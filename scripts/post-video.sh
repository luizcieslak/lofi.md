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

HASHTAGS="#lofi #lofihiphop #studymusic #lofiradio #codingmusic"

YOUTUBE_CATEGORY_ID="10" # Music
YOUTUBE_PRIVACY="public"
YOUTUBE_TITLE_MAX=100
TIKTOK_TEXT_MAX=2200

# Buffer caps Reels captions at 5 hashtags; extras are dropped, keeping the first 5.
INSTAGRAM_HASHTAG_MAX=5

# --- args -------------------------------------------------------------------

usage() {
	cat <<'EOF'
Usage: scripts/post-video.sh --video <url> --description <text> [options]

Required:
  --video <url>          Public HTTPS URL to the .mp4
  --description <text>   One description; each network's copy is derived from it

Options:
  --title <text>         Override the derived YouTube title
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

while [ $# -gt 0 ]; do
	case "$1" in
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

# Channel IDs are per-workspace and live in .env (gitignored), never in the repo.
if [ -f "$ROOT_DIR/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$ROOT_DIR/.env"
	set +a
fi

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

split_result="$(split_trailing_hashtags "$DESCRIPTION")"
DESCRIPTION_BODY="${split_result%%$'\x1f'*}"
INLINE_HASHTAGS="${split_result#*$'\x1f'}"

ALL_HASHTAGS="$(merge_hashtags "$INLINE_HASHTAGS" "$HASHTAGS")"
INSTAGRAM_HASHTAGS="$(limit_hashtags "$ALL_HASHTAGS" "$INSTAGRAM_HASHTAG_MAX")"

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
