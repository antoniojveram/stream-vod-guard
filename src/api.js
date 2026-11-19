import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { config, displayPathFor, publicConfig } from './config.js';
import { logger } from './logger.js';
import { saveSettings, settingsFromConfig, validateDestination } from './settings.js';
import { diskFreeBytes, humanBytes } from './util.js';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.mkv': 'video/x-matroska',
  '.mp4': 'video/mp4',
  '.ts': 'video/mp2t',
  '.txt': 'text/plain; charset=utf-8',
};

const GB = 1024 ** 3;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(data),
  });
  res.end(data);
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body is too large'));
        req.destroy();
        return;
      }
      body += chunk;
    });
    req.on('error', reject);
    req.on('end', () => {
      if (!body.trim()) return resolve({});
      try {
        return resolve(JSON.parse(body));
      } catch {
        return reject(new Error('Invalid JSON'));
      }
    });
  });
}

function resolveRequestedPath(input) {
  const raw = String(input || '').trim();
  const candidate = raw
    ? (path.isAbsolute(raw) ? raw : path.join(config.videosRoot, raw))
    : config.videosRoot;
  return validateDestination(candidate);
}

function isAuthorized(req, url) {  if (!config.dashboardToken) return true;
  // The dashboard shell and its assets must load so the token can be supplied
  // via ?token=... in the URL. Healthchecks must work without credentials.
  if (url.pathname === '/' || url.pathname === '/index.html'
    || url.pathname === '/app.js' || url.pathname === '/style.css'
    || url.pathname === '/favicon.svg' || url.pathname === '/healthz') {
    return true;
  }
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7) : '';
  const query = url.searchParams.get('token') || '';
  return bearer === config.dashboardToken || query === config.dashboardToken;
}

function publicSession(session, { detail = false } = {}) {
  const relativeFinal = session.final?.file
    && session.final.file.startsWith(`${config.videosRoot}${path.sep}`)
    ? path.relative(config.videosRoot, session.final.file)
    : null;
  const displayFile = session.final?.displayFile
    || (relativeFinal ? path.join(config.archiveDisplayPath, relativeFinal) : session.final?.file || null);
  const clone = {
    id: session.id,
    platform: session.platform,
    channel: session.channel,
    title: session.title,
    game: session.game,
    status: session.status,
    streamId: session.streamId,
    videoId: session.videoId,
    streamStartedAt: session.streamStartedAt,
    detectedAt: session.detectedAt,
    recordingStartedAt: session.recordingStartedAt,
    endedAt: session.endedAt,
    finalizedAt: session.finalizedAt,
    liveStats: session.liveStats || null,
    restarts: session.restarts || 0,
    lastError: session.lastError || null,
    coverage: session.coverage || null,
    audit: session.audit || null,
    twitchVod: session.twitchVod ? {
      id: session.twitchVod.id,
      title: session.twitchVod.title,
      lengthSeconds: session.twitchVod.lengthSeconds,
      mutedSegments: session.twitchVod.mutedSegments?.length || 0,
      mutedSeconds: session.twitchVod.mutedSegments?.reduce((a, s) => a + s.duration, 0) || 0,
      firstMuteSeenAt: session.twitchVod.firstMuteSeenAt || null,
      secondsAfterStreamEnd: session.twitchVod.secondsAfterStreamEnd ?? null,
      discoveredAt: session.twitchVod.discoveredAt || null,
    } : null,
    final: session.final ? {
      file: session.final.file,
      displayFile,
      size: session.final.size,
      duration: session.final.duration,
      bitrate: session.final.bitrate,
      quality: session.final.quality || null,
      sha256: session.final.sha256 || null,
      archived: session.final.archived ?? null,
      verifiedAt: session.final.verifiedAt,
    } : null,
    downloadUrl: relativeFinal ? `/files/${encodeURIComponent(relativeFinal)}` : null,
    partsCount: (session.parts || []).length,
    archiveError: session.archiveError || null,
    diskFreeGb: session.diskFreeGb ?? null,
    startedAtEstimated: session.startedAtEstimated || false,
    localCleanedAt: session.localCleanedAt || null,
    deletedAt: session.deletedAt || null,
  };
  if (detail) {
    clone.parts = (session.parts || []).map((p) => ({
      index: p.index,
      attempt: p.attempt,
      status: p.status,
      bytes: p.bytes,
      startedAt: p.startedAt,
      endedAt: p.endedAt,
      files: (p.files || []).map((f) => path.basename(f)),
    }));
    clone.notes = (session.notes || []).slice(-40);
    clone.silences = (session.silences || []).slice(0, 50);
    clone.metadataFile = session.metadataFile || null;
  }
  return clone;
}

async function fileSizeSafe(file) {
  try {
    const stat = await fsp.stat(file);
    return stat.size;
  } catch {
    return 0;
  }
}

function parseRange(rangeHeader, size) {
  if (!rangeHeader) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
  if (!match) return null;
  let start = match[1] === '' ? null : Number(match[1]);
  let end = match[2] === '' ? null : Number(match[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  } else {
    end = end === null ? size - 1 : Math.min(end, size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null;
  return { start, end };
}

async function serveFile(req, res, relativePath, url) {
  const root = path.resolve(config.videosRoot);
  const target = path.resolve(root, relativePath);
  if (!target.startsWith(`${root}${path.sep}`) || target.includes(`${path.sep}.`)) {
    return json(res, 404, { error: 'not found' });
  }
  let stat;
  try {
    stat = await fsp.stat(target);
  } catch {
    return json(res, 404, { error: 'not found' });
  }
  if (!stat.isFile()) return json(res, 404, { error: 'not found' });

  const ext = path.extname(target).toLowerCase();
  const headers = {
    'content-type': MIME[ext] || 'application/octet-stream',
    'accept-ranges': 'bytes',
    'cache-control': 'private, max-age=0',
    'x-content-type-options': 'nosniff',
  };
  if (url.searchParams.get('download') === '1') {
    headers['content-disposition'] = `attachment; filename*=UTF-8''${encodeURIComponent(path.basename(target))}`;
  }

  const range = parseRange(req.headers.range, stat.size);
  if (range) {
    res.writeHead(206, {
      ...headers,
      'content-range': `bytes ${range.start}-${range.end}/${stat.size}`,
      'content-length': range.end - range.start + 1,
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(target, { start: range.start, end: range.end }).pipe(res);
    return;
  }

  res.writeHead(200, { ...headers, 'content-length': stat.size });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(target).pipe(res);
}

async function serveStatic(res, file) {
  try {
    const body = await fsp.readFile(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'same-origin',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not found');
  }
}

export function createApiServer({ store, archiver, monitors }) {
  const startedAt = Date.now();

  return http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
    if (!isAuthorized(req, url)) {
      res.writeHead(401, { 'www-authenticate': 'Bearer' });
      return res.end('Unauthorized');
    }

    try {
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
        return serveStatic(res, path.join(config.publicDir, 'index.html'));
      }
      if (req.method === 'GET' && ['/app.js', '/style.css', '/favicon.svg'].includes(url.pathname)) {
        return serveStatic(res, path.join(config.publicDir, url.pathname.slice(1)));
      }

      if (req.method === 'GET' && url.pathname === '/healthz') {
        const now = Date.now();
        const twitch = store.getMonitor('twitch');
        const youtube = store.getMonitor('youtube');
        const localFree = await diskFreeBytes(config.workDir);
        const archiveFree = await diskFreeBytes(config.videosRoot);
        const stale = (monitor) => monitor?.lastSuccessAt
          ? now - Date.parse(monitor.lastSuccessAt) > Math.max(120000, (monitor.pollMs || 60000) * 4)
          : true;
        const problems = [];
        if (config.twitch.enabled && stale(twitch)) problems.push('twitch monitor stale');
        if (config.youtube.enabled && stale(youtube)) problems.push('youtube monitor stale');
        if (localFree < 2 * GB) problems.push('local disk critical');
        if (archiveFree < config.disk.minFreeArchiveGb * GB) problems.push('destination free space critical');
        return json(res, problems.length ? 503 : 200, {
          ok: problems.length === 0,
          problems,
          uptimeSeconds: Math.round((now - startedAt) / 1000),
          localFreeGb: Math.round((localFree / GB) * 10) / 10,
          archiveFreeGb: Math.round((archiveFree / GB) * 10) / 10,
          active: store.activeSessions().length,
          monitors: {
            twitch: twitch?.status,
            youtube: youtube?.status,
          },
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/status') {
        const localFree = await diskFreeBytes(config.workDir);
        const archiveFree = await diskFreeBytes(config.videosRoot);
        const localStats = await fsp.statfs(config.workDir).catch(() => null);
        const archiveStats = await fsp.statfs(config.videosRoot).catch(() => null);
        const localTotal = localStats ? Number(localStats.blocks) * Number(localStats.bsize) : 0;
        const archiveTotal = archiveStats ? Number(archiveStats.blocks) * Number(archiveStats.bsize) : 0;
        const active = store.activeSessions().map((s) => publicSession(s));
        const recent = store.listSessions({ limit: 25 })
          .filter((s) => !['recording', 'ending', 'finalizing'].includes(s.status))
          .slice(0, 15)
          .map((s) => publicSession(s));
        return json(res, 200, {
          now: new Date().toISOString(),
          app: config.appName,
          uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
          monitors: {
            twitch: store.getMonitor('twitch'),
            youtube: store.getMonitor('youtube'),
          },
          disk: {
            localFreeGb: Math.round((localFree / GB) * 10) / 10,
            archiveFreeGb: Math.round((archiveFree / GB) * 10) / 10,
            localTotalGb: Math.round((localTotal / GB) * 10) / 10,
            archiveTotalGb: Math.round((archiveTotal / GB) * 10) / 10,
            localUsedPct: localTotal ? Math.round(((localTotal - localFree) / localTotal) * 1000) / 10 : null,
            archiveUsedPct: archiveTotal ? Math.round(((archiveTotal - archiveFree) / archiveTotal) * 1000) / 10 : null,
            minFreeGb: config.disk.minFreeGb,
            warnFreeGb: config.disk.warnFreeGb,
            minFreeArchiveGb: config.disk.minFreeArchiveGb,
            warnFreeArchiveGb: config.disk.warnFreeArchiveGb,
          },
          stats: store.stats(),
          active,
          recent,
          events: store.recentEvents(60),
          config: publicConfig(),
          vodWatchers: archiver.vodWatchers.size,
        });
      }

      if (req.method === 'GET' && url.pathname === '/api/settings') {
        return json(res, 200, {
          ...settingsFromConfig(),
          activeSessions: store.activeSessions().length,
        });
      }

      if (req.method === 'POST' && url.pathname === '/api/settings') {
        try {
          const body = await readJsonBody(req);
          const destination = resolveRequestedPath(body.destination?.dir || config.recordingsDir);
          const settings = {
            appName: String(body.appName ?? config.appName).trim().slice(0, 80),
            appMark: String(body.appMark ?? config.appMark).trim().slice(0, 4),
            filenameTemplate: String(body.filenameTemplate ?? config.filenameTemplate).trim().slice(0, 200),
            twitch: {
              enabled: body.twitch?.enabled !== false,
              channel: String(body.twitch?.channel ?? config.twitch.channelInput).trim(),
            },
            youtube: {
              enabled: body.youtube?.enabled !== false,
              channel: String(body.youtube?.channel ?? config.youtube.channelInput).trim(),
              label: String(body.youtube?.label ?? config.youtube.channelLabel).trim().slice(0, 80),
            },
            destination: { dir: destination },
          };
          await monitors.reconfigure(settings);
          await saveSettings(settings);
          logger.info('Settings saved from dashboard', {
            twitch: settings.twitch.enabled ? settings.twitch.channel : 'disabled',
            youtube: settings.youtube.enabled ? settings.youtube.channel : 'disabled',
            destination,
          });
          return json(res, 200, {
            ...settingsFromConfig(),
            activeSessions: store.activeSessions().length,
          });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/folders') {
        try {
          const dir = resolveRequestedPath(url.searchParams.get('path') || config.videosRoot);
          const stat = await fsp.stat(dir);
          if (!stat.isDirectory()) throw new Error('Path is not a folder');
          const entries = await fsp.readdir(dir, { withFileTypes: true });
          const dirs = entries
            .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
            .sort((a, b) => a.name.localeCompare(b.name, 'es'))
            .map((entry) => {
              const child = path.join(dir, entry.name);
              return {
                name: entry.name,
                path: child,
                displayPath: displayPathFor(child),
              };
            });
          return json(res, 200, {
            path: dir,
            displayPath: displayPathFor(dir),
            parent: dir === config.videosRoot ? null : path.dirname(dir),
            root: config.videosRoot,
            hostRoot: config.videosHostRoot,
            dirs,
          });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }

      if (req.method === 'POST' && url.pathname === '/api/folders') {
        try {
          const body = await readJsonBody(req);
          const dir = resolveRequestedPath(body.path);
          await fsp.mkdir(dir, { recursive: true });
          const stat = await fsp.stat(dir);
          if (!stat.isDirectory()) throw new Error('Path is not a folder');
          return json(res, 201, {
            ok: true,
            path: dir,
            displayPath: displayPathFor(dir),
          });
        } catch (error) {
          return json(res, 400, { error: error.message });
        }
      }

      if (req.method === 'GET' && url.pathname === '/api/sessions') {
        const limit = Math.min(200, Number(url.searchParams.get('limit')) || 50);
        return json(res, 200, {
          sessions: store.listSessions({ limit }).map((s) => publicSession(s)),
        });
      }

      const sessionMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)$/);
      if (req.method === 'GET' && sessionMatch) {
        const session = store.getSession(decodeURIComponent(sessionMatch[1]));
        if (!session) return json(res, 404, { error: 'session not found' });
        return json(res, 200, publicSession(session, { detail: true }));
      }

      const finalizeMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/finalize$/);
      if (req.method === 'POST' && finalizeMatch) {
        const session = store.getSession(decodeURIComponent(finalizeMatch[1]));
        if (!session) return json(res, 404, { error: 'session not found' });
        await archiver.endSession(session, 'manual finalize');
        return json(res, 202, { ok: true });
      }

      const reauditMatch = url.pathname.match(/^\/api\/sessions\/([^/]+)\/reaudit$/);
      if (req.method === 'POST' && reauditMatch) {
        const session = store.getSession(decodeURIComponent(reauditMatch[1]));
        if (!session) return json(res, 404, { error: 'session not found' });
        archiver.scheduleVodWatch(session);
        return json(res, 202, { ok: true });
      }

      if (req.method === 'GET' && url.pathname === '/api/events') {
        const limit = Math.min(500, Number(url.searchParams.get('limit')) || 100);
        return json(res, 200, { events: store.recentEvents(limit) });
      }

      if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname.startsWith('/files/')) {
        const relative = decodeURIComponent(url.pathname.slice('/files/'.length));
        return serveFile(req, res, relative, url);
      }

      return json(res, 404, { error: 'not found' });
    } catch (error) {
      logger.error(`HTTP error ${req.method} ${url.pathname}: ${error.message}`);
      return json(res, 500, { error: 'internal error' });
    }
  });
}
