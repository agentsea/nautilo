/**
 * M102 — headless-host detection for CLI authentication.
 *
 * Pure module. Inspects `process.env` (or an injected env map) plus the
 * host OS to decide whether launching a system browser for loopback PKCE
 * is likely to fail — e.g. SSH sessions without a display on Linux, or
 * an operator forcing the device-code path via `NAUTILO_FORCE_DEVICE_FLOW`.
 * Callers use `detectHeadless()` at runtime and `detectHeadlessForPlatform`
 * in unit tests so Linux-only rules can run on macOS CI.
 */

export interface HeadlessDecision {
  headless: boolean;
  /** Collected signals, e.g. `ssh-session`, `no-display`, `env-force`. */
  reasons: string[];
}

function isNonEmpty(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

export function detectHeadlessForPlatform(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): HeadlessDecision {
  const reasons: string[] = [];

  if (
    isNonEmpty(env["SSH_CONNECTION"]) ||
    isNonEmpty(env["SSH_TTY"]) ||
    isNonEmpty(env["SSH_CLIENT"])
  ) {
    reasons.push("ssh-session");
  }

  const hasDisplay =
    isNonEmpty(env["DISPLAY"]) || isNonEmpty(env["WAYLAND_DISPLAY"]);
  if (platform === "linux" && !hasDisplay) {
    reasons.push("no-display");
  }

  if (env["NAUTILO_FORCE_DEVICE_FLOW"] === "1") {
    reasons.push("env-force");
  }

  return {
    headless: reasons.length > 0,
    reasons,
  };
}

export function detectHeadless(env?: NodeJS.ProcessEnv): HeadlessDecision {
  return detectHeadlessForPlatform(env ?? process.env, process.platform);
}
