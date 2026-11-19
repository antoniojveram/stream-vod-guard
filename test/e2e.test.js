import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { CaptureController } from '../src/recorder.js';
import { createSession, ensureSessionDirs } from '../src/store.js';
import { ffprobe, finalizeSession, reconcileParts } from '../src/postprocess.js';
import { sleep } from '../src/util.js';

const E2E = process.env.E2E === '1';

function startStaticServer(root) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const file = path.join(root, decodeURIComponent(url.pathname));
    try {
      const body = await fsp.readFile(file);
      res.writeHead(200, {
        'content-type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t',
        'cache-control': 'no-store',
        'access-control-allow-origin': '*',
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(predicate, timeoutMs = 30000, intervalMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

test('live capture survives a hard kill, restarts, and finalizes with audio', { skip: !E2E, timeout: 180000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-e2e-'));
  const hlsDir = path.join(root, 'hls');
  await fsp.mkdir(hlsDir, { recursive: true });

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000',
    '-t', '180',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
    '-g', '60', '-b:v', '900k',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls',
    '-hls_time', '2',
    '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  const server = await startStaticServer(hlsDir);
  const port = server.address().port;
  const url = `http://127.0.0.1:${port}/index.m3u8`;

  const oldConfig = {
    recordingsDir: config.recordingsDir,
    workDir: config.workDir,
    archiveMetaDir: config.archiveMetaDir,
    urlOverride: config.twitch.urlOverride,
    archiveEnabled: config.recorder.archiveEnabled,
    checksum: config.recorder.checksum,
  };
  config.recordingsDir = path.join(root, 'recordings');
  config.workDir = path.join(root, 'work');
  config.archiveMetaDir = path.join(root, 'meta');
  config.twitch.urlOverride = url;
  config.recorder.archiveEnabled = false;
  config.recorder.checksum = false;

  const session = createSession({
    platform: 'twitch',
    streamId: `e2e-${Date.now()}`,
    title: 'E2E synthetic live',
    streamStartedAt: new Date().toISOString(),
    dir: path.join(root, 'work', 'session'),
  });
  ensureSessionDirs(session);
  session.recordingStartedAt = new Date().toISOString();
  session.status = 'recording';

  let controller = null;
  try {
    const ready = await waitFor(async () => {
      try {
        const text = await fsp.readFile(path.join(hlsDir, 'index.m3u8'), 'utf8');
        return (text.match(/\.ts/g) || []).length >= 4;
      } catch {
        return false;
      }
    }, 30000);
    assert.equal(ready, true, 'fake HLS live playlist was not produced');

    controller = new CaptureController(session);
    const fakeStore = {
      putSession() {},
      addEvent() {},
      listSessions() { return []; },
    };
    await controller.start();

    // Give streamlink time to fetch the live edge and then follow the live
    // stream for several seconds.
    await sleep(10000);
    await controller.measure(controller.part);
    assert.ok((controller.part?.bytes || 0) > 100000, `first part too small: ${controller.part?.bytes}`);

    const firstPart = controller.part.index;
    // Simulate a recorder crash, not a graceful stop: the watchdog must restart.
    controller.child.kill('SIGKILL');
    const restarted = await waitFor(async () => controller.part?.index > firstPart, 45000);
    assert.equal(restarted, true, 'watchdog did not restart the capture after SIGKILL');

    await sleep(10000);
    await controller.measure(controller.part);
    assert.ok((controller.part?.bytes || 0) > 100000, `second part too small: ${controller.part?.bytes}`);

    await controller.stopAndWait('e2e done');
    controller = null;
    await reconcileParts(session);
    assert.ok(session.parts.length >= 2, `expected >=2 parts, got ${session.parts.length}`);
    assert.ok(session.restarts >= 1, 'restart counter was not incremented');

    const result = await finalizeSession(session, { store: fakeStore });
    assert.equal(result.ok, true, `finalize failed: ${result.error || ''}`);

    const probe = await ffprobe(session.final.localFile);
    assert.equal(probe.hasVideo, true, 'final file has no video');
    assert.equal(probe.hasAudio, true, 'final file has no audio');
    assert.ok(probe.duration > 14, `final duration too short: ${probe.duration}`);
    assert.ok(session.final.size > 200000, `final file too small: ${session.final.size}`);

    const stat = await fsp.stat(session.final.localFile);
    console.log(`E2E OK · parts=${session.parts.length} restarts=${session.restarts} duration=${probe.duration.toFixed(1)}s size=${stat.size}`);
  } finally {
    try { await controller?.stop('test cleanup'); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
    ffmpeg.kill('SIGKILL');
    config.recordingsDir = oldConfig.recordingsDir;
    config.workDir = oldConfig.workDir;
    config.archiveMetaDir = oldConfig.archiveMetaDir;
    config.twitch.urlOverride = oldConfig.urlOverride;
    config.recorder.archiveEnabled = oldConfig.archiveEnabled;
    config.recorder.checksum = oldConfig.checksum;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
