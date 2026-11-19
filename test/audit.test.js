import test from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { auditTwitchMutes, auditSummary, ffprobe } from '../src/postprocess.js';

const E2E = process.env.E2E === '1';

function makeAudio(file, { tone = true, duration = 180 } = {}) {
  return new Promise((resolve, reject) => {
    const args = tone
      ? ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${duration}`, '-c:a', 'aac', '-b:a', '128k', file]
      : ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', `anullsrc=channel_layout=stereo:sample_rate=48000:d=${duration}`, '-c:a', 'aac', '-b:a', '128k', file];
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (c) => { stderr += c; });
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(stderr)));
  });
}

test('auditTwitchMutes PASSES when our live copy has audio on muted ranges', { skip: !E2E, timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-audit-test-'));
  try {
    const file = path.join(dir, 'tone.m4a');
    await makeAudio(file, { tone: true, duration: 180 });
    const probe = await ffprobe(file);
    assert.ok(probe.duration >= 179);

    const session = {
      platform: 'twitch',
      streamStartedAt: '2026-01-01T00:00:00.000Z',
      recordingStartedAt: '2026-01-01T00:00:00.000Z',
    };
    const vod = {
      id: 'fake',
      lengthSeconds: 180,
      mutedSegments: [
        { offset: 30, duration: 30 },
        { offset: 90, duration: 30 },
        { offset: 150, duration: 30 },
      ],
    };
    const audit = await auditTwitchMutes(session, file, vod);
    assert.equal(audit.verdict, 'PASSED', JSON.stringify(audit.segments));
    assert.equal(audit.passed, 3);
    assert.equal(audit.failed, 0);
    const summary = auditSummary(audit);
    assert.equal(summary.ok, true);
    assert.match(summary.line, /3\/3 with audio/);
    console.log(`AUDIT PASS · ${summary.line} · control ${audit.control.meanDb} dB`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});

test('auditTwitchMutes FAILS when our copy is silent (as a muted VOD would)', { skip: !E2E, timeout: 120000 }, async () => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-audit-test-'));
  try {
    const file = path.join(dir, 'silence.m4a');
    await makeAudio(file, { tone: false, duration: 180 });
    const session = {
      platform: 'twitch',
      streamStartedAt: '2026-01-01T00:00:00.000Z',
      recordingStartedAt: '2026-01-01T00:00:00.000Z',
    };
    const vod = {
      id: 'fake',
      lengthSeconds: 180,
      mutedSegments: [
        { offset: 30, duration: 30 },
        { offset: 90, duration: 30 },
      ],
    };
    const audit = await auditTwitchMutes(session, file, vod);
    assert.equal(audit.verdict, 'FAILED', JSON.stringify(audit.segments));
    assert.equal(audit.failed, 2);
    const summary = auditSummary(audit);
    assert.equal(summary.ok, false);
    console.log(`AUDIT FAIL (expected) · ${summary.line}`);
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
});
