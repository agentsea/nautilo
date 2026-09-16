import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { Window } from "happy-dom";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
const priorGlobals: Record<string, unknown> = {};
const listeners = new Map<string, () => void>();

const aui = {
  on(event: string, listener: () => void) {
    listeners.set(event, listener);
    return () => listeners.delete(event);
  },
  thread() {
    return { getState: () => ({ isRunning: false }) };
  },
  composer() {
    return {
      getState: () => ({ canCancel: false }),
      setText: () => undefined,
      send: () => undefined,
      cancel: () => undefined,
      __internal_getRuntime: () => undefined,
    };
  },
};

const mockAssistantStore = () => ({
  useAui: () => aui,
  useAuiState: (
    selector: (state: {
      thread: { isDisabled: boolean };
      composer: { dictation: undefined };
    }) => unknown,
  ) =>
    selector({
      thread: { isDisabled: false },
      composer: { dictation: undefined },
    }),
});

mock.module("@assistant-ui/store", mockAssistantStore);

// Bun can materialize a second root-level copy of this peer dependency. Mock
// the instance resolved by react-lexical as well so this isolated test does not
// depend on install order or node_modules topology.
mock.module(
  createRequire(import.meta.resolve("@assistant-ui/react-lexical")).resolve(
    "@assistant-ui/store",
  ),
  mockAssistantStore,
);

mock.module("@assistant-ui/react", () => ({
  ComposerPrimitive: {},
  INTERNAL: {
    useComposerInputPluginRegistryOptional: () => null,
  },
  unstable_useTriggerPopoverRootContextOptional: () => null,
}));

const { LexicalComposerInput } = await import("@assistant-ui/react-lexical");
const { MentionAwareLexicalComposerInput } = await import(
  "../../src/components/composer/MentionAdapter"
);

describe("LexicalComposerInput run-start focus policy", () => {
  beforeAll(() => {
    for (const key of [
      "window",
      "document",
      "navigator",
      "HTMLElement",
      "MutationObserver",
      "Node",
      "getComputedStyle",
    ] as const) {
      priorGlobals[key] = (globalThis as Record<string, unknown>)[key];
    }
    Object.assign(globalThis, {
      window: happyWindow,
      document: happyWindow.document,
      navigator: happyWindow.navigator,
      HTMLElement: happyWindow.HTMLElement,
      MutationObserver: happyWindow.MutationObserver,
      Node: happyWindow.Node,
      getComputedStyle: happyWindow.getComputedStyle.bind(happyWindow),
    });
  });

  beforeEach(() => {
    cleanup();
    listeners.clear();
    happyWindow.document.body.innerHTML = "";
  });

  afterAll(() => {
    cleanup();
    for (const [key, value] of Object.entries(priorGlobals)) {
      if (value === undefined) {
        delete (globalThis as Record<string, unknown>)[key];
      } else {
        (globalThis as Record<string, unknown>)[key] = value;
      }
    }
  });

  test("Nautilo run start preserves document focus, selection, and subsequent typing", async () => {
    const documentEditor = happyWindow.document.createElement("textarea");
    documentEditor.value = "hello world";
    documentEditor.setAttribute("aria-label", "Document editor");
    happyWindow.document.body.append(documentEditor);
    documentEditor.focus();
    documentEditor.setSelectionRange(5, 5);

    render(<MentionAwareLexicalComposerInput />);
    await act(async () => undefined);
    documentEditor.focus();
    documentEditor.setSelectionRange(5, 5);

    expect(listeners.has("thread.runStart")).toBeFalse();
    listeners.get("thread.runStart")?.();

    const caret = documentEditor.selectionStart;
    expect(caret).toBe(5);
    documentEditor.value =
      documentEditor.value.slice(0, caret) + "X" + documentEditor.value.slice(caret);
    documentEditor.setSelectionRange(caret + 1, caret + 1);
    documentEditor.dispatchEvent(new happyWindow.InputEvent("input", { bubbles: true }));

    expect(happyWindow.document.activeElement).toBe(documentEditor);
    expect(documentEditor.selectionStart).toBe(6);
    expect(documentEditor.selectionEnd).toBe(6);
    expect(documentEditor.value).toBe("helloX world");
  });

  test("retains the dependency's default run-start focus behavior", async () => {
    render(<LexicalComposerInput />);
    await act(async () => undefined);

    const runStartListener = listeners.get("thread.runStart");
    expect(runStartListener).toBeFunction();
    expect(() => runStartListener?.()).not.toThrow();
  });

  test("makes browser spellchecking explicit at the shared Composer boundary", async () => {
    const { container } = render(<MentionAwareLexicalComposerInput />);
    await act(async () => undefined);

    expect(container.querySelector(".aui-lexical-editor")?.getAttribute("spellcheck")).toBe(
      "true",
    );
  });

  test("preserves an intentional Composer spellcheck override", async () => {
    const { container } = render(<MentionAwareLexicalComposerInput spellCheck={false} />);
    await act(async () => undefined);

    expect(container.querySelector(".aui-lexical-editor")?.getAttribute("spellcheck")).toBe(
      "false",
    );
  });

  test("main Room and Subthread use the shared spellcheck boundary", () => {
    const workbenchRoot = join(import.meta.dir, "../..");
    const surfaces = [
      readFileSync(join(workbenchRoot, "src/components/conversation.tsx"), "utf8"),
      readFileSync(
        join(workbenchRoot, "src/modes/rooms/thread-drawer/surfaces/SubthreadSurface.tsx"),
        "utf8",
      ),
    ];

    for (const source of surfaces) {
      expect(source).toContain("<MentionAwareLexicalComposerInput");
      expect(source).not.toContain("spellCheck=");
    }
  });
});
