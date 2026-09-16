import { describe, expect, test } from "bun:test";

import { recoverTargetScroll } from "./scroll-recovery";

describe("D470 target scroll recovery", () => {
  test("measures once, retries the rendered inverted-list index, then fails visibly", () => {
    const offsets: number[] = [];
    const indices: number[] = [];
    const scheduled: Array<() => void> = [];
    let failures = 0;
    const attempted = recoverTargetScroll({
      requestId: 7,
      attemptedRequestId: null,
      index: 12,
      averageItemLength: 44,
      scrollToOffset: (offset) => offsets.push(offset),
      scrollToIndex: (index) => indices.push(index),
      schedule: (run) => { scheduled.push(run); },
      fail: () => { failures += 1; },
    });
    expect(attempted).toBe(7);
    expect(offsets).toEqual([528]);
    scheduled[0]?.();
    expect(indices).toEqual([12]);
    recoverTargetScroll({
      requestId: 7,
      attemptedRequestId: attempted,
      index: 12,
      averageItemLength: 44,
      scrollToOffset: () => undefined,
      scrollToIndex: () => undefined,
      schedule: () => undefined,
      fail: () => { failures += 1; },
    });
    expect(failures).toBe(1);
  });

  test("reports a synchronous retry failure", () => {
    const scheduled: Array<() => void> = [];
    let failed = false;
    recoverTargetScroll({
      requestId: 1,
      attemptedRequestId: null,
      index: 2,
      averageItemLength: 50,
      scrollToOffset: () => undefined,
      scrollToIndex: () => { throw new Error("not measured"); },
      schedule: (run) => { scheduled.push(run); },
      fail: () => { failed = true; },
    });
    scheduled[0]?.();
    expect(failed).toBe(true);
  });
});
