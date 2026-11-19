# Security policy

## Supported versions

Security fixes are applied to the latest release on `main`.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

<https://github.com/antoniojveram/stream-vod-guard/security/advisories/new>

Do not open a public issue with exploit details. Include:

- affected version or commit;
- a description and reproduction steps;
- impact (path traversal, auth bypass, RCE, secret exposure, etc.);
- any suggested fix.

## Scope

Relevant areas:

- dashboard/API authentication and exposure;
- path traversal in settings, folders or file downloads;
- command injection through channel names or metadata;
- container privilege issues;
- accidental leakage of `.env`, cookies or tokens.

Out of scope:

- recording publicly available streams for personal use (the project's purpose);
- platform-side copyright claims or muting (we preserve the live feed, not bypass DRM);
- issues caused by exposing the dashboard to the internet without authentication.

## Hardening checklist for users

- Keep `DASHBOARD_BIND=127.0.0.1` unless you use a reverse proxy with authentication.
- Set `DASHBOARD_TOKEN` if the dashboard is reachable by others.
- Do not commit `.env`, cookies or `data/settings.json`.
- Keep Docker, FFmpeg, yt-dlp and Streamlink updated.
- Mount cookies read-only when possible.
