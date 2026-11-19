import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_FILENAME_TEMPLATE, normalizeTwitchLogin } from './util.js';

function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'si', 'sí'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function float(value, fallback) {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : fallback;
}

const dataDir = path.resolve(process.env.DATA_DIR || '/data');
// Parent folder that contains all selectable destinations. In Docker this is
// mounted from VIDEOS_HOST_PATH (e.g. /media/videos) to /videos.
const videosRoot = path.resolve(process.env.VIDEOS_ROOT || '/videos');
const videosHostRoot = process.env.VIDEOS_HOST_ROOT || './videos';

export function displayPathFor(dir) {
  const resolved = path.resolve(dir);
  if (resolved === videosRoot) return videosHostRoot;
  if (resolved.startsWith(`${videosRoot}${path.sep}`)) {
    return path.join(videosHostRoot, path.relative(videosRoot, resolved));
  }
  return resolved;
}

// Final videos live on RECORDINGS_DIR (host path configured in .env). Raw
// chunks stay on local disk while recording so a network or storage hiccup
// cannot corrupt a live capture.
const recordingsDir = path.resolve(
  process.env.RECORDINGS_DIR || path.join(videosRoot, 'recordings'),
);
const archiveDisplayPath = process.env.ARCHIVE_DISPLAY_PATH || displayPathFor(recordingsDir);
const twitchChannelInput = process.env.TWITCH_CHANNEL || '';
const youtubeChannelInput = process.env.YOUTUBE_CHANNEL_ID || process.env.YOUTUBE_CHANNEL || '';
const youtubeLooksLikeId = /^UC[\w-]{22}$/.test(youtubeChannelInput.trim());

export const config = {
  appName: process.env.APP_NAME || 'Stream VOD Guard',
  appMark: process.env.APP_MARK || 'SV',
  filenameTemplate: process.env.FILENAME_TEMPLATE || DEFAULT_FILENAME_TEMPLATE,
  dataDir,
  videosRoot,
  videosHostRoot,
  recordingsDir,
  archiveDisplayPath,
  workDir: path.join(dataDir, 'work'),
  archiveMetaDir: path.join(recordingsDir, process.env.METADATA_DIR || '.stream-vod-guard'),
  logsDir: path.join(dataDir, 'logs'),
  stateFile: path.join(dataDir, 'state.json'),
  publicDir: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'web'),

  host: process.env.HOST || '127.0.0.1',
  port: int(process.env.PORT, 8787),
  timezone: process.env.TZ || 'Europe/Madrid',
  dashboardToken: process.env.DASHBOARD_TOKEN || '',

  twitch: {
    enabled: bool(process.env.TWITCH_ENABLED, true),
    channelInput: twitchChannelInput,
    login: normalizeTwitchLogin(twitchChannelInput),
    pollMs: int(process.env.TWITCH_POLL_MS, 5000),
    quality: process.env.TWITCH_QUALITY || 'best',
    // Set only for subscriber-only content / to reduce ads on your own account.
    oauthToken: process.env.TWITCH_OAUTH_TOKEN || '',
    disableAds: bool(process.env.TWITCH_DISABLE_ADS, true),
    // Used by the automated test to point the recorder at a local HLS server.
    urlOverride: process.env.TWITCH_URL_OVERRIDE || '',
    // Optional Helix credentials (not required: public GQL is used by default).
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
  },

  youtube: {
    enabled: bool(process.env.YOUTUBE_ENABLED, true),
    // Accepts a channel ID (UC...), a handle (@name), or a full YouTube URL.
    channelInput: youtubeChannelInput,
    channelId: youtubeLooksLikeId ? youtubeChannelInput.trim() : '',
    channelLabel: process.env.YOUTUBE_CHANNEL_LABEL || '',
    pollMs: int(process.env.YOUTUBE_POLL_MS, 30000),
    // Max height for the backup capture. 1080 keeps full quality; 720 saves disk.
    maxHeight: int(process.env.YOUTUBE_MAX_HEIGHT, 0),
    liveFromStart: bool(process.env.YOUTUBE_LIVE_FROM_START, true),
    cookiesFile: process.env.YT_COOKIES_FILE || '',
    urlOverride: process.env.YOUTUBE_URL_OVERRIDE || '',
    // Do not record YouTube members-only / unlisted streams unless cookies are supplied.
    allowUnavailable: bool(process.env.YOUTUBE_ALLOW_UNAVAILABLE, false),
  },

  recorder: {
    // Keep raw parts after a successful archive (normally deleted to save space).
    keepRaw: bool(process.env.KEEP_RAW, false),
    // Copy the final MKV to RECORDINGS_DIR. If it fails, the file stays local.
    archiveEnabled: bool(process.env.ARCHIVE_ENABLED ?? process.env.ARCHIVE_TO_NAS, true),
    // No-bytes-growth window before the watchdog kills and restarts a capture.
    // Twitch ad breaks can leave a 1-3 min hole when ads are filtered, so this
    // must be comfortably larger than an ad break.
    stallTimeoutMs: int(process.env.STALL_TIMEOUT_MS, 240000),
    // Minimum delay between restarts.
    restartBackoffMs: int(process.env.RESTART_BACKOFF_MS, 5000),
    // Max simultaneous finalizations (ffmpeg concat is I/O heavy).
    finalizeConcurrency: int(process.env.FINALIZE_CONCURRENCY, 1),
    // Grace period after the platform reports offline before finalizing.
    offlineGraceMs: int(process.env.OFFLINE_GRACE_MS, 90000),
    // How often the watchdog inspects child processes.
    watchdogMs: int(process.env.WATCHDOG_MS, 10000),
    // An apparently stalled live capture is only restarted if no bytes arrived
    // for this long. Keep above the platform's segment duration.
    minPartBytes: int(process.env.MIN_PART_BYTES, 1024),
    checksum: bool(process.env.CHECKSUM, true),
  },

  audit: {
    enabled: bool(process.env.VOD_AUDIT_ENABLED, true),
    // Twitch applies mutes to VODs after the broadcast. Poll for the VOD and its
    // muted segments for this long so the system can prove the live copy is clean.
    vodPollMs: int(process.env.VOD_POLL_MS, 60000),
    vodWatchMaxMs: int(process.env.VOD_WATCH_MAX_MS, 24 * 60 * 60 * 1000),
    silenceNoiseDb: float(process.env.SILENCE_NOISE_DB, -55),
    silenceMinDurationSec: int(process.env.SILENCE_MIN_SECONDS, 20),
    // A muted VOD interval is considered "saved" if our copy has audio above this.
    muteSampleSeconds: int(process.env.MUTE_SAMPLE_SECONDS, 30),
    mutePassDb: float(process.env.MUTE_PASS_DB, -55),
  },

  disk: {
    // Local disk holds raw chunks while recording. Refuse below this.
    minFreeGb: float(process.env.MIN_FREE_GB, 20),
    warnFreeGb: float(process.env.WARN_FREE_GB, 60),
    // Destination holds the final MKVs. Refuse to finalize below this (raw is kept safe).
    minFreeArchiveGb: float(process.env.MIN_FREE_ARCHIVE_GB, 30),
    warnFreeArchiveGb: float(process.env.WARN_FREE_ARCHIVE_GB, 100),
  },

  // 0 = keep forever. Otherwise remove finalized recordings older than N days.
  retentionDays: int(process.env.RETENTION_DAYS, 0),

  notify: {
    ntfyUrl: process.env.NTFY_URL || '',
    ntfyTopic: process.env.NTFY_TOPIC || '',
    ntfyToken: process.env.NTFY_TOKEN || '',
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || '',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || '',
    discordWebhook: process.env.DISCORD_WEBHOOK || '',
    // Notify on every live start/end; failures are always notified.
    onLive: bool(process.env.NOTIFY_ON_LIVE, true),
  },

  logLevel: process.env.LOG_LEVEL || 'info',
};

export function ensureDirs() {
  const required = [config.dataDir, config.workDir, config.logsDir];
  for (const dir of required) {
    fs.mkdirSync(dir, { recursive: true });
  }
  // The destination can be temporarily unavailable. Do not prevent the recorder from
  // starting: finals stay local and archive retries later.
  for (const dir of [config.recordingsDir, config.archiveMetaDir]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch {
      // handled by archiveFinal / checkWritable
    }
  }
}

export function publicConfig() {
  return {
    appName: config.appName,
    appMark: config.appMark,
    filenameTemplate: config.filenameTemplate,
    twitch: {
      enabled: config.twitch.enabled,
      login: config.twitch.login,
      pollMs: config.twitch.pollMs,
      quality: config.twitch.quality,
      disableAds: config.twitch.disableAds,
    },
    youtube: {
      enabled: config.youtube.enabled,
      channelId: config.youtube.channelId,
      channelLabel: config.youtube.channelLabel,
      pollMs: config.youtube.pollMs,
      maxHeight: config.youtube.maxHeight,
      liveFromStart: config.youtube.liveFromStart,
    },
    recorder: {
      stallTimeoutMs: config.recorder.stallTimeoutMs,
      offlineGraceMs: config.recorder.offlineGraceMs,
      checksum: config.recorder.checksum,
      keepRaw: config.recorder.keepRaw,
      archiveEnabled: config.recorder.archiveEnabled,
    },
    paths: {
      recordings: config.archiveDisplayPath,
      recordingsDir: config.recordingsDir,
      work: config.workDir,
      videosRoot: config.videosRoot,
      videosHostRoot: config.videosHostRoot,
    },
    disk: config.disk,
    retentionDays: config.retentionDays,
  };
}
