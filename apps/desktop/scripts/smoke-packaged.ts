#!/usr/bin/env bun
/**
 * D103 P5.1 / P5.2 / P5.4 / P5.5 — packaged-app smoke harness.
 *
 * Scope (D134 rescope) — this harness validates the packaged
 * **Electron client**: the binary launches, the first-run picker
 * window renders, the preload surface matches the canonical
 * contract, and the main log is redacted. It does NOT spawn or
 * audit a Nautilo server: the packaged app is a connect-to-server
 * client and does not bundle a server. The Workbench preload check
 * uses a tiny harness-owned HTTP stub only to reach the normal main
 * window; a connected end-to-end smoke (client + real server + Logto)
 * lives elsewhere — see
 * `apps/desktop/PRODUCTION.md` for the packaging and acceptance boundaries.
 *
 * Cases:
 *   - 5.1  Launch the packaged main process; assert it survives N
 *          seconds without crashing.
 *   - 5.2  `--ports-matrix` re-runs 5.1 with `nc -l 3000` /
 *          `nc -l 3001` blockers and a two-concurrent-instance
 *          variant. Pass criterion: the Electron client survives
 *          regardless of what's bound on those ports — it does
 *          not own them. (Pre-D134 these tests asserted a bundled
 *          server picked an alternate port; that mode is gone.)
 *   - 5.4  After each launch the harness tails main.log and rejects
 *          token-looking substrings (Bearer / refresh_token / JWT).
 *   - 5.5  When `--cdp` is passed (default ON), attach via Chrome
 *          DevTools Protocol on the `--remote-debugging-port` we
 *          pass at launch and evaluate `Object.keys(window.<surface>)`
 *          against the canonical documented surface. The first-run
 *          picker exposes `nautiloFirstRun`; a connected Workbench
 *          window exposes `nautiloDesktop`. Default smoke launches
 *          both deterministic targets.
 *
 * # Smoke-harness shape — log-parsing primary, CDP for surface only
 *
 * The spec offers two shapes: a CDP-driven UI script that drives the
 * picker, OR a launch-sleep-parse-logs fallback. We combine them:
 * log-parsing is the primary process-health signal (cheap, stable)
 * and CDP is a single read-only eval to enumerate the preload
 * surface keys. We intentionally do NOT drive the first-run picker
 * UI via CDP — that's brittle and not what this harness is for.
 *
 * # Platform notes
 *
 * macOS-first. Linux/Windows path resolution is sketched (see
 * `resolveAppExecutable`) but not exercised in CI today. Add native jobs to
 * `desktop-package.yml` when those targets are qualified.
 */

import { spawn, type ChildProcess } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, homedir, platform as osPlatform } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

// =============================================================================
// Canonical preload surface — the source of truth for §5.5.
//
// Derived directly from `apps/desktop/electron/preload.ts`'s
// `contextBridge.exposeInMainWorld("nautiloDesktop", { ... })` block. If
// you change preload.ts, update this list too AND update
// `PRODUCTION.md` §"Preload surface contract" via the orchestrator.
// =============================================================================
export const NAUTILO_DESKTOP_SURFACE = [
  "miniAppRecovery",
  "documentMutations",
  "isDesktop",
  "embeddedBrowserGuestPreloadPath",
  "auth",
  "shellStateOnBoot",
  "coldBoot",
  "platform",
  "electronVersion",
  "getVersion",
  "workbench",
  "openFolder",
  "pickFiles",
  "currentFolder",
  "genieWorkspace",
  "workspace", // deprecated alias — D079 Phase 4 removes
  "servers",
  "activeSession",
  "updates",
  "notifications",
  "browserControl",
  "browserResearch",
  "passwords",
  "toolRuntimes",
  "googleWorkspace",
  "terminal",
  "desktopFilesystemGrants",
  "workstationProfiles",
  "uncontainedHostCommands",
  "githubCli",
  "structuredSsh",
  "computerUse",
  "workstationShell",
  "codexConnection",
  "hermesConnection",
  "readyToWork",
  "remoteControl",
  "ordinaryChat",
  "foregroundShadow",
  "encryptionRecovery",
  "relayStatus",
  "relayIdentity",
  "binaryRead",
  "mediaProxy",
  "mediaExport",
  "fs",
  "media",
  "systemPermissions",
  "menu",
  "logger",
  "onboarding",
  "deepLink",
] as const;

export const NAUTILO_FIRST_RUN_SURFACE = [
  "getConnectTargets",
  "commit",
  "confirmDowngrade",
  "acceptIdentity",
  "abortAttempt",
  "onConnectionPresentation",
  "cancel",
] as const;

// =============================================================================
// CLI parse
// =============================================================================
interface CliOptions {
  appPath: string;
  unpackaged: boolean;
  portsMatrix: boolean;
  cdp: boolean;
  bootSeconds: number;
  cdpPort: number;
}

function parseCli(argv: string[]): CliOptions {
  // D376 Phase 3 — unpackaged mode launches the built `dist/main.js`
  // via the local electron binary (`node_modules/.bin/electron
  // dist/main.js`), no electron-builder/.app needed. Select via
  // `--unpackaged` flag or `SMOKE_UNPACKAGED=1` env. The packaged
  // .app path below stays the default for release-time smoke.
  const unpackaged =
    process.env.SMOKE_UNPACKAGED === "1" ||
    argv.includes("--unpackaged");
  const opts: CliOptions = {
    appPath: unpackaged ? "dist/main.js" : "release/mac-arm64/Nautilo.app",
    unpackaged,
    portsMatrix: false,
    cdp: true,
    bootSeconds: 25,
    cdpPort: 9222,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--ports-matrix") opts.portsMatrix = true;
    else if (a === "--unpackaged") opts.unpackaged = true;
    else if (a === "--no-cdp") opts.cdp = false;
    else if (a === "--boot-seconds") opts.bootSeconds = Number(argv[++i]);
    else if (a === "--cdp-port") opts.cdpPort = Number(argv[++i]);
    else if (!a.startsWith("--")) opts.appPath = a;
  }
  return opts;
}

// =============================================================================
// App-executable resolution (macOS-first; sketches for Linux/Windows)
//
// D376 Phase 3 — when `unpackaged` is set, the harness resolves the
// local electron binary (`require("electron")`, which reads
// `node_modules/electron/path.txt`) and returns *that*; the
// `dist/main.js` path is threaded separately as `mainJs` through
// LaunchOptions so it becomes the first arg to the electron CLI
// (`electron dist/main.js --user-data-dir=... ...`). The packaged
// `.app` resolution below is unchanged — release-time smoke still
// uses it.
// =============================================================================
export function resolveElectronBinary(): string {
  // `require("electron")` returns the absolute path to the installed
  // electron executable (see `node_modules/electron/index.js`). Works
  // under both Node and Bun. Fall back to the bin symlink if the
  // package's index.js refuses to load (e.g. binary not extracted).
  try {
    const p = require("electron") as unknown as string;
    const normalized = typeof p === "string" ? p.trim() : "";
    if (normalized && existsSync(normalized)) return normalized;
  } catch {
    /* fall through */
  }
  // Walk up from cwd looking for `node_modules/.bin/electron`.
  let dir = process.cwd();
  for (let i = 0; i < 8; i++) {
    const cand = join(dir, "node_modules", ".bin", "electron");
    if (existsSync(cand)) return cand;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `[smoke] could not resolve electron binary — run \`bun install\` ` +
      `in the worktree root (electron postinstall downloads it).`,
  );
}

export function resolveAppExecutable(
  appPath: string,
  unpackaged = false,
): string {
  if (unpackaged) {
    // The app path is the built `dist/main.js`; verify it exists, but
    // the executable we return is the electron binary itself.
    const mainJsAbs = resolve(appPath);
    if (!existsSync(mainJsAbs)) {
      throw new Error(
        `[smoke] unpackaged main.js does not exist: ${mainJsAbs}\n` +
          `       Build it first: bun run --cwd apps/desktop build:electron`,
      );
    }
    return resolveElectronBinary();
  }

  const abs = resolve(appPath);
  if (!existsSync(abs)) {
    throw new Error(
      `[smoke] app path does not exist: ${abs}\n` +
        `       Build the app first: bun run package:dev (or package:mac)`,
    );
  }

  if (osPlatform() === "darwin" && abs.endsWith(".app")) {
    // Locate Info.plist's CFBundleExecutable; fall back to "Nautilo".
    const macos = join(abs, "Contents", "MacOS");
    if (!existsSync(macos)) {
      throw new Error(`[smoke] missing ${macos}`);
    }
    const candidate = join(macos, "Nautilo");
    if (existsSync(candidate)) return candidate;
    // Last-resort: pick the first executable under MacOS/.
    throw new Error(
      `[smoke] could not locate Nautilo binary under ${macos}`,
    );
  }

  // Linux: AppImage / extracted dir → look for .AppImage or main exe.
  // Windows: .exe inside a versioned folder. Both are scaffolded for
  // the GH-Actions matrix expansion; not exercised today.
  if (osPlatform() === "linux") {
    if (statSync(abs).isFile()) return abs;
    const guess = join(abs, "nautilo");
    if (existsSync(guess)) return guess;
  }
  if (osPlatform() === "win32") {
    if (abs.toLowerCase().endsWith(".exe")) return abs;
    const guess = join(abs, "Nautilo.exe");
    if (existsSync(guess)) return guess;
  }
  return abs;
}

// =============================================================================
// Log-redaction — §5.4
//
// The packaged app writes to electron-log's per-OS path. The negative
// patterns here mirror the spec; if any match, the run FAILs.
// =============================================================================
function logFilePath(): string {
  if (osPlatform() === "darwin") {
    return join(homedir(), "Library", "Logs", "Nautilo", "main.log");
  }
  if (osPlatform() === "linux") {
    // `~/.config/Nautilo/logs/main.log` per electron-log's Linux default.
    return join(homedir(), ".config", "Nautilo", "logs", "main.log");
  }
  if (osPlatform() === "win32") {
    return join(
      process.env.USERPROFILE ?? homedir(),
      "AppData",
      "Roaming",
      "Nautilo",
      "logs",
      "main.log",
    );
  }
  return join(homedir(), ".nautilo-main.log");
}

interface RedactionResult {
  ok: boolean;
  failures: string[];
  positiveMatches: string[];
}

const REDACTION_NEGATIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "Bearer token", re: /Bearer [A-Za-z0-9_-]{20,}/ },
  {
    name: "refresh_token",
    re: /"refresh_token"\s*:\s*"[A-Za-z0-9_-]{20,}"/,
  },
  // JWT: three base64url segments separated by dots, header+payload start "ey".
  { name: "JWT", re: /ey[A-Za-z0-9_-]{20,}\.ey[A-Za-z0-9_-]{20,}\./ },
  // access_token explicit field — separate from "Bearer …" since some
  // clients log the bare value alongside the auth scheme.
  {
    name: "access_token",
    re: /"access_token"\s*:\s*"[A-Za-z0-9_-]{20,}"/,
  },
];

const REDACTION_POSITIVE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  // The `…(len=N)` shape is the current redaction-aware prefix used in
  // diag logs (see token-prefix audit in P4). Presence is informational —
  // if the app never printed any token-shaped value at all this list is
  // empty and that's fine.
  { name: "prefix-only diagnostic", re: /\.\.\.\(len=\d+\)/ },
];

function checkLogRedaction(logPath: string): RedactionResult {
  const result: RedactionResult = { ok: true, failures: [], positiveMatches: [] };
  if (!existsSync(logPath)) {
    // Missing log = first run wrote nothing yet. Treat as soft-pass: the
    // launch itself is verified through the child process's stdout.
    return result;
  }
  let body: string;
  try {
    body = readFileSync(logPath, "utf8");
  } catch (err) {
    result.failures.push(`unable to read log: ${(err as Error).message}`);
    result.ok = false;
    return result;
  }
  for (const { name, re } of REDACTION_NEGATIVE_PATTERNS) {
    if (re.test(body)) {
      result.failures.push(`negative match: ${name}`);
      result.ok = false;
    }
  }
  for (const { name, re } of REDACTION_POSITIVE_PATTERNS) {
    if (re.test(body)) result.positiveMatches.push(name);
  }
  return result;
}

// =============================================================================
// CDP — minimal client for surface audit (§5.5)
//
// We intentionally don't pull in puppeteer / playwright / cdp-client. A
// thin WebSocket-based attach + Runtime.evaluate is all we need.
// =============================================================================
export interface CDPTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

export async function fetchCdpTargets(
  port: number,
  timeoutMs = 1_000,
): Promise<CDPTarget[]> {
  const res = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`CDP /json HTTP ${res.status}`);
  return (await res.json()) as CDPTarget[];
}

interface SurfaceAuditResult {
  ok: boolean;
  reason?: string;
  exposedRoot?: string[];
  desktopKeys?: string[];
  binaryReadProbe?: string[];
  miniAppRecoveryProbe?: {
    methods: string[];
    invalidReadRejected: boolean;
  };
  firstRunKeys?: string[];
  detectedWindow?: string;
}

type ExpectedPreloadSurface = "nautiloDesktop" | "nautiloFirstRun";

export function surfaceContractMismatch(
  actual: readonly string[],
  expected: readonly string[],
): { undocumented: string[]; missing: string[] } {
  return {
    undocumented: actual.filter((key) => !expected.includes(key)),
    missing: expected.filter((key) => !actual.includes(key)),
  };
}

export async function evaluateInTarget(
  wsUrl: string,
  expression: string,
  awaitPromise = false,
): Promise<unknown> {
  return await new Promise((resolveP, rejectP) => {
    const ws = new WebSocket(wsUrl);
    let id = 0;
    ws.addEventListener("open", () => {
      id += 1;
      ws.send(
        JSON.stringify({
          id,
          method: "Runtime.evaluate",
          params: {
            expression,
            returnByValue: true,
            awaitPromise,
          },
        }),
      );
    });
    ws.addEventListener("message", (ev) => {
      const data = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: { result?: { value?: unknown } };
        error?: { message?: string };
      };
      if (data.id === id) {
        ws.close();
        if (data.error) rejectP(new Error(data.error.message ?? "CDP error"));
        else resolveP(data.result?.result?.value);
      }
    });
    ws.addEventListener("error", (ev) => {
      rejectP(new Error(`WS error: ${String((ev as ErrorEvent).message ?? ev)}`));
    });
    setTimeout(() => {
      try {
        ws.close();
      } catch {
        /* noop */
      }
      rejectP(new Error("CDP evaluate timeout"));
    }, 5_000);
  });
}

async function auditPreloadSurface(
  cdpPort: number,
  totalTimeoutMs: number,
  expectedSurface: ExpectedPreloadSurface,
): Promise<SurfaceAuditResult> {
  // The requested launch mode determines which bridge must appear. Merely
  // finding any page is insufficient: a preload regression can create a page
  // with no Nautilo global at all.
  const startedAt = Date.now();
  const deadline = startedAt + totalTimeoutMs;
  let target: CDPTarget | null = null;
  let exposedRoot: string[] = [];
  const evaluateExpectedSurface = async (
    expression: string,
    awaitPromise = false,
  ): Promise<unknown> => {
    while (Date.now() < deadline) {
      try {
        // A BrowserWindow can replace its renderer target while navigating
        // from the initial document to the packaged file/server URL. Re-read
        // /json before every assertion instead of retaining a target that can
        // legitimately close between two CDP evaluations.
        const pageTargets = (await fetchCdpTargets(cdpPort)).filter(
          (candidate) => candidate.type === "page",
        );
        for (const candidate of pageTargets) {
          try {
            const candidateRoot = (await evaluateInTarget(
              candidate.webSocketDebuggerUrl,
              "Object.keys(window).filter(k => k.toLowerCase().startsWith('nautilo'))",
            )) as string[];
            target = candidate;
            exposedRoot = candidateRoot;
            if (!candidateRoot.includes(expectedSurface)) continue;
            return await evaluateInTarget(
              candidate.webSocketDebuggerUrl,
              expression,
              awaitPromise,
            );
          } catch {
            // The target can navigate after discovery or during evaluation.
            // The next poll observes and evaluates its replacement.
          }
        }
      } catch {
        // CDP may still be starting (or an accepted HTTP request may stall);
        // the per-request abort keeps the overall launch deadline authoritative.
      }
      await sleep(250);
    }
    throw new Error(`window.${expectedSurface} was unavailable during audit`);
  };

  try {
    await evaluateExpectedSurface("true");
  } catch {
    // The structured result below preserves the last page/root observation.
  }

  if (!target) {
    return { ok: false, reason: "no CDP page target appeared in time" };
  }

  const result: SurfaceAuditResult = {
    ok: exposedRoot.includes(expectedSurface),
    exposedRoot,
    detectedWindow: target.title || target.url,
  };
  if (!result.ok) {
    result.reason = `expected window.${expectedSurface}, exposed [${exposedRoot.join(", ")}]`;
  }

  if (exposedRoot.includes("nautiloDesktop")) {
    const keys = (await evaluateExpectedSurface(
      "Object.keys(window.nautiloDesktop)",
    )) as string[];
    result.desktopKeys = keys;
    const { undocumented, missing } = surfaceContractMismatch(
      keys,
      NAUTILO_DESKTOP_SURFACE,
    );
    if (undocumented.length > 0) {
      result.ok = false;
      result.reason = `undocumented nautiloDesktop keys: ${undocumented.join(", ")}`;
    } else if (missing.length > 0) {
      result.ok = false;
      result.reason = `missing nautiloDesktop keys: ${missing.join(", ")}`;
    }

    if (keys.includes("binaryRead")) {
      const binaryReadProbe = (await evaluateExpectedSurface(
        `Promise.all([
          window.nautiloDesktop.binaryRead.open(undefined),
          window.nautiloDesktop.binaryRead.read("packaged-smoke-missing", 0),
          window.nautiloDesktop.binaryRead.close("packaged-smoke-missing")
        ]).then(results => results.map(result =>
          result?.ok === true ? "ok" : result.error?.code
        ))`,
        true,
      )) as string[];
      result.binaryReadProbe = binaryReadProbe;
      const expected = [
        "invalid_request",
        "session_not_found",
        "ok",
      ];
      if (binaryReadProbe.join(",") !== expected.join(",")) {
        result.ok = false;
        result.reason =
          (result.reason ? result.reason + "; " : "") +
          `binaryRead open/read/close probe returned [${binaryReadProbe.join(", ")}]`;
      }
    }

    if (keys.includes("miniAppRecovery")) {
      const miniAppRecoveryProbe = (await evaluateExpectedSurface(
        `(async () => ({
          methods: ["open", "read", "write", "close"].map(
            method => typeof window.nautiloDesktop.miniAppRecovery[method]
          ),
          invalidReadRejected: await window.nautiloDesktop.miniAppRecovery
            .read("")
            .then(() => false, () => true)
        }))()`,
        true,
      )) as { methods: string[]; invalidReadRejected: boolean };
      result.miniAppRecoveryProbe = miniAppRecoveryProbe;
      if (
        miniAppRecoveryProbe.methods.some((type) => type !== "function") ||
        !miniAppRecoveryProbe.invalidReadRejected
      ) {
        result.ok = false;
        result.reason =
          (result.reason ? result.reason + "; " : "") +
          `miniAppRecovery protocol probe returned methods=[${miniAppRecoveryProbe.methods.join(", ")}], invalidReadRejected=${miniAppRecoveryProbe.invalidReadRejected}`;
      }
    }
  }

  if (exposedRoot.includes("nautiloFirstRun")) {
    const keys = (await evaluateExpectedSurface(
      "Object.keys(window.nautiloFirstRun)",
    )) as string[];
    result.firstRunKeys = keys;
    const { undocumented, missing } = surfaceContractMismatch(
      keys,
      NAUTILO_FIRST_RUN_SURFACE,
    );
    if (undocumented.length > 0) {
      result.ok = false;
      result.reason =
        (result.reason ? result.reason + "; " : "") +
        `undocumented nautiloFirstRun keys: ${undocumented.join(", ")}`;
    } else if (missing.length > 0) {
      result.ok = false;
      result.reason =
        (result.reason ? result.reason + "; " : "") +
        `missing nautiloFirstRun keys: ${missing.join(", ")}`;
    }
  }

  // Negative: ipcRenderer / require / process must NOT be reachable
  // from the renderer. Sandbox + contextIsolation enforce this; we
  // verify here as a regression backstop.
  const leaked = (await evaluateExpectedSurface(
    "[typeof require, typeof module, typeof process].map(String)",
  )) as string[];
  const leaks = leaked.filter((t) => t !== "undefined");
  if (leaks.length > 0) {
    result.ok = false;
    result.reason =
      (result.reason ? result.reason + "; " : "") +
      `renderer leak: require/module/process exposed (${leaked.join(",")})`;
  }

  return result;
}

// =============================================================================
// Single-run launch helper
// =============================================================================
interface LaunchResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  bootedFor: number;
  surface?: SurfaceAuditResult;
  redaction: RedactionResult;
  killed: boolean;
}

interface LaunchOptions {
  appExecutable: string;
  bootSeconds: number;
  cdp: boolean;
  cdpPort: number;
  // D376 Phase 3 — when set, this path is passed as the first arg to
  // the electron CLI (`electron <mainJs> ...`). Used only in
  // unpackaged mode; packaged mode leaves this undefined.
  mainJs?: string;
  extraArgs?: string[];
  envOverrides?: Record<string, string>;
  forceFirstRun?: boolean;
  expectedSurface?: ExpectedPreloadSurface;
}

async function launchOnce(opts: LaunchOptions): Promise<LaunchResult> {
  const userData = mkdtempSync(join(tmpdir(), "nautilo-smoke-"));
  const args = [
    // Unpackaged mode: `electron dist/main.js ...` — the main.js path
    // must be the first positional arg, before any chrome flags.
    ...(opts.mainJs ? [opts.mainJs] : []),
    `--user-data-dir=${userData}`,
    ...(opts.cdp ? [`--remote-debugging-port=${opts.cdpPort}`] : []),
    ...(opts.extraArgs ?? []),
  ];
  // D134 — desktop is a connect-to-server client. Strip dev-mode env
  // that might leak in from the operator's shell so the smoke
  // exercises the packaged boot path deterministically.
  const env = { ...process.env };
  delete env["NAUTILO_FORCE_FIRST_RUN"];
  delete env["NAUTILO_CONNECT_SERVER_URL"];
  if (opts.forceFirstRun) env["NAUTILO_FORCE_FIRST_RUN"] = "1";
  // D376 — never pop a visible Setup window on the operator's desktop
  // during smoke runs. main.ts skips win.show() (+ hides the dock on
  // macOS) when this is set; CDP surface enumeration still works on
  // the hidden window. CI (xvfb) is unaffected either way.
  env["NAUTILO_SMOKE_HIDDEN"] = "1";
  const child: ChildProcess = spawn(opts.appExecutable, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...env,
      ...(opts.envOverrides ?? {}),
    },
  });

  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (b: Buffer) => {
    stdout += b.toString("utf8");
  });
  child.stderr?.on("data", (b: Buffer) => {
    stderr += b.toString("utf8");
  });

  const startedAt = Date.now();
  let surface: SurfaceAuditResult | undefined;

  if (opts.cdp) {
    surface = await auditPreloadSurface(
      opts.cdpPort,
      opts.bootSeconds * 1000,
      opts.expectedSurface ?? "nautiloFirstRun",
    ).catch((err) => ({
      ok: false,
      reason: `surface audit threw: ${(err as Error).message}`,
    }));
  } else {
    await sleep(opts.bootSeconds * 1000);
  }

  // Top up to bootSeconds even if surface audit returned early — gives
  // the log-redaction tail something to read and confirms the process
  // didn't crash post-boot.
  const elapsedMs = Date.now() - startedAt;
  const remaining = opts.bootSeconds * 1000 - elapsedMs;
  if (remaining > 0) await sleep(remaining);

  const stillRunning = child.exitCode === null && child.signalCode === null;
  let killed = false;
  if (stillRunning) {
    child.kill("SIGTERM");
    killed = true;
    await Promise.race([
      new Promise<void>((r) => child.once("exit", () => r())),
      sleep(5_000),
    ]);
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await new Promise<void>((r) => child.once("exit", () => r()));
    }
  }

  const redaction = checkLogRedaction(logFilePath());

  return {
    exitCode: child.exitCode,
    signal: child.signalCode as NodeJS.Signals | null,
    stdout,
    stderr,
    bootedFor: Date.now() - startedAt,
    surface,
    redaction,
    killed,
  };
}

// =============================================================================
// Port-blocker helpers (§5.2)
// =============================================================================
function spawnPortBlocker(port: number): ChildProcess {
  // `nc -l <port>` blocks; use that to occupy the port for the
  // duration of the test case. macOS netcat needs `-l <port>` (no
  // `-p`) and exits when the connection drops; we keep stdin open
  // so it stays alive. Linux ncat / GNU netcat have the same
  // surface.
  const blocker = spawn("nc", ["-l", String(port)], {
    stdio: ["pipe", "ignore", "ignore"],
  });
  return blocker;
}

function killBlocker(blocker: ChildProcess): void {
  try {
    blocker.kill("SIGTERM");
  } catch {
    /* noop */
  }
}

// =============================================================================
// Reporting
// =============================================================================
interface CaseReport {
  name: string;
  pass: boolean;
  detail: string;
}

function summarize(report: CaseReport[]): boolean {
  let ok = true;
  process.stdout.write("\n=== smoke summary ===\n");
  for (const r of report) {
    process.stdout.write(`${r.pass ? "PASS" : "FAIL"}  ${r.name}\n`);
    if (r.detail) {
      const indented = r.detail
        .split("\n")
        .map((l) => `      ${l}`)
        .join("\n");
      process.stdout.write(`${indented}\n`);
    }
    if (!r.pass) ok = false;
  }
  process.stdout.write(`\n${ok ? "PASS" : "FAIL"} (${report.length} cases)\n`);
  return ok;
}

// =============================================================================
// Run modes
// =============================================================================
async function runDefault(opts: CliOptions): Promise<CaseReport[]> {
  const exe = resolveAppExecutable(opts.appPath, opts.unpackaged);
  // D376 Phase 3 — in unpackaged mode the built `dist/main.js` is
  // passed as the first arg to the electron binary; in packaged mode
  // `mainJs` is undefined and the .app executable runs itself.
  const mainJs = opts.unpackaged ? resolve(opts.appPath) : undefined;
  // D134 — force the first-run picker so the surface audit hits a
  // deterministic CDP target (`window.nautiloFirstRun`). A paired
  // packaged install would instead load the Workbench from its
  // server URL; that path requires an operator-owned server and is
  // covered by the connected end-to-end smoke (out of scope here).
  const result = await launchOnce({
    appExecutable: exe,
    bootSeconds: opts.bootSeconds,
    cdp: opts.cdp,
    cdpPort: opts.cdpPort,
    mainJs,
    forceFirstRun: true,
    expectedSurface: "nautiloFirstRun",
  });
  const reports: CaseReport[] = [];

  // D376 Phase 3 — boot-survive criterion. The packaged .app stays
  // alive for the full boot window (we kill it at Ns). The unpackaged
  // first-run picker, when launched in the background / headless,
  // self-quits cleanly (~4s, exit=0) once the picker window closes —
  // that is NOT a load crash. The D373-class load crash exits non-zero
  // at ~0ms before any window opens. So in unpackaged mode we accept
  // either (a) still-running-at-Ns (killed), or (b) a clean exit=0
  // AFTER the boot floor (>= 2000ms = past the load + window-open
  // phase). A non-zero exit before the floor = crash = FAIL.
  const BOOT_FLOOR_MS = 2000;
  const survivedBoot = opts.unpackaged
    ? (result.killed && result.bootedFor >= opts.bootSeconds * 1000 - 250) ||
      (result.exitCode === 0 &&
        result.bootedFor >= BOOT_FLOOR_MS &&
        result.signal === null)
    : result.killed && result.bootedFor >= opts.bootSeconds * 1000 - 250;
  reports.push({
    name: "5.1 process survives boot window (first-run picker)",
    pass: survivedBoot,
    detail: `bootedFor=${result.bootedFor}ms killed=${result.killed} exit=${result.exitCode} signal=${result.signal} target=${opts.unpackaged ? "unpackaged" : "packaged"}\n${tailOutput(result.stdout, result.stderr)}`,
  });

  if (opts.cdp) {
    const s = result.surface;
    reports.push({
      name: "5.5 preload surface audit",
      pass: !!s?.ok,
      detail: s
        ? `window=${s.detectedWindow}\n` +
          `exposedRoot=[${s.exposedRoot?.join(", ") ?? ""}]\n` +
          (s.desktopKeys
            ? `nautiloDesktop=[${s.desktopKeys.join(", ")}]\n`
            : "") +
          (s.firstRunKeys
            ? `nautiloFirstRun=[${s.firstRunKeys.join(", ")}]\n`
            : "") +
          (s.reason ? `reason=${s.reason}` : "")
        : "(no result)",
    });
  }

  if (opts.cdp) {
    const stub = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const pathname = new URL(request.url).pathname;
        if (pathname === "/health") {
          return Response.json({ status: "ready" });
        }
        if (pathname === "/api/setup/status") {
          return Response.json({
            instanceId: "packaged-smoke",
            serverUrl: new URL(request.url).origin,
            deploymentMode: "local-self-host",
            setupState: "fresh-unclaimed",
            claimRequired: true,
            recommendedSetupSurface: { kind: "cli", url: null },
          });
        }
        return new Response("<!doctype html><title>Nautilo packaged smoke</title>", {
          headers: { "content-type": "text/html; charset=utf-8" },
        });
      },
    });
    try {
      const connected = await launchOnce({
        appExecutable: exe,
        bootSeconds: opts.bootSeconds,
        cdp: true,
        cdpPort: opts.cdpPort,
        mainJs,
        envOverrides: {
          NAUTILO_CONNECT_SERVER_URL: stub.url.origin,
        },
        expectedSurface: "nautiloDesktop",
      });
      const s = connected.surface;
      reports.push({
        name: "5.5 Workbench preload surface audit",
        pass: !!s?.ok,
        detail: s
          ? `window=${s.detectedWindow}\n` +
            `exposedRoot=[${s.exposedRoot?.join(", ") ?? ""}]\n` +
            `nautiloDesktop=[${s.desktopKeys?.join(", ") ?? ""}]\n` +
            `miniAppRecovery(open/read/write/close)=[${s.miniAppRecoveryProbe?.methods.join(", ") ?? ""}], invalidReadRejected=${s.miniAppRecoveryProbe?.invalidReadRejected ?? false}\n` +
            `binaryRead(open/read/close)=[${s.binaryReadProbe?.join(", ") ?? ""}]\n` +
            (s.reason ? `reason=${s.reason}` : "")
          : "(no result)",
      });
    } finally {
      await stub.stop(true);
    }
  }

  reports.push({
    name: "5.4 log redaction",
    pass: result.redaction.ok,
    detail:
      `log=${logFilePath()}\n` +
      (result.redaction.failures.length > 0
        ? `failures: ${result.redaction.failures.join("; ")}\n`
        : "no token-shaped substrings\n") +
      (result.redaction.positiveMatches.length > 0
        ? `positives: ${result.redaction.positiveMatches.join(", ")}`
        : ""),
  });

  return reports;
}

async function runPortsMatrix(opts: CliOptions): Promise<CaseReport[]> {
  const exe = resolveAppExecutable(opts.appPath, opts.unpackaged);
  const mainJs = opts.unpackaged ? resolve(opts.appPath) : undefined;
  const reports: CaseReport[] = [];

  // D134 — the desktop client does not bind any local server ports;
  // these cases verify the client doesn't *crash* when the ports
  // an operator-bundled server might have used are occupied (a
  // common collision with other dev tools on developer machines).
  // Pre-D134 these tests asserted the bundled server picked an
  // alternate port; that mode was retired with the rescope.
  const cases: Array<{ name: string; ports: number[] }> = [
    { name: "5.2.a port 3000 occupied — client survives", ports: [3000] },
    { name: "5.2.b port 3001 occupied — client survives", ports: [3001] },
    { name: "5.2.c ports 3000 + 3001 occupied — client survives", ports: [3000, 3001] },
  ];

  for (const c of cases) {
    const blockers = c.ports.map(spawnPortBlocker);
    await sleep(500);
    const r = await launchOnce({
      appExecutable: exe,
      bootSeconds: Math.min(opts.bootSeconds, 20),
      cdp: false,
      cdpPort: opts.cdpPort,
      mainJs,
      forceFirstRun: true,
    });
    blockers.forEach(killBlocker);
    reports.push({
      name: c.name,
      pass: r.killed && r.bootedFor >= Math.min(opts.bootSeconds, 20) * 1000 - 250,
      detail:
        `bootedFor=${r.bootedFor}ms exit=${r.exitCode} signal=${r.signal}\n` +
        tailOutput(r.stdout, r.stderr),
    });
  }

  // 5.2.d — two concurrent desktop instances. Each should boot in
  // its own user-data-dir; D133 multi-instance work assumes the
  // packaged client tolerates concurrent launches without crash.
  const cdp1 = opts.cdpPort;
  const cdp2 = opts.cdpPort + 1;
  const [r1, r2] = await Promise.all([
    launchOnce({
      appExecutable: exe,
      bootSeconds: Math.min(opts.bootSeconds, 20),
      cdp: false,
      cdpPort: cdp1,
      mainJs,
      forceFirstRun: true,
    }),
    launchOnce({
      appExecutable: exe,
      bootSeconds: Math.min(opts.bootSeconds, 20),
      cdp: false,
      cdpPort: cdp2,
      mainJs,
      forceFirstRun: true,
    }),
  ]);
  const survivalFloor = Math.min(opts.bootSeconds, 20) * 1000 - 250;
  reports.push({
    name: "5.2.d two concurrent desktop instances",
    pass:
      r1.killed && r2.killed &&
      r1.bootedFor >= survivalFloor && r2.bootedFor >= survivalFloor,
    detail:
      `instance1 bootedFor=${r1.bootedFor}ms exit=${r1.exitCode}\n` +
      `instance2 bootedFor=${r2.bootedFor}ms exit=${r2.exitCode}`,
  });

  return reports;
}

function tailOutput(stdout: string, stderr: string, lines = 12): string {
  const out = (stdout + stderr).split("\n").slice(-lines).join("\n");
  return out ? `tail:\n${out}` : "(no output)";
}

// =============================================================================
// Entry
// =============================================================================
async function main(): Promise<void> {
  const opts = parseCli(process.argv.slice(2));
  process.stdout.write(
    `[smoke] mode=${opts.portsMatrix ? "ports-matrix" : "default"} ` +
      `target=${opts.unpackaged ? "unpackaged" : "packaged"} ` +
      `app=${opts.appPath} cdp=${opts.cdp} bootSeconds=${opts.bootSeconds}\n`,
  );

  const reports = opts.portsMatrix
    ? await runPortsMatrix(opts)
    : await runDefault(opts);

  const ok = summarize(reports);
  process.exit(ok ? 0 : 1);
}

if (import.meta.main) {
  main().catch((err) => {
    process.stderr.write(`[smoke] fatal: ${(err as Error).stack ?? err}\n`);
    process.exit(2);
  });
}
