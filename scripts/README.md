# scripts

Social-media posting for lofi.md.

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
