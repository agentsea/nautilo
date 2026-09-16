import { describe, expect, test } from "bun:test";
import { MemSlidesStore } from "../engine/browser.js";
import { createSlideDocument, parseSlideHtml, serializeSlideHtml } from "./slide-document";
import { applyDesignTheme, getDesignThemes } from "./slide-design";

describe("presentation design choices", () => {
  test("offers the full catalog without modifying an existing one-theme deck", () => {
    const document = createSlideDocument();
    const before = serializeSlideHtml(document);
    expect(document.themes).toHaveLength(1);
    expect(getDesignThemes(document)).toHaveLength(23);
    expect(serializeSlideHtml(document)).toBe(before);
  });

  test("persists only a selected theme with content preserved and one undo step", () => {
    const document = createSlideDocument();
    const store = new MemSlidesStore(document);
    const initialChoices = getDesignThemes(store.read());
    applyDesignTheme(store, "luxe");
    expect(getDesignThemes(store.read())).toEqual(initialChoices);
    expect(store.read().meta.themeId).toBe("luxe");
    expect(store.read().themes).toHaveLength(2);
    expect(store.read().slides).toEqual(document.slides);
    expect(store.read().layouts).toEqual(document.layouts);
    const reopened = parseSlideHtml(serializeSlideHtml(store.read()));
    expect(reopened.meta.themeId).toBe("luxe");
    expect(reopened.themes.find((theme) => theme.id === "luxe")?.name).toBe("Luxe");
    store.undo();
    expect(store.read()).toEqual(document);
    expect(store.canUndo()).toBe(false);
    store.redo();
    expect(store.read().meta.themeId).toBe("luxe");
  });

  test("preserves imported definitions even when their IDs match the built-in catalog", () => {
    const document = createSlideDocument();
    const custom = structuredClone(document.themes[0]);
    custom.id = "luxe";
    custom.name = "Our imported brand";
    custom.colors.accent1 = "#123456";
    document.themes.push(custom);
    const extra = structuredClone(custom);
    extra.id = "company-theme";
    document.themes.push(extra);
    const choices = getDesignThemes(document);
    expect(choices).toHaveLength(24);
    expect(choices.find((theme) => theme.id === "luxe")).toEqual(custom);
    const store = new MemSlidesStore(document);
    applyDesignTheme(store, "luxe");
    expect(store.read().themes).toEqual(document.themes);
  });

  test("refuses unknown themes and avoids history entries for the current choice", () => {
    const store = new MemSlidesStore(createSlideDocument());
    const before = store.read();
    applyDesignTheme(store, before.meta.themeId);
    expect(() => applyDesignTheme(store, "missing")).toThrow("no longer available");
    expect(store.read()).toEqual(before);
    expect(store.canUndo()).toBe(false);
  });
});
