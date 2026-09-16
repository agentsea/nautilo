/**
 * Guarded filesystem adapter for local revision restore and drift checks.
 *
 * Callers inject an implementation so business logic stays Electron-free and
 * path containment is enforced through `canonicalize` at restore time.
 */

import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface FileStat {
  isFile: boolean;
  isDirectory: boolean;
  isSymbolicLink: boolean;
  size: number;
  mtimeMs: number;
  /** Identity/change stamp for byte-exact ranged reads. */
  sourceVersion?: string;
}

export type ConditionalFilePreimage =
  | { readonly kind: "missing" }
  | { readonly kind: "bytes"; readonly bytes: Uint8Array };

export type ConditionalFileMutationResult =
  | { readonly kind: "applied" }
  | { readonly kind: "conflict" };

export type ResolveGuardedTargetOptions = {
  /** Permit only the final path component to be absent. */
  readonly allowMissing: boolean;
  /** Reject rather than follow an existing final symbolic link. */
  readonly rejectFinalSymlink: boolean;
};

export interface GuardedFileAdapter {
  stat(filePath: string): Promise<FileStat | null>;
  readFile(filePath: string): Promise<Uint8Array>;
  /** Reads exactly a bounded byte range after the same path guard checks. */
  readRange?(filePath: string, offset: number, length: number): Promise<Uint8Array>;
  writeFile(filePath: string, bytes: Uint8Array): Promise<void>;
  /**
   * Same-directory temp write + rename so readers never observe torn bytes.
   * Used by M216 accepted local Writer writes after SHA recheck.
   */
  writeFileAtomic?(filePath: string, bytes: Uint8Array): Promise<void>;
  /**
   * Publishes an atomic byte postimage only while the path still has the exact
   * supplied preimage. A missing preimage uses no-replace publication.
   */
  writeFileAtomicConditional?(
    filePath: string,
    expected: ConditionalFilePreimage,
    bytes: Uint8Array,
  ): Promise<ConditionalFileMutationResult>;
  remove(filePath: string): Promise<void>;
  /** Removes only while the path still has the exact supplied preimage. */
  removeConditional?(
    filePath: string,
    expected: ConditionalFilePreimage,
  ): Promise<ConditionalFileMutationResult>;
  removeRecursive(filePath: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  canonicalize(filePath: string): Promise<string>;
  /**
   * Resolves a mutation target against filesystem truth. Existing targets use
   * realpath; missing targets require an existing canonical parent.
   */
  resolveTarget(
    filePath: string,
    options: ResolveGuardedTargetOptions,
  ): Promise<string>;
}

export interface CreateGuardedNodeAdapterOptions {
  allowedRoots: string[];
}

export function isPathContained(candidate: string, root: string): boolean {
  const normalizedRoot = path.resolve(root);
  const normalizedCandidate = path.resolve(candidate);
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Canonicalize the nearest existing ancestor and reattach an absent suffix.
 * Every existing ancestor (including a symlinked directory) is resolved by
 * realpath before the caller's root authority is checked.
 */
export async function resolveMissingTargetFromExistingAncestor(
  filePath: string,
  assertAllowed: (candidate: string) => void,
): Promise<string> {
  const resolved = path.resolve(filePath);
  let current = resolved;
  const suffix: string[] = [];
  while (true) {
    try {
      const existing = await fs.realpath(current);
      const stat = await fs.lstat(existing);
      if (!stat.isDirectory()) {
        throw Object.assign(
          new Error(`missing target ancestor is not a directory: ${filePath}`),
          { code: "PATH_GUARD_REJECTED" },
        );
      }
      assertAllowed(existing);
      const candidate = path.join(existing, ...suffix);
      assertAllowed(candidate);
      return candidate;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      suffix.unshift(path.basename(current));
      current = parent;
    }
  }
}

async function resolveComparablePath(filePath: string): Promise<string> {
  try {
    return await fs.realpath(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return path.resolve(filePath);
    }
    throw err;
  }
}

export function createGuardedNodeAdapter(
  options: CreateGuardedNodeAdapterOptions,
): GuardedFileAdapter {
  const allowedRoots = options.allowedRoots.map((r) => path.resolve(r));
  let comparableRootsPromise: Promise<string[]> | null = null;

  async function getComparableRoots(): Promise<string[]> {
    if (!comparableRootsPromise) {
      comparableRootsPromise = Promise.all(allowedRoots.map((root) => resolveComparablePath(root)));
    }
    return comparableRootsPromise;
  }

  async function comparablePath(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    try {
      return await fs.realpath(resolved);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      const roots = await getComparableRoots();
      for (let i = 0; i < allowedRoots.length; i += 1) {
        const originalRoot = path.resolve(allowedRoots[i]!);
        if (isPathContained(resolved, originalRoot)) {
          const relative = path.relative(originalRoot, resolved);
          return path.join(roots[i]!, relative);
        }
      }
      return resolved;
    }
  }

  async function assertAllowed(filePath: string): Promise<string> {
    const resolved = path.resolve(filePath);
    const comparable = await comparablePath(resolved);
    const roots = await getComparableRoots();
    if (!roots.some((root) => isPathContained(comparable, root))) {
      throw Object.assign(new Error(`path outside allowed roots: ${filePath}`), {
        code: "PATH_GUARD_REJECTED",
      });
    }
    return comparable;
  }

  async function resolveTarget(
    filePath: string,
    targetOptions: ResolveGuardedTargetOptions,
  ): Promise<string> {
    const resolved = path.resolve(filePath);
    const roots = await getComparableRoots();
    try {
      const stat = await fs.lstat(resolved);
      if (targetOptions.rejectFinalSymlink && stat.isSymbolicLink()) {
        throw Object.assign(new Error(`symbolic-link target rejected: ${filePath}`), {
          code: "PATH_GUARD_REJECTED",
        });
      }
      const canonical = await fs.realpath(resolved);
      if (!roots.some((root) => isPathContained(canonical, root))) {
        throw Object.assign(new Error(`path outside allowed roots: ${filePath}`), {
          code: "PATH_GUARD_REJECTED",
        });
      }
      return canonical;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!targetOptions.allowMissing) throw error;
      return await resolveMissingTargetFromExistingAncestor(
        resolved,
        (candidate) => {
          if (!roots.some((root) => isPathContained(candidate, root))) {
            throw Object.assign(
              new Error(`missing target parent is not allowed: ${filePath}`),
              { code: "PATH_GUARD_REJECTED" },
            );
          }
        },
      );
    }
  }

  async function matchesExpected(
    filePath: string,
    expected: ConditionalFilePreimage,
  ): Promise<boolean> {
    try {
      const stat = await fs.lstat(filePath);
      if (expected.kind === "missing" || !stat.isFile() || stat.isSymbolicLink()) {
        return false;
      }
      const current = await fs.readFile(filePath);
      return current.byteLength === expected.bytes.byteLength &&
        current.equals(Buffer.from(
          expected.bytes.buffer,
          expected.bytes.byteOffset,
          expected.bytes.byteLength,
        ));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return expected.kind === "missing";
      }
      throw error;
    }
  }

  async function temporaryPostimage(
    resolved: string,
    bytes: Uint8Array,
  ): Promise<string> {
    const dir = path.dirname(resolved);
    await fs.mkdir(dir, { recursive: true });
    const token = randomBytes(8).toString("hex");
    const tempPath = path.join(dir, `.${path.basename(resolved)}.nautilo-${token}.tmp`);
    await fs.writeFile(tempPath, bytes, { flag: "wx" });
    return tempPath;
  }

  return {
    async stat(filePath) {
      const resolved = await assertAllowed(filePath);
      try {
        const st = await fs.lstat(resolved);
        return {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          isSymbolicLink: st.isSymbolicLink(),
          size: st.size,
          mtimeMs: st.mtimeMs,
          sourceVersion: `${resolved}:${st.dev}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`,
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
        throw err;
      }
    },

    async readFile(filePath) {
      const resolved = await assertAllowed(filePath);
      const buf = await fs.readFile(resolved);
      return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
    },

    async readRange(filePath, offset, length) {
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0) {
        throw Object.assign(new Error("invalid byte range"), { code: "EINVAL" });
      }
      const resolved = await assertAllowed(filePath);
      const handle = await fs.open(resolved, "r");
      try {
        const st = await handle.stat();
        if (!st.isFile() || offset > st.size) {
          throw Object.assign(new Error("range read requires a regular file"), { code: "EINVAL" });
        }
        const readLength = Math.min(length, st.size - offset);
        const buffer = Buffer.allocUnsafe(readLength);
        const { bytesRead } = await handle.read(buffer, 0, readLength, offset);
        return new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      } finally {
        await handle.close();
      }
    },

    async writeFile(filePath, bytes) {
      const resolved = await assertAllowed(filePath);
      await fs.mkdir(path.dirname(resolved), { recursive: true });
      await fs.writeFile(resolved, bytes);
    },

    async writeFileAtomic(filePath, bytes) {
      const resolved = await assertAllowed(filePath);
      const tempPath = await temporaryPostimage(resolved, bytes);
      try {
        await fs.rename(tempPath, resolved);
      } catch (err) {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
        throw err;
      }
    },

    async writeFileAtomicConditional(filePath, expected, bytes) {
      const resolved = await resolveTarget(filePath, {
        allowMissing: expected.kind === "missing",
        rejectFinalSymlink: true,
      });
      const tempPath = await temporaryPostimage(resolved, bytes);
      try {
        if (expected.kind === "missing") {
          try {
            // Hard-link publication is atomic and refuses to replace a path
            // created by a concurrent human writer.
            await fs.link(tempPath, resolved);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "EEXIST") {
              return { kind: "conflict" };
            }
            throw error;
          }
          return { kind: "applied" };
        }
        // The temp postimage is fully durable in the destination directory
        // before the final exact-preimage check and atomic replacement.
        if (!await matchesExpected(resolved, expected)) {
          return { kind: "conflict" };
        }
        await fs.rename(tempPath, resolved);
        return { kind: "applied" };
      } finally {
        await fs.rm(tempPath, { force: true }).catch(() => undefined);
      }
    },

    async remove(filePath) {
      const resolved = await assertAllowed(filePath);
      await fs.rm(resolved, { force: true });
    },

    async removeConditional(filePath, expected) {
      const resolved = await resolveTarget(filePath, {
        allowMissing: false,
        rejectFinalSymlink: true,
      });
      if (!await matchesExpected(resolved, expected)) {
        return { kind: "conflict" };
      }
      try {
        await fs.unlink(resolved);
        return { kind: "applied" };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return { kind: "conflict" };
        }
        throw error;
      }
    },

    async removeRecursive(filePath) {
      const resolved = await assertAllowed(filePath);
      await fs.rm(resolved, { recursive: true, force: false });
    },

    async rename(from, to) {
      const resolvedFrom = await assertAllowed(from);
      const resolvedTo = await assertAllowed(to);
      await fs.rename(resolvedFrom, resolvedTo);
    },

    async canonicalize(filePath) {
      return assertAllowed(filePath);
    },

    resolveTarget,
  };
}
