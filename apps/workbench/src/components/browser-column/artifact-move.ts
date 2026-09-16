import type { ArtifactDto } from "@nautilo/api-client/browser";
import { buildFolderMarkerPath, isFolderMarkerPath } from "./artifact-tree";

/** Internal MIME for intra-artifact-tree drag moves (not composer outbound). */
const ARTIFACT_TREE_MOVE_MIME =
  "application/x-nautilo-artifact-tree-move" as const;

export type ArtifactTreeMovePayload = {
  kind: "artifact";
  path: string;
  rowId?: string;
  isDir: boolean;
  /**
   * Multi-select move: when the dragged row is part of a selection of >1,
   * this carries every selected path so the drop moves them all at once.
   * Absent for single-item drags.
   */
  paths?: string[];
  /** Identity-preserving multi-selection. New senders populate this instead of `paths`. */
  items?: ArtifactTreeMoveSource[];
};

export interface ArtifactTreeMoveSource {
  path: string;
  rowId?: string;
  isDir: boolean;
}

function isArtifactTreeMoveSource(value: unknown): value is ArtifactTreeMoveSource {
  if (value == null || typeof value !== "object") return false;
  const source = value as { path?: unknown; rowId?: unknown; isDir?: unknown };
  return (
    typeof source.path === "string" &&
    typeof source.isDir === "boolean" &&
    (source.rowId === undefined || typeof source.rowId === "string")
  );
}

function isArtifactTreeMovePayload(value: unknown): value is ArtifactTreeMovePayload {
  if (value == null || typeof value !== "object") return false;
  const payload = value as {
    kind?: unknown;
    path?: unknown;
    rowId?: unknown;
    isDir?: unknown;
    paths?: unknown;
    items?: unknown;
  };
  return (
    payload.kind === "artifact" &&
    typeof payload.path === "string" &&
    typeof payload.isDir === "boolean" &&
    (payload.rowId === undefined || typeof payload.rowId === "string") &&
    (payload.paths === undefined ||
      (Array.isArray(payload.paths) && payload.paths.every((path) => typeof path === "string"))) &&
    (payload.items === undefined ||
      (Array.isArray(payload.items) && payload.items.every(isArtifactTreeMoveSource)))
  );
}

export function setArtifactTreeMoveOnDragData(
  dt: DataTransfer,
  payload: ArtifactTreeMovePayload,
): void {
  dt.setData(ARTIFACT_TREE_MOVE_MIME, JSON.stringify(payload));
}

export function parseArtifactTreeMoveFromDataTransfer(
  dt: DataTransfer | null,
): ArtifactTreeMovePayload | null {
  if (!dt) return null;
  if (!Array.from(dt.types ?? []).includes(ARTIFACT_TREE_MOVE_MIME)) return null;
  const raw = dt.getData(ARTIFACT_TREE_MOVE_MIME);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (isArtifactTreeMovePayload(parsed)) return parsed;
  } catch {
    /* invalid JSON */
  }
  return null;
}

export function isArtifactTreeMoveDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return Array.from(dt.types ?? []).includes(ARTIFACT_TREE_MOVE_MIME);
}

function basenameLogicalPath(logicalPath: string): string {
  const norm = logicalPath.replace(/\\/g, "/");
  const seg = norm.split("/").pop();
  return seg && seg.length > 0 ? seg : logicalPath;
}

/** Parent directory path for a logical artifact path (empty string = workspace root). */
export function artifactParentPath(path: string): string {
  const slash = path.lastIndexOf("/");
  return slash >= 0 ? path.slice(0, slash) : "";
}

/** Compute destination path when dropping `dragPath` into `targetDirPath`. */
export function artifactDropTargetPath(dragPath: string, targetDirPath: string): string {
  const base = basenameLogicalPath(dragPath);
  return targetDirPath.length > 0 ? `${targetDirPath}/${base}` : base;
}

/** True when the item already lives in `targetDirPath` (no move needed). */
export function isSameFolderNoOp(dragPath: string, targetDirPath: string): boolean {
  return artifactParentPath(dragPath) === targetDirPath;
}

/** Rebase one artifact path when a folder prefix moves from `oldPrefix` to `newPrefix`. */
export function rebaseArtifactPath(
  oldPath: string,
  oldPrefix: string,
  newPrefix: string,
): string {
  if (oldPath === oldPrefix) return newPrefix;
  const prefixWithSlash = `${oldPrefix}/`;
  if (oldPath.startsWith(prefixWithSlash)) {
    return `${newPrefix}/${oldPath.slice(prefixWithSlash.length)}`;
  }
  return oldPath;
}

/** All artifact rows under a virtual folder prefix, including the folder marker. */
export function collectDescendantArtifacts(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  dirPrefix: string,
): Array<{ id: string; path: string }> {
  const out: Array<{ id: string; path: string }> = [];
  const nestedPrefix = dirPrefix.length > 0 ? `${dirPrefix}/` : "";
  for (const a of artifacts) {
    if (a.path === dirPrefix || (dirPrefix.length > 0 && a.path.startsWith(nestedPrefix))) {
      out.push({ id: a.id, path: a.path });
    }
  }
  return out;
}

/** Artifact rows contained by a virtual folder; excludes a file colliding at the folder path. */
export function collectFolderDescendantArtifacts(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  dirPrefix: string,
): Array<{ id: string; path: string }> {
  const nestedPrefix = dirPrefix.length > 0 ? `${dirPrefix}/` : "";
  return artifacts
    .filter((artifact) => nestedPrefix.length > 0 && artifact.path.startsWith(nestedPrefix))
    .map(({ id, path }) => ({ id, path }));
}

export interface FolderRebaseOp {
  rowId: string;
  oldPath: string;
  newPath: string;
}

export type ArtifactMoveRowResolution =
  | { ok: true; rowId: string }
  | { ok: false; reason: "missing" | "ambiguous" };

export function resolveArtifactMoveRowId(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  path: string,
  rowId?: string,
): ArtifactMoveRowResolution {
  if (rowId) {
    return artifacts.some((artifact) => artifact.id === rowId && artifact.path === path)
      ? { ok: true, rowId }
      : { ok: false, reason: "missing" };
  }
  const matches = artifacts.filter((artifact) => artifact.path === path);
  if (matches.length === 1) return { ok: true, rowId: matches[0].id };
  return { ok: false, reason: matches.length === 0 ? "missing" : "ambiguous" };
}

/** Plan sequential rename ops for moving/renaming a folder and all descendants. */
export function planFolderRebase(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  oldPrefix: string,
  newPrefix: string,
): FolderRebaseOp[] {
  return collectFolderDescendantArtifacts(artifacts, oldPrefix).map((a) => ({
    rowId: a.id,
    oldPath: a.path,
    newPath: rebaseArtifactPath(a.path, oldPrefix, newPrefix),
  }));
}

/**
 * Destination paths in `ops` that already exist as a *different* artifact
 * (i.e. not one of the rows being moved). A non-empty result means the move
 * would collide; callers must abort BEFORE issuing any rename so the batch
 * stays atomic instead of half-applying and then hitting a mid-flight 409.
 */
export function detectRebaseCollisions(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  ops: readonly FolderRebaseOp[],
): string[] {
  const movingRowIds = new Set(ops.map((o) => o.rowId));
  const collisions: string[] = [];
  for (const op of ops) {
    if (op.newPath === op.oldPath) continue;
    if (artifacts.some((artifact) => artifact.path === op.newPath && !movingRowIds.has(artifact.id))) {
      collisions.push(op.newPath);
    }
  }
  return collisions;
}

/**
 * Plan rename ops for moving a set of source paths (files and/or folders)
 * into `targetDirPath`. Folders rebase every descendant (marker included);
 * files map to `targetDir/basename`. De-dupes by rowId so a selection that
 * contains both a folder and one of its own children never double-moves a
 * row. Items already living in the target (`dest === src`) are skipped.
 */
export function planMoveToDir(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  sources: readonly (string | ArtifactTreeMoveSource)[],
  targetDirPath: string,
): FolderRebaseOp[] {
  for (const source of sources) {
    if (typeof source === "string" || source.isDir) continue;
    if (!resolveArtifactMoveRowId(artifacts, source.path, source.rowId).ok) return [];
  }

  const ops: FolderRebaseOp[] = [];
  const seenRowIds = new Set<string>();
  for (const source of sources) {
    const src = typeof source === "string" ? source : source.path;
    const dest = artifactDropTargetPath(src, targetDirPath);
    if (dest === src) continue;
    const selected =
      typeof source === "string"
        ? collectDescendantArtifacts(artifacts, src)
        : source.isDir
          ? collectFolderDescendantArtifacts(artifacts, src)
          : artifacts.filter((artifact) =>
              source.rowId
                ? artifact.id === source.rowId && artifact.path === source.path
                : artifact.path === source.path,
            );
    for (const item of selected) {
      if (seenRowIds.has(item.id)) continue;
      seenRowIds.add(item.id);
      ops.push({
        rowId: item.id,
        oldPath: item.path,
        newPath: rebaseArtifactPath(item.path, src, dest),
      });
    }
  }
  return ops;
}

/** Reject dropping a folder onto itself or onto one of its descendants. */
export function isCyclicFolderDrop(dragFolderPath: string, targetDirPath: string): boolean {
  if (dragFolderPath === targetDirPath) return true;
  const nested = `${dragFolderPath}/`;
  return targetDirPath.startsWith(nested);
}

export function folderMarkerRowId(
  artifacts: readonly Pick<ArtifactDto, "id" | "path">[],
  folderPath: string,
): string | undefined {
  const markerPath = buildFolderMarkerPath(folderPath);
  return artifacts.find((a) => a.path === markerPath)?.id;
}

/** Non-marker descendant count for delete confirmation copy. */
export function countFolderChildren(
  artifacts: readonly Pick<ArtifactDto, "path">[],
  dirPrefix: string,
): number {
  const nestedPrefix = dirPrefix.length > 0 ? `${dirPrefix}/` : "";
  let count = 0;
  for (const a of artifacts) {
    if (isFolderMarkerPath(a.path)) continue;
    if (dirPrefix.length > 0 && a.path.startsWith(nestedPrefix)) count++;
  }
  return count;
}
