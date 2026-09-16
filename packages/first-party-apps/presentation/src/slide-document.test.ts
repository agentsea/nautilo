import { describe, expect, test } from "bun:test";
import { MemSlidesStore } from "../engine/node.js";
import { assertSlideAdoptionPreserves, createSlideDocument, parseSlideHtml, serializeSlideHtml, validateSlideDocument } from "./slide-document";

describe("native presentation document", () => {
  test("preserves explicit chart axes through native save, reopen and engine adoption", () => {
    const document = createSlideDocument();
    const chart = {
      id: "chart-axis", type: "chart", frame: { x: 10, y: 10, w: 400, h: 200, rotation: 0 },
      data: { kind: "bar", categories: ["A", "B"], series: [{ values: [-5, 12] }], valueAxis: { min: -20, max: 30, crossAt: 5 } },
    };
    const source = structuredClone(document) as unknown as { slides: Array<{ elements: unknown[] }> };
    source.slides[0].elements.push(chart);
    const validated = validateSlideDocument(source);
    expect(parseSlideHtml(serializeSlideHtml(validated))).toEqual(validated);
    expect(() => assertSlideAdoptionPreserves(validated, new MemSlidesStore(validated).read())).not.toThrow();
    expect(chart.data.valueAxis).toEqual({ min: -20, max: 30, crossAt: 5 });
  });

  test("refuses malformed or inverted chart axes without rewriting source", () => {
    for (const axis of [{ min: "0" }, { min: 10, max: 10 }, { min: 20, max: 10 }, { min: Number.MAX_VALUE }, { max: -Number.MAX_VALUE }, { crossAt: "zero" }, { crosses: "somewhere" }]) {
      const source = createSlideDocument() as unknown as { slides: Array<{ elements: unknown[] }> };
      source.slides[0].elements.push({
        id: "chart-axis", type: "chart", frame: { x: 10, y: 10, w: 400, h: 200, rotation: 0 },
        data: { kind: "bar", categories: ["A"], series: [{ values: [5] }], valueAxis: axis },
      });
      const before = JSON.stringify(source);
      expect(() => validateSlideDocument(source)).toThrow(/valueAxis/);
      expect(JSON.stringify(source)).toBe(before);
    }
  });

  test("creates and round-trips one editable title slide", () => {
    const document = createSlideDocument();
    expect(document.slides).toHaveLength(1);
    const html = serializeSlideHtml(document);
    expect(html).toContain('type="application/vnd.nautilo.document+json"');
    expect(html).toContain('type="application/vnd.wafflebase.presentation+json"');
    expect(parseSlideHtml(html)).toEqual(document);
  });

  test("preserves unknown safe metadata rather than silently dropping it", () => {
    const document = createSlideDocument() as typeof createSlideDocument extends () => infer T ? T & { extensionData: { future: string } } : never;
    document.extensionData = { future: "kept" };
    expect((parseSlideHtml(serializeSlideHtml(document)) as unknown as { extensionData: unknown }).extensionData).toEqual({ future: "kept" });
    expect(() => assertSlideAdoptionPreserves(document, new MemSlidesStore(document).read())).toThrow(/extensionData would be discarded/);
  });

  test("refuses nested fields the engine would silently discard and accepts its canonical model", () => {
    const canonical = createSlideDocument();
    expect(() => assertSlideAdoptionPreserves(canonical, new MemSlidesStore(canonical).read())).not.toThrow();
    for (const mutate of [
      (document: Record<string, unknown>) => { (document["meta"] as Record<string, unknown>)["futureMeta"] = true; },
      (document: Record<string, unknown>) => { ((document["layouts"] as Record<string, unknown>[])[0])["futureLayout"] = true; },
      (document: Record<string, unknown>) => { ((document["slides"] as Record<string, unknown>[])[0])["futureSlide"] = true; },
    ]) {
      const source = structuredClone(canonical) as unknown as Record<string, unknown>;
      mutate(source);
      const validated = validateSlideDocument(source);
      expect(() => assertSlideAdoptionPreserves(validated, new MemSlidesStore(validated).read())).toThrow(/would be discarded/);
    }
  });

  test("rejects executable scripts, remote images, unsupported elements, and stale references", () => {
    const canonical = serializeSlideHtml(createSlideDocument());
    expect(() => parseSlideHtml(canonical.replace('<script id="manifest"', '<script src="evil.js" id="manifest"'))).toThrow(/executable or unsupported/);

    const remoteImage = createSlideDocument();
    remoteImage.slides[0].elements.push({ id: "image-1", type: "image", frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0 }, data: { src: "https://example.com/a.png" } });
    expect(() => validateSlideDocument(remoteImage)).toThrow(/self-contained base64/);

    const unsupported = createSlideDocument() as unknown as { slides: Array<{ elements: unknown[] }> };
    unsupported.slides[0].elements.push({ id: "video-1", type: "video", frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0 }, data: {} });
    expect(() => validateSlideDocument(unsupported)).toThrow(/unsupported/);

    const stale = createSlideDocument() as unknown as { slides: Array<{ elements: unknown[] }> };
    stale.slides[0].elements.push({ id: "connector-1", type: "connector", frame: { x: 0, y: 0, w: 10, h: 10, rotation: 0 }, routing: "straight", start: { kind: "attached", elementId: "missing", siteIndex: 0 }, end: { kind: "free", x: 10, y: 10 }, arrowheads: {} });
    expect(() => validateSlideDocument(stale)).toThrow(/references a missing element/);
  });

  test("escapes closing script text inside safe extension data", () => {
    const document = createSlideDocument() as unknown as ReturnType<typeof createSlideDocument> & { extensionData: string };
    document.extensionData = "</script><script>alert(1)</script>";
    const html = serializeSlideHtml(document);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(parseSlideHtml(html)).toEqual(document);
  });

  test("preserves sparse note styles emitted by NotesPanel", () => {
    const document = createSlideDocument();
    const notes = [
      { id: "notes-0", type: "paragraph", inlines: [{ text: "First line", style: {} }], style: {} },
      { id: "notes-1", type: "paragraph", inlines: [{ text: "Second line", style: {} }], style: {} },
    ] as unknown as (typeof document.slides)[number]["notes"];
    document.slides[0].notes = notes;

    const parsed = parseSlideHtml(serializeSlideHtml(document));
    expect(parsed.slides[0].notes).toEqual(document.slides[0].notes);
    expect(() => assertSlideAdoptionPreserves(parsed, new MemSlidesStore(parsed).read())).not.toThrow();

    const unsafe = structuredClone(document) as unknown as {
      slides: Array<{ notes: Array<{ style: Record<string, unknown> }> }>;
    };
    unsafe.slides[0].notes[0].style.lineHeight = "tall";
    expect(() => validateSlideDocument(unsafe)).toThrow(/notes\[0\]\.style\.lineHeight/);
  });
});


test("rejects an empty deck instead of silently adding unsaved content", () => {
  const document = createSlideDocument();
  document.slides = [];
  expect(() => serializeSlideHtml(document)).toThrow("at least one slide");
});


test("adoption refusal reports every changed or discarded field with addressable pointers", () => {
  const source = createSlideDocument();
  const adopted = structuredClone(source);
  const extended = source.meta as typeof source.meta & Record<string, unknown>;
  extended["future/key~name"] = { important: true };
  adopted.meta.title = "Engine rewrite";
  const before = JSON.stringify(source);
  try {
    assertSlideAdoptionPreserves(source, adopted);
    throw new Error("expected adoption refusal");
  } catch (error) {
    expect(error).toMatchObject({
      code: "engine_adoption_changes_source", phase: "engine_adoption", stateChanged: false,
      retrySafe: true, errorCount: 2,
      affectedPaths: ["/meta/title", "/meta/future~1key~0name"],
      errors: [
        { path: "/meta/title", kind: "changed", adoptedValue: "Engine rewrite" },
        { path: "/meta/future~1key~0name", kind: "discarded" },
      ],
    });
  }
  expect(JSON.stringify(source)).toBe(before);
});
