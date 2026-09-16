#!/usr/bin/env bash
# M161 Phase 5 — profile-scoped second-copy launch smoke (non-destructive).
#
# Verifies the *plumbing* that lets a second desktop process run alongside
# the first against a different server, each in its own profile-scoped
# `userData`. It does NOT launch two long-running Electron GUIs (that is
# a manual, operator-driven step documented below) and it does NOT delete
# any cache or userData tree.
#
# What this proves (pure / dry-run):
#   1. `parseProfileFromArgv` resolves `--profile <slug>` from argv.
#   2. `parseProfileFromArgv` resolves `NAUTILO_PROFILE` from env when the
#      flag is absent, and rejects a disagreeing argv/env pair.
#   3. `computeUserDataDirName` yields distinct basenames for the default
#      profile (`Nautilo`) vs `--profile work` (`Nautilo-work`) — so the
#      two copies land in isolated userData trees.
#   4. Electron's single-instance lock tuple (app name + userData) is
#      therefore distinct per profile — the second copy is NOT refused.
#   5. (Regression guard) `app.setPath("userData", …)` for the profile-
#      scoped tuple occurs BEFORE `requestSingleInstanceLock()` in
#      `electron/main.ts`, so the lock sees the profile-scoped path.
#
# Manual two-copy launch (operator-driven, not run here):
#   # Terminal A — default profile against instance beta
#   bun run desktop -- --instance beta
#
#   # Terminal B — second copy, profile `work`, distinct CDP port
#   NAUTILO_REMOTE_DEBUGGING_PORT=9223 bun run desktop -- --instance beta --profile work
#
#   # Or via env instead of the flag:
#   NAUTILO_REMOTE_DEBUGGING_PORT=9223 NAUTILO_PROFILE=work bun run desktop -- --instance beta
#
#   Expect: two windows open, neither quits; userData basenames are
#   `Nautilo-beta` and `Nautilo-beta-work` under
#   ~/Library/Application Support/ (macOS) / ~/.config (Linux).
#
# Usage (from repo root):
#   bash scripts/m161-profile-second-copy-smoke.sh
#
# Exit 0 on success; non-zero with `[m161-smoke] FAIL: <step>` on failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
DESKTOP_DIR="$REPO_ROOT/apps/desktop"
MAIN_TS="$DESKTOP_DIR/electron/main.ts"

cd "$REPO_ROOT"

smoke_fail() {
  local step="$1"
  shift
  echo "[m161-smoke] FAIL: step ${step} — $*" >&2
  exit 1
}

# ---------------------------------------------------------------------------
# 0. Sanity: bun available
# ---------------------------------------------------------------------------
command -v bun >/dev/null 2>&1 || smoke_fail 0 "bun not found on PATH"

# ---------------------------------------------------------------------------
# 1. Pure computation of basenames + parser behavior via the real modules
# ---------------------------------------------------------------------------
# A tiny TS driver imports the canonical helpers and prints JSON we assert
# on. Written to a tmpdir so we never touch the worktree.
WORK_DIR="$(mktemp -d)"
trap 'rm -rf "$WORK_DIR"' EXIT

cat > "$WORK_DIR/driver.ts" <<'TS'
import { parseProfileFromArgv } from "${DESKTOP_DIR_PLACEHOLDER}/electron/auth/profile-from-argv";
import { computeUserDataDirName } from "${DESKTOP_DIR_PLACEHOLDER}/electron/user-data-dir-name";

const APP = "Nautilo";
const INSTANCE_ID = "beta";
const isDefaultInstance = false;

const argvProfile = parseProfileFromArgv(["--profile", "work"], {});
const envProfile = parseProfileFromArgv(["electron", "dist/main.js"], { NAUTILO_PROFILE: "work" });

let disagreementThrew = false;
try {
  parseProfileFromArgv(["--profile", "work"], { NAUTILO_PROFILE: "personal" });
} catch {
  disagreementThrew = true;
}

const baseDefault = computeUserDataDirName({
  appName: APP,
  instanceId: INSTANCE_ID,
  isDefaultInstance,
  profile: undefined,
});
const baseWork = computeUserDataDirName({
  appName: APP,
  instanceId: INSTANCE_ID,
  isDefaultInstance,
  profile: argvProfile,
});

const result = {
  argvProfile,
  envProfile,
  disagreementThrew,
  baseDefault,
  baseWork,
  baseDiffer: baseDefault !== baseWork,
  // Electron's requestSingleInstanceLock is keyed on (app name, userData).
  // Distinct userData basenames => distinct lock tuples => no refusal.
  lockTupleDefault: `${APP}|${baseDefault}`,
  lockTupleWork: `${APP}|${baseWork}`,
  lockTuplesDiffer: `${APP}|${baseDefault}` !== `${APP}|${baseWork}`,
};
console.log(JSON.stringify(result, null, 2));
TS
# Substitute the absolute desktop dir (no spaces in this worktree path).
sed "s|\${DESKTOP_DIR_PLACEHOLDER}|$DESKTOP_DIR|g" "$WORK_DIR/driver.ts" > "$WORK_DIR/driver.resolved.ts"

echo "[m161-smoke] step 1: resolve profiles + compute userData basenames"
OUT="$(bun "$WORK_DIR/driver.resolved.ts")"
echo "$OUT"

ARGV_PROFILE="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).argvProfile)')"
ENV_PROFILE="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).envProfile)')"
DISAGREE="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).disagreementThrew)')"
BASE_DEFAULT="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).baseDefault)')"
BASE_WORK="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).baseWork)')"
BASE_DIFFER="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).baseDiffer)')"
LOCK_DIFFER="$(printf '%s' "$OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).lockTuplesDiffer)')"

[ "$ARGV_PROFILE" = "work" ] || smoke_fail 1 "argv --profile work resolved to '${ARGV_PROFILE}', expected 'work'"
[ "$ENV_PROFILE" = "work" ] || smoke_fail 1 "NAUTILO_PROFILE=work resolved to '${ENV_PROFILE}', expected 'work'"
[ "$DISAGREE" = "true" ] || smoke_fail 1 "disagreeing argv/env pair did NOT throw"
[ "$BASE_DEFAULT" = "Nautilo-beta" ] || smoke_fail 1 "default basename '${BASE_DEFAULT}', expected 'Nautilo-beta'"
[ "$BASE_WORK" = "Nautilo-beta-work" ] || smoke_fail 1 "work basename '${BASE_WORK}', expected 'Nautilo-beta-work'"
[ "$BASE_DIFFER" = "true" ] || smoke_fail 1 "default and work basenames collide: '${BASE_DEFAULT}'"
[ "$LOCK_DIFFER" = "true" ] || smoke_fail 1 "single-instance lock tuples collide for default vs work"
echo "[m161-smoke] argv + env resolve to 'work'; basenames '${BASE_DEFAULT}' vs '${BASE_WORK}'; lock tuples distinct"

# ---------------------------------------------------------------------------
# 2. Regression guard: profile-scoped setPath("userData") precedes the lock
# ---------------------------------------------------------------------------
echo "[m161-smoke] step 2: userData setPath precedes requestSingleInstanceLock"
SETLINE="$(grep -n 'app.setPath("userData", tupleUserData)' "$MAIN_TS" | head -1 | cut -d: -f1 || true)"
LOCKLINE="$(grep -n 'app.requestSingleInstanceLock()' "$MAIN_TS" | head -1 | cut -d: -f1 || true)"
[ -n "$SETLINE" ] || smoke_fail 2 "profile-scoped app.setPath(\"userData\", tupleUserData) not found in main.ts"
[ -n "$LOCKLINE" ] || smoke_fail 2 "app.requestSingleInstanceLock() not found in main.ts"
[ "$SETLINE" -lt "$LOCKLINE" ] || smoke_fail 2 "setPath(userData) at line ${SETLINE} must precede lock at line ${LOCKLINE}"
echo "[m161-smoke] setPath(userData)@${SETLINE} < requestSingleInstanceLock()@${LOCKLINE} — lock sees profile-scoped path"

# ---------------------------------------------------------------------------
# 3. dev script preserves --remote-debugging-port and threads NAUTILO_PROFILE
# ---------------------------------------------------------------------------
echo "[m161-smoke] step 3: dev script preserves remote-debugging-port + NAUTILO_PROFILE"
DEV_SCRIPT="$(bun -e 'console.log(require("./apps/desktop/package.json").scripts.dev)' 2>/dev/null \
  || bun -e 'import{readFileSync}from"fs";console.log(JSON.parse(readFileSync("./apps/desktop/package.json","utf8")).scripts.dev)')"
case "$DEV_SCRIPT" in
  *--remote-debugging-port=*) ;;
  *) smoke_fail 3 "dev script dropped --remote-debugging-port" ;;
esac
case "$DEV_SCRIPT" in
  *NAUTILO_PROFILE*) ;;
  *) smoke_fail 3 "dev script does not thread NAUTILO_PROFILE" ;;
esac
echo "[m161-smoke] dev script keeps --remote-debugging-port and exports NAUTILO_PROFILE"

# ---------------------------------------------------------------------------
# 4. ROOT launcher threads NAUTILO_REMOTE_DEBUGGING_PORT (Stack 198 live-QA gap)
# ---------------------------------------------------------------------------
# The live QA gap: `NAUTILO_REMOTE_DEBUGGING_PORT=9222 bun run desktop` reached
# run-desktop.ts but the launcher never appended --remote-debugging-port, so
# Electron had no CDP listener. Step 3 only proved the apps/desktop *dev*
# script threads the port; this step proves the ROOT launcher (the `desktop`
# → `app` → `scripts/run-desktop.ts` path) does too, by exercising the real,
# pure `buildDesktopArgs` helper exported from run-desktop.ts.
echo "[m161-smoke] step 4: root launcher threads NAUTILO_REMOTE_DEBUGGING_PORT"
cat > "$WORK_DIR/launcher-driver.ts" <<'TS'
import { buildDesktopArgs } from "${DESKTOP_DIR_PLACEHOLDER}/scripts/run-desktop";

const MAIN = "/smoke/main.js";

const withPort = buildDesktopArgs({
  argv: ["--profile", "work"],
  env: { NAUTILO_REMOTE_DEBUGGING_PORT: "9223" },
  mainBundlePath: MAIN,
});
const withoutPort = buildDesktopArgs({
  argv: [],
  env: {},
  mainBundlePath: MAIN,
});
const invalidPort = (() => {
  try {
    buildDesktopArgs({
      argv: [],
      env: { NAUTILO_REMOTE_DEBUGGING_PORT: "not-a-port" },
      mainBundlePath: MAIN,
    });
    return { threw: false };
  } catch (err) {
    return { threw: true, msg: (err as Error).message };
  }
})();

console.log(
  JSON.stringify(
    {
      withPortArgs: withPort.args,
      withPortFlag: withPort.args.includes("--remote-debugging-port=9223"),
      withoutPortArgs: withoutPort.args,
      withoutPortFlag: withoutPort.args.some((a) =>
        a.startsWith("--remote-debugging-port"),
      ),
      invalidPortThrew: invalidPort.threw,
    },
    null,
    2,
  ),
);
TS
sed "s|\${DESKTOP_DIR_PLACEHOLDER}|$DESKTOP_DIR|g" "$WORK_DIR/launcher-driver.ts" > "$WORK_DIR/launcher-driver.resolved.ts"
LAUNCHER_OUT="$(bun "$WORK_DIR/launcher-driver.resolved.ts")"
echo "$LAUNCHER_OUT"

WITH_FLAG="$(printf '%s' "$LAUNCHER_OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).withPortFlag)')"
WITHOUT_FLAG="$(printf '%s' "$LAUNCHER_OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).withoutPortFlag)')"
INVALID_THREW="$(printf '%s' "$LAUNCHER_OUT" | bun -e 'const d=await Bun.stdin.text();console.log(JSON.parse(d).invalidPortThrew)')"
[ "$WITH_FLAG" = "true" ] || smoke_fail 4 "root launcher did NOT append --remote-debugging-port=9223 when env set"
[ "$WITHOUT_FLAG" = "false" ] || smoke_fail 4 "root launcher appended a CDP flag when env absent (normal app path must be unchanged)"
[ "$INVALID_THREW" = "true" ] || smoke_fail 4 "root launcher accepted an invalid port (must fail before spawn)"
echo "[m161-smoke] root launcher threads NAUTILO_REMOTE_DEBUGGING_PORT; absent → no CDP flag; invalid → throws"

echo "[m161-smoke] all non-destructive verification steps passed."
echo "[m161-smoke] Manual two-copy launch (not run here): see script header."
exit 0
