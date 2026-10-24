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

Install the [Buffer CLI](https://buffer.com) and `jq`. This repo posts as the
lofi.md account while other projects on this machine keep using
`~/.config/buffer`. The CLI resolves flag → env → repo `.buffer/config.json` →
global, but only stores the API key globally. So:

- the key lives in `.env` as `BUFFER_API_KEY`. Every script here loads `.env`
  before calling `buffer`, and the env var beats the global key;
- the organization and timezone live in `.buffer/config.json` (gitignored).

To run `buffer` by hand in this folder as the lofi.md account, load `.env` first
(`set -a; . ./.env; set +a`). Without it, `buffer` uses the global account.

1. In Buffer, logged in as the lofi.md account: **Settings → API**, create a key.
2. In `.env`, set `BUFFER_API_KEY` (and `BUFFER_TIMEZONE`, default
   `America/Sao_Paulo`).
3. `pnpm buffer:setup` lists the organizations for that key. Copy the lofi.md one
   into `BUFFER_ORGANIZATION_ID`, then run `pnpm buffer:setup` again. It writes
   the organization and timezone to `.buffer/config.json`, then fills
   `BUFFER_YOUTUBE_CHANNEL_ID`, `BUFFER_TIKTOK_CHANNEL_ID` and
   `BUFFER_INSTAGRAM_CHANNEL_ID` in `.env` from `buffer channels list`. It only
   rewrites those lines. If a network has several channels, it lists them and
   leaves that one for you to set.

The setup script prints where each setting comes from, never its value.

### Hosting the video

Buffer's API takes videos as public HTTPS URLs and the CLI has no upload command,
so upload the `.mp4` somewhere public first and pass the URL. The script rejects
local paths rather than failing halfway through. The scheduler (below) uploads to
R2 for you.

### Options

| Flag                  | Effect                                              |
| --------------------- | --------------------------------------------------- |
| `--video <url>`       | Public HTTPS URL to the `.mp4` (required)           |
| `--description <text>` | Source text for all three captions (required)      |
| `--title <text>`      | Override the derived YouTube title                  |
| `--only <list>`       | Subset, e.g. `--only tiktok,instagram`              |
| `--draft`             | Save as drafts; nothing publishes                   |
| `--dry-run`           | Validate payloads, make no API calls                |
| `--due-at <iso>`      | Publish at this time instead of the next queue slot |
| `--report json`       | One JSON line per created post on stdout            |
| `--latest`            | Schedule the next batch (see the scheduler below)   |
| `--batch <id>`        | Schedule this batch instead                         |
| `--limit <n>`         | Videos to fill an empty batch with (default 10)     |
| `--folder <name>`     | Fill an empty batch from this recordings folder     |

`<br>` in a description becomes a line break.

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

Without `--due-at`, posts go in with `addToQueue`, so Buffer places each one in
that channel's next configured slot: the power hours set up per channel. The
three schedules have different empty days (TikTok has no wed/thu, YouTube no
mon/wed), so queued posts can land on different days.

With `--due-at` (which the scheduler always passes), every network gets
`customScheduled` at that exact time.

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

## The scheduler: batches of 10, one post a day

Renders start out on local disk, in `RECORDINGS_DIR` (default
`/home/luiz/oss/lofi-radio/recordings`): new ones at the root, archived ones in
`backup/<YYYY-MM-DD[THH-MM-SS]>/`. A **batch** is up to 10 of them, posted one a
day from its start date at `postTime` (18:00 by default, in the Buffer
timezone). Batches follow each other in 10-day windows. 10 matches the Buffer
plan's queue limit.

There are two ways to drive it, and both read and write the same files.

### In the browser

```bash
pnpm dev     # then open http://localhost:5173/posts.html
```

- **Videos** (left): every render, grouped by folder. The newest folder dated
  today or earlier is opened by default. Each one is matched to `/api/tracks` on
  the radio API for title, artist and cover art.
- **Batches**: the next one is pinned on top as *Next up*. Drag videos from the
  list into a batch, between days, between batches, or back to the list to
  remove them. *+ Add batch* opens the next 10-day window, and *Starts* moves one.
- Click a video for its details: preview, title and artist overrides (for files
  without a radio match), the custom text, the caption, and *Preview payloads*,
  which runs `post-video.sh --dry-run` for the exact payloads.
- **Handles**: every artist on the radio and their Instagram handles. Artists in
  upcoming batches without a handle are flagged.
- **Save** (or ⌘S / Ctrl+S) writes the files. A save fails if a run or the
  terminal changed them since the page loaded.
- **Dry run**, **Save as drafts** and **Schedule** run the scheduler and stream
  its output: progress per video, the full CLI log, and links to the video on
  the CDN and the Buffer channel.

The page only exists in `pnpm dev`. `pnpm build` ships just the radio.

### In the terminal

```bash
pnpm schedule -- videos                  # renders, matched to radio tracks
pnpm schedule -- batches                 # every batch, its days and status
pnpm schedule -- new-batch [--start 2026-11-03]
pnpm schedule -- add <file…> [--batch <id>]
pnpm schedule -- move <file> --batch <id> [--index 3]
pnpm schedule -- extra <file> "great beat, smoother bassline"
pnpm schedule -- handle "jinsang" @jinsangbeats
pnpm schedule -- theme-before light      # theme of the post before the first batch
pnpm schedule -- run next --dry-run      # validate the next batch
pnpm schedule -- run next                # upload and schedule it
pnpm post -- --latest                    # same as `run next`
```

Files are relative to the recordings folder, as `videos` prints them. If `run`
finds the next batch empty, it fills it with the next 10 unused videos from the
newest folder (`--folder` and `--limit` change that).

### Light and dark alternate

Renders are named `<slug>-<uuid>-<theme>-1080x1920.mp4`, where the theme is
`light` or `dark`. `default`, or no theme at all (older renders), counts as light.
Posts always alternate between the two, across batches too. The last post before
this rule was light, so the sequence starts with dark. `settings.themeBefore` in
`schedule.json` records that ("Post before" in the page,
`pnpm schedule -- theme-before light|dark` in the terminal).

- The page shows each video's theme as a dot (filled for light, ringed for dark),
  shows the theme every empty day needs, and flags a video that breaks the
  sequence with "needs dark" or "needs light".
- You can still drag freely and save, because a reorder breaks the sequence until
  it's done. But *Save as drafts* and *Schedule* stay off, and `run` refuses
  (`--dry-run` only warns), while anything up to and including that batch is out
  of sequence.
- `run` filling an empty batch picks the theme each day needs. It stops early
  rather than put two of a kind in a row.

### What a run does

For each video in the batch:

1. **Upload to R2** with `wrangler r2 object put` into
   `album-covers/lofi.md/<folder>/<file>`, served at `https://cdn.cieslak.dev/…`.
   Renders still at the recordings root go under the upload day. If the CDN
   already has the file, the upload is skipped. Wrangler uses the
   `npx wrangler login` session, or `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID` from `.env`.
2. **Caption** it as `{title} by {artist} {@handles}<br><br><br>{custom text}`.
3. **Call `post-video.sh`** with `--due-at` for that day, then record each post id
   in `schedule.json`.

It saves after every video and keeps going past a failure, leaving the batch
*partial*. A re-run only posts the networks that have no post id yet, so it
never duplicates one. It refuses to start if any post would be due in the past.
Only one run can happen at a time, across the terminal and the browser.

### The files

- [`schedule.json`](schedule.json): settings and batches. Each item has its file,
  custom text, overrides, R2 key and URL, Buffer post ids, and last error.
  Status (*draft*, *partial*, *scheduled*) is derived from the post ids.
  The first batch came from the old `posted-videos.json`, queued with
  `addToQueue` before post ids were recorded.
- [`instagram-handles.json`](instagram-handles.json): lowercase artist → handles.
  Credits like `dEnk, Drumtomski` are split, and each artist's handles are added.

### Failure runbook

If an automated or manual scheduling run fails, follow
[`SCHEDULE-RUNBOOK.md`](SCHEDULE-RUNBOOK.md). Treat Buffer as the source of
truth before retrying a partial run.
