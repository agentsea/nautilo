import { describe, expect, test } from "bun:test";
import { DynamicStructuredTool } from "@langchain/core/tools";
import { z } from "zod";
import { createProtectedTaskNodeSettlementScope } from
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
});
