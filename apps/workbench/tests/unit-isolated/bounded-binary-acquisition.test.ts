import { describe, expect, test } from "bun:test";
import {
  BinaryAcquisitionError,
  BoundedBinaryAcquisitionOwner,
  classifyBinaryAcquisitionError,
  type BinaryChunkSource,
} from "../../src/lib/bounded-binary-acquisition";

function chunksSource(
  chunks: readonly Uint8Array[],
  options: { knownSize?: number; failAfter?: number; onCancel?: () => void } = {},
): BinaryChunkSource {
  return {
    knownSize: options.knownSize,
    async *chunks() {
      for (let index = 0; index < chunks.length; index += 1) {
        if (options.failAfter === index) throw new Error("transport interrupted");
        yield chunks[index]!;
      }
      if (options.failAfter === chunks.length) throw new Error("transport interrupted");
    },
    cancel() {
      options.onCancel?.();
    },
  };
}

describe("bounded binary acquisition", () => {
  test("assembles known and unknown sources into one exact ArrayBuffer", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 16 });
    let cancelled = 0;
    const known = await owner.acquire(
      chunksSource([new Uint8Array([1, 2]), new Uint8Array([3])], {
        knownSize: 3,
        onCancel: () => {
          cancelled += 1;
        },
      }),
    );
    const unknown = await owner.acquire(
      chunksSource([new Uint8Array([4]), new Uint8Array([5, 6])]),
    );

    expect(known).toBeInstanceOf(ArrayBuffer);
    expect(known.byteLength).toBe(3);
    expect([...new Uint8Array(known)]).toEqual([1, 2, 3]);
    expect(unknown.byteLength).toBe(3);
    expect([...new Uint8Array(unknown)]).toEqual([4, 5, 6]);
    expect(cancelled).toBe(1);
  });

  test("returns an authority-owned direct buffer without copying or opening chunks", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 16 });
    const privateBytes = new Uint8Array([7, 8, 9]).buffer;
    let chunkOpened = false;
    const source: BinaryChunkSource = {
      knownSize: 3,
      async arrayBuffer() {
        return privateBytes;
      },
      async *chunks() {
        chunkOpened = true;
        yield new Uint8Array([0]);
      },
    };

    const acquired = await owner.acquire(source);
    expect(acquired).toBe(privateBytes);
    expect(chunkOpened).toBe(false);
  });

  test("preflights known oversize data before opening its chunk iterator", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 4 });
    let opened = false;
    const source: BinaryChunkSource = {
      knownSize: 5,
      async *chunks() {
        opened = true;
        yield new Uint8Array([1]);
      },
    };

    await expect(owner.acquire(source)).rejects.toMatchObject({
      name: "BinaryAcquisitionError",
      kind: "size",
    });
    expect(opened).toBe(false);
  });

  test("rejects unknown-size data that grows beyond the budget and closes the source", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 3 });
    let cancelled = false;
    await expect(
      owner.acquire(
        chunksSource([new Uint8Array([1, 2]), new Uint8Array([3, 4])], {
          onCancel: () => {
            cancelled = true;
          },
        }),
      ),
    ).rejects.toMatchObject({ name: "BinaryAcquisitionError", kind: "size" });
    expect(cancelled).toBe(true);
  });

  test("detects a truncated known-size transfer and maps source authorization failures", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 8 });
    await expect(
      owner.acquire(chunksSource([new Uint8Array([1, 2])], { knownSize: 3 })),
    ).rejects.toMatchObject({ name: "BinaryAcquisitionError", kind: "acquisition" });

    const unauthorized: BinaryChunkSource = {
      async *chunks() {
        throw { status: 403 };
      },
    };
    await expect(owner.acquire(unauthorized)).rejects.toMatchObject({
      name: "BinaryAcquisitionError",
      kind: "authorization",
    });
    expect(classifyBinaryAcquisitionError({ status: 401 }).kind).toBe("authorization");
    expect(classifyBinaryAcquisitionError({ code: "size" }).kind).toBe("size");
  });

  test("caller cancellation and timeout both close a pending source", async () => {
    const caller = new AbortController();
    let releaseCaller: (() => void) | undefined;
    let callerCancelled = false;
    const pendingSource: BinaryChunkSource = {
      async *chunks(signal) {
        await new Promise<void>((resolve) => {
          releaseCaller = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        throw new DOMException("cancelled", "AbortError");
      },
      cancel() {
        callerCancelled = true;
        releaseCaller?.();
      },
    };
    const owner = new BoundedBinaryAcquisitionOwner();
    const cancelled = owner.acquire(pendingSource, { signal: caller.signal });
    await Promise.resolve();
    caller.abort();
    await expect(cancelled).rejects.toMatchObject({ kind: "cancelled" });
    expect(callerCancelled).toBe(true);

    let releaseTimeout: (() => void) | undefined;
    let timeoutCancelled = false;
    const timeoutSource: BinaryChunkSource = {
      async *chunks(signal) {
        await new Promise<void>((resolve) => {
          releaseTimeout = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        throw new DOMException("timed out", "AbortError");
      },
      cancel() {
        timeoutCancelled = true;
        releaseTimeout?.();
      },
    };
    await expect(owner.acquire(timeoutSource, { timeoutMs: 1 })).rejects.toMatchObject({
      name: "BinaryAcquisitionError",
      kind: "timeout",
    });
    expect(timeoutCancelled).toBe(true);

    let consumeObservedAbort = false;
    await expect(
      owner.acquireFor(
        chunksSource([new Uint8Array([1])]),
        async (_bytes, signal) => {
          await new Promise<void>((resolve) => {
            signal.addEventListener(
              "abort",
              () => {
                consumeObservedAbort = true;
                resolve();
              },
              { once: true },
            );
          });
          return "late";
        },
        { timeoutMs: 1 },
      ),
    ).rejects.toMatchObject({ kind: "timeout" });
    expect(consumeObservedAbort).toBe(true);
  });

  test("enforces one active acquisition per owner without retrying", async () => {
    let release: (() => void) | undefined;
    const source: BinaryChunkSource = {
      async *chunks(signal) {
        await new Promise<void>((resolve) => {
          release = resolve;
          signal.addEventListener("abort", resolve, { once: true });
        });
        yield new Uint8Array([1]);
      },
      cancel() {
        release?.();
      },
    };
    const owner = new BoundedBinaryAcquisitionOwner();
    const first = owner.acquire(source);
    await Promise.resolve();
    await expect(owner.acquire(chunksSource([new Uint8Array([2])]))).rejects.toMatchObject({
      kind: "acquisition",
    });
    release?.();
    await expect(first).resolves.toBeInstanceOf(ArrayBuffer);
  });

  test("acquireFor rejects an already-aborted caller before opening the source", async () => {
    const caller = new AbortController();
    caller.abort();
    let opened = false;
    let cancelled = false;
    const source: BinaryChunkSource = {
      async arrayBuffer() {
        opened = true;
        return new ArrayBuffer(0);
      },
      cancel() {
        cancelled = true;
      },
    };
    const owner = new BoundedBinaryAcquisitionOwner();
    await expect(owner.acquireFor(source, () => "unexpected", { signal: caller.signal })).rejects.toMatchObject({
      kind: "cancelled",
    });
    expect(opened).toBe(false);
    expect(cancelled).toBe(true);
  });

  test("rejects invalid owner limits with a bounded error at acquisition time", async () => {
    const owner = new BoundedBinaryAcquisitionOwner({ maxBytes: 8 });
    await expect(owner.acquire(chunksSource([new Uint8Array([1])]), { maxBytes: 9 })).rejects.toBeInstanceOf(
      BinaryAcquisitionError,
    );
  });
});
