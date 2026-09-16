/**
 * M055 — Electron-bound facade over the pure `token-store` module.
 *
 * Imports `electron` + `node:fs` directly; only main-process code
 * should ever pull this in. Tests must use the pure module with
 * injected fakes (or `parseProfileFromArgv` from `./profile-from-argv`).
 */
import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseNautiloInstanceId,
  resolveInstance,
  resolveNautiloRootDir,
} from "@nautilo/config";
import { warn } from "@nautilo/logger";
import {
  authFilePath,
  clearTokens as clearTokensImpl,
  loadTokensResult,
  migrateLegacyAuthV1IfDefaultInstance,
  migrateLegacySingleServerAuth,
  saveTokens as saveTokensImpl,
  type AuthIdentity,
  type TokenBundle,
  type TokenStoreDeps,
} from "./token-store";
import { parseProfileFromArgv } from "./profile-from-argv";
import { canonicalServerScope } from "../url-canonical";

// `@nautilo/logger` exposes flat `warn(msg, ...meta)` rather than a
// per-namespace getLogger; adapt to the structured-warn shape the
// pure token-store module expects.
const logger: TokenStoreDeps["logger"] = {
  warn: (obj, msg) => {
    warn(`[desktop.auth.token_store] ${msg}`, obj ?? {});
  },
};

let profileFromArgv: string | undefined;
let argvProfileInited = false;
let migrationAttempted = false;
let singleServerMigrationAttempted = false;

export type DesktopAuthIssue = {
  kind: "scope-mismatch";
  expected: AuthIdentity;
  disk: AuthIdentity | null;
};

export type DesktopAuthNotice = {
  kind: "env-pinned-auth-cleared";
  expected: AuthIdentity;
  disk: AuthIdentity | null;
};

let lastAuthIssue: DesktopAuthIssue | null = null;
let pendingAuthNotice: DesktopAuthNotice | null = null;

/**
 * Parse `--profile` once (idempotent). Call from the argv bootstrap
 * module so invalid values fail fast with the same exit semantics as
 * `--instance`.
 */
export function initDesktopAuthProfileFromArgv(argv: string[]): void {
  if (argvProfileInited) return;
  argvProfileInited = true;
  profileFromArgv = parseProfileFromArgv(argv);
}

/**
 * M097 — the desktop deliberately does NOT load `~/.nautilo${suffix}/instance.env`
 * into `process.env` (that file is the server-side runtime surface). The
 * Logto endpoint + app id + the **paired server URL** come from `main.ts`
 * (`resolveLogtoConfig()` / boot URL resolution); main registers a descriptor
 * factory here once those values are resolved. saveTokens / loadTokens
 * call the factory through `composeAuthIdentityOrThrow()`.
 *
 * The `clientAppId` field maps to the on-disk `workbenchAppId` slot for
 * envelope-version stability — the desktop bundle is scoped to the
 * Logto Native (desktop) app the same way the workbench is scoped to
 * the SPA app; both are tenant-unique and share the v2 schema.
 */
let identityDescriptorProvider:
  | (() => { serverUrl: string; logtoEndpoint: string; clientAppId: string })
  | null = null;

export function registerDesktopAuthIdentityDescriptor(
  fn: () => { serverUrl: string; logtoEndpoint: string; clientAppId: string },
): void {
  identityDescriptorProvider = fn;
}

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * M161 Phase 2 — fetch + validate the global identity descriptor.
 *
 * The descriptor is registered by `main.ts` once Logto config resolves for
 * the active session; it carries the active session's `serverUrl` plus the
 * Logto endpoint/app id. The `…For(serverUrl)` entry points override the
 * `serverUrl` with a caller-supplied canonical value while reusing the
 * descriptor's Logto endpoint/app id — in Phase 2 only the active session's
 * auth IPC fires, so the descriptor's Logto values are always the right ones.
 */
function requireDescriptor(): {
  serverUrl: string;
  logtoEndpoint: string;
  clientAppId: string;
} {
  if (!identityDescriptorProvider) {
    throw new Error(
      "Desktop auth identity not initialized — main.ts must call " +
        "registerDesktopAuthIdentityDescriptor() after resolveLogtoConfig().",
    );
  }
  const desc = identityDescriptorProvider();
  const logtoEndpoint = desc.logtoEndpoint.trim();
  const clientAppId = desc.clientAppId.trim();
  if (!logtoEndpoint || !clientAppId) {
    throw new Error(
      "Desktop auth identity descriptor returned empty values; refusing to scope the auth bundle.",
    );
  }
  const serverUrl = desc.serverUrl.trim();
  if (!serverUrl) {
    throw new Error(
      "descriptor returned empty serverUrl; refusing to scope the auth bundle",
    );
  }
  return { serverUrl, logtoEndpoint, clientAppId };
}

/** Build the persisted identity envelope for the active session; throws if not yet registered. */
export function composeAuthIdentityOrThrow(): AuthIdentity {
  const desc = requireDescriptor();
  const inst = resolveInstance();
  // The descriptor's serverUrl is the active session's canonical URL
  // (registered in resolveLogtoConfig from the registry's already-
  // canonicalized session URL). Strip any trailing slashes so
  // `https://x/` and `https://x` share one bundle slot. We do NOT
  // re-run `canonicalServerScope` here: the descriptor value is already
  // canonical, and the pre-Phase-2 contract (covered by
  // token-store-electron.test.ts) strips ALL trailing slashes.
  return {
    instanceId: inst.instanceId.trim(),
    serverUrl: stripTrailingSlash(desc.serverUrl),
    logtoEndpoint: stripTrailingSlash(desc.logtoEndpoint),
    workbenchAppId: desc.clientAppId,
  };
}

/**
 * M161 Phase 2 — build an `AuthIdentity` scoped to an explicit canonical
 * server URL. The `serverUrl` is canonicalized through the single-source
 * `canonicalServerScope` helper (same one recents / token filenames /
 * partitions / registry scopes use) before any path derivation, so
 * `https://X/` and `https://x` share one bundle slot. The Logto endpoint +
 * app id still come from the active session's descriptor (Phase 2 only
 * permits the active session to drive auth).
 */
function composeAuthIdentityForServerOrThrow(serverUrl: string): AuthIdentity {
  const desc = requireDescriptor();
  const inst = resolveInstance();
  return {
    instanceId: inst.instanceId.trim(),
    serverUrl: canonicalServerScope(serverUrl),
    logtoEndpoint: stripTrailingSlash(desc.logtoEndpoint),
    workbenchAppId: desc.clientAppId,
  };
}

function envPinnedConnectServerUrl(): string | null {
  const v = process.env["NAUTILO_CONNECT_SERVER_URL"]?.trim();
  return v || null;
}

function deps(): TokenStoreDeps {
  return {
    safeStorage,
    fs: {
      writeFileSync: fs.writeFileSync,
      readFileSync: fs.readFileSync,
      unlinkSync: fs.unlinkSync,
      chmodSync: fs.chmodSync,
      existsSync: fs.existsSync,
      renameSync: fs.renameSync,
    },
    authDir: resolveNautiloRootDir(),
    profile: profileFromArgv,
    logger,
  };
}

/** D514 — token I/O bound to one explicit, health-derived server identity. */
export function createIdentityBoundTokenStore(input: {
  routingServerUrl: string;
  logtoEndpoint: string;
  clientAppId: string;
}): {
  load(): TokenBundle | null;
  save(tokens: TokenBundle): void;
  clear(): void;
  /** Marker-authorized exact-slot retirement; ENOENT is the only no-op. */
  retireExact(): void;
} {
  const routingServerUrl = canonicalServerScope(input.routingServerUrl);
  const logtoEndpoint = canonicalServerScope(input.logtoEndpoint);
  if (![routingServerUrl, logtoEndpoint].every((value) => /^https?:\/\//.test(value)))
    throw new Error("identity-bound auth scope requires HTTP(S) URLs");
  const clientAppId = input.clientAppId.trim();
  if (!clientAppId) throw new Error("identity-bound auth scope requires clientAppId");
  const identity: AuthIdentity = {
    instanceId: resolveInstance().instanceId.trim(),
    serverUrl: routingServerUrl,
    logtoEndpoint,
    workbenchAppId: clientAppId,
  };
  const d = deps();
  return {
    load: () => {
      const result = loadTokensResult(d, { expectedIdentity: identity });
      return result.kind === "loaded" ? result.bundle : null;
    },
    save: (tokens) => {
      fs.mkdirSync(d.authDir, { recursive: true });
      saveTokensImpl(d, { bundle: tokens, identity });
    },
    clear: () => {
      const result = loadTokensResult(d, { expectedIdentity: identity });
      if (result.kind === "loaded") clearTokensImpl(d, identity);
    },
    retireExact: () => {
      try { d.fs.unlinkSync(authFilePath(d, identity)); }
      catch (error) {
        if (typeof error === "object" && error !== null &&
            (error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
    },
  };
}

export function saveTokensFor(serverUrl: string, tokens: TokenBundle): void {
  const authDir = resolveNautiloRootDir();
  fs.mkdirSync(authDir, { recursive: true });
  const identity = composeAuthIdentityForServerOrThrow(serverUrl);
  saveTokensImpl(deps(), { bundle: tokens, identity });
}

export function loadTokensFor(serverUrl: string): TokenBundle | null {
  let identity: AuthIdentity;
  try {
    identity = composeAuthIdentityForServerOrThrow(serverUrl);
  } catch {
    return null;
  }
  const d = deps();
  if (!singleServerMigrationAttempted) {
    singleServerMigrationAttempted = true;
    migrateLegacySingleServerAuth(d, identity);
  }
  const envPinned = envPinnedConnectServerUrl();
  const first = loadTokensResult(d, {
    expectedIdentity: identity,
    envPinnedServerUrl: envPinned,
  });
  if (first.kind === "loaded") {
    lastAuthIssue = null;
    return first.bundle;
  }
  if (first.kind === "env-pinned-cleared") {
    pendingAuthNotice = {
      kind: "env-pinned-auth-cleared",
      expected: first.expected,
      disk: first.disk,
    };
    lastAuthIssue = null;
    return null;
  }
  if (first.kind === "scope-mismatch") {
    lastAuthIssue = {
      kind: "scope-mismatch",
      expected: first.expected,
      disk: first.disk,
    };
  } else {
    lastAuthIssue = null;
  }
  if (migrationAttempted) return null;
  migrationAttempted = true;
  const legacyPath = path.join(app.getPath("userData"), "auth.json");
  const isDefault = parseNautiloInstanceId(process.env) === "";
  migrateLegacyAuthV1IfDefaultInstance(d, {
    legacyPath,
    identity,
    isDefaultInstance: isDefault,
  });
  const second = loadTokensResult(deps(), {
    expectedIdentity: identity,
    envPinnedServerUrl: envPinned,
  });
  if (second.kind === "loaded") {
    lastAuthIssue = null;
    return second.bundle;
  }
  if (second.kind === "env-pinned-cleared") {
    pendingAuthNotice = {
      kind: "env-pinned-auth-cleared",
      expected: second.expected,
      disk: second.disk,
    };
    lastAuthIssue = null;
    return null;
  }
  if (second.kind === "scope-mismatch") {
    lastAuthIssue = {
      kind: "scope-mismatch",
      expected: second.expected,
      disk: second.disk,
    };
  } else {
    lastAuthIssue = null;
  }
  return null;
}

export function clearTokensFor(serverUrl: string): void {
  const identity = composeAuthIdentityForServerOrThrow(serverUrl);
  clearTokensImpl(deps(), identity);
  lastAuthIssue = null;
}

/**
 * M161 Phase 2 — active-session wrappers. Non-session callers (boot,
 * menu, refresh) keep working; the wrappers delegate to the `…For`
 * variants using the active session's server URL, which the global
 * descriptor carries (registered in `resolveLogtoConfig`). `null`-safe:
 * `loadTokens` returns `null` when no active session / descriptor is
 * registered yet; `saveTokens` / `clearTokens` throw to preserve the
 * pre-Phase-2 contract (a caller that writes/clears without a resolved
 * session has a logic bug).
 */
export function saveTokens(tokens: TokenBundle): void {
  saveTokensFor(composeAuthIdentityOrThrow().serverUrl, tokens);
}

export function loadTokens(): TokenBundle | null {
  let serverUrl: string;
  try {
    serverUrl = composeAuthIdentityOrThrow().serverUrl;
  } catch {
    return null;
  }
  return loadTokensFor(serverUrl);
}

export function clearTokens(): void {
  clearTokensFor(composeAuthIdentityOrThrow().serverUrl);
}

export function getLastAuthIssue(): DesktopAuthIssue | null {
  return lastAuthIssue;
}

export function consumeAuthNotice(): DesktopAuthNotice | null {
  const notice = pendingAuthNotice;
  pendingAuthNotice = null;
  return notice;
}

export type { AuthIdentity, TokenBundle } from "./token-store";
