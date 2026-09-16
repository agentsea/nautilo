/**
 * M167 desktop-only launcher.
 *
 * The `app` script runs `build:electron` first; this just launches the
 * already-built Electron main bundle in connect mode. Without an explicit
 * `NAUTILO_CONNECT_SERVER_URL` it reuses the profile's persisted connection,
 * opening the first-run/connect picker only when no valid connection exists;
 * with an explicit loopback URL it preserves that URL so the unpackaged
 * Desktop can establish its development trust record and pair its relay. An optional
 * per-profile userData/auth segregation (see `electron/main.ts`
 * `computeUserDataDirName`). Run several at once with different profiles.
 *
 * Profile is optional and may be passed positionally OR via `--profile`:
 *   bun run desktop second
 *   bun run desktop --profile second
 *   bun run desktop                  (default profile)
 *
 * Stack 198 / M161 Phase 5 — `NAUTILO_REMOTE_DEBUGGING_PORT` opts the launched
 * Electron into a CDP listener. The launcher builds the Electron argv in a
 * pure, testable helper (`buildDesktopArgs`) so the second-copy smoke can
 * assert the root launcher (not just the `apps/desktop` dev script) threads
 * the configured port. When unset, behavior is unchanged: no CDP flag is
 * appended in the normal app path.
 */
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";

const PROFILE_SLUG = /^[a-z0-9_-]{1,32}$/;

/** Env var name for opting the launched Electron into a CDP listener. */
export const REMOTE_DEBUGGING_PORT_ENV = "NAUTILO_REMOTE_DEBUGGING_PORT";
const REMOTE_DEBUGGING_PORT_FLAG = "--remote-debugging-port";

export interface BuildDesktopArgsOptions {
  argv: string[];
  env: Record<string, string | undefined>;
  mainBundlePath: string;
}

export interface DesktopArgs {
  args: string[];
  profile: string | undefined;
  remoteDebuggingPort: number | undefined;
}

export function buildDesktopChildEnv(
  env: Record<string, string | undefined>,
): Record<string, string | undefined> {
  return {
    ...env,
    NAUTILO_HOST: env["NAUTILO_HOST"] ?? "127.0.0.1",
    // The explicit URL is the documented cloned-default/second-copy path.
    // Forcing first-run would discard it, bypass loopback trust, and leave a
    // signed-in Desktop unable to pair its relay or send ordinary messages.
    NAUTILO_FORCE_FIRST_RUN: env["NAUTILO_CONNECT_SERVER_URL"]
      ? "0"
      : (env["NAUTILO_FORCE_FIRST_RUN"] ?? "0"),
    // This launcher is a connect client even though its Electron binary is
    // unpackaged. Prefer the profile's committed connection; a new profile
    // still reaches the picker through main's packaged/connect branch.
    NAUTILO_PREFER_PERSISTED_CONNECTION: "1",
  };
}

export function resolveProfile(argv: string[]): string | undefined {
  const flagIdx = argv.indexOf("--profile");
  const raw = flagIdx !== -1 ? argv[flagIdx + 1] : argv.find((a) => !a.startsWith("-"));
  if (raw === undefined) return undefined;
  if (raw.startsWith("-") || !PROFILE_SLUG.test(raw)) {
    throw new Error(
      `Invalid profile "${raw}" — expected a slug of 1–32 characters [a-z0-9_-]`,
    );
  }
  return raw;
}

/**
 * Validate a raw `NAUTILO_REMOTE_DEBUGGING_PORT` value. Returns the integer
 * port on success; throws on anything that is not a decimal integer in
 * 1..65535. The error message echoes the offending value but the value is a
 * port number an operator chooses, not a secret, so it is safe to surface.
 */
function parseRemoteDebuggingPort(raw: string): number {
  const trimmed = raw.trim();
  if (!/^[0-9]+$/.test(trimmed)) {
    throw new Error(
      `Invalid ${REMOTE_DEBUGGING_PORT_ENV}="${raw}" — expected a decimal integer 1..65535`,
    );
  }
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new Error(
      `Invalid ${REMOTE_DEBUGGING_PORT_ENV}="${raw}" — port must be an integer 1..65535`,
    );
  }
  return n;
}

/**
 * Pure builder for the Electron argv the launcher spawns. No process.env /
 * process.argv / spawn access — callers pass them in so this is deterministic
 * under `bun:test` and the second-copy smoke driver.
 *
 * - Always leads with the main bundle path; appends `--profile <slug>` when a
 *   profile resolves (positional or `--profile`), preserving M167 behavior.
 * - When `NAUTILO_REMOTE_DEBUGGING_PORT` is set and non-empty, validates it as
 *   a decimal integer 1..65535 and appends `--remote-debugging-port=<port>`.
 *   When unset/empty, no CDP flag is appended (normal app path unchanged).
 * - Never emits a duplicate `--remote-debugging-port` if one is already
 *   present in the constructed args (the current launcher does not forward
 *   arbitrary argv, so this guard is defensive — see Stack 198).
 */
export function buildDesktopArgs({
  argv,
  env,
  mainBundlePath,
}: BuildDesktopArgsOptions): DesktopArgs {
  const profile = resolveProfile(argv);
  const args: string[] = [mainBundlePath];
  if (profile !== undefined) args.push("--profile", profile);

  const envPort = env[REMOTE_DEBUGGING_PORT_ENV];
  let remoteDebuggingPort: number | undefined;
  if (envPort !== undefined && envPort !== "") {
    remoteDebuggingPort = parseRemoteDebuggingPort(envPort);
    const alreadyForwarded = args.some(
      (a) => a === REMOTE_DEBUGGING_PORT_FLAG || a.startsWith(`${REMOTE_DEBUGGING_PORT_FLAG}=`),
    );
    if (!alreadyForwarded) {
      args.push(`${REMOTE_DEBUGGING_PORT_FLAG}=${remoteDebuggingPort}`);
    }
  }

  return { args, profile, remoteDebuggingPort };
}

function main(): void {
  const mainBundlePath = join(import.meta.dirname, "..", "dist", "main.js");
  let desktopArgs: DesktopArgs;
  try {
    desktopArgs = buildDesktopArgs({
      argv: process.argv.slice(2),
      env: process.env,
      mainBundlePath,
    });
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  }

  const electronPath = createRequire(import.meta.url)("electron") as unknown as string;
  const child = spawn(electronPath, desktopArgs.args, {
    stdio: "inherit",
    env: buildDesktopChildEnv(process.env),
  });
  child.on("exit", (code) => {
    process.exit(code ?? 0);
  });
}

if (import.meta.main) {
  main();
}
