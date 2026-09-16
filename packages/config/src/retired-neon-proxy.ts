import { warn } from "@nautilo/logger";

const warnedSources = new Set<string>();

/**
 * M215 — one-release compatibility: stale operator config may still carry
 * neon-proxy ports. Log once per source and ignore the value.
 */
export function warnRetiredNeonProxyConfig(source: string): void {
  if (warnedSources.has(source)) return;
  warnedSources.add(source);
  warn(
    `[resolveInstance] ${source} is retired (ISSUE-M215): the local Neon HTTP proxy topology was removed. ` +
      "Direct PostgreSQL wire protocol is the only dev/runtime path; this field is ignored.",
  );
}

/** True when `NAUTILO_NEON_PROXY_PORT` is set to any non-empty value (numeric or not). */
function retiredNeonProxyEnvPresent(env: NodeJS.ProcessEnv): boolean {
  const raw = env["NAUTILO_NEON_PROXY_PORT"]?.trim();
  return raw !== undefined && raw !== "";
}

/** Warn once when a retired env override is present; never apply it to resolved output. */
export function warnIfRetiredNeonProxyEnvPresent(env: NodeJS.ProcessEnv): void {
  if (retiredNeonProxyEnvPresent(env)) {
    warnRetiredNeonProxyConfig("NAUTILO_NEON_PROXY_PORT");
  }
}

/** @internal test seam */
export function __resetRetiredNeonProxyWarningsForTests(): void {
  warnedSources.clear();
}
