import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { expect, spyOn, test } from "bun:test";
import { act, render, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { CodePreview } from "../../src/editors/code-editor";
import { ToolCard } from "../../src/components/tool-card/tool-card";
import { parseTextReadWindow } from "../../src/components/tool-card/renderers/file-read";

test("source preview retains every received line, uses its source offset, and is read only", async () => {
  reapplyHappyDomGlobals();
  const source = Array.from({ length: 350 }, (_, i) => `const line${i} = ${i};`).join("\n");
  const view = render(<CodePreview value={source} path="src/example.ts" firstLine={501} />);
  await waitFor(() => expect(view.container.querySelector(".cm-editor")).toBeTruthy());
  const editor = EditorView.findFromDOM(view.container.querySelector(".cm-editor") as HTMLElement)!;
  expect(editor.state.doc.toString()).toBe(source);
  expect(editor.state.doc.lines).toBe(350);
  expect(editor.state.facet(EditorState.readOnly)).toBe(true);
  expect(editor.contentDOM.getAttribute("contenteditable")).toBe("false");
  expect(view.container.querySelector(".cm-lineNumbers")?.textContent).toContain("501");
  expect(editor.contentDOM.getAttribute("aria-label")).toBe("Source code: src/example.ts");
  view.unmount();
});

test("read windows unwrap source, preserve literal markup, and disclose continued long lines", () => {
  const source = '<script>alert("literal source")</script>\\n';
  expect(parseTextReadWindow(JSON.stringify({ command: "read", content: source, sourceVersion: "version", startLine: 19, endLine: 19, partialEndLine: true, nextCursor: "next" }))).toEqual({ content: source, startLine: 19, endLine: 19, more: true, partialLine: true });
  expect(parseTextReadWindow('{"content":"a JSON source file"}')).toBeNull();
  expect(parseTextReadWindow('{"command":"read",')).toBeNull();
});

test("unchanged source previews do not reconfigure their editor on unrelated parent progress", async () => {
  reapplyHappyDomGlobals();
  const Preview = ({ tick, source }: { tick: number; source: string }) => <div data-progress={tick}><CodePreview value={source} path="source.ts" /></div>;
  const view = render(<Preview tick={0} source="const original = true;" />);
  await waitFor(() => expect(view.container.querySelector(".cm-editor")).toBeTruthy());
  const element = view.container.querySelector(".cm-editor") as HTMLElement;
  const editor = EditorView.findFromDOM(element)!;
  const dispatch = spyOn(editor, "dispatch");
  await act(async () => { view.rerender(<Preview tick={1} source="const original = true;" />); });
  expect(EditorView.findFromDOM(element)).toBe(editor);
  expect(dispatch).not.toHaveBeenCalled();
  view.rerender(<Preview tick={2} source="const updated = true;" />);
  await waitFor(() => expect(editor.state.doc.toString()).toBe("const updated = true;"));
  expect(EditorView.findFromDOM(element)).toBe(editor);
  dispatch.mockRestore(); view.unmount();
});

test("an empty read window does not render its JSON envelope as file content", () => {
  expect(parseTextReadWindow(JSON.stringify({ command: "read", content: "", sourceVersion: "v1", startLine: 1, endLine: 0, nextCursor: null }))).toEqual({ content: "", startLine: 1, endLine: 0, more: false, partialLine: false });
});


test("screen-reader tool outcomes stay positioned inside their own clipped card in a nested transcript", () => {
  reapplyHappyDomGlobals();
  // Relevant Tailwind utility rules. happy-dom can verify the actual containing
  // block relationship; Electron qualification verifies native scroll geometry.
  const styles = document.createElement("style");
  styles.textContent = ".relative{position:relative}.overflow-hidden{overflow:hidden}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}";
  document.head.appendChild(styles);
  const source = "const sourceRemainsAvailable = true;";
  const Fixture = ({ running }: { running: boolean }) => <div data-testid="outer-message" style={{ position: "relative" }}>
    <div style={{ height: 384, overflowY: "auto" }}>
      <div style={{ height: 17000 }} aria-hidden />
      <ToolCard toolName="file" toolCallId="nested-read" args={{ command: "read", path: "source.ts" }}
        status={{ type: running ? "running" : "complete" }} stateOverride={running ? "running" : "success"}
        defaultExpanded expandedContent={<pre>{source}</pre>} />
    </div>
  </div>;
  const view = render(<Fixture running />);
  try {
    const card = view.container.querySelector<HTMLElement>("[data-tool-card-state]")!;
    const announcement = card.querySelector<HTMLElement>('.sr-only[aria-live="polite"]')!;
    let containingBlock = announcement.parentElement;
    while (containingBlock && ["", "static"].includes(window.getComputedStyle(containingBlock).position)) containingBlock = containingBlock.parentElement;
    expect(containingBlock === card).toBe(true);
    expect(window.getComputedStyle(card).overflow).toBe("hidden");
    expect(announcement.textContent).toContain("running");
    expect(announcement.getAttribute("aria-hidden")).toBeNull();
    view.rerender(<Fixture running={false} />);
    expect(announcement.textContent).toContain("succeeded");
    expect(card.querySelector("pre")?.textContent).toBe(source);
  } finally { view.unmount(); styles.remove(); }
});

test("offscreen previews destroy editors, retain geometry and bytes, and disconnect their visibility observer", async () => {
  reapplyHappyDomGlobals();
  const original = globalThis.IntersectionObserver;
  let notify: IntersectionObserverCallback;
  let disconnected = false;
  globalThis.IntersectionObserver = class {
    constructor(private callback: IntersectionObserverCallback) {}
    observe(target: Element) { if (target.querySelector("pre")) notify = this.callback; }
    disconnect() { if (notify === this.callback) disconnected = true; }
  } as unknown as typeof IntersectionObserver;
  const source = 'const preserved = "🦀";\n'.repeat(350);
  const view = render(<CodePreview value={source} path="large.ts" />);
  const intersect = async (isIntersecting: boolean) => act(async () => {
    notify([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
  });
  try {
    expect(view.container.querySelector(".cm-editor")).toBeNull();
    expect(view.container.querySelector("pre")?.textContent).toBe(source);
    await intersect(true);
    const element = view.container.querySelector(".cm-editor") as HTMLElement;
    const editor = EditorView.findFromDOM(element)!;
    const destroy = spyOn(editor, "destroy");
    const geometry = spyOn(view.container.firstElementChild as HTMLElement, "getBoundingClientRect").mockReturnValue({ height: 384 } as DOMRect);
    await intersect(false);
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(view.container.querySelector(".cm-editor")).toBeNull();
    expect(view.container.querySelector("pre")?.style.height).toBe("384px");
    await intersect(true);
    const restored = EditorView.findFromDOM(view.container.querySelector(".cm-editor") as HTMLElement)!;
    expect(restored).not.toBe(editor);
    expect(restored.state.doc.toString()).toBe(source);
    geometry.mockRestore();
    view.unmount();
    expect(disconnected).toBe(true);
  } finally { view.unmount(); globalThis.IntersectionObserver = original; }
});
