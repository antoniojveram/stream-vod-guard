import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { config } from './config.js';
import { logger } from './logger.js';
import { ffprobe, writeMetadata } from './postprocess.js';
import {
  diskFreeBytes,
  errorMessage,
  fileSize,
  humanBytes,
  nowIso,
  pathExists,
  run,
  sha256File,
  sleep,
  truncate,
} from './util.js';

const QUALITY = {
  high: { label: 'high', qp: 21 },
  balanced: { label: 'balanced', qp: 24 },
  small: { label: 'small', qp: 27 },
};

const TEMP_SUFFIX = '.hevc-tmp';
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

let storageStore = null;
let cachedEncoder = null;
let currentJob = null;
let queue = [];
let pumping = false;
let stopping = false;
let pruneTimer = null;

export function compressionQuality(value) {
  return QUALITY[value] || QUALITY.balanced;
}

export function getEncoderInfo() {
  return cachedEncoder || { kind: 'unknown', name: 'unknown', available: false };
}

export function getStorageStatus() {
  return {
    encoder: getEncoderInfo(),
    queue: queue.length,
    running: currentJob ? { sessionId: currentJob.id } : null,
  };
}

/**
 * Probe the configured hardware encoder once. VAAPI needs both the render node
 * and the Intel/AMD driver inside the image; a one-frame encode is the most
 * reliable end-to-end test.
 */
export async function detectEncoder(force = false) {
  if (cachedEncoder && !force) return cachedEncoder;
  const wanted = String(config.storage.compressEncoder || 'auto').toLowerCase();
  if (wanted === 'none') {
    cachedEncoder = { kind: 'none', name: 'none', available: false, reason: 'disabled by configuration' };
    return cachedEncoder;
  }
  if (wanted === 'x265') {
    cachedEncoder = { kind: 'x265', name: 'libx265', available: true, reason: 'forced by configuration' };
    return cachedEncoder;
  }
  if ((wanted === 'vaapi' || wanted === 'auto') && fs.existsSync(config.storage.vaapiDevice)) {
    const probe = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-vaapi_device', config.storage.vaapiDevice,
      '-f', 'lavfi', '-i', 'color=c=black:s=320x240:r=1:d=1',
      '-frames:v', '1',
      '-vf', 'format=nv12,hwupload',
      '-c:v', 'hevc_vaapi',
      '-f', 'null', '-',
    ], { timeoutMs: 30000 });
    if (probe.code === 0) {
      cachedEncoder = {
        kind: 'vaapi',
        name: 'hevc_vaapi',
        device: config.storage.vaapiDevice,
        available: true,
      };
      return cachedEncoder;
    }
    logger.warn('VAAPI encoder probe failed', { error: truncate(probe.stderr, 300) });
    if (wanted === 'vaapi') {
      cachedEncoder = {
        kind: 'none',
        name: 'none',
        available: false,
        reason: 'VAAPI render node present but the encoder failed to initialise',
      };
      return cachedEncoder;
    }
  }
  if (wanted === 'auto' || wanted === 'x265') {
    cachedEncoder = {
      kind: 'x265',
      name: 'libx265',
      available: true,
      reason: fs.existsSync(config.storage.vaapiDevice) ? 'VAAPI unavailable, using CPU' : 'no VAAPI render node',
    };
    return cachedEncoder;
  }
  cachedEncoder = { kind: 'none', name: 'none', available: false, reason: 'no encoder available' };
  return cachedEncoder;
}

export function sessionInterval(session) {
  const start = Date.parse(
    session?.recordingStartedAt || session?.streamStartedAt || session?.detectedAt || 0,
  );
  const end = Date.parse(
    session?.endedAt || session?.finalizedAt || session?.final?.verifiedAt || session?.detectedAt || 0,
  );
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end };
}

/** Fraction of `secondary` covered by `primary` (0..1). */
export function coverageOf(primary, secondary) {
  const a = sessionInterval(primary);
  const b = sessionInterval(secondary);
  if (!a || !b) return 0;
  const overlap = Math.min(a.end, b.end) - Math.max(a.start, b.start);
  if (overlap <= 0) return 0;
  return overlap / (b.end - b.start);
}

function backupPlatform() {
  return config.twitch.enabled && config.youtube.enabled ? 'youtube' : null;
}

function findPrimaryCover(session, store, minCoverage = 0.95) {
  if (!store) return null;
  const candidates = store.listSessions({ limit: 2000 });
  return candidates.find((candidate) => {
    if (candidate.platform !== 'twitch' || candidate.status !== 'done') return false;
    if (!candidate.final?.file || !fs.existsSync(candidate.final.file)) return false;
    return coverageOf(candidate, session) >= minCoverage;
  }) || null;
}

function tempPrefix(target) {
  return path.join(path.dirname(target), `${path.basename(target)}${TEMP_SUFFIX}`);
}

async function removeTempFiles(target) {
  const prefix = tempPrefix(target);
  const dir = path.dirname(target);
  try {
    const entries = await fsp.readdir(dir);
    await Promise.all(entries
      .filter((name) => `${path.join(dir, name)}`.startsWith(prefix))
      .map((name) => fsp.rm(path.join(dir, name), { force: true }).catch(() => {})));
  } catch {
    // destination may be temporarily unavailable
  }
}

/**
 * If the process died between moving the original aside and renaming the new
 * file into place, restore the newest `.orig-*` backup before doing anything.
 */
async function restoreOriginalIfNeeded(target) {
  if (await pathExists(target)) return true;
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}.orig-`;
  try {
    const entries = await fsp.readdir(dir);
    const backups = entries
      .filter((name) => name.startsWith(prefix) && name.endsWith('.mkv'))
      .sort()
      .reverse();
    if (!backups.length) return false;
    await fsp.rename(path.join(dir, backups[0]), target);
    logger.warn(`Restored original after an interrupted replacement: ${target}`);
    return true;
  } catch {
    return false;
  }
}

function setCompression(session, patch, store) {
  session.compression = {
    ...(session.compression || {}),
    ...patch,
    updatedAt: nowIso(),
  };
  store?.putSession(session);
  return session.compression;
}

function markFailed(session, error, store) {
  const message = truncate(errorMessage(error), 600);
  setCompression(session, {
    status: 'failed',
    error: message,
    progress: session.compression?.progress || 0,
    completedAt: nowIso(),
  }, store);
  store?.addEvent({
    event: 'compression-failed',
    level: 'error',
    sessionId: session.id,
    message: `HEVC compression failed: ${message}`,
  });
  logger.warn(`[${session.id}] HEVC compression failed: ${message}`);
  return { ok: false, error: message };
}

function markSkipped(session, reason, store, extra = {}) {
  setCompression(session, {
    status: 'skipped',
    reason,
    ...extra,
    completedAt: nowIso(),
  }, store);
  store?.addEvent({
    event: 'compression-skipped',
    level: 'info',
    sessionId: session.id,
    message: `HEVC compression skipped: ${reason}`,
  });
  logger.info(`[${session.id}] HEVC compression skipped: ${reason}`);
  return { ok: true, skipped: true, reason };
}

/**
 * Queue a finished session for HEVC compression. Repeated calls are safe.
 */
export function enqueueCompression(session, { reason = 'auto', force = false } = {}) {
  if (!session || !storageStore) return false;
  if (!config.storage.compressEnabled && !force) return false;
  if (session.status !== 'done' || !session.final?.file) return false;
  if (['queued', 'running', 'done'].includes(session.compression?.status)) return false;
  if (['hevc', 'av1'].includes(session.final?.quality?.videoCodec)) return false;
  if (!fs.existsSync(session.final.file)) return false;

  // The YouTube copy will be deleted by the retention policy: do not waste CPU
  // compressing it. A YouTube-only recording has no Twitch cover and is kept.
  if (!force && config.storage.backupRetentionDays > 0 && session.platform === backupPlatform()) {
    const primary = findPrimaryCover(session, storageStore);
    if (primary) {
      markSkipped(
        session,
        `YouTube backup is pruned after ${config.storage.backupRetentionDays} days (Twitch copy ${primary.id} covers it)`,
        storageStore,
      );
      return false;
    }
  }

  const quality = compressionQuality(config.storage.compressQuality);
  setCompression(session, {
    status: 'queued',
    reason,
    quality: quality.label,
    qp: quality.qp,
    queuedAt: nowIso(),
    progress: 0,
    error: null,
  }, storageStore);
  storageStore.addEvent({
    event: 'compression-queued',
    level: 'info',
    sessionId: session.id,
    message: `HEVC compression queued (${quality.label}${force ? ', manual' : ''})`,
  });
  queue.push({ id: session.id, force });
  void pump();
  return true;
}

async function pump() {
  if (pumping || stopping) return;
  pumping = true;
  try {
    while (queue.length && !stopping) {
      const job = queue.shift();
      const session = storageStore?.getSession(job.id);
      if (!session) continue;
      if (!config.storage.compressEnabled && !job.force) {
        markSkipped(session, 'compression disabled', storageStore);
        continue;
      }
      currentJob = { id: session.id, child: null };
      try {
        await compressSession(session, { store: storageStore, force: job.force });
      } catch (error) {
        logger.error(`[${session.id}] compression queue error: ${errorMessage(error)}`);
      } finally {
        currentJob = null;
      }
    }
  } finally {
    pumping = false;
  }
}

function buildArgs(encoder, input, output, qp) {
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y'];
  if (encoder.kind === 'vaapi') args.push('-vaapi_device', encoder.device);
  args.push('-i', input, '-map', '0:v:0', '-map', '0:a?', '-map', '0:s?');
  if (encoder.kind === 'vaapi') {
    args.push('-vf', 'format=nv12,hwupload', '-c:v', 'hevc_vaapi', '-rc_mode', 'CQP', '-qp', String(qp));
  } else {
    args.push('-c:v', 'libx265', '-preset', 'fast', '-crf', String(qp), '-x265-params', 'log-level=error');
  }
  args.push(
    '-c:a', 'copy',
    '-c:s', 'copy',
    '-map_metadata', '0',
    '-max_muxing_queue_size', '4096',
    '-progress', 'pipe:1',
    '-nostats',
    output,
  );
  return args;
}

function runFfmpeg(args, { duration, onProgress, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    onSpawn?.(child);
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const index = line.indexOf('=');
        if (index < 0) continue;
        const key = line.slice(0, index);
        const value = line.slice(index + 1);
        if (key === 'out_time_us' && duration > 0) {
          const us = Number(value);
          if (Number.isFinite(us)) {
            onProgress?.(Math.max(0, Math.min(99, (us / 1e6 / duration) * 100)));
          }
        } else if (key === 'speed') {
          onProgress?.(undefined, value);
        }
      }
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > 50000) stderr = stderr.slice(-50000);
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      const tail = stderr.trim().split('\n').slice(-4).join(' | ');
      reject(new Error(
        `ffmpeg exited with ${code}${signal ? ` (${signal})` : ''}: ${truncate(tail, 600)}`,
      ));
    });
  });
}

/**
 * Compress one finished file to HEVC. The original is only replaced after the
 * new file has been probed, decoded and shown to be smaller.
 */
export async function compressSession(session, {
  store = storageStore,
  encoder = null,
  quality = null,
  minSavingsPercent = null,
} = {}) {
  if (!session?.final?.file) return { ok: false, skipped: true, reason: 'no final file' };
  const target = session.final.file;
  await restoreOriginalIfNeeded(target);
  if (!(await pathExists(target))) return { ok: false, skipped: true, reason: 'final file not found' };

  const originalProbe = await ffprobe(target);
  const video = originalProbe.streams.find((stream) => stream.type === 'video');
  if (!video) return { ok: false, error: 'final file has no video stream' };
  if (['hevc', 'av1'].includes(video.codec)) {
    return markSkipped(session, `already ${video.codec}`, store);
  }

  const enc = encoder || await detectEncoder();
  if (!enc.available || enc.kind === 'none') {
    return markFailed(session, `no HEVC encoder available: ${enc.reason || enc.kind}`, store);
  }
  const q = compressionQuality(quality || config.storage.compressQuality);
  const originalSize = await fileSize(target);
  const free = await diskFreeBytes(path.dirname(target));
  const estimated = Math.max(originalSize * 0.55, 512 * 1024 * 1024);
  if (free < estimated) {
    return markSkipped(
      session,
      `not enough destination space (${humanBytes(free)} free, ~${humanBytes(estimated)} needed)`,
      store,
    );
  }

  const temp = `${tempPrefix(target)}-${process.pid}-${Date.now()}.mkv`;
  await fsp.rm(temp, { force: true }).catch(() => {});
  setCompression(session, {
    status: 'running',
    reason: 'compress',
    encoder: enc.kind,
    encoderName: enc.name,
    quality: q.label,
    qp: q.qp,
    originalSize,
    originalCodec: video.codec,
    progress: 0,
    error: null,
    startedAt: nowIso(),
  }, store);
  store?.addEvent({
    event: 'compression-started',
    level: 'info',
    sessionId: session.id,
    message: `Compressing to HEVC (${enc.name}, QP ${q.qp})`,
  });
  logger.info(`[${session.id}] compressing to HEVC with ${enc.name} (QP ${q.qp})`, {
    input: target,
    size: humanBytes(originalSize),
  });

  const started = Date.now();
  let lastProgressWrite = 0;
  try {
    await runFfmpeg(buildArgs(enc, target, temp, q.qp), {
      duration: originalProbe.duration,
      onSpawn: (child) => {
        if (currentJob) currentJob.child = child;
      },
      onProgress: (percent, speed) => {
        if (percent !== undefined) {
          session.compression.progress = Math.round(percent);
          session.compression.speed = speed || session.compression.speed || null;
          if (Date.now() - lastProgressWrite >= 15000 || percent >= 99) {
            lastProgressWrite = Date.now();
            store?.putSession(session);
          }
        } else if (speed) {
          session.compression.speed = speed;
        }
      },
    });

    const encodedProbe = await ffprobe(temp);
    if (!encodedProbe.hasVideo) throw new Error('compressed file has no video stream');
    if (originalProbe.hasAudio && !encodedProbe.hasAudio) throw new Error('compressed file lost the audio track');
    if (originalProbe.duration && encodedProbe.duration
      && Math.abs(originalProbe.duration - encodedProbe.duration) > 2) {
      throw new Error(`duration mismatch: source ${originalProbe.duration.toFixed(1)}s, output ${encodedProbe.duration.toFixed(1)}s`);
    }
    const sampleAt = Math.max(1, Math.min((originalProbe.duration || 10) / 2, 3600));
    const decodeCheck = await run('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-ss', String(sampleAt), '-t', '10',
      '-i', temp, '-f', 'null', '-',
    ], { timeoutMs: 120000 });
    if (decodeCheck.code !== 0) {
      throw new Error(`decode check failed: ${truncate(decodeCheck.stderr, 400)}`);
    }

    const compressedSize = await fileSize(temp);
    const savedBytes = originalSize - compressedSize;
    const savedPercent = originalSize > 0 ? (savedBytes / originalSize) * 100 : 0;
    const minimum = minSavingsPercent ?? config.storage.compressMinSavingsPercent;
    if (compressedSize <= 0 || savedPercent < minimum) {
      await fsp.rm(temp, { force: true }).catch(() => {});
      return markSkipped(
        session,
        `only ${savedPercent.toFixed(1)}% smaller (minimum ${minimum}%)`,
        store,
        { compressedSize, savedBytes, savedPercent },
      );
    }

    // Atomic replace on the same filesystem. The fallback handles CIFS mounts
    // that refuse to rename over an existing file.
    try {
      await fsp.rename(temp, target);
    } catch (error) {
      if (!['EEXIST', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const backup = `${target}.orig-${process.pid}.mkv`;
      await fsp.rename(target, backup);
      try {
        await fsp.rename(temp, target);
        await fsp.rm(backup, { force: true }).catch(() => {});
      } catch (renameError) {
        await fsp.rename(backup, target).catch(() => {});
        throw renameError;
      }
    }

    const outputVideo = encodedProbe.streams.find((stream) => stream.type === 'video');
    const outputAudio = encodedProbe.streams.find((stream) => stream.type === 'audio');
    let checksum = null;
    if (config.recorder.checksum) {
      try {
        checksum = await sha256File(target);
      } catch (error) {
        logger.warn(`[${session.id}] checksum after compression failed: ${errorMessage(error)}`);
      }
    }
    session.final = {
      ...session.final,
      size: compressedSize,
      duration: encodedProbe.duration ?? session.final.duration,
      bitrate: encodedProbe.bitrate,
      quality: outputVideo ? {
        width: outputVideo.width,
        height: outputVideo.height,
        fps: outputVideo.fps,
        videoBitrate: outputVideo.bitrate,
        videoCodec: outputVideo.codec,
        audioCodec: outputAudio?.codec || null,
      } : session.final.quality,
      sha256: checksum,
      compressedAt: nowIso(),
    };
    setCompression(session, {
      status: 'done',
      progress: 100,
      compressedSize,
      savedBytes,
      savedPercent: Math.round(savedPercent * 10) / 10,
      durationMs: Date.now() - started,
      completedAt: nowIso(),
      error: null,
    }, store);
    try {
      session.metadataFile = await writeMetadata(session);
      store?.putSession(session);
    } catch (error) {
      logger.warn(`[${session.id}] metadata update after compression failed: ${errorMessage(error)}`);
    }
    store?.addEvent({
      event: 'compression-done',
      level: 'info',
      sessionId: session.id,
      message: `HEVC compression done: ${humanBytes(savedBytes)} saved (${savedPercent.toFixed(1)}%)`,
      meta: { originalSize, compressedSize, savedPercent: Math.round(savedPercent * 10) / 10, encoder: enc.name },
    });
    logger.info(
      `[${session.id}] HEVC compression done: ${humanBytes(originalSize)} -> ${humanBytes(compressedSize)} `
      + `(${savedPercent.toFixed(1)}% saved) in ${Math.round((Date.now() - started) / 1000)}s`,
      { encoder: enc.name },
    );
    return { ok: true, originalSize, compressedSize, savedBytes, savedPercent };
  } catch (error) {
    await fsp.rm(temp, { force: true }).catch(() => {});
    if (stopping) {
      setCompression(session, {
        status: 'queued',
        error: 'interrupted by shutdown',
        queuedAt: nowIso(),
      }, store);
      return { ok: false, interrupted: true };
    }
    return markFailed(session, error, store);
  }
}

async function backfill(store) {
  const days = config.storage.compressBackfillDays;
  if (!config.storage.compressEnabled || !days || days <= 0) return 0;
  const cutoff = Date.now() - days * 86400000;
  let queued = 0;
  for (const session of store.listSessions({ limit: 500 })) {
    if (session.status !== 'done' || !session.final?.file) continue;
    if (session.compression) continue;
    if (['hevc', 'av1'].includes(session.final.quality?.videoCodec)) continue;
    const when = Date.parse(
      session.final.verifiedAt || session.finalizedAt || session.endedAt || session.detectedAt || 0,
    );
    if (!Number.isFinite(when) || when < cutoff) continue;
    if (!(await pathExists(session.final.file))) continue;
    if (enqueueCompression(session, { reason: 'backfill' })) queued += 1;
  }
  if (queued) logger.info(`Queued ${queued} recent recording(s) for HEVC compression`);
  return queued;
}

async function recoverJobs(store) {
  for (const session of store.listSessions({ limit: 1000 })) {
    const status = session.compression?.status;
    if (status !== 'running' && status !== 'queued') continue;
    if (session.final?.file) {
      await restoreOriginalIfNeeded(session.final.file);
      await removeTempFiles(session.final.file);
    }
    if (status === 'running') {
      setCompression(session, {
        status: 'queued',
        error: 'interrupted; queued again',
        queuedAt: nowIso(),
      }, store);
    }
    queue.push({ id: session.id, force: true });
  }
  if (queue.length) void pump();
}

/**
 * Delete YouTube backups that are older than the configured retention when a
 * verified Twitch recording covers at least 95% of their duration.
 */
export async function pruneBackups(store, {
  days = config.storage.backupRetentionDays,
  now = Date.now(),
  dryRun = false,
} = {}) {
  if (!store || !days || days <= 0) return { pruned: 0, freedBytes: 0, candidates: [] };
  const cutoff = now - days * 86400000;
  const sessions = store.listSessions({ limit: 2000 });
  const candidates = [];
  let pruned = 0;
  let freedBytes = 0;

  for (const session of sessions) {
    if (session.platform !== 'youtube' || session.status !== 'done') continue;
    if (!session.final?.file || session.backupPruned) continue;
    const ended = Date.parse(
      session.endedAt || session.finalizedAt || session.final?.verifiedAt || session.detectedAt || 0,
    );
    if (!Number.isFinite(ended) || ended > cutoff) continue;
    const primary = findPrimaryCover(session, store);
    if (!primary) continue;
    const size = session.final.size || await fileSize(session.final.file);
    candidates.push({ id: session.id, file: session.final.file, size, twitchSessionId: primary.id });
    if (dryRun) continue;
    try {
      await fsp.rm(session.final.file, { force: true });
      const metaDir = session.metadataFile
        ? path.dirname(session.metadataFile)
        : path.join(
          session.destinationDir || config.recordingsDir,
          path.basename(config.archiveMetaDir),
          session.id,
        );
      await fsp.rm(metaDir, { recursive: true, force: true }).catch(() => {});
      session.backupPruned = {
        at: nowIso(),
        file: session.final.file,
        size,
        twitchSessionId: primary.id,
        reason: `older than ${days} days`,
      };
      session.final = { ...session.final, prunedFile: session.final.file, file: null, archived: false };
      store.putSession(session);
      store.addEvent({
        event: 'backup-pruned',
        level: 'info',
        sessionId: session.id,
        message: `Pruned YouTube backup ${path.basename(session.backupPruned.file)} (${humanBytes(size)})`,
        meta: { twitchSessionId: primary.id, freedBytes: size },
      });
      pruned += 1;
      freedBytes += size;
    } catch (error) {
      logger.warn(`[${session.id}] could not prune YouTube backup: ${errorMessage(error)}`);
    }
  }

  if (pruned) logger.info(`Pruned ${pruned} YouTube backup(s): ${humanBytes(freedBytes)} freed`);
  return { pruned, freedBytes, candidates };
}

export async function initStorage(store) {
  storageStore = store;
  const encoder = await detectEncoder();
  logger.info('Storage optimizer ready', {
    compress: config.storage.compressEnabled ? config.storage.compressQuality : 'disabled',
    encoder: encoder.name,
    encoderKind: encoder.kind,
    backupRetentionDays: config.storage.backupRetentionDays,
    backfillDays: config.storage.compressBackfillDays,
    vaapiDevice: fs.existsSync(config.storage.vaapiDevice) ? config.storage.vaapiDevice : 'missing',
  });
  if (config.storage.compressEnabled && !encoder.available) {
    logger.warn(`Compression is enabled but no encoder is available: ${encoder.reason || encoder.kind}`);
  }
  if (config.storage.compressEnabled && encoder.kind === 'x265') {
    logger.warn('Using CPU x265 for compression: expect several hours per 10 h recording. '
      + 'Mount /dev/dri and install the Intel/AMD VAAPI driver for hardware encoding.');
  }

  if (config.storage.compressEnabled) {
    await recoverJobs(store);
    await backfill(store);
  }

  const runPrune = () => pruneBackups(store).catch((error) => {
    logger.warn(`Backup retention failed: ${errorMessage(error)}`);
  });
  const initial = setTimeout(runPrune, 15000);
  initial.unref();
  pruneTimer = setInterval(runPrune, PRUNE_INTERVAL_MS);
  pruneTimer.unref();

  return {
    encoder,
    pruneBackups: runPrune,
    enqueue: enqueueCompression,
    async stop() {
      stopping = true;
      if (pruneTimer) clearInterval(pruneTimer);
      if (currentJob?.child) {
        currentJob.child.kill('SIGTERM');
        const deadline = Date.now() + 5000;
        while (currentJob?.child && Date.now() < deadline) await sleep(100);
        if (currentJob?.child) currentJob.child.kill('SIGKILL');
      }
    },
  };
}
