import { dirname } from "node:path";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";

export function normalizeRelayServerUrl(url: string): string {
  const trimmed = url.trim();
  try {
    const parsed = new URL(trimmed);
    if (
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    ) {
      return parsed.origin;
    }
  } catch {
    // The caller's endpoint validation owns the public error. Preserve the
    // legacy non-throwing normalizer for bootstrap callers and tests.
  }
  return trimmed.replace(/\/+$/, "");
}

/** Server base URL: `resolveInstance(env).server.url` (env / config / instance.json). */
export function resolveRelayServerUrl(env: NodeJS.ProcessEnv = process.env): string {
  return normalizeRelayServerUrl(resolveInstance(env).server.url);
}

/** Nautilo data root (`~/.nautilo`), aligned with server + posture sidecars. */
export function resolveRelayDataDir(env: NodeJS.ProcessEnv = process.env): string {
  const userHomeDir =
    env["HOME"]?.trim() ||
    env["USERPROFILE"]?.trim() ||
    undefined;
  const resolvedHome =
    userHomeDir && userHomeDir !== "" ? userHomeDir : undefined;
  return resolveNautiloRootDir({
    env,
    ...(resolvedHome !== undefined ? { userHomeDir: resolvedHome } : {}),
  });
}

export function resolveRelayUserHome(dataDir: string): string {
  return dirname(dataDir);
}
