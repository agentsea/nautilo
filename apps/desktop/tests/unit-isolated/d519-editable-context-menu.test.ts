import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildEditableContextMenuPolicy,
  type EditableContextMenuInput,
} from "../../electron/editable-context-menu-policy";

const editableFlags = {
  canUndo: true,
  canRedo: false,
  canCut: true,
  canCopy: true,
  canPaste: false,
  canDelete: true,
  canSelectAll: true,
};

function input(overrides: Partial<EditableContextMenuInput> = {}): EditableContextMenuInput {
  return {
    isEditable: true,
    selectionText: "",
    mediaType: "none",
    linkURL: "",
    misspelledWord: "initataivme",
    dictionarySuggestions: ["initiative", "initiated"],
    editFlags: editableFlags,
    frameAvailable: true,
    platform: "win32",
    ...overrides,
  };
}

describe("D519 pure editable native-menu policy", () => {
  test("orders suggestions, Learn, capability-derived edits, and compact separators", () => {
    const menu = buildEditableContextMenuPolicy(input());

    expect(menu).toEqual([
      { kind: "suggestion", replacement: "initiative" },
      { kind: "suggestion", replacement: "initiated" },
      { kind: "learn", word: "initataivme" },
      { kind: "separator" },
      { kind: "edit", action: "undo", enabled: true },
      { kind: "edit", action: "redo", enabled: false },
      { kind: "edit", action: "cut", enabled: true },
      { kind: "edit", action: "copy", enabled: true },
      { kind: "edit", action: "paste", enabled: false },
      { kind: "edit", action: "delete", enabled: true },
      { kind: "edit", action: "selectAll", enabled: true },
    ]);
    expect(menu[0]?.kind).not.toBe("separator");
    expect(menu.at(-1)?.kind).not.toBe("separator");
  });

  test("owns only ordinary editable text or an ordinary text selection", () => {
    expect(buildEditableContextMenuPolicy(input({ frameAvailable: false }))).toEqual([]);
    expect(buildEditableContextMenuPolicy(input({ mediaType: "canvas" }))).toEqual([]);
    expect(buildEditableContextMenuPolicy(input({ mediaType: "image" }))).toEqual([]);
    expect(buildEditableContextMenuPolicy(input({ linkURL: "https://nautilo.ai" }))).toEqual([]);
    expect(
      buildEditableContextMenuPolicy(
        input({
          isEditable: false,
          selectionText: "",
          misspelledWord: "",
          dictionarySuggestions: [],
        }),
      ),
    ).toEqual([]);

    expect(
      buildEditableContextMenuPolicy(
        input({
          isEditable: false,
          selectionText: "selected transcript text",
          misspelledWord: "",
          dictionarySuggestions: [],
        }),
      ),
    ).toEqual([
      { kind: "edit", action: "copy", enabled: true },
      { kind: "edit", action: "selectAll", enabled: true },
    ]);
  });

  test("does not explicitly add macOS text-service roles", () => {
    const mac = buildEditableContextMenuPolicy(input({ platform: "darwin" }));
    const nonMac = buildEditableContextMenuPolicy(input({ platform: "linux" }));

    expect(mac).toEqual(nonMac);
    expect(JSON.stringify(mac)).not.toContain('"mac-role"');
  });
});

const builtTemplates: unknown[][] = [];
const popupCalls: unknown[] = [];

mock.module("electron", () => ({
  Menu: {
    buildFromTemplate(template: unknown[]) {
      builtTemplates.push(template);
      return { popup: (options: unknown) => popupCalls.push(options) };
    },
  },
}));

const { attachEditableContextMenu } = await import("../../electron/editable-context-menu");

describe("D519 Electron editable-menu binding", () => {
  test("uses the originating contents, frame, and host window, then disposes on destruction", () => {
    builtTemplates.length = 0;
    popupCalls.length = 0;
    const listeners = new Map<string, (...args: any[]) => void>();
    const onceListeners = new Map<string, () => void>();
    const replacement: string[] = [];
    const learned: string[] = [];
    const frame = { isDestroyed: () => false, detached: false };
    const contents = {
      isDestroyed: () => false,
      on: (event: string, listener: (...args: any[]) => void) => listeners.set(event, listener),
      once: (event: string, listener: () => void) => onceListeners.set(event, listener),
      removeListener: (event: string) => listeners.delete(event),
      replaceMisspelling: (word: string) => replacement.push(word),
      session: { addWordToSpellCheckerDictionary: (word: string) => learned.push(word) },
    };
    const window = { isDestroyed: () => false };

    attachEditableContextMenu(contents as never, {
      getWindow: () => window as never,
      platform: "darwin",
    });
    listeners.get("context-menu")?.({}, {
      ...input({ platform: "darwin" }),
      x: 14,
      y: 20,
      frame,
      menuSourceType: "keyboard",
    });

    expect(builtTemplates).toHaveLength(1);
    expect(popupCalls).toEqual([
      expect.objectContaining({ window, frame, x: 14, y: 20, sourceType: "keyboard" }),
    ]);
    const template = builtTemplates[0] as Array<{ label?: string; click?: () => void }>;
    template.find((item) => item.label === "initiative")?.click?.();
    template.find((item) => item.label === "Learn Spelling")?.click?.();
    expect(replacement).toEqual(["initiative"]);
    expect(learned).toEqual(["initataivme"]);

    // A frame can detach while its native menu is open. Custom callbacks must
    // not redirect a replacement or dictionary mutation to a new document.
    frame.detached = true;
    template.find((item) => item.label === "initiative")?.click?.();
    template.find((item) => item.label === "Learn Spelling")?.click?.();
    expect(replacement).toEqual(["initiative"]);
    expect(learned).toEqual(["initataivme"]);

    onceListeners.get("destroyed")?.();
    expect(listeners.has("context-menu")).toBe(false);
  });

  test("does not build a menu from a null or detached frame", () => {
    builtTemplates.length = 0;
    const listeners = new Map<string, (...args: any[]) => void>();
    const contents = {
      isDestroyed: () => false,
      on: (event: string, listener: (...args: any[]) => void) => listeners.set(event, listener),
      once: () => undefined,
      removeListener: (event: string) => listeners.delete(event),
    };
    attachEditableContextMenu(contents as never, {
      getWindow: () => ({ isDestroyed: () => false }) as never,
      platform: "win32",
    });
    const base = { ...input(), x: 1, y: 2, menuSourceType: "mouse" };
    listeners.get("context-menu")?.({}, { ...base, frame: null });
    listeners.get("context-menu")?.({}, {
      ...base,
      frame: { isDestroyed: () => false, detached: true },
    });
    expect(builtTemplates).toEqual([]);
  });
});

describe("D519 Workbench view wiring", () => {
  test("keeps initial and shared server-view construction explicit and attached", () => {
    const desktopRoot = join(import.meta.dir, "../..");
    const main = readFileSync(join(desktopRoot, "electron/main.ts"), "utf8");
    const initial = main.slice(main.indexOf("function createWindow("), main.indexOf("function constructServerSessionView("));
    const shared = main.slice(main.indexOf("function constructServerSessionView("), main.indexOf("const boundCandidateSessionViews"));

    for (const source of [initial, shared]) {
      expect(source).toContain("spellcheck: true");
      expect(source).toContain("attachEditableContextMenu(view.webContents");
    }
    expect(shared).toContain("return constructServerSessionView(session, true, true)");
    expect(shared).toContain("return constructServerSessionView(session, false, false)");
  });
});
