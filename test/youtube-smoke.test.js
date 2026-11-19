import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { CaptureController } from '../src/recorder.js';
import { createSession, ensureSessionDirs } from '../src/store.js';
import { ffprobe, finalizeSession, reconcileParts } from '../src/postprocess.js';
import { sleep } from '../src/util.js';

const ENABLED = process.env.YOUTUBE_SMOKE === '1' && Boolean(process.env.YOUTUBE_SMOKE_URL);

test('real YouTube live capture (yt-dlp) produces a playable file with audio', { skip: !ENABLED, timeout: 180000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-ytsmoke-'));
  const old = {
    recordingsDir: config.recordingsDir,
    workDir: config.workDir,
    archiveMetaDir: config.archiveMetaDir,
    urlOverride: config.youtube.urlOverride,
    maxHeight: config.youtube.maxHeight,
    archiveEnabled: config.recorder.archiveEnabled,
    checksum: config.recorder.checksum,
    audit: config.audit.enabled,
  };
  config.recordingsDir = path.join(root, 'recordings');
  config.workDir = path.join(root, 'work');
  config.archiveMetaDir = path.join(root, 'meta');
  config.youtube.urlOverride = process.env.YOUTUBE_SMOKE_URL;
  config.youtube.maxHeight = 720;
  config.recorder.archiveEnabled = false;
  config.recorder.checksum = false;
  config.audit.enabled = false;
  await fsp.mkdir(config.recordingsDir, { recursive: true });
  await fsp.mkdir(config.workDir, { recursive: true });
  await fsp.mkdir(config.archiveMetaDir, { recursive: true });

  const session = createSession({
    platform: 'youtube',
    videoId: `smoke-${Date.now()}`,
    title: 'YouTube real live smoke',
    streamStartedAt: new Date().toISOString(),
    dir: path.join(root, 'work', 'session'),
  });
  ensureSessionDirs(session);
  session.recordingStartedAt = new Date().toISOString();
  session.status = 'recording';

  let controller = null;
  try {
    controller = new CaptureController(session);
    await controller.start();
    if (process.env.YOUTUBE_SMOKE_KILL === '1') {
      await sleep(15000);
      await controller.measure(controller.part);
      assert.ok((controller.part?.bytes || 0) > 100000, `too few bytes before kill: ${controller.part?.bytes}`);
      const firstPart = controller.part.index;
      controller.child.kill('SIGKILL');
      const restarted = await new Promise(async (resolve) => {
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline) {
          if (controller.part?.index > firstPart) return resolve(true);
          await sleep(500);
        }
        resolve(false);
      });
      assert.equal(restarted, true, 'YouTube capture did not restart after SIGKILL');
      await sleep(15000);
    } else {
      await sleep(25000);
    }
    await controller.measure(controller.part);
    assert.ok((controller.part?.bytes || 0) > 100000, `too few bytes: ${controller.part?.bytes}`);
    await controller.stopAndWait('smoke done');
    controller = null;

    await reconcileParts(session);
    assert.ok(session.parts.length >= (process.env.YOUTUBE_SMOKE_KILL === '1' ? 2 : 1), 'missing parts');
    const result = await finalizeSession(session, {
      store: { putSession() {}, addEvent() {}, listSessions() { return []; } },
    });
    assert.equal(result.ok, true, `finalize failed: ${result.error || ''}`);
    const probe = await ffprobe(session.final.localFile);
    assert.equal(probe.hasVideo, true, 'no video');
    assert.equal(probe.hasAudio, true, 'no audio');
    assert.ok(probe.duration > 8, `duration too short: ${probe.duration}`);
    assert.ok(session.final.quality?.height > 0, 'missing YouTube quality');
    console.log(`YOUTUBE SMOKE OK · duration=${probe.duration.toFixed(1)}s size=${session.final.size}`);
  } finally {
    try { await controller?.stop('cleanup'); } catch { /* ignore */ }
    config.recordingsDir = old.recordingsDir;
    config.workDir = old.workDir;
    config.archiveMetaDir = old.archiveMetaDir;
    config.youtube.urlOverride = old.urlOverride;
    config.youtube.maxHeight = old.maxHeight;
    config.recorder.archiveEnabled = old.archiveEnabled;
    config.recorder.checksum = old.checksum;
    config.audit.enabled = old.audit;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
