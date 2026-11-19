# Case study: GTA VI, IlloJuan and 36 minutes of silence

This is the real case that motivated Stream VOD Guard. It shows why downloading a VOD is not enough and why the tool captures the live feed instead.

**Date:** 19 November 2026
**Channels:** `twitch.tv/illojuan` · YouTube `UCKvoBRFqMNqvuSvFBiNadgw`
**Game:** Grand Theft Auto VI

> Español: [gta-vi.es.md](gta-vi.es.md)

## Observed data

| Item | Value |
| --- | --- |
| Twitch VOD | `2932866051` — “Yo estuve aquí ❤️ - Grand Theft Auto VI #1” |
| Broadcast start | 2026-11-18 23:15:54 UTC |
| VOD duration | 18 760 s = **5 h 12 min 40 s** |
| Muted segments | **12 × 180 s = 2 160 s = 36 min** |
| Muted percentage | **11.51 %** |
| Pattern | Every segment is a **3-minute block** |
| Previous VOD (`2932595314`, “Eliminar”) | 15 180 s, **0 muted segments** |
| YouTube archive at the time | `zdFy-O_wUTU`, `was_live`, 14 940 s (4 h 09 min), public |

Muted offsets returned by Twitch (seconds from the VOD start):

```
 5220 (1:27:00)   8100 (2:15:00)   10620 (2:57:00)   14400 (4:00:00)
14760 (4:06:00)  15480 (4:18:00)   15660 (4:21:00)   16920 (4:42:00)
17100 (4:45:00)  17820 (4:57:00)   18180 (5:03:00)   18360 (5:06:00)
```

## The audio is really gone

Downloading the VOD's audio and running `ffmpeg silencedetect` returns exact digital silence at those offsets:

```
silence_start: 5220.05
silence_end: 5400.04 | silence_duration: 179.999
silence_start: 8100.05
silence_end: 8280.05 | silence_duration: 179.996
...
```

Sampling with `volumedetect`:

| Sample | Offset | Mean | Peak | Result |
| --- | --- | --- | --- | --- |
| Muted segment #1 | 01:28:00 | −91 dB | −91 dB | digital silence |
| Control (unmuted) | 01:22:00 | −31.1 dB | −10.8 dB | normal audio |

Raw files:

- [twitch-mutes.json](twitch-mutes.json)
- [twitch-silencedetect.txt](twitch-silencedetect.txt)
- [twitch-vod-audit.txt](twitch-vod-audit.txt)
- [youtube-vod.json](youtube-vod.json)

The VOD contains no original audio in those 36 minutes. This is not a player issue or a volume setting; Twitch removed the audio.

## When does Twitch mute?

Twitch's official help says:

> “Twitch services scan VODs as a proactive way to help broadcasters avoid having videos containing unauthorized audio. If copyrighted audio is detected in a VOD, we automatically mute that portion of the VOD.”
>
> “**Will my live content be flagged or muted?** No, this appeals process is strictly for VOD content.”
>
> — [Twitch Help: How to Appeal Muted Audio](https://help.twitch.tv/s/article/how-to-appeal-flagged-content)

The scan runs on the **stored VOD after the broadcast**, not on the packets viewers receive live. Twitch does not publish an SLA for when the mutes appear. Stream VOD Guard records the observed delay (`secondsAfterStreamEnd`) for each future stream.

The exact **3-minute** granularity is visible in this VOD: Twitch silences the entire detection window, not just the song.

## What about YouTube?

YouTube's official help:

> “All live streams are scanned for matches to third-party content… When third-party content is identified, a placeholder image may replace your live stream… If the third-party content remains in your stream, your live stream will be temporarily interrupted or terminated.”
>
> “**Content ID claims are only made after you complete your live streams, if you decide to archive the video.**”
>
> — [YouTube Help: Copyright issues with live streams](https://support.google.com/youtube/answer/3367684)

So the live signal is complete; the archive may later be muted, blocked, monetized or deleted. In this case the creator deletes the YouTube VOD to avoid risking the channel.

## Why downloading VODs fails

| Strategy | Complete audio? | Reliable? | Why |
| --- | --- | --- | --- |
| Download Twitch VOD after | No | No | 36 minutes muted; VOD can be deleted or sub-only |
| Download YouTube VOD after | Sometimes | No | Claims/blocks; creator may delete it |
| Record Twitch live | Yes | Yes | Live feed is not muted; ad gaps possible |
| Record YouTube live | Yes | Yes | Claims apply to the archive, not the live feed |
| Record both live | Yes | **Yes** | Redundancy across ads, outages and platform policies |
| Clips/highlights | No | No | Fragments; music clips are removed |
| Ask the creator for the file | Yes | No | Not automatable |

## What Stream VOD Guard does

1. Detect the live on both platforms.
2. Record both feeds in parallel, in crash-resilient parts.
3. Merge into MKV, verify audio, copy to the chosen folder.
4. After Twitch scans the VOD, compare its muted segments with **our** recording.
5. Report `PASS`/`FAIL` per segment with volume measurements.

In this case a live recording would have preserved all 12 segments; the audit would show 12/12 with audio and a control around −31 dB.

## Sources

- Twitch Help — [How to Appeal Muted Audio](https://help.twitch.tv/s/article/how-to-appeal-flagged-content)
- Twitch Help — [DMCA & Copyright FAQs](https://help.twitch.tv/s/article/dmca-and-copyright-faqs)
- Twitch Help — [On-Demand Content on Twitch](https://help.twitch.tv/s/article/video-on-demand)
- Twitch Legal — [Music Guidelines](https://legal.twitch.com/en/legal/music)
- YouTube Help — [Copyright issues with live streams](https://support.google.com/youtube/answer/3367684)
- YouTube Help — [Content ID claims](https://support.google.com/youtube/answer/6013276)

## Legal note

Personal time-shifting of publicly available live streams. Do not redistribute recordings; music and third-party content remain subject to their rights holders' terms.
