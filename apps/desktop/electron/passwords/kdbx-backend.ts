/**
 * D403 (ISSUE-D403) Phase 2 — Electron-bound KDBX credential backend.
 *
 * Implements the `CredentialBackend` seam (types.ts) with a real `.kdbx` store.
 * This is the only file in the P2 set that touches Electron: it owns the master
 * key lifecycle (generate-once, seal with `safeStorage`, persist beside the db)
 * and wires the resolved key + db path into an Electron-free `KdbxStore`.
 *
 * KEY DOMAIN (spec §R3): the master key here is a NEW, independent random
 * 32-byte key sealed via the OS Keychain (`safeStorage`). It is deliberately a
 * SEPARATE key domain from `packages/vault` — different scope (web origin vs
 * namespace) and different consumer (human vs agent). Do NOT reuse the vault
 * master.
 *
 * SECURITY (R6): plaintext credentials never leave `KdbxStore`; the backend
 * only ever hands the IPC layer non-secret lookup metadata plus a single
 * `PasswordFillValue` on an already-matched id.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { safeStorage } from "electron";

import { setKdbxRuntimeImpls } from "./runtime-impl";
import { KdbxStore } from "./kdbx-store";
import type {
  CredentialBackend,
  CredentialMatch,
  PasswordFillRequest,
  PasswordFillValue,
  PasswordLookupRequest,
  PasswordLookupResult,
  PasswordSaveRequest,
} from "./types";

const MASTER_KEY_BYTES = 32;

/** Sealed-key file header (safeStorage/OS-keychain-encrypted only). */
const HEADER_ENC = Buffer.from("nautilo-webcred-key-v1-enc\n", "utf-8");

const KEY_FILE_MODE = 0o600;

export interface KdbxBackendPaths {
  /** Absolute path to the `.kdbx` credential database. */
  dbPath: string;
  /** Absolute path to the sealed master-key blob (beside the db). */
  keyPath: string;
}

/**
 * Resolve the default per-install / per-OS-user paths inside `userData`.
 * Names are D403-prefixed so they never collide with vault/auth artifacts.
 */
function defaultKdbxPaths(userDataDir: string): KdbxBackendPaths {
  return {
    dbPath: path.join(userDataDir, "d403-web-credentials.kdbx"),
    keyPath: path.join(userDataDir, "d403-web-credentials.key"),
  };
}

export class KdbxBackend implements CredentialBackend {
  private readonly paths: KdbxBackendPaths;
  private storePromise: Promise<KdbxStore | null> | null = null;

  /**
   * @param userDataDirOrPaths either the Electron `userData` dir (paths derived
   *   via {@link defaultKdbxPaths}) or an explicit {@link KdbxBackendPaths}.
   */
  constructor(userDataDirOrPaths: string | KdbxBackendPaths) {
    this.paths =
      typeof userDataDirOrPaths === "string"
        ? defaultKdbxPaths(userDataDirOrPaths)
        : userDataDirOrPaths;
    // Register the DOM and Argon2 implementations before the first KDBX op.
    setKdbxRuntimeImpls();
  }

  private getStore(): Promise<KdbxStore | null> {
    if (!this.storePromise) {
      this.storePromise = this.initStore();
    }
    return this.storePromise;
  }

  /**
   * Build the store, or return `null` — password save & autofill DISABLED —
   * when the OS keychain is unavailable. FAIL CLOSED: we never write the master
   * key as plaintext. An unprotected key beside the encrypted `.kdbx` would
   * defeat at-rest protection for saved web passwords, so on a
   * headless/no-keyring box we disable the feature instead.
   */
  private async initStore(): Promise<KdbxStore | null> {
    if (!safeStorage.isEncryptionAvailable()) {
      console.warn(
        "[nautilo-passwords] OS keychain (safeStorage) unavailable — password save & autofill are DISABLED (refusing to store the master key as plaintext). Enable an OS keyring to turn them on.",
      );
      return null;
    }
    const key = await this.loadOrCreateMasterKey();
    return new KdbxStore(key, this.paths.dbPath);
  }

  /** Load the sealed master key, or generate + seal one on first use. */
  private async loadOrCreateMasterKey(): Promise<Uint8Array> {
    let blob: Buffer | null = null;
    try {
      blob = await fs.readFile(this.paths.keyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      blob = null;
    }

    if (blob) {
      const key = this.unsealMasterKey(blob);
      if (key) return key;
      // Unreadable (e.g. encrypted blob on a machine that lost the Keychain
      // entry). Fail closed by re-generating — old entries become unreadable,
      // but that's strictly better than crashing the human-only save/fill path.
      console.warn(
        "[nautilo-passwords] sealed master key unreadable; regenerating (existing web credentials will be unrecoverable)",
      );
    }

    const key = new Uint8Array(randomBytes(MASTER_KEY_BYTES));
    await this.sealMasterKey(key);
    return key;
  }

  /** Unseal an existing key blob — encrypted (safeStorage) format ONLY. */
  private unsealMasterKey(blob: Buffer): Uint8Array | null {
    if (!blob.subarray(0, HEADER_ENC.length).equals(HEADER_ENC)) return null;
    if (!safeStorage.isEncryptionAvailable()) return null;
    try {
      const b64 = safeStorage.decryptString(blob.subarray(HEADER_ENC.length));
      return new Uint8Array(Buffer.from(b64, "base64"));
    } catch {
      return null;
    }
  }

  /** Seal the master key with the OS keychain. Caller guarantees availability. */
  private async sealMasterKey(key: Uint8Array): Promise<void> {
    const b64 = Buffer.from(key).toString("base64");
    const payload = Buffer.concat([HEADER_ENC, safeStorage.encryptString(b64)]);
    await fs.mkdir(path.dirname(this.paths.keyPath), { recursive: true });
    await fs.writeFile(this.paths.keyPath, payload, { mode: KEY_FILE_MODE });
    await fs.chmod(this.paths.keyPath, KEY_FILE_MODE);
  }

  async lookup(req: PasswordLookupRequest): Promise<PasswordLookupResult> {
    const store = await this.getStore();
    if (!store) return { matches: [] };
    return { matches: await store.lookupByOrigin(req.origin) };
  }

  async save(req: PasswordSaveRequest): Promise<void> {
    const store = await this.getStore();
    if (!store) return; // fail closed: no keychain → do not persist
    await store.save({
      origin: req.origin,
      username: req.username,
      password: req.password,
    });
  }

  async getFillValue(
    req: PasswordFillRequest,
  ): Promise<PasswordFillValue | null> {
    const store = await this.getStore();
    if (!store) return null;
    return store.getFillValue(req.id);
  }

  async matchCredential(req: PasswordSaveRequest): Promise<CredentialMatch> {
    const store = await this.getStore();
    // Disabled store (no keychain) → report "identical" so the caller offers
    // NOTHING: we won't prompt to save into a store we can't encrypt at rest.
    if (!store) return "identical";
    return store.matchCredential(req.origin, req.username, req.password);
  }
}
