import { config } from './config.js';
import { logger } from './logger.js';
import { parseIso, run, truncate } from './util.js';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const BASE_HEADERS = {
  'User-Agent': USER_AGENT,
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

/**
 * Extract a JSON object that starts after `marker` using brace matching that
 * respects quoted strings. YouTube embeds large JSON blobs in the HTML and a
 * naive regex breaks on braces inside strings.
 */
export function extractJsonAfter(html, marker) {
  const markerIndex = html.indexOf(marker);
  if (markerIndex < 0) return null;
  const start = html.indexOf('{', markerIndex + marker.length);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < html.length; i += 1) {
    const ch = html[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function decodeXml(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

export function parseRss(xml) {
  const entries = [];
  const blocks = String(xml).match(/<entry>[\s\S]*?<\/entry>/g) || [];
  for (const block of blocks) {
    const videoId = block.match(/<yt:videoId>([^<]+)<\/yt:videoId>/)?.[1];
    if (!videoId) continue;
    entries.push({
      videoId,
      title: decodeXml(block.match(/<title>([\s\S]*?)<\/title>/)?.[1] || ''),
      published: block.match(/<published>([^<]+)<\/published>/)?.[1] || null,
      updated: block.match(/<updated>([^<]+)<\/updated>/)?.[1] || null,
      publishedAtMs: parseIso(block.match(/<published>([^<]+)<\/published>/)?.[1]),
    });
  }
  return entries;
}

export function extractYouTubeChannelId(html, input = '') {
  const source = String(html || '');
  const direct = String(input || '').trim().match(/^UC[\w-]{22}$/)?.[0];
  if (direct) return direct;
  const fromUrl = String(input || '').match(/youtube\.com\/channel\/(UC[\w-]{22})/)?.[1];
  if (fromUrl) return fromUrl;
  return source.match(/"channelId":"(UC[\w-]{22})"/)?.[1]
    || source.match(/"externalId":"(UC[\w-]{22})"/)?.[1]
    || source.match(/\/channel\/(UC[\w-]{22})/)?.[1]
    || null;
}

/**
 * Resolve a channel ID from an ID, a handle (@name), or a full YouTube URL.
 * Used only at startup (or when the configuration changes).
 */
export async function resolveYouTubeChannelId(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('Falta YOUTUBE_CHANNEL_ID o YOUTUBE_CHANNEL');
  if (/^UC[\w-]{22}$/.test(raw)) return { id: raw, label: null, source: 'id' };
  if (/youtube\.com\/channel\/(UC[\w-]{22})/.test(raw)) {
    return { id: raw.match(/youtube\.com\/channel\/(UC[\w-]{22})/)[1], label: null, source: 'url' };
  }
  const url = /^https?:\/\//i.test(raw)
    ? raw
    : `https://www.youtube.com/${raw.startsWith('@') ? '' : '@'}${raw}`;
  const res = await fetch(url, {
    headers: BASE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`Could not resolve YouTube channel (${url}): HTTP ${res.status}`);
  const html = await res.text();
  const id = extractYouTubeChannelId(html, res.url);
  if (!id) throw new Error(`No channelId found at ${url}`);
  const label = decodeXml(
    html.match(/<meta property="og:title" content="([^"]+)"/)?.[1]
    || html.match(/<title>([^<]*)<\/title>/)?.[1]?.replace(/\s*-\s*YouTube\s*$/, '')
    || '',
  ).trim() || null;
  return { id, label, source: 'handle' };
}

export async function getRssVideos(channelId = config.youtube.channelId || config.youtube.channelInput) {
  let id = String(channelId || '').trim();
  if (!/^UC[\w-]{22}$/.test(id)) {
    const resolved = await resolveYouTubeChannelId(id);
    id = resolved.id;
  }
  const url = `https://www.youtube.com/feeds/videos.xml?channel_id=${encodeURIComponent(id)}`;
  const res = await fetch(url, { headers: BASE_HEADERS, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`YouTube RSS HTTP ${res.status}`);
  return parseRss(await res.text());
}

/**
 * Check the channel's /live endpoint. When offline YouTube serves the channel
 * page (canonical URL has no video); when live it serves the watch page with
 * ytInitialPlayerResponse.videoDetails.isLive === true.
 */
export async function getLiveVideo(channelId = config.youtube.channelId || config.youtube.channelInput) {
  let id = String(channelId || '').trim();
  if (!/^UC[\w-]{22}$/.test(id)) {
    const resolved = await resolveYouTubeChannelId(id);
    id = resolved.id;
  }
  const url = `https://www.youtube.com/channel/${encodeURIComponent(id)}/live`;
  const res = await fetch(url, {
    headers: BASE_HEADERS,
    redirect: 'follow',
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`YouTube live page HTTP ${res.status}`);
  const html = await res.text();
  const player = extractJsonAfter(html, 'ytInitialPlayerResponse = ');
  const details = player?.videoDetails;
  const playability = player?.playabilityStatus;
  const micro = player?.microformat?.playerMicroformatRenderer;
  const startTimestamp = micro?.liveBroadcastDetails?.startTimestamp || null;

  if (details?.videoId) {
    // Never trust a recommended video surfaced on the page: it must belong to
    // the configured channel and be actually live.
    if (String(details.channelId) !== String(id)) {
      return { live: false, reason: 'channel-mismatch', foundChannelId: details.channelId };
    }
    if (details.isLive === true && (playability?.status === 'OK' || !playability)) {
      return {
        live: true,
        videoId: details.videoId,
        title: details.title || '',
        channelId: details.channelId,
        author: details.author || '',
        startedAtMs: parseIso(startTimestamp),
        viewers: details.viewCount ? Number(details.viewCount) : null,
      };
    }
    if (playability?.status && playability.status !== 'OK') {
      return {
        live: false,
        reason: `playability:${playability.status}`,
        message: playability.reason || null,
      };
    }
  }

  // A live watch page may expose a canonical URL even when the player response
  // was not parsed (consent/bot variant). Only accept it if it is a watch URL;
  // an offline channel canonicalizes back to /channel/<id>.
  const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)?.[1] || '';
  const videoId = canonical.match(/[?&]v=([\w-]{11})/)?.[1] || null;
  if (videoId && details?.channelId && String(details.channelId) === String(id)) {
    const liveHint = /"isLive":true|"isLiveNow":true|"liveBroadcastDetails":\{[^}]*"isLiveNow":true/.test(html);
    if (liveHint) {
      return {
        live: true,
        videoId,
        title: details.title || '',
        channelId: details.channelId,
        author: details.author || '',
        startedAtMs: parseIso(startTimestamp),
      };
    }
  }

  return { live: false, reason: 'offline' };
}

export async function getVideoInfo(videoId) {
  const args = [
    '-J',
    '--no-warnings',
    '--no-playlist',
    '--socket-timeout', '20',
    '--retries', '3',
  ];
  if (config.youtube.cookiesFile) args.push('--cookies', config.youtube.cookiesFile);
  args.push(`https://www.youtube.com/watch?v=${videoId}`);
  const result = await run('yt-dlp', args, { timeoutMs: 90000, maxOutput: 8 * 1024 * 1024 });
  if (result.code !== 0) {
    throw new Error(`yt-dlp metadata failed: ${truncate(result.stderr, 400)}`);
  }
  let data;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error('yt-dlp returned invalid JSON metadata');
  }
  return {
    videoId: data.id,
    title: data.title,
    channelId: data.channel_id,
    channel: data.channel,
    isLive: data.is_live === true,
    wasLive: data.was_live === true,
    liveStatus: data.live_status,
    duration: data.duration,
    timestamp: data.timestamp ? data.timestamp * 1000 : null,
    releaseTimestamp: data.release_timestamp ? data.release_timestamp * 1000 : null,
    viewers: data.concurrent_view_count ?? null,
    formats: (data.formats || []).map((f) => ({
      id: f.format_id,
      ext: f.ext,
      height: f.height,
      vcodec: f.vcodec,
      acodec: f.acodec,
      protocol: f.protocol,
    })),
  };
}

/**
 * Secondary detector for cases where the /live page is A/B tested or blocked:
 * a brand new RSS entry is checked with yt-dlp and treated as live when its
 * live_status is is_live (or post_live, i.e. it just ended).
 */
export async function detectLiveFromRss(channelId, seenVideoIds = []) {
  const videos = await getRssVideos(channelId);
  const seen = new Set(seenVideoIds);
  const recent = videos.filter((v) => {
    if (seen.has(v.videoId)) return false;
    return !v.publishedAtMs || Date.now() - v.publishedAtMs < 24 * 60 * 60 * 1000;
  });
  for (const video of recent.slice(0, 2)) {
    try {
      const info = await getVideoInfo(video.videoId);
      if (info.channelId !== channelId) continue;
      if (info.liveStatus === 'is_live' || info.liveStatus === 'post_live') {
        return {
          live: info.liveStatus === 'is_live',
          justEnded: info.liveStatus === 'post_live',
          videoId: video.videoId,
          title: info.title || video.title,
          viewers: info.viewers,
          startedAtMs: video.publishedAtMs,
          info,
        };
      }
    } catch (error) {
      logger.debug(`RSS candidate ${video.videoId} not live: ${truncate(error.message, 120)}`);
    }
  }
  return { live: false, videos };
}
