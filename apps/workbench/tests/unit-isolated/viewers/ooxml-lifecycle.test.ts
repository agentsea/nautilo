import { describe, expect, mock, test } from "bun:test";
import { createOoxmlLoadOwner, destroyOnce } from "../../../src/viewers/ooxml/lifecycle";

describe("OOXML lifecycle ownership", () => {
  test("destroys a live viewer exactly once when invalidated repeatedly", async () => {
    const destroy = mock(() => {});
    const owner = createOoxmlLoadOwner();
    owner.run({ destroy }, async () => {}, { onReady: () => {}, onError: () => {} });
    await Promise.resolve();
    owner.invalidate();
    owner.invalidate();
    expect(destroy).toHaveBeenCalledTimes(1);
    const once = destroyOnce(destroy);
    once(); once();
    expect(destroy).toHaveBeenCalledTimes(2);
  });

  test("suppresses stale success and destroys its viewer", async () => {
    let resolve!: () => void;
    const destroy = mock(() => {});
    const ready = mock(() => {});
    const owner = createOoxmlLoadOwner();
    owner.run(
      { destroy },
      () => new Promise<void>((settle) => { resolve = settle; }),
      { onReady: ready, onError: () => {} },
    );
    owner.invalidate();
    resolve();
    await Promise.resolve();
    expect(ready).not.toHaveBeenCalled();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  test("host total timeout invalidates generation and suppresses a late success", async () => {
    let resolve!: () => void;
    const destroy = mock(() => {});
    const error = mock(() => {});
    const owner = createOoxmlLoadOwner(1);
    owner.run(
      { destroy },
      () => new Promise<void>((done) => { resolve = done; }),
      { onReady: () => {}, onError: error },
    );
    await new Promise((done) => setTimeout(done, 8));
    resolve();
    await Promise.resolve();
    expect(error).toHaveBeenCalledWith("Document preview timed out.");
    expect(destroy).toHaveBeenCalledTimes(1);
    expect(owner.generation).toBeGreaterThan(1);
  });
});
