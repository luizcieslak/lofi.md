# scripts

Social-media posting and livestreaming for lofi.md.

## Livestreaming to YouTube

Two ways to stream, both cheap enough for an M1 with 8GB. Both encode with Apple's
hardware H.264 encoder, so the CPU barely notices.

| | OBS + Browser Source | `livestream.sh` (ffmpeg) |
| --- | --- | --- |
| Looks like | Exactly the site: cover art, wall tilt, fades | Backdrop loop + the site's own now-playing card (no fades) |
| Cost | OBS + a Chromium helper, ~0.6–1GB RAM | ~200MB RAM, ~20% of one core; a brief Chrome render per track |
| Runs | GUI app | Terminal, unattended, can move to a server |

### One-time YouTube setup

1. YouTube Studio → **Create → Go live**. The first time, YouTube asks you to verify
   the channel (phone), and live streaming can take **up to 24h** to unlock.
2. Pick **Stream** (not Webcam), set the title, description, privacy (start with
   **Unlisted**), category and thumbnail, and copy the **stream key**.

Title, description, privacy, thumbnail, chat and so on all live on YouTube's
side. Edit them in Studio at any time, even mid-stream. The encoder (OBS or
ffmpeg) only sends audio and video to the stream key.

### Option A: OBS

1. `brew install --cask obs`
2. **Settings → Video**: base and output 1920×1080, 30 fps.
3. **Settings → Output** (Advanced): encoder *Apple VT H264 Hardware Encoder*,
   rate control CBR, 4500 kbps, keyframe interval 2s. Audio: 160 kbps.
4. **Settings → Stream**: service YouTube, paste the stream key.
5. **Sources → + → Browser**: URL `https://<your deploy>/?stream` (or
   `http://localhost:5173/?stream` with `pnpm dev` running), 1920×1080, FPS 30.
   Check **Control audio via OBS**. Uncheck *Shutdown source when not visible*.
6. **Start Streaming**.

`?stream` hides the play button, footer and cursor, so the frame is only the
art and the now-playing block. OBS's browser allows autoplay, so the radio starts
on its own.

### Option B: `livestream.sh`

Put the stream key for the platform in `.env` (gitignored):

```
YOUTUBE_STREAM_KEY=xxxx-xxxx-xxxx-xxxx-xxxx
TWITCH_STREAM_KEY=live_xxxxxxxx
KICK_STREAM_URL=rtmps://xxxx.global-contribute.live-video.net:443/app/
KICK_STREAM_KEY=sk_xxxxxxxx
```

```bash
pnpm stream -- --output test.flv --duration 60   # record locally first
pnpm stream                                      # go live on YouTube
pnpm stream -- --platform twitch                 # …or Twitch
pnpm stream -- --platform kick                   # …or Kick
caffeinate -dimsu pnpm stream                    # go live, keep the Mac awake
```

Twitch and Kick have no 24h wait, so use them to test while YouTube unlocks.
For a private dry run on Twitch, set the key to `live_xxxxxxxx?bandwidthtest=true`.
Twitch accepts the stream and shows its health in Stream Manager, but the
channel never goes live.

It loops `public/lofimd.mp4`, pulls the radio audio from `VITE_RADIO_API_URL`, and
checks `/now-playing` every 3s. When the track changes, headless Chrome screenshots
[`stream-meta.html`](stream-meta.html), which is the site's `#meta` card styled by
`src/style.css` itself, to a transparent PNG that ffmpeg overlays. A new title shows
up 0–5s after the song changes. Without Google Chrome it falls back to plain ffmpeg
text. It registers as one listener
(heartbeat every 60s, `end` on exit), like a browser tab. When live, it restarts
ffmpeg if it dies.

| Flag                   | Effect                                            |
| ---------------------- | ------------------------------------------------- |
| `--platform <name>`    | `youtube` (default), `twitch` or `kick`           |
| `--output <file>`      | Record locally instead of going live              |
| `--duration <seconds>` | Stop after this long                              |
| `--no-text`            | No now-playing card                               |
| `--dry-run`            | Print the ffmpeg command (key redacted) and exit  |

Bitrate, card scale (`CARD_SCALE`, default 2x) and placement live in the tunables
block at the top of the script.

### Things to know

- **Music rights.** Every track on the radio must be cleared for YouTube, or
  Content ID can mute the stream or strike the channel.
- **Sleep.** A sleeping Mac ends the stream. Use `caffeinate` and keep it plugged in.
- **Upload.** 4.5 Mbps video plus 160 kbps audio needs about 6 Mbps of steady upload.

## post-video.sh

Queues one video to Instagram Reels, TikTok and YouTube Shorts in a single run,
deriving each network's copy from one description.

```bash
pnpm post -- \
  --video https://your-host.example/clip.mp4 \
  --description "Rainy night study session. Nothing but the art and the stream."
```

### Setup

Install the [Buffer CLI](https://buffer.com) and `jq`, then authenticate once:

```bash
buffer init
```

That stores your API key in `~/.config/buffer/config.json` — outside this repo.
The script never reads or embeds it.

Then put your channel IDs in `.env` (gitignored, never committed):

```bash
buffer channels list --fields id,name,service --output json
```

Copy each `id` into the matching variable in `.env`:

```
BUFFER_ORGANIZATION_ID=
BUFFER_YOUTUBE_CHANNEL_ID=
BUFFER_TIKTOK_CHANNEL_ID=
BUFFER_INSTAGRAM_CHANNEL_ID=
```

### Hosting the video

Buffer's API takes videos as public HTTPS URLs and the CLI has no upload command,
so upload the `.mp4` somewhere public first and pass the URL. The script rejects
local paths rather than failing halfway through.

### Options

| Flag                  | Effect                                              |
| --------------------- | --------------------------------------------------- |
| `--video <url>`       | Public HTTPS URL to the `.mp4` (required)           |
| `--description <text>` | Source text for all three captions (required)      |
| `--title <text>`      | Override the derived YouTube title                  |
| `--only <list>`       | Subset, e.g. `--only tiktok,instagram`              |
| `--draft`             | Save as drafts; nothing publishes                   |
| `--dry-run`           | Validate payloads, make no API calls                |

### What gets derived

From one `--description`:

- **YouTube** — title is the first line, capped at 100 chars; description plus
  hashtags as the body. Category `Music`, public.
- **Instagram** — description plus hashtags, posted as a Reel shared to feed.
  Uses its own shorter tag set (`INSTAGRAM_HASHTAGS_BASE`) and is capped at
  **5 hashtags** (Buffer's limit for Reels) — the first 5 are kept in order and
  the rest dropped.
- **TikTok** — description plus hashtags, capped at 2200 chars.

If the description already ends with hashtags, they're moved into the tag block
and merged with the defaults — first-seen order wins, duplicates are dropped
case-insensitively, and a hashtag mid-sentence stays where it is.

Both hashtag sets (`HASHTAGS` for YouTube and TikTok, `INSTAGRAM_HASHTAGS_BASE`
for Instagram), the category, and the Instagram tag limit live in a tunables
block at the top of the script.

### Scheduling

Posts go in with `addToQueue`, so Buffer places each one in that channel's next
configured slot — the power hours already set up per channel.

Because the three schedules have different empty days (TikTok has no wed/thu,
YouTube no mon/wed), the posts often land on different **days**, not just
different hours. A Wednesday run might queue Instagram for Wed evening but TikTok
for Friday. That's queue mode working as intended — to tighten it, fill the gaps
in the Buffer posting schedules rather than changing the script.

### If a post fails

The script validates all payloads before posting anything, then posts serially.
If one channel fails partway through, it reports which ones landed and stops —
it never retries automatically, because `posts create` is not idempotent and a
retry would duplicate a post. Re-run the rest with `--only`.

### Checking what's queued

```bash
buffer posts list --organization-id "$BUFFER_ORGANIZATION_ID" \
  --fields 'items.{id,status,dueAt,channel.name}' --output json

buffer posts delete --id <id>   # remove one
```
