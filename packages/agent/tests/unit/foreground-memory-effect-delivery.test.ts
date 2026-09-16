import { afterEach, describe, expect, mock, test } from "bun:test";
import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  installAuthoredMemorySemanticChangeSink,
} from "../../src/store/authored-memory-semantic-change";
import {
  deliverForegroundMemoryMutationEffect,
  type CommittedForegroundMemoryEffectReceipt,
} from "../../src/store/foreground-memory-effect-delivery";

const receipt = Object.freeze({
  operationId: "foreground-memory:operation-1",
  memoryId: "00000000-0000-4000-8000-000000000001",
  changeKind: "replace",
  completion: "complete",
  acknowledgedAt: null,
}) satisfies CommittedForegroundMemoryEffectReceipt;

afterEach(() => {
  _resetAuthoredMemorySemanticChangeSinkForTests();
});

describe("foreground Memory effect delivery", () => {
  test("acknowledges only after stable semantic delivery", async () => {
    const calls: string[] = [];
    installAuthoredMemorySemanticChangeSink(async (change) => {
      calls.push(`deliver:${change.changeRef}`);
      expect(change).toEqual({
        memoryId: receipt.memoryId,
        changeKind: "replace",
        changeRef: `memory-change:stable:${receipt.operationId}`,
      });
    });
    const acknowledge = mock(async (value: unknown) => {
      calls.push("acknowledge");
      expect(value).toEqual({
        operationId: receipt.operationId,
        memoryId: receipt.memoryId,
        changeKind: "replace",
      });
      return "acknowledged" as const;
    });

    expect(await deliverForegroundMemoryMutationEffect({
      receipt,
      acknowledge,
    })).toBe("acknowledged");
    expect(calls).toEqual([
      `deliver:memory-change:stable:${receipt.operationId}`,
      "acknowledge",
    ]);
  });

  test("keeps the committed effect pending and retries the same identity", async () => {
    const delivered: string[] = [];
    let fail = true;
    installAuthoredMemorySemanticChangeSink(async (change) => {
      delivered.push(change.changeRef);
      if (fail) throw new Error("sink unavailable");
    });
    const acknowledge = mock(async () => "acknowledged" as const);

    expect(await deliverForegroundMemoryMutationEffect({
      receipt,
      acknowledge,
    })).toBe("pending");
    expect(acknowledge).not.toHaveBeenCalled();
    fail = false;
    expect(await deliverForegroundMemoryMutationEffect({
      receipt,
      acknowledge,
    })).toBe("acknowledged");
    expect(delivered).toEqual([
      `memory-change:stable:${receipt.operationId}`,
      `memory-change:stable:${receipt.operationId}`,
    ]);
  });

  test("keeps delivery pending when acknowledgement fails", async () => {
    const sink = mock(async () => {});
    installAuthoredMemorySemanticChangeSink(sink);

    expect(await deliverForegroundMemoryMutationEffect({
      receipt,
      acknowledge: async () => {
        throw new Error("receipt update failed");
      },
    })).toBe("pending");
    expect(sink).toHaveBeenCalledTimes(1);
  });

  test("does not redeliver an already acknowledged receipt", async () => {
    const sink = mock(async () => {});
    installAuthoredMemorySemanticChangeSink(sink);
    const acknowledge = mock(async () => "already_acknowledged" as const);

    expect(await deliverForegroundMemoryMutationEffect({
      receipt: { ...receipt, acknowledgedAt: new Date("2026-09-07T00:00:00Z") },
      acknowledge,
    })).toBe("acknowledged");
    expect(sink).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
  });
});
