import { Buffer } from "node:buffer";
import { randomBytes } from "node:crypto";
import { timingSafeEqual } from "node:crypto";

import type {
  ConnectionMetadata,
  ConnectionRecord,
  ConnectionRef,
  ConnectionRefWithId,
  ConnectionScope,
  SecretCategory,
  StoreConnectionOptions,
  UnlockVaultOptions,
  VaultBackend,
  VaultState,
} from "@nautilo/types";

import { atomicWriteVaultFile, readVaultFile } from "./atomic-fs.ts";
import { connectionIdentityKeyFromRef } from "./connection-id.ts";
import { VAULT_ENCRYPTION_SENTINEL } from "./constants.ts";
import type { BunOrPinVaultMasterPersistence } from "./master-persistence.ts";
import type { VaultMasterPersistence } from "./master-persistence.ts";
import type { VaultDiskEnvelope } from "./disk-types.ts";
import type { DiskValue } from "./disk-types.ts";
import type { DiskMetadataRow } from "./disk-types.ts";
import { emptyVaultEnvelope, validateVaultEnvelope } from "./disk-validate.ts";
import {
  VaultCryptoError,
  VaultLockedError,
  VaultSchemaError,
  VaultScopeError,
} from "./errors.ts";
import { aesGcmDecrypt, aesGcmEncrypt } from "./payload-crypto.ts";
import { connectionReadable, targetRowAllowedForWrite } from "./scope-match.ts";

function toDiskMeta(m: DiskMetadataRow): ConnectionMetadata {
  return {
    authored_by_user_id: m.authored_by_user_id,
    category: m.category,
    created_at: m.created_at,
    expires_at: m.expires_at,
    field: m.field,
    namespace_id: m.namespace_id,
    service: m.service,
    updated_at: m.updated_at,
    agent_id: m.agent_id,
  };
}

function rowExpired(meta: DiskMetadataRow, nowMs = Date.now()): boolean {
  if (!meta.expires_at) {
    return false;
  }
  const expiresMs = Date.parse(meta.expires_at);
  return Number.isFinite(expiresMs) && expiresMs <= nowMs;
}

function resolveReadableRowForRef(
  envelope: VaultDiskEnvelope,
  ref: ConnectionRefWithId,
  scope: ConnectionScope,
): string | undefined {
  if (ref.id !== undefined) {
    const meta = envelope.metadata[ref.id];
    if (
      meta &&
      meta.service === ref.service &&
      meta.field === ref.field &&
      ref.id in envelope.secrets &&
      connectionReadable(toDiskMeta(meta), scope)
    ) {
      return ref.id;
    }

    return undefined;
  }

  const hits = Object.entries(envelope.metadata)
    .filter(
      ([id, meta]) =>
        meta.service === ref.service &&
        meta.field === ref.field &&
        id in envelope.secrets &&
        connectionReadable(toDiskMeta(meta), scope),
    )
    .map(([id]) => id);

  if (hits.length === 0) {
    return undefined;
  }

  const defNs = scope.defaultNamespaceId;
  if (defNs !== undefined && defNs !== null) {
    const pick = hits.find((hid) => {
      const md = envelope.metadata[hid];
      return md && md.namespace_id === defNs;
    });
    if (pick !== undefined) {
      return pick;
    }
  }

  if (hits.length > 1) {
    throw new VaultScopeError(
      "ambiguous Connection reference; include row id or defaultNamespaceId",
    );
  }

  return hits[0];
}

export function deriveRowMetadata(params: {
  readonly ref: ConnectionRef;
  readonly scope: ConnectionScope;
  readonly options?: StoreConnectionOptions | undefined;
}): DiskMetadataRow {
  const { ref, scope, options } = params;
  const category: SecretCategory = options?.category ?? "user";

  const namespace_id = options?.namespaceId ?? scope.defaultNamespaceId ?? null;
  const agent_id = options?.agentId ?? scope.agentId;

  const nowIso = new Date(options?.nowMs ?? Date.now()).toISOString();

  return {
    agent_id,
    authored_by_user_id: options?.authoredByUserId ?? null,
    category,
    expires_at: options?.expiresAt ?? null,
    field: ref.field,
    namespace_id,
    created_at: nowIso,
    service: ref.service,
    updated_at: nowIso,
  };
}

/** Single-file builtin backend implementing `VaultBackend`. */
export class BuiltinVaultBackend implements VaultBackend {
  private _disk!: VaultDiskEnvelope;
  private _masterKey?: Buffer | undefined;

  constructor(
    private readonly deps: Readonly<{
      readonly vaultPath: string;
      readonly installId: string;
      readonly masterPersistence: VaultMasterPersistence;
    }>,
    initialEnvelope?: VaultDiskEnvelope,
  ) {
    this._disk = initialEnvelope ?? emptyVaultEnvelope();
  }

  get vaultFilePath(): string {
    return this.deps.vaultPath;
  }

  get state(): VaultState {
    const mode = this._disk.config.encryption_mode;
    if (mode === "none") {
      return "plaintext_open";
    }
    if (!this._masterKey) {
      return "encrypted_locked";
    }
    return "encrypted_unlocked";
  }

  private assertNotLocked(): void {
    if (this.state === "encrypted_locked") {
      throw new VaultLockedError("vault not unlocked");
    }
  }

  private clearMasterKey(): void {
    if (this._masterKey) {
      this._masterKey.fill(0);
      this._masterKey = undefined;
    }
  }

  lock(): void {
    this.clearMasterKey();
  }

  async loadFromDisk(): Promise<void> {
    const read = await readVaultFile(this.deps.vaultPath);
    if (!read) {
      this._disk = emptyVaultEnvelope();
      return;
    }
    this._disk = validateVaultEnvelope(read);
  }

  private async ensureLoaded(): Promise<void> {
    await this.loadFromDisk();
  }

  async flushToDisk(): Promise<void> {
    await atomicWriteVaultFile(this.deps.vaultPath, this._disk);
  }

  private verifySentinel(aesKey256: Buffer): void {
    const sentinel = this._disk.encryption?.sentinel;
    if (!sentinel) {
      throw new VaultSchemaError("encrypted vault sentinel missing");
    }

    const plain = aesGcmDecrypt(aesKey256, sentinel.n, sentinel.blob);
    const expect = Buffer.from(VAULT_ENCRYPTION_SENTINEL, "utf8");
    if (plain.length !== expect.length || !timingSafeEqual(plain, expect)) {
      throw new VaultCryptoError("vault sentinel mismatch");
    }
  }

  async unlock(options?: UnlockVaultOptions  ): Promise<void> {
    await this.ensureLoaded();

    if (this._disk.config.encryption_mode === "none") {
      return;
    }

    const candidates = await this.loadMasterCandidates(options);
    const key = candidates.find((candidate) => {
      try {
        this.verifySentinel(candidate);
        return true;
      } catch {
        return false;
      }
    });

    if (!key) {
      throw new VaultCryptoError("vault master unavailable or sentinel mismatch");
    }

    this.clearMasterKey();
    this._masterKey = Buffer.from(key);
  }

  private async loadMasterCandidates(
    options?: UnlockVaultOptions  ,
  ): Promise<Buffer[]> {
    if (
      "loadCandidates" in this.deps.masterPersistence &&
      typeof this.deps.masterPersistence.loadCandidates === "function"
    ) {
      return this.deps.masterPersistence.loadCandidates(
        this.deps.installId,
        options?.pinUtf8,
      );
    }

    const key = await this.deps.masterPersistence.load(
      this.deps.installId,
      options?.pinUtf8,
    );
    return key ? [key] : [];
  }

  async enableEncryption(options?: UnlockVaultOptions  ): Promise<void> {
    await this.ensureLoaded();

    if (this._disk.config.encryption_mode !== "none") {
      throw new VaultSchemaError("vault already encrypted");
    }

    const master = Buffer.from(randomBytes(32));

    const maybeDual = this.deps.masterPersistence as
      | BunOrPinVaultMasterPersistence
      | VaultMasterPersistence;

    try {
      await this.deps.masterPersistence.persist(this.deps.installId, master);
    } catch {
      if (
        "persistWithPin" in maybeDual &&
        typeof maybeDual.persistWithPin === "function"
      ) {
        const pin = options?.pinUtf8;
        if (!pin) {
          throw new VaultCryptoError(
            "persisting vault master requires pinUtf8 fallback when Bun.secrets lacks keychain storage",
          );
        }

        await maybeDual.persistWithPin(this.deps.installId, master, pin);
      } else {
        throw new VaultCryptoError("unable to persist vault master");
      }
    }

    const sentinelBuf = aesGcmEncrypt(
      master,
      Buffer.from(VAULT_ENCRYPTION_SENTINEL, "utf8"),
    );
    const migratedSecrets: VaultDiskEnvelope["secrets"] = {};

    for (const [id, prev] of Object.entries(this._disk.secrets)) {
      migratedSecrets[id] = this.promotePayloadToEncrypted(master, prev);
    }

    this._disk = {
      encryption: {
        sentinel: {
          blob: sentinelBuf.blobB64,
          n: sentinelBuf.nonceB64,
        },
      },
      config: { encryption_mode: "aes_256_gcm" },
      metadata: this._disk.metadata,
      schema_version: this._disk.schema_version,
      secrets: migratedSecrets,
    };

    this.clearMasterKey();
    this._masterKey = Buffer.from(master);
    await this.flushToDisk();
    master.fill(0);
  }

  private promotePayloadToEncrypted(
    masterKey: Buffer,
    row: DiskValue,
  ): DiskValue {
    if (row.enc === "aes_gcm") {
      return row;
    }

    const buf = Buffer.from(row.b64, "base64");
    const boxed = aesGcmEncrypt(masterKey, buf);
    buf.fill(0);
    return {
      enc: "aes_gcm",
      n: boxed.nonceB64,
      b64: boxed.blobB64,
    };
  }

  async get(
    ref: ConnectionRefWithId,
    scope: ConnectionScope,
  ): Promise<Buffer | null> {
    await this.ensureLoaded();
    if (this._disk.config.encryption_mode === "aes_256_gcm") {
      this.assertNotLocked();
    }

    const id = resolveReadableRowForRef(this._disk, ref, scope);
    if (!id) {
      return null;
    }

    const dv = this._disk.secrets[id];
    if (!dv) {
      return null;
    }
    const meta = this._disk.metadata[id];
    if (!meta || rowExpired(meta)) {
      return null;
    }

    return this.unlockPayloadBlob(dv);
  }

  private encodeStoredPayload(value: Buffer): DiskValue {
    if (this._disk.config.encryption_mode === "aes_256_gcm") {
      if (!this._masterKey) {
        throw new VaultLockedError();
      }

      const copyPlain = Buffer.from(value);
      const pack = aesGcmEncrypt(this._masterKey, copyPlain);
      copyPlain.fill(0);
      return {
        enc: "aes_gcm",
        n: pack.nonceB64,
        b64: pack.blobB64,
      };
    }

    return { b64: value.toString("base64"), enc: "plain" };
  }

  async set(
    ref: ConnectionRef,
    value: Buffer,
    scope: ConnectionScope,
    options?: StoreConnectionOptions  ,
  ): Promise<void> {
    await this.ensureLoaded();

    const proposed = deriveRowMetadata({ options, ref, scope });
    if (
      !targetRowAllowedForWrite({
        agent_id: proposed.agent_id,
        category: proposed.category,
        namespace_id: proposed.namespace_id,
        scope,
      })
    ) {
      throw new VaultCryptoError("write rejected — scope forbids Connection row");
    }

    const id = connectionIdentityKeyFromRef(ref, proposed.namespace_id, proposed.agent_id);

    this.assertNotLocked();

    const prev = this._disk.metadata[id];
    const nowIso = new Date(options?.nowMs ?? Date.now()).toISOString();

    const nextRow: DiskMetadataRow = prev
      ? {
          ...prev,
          ...proposed,
          created_at: prev.created_at,
          updated_at: nowIso,
        }
      : { ...proposed, created_at: nowIso, updated_at: nowIso };

    const payloadEncoded = this.encodeStoredPayload(Buffer.from(value));

    this._disk = {
      ...this._disk,
      metadata: { ...this._disk.metadata, [id]: nextRow },
      secrets: { ...this._disk.secrets, [id]: payloadEncoded },
    };

    await this.flushToDisk();
  }

  private unlockPayloadBlob(dv: DiskValue): Buffer {
    if (dv.enc === "plain") {
      return Buffer.from(dv.b64, "base64");
    }

    if (!this._masterKey || this._masterKey.byteLength !== 32) {
      throw new VaultLockedError("vault ciphertext requires unlocked master key");
    }

    return aesGcmDecrypt(this._masterKey, dv.n, dv.b64);
  }

  async list(scope: ConnectionScope): Promise<ConnectionRecord[]> {
    await this.ensureLoaded();

    const out: ConnectionRecord[] = [];
    for (const [id, meta] of Object.entries(this._disk.metadata)) {
      if (!(id in this._disk.secrets)) {
        continue;
      }

      if (!connectionReadable(toDiskMeta(meta), scope)) {
        continue;
      }
      if (rowExpired(meta)) {
        continue;
      }

      const record: ConnectionRecord = {
        id,
        metadata: toDiskMeta(meta),
        ref: { field: meta.field, service: meta.service },
      };

      out.push(record);
    }

    out.sort((a, b) => {
      const diff = b.metadata.updated_at.localeCompare(a.metadata.updated_at);

      const diffFallback =
        diff !== 0 ? diff : String(a.id).localeCompare(String(b.id));

      return diffFallback;
    });

    return out;
  }

  async delete(ref: ConnectionRefWithId, scope: ConnectionScope): Promise<boolean> {
    await this.ensureLoaded();

    const id = resolveReadableRowForRef(this._disk, ref, scope);

    if (!id) {
      return false;
    }

    this.assertNotLocked();

    const meta = this._disk.metadata[id];
    if (!meta) {
      return false;
    }
    if (
      !targetRowAllowedForWrite({
        agent_id: meta.agent_id,
        category: meta.category,
        namespace_id: meta.namespace_id,
        scope,
      })
    ) {
      throw new VaultScopeError("delete rejected - scope forbids Connection row");
    }

    const { [id]: _omitMeta, ...restMeta } = this._disk.metadata;
    const { [id]: _omitSecrets, ...restSecrets } = this._disk.secrets;
    void _omitMeta;
    void _omitSecrets;

    this._disk = {
      ...this._disk,
      metadata: restMeta,
      secrets: restSecrets,
    };

    await this.flushToDisk();
    return true;
  }

  async rotateKey(): Promise<void> {
    await this.ensureLoaded();

    if (this._disk.config.encryption_mode !== "aes_256_gcm") {
      throw new VaultSchemaError("rotateKey only meaningful for encrypted envelopes");
    }

    this.assertNotLocked();
    if (!this._masterKey) {
      throw new VaultLockedError();
    }

    const oldMaster = Buffer.from(this._masterKey);

    const nextMaster = Buffer.from(randomBytes(32));

    const nextSecrets: VaultDiskEnvelope["secrets"] = {};

    for (const [sid, dv] of Object.entries(this._disk.secrets)) {
      let plainInner: Buffer;
      if (dv.enc === "plain") {
        plainInner = Buffer.from(dv.b64, "base64");
      } else {
        plainInner = aesGcmDecrypt(oldMaster, dv.n, dv.b64);
      }

      nextSecrets[sid] = aesGcmEncodeDiskValue(nextMaster, plainInner);

      plainInner.fill(0);
    }

    const sentinelPacked = aesGcmEncrypt(
      nextMaster,
      Buffer.from(VAULT_ENCRYPTION_SENTINEL, "utf8"),
    );

    const nextDisk: VaultDiskEnvelope = {
      ...this._disk,
      encryption: {
        sentinel: {
          blob: sentinelPacked.blobB64,
          n: sentinelPacked.nonceB64,
        },
      },
      secrets: nextSecrets,
    };

    if (
      "persistPrevious" in this.deps.masterPersistence &&
      typeof this.deps.masterPersistence.persistPrevious === "function"
    ) {
      await this.deps.masterPersistence.persistPrevious(this.deps.installId, oldMaster);
    }

    await this.deps.masterPersistence.persist(this.deps.installId, nextMaster);

    this._disk = nextDisk;
    oldMaster.fill(0);
    await this.flushToDisk();

    if (
      "clearPrevious" in this.deps.masterPersistence &&
      typeof this.deps.masterPersistence.clearPrevious === "function"
    ) {
      await this.deps.masterPersistence.clearPrevious(this.deps.installId);
    }

    this.clearMasterKey();
    this._masterKey = Buffer.from(nextMaster);

    this.verifySentinel(this._masterKey);
    nextMaster.fill(0);
  }
}

function aesGcmEncodeDiskValue(key: Buffer, plain: Buffer): DiskValue {
  const box = aesGcmEncrypt(key, plain);
  return {
    b64: box.blobB64,
    enc: "aes_gcm",
    n: box.nonceB64,
  };
}
