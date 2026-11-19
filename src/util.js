import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function nowIso() {
  return new Date().toISOString();
}

export function formatDuration(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function hms(totalSeconds) {
  const s = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export function humanBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[i]}`;
}

export function sanitizeFilename(input, maxLength = 130) {
  let name = String(input || 'stream')
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[\/\\:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[.\-\s]+/, '')
    .trim();
  if (!name) name = 'stream';
  if (name.length > maxLength) name = name.slice(0, maxLength).trim();
  return name;
}

export function sessionDirName({ platform, id, title, startedAt }) {
  const date = new Date(startedAt || Date.now());
  const stamp = date.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  return `${stamp}_${sanitizeFilename(title || platform, 80)}_${sanitizeFilename(id, 40)}`;
}

export function localStamp(dateValue, timeZone = 'Europe/Madrid') {
  const date = new Date(dateValue || Date.now());
  try {
    const parts = new Intl.DateTimeFormat('sv-SE', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date);
    const get = (type) => parts.find((p) => p.type === type)?.value || '00';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}-${get('minute')}`;
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

export const DEFAULT_FILENAME_TEMPLATE = '{channel} - {date} - {title} [{platform}-{id}]';

/**
 * Media-library friendly final name. Template placeholders:
 * {channel} {date} {title} {platform} {id} {game}
 */
export function finalFileName(session, timeZone = 'Europe/Madrid', template = DEFAULT_FILENAME_TEMPLATE) {
  const when = localStamp(session.streamStartedAt || session.detectedAt || Date.now(), timeZone);
  const id = session.platform === 'twitch'
    ? (session.streamId || 'live')
    : (session.videoId || 'live');
  const values = {
    channel: session.channel || 'channel',
    date: when,
    title: session.title || 'stream',
    platform: session.platform || 'live',
    id: String(id),
    game: session.game || '',
  };
  let name = String(template || DEFAULT_FILENAME_TEMPLATE)
    .replace(/\{(\w+)\}/g, (_, key) => (values[key] ?? ''));
  name = sanitizeFilename(name, 180);
  if (!name || name === '.mkv') name = `${sanitizeFilename(values.channel, 40)} - ${when}`;
  if (!name.toLowerCase().endsWith('.mkv')) name += '.mkv';
  return name;
}

/** Accepts "channel", "@channel" or "https://twitch.tv/channel". */
export function normalizeTwitchLogin(input) {
  let value = String(input || '').trim();
  const match = value.match(/twitch\.tv\/([^/?#]+)/i);
  if (match) value = match[1];
  value = value.replace(/^@/, '').toLowerCase();
  return value;
}

export async function diskFreeBytes(dir) {
  try {
    const stats = await fsp.statfs(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return 0;
  }
}

export async function copyFileVerified(src, dest, { onProgress } = {}) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.copying`;
  await fsp.copyFile(src, tmp);
  const [srcStat, tmpStat] = await Promise.all([fsp.stat(src), fsp.stat(tmp)]);
  if (srcStat.size !== tmpStat.size) {
    await fsp.rm(tmp, { force: true });
    throw new Error(`Copy size mismatch (${srcStat.size} != ${tmpStat.size})`);
  }
  await fsp.rename(tmp, dest);
  onProgress?.(tmpStat.size);
  return tmpStat.size;
}

export async function removeQuietly(target) {
  try {
    await fsp.rm(target, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

export async function atomicWriteJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const body = JSON.stringify(value, null, 2);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(tmp, body);
  await fsp.rename(tmp, file);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

export function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

export function run(command, args, options = {}) {
  const {
    timeoutMs = 120000,
    cwd,
    env,
    maxOutput = 2 * 1024 * 1024,
    input,
  } = options;

  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let killedByTimeout = false;
    const timer = timeoutMs > 0
      ? setTimeout(() => {
        killedByTimeout = true;
        child.kill('SIGKILL');
      }, timeoutMs)
      : null;

    child.stdout.on('data', (chunk) => {
      if (stdout.length < maxOutput) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (stderr.length < maxOutput) stderr += chunk.toString();
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: -1, stdout, stderr: `${stderr}\n${error.message}`, killedByTimeout });
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, signal, stdout, stderr, killedByTimeout });
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

export async function fileSize(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

export async function pathExists(file) {
  try {
    await fsp.access(file);
    return true;
  } catch {
    return false;
  }
}

export function parseIso(value) {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Twitch muted segments look like { offset, duration } in seconds.
 * Merge overlapping/adjacent ranges and clamp them to the VOD length.
 */
export function normalizeMuteSegments(segments, lengthSeconds = Infinity) {
  if (!Array.isArray(segments)) return [];
  const ranges = segments
    .map((s) => ({
      start: Number(s.offset ?? s.start ?? 0),
      duration: Number(s.duration ?? 0),
    }))
    .filter((s) => Number.isFinite(s.start) && Number.isFinite(s.duration) && s.duration > 0)
    .map((s) => ({ start: Math.max(0, s.start), end: Math.min(lengthSeconds, s.start + s.duration) }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start);

  const merged = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push({ ...range });
    }
  }
  return merged.map((r) => ({
    offset: Math.round(r.start * 1000) / 1000,
    duration: Math.round((r.end - r.start) * 1000) / 1000,
    start: r.start,
    end: r.end,
  }));
}

export function parseSilenceDetect(stderr, minDuration = 0) {
  const starts = [...String(stderr).matchAll(/silence_start:\s*(-?\d+(?:\.\d+)?)/g)]
    .map((m) => Number(m[1]));
  const ends = [...String(stderr).matchAll(/silence_end:\s*(-?\d+(?:\.\d+)?)\s*\|\s*silence_duration:\s*(\d+(?:\.\d+)?)/g)]
    .map((m) => ({ end: Number(m[1]), duration: Number(m[2]) }));
  const out = [];
  for (let i = 0; i < starts.length; i += 1) {
    const info = ends[i];
    if (!info) continue;
    if (info.duration >= minDuration) {
      out.push({ start: Math.max(0, starts[i]), end: info.end, duration: info.duration });
    }
  }
  return out;
}

export function parseMeanVolume(stderr) {
  const m = String(stderr).match(/mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? Number(m[1]) : null;
}

export function parseMaxVolume(stderr) {
  const m = String(stderr).match(/max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/);
  return m ? Number(m[1]) : null;
}

export function bytesToGb(bytes) {
  return (Number(bytes) || 0) / (1024 ** 3);
}

export function errorMessage(error) {
  if (!error) return 'unknown error';
  return error?.message || String(error);
}

export function truncate(text, length = 300) {
  const s = String(text ?? '');
  return s.length > length ? `${s.slice(0, length)}…` : s;
}

export function sortByStart(a, b) {
  return (a.startedAt || 0) - (b.startedAt || 0);
}
