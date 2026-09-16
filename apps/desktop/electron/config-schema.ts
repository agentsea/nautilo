/**
 * DesktopConfig schema + pure parser (D057 2a.2).
 *
 * Split out from config.ts so tests can exercise parse behavior without
 * booting Electron (config.ts imports `app` which is only available
 * inside a running Electron process).
 *
 * Keep this file dependency-free — no electron, no node:fs, no IPC.
 */

export const CONFIG_VERSION = 1 as const;

export type DesktopMode = "connect";

/**
 * Durable pairing receipt written with the active server URL at the one
 * authority handoff boundary. Both values are opaque; consumers compare them
 * exactly and must never try to reconstruct either one from a URL.
 */
export type ActiveAuthorityMarker = Readonly<{
  /** Exact canonical `new URL(serverUrl).origin`, never a routing path. */
  canonicalOrigin: string;
  revision: string;
  connectionAttemptId: string;
  /** Exact identity accepted by this attempt; recents only cache this truth. */
  serverFingerprint: string | null;
}>;

/** The usable active-pairing authority, projected only from a complete marker. */
export type ActiveAuthority = Readonly<{
  scope: string;
  revision: string;
  connectionAttemptId: string;
  serverFingerprint: string | null;
}>;

export interface DesktopConfig {
  version: typeof CONFIG_VERSION;
  mode: DesktopMode;
  /** Required when mode === "connect". Absolute URL with scheme + host. */
  serverUrl?: string;
  /**
   * D514 — absent in legacy configs. When present it is deliberately strict:
   * a partially-written marker is not a legacy pairing and must be rejected.
   */
  activeAuthority?: ActiveAuthorityMarker;
  /**
   * Local human intent for the optional Codex desktop connection.
   *
   * This is only an enablement preference. Runtime/profile/account readiness
   * remains server-preflight state and is never persisted here.
   */
  codexConnectionEnabled?: boolean;
  /** Durable local owner choice for the ephemeral Hermes ACP harness. */
  hermesConnectionEnabled?: boolean;
}

const OPAQUE_REVISION = /^[A-Za-z0-9._:-]{1,256}$/;
const CONNECTION_ATTEMPT_ID = /^[A-Za-z0-9._-]{1,128}$/;
const SERVER_FINGERPRINT = /^[A-Za-z0-9][A-Za-z0-9._:+/|=-]{0,255}$/;

export function isOpaqueActiveRevision(value: unknown): value is string {
  return typeof value === "string" && OPAQUE_REVISION.test(value);
}

export function isConnectionAttemptId(value: unknown): value is string {
  return typeof value === "string" && CONNECTION_ATTEMPT_ID.test(value);
}

export function isServerFingerprint(value: unknown): value is string {
  return typeof value === "string" && SERVER_FINGERPRINT.test(value);
}

function canonicalOriginForServerUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048) return null;
  try {
    const parsed = new URL(value);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
      return null;
    }
    return parsed.origin;
  } catch {
    return null;
  }
}

function isCanonicalHttpOrigin(value: unknown): value is string {
  return canonicalOriginForServerUrl(value) === value;
}

function parseActiveAuthorityMarker(value: unknown): ActiveAuthorityMarker | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const marker = value as Record<string, unknown>;
  const keys = Object.keys(marker).sort();
  if (keys.length !== 4 || keys[0] !== "canonicalOrigin" || keys[1] !== "connectionAttemptId" ||
    keys[2] !== "revision" || keys[3] !== "serverFingerprint") return null;
  if (!isCanonicalHttpOrigin(marker["canonicalOrigin"]) ||
    !isOpaqueActiveRevision(marker["revision"]) || !isConnectionAttemptId(marker["connectionAttemptId"]) ||
    !(isServerFingerprint(marker["serverFingerprint"]) ||
      (marker["serverFingerprint"] === null && marker["connectionAttemptId"].startsWith("legacy-")))) {
    return null;
  }
  return {
    canonicalOrigin: marker["canonicalOrigin"],
    revision: marker["revision"],
    connectionAttemptId: marker["connectionAttemptId"],
    serverFingerprint: marker["serverFingerprint"],
  };
}

/**
 * Names a legacy active config for replacement fencing without claiming an
 * identity it has not freshly proved. New connection commits cannot call this
 * path and always require a non-null verified fingerprint.
 */
export function configForLegacyActiveConnection(
  current: DesktopConfig,
  input: Readonly<{ connectionAttemptId: string }>,
  deps: Readonly<{ mintRevision: () => string }>,
): DesktopConfig {
  if (projectActiveAuthority(current)) {
    throw new Error("legacy active authority migration requires a markerless config");
  }
  if (!input.connectionAttemptId.startsWith("legacy-") ||
    !isConnectionAttemptId(input.connectionAttemptId)) {
    throw new Error("legacy active authority marker is invalid");
  }
  const canonicalOrigin = canonicalOriginForServerUrl(current.serverUrl);
  const revision = deps.mintRevision();
  if (!canonicalOrigin || !isOpaqueActiveRevision(revision)) {
    throw new Error("legacy active authority source is invalid");
  }
  return {
    ...current,
    activeAuthority: {
      canonicalOrigin,
      revision,
      connectionAttemptId: input.connectionAttemptId,
      serverFingerprint: null,
    },
  };
}

/**
 * Complete the exact legacy authority guard after cold boot has freshly
 * verified that same server origin. This is the only path that may replace a
 * null legacy fingerprint; ordinary connection commits still mint a new
 * attempt and revision through `configForActiveConnection`.
 */
export function configForVerifiedLegacyActiveConnection(
  current: DesktopConfig,
  input: Readonly<{ serverUrl: string; serverFingerprint: string }>,
): DesktopConfig {
  const existing = projectActiveAuthority(current);
  const canonicalOrigin = canonicalOriginForServerUrl(input.serverUrl);
  if (!existing || existing.serverFingerprint !== null ||
    !existing.connectionAttemptId.startsWith("legacy-") ||
    canonicalOrigin === null || existing.scope !== canonicalOrigin ||
    canonicalOriginForServerUrl(current.serverUrl) !== canonicalOrigin) {
    throw new Error("verified legacy authority does not match the active server");
  }
  if (!isServerFingerprint(input.serverFingerprint)) {
    throw new Error("verified legacy authority fingerprint is invalid");
  }
  return {
    ...current,
    activeAuthority: {
      canonicalOrigin,
      revision: existing.revision,
      connectionAttemptId: existing.connectionAttemptId,
      serverFingerprint: input.serverFingerprint,
    },
  };
}

/**
 * Projects pairing truth only when an exact active marker was durably paired
 * with a canonical server origin. Legacy configs deliberately yield null so
 * the coordinator can upgrade them before journalling an attempt.
 */
export function projectActiveAuthority(config: DesktopConfig): ActiveAuthority | null {
  const marker = parseActiveAuthorityMarker(config.activeAuthority);
  if (!marker || canonicalOriginForServerUrl(config.serverUrl) !== marker.canonicalOrigin) return null;
  return {
    scope: marker.canonicalOrigin,
    revision: marker.revision,
    connectionAttemptId: marker.connectionAttemptId,
    serverFingerprint: marker.serverFingerprint,
  };
}

/**
 * Constructs the one config snapshot written when a prepared connection is
 * promoted. URL + revision + attempt ID are intentionally one value passed to
 * the atomic writer; callers cannot persist a new server without its marker.
 */
export function configForActiveConnection(
  current: DesktopConfig | null,
  input: Readonly<{ serverUrl: string; connectionAttemptId: string; serverFingerprint: string }>,
  deps: Readonly<{ mintRevision: () => string }>,
): DesktopConfig {
  const canonicalOrigin = canonicalOriginForServerUrl(input.serverUrl);
  if (!canonicalOrigin) {
    throw new Error("active connection serverUrl must be an HTTP(S) URL without credentials");
  }
  if (!isConnectionAttemptId(input.connectionAttemptId)) {
    throw new Error("active connection attempt id must be a bounded opaque marker");
  }
  if (!isServerFingerprint(input.serverFingerprint)) {
    throw new Error("active connection fingerprint must be a bounded opaque marker");
  }
  const existing = current === null ? null : projectActiveAuthority(current);
  // A crash after the atomic rename but before the caller observes success may
  // resume this exact handoff. Reusing that already-durable receipt is the one
  // allowed idempotent case; all distinct commits mint a fresh opaque revision.
  if (existing?.connectionAttemptId === input.connectionAttemptId) {
    if (existing.scope !== canonicalOrigin) {
      throw new Error("active connection attempt id is already bound to a different origin");
    }
    if (existing.serverFingerprint !== input.serverFingerprint) {
      throw new Error("active connection attempt id is already bound to a different fingerprint");
    }
    return current as DesktopConfig;
  }
  const revision = deps.mintRevision();
  if (!isOpaqueActiveRevision(revision) || revision === existing?.revision) {
    throw new Error("active connection revision factory must mint a fresh bounded opaque marker");
  }
  return {
    version: CONFIG_VERSION,
    mode: "connect",
    serverUrl: input.serverUrl,
    activeAuthority: {
      canonicalOrigin,
      revision,
      connectionAttemptId: input.connectionAttemptId,
      serverFingerprint: input.serverFingerprint,
    },
    ...(current?.codexConnectionEnabled === undefined
      ? {}
      : { codexConnectionEnabled: current.codexConnectionEnabled }),
    ...(current?.hermesConnectionEnabled === undefined
      ? {}
      : { hermesConnectionEnabled: current.hermesConnectionEnabled }),
  };
}

/**
 * Narrow an `unknown` (from JSON.parse) into a DesktopConfig or null.
 *
 * Any schema mismatch — unknown mode, wrong version, missing required
 * field — rejects and routes the caller through the picker. This is
 * intentional: re-running the picker on schema drift beats silently
 * loading a config we don't understand.
 *
 * Extra fields on valid-mode records are ignored (forward compatibility
 * for minor schema extensions).
 */
export function parseConfig(raw: unknown): DesktopConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj["version"] !== CONFIG_VERSION) return null;
  if (obj["mode"] !== "connect") return null;
  const url = obj["serverUrl"];
  if (typeof url !== "string" || url.length === 0) return null;
  const hasAuthorityMarker = Object.prototype.hasOwnProperty.call(obj, "activeAuthority");
  const activeAuthority = hasAuthorityMarker ? parseActiveAuthorityMarker(obj["activeAuthority"]) : null;
  const oldBranchMarker = hasAuthorityMarker && obj["activeAuthority"] !== null &&
    typeof obj["activeAuthority"] === "object" && !Array.isArray(obj["activeAuthority"]) &&
    (() => {
      const marker = obj["activeAuthority"] as Record<string, unknown>;
      const keys = Object.keys(marker).sort();
      return keys.length === 3 && keys[0] === "canonicalOrigin" && keys[1] === "connectionAttemptId" &&
        keys[2] === "revision" && isCanonicalHttpOrigin(marker["canonicalOrigin"]) &&
        isOpaqueActiveRevision(marker["revision"]) && isConnectionAttemptId(marker["connectionAttemptId"]) &&
        canonicalOriginForServerUrl(url) === marker["canonicalOrigin"];
    })();
  // A missing marker is a supported pre-D514 config. A present but malformed
  // marker is not: accepting it would make partial authority look authoritative.
  if (hasAuthorityMarker && !oldBranchMarker &&
    (!activeAuthority || canonicalOriginForServerUrl(url) !== activeAuthority.canonicalOrigin)) return null;
  const cfg: DesktopConfig = {
    version: CONFIG_VERSION,
    mode: "connect",
    serverUrl: url,
    ...(activeAuthority === null ? {} : { activeAuthority }),
    ...(typeof obj["codexConnectionEnabled"] === "boolean"
      ? { codexConnectionEnabled: obj["codexConnectionEnabled"] }
      : {}),
    ...(typeof obj["hermesConnectionEnabled"] === "boolean"
      ? { hermesConnectionEnabled: obj["hermesConnectionEnabled"] }
      : {}),
  };
  return cfg;
}

/**
 * Apply the narrow Codex enablement preference without creating a second
 * settings store. The caller supplies the active server URL only when there
 * is no existing desktop config (notably dev-from-source profiles).
 */
export function withCodexConnectionIntent(
  current: DesktopConfig | null,
  serverUrl: string,
  enabled: boolean,
): DesktopConfig {
  return {
    ...(current ?? {
      version: CONFIG_VERSION,
      mode: "connect" as const,
      serverUrl,
    }),
    codexConnectionEnabled: enabled,
  };
}

/** Apply the narrow Hermes owner choice without adding another settings file. */
export function withHermesConnectionIntent(
  current: DesktopConfig | null,
  serverUrl: string,
  enabled: boolean,
): DesktopConfig {
  return {
    ...(current ?? {
      version: CONFIG_VERSION,
      mode: "connect" as const,
      serverUrl,
    }),
    hermesConnectionEnabled: enabled,
  };
}

export type DesktopConfigWriteFs = Readonly<{
  mkdirSync(directoryPath: string, options: { recursive: true; mode: number }): void;
  openSync(filePath: string, flags: "wx", mode: number): number;
  writeFileSync(
    fileDescriptor: number,
    data: string,
    options: { encoding: "utf-8" },
  ): void;
  closeSync(fileDescriptor: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(filePath: string): void;
}>;

/**
 * Pure injected-I/O atomic writer. `temporaryId` must be unique per write;
 * production supplies a UUID, keeping concurrent writers from sharing a temp
 * name. A failed rename leaves the existing target byte-for-byte untouched.
 */
export function writeDesktopConfigAtomically(input: Readonly<{
  filePath: string;
  directoryPath: string;
  config: DesktopConfig;
  temporaryId: string;
  fs: DesktopConfigWriteFs;
}>): void {
  const { filePath, directoryPath, config, temporaryId, fs } = input;
  if (!temporaryId || temporaryId.includes("/") || temporaryId.includes("\\")) {
    throw new Error("config temporary id must be a non-empty path fragment");
  }
  if (config.version !== CONFIG_VERSION || config.mode !== "connect" || !config.serverUrl) {
    throw new Error("saveConfig: connect config with serverUrl is required");
  }
  const hasAuthorityMarker = Object.prototype.hasOwnProperty.call(config, "activeAuthority");
  // Never let an in-memory malformed marker become durable either. Check the
  // own property so `{ activeAuthority: null }` cannot masquerade as legacy.
  if (hasAuthorityMarker && !projectActiveAuthority(config)) {
    throw new Error("saveConfig: active authority marker must be complete and match serverUrl origin");
  }
  const temporaryPath = `${filePath}.${temporaryId}.tmp`;
  let descriptor: number | null = null;
  let ownsTemporaryPath = false;
  try {
    fs.mkdirSync(directoryPath, { recursive: true, mode: 0o700 });
    descriptor = fs.openSync(temporaryPath, "wx", 0o600);
    ownsTemporaryPath = true;
    fs.writeFileSync(descriptor, JSON.stringify(config, null, 2), { encoding: "utf-8" });
    fs.closeSync(descriptor);
    descriptor = null;
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { fs.closeSync(descriptor); } catch { /* best-effort close */ }
    }
    // An EEXIST failure can belong to another writer; only remove a temp file
    // after this writer successfully opened it with exclusive creation.
    if (ownsTemporaryPath) {
      try { fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

/** Pure-I/O seam for the narrow Forget-only persisted-config removal. */
export function clearDesktopConfigFile(
  filePath: string,
  deps: { unlinkSync: (path: string) => void },
): void {
  try {
    deps.unlinkSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}
