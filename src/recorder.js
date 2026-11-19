import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { createProcessLogger, logger } from './logger.js';
import { fileSize, nowIso, sleep, truncate } from './util.js';

const PART_RE = /^part-(\d{4})\.(?!log$|json$)/;

function twitchArgs({ output, url, quality }) {
  const args = [
    '--loglevel', 'info',
    '--hls-live-edge', '3',
    '--stream-segment-threads', '3',
    '--stream-timeout', '60',
    '--retry-streams', '4',
    '--retry-open', '3',
    '--ringbuffer-size', '64M',
    '-o', output,
  ];
  if (!config.twitch.urlOverride) {
    if (config.twitch.disableAds) args.push('--twitch-disable-ads');
    if (config.twitch.oauthToken) {
      args.push('--twitch-api-header', `Authorization=OAuth ${config.twitch.oauthToken}`);
    }
  }
  args.push(url, quality || config.twitch.quality || 'best');
  return args;
}

function youtubeArgs({ output, videoId, firstAttempt }) {
  const height = config.youtube.maxHeight || 1080;
  const args = [
    '--no-playlist',
    '--no-warnings',
    '--newline',
    '--retries', '20',
    '--fragment-retries', '20',
    '--skip-unavailable-fragments',
    '--socket-timeout', '20',
    '--merge-output-format', 'mkv',
    '-f', `bv*[height<=${height}]+ba/b[height<=${height}]/b`,
    '-o', output,
  ];
  if (config.youtube.cookiesFile) args.push('--cookies', config.youtube.cookiesFile);
  // On the first attempt recover everything from the beginning of the DVR
  // window. On a restart this would duplicate hours of content, so follow the
  // live edge instead (the other platform/first part covers the downtime).
  if (firstAttempt && config.youtube.liveFromStart) args.push('--live-from-start');
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  return args;
}

export class CaptureController {
  constructor(session, { onUpdate, onFatal } = {}) {
    this.session = session;
    this.onUpdate = onUpdate;
    this.onFatal = onFatal;
    this.running = false;
    this.stopping = false;
    this.child = null;
    this.part = null;
    this.timer = null;
    this.lastGrowthAt = 0;
    this.lastSize = 0;
    this.mergingAt = 0;
    this.backoffMs = config.recorder.restartBackoffMs;
    this.stopWaiters = [];
    this.logFile = path.join(session.dir, 'capture.log');
    this.partIndex = (session.parts || []).reduce((max, p) => Math.max(max, Number(p.index) || 0), 0);
  }

  outputTemplate(index) {
    if (this.session.platform === 'twitch') {
      return path.join(this.session.dir, 'raw', `part-${String(index).padStart(4, '0')}.ts`);
    }
    return path.join(this.session.dir, 'raw', `part-${String(index).padStart(4, '0')}.%(ext)s`);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopping = false;
    this.session.recordingStartedAt ||= nowIso();
    this.session.status = 'recording';
    await this.launch();
    this.timer = setInterval(() => void this.watchdog(), config.recorder.watchdogMs);
    this.timer.unref?.();
  }

  buildCommand() {
    if (this.session.platform === 'twitch') {
      const url = config.twitch.urlOverride || `https://www.twitch.tv/${config.twitch.login}`;
      return {
        command: 'streamlink',
        args: twitchArgs({
          output: this.part.output,
          url,
          quality: config.twitch.urlOverride ? 'best' : config.twitch.quality,
        }),
      };
    }
    if (config.youtube.urlOverride) {
      return {
        command: 'yt-dlp',
        args: [
          '--no-warnings', '--newline', '--no-playlist',
          '--merge-output-format', 'mkv',
          '-f', `bv*[height<=${config.youtube.maxHeight}]+ba/b[height<=${config.youtube.maxHeight}]/b`,
          '-o', this.part.output,
          config.youtube.urlOverride,
        ],
      };
    }
    return {
      command: 'yt-dlp',
      args: youtubeArgs({
        output: this.part.output,
        videoId: this.session.videoId,
        firstAttempt: this.session.attempts === 1,
      }),
    };
  }

  async launch() {
    if (!this.running || this.stopping) return;
    this.session.attempts = (this.session.attempts || 0) + 1;
    this.partIndex += 1;
    const index = this.partIndex;
    const output = this.outputTemplate(index);
    const part = {
      index,
      attempt: this.session.attempts,
      output,
      files: [],
      startedAt: nowIso(),
      endedAt: null,
      bytes: 0,
      status: 'recording',
      command: null,
    };
    this.part = part;
    this.session.parts ||= [];
    this.session.parts.push(part);
    fs.mkdirSync(path.join(this.session.dir, 'raw'), { recursive: true });

    const { command, args } = this.buildCommand();
    part.command = `${command} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(' ')}`;

    logger.info(`[${this.session.id}] starting capture attempt ${this.session.attempts}`, {
      command: command === 'streamlink' ? 'streamlink' : 'yt-dlp',
      part: index,
    });

    const child = spawn(command, args, {
      cwd: this.session.dir,
      // A new process group lets the watchdog kill yt-dlp together with the
      // ffmpeg/fragment children it spawns. Otherwise an orphaned ffmpeg keeps
      // the stdout pipe open and Node never sees the capture as finished.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONUNBUFFERED: '1' },
    });
    this.child = child;
    this.lastGrowthAt = Date.now();
    this.lastSize = 0;

    const plog = createProcessLogger(this.logFile, (line) => this.handleLine(line, part));
    child.stdout.on('data', (chunk) => plog.write(chunk));
    child.stderr.on('data', (chunk) => plog.write(chunk));
    child.on('error', (error) => {
      logger.error(`[${this.session.id}] capture process error: ${error.message}`);
      this.handleLine(`ERROR spawn: ${error.message}`, part);
    });
    // Kill the group as soon as the direct child exits. On YouTube, yt-dlp can
    // leave an ffmpeg grandchild holding the stdout pipe; without this, Node's
    // 'close' event (and therefore the restart) never fires.
    child.on('exit', () => this.killGroup(child.pid));
    child.on('close', (code, signal) => {
      plog.close();
      void this.handleExit(part, code, signal);
    });

    this.onUpdate?.();
  }

  handleLine(line, part) {
    const clean = truncate(line, 500);
    const notes = this.session.notes ||= [];
    if (/\b(?:403|404|429)\b|error|failed|unavailable|forbidden/i.test(clean)) {
      notes.push({ ts: nowIso(), level: 'warn', line: clean });
      if (notes.length > 120) notes.splice(0, notes.length - 120);
      logger.warn(`[${this.session.id}] ${clean}`);
    } else if (/destination|opening stream|merging|filtering out|skipping|stream ended|live from start/i.test(clean)) {
      notes.push({ ts: nowIso(), level: 'info', line: clean });
      if (notes.length > 120) notes.splice(0, notes.length - 120);
    }
    const dest = clean.match(/Destination:\s*(.+)$/i)?.[1]?.trim();
    if (dest && !part.files.includes(dest)) part.files.push(dest);
    const merge = clean.match(/Merging formats into "(.+?)"/i)?.[1];
    if (merge && !part.files.includes(merge)) part.files.push(merge);
    if (/merging formats|fixing malformed|postprocess/i.test(clean)) this.mergingAt = Date.now();
  }

  listPartFiles(part) {
    try {
      const dir = path.join(this.session.dir, 'raw');
      const prefix = `part-${String(part.index).padStart(4, '0')}.`;
      return fs.readdirSync(dir)
        .filter((name) => name.startsWith(prefix) && PART_RE.test(name))
        .map((name) => path.join(dir, name));
    } catch {
      return [];
    }
  }

  async measure(part) {
    const files = this.listPartFiles(part);
    let bytes = 0;
    for (const file of files) bytes += await fileSize(file);
    part.files = [...new Set([...(part.files || []), ...files])];
    part.bytes = bytes;
    return bytes;
  }

  async watchdog() {
    if (!this.running || this.stopping || !this.child) return;
    const part = this.part;
    if (!part) return;
    if (this.mergingAt && Date.now() - this.mergingAt < 15 * 60 * 1000) return;
    const bytes = await this.measure(part);
    if (bytes > this.lastSize + 1024) {
      this.lastSize = bytes;
      this.lastGrowthAt = Date.now();
      part.status = 'recording';
      this.session.lastError = null;
      this.onUpdate?.();
      return;
    }
    const stalledFor = Date.now() - this.lastGrowthAt;
    if (stalledFor > config.recorder.stallTimeoutMs) {
      logger.warn(`[${this.session.id}] capture stalled for ${Math.round(stalledFor / 1000)}s; restarting`, {
        part: part.index,
        bytes,
      });
      part.status = 'stalled';
      this.session.lastError = `stalled ${Math.round(stalledFor / 1000)}s`;
      this.onUpdate?.();
      this.killChild('SIGKILL');
    }
  }

  killChild(signal) {
    if (!this.child?.pid) return;
    // Negative PID targets the whole process group (yt-dlp + ffmpeg children).
    try {
      process.kill(-this.child.pid, signal);
      return;
    } catch {
      // Not a group leader (or already gone): fall back to the direct child.
    }
    try {
      this.child.kill(signal);
    } catch {
      // already gone
    }
  }

  killGroup(pid) {
    if (!pid) return;
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      // group already gone
    }
  }

  async handleExit(part, code, signal) {
    const wasStopping = this.stopping;
    const pid = this.child?.pid;
    this.child = null;
    // Reap any yt-dlp/ffmpeg grandchild that survived the parent. This is
    // essential for YouTube: yt-dlp may leave an ffmpeg process writing to the
    // same part after a SIGKILL.
    this.killGroup(pid);
    part.endedAt = nowIso();
    await this.measure(part);
    part.status = wasStopping ? 'stopped' : (code === 0 ? 'ended' : 'failed');
    this.onUpdate?.();

    if (wasStopping || !this.running) {
      this.resolveStopWaiters();
      return;
    }

    this.session.restarts = (this.session.restarts || 0) + 1;
    logger.warn(`[${this.session.id}] capture exited (code=${code}, signal=${signal}); restart #${this.session.restarts}`, {
      part: part.index,
      bytes: part.bytes,
    });
    if (this.session.restarts === 3) {
      this.onFatal?.(new Error(`Capture restarted 3 times (last code ${code})`));
    }

    const delay = Math.min(this.backoffMs, 60000);
    this.backoffMs = Math.min(this.backoffMs * 2, 60000);
    await sleep(delay);
    if (this.running && !this.stopping) {
      await this.launch();
    } else {
      this.resolveStopWaiters();
    }
  }

  resolveStopWaiters() {
    const waiters = this.stopWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  async stop(reason = 'stream ended') {
    if (!this.running && !this.child) return;
    this.stopping = true;
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    logger.info(`[${this.session.id}] stopping capture: ${reason}`);

    if (!this.child) {
      this.resolveStopWaiters();
      return;
    }

    const exited = new Promise((resolve) => this.stopWaiters.push(resolve));
    this.killChild('SIGINT');
    const timeout = sleep(15000).then(() => 'timeout');
    const result = await Promise.race([exited.then(() => 'exited'), timeout]);
    if (result === 'timeout') {
      logger.warn(`[${this.session.id}] capture did not exit after SIGINT; sending SIGTERM`);
      this.killChild('SIGTERM');
      const second = await Promise.race([exited.then(() => 'exited'), sleep(8000).then(() => 'timeout')]);
      if (second === 'timeout') {
        logger.warn(`[${this.session.id}] killing capture with SIGKILL`);
        this.killChild('SIGKILL');
        await Promise.race([exited, sleep(5000)]);
      }
    }
    this.part = null;
    this.onUpdate?.();
  }

  async stopAndWait(reason) {
    await this.stop(reason);
    await fsp.mkdir(path.join(this.session.dir, 'raw'), { recursive: true });
  }
}
