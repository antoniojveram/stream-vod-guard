import test from 'node:test';
import assert from 'node:assert/strict';
import {
  finalFileName,
  localStamp,
  normalizeTwitchLogin,
  normalizeMuteSegments,
  parseMeanVolume,
  parseSilenceDetect,
  sanitizeFilename,
} from '../src/util.js';
import { extractJsonAfter, extractYouTubeChannelId, parseRss } from '../src/youtube.js';
import { createSession } from '../src/store.js';
import { displayPathFor } from '../src/config.js';
import { validateDestination } from '../src/settings.js';

test('normalizeMuteSegments merges adjacent Twitch 3-minute blocks', () => {
  const merged = normalizeMuteSegments([
    { offset: 5220, duration: 180 },
    { offset: 5400, duration: 180 },
    { offset: 8100, duration: 180 },
    { offset: 8100, duration: 180 },
  ], 20000);
  assert.equal(merged.length, 2);
  assert.equal(merged[0].offset, 5220);
  assert.equal(merged[0].duration, 360);
  assert.equal(merged[1].offset, 8100);
  assert.equal(merged[1].duration, 180);
});

test('normalizeMuteSegments clamps to VOD length', () => {
  const merged = normalizeMuteSegments([{ offset: 90, duration: 30 }], 100);
  assert.equal(merged[0].duration, 10);
});

test('sanitizeFilename keeps Unicode text but removes path characters', () => {
  assert.equal(sanitizeFilename('Café ☕ / Live #1'), 'Café ☕ - Live #1');
  assert.equal(sanitizeFilename('../../etc/passwd'), 'etc-passwd');
});

test('finalFileName includes channel, local date, title and platform id', () => {
  const name = finalFileName({
    platform: 'twitch',
    channel: 'Example Channel',
    title: 'Example Show #1',
    streamId: '123456',
    streamStartedAt: '2026-11-18T23:15:54Z',
  }, 'Europe/Madrid');
  assert.match(name, /^Example Channel - 2026-11-19 00-15 - Example Show #1 \[twitch-123456\]\.mkv$/);
});

test('localStamp uses the requested timezone', () => {
  assert.equal(localStamp('2026-11-18T23:15:54Z', 'Europe/Madrid'), '2026-11-19 00-15');
  assert.equal(localStamp('2026-11-18T23:15:54Z', 'UTC'), '2026-11-18 23-15');
});

test('normalizeTwitchLogin accepts login, at-login and full URL', () => {
  assert.equal(normalizeTwitchLogin('example'), 'example');
  assert.equal(normalizeTwitchLogin('@Example'), 'example');
  assert.equal(normalizeTwitchLogin('https://www.twitch.tv/example?foo=bar'), 'example');
  assert.equal(normalizeTwitchLogin(''), '');
});

test('finalFileName supports a custom template', () => {
  const name = finalFileName({
    platform: 'youtube',
    channel: 'My Channel',
    title: 'Test stream',
    videoId: 'abc123',
    streamStartedAt: '2026-11-18T23:15:54Z',
  }, 'Europe/Madrid', '{channel}/{date}/{title}');
  assert.equal(name, 'My Channel-2026-11-19 00-15-Test stream.mkv');
});

test('parseSilenceDetect extracts only long silences', () => {
  const stderr = `
[silencedetect @ 0x1] silence_start: 10.5
[silencedetect @ 0x1] silence_end: 20.0 | silence_duration: 9.5
[silencedetect @ 0x1] silence_start: 100
[silencedetect @ 0x1] silence_end: 160.25 | silence_duration: 60.25
`;
  const out = parseSilenceDetect(stderr, 20);
  assert.equal(out.length, 1);
  assert.equal(out[0].start, 100);
  assert.equal(out[0].duration, 60.25);
});

test('parseMeanVolume reads ffmpeg volumedetect output', () => {
  assert.equal(parseMeanVolume('[Parsed_volumedetect_0] mean_volume: -23.4 dB'), -23.4);
  assert.equal(parseMeanVolume('nothing'), null);
});

test('extractJsonAfter handles braces and escaped quotes inside strings', () => {
  const html = 'x var ytInitialPlayerResponse = {"a":"} not the end","b":{"c":1},"d":"\\"x\\""}; tail';
  assert.deepEqual(extractJsonAfter(html, 'ytInitialPlayerResponse = '), {
    a: '} not the end',
    b: { c: 1 },
    d: '"x"',
  });
});

test('parseRss reads video ids, titles and timestamps', () => {
  const xml = `<feed><entry>
    <yt:videoId>dQw4w9WgXcQ</yt:videoId>
    <title>Example video</title>
    <published>2026-11-18T23:24:18+00:00</published>
  </entry></feed>`;
  const [entry] = parseRss(xml);
  assert.equal(entry.videoId, 'dQw4w9WgXcQ');
  assert.equal(entry.title, 'Example video');
  assert.equal(entry.publishedAtMs, Date.parse('2026-11-18T23:24:18+00:00'));
});

test('extractYouTubeChannelId accepts IDs, channel URLs and page HTML', () => {
  const id = 'UCabcdefghijklmnopqrstuv';
  assert.equal(extractYouTubeChannelId('', id), id);
  assert.equal(extractYouTubeChannelId('', `https://www.youtube.com/channel/${id}`), id);
  assert.equal(
    extractYouTubeChannelId(`<link rel="canonical" href="https://www.youtube.com/channel/${id}">`),
    id,
  );
});

test('createSession accepts an explicit id (used for re-live suffix sessions)', () => {
  const session = createSession({
    id: 'twitch-123-r2',
    platform: 'twitch',
    streamId: '123',
    title: 'Reconnect',
    dir: '/tmp/x',
  });
  assert.equal(session.id, 'twitch-123-r2');
  assert.equal(session.streamId, '123');
  assert.equal(session.platform, 'twitch');
});

test('destination paths are constrained to VIDEOS_ROOT and mapped for display', () => {
  assert.equal(displayPathFor('/videos/recordings'), 'videos/recordings');
  assert.equal(validateDestination('/videos/recordings'), '/videos/recordings');
  assert.throws(() => validateDestination('/etc'), /inside/);
});
