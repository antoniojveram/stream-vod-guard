# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses [Semantic Versioning](https://semver.org/).

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

[1.0.1]: https://github.com/antoniojveram/stream-vod-guard/releases/tag/v1.0.1
[1.0.0]: https://github.com/antoniojveram/stream-vod-guard/releases/tag/v1.0.0
