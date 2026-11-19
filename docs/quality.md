# Quality guarantees

Stream VOD Guard captures the **best rendition each platform offers**, and never re-encodes the video. The final MKV is a remux (`-c copy`), so the selected video and audio streams are preserved bit-for-bit from the platform feed.

## Defaults

| Platform | Option | Default | Behaviour |
| --- | --- | --- | --- |
| Twitch | `TWITCH_QUALITY` | `best` | Streamlink picks the highest quality rendition (source, commonly 1080p60; higher if the broadcaster provides it) |
| YouTube | `YOUTUBE_MAX_HEIGHT` | `0` | `0` means no cap: `yt-dlp` selects the best video + best audio available (up to 4K/60 when offered) |

The YouTube selector is `bv*+ba/b` when `YOUTUBE_MAX_HEIGHT=0`, and `bv*[height<=N]+ba/b[height<=N]/b` when a cap is set. It prefers separate best video and best audio and merges them into MKV without re-encoding.

## Verification

The dashboard shows the **actual** resolution and FPS of every finished file (`Final duration`, `Resolution`). The same data is in `metadata.json` under `final.quality`.

Real checks performed on 2026-11-19:

| Platform | Source formats | Final file |
| --- | --- | --- |
| Twitch (`kaicenat`) | streamlink `best` | **1920×1080 @ 60 fps**, 11.0 MB for 12 s |
| YouTube (`@WWE`) | max available: 1920×1080 @ 30 fps (from `yt-dlp -F`) | **1920×1080 @ 30 fps** |

Reproduce with:

```bash
# One-off capture
docker compose run --rm stream-vod-guard \
  node src/cli.js record youtube @channel --output /videos/recordings --duration 15

# Inspect any final file
docker compose run --rm stream-vod-guard \
  node src/cli.js probe "/videos/recordings/example.mkv"
```

or open a recording in the dashboard and check **Resolution**.

## Caveats

- No tool can create quality the platform does not serve. If the streamer broadcasts at 1080p60, the archive is 1080p60.
- A deliberate lower cap (`YOUTUBE_MAX_HEIGHT=1080` or `720`) trades quality for disk space.
- Twitch ad filtering removes ad segments; it does not change the quality of the remaining content.
- Network drops are handled by the watchdog. On restart, the new part uses the same best-quality selection.
- The final MKV may be remuxed to a different container, but the codecs/bitrate are copied, not transcoded.
