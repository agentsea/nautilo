/** Electron-main durable store for the non-secret Ready-to-work desired state. */

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
  createReadyToWorkDesiredState,
  isReadyToWorkOpaqueId,
  matchesReadyToWorkRemoval,
  parseReadyToWorkMigrationFence,
  parseReadyToWorkRemovalScope,
  parseReadyToWorkRememberedEnvelope,
  readyToWorkRememberedKey,
  sameReadyToWorkRememberedKey,
  type ReadyToWorkRememberedEnvelope,
  type ReadyToWorkRememberedKey,
  type ReadyToWorkRemovalScope,
  parseReadyToWorkDesiredState,
  READY_TO_WORK_DESIRED_STATE_VERSION,
  type ReadyToWorkBinding,
  type ReadyToWorkDesiredState,
} from "./ready-to-work-contract";

export type ReadyToWorkStoreFs = Readonly<{
  mkdirSync(directoryPath: string, options: { recursive: true; mode: number }): void;
  openSync(filePath: string, flags: "wx", mode: number): number;
  writeFileSync(fileDescriptor: number, data: string, options: { encoding: "utf-8" }): void;
  closeSync(fileDescriptor: number): void;
  renameSync(from: string, to: string): void;
  unlinkSync(filePath: string): void;
  readFileSync(filePath: string, options: "utf-8"): string;
}>;

const productionFs: ReadyToWorkStoreFs = {
  mkdirSync,
  openSync,
  writeFileSync,
  closeSync,
  renameSync,
  unlinkSync,
  readFileSync,
};

export type ReadyToWorkPersistenceStatus = "ready" | "missing" | "unsupported" | "invalid" | "unavailable";
export class ReadyToWorkPersistenceError extends Error {
  constructor(readonly reason: Exclude<ReadyToWorkPersistenceStatus, "ready" | "missing"> | "changed") {
    super(`READY_TO_WORK_PERSISTENCE_${reason.toUpperCase()}`);
    this.name = "ReadyToWorkPersistenceError";
  }
}

export type ReadyToWorkInspection =
  | Readonly<{ status: "ready"; desired: ReadyToWorkDesiredState }>
  | Readonly<{ status: Exclude<ReadyToWorkPersistenceStatus, "ready"> }>;

function readState(filePath: string, fs: ReadyToWorkStoreFs): { bytes: string | null; inspection: ReadyToWorkInspection } {
  let bytes: string;
  try { bytes = fs.readFileSync(filePath, "utf-8"); }
  catch (error) {
    return { bytes: null, inspection: { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable" } };
  }
  try {
    const value: unknown = JSON.parse(bytes);
    if (typeof value === "object" && value !== null && !Array.isArray(value) &&
      "version" in value && typeof value.version === "number" && value.version !== READY_TO_WORK_DESIRED_STATE_VERSION) {
      return { bytes, inspection: { status: "unsupported" } };
    }
    const desired = parseReadyToWorkDesiredState(value);
    return { bytes, inspection: desired ? { status: "ready", desired } : { status: "invalid" } };
  } catch { return { bytes, inspection: { status: "invalid" } }; }
}

function writableState(filePath: string, fs: ReadyToWorkStoreFs): ReturnType<typeof readState> {
  const state = readState(filePath, fs);
  if (state.inspection.status !== "ready" && state.inspection.status !== "missing") {
    throw new ReadyToWorkPersistenceError(state.inspection.status);
  }
  return state;
}

function verifyUnchanged(filePath: string, fs: ReadyToWorkStoreFs, bytes: string | null): void {
  if (writableState(filePath, fs).bytes !== bytes) throw new ReadyToWorkPersistenceError("changed");
}

export function writeReadyToWorkDesiredStateAtomically(input: Readonly<{
  filePath: string;
  desired: ReadyToWorkDesiredState;
  temporaryId: string;
  fs: ReadyToWorkStoreFs;
}>): void {
  const desired = parseReadyToWorkDesiredState(input.desired);
  if (!desired) throw new Error("Ready-to-work desired state is invalid");
  const previous = writableState(input.filePath, input.fs);
  if (!input.temporaryId || input.temporaryId.includes("/") || input.temporaryId.includes("\\")) {
    throw new Error("Ready-to-work temporary id must be a non-empty path fragment");
  }
  const temporaryPath = `${input.filePath}.${input.temporaryId}.tmp`;
  let descriptor: number | null = null;
  let ownsTemporaryPath = false;
  try {
    input.fs.mkdirSync(dirname(input.filePath), { recursive: true, mode: 0o700 });
    descriptor = input.fs.openSync(temporaryPath, "wx", 0o600);
    ownsTemporaryPath = true;
    input.fs.writeFileSync(descriptor, JSON.stringify(desired, null, 2), { encoding: "utf-8" });
    input.fs.closeSync(descriptor);
    descriptor = null;
    // The main-process owner is synchronous and serialized. Detect observed
    // external changes too; this is not cross-version writer coordination.
    verifyUnchanged(input.filePath, input.fs, previous.bytes);
    input.fs.renameSync(temporaryPath, input.filePath);
  } catch (error) {
    if (descriptor !== null) {
      try { input.fs.closeSync(descriptor); } catch { /* best-effort close */ }
    }
    if (ownsTemporaryPath) {
      try { input.fs.unlinkSync(temporaryPath); } catch { /* best-effort cleanup */ }
    }
    throw error;
  }
}

export class ReadyToWorkStore {
  constructor(private readonly options: Readonly<{
    filePath: string;
    /** Explicit opt-in path; legacy APIs keep their current behavior. */
    rememberedFilePath?: string;
    mintFenceId?: () => string;
    fs?: ReadyToWorkStoreFs;
    mintTemporaryId?: () => string;
  }>) {}

  inspect(): ReadyToWorkInspection {
    return readState(this.options.filePath, this.options.fs ?? productionFs).inspection;
  }

  load(): ReadyToWorkDesiredState | null {
    const inspection = this.inspect();
    return inspection.status === "ready" ? inspection.desired : null;
  }

  loadFor(binding: ReadyToWorkBinding): ReadyToWorkDesiredState | null {
    const desired = this.load();
    return desired && hasReadyToWorkExactBinding(desired, binding) ? desired : null;
  }

  save(desired: ReadyToWorkDesiredState): void {
    writeReadyToWorkDesiredStateAtomically({
      filePath: this.options.filePath,
      desired,
      temporaryId: (this.options.mintTemporaryId ?? randomUUID)(),
      fs: this.options.fs ?? productionFs,
    });
  }

  /** Never deletes a different Human's or server's desired state. */
  clearFor(binding: ReadyToWorkBinding): boolean {
    const fs = this.options.fs ?? productionFs;
    const previous = writableState(this.options.filePath, fs);
    if (previous.inspection.status !== "ready" || !hasReadyToWorkExactBinding(previous.inspection.desired, binding)) return false;
    return this.remove(previous.bytes);
  }

  /** Removes understood intent; callers must still fence live work on refusal. */
  clear(): boolean {
    const previous = writableState(this.options.filePath, this.options.fs ?? productionFs);
    if (previous.inspection.status === "missing") return false;
    return this.remove(previous.bytes);
  }

  private rememberedPath(): string {
    const file = this.options.rememberedFilePath;
    if (!file || file === this.options.filePath) throw new Error("Remembered Ready requires a separate versioned path");
    return file;
  }

  private rememberedState() {
    const fs = this.options.fs ?? productionFs;
    const data = readRememberedJson(this.rememberedPath(), fs);
    if (data.value === null && data.bytes === null) return { bytes: null, envelope: null };
    const envelope = parseReadyToWorkRememberedEnvelope(data.value);
    if (!envelope) throw new ReadyToWorkPersistenceError(unknownVersion(data.value, 2) ? "unsupported" : "invalid");
    return { bytes: data.bytes, envelope };
  }

  private legacyState() {
    const data = readRememberedJson(this.options.filePath, this.options.fs ?? productionFs);
    const fenceId = parseReadyToWorkMigrationFence(data.value);
    const desired = parseReadyToWorkDesiredState(data.value);
    if (data.bytes !== null && !fenceId && !desired) throw new ReadyToWorkPersistenceError(unknownVersion(data.value, 1) ? "unsupported" : "invalid");
    return { ...data, fenceId, desired };
  }

  /** Unmatched choices remain visible, but confirmation_required never restores. */
  inspectRemembered(binding: ReadyToWorkBinding): ReadyToWorkRememberedInspection {
    try {
      const { envelope } = this.rememberedState();
      const legacy = this.legacyState();
      if (!envelope) return { status: "missing" };
      const entry = envelope.entries.find(value => sameReadyToWorkRememberedKey(value.key, readyToWorkRememberedKey(binding)));
      const desired = entry ? createReadyToWorkDesiredState(binding, entry.components) : null;
      return { status: envelope.fenceId === legacy.fenceId ? "ready" : "confirmation_required", fenceId: envelope.fenceId, desired };
    } catch (error) {
      return { status: error instanceof ReadyToWorkPersistenceError ? error.reason : "unavailable" };
    }
  }

  /** Pending migration data is not an automatic-restoration source. */
  pendingLegacyFor(binding: ReadyToWorkBinding): ReadyToWorkDesiredState | null {
    const { envelope } = this.rememberedState();
    const legacy = this.legacyState();
    if (envelope && (envelope.fenceId !== legacy.fenceId || envelope.migrationFenceId !== envelope.fenceId)) return null;
    const candidates = [...(envelope?.pendingLegacy ?? []), ...(legacy.desired ? [legacy.desired] : [])];
    return candidates.reverse().find(value => sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), readyToWorkRememberedKey(binding))) ?? null;
  }

  /** Captures a same-process transaction plan. Proof is written before commit.
   * A changed/deleted legacy sentinel rotates the generation; other keys' old
   * proofs are never rebased onto it. This is not cross-process CAS. */
  prepareRememberedWrite(): ReadyToWorkRememberedWrite {
    const previous = this.rememberedState();
    const legacy = this.legacyState();
    const fs = this.options.fs ?? productionFs;
    const fenceId = previous.envelope && previous.envelope.fenceId === legacy.fenceId
      ? previous.envelope.fenceId : (this.options.mintFenceId ?? randomUUID)();
    if (!isReadyToWorkOpaqueId(fenceId) || (previous.envelope && previous.envelope.fenceId !== legacy.fenceId && (fenceId === previous.envelope.fenceId || fenceId === previous.envelope.migrationFenceId))) throw new ReadyToWorkPersistenceError("changed");
    let used = false;
    const isCurrent = () => !used && this.rememberedState().bytes === previous.bytes && this.legacyState().bytes === legacy.bytes;
    return { fenceId, retainedProofKeys: (previous.envelope?.entries ?? []).filter(entry => entry.components.workstation).map(entry => entry.key), isCurrent, commit: (change) => {
      if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
      let entries = [...(previous.envelope?.entries ?? [])];
      let pendingLegacy = [...(previous.envelope?.pendingLegacy ?? [])];
      if (legacy.desired) {
        const key = readyToWorkRememberedKey(legacy.desired);
        pendingLegacy = pendingLegacy.filter(value => !sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), key));
        pendingLegacy.push(legacy.desired);
      }
      if (change.kind === "save") {
        const desired = parseReadyToWorkDesiredState(change.desired);
        if (!desired) throw new Error("Invalid remembered Ready selection");
        const key = readyToWorkRememberedKey(desired);
        entries = entries.filter(value => !sameReadyToWorkRememberedKey(value.key, key));
        entries.push({ key, components: desired.components });
        pendingLegacy = pendingLegacy.filter(value => !sameReadyToWorkRememberedKey(readyToWorkRememberedKey(value), key));
      } else {
        if (change.kind !== "remove" || !parseReadyToWorkRemovalScope(change.scope)) throw new ReadyToWorkPersistenceError("invalid");
        entries = entries.filter(value => !matchesReadyToWorkRemoval(value.key, change.scope));
        pendingLegacy = pendingLegacy.filter(value => !matchesReadyToWorkRemoval(readyToWorkRememberedKey(value), change.scope));
      }
      const envelope: ReadyToWorkRememberedEnvelope = { version: 2, fenceId,
        migrationFenceId: previous.envelope?.migrationFenceId ?? fenceId, entries, pendingLegacy };
      writeRememberedJson(this.rememberedPath(), envelope, fs, this.options.mintTemporaryId ?? randomUUID, () => {
        if (!isCurrent()) throw new ReadyToWorkPersistenceError("changed");
      });
      used = true;
      // If the second replacement fails, the envelope's new generation has no
      // matching sentinel, so no proof can restore until explicit enrollment.
      if (legacy.fenceId !== fenceId) writeRememberedJson(this.options.filePath,
        { version: 2, kind: "ready_to_work_migrated", fenceId }, fs, this.options.mintTemporaryId ?? randomUUID, () => {
          if (this.legacyState().bytes !== legacy.bytes || this.rememberedState().bytes !== JSON.stringify(envelope, null, 2)) throw new ReadyToWorkPersistenceError("changed");
        });
    } };
  }

  private remove(bytes: string | null): boolean {
    const fs = this.options.fs ?? productionFs;
    verifyUnchanged(this.options.filePath, fs, bytes);
    try {
      fs.unlinkSync(this.options.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
}


export type ReadyToWorkRememberedInspection =
  | Readonly<{ status: "ready" | "confirmation_required"; fenceId: string; desired: ReadyToWorkDesiredState | null }>
  | Readonly<{ status: Exclude<ReadyToWorkPersistenceStatus, "ready"> | "changed" }>;
export interface ReadyToWorkRememberedWrite {
  readonly fenceId: string;
  readonly retainedProofKeys: readonly ReadyToWorkRememberedKey[];
  isCurrent(): boolean;
  commit(change: Readonly<{ kind: "save"; desired: ReadyToWorkDesiredState }> | Readonly<{ kind: "remove"; scope: ReadyToWorkRemovalScope }>): void;
}
function unknownVersion(value: unknown, version: number): boolean {
  return typeof value === "object" && value !== null && "version" in value && typeof value.version === "number" && value.version !== version;
}
function readRememberedJson(file: string, fs: ReadyToWorkStoreFs): { bytes: string | null; value: unknown } {
  let bytes: string;
  try { bytes = fs.readFileSync(file, "utf-8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { bytes: null, value: null }; throw new ReadyToWorkPersistenceError("unavailable"); }
  try { return { bytes, value: JSON.parse(bytes) as unknown }; }
  catch { throw new ReadyToWorkPersistenceError("invalid"); }
}
function writeRememberedJson(file: string, value: unknown, fs: ReadyToWorkStoreFs, mint: () => string, verify: () => void): void {
  const id = mint();
  if (!id || id.includes("/") || id.includes("\\")) throw new Error("Invalid Ready temporary id");
  const temporary = `${file}.${id}.tmp`; let fd: number | null = null; let owned = false;
  try {
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    fd = fs.openSync(temporary, "wx", 0o600); owned = true;
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), { encoding: "utf-8" }); fs.closeSync(fd); fd = null;
    verify(); fs.renameSync(temporary, file); owned = false;
  } finally {
    if (fd !== null) try { fs.closeSync(fd); } catch { /* best effort */ }
    if (owned) try { fs.unlinkSync(temporary); } catch { /* owned temporary only */ }
  }
}
