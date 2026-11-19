# Development

## Requirements

- Node.js 22+ (24 recommended)
- FFmpeg + ffprobe
- [Streamlink](https://streamlink.github.io/) 8+
- [yt-dlp](https://github.com/yt-dlp/yt-dlp) (current)
- Docker + Compose for integration tests

The Docker image pins known-good versions; use it for reproducible tests:

```bash
docker compose build
docker compose run --rm --entrypoint node stream-vod-guard --test test/unit.test.js
```

## Project layout

```
src/
  index.js        startup, channel resolution, HTTP server, signals
  config.js       environment config + path mapping
  settings.js     persisted UI settings, destination validation
  monitor.js      monitors, sessions, watchdog, finalize queue, VOD audit
  recorder.js     streamlink/yt-dlp child processes, parts, restarts
  postprocess.js  concat, probe, silences, mute audit, archive
  twitch.js       public GraphQL
  youtube.js      /live, RSS, channel resolution, yt-dlp metadata
  api.js          dashboard REST API + file range downloads
  store.js        atomic JSON state
  cli.js          CLI commands
web/              dashboard (vanilla HTML/CSS/JS, no build step)
test/             unit, audit, e2e, integration, real YouTube smoke
docs/             documentation
scripts/          storage check, capture demo, storage archive test
```

## Tests

```bash
# Unit (no external tools)
node --test test/unit.test.js

# Audit logic (needs ffmpeg)
E2E=1 node --test test/audit.test.js

# Synthetic HLS capture + SIGKILL + restart + finalize (needs ffmpeg/streamlink)
E2E=1 node --test test/e2e.test.js

# Full Archiver flow + destination metadata (needs ffmpeg/streamlink)
E2E=1 node --test test/integration.test.js

# Optional: real YouTube live smoke (needs a live URL)
YOUTUBE_SMOKE=1 YOUTUBE_SMOKE_URL='https://www.youtube.com/watch?v=...' \
  node --test test/youtube-smoke.test.js
```

The CI workflow runs unit tests and the Docker-based integration suite.

## Coding conventions

- ES modules, Node built-ins only; no runtime npm dependencies.
- Prefer small pure helpers in `util.js` for testability.
- Never block the event loop; FFmpeg/yt-dlp/streamlink are child processes.
- All new user-facing strings in English; Spanish belongs in `README.es.md` and the case study translation.
- Validate every path received from the API against `VIDEOS_ROOT`.
- Keep recordings safe: never delete local files before a verified destination copy.

## Adding a new platform

1. Add a monitor that returns `{live, streamId/videoId, title, startedAt}`.
2. Add a recorder branch in `CaptureController.buildCommand`.
3. Add part normalization in `postprocess.js` if the output is not MKV/TS.
4. Add platform-specific audit in `finalizeSession` (optional).
5. Extend the session ID scheme and tests.

## Release process

1. Update `CHANGELOG.md` and `package.json` version.
2. Commit and tag:
   ```bash
   git tag v1.0.0
   git push origin v1.0.0
   ```
3. The release workflow builds a multi-arch image and publishes to GHCR:
   `ghcr.io/antoniojveram/stream-vod-guard:1.0.0`.
4. Create the GitHub release with the generated notes.

## Debugging

- Logs: `data/logs/` and `docker compose logs`.
- Per-session capture log: `data/work/<session>/capture.log`.
- State: `data/state.json`; settings: `data/settings.json`.
- Raw parts: `data/work/<session>/raw/`.
- Use `node src/cli.js probe <file>` to inspect a final file.
