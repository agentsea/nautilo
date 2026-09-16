import { describe, expect, test } from "bun:test";
import { createBoardDocument, parseBoardHtml, serializeBoardHtml } from "./board-document";
import {
  createFile,
  describeAuthoring,
  editBoard,
  editOpenBoard,
  inspectBoard,
  inspectOpenBoard,
  type BoardAgentToolContext,
} from "./board-tools";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

function context(overrides: Partial<BoardAgentToolContext["nautiloApp"]["document"]> = {}) {
  const calls: { writes: unknown[]; boundWrites: unknown[]; creates: unknown[] } = { writes: [], boundWrites: [], creates: [] };
  let content = serializeBoardHtml(createBoardDocument("Plan"));
  const document: BoardAgentToolContext["nautiloApp"]["document"] = {
    async createFromAction(id, opts) {
      calls.creates.push({ id, opts });
      return { target: { surface: "workspace", path: opts.filename }, displayPath: opts.filename, opened: false };
    },
    async read() { return { content, displayPath: "Plan.board.html", baseSha256: SHA_A, baseRevision: 4 }; },
    async write(target, next, opts) {
      calls.writes.push({ target, next, opts }); content = next.content;
      return { kind: "saved", sha256: SHA_B, revision: 5 };
    },
    async writeBound(next) {
      calls.boundWrites.push(next); content = next.content;
      return { kind: "saved", sha256: SHA_B, revision: 5 };
    },
    ...overrides,
  };
  const ctx: BoardAgentToolContext = { nautiloApp: { document } };
  return { ctx, calls, get content() { return content; } };
}

describe("Board Genie tools", () => {
  test("creates only through the new-board action without caller path authority", async () => {
    const host = context();
    const result = await createFile({ targetSurface: "workspace", filename: "Plan.board.html" }, host.ctx);
    expect(result).toMatchObject({ ok: true, status: "created", opened: false });
    expect(host.calls.creates).toEqual([{ id: "new-board", opts: { targetSurface: "workspace", filename: "Plan.board.html" } }]);
    expect(await createFile({ targetSurface: "workspace", filename: "../Plan.board.html" }, host.ctx)).toMatchObject({ ok: false, status: "invalid_request" });
  });

  test("accepts only complete structured create failures and treats other host failures as uncertain", async () => {
    const complete = { ok: false, status: "create_failed", phase: "create", code: "destination_exists",
      message: "Already exists", recoveryActions: ["choose_another_filename"] };
    const known = context({ async createFromAction() { throw new Error(JSON.stringify(complete)); } });
    expect(await createFile({ targetSurface: "workspace", filename: "Plan.board.html" }, known.ctx)).toEqual(complete);
    const malformed = context({ async createFromAction() { throw new Error(JSON.stringify({ ok: false, status: "create_failed" })); } });
    expect(await createFile({ targetSurface: "workspace", filename: "Plan.board.html" }, malformed.ctx))
      .toMatchObject({ ok: false, status: "error", code: "create_failed", retrySafe: false, stateChanged: "unknown" });
  });

  test("returns the complete model by default and exact selected ids without pagination claims", async () => {
    const model = createBoardDocument("Plan");
    model.elements.push({ id: "shape-1", type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 }, data: { kind: "rect" } });
    const content = serializeBoardHtml(model);
    const host = context({ async read() { return { content, displayPath: "Plan.board.html", baseSha256: SHA_A, baseRevision: 4 }; } });
    const full = await inspectBoard({ target: { surface: "workspace", path: "Plan.board.html" } }, host.ctx);
    expect(full).toMatchObject({ ok: true, completeness: "complete", elementCount: 1, returnedElementCount: 1, totalElementCount: 1, document: { meta: { title: "Plan" } } });
    const selected = await inspectBoard({ target: { surface: "workspace", path: "Plan.board.html" }, elementIds: ["shape-1"] }, host.ctx);
    expect(selected).toMatchObject({ ok: true, completeness: "complete", selectedElementIds: ["shape-1"], returnedElementCount: 1, totalElementCount: 1 });
    expect(await inspectBoard({ target: { surface: "workspace", path: "Plan.board.html" }, elementIds: ["missing"] }, host.ctx)).toMatchObject({ ok: false, status: "invalid_request" });
  });

  test("closed edit validates the whole result and writes once with the inspected CAS", async () => {
    const host = context();
    const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }] }, host.ctx);
    expect(result).toMatchObject({ ok: true, status: "saved", sha256: SHA_B, revision: 5,
      receipt: { operationCount: 1, changedPaths: ["/meta/title"] } });
    expect(host.calls.writes).toHaveLength(1);
    expect(host.calls.writes[0]).toMatchObject({ opts: { baseSha256: SHA_A, baseRevision: 4 } });
    expect(parseBoardHtml(host.content).meta.title).toBe("Launch");
  });

  test("closed edit refuses stale reads and invalid models without writing", async () => {
    const stale = context();
    expect(await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_B,
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }] }, stale.ctx)).toMatchObject({ ok: false, status: "stale_revision" });
    expect(stale.calls.writes).toHaveLength(0);
    const invalid = context();
    const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [{ op: "remove", path: "/meta/title" }] }, invalid.ctx);
    expect(result).toMatchObject({ ok: false, status: "invalid_request" });
    expect(invalid.calls.writes).toHaveLength(0);
  });

  test("bare hexadecimal colors refuse the complete closed or open edit before writing", async () => {
    const host = context();
    const operations = [
      { op: "replace", path: "/meta/title", value: "Must not partially save" },
      { op: "add", path: "/elements/-", value: { id: "note", type: "shape",
        frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
        data: { kind: "roundRect", fill: { kind: "srgb", value: "FFF2A8" } } } },
    ];
    const before = host.content;
    const closed = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" },
      expectedSha256: SHA_A, operations }, host.ctx);
    expect(closed).toMatchObject({ ok: false, stateChanged: false,
      affectedPaths: ["/elements/0/data/fill/value"], errors: [{ keyword: "color-syntax" }] });
    const documentVersion = { kind: "artifact_revision", revision: 4 };
    const open = await editOpenBoard({ sessionToken: "host-token", documentVersion,
      __canonicalContent: before, expectedVersion: JSON.stringify(documentVersion), operations }, host.ctx);
    expect(open).toMatchObject({ ok: false, stateChanged: false });
    expect(host.calls.writes).toHaveLength(0);
    expect(host.calls.boundWrites).toHaveLength(0);
    expect(host.content).toBe(before);
  });

  test("CSS color syntax remains open to hex, names and functional colors", async () => {
    for (const value of ["#FFF2A8", "#abc", "rebeccapurple", "rgb(255 242 168)", "hsl(50 100% 83%)", "color(display-p3 1 0.9 0.5)"]) {
      const host = context();
      const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" },
        expectedSha256: SHA_A, operations: [{ op: "add", path: "/elements/-", value: {
          id: "note", type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
          data: { kind: "roundRect", fill: { kind: "srgb", value } },
        } }] }, host.ctx);
      expect(result).toMatchObject({ ok: true, status: "saved" });
      expect(host.content).toContain(value);
    }
  });

  test("older malformed colors remain inspectable and repairable", async () => {
    const model = createBoardDocument("Repair");
    model.elements.push({ id: "note", type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
      data: { kind: "roundRect", fill: { kind: "srgb", value: "FFF2A8" } } });
    const content = serializeBoardHtml(model);
    const host = context({ async read() { return { content, displayPath: "Plan.board.html", baseSha256: SHA_A, baseRevision: 4 }; } });
    expect(await inspectBoard({ target: { surface: "workspace", path: "Plan.board.html" } }, host.ctx))
      .toMatchObject({ ok: true, document: model });
    const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [{ op: "replace", path: "/elements/0/data/fill/value", value: "#FFF2A8" }] }, host.ctx);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    expect(host.calls.writes).toHaveLength(1);
  });

  test("closed edits preserve and incrementally repair multiple older malformed colors", async () => {
    const model = createBoardDocument("Repair");
    for (const [id, value] of [["first", "FFF2A8"], ["second", "abcdef"]] as const) {
      model.elements.push({ id, type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
        data: { kind: "roundRect", fill: { kind: "srgb", value } } });
    }
    const firstHost = context({ async read() { return { content: serializeBoardHtml(model), displayPath: "Plan.board.html",
      baseSha256: SHA_A, baseRevision: 4 }; } });
    const first = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [
        { op: "replace", path: "/meta/title", value: "Repairing" },
        { op: "replace", path: "/elements/0/data/fill/value", value: "#FFF2A8" },
      ] }, firstHost.ctx);
    expect(first).toMatchObject({ ok: true, status: "saved" });
    expect(parseBoardHtml(firstHost.content).elements[1]).toMatchObject({ data: { fill: { value: "abcdef" } } });

    const secondHost = context({ async read() { return { content: firstHost.content, displayPath: "Plan.board.html",
      baseSha256: SHA_A, baseRevision: 5 }; } });
    const second = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [{ op: "replace", path: "/elements/1/data/fill/value", value: "#abcdef" }] }, secondHost.ctx);
    expect(second).toMatchObject({ ok: true, status: "saved" });
    expect(secondHost.calls.writes).toHaveLength(1);
  });

  test("open edits may reorder existing malformed colors but reject an increased count atomically", async () => {
    const model = createBoardDocument("Reorder");
    for (const id of ["first", "second"] as const) {
      model.elements.push({ id, type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
        data: { kind: "roundRect", fill: { kind: "srgb", value: "FFF2A8" } } });
    }
    const canonical = serializeBoardHtml(model);
    const documentVersion = { kind: "artifact_revision" as const, revision: 4 };
    const injected = { sessionToken: "host-token", documentVersion, __canonicalContent: canonical,
      expectedVersion: JSON.stringify(documentVersion) };
    const reorderedHost = context();
    const reordered = await editOpenBoard({ ...injected,
      operations: [{ op: "move", from: "/elements/0", path: "/elements/1" }] }, reorderedHost.ctx);
    expect(reordered).toMatchObject({ ok: true, status: "saved" });
    expect(reorderedHost.calls.boundWrites).toHaveLength(1);

    const rejectedHost = context();
    const rejected = await editOpenBoard({ ...injected, operations: [{ op: "add", path: "/elements/-", value: {
      id: "third", type: "shape", frame: { x: 0, y: 0, w: 100, h: 80, rotation: 0 },
      data: { kind: "roundRect", fill: { kind: "srgb", value: "fff2a8" } },
    } }] }, rejectedHost.ctx);
    expect(rejected).toMatchObject({ ok: false, stateChanged: false,
      affectedPaths: ["/elements/2/data/fill/value"], errors: [{ keyword: "color-syntax" }] });
    expect(rejectedHost.calls.boundWrites).toHaveLength(0);
  });

  test("insert-image resolves authorized bytes before one write and reports safe source identity", async () => {
    const host = context();
    const pixel = "data:image/png;base64,iVBORw0KGgo=";
    host.ctx.nautiloApp.assets = { async read(asset) {
      expect(asset).toEqual({ surface: "currentFolder", relativePath: "reference.png" });
      return { ok: true, dataUrl: pixel, sha256: SHA_B, byteLength: 8, mimeType: "image/png" };
    } };
    const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
      operations: [{ op: "insert-image", asset: { surface: "currentFolder", relativePath: "reference.png" },
        element: { frame: { x: 10, y: 20, w: 30, h: 40, rotation: 0 }, data: { alt: "Reference" } } }] }, host.ctx);
    expect(result).toMatchObject({ ok: true, receipt: { operationCount: 1,
      resources: [{ op: "insert-image", sourceSha256: SHA_B, sourceBytes: 8, mimeType: "image/png" }] } });
    expect(host.calls.writes).toHaveLength(1);
    const image = parseBoardHtml(host.content).elements[0];
    expect(image).toMatchObject({ type: "image", frame: { x: 10, y: 20, w: 30, h: 40 }, data: { alt: "Reference", src: pixel } });
  });

  test("unauthorized or missing image resources leave the Board unwritten", async () => {
    for (const assets of [undefined, { async read() { return { ok: false, code: "not_authorized", message: "Unavailable" }; } }]) {
      const host = context();
      host.ctx.nautiloApp.assets = assets;
      const result = await editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
        operations: [{ op: "insert-image", asset: { ref: "private" },
          element: { frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0 } } }] }, host.ctx);
      expect(result).toMatchObject({ ok: false, stateChanged: false });
      expect(host.calls.writes).toHaveLength(0);
    }
  });

  test("active tools accept only host injection and bind edits to expectedVersion", async () => {
    const host = context();
    const canonical = serializeBoardHtml(createBoardDocument("Plan"));
    const injected = { sessionToken: "host-token", documentVersion: { kind: "artifact_revision", revision: 4 }, __canonicalContent: canonical };
    const inspected = inspectOpenBoard(injected, host.ctx);
    expect(inspected).toMatchObject({ ok: true, versionToken: JSON.stringify({ kind: "artifact_revision", revision: 4 }), document: { meta: { title: "Plan" } } });
    const spoof = inspectOpenBoard({ ...injected, target: { surface: "workspace", path: "other" } }, host.ctx);
    expect(spoof).toMatchObject({ ok: false, status: "invalid_request" });
    const stale = await editOpenBoard({ ...injected, expectedVersion: "stale", operations: [{ op: "replace", path: "/meta/title", value: "Launch" }] }, host.ctx);
    expect(stale).toMatchObject({ ok: false, status: "stale_version" });
    expect(host.calls.boundWrites).toHaveLength(0);
    const saved = await editOpenBoard({ ...injected, expectedVersion: JSON.stringify(injected.documentVersion), operations: [{ op: "replace", path: "/meta/title", value: "Launch" }] }, host.ctx);
    expect(saved).toMatchObject({ ok: true, status: "saved", documentVersion: { kind: "artifact_revision", revision: 5 } });
    expect(host.calls.boundWrites).toHaveLength(1);
  });

  test("a saved bound write without a new version requires reinspection and a thrown write is uncertain", async () => {
    const canonical = serializeBoardHtml(createBoardDocument("Plan"));
    const injected = { sessionToken: "host-token", documentVersion: { kind: "artifact_revision" as const, revision: 4 },
      __canonicalContent: canonical, expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 4 }),
      operations: [{ op: "replace", path: "/meta/title", value: "Launch" }] };
    const incomplete = context({ async writeBound() { return { kind: "saved", sha256: SHA_B }; } });
    const saved = await editOpenBoard(injected, incomplete.ctx);
    expect(saved).toMatchObject({ ok: true, status: "saved", needsReinspect: true });
    expect(saved).not.toHaveProperty("documentVersion");
    expect(saved).not.toHaveProperty("versionToken");
    const uncertain = context({ async writeBound() { throw new Error("connection lost"); } });
    expect(await editOpenBoard(injected, uncertain.ctx)).toMatchObject({ ok: false, status: "error",
      code: "bound_write_failed", retrySafe: false, stateChanged: "unknown" });
  });

  test("schema discovery reports exact size and can return the full schema", () => {
    const overview = describeAuthoring({}) as Record<string, unknown>;
    expect(overview).toMatchObject({ ok: true, completeness: "overview", schemaIncluded: false });
    expect(overview).toMatchObject({ helpers: { insertImage: { op: "insert-image", required: ["asset", "element"],
      generated: ["element.id", "element.type", "element.data.src"] } } });
    expect(overview["schemaBytes"]).toBeGreaterThan(0);
    expect(describeAuthoring({ includeSchema: true })).toMatchObject({ ok: true, completeness: "complete", schema: { $ref: "#/definitions/BoardModel" } });
    expect(describeAuthoring({ definition: "BoardModel" })).toMatchObject({ ok: true, completeness: "complete",
      definition: "BoardModel", schema: { $ref: "#/definitions/BoardModel", definitions: { BoardModel: {} } } });
  });
});

for (const open of [false, true]) {
  test(`${open ? "open" : "closed"} image resolution cannot overwrite a revision changed while bytes were pending`, async () => {
    const original = serializeBoardHtml(createBoardDocument("Before"));
    const external = serializeBoardHtml(createBoardDocument("Changed by Human"));
    let canonical = original;
    let currentSha = SHA_A;
    let writeAttempts = 0;
    let release!: (value: unknown) => void;
    let entered!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const asset = new Promise<unknown>(resolve => { release = resolve; });
    const host = context({
      async read() { return { content: canonical, displayPath: "Plan.board.html", baseSha256: currentSha, baseRevision: 4 }; },
      async write(_target, _next, opts) {
        writeAttempts++;
        expect(opts.baseSha256).toBe(SHA_A);
        expect(opts.baseRevision).toBe(4);
        return { kind: "conflict", currentSha256: currentSha };
      },
      async writeBound() {
        writeAttempts++;
        return { kind: "conflict", currentSha256: currentSha };
      },
    });
    host.ctx.nautiloApp.assets = { read() { entered(); return asset; } };
    const operations = [{ op: "insert-image", asset: { surface: "currentFolder", relativePath: "reference.png" },
      element: { frame: { x: 0, y: 0, w: 32, h: 16, rotation: 0 } } }];
    const pending = open
      ? editOpenBoard({ sessionToken: "host", documentVersion: { kind: "artifact_revision", revision: 4 },
          __canonicalContent: original, expectedVersion: JSON.stringify({ kind: "artifact_revision", revision: 4 }), operations }, host.ctx)
      : editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A, operations }, host.ctx);
    await started;
    expect(writeAttempts).toBe(0);
    canonical = external; currentSha = SHA_B;
    release({ ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", sha256: SHA_A, byteLength: 8, mimeType: "image/png" });
    expect(await pending).toMatchObject({ ok: false, status: open ? "stale_version" : "stale_revision", stateChanged: false });
    expect(writeAttempts).toBe(1);
    expect(canonical).toBe(external);
    expect(parseBoardHtml(canonical).elements).toHaveLength(0);
  });
}

test("a delayed second asset failure rejects the complete Board batch before any write", async () => {
  const host = context();
  const original = host.content;
  let deny!: (value: unknown) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const failed = new Promise<unknown>(resolve => { deny = resolve; });
  host.ctx.nautiloApp.assets = { async read(source) {
    if ((source as { ref: string }).ref === "allowed") return {
      ok: true, dataUrl: "data:image/png;base64,iVBORw0KGgo=", sha256: SHA_A, byteLength: 8, mimeType: "image/png",
    };
    entered(); return failed;
  } };
  const pending = editBoard({ target: { surface: "workspace", path: "Plan.board.html" }, expectedSha256: SHA_A,
    operations: [
      { op: "replace", path: "/meta/title", value: "Must not partially save" },
      ...["allowed", "denied"].map(ref => ({ op: "insert-image", asset: { ref },
        element: { frame: { x: 0, y: 0, w: 32, h: 16, rotation: 0 } } })),
    ] }, host.ctx);
  await started;
  expect(host.calls.writes).toHaveLength(0);
  deny({ ok: false, code: "ASSET_NOT_FOUND", message: "Image is not readable in this Workspace." });
  expect(await pending).toMatchObject({ ok: false, code: "ASSET_NOT_FOUND", stateChanged: false, operationIndex: 2 });
  expect(host.calls.writes).toHaveLength(0);
  expect(host.content).toBe(original);
});
