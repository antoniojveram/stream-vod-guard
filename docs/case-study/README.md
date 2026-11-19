# Case study

Real data from the stream that motivated Stream VOD Guard.

- [gta-vi.md](gta-vi.md) — English case study.
- [gta-vi.es.md](gta-vi.es.md) — original Spanish investigation.

## Raw evidence

| File | What it shows |
| --- | --- |
| `twitch-mutes.json` | Twitch returned 12 muted segments of 180 s for VOD `2932866051` (36 min, 11.51%) |
| `twitch-silencedetect.txt` | `ffmpeg silencedetect` on the VOD audio: exact 180 s (or 360 s when two blocks are adjacent) digital-silence ranges |
| `twitch-vod-audit.txt` | `volumedetect` samples: muted segments at −91 dB, control at −31.1 dB |
| `youtube-vod.json` | The YouTube archive metadata (`was_live`, 14 940 s, public at analysis time) |

Reproduce:

```bash
docker compose run --rm stream-vod-guard node src/cli.js mutes 2932866051
docker compose run --rm stream-vod-guard node src/cli.js audit-vod 2932866051 --samples
```

> The VOD may no longer be available. These files are a snapshot of the analysis.
