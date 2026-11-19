import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import {
  atomicWriteJson,
  copyFileVerified,
  diskFreeBytes,
  errorMessage,
  fileSize,
  finalFileName,
  formatDuration,
  humanBytes,
  nowIso,
  parseMeanVolume,
  parseSilenceDetect,
  pathExists,
  removeQuietly,
  run,
  sha256File,
  truncate,
} from './util.js';
import { findVodForStream, getVodMutes } from './twitch.js';

const PART_FILE_RE = /^part-(\d{4})\./;

export async function ffprobe(file) {
  const result = await run('ffprobe', [
    '-v', 'error',
    '-print_format', 'json',
    '-show_format',
    '-show_streams',
    file,
  ], { timeoutMs: 60000, maxOutput: 2 * 1024 * 1024 });
  if (result.code !== 0) throw new Error(`ffprobe failed: ${truncate(result.stderr, 300)}`);
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('ffprobe returned invalid JSON');
  }
  const streams = (data.streams || []).map((s) => ({
    index: s.index,
    type: s.codec_type,
    codec: s.codec_name,
    width: s.width,
    height: s.height,
    channels: s.channels,
    sampleRate: s.sample_rate,
    duration: s.duration ? Number(s.duration) : null,
  }));
  return {
    file,
    duration: data.format?.duration ? Number(data.format.duration) : null,
    size: data.format?.size ? Number(data.format.size) : null,
    bitrate: data.format?.bit_rate ? Number(data.format.bit_rate) : null,
    streams,
    hasVideo: streams.some((s) => s.type === 'video'),
    hasAudio: streams.some((s) => s.type === 'audio'),
  };
}

export async function listRawFiles(session) {
  try {
    const files = await fsp.readdir(path.join(session.dir, 'raw'));
    return files
      .filter((name) => PART_FILE_RE.test(name))
      .sort()
      .map((name) => path.join(session.dir, 'raw', name));
  } catch {
    return [];
  }
}

/** Add files found on disk to the session (covers a crash before state save). */
export async function reconcileParts(session) {
  const files = await listRawFiles(session);
  const known = new Set((session.parts || []).flatMap((p) => p.files || []));
  const byPrefix = new Map();
  for (const file of files) {
    const name = path.basename(file);
    const prefix = name.match(/^(part-\d{4})\./)?.[1];
    if (!prefix) continue;
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, []);
    byPrefix.get(prefix).push(file);
  }
  for (const [prefix, group] of byPrefix) {
    const index = Number(prefix.split('-')[1]);
    let part = (session.parts || []).find((p) => Number(p.index) === index);
    if (!part) {
      part = {
        index,
        attempt: null,
        output: group[0],
        files: [],
        startedAt: null,
        endedAt: null,
        bytes: 0,
        status: 'recovered',
      };
      session.parts ||= [];
      session.parts.push(part);
    }
    for (const file of group) {
      if (!known.has(file)) part.files.push(file);
    }
    part.bytes = 0;
    for (const file of part.files) part.bytes += await fileSize(file);
  }
  session.parts = (session.parts || []).sort((a, b) => a.index - b.index);
  return session.parts;
}

async function findMergedFile(session, part) {
  const prefix = `part-${String(part.index).padStart(4, '0')}.`;
  const dir = path.join(session.dir, 'raw');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix))
    .map((name) => path.join(dir, name));
  if (!candidates.length) return null;

  // yt-dlp's finished merge has no ".f<id>" component.
  const merged = candidates.find((f) => !/\.f\d+\./.test(path.basename(f)) && !f.endsWith('.part'));
  if (merged) {
    try {
      const probe = await ffprobe(merged);
      if (probe.hasAudio && probe.hasVideo) return merged;
    } catch {
      // try the split files
    }
  }
  return null;
}

async function muxYouTubePart(session, part) {
  const merged = await findMergedFile(session, part);
  if (merged) return { file: merged, recovered: false };

  const prefix = `part-${String(part.index).padStart(4, '0')}.`;
  const dir = path.join(session.dir, 'raw');
  let names = [];
  try {
    names = await fsp.readdir(dir);
  } catch {
    return null;
  }
  const candidates = names
    .filter((name) => name.startsWith(prefix) && !name.endsWith('.log'))
    .map((name) => path.join(dir, name));
  if (!candidates.length) return null;

  const probed = [];
  for (const file of candidates) {
    try {
      const info = await ffprobe(file);
      if (info.duration && info.duration > 0.5) probed.push({ file, ...info });
    } catch {
      // incomplete fragment
    }
  }
  if (!probed.length) return null;

  const bestVideo = probed
    .filter((p) => p.hasVideo)
    .sort((a, b) => (b.height || 0) - (a.height || 0) || b.size - a.size)[0];
  const bestAudio = probed
    .filter((p) => p.hasAudio)
    .sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0))[0];

  if (bestVideo && bestAudio && bestVideo.file !== bestAudio.file) {
    const out = path.join(dir, `part-${String(part.index).padStart(4, '0')}-muxed.mkv`);
    const result = await run('ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-i', bestVideo.file,
      '-i', bestAudio.file,
      '-map', '0:v:0', '-map', '1:a:0',
      '-c', 'copy',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      '-max_interleave_delta', '0',
      out,
    ], { timeoutMs: 30 * 60 * 1000, maxOutput: 512 * 1024 });
    if (result.code === 0) {
      logger.info(`[${session.id}] recovered split YouTube part ${part.index}`, {
        video: path.basename(bestVideo.file),
        audio: path.basename(bestAudio.file),
      });
      return { file: out, recovered: true };
    }
    logger.warn(`[${session.id}] could not mux YouTube part ${part.index}: ${truncate(result.stderr, 300)}`);
  }

  const single = bestVideo || bestAudio || probed.sort((a, b) => b.size - a.size)[0];
  return single ? { file: single.file, recovered: true } : null;
}

async function normalizePart(session, part) {
  if (session.platform === 'youtube') {
    return muxYouTubePart(session, part);
  }
  // Twitch/streamlink writes one TS per attempt; it may be slightly truncated
  // at the tail after SIGKILL but ffmpeg can still remux it.
  const files = (part.files || []).filter((f) => /\.(ts|mp4|mkv)$/i.test(f));
  let best = null;
  for (const file of files) {
    try {
      const info = await ffprobe(file);
      if (!info.duration || info.duration < 0.5) continue;
      if (!best || info.duration > best.duration) best = { file, ...info };
    } catch {
      // ignore broken part
    }
  }
  return best ? { file: best.file, recovered: false } : null;
}

function concatLine(file) {
  return `file '${file.replace(/'/g, "'\\''")}'`;
}

export async function concatParts(session, parts, output) {
  const listFile = path.join(session.dir, 'concat.txt');
  await fsp.writeFile(listFile, `${parts.map((p) => concatLine(p.file)).join('\n')}\n`);

  const baseArgs = [
    '-hide_banner', '-nostdin', '-y',
    '-f', 'concat', '-safe', '0',
    '-i', listFile,
    '-map', '0:v:0?', '-map', '0:a:0?',
    '-c', 'copy',
    '-avoid_negative_ts', 'make_zero',
    '-max_interleave_delta', '0',
  ];

  let result = await run('ffmpeg', [...baseArgs, '-fflags', '+genpts', output], {
    timeoutMs: 60 * 60 * 1000,
    maxOutput: 4 * 1024 * 1024,
  });
  if (result.code === 0) return { ok: true, warnings: result.stderr };

  logger.warn(`[${session.id}] concat failed, retrying with igndts: ${truncate(result.stderr, 400)}`);
  result = await run('ffmpeg', [...baseArgs, '-fflags', '+genpts+igndts', output], {
    timeoutMs: 60 * 60 * 1000,
    maxOutput: 4 * 1024 * 1024,
  });
  if (result.code === 0) return { ok: true, warnings: result.stderr };

  // Last copy-only attempt: let ffmpeg generate timestamps without the concat
  // demuxer (works for TS chunks produced by streamlink).
  if (session.platform === 'twitch') {
    const concatProtocol = parts.map((p) => p.file).join('|');
    result = await run('ffmpeg', [
      '-hide_banner', '-nostdin', '-y',
      '-i', `concat:${concatProtocol}`,
      '-map', '0:v:0?', '-map', '0:a:0?',
      '-c', 'copy',
      '-fflags', '+genpts',
      '-avoid_negative_ts', 'make_zero',
      output,
    ], { timeoutMs: 60 * 60 * 1000, maxOutput: 4 * 1024 * 1024 });
    if (result.code === 0) return { ok: true, warnings: result.stderr };
  }

  return { ok: false, error: truncate(result.stderr, 1000) };
}

export async function scanSilences(file, { noiseDb = config.audit.silenceNoiseDb, minDuration = config.audit.silenceMinDurationSec } = {}) {
  const result = await run('ffmpeg', [
    '-hide_banner', '-nostdin',
    '-i', file,
    '-map', '0:a:0',
    '-af', `silencedetect=noise=${noiseDb}dB:d=${minDuration}`,
    '-f', 'null', '-',
  ], { timeoutMs: 60 * 60 * 1000, maxOutput: 8 * 1024 * 1024 });
  if (result.code !== 0) {
    logger.warn(`silencedetect failed: ${truncate(result.stderr, 300)}`);
    return [];
  }
  return parseSilenceDetect(result.stderr, minDuration);
}

export async function sampleVolume(file, startSeconds, seconds = config.audit.muteSampleSeconds) {
  const args = [
    '-hide_banner', '-nostdin',
    '-ss', String(Math.max(0, startSeconds)),
    '-t', String(seconds),
    '-i', file,
    '-map', '0:a:0',
    '-af', 'volumedetect',
    '-f', 'null', '-',
  ];
  const result = await run('ffmpeg', args, { timeoutMs: 180000, maxOutput: 512 * 1024 });
  return {
    mean: parseMeanVolume(result.stderr),
    max: (result.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)?.[1] ?? null) !== null
      ? Number(result.stderr.match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/)[1])
      : null,
    ok: result.code === 0,
  };
}

/**
 * Compare Twitch's post-stream muted ranges with our live capture. A PASS means
 * our file has audio on a segment that Twitch later silenced.
 */
export async function auditTwitchMutes(session, finalFile, vod) {
  const muted = vod?.mutedSegments || [];
  if (!muted.length) {
    return {
      checkedAt: nowIso(),
      vodId: vod?.id || null,
      vodLengthSeconds: vod?.lengthSeconds || null,
      mutedSegments: 0,
      mutedSeconds: 0,
      checked: 0,
      passed: 0,
      failed: 0,
      outsideCoverage: 0,
      segments: [],
      verdict: 'no-mutes',
    };
  }

  const probe = await ffprobe(finalFile);
  const streamStartMs = Date.parse(session.streamStartedAt || '');
  const recordingStartMs = Date.parse(session.recordingStartedAt || '');
  // Offset of our recording inside the VOD timeline. Twitch VOD createdAt is
  // the broadcast start, so this is normally 0-30 seconds.
  const ourStartOffset = Number.isFinite(streamStartMs) && Number.isFinite(recordingStartMs)
    ? Math.max(0, (recordingStartMs - streamStartMs) / 1000)
    : 0;

  const checks = [];
  for (const segment of muted) {
    const midpoint = segment.offset + Math.min(segment.duration / 2, 75);
    const position = midpoint - ourStartOffset;
    if (!probe.duration || position < 5 || position > probe.duration - 10) {
      checks.push({
        ...segment,
        position: Math.round(position * 10) / 10,
        status: 'outside-coverage',
      });
      continue;
    }
    const volume = await sampleVolume(finalFile, position);
    let status = 'unknown';
    if (volume.mean !== null) {
      if (volume.mean > config.audit.mutePassDb) status = 'pass';
      else if (volume.mean > -90) status = 'warn';
      else status = 'fail';
    }
    checks.push({
      ...segment,
      position: Math.round(position * 10) / 10,
      meanDb: volume.mean,
      maxDb: volume.max,
      status,
    });
  }

  // One control sample from a likely non-muted part of the file.
  const controlPosition = Math.max(30, Math.min(probe.duration * 0.1, 600));
  const control = await sampleVolume(finalFile, controlPosition);

  const passed = checks.filter((c) => c.status === 'pass').length;
  const failed = checks.filter((c) => c.status === 'fail').length;
  const outside = checks.filter((c) => c.status === 'outside-coverage').length;
  const warned = checks.filter((c) => c.status === 'warn').length;
  return {
    checkedAt: nowIso(),
    vodId: vod.id,
    vodLengthSeconds: vod.lengthSeconds,
    mutedSegments: muted.length,
    mutedSeconds: muted.reduce((a, s) => a + s.duration, 0),
    checked: checks.length,
    passed,
    warned,
    failed,
    outsideCoverage: outside,
    ourStartOffset: Math.round(ourStartOffset * 10) / 10,
    control: { position: Math.round(controlPosition), meanDb: control.mean },
    segments: checks,
    verdict: failed > 0 ? 'FAILED' : (outside > 0 ? 'PARTIAL' : 'PASSED'),
  };
}

export function auditSummary(audit) {
  if (!audit) return { line: 'Audit pending', ok: null, muteChecks: null };
  if (audit.verdict === 'no-mutes') {
    return { line: 'Twitch has not muted this VOD (or has not scanned it yet)', ok: true, muteChecks: null };
  }
  if (audit.verdict === 'pending-vod' || audit.verdict === 'pending-mutes') {
    return {
      line: audit.verdict === 'pending-vod'
        ? 'Twitch VOD not available yet; audit running in background'
        : 'Twitch has not applied mutes to the VOD yet; audit running in background',
      ok: null,
      muteChecks: null,
    };
  }
  if (audit.verdict === 'disabled') {
    return { line: 'VOD audit disabled', ok: null, muteChecks: null };
  }
  if (audit.verdict === 'not-applicable') {
    return { line: 'YouTube backup copy (no mute audit)', ok: null, muteChecks: null };
  }
  const line = `Twitch VOD: ${audit.mutedSegments} segments (${formatDuration(audit.mutedSeconds)}) muted · ` +
    `our copy: ${audit.passed}/${audit.checked} with audio` +
    (audit.failed ? ` · ${audit.failed} FAILURES` : '') +
    (audit.outsideCoverage ? ` · ${audit.outsideCoverage} outside coverage` : '');
  return {
    line,
    ok: audit.failed === 0,
    muteChecks: {
      total: audit.mutedSegments,
      passed: audit.passed,
      warned: audit.warned,
      failed: audit.failed,
      outside: audit.outsideCoverage,
    },
  };
}

async function uniqueDestination(dir, filename) {
  const parsed = path.parse(filename);
  let candidate = path.join(dir, filename);
  let n = 2;
  while (await pathExists(candidate)) {
    candidate = path.join(dir, `${parsed.name} (${n})${parsed.ext}`);
    n += 1;
  }
  return candidate;
}

export async function archiveFinal(session, localFile) {
  const destDir = session.destinationDir || config.recordingsDir;
  const displayDir = session.destinationDisplayPath || config.archiveDisplayPath;
  if (!config.recorder.archiveEnabled) {
    return { file: localFile, size: await fileSize(localFile), archived: false, dir: destDir, displayDir };
  }
  // Idempotent retry: if the copy already exists (metadata write failed, or the
  // container died right after copying), do not create a duplicate.
  if (session.final?.archived && session.final.file && await pathExists(session.final.file)) {
    const existingSize = await fileSize(session.final.file);
    const sourceSize = await fileSize(localFile);
    if (existingSize === sourceSize) {
      return { file: session.final.file, size: existingSize, archived: true, dir: destDir, displayDir };
    }
  }
  const free = await diskFreeBytes(destDir);
  const needed = await fileSize(localFile);
  if (free < needed + config.disk.minFreeArchiveGb * 1024 ** 3) {
    throw new Error(
      `Not enough space at destination: ${humanBytes(free)} libres, ` +
      `necesarios ${humanBytes(needed)} + ${config.disk.minFreeArchiveGb} GB of headroom`,
    );
  }
  const dest = await uniqueDestination(destDir, finalFileName(session, config.timezone, config.filenameTemplate));
  logger.info(`[${session.id}] copying final file to destination: ${dest}`, { size: humanBytes(needed) });
  await copyFileVerified(localFile, dest);
  return { file: dest, size: needed, archived: true, dir: destDir, displayDir };
}

export async function writeMetadata(session) {
  const metaRoot = path.join(session.destinationDir || config.recordingsDir, '.stream-vod-guard');
  const metaFile = path.join(metaRoot, session.id, 'metadata.json');
  await fsp.mkdir(path.dirname(metaFile), { recursive: true });
  const payload = {
    ...session,
    metadataFile: metaFile,
    generatedAt: nowIso(),
    tool: 'stream-vod-guard',
  };
  await atomicWriteJson(metaFile, payload);
  return metaFile;
}

export async function finalizeSession(session, { store, onUpdate } = {}) {
  const startedAt = Date.now();
  session.status = 'finalizing';
  session.endedAt ||= nowIso();
  store?.putSession(session);
  onUpdate?.();
  logger.info(`[${session.id}] finalizing`, { parts: session.parts?.length || 0 });

  await reconcileParts(session);
  const normalized = [];
  for (const part of session.parts || []) {
    if (!part.files?.length) continue;
    const result = await normalizePart(session, part);
    if (result?.file) {
      try {
        const info = await ffprobe(result.file);
        if (info.duration && info.duration >= 0.5) {
          normalized.push({ ...result, part: part.index, duration: info.duration, ...info });
        }
      } catch (error) {
        logger.warn(`[${session.id}] part ${part.index} unusable: ${truncate(error.message, 200)}`);
      }
    }
    part.status = result ? 'normalized' : 'unusable';
  }

  if (!normalized.length) {
    session.status = 'failed';
    session.lastError = 'No usable capture parts';
    store?.putSession(session);
    logger.error(`[${session.id}] no usable parts; raw files kept in ${session.dir}`);
    return { ok: false, error: session.lastError };
  }

  const expectedDuration = normalized.reduce((acc, p) => acc + (p.duration || 0), 0);
  const localFile = path.join(session.dir, 'final', 'final.mkv');
  await fsp.mkdir(path.dirname(localFile), { recursive: true });
  const concat = await concatParts(session, normalized, localFile);
  if (!concat.ok) {
    session.status = 'failed';
    session.lastError = `ffmpeg concat failed: ${concat.error}`;
    store?.putSession(session);
    logger.error(`[${session.id}] concat failed`, { error: concat.error });
    return { ok: false, error: session.lastError };
  }

  const probe = await ffprobe(localFile);
  if (!probe.hasAudio) {
    session.status = 'failed';
    session.lastError = 'Final file has no audio stream';
    store?.putSession(session);
    logger.error(`[${session.id}] final file has no audio!`);
    return { ok: false, error: session.lastError };
  }

  const coverageRatio = probe.duration && expectedDuration
    ? probe.duration / expectedDuration
    : null;
  session.coverage = {
    expectedSeconds: Math.round(expectedDuration),
    finalSeconds: Math.round(probe.duration || 0),
    ratio: coverageRatio ? Math.round(coverageRatio * 1000) / 1000 : null,
    parts: normalized.length,
    recordingStartedAt: session.recordingStartedAt,
    streamStartedAt: session.streamStartedAt,
    missedStartSeconds: Number.isFinite(Date.parse(session.streamStartedAt)) && Number.isFinite(Date.parse(session.recordingStartedAt))
      ? Math.max(0, Math.round((Date.parse(session.recordingStartedAt) - Date.parse(session.streamStartedAt)) / 1000))
      : null,
  };

  // Silence audit: long digital-silence runs are suspicious (they could mean a
  // local capture problem, not a platform mute).
  let silences = [];
  try {
    silences = await scanSilences(localFile);
  } catch (error) {
    logger.warn(`[${session.id}] silence scan failed: ${truncate(errorMessage(error), 200)}`);
  }

  let checksum = null;
  if (config.recorder.checksum) {
    try {
      checksum = await sha256File(localFile);
    } catch (error) {
      logger.warn(`[${session.id}] checksum failed: ${truncate(errorMessage(error), 200)}`);
    }
  }

  // Twitch post-stream VOD audit. The monitor may already have found the VOD;
  // otherwise try once now and leave a pending audit for the watcher.
  let vod = session.twitchVod?.mutedSegments ? session.twitchVod : null;
  if (session.platform === 'twitch' && config.audit.enabled && !vod && session.streamStartedAt) {
    try {
      vod = await findVodForStream(session.streamStartedAt);
      if (vod) {
        const mutes = await getVodMutes(vod.id);
        vod = { ...vod, ...mutes };
        session.twitchVod = { ...vod, discoveredAt: nowIso() };
      }
    } catch (error) {
      logger.warn(`[${session.id}] VOD discovery failed: ${truncate(error.message, 200)}`);
    }
  }

  let audit = null;
  if (session.platform === 'twitch' && vod?.mutedSegments?.length) {
    audit = await auditTwitchMutes(session, localFile, vod);
  } else if (session.platform === 'twitch') {
    audit = {
      checkedAt: nowIso(),
      verdict: config.audit.enabled ? (vod ? 'pending-mutes' : 'pending-vod') : 'disabled',
      vodId: vod?.id || null,
      mutedSegments: 0,
      segments: [],
    };
  } else {
    audit = {
      checkedAt: nowIso(),
      verdict: 'not-applicable',
      segments: [],
    };
  }

  session.audit = audit;
  session.final = {
    localFile,
    file: null,
    size: await fileSize(localFile),
    duration: probe.duration,
    bitrate: probe.bitrate,
    streams: probe.streams,
    sha256: checksum,
    verifiedAt: nowIso(),
  };
  session.silences = silences;
  // Until the destination copy succeeds the session is "archived-pending". If the
  // container dies during the copy, retryPendingArchives picks it up on boot.
  session.status = 'archived-pending';
  session.lastError = null;
  session.finalizedAt = nowIso();
  session.finalizeMs = Date.now() - startedAt;
  store?.putSession(session);
  onUpdate?.();

  // Archive to the destination. Keep the local final file if the copy fails so nothing
  // is ever lost, and let the maintenance loop retry.
  try {
    const archived = await archiveFinal(session, localFile);
    session.final.file = archived.file;
    session.final.archived = archived.archived;
    session.final.displayFile = archived.file.startsWith(`${archived.dir}${path.sep}`)
      ? path.join(archived.displayDir, path.relative(archived.dir, archived.file))
      : archived.file;
    session.status = 'done';
    session.archiveError = null;
    const metaFile = await writeMetadata(session);
    session.metadataFile = metaFile;
    store?.putSession(session);

    if (archived.archived && !config.recorder.keepRaw) {
      await removeQuietly(path.join(session.dir, 'raw'));
      await removeQuietly(localFile);
      session.localCleanedAt = nowIso();
      store?.putSession(session);
    }
  } catch (error) {
    session.status = 'archived-pending';
    session.archiveError = truncate(errorMessage(error), 600);
    await writeMetadata(session).catch(() => {});
    store?.putSession(session);
    logger.error(`[${session.id}] archive to destination failed; local file kept at ${localFile}`, {
      error: session.archiveError,
    });
  }

  const summary = auditSummary(audit);
  logger.info(`[${session.id}] finalized: ${formatDuration(probe.duration || 0)} · ${humanBytes(session.final.size)} · ${summary.line}`);
  return {
    ok: true,
    file: session.final.file || localFile,
    duration: probe.duration,
    size: session.final.size,
    audit,
    summary,
  };
}

export async function retryPendingArchives(store) {
  for (const session of store.listSessions({ active: false, limit: 200 })) {
    if (session.status !== 'archived-pending' || !session.final?.localFile) continue;
    if (!(await pathExists(session.final.localFile))) continue;
    try {
      const archived = await archiveFinal(session, session.final.localFile);
      session.final.file = archived.file;
      session.final.archived = true;
      session.final.displayFile = archived.file.startsWith(`${archived.dir}${path.sep}`)
        ? path.join(archived.displayDir, path.relative(archived.dir, archived.file))
        : archived.file;
      session.status = 'done';
      session.archiveError = null;
      const metaFile = await writeMetadata(session);
      session.metadataFile = metaFile;
      if (!config.recorder.keepRaw) {
        await removeQuietly(path.join(session.dir, 'raw'));
        await removeQuietly(session.final.localFile);
      }
      store.putSession(session);
      logger.info(`[${session.id}] pending archive completed: ${archived.file}`);
    } catch (error) {
      logger.warn(`[${session.id}] pending archive still failing: ${truncate(errorMessage(error), 200)}`);
    }
  }
}

/** Re-audit a Twitch session when Twitch eventually applies its mutes. */
export async function reauditTwitchSession(session, vod, store) {
  const file = session.final?.file;
  const localFile = session.final?.localFile;
  const target = (file && await pathExists(file)) ? file : (localFile && await pathExists(localFile) ? localFile : null);
  if (!target) return null;
  const audit = await auditTwitchMutes(session, target, vod);
  session.audit = audit;
  session.twitchVod = { ...session.twitchVod, ...vod, auditedAt: nowIso() };
  store?.putSession(session);
  await writeMetadata(session).catch(() => {});
  const summary = auditSummary(audit);
  logger.info(`[${session.id}] re-audit: ${summary.line}`);
  return audit;
}
