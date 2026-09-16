import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import React, {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// Models the editor's live document. In real MDXEditor, `getMarkdown()` returns
// the editor's current content (seeded from the initial `markdown` prop and
// thereafter only changed by `setMarkdown`/edits) — it does NOT track later
// `markdown` prop changes. The mock mirrors that so the prop-sync guard can be
// exercised honestly.
let editorContent = "";
const setMarkdownMock = mock((markdown: string) => {
  editorContent = markdown;
});
let animationFrames: FrameRequestCallback[] = [];
type TestSelection = {
  anchorNode: Node | null;
  anchorOffset: number;
  focusNode: Node | null;
  focusOffset: number;
  removeAllRanges: () => void;
  addRange: (range: Range) => void;
  setBaseAndExtent: (anchorNode: Node, anchorOffset: number, focusNode: Node, focusOffset: number) => void;
};
let testSelection: TestSelection;

function flushAnimationFrames() {
  const pending = animationFrames;
  animationFrames = [];
  for (const callback of pending) callback(performance.now());
}

function setSelectionByTextOffset(editable: HTMLElement, anchor: number, focus: number) {
  const findTextPoint = (offset: number) => {
    const walker = document.createTreeWalker(editable, window.NodeFilter.SHOW_TEXT);
    let remaining = offset;
    let node = walker.nextNode();
    while (node) {
      const length = node.textContent?.length ?? 0;
      if (remaining <= length) return { node, offset: remaining };
      remaining -= length;
      node = walker.nextNode();
    }
    throw new Error(`No text point at offset ${offset}`);
  };
  const anchorPoint = findTextPoint(anchor);
  const focusPoint = findTextPoint(focus);
  const selection = window.getSelection()!;
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(anchorPoint.node, anchorPoint.offset);
  range.setEnd(focusPoint.node, focusPoint.offset);
  selection.addRange(range);
}

function selectionOffsets(editable: HTMLElement) {
  const selection = window.getSelection()!;
  const offsetFor = (node: Node | null, offset: number) => {
    if (node?.nodeType === 3) {
      const walker = document.createTreeWalker(editable, window.NodeFilter.SHOW_TEXT);
      let textOffset = 0;
      let textNode = walker.nextNode() as Text | null;
      while (textNode) {
        if (textNode === node) return textOffset + offset;
        textOffset += textNode.data.length;
        textNode = walker.nextNode() as Text | null;
      }
    }
    const range = document.createRange();
    range.selectNodeContents(editable);
    range.setEnd(node!, offset);
    return range.toString().length;
  };
  return {
    anchor: offsetFor(selection.anchorNode, selection.anchorOffset),
    focus: offsetFor(selection.focusNode, selection.focusOffset),
  };
}

mock.module("@mdxeditor/editor", () => {
  const passthroughPlugin = () => ({});
  const Passthrough = ({ children }: { children?: React.ReactNode }) => <>{children}</>;
  return {
    BoldItalicUnderlineToggles: () => null,
    ChangeCodeMirrorLanguage: () => null,
    codeBlockPlugin: passthroughPlugin,
    codeMirrorPlugin: passthroughPlugin,
    ConditionalContents: Passthrough,
    CreateLink: () => null,
    diffSourcePlugin: passthroughPlugin,
    DiffSourceToggleWrapper: Passthrough,
    headingsPlugin: passthroughPlugin,
    InsertCodeBlock: () => null,
    InsertTable: () => null,
    linkPlugin: passthroughPlugin,
    listsPlugin: passthroughPlugin,
    ListsToggle: () => null,
    markdownShortcutPlugin: passthroughPlugin,
    quotePlugin: passthroughPlugin,
    tablePlugin: passthroughPlugin,
    thematicBreakPlugin: passthroughPlugin,
    toolbarPlugin: passthroughPlugin,
    UndoRedo: () => null,
    MDXEditor: forwardRef(
      (
        props: {
          markdown: string;
          className?: string;
          overlayContainer?: HTMLElement;
          onChange?: (markdown: string, initialMarkdownNormalize: boolean) => void;
        },
        ref,
      ) => {
        const [markdown, setMarkdown] = useState(props.markdown);
        const seeded = React.useRef(false);
        const editableRef = useRef<HTMLDivElement | null>(null);
        if (!seeded.current) {
          editorContent = props.markdown;
          seeded.current = true;
        }
        // MDXEditor's `setMarkdown` re-imports the Lexical tree and selects its
        // root start when it was focused. Model that real reset so this test
        // proves the Workbench wrapper restores a logical selection afterwards.
        useLayoutEffect(() => {
          const editable = editableRef.current;
          if (!editable || document.activeElement !== editable) return;
          setSelectionByTextOffset(editable, 0, 0);
        }, [markdown]);
        useEffect(() => {
          const popup = document.createElement("div");
          popup.classList.add("mdxeditor-popup-container", ...(props.className?.split(" ") ?? []));
          (props.overlayContainer ?? document.body).appendChild(popup);
          return () => popup.remove();
        }, [props.className, props.overlayContainer]);
        useImperativeHandle(ref, () => ({
          getMarkdown: () => editorContent,
          setMarkdown: (nextMarkdown: string) => {
            setMarkdownMock(nextMarkdown);
            setMarkdown(nextMarkdown);
          },
          insertMarkdown: () => {},
          focus: () => {},
          getEditorState: () => null,
          getContentEditableHTML: () => "",
          getMarkdownSelection: () => "",
        }), []);
        return (
          <div
            data-testid="mdx-editor"
            data-mode="rich-text"
            className={`mdxeditor mdxeditor-rich-text-editor ${props.className ?? ""}`}
          >
            <div ref={editableRef} contentEditable suppressContentEditableWarning>
              {markdown}
            </div>
          </div>
        );
      },
    ),
  };
});

const { MarkdownEditor, iconComponentFor } = await import("../../src/editors/markdown-editor");
const { WorkbenchPortalProvider } = await import("../../src/components/workbench-portals");

beforeEach(() => {
  reapplyHappyDomGlobals();
  testSelection = {
    anchorNode: null,
    anchorOffset: 0,
    focusNode: null,
    focusOffset: 0,
    removeAllRanges() {
      this.anchorNode = null;
      this.anchorOffset = 0;
      this.focusNode = null;
      this.focusOffset = 0;
    },
    addRange(range) {
      this.anchorNode = range.startContainer;
      this.anchorOffset = range.startOffset;
      this.focusNode = range.endContainer;
      this.focusOffset = range.endOffset;
    },
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      this.anchorNode = anchorNode;
      this.anchorOffset = anchorOffset;
      this.focusNode = focusNode;
      this.focusOffset = focusOffset;
    },
  };
  Object.defineProperty(window, "getSelection", {
    configurable: true,
    value: () => testSelection,
  });
  editorContent = "";
  setMarkdownMock.mockClear();
  animationFrames = [];
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  }) as typeof requestAnimationFrame;
});

describe("MarkdownEditor", () => {
  test("shares theme with its admitted popup host without copying editor layout classes", () => {
    const style = document.createElement("style");
    style.textContent = readFileSync(join(import.meta.dir, "../../src/index.css"), "utf8");
    document.body.appendChild(style);
    const view = render(
      <WorkbenchPortalProvider>
        <MarkdownEditor value="one" onChange={() => {}} />
      </WorkbenchPortalProvider>,
    );

    const editor = view.getByTestId("mdx-editor");
    const popupHost = view.container.querySelector<HTMLElement>(".mdxeditor-popup-container");
    expect(editor.classList.contains("mdxeditor")).toBe(true);
    expect(editor.classList.contains("nautilo-mdx-editor")).toBe(true);
    expect(popupHost?.parentElement?.hasAttribute("data-workbench-portals")).toBe(true);
    expect([...popupHost!.classList]).toEqual([
      "mdxeditor-popup-container",
      "nautilo-mdx-editor",
    ]);
    expect(getComputedStyle(editor).paddingTop).toBe("12px");
    expect(Number.parseFloat(getComputedStyle(popupHost!).paddingTop) || 0).toBe(0);
    expect(Number.parseFloat(getComputedStyle(popupHost!).paddingBottom) || 0).toBe(0);
    view.unmount();
    style.remove();
  });

  test("pushes external markdown prop changes into MDXEditor", () => {
    const view = render(<MarkdownEditor value="one" onChange={() => {}} />);

    expect(setMarkdownMock).toHaveBeenCalledTimes(0);

    view.rerender(<MarkdownEditor value="two" onChange={() => {}} />);

    expect(setMarkdownMock).toHaveBeenCalledTimes(1);
    expect(setMarkdownMock).toHaveBeenCalledWith("two");
  });

  test("does not re-apply when the editor already shows the incoming value", () => {
    const view = render(<MarkdownEditor value="one" onChange={() => {}} />);

    // The live editor content has already advanced to "two" (e.g. a patch was
    // reflected into the document). When the parent's `value` catches up to the
    // same text, re-applying it via setMarkdown would needlessly reset the
    // caret + scroll — so it must be skipped.
    editorContent = "two";
    view.rerender(<MarkdownEditor value="two" onChange={() => {}} />);

    expect(setMarkdownMock).toHaveBeenCalledTimes(0);
  });

  test("preserves a focused rich-text selection and scroll position across a non-overlapping external update", () => {
    const view = render(
      <div data-testid="scroller" style={{ height: "20px", overflowY: "auto" }}>
        <MarkdownEditor value="alpha bravo charlie" onChange={() => {}} />
      </div>,
    );
    const scroller = view.getByTestId("scroller");
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 20 },
      scrollHeight: { configurable: true, value: 200 },
    });
    scroller.scrollTop = 73;
    const editor = view.getByTestId("mdx-editor");
    const editable = editor.querySelector<HTMLElement>("[contenteditable='true']")!;
    editable.focus();
    setSelectionByTextOffset(editable, 6, 11);
    expect(selectionOffsets(editable)).toEqual({ anchor: 6, focus: 11 });

    view.rerender(
      <div data-testid="scroller" style={{ height: "20px", overflowY: "auto" }}>
        <MarkdownEditor value={"alpha bravo charlie\nremote footer"} onChange={() => {}} />
      </div>,
    );

    // `setMarkdown` has reset the mock Lexical editor to the document start.
    expect(selectionOffsets(editable)).toEqual({ anchor: 0, focus: 0 });

    act(() => flushAnimationFrames());

    expect(document.activeElement).toBe(editable);
    expect(selectionOffsets(editable)).toEqual({ anchor: 6, focus: 11 });
    expect(scroller.scrollTop).toBe(73);
    expect(editor.getAttribute("data-mode")).toBe("rich-text");
  });

  test("maps a focused rich-text selection forward when remote text is inserted before it", () => {
    const view = render(<MarkdownEditor value="alpha bravo charlie" onChange={() => {}} />);
    const editor = view.getByTestId("mdx-editor");
    const editable = editor.querySelector<HTMLElement>("[contenteditable='true']")!;
    editable.focus();
    setSelectionByTextOffset(editable, 6, 11);
    expect(selectionOffsets(editable)).toEqual({ anchor: 6, focus: 11 });

    view.rerender(
      <MarkdownEditor value={"remote header\nalpha bravo charlie"} onChange={() => {}} />,
    );
    expect(editable.textContent).toBe("remote header\nalpha bravo charlie");
    expect(selectionOffsets(editable)).toEqual({ anchor: 0, focus: 0 });

    act(() => flushAnimationFrames());

    // The remote prefix is non-overlapping, so the human selection follows
    // the same "bravo" text rather than remaining at the old character index.
    expect(selectionOffsets(editable)).toEqual({ anchor: 20, focus: 25 });
  });

  test("keeps a backward rich-text selection backward when the browser supports it", () => {
    const view = render(<MarkdownEditor value="alpha bravo charlie" onChange={() => {}} />);
    const editor = view.getByTestId("mdx-editor");
    const editable = editor.querySelector<HTMLElement>("[contenteditable='true']")!;
    editable.focus();
    setSelectionByTextOffset(editable, 6, 11);
    window.getSelection()!.setBaseAndExtent(
      testSelection.focusNode!,
      testSelection.focusOffset,
      testSelection.anchorNode!,
      testSelection.anchorOffset,
    );
    expect(selectionOffsets(editable)).toEqual({ anchor: 11, focus: 6 });

    view.rerender(
      <MarkdownEditor value={"remote header\nalpha bravo charlie"} onChange={() => {}} />,
    );
    act(() => flushAnimationFrames());

    expect(selectionOffsets(editable)).toEqual({ anchor: 25, focus: 20 });
  });
});

describe("MarkdownEditor icon replacement", () => {
  // Regression guard for D355: the editor's icons must be our lucide-react
  // glyphs (supplied through MDXEditor's `iconComponentFor` prop), not the
  // bundled MDXEditor defaults. lucide renders `<svg class="lucide lucide-…">`.
  function classOf(node: ReturnType<typeof iconComponentFor>): string {
    const { container } = render(node);
    return container.querySelector("svg")?.getAttribute("class") ?? "";
  }

  test("maps the toolbar + table icon keys to lucide glyphs", () => {
    const keys = [
      "undo",
      "redo",
      "format_bold",
      "format_italic",
      "format_underlined",
      "format_list_bulleted",
      "format_list_numbered",
      "format_list_checked",
      "table",
      "link",
      "rich_text",
      "difference",
      "frame_source",
    ] as const;
    for (const key of keys) {
      expect(classOf(iconComponentFor(key))).toContain("lucide");
    }
  });

  test("both table delete keys render the trash glyph (the unreadable-icon bug)", () => {
    expect(classOf(iconComponentFor("delete_small"))).toContain("lucide-trash");
    expect(classOf(iconComponentFor("delete_big"))).toContain("lucide-trash");
  });

  test("a specific key maps to its expected glyph, not a shared default", () => {
    expect(classOf(iconComponentFor("format_bold"))).toContain("lucide-bold");
    expect(classOf(iconComponentFor("table"))).toContain("lucide-table");
  });

  test("falls back to a real glyph for an unmapped key", () => {
    expect(classOf(iconComponentFor("frontmatter"))).toContain("lucide-square");
  });
});

describe("MarkdownEditor icon theming (token-based, not hard-coded)", () => {
  // Regression guard for D355: icon color must come from the theme token system
  // and must NOT reintroduce the legacy SVG normalization that washed out the
  // lucide strokes (0.9 stroke) and filled their interiors (fill: currentColor).
  const workbenchRoot = join(import.meta.dir, "../..");
  const editorSrc = readFileSync(
    join(workbenchRoot, "src/editors/markdown-editor.tsx"),
    "utf8",
  );
  const css = readFileSync(join(workbenchRoot, "src/index.css"), "utf8");

  test("MarkdownEditor wires our icon map through the iconComponentFor prop", () => {
    expect(editorSrc).toContain("iconComponentFor={iconComponentFor}");
  });

  // Without codeMirrorPlugin, MDXEditor has no CodeBlock editor descriptor and
  // rejects every fenced code node on rich-text import (type:"code" parse error).
  test("registers codeMirrorPlugin so fenced code blocks can import", () => {
    expect(editorSrc).toContain("codeMirrorPlugin({");
    expect(editorSrc).toContain("codeBlockPlugin({ defaultCodeBlockLanguage: \"txt\" })");
  });

  test("exposes InsertCodeBlock and a focused-block language picker in the toolbar", () => {
    expect(editorSrc).toContain("<InsertCodeBlock />");
    expect(editorSrc).toContain("<ChangeCodeMirrorLanguage />");
    expect(editorSrc).toContain('editor?.editorType === "codeblock"');
  });

  test("resting icon color is driven by the --foreground token", () => {
    expect(css).toMatch(
      /\.nautilo-mdx-editor button svg,[\s\S]*?color:\s*var\(--foreground\);/,
    );
  });

  test("active toggles use --primary, disabled uses --foreground-disabled", () => {
    expect(css).toContain('.nautilo-mdx-editor button[data-state="on"] svg');
    expect(css).toMatch(/data-state="on"\] svg[\s\S]*?color:\s*var\(--primary\);/);
    expect(css).toMatch(/:disabled svg[\s\S]*?color:\s*var\(--foreground-disabled\);/);
  });

  test("does not reintroduce the icon-mangling normalization", () => {
    expect(css).not.toContain("stroke-width: 0.9");
  });
});
