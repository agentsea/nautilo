/**
 * D403 (ISSUE-D403) Phase 2 — KDBX-backed credential store.
 *
 * A thin wrapper over `kdbxweb` that reads/writes a standard `.kdbx` file
 * (KDBX4, Argon2id KDF) mapping web credentials onto KeePass entries per the
 * spec §4 Data Model:
 *
 *   KdbxEntry.fields.URL      ← origin (exact registrable origin)
 *   KdbxEntry.fields.UserName ← username
 *   KdbxEntry.fields.Password ← ProtectedValue
 *
 * DESIGN: this module is deliberately **Electron-free**. It takes the master
 * key bytes and the db file path by constructor injection so it can be unit
 * tested against a real temp file with no Electron runtime. The Electron-bound
 * key sealing (safeStorage) + userData path resolution live in `kdbx-backend.ts`.
 *
 * SECURITY (R6): exact-origin match only — `lookupByOrigin` NEVER returns a
 * cross-origin entry. Plaintext passwords live only inside `kdbxweb`
 * `ProtectedValue`s (XOR'd in memory) and the AES/ChaCha20-encrypted `.kdbx`
 * on disk; the cleartext is released only via `getFillValue` on an id the
 * caller already matched (the P3 user-gesture gate lives above this layer).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as kdbxweb from "kdbxweb";

import { setKdbxRuntimeImpls } from "./runtime-impl";
import type { CredentialMatch, PasswordLookupMatch } from "./types";

/** Field keys per the KeePass schema (spec §4). */
const FIELD_URL = "URL";
const FIELD_USERNAME = "UserName";
const FIELD_PASSWORD = "Password";

/** Human-readable db + root-group names for the produced `.kdbx`. */
const DB_NAME = "Nautilo Web Credentials";

export interface CredentialInput {
  /** Exact registrable origin, e.g. `https://example.com`. */
  origin: string;
  username: string;
  password: string;
}

export interface CredentialFillValue {
  username: string;
  password: string;
}

function fieldToString(
  field: kdbxweb.KdbxEntryField | undefined,
): string {
  if (field === undefined) return "";
  if (typeof field === "string") return field;
  return field.getText();
}

/**
 * KDBX credential store. Open-or-create is lazy: the `.kdbx` is materialized on
 * disk on the first `save`. All reads/writes go through the in-memory `Kdbx`
 * instance; writes are persisted atomically (temp file + rename).
 */
export class KdbxStore {
  private readonly masterKey: Uint8Array;
  private readonly dbPath: string;
  private db: kdbxweb.Kdbx | null = null;

  /**
   * @param masterKey raw 32-byte master key (used as the KDBX credential). A
   *   defensive copy is taken so the caller may zero its own buffer.
   * @param dbPath absolute path to the `.kdbx` file.
   */
  constructor(masterKey: Uint8Array | Buffer, dbPath: string) {
    this.masterKey = Uint8Array.from(masterKey);
    this.dbPath = dbPath;
  }

  /** Build fresh `KdbxCredentials` from the master key (impl set first). */
  private async buildCredentials(): Promise<kdbxweb.KdbxCredentials> {
    setKdbxRuntimeImpls();
    // `ProtectedValue.fromBinary` takes ownership of (and destroys) its input,
    // so hand it a throwaway copy and keep `this.masterKey` intact.
    const keyCopy = Uint8Array.from(this.masterKey);
    const password = kdbxweb.ProtectedValue.fromBinary(keyCopy.buffer);
    const credentials = new kdbxweb.Credentials(password);
    await credentials.ready;
    return credentials;
  }

  /** Ensure `this.db` is populated (load existing file or create a new db). */
  private async ensureOpen(): Promise<kdbxweb.Kdbx> {
    if (this.db) return this.db;

    let data: Buffer | null = null;
    try {
      data = await fs.readFile(this.dbPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      data = null;
    }

    const credentials = await this.buildCredentials();
    if (data) {
      const ab = kdbxweb.ByteUtils.arrayToBuffer(data);
      this.db = await kdbxweb.Kdbx.load(ab, credentials);
    } else {
      const db = kdbxweb.Kdbx.create(credentials, DB_NAME);
      db.setVersion(4);
      db.setKdf(kdbxweb.Consts.KdfId.Argon2id);
      this.db = db;
    }
    return this.db;
  }

  /** Serialize the current db to disk atomically (temp file + rename). */
  private async persist(): Promise<void> {
    if (!this.db) throw new Error("kdbx-store: persist called before open");
    const ab = await this.db.save();
    const bytes = Buffer.from(ab);
    await fs.mkdir(path.dirname(this.dbPath), { recursive: true });
    const tmp = `${this.dbPath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, bytes, { mode: 0o600 });
    try {
      await fs.rename(tmp, this.dbPath);
    } catch (err) {
      await fs.rm(tmp, { force: true });
      throw err;
    }
  }

  private entries(db: kdbxweb.Kdbx): kdbxweb.KdbxEntry[] {
    return [...db.getDefaultGroup().allEntries()];
  }

  /**
   * Upsert a credential for `origin`. If an entry with the exact same URL
   * already exists it is updated in place (history pushed); otherwise a new
   * entry is created. Persists atomically.
   */
  async save(input: CredentialInput): Promise<void> {
    const db = await this.ensureOpen();
    const existing = this.entries(db).find(
      (e) => fieldToString(e.fields.get(FIELD_URL)) === input.origin,
    );

    const entry = existing ?? db.createEntry(db.getDefaultGroup());
    if (existing) entry.pushHistory();

    entry.fields.set(FIELD_URL, input.origin);
    entry.fields.set(FIELD_USERNAME, input.username);
    entry.fields.set(
      FIELD_PASSWORD,
      kdbxweb.ProtectedValue.fromString(input.password),
    );
    entry.times.update();

    await this.persist();
  }

  /**
   * Return matches for `origin` — EXACT origin equality only, never a
   * cross-origin or substring match. Matches carry only non-secret metadata
   * (id + username); the password is never included (spec §R6).
   */
  async lookupByOrigin(origin: string): Promise<PasswordLookupMatch[]> {
    const db = await this.ensureOpen();
    return this.entries(db)
      .filter((e) => fieldToString(e.fields.get(FIELD_URL)) === origin)
      .map((e) => ({
        id: e.uuid.id,
        username: fieldToString(e.fields.get(FIELD_USERNAME)),
      }));
  }

  /**
   * Classify a submitted credential against the store: `absent` (no entry for
   * this origin+username), `identical` (same password — nothing to save), or
   * `password-differs` (same user, new password — an update). Exact origin +
   * username match only.
   */
  async matchCredential(
    origin: string,
    username: string,
    password: string,
  ): Promise<CredentialMatch> {
    const db = await this.ensureOpen();
    const entry = this.entries(db).find(
      (e) =>
        fieldToString(e.fields.get(FIELD_URL)) === origin &&
        fieldToString(e.fields.get(FIELD_USERNAME)) === username,
    );
    if (!entry) return "absent";
    return fieldToString(entry.fields.get(FIELD_PASSWORD)) === password
      ? "identical"
      : "password-differs";
  }

  /**
   * Return the one-shot fill value (username + plaintext password) for a match
   * id previously returned by {@link lookupByOrigin}, or `null` if unknown.
   */
  async getFillValue(id: string): Promise<CredentialFillValue | null> {
    const db = await this.ensureOpen();
    const entry = this.entries(db).find((e) => e.uuid.id === id);
    if (!entry) return null;
    return {
      username: fieldToString(entry.fields.get(FIELD_USERNAME)),
      password: fieldToString(entry.fields.get(FIELD_PASSWORD)),
    };
  }
}
