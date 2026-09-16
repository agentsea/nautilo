import type { Element } from "../engine/node.js";
import { expect, test } from "bun:test";
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from "./slide-document";
import { describeAuthoring, editDocument, editOpenPresentation, inspectOpenPresentation, saveOpenTemplate, type AgentToolContext } from "./slide-tools";
import { patchSlideJson } from "./slide-json-patch";
import { captureSlideTemplate } from "./slide-templates";

const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const version = { kind: "artifact_revision", revision: 2 };
function fixture() {
  const source = createSlideDocument();
  let content = serializeSlideHtml(source);
  let writes = 0;
  const resources: unknown[] = [];
  const ctx: AgentToolContext = { nautiloApp: {
    assets: { async read(target) { resources.push(target); return { ok: true, dataUrl: png, sha256: "b".repeat(64), byteLength: 68, mimeType: "image/png" }; } },
    templates: {
      async list() { return { templates: [{ id: "template", name: "Opening" }], nextCursor: null }; },
      async read() { return { content: serializeSlideHtml(captureSlideTemplate(source, source.slides[0].id)) }; },
      async save(value) { resources.push(value); return { ok: true, template: { id: "saved-template", name: value.name }, stateChanged: true }; },
      async remove() { return { ok: true, stateChanged: true }; },
    },
    document: {
      async createFromAction() { throw new Error("unused"); },
      async read() { return { content, displayPath: "Deck.presentation.html", baseSha256: "a".repeat(64), baseRevision: 2 }; },
      async write(_target, next) { writes++; content = next.content; return { kind: "saved", sha256: "b".repeat(64), revision: 3 }; },
      async writeBound(next) { writes++; content = next.content; return { kind: "saved", sha256: "b".repeat(64), revision: 3 }; },
    },
  } };
  return { source, ctx, resources, get writes() { return writes; }, get content() { return content; },
    edit(operations: unknown[], open = true) { return open
      ? editOpenPresentation({ expectedVersion: JSON.stringify(version), documentVersion: version, sessionToken: "validated", __canonicalContent: content, operations }, ctx)
      : editDocument({ target: { surface: "workspace", path: "Deck.presentation.html" }, expectedSha256: "a".repeat(64), operations }, ctx); } };
}

test("one native transaction authors rich text, arbitrary font, gradient, chart and table in either path", async () => {
  for (const open of [true, false]) {
    const f = fixture();
    const textIndex = f.source.slides[0].elements.findIndex(element => element.type === "text");
    const text = f.source.slides[0].elements[textIndex];
    if (text.type !== "text") throw new Error("fixture text missing");
    const block = structuredClone(text.data.blocks[0]);
    block.inlines = [{ text: "Build ", style: { bold: true, fontFamily: "Aptos Display" } }, { text: "together", style: { italic: true, color: "#274B54" } }];
    const shape: Element = { id: "accent", type: "shape", frame: { x: 1400, y: 150, w: 200, h: 200, rotation: 0.25 }, data: { kind: "ellipse", fill: { kind: "gradient", type: "linear", angle: 0, stops: [{ pos: 0, color: { kind: "srgb", value: "#123456" } }, { pos: 1, color: { kind: "srgb", value: "#abcdef" } }] } } };
    const chart: Element = { id: "chart", type: "chart", frame: { x: 200, y: 550, w: 600, h: 350, rotation: 0 }, data: { kind: "column", categories: ["Now", "Next"], series: [{ name: "Progress", values: [20, 80] }] } };
    const table: Element = { id: "table", type: "table", frame: { x: 900, y: 600, w: 400, h: 100, rotation: 0 }, data: { columnWidths: [200, 200], rows: [{ height: 100, cells: [{ body: { blocks: [] }, style: {} }, { body: { blocks: [] }, style: {} }] }] } };
    const result = await f.edit([{ op: "patch", changes: [
      { op: "test", path: `/slides/0/elements/${textIndex}/id`, value: text.id },
      { op: "replace", path: `/slides/0/elements/${textIndex}/data/blocks/0`, value: block },
      { op: "add", path: "/slides/0/elements/-", value: shape },
      { op: "add", path: "/slides/0/elements/-", value: chart },
      { op: "add", path: "/slides/0/elements/-", value: table },
      { op: "add", path: `/slides/0/elements/${textIndex}/data/futureExtension`, value: { kept: true } },
    ] }], open);
    expect(result).toMatchObject({ ok: true, status: "saved" });
    expect(f.writes).toBe(1);
    const saved = parseSlideHtml(f.content);
    expect(saved.slides[0].elements[textIndex]).toMatchObject({ data: { blocks: [block] } });
    expect(saved.slides[0].elements).toContainEqual(shape);
    expect(saved.slides[0].elements).toContainEqual(chart);
    expect(saved.slides[0].elements).toContainEqual(table);
    expect((saved.slides[0].elements[textIndex] as unknown as { data: { futureExtension: unknown } }).data.futureExtension).toEqual({ kept: true });
    expect(saved.themes).toEqual(f.source.themes);
    expect(saved.layouts).toEqual(f.source.layouts);
  }
});

test("resolves image bytes inside code and inserts a private template with regenerated identities", async () => {
  const f = fixture();
  const slideId = f.source.slides[0].id;
  const result = await f.edit([
    { op: "insert-image", slideId, asset: { ref: `artifact:11111111-1111-4111-8111-111111111111:${"b".repeat(64)}` }, element: { frame: { x: 50, y: 50, w: 100, h: 100, rotation: 0 }, data: { alt: "Reference image" } } },
    { op: "insert-template", templateId: "template", afterSlideId: slideId },
  ]);
  expect(result).toMatchObject({ ok: true, status: "saved" });
  expect(f.writes).toBe(1);
  expect(f.resources).toHaveLength(1);
  const saved = parseSlideHtml(f.content);
  expect(saved.slides).toHaveLength(2);
  expect(saved.slides[0].elements.at(-1)).toMatchObject({ type: "image", data: { src: png, alt: "Reference image" } });
  expect(saved.slides[1].id).not.toBe(slideId);
  expect(saved.slides[1].elements[0].id).not.toBe(f.source.slides[0].elements[0].id);
});

test("invalid chart data or failed media resolution aborts the entire batch with recovery information", async () => {
  const f = fixture();
  const before = f.content;
  const bad = await f.edit([{ op: "patch", changes: [{ op: "replace", path: "/meta/title", value: "Never saved" }, { op: "add", path: "/meta/pxPerPt", value: 0 }] }]);
  expect(bad).toMatchObject({ ok: false, stateChanged: false, phase: "prepare" });
  expect(f.content).toBe(before); expect(f.writes).toBe(0);
  f.ctx.nautiloApp.assets = { async read() { return { ok: false, code: "ASSET_CHANGED", message: "Image changed" }; } };
  const media = await f.edit([{ op: "set-title", title: "Never saved" }, { op: "insert-image", slideId: f.source.slides[0].id, asset: { ref: "asset" }, element: { frame: { x: 1, y: 1, w: 1, h: 1, rotation: 0 } } }]);
  expect(media).toMatchObject({ ok: false, code: "ASSET_CHANGED", stateChanged: false, phase: "resolve_asset" });
  expect(f.content).toBe(before); expect(f.writes).toBe(0);
});

test("inspection offers measured summary, complete model, exact pagination and real resources", () => {
  const f = fixture();
  const args = { documentVersion: version, sessionToken: "validated", __canonicalContent: f.content };
  expect(inspectOpenPresentation({ ...args, view: "summary" }, f.ctx)).toMatchObject({ ok: true, contentIncluded: false, documentBytes: new TextEncoder().encode(f.content).byteLength, slideCount: 1 });
  expect(inspectOpenPresentation({ ...args, view: "document" }, f.ctx)).toMatchObject({ ok: true, completeness: "complete", document: f.source });
  expect(inspectOpenPresentation({ ...args }, f.ctx)).toMatchObject({ ok: true, returnedSlides: 1, remainingSlides: 0, selectionPolicy: "full selected content" });
  expect(inspectOpenPresentation({ ...args, view: "resources" }, f.ctx)).toMatchObject({ ok: true, layouts: f.source.layouts, masters: f.source.masters });
  const schema = describeAuthoring({ definition: "SlidesDocument" });
  expect(schema).toMatchObject({ ok: true, completeness: "complete" });
  const overview = describeAuthoring({});
  expect(overview).toMatchObject({ ok: true, schemaIncluded: false, fullSchemaOption: { includeSchema: true } });
});

test("open template capture writes only the library and preserves uncertain resource failure", async () => {
  const f = fixture();
  const args = { documentVersion: version, sessionToken: "validated", __canonicalContent: f.content, expectedVersion: JSON.stringify(version), slideId: f.source.slides[0].id, name: "Opening" };
  expect(await saveOpenTemplate(args, f.ctx)).toMatchObject({ ok: true, status: "template_saved", sourceChanged: false });
  expect(f.writes).toBe(0);
  f.ctx.nautiloApp.templates!.save = async () => ({ ok: true, template: { id: "saved", name: "Opening" }, stateChanged: true, warnings: ["Refresh the template library"] });
  expect(await saveOpenTemplate(args, f.ctx)).toMatchObject({ ok: true, stateChanged: true, warnings: ["Refresh the template library"] });
  f.ctx.nautiloApp.templates!.save = async () => ({ ok: false, code: "WRITE_UNCERTAIN", phase: "reconcile", retrySafe: false, stateChanged: "unknown", message: "Inspect before retrying", recoveryActions: ["inspect_template"] });
  expect(await saveOpenTemplate(args, f.ctx)).toMatchObject({ ok: false, stateChanged: "unknown", retrySafe: false });
});

test("a large caller-chosen batch has no hidden operation ceiling", async () => {
  const f = fixture();
  const changes = Array.from({ length: 1200 }, (_, index) => ({ op: "replace", path: "/meta/title", value: `Revision ${index}` }));
  expect(await f.edit([{ op: "patch", changes }])).toMatchObject({ ok: true, status: "saved" });
  expect(f.writes).toBe(1);
  expect(parseSlideHtml(f.content).meta.title).toBe("Revision 1199");
  expect(() => patchSlideJson({}, [{ op: "add", path: "/constructor/prototype", value: 1 }])).toThrow();
});


test("tool adoption refusal gives complete repair information and writes nothing", async () => {
  const f = fixture();
  const before = f.content;
  const result = await f.edit([{ op: "patch", changes: [
    { op: "add", path: "/meta/futureA", value: "preserve me" },
    { op: "add", path: "/meta/futureB", value: { nested: true } },
  ] }]);
  expect(result).toMatchObject({ ok: false, code: "engine_adoption_changes_source",
    phase: "engine_adoption", stateChanged: false, errorCount: 2,
    affectedPaths: ["/meta/futureA", "/meta/futureB"],
    validationErrors: [{ path: "/meta/futureA", kind: "discarded" }, { path: "/meta/futureB", kind: "discarded" }],
  });
  expect(f.writes).toBe(0);
  expect(f.content).toBe(before);
  const description = describeAuthoring({});
  expect("resources" in description).toBe(true);
  if (!("resources" in description)) throw new Error("Authoring overview must describe resources");
  expect(description.resources).toContain("omit element.id and element.data.src");
});


test("native colors survive a mixed patch and image-helper transaction without normalization retries", async () => {
  const f = fixture();
  const shape: Element = { id: "outline", type: "shape", frame: { x: 10, y: 20, w: 100, h: 50, rotation: 0 }, data: { kind: "rect", stroke: { color: "#D9A441", width: 2 } } };
  const result = await f.edit([
    { op: "patch", changes: [
      { op: "add", path: "/meta/recentColors", value: ["#D9A441", "#d9a441"] },
      { op: "add", path: "/slides/0/elements/-", value: shape },
    ] },
    { op: "insert-image", slideId: f.source.slides[0].id, asset: { surface: "currentFolder", relativePath: "identity.png" }, element: { frame: { x: 20, y: 20, w: 60, h: 60, rotation: 0 } } },
  ]);
  expect(result).toMatchObject({ ok: true, status: "saved" });
  expect(f.writes).toBe(1);
  const saved = parseSlideHtml(f.content);
  expect(saved.meta.recentColors).toEqual(["#D9A441", "#d9a441"]);
  expect(saved.slides[0].elements).toContainEqual(shape);
  expect(saved.slides[0].elements.at(-1)).toMatchObject({ type: "image", data: { src: png } });
});
