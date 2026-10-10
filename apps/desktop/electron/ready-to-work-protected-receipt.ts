/** OS-protected Electron-main store for the opaque Workstation startup receipt. */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { ensurePrivateDirectorySync } from "@nautilo/config/private-filesystem";
import {
  hasReadyToWorkExactBinding,
  matchesReadyToWorkRemoval,
  parseReadyToWorkRememberedKey,
  parseReadyToWorkRemovalScope,
  readyToWorkRememberedKey,
  sameReadyToWorkRememberedKey,
  type ReadyToWorkRememberedKey,
  type ReadyToWorkRemovalScope,
  isReadyToWorkOpaqueId,
  parseReadyToWorkAuthorityBinding,
  type ReadyToWorkBinding,
} from "./ready-to-work-contract";
import { ReadyToWorkPersistenceError, type ReadyToWorkPersistenceStatus } from "./ready-to-work-store";

const VERSION = 1 as const;
const HEADER = Buffer.from("nautilo-ready-workstation-receipt-v1\0", "utf8");
const MAX_RECEIPT_LENGTH = 4096;
const REMEMBERED_HEADER = Buffer.from("nautilo-ready-workstation-receipt-v2\0", "utf8");

export interface ReadyToWorkSafeStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

export function isReadyToWorkStorageProtected(safeStorage: ReadyToWorkSafeStorage): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  // Electron's Linux `basic_text` fallback is obfuscation, not OS protection.
  return safeStorage.getSelectedStorageBackend?.() !== "basic_text";
}

interface ProtectedWorkstationReceipt {
  readonly version: typeof VERSION;
  readonly humanId: string;
  readonly authority: ReadyToWorkBinding["authority"];
  readonly profileId: string;
  readonly profileRevision: number;
  readonly receipt: string;
}

type ReceiptFs = Readonly<{
  mkdirSync(path: string, options: { recursive: true; mode: number }): void;
  openSync(path: string, flags: "wx", mode: number): number;
  writeFileSync(fd: number, data: Buffer): void;
  closeSync(fd: number): void;
  renameSync(from: string, to: string): void;
  readFileSync(path: string): Buffer;
  unlinkSync(path: string): void;
}>;

const productionFs: ReceiptFs = {
  mkdirSync: (directory) => ensurePrivateDirectorySync(resolve(directory)),
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  readFileSync,
  unlinkSync,
};

function parseRecord(value: unknown): ProtectedWorkstationReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "authority,humanId,profileId,profileRevision,receipt,version") return null;
  const authority = parseReadyToWorkAuthorityBinding(record["authority"]);
  if (record["version"] !== VERSION || !authority || !isReadyToWorkOpaqueId(record["humanId"]) ||
    !isReadyToWorkOpaqueId(record["profileId"]) ||
    typeof record["profileRevision"] !== "number" || !Number.isSafeInteger(record["profileRevision"]) ||
    record["profileRevision"] < 1 || typeof record["receipt"] !== "string" ||
    record["receipt"].length === 0 || record["receipt"].length > MAX_RECEIPT_LENGTH) return null;
  return {
    version: VERSION,
    humanId: record["humanId"],
    authority,
    profileId: record["profileId"],
    profileRevision: record["profileRevision"],
    receipt: record["receipt"],
  };
}

export type ProtectedReceiptReadResult =
  | Readonly<{ ok: true; receipt: string; profileId: string; profileRevision: number }>
  | Readonly<{ ok: false; code: "unavailable" | "missing" | "invalid" | "foreign" }>;

export class ReadyToWorkProtectedReceiptStore {
  constructor(private readonly options: Readonly<{
    filePath: string;
    /** Opt-in versioned file, never a replacement for the legacy filename. */
    rememberedFilePath?: string;
    safeStorage: ReadyToWorkSafeStorage;
    fs?: ReceiptFs;
    mintTemporaryId?: () => string;
  }>) {}

  private readState(): {
    bytes: Buffer | null;
    status: ReadyToWorkPersistenceStatus;
    record?: ProtectedWorkstationReceipt;
  } {
    const fsPort = this.options.fs ?? productionFs;
    let bytes: Buffer;
    try {
      bytes = fsPort.readFileSync(this.options.filePath);
    } catch (error) {
      return { bytes: null, status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" };
    }
    if (!bytes.subarray(0, HEADER.length).equals(HEADER)) {
      return { bytes, status: bytes.subarray(0, HEADER.length).toString("utf8").startsWith("nautilo-ready-workstation-receipt-v")
        ? "unsupported" : "invalid" };
    }
    if (bytes.length === HEADER.length) return { bytes, status: "invalid" };
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return { bytes, status: "unavailable" };
    let parsed: ProtectedWorkstationReceipt | null;
    try {
      const value: unknown = JSON.parse(this.options.safeStorage.decryptString(bytes.subarray(HEADER.length)));
      if (typeof value === "object" && value !== null && !Array.isArray(value) &&
        "version" in value && typeof value.version === "number" && value.version !== VERSION) {
        return { bytes, status: "unsupported" };
      }
      parsed = parseRecord(value);
    } catch {
      parsed = null;
    }
    return parsed ? { bytes, status: "ready", record: parsed } : { bytes, status: "invalid" };
  }

  /** Classification only; no protected proof is exposed by inspection. */
  inspect(): Readonly<{ status: ReadyToWorkPersistenceStatus }> {
    return { status: this.readState().status };
  }

  private writableState(): ReturnType<ReadyToWorkProtectedReceiptStore["readState"]> {
    const state = this.readState();
    if (state.status !== "ready" && state.status !== "missing") throw new ReadyToWorkPersistenceError(state.status);
    return state;
  }

  private verifyUnchanged(bytes: Buffer | null): void {
    const next = this.writableState().bytes;
    if (bytes === null ? next !== null : next === null || !bytes.equals(next)) throw new ReadyToWorkPersistenceError("changed");
  }

  readFor(binding: ReadyToWorkBinding): ProtectedReceiptReadResult {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return { ok: false, code: "unavailable" };
    const state = this.readState();
    if (state.status !== "ready" || state.record === undefined) {
      return { ok: false, code: state.status === "missing" || state.status === "unavailable" ? state.status : "invalid" };
    }
    const parsed = state.record;
    if (!hasReadyToWorkExactBinding({
      version: 1,
      humanId: parsed.humanId,
      authority: parsed.authority,
      components: { voice: false, auto_approve: false, workstation: false, computer_use: false, coding_connection: false },
    }, binding)) return { ok: false, code: "foreign" };
    return {
      ok: true,
      receipt: parsed.receipt,
      profileId: parsed.profileId,
      profileRevision: parsed.profileRevision,
    };
  }

  save(input: Readonly<{
    binding: ReadyToWorkBinding;
    profileId: string;
    profileRevision: number;
    receipt: string;
  }>): boolean {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return false;
    const record = parseRecord({ version: VERSION, humanId: input.binding.humanId,
      authority: input.binding.authority, profileId: input.profileId,
      profileRevision: input.profileRevision, receipt: input.receipt });
    if (!record) return false;
    const previous = this.writableState();
    const fsPort = this.options.fs ?? productionFs;
    const temporaryId = (this.options.mintTemporaryId ?? randomUUID)();
    if (!temporaryId || temporaryId.includes("/") || temporaryId.includes("\\")) return false;
    const temporaryPath = `${this.options.filePath}.${temporaryId}.tmp`;
    let descriptor: number | null = null;
    let ownsTemporaryPath = false;
    try {
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify(record));
      fsPort.mkdirSync(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
      descriptor = fsPort.openSync(temporaryPath, "wx", 0o600);
      ownsTemporaryPath = true;
      fsPort.writeFileSync(descriptor, Buffer.concat([HEADER, encrypted]));
      fsPort.closeSync(descriptor);
      descriptor = null;
      this.verifyUnchanged(previous.bytes);
      fsPort.renameSync(temporaryPath, this.options.filePath);
      return true;
    } catch (error) {
      if (descriptor !== null) try { fsPort.closeSync(descriptor); } catch { /* best effort */ }
      if (ownsTemporaryPath) try { fsPort.unlinkSync(temporaryPath); } catch { /* best effort */ }
      if (error instanceof ReadyToWorkPersistenceError) throw error;
      return false;
    }
  }

  private rememberedPath(): string {
    const file = this.options.rememberedFilePath;
    if (!file || file === this.options.filePath) throw new Error("Remembered proof requires a separate versioned path");
    return file;
  }

  private rememberedState(): { bytes: Buffer | null; envelope: RememberedReceiptEnvelope | null } {
    let bytes: Buffer;
    try { bytes = (this.options.fs ?? productionFs).readFileSync(this.rememberedPath()); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, envelope: null }; throw new ReadyToWorkPersistenceError("unavailable"); }
    if (!bytes.subarray(0, REMEMBERED_HEADER.length).equals(REMEMBERED_HEADER)) {
      throw new ReadyToWorkPersistenceError(bytes.subarray(0, REMEMBERED_HEADER.length).toString("utf8").startsWith("nautilo-ready-workstation-receipt-v") ? "unsupported" : "invalid");
    }
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) throw new ReadyToWorkPersistenceError("unavailable");
    let value: unknown;
    try { value = JSON.parse(this.options.safeStorage.decryptString(bytes.subarray(REMEMBERED_HEADER.length))) as unknown; }
    catch { throw new ReadyToWorkPersistenceError("invalid"); }
    if (typeof value === "object" && value !== null && "version" in value && typeof value.version === "number" && value.version !== 2) throw new ReadyToWorkPersistenceError("unsupported");
    const envelope = parseRememberedReceiptEnvelope(value);
    if (!envelope) throw new ReadyToWorkPersistenceError("invalid");
    return { bytes, envelope };
  }

  inspectRemembered(): Readonly<{ status: ReadyToWorkPersistenceStatus }> {
    try { return { status: this.rememberedState().envelope ? "ready" : "missing" }; }
    catch (error) { return { status: error instanceof ReadyToWorkPersistenceError && error.reason !== "changed" ? error.reason : "unavailable" }; }
  }

  readRememberedFor(binding: ReadyToWorkBinding, fenceId: string): ProtectedReceiptReadResult {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return { ok: false, code: "unavailable" };
    try {
      const { envelope } = this.rememberedState();
      if (!envelope) return { ok: false, code: "missing" };
      const record = envelope.records.find(value => sameReadyToWorkRememberedKey(value.key, readyToWorkRememberedKey(binding)));
      if (!record) return { ok: false, code: "missing" };
      if (record.fenceId !== fenceId || envelope.fenceId !== fenceId) return { ok: false, code: "invalid" };
      return { ok: true, receipt: record.receipt, profileId: record.profileId, profileRevision: record.profileRevision };
    } catch (error) { return { ok: false, code: error instanceof ReadyToWorkPersistenceError && error.reason === "unavailable" ? "unavailable" : "invalid" }; }
  }

  /** Migration must independently validate this opaque old proof before use. */
  pendingLegacyFor(binding: ReadyToWorkBinding): ProtectedReceiptReadResult {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return { ok: false, code: "unavailable" };
    const { envelope } = this.rememberedState();
    const legacy = this.readState();
    if (legacy.status !== "ready" && legacy.status !== "missing") throw new ReadyToWorkPersistenceError(legacy.status);
    const records = [...(envelope?.pendingLegacy ?? []), ...(legacy.record && legacyDigest(legacy.bytes) !== envelope?.legacyDigest ? [legacy.record] : [])];
    const record = records.reverse().find(value => sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), readyToWorkRememberedKey(binding)));
    return record ? { ok: true, receipt: record.receipt, profileId: record.profileId, profileRevision: record.profileRevision } : { ok: false, code: "missing" };
  }

  saveRemembered(input: Readonly<{
    binding: ReadyToWorkBinding; fenceId: string; profileId: string; profileRevision: number; receipt: string;
    retainedProofKeys: readonly ReadyToWorkRememberedKey[];
    /** Captured Ready intent plan and current main-process generation. */
    isCurrent: () => boolean;
  }>): void {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) throw new ReadyToWorkPersistenceError("unavailable");
    const record = parseRememberedReceipt({ key: readyToWorkRememberedKey(input.binding), fenceId: input.fenceId,
      profileId: input.profileId, profileRevision: input.profileRevision, receipt: input.receipt });
    if (!record) throw new ReadyToWorkPersistenceError("invalid");
    const previous = this.rememberedState();
    const legacy = this.readState();
    if (legacy.status !== "ready" && legacy.status !== "missing") throw new ReadyToWorkPersistenceError(legacy.status);
    let pendingLegacy = [...(previous.envelope?.pendingLegacy ?? [])];
    if (legacy.record && legacyDigest(legacy.bytes) !== previous.envelope?.legacyDigest) {
      const key = readyToWorkRememberedKey({ humanId: legacy.record.humanId, authority: legacy.record.authority });
      pendingLegacy = pendingLegacy.filter(value => !sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), key));
      pendingLegacy.push(legacy.record);
    }
    pendingLegacy = pendingLegacy.filter(value => !sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), record.key));
    const records = [...(previous.envelope?.records ?? []).filter(value => value.fenceId === input.fenceId
      && input.retainedProofKeys.some(key => sameReadyToWorkRememberedKey(key, value.key))
      && !sameReadyToWorkRememberedKey(value.key, record.key)), record];
    this.writeRemembered({ version: 2, fenceId: input.fenceId, legacyDigest: legacyDigest(legacy.bytes), records, pendingLegacy }, previous.bytes, () => {
      if (!input.isCurrent() || !sameBytes(this.readState().bytes, legacy.bytes)) throw new ReadyToWorkPersistenceError("changed");
    });
  }

  /** Called after intent reduction. It cannot create or revive any proof. */
  removeRemembered(scope: ReadyToWorkRemovalScope, isCurrent: () => boolean): void {
    if (!parseReadyToWorkRemovalScope(scope)) throw new ReadyToWorkPersistenceError("invalid");
    const previous = this.rememberedState();
    const legacy = this.readState();
    if (legacy.status !== "ready" && legacy.status !== "missing") throw new ReadyToWorkPersistenceError(legacy.status);
    const verify = () => {
      if (!isCurrent() || !sameBytes(this.readState().bytes, legacy.bytes)) throw new ReadyToWorkPersistenceError("changed");
    };
    if (previous.envelope) this.writeRemembered({ ...previous.envelope,
      records: previous.envelope.records.filter(value => !matchesReadyToWorkRemoval(value.key, scope)),
      pendingLegacy: previous.envelope.pendingLegacy.filter(value => !matchesReadyToWorkRemoval(readyToWorkRememberedKey(value), scope)),
    }, previous.bytes, verify);
    // Old ciphertext is retained only until the corresponding explicit local
    // removal. Never delete a foreign singleton or an unfamiliar format.
    if (legacy.record && matchesReadyToWorkRemoval(readyToWorkRememberedKey(legacy.record), scope)) {
      verify();
      try { (this.options.fs ?? productionFs).unlinkSync(this.options.filePath); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    }
  }

  private writeRemembered(envelope: RememberedReceiptEnvelope, previous: Buffer | null, verify: () => void): void {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) throw new ReadyToWorkPersistenceError("unavailable");
    const fs = this.options.fs ?? productionFs; const file = this.rememberedPath();
    const id = (this.options.mintTemporaryId ?? randomUUID)();
    if (!id || id.includes("/") || id.includes("\\")) throw new Error("Invalid Ready temporary id");
    const temporary = `${file}.${id}.tmp`; let fd: number | null = null; let owned = false;
    try {
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify(envelope));
      fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fd = fs.openSync(temporary, "wx", 0o600); owned = true;
      fs.writeFileSync(fd, Buffer.concat([REMEMBERED_HEADER, encrypted])); fs.closeSync(fd); fd = null;
      verify(); if (!sameBytes(this.rememberedState().bytes, previous)) throw new ReadyToWorkPersistenceError("changed");
      fs.renameSync(temporary, file); owned = false;
    } finally {
      if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
      if (owned) try { fs.unlinkSync(temporary); } catch { /* owned temporary only */ }
    }
  }

  clear(): boolean {
    const previous = this.writableState();
    if (previous.status === "missing") return false;
    this.verifyUnchanged(previous.bytes);
    try {
      (this.options.fs ?? productionFs).unlinkSync(this.options.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}


interface RememberedReceipt {
  readonly key: ReadyToWorkRememberedKey;
  readonly fenceId: string;
  readonly profileId: string;
  readonly profileRevision: number;
  readonly receipt: string;
}
interface RememberedReceiptEnvelope {
  readonly version: 2;
  readonly fenceId: string;
  readonly legacyDigest: string | null;
  readonly records: readonly RememberedReceipt[];
  readonly pendingLegacy: readonly ProtectedWorkstationReceipt[];
}
function sameBytes(a: Buffer | null, b: Buffer | null): boolean { return a === null ? b === null : b !== null && a.equals(b); }
function parseRememberedReceipt(value: unknown): RememberedReceipt | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "fenceId,key,profileId,profileRevision,receipt") return null;
  const key = parseReadyToWorkRememberedKey(record["key"]);
  if (!key || !isReadyToWorkOpaqueId(record["fenceId"]) || !isReadyToWorkOpaqueId(record["profileId"])
    || typeof record["profileRevision"] !== "number" || !Number.isSafeInteger(record["profileRevision"]) || record["profileRevision"] < 1
    || typeof record["receipt"] !== "string" || !record["receipt"].length || record["receipt"].length > MAX_RECEIPT_LENGTH) return null;
  return { key, fenceId: record["fenceId"], profileId: record["profileId"], profileRevision: record["profileRevision"], receipt: record["receipt"] };
}
function parseRememberedReceiptEnvelope(value: unknown): RememberedReceiptEnvelope | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join(",") !== "fenceId,legacyDigest,pendingLegacy,records,version" || record["version"] !== 2
    || !(record["legacyDigest"] === null || (typeof record["legacyDigest"] === "string" && /^[a-f0-9]{64}$/.test(record["legacyDigest"])))
    || !isReadyToWorkOpaqueId(record["fenceId"]) || !Array.isArray(record["records"]) || !Array.isArray(record["pendingLegacy"])) return null;
  const records: RememberedReceipt[] = [];
  for (const raw of record["records"] as unknown[]) {
    const item = parseRememberedReceipt(raw);
    if (!item || records.some(other => sameReadyToWorkRememberedKey(item.key, other.key))) return null;
    records.push(item);
  }
  const pendingLegacy: ProtectedWorkstationReceipt[] = [];
  for (const raw of record["pendingLegacy"] as unknown[]) {
    const item = parseRecord(raw);
    if (!item || pendingLegacy.some(other => sameReadyToWorkRememberedKey(readyToWorkRememberedKey(item), readyToWorkRememberedKey(other)))) return null;
    pendingLegacy.push(item);
  }
  return { version: 2, fenceId: record["fenceId"], legacyDigest: record["legacyDigest"], records, pendingLegacy };
}

function legacyDigest(bytes: Buffer | null): string | null { return bytes === null ? null : createHash("sha256").update(bytes).digest("hex"); }
