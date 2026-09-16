#!/usr/bin/env bash
# Read-only: load Google API key from Nautilo instance.env and POST to Generative Language API
# Mirrors packages/config-guard Google health check (model must stay on a
# Generative Language API id that accepts new API keys; gemini-2.0-flash 404s for those).
# Does not print the key. Usage: bash ops/security/google-key-probe.sh

set -euo pipefail

HOME_DIR="${HOME:-/tmp}"
if [[ -n "${NAUTILO_DOTENV_PATH:-}" ]]; then
  ENV_FILE="$NAUTILO_DOTENV_PATH"
else
  ENV_FILE="$HOME_DIR/.nautilo/instance.env"
fi

if [[ ! -f "$ENV_FILE" ]]; then
  echo "instance.env not found at: $ENV_FILE"
  exit 2
fi

read_val() {
  local name="$1"
  local line
  line="$(grep -E "^${name}=" "$ENV_FILE" 2>/dev/null | tail -n1 || true)"
  [[ -n "$line" ]] || return 1
  local val="${line#*=}"
  val="${val//$'\r'/}"
  # strip optional double quotes (bash 3.2–safe)
  val="$(printf '%s' "$val" | sed 's/^"//;s/"$//')"
  printf '%s' "$val"
}

KEY=""
KEY_VAR=""
for v in GOOGLE_API_KEY GOOGLE_GENERATIVE_AI_API_KEY GEMINI_API_KEY; do
  if k="$(read_val "$v" 2>/dev/null)" && [[ -n "$k" ]]; then
    KEY="$k"
    KEY_VAR="$v"
    break
  fi
done

if [[ -z "${KEY:-}" ]]; then
  echo "No Google API key found in $ENV_FILE (tried GOOGLE_API_KEY, GOOGLE_GENERATIVE_AI_API_KEY, GEMINI_API_KEY)"
  exit 3
fi

OUT="$(mktemp)"
trap 'rm -f "$OUT"' EXIT

URL="https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${KEY}"
HTTP="$(curl -sS -m 15 -o "$OUT" -w "%{http_code}" -X POST "$URL" \
  -H "content-type: application/json" \
  -d '{"contents":[{"parts":[{"text":"hi"}]}]}' || true)"

echo "env_file=$ENV_FILE"
echo "key_var=$KEY_VAR"
echo "http_status=$HTTP"
if [[ "$HTTP" == "200" ]]; then
  echo "result=ok (Generative Language API accepted the key for gemini-2.5-flash generateContent)"
elif [[ "$HTTP" == "401" || "$HTTP" == "403" ]]; then
  echo "result=auth_failed (key rejected or insufficient permission)"
else
  echo "result=unexpected_http"
fi
if [[ "$HTTP" != "200" ]] && [[ -s "$OUT" ]]; then
  head -c 500 "$OUT" | tr '\n' ' '
  echo
fi
