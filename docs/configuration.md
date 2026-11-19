# Configuration

Stream VOD Guard is configured by environment variables and, optionally, by the dashboard. The dashboard writes `data/settings.json`; on startup those values **override** `.env`.

## Precedence

1. `data/settings.json` (saved from the dashboard)
2. `.env` (Docker Compose)
3. built-in defaults

To return to `.env` values, delete `data/settings.json` and restart.

## Channels

| Variable | Accepted values | Example |
| --- | --- | --- |
| `TWITCH_CHANNEL` | login, `@login`, URL | `illojuan`, `@illojuan`, `https://twitch.tv/illojuan` |
| `YOUTUBE_CHANNEL` | channel ID, `@handle`, URL | `UCKvoBRFqMNqvuSvFBiNadgw`, `@IlloJuanTV`, `https://youtube.com/@IlloJuanTV` |
| `YOUTUBE_CHANNEL_ID` | channel ID | `UCKvoBRFqMNqvuSvFBiNadgw` |
| `YOUTUBE_CHANNEL_LABEL` | display name | `IlloJuan` |
| `TWITCH_ENABLED` / `YOUTUBE_ENABLED` | `true` / `false` | `true` |

If a channel is empty or cannot be resolved, its monitor is disabled with a log message; the dashboard remains available so you can fix it.

> For IlloJuan, `@IlloJuanTV` is the VOD channel. The main channel is `UCKvoBRFqMNqvuSvFBiNadgw`.

## Paths

The container mounts a **parent folder** at `/videos`; the dashboard can browse and create subfolders.

| Variable | Default | Description |
| --- | --- | --- |
| `VIDEOS_HOST_PATH` | `./videos` | Host parent folder, mounted at `/videos` |
| `VIDEOS_ROOT` | `/videos` | Parent path inside the container |
| `VIDEOS_HOST_ROOT` | `./videos` | Parent path shown in the dashboard |
| `RECORDINGS_DIR` | `/videos/recordings` | Initial destination inside the container |
| `ARCHIVE_DISPLAY_PATH` | computed | Initial destination shown in the dashboard |
| `DATA_HOST_PATH` | `./data` | State, settings, logs and temporary parts |

Example with a NAS:

```env
VIDEOS_HOST_PATH=/mnt/nas/videos
VIDEOS_ROOT=/videos
VIDEOS_HOST_ROOT=/mnt/nas/videos
RECORDINGS_DIR=/videos/recordings
ARCHIVE_DISPLAY_PATH=/mnt/nas/videos/recordings
```

The API validates that every destination is inside `VIDEOS_ROOT` (path traversal is rejected; symlinked directories are skipped by the folder browser).

## Filenames

`FILENAME_TEMPLATE` supports:

| Placeholder | Value |
| --- | --- |
| `{channel}` | Channel name |
| `{date}` | Stream start, local timezone (`YYYY-MM-DD HH-MM`) |
| `{title}` | Stream title |
| `{platform}` | `twitch` or `youtube` |
| `{id}` | Twitch stream ID or YouTube video ID |
| `{game}` | Twitch category (empty for YouTube) |

Example:

```env
FILENAME_TEMPLATE={date} - {channel} - {title} [{platform}-{id}]
```

The result is sanitized and always ends in `.mkv`.

## Capture

| Variable | Default | Description |
| --- | --- | --- |
| `TWITCH_POLL_MS` | `5000` | Twitch live poll interval |
| `TWITCH_QUALITY` | `best` | Streamlink quality (`1080p60`, `720p60`…) |
| `TWITCH_DISABLE_ADS` | `true` | Filter Twitch ad segments |
| `TWITCH_OAUTH_TOKEN` | empty | Optional Twitch account token |
| `YOUTUBE_POLL_MS` | `30000` | YouTube live poll interval |
| `YOUTUBE_MAX_HEIGHT` | `0` | `0` = maximum available; or cap height |
| `YOUTUBE_LIVE_FROM_START` | `true` | Recover from the DVR start |
| `YT_COOKIES_FILE` | empty | Netscape cookies file for members-only content |
| `STALL_TIMEOUT_MS` | `240000` | Watchdog threshold with no bytes |
| `RESTART_BACKOFF_MS` | `5000` | Initial restart delay |
| `OFFLINE_GRACE_MS` | `90000` | Wait before finalizing |
| `WATCHDOG_MS` | `10000` | Watchdog check interval |

Twitch ad filtering can leave 1–3 minute gaps; the YouTube copy covers them. Set `TWITCH_DISABLE_ADS=false` to record the ads instead.

## Storage and retention

| Variable | Default | Description |
| --- | --- | --- |
| `ARCHIVE_ENABLED` | `true` | Copy the final MKV to the destination |
| `CHECKSUM` | `true` | SHA-256 of the final MKV |
| `KEEP_RAW` | `false` | Keep temporary parts after archiving |
| `MIN_FREE_GB` | `25` | Minimum local free space to start |
| `WARN_FREE_GB` | `60` | Local warning threshold |
| `MIN_FREE_ARCHIVE_GB` | `30` | Minimum destination free space |
| `WARN_FREE_ARCHIVE_GB` | `100` | Destination warning threshold |
| `RETENTION_DAYS` | `0` | 0 = forever; N = delete finalized recordings older than N days |

Size estimate: 1080p60 ≈ 3.5 GB/h. Recording both platforms ≈ 7 GB/h.

## Mute audit

| Variable | Default | Description |
| --- | --- | --- |
| `VOD_AUDIT_ENABLED` | `true` | Compare the recording with Twitch's muted segments |
| `VOD_POLL_MS` | `60000` | VOD mute polling interval |
| `VOD_WATCH_MAX_MS` | `86400000` | Maximum time to wait for Twitch's scan |
| `SILENCE_NOISE_DB` | `-55` | Silence threshold for the local scan |
| `SILENCE_MIN_SECONDS` | `20` | Minimum silence length reported |
| `MUTE_SAMPLE_SECONDS` | `30` | Sample length per muted segment |
| `MUTE_PASS_DB` | `-55` | Mean volume considered "audio present" |

## Dashboard

| Variable | Default | Description |
| --- | --- | --- |
| `DASHBOARD_PORT` | `8787` | Host port |
| `DASHBOARD_BIND` | `127.0.0.1` | Host bind address |
| `DASHBOARD_TOKEN` | empty | Bearer/query token for API, settings and files |
| `CONTAINER_NAME` | `stream-vod-guard` | Compose container name |
| `APP_ENV_FILE` | `.env` | Env file used by the Compose service (multi-instance) |

## Notifications

| Variable | Description |
| --- | --- |
| `NTFY_URL`, `NTFY_TOPIC`, `NTFY_TOKEN` | ntfy push notifications |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID` | Telegram |
| `DISCORD_WEBHOOK` | Discord webhook |
| `NOTIFY_ON_LIVE` | Notify when a live starts (failures are always notified) |

## Several channels

One container per channel, each with its own `.env`, data directory, port and destination:

```bash
cp .env .env.second
# edit CONTAINER_NAME, DASHBOARD_PORT, DATA_HOST_PATH, RECORDINGS_DIR, channels
APP_ENV_FILE=.env.second docker compose -p second --env-file .env.second up -d
```

All instances can mount the same `VIDEOS_HOST_PATH`; choose different subfolders in each dashboard.
