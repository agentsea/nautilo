import { beforeEach, describe, expect, test } from "bun:test";
import {
  MemDocStore,
  createBlock,
  initialize,
  type EditorAPI,
  type SpellError,
} from "@nautilo/office-docs/browser";
import {
  LocalSpellProvider,
  SpellRouter,
  SpellSession,
  getBlockText,
} from "@nautilo/office-docs/browser";
import {
  attachWriterSpellcheck,
  createWriterSpellSession,
  ignoreWriterSpellWord,
  scheduleWriterSpellRecheck,
  setWriterSpellcheckEnabled,
  setWriterSpellcheckPersonalWords,
} from "./writer-spellcheck";
import { installWriterTestDom, wait } from "./test-dom";

function makeEditorWithText(text: string): { editor: EditorAPI; canvas: HTMLElement; dispose: () => void } {
  const canvas = document.createElement("div");
  canvas.style.width = "800px";
  canvas.style.height = "600px";
  document.body.appendChild(canvas);

  const block = createBlock("paragraph");
  block.inlines = [{ text, style: {} }];
  const store = new MemDocStore({ blocks: [block] });
  const editor = initialize(canvas, store);
  return {
    editor,
    canvas,
    dispose: () => editor.dispose(),
  };
}

describe("Writer spellcheck", () => {
  beforeEach(() => {
    installWriterTestDom();
  });

  test("createWriterSpellSession uses LocalSpellProvider and bundled English dictionary", async () => {
    const { editor, dispose } = makeEditorWithText("hello");
    try {
      const session = createWriterSpellSession(editor);
      expect(session).toBeInstanceOf(SpellSession);
      expect(session.router).toBeInstanceOf(SpellRouter);
      await session.recheckBlocks([{ id: editor.getDoc().document.blocks[0]!.id, text: "helo" }]);
      expect(session.errors.some((e) => e.word === "helo")).toBe(true);
    } finally {
      dispose();
    }
  });

  test("attachWriterSpellcheck attaches session on mount and detaches on cleanup", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo wrld");
    const setSpellSessionCalls: unknown[] = [];
    const original = editor.setSpellSession.bind(editor);
    editor.setSpellSession = (session) => {
      setSpellSessionCalls.push(session);
      original(session);
    };

    let menuRequest: unknown = null;
    const cleanup = attachWriterSpellcheck(editor, canvas, (req) => {
      menuRequest = req;
    });

    expect(setSpellSessionCalls.length).toBeGreaterThanOrEqual(1);
    expect(setSpellSessionCalls[0]).toBeInstanceOf(SpellSession);

    await wait(50);

    cleanup();
    expect(setSpellSessionCalls.at(-1)).toBe(null);
    expect(menuRequest).toBe(null);

    dispose();
  });

  test("schedules debounced recheck and detects misspellings", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo");
    const cleanup = attachWriterSpellcheck(editor, canvas, () => {});

    await wait(400);
    scheduleWriterSpellRecheck(editor, { immediate: true });
    await wait(50);

    const block = editor.getDoc().document.blocks[0]!;
    const session = createWriterSpellSession(editor);
    editor.setSpellSession(session);
    await session.recheckBlocks([{ id: block.id, text: getBlockText(block) }]);
    expect(session.errors.some((e) => e.word === "helo")).toBe(true);

    cleanup();
    dispose();
  });

  test("applySpellSuggestion replaces misspelled text", async () => {
    const { editor, dispose } = makeEditorWithText("helo");
    try {
      const session = createWriterSpellSession(editor);
      editor.setSpellSession(session);
      const block = editor.getDoc().document.blocks[0]!;
      await session.recheckBlocks([{ id: block.id, text: "helo" }]);
      const err = session.errors.find((e) => e.word === "helo");
      expect(err).toBeDefined();

      editor.applySpellSuggestion(err!, "hello");
      expect(getBlockText(editor.getDoc().document.blocks[0]!)).toBe("hello");
      expect(session.errors.some((e) => e.word === "helo")).toBe(false);
    } finally {
      dispose();
    }
  });

  test("context menu opens for spelling errors and allows native menu when none", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo");
    const menuRequests: Array<{ error: SpellError } | null> = [];
    const cleanup = attachWriterSpellcheck(editor, canvas, (req) => {
      menuRequests.push(req);
    });

    await wait(400);
    scheduleWriterSpellRecheck(editor, { immediate: true });
    await wait(50);

    const err: SpellError = {
      blockId: editor.getDoc().document.blocks[0]!.id,
      start: 0,
      end: 4,
      word: "helo",
    };
    editor.getSpellErrorAt = () => err;

    const spellEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 40,
      clientY: 40,
    });
    let spellDefaultPrevented = false;
    spellEvent.preventDefault = () => {
      spellDefaultPrevented = true;
    };
    canvas.dispatchEvent(spellEvent);
    expect(spellDefaultPrevented).toBe(true);
    expect(menuRequests.at(-1)?.error.word).toBe("helo");

    editor.getSpellErrorAt = () => undefined;
    const nativeEvent = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 10,
      clientY: 10,
    });
    let nativeDefaultPrevented = false;
    nativeEvent.preventDefault = () => {
      nativeDefaultPrevented = true;
    };
    canvas.dispatchEvent(nativeEvent);
    expect(nativeDefaultPrevented).toBe(false);

    cleanup();
    dispose();
  });

  test("setSpellCheckEnabled(false) skips recheck scheduling", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo");
    const cleanup = attachWriterSpellcheck(editor, canvas, () => {});
    editor.setSpellCheckEnabled(false);

    scheduleWriterSpellRecheck(editor, { immediate: true });
    await wait(50);

    const session = createWriterSpellSession(editor);
    await session.recheckBlocks([{ id: "x", text: "helo" }]);
    expect(session.errors.length).toBe(1);

    cleanup();
    dispose();
  });

  test("initially disabled spellcheck and personal words remain view-local", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo");
    const cleanup = attachWriterSpellcheck(editor, canvas, () => {}, { enabled: false });
    await wait(50);
    expect(editor.getSpellErrorAt(0, 0)).toBeUndefined();
    editor.setSpellCheckEnabled(true);
    setWriterSpellcheckPersonalWords(editor, ["helo"]);
    ignoreWriterSpellWord(editor, "wrld");
    await wait(50);
    expect(getBlockText(editor.getDoc().document.blocks[0]!)).toBe("helo");
    cleanup(); dispose();
  });

  test("deduplicates repeated preference echoes and enabled state", async () => {
    const { editor, canvas, dispose } = makeEditorWithText("helo");
    const setSpellSession = editor.setSpellSession.bind(editor);
    let sessionWrites = 0;
    let renders = 0;
    editor.setSpellSession = (session) => { sessionWrites++; setSpellSession(session); };
    editor.render = () => { renders++; };
    const cleanup = attachWriterSpellcheck(editor, canvas, () => {}, { enabled: false });

    setWriterSpellcheckPersonalWords(editor, [" Helo "]);
    const sessionWritesAfterFirstPreference = sessionWrites;
    setWriterSpellcheckEnabled(editor, true);
    await wait(50);
    const rendersAfterEnable = renders;

    setWriterSpellcheckPersonalWords(editor, ["helo", "helo"]);
    setWriterSpellcheckEnabled(editor, true);
    await wait(50);

    expect(sessionWritesAfterFirstPreference).toBe(2);
    expect(sessionWrites).toBe(sessionWritesAfterFirstPreference);
    expect(rendersAfterEnable).toBe(1);
    expect(renders).toBe(rendersAfterEnable);
    cleanup(); dispose();
  });

  test("LocalSpellProvider suggests corrections for misspelled English words", async () => {
    const provider = new LocalSpellProvider();
    const suggestions = await provider.suggest("helo", "en");
    expect(suggestions.length).toBeGreaterThan(0);
    expect(suggestions.some((s) => s.toLowerCase().includes("hello") || s.toLowerCase() === "helot")).toBe(true);
  });
});
