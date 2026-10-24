#!/usr/bin/env bash
#
# Queue one video to Instagram Reels, TikTok and YouTube Shorts via the Buffer CLI.
#
# Each post goes in with mode=addToQueue, so Buffer drops it into that channel's
# next configured slot. Those slots are the power hours already set up in Buffer.
#
# Note: the three schedules have different empty days (TikTok has no wed/thu,
# YouTube no mon/wed), so the posts often land on different *days*, not just
# different hours. That's queue mode working as intended. To tighten it, fill the
# gaps in the Buffer posting schedules rather than changing this script.
#
# Videos must already be hosted at a public HTTPS URL — Buffer's API takes a URL,
# and the CLI has no upload command. See scripts/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# --- tunables ---------------------------------------------------------------

# TikTok and YouTube Shorts share the long set; Instagram gets its own, because
# Buffer keeps only the first 5 tags on a Reel and these are the 5 worth keeping.
HASHTAGS="#lofi #lowfi #chill #music #catjam #lofihiphop #studymusic #lofiradio #codingmusic"
INSTAGRAM_HASHTAGS_BASE="#lofi #lofihiphop #studymusic #lofiradio #codingmusic"

YOUTUBE_CATEGORY_ID="10" # Music
YOUTUBE_PRIVACY="public"
YOUTUBE_TITLE_MAX=100
TIKTOK_TEXT_MAX=2200

# Buffer caps Reels captions at 5 hashtags; extras are dropped, keeping the first 5.
INSTAGRAM_HASHTAG_MAX=5

# --latest: videos live in R2 under lofi.md/YYYY-MM-DDTHH-MM-SS/<kebab-title>.mp4.
R2_BUCKET="album-covers"
R2_PREFIX="lofi.md/"
R2_PUBLIC_URL="https://cdn.cieslak.dev"
BATCH_LIMIT=10

# Artist (lowercase) → Instagram handle(s). Reused across runs; add new artists here.
HANDLES_FILE="$SCRIPT_DIR/instagram-handles.json"
# Posting order and per-track extra text, keyed by the video's kebab-case name.
# Videos not listed here go after the queued ones, alphabetically.
QUEUE_FILE="$SCRIPT_DIR/post-queue.json"
# Videos already queued in Buffer, so the next --latest run picks the next batch.
POSTED_FILE="$SCRIPT_DIR/posted-videos.json"

# Three line breaks between the credit line and the extra text.
EXTRA_SEPARATOR="<br><br><br>"

# --- args -------------------------------------------------------------------

usage() {
	cat <<'EOF'
Usage: scripts/post-video.sh --video <url> --description <text> [options]
       scripts/post-video.sh --latest [--limit <n>] [--folder <name>] [options]

Single video:
  --video <url>          Public HTTPS URL to the .mp4
  --description <text>   One description; each network's copy is derived from it.
                         <br> becomes a line break.
  --title <text>         Override the derived YouTube title

Batch from R2:
  --latest               Queue the next videos from the newest lofi.md/<timestamp>/
                         folder in R2, captioned "{title} by {artist} {@handles}"
                         from the radio API and instagram-handles.json
  --limit <n>            How many videos to queue (default 10)
  --folder <name>        Use this folder instead of the newest one (implies --latest)

Options:
  --only <list>          Comma-separated subset: youtube,tiktok,instagram
  --draft                Save as drafts; nothing publishes
  --dry-run              Validate payloads, make no API calls
  -h, --help             Show this help

Requires BUFFER_* variables in .env — see scripts/README.md.
EOF
}

VIDEO_URL=""
DESCRIPTION=""
TITLE_OVERRIDE=""
ONLY="youtube,tiktok,instagram"
DRAFT=false
DRY_RUN=false
LATEST=false
FOLDER=""
LIMIT="$BATCH_LIMIT"

while [ $# -gt 0 ]; do
	case "$1" in
	--latest)
		LATEST=true
		shift
		;;
	--folder)
		FOLDER="${2:-}"
		LATEST=true
		shift 2
		;;
	--limit)
		LIMIT="${2:-}"
		shift 2
		;;
	--video)
		VIDEO_URL="${2:-}"
		shift 2
		;;
	--description)
		DESCRIPTION="${2:-}"
		shift 2
		;;
	--title)
		TITLE_OVERRIDE="${2:-}"
		shift 2
		;;
	--only)
		ONLY="${2:-}"
		shift 2
		;;
	--draft)
		DRAFT=true
		shift
		;;
	--dry-run)
		DRY_RUN=true
		shift
		;;
	-h | --help)
		usage
		exit 0
		;;
	*)
		echo "error: unknown argument: $1" >&2
		usage >&2
		exit 2
		;;
	esac
done

# Channel IDs are per-workspace and live in .env (gitignored), never in the repo.
if [ -f "$ROOT_DIR/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$ROOT_DIR/.env"
	set +a
fi

# --- batch: newest R2 folder -------------------------------------------------

# Wrangler has no "list objects" command, so list through the Cloudflare API with
# the same credentials: CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID if set (the
# variables wrangler itself reads), otherwise whatever `wrangler login` stored.
cf_credentials() {
	CF_TOKEN="${CLOUDFLARE_API_TOKEN:-}"
	if [ -z "$CF_TOKEN" ]; then
		CF_TOKEN="$(npx --yes wrangler auth token 2>/dev/null | awk 'NF { last = $NF } END { print last }')"
	fi
	CF_ACCOUNT="${CLOUDFLARE_ACCOUNT_ID:-}"
	if [ -z "$CF_ACCOUNT" ]; then
		CF_ACCOUNT="$(npx --yes wrangler whoami 2>/dev/null | grep -oE '\b[0-9a-f]{32}\b' | head -n 1)"
	fi
	if [ -z "$CF_TOKEN" ] || [ -z "$CF_ACCOUNT" ]; then
		echo "error: no Cloudflare credentials; run 'npx wrangler login'" >&2
		echo "       or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID in .env" >&2
		exit 2
	fi
}

# Print every object key under $1, following pagination.
r2_list_keys() {
	local cursor="" page
	while :; do
		page="$(curl -sS -G \
			-H "Authorization: Bearer $CF_TOKEN" \
			"https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT/r2/buckets/$R2_BUCKET/objects" \
			--data-urlencode "prefix=$1" \
			--data-urlencode "per_page=1000" \
			${cursor:+--data-urlencode "cursor=$cursor"})"
		if ! printf '%s' "$page" | jq -e '.success == true' >/dev/null 2>&1; then
			echo "error: listing r2://$R2_BUCKET/$1 failed:" >&2
			printf '%s' "$page" | jq -r '.errors[]? | "  \(.code): \(.message)"' >&2 2>/dev/null || echo "  $page" >&2
			echo "       if this is an auth error, set CLOUDFLARE_API_TOKEN (R2 read) and CLOUDFLARE_ACCOUNT_ID in .env" >&2
			exit 1
		fi
		printf '%s' "$page" | jq -r '.result[].key'
		cursor="$(printf '%s' "$page" | jq -r 'if .result_info.is_truncated then .result_info.cursor // empty else empty end')"
		[ -z "$cursor" ] && break
	done
}

# Pick the videos, match each to the radio API by kebab-case title, and build its
# caption. Casing comes from the API; anything unmatched falls back to the
# lowercase file name. Prints a JSON array, one object per video, in post order.
build_batch_plan() {
	local videos_json="$1" tracks_json="$2"
	jq -n \
		--argjson videos "$videos_json" \
		--argjson tracks "$tracks_json" \
		--slurpfile handles "$HANDLES_FILE" \
		--slurpfile queue "$QUEUE_FILE" \
		--slurpfile posted "$POSTED_FILE" \
		--arg base "$R2_PUBLIC_URL" \
		--arg separator "$EXTRA_SEPARATOR" \
		--argjson limit "$LIMIT" '
		def kebab: ascii_downcase | gsub("[^a-z0-9]+"; "-") | gsub("^-+|-+$"; "");
		def dedupe: reduce .[] as $x ([]; if index([$x]) then . else . + [$x] end);
		# "dEnk, Drumtomski" → ["dEnk", "Drumtomski"], so each artist keeps its own handles.
		def artists: [splits("\\s*(,|&|\\s+x\\s+|\\s+(feat|ft)\\.?\\s+)\\s*"; "i")] | map(select(length > 0));

		# Rendered files are named <slug>-<uuid>-<width>x<height>.mp4.
		def slug_of: split("/") | last | sub("\\.[^.]+$"; "")
			| sub("-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(-[0-9]+x[0-9]+)?$"; "");

		# A slug may be the title ("fig-pulp"), artist + title ("quetzal-fig-pulp"),
		# or the source file name ("the-deli-sunflowers" from "The Deli - Sunflowers向日葵.mp3").
		($tracks | reduce .[] as $t ({};
			reduce (($t.title | kebab), ("\($t.artist) \($t.title)" | kebab),
				($t.path // "" | split("/") | last | sub("\\.[^.]+$"; "") | kebab)) as $k
				(.; if $k == "" or has($k) then . else .[$k] = $t end))) as $bySlug
		| $queue[0] as $queue
		| ($posted[0] | map(.key)) as $done
		| $handles[0] as $handles
		# Same file, or the same radio track under another of its slugs.
		| def queued($slug): ($bySlug[$slug].id) as $id
			| $queue | to_entries
			| map(select(.value.video == $slug or ($id != null and $bySlug[.value.video].id == $id)))
			| first;
		$videos
		| map({ key: ., slug: slug_of })
		| map(select(.key as $k | $done | index([$k]) | not))
		| map(. + { rank: (queued(.slug).key // 1e9) })
		| sort_by(.rank, .key)
		| .[:$limit]
		| map(
			. as $v
			| (queued($v.slug).value // {}) as $entry
			| $bySlug[$v.slug] as $track
			| ($entry.title // $track.title // ($v.slug | gsub("-"; " "))) as $title
			| ($entry.artist // $track.artist // "") as $artist
			| [$artist | artists[] | ascii_downcase | $handles[.] // [] | if type == "string" then [.] else . end | .[]
				| if startswith("@") then . else "@" + . end] as $tags
			| ($tags | dedupe) as $tags
			| ($title + (if $artist != "" then " by " + $artist else "" end)) as $credit
			| {
				key: $v.key,
				url: ($base + "/" + ($v.key | split("/") | map(@uri) | join("/"))),
				matched: ($track != null),
				title: $credit,
				description: ([$credit] + $tags | join(" "))
					+ (if ($entry.extra // "") != "" then $separator + $entry.extra else "" end)
			})
		'
}

run_batch() {
	for cmd in curl jq npx; do
		command -v "$cmd" >/dev/null 2>&1 || {
			echo "error: '$cmd' is required but not installed" >&2
			exit 2
		}
	done
	case "$LIMIT" in
	'' | *[!0-9]*)
		echo "error: --limit must be a positive integer (got '$LIMIT')" >&2
		exit 2
		;;
	esac
	[ -f "$HANDLES_FILE" ] || echo '{}' >"$HANDLES_FILE"
	[ -f "$QUEUE_FILE" ] || echo '[]' >"$QUEUE_FILE"
	[ -f "$POSTED_FILE" ] || echo '[]' >"$POSTED_FILE"

	cf_credentials

	if [ -z "$FOLDER" ]; then
		echo "Finding the newest folder in r2://$R2_BUCKET/$R2_PREFIX..." >&2
		# Timestamps sort lexically in time order, so the last one is the newest.
		FOLDER="$(r2_list_keys "$R2_PREFIX" |
			grep -oE "^${R2_PREFIX//./\\.}[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}-[0-9]{2}-[0-9]{2}/" |
			sort -u | tail -n 1)"
		FOLDER="${FOLDER#"$R2_PREFIX"}"
		if [ -z "$FOLDER" ]; then
			echo "error: no YYYY-MM-DDTHH-MM-SS folders under r2://$R2_BUCKET/$R2_PREFIX" >&2
			exit 1
		fi
	fi
	FOLDER="${FOLDER%/}"
	echo "Folder: $R2_PREFIX$FOLDER" >&2

	local videos_json tracks_json plan count
	videos_json="$(r2_list_keys "$R2_PREFIX$FOLDER/" |
		grep -iE '\.(mp4|mov|webm)$' | jq -R . | jq -sc .)"
	if [ "$(printf '%s' "$videos_json" | jq length)" -eq 0 ]; then
		echo "error: no videos in r2://$R2_BUCKET/$R2_PREFIX$FOLDER/" >&2
		exit 1
	fi

	local radio_api="${VITE_RADIO_API_URL:-https://radio-api.cieslak.dev}"
	if ! tracks_json="$(curl -fsS --compressed "${radio_api%/}/api/tracks" | jq -c '.tracks')"; then
		echo "error: could not fetch tracks from ${radio_api%/}/api/tracks" >&2
		exit 1
	fi

	plan="$(build_batch_plan "$videos_json" "$tracks_json")"
	count="$(printf '%s' "$plan" | jq length)"
	if [ "$count" -eq 0 ]; then
		echo "Nothing to post — every video in this folder is in $(basename "$POSTED_FILE")." >&2
		exit 0
	fi

	echo >&2
	echo "Next $count video(s):" >&2
	printf '%s' "$plan" | jq -r 'to_entries[] | "  \(.key + 1). \(.value.key | split("/") | last) → \(.value.title)\(if .value.matched then "" else "  (no radio API match: lowercase from file name)" end)"' >&2

	local passthrough=()
	[ "$ONLY" != "youtube,tiktok,instagram" ] && passthrough+=(--only "$ONLY")
	[ "$DRAFT" = true ] && passthrough+=(--draft)
	[ "$DRY_RUN" = true ] && passthrough+=(--dry-run)

	local i item key
	for ((i = 0; i < count; i++)); do
		item="$(printf '%s' "$plan" | jq -c ".[$i]")"
		key="$(printf '%s' "$item" | jq -r .key)"
		echo >&2
		echo "=== $((i + 1))/$count: $key" >&2
		if ! "$SCRIPT_DIR/post-video.sh" \
			--video "$(printf '%s' "$item" | jq -r .url)" \
			--description "$(printf '%s' "$item" | jq -r .description)" \
			--title "$(printf '%s' "$item" | jq -r .title)" \
			${passthrough[@]+"${passthrough[@]}"}; then
			# Stop: a partial failure already queued some channels, and the next
			# video would land in the slot this one was meant for.
			echo >&2
			echo "Stopped at $key; it was not marked as posted, nor were the videos after it." >&2
			exit 1
		fi
		# Drafts still need approving, so only real queueing advances the batch.
		if [ "$DRY_RUN" = false ] && [ "$DRAFT" = false ]; then
			jq --arg key "$key" --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
				'. + [{ key: $key, queuedAt: $at }]' "$POSTED_FILE" >"$POSTED_FILE.tmp" &&
				mv "$POSTED_FILE.tmp" "$POSTED_FILE"
		fi
	done

	echo >&2
	echo "Done: $count video(s) from $R2_PREFIX$FOLDER." >&2
	exit 0
}

[ "$LATEST" = true ] && run_batch

if [ -z "$VIDEO_URL" ] || [ -z "$DESCRIPTION" ]; then
	echo "error: --video and --description are required" >&2
	usage >&2
	exit 2
fi

case "$VIDEO_URL" in
https://*) ;;
*)
	echo "error: --video must be a public https:// URL (Buffer cannot upload local files)" >&2
	echo "       see scripts/README.md" >&2
	exit 2
	;;
esac

for cmd in buffer jq; do
	command -v "$cmd" >/dev/null 2>&1 || {
		echo "error: '$cmd' is required but not installed" >&2
		exit 2
	}
done

# --- config -----------------------------------------------------------------

require_env() {
	local name="$1"
	if [ -z "${!name:-}" ]; then
		echo "error: $name is not set" >&2
		echo "       populate it in .env — see scripts/README.md" >&2
		exit 2
	fi
}

wants() {
	case ",$ONLY," in
	*",$1,"*) return 0 ;;
	*) return 1 ;;
	esac
}

for svc in $(echo "$ONLY" | tr ',' ' '); do
	case "$svc" in
	youtube | tiktok | instagram) ;;
	*)
		echo "error: --only accepts youtube, tiktok, instagram (got '$svc')" >&2
		exit 2
		;;
	esac
done

wants youtube && require_env BUFFER_YOUTUBE_CHANNEL_ID
wants tiktok && require_env BUFFER_TIKTOK_CHANNEL_ID
wants instagram && require_env BUFFER_INSTAGRAM_CHANNEL_ID

# --- derive per-network copy ------------------------------------------------

# Truncate on character count, not bytes, so multibyte text isn't cut mid-glyph.
truncate_text() {
	local text="$1" max="$2"
	printf '%s' "$text" | awk -v max="$max" '
		{ lines[NR] = $0 }
		END {
			out = ""
			for (i = 1; i <= NR; i++) out = out (i > 1 ? "\n" : "") lines[i]
			if (length(out) > max) out = substr(out, 1, max)
			printf "%s", out
		}'
}

# A description may already end with its own hashtags. Split those off, merge them
# with HASHTAGS preserving first-seen order, and drop duplicates (case-insensitive)
# so the caption never repeats a tag.
split_trailing_hashtags() {
	printf '%s' "$1" | awk '
		{ lines[NR] = $0 }
		END {
			last = NR
			# Walk back over trailing blank lines and hashtag-only lines.
			while (last > 0) {
				line = lines[last]
				gsub(/^[ \t]+|[ \t]+$/, "", line)
				if (line == "") { last--; continue }
				copy = line
				gsub(/#[^ \t#]+/, "", copy)
				gsub(/[ \t]/, "", copy)
				if (copy != "") break
				tags = line " " tags
				last--
			}
			# The last remaining line may still END with hashtags after real text
			# ("the journey begins. #lofi #catjam"). Peel those off too, leaving
			# any hashtag that sits mid-sentence untouched.
			if (last > 0) {
				line = lines[last]
				trailing = ""
				while (match(line, /[ \t]+#[^ \t#]+[ \t]*$/)) {
					tag = substr(line, RSTART, RLENGTH)
					gsub(/^[ \t]+|[ \t]+$/, "", tag)
					trailing = tag (trailing == "" ? "" : " " trailing)
					line = substr(line, 1, RSTART - 1)
					sub(/[ \t]+$/, "", line)
				}
				if (trailing != "") {
					tags = trailing " " tags
					lines[last] = line
				}
			}
			body = ""
			for (i = 1; i <= last; i++) body = body (i > 1 ? "\n" : "") lines[i]
			gsub(/[ \t]+$/, "", body)
			gsub(/^[ \t]+|[ \t]+$/, "", tags)
			printf "%s\x1f%s", body, tags
		}'
}

merge_hashtags() {
	printf '%s %s' "$1" "$2" | tr ' \t' '\n\n' | awk '
		$0 != "" {
			key = tolower($0)
			if (!(key in seen)) { seen[key] = 1; out = out (out == "" ? "" : " ") $0 }
		}
		END { printf "%s", out }'
}

# Keep at most $2 hashtags, preserving order. 0 or less means no limit.
limit_hashtags() {
	local tags="$1" max="$2"
	[ "$max" -le 0 ] && {
		printf '%s' "$tags"
		return
	}
	printf '%s' "$tags" | tr ' ' '\n' | awk -v max="$max" '
		$0 != "" && n < max { n++; out = out (out == "" ? "" : " ") $0 }
		END { printf "%s", out }'
}

compose_body() {
	local tags="$1"
	if [ -n "$DESCRIPTION_BODY" ] && [ -n "$tags" ]; then
		printf '%s\n\n%s' "$DESCRIPTION_BODY" "$tags"
	elif [ -n "$DESCRIPTION_BODY" ]; then
		printf '%s' "$DESCRIPTION_BODY"
	else
		printf '%s' "$tags"
	fi
}

# <br> is a line break, so a caption can push text a few lines down.
DESCRIPTION="${DESCRIPTION//<br \/>/$'\n'}"
DESCRIPTION="${DESCRIPTION//<br\/>/$'\n'}"
DESCRIPTION="${DESCRIPTION//<br>/$'\n'}"

split_result="$(split_trailing_hashtags "$DESCRIPTION")"
DESCRIPTION_BODY="${split_result%%$'\x1f'*}"
INLINE_HASHTAGS="${split_result#*$'\x1f'}"

ALL_HASHTAGS="$(merge_hashtags "$INLINE_HASHTAGS" "$HASHTAGS")"
INSTAGRAM_HASHTAGS="$(limit_hashtags "$(merge_hashtags "$INLINE_HASHTAGS" "$INSTAGRAM_HASHTAGS_BASE")" "$INSTAGRAM_HASHTAG_MAX")"

BODY="$(compose_body "$ALL_HASHTAGS")"
INSTAGRAM_TEXT="$(compose_body "$INSTAGRAM_HASHTAGS")"

if [ -n "$TITLE_OVERRIDE" ]; then
	YOUTUBE_TITLE="$TITLE_OVERRIDE"
else
	# First line of the description sans hashtags, capped at YouTube's 100-char limit.
	YOUTUBE_TITLE="$(printf '%s' "$DESCRIPTION_BODY" | head -n 1)"
fi
YOUTUBE_TITLE="$(truncate_text "$YOUTUBE_TITLE" "$YOUTUBE_TITLE_MAX")"

if [ -z "$YOUTUBE_TITLE" ]; then
	echo "error: could not derive a YouTube title; pass --title" >&2
	exit 2
fi

TIKTOK_TEXT="$(truncate_text "$BODY" "$TIKTOK_TEXT_MAX")"

# --- payloads ---------------------------------------------------------------

# Built with jq --arg so quotes, newlines and em-dashes are escaped properly.
base_payload() {
	jq -nc \
		--arg channelId "$1" \
		--arg text "$2" \
		--arg videoUrl "$VIDEO_URL" \
		--argjson draft "$DRAFT" \
		'{
			channelId: $channelId,
			schedulingType: "automatic",
			mode: "addToQueue",
			text: $text,
			assets: [{ video: { url: $videoUrl } }]
		}
		| if $draft then .saveToDraft = true else . end'
}

payload_for() {
	case "$1" in
	youtube)
		base_payload "$BUFFER_YOUTUBE_CHANNEL_ID" "$BODY" | jq -c \
			--arg title "$YOUTUBE_TITLE" \
			--arg categoryId "$YOUTUBE_CATEGORY_ID" \
			--arg privacy "$YOUTUBE_PRIVACY" \
			'.metadata.youtube = { title: $title, categoryId: $categoryId, privacy: $privacy }'
		;;
	tiktok)
		base_payload "$BUFFER_TIKTOK_CHANNEL_ID" "$TIKTOK_TEXT"
		;;
	instagram)
		base_payload "$BUFFER_INSTAGRAM_CHANNEL_ID" "$INSTAGRAM_TEXT" | jq -c \
			'.metadata.instagram = { type: "reel", shouldShareToFeed: true }'
		;;
	esac
}

SERVICES=()
for svc in youtube tiktok instagram; do
	wants "$svc" && SERVICES+=("$svc")
done

# --- validate everything before posting anything ----------------------------

# posts create is NOT idempotent, so catch a bad payload before any channel is
# touched. --dry-run makes no API call and costs nothing.
echo "Validating ${#SERVICES[@]} payload(s)..." >&2
for svc in "${SERVICES[@]}"; do
	payload="$(payload_for "$svc")"
	if ! buffer posts create --json "$payload" --dry-run --quiet >/dev/null; then
		echo "error: payload for $svc failed validation; nothing was posted" >&2
		exit 1
	fi
	echo "  ok: $svc" >&2
done

if [ "$DRY_RUN" = true ]; then
	echo >&2
	echo "Dry run — no posts created. Payloads:" >&2
	for svc in "${SERVICES[@]}"; do
		echo >&2
		echo "# $svc" >&2
		payload_for "$svc" | jq .
	done
	exit 0
fi

# --- post, serially ---------------------------------------------------------

# Serial on purpose: parallel calls multiply 429 risk against one rate-limit window.
SUCCEEDED=()
FAILED=()

for svc in "${SERVICES[@]}"; do
	echo >&2
	echo "Posting to $svc..." >&2
	payload="$(payload_for "$svc")"

	if ! response="$(buffer posts create --json "$payload" --output json 2>&1)"; then
		echo "  failed: $svc" >&2
		echo "$response" >&2
		FAILED+=("$svc")
		continue
	fi

	# A zero exit can still carry InvalidInputError — check the union type.
	# The CLI unwraps the mutation, so fields sit at the top level; fall back to
	# the wrapped shape in case that ever changes.
	result="$(printf '%s' "$response" | jq -c '.createPost // .')"
	typename="$(printf '%s' "$result" | jq -r '.__typename // empty')"
	if [ "$typename" != "PostActionSuccess" ]; then
		message="$(printf '%s' "$result" | jq -r '.message // empty')"
		echo "  failed: $svc — ${typename:-unrecognized response}${message:+: $message}" >&2
		[ -z "$typename" ] && echo "    raw: $response" >&2
		FAILED+=("$svc")
		continue
	fi

	post_id="$(printf '%s' "$result" | jq -r '.post.id')"
	status="$(printf '%s' "$result" | jq -r '.post.status')"
	echo "  ok: $svc — post $post_id ($status)" >&2
	SUCCEEDED+=("$svc")
done

# --- report -----------------------------------------------------------------

echo >&2
if [ ${#SUCCEEDED[@]} -gt 0 ]; then
	echo "Posted: ${SUCCEEDED[*]}" >&2
fi

if [ ${#FAILED[@]} -gt 0 ]; then
	failed_csv="$(
		IFS=,
		echo "${FAILED[*]}"
	)"
	echo "Failed: ${FAILED[*]}" >&2
	echo >&2
	# Never auto-retry: posts create is not idempotent and would duplicate.
	echo "Not retrying automatically — posts create is not idempotent." >&2
	echo "Re-run just the failures once you've fixed the cause:" >&2
	echo "  scripts/post-video.sh --video ... --description ... --only $failed_csv" >&2
	exit 1
fi

if [ "$DRAFT" = true ]; then
	echo "Saved as drafts — nothing will publish until you approve them in Buffer." >&2
else
	echo "Queued into each channel's next slot." >&2
fi
