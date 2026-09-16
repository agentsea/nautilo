import { describe, expect, mock, test } from "bun:test";
import { createOoxmlLoadOwner, destroyOnce } from "../src/ooxml/lifecycle";

describe("OOXML load ownership", () => {
  test("gives one parser clone to the live generation", async () => {
    const source = new Uint8Array([1, 2, 3]).buffer;
    const parserLoad = mock(async (_value: { destroy: () => void }, bytes: ArrayBuffer) => {
      new Uint8Array(bytes)[0] = 9;
    });
    const owner = createOoxmlLoadOwner({ timeoutMs: 100 });
    owner.runWithParserBytes(
      { destroy: () => {} },
      source,
      parserLoad,
      { onReady: () => {}, onError: () => {} },
    );
    await Promise.resolve();
    expect(parserLoad).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(source)).toEqual(new Uint8Array([1, 2, 3]));
  });

  test("clears a live timer and destroys exactly once on repeated invalidation", async () => {
    const destroy = mock(() => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 1 });
    owner.run(
      { destroy },
      () => new Promise<void>(() => {}),
      { onReady: () => {}, onError: () => {} },
    );
    owner.invalidate();
    owner.invalidate();
    await new Promise((done) => setTimeout(done, 8));
    expect(destroy).toHaveBeenCalledTimes(1);
    const once = destroyOnce(destroy);
    once();
    once();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  test("invalidates a timeout generation and suppresses late success", async () => {
    let resolve!: () => void;
    const destroy = mock(() => {});
    const ready = mock(() => {});
    const error = mock(() => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 1 });
    owner.run(
      { destroy },
      () => new Promise<void>((done) => { resolve = done; }),
      { onReady: ready, onError: error },
    );
    await new Promise((done) => setTimeout(done, 8));
    resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("Document preview timed out.");
    expect(ready).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("uses the host sanitizer once on load failure and cleans up", async () => {
    const destroy = mock(() => {});
    const error = mock(() => {});
    const owner = createOoxmlLoadOwner({
      timeoutMs: 100,
      sanitizeError: () => "Safe failure.",
    });
    owner.run(
      { destroy },
      async () => Promise.reject(new Error("private parser detail")),
      { onReady: () => {}, onError: error },
    );
    await new Promise((done) => setTimeout(done, 0));
    expect(error).toHaveBeenCalledWith("Safe failure.");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("sanitizes and cleans up a synchronous load throw", () => {
    const destroy = mock(() => {});
    const error = mock(() => {});
    const owner = createOoxmlLoadOwner({
      timeoutMs: 100,
      sanitizeError: () => "Safe failure.",
    });
    owner.run(
      { destroy },
      () => {
        throw new Error("private parser detail");
      },
      { onReady: () => {}, onError: error },
    );
    expect(error).toHaveBeenCalledWith("Safe failure.");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("sanitizes and cleans up a detached parser source", () => {
    const source = new Uint8Array([1]).buffer;
    structuredClone(source, { transfer: [source] });
    const destroy = mock(() => {});
    const load = mock(async () => {});
    const error = mock(() => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 100 });
    owner.runWithParserBytes(
      { destroy },
      source,
      load,
      { onReady: () => {}, onError: error },
    );
    expect(load).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Document preview failed.");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("rejects invalid host timeout values before creating an owner", () => {
    for (const timeoutMs of [0, -1, 1.5, Number.POSITIVE_INFINITY])
      expect(() => createOoxmlLoadOwner({ timeoutMs })).toThrow(RangeError);
  });

  test("aborting clears the timer and destroys the active viewer once", async () => {
    const controller = new AbortController();
    const destroy = mock(() => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 1, signal: controller.signal });
    owner.run(
      { destroy },
      () => new Promise<void>(() => {}),
      { onReady: () => {}, onError: () => {} },
    );
    controller.abort();
    await new Promise((done) => setTimeout(done, 8));
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("an abort permanently prevents later runs", () => {
    const controller = new AbortController();
    const destroy = mock(() => {});
    const load = mock(async () => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 100, signal: controller.signal });
    controller.abort();
    owner.run(
      { destroy },
      load,
      { onReady: () => {}, onError: () => {} },
    );
    expect(load).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("an already-aborted signal prevents a parser-byte run", () => {
    const controller = new AbortController();
    controller.abort();
    const destroy = mock(() => {});
    const load = mock(async () => {});
    const owner = createOoxmlLoadOwner({ timeoutMs: 100, signal: controller.signal });
    const generation = owner.runWithParserBytes(
      { destroy },
      new Uint8Array([1]).buffer,
      load,
      { onReady: () => {}, onError: () => {} },
    );
    expect(load).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(owner.generation).toBe(generation);
    expect(owner.isCurrent(generation)).toBe(false);
  });
});
