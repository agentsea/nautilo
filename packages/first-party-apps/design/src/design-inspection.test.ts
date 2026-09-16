import { describe, expect, test } from "bun:test";
import {
  designNodeHandle,
  designPageHandle,
  inspectOpenDesign,
  MAX_INSPECTION_PAGE_SIZE,
  nodeIdFromDesignHandle,
  pageIdFromDesignHandle,
  type PublicDesignInspectionItem,
  type PublicDesignInspectionNode,
  type PublicDesignInspectionPage,
} from "./design-inspection";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "./scene-graph";
import { editOpenDesign } from "./design-operations";

async function browserSha256Hex(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function inspectionDocument(): DesignDocument {
  const base = createEmptyDocument();
  const nodes = {
    frame: createNode({ id: "frame", type: "frame", parentId: null, name: "Frame", x: 0, y: 0, width: 400, height: 300, fills: [{ kind: "solid", color: "#fff" }] }),
    text: createNode({ id: "text", type: "text", parentId: "frame", name: "Greeting", x: 10, y: 10, width: 100, height: 20, text: "Hello", color: "#111" }),
    target: createNode({ id: "target", type: "rectangle", parentId: null, name: "Target", x: 500, y: 20, width: 80, height: 80, stroke: { color: "#222", width: 2 } }),
    pen: createNode({
      id: "pen", type: "vector", parentId: null, name: "Pen path", x: 10, y: 400, width: 100, height: 50,
      vectorNetwork: {
        vertices: [{ id: "private-v0", x: 0, y: 0 }, { id: "private-v1", x: 50, y: 20 }, { id: "private-v2", x: 100, y: 0 }],
        segments: [
          { id: "private-s0", startVertexId: "private-v0", endVertexId: "private-v1" },
          { id: "private-s1", startVertexId: "private-v1", endVertexId: "private-v2", startHandle: { x: 65, y: 40 }, endHandle: { x: 85, y: 40 } },
        ],
        regions: [],
      },
    }),
    connector: createNode({
      id: "connector", type: "vector", parentId: null, name: "Connector", x: 400, y: 50, width: 100, height: 0,
      connector: { route: "straight", start: { x: 400, y: 50 }, end: { x: 500, y: 50, targetId: "target", anchor: { x: 0, y: 0.5 } }, startArrow: true },
      vectorNetwork: { vertices: [], segments: [], regions: [] },
    }),
  };
  let document: DesignDocument = { ...base, nodes };
  document = appendChild(document, null, "frame", "page-1");
  document = appendChild(document, "frame", "text");
  document = appendChild(document, null, "target", "page-1");
  document = appendChild(document, null, "pen", "page-1");
  return appendChild(document, null, "connector", "page-1");
}

function itemsAcrossPages(doc: DesignDocument, options: Parameters<typeof inspectOpenDesign>[1]): PublicDesignInspectionItem[] {
  const items: PublicDesignInspectionItem[] = [];
  let cursor: string | undefined;
  do {
    const result = inspectOpenDesign(doc, { ...options, ...(cursor ? { cursor } : {}) });
    expect(result.ok).toBe(true);
    if (!result.ok) return items;
    items.push(...result.items);
    cursor = result.nextCursor;
  } while (cursor);
  return items;
}

describe("design inspection", () => {
  test("publishes collision-resistant opaque whole-resource semantic versions that change with state", async () => {
    const document = inspectionDocument();
    const original = inspectOpenDesign(document);
    if (!original.ok) throw new Error(original.message);
    const originalPage = original.items.find(
      (item): item is PublicDesignInspectionPage => item.kind === "page",
    );
    const originalTarget = original.items.find(
      (item): item is PublicDesignInspectionNode =>
        item.kind === "node" && item.handle === "node:target",
    );
    expect(originalPage?.semanticVersion).toMatch(/^s1:[a-f0-9]{64}$/);
    expect(originalTarget?.semanticVersion).toMatch(/^s1:[a-f0-9]{64}$/);
    expect(originalTarget?.semanticVersion).not.toContain("target");
    expect(originalPage?.semanticVersion).toBe(
      `s1:${await browserSha256Hex(JSON.stringify({ children: document.pages[0]!.children, id: "page-1", name: "Page 1" }))}`,
    );

    const nodeChanged = inspectOpenDesign({
      ...document,
      nodes: {
        ...document.nodes,
        target: { ...document.nodes["target"]!, stroke: { color: "#00f", width: 2 } },
      },
    });
    if (!nodeChanged.ok) throw new Error(nodeChanged.message);
    const changedTarget = nodeChanged.items.find(
      (item): item is PublicDesignInspectionNode =>
        item.kind === "node" && item.handle === "node:target",
    );
    const unchangedPage = nodeChanged.items.find(
      (item): item is PublicDesignInspectionPage => item.kind === "page",
    );
    expect(changedTarget?.semanticVersion).not.toBe(originalTarget?.semanticVersion);
    expect(unchangedPage?.semanticVersion).toBe(originalPage?.semanticVersion);

    const pageChanged = inspectOpenDesign({
      ...document,
      pages: [{ ...document.pages[0]!, name: "Renamed page" }],
    });
    if (!pageChanged.ok) throw new Error(pageChanged.message);
    expect(pageChanged.items.find(
      (item): item is PublicDesignInspectionPage => item.kind === "page",
    )?.semanticVersion)
      .not.toBe(originalPage?.semanticVersion);
  });

  test("publishes stable public node handles without accepting malformed handles", () => {
    const handle = designNodeHandle("shape / one");
    expect(handle).toBe("node:shape%20%2F%20one");
    expect(nodeIdFromDesignHandle(handle)).toBe("shape / one");
    expect(nodeIdFromDesignHandle("shape / one")).toBeNull();
    expect(nodeIdFromDesignHandle("node:%E0%A4%A")).toBeNull();
    expect(designPageHandle("page / one")).toBe("page:page%20%2F%20one");
    expect(pageIdFromDesignHandle("page:page%20%2F%20one")).toBe("page / one");
    expect(pageIdFromDesignHandle("page:%E0%A4%A")).toBeNull();
  });

  test("uses canonical page/tree order and cursors reconstruct the complete scene", () => {
    const document = inspectionDocument();
    const all = inspectOpenDesign(document);
    expect(all.ok).toBe(true);
    if (!all.ok) return;
    const paged = itemsAcrossPages(document, { pageSize: 2 });
    expect(paged).toEqual(all.items);
    expect(paged.map((item) => item.kind === "node" ? item.handle : item.kind === "page" ? item.handle : item.kind)).toEqual([
      "page:page-1", "node:frame", "node:text", "node:target", "node:pen", "node:connector",
    ]);
  });

  test("accounts for every returned and omitted item without a hidden small ceiling", () => {
    const document = inspectionDocument();
    const result = inspectOpenDesign(document, { pageSize: 3 });
    expect(result).toMatchObject({ ok: true, total: 6, returned: 3, omitted: 3, completeness: "partial" });
    if (!result.ok) return;
    expect(typeof result.nextCursor).toBe("string");
    expect(MAX_INSPECTION_PAGE_SIZE).toBeGreaterThan(1_000);

    const large: DesignDocument = { ...createEmptyDocument(), nodes: {} };
    for (let index = 0; index < 128; index++) {
      const id = `shape-${index}`;
      large.nodes[id] = createNode({ id, type: "rectangle", parentId: null, x: index, y: 0, width: 1, height: 1 });
      large.pages[0]!.children.push(id);
    }
    const bounded = inspectOpenDesign(large, { pageSize: 129 });
    expect(bounded).toMatchObject({ ok: true, returned: 129, total: 129, completeness: "complete" });
  });

  test("refuses malformed, stale, and out-of-range cursors", () => {
    const document = inspectionDocument();
    expect(inspectOpenDesign(document, { cursor: "not a cursor" })).toMatchObject({ ok: false, code: "invalid_cursor" });
    const first = inspectOpenDesign(document, { pageSize: 1 });
    expect(first.ok).toBe(true);
    if (!first.ok || !first.nextCursor) return;
    const changed = { ...document, nodes: { ...document.nodes, text: { ...document.nodes["text"]!, text: "Changed" } } };
    expect(inspectOpenDesign(changed, { pageSize: 1, cursor: first.nextCursor })).toMatchObject({ ok: false, code: "stale_cursor" });
    expect(inspectOpenDesign(document, { pageSize: 1, connector: "exclude", cursor: first.nextCursor })).toMatchObject({ ok: false, code: "stale_cursor" });
  });

  test("uses separately supplied selection, model filters, and connector detail", () => {
    const document = inspectionDocument();
    const selected = inspectOpenDesign(document, { selectedNodeHandles: [designNodeHandle("target"), designNodeHandle("missing")] });
    expect(selected).toMatchObject({ ok: true, matchedNodeCount: 1, selectedNodeHandles: ["node:target"], missingSelectedNodeHandles: ["node:missing"] });
    if (!selected.ok) return;
    expect(selected.items).toMatchObject([{ kind: "node", handle: "node:target", appearance: { stroke: { color: "#222", width: 2 } } }]);

    const connector = inspectOpenDesign(document, { connector: "only" });
    expect(connector).toMatchObject({ ok: true, matchedNodeCount: 1 });
    if (!connector.ok) return;
    expect(connector.items).toMatchObject([{
      kind: "node", handle: "node:connector", connector: {
        route: "straight", startArrow: true, end: { targetHandle: "node:target", anchor: { x: 0, y: 0.5 } },
      },
    }]);

    const spatial = inspectOpenDesign(document, { intersects: { x: 495, y: 15, width: 90, height: 90 }, nodeTypes: ["rectangle"] });
    expect(spatial).toMatchObject({ ok: true, matchedNodeCount: 1 });

    const topLevel = inspectOpenDesign(document, { parentHandle: null });
    expect(topLevel).toMatchObject({ ok: true, matchedNodeCount: 4 });
    const page = inspectOpenDesign(document, { pageHandle: designPageHandle("page-1") });
    expect(page).toMatchObject({ ok: true, matchedNodeCount: 5 });
  });

  test("pages normalized path geometry without private renderer vertex or segment ids", () => {
    const document = inspectionDocument();
    const items = itemsAcrossPages(document, { nodeHandle: designNodeHandle("pen"), includeGeometry: true, pageSize: 2 });
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ kind: "node", handle: "node:pen", vector: { geometryCompleteness: "complete", pathCommandCount: 3 } });
    expect(items.slice(1)).toMatchObject([
      { kind: "path-command", commandIndex: 0, coordinateSpace: "node-local-normalized", command: { kind: "M", x: 0, y: 0 } },
      { kind: "path-command", commandIndex: 1, command: { kind: "L", x: 0.5, y: 0.4 } },
      { kind: "path-command", commandIndex: 2, command: { kind: "C", c1x: 0.65, c1y: 0.8, c2x: 0.85, c2y: 0.8, x: 1, y: 0 } },
    ]);
    const serialized = JSON.stringify(items);
    expect(serialized).not.toContain("private-v");
    expect(serialized).not.toContain("private-s");
  });

  test("round-trips inspected Pen commands into expectedGeometry for revision", () => {
    const document = inspectionDocument();
    const inspected = inspectOpenDesign(document, { nodeHandle: designNodeHandle("pen"), includeGeometry: true });
    if (!inspected.ok) throw new Error(inspected.message);
    const expectedGeometry = inspected.items
      .filter((item) => item.kind === "path-command")
      .map((item) => item.command);
    const revised = editOpenDesign(document, {
      idempotencyKey: "inspection-round-trip",
      operations: [{
        op: "path",
        nodeId: designNodeHandle("pen"),
        bounds: { x: 10, y: 400, width: 100, height: 50 },
        expectedGeometry,
        commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }],
      }],
    });
    expect(revised.ok).toBe(true);
    if (!revised.ok) return;
    expect(revised.receipt.changedNodeHandles).toContain("node:pen");
  });

  test("marks zero-dimension geometry unavailable instead of dividing by zero", () => {
    const base = createEmptyDocument();
    const flat = createNode({
      id: "flat",
      type: "vector",
      parentId: null,
      width: 100,
      height: 0,
      vectorNetwork: {
        vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 100, y: 0 }],
        segments: [{ id: "ab", startVertexId: "a", endVertexId: "b" }],
        regions: [],
      },
    });
    const document = appendChild({ ...base, nodes: { flat } }, null, "flat", "page-1");
    const inspected = inspectOpenDesign(document, { nodeHandle: designNodeHandle("flat"), includeGeometry: true });
    expect(inspected).toMatchObject({
      ok: true,
      total: 1,
      items: [{
        kind: "node",
        handle: "node:flat",
        vector: { geometryCompleteness: "unavailable", pathCommandCount: 0, geometryOmittedReason: "zero_height" },
      }],
    });
    if (!inspected.ok) return;
    expect(inspected.items.some((item) => item.kind === "path-command")).toBe(false);
    expect(JSON.stringify(inspected)).not.toContain("Infinity");
  });
});
