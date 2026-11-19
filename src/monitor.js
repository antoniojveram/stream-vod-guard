import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, displayPathFor } from './config.js';
import { logger } from './logger.js';
import { notifyError, notifyFinal, notifyLive } from './notify.js';
import { CaptureController } from './recorder.js';
import { createSession, ensureSessionDirs } from './store.js';
import {
  auditSummary,
  finalizeSession,
  reauditTwitchSession,
  reconcileParts,
  retryPendingArchives,
} from './postprocess.js';
import { validateDestination } from './settings.js';
import { enqueueCompression } from './storage.js';
import { findVodForStream, getStream, getVodMutes } from './twitch.js';
import { detectLiveFromRss, getLiveVideo, resolveYouTubeChannelId } from './youtube.js';
import {
  diskFreeBytes,
  errorMessage,
  formatDuration,
  humanBytes,
  normalizeTwitchLogin,
  nowIso,
  pathExists,
  sleep,
  truncate,
} from './util.js';

const GB = 1024 ** 3;

export class Archiver {
  constructor(store) {
    this.store = store;
    this.controllers = new Map();
    this.finalizeQueue = Promise.resolve();
    this.vodWatchers = new Map();
    this.stopping = false;
    this.lastDiskWarnAt = 0;
    this.lastMaintenanceAt = 0;
    this.lastArchiveRetryAt = 0;
    this.lastRetentionAt = 0;
    this.retryingArchives = false;
    this.sessionStartGuard = new Set();
  }

  async recover() {
    const sessions = Object.values(this.store.state.sessions);
    for (const session of sessions) {
      if (!['recording', 'ending', 'finalizing'].includes(session.status)) continue;
      try {
        await reconcileParts(session);
        const usable = (session.parts || []).some((p) => (p.files || []).length > 0);
        if (!usable) {
          session.status = 'failed';
          session.lastError = 'No capture files found after restart';
          this.store.putSession(session);
          logger.warn(`[${session.id}] no parts found during recovery`);
          continue;
        }
        if (session.status === 'finalizing') {
          session.status = 'ending';
          session.needsFinalize = true;
        } else {
          session.status = 'recording';
          session.needsRecovery = true;
        }
        delete session._ending;
        session.attempts ||= 0;
        this.store.putSession(session);
        logger.info(`[${session.id}] recovered ${session.parts.length} parts`, {
          previousStatus: session.status,
        });
      } catch (error) {
        logger.warn(`[${session.id}] recovery failed: ${truncate(errorMessage(error), 200)}`);
      }
    }
    await this.store.saveNow();
  }

  activeFor(platform) {
    return this.store.listSessions({ active: true, limit: 50 })
      .filter((s) => s.platform === platform);
  }

  findActive(platform, { streamId, videoId } = {}) {
    return this.activeFor(platform).find((s) => {
      if (s.status !== 'recording') return false;
      if (platform === 'twitch' && streamId) return String(s.streamId) === String(streamId);
      if (platform === 'youtube' && videoId) return String(s.videoId) === String(videoId);
      return false;
    }) || null;
  }

  async ensureLocalDisk() {
    const free = await diskFreeBytes(config.workDir);
    if (free < config.disk.minFreeGb * GB) {
      const now = Date.now();
      if (now - this.lastDiskWarnAt > 10 * 60 * 1000) {
        this.lastDiskWarnAt = now;
        const msg = `Local disk has ${humanBytes(free)} free; minimum ${config.disk.minFreeGb} GB. New recordings will not start.`;
        logger.error(msg);
        this.store.addEvent({ event: 'disk-low', level: 'error', message: msg });
        void notifyError('Local disk full', msg);
      }
      return false;
    }
    return true;
  }

  async startSession(platform, info) {
    if (!(await this.ensureLocalDisk())) return null;
    const streamId = platform === 'twitch' ? String(info.streamId) : null;
    const videoId = platform === 'youtube' ? String(info.videoId) : null;
    const baseId = platform === 'twitch' ? `twitch-${streamId}` : `youtube-${videoId}`;

    // A live can come back after a manual finalize or a long disconnect with the
    // same platform ID. Reuse the running session, but never silently skip a
    // new capture because an old terminal session has the same ID.
    let id = baseId;
    let suffix = 2;
    for (;;) {
      const existing = this.store.getSession(id);
      if (!existing) break;
      if (['recording', 'ending', 'finalizing'].includes(existing.status)) return existing;
      id = `${baseId}-r${suffix}`;
      suffix += 1;
    }
    if (this.sessionStartGuard.has(baseId)) return null;
    this.sessionStartGuard.add(baseId);

    try {
      const dir = path.join(config.workDir, id);
      const session = createSession({
        id,
        platform,
        streamId,
        videoId,
        title: info.title,
        game: info.game || null,
        streamStartedAt: info.streamStartedAt || nowIso(),
        dir,
      });
      if (info.startedAtEstimated) session.startedAtEstimated = true;
      // Snapshot the destination: changing the folder from the UI must not move
      // a recording that is already in progress.
      session.destinationDir = config.recordingsDir;
      session.destinationDisplayPath = config.archiveDisplayPath;
      ensureSessionDirs(session);
      session.diskFreeAtStart = await diskFreeBytes(config.workDir);
      this.store.putSession(session);
      this.store.addEvent({
        event: 'live-detected',
        level: 'info',
        sessionId: id,
        message: `Directo detectado en ${platform}: ${session.title}`,
        meta: { streamId, videoId },
      });
      logger.info(`[${id}] live detected: ${session.title}`, { platform, streamId, videoId });

      const controller = this.createController(session);
      this.controllers.set(id, controller);
      try {
        await controller.start();
        void notifyLive(session);
      } catch (error) {
        session.lastError = truncate(errorMessage(error), 400);
        this.store.putSession(session);
        logger.error(`[${id}] could not start capture: ${session.lastError}`);
        void notifyError(`Could not start recording (${platform})`, session.lastError);
      }
      return session;
    } finally {
      this.sessionStartGuard.delete(baseId);
    }
  }

  createController(session) {
    return new CaptureController(session, {
      onUpdate: () => this.store.putSession(session),
      onFatal: (error) => {
        this.store.addEvent({
          event: 'capture-unstable',
          level: 'error',
          sessionId: session.id,
          message: `Unstable capture: ${truncate(error.message, 300)}`,
        });
        void notifyError(`Unstable capture: ${session.title}`, error.message);
      },
    });
  }

  async resumeSession(session) {
    if (session.status !== 'recording') return;
    if (this.controllers.has(session.id)) return;
    await reconcileParts(session);
    if (!(session.parts || []).some((p) => (p.files || []).length > 0)) {
      session.status = 'failed';
      session.lastError = 'No files to resume';
      this.store.putSession(session);
      return;
    }
    logger.info(`[${session.id}] resuming capture after restart`);
    const controller = this.createController(session);
    this.controllers.set(session.id, controller);
    session.needsRecovery = false;
    this.store.putSession(session);
    await controller.start();
  }

  async endSession(session, reason = 'stream ended') {
    if (!session) return null;
    if (['finalizing', 'done', 'failed', 'archived-pending'].includes(session.status)) return null;
    if (session._ending) return null;
    session._ending = true;
    session.status = 'ending';
    session.endedAt ||= nowIso();
    this.store.putSession(session);
    logger.info(`[${session.id}] stream ended: ${reason}`);

    const controller = this.controllers.get(session.id);
    if (controller) {
      try {
        await controller.stopAndWait(reason);
      } catch (error) {
        logger.warn(`[${session.id}] controller stop error: ${truncate(errorMessage(error), 200)}`);
      }
      this.controllers.delete(session.id);
    }
    this.enqueueFinalize(session);
    return session;
  }

  enqueueFinalize(session) {
    this.finalizeQueue = this.finalizeQueue
      .then(async () => {
        if (this.stopping) {
          session.status = 'ending';
          this.store.putSession(session);
          return null;
        }
        const result = await finalizeSession(session, {
          store: this.store,
          onUpdate: () => this.store.putSession(session),
        });
        const summary = auditSummary(session.audit);
        const archivePending = session.status === 'archived-pending';
        this.store.addEvent({
          event: result.ok ? (archivePending ? 'finalized-local' : 'finalized') : 'finalize-failed',
          level: result.ok ? (archivePending ? 'warn' : 'info') : 'error',
          sessionId: session.id,
          message: result.ok
            ? (archivePending
              ? `Local recording ready (${formatDuration(result.duration || 0)} · ${humanBytes(session.final?.size || 0)}); pending copy to destination`
              : `Recording ready: ${formatDuration(result.duration || 0)} · ${humanBytes(session.final?.size || 0)} · ${summary.line}`)
            : `Could not finalize: ${truncate(result.error, 400)}`,
          meta: { file: session.final?.file || null, audit: summary.muteChecks },
        });
        if (result.ok) {
          void notifyFinal(session, summary);
          this.scheduleVodWatch(session);
          if (session.status === 'done') enqueueCompression(session);
        } else {
          void notifyError(`Error finalizing ${session.title}`, result.error);
        }
        return result;
      })
      .catch((error) => {
        logger.error(`[${session.id}] finalize queue error: ${errorMessage(error)}`);
        session.status = 'failed';
        session.lastError = truncate(errorMessage(error), 500);
        this.store.putSession(session);
        return null;
      });
    return this.finalizeQueue;
  }

  /**
   * Twitch scans the archive after the broadcast. We keep polling so we can
   * (a) record when mutes appear and (b) verify our live copy has audio there.
   */
  scheduleVodWatch(session) {
    if (session.platform !== 'twitch') return;
    if (!config.audit.enabled) return;
    if (this.vodWatchers.has(session.id)) return;
    const state = { startedAt: Date.now(), vodId: null, firstMuteSeenAt: null, status: 'waiting-vod' };
    this.vodWatchers.set(session.id, state);

    const task = (async () => {
      let vod = null;
      const vodDeadline = Date.now() + 45 * 60 * 1000;
      while (!this.stopping && Date.now() < vodDeadline) {
        try {
          vod = await findVodForStream(session.streamStartedAt);
          if (vod) break;
        } catch (error) {
          logger.debug(`[${session.id}] VOD discovery: ${truncate(error.message, 120)}`);
        }
        await sleep(60000);
      }
      if (!vod) {
        state.status = 'vod-not-found';
        this.store.addEvent({
          event: 'vod-not-found',
          level: 'warn',
          sessionId: session.id,
          message: 'Twitch VOD not found for mute audit',
        });
        return;
      }
      state.vodId = vod.id;
      state.status = 'waiting-mutes';
      session.twitchVod = {
        ...vod,
        discoveredAt: nowIso(),
        watchStartedAt: new Date(state.startedAt).toISOString(),
      };
      this.store.putSession(session);
      logger.info(`[${session.id}] Twitch VOD found: ${vod.id}`, { length: formatDuration(vod.lengthSeconds) });

      const muteDeadline = Date.now() + config.audit.vodWatchMaxMs;
      let lastMuteCount = -1;
      while (!this.stopping && Date.now() < muteDeadline) {
        try {
          const info = await getVodMutes(vod.id);
          const count = info.mutedSegments.length;
          const endedMs = Date.parse(session.lastSeenLiveAt || session.endedAt || session.finalizedAt || nowIso());
          const now = Date.now();
          session.twitchVod = {
            ...session.twitchVod,
            ...info,
            discoveredAt: session.twitchVod?.discoveredAt,
            lastPolledAt: new Date(now).toISOString(),
            mutesAlreadyPresent: state.firstMuteSeenAt ? false : (count > 0 ? null : false),
          };
          if (count > 0 && !state.firstMuteSeenAt) {
            state.firstMuteSeenAt = now;
            state.status = 'muted';
            session.twitchVod.firstMuteSeenAt = new Date(now).toISOString();
            session.twitchVod.firstPollMuteCount = count;
            session.twitchVod.secondsAfterStreamEnd = Number.isFinite(endedMs)
              ? Math.round((now - endedMs) / 1000)
              : null;
            this.store.putSession(session);
            this.store.addEvent({
              event: 'twitch-muted',
              level: 'warn',
              sessionId: session.id,
              message: `Twitch muted ${count} segments (${formatDuration(info.mutedSegments.reduce((a, s) => a + s.duration, 0))}) in the VOD, ` +
                `${session.twitchVod.secondsAfterStreamEnd ?? '?'}s after the stream ended`,
              meta: { vodId: vod.id, mutedSegments: count },
            });
            await reauditTwitchSession(session, info, this.store);
            state.status = 'done';
            return;
          }
          if (count !== lastMuteCount) {
            lastMuteCount = count;
            this.store.putSession(session);
          }
          if (count === 0 && Date.now() - state.startedAt > 6 * 60 * 60 * 1000) {
            session.audit = {
              checkedAt: nowIso(),
              vodId: vod.id,
              mutedSegments: 0,
              verdict: 'no-mutes',
              segments: [],
            };
            this.store.putSession(session);
            state.status = 'no-mutes';
            return;
          }
        } catch (error) {
          logger.debug(`[${session.id}] mute poll: ${truncate(error.message, 120)}`);
        }
        await sleep(config.audit.vodPollMs);
      }
      state.status = 'timeout';
    })().catch((error) => {
      state.status = 'error';
      logger.warn(`[${session.id}] VOD watch failed: ${truncate(errorMessage(error), 200)}`);
    }).finally(() => {
      this.vodWatchers.delete(session.id);
    });
    void task;
  }

  async maintenance() {
    if (this.stopping) return;
    const now = Date.now();
    if (now - this.lastMaintenanceAt < 15000) return;
    this.lastMaintenanceAt = now;

    for (const session of this.store.activeSessions()) {
      const controller = this.controllers.get(session.id);
      if (!controller) continue;
      const bytes = (session.parts || []).reduce((acc, p) => acc + (p.bytes || 0), 0);
      const started = Date.parse(session.recordingStartedAt || session.detectedAt);
      const elapsed = Number.isFinite(started) ? (now - started) / 1000 : 0;
      session.liveStats = {
        bytes,
        restarts: session.restarts || 0,
        elapsedSeconds: Math.round(elapsed),
        bitrateKbps: elapsed > 5 ? Math.round((bytes * 8) / elapsed / 1000) : null,
        updatedAt: nowIso(),
      };
      session.diskFreeGb = Math.round((await diskFreeBytes(config.workDir) / GB) * 10) / 10;
      this.store.putSession(session);
    }

    const free = await diskFreeBytes(config.workDir);
    if (free < 2 * GB && this.store.activeSessions().length) {
      const msg = `Local disk below 2 GB (${humanBytes(free)}). Stopping recordings to avoid corruption.`;
      logger.error(msg);
      this.store.addEvent({ event: 'disk-critical', level: 'error', message: msg });
      void notifyError('Local disk critical', msg);
      for (const session of this.store.activeSessions()) {
        await this.endSession(session, 'local disk critical');
      }
    }

    if (now - this.lastArchiveRetryAt > 60000) {
      this.lastArchiveRetryAt = now;
      if (!this.retryingArchives) {
        this.retryingArchives = true;
        void retryPendingArchives(this.store, {
          onArchived: (session) => enqueueCompression(session),
        }).finally(() => {
          this.retryingArchives = false;
        });
      }
    }
    if (now - this.lastRetentionAt > 60 * 60 * 1000) {
      this.lastRetentionAt = now;
      await this.cleanupRetention();
    }
  }

  async cleanupRetention() {
    if (!config.retentionDays || config.retentionDays <= 0) return;
    const cutoff = Date.now() - config.retentionDays * 24 * 60 * 60 * 1000;
    for (const session of this.store.listSessions({ limit: 1000 })) {
      if (session.status !== 'done' || !session.final?.file) continue;
      if (session.deletedAt) continue;
      const finalized = Date.parse(session.finalizedAt || 0);
      if (!Number.isFinite(finalized) || finalized > cutoff) continue;
      try {
        await fsp.rm(session.final.file, { force: true });
        session.deletedAt = nowIso();
        session.status = 'deleted';
        this.store.putSession(session);
        logger.info(`[${session.id}] retention: deleted ${session.final.file}`);
      } catch (error) {
        logger.warn(`[${session.id}] retention delete failed: ${errorMessage(error)}`);
      }
    }
  }

  async shutdown() {
    this.stopping = true;
    const controllers = [...this.controllers.values()];
    logger.info(`Stopping ${controllers.length} active capture(s)…`);
    await Promise.allSettled(controllers.map((c) => c.stop('shutdown')));
    for (const session of this.store.activeSessions()) {
      session.status = 'ending';
      this.store.putSession(session);
    }
    await this.store.flush();
  }
}

class TwitchMonitor {
  constructor(archiver) {
    this.archiver = archiver;
    this.store = archiver.store;
    this.stopping = false;
    this.offlineSince = null;
    this.failures = 0;
    this.pollTimer = null;
  }

  setState(patch) {
    this.store.setMonitor('twitch', patch);
  }

  async start() {
    this.setState({ status: 'starting', nextPollAt: new Date(Date.now() + 100).toISOString() });
    void this.loop();
  }

  async loop() {
    while (!this.stopping) {
      const started = Date.now();
      this.setState({ lastPollAt: nowIso(), nextPollAt: new Date(started + config.twitch.pollMs).toISOString() });
      try {
        const status = await getStream(config.twitch.login);
        if (this.stopping) return;
        this.failures = 0;
        this.setState({
          lastSuccessAt: nowIso(),
          lastError: null,
          consecutiveFailures: 0,
          status: status.live ? 'live' : 'offline',
          liveSince: status.live ? (this.store.getMonitor('twitch')?.liveSince || nowIso()) : null,
          viewers: status.stream?.viewers ?? null,
          game: status.stream?.game ?? null,
          title: status.stream?.title ?? null,
          streamId: status.stream?.id ?? null,
          displayName: status.user?.displayName || config.twitch.login,
        });
        if (status.live) {
          this.offlineSince = null;
          await this.onLive(status.stream);
        } else {
          this.offlineSince ||= Date.now();
          await this.onOffline();
        }
      } catch (error) {
        this.failures += 1;
        this.setState({
          status: 'error',
          lastError: truncate(errorMessage(error), 400),
          consecutiveFailures: this.failures,
        });
        logger.warn(`Twitch poll failed (${this.failures}): ${truncate(errorMessage(error), 200)}`);
      }
      const backoff = Math.min(config.twitch.pollMs * Math.max(1, 2 ** Math.min(this.failures, 4)), 60000);
      await sleep(this.store.getMonitor('twitch')?.status === 'live' ? config.twitch.pollMs : backoff);
    }
  }

  async onLive(stream) {
    const active = this.archiver.findActive('twitch', { streamId: stream.id });
    if (active) {
      active.title = stream.title || active.title;
      active.game = stream.game || active.game;
      active.viewers = stream.viewers;
      active.lastSeenLiveAt = nowIso();
      this.store.putSession(active);
      if (!this.archiver.controllers.has(active.id) && active.status === 'recording') {
        await this.archiver.resumeSession(active);
      }
      return;
    }

    // A different stream ID while an old one is still marked active: close the
    // old one first (this also handles a quick restart/rerun boundary).
    for (const session of this.archiver.activeFor('twitch')) {
      if (String(session.streamId) !== String(stream.id)) {
        await this.archiver.endSession(session, 'new Twitch stream detected');
      }
    }
    await this.archiver.startSession('twitch', {
      streamId: stream.id,
      title: stream.title,
      game: stream.game,
      streamStartedAt: stream.createdAt,
      viewers: stream.viewers,
    });
  }

  async onOffline() {
    for (const session of this.archiver.activeFor('twitch')) {
      if (session.status !== 'recording') continue;
      const since = Date.parse(session.lastSeenLiveAt || session.detectedAt);
      const offlineFor = Number.isFinite(since) ? Date.now() - since : Date.now() - this.offlineSince;
      if (offlineFor >= config.recorder.offlineGraceMs) {
        await this.archiver.endSession(session, 'Twitch offline');
      }
    }
  }

  async stop() {
    this.stopping = true;
  }
}

class YouTubeMonitor {
  constructor(archiver) {
    this.archiver = archiver;
    this.store = archiver.store;
    this.stopping = false;
    this.failures = 0;
    this.lastRssCheckAt = 0;
    this.seenVideoIds = new Set(this.store.getMonitor('youtube')?.seenVideoIds || []);
  }

  setState(patch) {
    this.store.setMonitor('youtube', patch);
  }

  async start() {
    this.setState({
      status: 'starting',
      channelLabel: config.youtube.channelLabel,
      nextPollAt: new Date(Date.now() + 100).toISOString(),
    });
    void this.loop();
  }

  async loop() {
    while (!this.stopping) {
      const started = Date.now();
      this.setState({ lastPollAt: nowIso(), nextPollAt: new Date(started + config.youtube.pollMs).toISOString() });
      let live = false;
      try {
        const status = await getLiveVideo(config.youtube.channelId);
        if (this.stopping) return;
        this.failures = 0;
        live = status.live === true;
        this.setState({
          lastSuccessAt: nowIso(),
          lastError: null,
          consecutiveFailures: 0,
          status: live ? 'live' : 'offline',
          liveSince: live ? (this.store.getMonitor('youtube')?.liveSince || nowIso()) : null,
          videoId: status.videoId || null,
          title: status.title || null,
          channelLabel: config.youtube.channelLabel,
          startedAtMs: status.startedAtMs || null,
        });
        if (live) {
          await this.onLive(status);
        } else {
          await this.onOffline(status);
        }
      } catch (error) {
        this.failures += 1;
        this.setState({
          status: 'error',
          lastError: truncate(errorMessage(error), 400),
          consecutiveFailures: this.failures,
        });
        logger.warn(`YouTube poll failed (${this.failures}): ${truncate(errorMessage(error), 200)}`);
      }

      // RSS fallback: catches /live A/B variants and very recent starts. yt-dlp
      // is only invoked for unseen IDs, so this is cheap.
      if (!live && Date.now() - this.lastRssCheckAt > 60000) {
        this.lastRssCheckAt = Date.now();
        try {
          const detected = await detectLiveFromRss(config.youtube.channelId, [...this.seenVideoIds]);
          for (const video of detected.videos || []) this.seenVideoIds.add(video.videoId);
          this.setState({ seenVideoIds: [...this.seenVideoIds].slice(-200) });
          if (detected.live && !this.stopping) {
            logger.info(`YouTube live detected via RSS fallback: ${detected.videoId}`);
            await this.onLive(detected);
            live = true;
          }
        } catch (error) {
          logger.debug(`YouTube RSS fallback failed: ${truncate(error.message, 150)}`);
        }
      }

      const backoff = Math.min(config.youtube.pollMs * Math.max(1, 2 ** Math.min(this.failures, 4)), 180000);
      await sleep(live ? config.youtube.pollMs : backoff);
    }
  }

  async onLive(status) {
    const videoId = String(status.videoId || '');
    if (!videoId) return;
    this.seenVideoIds.add(videoId);
    this.setState({ videoId, seenVideoIds: [...this.seenVideoIds].slice(-200) });

    const active = this.archiver.activeFor('youtube').find((s) => s.status === 'recording');
    if (active && String(active.videoId) === videoId) {
      active.title = status.title || active.title;
      active.lastSeenLiveAt = nowIso();
      if (!active.streamStartedAt && status.startedAtMs) active.streamStartedAt = new Date(status.startedAtMs).toISOString();
      this.store.putSession(active);
      if (!this.archiver.controllers.has(active.id)) {
        await this.archiver.resumeSession(active);
      }
      return;
    }
    for (const session of this.archiver.activeFor('youtube')) {
      if (String(session.videoId) !== videoId) {
        await this.archiver.endSession(session, 'new YouTube live detected');
      }
    }
    await this.archiver.startSession('youtube', {
      videoId,
      title: status.title || status.info?.title || 'YouTube live',
      streamStartedAt: status.startedAtMs ? new Date(status.startedAtMs).toISOString() : nowIso(),
      startedAtEstimated: !status.startedAtMs,
    });
  }

  async onOffline(status = {}) {
    for (const session of this.archiver.activeFor('youtube')) {
      if (session.status !== 'recording') continue;
      const since = Date.parse(session.lastSeenLiveAt || session.detectedAt);
      const offlineFor = Number.isFinite(since) ? Date.now() - since : 0;
      if (status.justEnded || offlineFor >= config.recorder.offlineGraceMs) {
        await this.archiver.endSession(session, 'YouTube offline');
      }
    }
  }

  async stop() {
    this.stopping = true;
  }
}

export class Monitors {
  constructor(archiver) {
    this.archiver = archiver;
    this.twitch = null;
    this.youtube = null;
    this.maintenanceTimer = null;
  }

  createMonitors() {
    this.twitch = config.twitch.enabled ? new TwitchMonitor(this.archiver) : null;
    this.youtube = config.youtube.enabled ? new YouTubeMonitor(this.archiver) : null;
    if (!config.twitch.enabled) {
      this.archiver.store.setMonitor('twitch', { status: 'disabled', lastError: null });
    }
    if (!config.youtube.enabled) {
      this.archiver.store.setMonitor('youtube', { status: 'disabled', lastError: null });
    }
  }

  async startLoops() {
    this.createMonitors();
    const tasks = [];
    if (this.twitch) tasks.push(this.twitch.start());
    if (this.youtube) tasks.push(this.youtube.start());
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = setInterval(() => {
      void this.archiver.maintenance();
    }, 15000);
    this.maintenanceTimer.unref?.();
    await Promise.allSettled(tasks);
  }

  async start() {
    await this.archiver.recover();
    // Sessions that were already ending when the process stopped must be
    // finalized even if no monitor sees them again.
    for (const session of Object.values(this.archiver.store.state.sessions)) {
      if (session.status === 'ending') {
        this.archiver.enqueueFinalize(session);
      }
      // Resume a VOD mute audit that was interrupted by a restart. The live
      // recording is already safe; this only restores the post-stream proof.
      if (session.platform === 'twitch'
        && ['pending-vod', 'pending-mutes'].includes(session.audit?.verdict)
        && Date.now() - Date.parse(session.finalizedAt || session.endedAt || 0) < config.audit.vodWatchMaxMs) {
        this.archiver.scheduleVodWatch(session);
      }
    }
    await this.startLoops();
  }

  async stop() {
    await Promise.allSettled([this.twitch?.stop(), this.youtube?.stop()]);
    if (this.maintenanceTimer) clearInterval(this.maintenanceTimer);
    this.maintenanceTimer = null;
    this.twitch = null;
    this.youtube = null;
  }

  /**
   * Apply channel/branding/destination changes from the dashboard without
   * restarting the container. Channel changes end active sessions for that
   * platform; destination changes only affect new sessions (each session
   * snapshots its destination at start).
   */
  async reconfigure(settings) {
    const snapshot = {
      appName: config.appName,
      appMark: config.appMark,
      filenameTemplate: config.filenameTemplate,
      twitchEnabled: config.twitch.enabled,
      twitchInput: config.twitch.channelInput,
      twitchLogin: config.twitch.login,
      youtubeEnabled: config.youtube.enabled,
      youtubeInput: config.youtube.channelInput,
      youtubeId: config.youtube.channelId,
      youtubeLabel: config.youtube.channelLabel,
      recordingsDir: config.recordingsDir,
      archiveDisplayPath: config.archiveDisplayPath,
      archiveMetaDir: config.archiveMetaDir,
      compressEnabled: config.storage.compressEnabled,
      compressQuality: config.storage.compressQuality,
      backupRetentionDays: config.storage.backupRetentionDays,
    };

    let resolvedYoutube = null;
    if (settings.youtube?.enabled) {
      const channel = String(settings.youtube.channel || '').trim();
      if (!channel) throw new Error('Enter a YouTube channel or disable it.');
      resolvedYoutube = await resolveYouTubeChannelId(channel);
    }
    if (settings.twitch?.enabled && !String(settings.twitch.channel || '').trim()) {
      throw new Error('Enter a Twitch channel or disable it.');
    }
    const newDestination = settings.destination?.dir
      ? validateDestination(settings.destination.dir)
      : config.recordingsDir;

    const newTwitchLogin = settings.twitch?.enabled
      ? normalizeTwitchLogin(settings.twitch.channel)
      : config.twitch.login;
    const newYoutubeId = resolvedYoutube?.id || config.youtube.channelId;
    const twitchChanged = Boolean(settings.twitch) && (
      settings.twitch.enabled !== config.twitch.enabled || newTwitchLogin !== config.twitch.login
    );
    const youtubeChanged = Boolean(settings.youtube) && (
      settings.youtube.enabled !== config.youtube.enabled || newYoutubeId !== config.youtube.channelId
    );

    try {
      await this.stop();

      if (twitchChanged) {
        for (const session of this.archiver.activeFor('twitch')) {
          await this.archiver.endSession(session, 'channel reconfigured');
        }
      }
      if (youtubeChanged) {
        for (const session of this.archiver.activeFor('youtube')) {
          await this.archiver.endSession(session, 'channel reconfigured');
        }
      }

      if (settings.appName?.trim()) config.appName = settings.appName.trim().slice(0, 80);
      if (settings.appMark?.trim()) config.appMark = settings.appMark.trim().slice(0, 4);
      if (settings.filenameTemplate?.trim()) config.filenameTemplate = settings.filenameTemplate.trim().slice(0, 200);

      if (settings.twitch) {
        config.twitch.enabled = settings.twitch.enabled !== false;
        if (config.twitch.enabled) {
          config.twitch.channelInput = String(settings.twitch.channel).trim();
          config.twitch.login = normalizeTwitchLogin(settings.twitch.channel);
        }
      }
      if (settings.youtube) {
        config.youtube.enabled = settings.youtube.enabled !== false;
        if (config.youtube.enabled && resolvedYoutube) {
          config.youtube.channelInput = String(settings.youtube.channel).trim();
          config.youtube.channelId = resolvedYoutube.id;
          config.youtube.channelLabel = String(settings.youtube.label || '').trim()
            || resolvedYoutube.label
            || resolvedYoutube.id;
        } else if (typeof settings.youtube.label === 'string' && settings.youtube.label.trim()) {
          config.youtube.channelLabel = settings.youtube.label.trim();
        }
      }

      if (newDestination !== config.recordingsDir) {
        config.recordingsDir = newDestination;
        config.archiveDisplayPath = displayPathFor(newDestination);
        config.archiveMetaDir = path.join(newDestination, '.stream-vod-guard');
        await fsp.mkdir(config.recordingsDir, { recursive: true });
        await fsp.mkdir(config.archiveMetaDir, { recursive: true });
        const probe = path.join(config.recordingsDir, `.write-test-${process.pid}`);
        await fsp.writeFile(probe, 'ok');
        await fsp.rm(probe, { force: true });
      } else if (settings.destination?.display) {
        config.archiveDisplayPath = settings.destination.display;
      }

      if (settings.storage) {
        if (settings.storage.compressEnabled !== undefined) {
          config.storage.compressEnabled = settings.storage.compressEnabled !== false;
        }
        if (['high', 'balanced', 'small'].includes(settings.storage.compressQuality)) {
          config.storage.compressQuality = settings.storage.compressQuality;
        }
        const days = Number.parseInt(settings.storage.backupRetentionDays, 10);
        if (Number.isFinite(days)) {
          config.storage.backupRetentionDays = Math.max(0, Math.min(365, days));
        }
      }

      await this.startLoops();
      this.archiver.store.addEvent({
        event: 'settings-updated',
        level: 'info',
        message: `Settings updated: ${config.twitch.enabled ? config.twitch.login : 'Twitch off'} · ` +
          `${config.youtube.enabled ? config.youtube.channelLabel || config.youtube.channelId : 'YouTube off'} · ` +
          `${config.archiveDisplayPath}`,
      });
      logger.info('Runtime settings updated', {
        twitch: config.twitch.enabled ? config.twitch.login : 'disabled',
        youtube: config.youtube.enabled ? config.youtube.channelId : 'disabled',
        destination: config.recordingsDir,
      });
      return true;
    } catch (error) {
      // Roll back config and bring the old monitors back.
      config.appName = snapshot.appName;
      config.appMark = snapshot.appMark;
      config.filenameTemplate = snapshot.filenameTemplate;
      config.twitch.enabled = snapshot.twitchEnabled;
      config.twitch.channelInput = snapshot.twitchInput;
      config.twitch.login = snapshot.twitchLogin;
      config.youtube.enabled = snapshot.youtubeEnabled;
      config.youtube.channelInput = snapshot.youtubeInput;
      config.youtube.channelId = snapshot.youtubeId;
      config.youtube.channelLabel = snapshot.youtubeLabel;
      config.recordingsDir = snapshot.recordingsDir;
      config.archiveDisplayPath = snapshot.archiveDisplayPath;
      config.archiveMetaDir = snapshot.archiveMetaDir;
      config.storage.compressEnabled = snapshot.compressEnabled;
      config.storage.compressQuality = snapshot.compressQuality;
      config.storage.backupRetentionDays = snapshot.backupRetentionDays;
      await this.startLoops().catch(() => {});
      throw error;
    }
  }
}
