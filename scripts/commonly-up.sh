#!/usr/bin/env bash
#
# commonly-up.sh — quick-start the local Commonly agent (pod member).
#
# Replaces the old "connect via MCP server + `@commonlyai/mcp`" flow with the
# official CLI + webhook-SDK agent: `@commonlyai/cli` + `commonly agent init`.
#
# What this does on first run:
#   1. verifies the CLI (commonly) is installed/on PATH
#   2. verifies you are logged in (common login) — else prompts you to run it
#   3. scaffolds the webhook-SDK agent into scripts/commonly-agent/ (idempotent)
#   4. runs the agent, polling the pod for @mentions / DMs
#
# Registry identity matches AGENTS.md "Commonly Setup".
#   COMMONLY_POD_ID        — lives in the project's .env (shared by all members)
#   COMMONLY_AGENT_NAME    — optional override; default is derived from the host
# Agent name is sanitized to the registry charset [a-z0-9-]+ (lowercase, no quote).

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
AGENT_DIR="$REPO_ROOT/scripts/commonly-agent"

# Load the project env if present (holds COMMONLY_POD_ID for everyone).
if [ -f "$REPO_ROOT/.env" ]; then
  set -a; . "$REPO_ROOT/.env"; set +a
fi

# Map any input to the registry's valid agentName charset:
# lower-case it, drop chars outside [a-z0-9-], trim edge dashes.
sanitize_name() {
  printf '%s' "${1:-}" \
    | tr '[:upper:]' '[:lower:]' \
    | tr -cd '[a-z0-9-]' \
    | sed -E 's/^-+//; s/-+$//'
}

# Agent name precedence: user arg  >  $COMMONLY_AGENT_NAME  >  $(COMPUTERNAME)-agent
if [ -n "${1:-}" ]; then
  AGENT_NAME="$(sanitize_name "$1")"
elif [ -n "${COMMONLY_AGENT_NAME:-}" ]; then
  AGENT_NAME="$(sanitize_name "$COMMONLY_AGENT_NAME")"
else
  AGENT_NAME="$(sanitize_name "${COMPUTERNAME:-host}")-agent"
fi
if [ -z "$AGENT_NAME" ]; then
  echo "ERROR: agent name is empty after sanitization." >&2
  exit 1
fi

POD_ID="${COMMONLY_POD_ID:-6a520e34f4baa9b280bba195}"

# Python interpreter: prefer $PYTHON, else python3, else python (Windows).
if [ -n "${PYTHON:-}" ]; then PY="$PYTHON"; elif command -v python3 >/dev/null 2>&1; then PY=python3; else PY=python; fi

# ── tooling checks ────────────────────────────────────────────────────────────
if ! command -v commonly >/dev/null 2>&1; then
  echo "ERROR: 'commonly' CLI not found. Install with: npm i -g @commonlyai/cli@latest" >&2
  exit 1
fi

if [ ! -f "$HOME/.commonly/config.json" ]; then
  echo "Not logged in. Run in a terminal: commonly login   (then re-run this script)"
  exit 1
fi

# ── scaffold once (clobber-protection makes this idempotent) ─────────────────
mkdir -p "$AGENT_DIR"
if [ ! -f "$AGENT_DIR/.commonly-env" ]; then
  echo "[commonly-up] scaffolding agent '$AGENT_NAME' into $AGENT_DIR"
  # NOTE: @commonlyai/cli@0.1.11 init reads SDK/bot templates from an
  # `@commonlyai/examples` path that npm does not ship, so a fresh install may
  # fail with "ENOENT ... examples/sdk/python/commonly.py". Workaround: place
  # the canonical templates there from the repo (see AGENTS.md "Commonly Setup").
  commonly agent init \
    --language python \
    --name "$AGENT_NAME" \
    --pod "$POD_ID" \
    --dir "$AGENT_DIR"
fi

# ── run the agent (webhook SDK polls the pod) ────────────────────────────────
echo "[commonly-up] running '$AGENT_NAME' in pod $POD_ID (Ctrl+C to stop)"
cd "$AGENT_DIR"
export COMMONLY_TOKEN="$(cat .commonly-env | sed -n 's/^COMMONLY_TOKEN=//p' | tr -d "'\"")"
"$PY" "$AGENT_NAME.py"