/** OS-protected, crash-durable journal for bound mini-app drafts. */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FS_WRITE_FILE_MAX_BYTES } from "./fs-write";
import type { GuardedFileAdapter } from "./local-file-history/file-adapter";
import {
  MINI_APP_RECOVERY_VERSION,
  parseMiniAppRecoveryBinding,
  parseMiniAppRecoveryDraft,
  type MiniAppRecoveryBinding,
  type MiniAppRecoveryDraft,
  type MiniAppRecoveryReadResult,
} from "./mini-app-draft-recovery-contract";

const HEADER = Buffer.from("nautilo-mini-app-recovery-v1\0", "utf8");
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export interface MiniAppRecoverySafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

function isMiniAppRecoveryStorageProtected(
  safeStorage: MiniAppRecoverySafeStorage,
): boolean {
  return safeStorage.isEncryptionAvailable() &&
    safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

export class MiniAppRecoveryError extends Error {
  constructor(
    readonly code: "unavailable" | "invalid" | "conflict" | "too_large" | "authority_changed",
    message: string,
  ) {
    super(message);
    this.name = "MiniAppRecoveryError";
  }
}

/** Recovery belongs to an already-authorized path, even after its file is
 * moved or deleted. Resolve through the current grant and reject symlinks;
 * this permits reading the journal, never recreating the missing original. */
export async function resolveMiniAppRecoveryFilePath(
  files: Pick<GuardedFileAdapter, "resolveTarget" | "stat">,
  candidatePath: string,
): Promise<string> {
  const canonical = await files.resolveTarget(candidatePath, { allowMissing: true, rejectFinalSymlink: true });
  const stat = await files.stat(canonical);
  if (stat && (!stat.isFile || stat.isSymbolicLink)) {
    throw new MiniAppRecoveryError("authority_changed", "Draft recovery is unavailable for this document.");
  }
  return canonical;
}

type StoredEnvelope = Readonly<{
  version: typeof MINI_APP_RECOVERY_VERSION;
  binding: MiniAppRecoveryBinding;
  revision: string;
  draft: MiniAppRecoveryDraft | null;
  draftSha256: string | null;
}>;

const SHA256 = /^[0-9a-f]{64}$/;

function draftSha256(draft: MiniAppRecoveryDraft): string {
  const canonical = JSON.stringify({
    version: draft.version,
    content: draft.content,
    exact: draft.exact,
    baseSha256: draft.baseSha256,
    baseRevision: draft.baseRevision,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function canonicalBinding(binding: MiniAppRecoveryBinding): string {
  const target = binding.target.kind === "workspace_artifact"
    ? { kind: binding.target.kind, artifactInternalId: binding.target.artifactInternalId }
    : { kind: binding.target.kind, relayId: binding.target.relayId, canonicalPath: binding.target.canonicalPath };
  return JSON.stringify({
    owner: {
      humanId: binding.owner.humanId,
      canonicalOrigin: binding.owner.canonicalOrigin,
      serverFingerprint: binding.owner.serverFingerprint,
    },
    appId: binding.appId,
    target,
  });
}

function sameBinding(left: MiniAppRecoveryBinding, right: MiniAppRecoveryBinding): boolean {
  return canonicalBinding(left) === canonicalBinding(right);
}

function parseEnvelope(value: unknown): StoredEnvelope | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).sort().join(",") !==
    "binding,draft,draftSha256,revision,version"
  ) return null;
  if (
    record["version"] !== MINI_APP_RECOVERY_VERSION ||
    typeof record["revision"] !== "string" ||
    record["revision"].length === 0
  ) return null;
  const typedBinding = parseMiniAppRecoveryBinding(record["binding"]);
  if (!typedBinding) return null;
  const draft = record["draft"] === null ? null : parseMiniAppRecoveryDraft(record["draft"]);
  if (record["draft"] !== null && !draft) return null;
  const checksum = record["draftSha256"];
  let verifiedChecksum: string | null;
  if (draft === null) {
    if (checksum !== null) return null;
    verifiedChecksum = null;
  } else {
    if (
      typeof checksum !== "string" ||
      !SHA256.test(checksum) ||
      checksum !== draftSha256(draft)
    ) return null;
    verifiedChecksum = checksum;
  }
  return {
    version: MINI_APP_RECOVERY_VERSION,
    binding: typedBinding,
    revision: record["revision"],
    draft,
    draftSha256: verifiedChecksum,
  };
}

async function syncDirectory(dirPath: string): Promise<void> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupportedOnWindows = process.platform === "win32" &&
      ["EINVAL", "ENOTSUP", "EISDIR", "EPERM", "EBADF"].includes(code ?? "");
    if (!unsupportedOnWindows) throw error;
  } finally {
    await handle?.close();
  }
}

async function writeAtomically(
  filePath: string,
  bytes: Uint8Array,
  beforePublish: () => void | Promise<void>,
): Promise<void> {
  const dirPath = path.dirname(filePath);
  await fs.mkdir(dirPath, { recursive: true, mode: DIR_MODE });
  await fs.chmod(dirPath, DIR_MODE);
  const temporaryPath = path.join(
    dirPath,
    `.${path.basename(filePath)}.${randomBytes(12).toString("hex")}.tmp`,
  );
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(temporaryPath, "wx", FILE_MODE);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await beforePublish();
    await fs.rename(temporaryPath, filePath);
    await fs.chmod(filePath, FILE_MODE);
    await syncDirectory(dirPath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export class MiniAppDraftRecoveryStore {
  readonly #lanes = new Map<string, Promise<void>>();

  constructor(private readonly options: Readonly<{
    rootDir: string;
    safeStorage: MiniAppRecoverySafeStorage;
    mintRevision?: () => string;
    /** Test-only crash/concurrency seam immediately before atomic publication. */
    onBeforeAtomicPublish?: () => void | Promise<void>;
    /** Test-only async read seam used to prove revocation before disclosure. */
    onBeforeReadReturn?: () => void | Promise<void>;
  }>) {}

  #scopeKey(binding: MiniAppRecoveryBinding): string {
    return createHash("sha256").update(canonicalBinding(binding), "utf8").digest("hex");
  }

  #filePath(binding: MiniAppRecoveryBinding): string {
    return path.join(this.options.rootDir, `${this.#scopeKey(binding)}.bin`);
  }

  #requireProtection(): void {
    if (!isMiniAppRecoveryStorageProtected(this.options.safeStorage)) {
      throw new MiniAppRecoveryError(
        "unavailable",
        "Protected draft recovery is unavailable on this device.",
      );
    }
  }

  async #readEnvelope(binding: MiniAppRecoveryBinding): Promise<StoredEnvelope | null> {
    this.#requireProtection();
    let bytes: Buffer;
    try {
      bytes = await fs.readFile(this.#filePath(binding));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (bytes.length <= HEADER.length || !bytes.subarray(0, HEADER.length).equals(HEADER)) {
      throw new MiniAppRecoveryError("invalid", "The saved recovery draft is unreadable.");
    }
    let envelope: StoredEnvelope | null = null;
    try {
      envelope = parseEnvelope(JSON.parse(
        this.options.safeStorage.decryptString(bytes.subarray(HEADER.length)),
      ));
    } catch {
      envelope = null;
    }
    if (!envelope || !sameBinding(envelope.binding, binding)) {
      throw new MiniAppRecoveryError("invalid", "The saved recovery draft is unreadable.");
    }
    return envelope;
  }

  async read(binding: MiniAppRecoveryBinding): Promise<MiniAppRecoveryReadResult> {
    const envelope = await this.#readEnvelope(binding);
    await this.options.onBeforeReadReturn?.();
    return envelope
      ? { revision: envelope.revision, draft: envelope.draft }
      : { revision: null, draft: null };
  }

  async write(
    binding: MiniAppRecoveryBinding,
    expectedRevision: string | null,
    draft: MiniAppRecoveryDraft | null,
    isAuthorized: () => boolean | Promise<boolean> = () => true,
  ): Promise<{ revision: string }> {
    if (draft && Buffer.byteLength(draft.content, "utf8") > FS_WRITE_FILE_MAX_BYTES) {
      throw new MiniAppRecoveryError(
        "too_large",
        "The recovery draft is larger than the supported document size.",
      );
    }
    const key = this.#scopeKey(binding);
    return await this.#inLane(key, async () => {
      await this.#requireAuthorized(isAuthorized);
      const current = await this.#readEnvelope(binding);
      if ((current?.revision ?? null) !== expectedRevision) {
        throw new MiniAppRecoveryError(
          "conflict",
          "The recovery draft changed in another editor.",
        );
      }
      const revision = (this.options.mintRevision ?? randomUUID)();
      if (!revision) throw new MiniAppRecoveryError("invalid", "Could not save the recovery draft.");
      const envelope: StoredEnvelope = {
        version: MINI_APP_RECOVERY_VERSION,
        binding,
        revision,
        draft,
        draftSha256: draft ? draftSha256(draft) : null,
      };
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify(envelope));
      await writeAtomically(
        this.#filePath(binding),
        Buffer.concat([HEADER, encrypted]),
        async () => {
          await this.options.onBeforeAtomicPublish?.();
          await this.#requireAuthorized(isAuthorized);
        },
      );
      return { revision };
    });
  }

  async #requireAuthorized(isAuthorized: () => boolean | Promise<boolean>): Promise<void> {
    if (!await isAuthorized()) {
      throw new MiniAppRecoveryError(
        "authority_changed",
        "Draft recovery is no longer authorized.",
      );
    }
  }

  async #inLane<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const prior = this.#lanes.get(key) ?? Promise.resolve();
    const result = prior.catch(() => undefined).then(operation);
    const tail = result.then(() => undefined, () => undefined);
    this.#lanes.set(key, tail);
    try {
      return await result;
    } finally {
      if (this.#lanes.get(key) === tail) this.#lanes.delete(key);
    }
  }
}

type RecoveryHandle = {
  senderId: number;
  authGeneration: number;
  binding: MiniAppRecoveryBinding;
  revoked: boolean;
  pendingWrites: Set<Promise<unknown>>;
};

export type MiniAppRecoveryHandleContext = Readonly<{
  senderId: number;
  authGeneration: number;
  canonicalOrigin: string;
  serverFingerprint: string;
  signedIn: boolean;
}>;

/** In-memory capability registry. Handles never survive renderer/process life. */
export class MiniAppDraftRecoveryRuntime {
  readonly #handles = new Map<string, RecoveryHandle>();

  constructor(private readonly options: Readonly<{
    store: MiniAppDraftRecoveryStore;
    mintHandle?: () => string;
    authorizeBinding?: (binding: MiniAppRecoveryBinding) => boolean | Promise<boolean>;
  }>) {}

  open(senderId: number, authGeneration: number, binding: MiniAppRecoveryBinding): string {
    const handle = (this.options.mintHandle ?? randomUUID)();
    if (!handle || this.#handles.has(handle)) {
      throw new MiniAppRecoveryError("invalid", "Could not open draft recovery.");
    }
    this.#handles.set(handle, {
      senderId,
      authGeneration,
      binding,
      revoked: false,
      pendingWrites: new Set(),
    });
    return handle;
  }

  async read(context: MiniAppRecoveryHandleContext, handle: string): Promise<MiniAppRecoveryReadResult> {
    const capability = this.#requireHandle(context, handle);
    await this.#requireCapabilityAuthorized(handle, capability);
    const result = await this.options.store.read(capability.binding);
    await this.#requireCapabilityAuthorized(handle, capability);
    return result;
  }

  async write(
    context: MiniAppRecoveryHandleContext,
    handle: string,
    expectedRevision: string | null,
    draft: MiniAppRecoveryDraft | null,
  ): Promise<{ revision: string }> {
    const capability = this.#requireHandle(context, handle);
    await this.#requireCapabilityAuthorized(handle, capability);
    const operation = this.options.store.write(
      capability.binding,
      expectedRevision,
      draft,
      () => this.#isCapabilityAuthorized(handle, capability),
    );
    capability.pendingWrites.add(operation);
    try {
      return await operation;
    } finally {
      capability.pendingWrites.delete(operation);
    }
  }

  async close(senderId: number, handle: string): Promise<void> {
    const binding = this.#handles.get(handle);
    if (!binding || binding.senderId !== senderId) {
      throw new MiniAppRecoveryError("authority_changed", "Draft recovery is no longer authorized.");
    }
    binding.revoked = true;
    this.#handles.delete(handle);
    await Promise.allSettled(binding.pendingWrites);
  }

  invalidateSender(senderId: number): void {
    for (const [handle, binding] of this.#handles) {
      if (binding.senderId === senderId) {
        binding.revoked = true;
        this.#handles.delete(handle);
      }
    }
  }

  invalidateAll(): void {
    for (const binding of this.#handles.values()) binding.revoked = true;
    this.#handles.clear();
  }

  #requireHandle(context: MiniAppRecoveryHandleContext, handle: string): RecoveryHandle {
    const stored = this.#handles.get(handle);
    if (
      !stored ||
      !context.signedIn ||
      stored.senderId !== context.senderId ||
      stored.authGeneration !== context.authGeneration ||
      stored.binding.owner.canonicalOrigin !== context.canonicalOrigin ||
      stored.binding.owner.serverFingerprint !== context.serverFingerprint
    ) {
      if (stored?.senderId === context.senderId) {
        stored.revoked = true;
        this.#handles.delete(handle);
      }
      throw new MiniAppRecoveryError("authority_changed", "Draft recovery is no longer authorized.");
    }
    return stored;
  }

  async #isCapabilityAuthorized(handle: string, capability: RecoveryHandle): Promise<boolean> {
    if (capability.revoked || this.#handles.get(handle) !== capability) return false;
    const bindingAuthorized = await (
      this.options.authorizeBinding?.(capability.binding) ?? true
    );
    return bindingAuthorized &&
      !capability.revoked &&
      this.#handles.get(handle) === capability;
  }

  async #requireCapabilityAuthorized(handle: string, capability: RecoveryHandle): Promise<void> {
    if (!await this.#isCapabilityAuthorized(handle, capability)) {
      capability.revoked = true;
      if (this.#handles.get(handle) === capability) this.#handles.delete(handle);
      throw new MiniAppRecoveryError(
        "authority_changed",
        "Draft recovery is no longer authorized.",
      );
    }
  }
}
