/**
 * Narrow, Electron-free registration for the privileged structural fs IPCs.
 * `main.ts` supplies the authoritative sender and canonical-root policy.
 */
import { randomBytes } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import {
  decideFsWrite,
  sha256Hex,
  type FsWriteFileResult,
} from "./fs-write.ts";
import { resolveMissingTargetFromExistingAncestor } from "./local-file-history/file-adapter.ts";

export type FsRenameResult =
  | { ok: true }
  | { ok: false; code: "exists" | "forbidden" | "error"; message?: string };

export type FsTrashResult =
  | { ok: true }
  | { ok: false; code: "forbidden" | "error"; message?: string };

type FsStructuralIpc = {
  handle<Event>(
    channel: string,
    listener: (event: Event, args: unknown) => unknown,
  ): void;
};

type FsStructuralDeps<Event> = {
  ipcMain: FsStructuralIpc;
  assertSender: (event: Event) => void;
  assertPathInAllowedRoot: (targetPath: string) => void;
  fs: {
    readFile: (filePath: string) => Promise<Buffer>;
    writeFile: (filePath: string, data: Buffer) => Promise<void>;
    rename: (from: string, to: string) => Promise<void>;
    unlink: (filePath: string) => Promise<void>;
  };
  shell: { trashItem: (targetPath: string) => Promise<void> };
  /** Main-process canonical-parent + exclusive create authority. */
  createFileExclusive: (targetPath: string, bytes: Buffer) => Promise<void>;
  /**
   * Existing-file editor updates only. This is intentionally absent for the
   * explicit missing-file compatibility-create branch below.
   */
  editorSave?: {
    saveExistingFile(input: {
      path: string;
      content: string;
      baseSha256: string | null;
      correlation: {
        checkpoint?: unknown;
        requestId?: unknown;
        clientMutationId?: unknown;
        anchoredPatch?: unknown;
        baseVersion?: unknown;
      };
    }): Promise<FsWriteFileResult>;
  };
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isErrno(error: unknown, ...codes: string[]): boolean {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? "");
}

type ExclusivePublishDeps = {
  link: (existingPath: string, newPath: string) => Promise<void>;
  open: (filePath: string, flags: string, mode: number) => Promise<fsp.FileHandle>;
  lstat: (filePath: string) => Promise<{ dev: number; ino: number }>;
  rm: (filePath: string, options: { force: boolean }) => Promise<void>;
};

const exclusivePublishDeps: ExclusivePublishDeps = {
  link: (existingPath, newPath) => fsp.link(existingPath, newPath),
  open: (filePath, flags, mode) => fsp.open(filePath, flags, mode),
  lstat: (filePath) => fsp.lstat(filePath),
  rm: (filePath, options) => fsp.rm(filePath, options),
};

/**
 * Publish a staged create without replacing an existing target. Some mounted
 * folders (notably SMB/FUSE providers) reject hard links with ENOTSUP. Their
 * safe fallback is an exclusive `wx` create: it preserves the no-overwrite
 * contract, fsyncs before success, and only removes a failed write while the
 * directory entry still names the inode opened by this call.
 */
export async function publishCompatibilityFileExclusively(
  temporaryPath: string,
  targetPath: string,
  bytes: Buffer,
  deps: ExclusivePublishDeps = exclusivePublishDeps,
): Promise<void> {
  try {
    await deps.link(temporaryPath, targetPath);
    return;
  } catch (error) {
    if (!isErrno(error, "ENOTSUP", "EOPNOTSUPP")) throw error;
  }

  const handle = await deps.open(targetPath, "wx", 0o600);
  const opened = await handle.stat();
  let complete = false;
  try {
    await handle.writeFile(bytes);
    await handle.sync();
    complete = true;
  } finally {
    await handle.close();
    if (!complete) {
      const current = await deps.lstat(targetPath).catch(() => null);
      if (current?.dev === opened.dev && current.ino === opened.ino) {
        await deps.rm(targetPath, { force: true }).catch(() => undefined);
      }
    }
  }
}

/**
 * Temporary Phase-8 create lane: canonicalize the existing parent, stage and
 * fsync in that directory, then publish with link(2)'s atomic no-replace
 * semantics. It cannot follow a symlinked parent outside the current root or
 * overwrite a creator that wins the race.
 */
export async function createCompatibilityFileExclusively(
  targetPath: string,
  bytes: Buffer,
  assertPathInAllowedRoot: (candidate: string) => void,
): Promise<void> {
  let parent: string;
  try {
    parent = await fsp.realpath(path.dirname(targetPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    const canonicalTarget = await resolveMissingTargetFromExistingAncestor(
      targetPath,
      assertPathInAllowedRoot,
    );
    await fsp.mkdir(path.dirname(canonicalTarget), { recursive: true });
    parent = await fsp.realpath(path.dirname(canonicalTarget));
  }
  assertPathInAllowedRoot(parent);
  const canonicalTarget = path.join(parent, path.basename(targetPath));
  assertPathInAllowedRoot(canonicalTarget);
  const reauthorizedParent = await fsp.realpath(path.dirname(canonicalTarget));
  if (reauthorizedParent !== parent) {
    throw new Error("create parent changed during authorization");
  }
  assertPathInAllowedRoot(path.join(reauthorizedParent, path.basename(canonicalTarget)));
  const temporary = path.join(
    parent,
    `.${path.basename(canonicalTarget)}.nautilo-create-${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    const handle = await fsp.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    const publishParent = await fsp.realpath(path.dirname(canonicalTarget));
    if (publishParent !== parent) {
      throw new Error("create parent changed before publish");
    }
    const publishTarget = path.join(publishParent, path.basename(canonicalTarget));
    assertPathInAllowedRoot(publishTarget);
    await publishCompatibilityFileExclusively(temporary, publishTarget, bytes);
  } finally {
    await fsp.rm(temporary, { force: true }).catch(() => undefined);
  }
}

export function registerFsStructuralIpcHandlers<Event>(deps: FsStructuralDeps<Event>): void {
  deps.ipcMain.handle("fs:writeFile", async (event: Event, rawArgs: unknown): Promise<FsWriteFileResult> => {
    deps.assertSender(event);
    const args = rawArgs as {
      path: string;
      content: string;
      baseSha256?: string | null;
      checkpoint?: unknown;
      requestId?: unknown;
      clientMutationId?: unknown;
      anchoredPatch?: unknown;
      baseVersion?: unknown;
    };

    let allowed = true;
    try {
      deps.assertPathInAllowedRoot(args.path);
    } catch {
      allowed = false;
    }

    const bytes = Buffer.from(args.content, "utf-8");
    let currentSha256: string | null = null;
    if (allowed) {
      try {
        currentSha256 = sha256Hex(await deps.fs.readFile(args.path));
      } catch (error) {
        // Only a proved absent path may enter the temporary create lane.
        // Permission/read/type failures must not be reclassified as missing
        // and accidentally create/replace an existing document.
        if (!isErrno(error, "ENOENT")) {
          return { ok: false, code: "error", message: errorMessage(error) };
        }
      }
    }

    const decision = decideFsWrite({
      targetPath: args.path,
      allowed,
      baseSha256: args.baseSha256 ?? null,
      currentSha256,
      contentBytes: bytes.byteLength,
    });
    const stableRetry =
      typeof args.clientMutationId === "string" && args.clientMutationId.trim().length > 0 ||
      typeof args.requestId === "string" && args.requestId.trim().length > 0;
    // A lost response can arrive after the first save changed disk. Let the
    // trusted runtime reconstruct and validate durable truth before stale CAS
    // rejects it; size/root/sender admission still remains local here.
    if (allowed && currentSha256 !== null && stableRetry && deps.editorSave) {
      if (bytes.byteLength > 50 * 1024 * 1024) return { ok: false, code: "too_large" };
      return await deps.editorSave.saveExistingFile({
        path: args.path, content: args.content, baseSha256: args.baseSha256 ?? null,
        correlation: { checkpoint: args.checkpoint, requestId: args.requestId, clientMutationId: args.clientMutationId, anchoredPatch: args.anchoredPatch, baseVersion: args.baseVersion },
      });
    }
    if (!decision.ok) {
      if (decision.code === "conflict" && currentSha256 !== null) {
        return { ok: false, code: "conflict", currentSha256 };
      }
      return { ok: false, code: decision.code };
    }

    if (currentSha256 !== null) {
      if (!deps.editorSave) {
        return {
          ok: false,
          code: "error",
          message: "Desktop editor mutation runtime is unavailable",
        };
      }
      // D448: `fs:writeFile` is now only a renderer compatibility facade for
      // updates. It never writes an existing file itself and never falls back
      // to the legacy writer when coordinator admission/commit rejects.
      return await deps.editorSave.saveExistingFile({
        path: args.path,
        content: args.content,
        baseSha256: args.baseSha256 ?? null,
        correlation: {
          checkpoint: args.checkpoint,
          requestId: args.requestId,
          clientMutationId: args.clientMutationId,
          anchoredPatch: args.anchoredPatch,
          baseVersion: args.baseVersion,
        },
      });
    }

    try {
      // Explicit compatibility create only. It is structurally separate from
      // the coordinator's update lane; Phase 9 will give creates their own
      // coordinator plan, never an update fallback.
      await deps.createFileExclusive(args.path, bytes);
      return { ok: true, sha256: sha256Hex(bytes), size: bytes.byteLength };
    } catch (error) {
      if (isErrno(error, "EEXIST")) {
        try {
          return { ok: false, code: "conflict", currentSha256: sha256Hex(await deps.fs.readFile(args.path)) };
        } catch {
          return { ok: false, code: "conflict" };
        }
      }
      return { ok: false, code: "error", message: errorMessage(error) };
    }
  });

  deps.ipcMain.handle("fs:rename", async (event: Event, rawArgs: unknown): Promise<FsRenameResult> => {
    deps.assertSender(event);
    const args = rawArgs as { from: string; to: string };
    try {
      deps.assertPathInAllowedRoot(args.from);
    } catch {
      return { ok: false, code: "forbidden" };
    }
    try {
      deps.assertPathInAllowedRoot(args.to);
    } catch {
      return { ok: false, code: "forbidden" };
    }
    try {
      await deps.fs.rename(args.from, args.to);
      return { ok: true };
    } catch (error) {
      if (isErrno(error, "EEXIST", "ENOTEMPTY")) return { ok: false, code: "exists" };
      return { ok: false, code: "error", message: errorMessage(error) };
    }
  });

  deps.ipcMain.handle("fs:trash", async (event: Event, rawArgs: unknown): Promise<FsTrashResult> => {
    deps.assertSender(event);
    const args = rawArgs as { path: string };
    try {
      deps.assertPathInAllowedRoot(args.path);
    } catch {
      return { ok: false, code: "forbidden" };
    }
    try {
      await deps.shell.trashItem(args.path);
      return { ok: true };
    } catch (error) {
      return { ok: false, code: "error", message: errorMessage(error) };
    }
  });
}
