import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  arrangeNodes,
  createFile,
  createFrame,
  createShape,
  createText,
  editOpenDesign,
  exportSvg,
  exportPng,
  inspectDocument,
  inspectOpenDesign,
  layoutNodes,
  replaceText,
  setNodeProps,
  validateBasenameFilename,
  validateStaleDesignMutation,
  type ServerNautiloAppHost,
} from "./agent-tool-handlers";
import {
  createDefaultManifest,
  serializeDesignHtml,
} from "./design-document";
import {
  appendChild,
  createEmptyDocument,
  createNode,
  type DesignDocument,
} from "./scene-graph";
import {
  semanticVersionForNode,
  semanticVersionForPage,
} from "./design-inspection";

function sampleDoc(): DesignDocument {
  const base = createEmptyDocument();
  const frame = createNode({
    id: "node-1",
    type: "frame",
    parentId: null,
    name: "Hero",
    x: 0,
    y: 0,
    width: 400,
    height: 300,
  });
  const withNode: DesignDocument = { ...base, nodes: { ...base.nodes, "node-1": frame } };
  return appendChild(withNode, null, "node-1", "page-1");
}

function sampleHtml(): string {
  return serializeDesignHtml(createDefaultManifest(), sampleDoc());
}

function samplePreconditions(
  handles: Array<"page:page-1" | "node:node-1">,
): Array<{ handle: string; semanticVersion: string }> {
  const doc = sampleDoc();
  return handles.map((handle) => handle === "page:page-1"
    ? { handle, semanticVersion: semanticVersionForPage(doc.pages[0]!) }
    : { handle, semanticVersion: semanticVersionForNode(doc.nodes["node-1"]!) });
}

function mockHost(overrides?: Partial<ServerNautiloAppHost["document"]>): ServerNautiloAppHost {
  let content = sampleHtml();
  let baseSha256: string | null = "abc123";
  let baseRevision: number | null = 1;

  const document: ServerNautiloAppHost["document"] = {
    async createFromAction(actionId, opts) {
      expect(actionId).toBe("new-design");
      return {
        target: opts.targetSurface === "workspace"
          ? { surface: "workspace" as const, path: opts.filename }
          : { surface: "currentFolder" as const, relativePath: opts.filename },
        displayPath:
          opts.targetSurface === "workspace" ? `workspace:${opts.filename}` : opts.filename,
        opened: opts.openAfterCreate ?? false,
      };
    },
    async read(target) {
      return {
        content,
        mimeType: "text/html",
        displayPath:
          target.surface === "workspace" ? `workspace:${target.path}` : target.relativePath,
        baseSha256,
        baseRevision,
      };
    },
    async write(_target, next, opts) {
      if (opts?.baseSha256 !== baseSha256) {
        return { kind: "conflict", currentSha256: "newer-hash" };
      }
      content = next.content;
      baseSha256 = "saved-hash";
      baseRevision = 2;
      return { kind: "saved", sha256: "saved-hash", revision: 2 };
    },
    async writeBound(next) {
      content = next.content;
      baseSha256 = "bound-saved-hash";
      baseRevision = 2;
      return { kind: "saved", sha256: "bound-saved-hash", revision: 2 };
    },
    async createRasterFromSvg(args) {
      return { ok: true, artifactPath: args.path, sha256: "png-hash", byteLength: 96 };
    },
    async createDocument(args) {
      return {
        ok: true,
        artifactPath: args.path,
        sha256: "created-hash",
        byteLength: new TextEncoder().encode(args.content).byteLength,
      };
    },
    ...overrides,
  };

  return { document };
}

describe("agent-tool-handlers", () => {
  test("trusted stale validation auto-allows disjoint drift and bounds same-target conflicts", () => {
    const original = sampleDoc();
    const preconditions = samplePreconditions(["node:node-1"]);
    const frozenArgs = {
      idempotencyKey: "stale-style-v1",
      preconditions,
      operations: [{
        op: "style",
        nodeIds: ["node:node-1"],
        patch: { fills: [{ kind: "solid", color: "#ff0000" }] },
      }],
    };
    const disjoint = {
      ...original,
      metadata: { ...original.metadata, updatedAt: "2026-08-12T00:00:00.000Z" },
    };
    expect(validateStaleDesignMutation({
      canonicalContent: serializeDesignHtml(createDefaultManifest(), disjoint),
      frozenArgs,
    })).toEqual({ status: "allow_current_binding" });
    expect(validateStaleDesignMutation({
      canonicalContent: serializeDesignHtml(createDefaultManifest(), {
        ...original,
        nodes: {
          ...original.nodes,
          "node-1": { ...original.nodes["node-1"]!, opacity: 0.75 },
        },
      }),
      frozenArgs: {
        idempotencyKey: "stale-create-v1",
        preconditions: samplePreconditions(["page:page-1"]),
        operations: [{
          op: "shape",
          ref: "$new",
          pageId: "page:page-1",
          shape: "ellipse",
          x: 20,
          y: 20,
          width: 80,
          height: 80,
        }],
      },
    })).toEqual({ status: "allow_current_binding" });

    const sameTarget = {
      ...original,
      nodes: {
        ...original.nodes,
        "node-1": {
          ...original.nodes["node-1"]!,
          fills: [{ kind: "solid" as const, color: "#0000ff" }],
        },
      },
    };
    const conflict = validateStaleDesignMutation({
      canonicalContent: serializeDesignHtml(createDefaultManifest(), sameTarget),
      frozenArgs,
    });
    expect(conflict).toEqual({
      status: "semantic_conflict",
      conflicts: [{ handle: "node:node-1", propertyGroups: ["appearance"] }],
      conflictCount: 1,
      omittedConflictCount: 0,
    });
    expect(JSON.stringify(conflict)).not.toContain("#0000ff");
  });

  test("manifest declares the closed live Design tool pair and full operation vocabulary", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "app.json"), "utf8"),
    ) as Record<string, unknown>;
    const agent = manifest["agent"] as Record<string, unknown>;
    const tools = agent["tools"] as Array<Record<string, unknown>>;
    const create = tools.find((tool) => tool["id"] === "create-file");
    const exportSvgTool = tools.find((tool) => tool["id"] === "export-svg");
    const inspect = tools.find((tool) => tool["id"] === "inspect-open-design");
    const edit = tools.find((tool) => tool["id"] === "edit-open-design");
    expect(manifest["liveReview"]).toEqual({ enabled: true });
    expect(inspect).toMatchObject({
      handler: "inspectOpenDesign",
      impact: "read-only",
      inputSchema: { additionalProperties: false },
    });
    expect(edit).toMatchObject({
      handler: "editOpenDesign",
      impact: "high",
      requiredCapability: "use_project_content",
      inputSchema: { additionalProperties: false },
    });
    expect(create).toMatchObject({
      handler: "createFile",
      impact: "high",
      requiredCapability: "use_project_content",
      inputSchema: {
        additionalProperties: false,
        required: ["targetSurface", "filename"],
      },
    });
    expect(create?.["description"]).toContain("basename ending in .design.html, never a path");
    expect(create?.["description"]).toContain("does not claim to open it");
    const createToolProperties = (create?.["inputSchema"] as Record<string, unknown>)["properties"] as Record<string, unknown>;
    expect(createToolProperties["targetSurface"]).toMatchObject({
      enum: ["workspace", "currentFolder"],
    });
    expect(createToolProperties["filename"]).toMatchObject({
      minLength: 13,
      maxLength: 255,
    });
    expect(createToolProperties["openAfterCreate"]).toBeUndefined();
    expect(createToolProperties["roomId"]).toBeUndefined();
    const inspectProperties = (inspect?.["inputSchema"] as Record<string, unknown>)["properties"] as Record<string, unknown>;
    const editProperties = (edit?.["inputSchema"] as Record<string, unknown>)["properties"] as Record<string, unknown>;
    expect(inspectProperties["target"]).toBeUndefined();
    expect(editProperties["target"]).toBeUndefined();
    expect(inspectProperties["sessionToken"]).toBeUndefined();
    expect(inspectProperties["documentVersion"]).toBeUndefined();
    expect(editProperties["sessionToken"]).toBeUndefined();
    expect(editProperties["documentVersion"]).toBeUndefined();
    expect(editProperties["idempotencyKey"]).toBeUndefined();
    const editSchema = edit?.["inputSchema"] as Record<string, unknown>;
    expect(editSchema["required"]).toEqual(["preconditions", "operations"]);
    const preconditions = editProperties["preconditions"] as Record<string, unknown>;
    expect(preconditions).toMatchObject({ type: "array", maxItems: 256 });
    const preconditionItem = preconditions["items"] as Record<string, unknown>;
    expect(preconditionItem).toMatchObject({
      type: "object",
      additionalProperties: false,
      required: ["handle", "semanticVersion"],
    });
    const preconditionProperties = preconditionItem["properties"] as Record<string, Record<string, unknown>>;
    expect(preconditionProperties["semanticVersion"]).toMatchObject({
      type: "string",
      pattern: "^s1:[a-f0-9]{64}$",
      minLength: 67,
      maxLength: 67,
    });
    const operationItem = (editProperties["operations"] as Record<string, unknown>)["items"] as Record<string, unknown>;
    const branches = operationItem["oneOf"] as Array<Record<string, unknown>>;
    expect(branches).toHaveLength(16);
    const operationNames = branches.map((branch) => {
      expect(branch["additionalProperties"]).toBe(false);
      const properties = branch["properties"] as Record<string, Record<string, unknown>>;
      return properties["op"]?.["const"];
    });
    expect(operationNames).toEqual([
      "create", "path", "transform", "rotate", "rename", "text", "style",
      "align", "distribute", "reorder", "boolean", "page", "connector",
      "connector-update", "delete", "image",
    ]);
    const createBranch = branches[0]!;
    const createProperties = createBranch["properties"] as Record<string, unknown>;
    expect(Object.keys(createProperties)).toEqual(["op", "ref", "node", "pageId", "parentId"]);
    expect(createProperties["nodeId"]).toBeUndefined();
    expect(createBranch["required"]).toEqual(["op", "node", "pageId"]);
    expect(branches[1]!["description"]).toContain("creation requires an inspected pageId");
    expect(branches.find((branch) => ((branch["properties"] as Record<string, Record<string, unknown>>)["op"]?.["const"]) === "connector")!["required"]).toContain("pageId");
    const reorderProperties = (branches[9]!["properties"] as Record<string, Record<string, unknown>>);
    expect(reorderProperties["orderedIds"]).toMatchObject({ maxItems: 256 });
    const textPatchProperties = ((branches[5]!["properties"] as Record<string, Record<string, unknown>>)["patch"]!["properties"] as Record<string, unknown>);
    expect(textPatchProperties["lineHeight"]).toEqual({ type: "number", exclusiveMinimum: 0 });
    expect(textPatchProperties["textWrap"]).toEqual({ type: "boolean" });
    const exportProperties = (exportSvgTool?.["inputSchema"] as Record<string, unknown>)["properties"] as Record<string, Record<string, unknown>>;
    expect(exportProperties["scope"]).toMatchObject({ type: "object", additionalProperties: false, required: ["pageHandle"] });
    const scopeProperties = exportProperties["scope"]!["properties"] as Record<string, Record<string, unknown>>;
    expect(scopeProperties["nodeHandles"]).toEqual({ type: "array", items: { type: "string" } });
    expect(scopeProperties["nodeHandles"]?.["maxItems"]).toBeUndefined();
    expect(agent["instructions"]).toContain("expectedGeometry");
    expect(agent["instructions"]).toContain("host supplies the active-document binding");
    expect(agent["instructions"]).toContain("Lines use explicit start and end");
    expect(agent["instructions"]).toContain("implicit default page is not allowed");
    expect(edit?.["description"]).toContain("host supplies session and idempotency fields");
  });

  test("the live Design contract automatically recovers only semantically unchanged stale edits", () => {
    const manifest = JSON.parse(
      readFileSync(join(import.meta.dir, "..", "app.json"), "utf8"),
    ) as Record<string, unknown>;
    const agent = manifest["agent"] as Record<string, unknown>;
    const tools = agent["tools"] as Array<Record<string, unknown>>;
    const edit = tools.find((tool) => tool["id"] === "edit-open-design");
    const instructions = agent["instructions"] as string;
    const description = edit?.["description"] as string;
    const liveGuidance = readFileSync(
      join(import.meta.dir, "../../../server/src/apps/design-live-tool-extension.ts"),
      "utf8",
    );

    for (const contract of [instructions, description, liveGuidance]) {
      const normalized = contract.toLowerCase();
      expect(normalized).toContain("semantic");
      expect(normalized).toContain("precondition");
      expect(normalized).toContain("exact");
      expect(normalized).toContain("automatically");
      expect(normalized).toContain("disjoint");
      expect(normalized).toContain("semantic_conflict");
      expect(normalized).toContain("ask_user");
      expect(normalized).toContain("exact lost-response replay");
      expect(normalized).not.toContain("immediately inspect");
      expect(normalized).not.toContain("fresh idempotencykey");
    }
    expect(instructions).toContain("no second model call or approval");
    expect(instructions).toContain("stateChanged false, retrySafe false");
    expect(description).toContain("existing public handle referenced by the operations");
    expect(liveGuidance).toContain("frozen");
  });

  test("every durable agent reorder flows through the transaction kernel", () => {
    const source = readFileSync(
      join(import.meta.dir, "agent-tool-handlers.ts"),
      "utf8",
    );
    const arrangeStart = source.indexOf("export async function arrangeNodes");
    const exportStart = source.indexOf("export async function exportSvg", arrangeStart);
    const arrangeSource = source.slice(arrangeStart, exportStart);
    expect(arrangeSource).toContain("applyDesignTransaction(doc, {");
    expect(arrangeSource).toContain('kind: "reorder"');
    expect(source).not.toContain("reorderChildren");
  });

  test("validateBasenameFilename rejects unsafe names", () => {
    expect(validateBasenameFilename("Hero.design.html")).toBeNull();
    expect(validateBasenameFilename("../Hero.design.html")).toContain("basename");
    expect(validateBasenameFilename("")).toContain("non-empty");
  });

  test("createFile validates filename and calls createFromAction", async () => {
    const host = mockHost();
    const result = await createFile(
      { targetSurface: "workspace", filename: "Hero.design.html" },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      displayPath: "workspace:Hero.design.html",
      target: { surface: "workspace", path: "Hero.design.html" },
    });
  });

  test("createFile rejects non-Design names, paths, and false open claims before host creation", async () => {
    let creates = 0;
    const host = mockHost({
      async createFromAction() {
        creates += 1;
        throw new Error("must not run");
      },
    });
    for (const args of [
      { targetSurface: "workspace" as const, filename: "Hero.html" },
      { targetSurface: "workspace" as const, filename: ".design.html" },
      { targetSurface: "workspace" as const, filename: "folder/Hero.design.html" },
      { targetSurface: "workspace" as const, filename: `${"x".repeat(256)}.design.html` },
      { targetSurface: "workspace" as const, filename: "Hero.design.html", openAfterCreate: true },
      { targetSurface: "workspace" as const, filename: "Hero.design.html", roomId: "room-forged" },
    ]) {
      expect(await createFile(args as never, { nautiloApp: host })).toMatchObject({ ok: false });
    }
    expect(creates).toBe(0);
  });

  test("inspectDocument returns bounded summary without raw HTML", async () => {
    const host = mockHost();
    const result = await inspectDocument(
      { target: { surface: "workspace", path: "Hero.design.html" } },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.displayPath).toBe("workspace:Hero.design.html");
    expect(result.activePageId).toBe("page-1");
    expect(result.nodeCount).toBe(1);
    expect(result.topLevelFrames).toEqual([
      { id: "node-1", name: "Hero", type: "frame" },
    ]);
    expect(JSON.stringify(result)).not.toContain("<!DOCTYPE html>");
    expect(JSON.stringify(result)).not.toContain("application/vnd.nautilo");
  });

  test("inspectDocument with nodeId returns per-node summary", async () => {
    const host = mockHost();
    const result = await inspectDocument(
      { target: { surface: "workspace", path: "Hero.design.html" }, nodeId: "node-1" },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.node?.id).toBe("node-1");
    expect(result.node?.type).toBe("frame");
  });

  test("inspectOpenDesign reads only server-injected canonical content and returns public handles", async () => {
    let targetedReads = 0;
    const host = mockHost({
      async read() {
        targetedReads++;
        throw new Error("live inspection must not perform a targeted read");
      },
    });
    const result = inspectOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        pageSize: 2,
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: host },
    );
    expect(targetedReads).toBe(0);
    expect(result).toMatchObject({
      ok: true,
      status: "inspected",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      completeness: "complete",
    });
    if (!("ok" in result) || !result.ok) return;
    expect(result.items[0]).toMatchObject({
      kind: "page",
      handle: "page:page-1",
      name: "Page 1",
      topLevelCount: 1,
    });
    expect(result.items[1]).toMatchObject({
      kind: "node",
      handle: "node:node-1",
      parentHandle: null,
    });
    expect(JSON.stringify(result)).not.toContain('"id":"node-1"');
    expect(JSON.stringify(result)).not.toContain("<!DOCTYPE html>");
    expect(JSON.stringify(result)).not.toContain("validated-session");
  });

  test("inspectOpenDesign rejects path-shaped fields and non-canonical live versions", async () => {
    const pathShaped = inspectOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        target: { surface: "workspace", path: "Hero.design.html" },
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: mockHost() },
    );
    expect(pathShaped).toEqual({ ok: false, error: "unknown field target" });

    for (const documentVersion of [
      { kind: "artifact_revision", revision: 1, surprise: true },
      { kind: "artifact_revision", revision: -1 },
      { kind: "local_sha", sha256: "A".repeat(64) },
      { kind: "local_sha", sha256: "a".repeat(64), surprise: true },
    ]) {
      expect(inspectOpenDesign(
        {
          sessionToken: "validated-session",
          documentVersion,
          __canonicalContent: sampleHtml(),
        },
        { nautiloApp: mockHost() },
      )).toEqual({
        ok: false,
        error: "documentVersion must be a supported live document version",
      });
    }
  });

  test("editOpenDesign applies one atomic batch through writeBound and returns handles only", async () => {
    let targetedWrites = 0;
    let boundWrites = 0;
    let persisted = "";
    const host = mockHost({
      async write() {
        targetedWrites++;
        throw new Error("live edit must not perform a targeted write");
      },
      async writeBound(next) {
        boundWrites++;
        persisted = next.content;
        return { kind: "saved", sha256: "b".repeat(64), revision: 2 };
      },
    });
    const result = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        idempotencyKey: "hero-card-v1",
        preconditions: samplePreconditions(["page:page-1", "node:node-1"]),
        operations: [
          {
            op: "create",
            ref: "$card",
            pageId: "page:page-1",
            node: {
              type: "rectangle",
              name: "Card",
              x: 32,
              y: 48,
              width: 240,
              height: 120,
              style: {
                fills: [{ kind: "solid", color: "#2563eb" }],
                stroke: { color: "#0f172a", width: 2 },
              },
            },
          },
          {
            op: "connector",
            pageId: "page:page-1",
            connector: {
              route: "straight",
              start: { x: 0, y: 0, targetHandle: "node:node-1", anchor: { x: 1, y: 0.5 } },
              end: { x: 32, y: 48, targetHandle: "$card", anchor: { x: 0, y: 0.5 } },
              endArrow: true,
            },
          },
        ],
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: host },
    );
    expect(targetedWrites).toBe(0);
    expect(boundWrites).toBe(1);
    expect(persisted).toContain("Card");
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 2 },
      receipt: {
        idempotencyKey: "hero-card-v1",
        outcome: "applied",
        createdRefs: { "$card": "node:node-2" },
      },
      idempotency: { key: "hero-card-v1" },
    });
    expect(JSON.stringify(result)).not.toContain('"nodeId"');
    expect(JSON.stringify(result)).not.toContain("validated-session");
  });

  test("live top-level shapes and connector batch accepts explicit page-level null and same-batch refs", async () => {
    let writes = 0;
    let persisted = "";
    const result = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        idempotencyKey: "live-top-level-shapes-connector-v1",
        preconditions: samplePreconditions(["page:page-1"]),
        operations: [
          { op: "shape", ref: "$ellipse", shape: "ellipse", x: 40, y: 60, width: 120, height: 80, pageId: "page:page-1", parentId: null },
          { op: "shape", ref: "$diamond", shape: "diamond", x: 240, y: 60, width: 120, height: 80, pageId: "page:page-1", parentId: null },
          {
            op: "connector",
            ref: "$link",
            pageId: "page:page-1",
            parentId: null,
            connector: {
              route: "straight",
              start: { x: 160, y: 100, targetHandle: "$ellipse", anchor: { x: 1, y: 0.5 } },
              end: { x: 240, y: 100, targetHandle: "$diamond", anchor: { x: 0, y: 0.5 } },
            },
          },
          { op: "connector-update", nodeId: "$link", patch: { route: "elbow", endArrow: true } },
        ],
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: mockHost({
        async writeBound(next) {
          writes++;
          persisted = next.content;
          return { kind: "saved", sha256: "f".repeat(64), revision: 2 };
        },
      }) },
    );

    expect(writes).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      receipt: {
        outcome: "applied",
        createdRefs: {
          $ellipse: "node:node-2",
          $diamond: "node:node-3",
          $link: "node:node-4",
        },
      },
    });
    expect(persisted).toContain('"route": "elbow"');
    expect(persisted).toContain('"endArrow": true');
  });

  test("exact create then style, rename, and text $ref batch applies atomically", async () => {
    let writes = 0;
    let persisted = "";
    const host = mockHost({
      async writeBound(next) {
        writes++;
        persisted = next.content;
        return { kind: "saved", sha256: "d".repeat(64), revision: 2 };
      },
    });
    const result = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        idempotencyKey: "live-create-style-rename-text-v2",
        preconditions: samplePreconditions(["page:page-1"]),
        operations: [
          {
            op: "create",
            ref: "$card",
            pageId: "page:page-1",
            node: { type: "text", x: 40, y: 60, width: 240, height: 80 },
          },
          {
            op: "style",
            nodeIds: ["$card"],
            patch: {
              fills: [{ kind: "solid", color: "#2563eb" }],
              stroke: { color: "#0f172a", width: 2 },
            },
          },
          { op: "rename", nodeId: "$card", name: "Launch card" },
          {
            op: "text",
            nodeId: "$card",
            patch: { text: "Ship it", fontSize: 28, color: "#ffffff" },
          },
        ],
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: host },
    );

    expect(writes).toBe(1);
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      receipt: {
        outcome: "applied",
        createdRefs: { "$card": "node:node-2" },
      },
    });
    expect(persisted).toContain("Launch card");
    expect(persisted).toContain("Ship it");
    expect(persisted).toContain("#2563eb");
  });

  test("create with irrelevant nodeId remains a typed no-write runtime rejection", async () => {
    let writes = 0;
    const result = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        idempotencyKey: "bad-create-node-id-v1",
        operations: [{
          op: "create",
          ref: "$card",
          nodeId: "$card",
          node: { type: "text" },
        }],
        __canonicalContent: sampleHtml(),
      },
      { nautiloApp: mockHost({
        async writeBound() {
          writes++;
          return { kind: "saved", sha256: "e".repeat(64), revision: 2 };
        },
      }) },
    );
    expect(writes).toBe(0);
    expect(result).toMatchObject({
      ok: false,
      status: "rejected",
      code: "invalid_request",
      message: "unknown field nodeId",
      stateChanged: false,
      retrySafe: true,
      failedOperationIndex: 0,
    });
    expect(result).toHaveProperty(
      "recovery",
      "Correct operation 0 using the typed error message, then retry with a new idempotencyKey.",
    );
  });

  test("Pen geometry round-trips from normalized inspection into expectedGeometry revision", async () => {
    let persisted = sampleHtml();
    let revision = 1;
    let writes = 0;
    const host = mockHost({
      async writeBound(next) {
        writes++;
        persisted = next.content;
        revision++;
        return { kind: "saved", sha256: "c".repeat(64), revision };
      },
    });
    const created = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 1 },
        idempotencyKey: "pen-create-v1",
        preconditions: samplePreconditions(["page:page-1"]),
        operations: [{
          op: "path",
          ref: "$pen",
          pageId: "page:page-1",
          bounds: { x: 20, y: 30, width: 200, height: 100 },
          commands: [
            { kind: "M", x: 0, y: 0 },
            { kind: "C", c1x: 0.2, c1y: 0, c2x: 0.8, c2y: 1, x: 1, y: 1 },
          ],
        }],
        __canonicalContent: persisted,
      },
      { nautiloApp: host },
    );
    expect(created).toMatchObject({
      ok: true,
      status: "saved",
      receipt: { createdRefs: { "$pen": "node:node-2" } },
    });
    const inspected = inspectOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        nodeHandle: "node:node-2",
        includeGeometry: true,
        __canonicalContent: persisted,
      },
      { nautiloApp: host },
    );
    expect(inspected).toMatchObject({ ok: true, completeness: "complete" });
    if (!("ok" in inspected) || !inspected.ok) return;
    const expectedGeometry = inspected.items
      .filter((item) => item.kind === "path-command")
      .map((item) => item.command);
    expect(expectedGeometry).toEqual([
      { kind: "M", x: 0, y: 0 },
      { kind: "C", c1x: 0.2, c1y: 0, c2x: 0.8, c2y: 1, x: 1, y: 1 },
    ]);
    const providerExpectedGeometry = expectedGeometry.map((command) =>
      command.kind === "C"
        ? {
            kind: "C" as const,
            x: command.x,
            y: command.y,
            c1x: command.c1x,
            c1y: command.c1y,
            c2x: command.c2x,
            c2y: command.c2y,
          }
        : command
    );
    expect(JSON.stringify(providerExpectedGeometry)).not.toBe(JSON.stringify(expectedGeometry));
    const firstPathCommand = inspected.items.find(
      (item) => item.kind === "path-command",
    );
    const inspectedNode = inspected.items.find((item) => item.kind === "node");
    if (!inspectedNode || inspectedNode.kind !== "node") return;
    const penPreconditions = [{
      handle: inspectedNode.handle,
      semanticVersion: inspectedNode.semanticVersion,
    }];
    expect(firstPathCommand).toMatchObject({
      kind: "path-command",
      coordinateSpace: "node-local-normalized",
    });
    const revised = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 2 },
        idempotencyKey: "pen-revise-v1",
        preconditions: penPreconditions,
        operations: [{
          op: "path",
          nodeId: "node:node-2",
          bounds: { x: 20, y: 30, width: 200, height: 100 },
          expectedGeometry: providerExpectedGeometry,
          commands: [
            { kind: "M", x: 0, y: 0 },
            { kind: "C", c1x: 0.3, c1y: 0, c2x: 0.7, c2y: 1, x: 1, y: 1 },
          ],
        }],
        __canonicalContent: persisted,
      },
      { nautiloApp: host },
    );
    expect(revised).toMatchObject({ ok: true, status: "saved" });
    expect(writes).toBe(2);
    const stale = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "artifact_revision", revision: 3 },
        idempotencyKey: "pen-stale-v1",
        preconditions: penPreconditions,
        operations: [{
          op: "path",
          nodeId: "node:node-2",
          bounds: { x: 20, y: 30, width: 200, height: 100 },
          expectedGeometry: providerExpectedGeometry,
          commands: [
            { kind: "M", x: 0, y: 0 },
            { kind: "L", x: 1, y: 1 },
          ],
        }],
        __canonicalContent: persisted,
      },
      { nautiloApp: host },
    );
    expect(stale).toMatchObject({
      ok: false,
      status: "rejected",
      code: "semantic_conflict",
      stateChanged: false,
      retrySafe: false,
      recovery: { action: "ask_user", reason: "refresh_intent" },
    });
    expect(writes).toBe(2);
  });

  test("editOpenDesign never writes for noop, invalid handles, or rejected outer fields", async () => {
    let writes = 0;
    const host = mockHost({
      async writeBound() {
        writes++;
        return { kind: "saved", sha256: "b".repeat(64), revision: 2 };
      },
    });
    const base = {
      sessionToken: "validated-session",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      __canonicalContent: sampleHtml(),
    };
    const noop = await editOpenDesign(
      { ...base, idempotencyKey: "noop-v1", preconditions: samplePreconditions(["node:node-1"]), operations: [{ op: "transform", updates: [{ nodeId: "node:node-1", x: 0 }] }] },
      { nautiloApp: host },
    );
    const rawId = await editOpenDesign(
      { ...base, idempotencyKey: "raw-id-v1", operations: [{ op: "delete", nodeIds: ["node-1"] }] },
      { nautiloApp: host },
    );
    const target = await editOpenDesign(
      { ...base, idempotencyKey: "target-v1", operations: [{ op: "delete", nodeIds: ["node:node-1"] }], path: "Hero.design.html" },
      { nautiloApp: host },
    );
    expect(noop).toMatchObject({ ok: true, status: "noop", receipt: { outcome: "noop" } });
    expect(rawId).toMatchObject({ ok: false, status: "rejected", stateChanged: false });
    expect(target).toEqual({ ok: false, error: "unknown field path" });
    expect(writes).toBe(0);
  });

  test("editOpenDesign rejects hostile malformed representative families before write", async () => {
    let writes = 0;
    const host = mockHost({
      async writeBound() {
        writes++;
        return { kind: "saved", sha256: "b".repeat(64), revision: 2 };
      },
    });
    const base = {
      sessionToken: "validated-session",
      documentVersion: { kind: "artifact_revision" as const, revision: 1 },
      __canonicalContent: sampleHtml(),
    };
    const requests: unknown[][] = [
      [{ op: "create", node: { type: "rectangle", style: { stroke: { color: "#000", width: 1, rawId: "node-1" } } } }],
      [{ op: "shape", shape: "star", x: 0, y: 0, width: 100, height: 100, style: { fills: [{ kind: "solid", color: "#fff", target: "dom" }] } }],
      [JSON.parse('{"op":"text","nodeId":"node:node-1","patch":{"text":"No","__proto__":{"polluted":true}}}')],
      [{ op: "style", nodeIds: ["node:node-1"], patch: { stroke: { color: "#000" } } }],
      [{ op: "align", nodeIds: "node:node-1", axis: "horizontal", mode: "center" }],
      [{ op: "reorder", parentId: null, pageId: "page:page-1", orderedIds: ["node:node-1"], path: "/tmp/design" }],
      [{ op: "connector-update", nodeId: "node:node-1", patch: { start: { x: 0, y: 0, targetHandle: "node:node-1", pointerId: 7 } } }],
      [{ op: "delete", nodeIds: [] }],
    ];
    for (let index = 0; index < requests.length; index++) {
      const result = await editOpenDesign(
        { ...base, idempotencyKey: `hostile-${index}`, operations: requests[index] },
        { nautiloApp: host },
      );
      expect(result).toMatchObject({
        ok: false,
        status: "rejected",
        code: "invalid_request",
        stateChanged: false,
      });
    }
    expect(writes).toBe(0);
  });

  test("editOpenDesign reports a bound-write conflict without a success receipt", async () => {
    const result = await editOpenDesign(
      {
        sessionToken: "validated-session",
        documentVersion: { kind: "local_sha", sha256: "a".repeat(64) },
        idempotencyKey: "conflict-v1",
        preconditions: samplePreconditions(["node:node-1"]),
        operations: [{ op: "delete", nodeIds: ["node:node-1"] }],
        __canonicalContent: sampleHtml(),
      },
      {
        nautiloApp: mockHost({
          async writeBound() {
            return { kind: "conflict", currentSha256: "b".repeat(64) };
          },
        }),
      },
    );
    expect(result).toMatchObject({
      ok: false,
      status: "conflict",
      code: "version_conflict",
      stateChanged: false,
      retrySafe: true,
    });
    expect(JSON.stringify(result)).not.toContain("receipt");
  });

  test("createFrame persists a new frame and returns saved status", async () => {
    const host = mockHost();
    const result = await createFrame(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        name: "Card",
        x: 100,
        y: 100,
        width: 200,
        height: 200,
        fills: [{ kind: "solid", color: "#dbeafe" }],
        radius: 8,
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      nodeId: "node-2",
      sha256: "saved-hash",
    });
  });

  test("createText persists a new text node", async () => {
    const host = mockHost();
    const result = await createText(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        parentId: "node-1",
        text: "Hello",
        fontSize: 18,
        color: "#0f172a",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", nodeId: "node-2" });
  });

  test("createText rejects missing text", async () => {
    const host = mockHost();
    const result = await createText(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        // @ts-expect-error missing required text
        text: undefined,
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
  });

  test("createShape rejects unknown shape kinds in V1", async () => {
    const host = mockHost();
    const result = await createShape(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        // @ts-expect-error intentionally wrong shape
        shape: "circle",
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("rectangle");
  });

  test("setNodeProps updates geometry and persists", async () => {
    const host = mockHost();
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-1",
        props: { x: 50, y: 60, width: 999, radius: 4 },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", nodeId: "node-1" });
  });

  test("agent durable write forwards the document read sha and revision precondition", async () => {
    let receivedBase: { baseSha256?: string | null; baseRevision?: number | null } | undefined;
    const host = mockHost({
      async write(_target, _next, opts) {
        receivedBase = opts;
        return { kind: "saved", sha256: "saved-hash", revision: 2 };
      },
    });
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-1",
        props: { x: 50 },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", revision: 2 });
    expect(receivedBase).toEqual({ baseSha256: "abc123", baseRevision: 1 });
  });

  test("setNodeProps rejects unsafe props keys", async () => {
    const host = mockHost();
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-1",
        props: JSON.parse('{"__proto__":true}') as Record<string, unknown>,
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Unsafe key");
  });

  test("setNodeProps rejects D385-blocked image sources instead of bypassing the kernel", async () => {
    const host = mockHost();
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-1",
        props: { src: "data:image/png;base64,AA==" },
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("assetRef");
  });

  test("setNodeProps rejects an empty patch instead of writing metadata without a kernel request", async () => {
    const host = mockHost();
    const result = await setNodeProps(
      { target: { surface: "workspace", path: "Hero.design.html" }, nodeId: "node-1", props: {} },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("at least one");
  });

  test("replaceText delegates to setNodeProps and persists", async () => {
    const host = mockHost();
    const created = await createText(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        text: "Before",
      },
      { nautiloApp: host },
    );
    expect(created).toMatchObject({ ok: true, status: "saved", nodeId: "node-2" });
    const result = await replaceText(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-2",
        text: "Updated",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", nodeId: "node-2" });
  });

  test("layoutNodes delegates align intent to the kernel", async () => {
    const host = mockHost();
    await createFrame(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        x: 100,
        y: 0,
        width: 100,
        height: 100,
      },
      { nautiloApp: host },
    );
    const result = await layoutNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeIds: ["node-1", "node-2"],
        operation: "align",
        axis: "horizontal",
        mode: "center",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", changedNodeIds: ["node-2"] });
  });

  test("layoutNodes delegates distribute intent to the kernel", async () => {
    const host = mockHost();
    await createFrame(
      { target: { surface: "workspace", path: "Hero.design.html" }, x: 100, y: 0, width: 100, height: 100 },
      { nautiloApp: host },
    );
    await createFrame(
      { target: { surface: "workspace", path: "Hero.design.html" }, x: 600, y: 0, width: 50, height: 100 },
      { nautiloApp: host },
    );
    const result = await layoutNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeIds: ["node-1", "node-2", "node-3"],
        operation: "distribute",
        axis: "horizontal",
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", changedNodeIds: ["node-2"] });
  });

  test("layoutNodes rejects align-only mode on distribute", async () => {
    const result = await layoutNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeIds: ["node-1", "node-2", "node-3"],
        operation: "distribute",
        axis: "horizontal",
        mode: "center",
      },
      { nautiloApp: mockHost() },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("only valid");
  });

  test("same-value mutations return noop without document.write", async () => {
    let writes = 0;
    const host = mockHost({
      async write() {
        writes++;
        return { kind: "saved", sha256: "saved-hash", revision: 2 };
      },
    });
    const props = await setNodeProps(
      { target: { surface: "workspace", path: "Hero.design.html" }, nodeId: "node-1", props: { x: 0 } },
      { nautiloApp: host },
    );
    const layout = await layoutNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeIds: ["node-1"],
        operation: "align",
        axis: "horizontal",
        mode: "start",
      },
      { nautiloApp: host },
    );
    expect(props).toMatchObject({ ok: true, status: "noop", nodeId: "node-1" });
    expect(layout).toMatchObject({ ok: true, status: "noop", changedNodeIds: [] });
    expect(writes).toBe(0);
  });

  test("arrangeNodes reorders top-level page children", async () => {
    const host = mockHost();
    // Create two more frames so we have 3 top-level nodes to reorder.
    await createFrame(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        name: "B",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      { nautiloApp: host },
    );
    await createFrame(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        name: "C",
        x: 0,
        y: 0,
        width: 100,
        height: 100,
      },
      { nautiloApp: host },
    );
    const result = await arrangeNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        parentId: null,
        pageId: "page-1",
        nodeIds: ["node-3", "node-2", "node-1"],
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({ ok: true, status: "saved", reorderedCount: 3 });
  });

  test("arrangeNodes rejects mismatched child sets", async () => {
    const host = mockHost();
    const result = await arrangeNodes(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        parentId: null,
        pageId: "page-1",
        nodeIds: ["missing"],
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
  });

  test("exportSvg renders and persists canonical SVG beside a workspace source", async () => {
    const capture: { value: {
      surface: string;
      path: string;
      content: string;
      mimeType?: string;
      overwrite?: boolean;
      colocateWith?: unknown;
    } | null } = { value: null };
    const host = mockHost({
      async createDocument(args) {
        capture.value = args;
        return {
          ok: true,
          artifactPath: args.path,
          sha256: "svg-hash",
          byteLength: new TextEncoder().encode(args.content).byteLength,
        };
      },
    });
    const result = await exportSvg(
      {
        source: { surface: "workspace", path: "designs/Hero.design.html" },
        target: { surface: "workspace", path: "designs/Hero.svg" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "exported",
      artifactPath: "designs/Hero.svg",
      displayPath: "designs/Hero.svg",
      sha256: "svg-hash",
      scope: { pageHandle: "page:page-1" },
    });
    expect(capture.value?.surface).toBe("workspace");
    expect(capture.value?.path).toBe("designs/Hero.svg");
    expect(capture.value?.mimeType).toBe("image/svg+xml");
    expect(capture.value?.colocateWith).toEqual({
      surface: "workspace",
      path: "designs/Hero.design.html",
    });
    expect(capture.value?.content.startsWith("<svg")).toBe(true);
    expect(capture.value?.content).toContain("<rect");
    expect(capture.value?.content).toContain('width="400"');
    expect(capture.value?.content).not.toContain("application/vnd.nautilo.design");
  });

  test("PNG export shares scope and collision recovery and delegates only outlined SVG to the host", async () => {
    const doc = sampleDoc();
    const label = createNode({ id: "label", type: "text", parentId: null, text: "AV café",
      fontFamily: "Nautilo Noto Sans", fontSize: 24, x: 500, y: 20, width: 150, height: 40 });
    doc.nodes[label.id] = label;
    doc.pages[0]!.children.push(label.id);
    const captures: Array<Parameters<ServerNautiloAppHost["document"]["createRasterFromSvg"]>[0]> = [];
    const host = mockHost({
      async read() { return { content: serializeDesignHtml(createDefaultManifest(), doc), mimeType: "text/html", displayPath: "Hero.design.html", baseSha256: "source", baseRevision: 1 }; },
      async createDocument() { throw new Error("PNG must use the binary host operation"); },
      async createRasterFromSvg(args) {
        captures.push(args);
        return args.overwrite
          ? { ok: true, artifactPath: args.path, sha256: "png", byteLength: 123 }
          : { ok: false, code: "EXISTS", message: "Already exists" };
      },
    });
    const args = { source: { surface: "workspace" as const, path: "Hero.design.html" },
      target: { surface: "workspace" as const, path: "Hero.png" },
      scope: { pageHandle: "page:page-1", nodeHandles: ["node:label"] } };
    expect(await exportPng(args, { nautiloApp: host })).toMatchObject({ status: "conflict" });
    expect(await exportPng({ ...args, overwrite: true }, { nautiloApp: host })).toMatchObject({
      status: "exported", artifactPath: "Hero.png", sha256: "png", scope: args.scope,
    });
    expect(captures).toHaveLength(2);
    expect(captures[0]).toMatchObject({ format: "png", colocateWith: args.source });
    expect(captures[0]!.svg).toContain("<path");
    expect(captures[0]!.svg).not.toMatch(/<(?:text|style|rect)\b/);
    expect(await exportPng({ ...args, target: { surface: "workspace", path: "Hero.svg" } }, { nautiloApp: host })).toMatchObject({ ok: false });
    expect(captures).toHaveLength(2);
  });

  test("PNG export retains partial-write facts as a failed result without retrying or relabeling it", async () => {
    let rasterWrites = 0;
    const host = mockHost({
      async createDocument() {
        throw new Error("PNG export must not fall back to document writing");
      },
      async createRasterFromSvg() {
        rasterWrites += 1;
        return {
          ok: false,
          code: "PARTIAL_WRITE",
          message: "Bytes reached storage but artifact metadata is unconfirmed.",
          displayPath: "exports/Hero.png",
          bytesWritten: 1_024,
          metadataConfirmed: false as const,
          stateChanged: true as const,
          retrySafe: false as const,
        };
      },
    });

    const result = await exportPng({
      source: { surface: "workspace", path: "Hero.design.html" },
      target: { surface: "workspace", path: "exports/Hero.png" },
    }, { nautiloApp: host });

    expect(result).toEqual({
      ok: true,
      status: "failed",
      code: "PARTIAL_WRITE",
      message: "Bytes reached storage but artifact metadata is unconfirmed.",
      displayPath: "exports/Hero.png",
      bytesWritten: 1_024,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    });
    expect(rasterWrites).toBe(1);
    expect(result).not.toMatchObject({ status: "conflict" });
    expect(result).not.toMatchObject({ status: "exported" });
  });

  test("exportSvg validates public scope against a second page and exports only its selected node", async () => {
    const second = createNode({
      id: "node-2", type: "rectangle", parentId: null, name: "Second page rectangle",
      x: 20, y: 30, width: 70, height: 40,
    });
    const base = sampleDoc();
    const scopedDocument: DesignDocument = {
      ...base,
      pages: [...base.pages, { id: "page-2", name: "Second", children: ["node-2"] }],
      nodes: { ...base.nodes, "node-2": second },
    };
    const sourceContent = serializeDesignHtml(createDefaultManifest(), scopedDocument);
    const capture: { value: string | null } = { value: null };
    let sourceReads = 0;
    let sourceWrites = 0;
    const host = mockHost({
      async read() {
        sourceReads += 1;
        return { content: sourceContent, mimeType: "text/html", displayPath: "Hero.design.html", baseSha256: "abc123", baseRevision: 1 };
      },
      async createDocument(args) {
        capture.value = args.content;
        return { ok: true, artifactPath: args.path, sha256: "scope-hash", byteLength: args.content.length };
      },
      async write() {
        sourceWrites += 1;
        return { kind: "saved", sha256: "unexpected", revision: 2 };
      },
    });
    const result = await exportSvg({
      source: { surface: "workspace", path: "Hero.design.html" },
      target: { surface: "workspace", path: "Second.svg" },
      scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-2"] },
    }, { nautiloApp: host });
    expect(result).toMatchObject({
      ok: true,
      status: "exported",
      scope: { pageHandle: "page:page-2", nodeHandles: ["node:node-2"] },
    });
    expect(capture.value).toContain('width="70"');
    expect(capture.value).not.toContain('width="400"');
    expect(sourceReads).toBe(1);
    expect(sourceWrites).toBe(0);
  });

  test("SVG and PNG export ignore image sources outside the visible requested scope", async () => {
    const sourceImage = (id: string, parentId: string | null) => createNode({
      id,
      type: "image",
      parentId,
      name: "Referenced image",
      x: 20,
      y: 20,
      width: 64,
      height: 64,
      src: "https://example.test/image.png",
    });

    const otherPageImage = sourceImage("other-page-image", null);
    const baseWithOtherPage = sampleDoc();
    const onOtherPage: DesignDocument = {
      ...baseWithOtherPage,
      pages: [
        ...baseWithOtherPage.pages,
        { id: "page-2", name: "Other page", children: [otherPageImage.id] },
      ],
      nodes: { ...baseWithOtherPage.nodes, [otherPageImage.id]: otherPageImage },
    };

    const outsideImage = sourceImage("outside-image", null);
    const baseWithOutsideImage = sampleDoc();
    const outsideSelection = appendChild(
      {
        ...baseWithOutsideImage,
        nodes: { ...baseWithOutsideImage.nodes, [outsideImage.id]: outsideImage },
      },
      null,
      outsideImage.id,
      "page-1",
    );

    const hiddenFrame = createNode({
      id: "hidden-frame",
      type: "frame",
      parentId: null,
      hidden: true,
      width: 100,
      height: 100,
    });
    const hiddenImage = sourceImage("hidden-image", hiddenFrame.id);
    const hiddenBase = sampleDoc();
    let underHiddenAncestor = appendChild(
      {
        ...hiddenBase,
        nodes: {
          ...hiddenBase.nodes,
          [hiddenFrame.id]: hiddenFrame,
          [hiddenImage.id]: hiddenImage,
        },
      },
      null,
      hiddenFrame.id,
      "page-1",
    );
    underHiddenAncestor = appendChild(
      underHiddenAncestor,
      hiddenFrame.id,
      hiddenImage.id,
    );

    const cases = [
      { document: onOtherPage, scope: { pageHandle: "page:page-1" } },
      {
        document: outsideSelection,
        scope: { pageHandle: "page:page-1", nodeHandles: ["node:node-1"] },
      },
      { document: underHiddenAncestor, scope: { pageHandle: "page:page-1" } },
    ];
    for (const format of ["svg", "png"] as const) {
      for (const [index, entry] of cases.entries()) {
        let creates = 0;
        const host = mockHost({
          async read() {
            return {
              content: serializeDesignHtml(createDefaultManifest(), entry.document),
              mimeType: "text/html",
              displayPath: "Hero.design.html",
              baseSha256: "abc123",
              baseRevision: 1,
            };
          },
          async createDocument(args) {
            creates += 1;
            return { ok: true, artifactPath: args.path, sha256: "svg", byteLength: 1 };
          },
          async createRasterFromSvg(args) {
            creates += 1;
            return { ok: true, artifactPath: args.path, sha256: "png", byteLength: 1 };
          },
        });
        const args = {
          source: { surface: "workspace" as const, path: "Hero.design.html" },
          target: { surface: "workspace" as const, path: `Hero-${index}.${format}` },
          scope: entry.scope,
        };
        const result = format === "svg"
          ? await exportSvg(args, { nautiloApp: host })
          : await exportPng(args, { nautiloApp: host });
        expect(result).toMatchObject({ ok: true, status: "exported" });
        expect(creates).toBe(1);
      }
    }
  });

  test("exportSvg rejects empty, unknown, and cross-page scopes before creating an artifact", async () => {
    const second = createNode({ id: "node-2", type: "rectangle", parentId: null, width: 10, height: 10 });
    const base = sampleDoc();
    const scopedDocument: DesignDocument = {
      ...base,
      pages: [...base.pages, { id: "page-2", name: "Second", children: ["node-2"] }],
      nodes: { ...base.nodes, "node-2": second },
    };
    let creates = 0;
    const host = mockHost({
      async read() {
        return { content: serializeDesignHtml(createDefaultManifest(), scopedDocument), mimeType: "text/html", displayPath: "Hero.design.html", baseSha256: "abc123", baseRevision: 1 };
      },
      async createDocument() {
        creates += 1;
        return { ok: true, artifactPath: "unexpected.svg", sha256: "unexpected", byteLength: 0 };
      },
    });
    for (const scope of [
      { pageHandle: "page:page-2", nodeHandles: [] },
      { pageHandle: "page:page-2", nodeHandles: ["node:missing"] },
      { pageHandle: "page:page-2", nodeHandles: ["node:node-1"] },
    ]) {
      const result = await exportSvg({
        source: { surface: "workspace", path: "Hero.design.html" },
        target: { surface: "workspace", path: "Scoped.svg" },
        scope,
      }, { nautiloApp: host });
      expect(result.ok).toBe(false);
    }
    expect(creates).toBe(0);
  });

  test("exportSvg refuses Current Folder until create-only relay writes are atomic", async () => {
    let reads = 0;
    let creates = 0;
    const host = mockHost({
      async read() {
        reads += 1;
        return {
          content: sampleHtml(),
          mimeType: "text/html",
          displayPath: "designs/Hero.design.html",
          baseSha256: "abc123",
          baseRevision: 1,
        };
      },
      async createDocument() {
        creates += 1;
        return {
          ok: true as const,
          artifactPath: "exports/Hero.svg",
          sha256: "svg-hash",
          byteLength: 1,
        };
      },
    });
    const result = await exportSvg(
      {
        source: { surface: "currentFolder", path: "designs/Hero.design.html" },
        target: { surface: "currentFolder", path: "exports/Hero.svg" },
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: false,
      error:
        "SVG export currently requires a workspace destination because Current Folder does not provide atomic create-only writes.",
    });
    expect(reads).toBe(0);
    expect(creates).toBe(0);
  });

  test("exportSvg reports a target collision and forwards explicit overwrite", async () => {
    const conflictHost = mockHost({
      async createDocument() {
        return {
          ok: false,
          code: "EXISTS",
          message: 'A file already exists at "Hero.svg".',
        };
      },
    });
    const conflict = await exportSvg(
      {
        source: { surface: "workspace", path: "Hero.design.html" },
        target: { surface: "workspace", path: "Hero.svg" },
      },
      { nautiloApp: conflictHost },
    );
    expect(conflict).toEqual({
      ok: true,
      status: "conflict",
      target: { surface: "workspace", path: "Hero.svg" },
      message: 'A file already exists at "Hero.svg".',
    });

    let overwrite: boolean | undefined;
    const overwriteHost = mockHost({
      async createDocument(args) {
        overwrite = args.overwrite;
        return {
          ok: true,
          artifactPath: args.path,
          sha256: "svg-hash",
          byteLength: 1,
        };
      },
    });
    await exportSvg(
      {
        source: { surface: "workspace", path: "Hero.design.html" },
        target: { surface: "workspace", path: "Hero.svg" },
        overwrite: true,
      },
      { nautiloApp: overwriteHost },
    );
    expect(overwrite).toBe(true);
  });

  test("exportSvg rejects invalid conversion locations and extensions before writing", async () => {
    let creates = 0;
    const host = mockHost({
      async createDocument() {
        creates += 1;
        return {
          ok: true,
          artifactPath: "unused.svg",
          sha256: "unused",
          byteLength: 0,
        };
      },
    });
    for (const args of [
      {
        source: { surface: "workspace" as const, path: "Hero.html" },
        target: { surface: "workspace" as const, path: "Hero.svg" },
      },
      {
        source: { surface: "workspace" as const, path: "../Hero.design.html" },
        target: { surface: "workspace" as const, path: "Hero.svg" },
      },
      {
        source: { surface: "currentFolder" as const, path: "Hero.design.html" },
        target: { surface: "currentFolder" as const, path: "../Hero.svg" },
      },
      {
        source: { surface: "workspace" as const, path: "Hero.design.html" },
        target: { surface: "workspace" as const, path: "Hero.png" },
      },
    ]) {
      const result = await exportSvg(args, { nautiloApp: host });
      expect(result.ok).toBe(false);
    }
    expect(creates).toBe(0);
  });

  test("exportSvg does not write a malformed canonical document", async () => {
    let creates = 0;
    const host = mockHost({
      async read() {
        return {
          content: "<html><body>not a Nautilo Design document</body></html>",
          mimeType: "text/html",
          displayPath: "Hero.design.html",
          baseSha256: "abc123",
          baseRevision: 1,
        };
      },
      async createDocument() {
        creates += 1;
        return {
          ok: true,
          artifactPath: "Hero.svg",
          sha256: "unexpected",
          byteLength: 0,
        };
      },
    });
    const result = await exportSvg(
      {
        source: { surface: "workspace", path: "Hero.design.html" },
        target: { surface: "workspace", path: "Hero.svg" },
      },
      { nautiloApp: host },
    );
    expect(result).toMatchObject({
      ok: true,
      status: "failed",
      code: "PARSER_FAILED",
    });
    expect(creates).toBe(0);
  });

  test("SVG and PNG export reject a selected visible image before calling the host", async () => {
    const image = createNode({
      id: "image-1",
      type: "image",
      parentId: null,
      name: "Remote image",
      x: 0,
      y: 0,
      width: 64,
      height: 64,
      src: "https://example.test/image.png",
    });
    const withImage = appendChild(
      { ...sampleDoc(), nodes: { ...sampleDoc().nodes, "image-1": image } },
      null,
      "image-1",
      "page-1",
    );
    let creates = 0;
    const host = mockHost({
      async read() {
        return {
          content: serializeDesignHtml(createDefaultManifest(), withImage),
          mimeType: "text/html",
          displayPath: "Hero.design.html",
          baseSha256: "abc123",
          baseRevision: 1,
        };
      },
      async createRasterFromSvg() {
        creates += 1;
        return {
          ok: true,
          artifactPath: "Hero.png",
          sha256: "unexpected",
          byteLength: 0,
        };
      },
      async createDocument() {
        creates += 1;
        return {
          ok: true,
          artifactPath: "Hero.svg",
          sha256: "unexpected",
          byteLength: 0,
        };
      },
    });
    for (const format of ["svg", "png"] as const) {
      const args = {
        source: { surface: "workspace" as const, path: "Hero.design.html" },
        target: { surface: "workspace" as const, path: `Hero.${format}` },
        scope: { pageHandle: "page:page-1", nodeHandles: ["node:image-1"] },
      };
      const result = format === "svg"
        ? await exportSvg(args, { nautiloApp: host })
        : await exportPng(args, { nautiloApp: host });
      expect(result).toMatchObject({
        ok: true,
        status: "failed",
        code: "UNSUPPORTED_IMAGE_SOURCE",
      });
    }
    expect(creates).toBe(0);
  });

  test("setNodeProps propagates write conflicts", async () => {
    const host = mockHost({
      async write() {
        return { kind: "conflict", currentSha256: "newer-hash" };
      },
    });
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "node-1",
        props: { x: 1 },
      },
      { nautiloApp: host },
    );
    expect(result).toEqual({
      ok: true,
      status: "conflict",
      displayPath: "workspace:Hero.design.html",
      currentSha256: "newer-hash",
    });
  });

  test("inspectDocument rejects invalid targets", async () => {
    const host = mockHost();
    const result = await inspectDocument(
      // @ts-expect-error invalid target
      { target: { surface: "bogus" } },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
  });

  test("setNodeProps rejects when node is missing", async () => {
    const host = mockHost();
    const result = await setNodeProps(
      {
        target: { surface: "workspace", path: "Hero.design.html" },
        nodeId: "missing-node",
        props: { x: 1 },
      },
      { nautiloApp: host },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain("Node not found");
  });
});
