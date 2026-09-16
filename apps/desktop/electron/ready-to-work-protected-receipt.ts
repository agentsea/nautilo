/** OS-protected Electron-main store for D557's opaque Workstation receipt. */

import { randomUUID } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  hasReadyToWorkExactBinding,
  isReadyToWorkOpaqueId,
  parseReadyToWorkAuthorityBinding,
  type ReadyToWorkBinding,
} from "./ready-to-work-contract";

const VERSION = 1 as const;
const HEADER = Buffer.from("nautilo-ready-workstation-receipt-v1\0", "utf8");
const MAX_RECEIPT_LENGTH = 4096;

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
  mkdirSync,
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
    safeStorage: ReadyToWorkSafeStorage;
    fs?: ReceiptFs;
    mintTemporaryId?: () => string;
  }>) {}

  readFor(binding: ReadyToWorkBinding): ProtectedReceiptReadResult {
    if (!isReadyToWorkStorageProtected(this.options.safeStorage)) return { ok: false, code: "unavailable" };
    const fsPort = this.options.fs ?? productionFs;
    let bytes: Buffer;
    try {
      bytes = fsPort.readFileSync(this.options.filePath);
    } catch (error) {
      return { ok: false, code: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "invalid" };
    }
    if (bytes.length <= HEADER.length || !bytes.subarray(0, HEADER.length).equals(HEADER)) {
      return { ok: false, code: "invalid" };
    }
    let parsed: ProtectedWorkstationReceipt | null;
    try {
      parsed = parseRecord(JSON.parse(this.options.safeStorage.decryptString(bytes.subarray(HEADER.length))));
    } catch {
      parsed = null;
    }
    if (!parsed) return { ok: false, code: "invalid" };
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
    const fsPort = this.options.fs ?? productionFs;
    const temporaryId = (this.options.mintTemporaryId ?? randomUUID)();
    if (!temporaryId || temporaryId.includes("/") || temporaryId.includes("\\")) return false;
    const temporaryPath = `${this.options.filePath}.${temporaryId}.tmp`;
    let descriptor: number | null = null;
    try {
      const encrypted = this.options.safeStorage.encryptString(JSON.stringify(record));
      fsPort.mkdirSync(dirname(this.options.filePath), { recursive: true, mode: 0o700 });
      descriptor = fsPort.openSync(temporaryPath, "wx", 0o600);
      fsPort.writeFileSync(descriptor, Buffer.concat([HEADER, encrypted]));
      fsPort.closeSync(descriptor);
      descriptor = null;
      fsPort.renameSync(temporaryPath, this.options.filePath);
      return true;
    } catch {
      if (descriptor !== null) try { fsPort.closeSync(descriptor); } catch { /* best effort */ }
      try { fsPort.unlinkSync(temporaryPath); } catch { /* best effort */ }
      return false;
    }
  }

  clear(): boolean {
    try {
      (this.options.fs ?? productionFs).unlinkSync(this.options.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}
