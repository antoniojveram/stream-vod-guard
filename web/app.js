const $ = (id) => document.getElementById(id);
const tokenFromUrl = new URLSearchParams(location.search).get('token') || '';
if (tokenFromUrl) sessionStorage.setItem('dashboardToken', tokenFromUrl);
const token = tokenFromUrl || sessionStorage.getItem('dashboardToken') || '';

const state = {
  status: null,
  timer: null,
  lastOk: 0,
  loading: false,
  settings: null,
  folder: null,
  settingsSaving: false,
};

function apiUrl(path, extra = {}) {
  const url = new URL(path, location.origin);
  if (token) url.searchParams.set('token', token);
  for (const [key, value] of Object.entries(extra)) url.searchParams.set(key, value);
  return url.toString();
}

async function api(path, options = {}) {
  const res = await fetch(apiUrl(path), { cache: 'no-store', ...options });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const data = await res.json();
      if (data?.error) message = data.error;
    } catch {
      // keep HTTP status
    }
    throw new Error(message);
  }
  return res.json();
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[i]}`;
}

function fmtDuration(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

function fmtFps(value) {
  if (!value) return '';
  const [num, den] = String(value).split('/');
  if (!den || den === '1') return String(num);
  const fps = Number(num) / Number(den);
  return Number.isFinite(fps) ? fps.toFixed(1) : String(value);
}

function fmtHms(seconds) {
  const s = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(s / 3600)).padStart(2, '0')}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '—' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function ago(iso) {
  if (!iso) return '—';
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 5000) return 'now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

function statusLabel(status) {
  return ({
    recording: 'Recording',
    ending: 'Finishing',
    finalizing: 'Finalizing',
    done: 'Complete',
    'archived-pending': 'Local only',
    failed: 'Error',
    deleted: 'Deleted',
  })[status] || status;
}

function statusBadge(session) {
  if (session.status === 'recording') return '<span class="badge live">● Recording</span>';
  if (session.status === 'ending' || session.status === 'finalizing') return '<span class="badge pending">Finalizing</span>';
  if (session.status === 'archived-pending') return '<span class="badge pending">Pending archive</span>';
  if (session.status === 'failed') return '<span class="badge fail">Error</span>';
  if (session.status === 'deleted') return '<span class="badge neutral">Deleted</span>';
  return '<span class="badge done">Complete</span>';
}

function auditBadge(session) {
  const verdict = session.audit?.verdict;
  if (verdict === 'PASSED') return `<span class="badge done" title="${esc(session.audit.passed)}/${esc(session.audit.checked)} segments with audio">Audio OK</span>`;
  if (verdict === 'FAILED') return `<span class="badge fail">Missing audio</span>`;
  if (verdict === 'PARTIAL') return `<span class="badge pending">Partial</span>`;
  if (verdict === 'no-mutes') return '<span class="badge neutral">No mutes</span>';
  if (session.platform === 'twitch') return '<span class="badge pending">Auditing…</span>';
  return '';
}

function compressionBadge(session) {
  const c = session.compression;
  if (!c) return '';
  if (c.status === 'running') return `<span class="badge pending">HEVC ${c.progress ?? 0}%</span>`;
  if (c.status === 'queued') return '<span class="badge pending">HEVC queued</span>';
  if (c.status === 'done') return `<span class="badge done">HEVC −${Math.round(c.savedPercent || 0)}%</span>`;
  if (c.status === 'failed') return '<span class="badge fail">HEVC failed</span>';
  return '';
}

function compressionText(session) {
  const c = session.compression;
  if (!c) return '—';
  if (c.status === 'done') {
    return `HEVC · ${c.savedPercent || 0}% smaller (${fmtBytes(c.savedBytes || 0)} saved)`;
  }
  if (c.status === 'running') return `HEVC · ${c.progress ?? 0}%${c.speed ? ` · ${esc(c.speed)}` : ''}`;
  if (c.status === 'queued') return c.error ? `HEVC queued: ${esc(c.error)}` : 'HEVC queued';
  if (c.status === 'skipped') return `Skipped: ${esc(c.reason || '—')}`;
  if (c.status === 'failed') return `Failed: ${esc(c.error || '—')}`;
  return esc(c.status || '—');
}

function canCompress(session) {
  const codec = session.final?.quality?.videoCodec;
  if (!session.final?.file || codec === 'hevc' || codec === 'av1') return false;
  return !['queued', 'running', 'done'].includes(session.compression?.status);
}

function platformBadge(platform, small = false) {
  if (platform === 'twitch') return `<span class="platform twitch${small ? '-sm' : ''}">Twitch</span>`;
  return `<span class="platform youtube${small ? '-sm' : ''}">YouTube</span>`;
}

function downloadHref(url) {
  if (!url) return '';
  const u = new URL(url, location.origin);
  if (token) u.searchParams.set('token', token);
  u.searchParams.set('download', '1');
  return u.toString();
}

function renderBrand() {
  const cfg = state.status?.config;
  if (!cfg) return;
  // The project name is fixed; only the channel subtitle is dynamic.
  const parts = [];
  if (cfg.twitch?.enabled) {
    parts.push(`${state.status.monitors.twitch?.displayName || cfg.twitch.login} on Twitch`);
  }
  if (cfg.youtube?.enabled) {
    parts.push(`${cfg.youtube.channelLabel || cfg.youtube.channelId} on YouTube`);
  }
  $('app-subtitle').textContent = parts.length
    ? `Watching · ${parts.join(' · ')}`
    : 'Watching channels live';
}

function renderMonitor(platform) {
  const m = state.status?.monitors?.[platform];
  const prefix = platform === 'twitch' ? 'twitch' : 'youtube';
  const card = $(`${prefix}-card`);
  const dot = card?.querySelector('.status-dot');
  if (!m) return;
  dot.dataset.status = m.status || 'offline';
  let title = 'Offline';
  let sub = 'The monitor is waiting.';
  if (m.status === 'live') {
    title = m.title || (platform === 'twitch' ? 'Directo on Twitch' : 'Directo on YouTube');
    sub = platform === 'twitch'
      ? `${m.game || 'Uncategorized'} · live since ${fmtDate(m.liveSince)}`
      : `Video ${m.videoId || '—'}`;
  } else if (m.status === 'error') {
    title = 'Connection error';
    sub = 'It will retry automatically.';
  } else if (m.status === 'disabled') {
    title = 'Disabled';
    sub = 'Enable it in Settings.';
  } else if (m.status === 'offline') {
    title = 'Offline';
    sub = `Checked ${ago(m.lastSuccessAt)}`;
  } else {
    title = 'Connecting…';
    sub = 'First check in progress.';
  }
  $(`${prefix}-title`).textContent = title;
  $(`${prefix}-sub`).textContent = sub;
  $(`${prefix}-status`).textContent = m.status === 'live'
    ? 'LIVE'
    : (m.status === 'disabled' ? 'DISABLED' : (m.status || '—').toUpperCase());
  if (platform === 'twitch') {
    $('twitch-viewers').textContent = m.viewers ? Number(m.viewers).toLocaleString('en-GB') : '—';
  } else {
    $('youtube-video').textContent = m.videoId || '—';
  }
  $(`${prefix}-poll`).textContent = m.lastPollAt ? ago(m.lastPollAt) : '—';
  $(`${prefix}-error`).textContent = m.lastError || '';
}

function renderDisk() {
  const disk = state.status?.disk;
  if (!disk) return;
  const archiveFree = disk.archiveFreeGb ?? 0;
  $('dest-free').textContent = `${archiveFree.toFixed(1)} GB free`;
  $('local-free').textContent = `${(disk.localFreeGb ?? 0).toFixed(1)} GB`;
  $('session-count').textContent = `${state.status.stats?.sessions ?? 0} total`;
  const pct = Math.max(0, Math.min(100, disk.archiveUsedPct ?? 0));
  const bar = $('dest-bar');
  bar.style.width = `${pct}%`;
  bar.className = archiveFree <= disk.minFreeArchiveGb ? 'bad' : (archiveFree <= disk.warnFreeArchiveGb ? 'warn' : '');
  $('disk-pill').textContent = `${pct.toFixed(1)}% used`;
  $('dest-path').textContent = state.status.config?.paths?.recordings || '—';
  $('footer-path').textContent = state.status.config?.paths?.recordings || '—';
}

function renderActive() {
  const list = state.status?.active || [];
  $('active-count').textContent = list.length ? `${list.length} active` : '';
  const container = $('active-list');
  if (!list.length) {
    container.innerHTML = '<p class="empty">No active recordings. The monitors are watching both channels.</p>';
    return;
  }
  container.innerHTML = list.map((s) => {
    const stats = s.liveStats || {};
    const size = stats.bytes ? fmtBytes(stats.bytes) : '0 B';
    const elapsed = stats.elapsedSeconds ? fmtDuration(stats.elapsedSeconds) : '—';
    const bitrate = stats.bitrateKbps ? `${stats.bitrateKbps} kbps` : '—';
    const link = s.platform === 'twitch'
      ? `https://twitch.tv/${encodeURIComponent(s.channel || '')}`
      : `https://youtube.com/watch?v=${encodeURIComponent(s.videoId || '')}`;
    return `
      <div class="session live">
        <div class="session-main">
          <div class="session-title">${platformBadge(s.platform)}<h3>${esc(s.title)}</h3></div>
          <div class="session-meta">
            <span>${esc(s.channel || '')}</span>
            <span>${s.game ? esc(s.game) : 'Uncategorized'}</span>
            <span>started ${fmtDate(s.streamStartedAt)}</span>
            <span>${s.partsCount || 1} part(s) · ${s.restarts || 0} restarts</span>
            ${s.lastError ? `<span style="color:var(--amber)">${esc(s.lastError)}</span>` : ''}
          </div>
        </div>
        <div class="session-stats">
          <span>Time <b>${elapsed}</b></span>
          <span>Size <b>${size}</b></span>
          <span>Bitrate <b>${bitrate}</b></span>
        </div>
        <div class="session-actions">
          ${statusBadge(s)}
          <a class="btn ghost sm" href="${link}" target="_blank" rel="noreferrer">Open</a>
          <button class="btn sm" data-detail="${esc(s.id)}">Details</button>
          <button class="btn danger sm" data-finalize="${esc(s.id)}">Finalize</button>
        </div>
      </div>`;
  }).join('');
  wireActions(container);
}

function renderRecent() {
  const list = state.status?.recent || [];
  const container = $('recent-list');
  if (!list.length) {
    container.innerHTML = '<p class="empty">No finished recordings yet.</p>';
    return;
  }
  container.innerHTML = list.map((s) => {
    const size = s.final?.size ? fmtBytes(s.final.size) : '—';
    const duration = s.final?.duration ? fmtDuration(s.final.duration) : '—';
    const coverage = s.coverage?.ratio ? `${Math.round(s.coverage.ratio * 100)}%` : '—';
    return `
      <div class="session ${s.status === 'failed' ? 'failed' : ''}">
        <div class="session-main">
          <div class="session-title">${platformBadge(s.platform)}<h3>${esc(s.title)}</h3></div>
          <div class="session-meta">
            <span>${esc(s.channel || '')}</span>
            <span>${fmtDate(s.streamStartedAt || s.detectedAt)}</span>
            <span>${s.game ? esc(s.game) : 'Uncategorized'}</span>
            ${s.twitchVod ? `<span>Twitch VOD: ${s.twitchVod.mutedSegments || 0} mutes (${fmtDuration(s.twitchVod.mutedSeconds || 0)})</span>` : ''}
            ${s.archiveError ? `<span style="color:var(--amber)">${esc(s.archiveError)}</span>` : ''}
          </div>
        </div>
        <div class="session-stats">
          <span>Dur <b>${duration}</b></span>
          <span>Size <b>${size}</b></span>
          <span>Coverage <b>${coverage}</b></span>
        </div>
        <div class="session-actions">
          ${statusBadge(s)} ${auditBadge(s)} ${compressionBadge(s)}
          ${s.downloadUrl ? `<a class="btn primary sm" href="${downloadHref(s.downloadUrl)}">Download</a>` : ''}
          <button class="btn sm" data-detail="${esc(s.id)}">Details</button>
        </div>
      </div>`;
  }).join('');
  wireActions(container);
}

function renderEvents() {
  const events = state.status?.events || [];
  const list = $('events');
  if (!events.length) {
    list.innerHTML = '<li><span></span><span></span><span class="msg">No events.</span></li>';
    return;
  }
  list.innerHTML = events.slice().reverse().map((e) => `
    <li>
      <time>${fmtTime(e.ts)}</time>
      <span class="lvl ${esc(e.level || 'info')}">${esc(e.level || 'info')}</span>
      <span class="msg" title="${esc(e.message)}">${esc(e.message)}</span>
    </li>`).join('');
}

function wireActions(root) {
  root.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => openDetail(btn.dataset.detail));
  });
  root.querySelectorAll('[data-compress]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/api/sessions/${encodeURIComponent(btn.dataset.compress)}/compress`, { method: 'POST' });
        $('detail-dialog').close();
        await refresh();
      } catch (error) {
        alert(`Could not queue compression: ${error.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
  root.querySelectorAll('[data-finalize]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!confirm('Finalize this recording now? The capture will stop and the file will be processed.')) return;
      btn.disabled = true;
      try {
        await api(`/api/sessions/${encodeURIComponent(btn.dataset.finalize)}/finalize`, { method: 'POST' });
        await refresh();
      } catch (error) {
        alert(`Could not finalize: ${error.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function kv(label, value, full = false) {
  return `<div class="kv${full ? ' full' : ''}"><dt>${esc(label)}</dt><dd>${value}</dd></div>`;
}

async function openDetail(id) {
  const dialog = $('detail-dialog');
  $('detail-title').textContent = 'Loading…';
  $('detail-body').innerHTML = '<p class="empty">Loading details…</p>';
  dialog.showModal();
  try {
    const s = await api(`/api/sessions/${encodeURIComponent(id)}`);
    $('detail-title').textContent = s.title;
    const audit = s.audit;
    let verdict = '';
    if (audit) {
      if (audit.verdict === 'PASSED') {
        verdict = `<div class="verdict pass"><span class="big">✓</span><div><strong>Audio preserved where Twitch muted</strong><br>
          ${audit.passed}/${audit.checked} segments with audio · ${fmtDuration(audit.mutedSeconds)} muted by Twitch · control ${audit.control?.meanDb ?? '—'} dB</div></div>`;
      } else if (audit.verdict === 'FAILED') {
        verdict = `<div class="verdict fail"><span class="big">✕</span><div><strong>Audio segments were lost</strong><br>
          ${audit.failed} of ${audit.checked} muted segments are silent in our copy. Check capture restarts.</div></div>`;
      } else if (audit.verdict === 'PARTIAL') {
        verdict = `<div class="verdict pending"><span class="big">!</span><div><strong>Partial audit</strong><br>
          ${audit.passed} with audio · ${audit.outsideCoverage} outside coverage (recording started late).</div></div>`;
      } else if (audit.verdict === 'no-mutes') {
        verdict = `<div class="verdict pass"><span class="big">✓</span><div><strong>Twitch did not mute this VOD</strong><br>There were no segments to recover.</div></div>`;
      } else if (audit.verdict === 'not-applicable') {
        verdict = `<div class="verdict pass"><span class="big">↺</span><div><strong>YouTube backup copy</strong><br>Recorded in parallel; the mute audit applies to the Twitch copy.</div></div>`;
      } else {
        verdict = `<div class="verdict pending"><span class="big">…</span><div><strong>Audit in progress</strong><br>
          ${esc(audit.verdict)} · Twitch scans the VOD after the stream ends.</div></div>`;
      }
    }

    const rows = (audit?.segments || []).map((seg) => `
      <tr class="${esc(seg.status)}">
        <td class="mono">${fmtHms(seg.offset)}</td>
        <td class="mono">${fmtDuration(seg.duration)}</td>
        <td class="mono">${seg.meanDb ?? '—'} dB</td>
        <td>${seg.status === 'pass' ? 'Audio present' : seg.status === 'fail' ? 'SILENCE' : seg.status === 'warn' ? 'Low' : 'Outside coverage'}</td>
      </tr>`).join('');

    const parts = (s.parts || []).map((p) => `
      <tr>
        <td class="mono">#${p.index}</td>
        <td>${esc(p.status || '—')}</td>
        <td class="mono">${fmtBytes(p.bytes || 0)}</td>
        <td>${fmtDate(p.startedAt)} → ${fmtDate(p.endedAt)}</td>
      </tr>`).join('');

    const silences = (s.silences || []).slice(0, 10).map((x) => `
      <tr><td class="mono">${fmtHms(x.start)}</td><td class="mono">${fmtDuration(x.duration)}</td><td class="mono">${fmtHms(x.end)}</td></tr>`).join('');

    $('detail-body').innerHTML = `
      ${verdict}
      <div class="detail-grid">
        ${kv('Platform', platformBadge(s.platform))}
        ${kv('Channel', esc(s.channel || '—'))}
        ${kv('State', statusBadge(s))}
        ${kv('Stream start', fmtDate(s.streamStartedAt))}
        ${kv('Detected', fmtDate(s.detectedAt))}
        ${kv('Final duration', s.final?.duration ? fmtDuration(s.final.duration) : '—')}
        ${kv('Resolution', s.final?.quality
          ? `${s.final.quality.width}x${s.final.quality.height}${s.final.quality.fps ? ` @ ${fmtFps(s.final.quality.fps)} fps` : ''}`
          : '—')}
        ${kv('Size', s.final?.size ? fmtBytes(s.final.size) : '—')}
        ${kv('Compression', compressionText(s), true)}
        ${s.backupPruned ? kv('Backup pruned', `${fmtDate(s.backupPruned.at)} · ${fmtBytes(s.backupPruned.size || 0)} freed`, true) : ''}
        ${kv('Coverage', s.coverage ? `${Math.round((s.coverage.ratio || 0) * 100)}% (${fmtDuration(s.coverage.finalSeconds)} de ${fmtDuration(s.coverage.expectedSeconds)})` : '—')}
        ${kv('Restarts', String(s.restarts || 0))}
        ${kv('Final file', esc(s.final?.displayFile || s.final?.file || '—'), true)}
        ${kv('SHA-256', esc(s.final?.sha256 || '—'), true)}
        ${s.twitchVod ? kv('Twitch VOD', `${esc(s.twitchVod.id)} · ${s.twitchVod.mutedSegments} mutes / ${fmtDuration(s.twitchVod.mutedSeconds)}`, true) : ''}
        ${s.twitchVod?.secondsAfterStreamEnd != null ? kv('Mutes applied', `≈ ${fmtDuration(s.twitchVod.secondsAfterStreamEnd)} after stream end`, true) : ''}
      </div>

      ${canCompress(s) ? `
        <div class="detail-actions">
          <button class="btn primary" data-compress="${esc(s.id)}">Compress to HEVC</button>
          <span class="subtle">Runs in the background; the original is replaced only after verification.</span>
        </div>` : ''}

      ${audit && audit.segments?.length ? `
        <h3 class="sub">Twitch mute audit</h3>
        <table>
          <thead><tr><th>VOD offset</th><th>Duration</th><th>Our audio</th><th>Result</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>` : ''}

      ${parts ? `
        <h3 class="sub">Captured parts</h3>
        <table>
          <thead><tr><th>Part</th><th>State</th><th>Size</th><th>Window</th></tr></thead>
          <tbody>${parts}</tbody>
        </table>` : ''}

      ${silences ? `
        <h3 class="sub">Long silences detected in our copy (${s.silences.length})</h3>
        <table>
          <thead><tr><th>Start</th><th>Duration</th><th>End</th></tr></thead>
          <tbody>${silences}</tbody>
        </table>` : ''}
    `;
    wireActions($('detail-body'));
  } catch (error) {
    $('detail-body').innerHTML = `<p class="empty">Could not load: ${esc(error.message)}</p>`;
  }
}

async function loadFolders(folderPath) {
  const data = await api(`/api/folders?path=${encodeURIComponent(folderPath)}`);
  state.folder = data;
  $('folder-current').textContent = data.displayPath;
  $('dest-selected').textContent = data.displayPath;
  $('folder-up').disabled = !data.parent;
  const list = $('folder-list');
  if (!data.dirs?.length) {
    list.innerHTML = '<p class="empty">No subfolders. You can create one below.</p>';
    return;
  }
  list.innerHTML = data.dirs.map((dir) => `
    <button class="folder-row" type="button" data-folder-path="${esc(dir.path)}">
      <span class="folder-icon">▸</span>
      <span>${esc(dir.name)}</span>
      <span class="folder-host">${esc(dir.displayPath)}</span>
    </button>`).join('');
  list.querySelectorAll('[data-folder-path]').forEach((button) => {
    button.addEventListener('click', async () => {
      try {
        await loadFolders(button.dataset.folderPath);
      } catch (error) {
        $('settings-error').textContent = error.message;
      }
    });
  });
}

function updateStorageNote() {
  const note = $('storage-note');
  if (!note) return;
  const selected = $('compress-encoder')?.value || 'auto';
  const encoder = state.settings?.storage?.encoder;
  if (selected === 'none') {
    note.textContent = 'Compression is off: finished recordings stay H.264. Nothing is deleted.';
    return;
  }
  if (selected === 'x265') {
    note.textContent = 'CPU fallback: compatible with any x86-64/arm64 machine, but slow (hours per long recording). The original is kept until verified.';
    return;
  }
  if (selected === 'vaapi') {
    note.textContent = encoder?.kind === 'vaapi'
      ? `Hardware encoder ready: ${encoder.name}. Finished files are compressed after the stream ends; the original is kept until verified.`
      : 'VAAPI was not detected. Save to re-probe; if unavailable, recordings stay H.264.';
    return;
  }
  if (encoder?.kind === 'vaapi') {
    note.textContent = `Hardware encoder ready: ${encoder.name}. Finished files are compressed after the stream ends; the original is kept until verified.`;
  } else if (encoder?.kind === 'x265') {
    note.textContent = 'No GPU encoder detected. Auto will use CPU x265: compatible but slow. The original is kept until verified.';
  } else if (encoder?.kind === 'none') {
    note.textContent = `No compatible encoder found (${encoder.reason || 'not available'}). Files stay H.264; nothing is deleted. Choose CPU (x265) or Auto to try the software fallback.`;
  } else {
    note.textContent = 'Checking the compression encoder…';
  }
}

async function openSettings() {
  const dialog = $('settings-dialog');
  $('settings-error').textContent = '';
  $('settings-warning').className = 'settings-note';
  try {
    const settings = await api('/api/settings');
    state.settings = settings;
    $('tw-enabled').checked = Boolean(settings.twitch?.enabled);
    $('tw-channel').value = settings.twitch?.channel || '';
    $('yt-enabled').checked = Boolean(settings.youtube?.enabled);
    $('yt-channel').value = settings.youtube?.channel || '';
    $('yt-label').value = settings.youtube?.label || '';
    $('filename-template').value = settings.filenameTemplate || '';
    $('compress-enabled').checked = Boolean(settings.storage?.compressEnabled);
    $('compress-encoder').value = settings.storage?.compressEncoder || 'auto';
    $('compress-quality').value = settings.storage?.compressQuality || 'balanced';
    $('backup-retention').value = settings.storage?.backupRetentionDays ?? 0;
    updateStorageNote();
    const active = settings.activeSessions || 0;
    $('settings-warning').textContent = active
      ? `${active} active recording(s). Changing a channel will stop and finalize that channel; the folder only affects new recordings.`
      : 'Changes apply when you save. The selected folder is used for new recordings.';
    try {
      await loadFolders(settings.destination.dir);
    } catch {
      await loadFolders(settings.destination.root);
    }
    if (!dialog.open) dialog.showModal();
  } catch (error) {
    alert(`Could not open settings: ${error.message}`);
  }
}

async function createFolder() {
  const name = $('folder-name').value.trim();
  if (!name) return;
  try {
    const base = state.folder?.path || state.settings?.destination?.root;
    if (!base) throw new Error('No base folder selected');
    const result = await api('/api/folders', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${base}/${name}` }),
    });
    $('folder-name').value = '';
    $('settings-error').textContent = '';
    await loadFolders(result.path);
  } catch (error) {
    $('settings-error').textContent = error.message;
  }
}

async function saveSettings() {
  if (state.settingsSaving || !state.folder) return;
  state.settingsSaving = true;
  const button = $('settings-save');
  button.disabled = true;
  $('settings-error').textContent = '';
  try {
    const body = {
      filenameTemplate: $('filename-template').value.trim(),
      twitch: {
        enabled: $('tw-enabled').checked,
        channel: $('tw-channel').value.trim(),
      },
      youtube: {
        enabled: $('yt-enabled').checked,
        channel: $('yt-channel').value.trim(),
        label: $('yt-label').value.trim(),
      },
      destination: { dir: state.folder.path },
      storage: {
        compressEnabled: $('compress-enabled').checked,
        compressEncoder: $('compress-encoder').value,
        compressQuality: $('compress-quality').value,
        backupRetentionDays: Number.parseInt($('backup-retention').value, 10) || 0,
      },
    };
    const settings = await api('/api/settings', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    state.settings = settings;
    updateStorageNote();
    $('settings-warning').className = 'settings-note ok';
    $('settings-warning').textContent = 'Saved. Channels, destination, storage and appearance updated.';
    await refresh();
    setTimeout(() => $('settings-dialog').close(), 900);
  } catch (error) {
    $('settings-error').textContent = error.message;
  } finally {
    state.settingsSaving = false;
    button.disabled = false;
  }
}

async function refresh() {
  if (state.loading) return;
  state.loading = true;
  try {
    state.status = await api('/api/status');
    state.lastOk = Date.now();
    $('conn').className = 'conn ok';
    renderBrand();
    renderMonitor('twitch');
    renderMonitor('youtube');
    renderDisk();
    renderActive();
    renderRecent();
    renderEvents();
    const up = state.status.uptimeSeconds || 0;
    $('uptime').textContent = `uptime ${fmtDuration(up)}`;
    $('last-refresh').textContent = `updated ${new Date().toLocaleTimeString('en-GB')}`;
  } catch (error) {
    $('conn').className = 'conn bad';
    $('last-refresh').textContent = `disconnected (${error.message})`;
  } finally {
    state.loading = false;
  }
}

$('detail-close').addEventListener('click', () => $('detail-dialog').close());
$('detail-dialog').addEventListener('click', (event) => {
  if (event.target === $('detail-dialog')) $('detail-dialog').close();
});

$('settings-open').addEventListener('click', openSettings);
$('settings-close').addEventListener('click', () => $('settings-dialog').close());
$('settings-cancel').addEventListener('click', () => $('settings-dialog').close());
$('settings-save').addEventListener('click', saveSettings);
$('compress-encoder').addEventListener('change', updateStorageNote);
$('folder-up').addEventListener('click', async () => {
  if (!state.folder?.parent) return;
  try {
    await loadFolders(state.folder.parent);
  } catch (error) {
    $('settings-error').textContent = error.message;
  }
});
$('folder-create').addEventListener('click', createFolder);
$('settings-dialog').addEventListener('click', (event) => {
  if (event.target === $('settings-dialog')) $('settings-dialog').close();
});

refresh();
state.timer = setInterval(refresh, 5000);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refresh();
});
