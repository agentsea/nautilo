import { describe, expect, test } from "bun:test";
import { MemSlidesStore, type SlidesDocument } from "../engine/browser.js";
import { createSlideDocument, serializeSlideHtml } from "./slide-document";
import { captureSlideTemplate, insertSlideTemplate } from "./slide-templates";

function block(id: string, text: string, fontSize = 12) {
  return {
    id,
    type: "paragraph" as const,
    inlines: [{ text, style: { fontSize, fontFamily: "Arial", color: "#123456" } }],
    style: { alignment: "left" as const, lineHeight: 1.5, marginTop: 0, marginBottom: 8, textIndent: 0, marginLeft: 0 },
  };
}

function sourceTemplateDeck(): SlidesDocument {
  const source = createSlideDocument();
  source.meta.pxPerPt = 8 / 3;
  source.meta.slideHeight = 1440;
  const sourceTheme = structuredClone(source.themes[0]);
  sourceTheme.id = "source-theme";
  sourceTheme.colors.accent1 = "#C026D3";
  source.themes.push(sourceTheme);
  const slide = source.slides[0];
  slide.themeId = sourceTheme.id;
  slide.notes = [block("note-private", "selected notes")];
  slide.elements = [
    {
      id: "shape-source",
      type: "shape",
      frame: { x: 100, y: 120, w: 300, h: 240, rotation: 0 },
      data: {
        kind: "rect",
        fill: { kind: "role", role: "accent1" },
        text: { blocks: [block("shape-block", "Template", 12)], inset: { left: 9, top: 7, right: 5, bottom: 3 } },
      },
    },
    {
      id: "connector-source",
      type: "connector",
      frame: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
      routing: "straight",
      start: { kind: "free", x: 10, y: 40 },
      end: { kind: "attached", elementId: "shape-source", siteIndex: 0 },
      arrowheads: {},
    },
    {
      id: "table-source",
      type: "table",
      frame: { x: 500, y: 400, w: 200, h: 80, rotation: 0 },
      data: {
        columnWidths: [200],
        rows: [{ height: 80, cells: [{ body: { blocks: [block("cell-block", "Cell", 10)] }, style: { padding: { top: 7 } } }] }],
      },
    },
    {
      id: "group-source",
      type: "group",
      frame: { x: 800, y: 600, w: 200, h: 200, rotation: 0 },
      data: {
        refSize: { w: 200, h: 200 },
        children: [
          { id: "child-shape", type: "shape", frame: { x: 20, y: 20, w: 80, h: 80, rotation: 0 }, data: { kind: "ellipse" } },
          {
            id: "child-connector", type: "connector", frame: { x: 0, y: 0, w: 0, h: 0, rotation: 0 },
            routing: "straight", start: { kind: "free", x: 0, y: 0 },
            end: { kind: "attached", elementId: "child-shape", siteIndex: 0 }, arrowheads: {},
          },
        ],
      },
    },
  ];
  slide.animations = [{
    id: "animation-source",
    elementId: "shape-source",
    category: "entrance",
    effect: "fadeIn",
    start: "onClick",
    durationMs: 300,
  }];
  return source;
}

describe("slide templates", () => {
  test("captures only the selected slide and its exact design closure", () => {
    const source = sourceTemplateDeck();
    const privateSlide = structuredClone(source.slides[0]);
    privateSlide.id = "other-slide";
    privateSlide.notes = [block("other-note", "must not leak")];
    source.slides.push(privateSlide);
    source.guides.push({ id: "private-guide", axis: "x", position: 99 });

    const captured = captureSlideTemplate(source, source.slides[0].id);

    expect(captured.slides).toHaveLength(1);
    expect(captured.slides[0].notes[0].inlines[0].text).toBe("selected notes");
    expect(JSON.stringify(captured)).not.toContain("must not leak");
    expect(captured.guides).toEqual([]);
    expect(captured.themes.map((theme) => theme.id)).toEqual(["source-theme"]);
    expect(captured.layouts).toHaveLength(1);
    expect(captured.masters).toHaveLength(1);
  });

  test("inserts a scaled independent copy with remapped references in one undo", () => {
    const source = sourceTemplateDeck();
    const template = captureSlideTemplate(source, source.slides[0].id);
    const sourceBefore = JSON.stringify(source);
    const templateBefore = JSON.stringify(template);
    const target = createSlideDocument();
    const targetBefore = structuredClone(target);
    const store = new MemSlidesStore(target);

    const insertedId = insertSlideTemplate(store, template, target.slides[0].id);
    const result = store.read();
    const inserted = result.slides.find((slide) => slide.id === insertedId)!;
    const shape = inserted.elements.find((element) => element.type === "shape")!;
    const connector = inserted.elements.find((element) => element.type === "connector")!;
    const table = inserted.elements.find((element) => element.type === "table")!;
    const group = inserted.elements.find((element) => element.type === "group")!;

    expect(result.meta).toEqual(target.meta);
    expect(inserted.themeId).toBeDefined();
    expect(inserted.themeId).not.toBe("source-theme");
    expect(result.themes.find((theme) => theme.id === inserted.themeId)?.colors.accent1).toBe("#C026D3");
    expect(shape.id).not.toBe("shape-source");
    expect(shape.frame.y).toBe(90);
    expect(shape.frame.h).toBe(180);
    if (shape.type === "shape" && shape.data.text) {
      expect(shape.data.text.blocks[0].id).not.toBe("shape-block");
      expect(shape.data.text.blocks[0].inlines[0].style.fontSize).toBe(24);
      expect(shape.data.text.inset).toEqual({ left: 9, top: 7, right: 5, bottom: 3 });
    }
    if (table.type === "table") {
      expect(table.data.rows[0].height).toBe(60);
      expect(table.data.rows[0].cells[0].body.blocks[0].inlines[0].style.fontSize).toBe(20);
      expect(table.data.rows[0].cells[0].style.padding).toEqual({ top: 7 });
    }
    if (group.type === "group") {
      expect(group.frame).toMatchObject({ y: 450, h: 150 });
      expect(group.data.refSize).toEqual({ w: 200, h: 200 });
      const childShape = group.data.children.find((element) => element.type === "shape")!;
      const childConnector = group.data.children.find((element) => element.type === "connector")!;
      expect(childShape.id).not.toBe("child-shape");
      if (childConnector.type === "connector") {
        expect(childConnector.end).toEqual({ kind: "attached", elementId: childShape.id, siteIndex: 0 });
      }
    }
    if (connector.type === "connector") {
      expect(connector.end).toEqual({ kind: "attached", elementId: shape.id, siteIndex: 0 });
      expect(connector.start).toEqual({ kind: "free", x: 10, y: 30 });
    }
    expect(inserted.notes[0].id).not.toBe("note-private");
    expect(inserted.animations?.[0].id).not.toBe("animation-source");
    expect(inserted.animations?.[0].elementId).toBe(shape.id);
    expect(JSON.stringify(source)).toBe(sourceBefore);
    expect(JSON.stringify(template)).toBe(templateBefore);
    expect(() => serializeSlideHtml(result)).not.toThrow();

    store.undo();
    expect(store.read()).toEqual(targetBefore);
    store.redo();
    expect(store.read().slides.some((slide) => slide.id === insertedId)).toBe(true);
  });

  test("deck-wide theme application clears imported slide overrides", () => {
    const store = new MemSlidesStore(createSlideDocument());
    const source = sourceTemplateDeck();
    insertSlideTemplate(store, captureSlideTemplate(source, source.slides[0].id));
    const currentTheme = store.read().meta.themeId;
    store.batch(() => store.applyTheme(currentTheme));
    expect(store.read().slides.every((slide) => slide.themeId === undefined)).toBe(true);
    expect(store.read().masters.every((master) => master.themeId === currentTheme)).toBe(true);
  });

  test("uses legacy deck theme semantics when a raw template has no slide override", () => {
    const source = sourceTemplateDeck();
    delete source.slides[0].themeId;
    source.meta.themeId = "source-theme";
    // This is deliberately stale, matching decks created before per-slide themes.
    source.masters[0].themeId = "default-light";
    const store = new MemSlidesStore(createSlideDocument());
    const insertedId = insertSlideTemplate(store, source);
    const result = store.read();
    const inserted = result.slides.find((slide) => slide.id === insertedId)!;
    expect(result.themes.find((theme) => theme.id === inserted.themeId)?.colors.accent1).toBe("#C026D3");
  });

  test("refuses a cross-font-scale chart before creating history or changing either document", () => {
    const source = sourceTemplateDeck();
    source.slides[0].elements.push({
      id: "chart-source",
      type: "chart",
      frame: { x: 0, y: 0, w: 400, h: 300, rotation: 0 },
      data: { kind: "column", categories: ["A"], series: [{ values: [1] }] },
    });
    const template = captureSlideTemplate(source, source.slides[0].id);
    const templateBefore = JSON.stringify(template);
    const store = new MemSlidesStore(createSlideDocument());
    const targetBefore = store.read();

    expect(() => insertSlideTemplate(store, template)).toThrow("different presentation font scale");
    expect(store.read()).toEqual(targetBefore);
    expect(store.canUndo()).toBe(false);
    expect(JSON.stringify(template)).toBe(templateBefore);
  });
});
