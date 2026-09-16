import { describe, expect, test } from "bun:test";
import { NativeMiniAppLifecycleCoordinator } from "../../electron/native-mini-app-lifecycle";

describe("NativeMiniAppLifecycleCoordinator", () => {
  test("fences responses by both registered sender and request", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "renderer");
    const [result] = coordinator.begin("request-a", [7]);
    expect(coordinator.accept(8, "request-a", true)).toBe(false);
    expect(coordinator.accept(7, "request-b", true)).toBe(false);
    expect(coordinator.accept(7, "request-a", true)).toBe(true);
    expect(await result).toBe(true);
  });

  test("unregistering during a pending request fails closed", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "renderer");
    const [result] = coordinator.begin("request-a", [7]);
    coordinator.unregister(7);
    expect(await result).toBe(false);
    expect(coordinator.entries()).toEqual([]);
  });

  test("unregistering after an individual ready response invalidates the aggregate", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "first");
    coordinator.register(8, "second");
    const [first] = coordinator.begin("request-a", [7, 8]);
    const invalidated = coordinator.watchInvalidation("request-a", [7, 8]);
    coordinator.accept(7, "request-a", true);
    expect(await first).toBe(true);
    coordinator.unregister(7);
    await invalidated;
  });

  test("a newly registered renderer invalidates an in-flight target snapshot", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "first");
    const invalidated = coordinator.watchInvalidation("request-a", [7]);
    coordinator.register(8, "second");
    await invalidated;
    expect(coordinator.entries()).toEqual([[7, "first"], [8, "second"]]);
  });

  test("an aggregate ready response can still be invalidated before completion", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "first");
    const [ready] = coordinator.begin("request-a", [7]);
    let invalidatedDuringPreparation = false;
    const invalidated = coordinator.watchInvalidation("request-a", [7]).then(() => {
      invalidatedDuringPreparation = true;
    });

    coordinator.accept(7, "request-a", true);
    expect(await ready).toBe(true);
    coordinator.register(8, "late renderer");
    await invalidated;

    expect(invalidatedDuringPreparation).toBe(true);
  });

  test("cancellation releases only the matching request", async () => {
    const coordinator = new NativeMiniAppLifecycleCoordinator<string>();
    coordinator.register(7, "first");
    coordinator.register(8, "second");
    const [first, second] = coordinator.begin("request-a", [7, 8]);
    coordinator.cancel("request-b");
    expect(coordinator.accept(7, "request-a", true)).toBe(true);
    coordinator.cancel("request-a");
    expect(await first).toBe(true);
    expect(await second).toBe(false);
  });
});
