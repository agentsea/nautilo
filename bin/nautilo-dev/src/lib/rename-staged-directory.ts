import { rename } from "node:fs/promises";

const WINDOWS_RENAME_ATTEMPTS = 6;
const WINDOWS_RENAME_INITIAL_WAIT_MS = 20;

/**
 * Publishes a freshly populated staging directory. Windows refuses a directory
 * rename while a just-written file inside it is still briefly open, for
 * example by a malware scanner, so lock errors there get a bounded retry.
 */
export async function renameStagedDirectory(from: string, to: string): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === "EPERM" || code === "EACCES" || code === "EBUSY";
      if (process.platform !== "win32" || !transient || attempt >= WINDOWS_RENAME_ATTEMPTS) throw error;
      await new Promise((resolve) => setTimeout(resolve, WINDOWS_RENAME_INITIAL_WAIT_MS * 2 ** (attempt - 1)));
    }
  }
}
