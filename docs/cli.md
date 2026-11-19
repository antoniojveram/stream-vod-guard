# CLI reference

The CLI runs inside the same image as the service, so all tools (ffmpeg, yt-dlp, streamlink) are available.

```bash
docker compose run --rm stream-vod-guard node src/cli.js <command> [options]
```

## `status`

Shows the current live state of the configured Twitch and YouTube channels.

```bash
node src/cli.js status
```

## `vods`

Lists the latest Twitch VODs for the configured channel.

```bash
node src/cli.js vods
```

## `mutes <vodId>`

Fetches Twitch's public muted-segment metadata for a VOD.

```bash
node src/cli.js mutes 2932866051
```

Output includes the segment offsets, durations, total muted time and percentage.

## `audit-vod <vodId>`

Prints a table of muted segments. With `--samples`, downloads the VOD audio and measures muted segments against an unmuted control.

```bash
node src/cli.js audit-vod <vodId>
node src/cli.js audit-vod <vodId> --samples
node src/cli.js audit-vod <vodId> --samples --file /path/to/audio.m4a
```

`--samples` downloads roughly the audio track size (hundreds of MB for a long stream). Use `--file` to reuse a downloaded audio file.

## `probe <file>`

Runs `ffprobe` and a long-silence scan on a local file.

```bash
node src/cli.js probe /videos/recordings/example.mkv
```

## `record <platform> <channel>`

One-off live capture without running the 24/7 service.

```bash
node src/cli.js record twitch <channel> --output /videos/recordings --duration 60
node src/cli.js record youtube <id|@handle|url> --output /videos/recordings --duration 60
node src/cli.js record twitch <channel> --output /videos/recordings --duration 0
```

| Option | Description |
| --- | --- |
| `--duration <seconds>` | Recording length; `0` means until the stream ends (max 12 h) |
| `--output <dir>` | Destination folder (default `./downloads`) |
| `--from-start` | YouTube: recover from the beginning of the DVR |
| `--height <px>` | YouTube: maximum height |
| `--quality <name>` | Twitch: streamlink quality (`best` is safest) |
| `--checksum` | Compute SHA-256 of the final file |
| `--keep-raw` | Keep temporary parts and print their folder |

The command validates that the channel is live, records, finalizes and copies the MKV to `--output`. It prints a JSON summary with the final path, duration and size.

## Exit codes

- `0` success
- `1` error (not live, invalid channel, finalize failure)
- `130` interrupted with Ctrl+C
