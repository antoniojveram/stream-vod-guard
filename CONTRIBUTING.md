# Contributing

Thanks for improving Stream VOD Guard. This project is a small, dependency-light Node.js service; contributions are welcome.

## Before you start

- Search existing issues and pull requests.
- For a large feature, open an issue first so we can agree on the design.
- Never include real credentials, `.env` files, cookies, recordings or personal data in a PR.

## Development setup

```bash
git clone https://github.com/antoniojveram/stream-vod-guard.git
cd stream-vod-guard

cp .env.example .env
mkdir -p videos/recordings

docker compose build
docker compose run --rm --entrypoint node stream-vod-guard --test test/unit.test.js
```

To run the full suite:

```bash
docker compose run --rm -e E2E=1 --entrypoint node stream-vod-guard \
  --test test/audit.test.js test/e2e.test.js test/integration.test.js
```

## What to test

- `test/unit.test.js`: pure helpers, path validation, parsing.
- `test/audit.test.js`: mute audit PASS/FAIL.
- `test/e2e.test.js`: synthetic HLS, SIGKILL, watchdog restart, final MKV.
- `test/integration.test.js`: full Archiver flow and metadata.
- `test/youtube-smoke.test.js`: optional real YouTube live.

## Code style

- ES modules and Node built-ins; avoid adding runtime dependencies.
- Keep user-facing strings in English.
- Validate any path coming from HTTP against `VIDEOS_ROOT`.
- Never delete raw/local files before a verified destination copy.
- Keep the event loop free; spawn FFmpeg/Streamlink/yt-dlp as child processes.
- Use `node --check <file>` before committing.

## Pull requests

1. Fork the repository and create a branch:
   ```bash
   git checkout -b feat/my-feature
   ```
2. Keep the change focused and update docs/`CHANGELOG.md`.
3. Add or update tests.
4. Make sure CI is green.
5. Describe **what**, **why** and how you tested it.

## Commit messages

Use a short imperative subject, optionally with a conventional prefix:

```
feat: add per-session destination snapshot
fix: kill yt-dlp process group on restart
docs: explain YouTube handle resolution
```

## Security

Please report vulnerabilities privately; see [SECURITY.md](SECURITY.md). Do not open a public issue with exploit details.
