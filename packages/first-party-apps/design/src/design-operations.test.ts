import { describe, expect, test } from "bun:test";
import { appendChild, createEmptyDocument, createNode, validateDesignDocument } from "./scene-graph";
import {
  DesignOperationReceiptStore,
  MAX_EDIT_OPERATIONS,
  MAX_PATH_COMMANDS,
  designOperationFingerprint,
  editOpenDesign,
  validateDesignSemanticPreconditions,
  requiredDesignSemanticPreconditions,
  type DesignOperation,
} from "./design-operations";
import { semanticVersionForNode, semanticVersionForPage } from "./design-inspection";

const creationFamilies = [
  ["create", () => ({ op: "create", node: { type: "rectangle", x: 10, y: 20, width: 40, height: 30 } })],
  ["shape", () => ({ op: "shape", shape: "ellipse", x: 10, y: 20, width: 40, height: 30 })],
  ["path", () => ({ op: "path", bounds: { x: 10, y: 20, width: 40, height: 30 }, commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }] })],
  ["connector", () => ({ op: "connector", connector: { route: "straight", start: { x: 10, y: 20 }, end: { x: 50, y: 50 } } })],
] as const;

function sampleSemanticDocument() {
  const empty = createEmptyDocument();
  const node = createNode({
    id: "node-1",
    type: "rectangle",
    parentId: null,
    width: 100,
    height: 80,
  });
  return appendChild({ ...empty, nodes: { "node-1": node } }, null, "node-1", "page-1");
}

describe("editOpenDesign", () => {
  test("derives public semantic dependencies across all 16 operation families and exempts batch refs", () => {
    const cases: Array<[DesignOperation, string[]]> = [
      [{ op: "create", pageId: "page:page-1", node: { type: "rectangle" } }, ["page:page-1"]],
      [{ op: "shape", pageId: "page:page-1", parentId: "node:parent", shape: "ellipse", x: 0, y: 0, width: 10, height: 10 }, ["node:parent", "page:page-1"]],
      [{ op: "path", nodeId: "node:a", commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }], expectedGeometry: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }], bounds: { x: 0, y: 0, width: 10, height: 10 } }, ["node:a"]],
      [{ op: "transform", updates: [{ nodeId: "node:a", x: 2 }] }, ["node:a"]],
      [{ op: "rotate", nodeIds: ["node:a"], rotation: 45 }, ["node:a"]],
      [{ op: "rename", nodeId: "node:a", name: "A" }, ["node:a"]],
      [{ op: "text", nodeId: "node:a", patch: { text: "A" } }, ["node:a"]],
      [{ op: "style", nodeIds: ["node:a", "$new"], patch: { opacity: 0.5 } }, ["node:a"]],
      [{ op: "align", nodeIds: ["node:a", "node:b"], axis: "horizontal", mode: "center" }, ["node:a", "node:b"]],
      [{ op: "distribute", nodeIds: ["node:a", "node:b", "node:c"], axis: "vertical" }, ["node:a", "node:b", "node:c"]],
      [{ op: "reorder", parentId: null, pageId: "page:page-1", orderedIds: ["node:a", "node:b"] }, ["node:a", "node:b", "page:page-1"]],
      [{ op: "boolean", nodeIds: ["node:a", "node:b"], opName: "union" }, ["node:a", "node:b"]],
      [{ op: "page", name: "Ideas" }, []],
      [{ op: "connector", pageId: "page:page-1", connector: { route: "straight", start: { x: 0, y: 0, targetHandle: "node:a" }, end: { x: 10, y: 10, targetHandle: "$new" } } }, ["node:a", "page:page-1"]],
      [{ op: "connector-update", nodeId: "node:link", patch: { end: { x: 10, y: 10, targetHandle: "node:b" } } }, ["node:b", "node:link"]],
      [{ op: "delete", nodeIds: ["node:a"] }, ["node:a"]],
    ];

    for (const [operation, handles] of cases) {
      expect([...requiredDesignSemanticPreconditions([operation]).keys()].sort()).toEqual(handles.sort());
    }
  });

  test("semantic live creation requires an explicit inspected page and page precondition across all four families", () => {
    const document = sampleSemanticDocument();
    const pagePrecondition = [{
      handle: "page:page-1",
      semanticVersion: semanticVersionForPage(document.pages[0]!),
    }];
    for (const [family, build] of creationFamilies) {
      const operation = build() as DesignOperation;
      const implicitPage = editOpenDesign(document, {
        idempotencyKey: `${family}-implicit-page`,
        operations: [operation],
        preconditions: [],
      }, undefined, { requireSemanticPreconditions: true });
      expect(implicitPage).toMatchObject({
        ok: false,
        error: {
          code: "invalid_request",
          failedOperationIndex: 0,
          stateChanged: false,
        },
      });
      if (implicitPage.ok) throw new Error(`${family} unexpectedly accepted an implicit page`);
      expect(implicitPage.error.message).toContain("explicit inspected pageId");
      expect(editOpenDesign(document, {
        idempotencyKey: `${family}-missing-page-precondition`,
        operations: [{ ...operation, pageId: "page:page-1" }],
        preconditions: [],
      }, undefined, { requireSemanticPreconditions: true })).toMatchObject({
        ok: false,
        error: { code: "invalid_request", stateChanged: false },
      });
      expect(editOpenDesign(document, {
        idempotencyKey: `${family}-explicit-page`,
        operations: [{ ...operation, pageId: "page:page-1" }],
        preconditions: pagePrecondition,
      }, undefined, { requireSemanticPreconditions: true })).toMatchObject({ ok: true });
    }
  });

  test("permits disjoint stale recovery but refuses same-resource semantic overwrite atomically", () => {
    const empty = createEmptyDocument();
    const first = createNode({ id: "node-1", type: "rectangle", parentId: null, name: "A", width: 100, height: 80 });
    const second = createNode({ id: "node-2", type: "rectangle", parentId: null, name: "B", x: 140, width: 100, height: 80 });
    const original = appendChild(
      appendChild({ ...empty, nodes: { "node-1": first, "node-2": second } }, null, "node-1", "page-1"),
      null,
      "node-2",
      "page-1",
    );
    const preconditions = [{
      handle: "node:node-1",
      semanticVersion: semanticVersionForNode(original.nodes["node-1"]!),
    }];
    const operations: DesignOperation[] = [{
      op: "style",
      nodeIds: ["node:node-1"],
      patch: { fills: [{ kind: "solid", color: "#ff0000" }] },
    }];
    const disjoint = {
      ...original,
      nodes: { ...original.nodes, "node-2": { ...original.nodes["node-2"]!, x: 180 } },
    };
    expect(editOpenDesign(disjoint, {
      idempotencyKey: "disjoint-style",
      preconditions,
      operations,
    }, undefined, { requireSemanticPreconditions: true })).toMatchObject({ ok: true });

    const sameTarget = {
      ...original,
      nodes: {
        ...original.nodes,
        "node-1": { ...original.nodes["node-1"]!, fills: [{ kind: "solid" as const, color: "#0000ff" }] },
      },
    };
    const conflict = editOpenDesign(sameTarget, {
      idempotencyKey: "same-target-style",
      preconditions,
      operations,
    }, undefined, { requireSemanticPreconditions: true });
    expect(conflict).toMatchObject({
      ok: false,
      error: {
        code: "semantic_conflict",
        stateChanged: false,
        retrySafe: false,
        conflicts: [{ handle: "node:node-1", propertyGroups: ["appearance"] }],
        conflictCount: 1,
        omittedConflictCount: 0,
      },
    });
    expect(sameTarget.nodes["node-1"]?.fills?.[0]?.color).toBe("#0000ff");

    const laterConflict = editOpenDesign(sameTarget, {
      idempotencyKey: "later-same-target-style",
      preconditions,
      operations: [
        { op: "page", name: "Would be first" },
        ...operations,
      ],
    }, undefined, { requireSemanticPreconditions: true });
    expect(laterConflict).toMatchObject({
      ok: false,
      error: {
        code: "semantic_conflict",
        failedOperationIndex: 1,
        path: "/preconditions",
        stateChanged: false,
      },
    });
  });

  test("requires exact public precondition coverage and binds it into idempotency", () => {
    const doc = sampleSemanticDocument();
    const operations: DesignOperation[] = [{ op: "rename", nodeId: "node:node-1", name: "Renamed" }];
    const valid = [{ handle: "node:node-1", semanticVersion: semanticVersionForNode(doc.nodes["node-1"]!) }];
    for (const preconditions of [
      [],
      [{ handle: "node-1", semanticVersion: valid[0]!.semanticVersion }],
      [{ handle: "node:node-1", semanticVersion: "s1:short" }],
      [...valid, { handle: "page:page-1", semanticVersion: semanticVersionForPage(doc.pages[0]!) }],
    ]) {
      expect(editOpenDesign(doc, {
        idempotencyKey: `invalid-preconditions-${preconditions.length}`,
        operations,
        preconditions,
      }, undefined, { requireSemanticPreconditions: true })).toMatchObject({
        ok: false,
        error: { code: "invalid_request", stateChanged: false },
      });
    }
    expect(designOperationFingerprint(doc, operations, valid)).not.toBe(
      designOperationFingerprint(doc, operations, [{ ...valid[0]!, semanticVersion: "s1:different" }]),
    );
  });
  test("applies ordered create, style, path, connector, and page operations atomically through the kernel", () => {
    const result = editOpenDesign(createEmptyDocument(), {
      idempotencyKey: "batch-1",
      operations: [
        { op: "shape", ref: "$card", shape: "rectangle", x: 20, y: 30, width: 120, height: 80, style: { fills: [{ kind: "solid", color: "#ffffff" }], stroke: { color: "#111111", width: 2 } } },
        { op: "shape", ref: "$circle", shape: "ellipse", x: 200, y: 30, width: 80, height: 80 },
        { op: "style", nodeIds: ["$card"], patch: { stroke: null, radius: 12 } },
        { op: "connector", ref: "$link", connector: { route: "straight", start: { x: 140, y: 70, targetHandle: "$card", anchor: { x: 1, y: 0.5 } }, end: { x: 200, y: 70, targetHandle: "$circle", anchor: { x: 0, y: 0.5 } } } },
        { op: "page", ref: "$ideas", name: "Ideas" },
      ],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.receipt.createdRefs).toEqual({ $card: "node:node-1", $circle: "node:node-2", $link: "node:node-3", $ideas: "page:page-2" });
    expect(result.document.nodes["node-1"]?.stroke).toBeUndefined();
    expect(result.document.nodes["node-3"]?.connector?.start.targetId).toBe("node-1");
  });

  test("uses one named creation contract for common shapes and direction-safe lines", () => {
    const result = editOpenDesign(createEmptyDocument(), {
      idempotencyKey: "coherent-create-v1",
      operations: [
        {
          op: "create",
          ref: "$ellipse",
          node: {
            type: "ellipse",
            name: "Sun",
            x: 20,
            y: 30,
            width: 80,
            height: 60,
            style: { fills: [{ kind: "solid", color: "#fbbf24" }], stroke: null },
          },
        },
        { op: "create", ref: "$horizontal", node: { type: "line", name: "Road", start: { x: 200, y: 80 }, end: { x: 80, y: 80 } } },
        { op: "create", ref: "$vertical", node: { type: "line", name: "Post", start: { x: 120, y: 160 }, end: { x: 120, y: 40 } } },
        { op: "create", ref: "$reverse", node: { type: "line", name: "Spoke", start: { x: 200, y: 200 }, end: { x: 120, y: 120 } } },
      ],
    });
    if (!result.ok) throw new Error(result.error.message);
    expect(result.document.nodes["node-1"]).toMatchObject({ name: "Sun", x: 20, y: 30, width: 80, height: 60 });
    expect(result.document.nodes["node-1"]?.stroke).toBeUndefined();
    expect(result.document.nodes["node-2"]).toMatchObject({ name: "Road", x: 80, y: 80, width: 120, height: 1 });
    expect(result.document.nodes["node-3"]).toMatchObject({ name: "Post", x: 120, y: 40, width: 1, height: 120 });
    expect(result.document.nodes["node-4"]).toMatchObject({ name: "Spoke", x: 120, y: 120, width: 80, height: 80 });
  });

  test("reports the exact invalid operation position and JSON path without changing state", () => {
    const original = createEmptyDocument();
    const result = editOpenDesign(original, {
      idempotencyKey: "typed-diagnostic-v1",
      operations: [
        { op: "page", name: "Valid first operation" },
        { op: "create", node: { type: "line", start: { x: 0, y: 0 }, end: { x: 0, y: 0 } } },
      ],
    });
    expect(result).toMatchObject({
      ok: false,
      error: {
        code: "invalid_request",
        failedOperationIndex: 1,
        path: "/operations/1/node/end",
        stateChanged: false,
        retrySafe: true,
      },
    });
    expect(original.pages).toHaveLength(1);
  });

  test("refuses an invalid later operation without leaking earlier work", () => {
    const original = createEmptyDocument();
    const result = editOpenDesign(original, { idempotencyKey: "batch-2", operations: [
      { op: "create", ref: "$a", node: { type: "rectangle" } },
      { op: "text", nodeId: "$a", patch: { text: "not text" } },
    ] });
    expect(result).toMatchObject({ ok: false, error: { failedOperationIndex: 1, stateChanged: false } });
    expect(original.nodes).toEqual({});
  });

  test("creation families distinguish page-level null, omission, failed handles, page ownership, and batch refs", () => {
    const base = createEmptyDocument();
    const parent = createNode({ id: "node-1", type: "frame", parentId: null, width: 200, height: 120 });
    const withParent = appendChild(
      { ...base, nodes: { "node-1": parent } },
      null,
      "node-1",
      "page-1",
    );
    const twoPages = {
      ...withParent,
      pages: [...withParent.pages, { id: "page-2", name: "Second", children: [] }],
    };

    for (const [family, build] of creationFamilies) {
      const topLevel = editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-top-level`,
        operations: [{ ...build(), pageId: "page:page-1", parentId: null }],
      } as unknown);
      expect(topLevel).toMatchObject({ ok: true });
      if (topLevel.ok) expect(topLevel.document.pages[0]?.children).toEqual(["node-1"]);

      const omitted = editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-omitted-parent`,
        operations: [build()],
      } as unknown);
      expect(omitted).toMatchObject({ ok: true });
      if (omitted.ok) {
        expect(omitted.document.pages[0]?.children).toEqual(["node-1"]);
        expect(validateDesignDocument(omitted.document)).toEqual(omitted.document);
      }

      const omittedParentPage = editOpenDesign(twoPages, {
        idempotencyKey: `${family}-infer-parent-page`,
        operations: [{ ...build(), parentId: "node:node-1" }],
      } as unknown);
      expect(omittedParentPage).toMatchObject({
        ok: true,
        document: { nodes: { "node-2": { parentId: "node-1" } } },
      });
      if (omittedParentPage.ok) {
        expect(omittedParentPage.document.nodes["node-1"]?.childIds).toEqual(["node-2"]);
        expect(validateDesignDocument(omittedParentPage.document)).toEqual(omittedParentPage.document);
      }

      expect(editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-null-without-page`,
        operations: [{ ...build(), parentId: null }],
      } as unknown)).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: "pageId is required when parentId is null.", stateChanged: false },
      });

      expect(editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-missing-parent`,
        operations: [{ ...build(), pageId: "page:page-1", parentId: "node:missing" }],
      } as unknown)).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "Unknown parent handle.", stateChanged: false },
      });

      expect(editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-missing-page`,
        operations: [{ ...build(), pageId: "page:missing", parentId: null }],
      } as unknown)).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "Unknown page handle.", stateChanged: false },
      });

      expect(editOpenDesign(twoPages, {
        idempotencyKey: `${family}-wrong-page`,
        operations: [{ ...build(), pageId: "page:page-2", parentId: "node:node-1" }],
      } as unknown)).toMatchObject({
        ok: false,
        error: { code: "invalid_request", message: "parentId must belong to pageId.", stateChanged: false },
      });

      const batchRef = editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-batch-parent-ref`,
        operations: [
          { op: "create", ref: "$parent", pageId: "page:page-1", parentId: null, node: { type: "frame", width: 200, height: 120 } },
          { ...build(), ref: "$child", pageId: "page:page-1", parentId: "$parent" },
        ],
      } as unknown);
      expect(batchRef).toMatchObject({
        ok: true,
        receipt: { createdRefs: { $parent: "node:node-1", $child: "node:node-2" } },
        document: { nodes: { "node-2": { parentId: "node-1" } } },
      });
      if (batchRef.ok) expect(validateDesignDocument(batchRef.document)).toEqual(batchRef.document);

      expect(editOpenDesign(createEmptyDocument(), {
        idempotencyKey: `${family}-forward-parent-ref`,
        operations: [
          { ...build(), ref: "$child", parentId: "$parent" },
          { op: "create", ref: "$parent", pageId: "page:page-1", parentId: null, node: { type: "frame" } },
        ],
      } as unknown)).toMatchObject({
        ok: false,
        error: { code: "not_found", message: "Unknown parent handle.", stateChanged: false },
      });
    }
  });

  test("nested reorder accepts a same-batch parent ref and rejects a contradictory page", () => {
    const arranged = editOpenDesign(createEmptyDocument(), {
      idempotencyKey: "nested-reorder-ref",
      operations: [
        { op: "create", ref: "$parent", pageId: "page:page-1", parentId: null, node: { type: "frame" } },
        { op: "create", ref: "$first", pageId: "page:page-1", parentId: "$parent", node: { type: "rectangle" } },
        { op: "create", ref: "$second", pageId: "page:page-1", parentId: "$parent", node: { type: "rectangle" } },
        { op: "reorder", parentId: "$parent", pageId: "page:page-1", orderedIds: ["$second", "$first"] },
      ],
    });
    expect(arranged).toMatchObject({
      ok: true,
      document: { nodes: { "node-1": { childIds: ["node-3", "node-2"] } } },
    });
    if (!arranged.ok) return;
    expect(validateDesignDocument(arranged.document)).toEqual(arranged.document);

    const topLevel = editOpenDesign(createEmptyDocument(), {
      idempotencyKey: "top-level-reorder-refs",
      operations: [
        { op: "create", ref: "$first", pageId: "page:page-1", parentId: null, node: { type: "rectangle" } },
        { op: "create", ref: "$second", pageId: "page:page-1", parentId: null, node: { type: "rectangle" } },
        { op: "reorder", parentId: null, pageId: "page:page-1", orderedIds: ["$second", "$first"] },
      ],
    });
    expect(topLevel).toMatchObject({
      ok: true,
      document: { pages: [{ children: ["node-2", "node-1"] }] },
    });
    if (topLevel.ok) expect(validateDesignDocument(topLevel.document)).toEqual(topLevel.document);
    const withSecondPage = {
      ...arranged.document,
      pages: [...arranged.document.pages, { id: "page-2", name: "Second", children: [] }],
    };
    expect(editOpenDesign(withSecondPage, {
      idempotencyKey: "nested-reorder-wrong-page",
      operations: [{
        op: "reorder",
        parentId: "node:node-1",
        pageId: "page:page-2",
        orderedIds: ["node:node-3", "node:node-2"],
      }],
    })).toMatchObject({
      ok: false,
      error: { code: "invalid_request", message: "parentId must belong to pageId.", stateChanged: false },
    });
  });

  test("uses finite typed pen commands and protects revisions with expected geometry", () => {
    const inspectedGeometry = [
      { kind: "M" as const, x: 0, y: 0 },
      { kind: "C" as const, c1x: 1 / 3, c1y: 0, c2x: 2 / 3, c2y: 1, x: 1, y: 1 },
    ];
    // The callable schema exposes x/y before cubic handles, while inspection
    // materializes the canonical command with handles first. They are the same
    // normalized geometry even though JSON property order differs.
    const providerGeometry = [
      { kind: "M" as const, x: 0, y: 0 },
      { kind: "C" as const, x: 1, y: 1, c1x: 1 / 3, c1y: 0, c2x: 2 / 3, c2y: 1 },
    ];
    expect(JSON.stringify(providerGeometry)).not.toBe(JSON.stringify(inspectedGeometry));
    const create = editOpenDesign(createEmptyDocument(), { idempotencyKey: "pen-create", operations: [{
      op: "path", ref: "$line", bounds: { x: 10, y: 20, width: 60, height: 20 }, commands: inspectedGeometry,
    }] });
    if (!create.ok) throw new Error(create.error.message);
    const revised = editOpenDesign(create.document, { idempotencyKey: "pen-revise", operations: [{
      op: "path", nodeId: "node:node-1", bounds: { x: 10, y: 20, width: 70, height: 20 }, expectedGeometry: providerGeometry,
      commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 0 }],
    }] });
    expect(revised).toMatchObject({ ok: true, receipt: { changedNodeHandles: ["node:node-1"] } });
    const stale = editOpenDesign(create.document, { idempotencyKey: "pen-stale", operations: [{
      op: "path", nodeId: "node:node-1", bounds: { x: 10, y: 20, width: 70, height: 20 }, expectedGeometry: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }],
      commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 0 }],
    }] });
    expect(stale).toMatchObject({ ok: false, error: { code: "stale_geometry", stateChanged: false } });
    for (const malformedExpectedGeometry of [
      [{ kind: "M", x: 0, y: 0 }, { kind: "C", x: 1, y: 1, c1x: 1 / 3, c1y: 0, c2x: 2 / 3, c2y: 1, private: true }],
      [{ kind: "M", x: 0, y: 0 }, { kind: "C", x: 1, y: 1, c1y: 0, c2x: 2 / 3, c2y: 1 }],
    ]) {
      expect(editOpenDesign(create.document, { idempotencyKey: "pen-malformed", operations: [{
        op: "path", nodeId: "node:node-1", bounds: { x: 10, y: 20, width: 70, height: 20 }, expectedGeometry: malformedExpectedGeometry,
        commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 0 }],
      }] } as unknown)).toMatchObject({
        ok: false,
        error: { code: "invalid_request", stateChanged: false, retrySafe: true },
      });
    }
  });

  test("compares every Pen command field semantically while preserving command order", () => {
    const geometry = [
      { kind: "M" as const, x: 0, y: 0 },
      { kind: "L" as const, x: 0.25, y: 0.5 },
      { kind: "C" as const, c1x: 0.3, c1y: 0.4, c2x: 0.7, c2y: 0.8, x: 1, y: 1 },
      { kind: "Z" as const },
    ];
    const created = editOpenDesign(createEmptyDocument(), {
      idempotencyKey: "pen-all-create",
      operations: [{
        op: "path",
        ref: "$closed",
        bounds: { x: 10, y: 20, width: 100, height: 100 },
        commands: geometry,
      }],
    });
    if (!created.ok) throw new Error(created.error.message);

    const reorderedProperties = [
      { y: 0, x: 0, kind: "M" as const },
      { y: 0.5, kind: "L" as const, x: 0.25 },
      { x: 1, c2y: 0.8, kind: "C" as const, c1y: 0.4, y: 1, c2x: 0.7, c1x: 0.3 },
      { kind: "Z" as const },
    ];
    expect(editOpenDesign(created.document, {
      idempotencyKey: "pen-all-revise",
      operations: [{
        op: "path",
        nodeId: "node:node-1",
        bounds: { x: 11, y: 20, width: 100, height: 100 },
        expectedGeometry: reorderedProperties,
        commands: geometry,
      }],
    })).toMatchObject({ ok: true });

    const staleCandidates = [
      geometry.map((command, index) => index === 0 ? { ...command, x: 0.1 } : command),
      geometry.map((command, index) => index === 1 ? { ...command, y: 0.6 } : command),
      ...(["c1x", "c1y", "c2x", "c2y", "x", "y"] as const).map((field) =>
        geometry.map((command, index) =>
          index === 2 && command.kind === "C" ? { ...command, [field]: command[field] - 0.01 } : command,
        ),
      ),
      [geometry[0]!, geometry[2]!, geometry[1]!, geometry[3]!],
    ];
    staleCandidates.forEach((expectedGeometry, index) => {
      expect(editOpenDesign(created.document, {
        idempotencyKey: `pen-all-stale-${index}`,
        operations: [{
          op: "path",
          nodeId: "node:node-1",
          bounds: { x: 11, y: 20, width: 100, height: 100 },
          expectedGeometry,
          commands: geometry,
        }],
      })).toMatchObject({ ok: false, error: { code: "stale_geometry", stateChanged: false } });
    });

    for (const expectedGeometry of [
      [{ kind: "M", x: 0, y: 0, horizontal: 0 }, ...geometry.slice(1)],
      [...geometry.slice(0, 3), { kind: "Z", closed: true }],
    ]) {
      expect(editOpenDesign(created.document, {
        idempotencyKey: "pen-all-extra-field",
        operations: [{
          op: "path",
          nodeId: "node:node-1",
          bounds: { x: 11, y: 20, width: 100, height: 100 },
          expectedGeometry,
          commands: geometry,
        }],
      } as unknown)).toMatchObject({ ok: false, error: { code: "invalid_request", stateChanged: false } });
    }
  });

  test("returns the stored receipt for an identical idempotency key and refuses key reuse", () => {
    const store = new DesignOperationReceiptStore();
    const args = { idempotencyKey: "repeat", operations: [{ op: "page" as const, name: "Second" }] };
    const original = createEmptyDocument();
    const first = editOpenDesign(original, args, store);
    if (!first.ok) throw new Error(first.error.message);
    const repeated = editOpenDesign(original, args, store);
    expect(repeated).toBe(first);
    expect(editOpenDesign(original, { idempotencyKey: "repeat", operations: [{ op: "page", name: "Different" }] }, store)).toMatchObject({
      ok: false, error: { code: "invalid_request", stateChanged: false },
    });
  });

  test("covers transform, rotate, text, full appearance, layout, reorder, boolean, connector update, and delete", () => {
    const seed = editOpenDesign(createEmptyDocument(), { idempotencyKey: "families-seed", operations: [
      { op: "create", ref: "$frame", node: { type: "frame", width: 500, height: 300 } },
      { op: "create", ref: "$text", parentId: "$frame", node: { type: "text", text: { text: "Old" } } },
      { op: "shape", ref: "$a", shape: "rectangle", x: 10, y: 20, width: 40, height: 30 },
      { op: "shape", ref: "$b", shape: "diamond", x: 80, y: 20, width: 40, height: 30 },
      { op: "connector", ref: "$link", connector: { route: "straight", start: { x: 50, y: 35, targetHandle: "$a", anchor: { x: 1, y: 0.5 } }, end: { x: 80, y: 35, targetHandle: "$b", anchor: { x: 0, y: 0.5 } } } },
    ] });
    if (!seed.ok) throw new Error(seed.error.message);
    const edit = editOpenDesign(seed.document, { idempotencyKey: "families-edit", operations: [
      { op: "transform", updates: [{ nodeId: "node:node-3", x: 15, y: 25 }] },
      { op: "rotate", nodeIds: ["node:node-3"], rotation: 15 },
      { op: "rename", nodeId: "node:node-3", name: "Decision" },
      { op: "text", nodeId: "node:node-2", patch: { text: "New", color: "#334455" } },
      { op: "style", nodeIds: ["node:node-3"], patch: { fills: [{ kind: "solid", color: "#abcdef" }], stroke: { color: "#000000", width: 3, cap: "round", join: "bevel" }, opacity: 0.8, radius: 4 } },
      { op: "align", nodeIds: ["node:node-3", "node:node-4"], axis: "vertical", mode: "center" },
      { op: "distribute", nodeIds: ["node:node-3", "node:node-4", "node:node-5"], axis: "horizontal" },
      { op: "connector-update", nodeId: "node:node-5", patch: { route: "elbow", endArrow: true, start: { x: 55, y: 40, targetHandle: "node:node-3", anchor: { x: 1, y: 0.5 } } } },
      { op: "boolean", ref: "$boolean", nodeIds: ["node:node-3", "node:node-4"], opName: "union" },
      { op: "reorder", parentId: null, pageId: "page:page-1", orderedIds: ["$boolean", "node:node-5", "node:node-1"] },
      { op: "delete", nodeIds: ["node:node-5"] },
    ] });
    expect(edit.ok).toBe(true);
    if (!edit.ok) return;
    expect(edit.document.nodes["node-2"]?.text).toBe("New");
    expect(edit.document.nodes["node-3"]?.name).toBe("Decision");
    expect(edit.document.nodes["node-3"]?.booleanOp).toBeUndefined();
    expect(edit.document.nodes["node-5"]).toBeUndefined();
  });

  test("rejects hostile operation fields and binds idempotency to the starting document", () => {
    const hostile = editOpenDesign(createEmptyDocument(), { idempotencyKey: "hostile", operations: [{ op: "page", surprise: true }] } as unknown);
    expect(hostile).toMatchObject({ ok: false, error: { code: "invalid_request", stateChanged: false, retrySafe: true } });
    const store = new DesignOperationReceiptStore();
    const first = editOpenDesign(createEmptyDocument(), { idempotencyKey: "same-key", operations: [{ op: "page" }] }, store);
    if (!first.ok) throw new Error(first.error.message);
    const changed = editOpenDesign(first.document, { idempotencyKey: "same-key", operations: [{ op: "page" }] }, store);
    expect(changed).toMatchObject({ ok: false, error: { stateChanged: false } });
  });

  test("rejects hostile nested public payloads before any kernel call", () => {
    const cases: unknown[] = [
      { op: "path", bounds: { x: 0, y: 0, width: 10, height: 10, private: true }, commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }] },
      { op: "transform", updates: [{ nodeId: "node:node-1", x: 1, private: true }] },
      { op: "connector", connector: { route: "straight", start: { x: 0, y: 0, targetId: "private" }, end: { x: 1, y: 1 } } },
      { op: "connector-update", nodeId: "node:node-1", patch: { start: { x: 0, y: 0, targetId: "private" } } },
    ];
    for (const operation of cases) {
      expect(editOpenDesign(createEmptyDocument(), { idempotencyKey: `nested-${cases.indexOf(operation)}`, operations: [operation] })).toMatchObject({
        ok: false, error: { code: "invalid_request", stateChanged: false, retrySafe: true },
      });
    }
  });

  test("fails closed for missing or hostile fields in every public operation family", () => {
    const invalidFamilies: unknown[] = [
      { op: "create", node: { type: "rectangle", private: true } },
      { op: "shape", shape: "rectangle", x: 0, y: 0, height: 10 },
      { op: "path", commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1, y: 1 }] },
      { op: "transform", updates: [{ nodeId: "node:node-1", x: 1, private: true }] },
      { op: "rotate", nodeIds: ["node:node-1"] },
      { op: "rename", nodeId: "node:node-1" },
      { op: "text", nodeId: "node:node-1", patch: { text: "x", private: true } },
      { op: "style", nodeIds: ["node:node-1"], patch: { fills: [{ kind: "solid", color: "#fff", private: true }] } },
      { op: "align", nodeIds: ["node:node-1", "node:node-2"], axis: "diagonal", mode: "center" },
      { op: "distribute", nodeIds: ["node:node-1", "node:node-2"], axis: "horizontal" },
      { op: "reorder", pageId: "page:page-1", orderedIds: ["node:node-1"] },
      { op: "boolean", nodeIds: ["node:node-1", "node:node-2"], opName: "merge" },
      { op: "page", name: 42 },
      { op: "connector", connector: { route: "straight", start: { x: 0, y: 0 }, end: { x: 1, y: 1 } }, stroke: { color: "#000", width: 1, private: true } },
      { op: "connector-update", nodeId: "node:node-1", patch: { start: { x: 0, y: 0, targetId: "node-2" } } },
      { op: "delete", nodeIds: [] },
    ];
    invalidFamilies.forEach((operation, index) => {
      const result = editOpenDesign(createEmptyDocument(), { idempotencyKey: `invalid-family-${index}`, operations: [operation] });
      expect(result).toMatchObject({ ok: false, error: { code: "invalid_request", failedOperationIndex: 0, stateChanged: false, retrySafe: true } });
    });
  });

  test("renames through public handles and temporary refs while rejecting private raw ids", () => {
    const created = editOpenDesign(createEmptyDocument(), { idempotencyKey: "rename-ref", operations: [
      { op: "create", ref: "$card", node: { type: "rectangle" } },
      { op: "rename", nodeId: "$card", name: "  Decision card  " },
    ] });
    expect(created).toMatchObject({ ok: true, document: { nodes: { "node-1": { name: "Decision card" } } } });
    expect(editOpenDesign(createEmptyDocument(), { idempotencyKey: "rename-private", operations: [
      { op: "rename", nodeId: "node-1", name: "Private id" },
    ] })).toMatchObject({ ok: false, error: { code: "invalid_request", stateChanged: false, retrySafe: true } });
    expect(editOpenDesign(createEmptyDocument(), { idempotencyKey: "rename-hostile", operations: [
      { op: "rename", nodeId: "node:node-1", name: "Name", rawId: "node-1" },
    ] as unknown[] })).toMatchObject({ ok: false, error: { code: "invalid_request", retrySafe: true } });
  });

  test("uses a bounded stable fingerprint that changes with document or operation drift", () => {
    const doc = createEmptyDocument();
    const operations = [{ op: "page", name: "Ideas" }] as const;
    const first = designOperationFingerprint(doc, operations);
    expect(first).toMatch(/^v1:[0-9a-f]{16}$/);
    expect(designOperationFingerprint(doc, operations)).toBe(first);
    expect(designOperationFingerprint({ ...doc, pages: [...doc.pages, { id: "page-2", name: "Other", children: [] }] }, operations)).not.toBe(first);
    expect(designOperationFingerprint(doc, [{ op: "page", name: "Different" }])).not.toBe(first);
  });

  test("gives honest recovery at direct-live request safety boundaries", () => {
    const tooManyOperations = Array.from({ length: MAX_EDIT_OPERATIONS + 1 }, () => ({ op: "page" as const }));
    const operationsResult = editOpenDesign(createEmptyDocument(), { idempotencyKey: "operations-bound", operations: tooManyOperations });
    const operationsMessage = operationsResult.ok ? "" : operationsResult.error.message;
    expect(operationsResult).toMatchObject({
      ok: false,
      error: {
        stateChanged: false,
        retrySafe: true,
      },
    });
    expect(operationsMessage.includes(`observed ${MAX_EDIT_OPERATIONS + 1}, maximum ${MAX_EDIT_OPERATIONS}`)).toBe(true);
    const tooManyCommands = [
      { kind: "M" as const, x: 0, y: 0 },
      ...Array.from({ length: MAX_PATH_COMMANDS }, () => ({ kind: "L" as const, x: 1, y: 1 })),
    ];
    const path = editOpenDesign(createEmptyDocument(), { idempotencyKey: "path-bound", operations: [{
      op: "path", bounds: { x: 0, y: 0, width: 10, height: 10 }, commands: tooManyCommands,
    }] });
    const pathMessage = path.ok ? "" : path.error.message;
    expect(path).toMatchObject({
      ok: false,
      error: {
        stateChanged: false,
        retrySafe: true,
      },
    });
    expect(pathMessage.includes(`observed ${MAX_PATH_COMMANDS + 1}, maximum ${MAX_PATH_COMMANDS}`)).toBe(true);
    expect(pathMessage.includes("simplify or resample")).toBe(true);
    expect(pathMessage.includes("split")).toBe(false);
  });

  test("bounds nested direct-live payloads and enforces normalized paths and public handles", () => {
    const nodeHandles = Array.from({ length: 257 }, (_, index) => `node:node-${index + 1}`);
    const cases: unknown[] = [
      { op: "path", bounds: { x: 0, y: 0, width: 10, height: 10 }, commands: [{ kind: "M", x: 0, y: 0 }, { kind: "L", x: 1.01, y: 1 }] },
      { op: "transform", updates: [{ nodeId: "node-1", x: 1 }] },
      { op: "transform", updates: nodeHandles.map((nodeId) => ({ nodeId, x: 1 })) },
      { op: "delete", nodeIds: nodeHandles },
      { op: "style", nodeIds: ["node:node-1"], patch: { fills: Array.from({ length: 17 }, () => ({ kind: "solid", color: "#fff" })) } },
      { op: "text", nodeId: "node:node-1", patch: { text: "x".repeat(20_001) } },
      { op: "text", nodeId: "node:node-1", patch: { fontFamily: "x".repeat(201) } },
      { op: "style", nodeIds: ["node:node-1"], patch: { stroke: { color: "x".repeat(65), width: 1 } } },
    ];
    cases.forEach((operation, index) => {
      expect(editOpenDesign(createEmptyDocument(), { idempotencyKey: `nested-bound-${index}`, operations: [operation] })).toMatchObject({
        ok: false, error: { code: "invalid_request", stateChanged: false, retrySafe: true },
      });
    });
  });
});


test("container semantic preconditions include descendants before subtree mutations", () => {
  const doc = createEmptyDocument();
  const group = createNode({ id: "group", type: "group", parentId: null });
  const child = createNode({ id: "child", type: "rectangle", parentId: "group", x: 10 });
  group.childIds = ["child"];
  doc.nodes = { group, child }; doc.pages[0]!.children = ["group"];
  const operations: DesignOperation[] = [{ op: "rotate", nodeIds: ["node:group"], rotation: 90 }];
  const preconditions = [{ handle: "node:group", semanticVersion: semanticVersionForNode(group, doc) }];
  expect(validateDesignSemanticPreconditions(doc, operations, preconditions)).toBeNull();
  const changed = { ...doc, nodes: { ...doc.nodes, child: { ...child, x: 30 } } };
  expect(validateDesignSemanticPreconditions(changed, operations, preconditions)).toMatchObject({ ok: false, error: { code: "semantic_conflict", stateChanged: false } });
});
