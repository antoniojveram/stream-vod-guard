import fs from 'node:fs';
import { config } from './config.js';
import { atomicWriteJson, nowIso, readJson } from './util.js';

const MAX_EVENTS = 1500;

function defaultState() {
  return {
    version: 1,
    createdAt: nowIso(),
    monitors: {
      twitch: {
        name: 'twitch',
        status: 'starting',
        lastPollAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        liveSince: null,
        viewers: null,
        game: null,
        title: null,
        streamId: null,
        nextPollAt: null,
      },
      youtube: {
        name: 'youtube',
        status: 'starting',
        lastPollAt: null,
        lastSuccessAt: null,
        lastError: null,
        consecutiveFailures: 0,
        liveSince: null,
        videoId: null,
        title: null,
        nextPollAt: null,
        seenVideoIds: [],
      },
    },
    sessions: {},
    events: [],
  };
}

export class Store {
  constructor(file = config.stateFile) {
    this.file = file;
    this.state = defaultState();
    this.saveTimer = null;
    this.dirty = false;
    this.saving = Promise.resolve();
  }

  async init() {
    const loaded = readJson(this.file);
    if (loaded && typeof loaded === 'object') {
      this.state = {
        ...defaultState(),
        ...loaded,
        monitors: { ...defaultState().monitors, ...(loaded.monitors || {}) },
        sessions: loaded.sessions || {},
        events: Array.isArray(loaded.events) ? loaded.events.slice(-MAX_EVENTS) : [],
      };
      // A process that died mid-finalization leaves status in-flight. Keep it so
      // recovery can either resume or finalize without losing the parts.
      for (const monitor of Object.values(this.state.monitors)) {
        monitor.status = monitor.status === 'live' ? 'starting' : monitor.status;
      }
    }
    return this;
  }

  scheduleSave(delayMs = 400) {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.saveNow();
    }, delayMs);
  }

  async saveNow() {
    if (!this.dirty) return this.saving;
    this.dirty = false;
    const snapshot = JSON.stringify(this.state);
    this.saving = this.saving.then(async () => {
      await atomicWriteJson(this.file, JSON.parse(snapshot));
    }).catch(() => {});
    return this.saving;
  }

  async flush() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = true;
    await this.saveNow();
  }

  getSession(id) {
    return this.state.sessions[id] || null;
  }

  putSession(session) {
    session.updatedAt = nowIso();
    this.state.sessions[session.id] = session;
    this.scheduleSave();
    return session;
  }

  listSessions({ limit = 100, active = false } = {}) {
    const list = Object.values(this.state.sessions)
      .sort((a, b) => Date.parse(b.detectedAt || b.createdAt || 0) - Date.parse(a.detectedAt || a.createdAt || 0));
    const filtered = active
      ? list.filter((s) => ['recording', 'ending', 'finalizing'].includes(s.status))
      : list;
    return filtered.slice(0, limit);
  }

  activeSessions() {
    return Object.values(this.state.sessions).filter((s) =>
      ['recording', 'ending', 'finalizing'].includes(s.status));
  }

  addEvent({ event, message, level = 'info', sessionId = null, meta = undefined }) {
    const entry = {
      ts: nowIso(),
      event,
      level,
      message,
      ...(sessionId ? { sessionId } : {}),
      ...(meta ? { meta } : {}),
    };
    this.state.events.push(entry);
    if (this.state.events.length > MAX_EVENTS) {
      this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    }
    this.scheduleSave();
    return entry;
  }

  recentEvents(limit = 100) {
    return this.state.events.slice(-limit);
  }

  setMonitor(name, patch) {
    const monitor = this.state.monitors[name];
    if (!monitor) return;
    Object.assign(monitor, patch);
    this.scheduleSave();
  }

  getMonitor(name) {
    return this.state.monitors[name] || null;
  }

  stats() {
    const sessions = Object.values(this.state.sessions);
    const bytes = sessions.reduce((acc, s) => acc + (s.final?.size || 0), 0);
    return {
      sessions: sessions.length,
      finalized: sessions.filter((s) => s.status === 'done').length,
      active: this.activeSessions().length,
      bytes,
    };
  }
}

export function createSession({
  id: providedId = null,
  platform,
  streamId = null,
  videoId = null,
  title,
  game = null,
  streamStartedAt,
  detectedAt = nowIso(),
  dir,
}) {
  const id = providedId || (platform === 'twitch'
    ? `twitch-${streamId || Date.now()}`
    : `youtube-${videoId || Date.now()}`);
  return {
    id,
    key: id,
    platform,
    channel: platform === 'twitch' ? config.twitch.login : config.youtube.channelLabel,
    streamId,
    videoId,
    title: title || `${platform} stream`,
    game,
    streamStartedAt: streamStartedAt || null,
    detectedAt,
    recordingStartedAt: null,
    endedAt: null,
    finalizedAt: null,
    status: 'recording',
    dir,
    parts: [],
    attempts: 0,
    restarts: 0,
    lastError: null,
    coverage: null,
    twitchVod: null,
    audit: null,
    final: null,
    notes: [],
    createdAt: nowIso(),
  };
}

export function ensureSessionDirs(session) {
  for (const sub of ['raw', 'final']) {
    fs.mkdirSync(`${session.dir}/${sub}`, { recursive: true });
  }
}
