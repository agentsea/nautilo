/**
 * M055 — token persistence for the Electron Logto flow.
 *
 * Storage shape:
 *   <header>\n<payload>
 *
 * Two header tags discriminate the format without guessing on byte
 * distribution (a previous draft used "first byte non-printable",
 * which is fragile — `safeStorage` ciphertext on macOS can
 * incidentally start with a printable byte):
 *
 *   nautilo-auth-v2-enc   safeStorage-encrypted JSON payload (PersistedAuth v2)
 *   nautilo-auth-v2-pt    plaintext JSON, chmod 600 (libsecret-less Linux)
 *
 * Legacy v1 headers (migration + one-shot upgrade only):
 *
 *   nautilo-auth-v1-enc   safeStorage-encrypted JSON (raw TokenBundle)
 *   nautilo-auth-v1-pt    plaintext raw TokenBundle JSON
 *
 * `loadTokens` fails closed on any unrecognised header, malformed
 * JSON, identity mismatch on v2, or "encrypted disk format but platform can't decrypt" —
 * the caller treats every non-recognition as "no tokens, re-run sign-in".
 *
 * Dependency injection: every Electron-bound side-effect (safeStorage,
 * auth dir path, fs) is passed through a `TokenStoreDeps` so the
 * module can be unit-tested under `bun:test` without an Electron
 * runtime. The thin Electron-bound facade lives in
 * `token-store-electron.ts`.
 */
import { createHash } from "node:crypto";
import * as path from "node:path";

import { appendAuthBundleClearedAudit } from "./local-auth-audit";

export interface TokenBundle {
  access_token: string;
  /**
   * Required. M060 flipped `customClientMetadata.alwaysIssueRefreshToken`
   * on the `Nautilo Desktop` Native app, so Logto now always returns a
   * refresh_token from the loopback PKCE exchange. A bundle without
   * one is corrupt (or pre-M060) and `loadTokens` rejects it — the
   * caller treats it as "no tokens, re-run sign-in" rather than
   * silently degrading to "user re-signs-in every hour".
   */
  refresh_token: string;
  /** Required for RP-initiated logout (§6.8). */
  id_token: string;
  expires_in: number;
  /** Unix ms; used by `isAccessTokenExpiring` to compute expiry. */
  refreshed_at: number;
}

/** Non-secret connection identity persisted with the bundle (defence-in-depth). */
export interface AuthIdentity {
  instanceId: string;
  serverUrl: string;
  logtoEndpoint: string;
  workbenchAppId: string;
}

/** On-disk JSON inside the v2 outer header (before encryption). */
export interface PersistedAuth {
  v: 2;
  identity: AuthIdentity;
  bundle: TokenBundle;
}

export type TokenLoadResult =
  | { kind: "loaded"; bundle: TokenBundle }
  | { kind: "none" }
  | {
      kind: "env-pinned-cleared";
      expected: AuthIdentity;
      disk: AuthIdentity | null;
    }
  | {
      kind: "scope-mismatch";
      expected: AuthIdentity;
      disk: AuthIdentity | null;
    };

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(buf: Buffer): string;
}

export interface FsLike {
  writeFileSync: (
    path: string,
    data: Buffer | string,
    options?: { mode?: number },
  ) => void;
  readFileSync: (path: string) => Buffer;
  unlinkSync: (path: string) => void;
  chmodSync: (path: string, mode: number) => void;
  existsSync: (path: string) => boolean;
  renameSync: (from: string, to: string) => void;
}

export interface TokenStoreLogger {
  warn: (
    obj: Record<string, unknown> | undefined,
    msg: string,
  ) => void;
}

export interface TokenStoreDeps {
  safeStorage: SafeStorageLike;
  fs: FsLike;
  /** Resolved per-instance directory (e.g. `resolveNautiloRootDir()`). */
  authDir: string;
  /**
   * Optional multi-account slug from `--profile` (already validated
   * `[a-z0-9_-]{1,32}` and lowercased by the Electron facade).
   */
  profile?: string | undefined;
  logger: TokenStoreLogger;
  /** Tests may inject a fake audit writer; production uses the default. */
  appendAuthBundleClearedAudit?: typeof appendAuthBundleClearedAudit;
}

/** Legacy v1 encrypted outer header (raw {@link TokenBundle} JSON inside). */
export const HEADER_ENC_V1 = Buffer.from("nautilo-auth-v1-enc\n", "utf-8");
/** Legacy v1 plaintext outer header. */
export const HEADER_PT_V1 = Buffer.from("nautilo-auth-v1-pt\n", "utf-8");

export const HEADER_ENC_V2 = Buffer.from("nautilo-auth-v2-enc\n", "utf-8");
export const HEADER_PT_V2 = Buffer.from("nautilo-auth-v2-pt\n", "utf-8");


const FILE_MODE = 0o600;

function stripTrailingSlash(u: string): string {
  return u.replace(/\/+$/, "");
}

/**
 * Per-server scope key for auth filenames (M123). Trailing slashes on
 * `serverUrl` are stripped before hashing so `https://x/` and `https://x`
 * share one bundle slot.
 */
export function serverUrlScope(serverUrl: string): string {
  return createHash("sha256")
    .update(stripTrailingSlash(serverUrl))
    .digest("hex")
    .slice(0, 16);
}

/**
 * Pre-M123 single-server basename (`desktop-auth[-<profile>].json`).
 * Used only for one-shot rename migration into the keyed filename.
 */
export function legacyAuthFilePath(deps: TokenStoreDeps): string {
  const base =
    deps.profile !== undefined && deps.profile !== ""
      ? `desktop-auth-${deps.profile}.json`
      : "desktop-auth.json";
  return path.join(deps.authDir, base);
}

/**
 * Absolute path to the per-server auth file for `identity`.
 *
 * Basename: `desktop-auth[-<profile>]-<sha256(serverUrl).slice(0,16)>.json`.
 * The profile slug is **not** validated here — the Electron facade must
 * pass a value already validated as `[a-z0-9_-]{1,32}` and lowercased.
 */
export function authFilePath(deps: TokenStoreDeps, identity: AuthIdentity): string {
  const scope = serverUrlScope(identity.serverUrl);
  const base =
    deps.profile !== undefined && deps.profile !== ""
      ? `desktop-auth-${deps.profile}-${scope}.json`
      : `desktop-auth-${scope}.json`;
  return path.join(deps.authDir, base);
}

function identitiesEqual(a: AuthIdentity, b: AuthIdentity): boolean {
  return (
    a.instanceId === b.instanceId &&
    a.serverUrl === b.serverUrl &&
    a.logtoEndpoint === b.logtoEndpoint &&
    a.workbenchAppId === b.workbenchAppId
  );
}

function maskForLog(s: string): string {
  const t = s.trim();
  if (t.length <= 10) return "***";
  return `${t.slice(0, 6)}…${t.slice(-4)}`;
}

function maskIdentity(id: AuthIdentity): Record<string, string> {
  return {
    instanceId: id.instanceId,
    serverUrl: maskForLog(id.serverUrl),
    logtoEndpoint: maskForLog(id.logtoEndpoint),
    workbenchAppId: maskForLog(id.workbenchAppId),
  };
}

function persistedIdentity(parsed: unknown): AuthIdentity | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o["v"] !== 2 || typeof o["identity"] !== "object" || o["identity"] === null) {
    return null;
  }
  const idRaw = o["identity"] as Record<string, unknown>;
  if (
    typeof idRaw["instanceId"] !== "string" ||
    typeof idRaw["serverUrl"] !== "string" ||
    typeof idRaw["logtoEndpoint"] !== "string" ||
    typeof idRaw["workbenchAppId"] !== "string"
  ) {
    return null;
  }
  return {
    instanceId: idRaw["instanceId"],
    serverUrl: idRaw["serverUrl"],
    logtoEndpoint: idRaw["logtoEndpoint"],
    workbenchAppId: idRaw["workbenchAppId"],
  };
}

function isTokenBundleShape(parsed: unknown): parsed is TokenBundle {
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;
  return (
    typeof o["access_token"] === "string" &&
    typeof o["id_token"] === "string" &&
    typeof o["expires_in"] === "number" &&
    typeof o["refreshed_at"] === "number" &&
    typeof o["refresh_token"] === "string"
  );
}

function parsePersistedAuthV2(
  parsed: unknown,
  expectedIdentity: AuthIdentity,
): TokenBundle | { kind: "mismatch"; disk: AuthIdentity | null } | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (o["v"] !== 2) return null;
  const diskIdentity = persistedIdentity(parsed);
  if (diskIdentity === null) return null;
  if (!identitiesEqual(diskIdentity, expectedIdentity)) {
    return { kind: "mismatch", disk: diskIdentity };
  }
  if (!isTokenBundleShape(o["bundle"])) return null;
  return o["bundle"];
}

function decryptV1OrV2Payload(
  deps: TokenStoreDeps,
  buf: Buffer,
  headerLen: number,
  encrypted: boolean,
): string | null {
  if (encrypted) {
    if (!deps.safeStorage.isEncryptionAvailable()) {
      return null;
    }
    try {
      return deps.safeStorage.decryptString(buf.subarray(headerLen));
    } catch (err) {
      deps.logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "auth.token_store.decrypt_failed",
      );
      return null;
    }
  }
  return buf.subarray(headerLen).toString("utf-8");
}

function loadJsonPayload(
  deps: TokenStoreDeps,
  buf: Buffer,
  header: Buffer,
  encrypted: boolean,
): string | null {
  if (!buf.subarray(0, header.length).equals(header)) return null;
  return decryptV1OrV2Payload(deps, buf, header.length, encrypted);
}

function envPinAuthorizesSilentClear(
  expectedIdentity: AuthIdentity,
  envPinnedServerUrl: string | null | undefined,
): boolean {
  const pinned = envPinnedServerUrl?.trim();
  if (!pinned) return false;
  return stripTrailingSlash(expectedIdentity.serverUrl) === stripTrailingSlash(pinned);
}

function clearAuthBundlePaths(
  deps: TokenStoreDeps,
  identity: AuthIdentity,
): void {
  for (const filePath of [
    authFilePath(deps, identity),
    legacyAuthFilePath(deps),
  ]) {
    try {
      deps.fs.unlinkSync(filePath);
    } catch {
      /* already gone — fine */
    }
  }
}

function handleEnvPinnedScopeMismatch(
  deps: TokenStoreDeps,
  args: {
    expectedIdentity: AuthIdentity;
    disk: AuthIdentity | null;
    envPinnedServerUrl: string | null | undefined;
  },
): TokenLoadResult {
  deps.logger.warn(
    {
      expected: maskIdentity(args.expectedIdentity),
      disk: args.disk ? maskIdentity(args.disk) : null,
    },
    "auth.token_store.env_pinned_mismatch_clear",
  );
  clearAuthBundlePaths(deps, args.expectedIdentity);
  const appendAudit = deps.appendAuthBundleClearedAudit ?? appendAuthBundleClearedAudit;
  appendAudit({
    expected: args.expectedIdentity,
    disk: args.disk,
  });
  return {
    kind: "env-pinned-cleared",
    expected: args.expectedIdentity,
    disk: args.disk,
  };
}

/**
 * One-shot M123 migration: rename legacy single-server auth file to the
 * per-server keyed name when the keyed file is absent. Idempotent.
 */
export function migrateLegacySingleServerAuth(
  deps: TokenStoreDeps,
  identity: AuthIdentity,
): "migrated" | "no-legacy" | "skipped" {
  const legacy = legacyAuthFilePath(deps);
  const next = authFilePath(deps, identity);
  if (!deps.fs.existsSync(legacy)) {
    return "no-legacy";
  }
  if (deps.fs.existsSync(next)) {
    return "skipped";
  }
  deps.fs.renameSync(legacy, next);
  deps.logger.warn(
    { from: legacy, to: next },
    "auth.token_store.legacy_single_server_migration",
  );
  return "migrated";
}

export function saveTokens(
  deps: TokenStoreDeps,
  args: { bundle: TokenBundle; identity: AuthIdentity },
): void {
  const persisted: PersistedAuth = {
    v: 2,
    identity: args.identity,
    bundle: args.bundle,
  };
  const json = JSON.stringify(persisted);
  let payload: Buffer;
  if (deps.safeStorage.isEncryptionAvailable()) {
    const encrypted = deps.safeStorage.encryptString(json);
    payload = Buffer.concat([HEADER_ENC_V2, encrypted]);
  } else {
    // Decision #14: chmod-600 plaintext fallback when libsecret /
    // D-Bus is unavailable. Logged + tracked for future upgrade.
    deps.logger.warn(
      { path: authFilePath(deps, args.identity) },
      "auth.token_store.unencrypted_fallback",
    );
    payload = Buffer.concat([HEADER_PT_V2, Buffer.from(json, "utf-8")]);
  }
  const filePath = authFilePath(deps, args.identity);
  deps.fs.writeFileSync(filePath, payload, { mode: FILE_MODE });
  // `mode` only applies on file creation. Force 0600 on existing
  // files too — defence-in-depth against pre-existing world-readable
  // versions left over from a botched manual edit.
  deps.fs.chmodSync(filePath, FILE_MODE);
}

export function loadTokens(
  deps: TokenStoreDeps,
  args: {
    expectedIdentity: AuthIdentity;
    envPinnedServerUrl?: string | null | undefined;
  },
): TokenBundle | null {
  const result = loadTokensResult(deps, args);
  return result.kind === "loaded" ? result.bundle : null;
}

export function loadTokensResult(
  deps: TokenStoreDeps,
  args: {
    expectedIdentity: AuthIdentity;
    envPinnedServerUrl?: string | null | undefined;
  },
): TokenLoadResult {
  let buf: Buffer;
  const filePath = authFilePath(deps, args.expectedIdentity);
  try {
    buf = deps.fs.readFileSync(filePath);
  } catch {
    return { kind: "none" };
  }

  const tryV2 = (header: Buffer, enc: boolean): TokenLoadResult | null => {
    const json = loadJsonPayload(deps, buf, header, enc);
    if (json === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(json) as unknown;
    } catch {
      return null;
    }
    const scope = parsePersistedAuthV2(parsed, args.expectedIdentity);
    if (typeof scope === "object" && scope !== null && "kind" in scope) {
      if (envPinAuthorizesSilentClear(args.expectedIdentity, args.envPinnedServerUrl)) {
        return handleEnvPinnedScopeMismatch(deps, {
          expectedIdentity: args.expectedIdentity,
          disk: scope.disk,
          envPinnedServerUrl: args.envPinnedServerUrl,
        });
      }
      const diskForLog: Record<string, string> = scope.disk
        ? maskIdentity(scope.disk)
        : {
            instanceId: "?",
            serverUrl: "?",
            logtoEndpoint: "?",
            workbenchAppId: "?",
          };
      deps.logger.warn(
        {
          expected: maskIdentity(args.expectedIdentity),
          disk: diskForLog,
        },
        "auth.token_store.scope_mismatch",
      );
      return {
        kind: "scope-mismatch",
        expected: args.expectedIdentity,
        disk: scope.disk,
      };
    }
    return scope ? { kind: "loaded", bundle: scope } : null;
  };

  const v2 =
    tryV2(HEADER_ENC_V2, true) ?? tryV2(HEADER_PT_V2, false);
  if (v2 !== null) return v2;

  return { kind: "none" };
}

export function clearTokens(
  deps: TokenStoreDeps,
  identity: AuthIdentity,
): void {
  clearAuthBundlePaths(deps, identity);
}

/**
 * Default-instance default-profile only. Returns `"migrated"` when a legacy
 * v1 file at `legacyPath` was moved into the v2 envelope at the current auth
 * path; `"no-legacy"` when the legacy file is absent; `"skipped"` in all other
 * cases (named instance, profile set, new auth file already present, or
 * legacy payload unreadable).
 *
 * Callers must pass `isDefaultInstance: true` only for the default `~/.nautilo`
 * instance; `identity` must reflect the current resolved instance + Logto env.
 */
export function migrateLegacyAuthV1IfDefaultInstance(
  deps: TokenStoreDeps,
  args: {
    legacyPath: string;
    identity: AuthIdentity;
    isDefaultInstance: boolean;
  },
): "migrated" | "no-legacy" | "skipped" {
  if (!args.isDefaultInstance || deps.profile !== undefined) {
    return "skipped";
  }
  try {
    deps.fs.readFileSync(authFilePath(deps, args.identity));
    // New store already exists — do not migrate over it.
    return "skipped";
  } catch {
    /* no primary file — proceed */
  }

  let legacyBuf: Buffer;
  try {
    legacyBuf = deps.fs.readFileSync(args.legacyPath);
  } catch {
    return "no-legacy";
  }

  const readV1Json = (header: Buffer, enc: boolean): string | null => {
    if (!legacyBuf.subarray(0, header.length).equals(header)) return null;
    return decryptV1OrV2Payload(deps, legacyBuf, header.length, enc);
  };

  const json =
    readV1Json(HEADER_ENC_V1, true) ?? readV1Json(HEADER_PT_V1, false);
  if (json === null) return "skipped";

  let parsed: unknown;
  try {
    parsed = JSON.parse(json) as unknown;
  } catch {
    return "skipped";
  }
  if (!isTokenBundleShape(parsed)) return "skipped";

  saveTokens(deps, { bundle: parsed, identity: args.identity });
  deps.logger.warn(
    { legacyPath: args.legacyPath, target: authFilePath(deps, args.identity) },
    "auth.token_store.legacy_migration",
  );
  try {
    deps.fs.unlinkSync(args.legacyPath);
  } catch {
    /* best effort */
  }
  return "migrated";
}
