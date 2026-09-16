import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FileHandle } from "node:fs/promises";

export type CurrentFolderSelection = Readonly<{ path: string; revision: number }>;

export interface CurrentFolderClaudeLease {
  readonly workingDirectory: string;
  readonly signal: AbortSignal;
  validate(): Promise<boolean>;
  close(): Promise<void>;
}

export interface CurrentFolderClaudeLeaseProvider {
  acquire(): Promise<CurrentFolderClaudeLease | null>;
}

export function hasCurrentFolderSelection(getCurrentFolder: () => CurrentFolderSelection | null): boolean {
  return captureSelection(getCurrentFolder) !== null;
}

type Filesystem = Readonly<{
  realpath(candidate: string): Promise<string>;
  open(candidate: string, flags: number): Promise<FileHandle>;
}>;

/**
 * Captures only the Electron-main Current Folder selection. The canonical
 * directory and its opened descriptor remain process-local; neither is a
 * relay, Task, or durable authority.
 */
export function createCurrentFolderClaudeLeaseProvider(input: Readonly<{
  currentFolder: () => CurrentFolderSelection | null;
  filesystem?: Filesystem;
}>): CurrentFolderClaudeLeaseProvider {
  const currentFolder = input.currentFolder;
  const filesystem = input.filesystem ?? fs;
  return Object.freeze({
    async acquire(): Promise<CurrentFolderClaudeLease | null> {
      const selection = captureSelection(currentFolder);
      if (selection === null) return null;
      let workingDirectory: string;
      let directory: FileHandle;
      try {
        workingDirectory = await filesystem.realpath(selection.path);
        if (!validPath(workingDirectory)) return null;
        directory = await filesystem.open(
          workingDirectory,
          fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
        );
      } catch {
        return null;
      }
      let identity: Identity | null;
      try {
        identity = identityOf(await directory.stat());
      } catch {
        await closeQuietly(directory);
        return null;
      }
      if (identity === null) {
        await closeQuietly(directory);
        return null;
      }
      const capturedIdentity = identity;
      const controller = new AbortController();
      let closed = false;
      const close = async (): Promise<void> => {
        if (closed) return;
        closed = true;
        controller.abort();
        await closeQuietly(directory);
      };
      const validate = async (): Promise<boolean> => {
        if (closed || controller.signal.aborted) return false;
        const current = captureSelection(currentFolder);
        if (current === null || current.path !== selection.path || current.revision !== selection.revision) return false;
        let canonical: string;
        let reopened: FileHandle | null = null;
        try {
          canonical = await filesystem.realpath(current.path);
          if (canonical !== workingDirectory) return false;
          reopened = await filesystem.open(
            canonical,
            fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
          );
        } catch {
          return false;
        }
        try {
          const currentIdentity = identityOf(await directory.stat());
          const reopenedIdentity = identityOf(await reopened.stat());
          const final = captureSelection(currentFolder);
          return currentIdentity !== null && reopenedIdentity !== null &&
            final !== null && final.path === selection.path && final.revision === selection.revision &&
            sameIdentity(capturedIdentity, currentIdentity) && sameIdentity(capturedIdentity, reopenedIdentity);
        } catch {
          return false;
        } finally {
          if (reopened !== null) await closeQuietly(reopened);
        }
      };
      return Object.freeze({ workingDirectory, signal: controller.signal, validate, close });
    },
  });
}

type Identity = Readonly<{ dev: number; ino: number }>;

function captureSelection(getCurrentFolder: () => CurrentFolderSelection | null): CurrentFolderSelection | null {
  try {
    const value = getCurrentFolder();
    if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) return null;
    const descriptorPath = Object.getOwnPropertyDescriptor(value, "path");
    const descriptorRevision = Object.getOwnPropertyDescriptor(value, "revision");
    if (!descriptorPath || !("value" in descriptorPath) || !descriptorRevision || !("value" in descriptorRevision)) return null;
    const candidate: unknown = descriptorPath.value as unknown;
    const revision: unknown = descriptorRevision.value as unknown;
    return validPath(candidate) && typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0
      ? Object.freeze({ path: candidate, revision })
      : null;
  } catch {
    return null;
  }
}

function validPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && path.isAbsolute(value) && !containsControl(value);
}

function identityOf(stat: Awaited<ReturnType<FileHandle["stat"]>>): Identity | null {
  return stat.isDirectory() && Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
    Number.isSafeInteger(stat.ino) && stat.ino >= 0
    ? Object.freeze({ dev: Number(stat.dev), ino: Number(stat.ino) })
    : null;
}

function sameIdentity(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

async function closeQuietly(handle: FileHandle): Promise<void> {
  try { await handle.close(); } catch { /* best-effort local resource cleanup */ }
}

function containsControl(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint !== undefined && (codePoint < 32 || codePoint === 127);
  });
}
