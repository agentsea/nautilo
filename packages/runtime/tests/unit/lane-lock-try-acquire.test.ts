import { describe, test, expect } from "bun:test";
import { InMemoryLaneLock, laneLock } from "../../src/lane-lock";

describe("LaneLock.tryAcquire", () => {
  test("free lane acquire + busy + release cycle", async () => {
    const lock = new InMemoryLaneLock();
    const r1 = await lock.tryAcquire("t:1");
    expect(r1.acquired).toBe(true);
    if (!r1.acquired) return;

    const r2 = await lock.tryAcquire("t:1");
    expect(r2.acquired).toBe(false);
    if (r2.acquired) return;

    await r1.release();

    const r3 = await lock.tryAcquire("t:1");
    expect(r3.acquired).toBe(true);
    if (!r3.acquired) return;
    await r3.release();
  });

  test("two tryAcquire on idle lane same turn — exactly one wins", async () => {
    const lock = new InMemoryLaneLock();
    const k = `race:${Date.now()}`;
    const p1 = lock.tryAcquire(k);
    const p2 = lock.tryAcquire(k);
    const [a, b] = await Promise.all([p1, p2]);
    const winners = [a, b].filter((x) => x.acquired);
    const losers = [a, b].filter((x) => !x.acquired);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(1);
    const w = winners[0]!;
    expect(w.acquired).toBe(true);
    if (!w.acquired) return;
    await w.release();
  });

  test("tryAcquire on different lane while one held → acquired true", async () => {
    const lock = new InMemoryLaneLock();
    const a = await lock.tryAcquire("lane:a");
    expect(a.acquired).toBe(true);
    if (!a.acquired) return;

    const b = await lock.tryAcquire("lane:b");
    expect(b.acquired).toBe(true);
    if (!b.acquired) return;

    await b.release();
    await a.release();
  });

  test("interleave acquire then tryAcquire busy then release", async () => {
    const lock = new InMemoryLaneLock();
    const k = `mix:${Date.now()}`;
    const rel = await lock.acquire(k);
    const t = await lock.tryAcquire(k);
    expect(t.acquired).toBe(false);
    await rel();
    const u = await lock.tryAcquire(k);
    expect(u.acquired).toBe(true);
    if (!u.acquired) return;
    await u.release();
  });

  test("singleton laneLock acquire suite unchanged (regression)", async () => {
    const release = await laneLock.acquire("try-acquire-regression");
    expect(typeof release).toBe("function");
    await release();
  });
});
