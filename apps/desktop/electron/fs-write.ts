import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";

/**
 * Max UTF-8 payload for desktop `fs:writeFile`. Raised to 50 MB (the officecli
 * `.docx` ceiling) so current-folder office/Writer documents — which embed
 * inline base64 images — save through the desktop relay, matching the
 * workspace-artifact save cap (`USER_SAVE_TEXT_LIMIT_BYTES`) and the Writer
 * container cap (`MAX_DOCUMENT_BYTES`). (Was 200 KB, M180.)
 */
export const FS_WRITE_FILE_MAX_BYTES = 50 * 1024 * 1024;

export type FsWriteFileResult =
  | { ok: true; sha256: string; size: number }
  | {
      ok: false;
      code: "forbidden" | "conflict" | "too_large" | "error";
      currentSha256?: string;
      message?: string;
    };

export type FsWriteDecision =
  | { ok: true }
  | { ok: false; code: "forbidden" | "conflict" | "too_large" };

export function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Pure pre-write gate for jailed desktop fs writes. Forbidden wins before
 * size/conflict; `baseSha256: null` skips the sha guard (force-write).
 */
export function decideFsWrite(input: {
  targetPath: string;
  allowed: boolean;
  baseSha256: string | null;
  currentSha256: string | null;
  contentBytes: number;
}): FsWriteDecision {
  if (!input.allowed) {
    return { ok: false, code: "forbidden" };
  }
  if (input.contentBytes > FS_WRITE_FILE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  if (
    input.baseSha256 !== null &&
    input.baseSha256 !== input.currentSha256
  ) {
    return { ok: false, code: "conflict" };
  }
  return { ok: true };
}

export type AtomicFsWriteDeps = {
  writeFile: (filePath: string, data: Buffer) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  unlink: (filePath: string) => Promise<void>;
};

function buildAtomicWriteTempPath(targetPath: string): string {
  const suffix = randomBytes(8).toString("hex");
  return path.join(
    path.dirname(targetPath),
    `.${path.basename(targetPath)}.${suffix}.tmp`,
  );
}

/** Write bytes atomically via same-directory temp file + rename. */
export async function writeFileAtomically(
  targetPath: string,
  bytes: Buffer,
  deps: AtomicFsWriteDeps,
): Promise<void> {
  const tmpPath = buildAtomicWriteTempPath(targetPath);
  try {
    await deps.writeFile(tmpPath, bytes);
    await deps.rename(tmpPath, targetPath);
  } catch (err) {
    try {
      await deps.unlink(tmpPath);
    } catch {
      /* tmp may not exist */
    }
    throw err;
  }
}
