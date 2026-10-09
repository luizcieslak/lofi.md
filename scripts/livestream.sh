#!/usr/bin/env bash
#
# Stream lofi.md to YouTube Live, Twitch or Kick with ffmpeg alone — no
# browser, no OBS.
#
# Loops the backdrop video, pulls the radio audio straight from the radio API,
# and overlays the now-playing card top-right. The card is the site's own #meta,
# rendered to a transparent PNG by headless Chrome (scripts/stream-meta.html)
# once per track change. Without Chrome it falls back to plain ffmpeg text. Encodes with Apple's hardware H.264 encoder (VideoToolbox), so on an
# M1 it costs very little CPU and RAM.
#
# The audio connection registers as a listener exactly like a browser tab does:
# one session id per run, a heartbeat every 60s, and an `end` call on exit.
#
# For a pixel-identical stream (cover art, the wall tilt), use OBS with a
# Browser Source on the site's ?stream mode instead — see scripts/README.md.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"

# --- tunables ---------------------------------------------------------------

VIDEO_FILE="$ROOT_DIR/public/lofimd.mp4"

# Ingest servers. Kick's is per-account, so it comes from .env (KICK_STREAM_URL).
YOUTUBE_INGEST="rtmp://a.rtmp.youtube.com/live2"
TWITCH_INGEST="rtmp://live.twitch.tv/app" # auto-routes to the nearest ingest

# A ceiling, not a target: 6 Mbps is Twitch's recommended max and inside
# YouTube's 4.5–9 Mbps for 1080p30. VideoToolbox undershoots it on this mostly
# still loop (~3 Mbps measured) because it doesn't need more.
VIDEO_BITRATE="6000k"
AUDIO_BITRATE="160k"
FPS=30
GOP=$((FPS * 2)) # keyframe every 2s — YouTube wants ≤ 4s

EDGE=48 # gap between the card and the top/right edges, in px of the 1920x1080 frame

# Backdrop scrim, mirroring #backdrop::after in src/style.css: a black gradient
# at 55% → 15% (at 45% height) → 45%, times --backdrop-scrim-opacity. Keep these
# in sync by hand. 0 turns it off.
SCRIM_OPACITY=1

# Now-playing card. CARD_SCALE is the device pixel ratio Chrome renders at: the
# site's 14px type is tuned for a screen you sit in front of, and 2x reads well
# in a small 1080p player, like the site on a Retina display.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
CARD_SCALE=2
CARD_VIEWPORT="480,120" # CSS px; fits #meta's 420px max-width plus its shadow
CARD_INSET=16           # CSS px; matches --meta-top/--meta-right in stream-meta.html
CARD_RENDER_TIMEOUT_S=15

# Fallback text overlay, used when Chrome isn't installed.
FONT_FILE="/System/Library/Fonts/SFNS.ttf"
TITLE_SIZE=30
ARTIST_SIZE=26
BOX_PAD=10       # padding inside each line's backing box
SCRIM_ALPHA=0.55 # matches --meta-bg-alpha in src/style.css

# A new track reaches the stream within one poll plus one card render (~1-2s).
NOW_PLAYING_POLL_S=3
HEARTBEAT_S=60    # matches HEARTBEAT_INTERVAL_MS in src/radio-player.ts
RESTART_DELAY_S=5 # live mode: wait this long before restarting a dead ffmpeg

# --- args -------------------------------------------------------------------

usage() {
	cat <<'EOF'
Usage: scripts/livestream.sh [options]

Streams to YouTube Live by default, unless --output is given.

Options:
  --platform <name>      youtube (default), twitch or kick
  --output <file>        Record to a local file (.flv or .mp4) instead of going live
  --duration <seconds>   Stop after this many seconds
  --no-text              Skip the now-playing card
  --dry-run              Print the ffmpeg command and exit
  -h, --help             Show this help

Requires ffmpeg, curl and jq. Reads VITE_RADIO_API_URL and the platform's
stream key (YOUTUBE_STREAM_KEY, TWITCH_STREAM_KEY, or KICK_STREAM_URL +
KICK_STREAM_KEY) from .env — see scripts/README.md.
EOF
}

PLATFORM="youtube"
OUTPUT=""
DURATION=""
TEXT=true
DRY_RUN=false

while [ $# -gt 0 ]; do
	case "$1" in
	--platform)
		PLATFORM="${2:-}"
		shift 2
		;;
	--output)
		OUTPUT="${2:-}"
		shift 2
		;;
	--duration)
		DURATION="${2:-}"
		shift 2
		;;
	--no-text)
		TEXT=false
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

# --- env --------------------------------------------------------------------

# The stream key is a secret and lives in .env (gitignored), never in the repo.
if [ -f "$ROOT_DIR/.env" ]; then
	set -a
	# shellcheck disable=SC1091
	. "$ROOT_DIR/.env"
	set +a
fi

for bin in ffmpeg curl jq; do
	if ! command -v "$bin" >/dev/null 2>&1; then
		echo "error: $bin is not installed (brew install $bin)" >&2
		exit 1
	fi
done

RADIO_API="${VITE_RADIO_API_URL:-}"
if [ -z "$RADIO_API" ]; then
	echo "error: VITE_RADIO_API_URL is not set — copy .env.example to .env" >&2
	exit 1
fi

# Where the key comes from, per platform. Twitch and YouTube have fixed ingest
# servers; Kick shows a per-account server URL next to the key (RTMPS).
case "$PLATFORM" in
youtube)
	PLATFORM_NAME="YouTube Live"
	INGEST="$YOUTUBE_INGEST"
	KEY_VAR="YOUTUBE_STREAM_KEY"
	KEY_HINT="YouTube Studio → Create → Go live → Stream"
	;;
twitch)
	PLATFORM_NAME="Twitch"
	INGEST="$TWITCH_INGEST"
	KEY_VAR="TWITCH_STREAM_KEY"
	KEY_HINT="Twitch → Creator Dashboard → Settings → Stream → Primary Stream key"
	;;
kick)
	PLATFORM_NAME="Kick"
	INGEST="${KICK_STREAM_URL:-}"
	KEY_VAR="KICK_STREAM_KEY"
	KEY_HINT="Kick → Dashboard → Settings → Stream URL & Key"
	if [ -z "$OUTPUT" ] && [ -z "$INGEST" ] && [ "$DRY_RUN" = false ]; then
		echo "error: KICK_STREAM_URL is not set" >&2
		echo "       copy the Stream URL from $KEY_HINT into .env" >&2
		exit 1
	fi
	INGEST="${INGEST%/}"
	;;
*)
	echo "error: --platform must be youtube, twitch or kick, got: $PLATFORM" >&2
	exit 2
	;;
esac

STREAM_KEY="${!KEY_VAR:-}"
if [ -z "$OUTPUT" ] && [ -z "$STREAM_KEY" ] && [ "$DRY_RUN" = false ]; then
	echo "error: $KEY_VAR is not set" >&2
	echo "       copy it from $KEY_HINT into .env," >&2
	echo "       or pass --output <file> to record locally instead" >&2
	exit 1
fi

if [ -n "$DURATION" ] && ! [[ "$DURATION" =~ ^[0-9]+$ ]]; then
	echo "error: --duration takes whole seconds, got: $DURATION" >&2
	exit 2
fi

# --- now playing + listener heartbeat ---------------------------------------

SID="$(uuidgen | tr '[:upper:]' '[:lower:]')"
WORK_DIR="$(mktemp -d -t lofimd-stream)"
TITLE_FILE="$WORK_DIR/title.txt"
ARTIST_FILE="$WORK_DIR/artist.txt"
CARD_FILE="$WORK_DIR/card.png"
CARD_PAGE="$SCRIPT_DIR/stream-meta.html"
HELPER_PIDS=()

# card: Chrome-rendered #meta. text: ffmpeg drawtext. none: --no-text.
OVERLAY=none
if [ "$TEXT" = true ]; then
	if [ -x "$CHROME" ]; then
		OVERLAY=card
	else
		echo "warning: Chrome not found at $CHROME — using the plain text overlay" >&2
		OVERLAY=text
	fi
fi

cleanup() {
	# Killing only a helper subshell would orphan its in-flight sleep/curl, which
	# holds stdout open until its timer runs out — so take the children too. The
	# subshell goes first so it can't report its child's death to the terminal.
	local pid kids
	for pid in "${HELPER_PIDS[@]:-}"; do
		[ -n "$pid" ] || continue
		kids="$(pgrep -P "$pid" || true)"
		kill "$pid" 2>/dev/null || true
		[ -n "$kids" ] && kill $kids 2>/dev/null || true
	done
	curl -fsS -m 5 -X POST "$RADIO_API/api/listeners/end?sid=$SID" >/dev/null 2>&1 || true
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# ffmpeg re-reads the overlay files continuously, so each one is written beside
# itself and then renamed over — a rename is atomic, so ffmpeg never catches a
# half-written title or card.
write_atomic() {
	printf '%s' "$2" >"$1.tmp"
	mv -f "$1.tmp" "$1"
}

# Screenshot stream-meta.html for one track. Headless Chrome on macOS often
# writes the screenshot and then never exits, so rather than wait on it, watch
# for the file and kill Chrome once it's there.
render_card() {
	local title="$1" artist="$2" cover="$3" query next chrome_pid waited=0
	query="$(jq -rn --arg t "$title" --arg a "$artist" --arg c "$cover" \
		'"title=\($t|@uri)&artist=\($a|@uri)&cover=\($c|@uri)"')"
	next="$WORK_DIR/card.next.png"
	rm -f "$next"

	"$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run \
		--user-data-dir="$WORK_DIR/chrome" --default-background-color=00000000 \
		--force-device-scale-factor="$CARD_SCALE" --window-size="$CARD_VIEWPORT" \
		--virtual-time-budget=5000 --screenshot="$next" \
		"file://$CARD_PAGE?$query" >/dev/null 2>&1 &
	chrome_pid=$!

	# Chrome writes the PNG in one go; the file appearing means it's complete
	# once its size stops changing.
	while [ "$waited" -lt $((CARD_RENDER_TIMEOUT_S * 10)) ]; do
		if [ -s "$next" ]; then
			local size1 size2
			size1="$(stat -f %z "$next")"
			sleep 0.1
			size2="$(stat -f %z "$next")"
			[ "$size1" = "$size2" ] && break
		fi
		sleep 0.1
		waited=$((waited + 1))
	done
	kill "$chrome_pid" 2>/dev/null || true
	wait "$chrome_pid" 2>/dev/null || true

	if [ -s "$next" ]; then
		mv -f "$next" "$CARD_FILE"
	else
		echo "warning: card render timed out for \"$title\"; keeping the previous card" >&2
	fi
}

poll_now_playing() {
	local json title artist cover current="" last=""
	while true; do
		if json="$(curl -fsS -m 5 "$RADIO_API/now-playing?t=$(date +%s)" 2>/dev/null)"; then
			title="$(jq -r '.track.title // ""' <<<"$json")"
			artist="$(jq -r '.track.artist // ""' <<<"$json")"
			# Same fallback order as the site: album art, then cover.
			cover="$(jq -r '.track.albumArtUrl // .track.coverUrl // ""' <<<"$json")"
			current="$title|$artist|$cover"
			if [ "$current" != "$last" ]; then
				case "$OVERLAY" in
				card) [ -n "$title" ] && render_card "$title" "$artist" "$cover" ;;
				text)
					write_atomic "$TITLE_FILE" "$title"
					write_atomic "$ARTIST_FILE" "$artist"
					;;
				esac
				last="$current"
			fi
		fi
		sleep "$NOW_PLAYING_POLL_S"
	done
}

send_heartbeats() {
	while true; do
		sleep "$HEARTBEAT_S"
		curl -fsS -m 5 -X POST "$RADIO_API/api/listeners/heartbeat?sid=$SID" >/dev/null 2>&1 || true
	done
}

# --- ffmpeg command ---------------------------------------------------------

write_atomic "$TITLE_FILE" ""
write_atomic "$ARTIST_FILE" ""

# Until the first track renders, the card is a fully transparent image of the
# same size, so the overlay's dimensions never change mid-stream.
CARD_W=$((${CARD_VIEWPORT%,*} * CARD_SCALE))
CARD_H=$((${CARD_VIEWPORT#*,} * CARD_SCALE))
# Chrome draws the card CARD_INSET CSS px in from the image's top-right corner;
# shift the image so the card itself lands EDGE px from the frame's edges.
CARD_OFFSET=$((EDGE - CARD_INSET * CARD_SCALE))
if [ "$OVERLAY" = card ]; then
	ffmpeg -v error -y -f lavfi -i "color=black@0:s=${CARD_W}x${CARD_H},format=rgba" \
		-frames:v 1 "$CARD_FILE"
fi

VIDEO_FILTER="[0:v]fps=$FPS"
if [ "$SCRIM_OPACITY" != 0 ]; then
	# The gradient is computed once, on a single frame; overlay then reuses that
	# frame for the whole stream, so the per-frame cost is just the blend.
	scrim_alpha="255*$SCRIM_OPACITY*if(lt(Y/H\,0.45)\,0.55-0.40*Y/H/0.45\,0.15+0.30*(Y/H-0.45)/0.55)"
	VIDEO_FILTER+="[base];color=c=black:s=1920x1080:d=1,format=rgba,geq=r=0:g=0:b=0:a=$scrim_alpha,trim=end_frame=1,format=yuva420p[scrim]"
	VIDEO_FILTER+=";[base][scrim]overlay=eof_action=repeat:format=yuv420"
fi
if [ "$OVERLAY" = card ]; then
	# Input 2 is the card PNG; image2 re-reads the file on every loop, so a
	# renamed-in card shows up within half a second.
	VIDEO_FILTER+="[bg];[2:v]format=rgba[card];[bg][card]overlay=x=W-w-$CARD_OFFSET:y=$CARD_OFFSET:format=auto"
fi
if [ "$OVERLAY" = text ]; then
	# expansion=none: titles are printed literally, so a '%' in a song name is safe.
	# Each line gets its own translucent box, like the scrim behind #meta, so the
	# text stays readable over the bright wall.
	common="fontfile=$FONT_FILE:reload=1:expansion=none:box=1:boxcolor=black@$SCRIM_ALPHA:boxborderw=$BOX_PAD:x=w-tw-$EDGE"
	VIDEO_FILTER+=",drawtext=$common:textfile=$TITLE_FILE:fontsize=$TITLE_SIZE:fontcolor=white:y=$EDGE"
	VIDEO_FILTER+=",drawtext=$common:textfile=$ARTIST_FILE:fontsize=$ARTIST_SIZE:fontcolor=white@0.8:y=$EDGE+$TITLE_SIZE+$BOX_PAD*2"
fi
VIDEO_FILTER+=",format=yuv420p[v]"

CARD_INPUT=()
if [ "$OVERLAY" = card ]; then
	CARD_INPUT=(-thread_queue_size 64 -re -f image2 -loop 1 -framerate 2 -i "$CARD_FILE")
fi

FFMPEG=(
	ffmpeg -hide_banner -loglevel warning -stats
	# Video: the backdrop loop, read at its native rate so it paces the output.
	-thread_queue_size 1024 -stream_loop -1 -re -i "$VIDEO_FILE"
	# Audio: the live radio. Reconnects on its own after a dropped connection.
	-thread_queue_size 1024
	-reconnect 1 -reconnect_streamed 1 -reconnect_on_network_error 1 -reconnect_delay_max 30
	-i "$RADIO_API/stream?sid=$SID&hb=1"
	# Card: the now-playing PNG, re-read twice a second.
	${CARD_INPUT[@]+"${CARD_INPUT[@]}"} # bash 3.2-safe empty-array expansion
	-filter_complex "$VIDEO_FILTER"
	-map "[v]" -map 1:a:0
	# prio_speed 0: favour quality over speed — the hardware encoder has plenty of
	# headroom at 1080p30. spatial_aq: spend bits on detail (the card) over flat wall.
	-c:v h264_videotoolbox -realtime 1 -prio_speed 0 -spatial_aq 1
	-b:v "$VIDEO_BITRATE" -maxrate "$VIDEO_BITRATE" -bufsize "$VIDEO_BITRATE"
	-g "$GOP" -profile:v high
	-c:a aac -b:a "$AUDIO_BITRATE" -ar 44100 -ac 2
)
[ -n "$DURATION" ] && FFMPEG+=(-t "$DURATION")

if [ -n "$OUTPUT" ]; then
	FFMPEG+=(-y "$OUTPUT")
else
	FFMPEG+=(-f flv "$INGEST/${STREAM_KEY:-<$KEY_VAR>}")
fi

if [ "$DRY_RUN" = true ]; then
	# Never echo the real key.
	printf '%q ' "${FFMPEG[@]}" | sed -E "s#(rtmps?://[^ ]*/)[^/ ]+#\1<redacted>#"
	echo
	exit 0
fi

# --- run --------------------------------------------------------------------

poll_now_playing &
HELPER_PIDS+=($!)
send_heartbeats &
HELPER_PIDS+=($!)

if [ -n "$OUTPUT" ]; then
	echo "Recording to $OUTPUT (sid $SID) — ctrl-c to stop"
	"${FFMPEG[@]}"
	exit 0
fi

# Live: if ffmpeg dies (radio restart, network blip past the reconnect window,
# ingest hiccup) start it again. The platforms hold the broadcast open through
# a short gap, so viewers see a brief buffer rather than an ended stream.
echo "Streaming to $PLATFORM_NAME (sid $SID) — ctrl-c to stop"
while true; do
	"${FFMPEG[@]}" && break
	echo "ffmpeg exited ($?); restarting in ${RESTART_DELAY_S}s…" >&2
	sleep "$RESTART_DELAY_S"
done
