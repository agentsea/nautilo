/**
 * M056 — Electron desktop side of the relay-pairing handshake.
 *
 * Persists the long-lived relay token at `<userData>/relay-token-<scope>.json`
 * using the same header-tagged format the M055 auth bundle uses
 * (`nautilo-relay-v1-{enc,pt}\n<payload>`). The `<scope>` is derived from the
 * target server URL so one Electron install can connect to multiple Nautilo
 * instances without sharing relay credentials:
 *
 *   - `safeStorage.encryptString(...)` body when libsecret / Keychain
 *     is available;
 *   - chmod-600 plaintext fallback otherwise.
 *
 * Atomic write via `tmp + rename`, mode 0o600 from creation. Mirrors
 * `token-store.ts`'s fail-closed semantics — unrecognised header,
 * malformed JSON, "encrypted disk format but platform can't decrypt"
 * all return null so the caller re-pairs.
 *
 * Pure side-effects are funneled through `RelayPairDeps` so the
 * module can be unit-tested without an Electron runtime. Production
 * callers use `electronRelayPairDeps()` to bind the live `app` +
 * `safeStorage` + `node:fs`.
 *
 * D418 — alongside the server-scoped relay token, this module also
 * owns the install's STABLE OPAQUE `installationId` UUID. It lives in
 * its own Family A userData file (`installation-id.json`), NOT under
 * the server-scoped `relay-token-<scope>.json` name, so one install
 * shares a single ID across every server it pairs with and the ID
 * survives `clearRelayToken` / sign-out / re-pair. It is NOT a
 * credential: the server uses it only to correlate pair requests from
 * the same physical install across token rotations. See
 * `getOrCreateInstallationId` below.
 */
import * as path from "node:path";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";

const ENCRYPTED_HEADER = "nautilo-relay-v1-enc";
const PLAINTEXT_HEADER = "nautilo-relay-v1-pt";
const FILE_MODE = 0o600;

/** D418 — Family A userData basename for the stable installation UUID. */
const INSTALLATION_ID_FILE_NAME = "installation-id.json";
const PHYSICAL_DEVICE_SEED_FILE_NAME = "physical-device-seed.json";
const PHYSICAL_DEVICE_SEED_BYTES = 32;
const PAIRING_CONTRACT_VERSION = 2;
const DEVICE_GROUP_DOMAIN = "nautilo.device-group.v1\0";
/** Case-insensitive, any UUID version — matches the server's D418 check. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface RelayPairFsLike {
  writeFileSync: (
    p: string,
    data: Buffer | string,
    options?: { mode?: number; encoding?: "utf-8" },
  ) => void;
  readFileSync: (p: string) => Buffer;
  renameSync: (from: string, to: string) => void;
  unlinkSync: (p: string) => void;
  mkdirSync: (p: string, options?: { recursive?: boolean; mode?: number }) => void;
  /** Atomic no-clobber publication for the shared seed. */
  linkSync: (existingPath: string, newPath: string) => void;
  /** Serializes corrupt-state repair so it cannot replace a valid winner. */
  rmdirSync: (p: string) => void;
}

export interface RelayPairSafeStorageLike {
  isEncryptionAvailable(): boolean;
  encryptString(s: string): Buffer;
  decryptString(buf: Buffer): string;
}

export interface RelayPairDeps {
  fs: RelayPairFsLike;
  safeStorage: RelayPairSafeStorageLike;
  userDataDir: string;
  fetchImpl: typeof fetch;
  hostname: () => string;
  /** Override for tests; defaults to `Date.now`. */
  now?: () => number;
  /**
   * Optional override for the installation-id file location. Production
   * wires this to `paths.ts`' `installationIdFilePath()` so the basename
   * has one source of truth; tests rely on the
   * `<userDataDir>/installation-id.json` default.
   */
  installationIdPath?: string;
  /** Family-C seed path. Defaults only for pure tests. */
  physicalDeviceSeedPath?: string;
  /** Override UUID generator for deterministic tests; defaults to `node:crypto.randomUUID`. */
  uuid?: () => string;
  /** Override random seed material for deterministic tests. */
  randomBytes?: (size: number) => Buffer;
}

interface PersistedPayload {
  token: string;
  pairedAt: number;
  serverUrl: string;
  /** Present after a D480 pair attempt; 2 means the server acknowledged it. */
  pairingContractVersion?: number;
  /** Trusted canonical server fingerprint bound to the cutover result. */
  trustedServerFingerprint?: string;
}

interface PersistedPhysicalDeviceSeed {
  v: 1;
  seed: string;
  createdAt: number;
}

function normalizeServerUrl(serverUrl: string): string {
  try {
    const url = new URL(serverUrl);
    url.hash = "";
    url.search = "";
    url.pathname = url.pathname.replace(/\/+$/, "");
    return url.toString().replace(/\/+$/, "");
  } catch {
    return serverUrl.trim().replace(/\/+$/, "");
  }
}

function relayTokenPath(deps: RelayPairDeps, serverUrl: string): string {
  const normalized = normalizeServerUrl(serverUrl);
  const scope = createHash("sha256").update(normalized).digest("hex").slice(0, 32);
  return path.join(deps.userDataDir, `relay-token-${scope}.json`);
}

/**
 * D418 — path to the stable installation-id file. Per `(instance, profile)`
 * (Family A userData), NOT server-scoped, so the basename is fixed (no
 * server hash). Production overrides via `deps.installationIdPath` so
 * `paths.ts` stays the single source of truth for the basename.
 */
function installationIdFilePath(deps: RelayPairDeps): string {
  return deps.installationIdPath ?? path.join(deps.userDataDir, INSTALLATION_ID_FILE_NAME);
}

function physicalDeviceSeedFilePath(deps: RelayPairDeps): string {
  return deps.physicalDeviceSeedPath ?? path.join(deps.userDataDir, PHYSICAL_DEVICE_SEED_FILE_NAME);
}

function isEexist(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === "EEXIST";
}

function readPhysicalDeviceSeed(deps: RelayPairDeps): Buffer | null {
  try {
    const parsed = JSON.parse(
      deps.fs.readFileSync(physicalDeviceSeedFilePath(deps)).toString("utf-8"),
    ) as Partial<PersistedPhysicalDeviceSeed>;
    if (
      parsed.v !== 1 ||
      typeof parsed.seed !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(parsed.seed)
    ) {
      return null;
    }
    const seed = Buffer.from(parsed.seed, "base64url");
    return seed.length === PHYSICAL_DEVICE_SEED_BYTES ? seed : null;
  } catch {
    return null;
  }
}

/**
 * Return the random Family-C seed. Publication uses link(2), rather than a
 * replacing rename, so simultaneous first writers converge on the winner and
 * can never silently replace a valid seed. A corrupt file is repaired only by
 * the holder of an owner-only repair directory, which re-reads immediately
 * before replacement; concurrent callers either read its winner or retry.
 */
export function getOrCreatePhysicalDeviceSeed(deps: RelayPairDeps): Buffer {
  const existing = readPhysicalDeviceSeed(deps);
  if (existing) return existing;

  const finalPath = physicalDeviceSeedFilePath(deps);
  deps.fs.mkdirSync(path.dirname(finalPath), { recursive: true, mode: 0o700 });
  const seed = deps.randomBytes ? deps.randomBytes(PHYSICAL_DEVICE_SEED_BYTES) : randomBytes(PHYSICAL_DEVICE_SEED_BYTES);
  if (seed.length !== PHYSICAL_DEVICE_SEED_BYTES) {
    throw new Error("physical device seed generator returned an invalid length");
  }
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  const payload = JSON.stringify({
    v: 1,
    seed: seed.toString("base64url"),
    createdAt: deps.now ? deps.now() : Date.now(),
  } satisfies PersistedPhysicalDeviceSeed);
  try {
    deps.fs.writeFileSync(tmpPath, payload, { mode: FILE_MODE });
    try {
      deps.fs.linkSync(tmpPath, finalPath);
      return seed;
    } catch (error) {
      if (!isEexist(error)) throw error;
      const winner = readPhysicalDeviceSeed(deps);
      if (winner) return winner;
      const repairLockPath = `${finalPath}.repair-lock`;
      try {
        // mkdir is atomic. It prevents a corrupt-state repair from racing a
        // first-writer publication and overwriting that valid winner.
        deps.fs.mkdirSync(repairLockPath, { mode: 0o700 });
      } catch (lockError) {
        if (isEexist(lockError)) {
          const repairedByPeer = readPhysicalDeviceSeed(deps);
          if (repairedByPeer) return repairedByPeer;
          throw new Error("physical device seed repair is in progress; retry later");
        }
        throw lockError;
      }
      try {
        const repairedByPeer = readPhysicalDeviceSeed(deps);
        if (repairedByPeer) return repairedByPeer;
        deps.fs.renameSync(tmpPath, finalPath);
        return seed;
      } finally {
        try {
          deps.fs.rmdirSync(repairLockPath);
        } catch {
          // Best-effort cleanup; the seed itself remains fail-closed.
        }
      }
    }
  } finally {
    try {
      deps.fs.unlinkSync(tmpPath);
    } catch {
      // link/rename consumed the temporary path, or it was never created.
    }
  }
}

/**
 * D480 grouping-only pseudonym. The trusted D133/M161 server fingerprint is
 * the sole server input: raw URL aliases, hostname, hardware and username are
 * deliberately absent. The UUID shape is a wire-format convenience only.
 */
export function deriveDeviceGroupId(
  deps: RelayPairDeps,
  trustedServerFingerprint: string,
): string {
  if (typeof trustedServerFingerprint !== "string" || trustedServerFingerprint.length === 0) {
    throw new Error("A trusted server fingerprint is required for device grouping");
  }
  const bytes = createHmac("sha256", getOrCreatePhysicalDeviceSeed(deps))
    .update(DEVICE_GROUP_DOMAIN, "utf-8")
    .update(trustedServerFingerprint, "utf-8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Read + validate the persisted installation UUID. null = missing/corrupt/invalid. */
function readInstallationId(deps: RelayPairDeps): string | null {
  let buf: Buffer;
  try {
    buf = deps.fs.readFileSync(installationIdFilePath(deps));
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(buf.toString("utf-8")) as { installationId?: unknown };
    if (
      typeof parsed.installationId === "string" &&
      UUID_RE.test(parsed.installationId)
    ) {
      return parsed.installationId;
    }
  } catch {
    /* corrupt — fall through to regenerate */
  }
  return null;
}

/**
 * Atomic write of the installation-id file. Same tmp + rename + 0600
 * pattern as the relay token. NOT a credential, so plaintext (no
 * safeStorage); the 0600 keeps it owner-only so a local non-operator
 * user can't swap it to merge installation identity.
 */
function writeInstallationId(deps: RelayPairDeps, id: string): void {
  const payload = JSON.stringify({
    installationId: id,
    createdAt: deps.now ? deps.now() : Date.now(),
  });
  const finalPath = installationIdFilePath(deps);
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;
  try {
    deps.fs.writeFileSync(tmpPath, payload, { mode: FILE_MODE });
    deps.fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    try {
      deps.fs.unlinkSync(tmpPath);
    } catch {
      /* tmp may not have been created */
    }
    throw e;
  }
}

/**
 * D418 — return this Electron install's stable opaque installation UUID,
 * creating it on first call. Per `(instance, profile)` (Family A
 * userData), NOT per server: one ID shared across every server this
 * install pairs with. Survives `clearRelayToken` / sign-out / re-pair
 * because it lives in its own file (`installation-id.json`), not the
 * server-scoped `relay-token-<scope>.json`. Not a credential — never
 * used for auth, only for the server to correlate pair requests from
 * the same physical install across token rotations.
 */
export function getOrCreateInstallationId(deps: RelayPairDeps): string {
  const existing = readInstallationId(deps);
  if (existing !== null) return existing;
  const id = deps.uuid ? deps.uuid() : randomUUID();
  writeInstallationId(deps, id);
  return id;
}

/**
 * Hit `POST /api/relay/pair` with the supplied Logto access token,
 * persist the returned plaintext token to disk, return it.
 *
 * Throws when the server returns non-2xx — caller logs + skips
 * relay startup so we don't re-loop.
 */
export async function pairRelay(
  deps: RelayPairDeps,
  args: {
    serverUrl: string;
    accessToken: string;
    /** D133/M161 canonical server identity; raw URLs are forbidden here. */
    trustedServerFingerprint: string;
    capabilities?: Record<string, unknown>;
  },
): Promise<string> {
  const normalizedServerUrl = normalizeServerUrl(args.serverUrl);
  const deviceGroupId = deriveDeviceGroupId(deps, args.trustedServerFingerprint);
  const res = await deps.fetchImpl(`${normalizedServerUrl}/api/relay/pair`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${args.accessToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      installationId: getOrCreateInstallationId(deps),
      deviceGroupId,
      deviceLabel: deps.hostname(),
      capabilities: args.capabilities ?? { profile: "desktop-agent" },
    }),
  });
  if (!res.ok) {
    let detail = "";
    try {
      detail = await res.text();
    } catch {
      /* ignore */
    }
    throw new Error(`Relay pair failed: ${res.status} ${detail}`);
  }
  const json = (await res.json()) as {
    relayToken?: unknown;
    pairingContractVersion?: unknown;
  };
  if (typeof json.relayToken !== "string" || !json.relayToken.startsWith("rty_")) {
    throw new Error("Relay pair response missing relayToken");
  }
  // An older endpoint may mint a token while ignoring the additive field. Mark
  // that bounded result too: it prevents a legacy cached token from rotating on
  // every restart. A later trusted-fingerprint change triggers one new attempt.
  persistToken(deps, {
    serverUrl: normalizedServerUrl,
    token: json.relayToken,
    pairingContractVersion:
      json.pairingContractVersion === PAIRING_CONTRACT_VERSION
        ? PAIRING_CONTRACT_VERSION
        : 1,
    trustedServerFingerprint: args.trustedServerFingerprint,
  });
  return json.relayToken;
}

function persistToken(
  deps: RelayPairDeps,
  args: {
    serverUrl: string;
    token: string;
    pairingContractVersion?: number;
    trustedServerFingerprint?: string;
  },
): void {
  const payload: PersistedPayload = {
    token: args.token,
    pairedAt: deps.now ? deps.now() : Date.now(),
    serverUrl: normalizeServerUrl(args.serverUrl),
    ...(args.pairingContractVersion !== undefined
      ? { pairingContractVersion: args.pairingContractVersion }
      : {}),
    ...(args.trustedServerFingerprint !== undefined
      ? { trustedServerFingerprint: args.trustedServerFingerprint }
      : {}),
  };
  const json = JSON.stringify(payload);
  const finalPath = relayTokenPath(deps, args.serverUrl);
  const tmpPath = `${finalPath}.${randomUUID()}.tmp`;

  let body: Buffer;
  if (deps.safeStorage.isEncryptionAvailable()) {
    body = Buffer.concat([
      Buffer.from(ENCRYPTED_HEADER + "\n", "utf-8"),
      deps.safeStorage.encryptString(json),
    ]);
  } else {
    body = Buffer.from(PLAINTEXT_HEADER + "\n" + json, "utf-8");
  }
  // Atomic write — tmp file goes down with mode 0600 from creation,
  // then is rename()'d into place. Mirrors token-store.ts's pattern;
  // never leaves a 0644 window where the plaintext fallback would
  // be world-readable.
  try {
    deps.fs.writeFileSync(tmpPath, body, { mode: FILE_MODE });
    deps.fs.renameSync(tmpPath, finalPath);
  } catch (e) {
    try {
      deps.fs.unlinkSync(tmpPath);
    } catch {
      /* tmp may not have been created */
    }
    throw e;
  }
}

/**
 * Read + decode the persisted relay token. Returns null on every
 * recoverable failure (file missing, unrecognised header, decrypt
 * unavailable on this platform, malformed JSON, missing `rty_`
 * prefix). Caller treats null as "re-pair on next sign-in".
 */
function loadRelayTokenPayload(
  deps: RelayPairDeps,
  args: { serverUrl: string },
): PersistedPayload | null {
  let buf: Buffer;
  try {
    buf = deps.fs.readFileSync(relayTokenPath(deps, args.serverUrl));
  } catch {
    return null;
  }

  const newlineIdx = buf.indexOf(0x0a);
  if (newlineIdx < 0) return null;
  const header = buf.subarray(0, newlineIdx).toString("utf-8");
  const body = buf.subarray(newlineIdx + 1);

  let json: string;
  if (header === ENCRYPTED_HEADER) {
    if (!deps.safeStorage.isEncryptionAvailable()) {
      // Disk says "encrypted" but platform can't decrypt right now.
      // Fail closed — the caller re-pairs on next sign-in.
      return null;
    }
    try {
      json = deps.safeStorage.decryptString(body);
    } catch {
      return null;
    }
  } else if (header === PLAINTEXT_HEADER) {
    json = body.toString("utf-8");
  } else {
    return null;
  }

  let parsed: Partial<PersistedPayload>;
  try {
    parsed = JSON.parse(json) as Partial<PersistedPayload>;
  } catch {
    return null;
  }
  if (typeof parsed.token !== "string" || !parsed.token.startsWith("rty_")) {
    return null;
  }
  if (parsed.serverUrl !== normalizeServerUrl(args.serverUrl)) {
    return null;
  }
  return parsed as PersistedPayload;
}

export function loadRelayToken(
  deps: RelayPairDeps,
  args: { serverUrl: string },
): string | null {
  return loadRelayTokenPayload(deps, args)?.token ?? null;
}

/**
 * A valid legacy token is still usable, but it needs exactly one authenticated
 * D480 rotation for each trusted server binding. Failed requests leave the
 * marker untouched (retry-safe); an older server's successful v1 response is
 * recorded so normal relaunches do not churn tokens.
 */
export function relayTokenRequiresPairingCutover(
  deps: RelayPairDeps,
  args: {
    serverUrl: string;
    trustedServerFingerprint: string;
    /** Set only after /health advertised the v2 contract. */
    requirePairingContractV2?: boolean;
  },
): boolean {
  const payload = loadRelayTokenPayload(deps, { serverUrl: args.serverUrl });
  if (!payload) return false;
  if (!args.trustedServerFingerprint) {
    throw new Error("A trusted server fingerprint is required for pairing cutover");
  }
  if (payload.trustedServerFingerprint !== args.trustedServerFingerprint) return true;
  return (
    args.requirePairingContractV2 === true &&
    payload.pairingContractVersion !== PAIRING_CONTRACT_VERSION
  );
}

/** Best-effort delete; missing-file is fine. */
export function clearRelayToken(
  deps: RelayPairDeps,
  args: { serverUrl: string },
): void {
  try {
    deps.fs.unlinkSync(relayTokenPath(deps, args.serverUrl));
  } catch {
    /* already gone */
  }
}

/** D514 — retirement is strict: only absence is idempotent success. */
export function retireRelayToken(deps: RelayPairDeps, args: { serverUrl: string }): void {
  try { deps.fs.unlinkSync(relayTokenPath(deps, args.serverUrl)); }
  catch (error) {
    if (typeof error === "object" && error !== null &&
        (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
}
