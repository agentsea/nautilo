import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { parseRelayLocalExecutionBinding, type RelayLocalExecutionOwnerV1 } from "@nautilo/relay";
import { ensurePrivateDirectory, publishPrivateFileAtomically, syncDirectory } from "@nautilo/config/private-filesystem";
import type { LocalExecutionSnapshot } from "./local-execution-host";

export interface LocalExecutionHistoryScope {
  readonly instanceId: string;
  readonly origin: string;
  readonly serverFingerprint: string;
  readonly humanUserId: string;
  readonly relayId: string;
  readonly pairingGeneration: string;
}
export interface LocalExecutionHistoryRecord {
  readonly version: 1;
  readonly scope: LocalExecutionHistoryScope;
  readonly owner: RelayLocalExecutionOwnerV1;
  readonly generation: string;
  readonly snapshot: LocalExecutionSnapshot;
}
export interface LocalExecutionHistoryStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}

const HEADER = Buffer.from("nautilo-local-execution-history-v1\0");
function sameScope(a: LocalExecutionHistoryScope, b: LocalExecutionHistoryScope): boolean {
  return a.instanceId === b.instanceId && a.origin === b.origin && a.serverFingerprint === b.serverFingerprint &&
    a.humanUserId === b.humanUserId && a.relayId === b.relayId && a.pairingGeneration === b.pairingGeneration;
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function cursor(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }

/** Archives contain settled receipts only, including explicitly uncertain cleanup. */
export function parseLocalExecutionHistoryRecord(value: unknown): LocalExecutionHistoryRecord | null {
  const record = object(value);
  const scope = object(record?.["scope"]);
  const snapshot = object(record?.["snapshot"]);
  const output = object(snapshot?.["output"]);
  if (!record || record["version"] !== 1 || !scope || !snapshot || !output ||
    typeof scope["instanceId"] !== "string" || ![scope["origin"], scope["serverFingerprint"], scope["humanUserId"], scope["relayId"], scope["pairingGeneration"]].every(v => typeof v === "string" && v.length > 0) ||
    typeof snapshot["executionId"] !== "string" || typeof record["generation"] !== "string" ||
    typeof snapshot["state"] !== "string" || !["completed", "cancelled", "failed", "unknown"].includes(snapshot["state"]) ||
    typeof snapshot["resources"] !== "string" || !["released", "release_failed"].includes(snapshot["resources"]) ||
    (snapshot["resources"] === "release_failed" && snapshot["state"] !== "unknown") ||
    typeof snapshot["tty"] !== "boolean" || snapshot["terminationScope"] !== "owned_process_group" ||
    !(snapshot["pid"] === null || (cursor(snapshot["pid"]) && snapshot["pid"] > 0)) ||
    !(snapshot["exitCode"] === null || (typeof snapshot["exitCode"] === "number" && Number.isSafeInteger(snapshot["exitCode"]))) ||
    !(snapshot["signal"] === null || typeof snapshot["signal"] === "string") ||
    !(snapshot["failureCode"] === null || typeof snapshot["failureCode"] === "string") || snapshot["expiresAt"] !== null ||
    typeof output["data"] !== "string" || !cursor(output["cursor"]) || !cursor(output["nextCursor"]) ||
    !cursor(output["availableFrom"]) || !cursor(output["produced"]) || output["cursor"] !== output["availableFrom"] ||
    output["nextCursor"] !== output["produced"] || output["cursor"] > output["nextCursor"] ||
    Buffer.byteLength(output["data"]) !== output["nextCursor"] - output["cursor"] ||
    output["gap"] !== (output["availableFrom"] > 0) || output["hasMore"] !== false) return null;
  const binding = parseRelayLocalExecutionBinding({ version: 1, generation: record["generation"],
    invocationId: "history", executionId: snapshot["executionId"], operation: "read", owner: record["owner"] });
  if (!binding || binding.owner.instanceId !== scope["instanceId"] || binding.owner.humanUserId !== scope["humanUserId"] || binding.owner.relayId !== scope["relayId"] ||
    binding.owner.pairingGeneration !== scope["pairingGeneration"]) return null;
  return record as unknown as LocalExecutionHistoryRecord;
}

/** Encrypted local history, never a source of execution or grant authority.
 * Final retained windows live until explicitly cleared or profile data removal.
 * Storage therefore grows with completed executions; no silent expiry/eviction.
 */
export class LocalExecutionHistoryStore {
  private pending: Promise<void> = Promise.resolve();
  private epoch = 0;
  constructor(private readonly options: { directory: string; storage: LocalExecutionHistoryStorage }) {}

  private protectedStorage(): void {
    if (!this.options.storage.isEncryptionAvailable() || this.options.storage.getSelectedStorageBackend?.() === "basic_text") {
      throw new Error("LOCAL_EXECUTION_HISTORY_PROTECTION_UNAVAILABLE");
    }
  }
  private file(generation: string, executionId: string): string {
    return path.join(this.options.directory, `${createHash("sha256").update(JSON.stringify([generation, executionId])).digest("hex")}.sealed`);
  }
  private enqueue(operation: () => Promise<void>): Promise<void> {
    const task = this.pending.then(operation);
    this.pending = task.catch(() => {});
    return task;
  }
  save(record: LocalExecutionHistoryRecord): Promise<void> {
    const captured = structuredClone(record);
    const epoch = this.epoch;
    return this.enqueue(async () => {
      if (epoch !== this.epoch) return;
      this.protectedStorage();
      if (!parseLocalExecutionHistoryRecord(captured)) throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
      try {
        await ensurePrivateDirectory(this.options.directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOTDIR") throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
        throw error;
      }
      const existing = await this.readRecord(captured.generation, captured.snapshot.executionId);
      if (existing !== null) {
        if (JSON.stringify(existing) !== JSON.stringify(captured)) throw new Error("LOCAL_EXECUTION_HISTORY_CONFLICT");
        return;
      }
      const target = this.file(captured.generation, captured.snapshot.executionId);
      const bytes = Buffer.concat([HEADER, this.options.storage.encryptString(JSON.stringify(captured))]);
      // A newer epoch must not publish; the aborted temporary file is removed.
      let superseded = false;
      await publishPrivateFileAtomically(target, bytes, {
        beforePublish: () => {
          superseded = epoch !== this.epoch;
          if (superseded) throw new Error("LOCAL_EXECUTION_HISTORY_SUPERSEDED");
        },
      }).catch((error: unknown) => { if (!superseded) throw error; });
      if (superseded) return;
      await syncDirectory(this.options.directory);
    });
  }
  async read(scope: LocalExecutionHistoryScope, generation: string, executionId: string): Promise<LocalExecutionHistoryRecord | null> {
    const epoch = this.epoch;
    await this.pending;
    this.protectedStorage();
    const record = await this.readRecord(generation, executionId);
    return epoch === this.epoch && record !== null && sameScope(record.scope, scope) ? record : null;
  }
  private async readRecord(generation: string, executionId: string): Promise<LocalExecutionHistoryRecord | null> {
    try {
      if (!(await fs.lstat(this.options.directory)).isDirectory()) throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
      const filePath = this.file(generation, executionId);
      const entry = await fs.lstat(filePath, { bigint: true });
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
      const file = await fs.open(filePath, constants.O_RDONLY | (process.platform === "win32" ? 0 : constants.O_NOFOLLOW));
      let bytes: Buffer;
      try {
        const opened = await file.stat({ bigint: true });
        const current = await fs.lstat(filePath, { bigint: true });
        if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino || opened.size !== entry.size ||
          !current.isFile() || current.isSymbolicLink() || current.dev !== opened.dev || current.ino !== opened.ino) {
          throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
        }
        bytes = await file.readFile();
      } finally { await file.close(); }
      if (!bytes.subarray(0, HEADER.length).equals(HEADER)) throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
      const record = parseLocalExecutionHistoryRecord(JSON.parse(this.options.storage.decryptString(bytes.subarray(HEADER.length))));
      if (!record || record.generation !== generation || record.snapshot.executionId !== executionId) throw new Error("LOCAL_EXECUTION_HISTORY_INVALID");
      return record;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error("LOCAL_EXECUTION_HISTORY_UNAVAILABLE");
    }
  }
  clear(): Promise<void> {
    this.epoch += 1;
    return this.enqueue(() => fs.rm(this.options.directory, { recursive: true, force: true }));
  }
}
