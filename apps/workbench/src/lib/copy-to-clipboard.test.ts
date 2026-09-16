import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { copyTextToClipboard, copyTextViaHiddenTextarea } from "./copy-to-clipboard";

let happyWindow: Window;
const priorGlobals: Record<string, unknown> = {};

beforeAll(() => {
  happyWindow = new Window({ url: "http://127.0.0.1:3001/" });
  for (const k of ["window", "document", "navigator"] as const) {
    priorGlobals[k] = (globalThis as Record<string, unknown>)[k];
  }
  Object.assign(globalThis, {
    window: happyWindow,
    document: happyWindow.document,
    navigator: happyWindow.navigator,
  });
});

afterEach(() => {
  // Restore the happy-dom navigator between tests that override it.
  (globalThis as Record<string, unknown>).navigator = happyWindow.navigator;
});

afterAll(() => {
  const g = globalThis as Record<string, unknown>;
  for (const key of Object.keys(priorGlobals)) {
    if (priorGlobals[key] === undefined) delete g[key];
    else g[key] = priorGlobals[key];
  }
});

describe("copyTextToClipboard", () => {
  test("empty text is a no-op that returns false", async () => {
    let called = false;
    (globalThis as Record<string, unknown>).navigator = {
      clipboard: {
        writeText: async () => {
          called = true;
        },
      },
    };
    expect(await copyTextToClipboard("")).toBe(false);
    expect(called).toBe(false);
  });

  test("uses navigator.clipboard.writeText when available", async () => {
    let written: string | null = null;
    (globalThis as Record<string, unknown>).navigator = {
      clipboard: {
        writeText: async (t: string) => {
          written = t;
        },
      },
    };
    expect(await copyTextToClipboard("hello world")).toBe(true);
    expect(written).toBe("hello world");
  });

  test("falls back to hidden textarea when writeText rejects", async () => {
    (globalThis as Record<string, unknown>).navigator = {
      clipboard: {
        writeText: async () => {
          throw new Error("blocked in webview");
        },
      },
    };
    const origExec = happyWindow.document.execCommand;
    let execArg: string | null = null;
    happyWindow.document.execCommand = ((cmd: string) => {
      execArg = cmd;
      return true;
    }) as typeof happyWindow.document.execCommand;
    try {
      expect(await copyTextToClipboard("fallback text")).toBe(true);
      expect(execArg).toBe("copy");
    } finally {
      happyWindow.document.execCommand = origExec;
    }
  });
});

describe("copyTextViaHiddenTextarea", () => {
  test("returns false when execCommand throws", () => {
    const origExec = happyWindow.document.execCommand;
    happyWindow.document.execCommand = (() => {
      throw new Error("nope");
    }) as typeof happyWindow.document.execCommand;
    try {
      expect(copyTextViaHiddenTextarea("x")).toBe(false);
    } finally {
      happyWindow.document.execCommand = origExec;
    }
  });

  test("cleans up the textarea it appends", () => {
    const origExec = happyWindow.document.execCommand;
    happyWindow.document.execCommand = (() => true) as typeof happyWindow.document.execCommand;
    try {
      copyTextViaHiddenTextarea("x");
      expect(happyWindow.document.querySelector("textarea")).toBeNull();
    } finally {
      happyWindow.document.execCommand = origExec;
    }
  });
});
