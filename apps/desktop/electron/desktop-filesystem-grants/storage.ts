/**
 * Injectable atomic persistence primitive for Desktop Filesystem Grants.
 *
 * This layer deliberately handles bytes only: schema validation belongs in
 * store.ts so invalid or future-format bytes are never replaced accidentally.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import { secureFilesystemPath, writePrivateFileExclusive } from "@nautilo/config/private-filesystem";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface DesktopFilesystemGrantFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number; flag: "wx" }): Promise<void>;
  rename(oldPath: string, newPath: string): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  rm(path: string, options: { force: true }): Promise<void>;
}

export interface DesktopFilesystemGrantStorageDependencies {
  fs?: DesktopFilesystemGrantFileSystem;
  dirname?: (filePath: string) => string;
  basename?: (filePath: string) => string;
  randomHex?: () => string;
}

export interface DesktopFilesystemGrantStorage {
  read(): Promise<string | null>;
  /** Reads the historical filename only during the one-time store migration. */
  readLegacy?(): Promise<string | null>;
  /** Removes the historical filename only after the renamed store is durable. */
  removeLegacy?(): Promise<void>;
  writeAtomic(bytes: string): Promise<void>;
}

function isNotFound(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";
}

const nativeFileSystem: DesktopFilesystemGrantFileSystem = {
  ...nodeFs,
  chmod: (path) => secureFilesystemPath(nodePath.resolve(path)),
  writeFile: (path, data) => writePrivateFileExclusive(nodePath.resolve(path), new TextEncoder().encode(data)),
};

export function createDesktopFilesystemGrantStorage(
  filePath: string,
  legacyFilePath: string | undefined,
  dependencies: DesktopFilesystemGrantStorageDependencies = {},
): DesktopFilesystemGrantStorage {
  const fs = dependencies.fs ?? nativeFileSystem;
  const dirname = dependencies.dirname ?? ((targetPath: string) => nodePath.dirname(targetPath));
  const basename = dependencies.basename ?? ((targetPath: string) => nodePath.basename(targetPath));
  const randomHex = dependencies.randomHex ?? (() => randomBytes(12).toString("hex"));
  const parentDir = dirname(filePath);

  return {
    async read() {
      try {
        return await fs.readFile(filePath, "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async readLegacy() {
      if (legacyFilePath === undefined) return null;
      try {
        return await fs.readFile(legacyFilePath, "utf8");
      } catch (error) {
        if (isNotFound(error)) return null;
        throw error;
      }
    },

    async removeLegacy() {
      if (legacyFilePath === undefined) return;
      await fs.rm(legacyFilePath, { force: true });
    },

    async writeAtomic(bytes) {
      await fs.mkdir(parentDir, { recursive: true, mode: DIRECTORY_MODE });
      await fs.chmod(parentDir, DIRECTORY_MODE);

      const temporaryPath = nodePath.join(
        parentDir,
        `.${basename(filePath)}.${randomHex()}.tmp`,
      );
      // The exclusive private write already fixes the file's mode or ACL, and
      // rename carries it to the published name; no later chmod is needed.
      let created = false;
      try {
        await fs.writeFile(temporaryPath, bytes, { mode: FILE_MODE, flag: "wx" });
        created = true;
        await fs.rename(temporaryPath, filePath);
      } catch (error) {
        try {
          if (created) await fs.rm(temporaryPath, { force: true });
        } catch {
          // Original bytes remain at filePath; best-effort temporary cleanup only.
        }
        throw error;
      }
    },
  };
}
