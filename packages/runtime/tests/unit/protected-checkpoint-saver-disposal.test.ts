import { describe, expect, test } from "bun:test";

import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "@nautilo/agent";

import {
  disposeProtectedCheckpointSaver,
  type ProtectedCheckpointSaverDisposalReport,
} from "../../src/conversation/protected-checkpoint-saver-disposal";

function saverWithClose(
  close: () => Promise<void>,
): EncryptedCheckpointSaver {
  const serializer = new InlineCheckpointCellSerializer();
  return new EncryptedCheckpointSaver({
    operationStoreFactory: {
      serializer,
      schema: "langchain",
      create: () => {
        throw new Error("checkpoint operation is outside disposal test");
      },
      end: close,
    },
    crypto: {} as never,
    scope: {
      logicalThreadId: "room:room-1:bot:agent-1",
      namespaceId: "namespace-test-shadow",
      keyClass: "ai",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 1,
      authorizationSession: Object.freeze({ id: "session-test" }),
    },
  });
}

async function executeWithExecutorLifecycle<Value>(input: Readonly<{
  saver: EncryptedCheckpointSaver;
  execute(): Value | PromiseLike<Value>;
  report(report: ProtectedCheckpointSaverDisposalReport): void;
}>): Promise<Value> {
  let primaryErrorPresent = false;
  try {
    return await input.execute();
  } catch (error) {
    primaryErrorPresent = true;
    throw error;
  } finally {
    await disposeProtectedCheckpointSaver({
      saver: input.saver,
      primaryErrorPresent,
      report: input.report,
    });
  }
}

describe("protected checkpoint saver disposal", () => {
  test("does not turn successful durable execution into pool-close failure", async () => {
    const closeFailure = new Error("pool close failed");
    const reports: ProtectedCheckpointSaverDisposalReport[] = [];

    const value = await executeWithExecutorLifecycle({
      saver: saverWithClose(() => Promise.reject(closeFailure)),
      execute: () => "durable-success",
      report: (report) => reports.push(report),
    });

    expect(value).toBe("durable-success");
    expect(reports).toHaveLength(1);
    expect(reports[0]?.primaryErrorPresent).toBeFalse();
    expect(reports[0]?.close.status).toBe("close_failed");
    if (reports[0]?.close.status !== "close_failed") {
      throw new Error("expected typed close failure");
    }
    expect(reports[0].close.error.cause).toBe(closeFailure);
  });

  test("preserves the exact primary graph failure when cleanup also fails", async () => {
    const primaryFailure = new Error("graph failed");
    const closeFailure = new Error("pool close failed");
    const reports: ProtectedCheckpointSaverDisposalReport[] = [];

    try {
      await executeWithExecutorLifecycle({
        saver: saverWithClose(() => Promise.reject(closeFailure)),
        execute: () => {
          throw primaryFailure;
        },
        report: (report) => reports.push(report),
      });
      throw new Error("expected graph failure");
    } catch (error) {
      expect(error).toBe(primaryFailure);
    }
    expect(reports).toHaveLength(1);
    expect(reports[0]?.primaryErrorPresent).toBeTrue();
    expect(reports[0]?.close.status).toBe("close_failed");
  });

  test("observability failure cannot mask a successful result", async () => {
    const value = await executeWithExecutorLifecycle({
      saver: saverWithClose(() => Promise.resolve()),
      execute: () => "success",
      report: () => {
        throw new Error("reporter failed");
      },
    });

    expect(value).toBe("success");
  });

  test("defensively converts an unexpected throwing end implementation into a typed report", async () => {
    const saver = saverWithClose(() => Promise.resolve());
    const unexpected = new Error("unexpected end rejection");
    Object.defineProperty(saver, "end", {
      value: () => Promise.reject(unexpected),
    });

    const report = await disposeProtectedCheckpointSaver({
      saver,
      primaryErrorPresent: false,
      report: () => undefined,
    });

    expect(report.close.status).toBe("close_failed");
    if (report.close.status !== "close_failed") {
      throw new Error("expected typed close failure");
    }
    expect(report.close.error.cause).toBe(unexpected);
  });
});
