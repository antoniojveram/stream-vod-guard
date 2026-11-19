import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, displayPathFor } from './config.js';
import { CaptureController } from './recorder.js';
import { createSession, ensureSessionDirs } from './store.js';
import {
  errorMessage,
  formatDuration,
  hms,
  nowIso,
  normalizeTwitchLogin,
  run,
  sleep,
} from './util.js';
import { getVodMutes, getVods, getStream, summarizeMutes } from './twitch.js';
import { getLiveVideo, resolveYouTubeChannelId } from './youtube.js';
import { ffprobe, finalizeSession, reconcileParts, sampleVolume, scanSilences } from './postprocess.js';

async function downloadFullAudio(vodId, dir) {
  const template = path.join(dir, 'full-audio.%(ext)s');
  const result = await run('yt-dlp', [
    '-f', 'Audio_Only',
    '--no-warnings',
    '--no-playlist',
    '--retries', '10',
    '-o', template,
    `https://www.twitch.tv/videos/${vodId}`,
  ], { timeoutMs: 30 * 60 * 1000, maxOutput: 4 * 1024 * 1024 });
  if (result.code !== 0) {
    throw new Error(`yt-dlp audio download failed: ${result.stderr.slice(-500)}`);
  }
  const files = (await fsp.readdir(dir))
    .filter((f) => f.startsWith('full-audio.'))
    .map((f) => path.join(dir, f));
  if (!files.length) throw new Error('yt-dlp produced no audio file');
  return files[0];
}

async function volumeOf(file, start, duration) {
  return sampleVolume(file, start, duration);
}

function pickControl(vod, mutedStart) {
  const candidates = [
    mutedStart - 300,
    mutedStart + 480,
    Math.max(30, mutedStart - 900),
    Math.min(vod.lengthSeconds - 60, mutedStart + 1200),
  ];
  for (const candidate of candidates) {
    if (candidate < 0 || candidate > vod.lengthSeconds - 30) continue;
    const inside = vod.mutedSegments.some((s) => candidate >= s.offset && candidate < s.offset + s.duration);
    if (!inside) return candidate;
  }
  return Math.max(30, Math.min(vod.lengthSeconds - 60, vod.lengthSeconds * 0.25));
}

async function commandMutes(vodId) {
  const vod = await getVodMutes(vodId);
  const summary = summarizeMutes(vod);
  console.log(JSON.stringify({
    id: vod.id,
    title: vod.title,
    createdAt: vod.createdAt,
    lengthSeconds: vod.lengthSeconds,
    length: formatDuration(vod.lengthSeconds),
    mutedSegments: vod.mutedSegments,
    summary: {
      count: summary.count,
      totalSeconds: summary.seconds,
      total: formatDuration(summary.seconds),
      percent: summary.percent ? Math.round(summary.percent * 100) / 100 : null,
    },
  }, null, 2));
}

async function commandAuditVod(vodId, { samples = false, file = null } = {}) {
  const vod = await getVodMutes(vodId);
  const summary = summarizeMutes(vod);
  console.log(`\nVOD ${vod.id} · ${vod.title}`);
  console.log(`Duration: ${formatDuration(vod.lengthSeconds)} · muted by Twitch: ${summary.count} segments, ${formatDuration(summary.seconds)} (${(summary.percent || 0).toFixed(2)}%)\n`);
  console.log('| # | Offset | Duration | Range |');
  console.log('|---|--------|----------|-------|');
  vod.mutedSegments.forEach((s, i) => {
    console.log(`| ${i + 1} | ${hms(s.offset)} | ${Math.round(s.duration)}s | ${hms(s.offset)} → ${hms(s.offset + s.duration)} |`);
  });

  if (!samples || !vod.mutedSegments.length) return;

  const tempDir = file ? null : await fsp.mkdtemp(path.join(os.tmpdir(), 'stream-vod-audit-'));
  try {
    const audioFile = file || await downloadFullAudio(vod.id, tempDir);
    const probe = await ffprobe(audioFile);
    console.log(`\nAudio analysed: ${path.basename(audioFile)} · ${formatDuration(probe.duration)}`);
    console.log(`\n| Sample | VOD offset | mean | peak | Interpretation |`);
    console.log(`|---------|-----------|-------|------|----------------|`);

    let muteWithAudio = 0;
    let muteSilent = 0;
    for (const segment of vod.mutedSegments.slice(0, 6)) {
      const at = segment.offset + Math.min(segment.duration / 2, 60);
      const vol = await volumeOf(audioFile, at, 20);
      const verdict = vol.mean === null
        ? 'no audio samples (Twitch removed them)'
        : vol.mean <= -80
          ? 'DIGITAL SILENCE'
          : 'audio present';
      if (vol.mean === null || vol.mean <= -80) muteSilent += 1;
      else muteWithAudio += 1;
      console.log(`| Muted segment #${vod.mutedSegments.indexOf(segment) + 1} | ${hms(at)} | ${vol.mean ?? '—'} dB | ${vol.max ?? '—'} dB | ${verdict} |`);
    }

    const control = pickControl(vod, vod.mutedSegments[0].offset);
    const controlVol = await volumeOf(audioFile, control, 20);
    console.log(`| Control (unmuted) | ${hms(control)} | ${controlVol.mean ?? '—'} dB | ${controlVol.max ?? '—'} dB | ${controlVol.mean !== null && controlVol.mean > -60 ? 'normal audio' : 'review'} |`);

    console.log(`\nSummary: ${muteSilent} muted segments without audio · ${muteWithAudio} with audio · control ${controlVol.mean ?? '—'} dB`);
    console.log('Segments with "no samples" or digital silence confirm that the VOD does not contain the original audio.');
  } finally {
    if (tempDir) await fsp.rm(tempDir, { recursive: true, force: true });
  }
}

async function commandRecord(platform, channel, options = {}) {
  if (!['twitch', 'youtube'].includes(platform)) {
    throw new Error('Invalid platform. Use: record twitch <channel> | record youtube <channel>');
  }
  if (!channel) throw new Error('Missing channel. Example: record twitch your_channel');

  const output = path.resolve(options.output || './downloads');
  await fsp.mkdir(output, { recursive: true });
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'live-vod-record-'));
  const fakeStore = { putSession() {}, addEvent() {}, listSessions() { return []; } };
  const old = {
    recordingsDir: config.recordingsDir,
    archiveDisplayPath: config.archiveDisplayPath,
    archiveMetaDir: config.archiveMetaDir,
    workDir: config.workDir,
    archiveEnabled: config.recorder.archiveEnabled,
    checksum: config.recorder.checksum,
    keepRaw: config.recorder.keepRaw,
    audit: config.audit.enabled,
    minFreeArchiveGb: config.disk.minFreeArchiveGb,
    twitch: { ...config.twitch },
    youtube: { ...config.youtube },
  };
  let controller = null;
  let session = null;
  let completed = false;
  const onSignal = (signal) => {
    console.error(`\n${signal}: stopping recording…`);
    Promise.resolve(controller?.stop(signal)).finally(() => process.exit(130));
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  try {
    config.recordingsDir = output;
    config.archiveDisplayPath = displayPathFor(output);
    config.archiveMetaDir = path.join(output, '.stream-vod-guard');
    config.workDir = work;
    config.recorder.archiveEnabled = true;
    config.recorder.checksum = Boolean(options.checksum);
    config.recorder.keepRaw = Boolean(options.keepRaw);
    config.audit.enabled = false;
    config.disk.minFreeArchiveGb = 0;
    await fsp.mkdir(config.archiveMetaDir, { recursive: true });

    if (platform === 'twitch') {
      config.twitch.enabled = true;
      config.youtube.enabled = false;
      config.twitch.login = normalizeTwitchLogin(channel);
      if (options.quality) config.twitch.quality = options.quality;
      const status = await getStream(config.twitch.login);
      if (!status.live) throw new Error(`Twitch ${config.twitch.login} is not live right now`);
      session = createSession({
        platform: 'twitch',
        streamId: status.stream.id,
        title: status.stream.title,
        game: status.stream.game,
        streamStartedAt: status.stream.createdAt,
        dir: path.join(work, 'session'),
      });
    } else {
      config.youtube.enabled = true;
      config.twitch.enabled = false;
      const resolved = await resolveYouTubeChannelId(channel);
      config.youtube.channelId = resolved.id;
      config.youtube.channelLabel = resolved.label || channel;
      config.youtube.liveFromStart = Boolean(options.fromStart);
      if (options.height) config.youtube.maxHeight = Number(options.height);
      const live = await getLiveVideo(resolved.id);
      if (!live.live) throw new Error(`YouTube ${channel} is not live right now`);
      session = createSession({
        platform: 'youtube',
        videoId: live.videoId,
        title: live.title || 'YouTube live',
        streamStartedAt: live.startedAtMs ? new Date(live.startedAtMs).toISOString() : nowIso(),
        dir: path.join(work, 'session'),
      });
    }

    ensureSessionDirs(session);
    session.recordingStartedAt = nowIso();
    session.status = 'recording';
    controller = new CaptureController(session);
    await controller.start();
    console.log(`Recording ${platform} · ${session.title}${options.duration > 0 ? ` · ${options.duration}s` : ' · until the stream ends'}`);

    if (options.duration > 0) {
      await sleep(options.duration * 1000);
    } else {
      const deadline = Date.now() + 12 * 60 * 60 * 1000;
      while (Date.now() < deadline) {
        await sleep(platform === 'twitch' ? 10000 : 15000);
        try {
          if (platform === 'twitch') {
            const status = await getStream(config.twitch.login);
            if (!status.live) break;
          } else {
            const status = await getLiveVideo(config.youtube.channelId);
            if (!status.live) break;
          }
        } catch {
          // API hiccup: keep recording, the watchdog handles capture failures.
        }
      }
    }

    await controller.stopAndWait('record finished');
    controller = null;
    await reconcileParts(session);
    const result = await finalizeSession(session, { store: fakeStore });
    if (!result.ok) throw new Error(result.error || 'finalize failed');
    completed = true;
    console.log(JSON.stringify({
      ok: true,
      platform,
      title: session.title,
      file: session.final?.displayFile || session.final?.file,
      durationSeconds: session.final?.duration,
      sizeBytes: session.final?.size,
      ...(options.keepRaw ? { rawWorkDir: work } : {}),
    }, null, 2));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    try { await controller?.stop('cleanup'); } catch { /* ignore */ }
    config.recordingsDir = old.recordingsDir;
    config.archiveDisplayPath = old.archiveDisplayPath;
    config.archiveMetaDir = old.archiveMetaDir;
    config.workDir = old.workDir;
    config.recorder.archiveEnabled = old.archiveEnabled;
    config.recorder.checksum = old.checksum;
    config.recorder.keepRaw = old.keepRaw;
    config.audit.enabled = old.audit;
    config.disk.minFreeArchiveGb = old.minFreeArchiveGb;
    config.twitch = old.twitch;
    config.youtube = old.youtube;
    if (completed && !options.keepRaw) {
      await fsp.rm(work, { recursive: true, force: true }).catch(() => {});
    } else if (!completed) {
      console.error(`Recording leftovers at ${work}`);
    }
  }
}

async function commandStatus() {
  const [twitch, youtube] = await Promise.allSettled([
    getStream(),
    getLiveVideo(),
  ]);
  console.log(JSON.stringify({
    twitch: twitch.status === 'fulfilled' ? twitch.value : { error: errorMessage(twitch.reason) },
    youtube: youtube.status === 'fulfilled' ? youtube.value : { error: errorMessage(youtube.reason) },
  }, null, 2));
}

async function commandVods() {
  console.log(JSON.stringify(await getVods(undefined, 10), null, 2));
}

async function commandProbe(file) {
  const probe = await ffprobe(file);
  const silences = await scanSilences(file);
  console.log(JSON.stringify({ ...probe, silences }, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const positional = args.slice(1).filter((a) => !a.startsWith('--'));
  const fileIndex = args.indexOf('--file');
  const file = fileIndex >= 0 ? args[fileIndex + 1] : null;
  const arg = positional[0];
  const option = (name, fallback) => {
    const index = args.indexOf(name);
    return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
  };

  switch (command) {
    case 'record': {
      const platform = args[1];
      const channel = args[2];
      const parsedDuration = Number(option('--duration', '60'));
      await commandRecord(platform, channel, {
        output: option('--output', './downloads'),
        duration: Number.isFinite(parsedDuration) ? Math.max(0, parsedDuration) : 60,
        fromStart: args.includes('--from-start'),
        height: option('--height'),
        quality: option('--quality'),
        checksum: args.includes('--checksum'),
        keepRaw: args.includes('--keep-raw'),
      });
      break;
    }
    case 'mutes':
      if (!arg) throw new Error('Usage: node src/cli.js mutes <twitchVodId>');
      await commandMutes(arg);
      break;
    case 'audit-vod':
      if (!arg) throw new Error('Usage: node src/cli.js audit-vod <twitchVodId> [--samples] [--file audio.mp4]');
      await commandAuditVod(arg, { samples: args.includes('--samples'), file });
      break;
    case 'status':
      await commandStatus();
      break;
    case 'vods':
      await commandVods();
      break;
    case 'probe':
      if (!arg) throw new Error('Usage: node src/cli.js probe <file>');
      await commandProbe(arg);
      break;
    default:
      console.log(`Stream VOD Guard CLI

  node src/cli.js status                 Live status for Twitch and YouTube
  node src/cli.js vods                   Latest Twitch VODs
  node src/cli.js mutes <vodId>          Twitch muted segments (JSON)
  node src/cli.js audit-vod <vodId>      Muted-segment table
       --samples                         Download audio and compare muted vs control
       --file <audio>                    Use an already downloaded audio file
  node src/cli.js probe <file>           ffprobe + long silences

  One-off live capture (no 24/7 service):
  node src/cli.js record twitch <channel> --output <folder> --duration 60
  node src/cli.js record youtube <id|@handle|url> --output <folder> --duration 60
       --duration 0                      Record until the stream ends
       --from-start                      YouTube: recover from the DVR start
       --height 1080                     YouTube: max height
       --quality best                    Twitch: streamlink quality
       --checksum                        Compute SHA-256
       --keep-raw                        Keep temporary parts
`);
  }
}

main().catch((error) => {
  console.error(`ERROR: ${error.stack || error.message}`);
  process.exit(1);
});
