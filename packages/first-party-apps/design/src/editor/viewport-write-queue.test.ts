import { describe, expect, test } from "bun:test";
import { isArtifactStateUnavailable, ViewportWriteQueue } from "./viewport-write-queue";

describe("viewport state write queue", () => {
  test("coalesces rapid writes and serializes the newest value after an in-flight write", async () => {
    const writes: number[] = [];
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const queue = new ViewportWriteQueue(async (value: number) => {
      writes.push(value);
      if (value === 1) await first;
    }, 10_000);
    queue.schedule(1);
    const flushing = queue.flush();
    queue.schedule(2);
    queue.schedule(3);
    releaseFirst();
    await flushing;
    expect(writes).toEqual([1, 3]);
  });

  test("only caches the known artifact-only state boundary", () => {
    expect(isArtifactStateUnavailable(new Error("App state is only supported for workspace artifact documents."))).toBe(true);
    expect(isArtifactStateUnavailable(new Error("temporary bridge failure"))).toBe(false);
  });

  test("closing during an in-flight write drains the newest queued value", async () => {
    const writes: number[] = [];
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => { release = resolve; });
    const queue = new ViewportWriteQueue(async (value: number) => {
      writes.push(value);
      if (value === 1) await blocker;
    }, 10_000);
    queue.schedule(1);
    const flushing = queue.flush();
    queue.schedule(2);
    const closing = queue.closeAndFlush();
    release();
    await Promise.all([flushing, closing]);
    expect(writes).toEqual([1, 2]);
    queue.schedule(3);
    await queue.flush();
    expect(writes).toEqual([1, 2]);
  });
});
