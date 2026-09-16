/** Canonical structural edits. Coordinates remain absolute when ownership changes. */
import { createNode, nextNodeId, nextPageId, removeNode, validateDesignDocument, type DesignDocument, type DesignNode } from "./scene-graph";
import { detachConnectorsForDeleted, resolveConnectorEndpoint } from "./editor/connector";
import { nodeVisualBounds } from "./geometry";
import type { DesignTransactionResult } from "./transactions";

export type DesignFragment = { roots: string[]; nodes: DesignNode[] };
export type OrganizationTransaction =
  | { kind: "group"; nodeIds: string[]; name?: string }
  | { kind: "ungroup"; nodeIds: string[] }
  | { kind: "reparent"; nodeIds: string[]; parentId: string | null; pageId: string }
  | { kind: "duplicate"; nodeIds: string[]; dx: number; dy: number }
  | { kind: "insert"; fragment: DesignFragment; pageId: string; dx: number; dy: number }
  | { kind: "flags"; nodeIds: string[]; hidden?: boolean; locked?: boolean }
  | { kind: "page-edit"; action: "rename" | "delete"; pageId: string; name?: string }
  | { kind: "page-order"; pageIds: string[] };

export function subtreeIds(doc: DesignDocument, roots: readonly string[]): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const pending = [...roots].reverse();
  while (pending.length) {
    const id = pending.pop()!;
    const node = doc.nodes[id];
    if (!node || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
    pending.push(...[...node.childIds].reverse());
  }
  return ids;
}

/** Selecting a parent and child must never apply an operation twice. */
export function selectionRoots(doc: DesignDocument, ids: readonly string[]): string[] {
  const selected = new Set(ids);
  return [...selected].filter((id) => {
    let node = doc.nodes[id];
    if (!node) return false;
    const seen = new Set<string>();
    while (node.parentId !== null) {
      if (selected.has(node.parentId) || seen.has(node.parentId)) return false;
      seen.add(node.parentId);
      node = doc.nodes[node.parentId];
      if (!node) return false;
    }
    return true;
  });
}

export function copyDesignFragment(doc: DesignDocument, ids: readonly string[]): DesignFragment {
  const roots = selectionRoots(doc, ids);
  const copied = subtreeIds(doc, roots);
  const included = new Set(copied);
  return {
    roots,
    nodes: copied.map((id) => {
      const node = structuredClone(doc.nodes[id]!);
      if (!included.has(node.parentId ?? "")) node.parentId = null;
      // A copied connector retains a free endpoint when its target is outside the fragment.
      if (node.connector) {
        for (const key of ["start", "end"] as const) {
          const endpoint = node.connector[key];
          if (endpoint.targetId && !included.has(endpoint.targetId)) {
            const { targetId: _target, anchor: _anchor, ...free } = endpoint;
            node.connector[key] = { ...free, ...resolveConnectorEndpoint(doc, endpoint) };
          }
        }
      }
      return node;
    }),
  };
}

function error(message: string, path = "request"): DesignTransactionResult {
  return { ok: false, error: { code: "invalid_request", message, path } };
}

function siblingIds(doc: DesignDocument, node: DesignNode): string[] {
  return node.parentId === null
    ? doc.pages.find((page) => page.children.includes(node.id))?.children ?? []
    : doc.nodes[node.parentId]?.childIds ?? [];
}

function setSiblings(doc: DesignDocument, node: DesignNode, ids: string[]): void {
  if (node.parentId !== null) doc.nodes[node.parentId]!.childIds = ids;
  else {
    const page = doc.pages.find((candidate) => candidate.children.includes(node.id));
    if (!page) throw new Error("Object is not attached to a page.");
    page.children = ids;
  }
}

function translateCopy(node: DesignNode, dx: number, dy: number): void {
  node.x += dx;
  node.y += dy;
  if (node.connector) for (const key of ["start", "end"] as const) {
    node.connector[key].x += dx;
    node.connector[key].y += dy;
  }
}

function insertFragment(doc: DesignDocument, fragment: DesignFragment, pageId: string, dx: number, dy: number): string[] {
  if (!fragment || !Array.isArray(fragment.roots) || !Array.isArray(fragment.nodes) || fragment.roots.length === 0) throw new Error("Clipboard contains no design objects.");
  if (!Number.isFinite(dx) || !Number.isFinite(dy)) throw new Error("Offsets must be finite numbers.");
  const page = doc.pages.find((candidate) => candidate.id === pageId);
  if (!page) throw new Error("Destination page does not exist.");
  const sourceNodes = Object.fromEntries(fragment.nodes.map((node) => [node.id, node]));
  if (Object.keys(sourceNodes).length !== fragment.nodes.length) throw new Error("Clipboard object ids must be unique.");
  const validated = validateDesignDocument({ version: 1, pages: [{ id: "clipboard-page", name: "Clipboard", children: fragment.roots }], nodes: sourceNodes });
  const mapping = new Map<string, string>();
  for (const node of Object.values(validated.nodes)) {
    const id = nextNodeId(doc);
    mapping.set(node.id, id);
    doc.nodes[id] = { ...node, id };
  }
  for (const [oldId, id] of mapping) {
    const node = structuredClone(validated.nodes[oldId]!);
    node.id = id;
    node.parentId = node.parentId ? mapping.get(node.parentId)! : null;
    node.childIds = node.childIds.map((child) => mapping.get(child)!);
    if (node.connector) for (const key of ["start", "end"] as const) {
      const endpoint = node.connector[key];
      if (endpoint.targetId) endpoint.targetId = mapping.get(endpoint.targetId)!;
    }
    translateCopy(node, dx, dy);
    doc.nodes[id] = node;
  }
  const roots = fragment.roots.map((id) => mapping.get(id)!);
  page.children.push(...roots);
  return roots;
}

export function applyOrganizationTransaction(original: DesignDocument, request: OrganizationTransaction): DesignTransactionResult {
  try {
    const known: Record<OrganizationTransaction["kind"], string[]> = {
      group: ["kind", "nodeIds", "name"], ungroup: ["kind", "nodeIds"], reparent: ["kind", "nodeIds", "parentId", "pageId"],
      duplicate: ["kind", "nodeIds", "dx", "dy"], insert: ["kind", "fragment", "pageId", "dx", "dy"],
      flags: ["kind", "nodeIds", "hidden", "locked"], "page-edit": ["kind", "action", "pageId", "name"], "page-order": ["kind", "pageIds"],
    };
    const unknown = Object.keys(request).find((key) => !known[request.kind].includes(key));
    if (unknown) return error(`Unknown field: ${unknown}.`, `request.${unknown}`);
    let doc = structuredClone(original);
    let roots: string[] = [];
    if ("nodeIds" in request) {
      if (!Array.isArray(request.nodeIds) || request.nodeIds.length === 0 || new Set(request.nodeIds).size !== request.nodeIds.length || request.nodeIds.some((id) => typeof id !== "string" || !doc.nodes[id])) return error("Choose distinct existing objects.", "nodeIds");
      roots = selectionRoots(doc, request.nodeIds);
    }
    let primaryIds: string[] = [];
    switch (request.kind) {
      case "group": {
        if (roots.length < 2) return error("Select at least two sibling objects.", "nodeIds");
        const first = doc.nodes[roots[0]!]!;
        const siblings = siblingIds(doc, first);
        if (!roots.every((id) => siblings.includes(id))) return error("Group objects on the same page and level.", "nodeIds");
        if (request.name !== undefined && (typeof request.name !== "string" || !request.name.trim())) return error("Group name cannot be empty.", "name");
        const ordered = siblings.filter((id) => roots.includes(id));
        const nodes = ordered.map((id) => doc.nodes[id]!);
        const boxes = nodes.map(nodeVisualBounds);
        const x = Math.min(...boxes.map((box) => box.minX));
        const y = Math.min(...boxes.map((box) => box.minY));
        const id = nextNodeId(doc);
        const group = createNode({ id, type: "group", parentId: first.parentId, name: request.name ?? "Group", x, y,
          width: Math.max(...boxes.map((box) => box.maxX)) - x, height: Math.max(...boxes.map((box) => box.maxY)) - y });
        group.childIds = ordered;
        const index = Math.max(...ordered.map((id) => siblings.indexOf(id)));
        const next = siblings.filter((id) => !ordered.includes(id));
        next.splice(siblings.slice(0, index).filter((id) => !ordered.includes(id)).length, 0, id);
        setSiblings(doc, first, next);
        doc.nodes[id] = group;
        for (const child of ordered) doc.nodes[child]!.parentId = id;
        primaryIds = [id];
        break;
      }
      case "ungroup": {
        for (const id of roots) {
          const group = doc.nodes[id]!;
          if (group.type !== "group" || group.booleanOp) return error("Only ordinary groups can be ungrouped. Boolean operands remain editable in Layers.", "nodeIds");
          if ((group.opacity ?? 1) !== 1 && group.childIds.length > 1) return error("Set group opacity to 100% before ungrouping to preserve overlapping paint.", "nodeIds");
          doc = detachConnectorsForDeleted(doc, new Set([id]));
          const siblings = siblingIds(doc, group);
          setSiblings(doc, group, siblings.flatMap((child) => child === id ? group.childIds : [child]));
          for (const child of group.childIds) {
            const node = doc.nodes[child]!;
            node.parentId = group.parentId;
            if (group.opacity !== undefined) node.opacity = (node.opacity ?? 1) * group.opacity;
            if (group.hidden) node.hidden = true;
            if (group.locked) node.locked = true;
          }
          primaryIds.push(...group.childIds);
          delete doc.nodes[id];
        }
        break;
      }
      case "reparent": {
        const destination = request.parentId === null ? doc.pages.find((page) => page.id === request.pageId) : doc.nodes[request.parentId];
        if (!destination || ("type" in destination && (destination.booleanOp || !["frame", "group"].includes(destination.type)))) return error("Choose an existing page, frame, or ordinary group.", "parentId");
        const targetPage = doc.pages.find((page) => page.id === request.pageId);
        if (!targetPage || (request.parentId !== null && !subtreeIds(doc, targetPage.children).includes(request.parentId))) return error("Destination parent must belong to the destination page.", "pageId");
        if (request.parentId !== null && subtreeIds(doc, roots).includes(request.parentId)) return error("An object cannot contain itself or an ancestor.", "parentId");
        for (const id of roots) {
          const node = doc.nodes[id]!;
          setSiblings(doc, node, siblingIds(doc, node).filter((child) => child !== id));
          node.parentId = request.parentId;
          if ("children" in destination) destination.children.push(id);
          else destination.childIds.push(id);
        }
        const pagesByNode = new Map(doc.pages.flatMap((page) =>
          subtreeIds(doc, page.children).map((id) => [id, page.id] as const)));
        for (const node of Object.values(doc.nodes)) {
          if (!node.connector) continue;
          for (const key of ["start", "end"] as const) {
            const endpoint = node.connector[key];
            if (!endpoint.targetId || pagesByNode.get(endpoint.targetId) === pagesByNode.get(node.id)) continue;
            node.connector[key] = {
              ...resolveConnectorEndpoint(doc, endpoint),
              detachedFromTargetId: endpoint.targetId,
            };
          }
        }
        primaryIds = roots;
        break;
      }
      case "duplicate": {
        const page = doc.pages.find((candidate) => subtreeIds(doc, candidate.children).includes(roots[0]!));
        if (!page || !roots.every((id) => subtreeIds(doc, page.children).includes(id))) return error("Duplicate objects from one page.", "nodeIds");
        primaryIds = insertFragment(doc, copyDesignFragment(original, roots), page.id, request.dx, request.dy);
        for (let i = 0; i < roots.length; i++) {
          const source = original.nodes[roots[i]!]!;
          const clone = doc.nodes[primaryIds[i]!]!;
          page.children = page.children.filter((id) => id !== clone.id);
          clone.parentId = source.parentId;
          const siblings = siblingIds(doc, source);
          const next = [...siblings];
          next.splice(next.indexOf(source.id) + 1, 0, clone.id);
          setSiblings(doc, source, next);
        }
        break;
      }
      case "insert": primaryIds = insertFragment(doc, request.fragment, request.pageId, request.dx, request.dy); break;
      case "flags":
        for (const key of ["hidden", "locked"] as const) {
          if (request[key] !== undefined && typeof request[key] !== "boolean") return error(`${key} must be a boolean.`, key);
          if (request[key] !== undefined) for (const id of request.nodeIds) doc.nodes[id]![key] = request[key];
        }
        primaryIds = request.nodeIds;
        break;
      case "page-edit": {
        const page = doc.pages.find((candidate) => candidate.id === request.pageId);
        if (!page) return error("Page does not exist.", "pageId");
        if (request.action === "rename") {
          if (typeof request.name !== "string" || !request.name.trim()) return error("Page name cannot be empty.", "name");
          page.name = request.name.trim();
        } else if (request.action === "delete") {
          const replacementId = nextPageId(doc);
          doc = detachConnectorsForDeleted(doc, new Set(subtreeIds(doc, page.children)));
          for (const id of [...page.children]) doc = removeNode(doc, id);
          doc.pages = doc.pages.filter((candidate) => candidate.id !== request.pageId);
          if (!doc.pages.length) doc.pages = [{ id: replacementId, name: "Page 1", children: [] }];
        } else return error("Choose rename or delete.", "action");
        break;
      }
      case "page-order":
        if (!Array.isArray(request.pageIds) || request.pageIds.length !== doc.pages.length || new Set(request.pageIds).size !== doc.pages.length || request.pageIds.some((id) => !doc.pages.some((page) => page.id === id))) return error("Page order must contain every page exactly once.", "pageIds");
        doc.pages = request.pageIds.map((id) => doc.pages.find((page) => page.id === id)!);
        break;
    }
    doc = validateDesignDocument(doc);
    const changed = [...new Set([...Object.keys(original.nodes), ...Object.keys(doc.nodes)])].filter((id) => JSON.stringify(original.nodes[id]) !== JSON.stringify(doc.nodes[id]));
    const changedPageIds = [...new Set([...original.pages.map((page) => page.id), ...doc.pages.map((page) => page.id)])].filter((id) => JSON.stringify(original.pages.find((page) => page.id === id)) !== JSON.stringify(doc.pages.find((page) => page.id === id)));
    const reordered = original.pages.some((page, i) => doc.pages[i]?.id !== page.id);
    const applied = changed.length > 0 || changedPageIds.length > 0 || reordered;
    return { ok: true, document: applied ? doc : original, receipt: { kind: request.kind, outcome: applied ? "applied" : "noop",
      changedNodeIds: [...primaryIds.filter((id) => changed.includes(id)), ...changed.filter((id) => !primaryIds.includes(id))],
      ...(changedPageIds.length || reordered ? { changedPageIds: reordered ? doc.pages.map((page) => page.id) : changedPageIds } : {}) } };
  } catch (cause) { return error(cause instanceof Error ? cause.message : "Invalid organization request."); }
}
