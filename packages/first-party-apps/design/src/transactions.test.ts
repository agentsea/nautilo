import { describe, expect, test } from "bun:test";
import { appendChild, createEmptyDocument, createNode, type DesignDocument } from "./scene-graph";
import {
  applyDesignTransaction,
  type DesignTransactionResult,
} from "./transactions";

const applyRuntimeRequest = applyDesignTransaction as (
  document: DesignDocument,
  request: unknown,
) => DesignTransactionResult;

function documentWithNodes(): DesignDocument {
  const base = createEmptyDocument();
  const a = createNode({ id: "node-1", type: "rectangle", parentId: null, x: 0, y: 0, width: 20, height: 10 });
  const b = createNode({ id: "node-2", type: "rectangle", parentId: null, x: 50, y: 20, width: 10, height: 10 });
  const c = createNode({ id: "node-3", type: "text", parentId: null, x: 100, y: 40, width: 10, height: 20, text: "Old" });
  return appendChild(
    appendChild(
      appendChild({ ...base, nodes: { "node-1": a, "node-2": b, "node-3": c } }, null, "node-1", "page-1"),
      null,
      "node-2",
      "page-1",
    ),
    null,
    "node-3",
    "page-1",
  );
}

describe("applyDesignTransaction", () => {
  test("creates a validated text node and returns its durable receipt", () => {
    const result = applyDesignTransaction(createEmptyDocument(), {
      kind: "create",
      node: {
        type: "text",
        name: "Headline",
        x: 12,
        y: 24,
        style: { fills: [{ kind: "solid", color: "#123456" }], opacity: 0.5 },
        text: { text: "Hello", fontSize: 24, textAlign: "center" },
      },
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: { kind: "create", outcome: "applied", changedNodeIds: ["node-1"] },
    });
    if (!result.ok) return;
    expect(result.document.nodes["node-1"]).toMatchObject({
      type: "text",
      name: "Headline",
      x: 12,
      y: 24,
      text: "Hello",
      fontSize: 24,
      textAlign: "center",
      fontFamily: "Nautilo Noto Sans",
      opacity: 0.5,
    });
  });

  test("normalizes applied style payloads without retaining caller aliases", () => {
    const fills = [{ kind: "solid" as const, color: "#123456" }];
    const stroke = { color: "#111111", width: 2, dash: [2, 3] };
    const created = applyDesignTransaction(createEmptyDocument(), {
      kind: "create",
      node: { type: "rectangle", style: { fills, stroke } },
    });
    if (!created.ok) throw new Error(created.error.message);
    fills[0]!.color = "#ffffff";
    stroke.color = "#ffffff";
    stroke.dash[0] = 99;
    expect(created.document.nodes["node-1"]?.fills).toEqual([{ kind: "solid", color: "#123456" }]);
    expect(created.document.nodes["node-1"]?.stroke).toEqual({ color: "#111111", width: 2, dash: [2, 3] });

    const replacement = [{ kind: "solid" as const, color: "#abcdef" }];
    const styled = applyDesignTransaction(created.document, {
      kind: "style", nodeIds: ["node-1"], patch: { fills: replacement },
    });
    if (!styled.ok) throw new Error(styled.error.message);
    replacement[0]!.color = "#000000";
    expect(styled.document.nodes["node-1"]?.fills).toEqual([{ kind: "solid", color: "#abcdef" }]);
  });

  test("creates a validated durable vector network without a parallel primitive format", () => {
    const result = applyDesignTransaction(createEmptyDocument(), {
      kind: "create",
      node: {
        type: "vector",
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        vectorNetwork: {
          vertices: [{ id: "v0", x: 0, y: 0 }, { id: "v1", x: 30, y: 40 }],
          segments: [{ id: "s0", startVertexId: "v0", endVertexId: "v1" }],
          regions: [],
        },
        style: { stroke: { color: "#000000", width: 2 } },
      },
    });
    expect(result).toMatchObject({ ok: true, receipt: { kind: "create", changedNodeIds: ["node-1"] } });
    if (!result.ok) return;
    expect(result.document.nodes["node-1"]?.type).toBe("vector");
    expect(result.document.nodes["node-1"]?.vectorNetwork?.vertices[0]).toEqual({ id: "v0", x: 0, y: 0 });
  });

  test("creates children only inside frames and ordinary groups", () => {
    for (const parent of [
      createNode({ id: "parent", type: "rectangle", parentId: null }),
      createNode({ id: "parent", type: "text", parentId: null }),
      createNode({ id: "parent", type: "vector", parentId: null }),
      createNode({ id: "parent", type: "group", parentId: null, booleanOp: "union" }),
    ]) {
      const doc = appendChild({ ...createEmptyDocument(), nodes: { parent } }, null, "parent", "page-1");
      const result = applyDesignTransaction(doc, { kind: "create", parentId: "parent", node: { type: "rectangle" } });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", path: "parentId" } });
      expect(doc.nodes["parent"]?.childIds).toEqual([]);
    }

    const group = createNode({ id: "parent", type: "group", parentId: null });
    const groupDoc = appendChild({ ...createEmptyDocument(), nodes: { parent: group } }, null, "parent", "page-1");
    expect(applyDesignTransaction(groupDoc, {
      kind: "create", parentId: "parent", pageId: "page-missing", node: { type: "rectangle" },
    })).toMatchObject({ ok: false, error: { code: "invalid_request", path: "pageId" } });
    expect(applyDesignTransaction(groupDoc, {
      kind: "create", parentId: "parent", pageId: "page-1", node: { type: "rectangle" },
    })).toMatchObject({ ok: true, document: { nodes: { "node-1": { parentId: "parent" } } } });
  });

  test("accepts connector attachments only to eligible targets on the connector page", () => {
    const doc = createEmptyDocument();
    doc.pages.push({ id: "page-2", name: "Page 2", children: ["other-page"] });
    doc.pages[0]!.children = ["shape", "label", "open"];
    doc.nodes = {
      shape: createNode({ id: "shape", type: "rectangle", parentId: null, width: 40, height: 40 }),
      label: createNode({ id: "label", type: "text", parentId: null, width: 40, height: 20 }),
      open: createNode({
        id: "open", type: "vector", parentId: null, width: 40, height: 10,
        vectorNetwork: {
          vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 40, y: 10 }],
          segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }],
          regions: [],
        },
      }),
      "other-page": createNode({ id: "other-page", type: "rectangle", parentId: null, x: 100, width: 40, height: 40 }),
    };
    const network = {
      vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 40, y: 0 }],
      segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }],
      regions: [],
    };
    const createConnector = (targetId: string) => applyDesignTransaction(doc, {
      kind: "create",
      pageId: "page-1",
      node: {
        type: "vector",
        width: 40,
        vectorNetwork: network,
        connector: {
          route: "straight",
          start: { x: 0, y: 20, targetId, anchor: { x: 0, y: 0.5 } },
          end: { x: 40, y: 20 },
        },
      },
    });
    const created = createConnector("shape");
    expect(created.ok).toBe(true);
    for (const targetId of ["label", "open", "other-page"]) {
      expect(createConnector(targetId)).toMatchObject({
        ok: false,
        error: { code: "invalid_request", path: "node.connector.start.targetId" },
      });
    }
    if (!created.ok) return;
    const connectorId = created.receipt.changedNodeIds[0]!;
    expect(applyDesignTransaction(created.document, {
      kind: "connector",
      nodeId: connectorId,
      patch: { start: { x: 100, y: 20, targetId: "other-page", anchor: { x: 0, y: 0.5 } } },
    })).toMatchObject({ ok: false, error: { code: "invalid_request", path: "patch.start.targetId" } });

    // Existing documents can still change route/arrow settings without forcing
    // an unrelated legacy attachment migration in the same transaction.
    const legacy = structuredClone(created.document);
    legacy.nodes[connectorId]!.connector!.start = {
      x: 100, y: 20, targetId: "other-page", anchor: { x: 0, y: 0.5 },
    };
    expect(applyDesignTransaction(legacy, {
      kind: "connector", nodeId: connectorId, patch: { route: "elbow" },
    })).toMatchObject({ ok: true, document: { nodes: { [connectorId]: { connector: { route: "elbow" } } } } });
  });

  test("normalizes validated vector nodes and strips hostile network fields before persistence", () => {
    const doc = createEmptyDocument();
    const validNetwork = {
      vertices: [{ id: "v0", x: 0, y: 0 }, { id: "v1", x: 20, y: 10 }],
      segments: [{ id: "s0", startVertexId: "v0", endVertexId: "v1" }],
      regions: [],
    };
    const valid = applyRuntimeRequest(doc, { kind: "create", node: { type: "vector", vectorNetwork: validNetwork } });
    if (!valid.ok) throw new Error("valid vector network should normalize");
    validNetwork.vertices[0]!.x = 999;
    expect(valid.document.nodes["node-1"]?.vectorNetwork?.vertices[0]?.x).toBe(0);
    for (const vectorNetwork of [
      { ...validNetwork, injected: true },
      { ...validNetwork, vertices: [{ ...validNetwork.vertices[0]!, injected: true }, validNetwork.vertices[1]! ] },
      { ...validNetwork, segments: [{ ...validNetwork.segments[0]!, injected: true }] },
    ]) {
      const result = applyRuntimeRequest(doc, {
        kind: "create",
        node: { type: "vector", vectorNetwork },
      });
      if (!result.ok) throw new Error("parser-compatible vector fields should normalize");
      const persisted = result.document.nodes["node-1"]?.vectorNetwork;
      expect(persisted).toBeDefined();
      expect("injected" in (persisted as object)).toBe(false);
      expect("injected" in (persisted?.vertices[0] as object)).toBe(false);
      expect("injected" in (persisted?.segments[0] as object)).toBe(false);
      expect(doc.nodes).toEqual({});
    }
  });

  test("transforms, rotates, styles, and edits text without changing the source document", () => {
    const original = documentWithNodes();
    const transformed = applyDesignTransaction(original, {
      kind: "transform",
      updates: [{ nodeId: "node-1", x: 5, width: 30 }, { nodeId: "node-2", y: 25 }],
    });
    expect(transformed).toMatchObject({
      ok: true,
      receipt: { outcome: "applied", changedNodeIds: ["node-1", "node-2"] },
    });
    if (!transformed.ok) return;
    expect(original.nodes["node-1"]!.x).toBe(0);
    const rotated = applyDesignTransaction(transformed.document, {
      kind: "rotate",
      nodeIds: ["node-1", "node-2"],
      rotation: 45,
    });
    if (!rotated.ok) throw new Error("rotate should be valid");
    const styled = applyDesignTransaction(rotated.document, {
      kind: "style",
      nodeIds: ["node-1", "node-2"],
      patch: { radius: 4, stroke: { color: "#000", width: 2, dash: [2, 3] } },
    });
    if (!styled.ok) throw new Error("style should be valid");
    const text = applyDesignTransaction(styled.document, {
      kind: "text",
      nodeId: "node-3",
      patch: { text: "New", fontWeight: 600, color: "#f00" },
    });
    expect(text).toMatchObject({ ok: true, receipt: { kind: "text", changedNodeIds: ["node-3"] } });
    if (!text.ok) return;
    expect(text.document.nodes["node-1"]).toMatchObject({ x: 5, width: 30, rotation: 45, radius: 4 });
    expect(text.document.nodes["node-3"]).toMatchObject({ text: "New", fontWeight: 600, color: "#f00" });
  });

  test("removes a stroke explicitly instead of encoding removal as a zero-width stroke", () => {
    const original = documentWithNodes();
    const withStroke = applyDesignTransaction(original, {
      kind: "style", nodeIds: ["node-1"], patch: { stroke: { color: "#000000", width: 1 } },
    });
    if (!withStroke.ok) throw new Error("stroke setup should be valid");
    const removed = applyDesignTransaction(withStroke.document, {
      kind: "style", nodeIds: ["node-1"], patch: { stroke: null },
    });
    expect(removed).toMatchObject({ ok: true, receipt: { outcome: "applied", changedNodeIds: ["node-1"] } });
    if (!removed.ok) return;
    expect(removed.document.nodes["node-1"]?.stroke).toBeUndefined();
    expect(withStroke.document.nodes["node-1"]?.stroke).toEqual({ color: "#000000", width: 1 });
    expect(applyRuntimeRequest(original, {
      kind: "create", node: { type: "rectangle", style: { stroke: null } },
    })).toMatchObject({ ok: true, document: { nodes: { "node-4": { strokeDisabled: true } } } });
  });

  test("one style edit can restore circular corners while removing the stroke", () => {
    const original = documentWithNodes();
    original.nodes["node-1"] = { ...original.nodes["node-1"]!, radius: 8, radiusY: 4 };
    const result = applyDesignTransaction(original, {
      kind: "style", nodeIds: ["node-1"], patch: { radius: 6, stroke: null },
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.document.nodes["node-1"]).toMatchObject({ radius: 6, strokeDisabled: true });
    expect(result.document.nodes["node-1"]?.radiusY).toBeUndefined();
    expect(original.nodes["node-1"]?.radiusY).toBe(4);
  });

  test("keeps connector metadata while an explicit style removal turns its stroke off", () => {
    const connector = createNode({
      id: "connector",
      type: "vector",
      parentId: null,
      vectorNetwork: {
        vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 60, y: 20 }],
        segments: [{ id: "segment", startVertexId: "a", endVertexId: "b" }],
        regions: [],
      },
      connector: { route: "straight", start: { x: 0, y: 0 }, end: { x: 60, y: 20 } },
      stroke: { color: "#000000", width: 2 },
    });
    const doc = appendChild({ ...createEmptyDocument(), nodes: { connector } }, null, "connector", "page-1");
    const removed = applyDesignTransaction(doc, { kind: "style", nodeIds: ["connector"], patch: { stroke: null } });
    if (!removed.ok) throw new Error("connector stroke removal should be valid");
    expect(removed.document.nodes["connector"]?.stroke).toBeUndefined();
    expect(removed.document.nodes["connector"]?.connector).toEqual(connector.connector);
  });

  test("renames through the same canonical request used by both actors", () => {
    const original = documentWithNodes();
    const renamed = applyDesignTransaction(original, { kind: "rename", nodeIds: ["node-1"], name: "Card" });
    expect(renamed).toMatchObject({ ok: true, receipt: { kind: "rename", outcome: "applied", changedNodeIds: ["node-1"] } });
    if (!renamed.ok) return;
    expect(renamed.document.nodes["node-1"]?.name).toBe("Card");
    expect(original.nodes["node-1"]?.name).not.toBe("Card");
    expect(applyDesignTransaction(original, { kind: "rename", nodeIds: ["node-1"], name: "" })).toMatchObject({
      ok: false,
      error: { code: "invalid_request", path: "name" },
    });
  });

  test("aligns and distributes geometry using outer bounds", () => {
    const original = documentWithNodes();
    const aligned = applyDesignTransaction(original, {
      kind: "align",
      nodeIds: ["node-1", "node-2"],
      axis: "horizontal",
      mode: "center",
    });
    if (!aligned.ok) throw new Error("align should be valid");
    expect(aligned.document.nodes["node-1"]!.x + aligned.document.nodes["node-1"]!.width / 2).toBe(30);
    expect(aligned.document.nodes["node-2"]!.x + aligned.document.nodes["node-2"]!.width / 2).toBe(30);
    const distributed = applyDesignTransaction(original, {
      kind: "distribute",
      nodeIds: ["node-1", "node-2", "node-3"],
      axis: "horizontal",
    });
    expect(distributed).toMatchObject({
      ok: true,
      receipt: { kind: "distribute", outcome: "applied", changedNodeIds: ["node-2"] },
    });
    if (!distributed.ok) return;
    expect(distributed.document.nodes["node-1"]!.x).toBe(0);
    expect(distributed.document.nodes["node-2"]!.x).toBe(55);
    expect(distributed.document.nodes["node-3"]!.x).toBe(100);
  });

  test("aligns and distributes rotated nodes by their visual bounds", () => {
    const base = createEmptyDocument();
    const first = createNode({ id: "node-1", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 50, rotation: 90 });
    const middle = createNode({ id: "node-2", type: "rectangle", parentId: null, x: 110, y: 0, width: 50, height: 50 });
    const last = createNode({ id: "node-3", type: "rectangle", parentId: null, x: 300, y: 0, width: 50, height: 50 });
    const doc = appendChild(
      appendChild(
        appendChild({ ...base, nodes: { "node-1": first, "node-2": middle, "node-3": last } }, null, "node-1", "page-1"),
        null,
        "node-2",
        "page-1",
      ),
      null,
      "node-3",
      "page-1",
    );
    const aligned = applyDesignTransaction(doc, {
      kind: "align", nodeIds: ["node-1", "node-2"], axis: "horizontal", mode: "start",
    });
    if (!aligned.ok) throw new Error("rotated alignment should be valid");
    // A 100×50 rectangle rotated 90° at x=0 visually starts at x=25.
    expect(aligned.document.nodes["node-2"]?.x).toBe(25);

    const distributed = applyDesignTransaction(doc, {
      kind: "distribute", nodeIds: ["node-1", "node-2", "node-3"], axis: "horizontal",
    });
    if (!distributed.ok) throw new Error("rotated distribution should be valid");
    // Visual spans are 50, 50, 50 from x=25 through x=350, so the middle
    // visual start is 162.5 rather than the old unrotated-box value of 175.
    expect(distributed.document.nodes["node-2"]?.x).toBe(162.5);
  });

  test("deletes requested roots and descendants while reporting all changed nodes", () => {
    const base = createEmptyDocument();
    const parent = createNode({ id: "node-1", type: "frame", parentId: null });
    const child = createNode({ id: "node-2", type: "rectangle", parentId: "node-1" });
    parent.childIds = ["node-2"];
    const doc = appendChild({ ...base, nodes: { "node-1": parent, "node-2": child } }, null, "node-1", "page-1");
    const result = applyDesignTransaction(doc, { kind: "delete", nodeIds: ["node-1"] });
    expect(result).toMatchObject({
      ok: true,
      receipt: { outcome: "applied", changedNodeIds: ["node-1", "node-2"] },
    });
    if (!result.ok) return;
    expect(result.document.nodes).toEqual({});
  });

  test("rejects invalid requests with typed errors", () => {
    const doc = documentWithNodes();
    expect(
      applyDesignTransaction(doc, { kind: "transform", updates: [{ nodeId: "node-1", width: -1 }] }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request", path: "updates[0].width" } });
    expect(
      applyDesignTransaction(doc, { kind: "text", nodeId: "node-1", patch: { text: "No" } }),
    ).toMatchObject({ ok: false, error: { code: "invalid_request", path: "nodeId" } });
    expect(
      applyDesignTransaction(doc, { kind: "delete", nodeIds: ["missing"] }),
    ).toMatchObject({ ok: false, error: { code: "not_found" } });
  });

  test("rejects malformed runtime request shapes without throwing", () => {
    const doc = documentWithNodes();
    const malformedRequests: unknown[] = [
      { kind: "transform", updates: null },
      { kind: "transform", updates: [null] },
      { kind: "rotate", nodeIds: null, rotation: 0 },
      { kind: "align", nodeIds: ["node-1"], axis: "diagonal", mode: "start" },
      { kind: "align", nodeIds: ["node-1"], axis: "horizontal", mode: "middle" },
      { kind: "distribute", nodeIds: ["node-1"], axis: "depth" },
      { kind: "style", nodeIds: ["node-1"], patch: null },
      { kind: "text", nodeId: "node-3", patch: null },
      { kind: "create", node: null },
      { kind: "create", node: { type: "vector" } },
      { kind: "create", node: { type: "rectangle", vectorNetwork: { vertices: [], segments: [], regions: [] } } },
    ];
    for (const request of malformedRequests) {
      expect(() => applyRuntimeRequest(doc, request)).not.toThrow();
      expect(applyRuntimeRequest(doc, request)).toMatchObject({
        ok: false,
        error: { code: "invalid_request" },
      });
    }
  });

  test("rejects hallucinated style and text fields without contaminating a document", () => {
    const doc = documentWithNodes();
    const style = applyDesignTransaction(doc, {
      kind: "style",
      nodeIds: ["node-1"],
      patch: { radius: 4, hallucinated: true },
    } as unknown as never);
    const text = applyDesignTransaction(doc, {
      kind: "text",
      nodeId: "node-3",
      patch: { text: "New", hallucinated: true },
    } as unknown as never);
    const invalidName = applyDesignTransaction(doc, {
      kind: "create",
      node: { type: "text", name: 42 },
    } as unknown as never);

    expect(style).toMatchObject({ ok: false, error: { code: "invalid_request", path: "patch.hallucinated" } });
    expect(text).toMatchObject({ ok: false, error: { code: "invalid_request", path: "patch.hallucinated" } });
    expect(invalidName).toMatchObject({ ok: false, error: { code: "invalid_request", path: "node.name" } });
    expect(doc.nodes["node-1"]).not.toHaveProperty("hallucinated");
    expect(doc.nodes["node-3"]).not.toHaveProperty("hallucinated");
  });

  test("rejects misspelled create and transform payload fields", () => {
    const doc = documentWithNodes();
    const create = applyDesignTransaction(doc, {
      kind: "create",
      node: { type: "rectangle", rotatoin: 45 },
    } as unknown as never);
    const transform = applyDesignTransaction(doc, {
      kind: "transform",
      updates: [{ nodeId: "node-1", widht: 40 }],
    } as unknown as never);

    expect(create).toMatchObject({ ok: false, error: { code: "invalid_request", path: "node.rotatoin" } });
    expect(transform).toMatchObject({ ok: false, error: { code: "invalid_request", path: "updates[0].widht" } });
    expect(doc.nodes["node-1"]!.width).toBe(20);
  });

  test("rejects align and distribute targets with different parents", () => {
    const base = createEmptyDocument();
    const firstParent = createNode({ id: "node-1", type: "frame", parentId: null });
    const firstChild = createNode({ id: "node-2", type: "rectangle", parentId: "node-1", x: 0, y: 0 });
    const secondParent = createNode({ id: "node-3", type: "frame", parentId: null });
    const secondChild = createNode({ id: "node-4", type: "rectangle", parentId: "node-3", x: 20, y: 0 });
    firstParent.childIds = ["node-2"];
    secondParent.childIds = ["node-4"];
    const doc = appendChild(
      appendChild(
        { ...base, nodes: { "node-1": firstParent, "node-2": firstChild, "node-3": secondParent, "node-4": secondChild } },
        null,
        "node-1",
        "page-1",
      ),
      null,
      "node-3",
      "page-1",
    );

    expect(applyDesignTransaction(doc, {
      kind: "align", nodeIds: ["node-2", "node-4"], axis: "horizontal", mode: "start",
    })).toMatchObject({ ok: false, error: { code: "invalid_request", path: "nodeIds" } });
    expect(applyDesignTransaction(doc, {
      kind: "distribute", nodeIds: ["node-2", "node-4"], axis: "horizontal",
    })).toMatchObject({ ok: false, error: { code: "invalid_request", path: "nodeIds" } });
  });

  test("keeps a vector network in sync when a vector box is resized", () => {
    const base = createEmptyDocument();
    const vector = createNode({
      id: "node-1",
      type: "vector",
      parentId: null,
      width: 10,
      height: 20,
      vectorNetwork: {
        vertices: [{ id: "v1", x: 10, y: 20 }],
        segments: [],
        regions: [],
      },
    });
    const doc = appendChild({ ...base, nodes: { "node-1": vector } }, null, "node-1", "page-1");
    const result = applyDesignTransaction(doc, {
      kind: "transform",
      updates: [{ nodeId: "node-1", width: 20, height: 10 }],
    });
    expect(result).toMatchObject({ ok: true, receipt: { outcome: "applied", changedNodeIds: ["node-1"] } });
    if (!result.ok) return;
    expect(result.document.nodes["node-1"]!.vectorNetwork?.vertices[0]).toMatchObject({ x: 20, y: 10 });
  });

  test("replaces a non-connector vector network through the canonical kernel", () => {
    const created = applyDesignTransaction(createEmptyDocument(), {
      kind: "create", node: { type: "vector", x: 0, y: 0, width: 10, height: 10, vectorNetwork: {
        vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 10, y: 10 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [],
      } },
    });
    if (!created.ok) throw new Error(created.error.message);
    const result = applyDesignTransaction(created.document, {
      kind: "vector", nodeId: "node-1", x: 4, y: 5, width: 20, height: 10,
      vectorNetwork: { vertices: [{ id: "a", x: 0, y: 0 }, { id: "b", x: 20, y: 10 }], segments: [{ id: "s", startVertexId: "a", endVertexId: "b" }], regions: [] },
    });
    expect(result).toMatchObject({ ok: true, receipt: { kind: "vector", changedNodeIds: ["node-1"] } });
    if (result.ok) expect(result.document.nodes["node-1"]).toMatchObject({ x: 4, y: 5, width: 20, height: 10 });
  });

  test("includes a structurally changed parent in nested create and child delete receipts", () => {
    const base = createEmptyDocument();
    const parent = createNode({ id: "node-1", type: "frame", parentId: null });
    const child = createNode({ id: "node-2", type: "rectangle", parentId: "node-1" });
    parent.childIds = ["node-2"];
    const doc = appendChild({ ...base, nodes: { "node-1": parent, "node-2": child } }, null, "node-1", "page-1");
    const created = applyDesignTransaction(doc, {
      kind: "create",
      parentId: "node-1",
      node: { type: "rectangle" },
    });
    expect(created).toMatchObject({
      ok: true,
      receipt: { outcome: "applied", changedNodeIds: ["node-3", "node-1"] },
    });
    const deleted = applyDesignTransaction(doc, { kind: "delete", nodeIds: ["node-2"] });
    expect(deleted).toMatchObject({
      ok: true,
      receipt: { outcome: "applied", changedNodeIds: ["node-2", "node-1"] },
    });
  });

  test("creates pages and reorders page or child scopes through validated kernel requests", () => {
    const original = documentWithNodes();
    const page = applyDesignTransaction(original, { kind: "page", name: "Ideas" });
    expect(page).toMatchObject({ ok: true, receipt: { kind: "page", changedPageIds: ["page-2"] } });
    if (!page.ok) throw new Error("page should be valid");
    expect(page.document.pages[1]).toEqual({ id: "page-2", name: "Ideas", children: [] });

    const reordered = applyDesignTransaction(original, {
      kind: "reorder", parentId: null, pageId: "page-1", orderedIds: ["node-3", "node-1", "node-2"],
    });
    expect(reordered).toMatchObject({ ok: true, receipt: { kind: "reorder", changedPageIds: ["page-1"] } });
    if (!reordered.ok) throw new Error("page reorder should be valid");
    expect(reordered.document.pages[0]?.children).toEqual(["node-3", "node-1", "node-2"]);
    expect(applyDesignTransaction(original, {
      kind: "reorder", parentId: null, pageId: "page-1", orderedIds: ["node-1", "node-1", "node-2"],
    })).toMatchObject({ ok: false, error: { code: "invalid_request", path: "orderedIds" } });
    const noop = applyDesignTransaction(original, {
      kind: "reorder", parentId: null, pageId: "page-1", orderedIds: ["node-1", "node-2", "node-3"],
    });
    expect(noop).toMatchObject({ ok: true, receipt: { outcome: "noop", changedNodeIds: [] } });
    if (noop.ok) expect(noop.document).toBe(original);
  });

  test("reorders unlocked siblings without moving a locked layer", () => {
    const original = documentWithNodes();
    original.nodes["node-2"] = { ...original.nodes["node-2"]!, locked: true };
    const allowed = applyDesignTransaction(original, {
      kind: "reorder", parentId: null, pageId: "page-1", orderedIds: ["node-3", "node-2", "node-1"],
    });
    expect(allowed).toMatchObject({ ok: true, document: { pages: [{ children: ["node-3", "node-2", "node-1"] }] } });
    const rejected = applyDesignTransaction(original, {
      kind: "reorder", parentId: null, pageId: "page-1", orderedIds: ["node-2", "node-1", "node-3"],
    });
    expect(rejected).toMatchObject({ ok: false, error: { code: "invalid_request", path: "orderedIds" } });
    expect(original.pages[0]?.children).toEqual(["node-1", "node-2", "node-3"]);
  });

  test("groups siblings as a renderer-native boolean composition through the kernel", () => {
    const original = documentWithNodes();
    const result = applyDesignTransaction(original, { kind: "boolean", nodeIds: ["node-1", "node-2"], op: "subtract" });
    expect(result).toMatchObject({
      ok: true,
      receipt: { kind: "boolean", changedNodeIds: ["node-4", "node-1", "node-2"], changedPageIds: ["page-1"] },
    });
    if (!result.ok) throw new Error("boolean should be valid");
    expect(result.document.pages[0]?.children).toEqual(["node-4", "node-3"]);
    expect(result.document.nodes["node-4"]).toMatchObject({ type: "group", booleanOp: "subtract", childIds: ["node-1", "node-2"] });
    expect(result.document.nodes["node-1"]?.parentId).toBe("node-4");
    expect(applyDesignTransaction(original, { kind: "boolean", nodeIds: ["node-1"], op: "union" })).toMatchObject({
      ok: false, error: { code: "invalid_request", path: "nodeIds" },
    });
  });

  test("derives nested boolean bounds from visible transformed operands instead of stale group boxes", () => {
    const original = documentWithNodes();
    original.nodes["node-1"] = { ...original.nodes["node-1"]!, rotation: 90 };
    original.nodes["node-3"] = createNode({
      id: "node-3", type: "rectangle", parentId: null, x: 100, y: 40, width: 10, height: 20,
    });
    const inner = applyDesignTransaction(original, { kind: "boolean", nodeIds: ["node-1", "node-2"], op: "union" });
    if (!inner.ok) throw new Error(inner.error.message);
    const movedOperand = applyDesignTransaction(inner.document, {
      kind: "transform", updates: [{ nodeId: "node-1", x: -100 }],
    });
    if (!movedOperand.ok) throw new Error(movedOperand.error.message);
    const outer = applyDesignTransaction(movedOperand.document, {
      kind: "boolean", nodeIds: ["node-4", "node-3"], op: "union",
    });
    if (!outer.ok) throw new Error(outer.error.message);
    expect(outer.document.nodes["node-5"]).toMatchObject({ x: -95, y: -5, width: 205, height: 65 });
  });

  test("rejects hostile fields on page, reorder, and boolean kernel requests", () => {
    const doc = documentWithNodes();
    for (const request of [
      { kind: "page", name: "Ideas", surprise: true },
      { kind: "reorder", parentId: null, orderedIds: ["node-1", "node-2", "node-3"], surprise: true },
      { kind: "boolean", nodeIds: ["node-1", "node-2"], op: "union", surprise: true },
    ]) {
      expect(applyRuntimeRequest(doc, request)).toMatchObject({
        ok: false, error: { code: "invalid_request", path: "request.surprise" },
      });
    }
  });

  test("returns a stable no-op receipt without allocating a new document", () => {
    const doc = documentWithNodes();
    const result = applyDesignTransaction(doc, {
      kind: "transform",
      updates: [{ nodeId: "node-1", x: 0 }],
    });
    expect(result).toMatchObject({
      ok: true,
      receipt: { kind: "transform", outcome: "noop", changedNodeIds: [] },
    });
    if (!result.ok) return;
    expect(result.document).toBe(doc);
  });

  test("reverts exact non-structural post-images atomically and refuses stale targets", () => {
    const before = documentWithNodes();
    const agent = applyDesignTransaction(before, {
      kind: "transform",
      updates: [{ nodeId: "node-1", x: 15 }, { nodeId: "node-2", y: 35 }],
    });
    if (!agent.ok) throw new Error(agent.error.message);
    const revert = {
      kind: "revert" as const,
      changes: ["node-1", "node-2"].map((nodeId) => ({
        nodeId,
        expected: agent.document.nodes[nodeId]!,
        restore: before.nodes[nodeId]!,
      })),
    };
    const reverted = applyDesignTransaction(agent.document, revert);
    expect(reverted).toMatchObject({
      ok: true,
      receipt: { kind: "revert", outcome: "applied", changedNodeIds: ["node-1", "node-2"] },
    });
    if (!reverted.ok) throw new Error(reverted.error.message);
    expect(reverted.document.nodes["node-1"]?.x).toBe(0);
    expect(reverted.document.nodes["node-2"]?.y).toBe(20);

    const locallyChanged = applyDesignTransaction(agent.document, {
      kind: "text",
      nodeId: "node-3",
      patch: { text: "unrelated local draft" },
    });
    if (!locallyChanged.ok) throw new Error(locallyChanged.error.message);
    const stale = applyDesignTransaction(locallyChanged.document, revert);
    expect(stale).toMatchObject({ ok: true, receipt: { outcome: "applied" } });

    const changedTarget = applyDesignTransaction(agent.document, {
      kind: "transform",
      updates: [{ nodeId: "node-2", y: 99 }],
    });
    if (!changedTarget.ok) throw new Error(changedTarget.error.message);
    const refused = applyDesignTransaction(changedTarget.document, revert);
    expect(refused).toMatchObject({ ok: false, error: { code: "stale_revert" } });
    expect(changedTarget.document.nodes["node-1"]?.x).toBe(15);
    expect(changedTarget.document.nodes["node-2"]?.y).toBe(99);
  });

  test("rejects unknown Revert request and change fields", () => {
    const doc = documentWithNodes();
    const unknownRequest = {
      kind: "revert",
      changes: [{ nodeId: "node-1", expected: doc.nodes["node-1"], restore: doc.nodes["node-1"], typo: true }],
      surprise: true,
    };
    expect(applyRuntimeRequest(doc, unknownRequest)).toMatchObject({
      ok: false,
      error: { code: "invalid_request", path: "request.surprise" },
    });
    expect(applyRuntimeRequest(doc, {
      kind: "revert",
      changes: [{ nodeId: "node-1", expected: doc.nodes["node-1"], restore: doc.nodes["node-1"], typo: true }],
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_request", path: "changes[0].typo" },
    });
  });
});
