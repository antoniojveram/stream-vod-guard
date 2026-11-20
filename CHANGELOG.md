# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

## [1.1.0] — 2026-11-19

### Added

- Optional **HEVC compression** of finished recordings with Intel/AMD VAAPI
  hardware encoding (x265 CPU fallback). The original is kept until the new file
  is probed, decoded and verified smaller.
- **Encoder selection in the dashboard** (`auto`, `vaapi`, `x265`, `none`) with
  runtime re-probing when settings are saved.
- Safe degradation on unsupported hosts: a missing encoder **skips**
  compression and keeps the H.264 original; it never marks the recording as
  failed or deletes it.
- x265 is validated with a one-frame probe, and the image builds for both
  `linux/amd64` and `linux/arm64` (Intel VAAPI driver only on amd64).
- **YouTube backup retention**: delete the secondary copy after N days when a
  verified Twitch recording covers at least 95% of it.
- Storage section in the dashboard settings, per-recording **Compress to HEVC**
  action, compression progress/savings badges and activity events.
- `docker-compose.vaapi.yml` for `/dev/dri` passthrough and `RENDER_GID`.
- API endpoints `GET /api/storage`, `POST /api/storage/prune` and
  `POST /api/sessions/:id/compress`.
- Compression and retention tests.

### Changed

- The dashboard identity is fixed to **Stream VOD Guard**. `APP_NAME`,
  `APP_MARK` and the name/mark fields were removed; only the filename template
  remains configurable.
- The Docker image now includes the Intel and Mesa VAAPI drivers.
- Documentation for quality, storage, configuration and troubleshooting.

## [1.0.1] — 2026-11-19

### Changed

- YouTube now defaults to **maximum available quality** (`YOUTUBE_MAX_HEIGHT=0`) instead of a 1080p cap.
- Final files record and display their real resolution/FPS (`final.quality`).
- Added a quality verification guide and real capture checks.

## [1.0.0] — 2026-11-19

### Added

- Dual live capture for Twitch (`streamlink`) and YouTube (`yt-dlp --live-from-start`).
- Web dashboard with live status, active sessions, history, events and downloads.
- Settings dialog: channels, destination folder browser, app name/mark and filename template.
- Runtime reconfiguration without restarting the container; persisted in `data/settings.json`.
- Per-session destination snapshot and verified copy with retry.
- Crash-resilient parts, process-group kills and watchdog restarts.
- Twitch VOD mute audit with per-segment volume measurements (PASS/WARN/FAIL/OUTSIDE).
- Folder creation and path validation under `VIDEOS_ROOT`.
- CLI: `status`, `vods`, `mutes`, `audit-vod`, `probe`, one-off `record`.
- Optional ntfy, Telegram and Discord notifications.
- Disk guards, retention, SHA-256, range downloads and optional dashboard token.
- Docker Compose, multi-arch GHCR release, CI and case study documentation.

[1.1.0]: https://github.com/antoniojveram/stream-vod-guard/releases/tag/v1.1.0
[1.0.1]: https://github.com/antoniojveram/stream-vod-guard/releases/tag/v1.0.1
[1.0.0]: https://github.com/antoniojveram/stream-vod-guard/releases/tag/v1.0.0
