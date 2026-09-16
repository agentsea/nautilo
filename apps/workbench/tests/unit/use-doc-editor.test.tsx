import { reapplyHappyDomGlobals } from "../bun-dom-preload";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { LoadEditableTextResult, SaveEditableTextResult } from "../../src/editors/editor-io";
import {
  AUTOSAVE_DEBOUNCE_MS,
  AUTOSAVE_STORAGE_KEY,
  getAutosaveEnabled,
  setAutosaveEnabled,
  useDocEditor,
} from "../../src/editors/use-doc-editor";

type PendingTimer = { fn: () => void; delay: number };

let pendingTimers: PendingTimer[] = [];
let realSetTimeout: typeof setTimeout | undefined;
let realClearTimeout: typeof clearTimeout | undefined;

function flushTimers() {
  const batch = pendingTimers.splice(0);
  for (const { fn } of batch) {
    fn();
  }
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  pendingTimers = [];
  realSetTimeout = globalThis.setTimeout;
  realClearTimeout = globalThis.clearTimeout;
  reapplyHappyDomGlobals();
  globalThis.localStorage.clear();

  globalThis.setTimeout = ((fn: () => void, delay?: number) => {
    pendingTimers.push({ fn, delay: delay ?? 0 });
    return pendingTimers.length as unknown as ReturnType<typeof setTimeout>;
  }) as typeof setTimeout;

  globalThis.clearTimeout = ((id: ReturnType<typeof setTimeout>) => {
    const index = Number(id) - 1;
    if (index >= 0 && index < pendingTimers.length) {
      pendingTimers.splice(index, 1);
    }
  }) as typeof clearTimeout;
});

afterEach(() => {
  if (realSetTimeout) globalThis.setTimeout = realSetTimeout;
  if (realClearTimeout) globalThis.clearTimeout = realClearTimeout;
  pendingTimers = [];
});

function readyLoad(content: string): LoadEditableTextResult {
  return {
    kind: "ready",
    content,
    baseSha256: `sha-${content}`,
    baseRevision: 2,
  };
}

describe("autosave storage helpers", () => {
  test("defaults autosave to ON when storage is empty", () => {
    expect(getAutosaveEnabled()).toBe(true);
  });

  test("persists autosave OFF in localStorage", () => {
    setAutosaveEnabled(false);
    expect(globalThis.localStorage.getItem(AUTOSAVE_STORAGE_KEY)).toBe("off");
    expect(getAutosaveEnabled()).toBe(false);
    setAutosaveEnabled(true);
    expect(getAutosaveEnabled()).toBe(true);
  });
});

describe("useDocEditor", () => {
  test("debounced persist when autosave is ON uses checkpoint on first dirty only", async () => {
    const save = mock(
      async (
        _content: string,
        _base: { sha256: string | null; revision: number | null },
        checkpoint: boolean,
      ): Promise<SaveEditableTextResult> => ({
        kind: "saved",
        newSha256: "sha-new",
        revision: 3,
      }),
    );

    const { result } = renderHook(() =>
      useDocEditor({
        initialContent: "hello",
        baseSha256: "sha-base",
        baseRevision: 1,
        save,
      }),
    );

    act(() => {
      result.current.setDraftFromEditor("hello!");
    });

    expect(save).toHaveBeenCalledTimes(0);
    expect(result.current.dirty).toBe(true);

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2]).toBe(true);
    expect(typeof save.mock.calls[0]?.[3]?.clientMutationId).toBe("string");

    act(() => {
      result.current.setDraftFromEditor("hello!!");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1]?.[2]).toBe(false);
    expect(typeof save.mock.calls[1]?.[3]?.clientMutationId).toBe("string");
  });

  test("autosave OFF marks unsaved and explicit save uses checkpoint", async () => {
    const save = mock(
      async (): Promise<SaveEditableTextResult> => ({
        kind: "saved",
        newSha256: "sha-new",
      }),
    );

    const { result } = renderHook(() =>
      useDocEditor({
        initialContent: "hello",
        baseSha256: "sha-base",
        baseRevision: null,
        save,
      }),
    );

    act(() => {
      result.current.setAutosaveEnabled(false);
      result.current.setDraftFromEditor("changed");
    });

    expect(result.current.status).toBe("unsaved");
    expect(save).toHaveBeenCalledTimes(0);

    await act(async () => {
      await result.current.saveNow({ checkpoint: true });
      await flushPromises();
    });

    expect(save).toHaveBeenCalledTimes(1);
    expect(save.mock.calls[0]?.[2]).toBe(true);
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe("saved");
  });

  test("late save completion does not clear dirty for a newer draft", async () => {
    let resolveSave: ((value: SaveEditableTextResult) => void) | undefined;
    const save = mock(
      (): Promise<SaveEditableTextResult> =>
        new Promise((resolve) => {
          resolveSave = resolve;
        }),
    );

    const { result } = renderHook(() =>
      useDocEditor({
        initialContent: "hello",
        baseSha256: "sha-base",
        baseRevision: null,
        save,
      }),
    );

    act(() => {
      result.current.setDraftFromEditor("first edit");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(save).toHaveBeenCalledTimes(1);

    act(() => {
      result.current.setDraftFromEditor("second edit");
    });

    expect(result.current.dirty).toBe(true);

    await act(async () => {
      resolveSave?.({ kind: "saved", newSha256: "sha-stale" });
      await flushPromises();
    });

    expect(result.current.dirty).toBe(true);
    expect(result.current.status).not.toBe("saved");
  });

  test("conflict stays sticky until keepMine or takeTheirs", async () => {
    const save = mock(
      async (
        _content: string,
        base: { sha256: string | null; revision: number | null },
        _checkpoint: boolean,
      ): Promise<SaveEditableTextResult> => {
        if (base.sha256 === null && base.revision === null) {
          return { kind: "saved", newSha256: "sha-forced", revision: 5 };
        }
        return { kind: "conflict", currentSha256: "sha-remote" };
      },
    );

    const loadLatest = mock(async (): Promise<LoadEditableTextResult> =>
      readyLoad("server version"),
    );

    const { result } = renderHook(() =>
      useDocEditor({
        initialContent: "mine",
        baseSha256: "sha-base",
        baseRevision: 1,
        save,
        loadLatest,
      }),
    );

    act(() => {
      result.current.setDraftFromEditor("mine edited");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.status).toBe("conflict");
    expect(loadLatest).toHaveBeenCalledTimes(1);
    expect(result.current.conflict?.latestContent).toBe("server version");

    act(() => {
      result.current.setDraftFromEditor("still editing during conflict");
    });

    expect(result.current.status).toBe("conflict");

    act(() => {
      result.current.takeTheirs();
    });

    expect(result.current.draft).toBe("server version");
    expect(result.current.conflict).toBeNull();
    expect(result.current.dirty).toBe(false);
    expect(result.current.status).toBe("idle");

    act(() => {
      result.current.setDraftFromEditor("another edit");
    });

    await act(async () => {
      flushTimers();
      await flushPromises();
    });

    expect(result.current.status).toBe("conflict");

    await act(async () => {
      await result.current.keepMine();
      await flushPromises();
    });

    expect(result.current.status).toBe("saved");
    expect(save.mock.calls.at(-1)?.[1]).toEqual({ sha256: null, revision: null });
    expect(save.mock.calls.at(-1)?.[2]).toBe(true);
  });

  test("saveNow uses debounce constant and successful save clears dirty", async () => {
    const save = mock(
      async (): Promise<SaveEditableTextResult> => ({
        kind: "saved",
        newSha256: "sha-new",
        revision: 4,
      }),
    );

    const { result } = renderHook(() =>
      useDocEditor({
        initialContent: "start",
        baseSha256: "sha-base",
        baseRevision: 1,
        save,
      }),
    );

    act(() => {
      result.current.setDraftFromEditor("updated");
    });

    expect(pendingTimers[0]?.delay).toBe(AUTOSAVE_DEBOUNCE_MS);

    await act(async () => {
      await result.current.saveNow({ checkpoint: true });
      await flushPromises();
    });

    expect(result.current.status).toBe("saved");
    expect(result.current.dirty).toBe(false);
    expect(result.current.lastSavedAt).not.toBeNull();
  });
});
