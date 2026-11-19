# Troubleshooting

## The dashboard shows a channel as "Disabled"

The monitor disables itself when the channel is missing or cannot be resolved. Open **⚙ Settings** and enter:

- Twitch: `channel`, `@channel` or `https://twitch.tv/channel`.
- YouTube: `UC...`, `@handle` or `https://youtube.com/@handle`.

Check the container log for the exact reason:

```bash
docker compose logs --tail=100 stream-vod-guard
```

## YouTube does not start recording

- The stream may be members-only. Export cookies in Netscape format and set `YT_COOKIES_FILE=/data/cookies.txt`.
- The handle may be wrong; prefer the channel ID (`UC...`).
- YouTube may temporarily block the datacenter IP; try again or use the official API-based monitor in a future release.
- `yt-dlp` may be outdated. Rebuild the image: `docker compose build --pull`.

## Twitch capture exits immediately

- Verify that the quality exists: `best` always works; `720p` may not exist while `720p60` does.
- If the channel is subscriber-only, add `TWITCH_OAUTH_TOKEN`.
- Check `docker compose logs` for `error: The specified stream(s) ... could not be found`.

## Gaps in the Twitch file

`TWITCH_DISABLE_ADS=true` filters Twitch's server-side ads, leaving 1–3 minute gaps. Both recordings are kept; use the YouTube copy if you need every second. Set `TWITCH_DISABLE_ADS=false` to keep the ads.

## Destination is not writable

```bash
chmod -R u+rwX /path/to/videos
```

- Check that the NAS is mounted on the host.
- The container writes as the image user (uid 1000). Match ownership or use a bind mount with permissive permissions.
- If the copy fails, the MKV stays in `data/work/<session>/final/` and is retried every minute and on startup.

## Disk full

- Local disk: raw parts. The recorder stops new sessions below `MIN_FREE_GB` and aborts below 2 GB.
- Destination: final copies. `MIN_FREE_ARCHIVE_GB` prevents filling it.
- Reduce `YOUTUBE_MAX_HEIGHT` to 720, set `CHECKSUM=false`, or enable `RETENTION_DAYS`.

## Port already in use

Change `DASHBOARD_PORT` in `.env` and restart.

## The dashboard is not reachable from another machine

It binds to `127.0.0.1` on purpose. Use an SSH tunnel:

```bash
ssh -L 8787:127.0.0.1:8787 user@host
```

Or put a reverse proxy with authentication in front and set `DASHBOARD_BIND=0.0.0.0` plus `DASHBOARD_TOKEN`.

## Audit stays "pending"

- Twitch has not scanned the VOD yet (can take a while).
- The VOD is subscriber-only, deleted, or was never created.
- The recording started after the muted segment (marked "outside coverage").

The live recording is still valid. The audit is additional evidence, not a requirement for capture.

## "No usable capture parts"

Both attempts produced empty or corrupt parts. Check:

- The channel was live for the whole capture.
- The output directory is writable.
- `ffmpeg -version` inside the container works.
- The container log for process errors.

Raw parts are kept under `data/work/<session>/raw/` for inspection.

## Settings saved but ignored after restart

`data/settings.json` overrides `.env`. Delete it to return to `.env`:

```bash
rm data/settings.json
docker compose restart
```
