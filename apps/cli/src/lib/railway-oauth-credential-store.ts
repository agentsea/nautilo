import { lstat, mkdir, open, readFile, unlink, type FileHandle } from "node:fs/promises";
import { dirname } from "node:path";

import type {
  RailwayOAuthCredentialStore,
  RailwayOAuthRefreshLease,
  RailwayOAuthStoredCredential,
} from "@nautilo/railway-hosting";

const OWNER_ONLY_DIRECTORY_MODE = 0o700;
const OWNER_ONLY_FILE_MODE = 0o600;
const FORMAT_VERSION = 1 as const;
const MAX_REFRESH_TOKEN_BYTES = 8192;
const MAX_LOCK_BYTES = 512;
const STALE_LOCK_MS = 15 * 60_000;

export const RAILWAY_OAUTH_KEYRING_SERVICE = "dev.nautilo.cli.railway-oauth" as const;
export const RAILWAY_OAUTH_KEYRING_ACCOUNT = "default" as const;

export interface RailwayOAuthKeyringEntry {
  getPassword(): Promise<string | null | undefined>;
  setPassword(password: string): Promise<void>;
  deleteCredential(): Promise<boolean>;
}

interface StoredEnvelope {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly generation: number;
  readonly refreshToken: string;
}

interface LockMetadata {
  readonly formatVersion: typeof FORMAT_VERSION;
  readonly pid: number;
  readonly createdAt: number;
}

function parseEnvelope(raw: string | null | undefined): RailwayOAuthStoredCredential | null {
  // @napi-rs/keyring 1.3.0 declares `undefined` but its macOS async binding
  // returns `null` for a missing entry. Both mean absent; no other coercion is
  // accepted.
  if (raw === undefined || raw === null) return null;
  if (Buffer.byteLength(raw, "utf8") > MAX_REFRESH_TOKEN_BYTES * 2) {
    throw new Error("Railway OAuth credential is invalid");
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("Railway OAuth credential is invalid");
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("formatVersion" in value) ||
    value.formatVersion !== FORMAT_VERSION ||
    !("generation" in value) ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1 ||
    !("refreshToken" in value) ||
    typeof value.refreshToken !== "string" ||
    value.refreshToken.length === 0 ||
    Buffer.byteLength(value.refreshToken, "utf8") > MAX_REFRESH_TOKEN_BYTES
  ) {
    throw new Error("Railway OAuth credential is invalid");
  }
  return {
    generation: value.generation as number,
    refreshToken: value.refreshToken,
  };
}

function encodeEnvelope(credential: RailwayOAuthStoredCredential): string {
  if (
    !Number.isSafeInteger(credential.generation) ||
    credential.generation < 1 ||
    credential.refreshToken.length === 0 ||
    Buffer.byteLength(credential.refreshToken, "utf8") > MAX_REFRESH_TOKEN_BYTES
  ) {
    throw new Error("Railway OAuth credential is invalid");
  }
  const envelope: StoredEnvelope = {
    formatVersion: FORMAT_VERSION,
    generation: credential.generation,
    refreshToken: credential.refreshToken,
  };
  return JSON.stringify(envelope);
}

async function prepareLockDirectory(lockPath: string): Promise<void> {
  const directory = dirname(lockPath);
  await mkdir(directory, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
  const status = await lstat(directory);
  if (
    status.isSymbolicLink() ||
    !status.isDirectory() ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0)
  ) {
    throw new Error("Railway OAuth lock directory is unsafe");
  }
}

function isAlreadyExists(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST";
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "EPERM";
  }
}

async function reclaimStaleLock(lockPath: string, now: number): Promise<boolean> {
  let status;
  try {
    status = await lstat(lockPath);
  } catch {
    return false;
  }
  if (
    status.isSymbolicLink() ||
    !status.isFile() ||
    status.size > MAX_LOCK_BYTES ||
    (process.platform !== "win32" && (status.mode & 0o077) !== 0)
  ) {
    return false;
  }

  let metadata: LockMetadata;
  try {
    const value: unknown = JSON.parse(await readFile(lockPath, "utf8"));
    if (
      typeof value !== "object" ||
      value === null ||
      !("formatVersion" in value) ||
      value.formatVersion !== FORMAT_VERSION ||
      !("pid" in value) ||
      !Number.isSafeInteger(value.pid) ||
      (value.pid as number) < 1 ||
      !("createdAt" in value) ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0
    ) {
      return false;
    }
    metadata = value as LockMetadata;
  } catch {
    return false;
  }

  const expired = now - metadata.createdAt > STALE_LOCK_MS;
  if (!expired && processIsAlive(metadata.pid)) return false;
  try {
    await unlink(lockPath);
    return true;
  } catch {
    return false;
  }
}

async function acquireLock(lockPath: string): Promise<FileHandle> {
  try {
    return await open(lockPath, "wx", OWNER_ONLY_FILE_MODE);
  } catch (error) {
    if (!isAlreadyExists(error) || !(await reclaimStaleLock(lockPath, Date.now()))) throw error;
    return await open(lockPath, "wx", OWNER_ONLY_FILE_MODE);
  }
}

async function releaseLock(handle: FileHandle, lockPath: string): Promise<void> {
  let failure: unknown;
  try {
    await handle.close();
  } catch (error) {
    failure = error;
  }
  try {
    await unlink(lockPath);
  } catch (error) {
    failure ??= error;
  }
  if (failure !== undefined) {
    throw failure instanceof Error ? failure : new Error("Railway OAuth lock cleanup failed");
  }
}

function sameCredential(
  left: RailwayOAuthStoredCredential | null,
  right: RailwayOAuthStoredCredential | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.generation === right.generation && left.refreshToken === right.refreshToken;
}

/**
 * OS-vault refresh-token custody with a non-secret filesystem lock. The lock
 * covers provider exchange plus keyring replacement, so rotated tokens have a
 * single writer even when two Nautilo CLI processes start together.
 */
export class KeyringRailwayOAuthCredentialStore implements RailwayOAuthCredentialStore {
  readonly #entry: RailwayOAuthKeyringEntry;
  readonly #lockPath: string;

  constructor(entry: RailwayOAuthKeyringEntry, lockPath: string) {
    this.#entry = entry;
    this.#lockPath = lockPath;
  }

  async acquireExclusiveRefreshLease(): Promise<RailwayOAuthRefreshLease> {
    await prepareLockDirectory(this.#lockPath);
    const handle = await acquireLock(this.#lockPath);
    try {
      await handle.chmod(OWNER_ONLY_FILE_MODE);
      const lockMetadata: LockMetadata = {
        formatVersion: FORMAT_VERSION,
        pid: process.pid,
        createdAt: Date.now(),
      };
      await handle.writeFile(JSON.stringify(lockMetadata), "utf8");
      await handle.sync();
      const leased = parseEnvelope(await this.#entry.getPassword());
      let active = true;

      const currentMatchesLease = async (): Promise<boolean> =>
        sameCredential(parseEnvelope(await this.#entry.getPassword()), leased);

      return {
        credential: leased,
        replace: async (credential) => {
          if (!active || !(await currentMatchesLease())) return "stale-lease";
          await this.#entry.setPassword(encodeEnvelope(credential));
          return "stored";
        },
        clear: async () => {
          if (!active || !(await currentMatchesLease())) return "stale-lease";
          if (leased !== null) await this.#entry.deleteCredential();
          return "cleared";
        },
        release: async () => {
          if (!active) return;
          active = false;
          await releaseLock(handle, this.#lockPath);
        },
      };
    } catch (error) {
      await releaseLock(handle, this.#lockPath).catch(() => undefined);
      throw error;
    }
  }
}
