import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { ffprobe } from '../src/postprocess.js';
import { compressSession, coverageOf, detectEncoder, pruneBackups } from '../src/storage.js';

const E2E = process.env.E2E === '1';
const DAY = 24 * 60 * 60 * 1000;

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(stderr))));
  });
}

function makeVideo(file) {
  return runFfmpeg([
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30:duration=6',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '18',
    '-c:a', 'aac', '-b:a', '128k', '-shortest', file,
  ]);
}

async function exists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

function storageSnapshot() {
  return {
    ...config.storage,
    checksum: config.recorder.checksum,
  };
}

function restoreStorage(snapshot) {
  Object.assign(config.storage, snapshot);
  config.recorder.checksum = snapshot.checksum;
}

test('compressSession replaces H.264 with verified HEVC and keeps audio', { skip: !E2E, timeout: 180000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-compress-'));
  const file = path.join(dir, 'recording.mkv');
  await makeVideo(file);
  const before = await ffprobe(file);
  const beforeSize = (await fsp.stat(file)).size;
  assert.equal(before.hasAudio, true);

  const store = await new Store(path.join(dir, 'state.json')).init();
  const now = new Date().toISOString();
  const session = {
    id: 'twitch-compress-test',
    platform: 'twitch',
    status: 'done',
    title: 'Compression test',
    detectedAt: now,
    recordingStartedAt: now,
    endedAt: now,
    destinationDir: dir,
    final: {
      file,
      size: beforeSize,
      duration: before.duration,
      bitrate: before.bitrate,
      quality: {
        width: 640,
        height: 360,
        fps: '30/1',
        videoCodec: 'h264',
        audioCodec: 'aac',
      },
      archived: true,
      verifiedAt: now,
    },
  };
  store.putSession(session);

  const snapshot = storageSnapshot();
  config.storage.compressEnabled = true;
  config.storage.compressEncoder = 'x265';
  config.storage.compressQuality = 'small';
  config.storage.compressMinSavingsPercent = 1;
  config.recorder.checksum = false;

  try {
    const result = await compressSession(store.getSession(session.id), {
      store,
      encoder: { kind: 'x265', name: 'libx265', available: true },
      quality: 'small',
      minSavingsPercent: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(result.skipped, undefined);
    assert.ok(result.compressedSize < result.originalSize, 'compressed file should be smaller');

    const after = await ffprobe(file);
    assert.equal(after.streams.find((stream) => stream.type === 'video')?.codec, 'hevc');
    assert.equal(after.hasAudio, true);
    assert.ok(Math.abs((after.duration || 0) - (before.duration || 0)) < 2);

    const saved = store.getSession(session.id);
    assert.equal(saved.compression.status, 'done');
    assert.equal(saved.final.quality.videoCodec, 'hevc');
    assert.equal(saved.final.size, result.compressedSize);

    const metadata = JSON.parse(await fsp.readFile(
      path.join(dir, '.stream-vod-guard', session.id, 'metadata.json'),
      'utf8',
    ));
    assert.equal(metadata.compression.status, 'done');
    assert.equal(metadata.final.quality.videoCodec, 'hevc');
  } finally {
    restoreStorage(snapshot);
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('compressSession keeps the original when no encoder is available', { skip: !E2E, timeout: 60000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-no-encoder-'));
  const file = path.join(dir, 'recording.mkv');
  await makeVideo(file);
  const before = await ffprobe(file);
  const beforeSize = (await fsp.stat(file)).size;

  const store = await new Store(path.join(dir, 'state.json')).init();
  const now = new Date().toISOString();
  const session = {
    id: 'twitch-no-encoder',
    platform: 'twitch',
    status: 'done',
    title: 'No encoder test',
    detectedAt: now,
    recordingStartedAt: now,
    endedAt: now,
    destinationDir: dir,
    final: {
      file,
      size: beforeSize,
      duration: before.duration,
      quality: { width: 640, height: 360, fps: '30/1', videoCodec: 'h264', audioCodec: 'aac' },
      archived: true,
      verifiedAt: now,
    },
  };
  store.putSession(session);

  try {
    const result = await compressSession(session, {
      store,
      encoder: { kind: 'none', name: 'none', available: false, reason: 'test without encoder' },
    });
    assert.equal(result.ok, false);
    assert.equal(result.skipped, true);
    assert.match(result.reason, /no compatible encoder/);
    const after = await ffprobe(file);
    assert.equal(after.streams.find((stream) => stream.type === 'video')?.codec, 'h264');
    assert.equal((await fsp.stat(file)).size, beforeSize);
    const saved = store.getSession(session.id);
    assert.equal(saved.compression.status, 'queued');
    assert.match(saved.compression.error, /no compatible encoder/);
    assert.equal(await exists(`${file}.hevc-tmp-test.mkv`), false);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('detectEncoder honours none and validates the x265 software fallback', { timeout: 60000 }, async () => {
  const snapshot = storageSnapshot();
  try {
    config.storage.compressEncoder = 'none';
    const disabled = await detectEncoder(true);
    assert.equal(disabled.kind, 'none');
    assert.equal(disabled.available, false);

    config.storage.compressEncoder = 'x265';
    const software = await detectEncoder(true);
    assert.equal(software.kind, 'x265');
    assert.equal(software.available, true);
  } finally {
    restoreStorage(snapshot);
    await detectEncoder(true).catch(() => {});
  }
});

test('pruneBackups removes only an old YouTube copy covered by Twitch', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-prune-'));
  const twitchFile = path.join(dir, 'twitch.mkv');
  const youtubeFile = path.join(dir, 'youtube.mkv');
  await fsp.writeFile(twitchFile, 'x'.repeat(1024));
  await fsp.writeFile(youtubeFile, 'y'.repeat(2048));

  const store = await new Store(path.join(dir, 'state.json')).init();
  const ended = new Date(Date.now() - 10 * DAY).toISOString();
  const started = new Date(Date.now() - 10 * DAY - 2 * 60 * 60 * 1000).toISOString();
  const twitch = {
    id: 'twitch-prune-test',
    platform: 'twitch',
    status: 'done',
    detectedAt: started,
    recordingStartedAt: started,
    endedAt: ended,
    destinationDir: dir,
    final: { file: twitchFile, size: 1024, archived: true, verifiedAt: ended },
  };
  const youtube = {
    id: 'youtube-prune-test',
    platform: 'youtube',
    status: 'done',
    detectedAt: started,
    recordingStartedAt: started,
    endedAt: ended,
    destinationDir: dir,
    metadataFile: path.join(dir, '.stream-vod-guard', 'youtube-prune-test', 'metadata.json'),
    final: { file: youtubeFile, size: 2048, archived: true, verifiedAt: ended },
  };
  store.putSession(twitch);
  store.putSession(youtube);

  try {
    assert.ok(coverageOf(twitch, youtube) > 0.99);
    const dry = await pruneBackups(store, { days: 7, dryRun: true });
    assert.equal(dry.candidates.length, 1);
    assert.equal(await exists(youtubeFile), true);

    const result = await pruneBackups(store, { days: 7 });
    assert.equal(result.pruned, 1);
    assert.equal(await exists(twitchFile), true, 'the primary Twitch file must stay');
    assert.equal(await exists(youtubeFile), false, 'the old YouTube backup must be pruned');
    const saved = store.getSession(youtube.id);
    assert.equal(saved.final.file, null);
    assert.ok(saved.backupPruned?.twitchSessionId === twitch.id);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('pruneBackups keeps a YouTube copy when the Twitch recording does not cover it', async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-prune-short-'));
  const twitchFile = path.join(dir, 'twitch.mkv');
  const youtubeFile = path.join(dir, 'youtube.mkv');
  await fsp.writeFile(twitchFile, 'x'.repeat(1024));
  await fsp.writeFile(youtubeFile, 'y'.repeat(2048));

  const store = await new Store(path.join(dir, 'state.json')).init();
  const old = new Date(Date.now() - 10 * DAY).toISOString();
  const recent = new Date(Date.now() - 10 * DAY + 30 * 60 * 1000).toISOString();
  store.putSession({
    id: 'twitch-short-cover',
    platform: 'twitch',
    status: 'done',
    detectedAt: recent,
    recordingStartedAt: recent,
    endedAt: old,
    destinationDir: dir,
    final: { file: twitchFile, size: 1024, archived: true, verifiedAt: old },
  });
  store.putSession({
    id: 'youtube-long-copy',
    platform: 'youtube',
    status: 'done',
    detectedAt: old,
    recordingStartedAt: new Date(Date.parse(old) - 2 * 60 * 60 * 1000).toISOString(),
    endedAt: old,
    destinationDir: dir,
    final: { file: youtubeFile, size: 2048, archived: true, verifiedAt: old },
  });

  try {
    const result = await pruneBackups(store, { days: 7 });
    assert.equal(result.pruned, 0);
    assert.equal(await exists(youtubeFile), true);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
