/** Electron-main durable store for the non-secret D557 desired-state record. */

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
  parseReadyToWorkDesiredState,
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

export function writeReadyToWorkDesiredStateAtomically(input: Readonly<{
  filePath: string;
  desired: ReadyToWorkDesiredState;
  temporaryId: string;
  fs: ReadyToWorkStoreFs;
}>): void {
  const desired = parseReadyToWorkDesiredState(input.desired);
  if (!desired) throw new Error("Ready-to-work desired state is invalid");
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
    fs?: ReadyToWorkStoreFs;
    mintTemporaryId?: () => string;
  }>) {}

  load(): ReadyToWorkDesiredState | null {
    try {
      return parseReadyToWorkDesiredState(JSON.parse((this.options.fs ?? productionFs)
        .readFileSync(this.options.filePath, "utf-8")));
    } catch {
      return null;
    }
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
    const desired = this.load();
    if (desired && !hasReadyToWorkExactBinding(desired, binding)) return false;
    if (!desired) return false;
    try {
      (this.options.fs ?? productionFs).unlinkSync(this.options.filePath);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }

  /** Authority-reducing Off removes the sole local intent without identity/network lookup. */
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
