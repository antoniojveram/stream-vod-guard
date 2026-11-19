import { config } from './config.js';
import { logger } from './logger.js';
import { parseIso, truncate } from './util.js';

const GQL_URL = 'https://gql.twitch.tv/gql';
// Public client id used by twitch.tv's own web player.
const WEB_CLIENT_ID = 'kimne78kx3ncx6brgo4mv6wki5h1ko';

const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

async function gql(query, variables = {}, { operationName } = {}) {
  const body = { query, variables };
  if (operationName) body.operationName = operationName;
  const res = await fetch(GQL_URL, {
    method: 'POST',
    headers: {
      'Client-ID': WEB_CLIENT_ID,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error(`Twitch GQL HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors?.length) {
    throw new Error(`Twitch GQL: ${json.errors.map((e) => e.message).join('; ')}`);
  }
  return json.data;
}

export async function getStream(login = config.twitch.login) {
  const query = `query StreamStatus($login: String!) {
    user(login: $login) {
      id
      login
      displayName
      stream {
        id
        type
        createdAt
        viewersCount
        title
        game { id name }
      }
    }
  }`;
  const data = await gql(query, { login }, { operationName: 'StreamStatus' });
  const user = data?.user;
  if (!user) throw new Error(`Twitch user "${login}" not found`);
  const stream = user.stream;
  if (!stream || stream.type !== 'live') {
    return {
      live: false,
      user: { id: user.id, login: user.login, displayName: user.displayName },
      stream: null,
    };
  }
  return {
    live: true,
    user: { id: user.id, login: user.login, displayName: user.displayName },
    stream: {
      id: String(stream.id),
      type: stream.type,
      createdAt: stream.createdAt,
      startedAtMs: parseIso(stream.createdAt),
      viewers: stream.viewersCount ?? null,
      title: stream.title || '',
      game: stream.game?.name || null,
    },
  };
}

export async function getVods(login = config.twitch.login, first = 8) {
  const query = `query ChannelVideos($login: String!, $first: Int!) {
    user(login: $login) {
      videos(first: $first, type: ARCHIVE, sort: TIME) {
        edges {
          node {
            id
            title
            createdAt
            lengthSeconds
            viewCount
            game { name }
          }
        }
      }
    }
  }`;
  const data = await gql(query, { login, first }, { operationName: 'ChannelVideos' });
  return (data?.user?.videos?.edges || []).map(({ node }) => ({
    id: String(node.id),
    title: node.title,
    createdAt: node.createdAt,
    createdAtMs: parseIso(node.createdAt),
    lengthSeconds: node.lengthSeconds,
    viewCount: node.viewCount,
    game: node.game?.name || null,
  }));
}

/**
 * Twitch's own VOD seekbar uses this GraphQL operation. It is public (the same
 * anonymous query the web player issues) and returns the exact ranges that
 * Twitch Audio Recognition muted. This is why no OAuth token is needed.
 */
export async function getVodMutes(vodId) {
  const query = `query VideoPlayer_VODSeekbar($vodID: ID!, $includePrivate: Boolean = false) {
    video(id: $vodID, options: { includePrivate: $includePrivate }) {
      id
      title
      lengthSeconds
      createdAt
      muteInfo {
        mutedSegmentConnection {
          nodes { duration offset }
        }
      }
    }
  }`;
  const data = await gql(
    query,
    { vodID: String(vodId), includePrivate: false },
    { operationName: 'VideoPlayer_VODSeekbar' },
  );
  const video = data?.video;
  if (!video) throw new Error(`Twitch VOD ${vodId} not found or not public`);
  const nodes = video.muteInfo?.mutedSegmentConnection?.nodes || [];
  return {
    id: String(video.id),
    title: video.title,
    lengthSeconds: video.lengthSeconds,
    createdAt: video.createdAt,
    mutedSegments: nodes
      .map((s) => ({ offset: Number(s.offset), duration: Number(s.duration) }))
      .filter((s) => Number.isFinite(s.offset) && Number.isFinite(s.duration) && s.duration > 0)
      .sort((a, b) => a.offset - b.offset),
  };
}

/**
 * After a stream ends Twitch creates the archive within a few minutes. Match it
 * by start time (createdAt is the broadcast start, not the processing time).
 */
export async function findVodForStream(streamStartedAt, { login = config.twitch.login, toleranceMs = 15 * 60 * 1000 } = {}) {
  const target = parseIso(streamStartedAt);
  if (!target) return null;
  const vods = await getVods(login, 12);
  let best = null;
  let bestDelta = Infinity;
  for (const vod of vods) {
    if (!vod.createdAtMs) continue;
    const delta = Math.abs(vod.createdAtMs - target);
    if (delta < bestDelta) {
      best = vod;
      bestDelta = delta;
    }
  }
  if (best && bestDelta <= toleranceMs) return { ...best, deltaMs: bestDelta };
  return null;
}

/** Poll the VOD until Twitch finishes its post-broadcast audio scan. */
export async function watchVodMutes({
  vodId,
  onUpdate,
  maxMs = config.audit.vodWatchMaxMs,
  pollMs = config.audit.vodPollMs,
  signal,
}) {
  const startedAt = Date.now();
  let last = null;
  let firstMuteAt = null;
  while (Date.now() - startedAt < maxMs) {
    if (signal?.aborted) return { aborted: true, ...last };
    try {
      last = await getVodMutes(vodId);
      if (last.mutedSegments.length > 0 && !firstMuteAt) {
        firstMuteAt = Date.now();
        last.firstMuteSeenAt = new Date(firstMuteAt).toISOString();
        last.msAfterWatchStart = firstMuteAt - startedAt;
        logger.info(`Twitch VOD ${vodId}: ${last.mutedSegments.length} muted segments detected`, {
          totalMutedSeconds: last.mutedSegments.reduce((a, s) => a + s.duration, 0),
          secondsAfterStreamEnd: last.secondsAfterStreamEnd ?? null,
        });
        await onUpdate?.(last);
        return { ...last, firstMuteSeenAt: last.firstMuteSeenAt };
      }
      await onUpdate?.(last);
    } catch (error) {
      logger.warn(`Could not read muted segments for VOD ${vodId}: ${truncate(error.message, 200)}`);
    }
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, pollMs);
      signal?.addEventListener('abort', () => {
        clearTimeout(timer);
        resolve();
      }, { once: true });
    });
  }
  return last;
}

export function summarizeMutes(vod) {
  if (!vod?.mutedSegments?.length) {
    return { count: 0, seconds: 0, percent: 0, segments: [] };
  }
  const seconds = vod.mutedSegments.reduce((acc, s) => acc + s.duration, 0);
  return {
    count: vod.mutedSegments.length,
    seconds,
    percent: vod.lengthSeconds ? (seconds / vod.lengthSeconds) * 100 : null,
    segments: vod.mutedSegments,
  };
}
