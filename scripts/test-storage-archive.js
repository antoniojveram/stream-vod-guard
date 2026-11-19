import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from '../src/config.js';
import { archiveFinal, writeMetadata } from '../src/postprocess.js';
import { run } from '../src/util.js';

const tmp = '/tmp/stream-vod-storage-test.mkv';
await run('ffmpeg', [
  '-hide_banner', '-loglevel', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=15:duration=5',
  '-f', 'lavfi', '-i', 'sine=frequency=440:duration=5',
  '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', tmp,
], { timeoutMs: 60000 });

const session = {
  id: `storage-test-${Date.now()}`,
  platform: 'twitch',
  channel: 'TEST',
  title: 'Storage archive test',
  streamId: 'test',
  streamStartedAt: new Date().toISOString(),
};
const result = await archiveFinal(session, tmp);
const stat = await fsp.stat(result.file);
session.final = { ...result, localFile: tmp };
session.status = 'done';
const meta = await writeMetadata(session);
console.log(JSON.stringify({
  recordedFile: result.file,
  displayPath: path.join(config.archiveDisplayPath, path.basename(result.file)),
  size: stat.size,
  metadata: meta,
}, null, 2));

await fsp.rm(result.file, { force: true });
await fsp.rm(path.dirname(meta), { recursive: true, force: true });
await fsp.rm(tmp, { force: true });
console.log('Storage archive test cleaned up');
