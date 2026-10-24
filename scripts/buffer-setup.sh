#!/usr/bin/env bash
#
# Write this repo's Buffer profile to .buffer/config.json, so the Buffer CLI uses
# the lofi.md account here and whatever account is global everywhere else.
#
# The CLI resolves: flag → env → repo .buffer/config.json → ~/.config/buffer.
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
	buffer account --fields 'organizations.{id,name}' --output json | jq -r '.organizations[] | "  \(.id)  \(.name)"'
	echo >&2
	echo "Put the lofi.md one in BUFFER_ORGANIZATION_ID in .env and run this again." >&2
	exit 1
fi

buffer config set --repo apiKey "$BUFFER_API_KEY" >/dev/null
buffer config set --repo organizationId "$BUFFER_ORGANIZATION_ID" >/dev/null
buffer config set --repo timezone "$TIMEZONE" >/dev/null
chmod 600 .buffer/config.json

echo "Wrote $ROOT_DIR/.buffer/config.json:" >&2
# Sources only, never values: the API key would land in the terminal scrollback.
buffer config get --all --output json |
	jq -r '.entries[] | "  \(.key): \(.source)\(if .path then " (\(.path))" elif .envVar then " ($\(.envVar))" else "" end)"'
echo >&2
echo "Channels for this profile (copy the ids into BUFFER_*_CHANNEL_ID in .env):" >&2
buffer channels list --fields 'items.{id,service,name}' --output json |
	jq -r '.items[] | "  \(.service)\t\(.id)\t\(.name)"'
