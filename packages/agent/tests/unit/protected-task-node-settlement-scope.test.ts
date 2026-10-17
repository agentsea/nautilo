import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import {
  createProtectedTaskCheckpointPauseController,
  createProtectedTaskNodeSettlementScope,
  isProtectedTaskCheckpointPauseInterruption,
} from
  "../../src/graph/protected-task-node-settlement-scope";

describe("protected Task graph node settlement scope", () => {
  test("closes admission synchronously and waits for every admitted body", async () => {
    const scope = createProtectedTaskNodeSettlementScope();
    const body = Promise.withResolvers<string>();
    let lateBodyStarted = false;

    const admitted = scope.run("agent", () => body.promise);
    const closing = scope.closeAndWait();
    const late = scope.run("post_model", () => {
      lateBodyStarted = true;
      return "late";
    });
    await late.catch((error: unknown) => {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain(
        "started after settlement closed",
      );
    });
    expect(lateBodyStarted).toBe(false);

    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    body.resolve("done");
    expect(await admitted).toBe("done");
    await closing;
    expect(closed).toBe(true);
    await scope.closeAndWait();
  });

  test("waits for a real tool handler that ignores cancellation", async () => {
    const controller = new AbortController();
    const scope = createProtectedTaskNodeSettlementScope(controller.signal);
    const handlerStarted = Promise.withResolvers<void>();
    const releaseHandler = Promise.withResolvers<void>();
    const deferredTool = new DynamicStructuredTool({
      name: "deferred_test_tool",
      description: "Test-only deferred handler",
      schema: z.object({}).strict(),
      func: async () => {
        handlerStarted.resolve();
        await releaseHandler.promise;
        return "finished";
      },
    });

    const invocation = scope.run("tools", () =>
      deferredTool.invoke({}, { signal: controller.signal }),
    );
    await handlerStarted.promise;
    controller.abort();

    const closing = scope.closeAndWait();
    let closed = false;
    void closing.then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);

    releaseHandler.resolve();
    expect(await invocation).toBe("finished");
    await closing;
    expect(closed).toBe(true);
  });

  test("rejects a pause before the node body starts", async () => {
    const pause = createProtectedTaskCheckpointPauseController();
    const scope = createProtectedTaskNodeSettlementScope(undefined, pause);
    let bodyCalls = 0;

    expect(pause.request("manual_pause")).toBe(true);
    const failure = await scope.run("agent", () => {
      bodyCalls += 1;
      return "not reached";
    }).catch((error: unknown) => error);

    expect(bodyCalls).toBe(0);
    expect(isProtectedTaskCheckpointPauseInterruption(failure)).toBe(true);
    expect(isProtectedTaskCheckpointPauseInterruption(Object.assign(
      new Error("Protected Task checkpoint pause requested"),
      { reason: "manual_pause" },
    ))).toBe(false);
    if (isProtectedTaskCheckpointPauseInterruption(failure)) {
      expect(failure.reason).toBe("manual_pause");
      Object.defineProperty(failure, "pregelTaskId", {
        value: "node-task-1",
      });
      expect(Reflect.get(failure, "pregelTaskId")).toBe("node-task-1");
      expect(isProtectedTaskCheckpointPauseInterruption(failure)).toBe(true);
      expect(Reflect.set(failure, "reason", "grant_refresh")).toBe(false);
      expect(failure.reason).toBe("manual_pause");
    }
    await scope.closeAndWait();
  });

  test("drains an admitted body while refusing the next body on pause", async () => {
    const pause = createProtectedTaskCheckpointPauseController();
    const scope = createProtectedTaskNodeSettlementScope(undefined, pause);
    const release = Promise.withResolvers<string>();
    let nextBodyCalls = 0;

    const admitted = scope.run("tools", () => release.promise);
    expect(pause.request("time_limit")).toBe(true);
    const nextFailure = await scope.run("agent", () => {
      nextBodyCalls += 1;
      return "not reached";
    }).catch((error: unknown) => error);
    expect(nextBodyCalls).toBe(0);
    expect(isProtectedTaskCheckpointPauseInterruption(nextFailure)).toBe(true);

    const draining = scope.closeAndWait();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);

    release.resolve("settled");
    expect(await admitted).toBe("settled");
    await draining;
    expect(drained).toBe(true);
  });

  test("drains independently settling parallel admitted bodies", async () => {
    const pause = createProtectedTaskCheckpointPauseController();
    const scope = createProtectedTaskNodeSettlementScope(undefined, pause);
    const first = Promise.withResolvers<void>();
    const second = Promise.withResolvers<void>();
    const firstRun = scope.run("agent", () => first.promise);
    const secondRun = scope.run("tools", () => second.promise);

    pause.request("grant_refresh");
    const draining = scope.closeAndWait();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });

    first.resolve();
    await firstRun;
    await Promise.resolve();
    expect(drained).toBe(false);

    second.resolve();
    await secondRun;
    await draining;
    expect(drained).toBe(true);
  });

  test("retains the first consumer failure and rejects future node bodies", async () => {
    const scope = createProtectedTaskNodeSettlementScope();
    const release = Promise.withResolvers<void>();
    const admitted = scope.run("agent", () => release.promise);
    const firstFailure = new Error("protected transcript publication failed");
    const secondFailure = new Error("replacement failure");

    expect(scope.fail(firstFailure)).toBe(true);
    expect(scope.fail(secondFailure)).toBe(false);
    let lateBodyStarted = false;
    const rejected = scope.run("post_model", () => {
      lateBodyStarted = true;
    }).catch((error: unknown) => error);

    expect(await rejected).toBe(firstFailure);
    expect(lateBodyStarted).toBe(false);
    const draining = scope.closeAndWait();
    let drained = false;
    void draining.then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(drained).toBe(false);
    release.resolve();
    await admitted;
    await draining;
    expect(drained).toBe(true);
  });

  test("authorization abort wins over an already requested pause", async () => {
    const authorization = new AbortController();
    const pause = createProtectedTaskCheckpointPauseController();
    const scope = createProtectedTaskNodeSettlementScope(
      authorization.signal,
      pause,
    );
    const abortReason = new Error("authorization revoked");
    let bodyCalls = 0;

    pause.request("manual_pause");
    authorization.abort(abortReason);
    const failure = await scope.run("agent", () => {
      bodyCalls += 1;
    }).catch((error: unknown) => error);

    expect(failure).toBe(abortReason);
    expect(isProtectedTaskCheckpointPauseInterruption(failure)).toBe(false);
    expect(bodyCalls).toBe(0);
    await scope.closeAndWait();
  });

  test("authorization abort wins over a retained consumer failure", async () => {
    const authorization = new AbortController();
    const scope = createProtectedTaskNodeSettlementScope(
      authorization.signal,
    );
    const consumerFailure = new Error("protected transcript publication failed");
    const abortReason = new Error("authorization revoked");
    let bodyCalls = 0;

    expect(scope.fail(consumerFailure)).toBe(true);
    authorization.abort(abortReason);
    const failure = await scope.run("agent", () => {
      bodyCalls += 1;
    }).catch((error: unknown) => error);

    expect(failure).toBe(abortReason);
    expect(bodyCalls).toBe(0);
    await scope.closeAndWait();
  });

  test("retains the immutable first pause request", () => {
    const pause = createProtectedTaskCheckpointPauseController();

    expect(pause.currentRequestedReason()).toBeNull();
    expect(pause.request("grant_refresh")).toBe(true);
    expect(pause.currentRequestedReason()).toBe("grant_refresh");
    expect(pause.request("manual_pause")).toBe(false);
    expect(pause.request("grant_refresh")).toBe(false);
    expect(pause.currentRequestedReason()).toBe("grant_refresh");
    expect(() => pause.request("other" as never)).toThrow(TypeError);
    expect(pause.currentRequestedReason()).toBe("grant_refresh");
  });

  test("preserves the no-pause admission path", async () => {
    const pause = createProtectedTaskCheckpointPauseController();
    const scope = createProtectedTaskNodeSettlementScope(undefined, pause);
    let bodyCalls = 0;

    const result = await scope.run("agent", () => {
      bodyCalls += 1;
      return "completed";
    });
    expect(result).toBe("completed");
    expect(bodyCalls).toBe(1);
    expect(pause.currentRequestedReason()).toBeNull();
    await scope.closeAndWait();
  });
});
