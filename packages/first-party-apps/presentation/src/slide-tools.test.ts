import { describe, expect, test } from "bun:test";
import {
  createSlideDocument,
  parseSlideHtml,
  serializeSlideHtml,
} from "./slide-document";
import {
  createFile,
  editDocument,
  editOpenPresentation,
  inspectDocument,
  inspectOpenPresentation,
  type AgentToolContext,
} from "./slide-tools";

function fixture(initialContent = serializeSlideHtml(createSlideDocument())) {
  let content = initialContent;
  let revision = 2;
  const ctx: AgentToolContext = {
    nautiloApp: {
      document: {
        async createFromAction() {
          return {
            target: {
              surface: "workspace" as const,
              path: "Deck.presentation.html",
            },
            displayPath: "Deck.presentation.html",
            opened: true,
          };
        },
        async read() {
          return {
            content,
            displayPath: "Deck.presentation.html",
            baseSha256: "a".repeat(64),
            baseRevision: revision,
          };
        },
        async write(_target, next, opts) {
          if (opts.baseSha256 !== "a".repeat(64))
            return { kind: "conflict" as const, currentSha256: "b".repeat(64) };
          content = next.content;
          revision += 1;
          return { kind: "saved" as const, sha256: "b".repeat(64), revision };
        },
        async writeBound(next) {
          content = next.content;
          revision += 1;
          return { kind: "saved" as const, sha256: "b".repeat(64), revision };
        },
      },
    },
  };
  return {
    ctx,
    get content() {
      return content;
    },
  };
}

describe("presentation Genie tools", () => {
  test("updates an inspected shape in both tool paths while preserving styling and attached connectors", async () => {
    for (const live of [false, true]) {
      const doc = createSlideDocument();
      const slide = doc.slides[0];
      slide.elements.push({ id: "shape", type: "shape", frame: { x: 100, y: 100, w: 200, h: 100, rotation: 0 },
        data: { kind: "rect", fill: { kind: "srgb", value: "#0000ff" }, adjustments: [12500],
          stroke: { color: { kind: "srgb", value: "#112233" }, width: 2 } } },
      { id: "wire", type: "connector", routing: "straight", arrowheads: {},
        frame: { x: 200, y: 100, w: 400, h: 200, rotation: 0 },
        start: { kind: "attached", elementId: "shape", siteIndex: 0 }, end: { kind: "free", x: 600, y: 300 } });
      const before = serializeSlideHtml(doc);
      const f = fixture(before);
      const operations = [{ op: "update-shape", slideId: slide.id, elementId: "shape", frame: { x: -40, w: 300 }, fill: "#16a34a" }];
      const v = { kind: "artifact_revision", revision: 2 };
      const result = live
        ? await editOpenPresentation({ sessionToken: "s", documentVersion: v, idempotencyKey: "shape-edit", __canonicalContent: before,
            expectedVersion: JSON.stringify(v), operations }, f.ctx)
        : await editDocument({ target: { surface: "workspace", path: "Deck.presentation.html" }, expectedSha256: "a".repeat(64), operations }, f.ctx);
      expect(result).toMatchObject({ ok: true, status: "saved" });
      const saved = parseSlideHtml(f.content);
      const shape = saved.slides[0].elements.find(e => e.id === "shape")!;
      expect(shape).toMatchObject({ frame: { x: -40, y: 100, w: 300, h: 100, rotation: 0 },
        data: { kind: "rect", fill: { kind: "srgb", value: "#16a34a" }, adjustments: [12500],
          stroke: { color: { kind: "srgb", value: "#112233" }, width: 2 } } });
      const wire = saved.slides[0].elements.find(e => e.id === "wire")!;
      expect(wire).toMatchObject({ start: { kind: "attached", elementId: "shape", siteIndex: 0 }, end: { kind: "free", x: 600, y: 300 } });
      expect(wire.frame).not.toEqual(slide.elements.find(e => e.id === "wire")!.frame);
      const expected = structuredClone(doc);
      expected.slides[0].elements = expected.slides[0].elements.map(e => e.id === "shape" ? shape : e.id === "wire" ? wire : e);
      expect(saved).toEqual(expected);
    }
  });

  test("supports independent frame and fill patches and refreshes end-attached nested connectors", async () => {
    const doc = createSlideDocument();
    const slide = doc.slides[0];
    slide.elements.push(
      {
        id: "shape",
        type: "shape",
        frame: { x: 100, y: 100, w: 200, h: 100, rotation: 0 },
        data: { kind: "rect", fill: { kind: "srgb", value: "#0000ff" } },
      },
      {
        id: "end-wire",
        type: "connector",
        routing: "straight",
        arrowheads: {},
        frame: { x: 0, y: 0, w: 200, h: 150, rotation: 0 },
        start: { kind: "free", x: 0, y: 0 },
        end: { kind: "attached", elementId: "shape", siteIndex: 0 },
      },
      {
        id: "group",
        type: "group",
        frame: { x: 0, y: 0, w: 800, h: 450, rotation: 0 },
        data: {
          refSize: { w: 800, h: 450 },
          children: [{
            id: "nested-wire",
            type: "connector",
            routing: "straight",
            arrowheads: {},
            frame: { x: 10, y: 10, w: 190, h: 140, rotation: 0 },
            start: { kind: "free", x: 10, y: 10 },
            end: { kind: "attached", elementId: "shape", siteIndex: 0 },
          }],
        },
      },
    );
    const before = serializeSlideHtml(doc);
    const originalEndFrame = structuredClone(slide.elements[1].frame);
    const originalNestedFrame = structuredClone(
      (slide.elements[2].type === "group" ? slide.elements[2].data.children[0] : slide.elements[2]).frame,
    );
    const f = fixture(before);

    expect(await editDocument({
      target: { surface: "workspace", path: "Deck.presentation.html" },
      expectedSha256: "a".repeat(64),
      operations: [{ op: "update-shape", slideId: slide.id, elementId: "shape", fill: "#16a34a" }],
    }, f.ctx)).toMatchObject({ ok: true, status: "saved" });
    let saved = parseSlideHtml(f.content);
    let shape = saved.slides[0].elements.find((element) => element.id === "shape")!;
    expect(shape.frame).toEqual({ x: 100, y: 100, w: 200, h: 100, rotation: 0 });
    expect(shape.type === "shape" ? shape.data.fill : undefined).toEqual({ kind: "srgb", value: "#16a34a" });

    expect(await editDocument({
      target: { surface: "workspace", path: "Deck.presentation.html" },
      expectedSha256: "a".repeat(64),
      operations: [{ op: "update-shape", slideId: slide.id, elementId: "shape", frame: { x: 320 } }],
    }, f.ctx)).toMatchObject({ ok: true, status: "saved" });
    saved = parseSlideHtml(f.content);
    shape = saved.slides[0].elements.find((element) => element.id === "shape")!;
    expect(shape.type === "shape" ? shape.data.fill : undefined).toEqual({ kind: "srgb", value: "#16a34a" });
    expect(shape.frame).toEqual({ x: 320, y: 100, w: 200, h: 100, rotation: 0 });

    const endWire = saved.slides[0].elements.find((element) => element.id === "end-wire")!;
    expect(endWire.type === "connector" ? endWire.end : undefined).toEqual({
      kind: "attached", elementId: "shape", siteIndex: 0,
    });
    expect(endWire.frame).not.toEqual(originalEndFrame);
    const group = saved.slides[0].elements.find((element) => element.id === "group")!;
    if (group.type !== "group") throw new Error("group fixture was not preserved");
    const nestedWire = group.data.children[0];
    expect(nestedWire.type === "connector" ? nestedWire.end : undefined).toEqual({
      kind: "attached", elementId: "shape", siteIndex: 0,
    });
    expect(nestedWire.frame).not.toEqual(originalNestedFrame);
  });

  test("invalid shape updates refuse the whole batch without canonical writes", async () => {
    const doc = createSlideDocument();
    const slide = doc.slides[0];
    slide.elements.push({ id: "shape", type: "shape", frame: { x: 1, y: 2, w: 30, h: 40, rotation: 0 }, data: { kind: "rect" } });
    const before = serializeSlideHtml(doc);
    for (const patch of [{}, { frame: {} }, { frame: { x: Infinity } }, { frame: { w: -1 } },
      { frame: { x: Number.MAX_VALUE, w: Number.MAX_VALUE } }, { frame: { flipH: true } },
      { frame: { x: "10" } }, { fill: "url(https://example.test/image)" }, { fill: "#fff" },
      { elementId: slide.elements[0].id, fill: "#123456" }, { elementId: "missing", fill: "#123456" }]) {
      const f = fixture(before);
      const v = { kind: "artifact_revision", revision: 2 };
      const result = await editOpenPresentation({ sessionToken: "s", documentVersion: v, idempotencyKey: "invalid-shape", __canonicalContent: before,
        expectedVersion: JSON.stringify(v), operations: [{ op: "set-title", title: "Must not persist" },
          { op: "update-shape", slideId: slide.id, elementId: "shape", ...patch }] }, f.ctx);
      expect(result).toMatchObject({ ok: false, stateChanged: false });
      expect(f.content).toBe(before);
    }
  });

  test("inspects with a version-bound continuation", () => {
    const f = fixture();
    const version = { kind: "artifact_revision", revision: 2 } as const;
    const result = inspectOpenPresentation(
      {
        sessionToken: "s",
        documentVersion: version,
        idempotencyKey: "i",
        __canonicalContent: f.content,
        pageSize: 1,
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      status: "inspected",
      slideCount: 1,
      completeness: "complete",
      versionToken: JSON.stringify(version),
    });
  });

  test("applies one bound atomic batch and advances the version", async () => {
    const f = fixture();
    const version = { kind: "artifact_revision", revision: 2 } as const;
    const doc = parseSlideHtml(f.content);
    const slide = doc.slides[0];
    const text = slide.elements.find((element) => element.type === "text")!;
    const result = await editOpenPresentation(
      {
        sessionToken: "s",
        documentVersion: version,
        idempotencyKey: "i",
        __canonicalContent: f.content,
        expectedVersion: JSON.stringify(version),
        operations: [
          { op: "set-title", title: "Launch" },
          {
            op: "set-text",
            slideId: slide.id,
            elementId: text.id,
            text: "Hello",
          },
        ],
      },
      f.ctx,
    );
    expect(result).toMatchObject({
      ok: true,
      status: "saved",
      documentVersion: { kind: "artifact_revision", revision: 3 },
    });
    expect(parseSlideHtml(f.content).meta.title).toBe("Launch");
    const savedText = parseSlideHtml(f.content).slides[0].elements.find(
      (element) => element.id === text.id && element.type === "text",
    );
    if (!savedText || savedText.type !== "text")
      throw new Error("saved text missing");
    expect(savedText.data.blocks[0]?.inlines[0]?.style).toEqual(
      text.data.blocks[0]?.inlines[0]?.style,
    );
  });

  test("refuses stale live versions and invalid batches without writing", async () => {
    const f = fixture();
    const version = { kind: "artifact_revision", revision: 2 } as const;
    const before = f.content;
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: before,
          expectedVersion: "stale",
          operations: [{ op: "set-title", title: "No" }],
        },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "stale_version",
      stateChanged: false,
    });
    const slideId = parseSlideHtml(before).slides[0].id;
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: before,
          expectedVersion: JSON.stringify(version),
          operations: [
            { op: "set-title", title: "Would mutate" },
            { op: "delete-slide", slideId },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "invalid_request",
      stateChanged: false,
    });
    expect(f.content).toBe(before);
  });

  test("uses inspected SHA for closed strict CAS", async () => {
    const f = fixture();
    const target = {
      surface: "workspace",
      path: "Deck.presentation.html",
    } as const;
    const inspected = await inspectDocument({ target, pageSize: 1 }, f.ctx);
    expect(inspected).toMatchObject({
      ok: true,
      expectedSha256: "a".repeat(64),
    });
    const result = await editDocument(
      {
        target,
        expectedSha256: "a".repeat(64),
        operations: [{ op: "set-title", title: "Closed" }],
      },
      f.ctx,
    );
    expect(result).toMatchObject({ ok: true, status: "saved", revision: 3 });
  });

  test("binds continuations to the exact slide query", async () => {
    const f = fixture();
    const version = { kind: "artifact_revision", revision: 2 } as const;
    const first = await editOpenPresentation(
      {
        sessionToken: "s",
        documentVersion: version,
        idempotencyKey: "i",
        __canonicalContent: f.content,
        expectedVersion: JSON.stringify(version),
        operations: [{ op: "add-slide", layoutId: "blank" }],
      },
      f.ctx,
    );
    expect(first.ok).toBe(true);
    const current = { kind: "artifact_revision", revision: 3 } as const;
    const page = inspectOpenPresentation(
      {
        sessionToken: "s",
        documentVersion: current,
        idempotencyKey: "i",
        __canonicalContent: f.content,
        pageSize: 1,
      },
      f.ctx,
    );
    if (!page.ok || !("nextCursor" in page))
      throw new Error("expected continuation");
    const slideId = parseSlideHtml(f.content).slides[0].id;
    expect(
      inspectOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: current,
          idempotencyKey: "i",
          __canonicalContent: f.content,
          slideId,
          pageSize: 1,
          cursor: page.nextCursor,
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, status: "invalid_request" });
  });

  test("rejects ambiguous targets, unknown layouts, and uncertain create failures", async () => {
    const f = fixture();
    expect(
      await inspectDocument(
        {
          target: {
            surface: "workspace",
            path: "Deck.presentation.html",
            relativePath: "also",
          },
          pageSize: 1,
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, status: "invalid_request" });
    const before = f.content;
    const version = { kind: "artifact_revision", revision: 2 } as const;
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: before,
          expectedVersion: JSON.stringify(version),
          operations: [
            { op: "set-title", title: "No partial mutation" },
            { op: "add-slide", layoutId: "missing" },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(f.content).toBe(before);
    f.ctx.nautiloApp.document.createFromAction = async () => {
      throw new Error("completion unknown");
    };
    expect(
      await createFile(
        { targetSurface: "workspace", filename: "Deck.presentation.html" },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "error",
      retrySafe: false,
      stateChanged: "unknown",
    });
  });

  test("reports stale closed and bound conflict or unknown completion without writing success", async () => {
    const f = fixture();
    const target = {
      surface: "workspace",
      path: "Deck.presentation.html",
    } as const;
    expect(
      await editDocument(
        {
          target,
          expectedSha256: "c".repeat(64),
          operations: [{ op: "set-title", title: "Stale" }],
        },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "stale_revision",
      stateChanged: false,
    });
    const version = { kind: "artifact_revision", revision: 2 } as const;
    f.ctx.nautiloApp.document.writeBound = async () => ({
      kind: "conflict",
      currentSha256: "d".repeat(64),
    });
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: f.content,
          expectedVersion: JSON.stringify(version),
          operations: [{ op: "set-title", title: "Conflict" }],
        },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "stale_version",
      stateChanged: false,
    });
    f.ctx.nautiloApp.document.writeBound = async () => {
      throw new Error("completion unknown");
    };
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: f.content,
          expectedVersion: JSON.stringify(version),
          operations: [{ op: "set-title", title: "Unknown" }],
        },
        f.ctx,
      ),
    ).toMatchObject({
      ok: false,
      status: "error",
      retrySafe: false,
      stateChanged: "unknown",
    });
  });

  test("refuses ambiguous rich text, inline images, and unknown notes slides", async () => {
    const f = fixture();
    const document = parseSlideHtml(f.content);
    const slide = document.slides[0];
    const text = slide.elements.find((element) => element.type === "text");
    if (!text || text.type !== "text") throw new Error("expected text");
    text.data.blocks[0].inlines.push({ text: "mixed", style: { bold: true } });
    const rich = serializeSlideHtml(document);
    const version = { kind: "artifact_revision", revision: 2 } as const;
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: rich,
          expectedVersion: JSON.stringify(version),
          operations: [
            {
              op: "set-text",
              slideId: slide.id,
              elementId: text.id,
              text: "flatten",
            },
          ],
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(
      await editOpenPresentation(
        {
          sessionToken: "s",
          documentVersion: version,
          idempotencyKey: "i",
          __canonicalContent: f.content,
          expectedVersion: JSON.stringify(version),
          operations: [{ op: "set-notes", slideId: "missing", text: "notes" }],
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, stateChanged: false });
    expect(
      await inspectDocument(
        {
          target: {
            surface: "currentFolder",
            relativePath: "/absolute.presentation.html",
          },
          pageSize: 1,
        },
        f.ctx,
      ),
    ).toMatchObject({ ok: false, status: "invalid_request" });
  });
});


test("creation preserves the open action and collision recovery without asking for a blank deck", async () => {
  const f = fixture();
  const receipt = { target: { surface: "workspace" as const, path: "New.presentation.html" },
    displayPath: "New.presentation.html", opened: false,
    openInApp: { appId: "nautilo-presentation", appName: "Slides", target: {
      surface: "workspace", path: "New.presentation.html", artifactInternalId: "artifact-123", mimeType: "text/html",
    } } };
  f.ctx.nautiloApp.document.createFromAction = async (action, args) => {
    expect(action).toBe("new-presentation");
    expect(args).toEqual({ targetSurface: "workspace", filename: "New.presentation.html" });
    return receipt;
  };
  expect(await createFile({ targetSurface: "workspace", filename: "New.presentation.html" }, f.ctx))
    .toEqual({ ok: true, status: "created", ...receipt });
  const collision = { ok: false, status: "create_failed", code: "destination_exists", phase: "create",
    message: "Already exists", stateChanged: false, retrySafe: false,
    recoveryActions: ["choose_another_filename", "inspect_existing_document"] };
  f.ctx.nautiloApp.document.createFromAction = async () => { throw new Error(JSON.stringify(collision)); };
  expect(await createFile({ targetSurface: "workspace", filename: "New.presentation.html" }, f.ctx)).toEqual(collision);
});
