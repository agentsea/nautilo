/**
 * `dev:nuke-client-cache` — wipe Electron renderer-side state for a
 * specific (instance, profile) tuple. Single command, single atomic
 * operation, single allow-list of paths. No "and also" footguns.
 *
 * ISSUE-D156 (with the 2026-05-16 Architecture amendment that ships
 * the per-instance Electron userData segregation alongside this nuke
 * command).
 *
 * # When to use this
 *
 * The SERVER + DB + instance config are fine and you want to wipe ONLY
 * the renderer-side cache (Local Storage / IndexedDB / Cache / etc.) so
 * you can re-test a UI change against the real backend state, OR you've
 * hit a stale-cache symptom where the renderer is showing data from a
 * prior build that doesn't match server reality.
 *
 * For a full instance wipe (Postgres data, server PID file, log file,
 * ALL profiles' caches, everything in `~/.nautilo${suffix}/`), use
 * `bun run dev:cleanup-instances` or `bun run dev:delete-instance`
 * instead — those have different blast radius + different guards.
 *
 * # Coverage matrix (paths this command DELETES, per profile, per instance)
 *
 * Under `<userData>` (resolved via `computeUserDataDirName(...)` from
 * `apps/desktop/electron/user-data-dir-name.ts` — the SAME formula
 * Electron `main.ts` uses for `setPath("userData", ...)`, so the two
 * agree on what directory belongs to a given tuple):
 *
 *   <userData>/Local Storage/              — renderer Web Storage
 *   <userData>/IndexedDB/                  — renderer IndexedDB (RxDB, app caches)
 *   <userData>/Session Storage/            — renderer Session Storage
 *   <userData>/Cache/                      — HTTP cache
 *   <userData>/Code Cache/                 — V8 compiled-code cache
 *   <userData>/GPUCache/                   — GPU shader cache
 *   <userData>/logs/                       — Electron log files for this tuple
 *   <userData>/config.json                 — D057 first-run pairing choice
 *   <userData>/auth.json                   — legacy v1 auth bundle
 *   <userData>/paired-server-identity.json — Stack 19 Phase 2.2 fingerprint
 *   <userData>/relay-token-*.json          — M097 per-server-scope relay tokens
 *
 * Under `~/.nautilo${suffix}/` (instance-scoped, resolved via
 * `resolveNautiloRootDir` from `@nautilo/config`):
 *
 *   ~/.nautilo${suffix}/desktop-auth.json              — for default profile
 *   ~/.nautilo${suffix}/desktop-auth-<profile>.json    — for named profile
 *
 * # Coverage matrix (paths this command DOES NOT delete — preserved)
 *
 *   <userData>/Crashpad/                    — Electron crash dumps; debug
 *                                              data, not stale state. Preserved
 *                                              so post-mortem traces survive.
 *   <userData>/installation-id.json         — D418 stable pairing identity.
 *                                              NOT a credential; deliberately
 *                                              survives sign-out / token
 *                                              clearing / re-pair, so the nuke
 *                                              wipe must NOT touch it (only
 *                                              relay-token-*.json are wiped).
 *                                              Mechanically preserved because
 *                                              the relay-token discovery regex
 *                                              /^relay-token.*\.json$/ does
 *                                              not match this filename and no
 *                                              explicit target entry adds it.
 *   ~/.nautilo${suffix}/instance.env        — server-side state. Use
 *   ~/.nautilo${suffix}/instance.json       —   dev:delete-instance or
 *   ~/.nautilo${suffix}/server.pid          —   dev:cleanup-instances.
 *   ~/.nautilo${suffix}/workbench-vite.pid  —
 *   ~/.nautilo${suffix}/logs/               —
 *   ~/.nautilo${suffix}/logto-admin.txt     —
 *
 *   ~/.nautilo/recent-current-folders.json  — operator-identity files
 *   ~/.nautilo/state/genie-workspace.json   —   (Option-c carve-out per
 *                                                D156 Architecture amendment
 *                                                — belongs to the human, not
 *                                                to any specific server).
 *
 *   ~/.config/nautilo/deploy.toml           — operator config; sledgehammer-scoped
 *                                              destructive op out of scope.
 *
 * # Guards
 *
 * - `--instance <name>` REQUIRED. No flag → exit 2.
 * - `--instance default` (or `--instance ""`) HARD refuses without
 *   `--yes --i-know-what-i-am-doing` (typo-defense for the most-blast-
 *   radius case; the default-instance Electron userData was the
 *   pre-Stack-19 shared dir for early operators so wiping it is the
 *   "legacy soup cleanup" migration path — still requires the extra
 *   confirm).
 * - Electron currently running on the target userData → exit 1 with
 *   "stop Electron first" + PID. Uses Phase 3.A's
 *   `probeInstanceProcessState` for the running check.
 * - Target userData dir doesn't exist → friendly no-op (exit 0, not an
 *   error — operator may be re-running the command for an instance
 *   that was already cleaned).
 *
 * # Dry-run default + atomic stage-then-delete
 *
 * Without `--yes`: prints what WOULD be deleted with byte sizes; exits 0
 * deleting nothing.
 *
 * With `--yes`: stages each target path to a sibling staging dir via
 * atomic `rename(2)`. If ALL renames succeed, `rm -rf` the staging dir.
 * If ANY rename fails, leave the staging dir + abort with clear error
 * — nothing is half-deleted. The operator can `mv` the staged contents
 * back to recover from a botched run.
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { resolveNautiloRootDir } from "@nautilo/config";
import { computeUserDataDirName } from "../../../../apps/desktop/electron/user-data-dir-name";
import { probeInstanceProcessState } from "../lib/process-state";
import { formatBytes } from "../lib/format-bytes";
import { formatHelp, hasHelpFlag, type HelpSpec } from "../lib/cli-help";

/** Matches `apps/desktop/electron/constants.ts:38` — single source of truth there. */
const APP_NAME = "Nautilo";

/** macOS Electron userData base. v1 is macOS-only per ISSUE-D156. */
const MACOS_APP_SUPPORT = "Library/Application Support";

const NUKE_HELP: HelpSpec = {
  name: "dev:nuke-client-cache",
  summary:
    "Atomic wipe of Electron renderer-side state for one (instance, profile) tuple. Dry-run by default.",
  usage:
    "bun run dev:nuke-client-cache --instance <name> [--profile <name>] [--yes] [--i-know-what-i-am-doing] [--json]",
  flags: [
    {
      flag: "--instance <name>",
      description:
        "Target instance id (REQUIRED). Use 'default' for the default instance; that case requires --i-know-what-i-am-doing.",
    },
    {
      flag: "--profile <name>",
      description: "Target profile (default: the default profile).",
    },
    {
      flag: "--yes",
      description:
        "Execute the wipe. Without --yes, prints what would be deleted + byte sizes and exits 0.",
    },
    {
      flag: "--i-know-what-i-am-doing",
      description:
        "REQUIRED with --yes when --instance is 'default' (or unset). Typo defense for the most-blast-radius case.",
    },
    { flag: "--json", description: "Emit structured plan/report instead of human prose." },
    { flag: "--help, -h", description: "Show this help and exit." },
  ],
  examples: [
    {
      cmd: "bun run dev:nuke-client-cache --instance smoke-stack19",
      desc: "Dry-run: list paths + sizes for the smoke-stack19 default-profile tuple; deletes nothing.",
    },
    {
      cmd: "bun run dev:nuke-client-cache --instance smoke-stack19 --yes",
      desc: "Execute the wipe atomically.",
    },
    {
      cmd: "bun run dev:nuke-client-cache --instance smoke-stack19 --profile galina --yes",
      desc: "Wipe ONLY the galina-profile cache for smoke-stack19; default profile cache left intact.",
    },
    {
      cmd: "bun run dev:nuke-client-cache --instance default --yes --i-know-what-i-am-doing",
      desc: "MIGRATION RECIPE (Stack 19): wipe the pre-Stack-19 shared default userData soup that accumulated across instance switches.",
    },
  ],
  notes: [
    "Coverage matrix + carve-outs (which files survive) documented in nuke-client-cache.ts's top-of-file comment.",
    "Refuses to run while Electron is alive for the target (instance, profile). Stop Electron first.",
    "Atomic stage-then-delete via rename(2). On any per-path failure, the staging dir is left in place + the command aborts; nothing is half-deleted.",
    "macOS only at v1. Windows / Linux added when needed (Electron's userData base differs per platform).",
  ],
};

export interface NukeClientCacheOptions {
  instance: string;
  profile: string | undefined;
  yes: boolean;
  iKnowWhatIAmDoing: boolean;
  asJson: boolean;
}

type ParsedCli =
  | { ok: true; opts: NukeClientCacheOptions }
  | { ok: false; exitCode: number; message: string };

export function parseNukeClientCacheArgs(argv: string[]): ParsedCli {
  let instance: string | undefined;
  let profile: string | undefined;
  let yes = false;
  let iKnowWhatIAmDoing = false;
  let asJson = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--yes") yes = true;
    else if (a === "--i-know-what-i-am-doing") iKnowWhatIAmDoing = true;
    else if (a === "--json") asJson = true;
    else if (a === "--instance") {
      i++;
      const v = argv[i];
      if (v === undefined) {
        return { ok: false, exitCode: 2, message: "--instance requires a value (use --instance <name> or --instance default)" };
      }
      instance = v.trim();
    } else if (a === "--profile") {
      i++;
      const v = argv[i];
      if (v === undefined) {
        return { ok: false, exitCode: 2, message: "--profile requires a value" };
      }
      profile = v.trim() === "" ? undefined : v.trim();
    } else if (a === undefined) {
      // skip
    } else {
      return { ok: false, exitCode: 2, message: `Unknown flag: ${a}\n\nRun \`bun run dev:nuke-client-cache --help\` for usage.` };
    }
  }

  if (instance === undefined) {
    return {
      ok: false,
      exitCode: 2,
      message:
        "--instance <name> is REQUIRED. Use 'default' for the default instance (also requires --i-know-what-i-am-doing).\n\nRun `bun run dev:nuke-client-cache --help` for usage.",
    };
  }

  return {
    ok: true,
    opts: { instance, profile, yes, iKnowWhatIAmDoing, asJson },
  };
}

/**
 * Coverage matrix item: a path that nuke deletes, with its category for
 * the dry-run report.
 */
interface NukeTarget {
  path: string;
  category:
    | "renderer-storage"
    | "renderer-cache"
    | "electron-logs"
    | "auth-config"
    | "desktop-auth";
  isDirectory: boolean;
}

/** Walks a directory tree and returns total byte size. Cheap synchronous stat. */
function dirSizeBytes(p: string): number {
  let total = 0;
  for (const entry of readdirSync(p, { withFileTypes: true })) {
    const child = join(p, entry.name);
    try {
      if (entry.isDirectory()) {
        total += dirSizeBytes(child);
      } else if (entry.isFile()) {
        total += statSync(child).size;
      }
    } catch {
      /* deleted between readdir and stat — ignore */
    }
  }
  return total;
}

function pathSizeBytes(p: string): number {
  try {
    const st = statSync(p);
    return st.isDirectory() ? dirSizeBytes(p) : st.size;
  } catch {
    return 0;
  }
}

/** Reads `<userData>` for `relay-token-*.json` files (M097 per-scope tokens). */
export function discoverRelayTokens(userDataDir: string): string[] {
  if (!existsSync(userDataDir)) return [];
  try {
    return readdirSync(userDataDir)
      .filter((n) => /^relay-token.*\.json$/.test(n))
      .map((n) => join(userDataDir, n));
  } catch {
    return [];
  }
}

interface ResolvedTargets {
  userDataDir: string;
  desktopAuthFile: string;
  desktopAuthExists: boolean;
  targets: NukeTarget[];
  userDataDirExists: boolean;
}

function resolveNukeTargets(opts: NukeClientCacheOptions): ResolvedTargets {
  const isDefaultInstance =
    opts.instance === "default" || opts.instance === "" || opts.instance === "(default)";
  // resolveNautiloRootDir reads NAUTILO_INSTANCE_ID from env; we want the
  // instance the operator passed, NOT whatever the orchestrator's shell has.
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NAUTILO_INSTANCE_ID: isDefaultInstance ? "" : opts.instance,
  };
  const nautiloRoot = resolveNautiloRootDir({ env: childEnv });

  const userDataDirName = computeUserDataDirName({
    appName: APP_NAME,
    instanceId: isDefaultInstance ? "" : opts.instance,
    isDefaultInstance,
    profile: opts.profile,
  });
  const userDataBase = join(homedir(), MACOS_APP_SUPPORT);
  const userDataDir = join(userDataBase, userDataDirName);
  const userDataDirExists = existsSync(userDataDir);

  const desktopAuthName =
    opts.profile === undefined || opts.profile === ""
      ? "desktop-auth.json"
      : `desktop-auth-${opts.profile}.json`;
  const desktopAuthFile = join(nautiloRoot, desktopAuthName);
  const desktopAuthExists = existsSync(desktopAuthFile);

  const targets: NukeTarget[] = [];
  const addIfExists = (p: string, category: NukeTarget["category"], isDirectory: boolean) => {
    if (existsSync(p)) targets.push({ path: p, category, isDirectory });
  };

  if (userDataDirExists) {
    addIfExists(join(userDataDir, "Local Storage"), "renderer-storage", true);
    addIfExists(join(userDataDir, "IndexedDB"), "renderer-storage", true);
    addIfExists(join(userDataDir, "Session Storage"), "renderer-storage", true);
    addIfExists(join(userDataDir, "Cache"), "renderer-cache", true);
    addIfExists(join(userDataDir, "Code Cache"), "renderer-cache", true);
    addIfExists(join(userDataDir, "GPUCache"), "renderer-cache", true);
    addIfExists(join(userDataDir, "logs"), "electron-logs", true);
    addIfExists(join(userDataDir, "config.json"), "auth-config", false);
    addIfExists(join(userDataDir, "auth.json"), "auth-config", false);
    addIfExists(join(userDataDir, "paired-server-identity.json"), "auth-config", false);
    for (const tokenFile of discoverRelayTokens(userDataDir)) {
      targets.push({ path: tokenFile, category: "auth-config", isDirectory: false });
    }
  }
  if (desktopAuthExists) {
    targets.push({ path: desktopAuthFile, category: "desktop-auth", isDirectory: false });
  }

  return { userDataDir, desktopAuthFile, desktopAuthExists, targets, userDataDirExists };
}

function printDryRunReport(
  opts: NukeClientCacheOptions,
  resolved: ResolvedTargets,
): void {
  const profileLabel = opts.profile ?? "(default profile)";
  const instanceLabel = opts.instance === "" ? "(default)" : opts.instance;

  if (opts.asJson) {
    console.log(
      JSON.stringify(
        {
          mode: "dry-run",
          instance: instanceLabel,
          profile: profileLabel,
          userDataDir: resolved.userDataDir,
          userDataDirExists: resolved.userDataDirExists,
          desktopAuthFile: resolved.desktopAuthFile,
          desktopAuthExists: resolved.desktopAuthExists,
          targets: resolved.targets.map((t) => ({
            ...t,
            sizeBytes: pathSizeBytes(t.path),
          })),
          totalBytes: resolved.targets.reduce((sum, t) => sum + pathSizeBytes(t.path), 0),
        },
        null,
        2,
      ),
    );
    return;
  }

  console.log(`Nautilo dev:nuke-client-cache — DRY RUN (no changes made).`);
  console.log();
  console.log(`Instance: ${instanceLabel}    Profile: ${profileLabel}`);
  console.log(`Electron userData: ${resolved.userDataDir}`);
  console.log(`Per-instance auth: ${resolved.desktopAuthFile}`);
  console.log();
  if (!resolved.userDataDirExists && !resolved.desktopAuthExists) {
    console.log(
      `Nothing to do — neither the userData dir nor the desktop-auth file exists for this (instance, profile).`,
    );
    return;
  }
  console.log(`Would delete ${resolved.targets.length} path(s):`);
  console.log();
  let total = 0;
  for (const t of resolved.targets) {
    const sz = pathSizeBytes(t.path);
    total += sz;
    const kind = t.isDirectory ? "dir " : "file";
    console.log(`  [${kind}] ${formatBytes(sz).padStart(8)}  ${t.path}`);
  }
  console.log();
  console.log(`Total: ${formatBytes(total)} across ${resolved.targets.length} path(s).`);
  console.log();
  console.log(`To execute: re-run with --yes${opts.instance === "default" || opts.instance === "" ? " --i-know-what-i-am-doing" : ""}.`);
}

interface NukeExecuteResult {
  staged: string[];           // (target, stagedAt) pairs that succeeded
  failedAt: string | null;    // path that failed to stage, or null
  stagingDir: string;
}

/**
 * Atomic stage-then-delete. All targets are renamed (atomic on same
 * filesystem; cross-filesystem renames will fail loudly here, which is
 * the right behavior — we don't want a partial copy). If ALL renames
 * succeed, rm -rf the staging dir; if ANY fails, leave the staging dir
 * in place with whatever was already moved so the operator can recover
 * via `mv`.
 */
function executeNuke(resolved: ResolvedTargets): NukeExecuteResult {
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const stagingDir = join(homedir(), `.nautilo-nuke-staging-${ts}`);
  mkdirSync(stagingDir, { recursive: true });

  const staged: string[] = [];
  for (const t of resolved.targets) {
    const stagedAt = join(stagingDir, basename(t.path));
    try {
      renameSync(t.path, stagedAt);
      staged.push(stagedAt);
    } catch {
      return { staged, failedAt: t.path, stagingDir };
    }
  }
  // All renames succeeded — atomic delete.
  rmSync(stagingDir, { recursive: true, force: true });
  return { staged, failedAt: null, stagingDir };
}

/**
 * Stack 19 Phase 6.9.4 (2026-05-17) — real Electron-on-this-userData
 * detection.
 *
 * Pre-fix this function only checked whether the per-instance SERVER
 * was running via Phase 3.A's probe. Reviewer's BLOCK High-#4
 * finding: "Operator who stopped server but left Electron open
 * → --yes will rename/delete active renderer storage = userData
 * corruption."
 *
 * Fix: explicit Electron-PID-holding-our-userData probe using
 * `pgrep -f Electron` + `lsof -p <pid>` grep for our specific
 * userData path. Composes WITH the existing server-running check,
 * not replaces — server-also-down is the cleanest invariant to
 * preserve.
 *
 * Deps are dependency-injected so the regression test can stub
 * `pgrep` / `lsof` shapes without spawning real processes.
 */
export interface RefuseElectronDeps {
  /**
   * Return candidate Electron PIDs on the machine. Real impl shells
   * `pgrep -f Electron`. Tests inject stub PIDs.
   */
  pgrepElectronPids: () => Promise<number[]>;
  /**
   * Return true if `lsof -p <pid>` output contains the target
   * `userDataDir` path (indicating the process has an open file
   * inside the userData tree). Real impl shells lsof. Tests inject
   * a Map<pid, holds>.
   */
  lsofPidHoldsPath: (pid: number, path: string) => Promise<boolean>;
}

const realRefuseElectronDeps: RefuseElectronDeps = {
  pgrepElectronPids: async () => {
    try {
      const proc = Bun.spawn(["pgrep", "-f", "Electron"], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      return out
        .trim()
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    } catch {
      return [];
    }
  },
  lsofPidHoldsPath: async (pid, path) => {
    try {
      const proc = Bun.spawn(["lsof", "-p", String(pid)], {
        stdout: "pipe",
        stderr: "ignore",
      });
      const out = await new Response(proc.stdout).text();
      return out.includes(path);
    } catch {
      return false;
    }
  },
};

export async function findElectronPidsHoldingUserData(
  userDataDir: string,
  deps: RefuseElectronDeps = realRefuseElectronDeps,
): Promise<number[]> {
  const candidates = await deps.pgrepElectronPids();
  const hits: number[] = [];
  for (const pid of candidates) {
    if (await deps.lsofPidHoldsPath(pid, userDataDir)) hits.push(pid);
  }
  return hits;
}

async function refuseIfElectronRunning(
  opts: NukeClientCacheOptions,
  resolved: ResolvedTargets,
  deps: RefuseElectronDeps = realRefuseElectronDeps,
): Promise<string | null> {
  const isDefaultInstance =
    opts.instance === "default" || opts.instance === "" || opts.instance === "(default)";
  const nautiloRoot = resolveNautiloRootDir({
    env: { ...process.env, NAUTILO_INSTANCE_ID: isDefaultInstance ? "" : opts.instance },
  });

  // Check 1: server PID via Phase 3.A's probe (existing).
  const state = await probeInstanceProcessState(opts.instance, nautiloRoot);
  if (state.isRunning) {
    return [
      `Refusing to nuke: a Nautilo server appears to be running for instance \`${opts.instance}\` on pid ${state.serverPid ?? "?"}.`,
      `Electron may be attached. Stop it first:`,
      ``,
      `  bun run server:stop --instance ${opts.instance}`,
      ``,
      `(If you're sure Electron is NOT running, you can ignore this — but server-only is safer to bring down first.)`,
    ].join("\n");
  }

  // Check 2: Phase 6.9.4 — explicit Electron-on-userData probe. Catches
  // the "operator stopped server but left Electron open" case where
  // server-running check returns false but renderer storage is still
  // active. Without this, --yes would rename/delete the active
  // userData tree and corrupt the open Electron's IndexedDB / Local
  // Storage / Cache.
  const electronPids = await findElectronPidsHoldingUserData(
    resolved.userDataDir,
    deps,
  );
  if (electronPids.length > 0) {
    return [
      `Refusing to nuke: Electron process${electronPids.length === 1 ? "" : "es"} ${electronPids.join(", ")} ${electronPids.length === 1 ? "is" : "are"} holding open files under \`${resolved.userDataDir}\`.`,
      `Quit Electron first (Cmd-Q / equivalent), then re-run with --yes.`,
      ``,
      `Detected via pgrep -f Electron + lsof -p <pid> | grep <userData>.`,
      `If this is a false positive (some other process named "Electron" that doesn't actually mount our userData), pass --force-no-electron-check to bypass — but doing so on a live renderer WILL corrupt its open IndexedDB transactions.`,
    ].join("\n");
  }

  return null;
}

export async function nukeClientCacheCmd(args: string[]): Promise<number> {
  if (hasHelpFlag(args)) {
    console.log(formatHelp(NUKE_HELP));
    return 0;
  }

  const parsed = parseNukeClientCacheArgs(args);
  if (!parsed.ok) {
    console.error(parsed.message);
    return parsed.exitCode;
  }
  const opts = parsed.opts;

  // HARD refuse on default instance unless --i-know-what-i-am-doing
  const isDefaultInstance =
    opts.instance === "default" || opts.instance === "" || opts.instance === "(default)";
  if (isDefaultInstance && opts.yes && !opts.iKnowWhatIAmDoing) {
    console.error(
      [
        "Refusing to nuke the (default) instance's renderer cache without --i-know-what-i-am-doing.",
        "",
        "The default-instance Electron userData was the pre-Stack-19 shared",
        "directory for all instances on this machine; wiping it is the Stack",
        "19 migration recipe for cleaning up the cross-instance cache soup",
        "that accumulated under shared userData. That IS a real use case, so",
        "we don't HARD refuse — we require an extra confirm:",
        "",
        "  bun run dev:nuke-client-cache --instance default --yes --i-know-what-i-am-doing",
        "",
        "If you meant a named instance, pass --instance <name> (with the",
        "name spelled correctly).",
      ].join("\n"),
    );
    return 2;
  }

  const resolved = resolveNukeTargets(opts);

  if (!opts.yes) {
    printDryRunReport(opts, resolved);
    return 0;
  }

  // --yes path: refuse if Electron is up, otherwise execute.
  const runningError = await refuseIfElectronRunning(opts, resolved);
  if (runningError !== null) {
    console.error(runningError);
    return 1;
  }

  if (resolved.targets.length === 0) {
    if (opts.asJson) {
      console.log(JSON.stringify({ mode: "execute", result: "no-op", reason: "nothing-to-delete" }, null, 2));
    } else {
      console.log(`Nothing to do — neither the userData dir nor the desktop-auth file exists for this (instance, profile).`);
    }
    return 0;
  }

  const result = executeNuke(resolved);

  if (result.failedAt !== null) {
    console.error(
      [
        `ATOMIC NUKE ABORTED at: ${result.failedAt}`,
        ``,
        `${result.staged.length}/${resolved.targets.length} path(s) were already moved to the staging dir.`,
        `The staging dir was LEFT IN PLACE so you can recover:`,
        ``,
        `  ${result.stagingDir}`,
        ``,
        `To finish the delete manually after fixing the underlying issue:`,
        `  rm -rf ${result.stagingDir}`,
        ``,
        `To restore the moved paths (best-effort; only the ${result.staged.length} that staged are recoverable):`,
        `  for f in ${result.stagingDir}/*; do echo "manually move \\$f back to its original location"; done`,
      ].join("\n"),
    );
    return 1;
  }

  if (opts.asJson) {
    console.log(
      JSON.stringify(
        {
          mode: "execute",
          result: "success",
          instance: opts.instance === "" ? "(default)" : opts.instance,
          profile: opts.profile ?? null,
          deletedCount: resolved.targets.length,
          targets: resolved.targets.map((t) => t.path),
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Nuked ${resolved.targets.length} renderer-state path(s) for instance \`${opts.instance === "" ? "(default)" : opts.instance}\`${opts.profile ? ` profile \`${opts.profile}\`` : ""}.`);
    console.log(`Next launch will see fresh first-run state.`);
  }
  return 0;
}
