export type ArtifactSortMode = "name" | "modified" | "size";
export type ArtifactSortDir = "asc" | "desc";

export interface ArtifactSortConfig {
  mode: ArtifactSortMode;
  dir: ArtifactSortDir;
  /** Pin directories above files regardless of the active field. */
  foldersFirst: boolean;
}

export interface ArtifactSortableNode {
  name: string;
  isDir: boolean;
  updatedAt?: string;
  size?: number;
}

export const DEFAULT_ARTIFACT_SORT_CONFIG: ArtifactSortConfig = {
  mode: "name",
  dir: "asc",
  foldersFirst: true,
};

function parseUpdatedAtMs(value: string | undefined): number {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Comparator used when building/sorting the artifact tree. `foldersFirst`
 * short-circuits the field compare; name is the stable tiebreaker.
 */
export function compareArtifactNodes(
  a: ArtifactSortableNode,
  b: ArtifactSortableNode,
  cfg: ArtifactSortConfig,
): number {
  if (cfg.foldersFirst && a.isDir !== b.isDir) {
    return a.isDir ? -1 : 1;
  }
  let cmp = 0;
  switch (cfg.mode) {
    case "modified":
      cmp = parseUpdatedAtMs(a.updatedAt) - parseUpdatedAtMs(b.updatedAt);
      break;
    case "size":
      cmp = (a.size ?? 0) - (b.size ?? 0);
      break;
    case "name":
    default:
      cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
      break;
  }
  if (cmp === 0) {
    cmp = a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
  }
  return cfg.dir === "asc" ? cmp : -cmp;
}
