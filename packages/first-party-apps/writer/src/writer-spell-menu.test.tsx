import { beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { EditorAPI } from "@nautilo/office-docs/browser";
import { WriterSpellMenu } from "./writer-spell-menu";
import { installWriterTestDom } from "./test-dom";

describe("WriterSpellMenu", () => {
  beforeEach(() => { installWriterTestDom(); (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true; });

  test("focuses, navigates, activates, escapes, and clamps a bottom-right menu", async () => {
    const calls: string[] = [];
    Object.defineProperty(window, "visualViewport", { configurable: true, value: { offsetLeft: 40, offsetTop: 30, width: 400, height: 300 } as VisualViewport });
    const editor = {
      getSpellSuggestions: async () => ["hello"],
      applySpellSuggestion: () => calls.push("replace"),
      focus: () => calls.push("focus"),
    } as unknown as EditorAPI;
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    await act(async () => { root.render(createElement(WriterSpellMenu, { editor, request: { error: { blockId: "b", start: 0, end: 4, word: "helo" }, clientX: 9999, clientY: 9999 }, theme: "light", onIgnore: () => calls.push("ignore"), onLearn: () => calls.push("learn"), onClose: () => calls.push("close") })); await Promise.resolve(); });
    const menu = document.querySelector('[role="menu"]') as HTMLElement;
    expect(menu).toBeTruthy();
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect([...document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "hello")).toBe(true);
    const left = Number.parseFloat((menu as HTMLElement).style.left);
    const top = Number.parseFloat((menu as HTMLElement).style.top);
    expect(left).toBe(432);
    expect(top).toBe(322);
    expect(document.activeElement?.getAttribute("role")).toBe("menuitem");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })); });
    expect(document.activeElement?.textContent).toBe("Learn spelling");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true })); });
    expect(document.activeElement?.textContent).toBe("Ignore spelling");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(calls).toContain("ignore");
    await act(async () => { menu.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await Promise.resolve(); });
    expect(calls).toContain("focus");
    await act(async () => { root.unmount(); });
  });
});
