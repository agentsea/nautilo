import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { join } from "node:path";

import { normalizeRelayServerUrl } from "./bootstrap";

const FORMAT_VERSION = 1 as const;
const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256_HEX_RE = /^[0-9a-f]{64}$/;
const RELAY_TOKEN_RE = /^rty_[A-Za-z0-9_-]{32}$/;

const RELAY_CREDENTIAL_KEYRING_SERVICE = "dev.nautilo.relay.pairing";

export interface RelayPairingIdentity {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly serverUrl: string;
  readonly installationId: string;
}

export interface RelayStoredCredential extends RelayPairingIdentity {
  readonly userId: string;
  readonly relayToken: string;
}

interface PersistedPairingIdentity {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly serverScope: string;
  readonly installationId: string;
}

interface PersistedRelayCredential extends PersistedPairingIdentity {
  readonly userId: string;
  readonly relayToken: string;
}

export interface RelayKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

export interface RelayCredentialStore {
  readonly serverUrl: string;
  getOrCreatePairingIdentity(): Promise<RelayPairingIdentity>;
  load(): Promise<RelayStoredCredential | null>;
  save(credential: RelayStoredCredential): Promise<void>;
  clear(): Promise<void>;
}

export class RelayPairingRequiredError extends Error {
  constructor() {
    super("Relay pairing is required");
    this.name = "RelayPairingRequiredError";
  }
}

export class RelayCredentialStorageError extends Error {
  constructor(message = "Relay credential storage is unavailable") {
    super(message);
    this.name = "RelayCredentialStorageError";
  }
}

export function relayCredentialScope(serverUrl: string): string {
  return createHash("sha256")
    .update(normalizeRelayServerUrl(serverUrl), "utf8")
    .digest("hex");
}

export function relayPairingMetadataPath(dataDir: string, serverUrl: string): string {
  return join(dataDir, "relay", "pairings", `${relayCredentialScope(serverUrl)}.json`);
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

async function ensureOwnerOnlyDirectory(path: string): Promise<void> {
  let created = false;
  try {
    await mkdir(path, { mode: OWNER_ONLY_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if (!isAlreadyExists(error)) throw new RelayCredentialStorageError();
  }
  let status;
  try {
    status = await lstat(path);
  } catch {
    throw new RelayCredentialStorageError();
  }
  const currentUid = process.getuid?.();
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new RelayCredentialStorageError("Relay pairing directory is unsafe");
  }
  if (created || (process.platform !== "win32" && (status.mode & 0o077) !== 0)) {
    try {
      await chmod(path, OWNER_ONLY_DIRECTORY_MODE);
    } catch {
      throw new RelayCredentialStorageError();
    }
  }
  const secured = await lstat(path);
  if (
    secured.isSymbolicLink() ||
    !secured.isDirectory() ||
    (process.platform !== "win32" && (secured.mode & 0o077) !== 0) ||
    (currentUid !== undefined && secured.uid !== currentUid)
  ) {
    throw new RelayCredentialStorageError("Relay pairing directory is unsafe");
  }
}

async function preparePairingDirectory(dataDir: string): Promise<string> {
  const relayDir = join(dataDir, "relay");
  const pairingsDir = join(relayDir, "pairings");
  try {
    await mkdir(dataDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  } catch {
    throw new RelayCredentialStorageError();
  }
  await ensureOwnerOnlyDirectory(relayDir);
  await ensureOwnerOnlyDirectory(pairingsDir);
  return pairingsDir;
}

function parsePairingIdentity(raw: string, expectedServerUrl: string): RelayPairingIdentity {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RelayCredentialStorageError("Relay pairing metadata is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("formatVersion" in value) ||
    value.formatVersion !== FORMAT_VERSION ||
    !("serverScope" in value) ||
    typeof value.serverScope !== "string" ||
    !SHA256_HEX_RE.test(value.serverScope) ||
    value.serverScope !== relayCredentialScope(expectedServerUrl) ||
    !("installationId" in value) ||
    typeof value.installationId !== "string" ||
    !UUID_RE.test(value.installationId)
  ) {
    throw new RelayCredentialStorageError("Relay pairing metadata is invalid");
  }
  return {
    formatVersion: FORMAT_VERSION,
    serverUrl: expectedServerUrl,
    installationId: value.installationId,
  };
}

async function readPairingIdentity(path: string, serverUrl: string): Promise<RelayPairingIdentity | null> {
  let status;
  try {
    status = await lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new RelayCredentialStorageError();
  }
  const currentUid = process.getuid?.();
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0) ||
    (currentUid !== undefined && status.uid !== currentUid)
  ) {
    throw new RelayCredentialStorageError("Relay pairing metadata is unsafe");
  }
  try {
    return parsePairingIdentity(await readFile(path, "utf8"), serverUrl);
  } catch (error) {
    if (error instanceof RelayCredentialStorageError) throw error;
    throw new RelayCredentialStorageError();
  }
}

async function persistNewPairingIdentity(path: string, identity: RelayPairingIdentity): Promise<boolean> {
  let handle: FileHandle;
  try {
    handle = await open(path, "wx", OWNER_ONLY_FILE_MODE);
  } catch (error) {
    if (isAlreadyExists(error)) return false;
    throw new RelayCredentialStorageError();
  }
  let succeeded = false;
  try {
    await handle.chmod(OWNER_ONLY_FILE_MODE);
    const persisted: PersistedPairingIdentity = {
      formatVersion: FORMAT_VERSION,
      serverScope: relayCredentialScope(identity.serverUrl),
      installationId: identity.installationId,
    };
    await handle.writeFile(JSON.stringify(persisted), "utf8");
    await handle.sync();
    succeeded = true;
    return true;
  } catch {
    throw new RelayCredentialStorageError();
  } finally {
    await handle.close().catch(() => undefined);
    if (!succeeded) await unlink(path).catch(() => undefined);
  }
}

function parseStoredCredential(raw: string, identity: RelayPairingIdentity): RelayStoredCredential {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new RelayCredentialStorageError("Relay credential is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 5 ||
    !("formatVersion" in value) ||
    value.formatVersion !== FORMAT_VERSION ||
    !("serverScope" in value) ||
    typeof value.serverScope !== "string" ||
    !SHA256_HEX_RE.test(value.serverScope) ||
    value.serverScope !== relayCredentialScope(identity.serverUrl) ||
    !("installationId" in value) ||
    value.installationId !== identity.installationId ||
    !("userId" in value) ||
    typeof value.userId !== "string" ||
    !UUID_RE.test(value.userId) ||
    !("relayToken" in value) ||
    typeof value.relayToken !== "string" ||
    !RELAY_TOKEN_RE.test(value.relayToken)
  ) {
    throw new RelayCredentialStorageError("Relay credential is invalid");
  }
  return {
    ...identity,
    userId: value.userId,
    relayToken: value.relayToken,
  };
}

function encodeStoredCredential(credential: RelayStoredCredential): string {
  const persisted: PersistedRelayCredential = {
    formatVersion: FORMAT_VERSION,
    serverScope: relayCredentialScope(credential.serverUrl),
    installationId: credential.installationId,
    userId: credential.userId,
    relayToken: credential.relayToken,
  };
  const encoded = JSON.stringify(persisted);
  parseStoredCredential(encoded, credential);
  return encoded;
}

export class KeyringRelayCredentialStore implements RelayCredentialStore {
  readonly serverUrl: string;
  readonly #dataDir: string;
  readonly #entry: RelayKeyringEntry;

  constructor(input: { serverUrl: string; dataDir: string; entry: RelayKeyringEntry }) {
    this.serverUrl = normalizeRelayServerUrl(input.serverUrl);
    this.#dataDir = input.dataDir;
    this.#entry = input.entry;
  }

  async getOrCreatePairingIdentity(): Promise<RelayPairingIdentity> {
    const directory = await preparePairingDirectory(this.#dataDir);
    const path = join(directory, `${relayCredentialScope(this.serverUrl)}.json`);
    const existing = await readPairingIdentity(path, this.serverUrl);
    if (existing !== null) return existing;
    const identity: RelayPairingIdentity = {
      formatVersion: FORMAT_VERSION,
      serverUrl: this.serverUrl,
      installationId: randomUUID(),
    };
    if (await persistNewPairingIdentity(path, identity)) return identity;
    const winner = await readPairingIdentity(path, this.serverUrl);
    if (winner === null) throw new RelayCredentialStorageError();
    return winner;
  }

  async load(): Promise<RelayStoredCredential | null> {
    const path = relayPairingMetadataPath(this.#dataDir, this.serverUrl);
    const identity = await readPairingIdentity(path, this.serverUrl);
    if (identity === null) return null;
    let raw: string | null | undefined;
    try {
      raw = await this.#entry.getPassword();
    } catch {
      throw new RelayCredentialStorageError();
    }
    if (raw === null || raw === undefined) return null;
    return parseStoredCredential(raw, identity);
  }

  async save(credential: RelayStoredCredential): Promise<void> {
    const identity = await this.getOrCreatePairingIdentity();
    if (
      credential.serverUrl !== identity.serverUrl ||
      credential.installationId !== identity.installationId
    ) {
      throw new RelayCredentialStorageError("Relay credential target does not match pairing metadata");
    }
    try {
      await this.#entry.setPassword(encodeStoredCredential(credential));
    } catch {
      throw new RelayCredentialStorageError();
    }
  }

  async clear(): Promise<void> {
    try {
      await this.#entry.deleteCredential();
    } catch {
      throw new RelayCredentialStorageError("Rejected relay credential could not be removed");
    }
  }
}

export async function createKeyringRelayCredentialStore(input: {
  serverUrl: string;
  dataDir: string;
}): Promise<KeyringRelayCredentialStore> {
  const { AsyncEntry } = await import("@napi-rs/keyring");
  return new KeyringRelayCredentialStore({
    ...input,
    entry: new AsyncEntry(
      RELAY_CREDENTIAL_KEYRING_SERVICE,
      relayCredentialScope(input.serverUrl),
    ),
  });
}
