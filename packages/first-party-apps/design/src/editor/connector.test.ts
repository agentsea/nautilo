import { describe, expect, test } from "bun:test";
import { createDefaultManifest, parseDesignHtml, renderSceneSvg, serializeDesignHtml } from "../design-document";
import { appendChild, createEmptyDocument, createNode, type DesignConnector, type DesignDocument } from "../scene-graph";
import { applyDesignTransaction } from "../transactions";
import { connectorGeometry, resolveConnectorEndpoint } from "./connector";
import { DesignStore } from "./store";
import { pathDataFromVectorNetwork } from "../vector";

const applyRuntimeRequest = applyDesignTransaction as (
  document: DesignDocument,
  request: unknown,
) => ReturnType<typeof applyDesignTransaction>;

function targets(): DesignDocument {
  const base = createEmptyDocument();
  const left = createNode({ id: "left", type: "rectangle", parentId: null, x: 0, y: 0, width: 100, height: 80 });
  const right = createNode({ id: "right", type: "rectangle", parentId: null, x: 300, y: 40, width: 120, height: 100, rotation: 90 });
  return appendChild(appendChild({ ...base, nodes: { left, right } }, null, "left", "page-1"), null, "right", "page-1");
}

function attachedConnector(route: DesignConnector["route"] = "straight"): DesignConnector {
  return {
    route,
    start: { x: 0, y: 0, targetId: "left", anchor: { x: 1, y: 0.5 } },
    end: { x: 0, y: 0, targetId: "right", anchor: { x: 0, y: 0.5 } },
    startArrow: true,
    endArrow: true,
  };
}

function addConnector(doc: DesignDocument, connector = attachedConnector()): { document: DesignDocument; id: string } {
  const geometry = connectorGeometry(doc, connector);
  const result = applyDesignTransaction(doc, {
    kind: "create",
    node: {
      type: "vector",
      name: "Connector",
      x: geometry.x,
      y: geometry.y,
      width: geometry.width,
      height: geometry.height,
      vectorNetwork: geometry.network,
      connector,
      style: { stroke: { color: "#123456", width: 2 } },
    },
  });
  if (!result.ok) throw new Error(result.error.message);
  return { document: result.document, id: result.receipt.changedNodeIds[0]! };
}

describe("connector geometry and durable mutation spine", () => {
  test("resolves normalized attachment anchors through target move, resize, and rotation", () => {
    const doc = targets();
    expect(resolveConnectorEndpoint(doc, attachedConnector().start)).toEqual({ x: 100, y: 40 });
    // Right target's left-center rotates around its own center from (300, 90) to (360, 30).
    expect(resolveConnectorEndpoint(doc, attachedConnector().end)).toEqual({ x: 360, y: 30 });
    const added = addConnector(doc);
    const moved = applyDesignTransaction(added.document, {
      kind: "transform",
      updates: [{ nodeId: "left", x: 30, width: 200 }],
    });
    expect(moved.ok).toBe(true);
    if (!moved.ok) return;
    const connector = moved.document.nodes[added.id]!;
    expect(resolveConnectorEndpoint(moved.document, connector.connector!.start)).toEqual({ x: 230, y: 40 });
    expect(connector.vectorNetwork!.vertices.length).toBeGreaterThan(2);
  });

  test("keeps a deleted target's endpoint as its resolved world point and supports one-step undo", () => {
    const store = new DesignStore(targets(), "page-1");
    const id = store.addConnector(attachedConnector());
    const beforeDelete = resolveConnectorEndpoint(store.getDocument(), store.getDocument().nodes[id]!.connector!.start);
    store.deleteNodes(["left"]);
    const detached = store.getDocument().nodes[id]!.connector!.start;
    expect(detached).toEqual({ x: beforeDelete.x, y: beforeDelete.y, detachedFromTargetId: "left" });
    expect(store.getDocument().nodes[id]).toBeDefined();
    store.undo();
    expect(store.getDocument().nodes["left"]).toBeDefined();
    expect(store.getDocument().nodes[id]!.connector!.start.targetId).toBe("left");
  });

  test("reports a detached connector as a changed kernel target even when its pixels stay put", () => {
    const added = addConnector(targets());
    const deleted = applyDesignTransaction(added.document, { kind: "delete", nodeIds: ["left"] });
    expect(deleted.ok).toBe(true);
    if (!deleted.ok) return;
    expect(deleted.receipt.changedNodeIds).toContain(added.id);
    expect(deleted.document.nodes[added.id]!.connector!.start.detachedFromTargetId).toBe("left");
  });

  test("persists free endpoints and emits identical vector geometry for straight and elbow arrowheads", () => {
    const free: DesignConnector = {
      route: "elbow",
      start: { x: 10, y: 20 },
      end: { x: 210, y: 140 },
      startArrow: true,
      endArrow: true,
    };
    const added = addConnector(createEmptyDocument(), free);
    const node = added.document.nodes[added.id]!;
    expect(node.connector).toEqual(free);
    expect(node.vectorNetwork!.segments.length).toBe(7);
    const elbowPath = pathDataFromVectorNetwork(node.vectorNetwork!);
    expect(elbowPath.match(/M /g)?.length).toBe(3); // route + two real arrowhead subpaths
    const svg = renderSceneSvg(added.document);
    expect(svg).toContain("#123456");
    expect(svg).toContain(`d="${elbowPath}"`);
    const straight: DesignConnector = { ...free, route: "straight" };
    const straightAdded = addConnector(createEmptyDocument(), straight);
    const straightPath = pathDataFromVectorNetwork(straightAdded.document.nodes[straightAdded.id]!.vectorNetwork!);
    expect(straightAdded.document.nodes[straightAdded.id]!.vectorNetwork!.segments.length).toBe(5);
    expect(straightPath).not.toBe(elbowPath);
    expect(renderSceneSvg(straightAdded.document)).toContain(`d="${straightPath}"`);
    const reopened = parseDesignHtml(serializeDesignHtml(createDefaultManifest(), added.document));
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.document.scene.nodes[added.id]!.connector).toEqual(free);
  });

  test("rejects hostile connector payloads at the runtime transaction boundary without mutation or aliasing", () => {
    const source = targets();
    const raw = attachedConnector();
    const geometry = connectorGeometry(source, raw);
    const created = applyRuntimeRequest(source, {
      kind: "create",
      node: { type: "vector", x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height, vectorNetwork: geometry.network, connector: raw },
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const id = created.receipt.changedNodeIds[0]!;
    raw.start.anchor!.x = 0;
    expect(created.document.nodes[id]!.connector!.start.anchor!.x).toBe(1);
    expect(source.nodes[id]).toBeUndefined();

    const malformed = (connector: unknown) => applyRuntimeRequest(source, {
      kind: "create",
      node: { type: "vector", x: 0, y: 0, width: 1, height: 1, vectorNetwork: geometry.network, connector },
    });
    for (const connector of [
      { ...attachedConnector(), unknown: true },
      { ...attachedConnector(), start: { x: 0, y: 0, targetId: "left" } },
      { ...attachedConnector(), start: { x: 0, y: 0, targetId: "left", anchor: { x: 2, y: 0 } } },
      { ...attachedConnector(), start: { x: 0, y: 0, targetId: "missing", anchor: { x: 0, y: 0 } } },
    ]) {
      expect(malformed(connector)).toMatchObject({ ok: false, error: { code: "invalid_request" } });
    }
    const targetConnector = addConnector(source);
    const connectorTarget = applyRuntimeRequest(targetConnector.document, {
      kind: "create",
      node: {
        type: "vector", x: 0, y: 0, width: 1, height: 1, vectorNetwork: geometry.network,
        connector: { ...attachedConnector(), start: { x: 0, y: 0, targetId: targetConnector.id, anchor: { x: 0, y: 0 } } },
      },
    });
    expect(connectorTarget).toMatchObject({ ok: false, error: { code: "invalid_request" } });
  });

  test("updates connector metadata through one validated undoable transaction", () => {
    const store = new DesignStore(targets(), "page-1");
    const id = store.addConnector(attachedConnector());
    expect(store.updateConnector(id, { route: "elbow", endArrow: false })).toBe(true);
    expect(store.getDocument().nodes[id]!.connector).toMatchObject({ route: "elbow", endArrow: false });
    expect(store.getDocument().nodes[id]!.vectorNetwork!.segments.length).toBe(5);
    store.undo();
    expect(store.getDocument().nodes[id]!.connector).toMatchObject({ route: "straight", endArrow: true });
    const before = store.getDocument();
    expect(store.updateConnector(id, { start: { x: 0, y: 0, targetId: "missing", anchor: { x: 0, y: 0 } } })).toBe(false);
    expect(store.getDocument()).toBe(before);
  });

  test("refuses transient generic vector and box mutation for connector caches", () => {
    const store = new DesignStore(targets(), "page-1");
    const id = store.addConnector(attachedConnector());
    const before = store.getDocument();
    const node = before.nodes[id]!;
    store.beginTransient();
    store.updateTransientNodes(new Map([[id, { x: 999, y: 999, width: 1, height: 1 }]]));
    store.updateTransientVector(id, { vertices: [], segments: [], regions: [] }, { x: 999, y: 999, width: 1, height: 1 });
    store.endTransient();
    expect(store.getDocument()).toBe(before);
    expect(store.getDocument().nodes[id]).toBe(node);
  });
});
