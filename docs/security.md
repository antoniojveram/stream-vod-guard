# Security

## Threat model

Stream VOD Guard is a personal, self-hosted tool. It is not a multi-tenant service. The default deployment is reachable only from the host (`127.0.0.1`) and has no user accounts.

## Dashboard exposure

- Default: `DASHBOARD_BIND=127.0.0.1`. Only the host can connect.
- For remote access, prefer an SSH tunnel:
  ```bash
  ssh -L 8787:127.0.0.1:8787 user@host
  ```
- If you must expose it, put a reverse proxy with TLS and strong authentication in front and set `DASHBOARD_TOKEN`.
- The token is accepted as `Authorization: Bearer <token>` or `?token=<token>`. Treat the query-string form as sensitive (it can appear in logs).

## Path handling

- The settings API accepts a destination only inside `VIDEOS_ROOT` (`/videos` by default).
- `path.resolve` plus a prefix check blocks `..` traversal.
- Symlinked directories are skipped by the folder browser.
- Downloads are served only from the mounted videos root; hidden metadata directories are blocked.

## Container hardening

`docker-compose.yml` sets:

```yaml
security_opt:
  - no-new-privileges:true
cap_drop:
  - ALL
```

The container runs as the unprivileged `node` user. It needs write access only to `/data` and the mounted `/videos` parent.

## Secrets

- Do not commit `.env`, `data/settings.json`, cookies or tokens.
- `YT_COOKIES_FILE` should be mounted read-only if possible:
  ```yaml
  - ./cookies.txt:/data/cookies.txt:ro
  ```
- Twitch OAuth tokens and notification credentials are read from the environment.
- GitHub Actions uses `GITHUB_TOKEN` only for GHCR publishing.

## Recording and copyright

- The tool records **public live streams** for personal time-shifting.
- It does not bypass DRM, access controls or paywalls.
- It does not remove copyright claims from the platform; it preserves the live signal before post-stream processing.
- Do not redistribute recordings. Music and third-party content remain the property of their rights holders.
- Respect the streamer's wishes. If a creator asks you not to archive their stream, do not.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting:

<https://github.com/antoniojveram/stream-vod-guard/security/advisories/new>

Do not open a public issue with exploit details.
