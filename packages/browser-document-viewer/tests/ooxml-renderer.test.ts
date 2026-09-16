import { describe, expect, mock, test } from "bun:test";

import { renderOoxml } from "../src/ooxml/renderer";
import { createOoxmlByteSource } from "../src/ooxml/source";

const archivePreflight = { maxEntries: 0, maxDeclaredTotalUncompressedBytes: 0n, maxDeclaredPerEntryUncompressedBytes: 0n };
const SAFE_ERROR = "Document preview failed.";

function emptyZip(): ArrayBuffer {
  const bytes = new Uint8Array(22);
  new DataView(bytes.buffer).setUint32(0, 0x06054b50, true);
  return bytes.buffer;
}

function source(
  bytes = emptyZip(),
  signal = new AbortController().signal,
  deadlineAt = Date.now() + 1_000,
) {
  const result = createOoxmlByteSource({ bytes, signal, deadlineAt, archivePreflight });
  if (result.kind !== "ready") throw new Error("fixture source rejected");
  return result.source;
}

function options(overrides: Partial<Parameters<typeof renderOoxml<object, { destroy: () => void }>>[0]> = {}) {
  return {
    source: source(),
    host: {},
    sanitizeError: () => SAFE_ERROR,
    createViewer: () => ({ destroy: mock(() => {}) }),
    load: async () => {},
    onStatus: () => {},
    ...overrides,
  };
}

describe("format-neutral OOXML renderer", () => {
  test("hands one private parser clone to the injected viewer and reports ready", async () => {
    const master = emptyZip();
    const parserBytes: ArrayBuffer[] = [];
    const destroy = mock(() => {});
    const statuses: string[] = [];
    const renderer = renderOoxml({
      source: source(master), host: { id: "docx-host" }, sanitizeError: () => "safe",
      createViewer: () => ({ destroy }),
      load: async (_viewer, bytes) => { parserBytes.push(bytes); },
      onStatus: (status) => { statuses.push(status.kind); },
    });
    await expect(renderer.done).resolves.toEqual({ kind: "ready" });
    expect(statuses).toEqual(["loading", "ready"]);
    expect(parserBytes).toHaveLength(1);
    expect(parserBytes[0]).not.toBe(master);
    new Uint8Array(parserBytes[0]!)[0] = 9;
    expect(new Uint8Array(master)[0]).toBe(0x50);
    renderer.close();
    renderer.close();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("closes and destroys once on cancellation without allowing a later ready", async () => {
    let resolveLoad!: () => void;
    const pending = new Promise<void>((resolve) => { resolveLoad = resolve; });
    const destroy = mock(() => {});
    const statuses: string[] = [];
    const renderer = renderOoxml({
      source: source(), host: {}, sanitizeError: () => "safe",
      createViewer: () => ({ destroy }), load: async () => pending,
      onStatus: (status) => { statuses.push(status.kind); },
    });
    renderer.close();
    resolveLoad();
    await expect(renderer.done).resolves.toEqual({ kind: "closed" });
    await Promise.resolve();
    expect(statuses).toEqual(["loading", "closed"]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("times out an active future-deadline load once without allowing late ready", async () => {
    let resolveLoad!: () => void;
    const pending = new Promise<void>((resolve) => { resolveLoad = resolve; });
    const destroy = mock(() => {});
    const statuses: string[] = [];
    const renderer = renderOoxml({
      ...options({ source: source(emptyZip(), new AbortController().signal, Date.now() + 25) }),
      createViewer: () => ({ destroy }), load: async () => pending,
      onStatus: (status) => { statuses.push(status.kind); },
    });
    await expect(renderer.done).resolves.toEqual({ kind: "error", message: "Document preview timed out." });
    resolveLoad();
    await Promise.resolve();
    expect(statuses).toEqual(["loading", "error"]);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("fails safely when an injected viewer reports an error before load completion", async () => {
    let fail!: (error: unknown) => void;
    const destroy = mock(() => {});
    const renderer = renderOoxml({
      source: source(), host: {}, sanitizeError: () => "Document preview failed.",
      createViewer: (context) => { fail = context.fail; return { destroy }; },
      load: async () => { fail(new Error("private parser path")); },
      onStatus: () => {},
    });
    await expect(renderer.done).resolves.toEqual({ kind: "error", message: "Document preview failed." });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("does not construct a viewer after the source deadline has elapsed", async () => {
    const createViewer = mock(() => ({ destroy: mock(() => {}) }));
    const renderer = renderOoxml({
      source: source(emptyZip(), new AbortController().signal, Date.now() - 1), host: {}, sanitizeError: () => "safe", createViewer,
      load: async () => {}, onStatus: () => {},
    });
    await expect(renderer.done).resolves.toEqual({ kind: "error", message: "Document preview timed out." });
    expect(createViewer).not.toHaveBeenCalled();
  });

  test("turns a throwing loading observer into a safe terminal error before construction", async () => {
    const createViewer = mock(() => ({ destroy: mock(() => {}) }));
    const renderer = renderOoxml({
      ...options({ createViewer, onStatus: () => { throw new Error("observer"); } }),
    });
    await expect(renderer.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });
    expect(createViewer).not.toHaveBeenCalled();
  });

  test("turns a throwing ready observer into a safe terminal error and destroys once", async () => {
    const destroy = mock(() => {});
    const renderer = renderOoxml({
      ...options({
        createViewer: () => ({ destroy }),
        onStatus: (status) => { if (status.kind === "ready") throw new Error("observer"); },
      }),
    });
    await expect(renderer.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("contains sanitizer and viewer-construction failures", async () => {
    const createRenderer = renderOoxml({
      ...options({
        sanitizeError: () => { throw new Error("unsafe sanitizer"); },
        createViewer: () => { throw new Error("private construction"); },
      }),
    });
    await expect(createRenderer.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });

    const rejectedRenderer = renderOoxml({
      ...options({
        sanitizeError: () => { throw new Error("unsafe sanitizer"); },
        load: () => Promise.reject(new Error("private load")),
      }),
    });
    await expect(rejectedRenderer.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });
  });

  test("contains synchronous and rejected loads without a late ready", async () => {
    const syncDestroy = mock(() => {});
    const sync = renderOoxml({
      ...options({ createViewer: () => ({ destroy: syncDestroy }), load: () => { throw new Error("sync load"); } }),
    });
    await expect(sync.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });
    expect(syncDestroy).toHaveBeenCalledTimes(1);

    const rejectedDestroy = mock(() => {});
    const rejected = renderOoxml({
      ...options({
        createViewer: () => ({ destroy: rejectedDestroy }),
        load: () => Promise.reject(new Error("rejected load")),
      }),
    });
    await expect(rejected.done).resolves.toEqual({ kind: "error", message: SAFE_ERROR });
    expect(rejectedDestroy).toHaveBeenCalledTimes(1);
  });

  test("replaces only the current host owner while independent hosts remain live", async () => {
    const host = {};
    let resolveFirst!: () => void;
    const firstPending = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const firstDestroy = mock(() => {});
    const secondDestroy = mock(() => {});
    const thirdDestroy = mock(() => {});
    const first = renderOoxml({
      ...options({ host, createViewer: () => ({ destroy: firstDestroy }), load: async () => firstPending }),
    });
    const second = renderOoxml({
      ...options({ host, createViewer: () => ({ destroy: secondDestroy }) }),
    });
    const third = renderOoxml({
      ...options({ host: {}, createViewer: () => ({ destroy: thirdDestroy }) }),
    });
    await expect(first.done).resolves.toEqual({ kind: "closed" });
    await expect(second.done).resolves.toEqual({ kind: "ready" });
    await expect(third.done).resolves.toEqual({ kind: "ready" });
    resolveFirst();
    await Promise.resolve();
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(secondDestroy).not.toHaveBeenCalled();
    expect(thirdDestroy).not.toHaveBeenCalled();
    second.close();
    third.close();
  });

  test("leaves a reentrant same-host winner in control when a prior close observer starts it", async () => {
    const host = {};
    const firstDestroy = mock(() => {});
    const contenderCreate = mock(() => ({ destroy: mock(() => {}) }));
    const winnerDestroy = mock(() => {});
    let winner: ReturnType<typeof renderOoxml> | undefined;
    const first = renderOoxml({
      ...options({
        host,
        createViewer: () => ({ destroy: firstDestroy }),
        load: async () => new Promise<void>(() => {}),
        onStatus: (status) => {
          if (status.kind !== "closed") return;
          winner = renderOoxml({
            ...options({ host, createViewer: () => ({ destroy: winnerDestroy }) }),
          });
        },
      }),
    });
    const contender = renderOoxml({
      ...options({ host, createViewer: contenderCreate }),
    });
    await expect(first.done).resolves.toEqual({ kind: "closed" });
    await expect(contender.done).resolves.toEqual({ kind: "closed" });
    expect(winner).toBeDefined();
    await expect(winner!.done).resolves.toEqual({ kind: "ready" });
    expect(firstDestroy).toHaveBeenCalledTimes(1);
    expect(contenderCreate).not.toHaveBeenCalled();
    winner!.close();
    expect(winnerDestroy).toHaveBeenCalledTimes(1);
  });
});
