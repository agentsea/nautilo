import type { DesignDocument, DesignNode } from "./scene-graph";
import { jsonEqual } from "./json-equal";

export type SceneMergeConflict = {
  kind: "structural_change" | "same_target";
  affectedNodeIds: string[];
};

export type SceneMergeResult =
  | { ok: true; document: DesignDocument; mergedNodeIds: string[] }
  | { ok: false; conflict: SceneMergeConflict };

function structuralShape(node: DesignNode | undefined): unknown {
  if (!node) return null;
  return {
    id: node.id,
    type: node.type,
    parentId: node.parentId,
    childIds: node.childIds,
    ...(node.booleanOp !== undefined ? { booleanOp: node.booleanOp } : {}),
  };
}

function changedNodeIds(base: DesignDocument, candidate: DesignDocument): string[] {
  const ids = new Set([...Object.keys(base.nodes), ...Object.keys(candidate.nodes)]);
  return [...ids].filter((id) => !jsonEqual(base.nodes[id], candidate.nodes[id]));
}

function changedPageNodeIds(base: DesignDocument, candidate: DesignDocument): string[] {
  const ids = new Set<string>();
  const pages = new Map(base.pages.map((page) => [page.id, page]));
  for (const page of candidate.pages) {
    const prior = pages.get(page.id);
    if (!prior || !jsonEqual(prior.children, page.children) || prior.name !== page.name) {
      for (const id of prior?.children ?? []) ids.add(id);
      for (const id of page.children) ids.add(id);
    }
    pages.delete(page.id);
  }
  for (const page of pages.values()) for (const id of page.children) ids.add(id);
  return [...ids];
}

/**
 * Conservative three-way merge for one Design scene. It accepts independent
 * whole-node changes only; page/parent/child topology changes and same-node
 * edits remain reviewable conflicts instead of guessed reparenting.
 */
export function mergeThreeWayDesignScenes(
  base: DesignDocument,
  local: DesignDocument,
  remote: DesignDocument,
): SceneMergeResult {
  const localChanged = changedNodeIds(base, local);
  const remoteChanged = changedNodeIds(base, remote);
  const structuralIds = new Set<string>([
    ...changedPageNodeIds(base, local),
    ...changedPageNodeIds(base, remote),
  ]);
  const allNodeIds = new Set([...Object.keys(base.nodes), ...Object.keys(local.nodes), ...Object.keys(remote.nodes)]);
  for (const id of allNodeIds) {
    if (!jsonEqual(structuralShape(base.nodes[id]), structuralShape(local.nodes[id])) ||
        !jsonEqual(structuralShape(base.nodes[id]), structuralShape(remote.nodes[id]))) {
      structuralIds.add(id);
    }
  }
  if (structuralIds.size > 0) {
    return { ok: false, conflict: { kind: "structural_change", affectedNodeIds: [...structuralIds].sort() } };
  }

  const localSet = new Set(localChanged);
  const remoteSet = new Set(remoteChanged);
  const sameTarget = [...localSet].filter((id) => remoteSet.has(id) && !jsonEqual(local.nodes[id], remote.nodes[id]));
  if (sameTarget.length > 0) {
    return { ok: false, conflict: { kind: "same_target", affectedNodeIds: sameTarget.sort() } };
  }

  const nodes: Record<string, DesignNode> = {};
  for (const id of Object.keys(base.nodes)) {
    nodes[id] = localSet.has(id) ? local.nodes[id]! : remoteSet.has(id) ? remote.nodes[id]! : base.nodes[id]!;
  }
  return {
    ok: true,
    document: { ...remote, nodes },
    mergedNodeIds: [...new Set([...localChanged, ...remoteChanged])].sort(),
  };
}
