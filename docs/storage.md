# Storage optimization

1080p60 is expensive to archive: Twitch's source is around **5.8 Mbps**, which is
**~3.2 GB per hour** and **~32 GB for a 10-hour stream**. Recording both Twitch
and YouTube doubles that. Stream VOD Guard offers two optional mechanisms that
reduce the archive without touching the live capture quality:

1. **HEVC compression after the stream ends**, using the GPU when available.
2. **Automatic pruning of the YouTube backup** once a verified Twitch copy
   covers it.

Both are configured from **⚙ Settings → Storage** and apply at runtime.

## HEVC compression

When a recording is finalized and archived:

1. The compressor probes the final MKV and skips it if it is already HEVC/AV1.
2. It encodes a temporary HEVC copy in the same folder, copying the audio and
   subtitle streams without re-encoding them.
3. It probes the temporary file, decodes a 10-second sample, and checks that the
   duration and audio track survived.
4. The original is replaced **only** when the new file is at least
   `COMPRESS_MIN_SAVINGS` percent smaller.
5. `metadata.json` and the dashboard are updated with the new codec, size,
   bitrate, SHA-256 and savings.

If anything fails, the temporary file is deleted and the original remains
untouched. The dashboard shows a `HEVC −NN%` badge when it succeeds.

### Quality levels

| `COMPRESS_QUALITY` | QP | Intended use |
| --- | --- | --- |
| `high` | 21 | Near-transparent; keeps fine detail and motion |
| `balanced` | 24 | Recommended default; good quality/size balance |
| `small` | 27 | Maximum savings; visible on high-motion gameplay |

These are constant-quantizer (CQP) values for VAAPI and CRF for x265.

### Measured results

On the Intel N100 host used for development, with the iGPU VAAPI encoder:

| Source | Duration | Quality | Before | After | Saved | Encode time |
| --- | --- | --- | --- | --- | --- | --- |
| 1280×720 @ 60 fps, synthetic motion | 6 s | high (QP 21) | 12.0 MB | 7.0 MB | **41.5%** | 3 s |
| 1920×1080 @ 60 fps, static/animated UI | 30 s | high (QP 22) | 31 MB | 7 MB | **77%** | 16 s |
| 1920×1080 @ 60 fps, static/animated UI | 30 s | balanced (QP 24) | 31 MB | 5 MB | **84%** | 16 s |

Static scenes compress much better than gameplay. For real 1080p60 gameplay,
expect roughly **40–60% savings** at `high`/`balanced`. A 10-hour stream that
was 32 GB typically lands around **13–19 GB**, and encoding takes about **4–6
hours** on the N100 iGPU (faster than real time).

### Hardware encoding (recommended)

The image includes the Intel and Mesa VAAPI drivers. Pass the render node to the
container with the optional override:

```bash
# Find the host render GID (usually 992)
getent group render

# In .env
RENDER_GID=992

docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up -d
```

The app probes the encoder at startup with a one-frame encode and logs one of:

- `vaapi` / `hevc_vaapi`: hardware encoding ready.
- `x265` / `libx265`: portable software encoding, **much** slower.
- `none`: no compatible encoder found; compression is skipped.

### Encoder modes

| `COMPRESS_ENCODER` | Behaviour |
| --- | --- |
| `auto` (default) | Tries VAAPI, then x265. If neither works, compression is skipped and files stay H.264. |
| `vaapi` | Requires Intel/AMD VAAPI. If the device/driver is unavailable, compression is skipped; nothing is deleted. |
| `x265` | Forces the software encoder. Works on amd64 and arm64, but is slow. |
| `none` | Disables compression. |

The encoder can be changed from **Settings → Storage** without editing `.env`.
Saving re-probes the machine and queues recent recordings if compression becomes
available.

### Compatibility matrix

| Host | Encoder | Result |
| --- | --- | --- |
| Intel iGPU (N100, NUC, etc.) with `/dev/dri` | `hevc_vaapi` | Hardware; fast |
| AMD iGPU with `/dev/dri` | `hevc_vaapi` | Hardware; fast |
| NVIDIA GPU | `x265` | CPU; NVENC is not wired up yet. Use the CPU fallback |
| CPU-only server / NAS | `x265` | CPU; works, slow |
| Raspberry Pi / arm64 | `x265` | CPU; works, slow |
| Docker Desktop (macOS/Windows) | `x265` | CPU; no `/dev/dri` passthrough |
| No usable encoder | `none` | **Compression is skipped; the H.264 original is kept** |

The image is published for `linux/amd64` **and** `linux/arm64`; the Intel driver
is only installed on amd64. The `docker-compose.vaapi.yml` override is optional:
without it the container starts normally and uses x265.

### What "skipped" means

If no encoder is available, Stream VOD Guard does **not** mark the recording as
failed and does **not** touch the file. The dashboard shows that compression is
unavailable, and the original H.264 remains playable and downloadable. If an
encoder is attached later (or `COMPRESS_ENCODER=auto`/`x265` is selected), saving
the settings re-probes and can queue the recent recordings again.

### x265 performance

On a 4-core N100, x265 `preset fast` encodes 1080p60 at roughly **0.25× real
time**: a 10-hour stream can take 30–40 hours. It still works, but keep the
machine on and expect the queue to be busy. Hardware VAAPI is ~6× faster.

### HEVC compatibility

HEVC is supported by most modern TVs, phones, Apple TV, Chromecast, Plex and
Jellyfin clients. Browsers and older devices may need transcoding. If maximum
compatibility matters more than disk space, leave compression disabled and keep
the original H.264 files.

## YouTube backup retention

`BACKUP_RETENTION_DAYS=7` deletes the YouTube copy **7 days after the stream**
when all of these are true:

- the YouTube session is `done`;
- a Twitch session is also `done` and its file exists;
- the Twitch recording covers at least **95%** of the YouTube recording's
  duration;
- the YouTube copy is older than the retention period.

The Twitch file is never deleted by this policy. If Twitch's copy is missing or
shorter, the YouTube backup is kept. Sessions whose backup was pruned remain in
the history with a `Backup pruned` note, and the event log records the freed
bytes.

Set it to `0` to keep both platforms forever.

### Why skip compression for a backup that will be pruned?

If the YouTube copy is going to be deleted in a few days, compressing it first
would waste hours of CPU. The optimizer detects the Twitch cover and skips it.
A YouTube-only recording (Twitch disabled or failed) is treated as primary and
is compressed normally.

## Interactive use

- **Settings → Storage** toggles compression, selects the quality and sets the
  backup retention.
- Each finished recording shows a **Compress to HEVC** button in its detail
  dialog. This works even if automatic compression is disabled and retries a
  failed job.
- The activity log records `compression-queued`, `compression-started`,
  `compression-done`, `compression-failed`, `compression-skipped` and
  `backup-pruned` events.
- `GET /api/storage` reports the detected encoder, queue length and active job.
- `POST /api/storage/prune` runs the retention check on demand
  (`?dryRun=1` only lists candidates).

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `COMPRESS_ENABLED` | `false` | Compress finished recordings |
| `COMPRESS_QUALITY` | `balanced` | `high`, `balanced` or `small` |
| `COMPRESS_ENCODER` | `auto` | `auto`, `vaapi`, `x265` or `none`; editable in the dashboard |
| `COMPRESS_MIN_SAVINGS` | `10` | Skip if the saving is below this percentage |
| `COMPRESS_BACKFILL_DAYS` | `0` | On startup, queue recordings from the last N days |
| `BACKUP_RETENTION_DAYS` | `0` | Delete the YouTube backup after N days; 0 = keep |
| `VAAPI_DEVICE` | `/dev/dri/renderD128` | Render node used for VAAPI |
| `RENDER_GID` | `992` | Host render group for the Compose override |

`COMPRESS_BACKFILL_DAYS` is useful after enabling the feature on an existing
installation: set it to `2` or `7`, restart once, and recent recordings are
queued automatically. Jobs run one at a time and are persisted in
`data/state.json`, so a restart resumes them.

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `encoder: none` and `VAAPI render node present but the encoder failed` | The render node is passed but the driver cannot encode this size/codec. Check `docker compose -f docker-compose.yml -f docker-compose.vaapi.yml up -d` and `RENDER_GID`. |
| Compression uses x265 and takes forever | VAAPI is not available. Mount `/dev/dri` with the override or set `COMPRESS_ENCODER=vaapi` to diagnose. |
| `not enough destination space` | The compressor needs room for the original plus the temporary HEVC file. Free space or lower `COMPRESS_BACKFILL_DAYS`. |
| `only N% smaller (minimum 10%)` | The source is already efficient or mostly static. The original is kept. Lower `COMPRESS_MIN_SAVINGS` to force it. |
| The file plays on the PC but not on the TV | The device lacks HEVC support. Keep the original or transcode on the media server. |
| The YouTube backup disappeared | Expected after `BACKUP_RETENTION_DAYS`; the Twitch copy remains. Check the event log for `backup-pruned`. |
