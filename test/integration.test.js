import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { config } from '../src/config.js';
import { Store } from '../src/store.js';
import { Archiver } from '../src/monitor.js';
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
      });
      res.end(body);
    } catch {
      res.writeHead(404);
      res.end('not found');
    }
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

async function waitFor(predicate, timeoutMs = 90000, intervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

test('Archiver start -> capture -> end -> finalize -> destination metadata flow', { skip: !E2E, timeout: 180000 }, async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-int-'));
  const hlsDir = path.join(root, 'hls');
  await fsp.mkdir(hlsDir, { recursive: true });

  const ffmpeg = spawn('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-re',
    '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30',
    '-f', 'lavfi', '-i', 'sine=frequency=330:sample_rate=48000',
    '-t', '120',
    '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-g', '60', '-b:v', '800k',
    '-c:a', 'aac', '-b:a', '128k',
    '-f', 'hls', '-hls_time', '2', '-hls_list_size', '6',
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(hlsDir, 'seg%05d.ts'),
    path.join(hlsDir, 'index.m3u8'),
  ], { stdio: ['ignore', 'inherit', 'inherit'] });

  const server = await startStaticServer(hlsDir);
  const url = `http://127.0.0.1:${server.address().port}/index.m3u8`;

  const old = {
    recordingsDir: config.recordingsDir,
    workDir: config.workDir,
    archiveMetaDir: config.archiveMetaDir,
    urlOverride: config.twitch.urlOverride,
    archiveEnabled: config.recorder.archiveEnabled,
    checksum: config.recorder.checksum,
    audit: config.audit.enabled,
  };
  config.recordingsDir = path.join(root, 'recordings');
  config.workDir = path.join(root, 'work');
  config.archiveMetaDir = path.join(root, 'recordings', '.stream-vod-guard');
  config.twitch.urlOverride = url;
  config.recorder.archiveEnabled = false;
  config.recorder.checksum = false;
  config.audit.enabled = false;
  await fsp.mkdir(config.recordingsDir, { recursive: true });
  await fsp.mkdir(config.workDir, { recursive: true });
  await fsp.mkdir(config.archiveMetaDir, { recursive: true });

  let archiver = null;
  try {
    const ready = await waitFor(async () => {
      try {
        const text = await fsp.readFile(path.join(hlsDir, 'index.m3u8'), 'utf8');
        return (text.match(/\.ts/g) || []).length >= 3;
      } catch { return false; }
    }, 30000);
    assert.equal(ready, true);

    const store = await new Store(path.join(root, 'state.json')).init();
    archiver = new Archiver(store);
    const session = await archiver.startSession('twitch', {
      streamId: `int-${Date.now()}`,
      title: 'Integration synthetic live',
      streamStartedAt: new Date().toISOString(),
    });
    assert.ok(session?.id, 'session not created');
    assert.ok(archiver.controllers.has(session.id), 'controller not started');

    await sleep(12000);
    const partBytes = (session.parts || []).reduce((a, p) => a + (p.bytes || 0), 0);
    assert.ok(partBytes > 100000, `captured too few bytes: ${partBytes}`);

    await archiver.endSession(session, 'integration test end');
    const finalized = await waitFor(() => ['done', 'archived-pending', 'failed'].includes(session.status), 90000);
    assert.equal(finalized, true, `session stuck in ${session.status}`);
    assert.equal(session.status, 'done', `finalize status: ${session.status} (${session.lastError || ''})`);
    assert.ok(session.final?.localFile, 'no final file');
    const stat = await fsp.stat(session.final.localFile);
    assert.ok(stat.size > 100000);
    assert.ok(session.final.duration > 8, `duration ${session.final.duration}`);
    assert.ok(session.final.quality?.width > 0, 'missing video width');
    assert.ok(session.final.quality?.height > 0, 'missing video height');
    assert.ok(session.coverage?.ratio > 0.5, `coverage ${session.coverage?.ratio}`);
    assert.ok(session.metadataFile, 'metadata file not written');
    const meta = JSON.parse(await fsp.readFile(session.metadataFile, 'utf8'));
    assert.equal(meta.id, session.id);
    assert.ok(meta.final.size > 100000);

    console.log(`INTEGRATION OK · duration=${session.final.duration.toFixed(1)}s size=${stat.size} coverage=${session.coverage.ratio} metadata=${session.metadataFile}`);
  } finally {
    try { await archiver?.shutdown(); } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve));
    ffmpeg.kill('SIGKILL');
    config.recordingsDir = old.recordingsDir;
    config.workDir = old.workDir;
    config.archiveMetaDir = old.archiveMetaDir;
    config.twitch.urlOverride = old.urlOverride;
    config.recorder.archiveEnabled = old.archiveEnabled;
    config.recorder.checksum = old.checksum;
    config.audit.enabled = old.audit;
    await fsp.rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
