import { afterEach, describe, expect, test } from "bun:test";
import {
  clearAppSourceEventListenersForTests,
  publishAppSourceEvent,
  subscribeAppSourceEvents,
} from "../../src/apps/app-source-events";

afterEach(() => {
  clearAppSourceEventListenersForTests();
});

describe("app-source-events", () => {
  test("subscribe receives published events", () => {
    const received: unknown[] = [];
    const unsubscribe = subscribeAppSourceEvents((event) => {
      received.push(event);
    });

    publishAppSourceEvent({ type: "changed", appId: "test-canvas", sourceHash: "abc" });
    expect(received).toEqual([{ type: "changed", appId: "test-canvas", sourceHash: "abc" }]);

    unsubscribe();
    publishAppSourceEvent({ type: "status", appId: "test-canvas", status: "needs_dependencies" });
    expect(received).toHaveLength(1);
  });

  test("unsubscribe cleans up listener", () => {
    let count = 0;
    const unsubscribe = subscribeAppSourceEvents(() => {
      count += 1;
    });
    unsubscribe();
    publishAppSourceEvent({ type: "changed", appId: "test-canvas", sourceHash: "abc" });
    expect(count).toBe(0);
  });
});
