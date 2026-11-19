import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { nowIso } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

class Logger {
  constructor() {
    this.ring = [];
    this.maxRing = 800;
    this.stream = null;
    this.currentDay = null;
  }

  setLevel(level) {
    this.level = LEVELS[level] ? level : 'info';
  }

  ensureFile() {
    try {
      fs.mkdirSync(config.logsDir, { recursive: true });
      const day = new Date().toISOString().slice(0, 10);
      if (this.currentDay !== day || !this.stream) {
        this.stream?.end();
        this.stream = fs.createWriteStream(path.join(config.logsDir, `app-${day}.log`), { flags: 'a' });
        this.currentDay = day;
      }
    } catch {
      // Logging must never crash the recorder.
    }
  }

  write(level, message, meta = undefined) {
    const entry = {
      ts: nowIso(),
      level,
      message: String(message),
      ...(meta && typeof meta === 'object' ? { meta } : {}),
    };
    this.ring.push(entry);
    if (this.ring.length > this.maxRing) this.ring.splice(0, this.ring.length - this.maxRing);

    if ((LEVELS[level] || 20) >= (LEVELS[this.level] || 20)) {
      const suffix = meta && Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
      const line = `${entry.ts} ${level.toUpperCase().padEnd(5)} ${message}${suffix}`;
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    }
    this.ensureFile();
    this.stream?.write(`${JSON.stringify(entry)}\n`);
  }

  debug(message, meta) { this.write('debug', message, meta); }
  info(message, meta) { this.write('info', message, meta); }
  warn(message, meta) { this.write('warn', message, meta); }
  error(message, meta) { this.write('error', message, meta); }

  recent(limit = 100) {
    return this.ring.slice(-limit);
  }
}

export const logger = new Logger();
logger.setLevel(config.logLevel);

/**
 * Runs a command and streams every line to a per-session log file, while keeping
 * only recent meaningful lines in memory for the dashboard.
 */
export function createProcessLogger(file, onLine) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const stream = fs.createWriteStream(file, { flags: 'a' });
  let buffer = '';
  return {
    write(chunk) {
      const text = chunk.toString();
      stream.write(text);
      buffer += text;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.trim()) onLine?.(line.trim());
      }
    },
    close() {
      if (buffer.trim()) onLine?.(buffer.trim());
      buffer = '';
      stream.end();
    },
    stream,
  };
}

export function attachChildLogging(child, file, { prefix = '', onLine } = {}) {
  const plog = createProcessLogger(file, (line) => onLine?.(line));
  child.stdout?.on('data', (chunk) => plog.write(chunk));
  child.stderr?.on('data', (chunk) => {
    if (prefix) plog.stream.write(`${prefix}`);
    plog.write(chunk);
  });
  child.on('close', () => plog.close());
  return plog;
}
