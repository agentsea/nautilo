import * as fs from "node:fs/promises";
import * as path from "node:path";

export type StructuredSshCopyOperation = "copy-upload" | "copy-download";

export type StructuredSshCopyConfinementResult =
  | {
      readonly ok: true;
      /** Canonical local pathname given to fixed `scp`, never a model-selected root. */
      readonly path: string;
      readonly bytes: number;
      /** Rechecks containment and symlink state immediately before launch. */
      validateForLaunch(): Promise<boolean>;
      /** For downloads, verifies the created file is still confined after transfer. */
      validateAfterTransfer(): Promise<{ readonly ok: true; readonly bytes: number } | { readonly ok: false }>;
    }
  | { readonly ok: false };

export interface ResolveStructuredSshCopyPathInput {
  readonly operation: StructuredSshCopyOperation;
  /** Parsed workspace-relative intent only; it cannot name a local root. */
  readonly localPath: string;
  /** Always-present Nautilo Workspace baseline, never Current Folder. */
  readonly workspaceRoot: string;
}

function contained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative.length > 0 && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

function validWorkspaceRoot(value: unknown): value is string {
  return typeof value === "string" && value.length > 1 && path.isAbsolute(value) && !/[\0\r\n]/u.test(value);
}

function validRelativeIntent(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && !path.isAbsolute(value)
    && !/[\0\r\n]/u.test(value);
}

async function canonicalWorkspaceRoot(workspaceRoot: string): Promise<string | null> {
  if (!validWorkspaceRoot(workspaceRoot)) return null;
  try {
    const canonical = await fs.realpath(workspaceRoot);
    const stat = await fs.lstat(canonical);
    return stat.isDirectory() && !stat.isSymbolicLink() ? canonical : null;
  } catch {
    return null;
  }
}

/**
 * Resolves an SCP local endpoint against Electron-local authority only.  It
 * deliberately does not know a target, key, socket, Current Folder, or any
 * server supplied root. Every parsed relative path is resolved underneath the
 * canonical Electron workspace and then rechecked before the process launch.
 */
export async function resolveStructuredSshCopyPath(
  input: ResolveStructuredSshCopyPathInput,
): Promise<StructuredSshCopyConfinementResult> {
  if (!validRelativeIntent(input.localPath)) return { ok: false };
  const workspaceRoot = await canonicalWorkspaceRoot(input.workspaceRoot);
  if (workspaceRoot === null) return { ok: false };
  const lexical = path.resolve(workspaceRoot, input.localPath);
  if (!contained(workspaceRoot, lexical)) return { ok: false };

  if (input.operation === "copy-upload") {
    try {
      const lexicalStat = await fs.lstat(lexical);
      const canonical = await fs.realpath(lexical);
      const stat = await fs.lstat(canonical);
      if (lexicalStat.isSymbolicLink() || stat.isSymbolicLink() || !stat.isFile() || !contained(workspaceRoot, canonical) || stat.size < 0) return { ok: false };
      const expectedDev = stat.dev;
      const expectedIno = stat.ino;
      const expectedSize = stat.size;
      return {
        ok: true,
        path: canonical,
        bytes: expectedSize,
        validateForLaunch: async () => {
          try {
            const current = await fs.lstat(canonical);
            return current.isFile() && !current.isSymbolicLink() && current.dev === expectedDev && current.ino === expectedIno && current.size === expectedSize && contained(workspaceRoot, canonical);
          } catch { return false; }
        },
        validateAfterTransfer: () => Promise.resolve({ ok: true, bytes: expectedSize }),
      };
    } catch { return { ok: false }; }
  }

  try {
    // Do not let SCP overwrite an existing user file; it removes both the
    // symlink-write primitive and ambiguity about cleanup after a failed copy.
    await fs.lstat(lexical);
    return { ok: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return { ok: false };
  }
  try {
    const lexicalParent = path.dirname(lexical);
    const canonicalParent = await fs.realpath(lexicalParent);
    const parentStat = await fs.lstat(canonicalParent);
    // A file directly inside the Workspace has the Workspace itself as its
    // parent. That parent is authoritative, not an escape; nested parents
    // must still be strictly contained.
    if (
      !parentStat.isDirectory() ||
      parentStat.isSymbolicLink() ||
      (canonicalParent !== workspaceRoot && !contained(workspaceRoot, canonicalParent))
    ) return { ok: false };
    const destination = path.join(canonicalParent, path.basename(lexical));
    const expectedDev = parentStat.dev;
    const expectedIno = parentStat.ino;
    const validateDestination = async (): Promise<boolean> => {
      try {
        const currentParent = await fs.lstat(canonicalParent);
        if (
          !currentParent.isDirectory() ||
          currentParent.isSymbolicLink() ||
          currentParent.dev !== expectedDev ||
          currentParent.ino !== expectedIno ||
          (canonicalParent !== workspaceRoot && !contained(workspaceRoot, canonicalParent))
        ) return false;
        try { await fs.lstat(destination); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT"; }
      } catch { return false; }
    };
    return {
      ok: true,
      path: destination,
      bytes: 0,
      validateForLaunch: validateDestination,
      validateAfterTransfer: async () => {
        try {
          const stat = await fs.lstat(destination);
          return stat.isFile() && !stat.isSymbolicLink() && stat.size >= 0 && contained(workspaceRoot, destination)
            ? { ok: true, bytes: stat.size }
            : { ok: false };
        } catch { return { ok: false }; }
      },
    };
  } catch { return { ok: false }; }
}
