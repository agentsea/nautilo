#!/usr/bin/env bash
#
# D103 P5.3 — path-collision smoke for the packaged Nautilo.app.
#
# macOS-first. Linux / Windows equivalents are sketched as commented
# blocks at the bottom of this file; enable them with native jobs in
# `.github/workflows/desktop-package.yml` when those targets are qualified.
#
# Two cases:
#   5.3.a — install path contains spaces  ("/tmp/has space/Apps/Nautilo.app")
#   5.3.b — app moved post-install        (Applications/ → Desktop/)
#
# Each case launches the binary, waits for it to settle, asserts the
# process is still alive, then SIGTERMs it. The harness does NOT
# require a working server (Phase 6 deferred); we only assert the
# main process didn't crash on path resolution.
#
# Usage:
#   bash scripts/smoke-paths.sh                  # default app path
#   APP_PATH=path/to/Nautilo.app bash scripts/smoke-paths.sh
#
# Exits non-zero on any failure.

set -uo pipefail

APP_PATH="${APP_PATH:-release/mac-arm64/Nautilo.app}"
BOOT_SECONDS="${BOOT_SECONDS:-20}"

# Resolve to an absolute path so cp -R works from any cwd.
if [[ ! -d "$APP_PATH" ]]; then
  echo "FAIL prerequisite: $APP_PATH does not exist (build first: bun run package:dev)" >&2
  exit 1
fi
APP_PATH_ABS="$(cd "$APP_PATH" && pwd)"

OS="$(uname -s)"
if [[ "$OS" != "Darwin" ]]; then
  echo "[smoke-paths] non-macOS detected ($OS); see commented blocks at bottom" >&2
  echo "SKIP non-macOS"
  exit 0
fi

PASS=0
FAIL=0

run_case() {
  local name="$1"
  local launch_path="$2"
  local extra_setup="${3:-}"

  echo
  echo "=== $name ==="
  if [[ -n "$extra_setup" ]]; then
    eval "$extra_setup"
  fi

  local user_data
  user_data="$(mktemp -d -t nautilo-smoke-paths)"

  echo "[case] launching: $launch_path"
  # Run unattached so the parent shell can sleep then probe + kill.
  NAUTILO_FORCE_FIRST_RUN=1 \
    "$launch_path" --user-data-dir="$user_data" \
    >/tmp/nautilo-smoke-paths.stdout 2>/tmp/nautilo-smoke-paths.stderr &
  local pid=$!

  sleep "$BOOT_SECONDS"

  if kill -0 "$pid" 2>/dev/null; then
    echo "PASS $name (pid $pid alive after ${BOOT_SECONDS}s)"
    PASS=$((PASS+1))
    kill -TERM "$pid" 2>/dev/null || true
    # Give the child up to 5s to exit, then SIGKILL stragglers.
    for _ in 1 2 3 4 5; do
      if ! kill -0 "$pid" 2>/dev/null; then break; fi
      sleep 1
    done
    kill -KILL "$pid" 2>/dev/null || true
  else
    echo "FAIL $name (pid $pid died before ${BOOT_SECONDS}s)"
    FAIL=$((FAIL+1))
    echo "--- stderr tail ---"
    tail -n 30 /tmp/nautilo-smoke-paths.stderr || true
  fi
}

# -----------------------------------------------------------------------------
# 5.3.a — spaces in install path
# -----------------------------------------------------------------------------
SPACE_DIR="/tmp/nautilo smoke/Apps"
mkdir -p "$SPACE_DIR"
rm -rf "$SPACE_DIR/Nautilo.app"
cp -R "$APP_PATH_ABS" "$SPACE_DIR/Nautilo.app"
run_case "5.3.a spaces in path" "$SPACE_DIR/Nautilo.app/Contents/MacOS/Nautilo"
rm -rf "$SPACE_DIR"

# -----------------------------------------------------------------------------
# 5.3.b — app moved post-install (simulated by copy → launch → move →
# launch from new path, all in /tmp so we don't pollute /Applications).
# -----------------------------------------------------------------------------
HOMELIKE="/tmp/nautilo-moved-from"
NEWPATH="/tmp/nautilo-moved-to"
rm -rf "$HOMELIKE" "$NEWPATH"
mkdir -p "$HOMELIKE"
cp -R "$APP_PATH_ABS" "$HOMELIKE/Nautilo.app"
run_case "5.3.b moved app — original path" "$HOMELIKE/Nautilo.app/Contents/MacOS/Nautilo"
mv "$HOMELIKE/Nautilo.app" "$NEWPATH.app"
run_case "5.3.b moved app — new path" "$NEWPATH.app/Contents/MacOS/Nautilo"
rm -rf "$HOMELIKE" "$NEWPATH.app"

echo
echo "=== smoke-paths summary ==="
echo "PASS: $PASS"
echo "FAIL: $FAIL"

if [[ "$FAIL" -gt 0 ]]; then
  exit 1
fi
exit 0

# -----------------------------------------------------------------------------
# Linux / Windows scaffolds — uncomment when CI matrix expands.
#
# # Linux (AppImage):
# #   chmod +x "$APP_PATH"
# #   "$APP_PATH" --no-sandbox --user-data-dir="$user_data" &
# #
# # Windows (PowerShell, not bash):
# #   Start-Process -FilePath "$APP_PATH" `
# #     -ArgumentList "--user-data-dir=$user_data"
# -----------------------------------------------------------------------------
