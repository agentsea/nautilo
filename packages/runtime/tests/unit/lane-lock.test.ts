import { describe, test, expect } from "bun:test";
import { laneLock } from "../../src/lane-lock";

describe("LaneLock", () => {
  test("acquire returns a release function", async () => {
    const release = await laneLock.acquire("test:1");
    expect(typeof release).toBe("function");
    await release();
  });

  test("same key serializes access", async () => {
    const order: number[] = [];

    const r1 = await laneLock.acquire("serial:1");
    const p2 = laneLock.acquire("serial:1").then(async (r2) => {
      order.push(2);
      await r2();
    });

    order.push(1);
    await r1();
    await p2;

    expect(order).toEqual([1, 2]);
  });

  test("different keys run in parallel", async () => {
    const order: string[] = [];

    const r1 = await laneLock.acquire("parallel:a");
    const r2 = await laneLock.acquire("parallel:b");

    order.push("a");
    order.push("b");

    await r1();
    await r2();

    expect(order).toEqual(["a", "b"]);
  });
});
