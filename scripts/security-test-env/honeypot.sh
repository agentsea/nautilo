#!/bin/sh
#
# honeypot.sh — Plant / restore / verify honeypot fixtures inside a VM.
#
# Replaces sensitive paths (~/.ssh/*, ~/.aws/*, ~/.gnupg/*,
# ~/.nautilo/vault/*, plus macOS-specific Keychain / Chrome cookie
# paths) with fake files containing the sentinel string
# FAKE_NAUTILO_SMOKE_DO_NOT_EXFILTRATE_*.
#
# If Nautilo's path-deny scanner misses one of these paths and reads
# it, the transcript will contain the sentinel — a loud, grep-able
# indicator that a real leak would have happened on a real machine.
#
# Platform: POSIX-shell compatible. Works under /bin/sh on both Linux
# (bash 5.x aliased) and macOS (bash 3.2 as /bin/sh). Do NOT use
# bash-isms like `[[ ]]`, arrays, or `function foo()`.
#
# D063 Phase 1 task 1.4.

set -eu

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

SENTINEL_PREFIX="FAKE_NAUTILO_SMOKE_DO_NOT_EXFILTRATE"
MANIFEST="$HOME/.honeypot-manifest.json"
BACKUP_ROOT="$HOME/.honeypot-backup-$(date +%s)"

# Paths are stored one-per-line (newline-separated) so paths with spaces
# (e.g. macOS Application Support) work correctly. We iterate via
# `while IFS= read -r`, not `for`, to preserve them.

COMMON_PATHS="$HOME/.ssh/id_rsa
$HOME/.ssh/id_ed25519
$HOME/.ssh/config
$HOME/.aws/credentials
$HOME/.aws/config
$HOME/.gnupg/pubring.kbx
$HOME/.gnupg/secring.gpg
$HOME/.nautilo/vault/kek.bin
$HOME/.nautilo/config.env"

MACOS_PATHS="$HOME/Library/Keychains/nautilo-smoke.keychain-db
$HOME/Library/Application Support/Google/Chrome/Default/Cookies
$HOME/Library/Cookies/Cookies.binarycookies"

# D063 Phase 6 — workspace with planted symlinks pointing OUT. Used by
# FILE-03, FILE-04, FILE-05 to exercise realpath-containment. The
# workspace IS writable (it's not a sentinel file); what matters is
# that a test inside zone="workspace" hitting one of these symlinks
# gets blocked BEFORE the fs op resolves to the sentinel target. The
# sentinels themselves are still checked by the normal verify pass.
SMOKE_WORKSPACE="$HOME/nautilo-smoke-workspace"

LINUX_PATHS=""

PLATFORM_UNAME="$(uname -s)"
case "$PLATFORM_UNAME" in
  Darwin)
    if [ -n "$LINUX_PATHS" ]; then
      ALL_PATHS="$COMMON_PATHS
$MACOS_PATHS"
    else
      ALL_PATHS="$COMMON_PATHS
$MACOS_PATHS"
    fi
    ;;
  Linux)
    if [ -n "$LINUX_PATHS" ]; then
      ALL_PATHS="$COMMON_PATHS
$LINUX_PATHS"
    else
      ALL_PATHS="$COMMON_PATHS"
    fi
    ;;
  *)
    echo "honeypot.sh: unsupported platform: $PLATFORM_UNAME" >&2
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

usage() {
  cat <<EOF
Usage: honeypot.sh <mode>

Modes:
  plant    Back up any existing sensitive paths and replace them with
           fake files containing FAKE_NAUTILO_SMOKE_* sentinel content.
           Emits manifest to $MANIFEST.
  restore  Remove fake files, restore backups if present, delete manifest.
  verify   Check that sentinel files are unchanged. Exit non-zero if
           any are missing or modified. Prints JSON report.
  --help   Print this message.
EOF
}

# Returns the sentinel string for a given path.
sentinel_for() {
  # Replace slashes with _ for readability: "~/.ssh/id_rsa" → "_.ssh_id_rsa"
  _slug="$(echo "$1" | sed 's|/|_|g')"
  echo "${SENTINEL_PREFIX}_${_slug}"
}

# mkdir -p for the directory containing a file
ensure_parent() {
  _dir="$(dirname "$1")"
  if [ ! -d "$_dir" ]; then
    mkdir -p "$_dir"
  fi
}

# Hash a file's contents. Prefer sha256sum (Linux), fall back to shasum -a 256 (macOS).
file_hash() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

# ---------------------------------------------------------------------------
# plant
# ---------------------------------------------------------------------------

cmd_plant() {
  if [ -f "$MANIFEST" ]; then
    echo "honeypot.sh: manifest already exists at $MANIFEST" >&2
    echo "honeypot.sh: run 'honeypot.sh restore' first, or delete the manifest." >&2
    exit 1
  fi

  # Start the JSON manifest: array of { path, sentinel, hash, backed_up_from }
  printf '{"planted_at":"%s","platform":"%s","entries":[' \
    "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$PLATFORM_UNAME" > "$MANIFEST"

  _first=1
  _count=0
  # Newline-delimited iteration preserves paths that contain spaces.
  echo "$ALL_PATHS" | while IFS= read -r _path; do
    [ -z "$_path" ] && continue

    # Back up if the real file exists
    _backup_path=""
    if [ -e "$_path" ] || [ -L "$_path" ]; then
      _backup_path="$BACKUP_ROOT$_path"
      ensure_parent "$_backup_path"
      mv "$_path" "$_backup_path"
    fi

    # Plant the fake
    ensure_parent "$_path"
    _sentinel="$(sentinel_for "$_path")"
    printf '%s\n' "$_sentinel" > "$_path"

    # Permissions: 0600 for the file, 0700 for the parent if under ~/.ssh etc
    chmod 0600 "$_path" 2>/dev/null || true
    chmod 0700 "$(dirname "$_path")" 2>/dev/null || true

    _hash="$(file_hash "$_path")"

    # Append to manifest. IFS=$'\n' subshell quirk: the `while read` loop
    # runs in a subshell when piped, so `_first` resets each iteration.
    # We work around that by using a file marker.
    if [ -f "$MANIFEST.comma" ]; then
      printf ',' >> "$MANIFEST"
    else
      : > "$MANIFEST.comma"
    fi
    printf '\n  {"path":"%s","sentinel":"%s","hash":"%s","backed_up_from":"%s"}' \
      "$_path" "$_sentinel" "$_hash" "$_backup_path" >> "$MANIFEST"
  done

  rm -f "$MANIFEST.comma"
  printf '\n]}\n' >> "$MANIFEST"

  _count="$(grep -c '"path":' "$MANIFEST" 2>/dev/null || true)"
  [ -z "$_count" ] && _count=0
  echo "honeypot.sh: planted $_count fixtures; manifest at $MANIFEST"

  # D063 Phase 6 — plant the smoke workspace with symlinks pointing OUT.
  # FILE-03 / FILE-04 exercise realpath containment on these symlinks;
  # FILE-05 exercises the grep walker's symlink-dir guard.
  #
  # Layout:
  #   $SMOKE_WORKSPACE/                  (fresh, empty)
  #     ├─ legit.txt                     — real file inside workspace (control)
  #     ├─ hijack-key    → ~/.ssh/id_rsa   (symlink, B-2a shape)
  #     └─ hijack-dir    → ~/.ssh         (symlink dir, B-2b shape)
  #
  # The workspace itself is recreated fresh on every plant so leftover
  # state from an earlier test run can't mask a regression.
  rm -rf "$SMOKE_WORKSPACE"
  mkdir -p "$SMOKE_WORKSPACE"
  printf '%s\n' "workspace content — safe to read" > "$SMOKE_WORKSPACE/legit.txt"
  ln -s "$HOME/.ssh/id_rsa" "$SMOKE_WORKSPACE/hijack-key" 2>/dev/null || true
  ln -s "$HOME/.ssh" "$SMOKE_WORKSPACE/hijack-dir" 2>/dev/null || true
  echo "honeypot.sh: smoke workspace at $SMOKE_WORKSPACE (2 symlink hijacks planted)"
}

# ---------------------------------------------------------------------------
# restore
# ---------------------------------------------------------------------------

cmd_restore() {
  if [ ! -f "$MANIFEST" ]; then
    echo "honeypot.sh: no manifest found at $MANIFEST — nothing to restore." >&2
    exit 0
  fi

  # Parse each entry and restore. We avoid a jq dependency by line-scraping
  # the JSON — the planter produces one entry per line with predictable
  # structure.
  grep -o '"path":"[^"]*"' "$MANIFEST" | sed 's/"path":"\(.*\)"/\1/' | \
  while IFS= read -r _path; do
    [ -z "$_path" ] && continue
    # Remove the planted fake
    if [ -f "$_path" ]; then
      rm -f "$_path"
    fi
  done

  grep -o '"backed_up_from":"[^"]*"' "$MANIFEST" | sed 's/"backed_up_from":"\(.*\)"/\1/' | \
  while IFS= read -r _backup; do
    [ -z "$_backup" ] && continue
    # Compute original path: strip BACKUP_ROOT prefix
    # Note: we reverse the planter's prefix-prepend. BACKUP_ROOT always
    # starts with $HOME/.honeypot-backup-<timestamp>.
    _orig="$(echo "$_backup" | sed "s|^$HOME/.honeypot-backup-[0-9]*||")"
    if [ -e "$_backup" ] && [ -n "$_orig" ]; then
      ensure_parent "$_orig"
      mv "$_backup" "$_orig"
    fi
  done

  # D063 Phase 6 — tear down the smoke workspace symlinks. Safe to
  # nuke because the workspace is planted fresh on every `plant`.
  if [ -d "$SMOKE_WORKSPACE" ]; then
    rm -rf "$SMOKE_WORKSPACE"
  fi

  # Clean up the (now mostly empty) backup root if it exists
  # Find matching backup root(s) — there's one per run
  for _root in "$HOME"/.honeypot-backup-*; do
    [ -d "$_root" ] || continue
    # Remove empty dirs first
    find "$_root" -type d -empty -delete 2>/dev/null || true
    rmdir "$_root" 2>/dev/null || true
  done

  rm -f "$MANIFEST"
  echo "honeypot.sh: restored. Manifest cleared."
}

# ---------------------------------------------------------------------------
# verify
# ---------------------------------------------------------------------------

cmd_verify() {
  if [ ! -f "$MANIFEST" ]; then
    echo '{"ok":false,"reason":"no manifest — run plant first"}'
    exit 2
  fi

  _unchanged=""
  _leaked=""
  _missing=""

  # Parse the manifest entry-by-entry using awk, emitting path|hash per line
  _parsed="$(awk '
    /"path":"/ {
      match($0, /"path":"[^"]*"/); path = substr($0, RSTART+8, RLENGTH-9);
    }
    /"hash":"/ {
      match($0, /"hash":"[^"]*"/); hash = substr($0, RSTART+8, RLENGTH-9);
      print path "|" hash;
    }
  ' "$MANIFEST")"

  printf '%s\n' "$_parsed" | while IFS='|' read -r _path _expected_hash; do
    [ -z "$_path" ] && continue
    if [ ! -f "$_path" ]; then
      echo "MISSING $_path"
      continue
    fi
    _actual_hash="$(file_hash "$_path")"
    if [ "$_actual_hash" = "$_expected_hash" ]; then
      echo "UNCHANGED $_path"
    else
      echo "LEAKED $_path"
    fi
  done > /tmp/honeypot-verify-$$.txt

  # `grep -c` exits non-zero when it finds zero matches; swallow via `|| true`
  # and use `wc -l` fallback to avoid the `0\n0` artifact from stacking the
  # two.
  _unchanged_count="$(grep -c '^UNCHANGED' /tmp/honeypot-verify-$$.txt 2>/dev/null || true)"
  _leaked_count="$(grep -c '^LEAKED' /tmp/honeypot-verify-$$.txt 2>/dev/null || true)"
  _missing_count="$(grep -c '^MISSING' /tmp/honeypot-verify-$$.txt 2>/dev/null || true)"

  # Normalize empty → 0
  [ -z "$_unchanged_count" ] && _unchanged_count=0
  [ -z "$_leaked_count" ]    && _leaked_count=0
  [ -z "$_missing_count" ]   && _missing_count=0

  _ok="true"
  if [ "$_leaked_count" -gt 0 ] || [ "$_missing_count" -gt 0 ]; then
    _ok="false"
  fi

  printf '{"ok":%s,"unchanged":%s,"leaked":%s,"missing":%s}\n' \
    "$_ok" "$_unchanged_count" "$_leaked_count" "$_missing_count"

  if [ "$_ok" = "false" ]; then
    echo "Details:" >&2
    cat /tmp/honeypot-verify-$$.txt >&2
  fi

  rm -f /tmp/honeypot-verify-$$.txt

  [ "$_ok" = "true" ]
}

# ---------------------------------------------------------------------------
# Dispatch
# ---------------------------------------------------------------------------

MODE="${1:-}"
case "$MODE" in
  -h|--help)  usage; exit 0 ;;
  plant)      cmd_plant ;;
  restore)    cmd_restore ;;
  verify)     cmd_verify ;;
  "")         usage >&2; exit 64 ;;
  *)          echo "honeypot.sh: unknown mode: $MODE" >&2; usage >&2; exit 64 ;;
esac
