#!/usr/bin/env bash
#
# Set up this repo's Buffer profile, so the Buffer CLI uses the lofi.md account
# here and whatever account is global everywhere else.
#
# The CLI resolves: flag → env → repo .buffer/config.json → ~/.config/buffer.
# It only stores apiKey in the global config, so the key stays in .env as
# BUFFER_API_KEY: every script here loads .env before calling `buffer`, and the
# env var beats the global key. organizationId and timezone go in the repo config.
#
# Fill BUFFER_API_KEY (Buffer → Settings → API) in .env, run this once, and it
# lists the organizations so you can fill BUFFER_ORGANIZATION_ID; run it again.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$ROOT_DIR"

if [ -f .env ]; then
	set -a
	# shellcheck disable=SC1091
	. ./.env
	set +a
fi

TIMEZONE="${BUFFER_TIMEZONE:-America/Sao_Paulo}"

if [ -z "${BUFFER_API_KEY:-}" ]; then
	echo "error: BUFFER_API_KEY is not set in .env" >&2
	echo "       create one in Buffer → Settings → API, logged in as the lofi.md account" >&2
	exit 2
fi

if [ -z "${BUFFER_ORGANIZATION_ID:-}" ]; then
	echo "BUFFER_ORGANIZATION_ID is empty. Organizations for this key:" >&2
	buffer account --quiet --fields 'organizations.{id,name}' --output json | jq -r '.organizations[] | "  \(.id)  \(.name)"'
	echo >&2
	echo "Put the lofi.md one in BUFFER_ORGANIZATION_ID in .env and run this again." >&2
	exit 1
fi

buffer config set --repo organizationId "$BUFFER_ORGANIZATION_ID" --quiet >/dev/null
buffer config set --repo timezone "$TIMEZONE" --quiet >/dev/null
chmod 600 .buffer/config.json

echo "Wrote $ROOT_DIR/.buffer/config.json. Resolved here:" >&2
# Sources only, never values: the API key would land in the terminal scrollback.
buffer config get --all --output json --quiet |
	jq -r '.entries[] | "  \(.key): \(.source)\(if .path then " (\(.path))" elif .envVar then " ($\(.envVar))" else "" end)"'
echo >&2

# Replace KEY=... in .env (or append it) without printing or reformatting the
# rest of the file; the API key lives there too.
set_env_var() {
	local key="$1" value="$2" tmp
	tmp="$(mktemp "$ROOT_DIR/.env.XXXXXX")"
	awk -v key="$key" -v value="$value" '
		index($0, key "=") == 1 { print key "=" value; found = 1; next }
		{ print }
		END { if (!found) print key "=" value }
	' .env >"$tmp"
	chmod --reference=.env "$tmp" 2>/dev/null || chmod 600 "$tmp"
	mv "$tmp" .env
}

channels="$(buffer channels list --organization-id "$BUFFER_ORGANIZATION_ID" --fields id,name,service --output json --quiet)"
channels="$(printf '%s' "$channels" | jq -c 'if type == "array" then . else (.channels // .items // []) end')"

echo "Channels → .env:" >&2
for svc in youtube tiktok instagram; do
	var="BUFFER_$(printf '%s' "$svc" | tr '[:lower:]' '[:upper:]')_CHANNEL_ID"
	matches="$(printf '%s' "$channels" | jq -c --arg svc "$svc" '[.[] | select((.service | ascii_downcase) == $svc)]')"
	count="$(printf '%s' "$matches" | jq length)"
	current="${!var:-}"
	if [ "$count" -eq 1 ]; then
		id="$(printf '%s' "$matches" | jq -r '.[0].id')"
		name="$(printf '%s' "$matches" | jq -r '.[0].name')"
		if [ "$current" = "$id" ]; then
			echo "  $var: unchanged ($name)" >&2
		else
			set_env_var "$var" "$id"
			echo "  $var: ${current:+updated, }set to $name" >&2
		fi
	elif [ "$count" -eq 0 ]; then
		echo "  $var: no $svc channel in this organization; left as is" >&2
	else
		# Several accounts on one network: pick by hand rather than guess.
		echo "  $var: $count $svc channels, set one by hand:" >&2
		printf '%s' "$matches" | jq -r '.[] | "    \(.id)  \(.name)"' >&2
	fi
done
