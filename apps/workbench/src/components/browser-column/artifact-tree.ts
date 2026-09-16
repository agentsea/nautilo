import type { ArtifactDto } from "@nautilo/api-client/browser";
import {
  compareArtifactNodes,
  DEFAULT_ARTIFACT_SORT_CONFIG,
  type ArtifactSortConfig,
} from "./artifact-sort";

export type { ArtifactSortConfig } from "./artifact-sort";

/** Permanent placeholder artifact that keeps empty virtual folders in the trie. */
const FOLDER_MARKER_BASENAME = ".nautilo-keep.md";

export function isFolderMarkerPath(path: string): boolean {
  return path === FOLDER_MARKER_BASENAME || path.endsWith(`/${FOLDER_MARKER_BASENAME}`);
}

export function buildFolderMarkerPath(folderPath: string): string {
  return folderPath.length > 0
    ? `${folderPath}/${FOLDER_MARKER_BASENAME}`
    : FOLDER_MARKER_BASENAME;
}

export function collectSiblingNamesAt(
  artifacts: readonly { path: string }[],
  parentPath: string,
): string[] {
  const names = new Set<string>();
  const prefix = parentPath.length > 0 ? `${parentPath}/` : "";
  for (const a of artifacts) {
    let rest: string;
    if (parentPath.length === 0) {
      rest = a.path;
    } else {
      if (!a.path.startsWith(prefix)) continue;
      rest = a.path.slice(prefix.length);
    }
    const seg = rest.split("/")[0];
    if (seg && seg.length > 0) names.add(seg);
  }
  return [...names];
}

export interface ArtifactTreeNode {
  /** Stable UI identity: internal artifact row ID for files, logical path for folders. */
  key: string;
  name: string;
  /** Presentation-only label used to distinguish rows that share a logical path. */
  label: string;
  path: string;
  isDir: boolean;
  children?: ArtifactTreeNode[];
  artifactId?: string;
  rowId?: string;
  mimeType?: string;
  size?: number;
  updatedAt?: string;
}

interface TrieNode {
  name: string;
  path: string;
  children: Map<string, TrieNode>;
  files: ArtifactDto[];
}

function artifactTreeFileKey(rowId: string): string {
  return `artifact:${rowId}`;
}

function artifactTreeDirectoryKey(path: string): string {
  return `directory:${path}`;
}

function insertArtifact(root: Map<string, TrieNode>, dto: ArtifactDto): void {
  const parts = dto.path.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return;

  let map = root;
  let prefix = "";
  for (let i = 0; i < parts.length; i++) {
    const seg = parts[i];
    const path = prefix ? `${prefix}/${seg}` : seg;
    const isLeaf = i === parts.length - 1;

    let node = map.get(seg);
    if (!node) {
      node = { name: seg, path, children: new Map(), files: [] };
      map.set(seg, node);
    }

    if (isLeaf) {
      node.files.push(dto);
    } else {
      prefix = path;
      map = node.children;
    }
  }
}

function sortNodes(nodes: ArtifactTreeNode[], sortConfig: ArtifactSortConfig): ArtifactTreeNode[] {
  return [...nodes].sort((a, b) => {
    const compared = compareArtifactNodes(a, b, sortConfig);
    return compared !== 0 ? compared : a.key.localeCompare(b.key);
  });
}

function shortestUniqueIdPrefix(id: string, ids: readonly string[]): string {
  for (let length = 1; length <= id.length; length++) {
    const prefix = id.slice(0, length);
    if (ids.every((candidate) => candidate === id || !candidate.startsWith(prefix))) {
      return prefix;
    }
  }
  return id;
}

function trieMapToForest(
  map: Map<string, TrieNode>,
  sortConfig: ArtifactSortConfig,
): ArtifactTreeNode[] {
  const list = [...map.values()].flatMap((node) => {
    const hasDirectory = node.children.size > 0;
    const duplicateFileIds = node.files.map((file) => file.id);
    const hasDuplicateFiles = duplicateFileIds.length > 1;
    const entries: ArtifactTreeNode[] = [];
    if (hasDirectory) {
      const children = sortNodes(trieMapToForest(node.children, sortConfig), sortConfig);
      entries.push({
        key: artifactTreeDirectoryKey(node.path),
        name: node.name,
        label: node.files.length > 0 ? `${node.name} · folder` : node.name,
        path: node.path,
        isDir: true,
        children,
      });
    }
    for (const dto of node.files) {
      entries.push({
        key: artifactTreeFileKey(dto.id),
        name: node.name,
        label: hasDuplicateFiles
          ? `${node.name} · ${shortestUniqueIdPrefix(dto.id, duplicateFileIds)}`
          : hasDirectory
            ? `${node.name} · file`
            : node.name,
        path: dto.path,
        isDir: false,
        artifactId: dto.artifactId,
        rowId: dto.id,
        mimeType: dto.mimeType,
        size: dto.size,
        updatedAt: dto.updatedAt,
      });
    }
    return entries;
  });
  return sortNodes(list, sortConfig);
}

export function buildTreeFromArtifacts(
  artifacts: ArtifactDto[],
  sortConfig: ArtifactSortConfig = DEFAULT_ARTIFACT_SORT_CONFIG,
): ArtifactTreeNode[] {
  const root = new Map<string, TrieNode>();
  for (const dto of artifacts) {
    insertArtifact(root, dto);
  }
  return trieMapToForest(root, sortConfig);
}

export interface ArtifactFlatRow {
  node: ArtifactTreeNode;
  depth: number;
}

export function flattenTreeForRendering(
  roots: ArtifactTreeNode[],
  expandedDirs: ReadonlySet<string>,
): ArtifactFlatRow[] {
  const rows: ArtifactFlatRow[] = [];

  const walk = (nodes: ArtifactTreeNode[], depth: number) => {
    for (const node of nodes) {
      if (!node.isDir && isFolderMarkerPath(node.path)) continue;
      rows.push({ node, depth });
      if (node.isDir && node.children && expandedDirs.has(node.path)) {
        walk(node.children, depth + 1);
      }
    }
  };

  walk(roots, 0);
  return rows;
}
