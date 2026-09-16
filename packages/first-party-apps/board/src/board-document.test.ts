import { describe, expect, test } from "bun:test";
import { boardToSlidesDocument, type BoardModel } from "@nautilo/office-board";
import { MemSlidesStore } from "@nautilo/office-slides/node";
import {
  BOARD_FILE_EXTENSION,
  assertBoardAdoptionPreserves,
  createBoardDocument,
  parseBoardHtml,
  serializeBoardHtml,
  validateBoardDocument,
} from "./board-document";

const pixel = "data:image/png;base64,iVBORw0KGgo=";
const frame = (x: number, y: number, w = 120, h = 80) => ({ x, y, w, h, rotation: 0 });
const block = (text: string) => ({
  id: `block-${text}`,
  type: "paragraph" as const,
  inlines: [{ text, style: { fontSize: 18, href: "https://nautilo.ai" } }],
  style: { alignment: "left" as const, lineHeight: 1.2, marginTop: 0, marginBottom: 0, textIndent: 0, marginLeft: 0 },
});

function creativeBoard(): BoardModel {
  return {
    meta: { title: "Ideas", unit: "cm", recentColors: ["#ffd166"] },
    elements: [
      { id: "note", type: "shape", frame: frame(-40, 20), data: { kind: "roundRect", fill: { kind: "srgb", value: "#ffd166" }, text: { blocks: [block("Ship the good idea")] } } },
      { id: "copy", type: "text", frame: frame(140, 20, 200, 70), data: { blocks: [block("A linked rich-text thought")] } },
      { id: "image", type: "image", frame: frame(140, 120), data: { src: pixel, alt: "Reference" } },
      {
        id: "group", type: "group", frame: frame(360, 20, 200, 160), data: {
          refSize: { w: 200, h: 160 },
          children: [{ id: "nested", type: "shape", frame: frame(10, 10), data: { kind: "ellipse" } }],
        },
      },
      {
        id: "connector", type: "connector", frame: frame(-40, 20, 520, 80), routing: "curved",
        start: { kind: "attached", elementId: "note", siteIndex: 1 },
        end: { kind: "attached", elementId: "nested", siteIndex: 3 }, arrowheads: { end: { kind: "triangle", size: "md" } },
      },
    ],
  };
}

describe("native Board HTML document", () => {
  test("creates the canonical empty model and filename contract", () => {
    expect(createBoardDocument("Roadmap")).toEqual({ meta: { title: "Roadmap" }, elements: [] });
    expect(BOARD_FILE_EXTENSION).toBe(".board.html");
  });

  test("round-trips native groups, connectors, rich text and images exactly", () => {
    const source = creativeBoard() as BoardModel & { futureNativeProperty?: unknown };
    source.futureNativeProperty = { expressive: ["kept", { pressure: 0.72 }] };
    const html = serializeBoardHtml(source);
    expect(html).toContain('"documentType":"board"');
    expect(html).toContain('type="application/vnd.wafflebase.board+json"');
    expect(html).toContain("Static preview of Ideas");
    expect(html).toContain("Ship the good idea");
    expect(html).toContain("<line ");
    expect(parseBoardHtml(html)).toEqual(source);
  });

  test("preserves canonical adoption and refuses every changed or discarded source path", () => {
    const source = creativeBoard() as BoardModel & { future?: unknown };
    source.future = { "key/with~syntax": true };
    expect(() => assertBoardAdoptionPreserves(source, structuredClone(source))).not.toThrow();
    const adopted = structuredClone(source) as BoardModel & { future?: unknown };
    adopted.meta.title = "Rewritten";
    delete adopted.future;
    try {
      assertBoardAdoptionPreserves(source, adopted);
      throw new Error("expected adoption refusal");
    } catch (error) {
      expect(error).toMatchObject({
        code: "engine_adoption_changes_source", phase: "engine_adoption", stateChanged: false, retrySafe: true,
        errorCount: 2, affectedPaths: ["/meta/title", "/future"],
      });
    }
  });

  test("proves the owned Slides store preserves a canonical Board adoption", () => {
    const source = creativeBoard();
    const adoptedDeck = new MemSlidesStore(boardToSlidesDocument(source)).read();
    const adopted: BoardModel = {
      meta: {
        title: adoptedDeck.meta.title,
        ...(adoptedDeck.meta.unit === undefined ? {} : { unit: adoptedDeck.meta.unit }),
        ...(adoptedDeck.meta.recentColors === undefined ? {} : { recentColors: adoptedDeck.meta.recentColors }),
      },
      elements: adoptedDeck.slides[0].elements,
    };
    expect(() => assertBoardAdoptionPreserves(source, adopted)).not.toThrow();
    expect(adopted).toEqual(source);
  });

  test("rejects hostile or ambiguous HTML containers", () => {
    const canonical = serializeBoardHtml(createBoardDocument());
    expect(() => parseBoardHtml("")).toThrow(/non-empty/);
    expect(() => parseBoardHtml(canonical.replace('<script id="manifest"', '<script src="evil.js" id="manifest"'))).toThrow(/executable or unsupported/);
    expect(() => parseBoardHtml(canonical.replace("</body>", `${canonical.match(/<script id="wafflebase-board"[\s\S]*?<\/script>/)?.[0]}</body>`))).toThrow(/exactly two/);
    expect(() => parseBoardHtml(canonical.replace('"documentType":"board"', '"documentType":"presentation"'))).toThrow(/identity/);
    expect(() => parseBoardHtml(canonical.replace("</script>", ""))).toThrow(/unterminated|exactly two/);
  });

  test("rejects duplicate identities, stale references, remote data and invalid links", () => {
    const duplicate = creativeBoard();
    duplicate.elements[1].id = "note";
    expect(() => validateBoardDocument(duplicate)).toThrow(/unique across the Board/);

    const stale = creativeBoard();
    const connector = stale.elements.at(-1)!;
    if (connector.type === "connector") connector.end = { kind: "attached", elementId: "gone", siteIndex: 0 };
    expect(() => validateBoardDocument(stale)).toThrow(/identify an element/);

    const remote = creativeBoard();
    const image = remote.elements[2];
    if (image.type === "image") image.data.src = "https://example.com/tracker.png";
    expect(() => validateBoardDocument(remote)).toThrow(/self-contained/);

    const unsafeLink = creativeBoard() as unknown as { elements: Array<{ data?: { blocks?: Array<{ inlines: Array<{ style: { href?: string } }> }> } }> };
    unsafeLink.elements[1].data!.blocks![0].inlines[0].style.href = "javascript:alert(1)";
    expect(() => validateBoardDocument(unsafeLink)).toThrow(/http, https, or mailto/);
  });

  test("rejects attachment sites outside the target's native geometry", () => {
    const invalid = creativeBoard();
    const connector = invalid.elements.at(-1)!;
    if (connector.type === "connector") connector.start = { kind: "attached", elementId: "note", siteIndex: 999 };
    expect(() => validateBoardDocument(invalid)).toThrow(/connection site/);

    const geometryChange = creativeBoard();
    const note = geometryChange.elements[0];
    const attached = geometryChange.elements.at(-1)!;
    if (note.type === "shape") note.data.kind = "ellipse";
    if (attached.type === "connector") attached.start = { kind: "attached", elementId: "note", siteIndex: 6 };
    expect(() => validateBoardDocument(geometryChange)).not.toThrow();
    if (note.type === "shape") note.data.kind = "rect";
    expect(() => validateBoardDocument(geometryChange)).toThrow(/connection site/);
  });

  test("serializes an inert headless preview and escapes payload closing tags", () => {
    const model = createBoardDocument("</title><script>alert(1)</script>") as BoardModel & { extension?: string };
    model.extension = "</script><script>alert(2)</script>";
    const html = serializeBoardHtml(model);
    expect(html.match(/<script\b/g)).toHaveLength(2);
    expect(html).not.toContain("<script>alert");
    expect(parseBoardHtml(html)).toEqual(model);
  });

  test("projects nested group-local frames through ancestor transforms", () => {
    const model: BoardModel = { meta: { title: "Nested" }, elements: [{
      id: "outer", type: "group", frame: frame(100, 100, 200, 200), data: { refSize: { w: 100, h: 100 }, children: [{
        id: "inner", type: "group", frame: frame(10, 20, 40, 40), data: { refSize: { w: 20, h: 20 }, children: [{
          id: "leaf", type: "shape", frame: frame(5, 5, 10, 10), data: { kind: "rect" },
        }] },
      }] },
    }] };
    const html = serializeBoardHtml(model);
    expect(html).toContain('class="board-item board-shape" style="left:70px;top:90px;width:40px;height:40px;transform:rotate(0rad)"');
  });
});
