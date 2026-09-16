/**
 * Injectable atomic persistence primitive for Desktop Filesystem Grants.
 *
 * This layer deliberately handles bytes only: schema validation belongs in
 * store.ts so invalid or future-format bytes are never replaced accidentally.
 */

import { randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;

export interface DesktopFilesystemGrantFileSystem {
  mkdir(path: string, options: { recursive: true; mode: number }): Promise<unknown>;
  readFile(path: string, encoding: "utf8"): Promise<string>;
  writeFile(path: string, data: string, options: { mode: number }): Promise<void>;
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

export function createDesktopFilesystemGrantStorage(
  filePath: string,
  legacyFilePath: string | undefined,
  dependencies: DesktopFilesystemGrantStorageDependencies = {},
): DesktopFilesystemGrantStorage {
  const fs = dependencies.fs ?? nodeFs;
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
      try {
        await fs.writeFile(temporaryPath, bytes, { mode: FILE_MODE });
        await fs.chmod(temporaryPath, FILE_MODE);
        await fs.rename(temporaryPath, filePath);
        await fs.chmod(filePath, FILE_MODE);
      } catch (error) {
        try {
          await fs.rm(temporaryPath, { force: true });
        } catch {
          // Original bytes remain at filePath; best-effort temporary cleanup only.
        }
        throw error;
      }
    },
  };
}
