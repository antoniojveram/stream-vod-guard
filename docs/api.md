# HTTP API

The dashboard and API are served by the same Node process. Default base URL: `http://127.0.0.1:8787`.

If `DASHBOARD_TOKEN` is set, every API and file request requires:

```
Authorization: Bearer <token>
```

or `?token=<token>`.

## Health

`GET /healthz` — no auth required (used by the container healthcheck).

```json
{
  "ok": true,
  "problems": [],
  "uptimeSeconds": 123,
  "localFreeGb": 120.4,
  "archiveFreeGb": 900.1,
  "active": 0,
  "monitors": { "twitch": "offline", "youtube": "offline" }
}
```

Returns `503` when a monitor is stale, local disk is critical, or destination space is below the minimum.

## Status

`GET /api/status`

Returns monitors, disk, stats, active sessions, recent sessions, events, public config and paths.

## Sessions

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/api/sessions?limit=50` | Session list |
| `GET` | `/api/sessions/:id` | Full session, parts, audit and silences |
| `POST` | `/api/sessions/:id/finalize` | Stop capture and finalize now |
| `POST` | `/api/sessions/:id/reaudit` | Schedule another Twitch VOD mute audit |

## Settings

`GET /api/settings`

```json
{
  "appName": "Stream VOD Guard",
  "appMark": "SV",
  "filenameTemplate": "{channel} - {date} - {title} [{platform}-{id}]",
  "twitch": { "enabled": true, "channel": "example", "resolved": "example" },
  "youtube": { "enabled": true, "channel": "@example", "label": "Example", "resolved": "UC..." },
  "destination": {
    "dir": "/videos/recordings",
    "display": "./videos/recordings",
    "root": "/videos",
    "hostRoot": "./videos"
  },
  "activeSessions": 0
}
```

`POST /api/settings` with the same shape (only the writable fields) applies changes at runtime and persists them to `data/settings.json`:

```json
{
  "appName": "My Guard",
  "appMark": "MG",
  "filenameTemplate": "{date} - {channel} - {title}",
  "twitch": { "enabled": true, "channel": "example" },
  "youtube": { "enabled": false, "channel": "" },
  "destination": { "dir": "/videos/example" }
}
```

- Destination must be inside `VIDEOS_ROOT`.
- Enabling a platform with an empty channel returns `400`.
- Changing a channel finalizes active sessions for that platform.
- Changing the destination affects new sessions only.

## Folder browser

`GET /api/folders?path=/videos`

```json
{
  "path": "/videos",
  "displayPath": "./videos",
  "parent": null,
  "root": "/videos",
  "hostRoot": "./videos",
  "dirs": [
    { "name": "recordings", "path": "/videos/recordings", "displayPath": "videos/recordings" }
  ]
}
```

`POST /api/folders`

```json
{ "path": "/videos/new-folder" }
```

Creates the folder recursively. Both endpoints reject paths outside `VIDEOS_ROOT`.

## Events

`GET /api/events?limit=100` returns the recent activity log.

## Files

`GET /files/<path>` streams a file under the videos root. Supports `Range` and `HEAD`; add `?download=1` for `Content-Disposition: attachment`.

## Errors

Errors return JSON:

```json
{ "error": "Destination folder must be inside /videos" }
```

Status codes: `400` validation, `401` token, `404` missing, `500` unexpected.
