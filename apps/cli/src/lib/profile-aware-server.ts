/**
 * Profile-aware server resolution for CLI commands (D120 A5.3 follow-up).
 * Encapsulates the precedence: flag > env > active profile > default.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  profilesRootDir,
  resolveTransport,
  withUnixSocket as apiClientWithUnixSocket,
  type ResolvedTransport,
} from "./api-client.ts";
import { loadProfile } from "./profile-schema.ts";
import { resolveCliServerUrl } from "@nautilo/api-client";

type ServerSource = "flag" | "env" | "profile" | "default";

export type ResolvedServer = {
  baseUrl: string;
  bearer?: string;
  unixSocketPath?: string;
  source: ServerSource;
};

function activeFile(home: string): string {
  return join(profilesRootDir(home), ".active");
}

function resolveHome(home?: string): string {
  if (home !== undefined) {
    return home;
  }
  const h = process.env["HOME"];
  if (!h || h.trim() === "") {
    throw new Error("HOME is not set");
  }
  return h;
}

/** Set by `apps/cli` yargs middleware when global `--profile` is passed. */
let cliProfileFlagOverride: string | undefined;

export function setCliProfileFlagOverride(name: string | undefined): void {
  cliProfileFlagOverride =
    typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

/**
 * Effective active profile: global `--profile` flag (when set), else
 * `~/.nautilo/profiles/.active` (trimmed). Returns `undefined` if neither applies.
 */
export function readActiveProfileName(home?: string): string | undefined {
  if (cliProfileFlagOverride) return cliProfileFlagOverride;
  try {
    const h = resolveHome(home);
    const af = activeFile(h);
    if (!existsSync(af)) return undefined;
    const name = readFileSync(af, "utf8").trim();
    return name.length > 0 ? name : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the effective server transport for a CLI command.
 *
 * Resolution precedence (highest to lowest):
 * 1. --server <url> flag: use plain baseUrl, no bearer, no unix socket.
 * 2. NAUTILO_SERVER_URL env: same as flag (legacy behavior).
 * 3. Active profile (`--profile` flag or ~/.nautilo/profiles/.active): resolve via resolveTransport().
 * 4. Default: use resolveCliServerUrl({ serverFlag: undefined }) behavior.
 */
export async function resolveServerForCommand({
  serverFlag,
  templateServerUrl,
  home,
}: {
  serverFlag?: string | undefined;
  /** Setup-template `[serverUrl]` — preserves D112 Phase 9 precedence (flag > template > env > profile > default). */
  templateServerUrl?: string | undefined;
  home?: string | undefined;
}): Promise<ResolvedServer> {
  // 1. CLI --server flag wins
  if (serverFlag !== undefined && serverFlag.trim() !== "") {
    return { baseUrl: serverFlag.trim(), source: "flag" };
  }

  // 2. Setup-template serverUrl (only nautilo setup passes this; legacy precedence)
  if (templateServerUrl !== undefined && templateServerUrl.trim() !== "") {
    return { baseUrl: templateServerUrl.trim(), source: "flag" };
  }

  // 3. Environment variable NAUTILO_SERVER_URL
  const envUrl = process.env["NAUTILO_SERVER_URL"]?.trim();
  if (envUrl) {
    return { baseUrl: envUrl, source: "env" };
  }

  // 4. Active profile (--profile flag wins over ~/.nautilo/profiles/.active)
  const h = resolveHome(home);
  const profileName = readActiveProfileName(h);
  if (profileName) {
    const profile = loadProfile(profileName, h);
    const transport = await resolveTransport(profile, h);
    const result: ResolvedServer = {
      baseUrl: transport.baseUrl,
      source: "profile",
    };
    if (transport.bearer !== undefined) {
      result.bearer = transport.bearer;
    }
    if (transport.unixSocketPath !== undefined) {
      result.unixSocketPath = transport.unixSocketPath;
    }
    return result;
  }

  // 5. Default behavior
  const defaultUrl = resolveCliServerUrl({ serverFlag: undefined });
  return { baseUrl: defaultUrl, source: "default" };
}

/** Re-export withUnixSocket from api-client for convenience. */
export function withUnixSocket(
  transport: ResolvedServer,
  init?: RequestInit,
): RequestInit & { unix?: string } {
  // Delegate to the api-client version by converting ResolvedServer to ResolvedTransport shape
  // Build the object conditionally to satisfy exactOptionalPropertyTypes
  const transportLike: ResolvedTransport = { baseUrl: transport.baseUrl };
  if (transport.bearer !== undefined) {
    transportLike.bearer = transport.bearer;
  }
  if (transport.unixSocketPath !== undefined) {
    transportLike.unixSocketPath = transport.unixSocketPath;
  }
  return apiClientWithUnixSocket(transportLike, init) as RequestInit & { unix?: string };
}

/**
 * D120 A5.3 (review fix) — single transport-aware `fetch` for CLI commands.
 *
 * Use this instead of bare `fetch()` for *every* HTTP call inside a CLI
 * command handler. It:
 *   1. Joins `transport.baseUrl` (which may be `"http://localhost"` for an
 *      active local profile resolved to a Unix socket) with `path`.
 *   2. Forwards Bun's `unix:` request init when the transport is a socket
 *      so the request actually reaches the server instead of `localhost:80`.
 *   3. Leaves all other init (headers, body, signal, ...) untouched.
 *
 * Bare `fetch()` against a profile-resolved baseUrl is a footgun — it
 * silently dials the wrong port. Reviewer-flagged regression:
 * `apps/cli/src/commands/setup.ts` did this for `/api/health/keys` and
 * `/api/setup/reload-env` before the A5.3 follow-up.
 */
export function transportFetch(
  transport: ResolvedServer,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = `${transport.baseUrl.replace(/\/$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(url, withUnixSocket(transport, init));
}

/**
 * Convenience constructor-options helper: pass the result as the second arg
 * to `new NautiloApiClient(transport.baseUrl, apiClientOptionsFor(transport))`.
 * Returns `undefined` when there is no Unix socket so the no-arg behaviour
 * is preserved for plain TCP transports.
 */
export function apiClientOptionsFor(
  transport: ResolvedServer,
): { unixSocketPath: string } | undefined {
  if (transport.unixSocketPath !== undefined) {
    return { unixSocketPath: transport.unixSocketPath };
  }
  return undefined;
}

/**
 * Create fetch headers for a profile-aware request.
 *
 * Bearer precedence when both a profile bootstrap-token and a session bearer exist:
 * - Session bearer wins (the user has logged in; bootstrap is only the substrate auth).
 * - Profile bearer is used only when no session bearer is provided.
 */
export function buildAuthHeaders(
  transport: ResolvedServer,
  sessionBearer?: string  ,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  // Session bearer takes precedence over profile bootstrap token
  if (sessionBearer) {
    headers["Authorization"] = `Bearer ${sessionBearer}`;
  } else if (transport.bearer) {
    headers["Authorization"] = `Bearer ${transport.bearer}`;
  }

  return headers;
}

// NOTE: `loadProfile`, `readHome`, `resolveHome` and `profilesRootDir` are
// not re-exported here because no caller outside this file consumes them via
// this module — `apps/cli/src/commands/profile.ts` keeps its own private copies
// and tests import `profilesRootDir` from `./api-client.ts` directly. Adding
// re-exports here just to centralize the surface trips `lint:unused`.
