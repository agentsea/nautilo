import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import * as path from "node:path";

const DEFAULT_PREPARATION_TTL_MS = 60_000;
const DEFAULT_MAX_PREPARATIONS = 32;
const MAX_RELATIVE_PATH_LENGTH = 1_024;

export type CurrentFolderAdoptionSourceRootKind = "workspace" | "current_folder";

export interface CurrentFolderAdoptionRoot {
  /** Electron-owned path; it is never returned from prepare or commit. */
  readonly path: string;
  /** Monotonic local revision for this root selection. */
  readonly revision: number;
}

export interface CurrentFolderSelectionSnapshot {
  /** Electron-owned path; it is never returned from prepare or commit. */
  readonly path: string | null;
  readonly revision: number;
}

export interface CurrentFolderAdoptionIdentity {
  readonly device: number;
  readonly inode: number;
  /** Detects an inode that was deleted and immediately reused. */
  readonly changedAtMs: number;
  readonly createdAtMs: number;
}

export type CurrentFolderAdoptionPrepareResult =
  | {
      readonly ok: true;
      /** Opaque, process-local, one-use reference. */
      readonly preparationId: string;
      /** Safe display projection; this is never a host path. */
      readonly label: string;
      readonly sourceRootKind: CurrentFolderAdoptionSourceRootKind;
      readonly sourceIdentity: CurrentFolderAdoptionIdentity;
      readonly targetIdentity: CurrentFolderAdoptionIdentity;
      readonly currentFolderRevision: number;
      readonly expiresAt: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "invalid_request"
        | "source_unavailable"
        | "source_symlink"
        | "target_missing"
        | "target_not_directory"
        | "target_symlink"
        | "target_outside_source"
        | "target_protected"
        | "target_unsafe"
        | "preparation_unavailable";
      readonly message: string;
    };

export type CurrentFolderAdoptionCommitResult =
  | {
      readonly ok: true;
      readonly label: string;
      readonly currentFolderRevision: number;
    }
  | {
      readonly ok: false;
      readonly code:
        | "approval_required"
        | "preparation_unknown"
        | "preparation_expired"
        | "source_stale"
        | "target_stale"
        | "current_folder_stale"
        | "target_missing"
        | "target_not_directory"
        | "target_symlink"
        | "target_outside_source"
        | "target_protected"
        | "target_unsafe"
        | "commit_failed";
      readonly message: string;
    };

type ProtectedPathPolicy = {
  readonly check: (candidate: string) => { readonly allowed: boolean };
};

type SanityCheck = (candidate: string) => { readonly ok: boolean; readonly reason?: string };

interface PreparedTarget {
  readonly canonicalSourceRoot: string;
  readonly sourceIdentity: CurrentFolderAdoptionIdentity;
  readonly canonicalTarget: string;
  readonly targetIdentity: CurrentFolderAdoptionIdentity;
  readonly label: string;
}

interface Preparation extends PreparedTarget {
  readonly sourceRootKind: CurrentFolderAdoptionSourceRootKind;
  readonly sourceRevision: number;
  readonly currentFolderSelection: CurrentFolderSelectionSnapshot;
  readonly expiresAt: number;
}

export interface CurrentFolderAdoptionAuthorityOptions {
  readonly getWorkspaceRoot: () => CurrentFolderAdoptionRoot | null;
  readonly getCurrentFolderRoot: () => CurrentFolderAdoptionRoot | null;
  /** Captures every Current Folder transition, including a transition to none. */
  readonly getCurrentFolderSelection: () => CurrentFolderSelectionSnapshot;
  readonly checkCurrentFolderSanity: SanityCheck;
  readonly protectedPathPolicy: ProtectedPathPolicy;
  /** Calls Electron main's existing canonical commitCurrentFolderPath seam. */
  readonly commitCurrentFolderPath: (canonicalPath: string) => Promise<void> | void;
  readonly now?: () => number;
  readonly createPreparationId?: () => string;
  readonly preparationTtlMs?: number;
  readonly maxPreparations?: number;
}

function sameIdentity(
  left: CurrentFolderAdoptionIdentity,
  right: CurrentFolderAdoptionIdentity,
): boolean {
  return left.device === right.device &&
    left.inode === right.inode &&
    left.changedAtMs === right.changedAtMs &&
    left.createdAtMs === right.createdAtMs;
}

function sameSelection(
  left: CurrentFolderSelectionSnapshot,
  right: CurrentFolderSelectionSnapshot,
): boolean {
  return left.path === right.path && left.revision === right.revision;
}

function isContained(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function identityFromStat(stat: {
  readonly dev: number;
  readonly ino: number;
  readonly ctimeMs: number;
  readonly birthtimeMs: number;
}): CurrentFolderAdoptionIdentity | null {
  return Number.isSafeInteger(stat.dev) && stat.dev >= 0 &&
    Number.isSafeInteger(stat.ino) && stat.ino >= 0 &&
    Number.isFinite(stat.ctimeMs) && stat.ctimeMs >= 0 &&
    Number.isFinite(stat.birthtimeMs) && stat.birthtimeMs >= 0
    ? {
        device: stat.dev,
        inode: stat.ino,
        changedAtMs: stat.ctimeMs,
        createdAtMs: stat.birthtimeMs,
      }
    : null;
}

function validateRelativePath(input: unknown): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_RELATIVE_PATH_LENGTH) {
    return null;
  }
  if (
    input.includes("\0") ||
    path.isAbsolute(input) ||
    path.posix.isAbsolute(input) ||
    path.win32.isAbsolute(input) ||
    /^[A-Za-z]:/.test(input)
  ) {
    return null;
  }
  const segments = input.split(/[\\/]/);
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? null
    : input;
}

function resolveSourceRoot(
  sourceRootKind: CurrentFolderAdoptionSourceRootKind,
  options: CurrentFolderAdoptionAuthorityOptions,
): CurrentFolderAdoptionRoot | null {
  return sourceRootKind === "workspace"
    ? options.getWorkspaceRoot()
    : options.getCurrentFolderRoot();
}

async function resolvePreparedTarget(input: {
  readonly sourceRoot: CurrentFolderAdoptionRoot;
  readonly relativePath: string;
  readonly options: CurrentFolderAdoptionAuthorityOptions;
}): Promise<PreparedTarget | Exclude<CurrentFolderAdoptionPrepareResult, { readonly ok: true }>> {
  const { sourceRoot, relativePath, options } = input;
  let canonicalSourceRoot: string;
  try {
    const sourceLink = await fsp.lstat(sourceRoot.path);
    if (sourceLink.isSymbolicLink()) {
      return { ok: false, code: "source_symlink", message: "The requested source is no longer available." };
    }
    canonicalSourceRoot = await fsp.realpath(sourceRoot.path);
    const sourceStat = await fsp.stat(canonicalSourceRoot);
    if (!sourceStat.isDirectory()) {
      return { ok: false, code: "source_unavailable", message: "The requested source is no longer available." };
    }
    const sourceIdentity = identityFromStat(sourceStat);
    if (!sourceIdentity) {
      return { ok: false, code: "source_unavailable", message: "The requested source cannot be verified." };
    }

    let candidate = canonicalSourceRoot;
    for (const segment of relativePath.split(/[\\/]/)) {
      candidate = path.join(candidate, segment);
      const link = await fsp.lstat(candidate);
      if (link.isSymbolicLink()) {
        return { ok: false, code: "target_symlink", message: "The requested folder cannot use a symbolic link." };
      }
    }
    const canonicalTarget = await fsp.realpath(candidate);
    if (!isContained(canonicalSourceRoot, canonicalTarget)) {
      return { ok: false, code: "target_outside_source", message: "The requested folder is outside its authorized source." };
    }
    const targetStat = await fsp.stat(canonicalTarget);
    if (!targetStat.isDirectory()) {
      return { ok: false, code: "target_not_directory", message: "The requested target is not a folder." };
    }
    const targetIdentity = identityFromStat(targetStat);
    if (!targetIdentity) {
      return { ok: false, code: "target_missing", message: "The requested folder cannot be verified." };
    }
    if (!options.protectedPathPolicy.check(canonicalTarget).allowed) {
      return { ok: false, code: "target_protected", message: "The requested folder is protected." };
    }
    const sanity = options.checkCurrentFolderSanity(canonicalTarget);
    if (!sanity.ok) {
      return { ok: false, code: "target_unsafe", message: sanity.reason ?? "The requested folder is not safe to select." };
    }
    return {
      canonicalSourceRoot,
      sourceIdentity,
      canonicalTarget,
      targetIdentity,
      label: path.basename(canonicalTarget),
    };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { ok: false, code: "target_missing", message: "The requested folder is no longer available." };
    }
    return { ok: false, code: "source_unavailable", message: "The requested source is no longer available." };
  }
}

function asCommitFailure(
  failure: Exclude<CurrentFolderAdoptionPrepareResult, { readonly ok: true }>,
): Exclude<CurrentFolderAdoptionCommitResult, { readonly ok: true }> {
  switch (failure.code) {
    case "target_missing":
    case "target_not_directory":
    case "target_symlink":
    case "target_outside_source":
    case "target_protected":
    case "target_unsafe":
      return { ok: false, code: failure.code, message: failure.message };
    default:
      return { ok: false, code: "source_stale", message: failure.message };
  }
}

/**
 * Process-local, one-use preparation store for the future server-approved
 * Current Folder adoption route. It deliberately owns no filesystem grant,
 * policy, database state, or approval UI. The server can retain only the
 * opaque preparation id; all host paths stay inside this Electron object.
 */
export function createCurrentFolderAdoptionAuthority(options: CurrentFolderAdoptionAuthorityOptions) {
  const now = options.now ?? Date.now;
  const createPreparationId = options.createPreparationId ?? randomUUID;
  const ttlMs = options.preparationTtlMs ?? DEFAULT_PREPARATION_TTL_MS;
  const maxPreparations = options.maxPreparations ?? DEFAULT_MAX_PREPARATIONS;
  const preparations = new Map<string, Preparation>();

  const purgeExpired = (): void => {
    const current = now();
    for (const [id, preparation] of preparations) {
      if (preparation.expiresAt <= current) preparations.delete(id);
    }
  };

  const capturePreparation = async (
    sourceRootKind: CurrentFolderAdoptionSourceRootKind,
    relativePath: string,
  ): Promise<CurrentFolderAdoptionPrepareResult> => {
    const sourceRoot = resolveSourceRoot(sourceRootKind, options);
    if (!sourceRoot) {
      return { ok: false, code: "source_unavailable", message: "The requested source is no longer available." };
    }
    const resolved = await resolvePreparedTarget({ sourceRoot, relativePath, options });
    if ("ok" in resolved) return resolved;

    purgeExpired();
    if (preparations.size >= maxPreparations) {
      return { ok: false, code: "preparation_unavailable", message: "Folder adoption is temporarily unavailable." };
    }
    const createdAt = now();
    const expiresAt = createdAt + ttlMs;
    let preparationId = createPreparationId();
    for (let attempts = 0; preparations.has(preparationId) && attempts < 3; attempts += 1) {
      preparationId = createPreparationId();
    }
    if (preparations.has(preparationId)) {
      return { ok: false, code: "preparation_unavailable", message: "Folder adoption is temporarily unavailable." };
    }
    const selection = options.getCurrentFolderSelection();
    preparations.set(preparationId, {
      ...resolved,
      sourceRootKind,
      sourceRevision: sourceRoot.revision,
      currentFolderSelection: selection,
      expiresAt,
    });
    return {
      ok: true,
      preparationId,
      label: resolved.label,
      sourceRootKind,
      sourceIdentity: resolved.sourceIdentity,
      targetIdentity: resolved.targetIdentity,
      currentFolderRevision: selection.revision,
      expiresAt,
    };
  };

  return {
    async prepare(input: {
      readonly sourceRootKind: unknown;
      readonly relativePath: unknown;
    }): Promise<CurrentFolderAdoptionPrepareResult> {
      const relativePath = validateRelativePath(input.relativePath);
      if (
        (input.sourceRootKind !== "workspace" && input.sourceRootKind !== "current_folder") ||
        relativePath === null
      ) {
        return { ok: false, code: "invalid_request", message: "The requested folder selection is invalid." };
      }
      return capturePreparation(input.sourceRootKind, relativePath);
    },

    async commit(input: {
      readonly preparationId: unknown;
      readonly approved: unknown;
    }): Promise<CurrentFolderAdoptionCommitResult> {
      if (typeof input.preparationId !== "string" || input.preparationId.length === 0) {
        return { ok: false, code: "preparation_unknown", message: "That folder approval is no longer available." };
      }
      const preparation = preparations.get(input.preparationId);
      // Consume before every result after lookup: an approval, denial, stale
      // assertion, or race can never replay a prepared host path.
      preparations.delete(input.preparationId);
      if (!preparation) {
        return { ok: false, code: "preparation_unknown", message: "That folder approval is no longer available." };
      }
      if (preparation.expiresAt <= now()) {
        return { ok: false, code: "preparation_expired", message: "That folder approval has expired." };
      }
      if (input.approved !== true) {
        return { ok: false, code: "approval_required", message: "Current Folder adoption was not approved." };
      }

      const currentSelection = options.getCurrentFolderSelection();
      if (!sameSelection(preparation.currentFolderSelection, currentSelection)) {
        return { ok: false, code: "current_folder_stale", message: "Current Folder changed before adoption could complete." };
      }
      const sourceRoot = resolveSourceRoot(preparation.sourceRootKind, options);
      if (!sourceRoot || sourceRoot.revision !== preparation.sourceRevision) {
        return { ok: false, code: "source_stale", message: "The requested source changed before adoption could complete." };
      }
      const refreshed = await resolvePreparedTarget({
        sourceRoot,
        // Reconstruct from the trusted preparation only. This gives no new
        // authority to the committing caller and lets us compare exact paths.
        relativePath: path.relative(preparation.canonicalSourceRoot, preparation.canonicalTarget),
        options,
      });
      if ("ok" in refreshed) return asCommitFailure(refreshed);
      if (
        refreshed.canonicalSourceRoot !== preparation.canonicalSourceRoot ||
        !sameIdentity(refreshed.sourceIdentity, preparation.sourceIdentity)
      ) {
        return { ok: false, code: "source_stale", message: "The requested source changed before adoption could complete." };
      }
      if (
        refreshed.canonicalTarget !== preparation.canonicalTarget ||
        !sameIdentity(refreshed.targetIdentity, preparation.targetIdentity)
      ) {
        return { ok: false, code: "target_stale", message: "The requested folder changed before adoption could complete." };
      }
      try {
        await options.commitCurrentFolderPath(preparation.canonicalTarget);
      } catch {
        return { ok: false, code: "commit_failed", message: "Current Folder could not be updated." };
      }
      const committedSelection = options.getCurrentFolderSelection();
      if (committedSelection.path !== preparation.canonicalTarget) {
        return { ok: false, code: "commit_failed", message: "Current Folder could not be updated." };
      }
      return {
        ok: true,
        label: preparation.label,
        currentFolderRevision: committedSelection.revision,
      };
    },

    /** Test/teardown seam; app restart naturally clears this in-memory store. */
    clear(): void {
      preparations.clear();
    },
  };
}
