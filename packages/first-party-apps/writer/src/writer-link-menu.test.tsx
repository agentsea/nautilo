import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import type { EditorAPI } from "@nautilo/office-docs/browser";
import { installWriterTestDom } from "./test-dom";
installWriterTestDom();
const { createRoot } = await import("react-dom/client");
const { flushSync } = await import("react-dom");
const { WriterLinkMenu } = await import("./writer-doc-surface");
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
function changeInput(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(input, value);
  input.dispatchEvent(new window.Event("input", { bubbles: true }));
}

let root: Root;
beforeEach(() => { installWriterTestDom(); });
afterEach(async () => { if (root) await act(async () => root.unmount()); delete window.nautiloApp; });
const button = (text: string) => Array.from(document.querySelectorAll("button")).find((item) => item.textContent === text)!;

describe("Writer link controls", () => {
  test("shows a clicked link, opens via the host, prefills editing, applies and removes without changing its text", async () => {
    let href: string | undefined = "https://example.com/original";
    let cursorChange: Parameters<EditorAPI["onCursorLinkChange"]>[0] = () => {};
    let request: () => void = () => {};
    let openGesture: ((url: string) => void) | undefined;
    const opened: string[] = [];
    window.nautiloApp = { links: { open: async (url: string) => { opened.push(url); } } } as typeof window.nautiloApp;
    const editor = {
      getLinkAtCursor: () => href,
      onLinkRequest: (cb: typeof request) => { request = cb; },
      onOpenLink: (cb: typeof openGesture) => { openGesture = cb; },
      onCursorLinkChange: (cb: typeof cursorChange) => { cursorChange = cb; },
      insertLink: (url: string) => { href = url; },
      removeLink: () => { href = undefined; },
      focus: () => {},
    } as unknown as EditorAPI;
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(createElement(WriterLinkMenu, { editor, disabled: false })));
    await act(async () => cursorChange({ href: href!, rect: { x: 10, y: 10, width: 80, height: 20 } }));
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(href!);
    // Canvas links open on mousedown. The same gesture must not dismiss
    // the popover, including when clicking the current link again.
    const canvasLink = document.createElement("span"); host.appendChild(canvasLink);
    canvasLink.addEventListener("mousedown", () => flushSync(() => {
      cursorChange({ href: href!, rect: { x: 10, y: 10, width: 80, height: 20 } });
    }));
    await act(async () => { canvasLink.dispatchEvent(new window.MouseEvent("mousedown", { bubbles: true })); });
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(href!);
    await act(async () => button("Open link").click());
    expect(opened).toEqual([href!]);
    await act(async () => button("Edit link").click());
    const input = document.querySelector('[aria-label="Link URL"]') as HTMLInputElement;
    expect(input.value).toBe(href!);
    await act(async () => {
      changeInput(input, "https://example.com/updated");
    });
    await act(async () => button("Apply").click());
    expect(href).toBe("https://example.com/updated");
    await act(async () => request());
    expect((document.querySelector('[aria-label="Link URL"]') as HTMLInputElement).value).toBe(href!);
    await act(async () => openGesture?.(href!));
    expect(opened.at(-1)).toBe(href!);
    await act(async () => button("Remove link").click());
    expect(href).toBeUndefined();
  });

  test("invalid URLs leave the existing link unchanged and show an error", async () => {
    let current = "https://example.com";
    const editor = { getLinkAtCursor: () => current, onLinkRequest: () => {}, onOpenLink: () => {}, onCursorLinkChange: () => {}, insertLink: (url: string) => { current = url; }, focus: () => {} } as unknown as EditorAPI;
    const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
    await act(async () => root.render(createElement(WriterLinkMenu, { editor, disabled: false })));
    await act(async () => (host.querySelector("button") as HTMLButtonElement).click());
    const input = document.querySelector('[aria-label="Link URL"]') as HTMLInputElement;
    await act(async () => { changeInput(input, "javascript:alert(1)"); });
    await act(async () => button("Apply").click());
    expect(current).toBe("https://example.com");
    expect(document.querySelector('[role="alert"]')?.textContent).toContain("valid");
  });
});
