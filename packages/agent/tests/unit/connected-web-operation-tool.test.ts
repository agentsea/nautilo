import { afterEach, describe, expect, test } from "bun:test";
import {
  dispatchManageConnectedWebOperation,
} from "../../src/tools/connected-web-accounts/manage-connected-web-operation";
import { controlConnectedWebOperationToolSchema } from "../../src/tools/connected-web-accounts/control-connected-web-operation";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebOperationToolRuntime,
  type ConnectedWebAccountReadSuccess,
  type ConnectedWebOperationSafeProjection,
} from "../../src/tools/connected-web-accounts/runtime";

const OPERATION_ID = "77777777-7777-4777-8777-777777777777";
const ACCOUNT_ID = "88888888-8888-4888-8888-888888888888";

const context = {
  userId: "owner-1",
  agentId: "agent-1",
  roomId: "room-1",
  callingRoomId: null,
  memoryAccessEnvelope: {} as never,
  toolCallId: "tool-call-1",
  currentThreadId: "thread-1",
  turnId: "turn-1",
  laneKey: "room:room-1",
};

function terminalProjection(): ConnectedWebOperationSafeProjection & { result: ConnectedWebAccountReadSuccess } {
  return {
    operationId: OPERATION_ID,
    driver: "hosted",
    lifecycle: "terminal",
    controlEpoch: 2,
    activity: { phase: "finishing", code: "provider_terminal_verified", summary: "Connected website work finished." },
    receipt: { outcome: "completed", code: "provider_completed", summary: "Connected website work completed." },
    result: {
      ok: true,
      status: "completed",
      account: { id: ACCOUNT_ID, label: "Example", service: "example", origin: "https://example.com" },
      page: { ref: ACCOUNT_ID, title: "Example", origin: "https://example.com" },
      read: {
        answer: "The requested answer.",
        facts: [{ label: "Status", value: "Ready" }],
        completeness: "complete",
        provenance: "authenticated_website",
        origin: "https://example.com",
      },
      cost: { currency: "USD", amountUsd: 0.01, state: "actual" },
      outputs: [],
      outputsTruncated: false,
    },
  };
}

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

describe("manage_connected_web_operation terminal read projection", () => {
  test("returns the exact bounded completed read only from inspect", async () => {
    setConnectedWebOperationToolRuntime({
      manage: async (_actor, input) => ({ ok: true, accepted: input.operation, operation: terminalProjection() }),
    });

    const raw = await dispatchManageConnectedWebOperation({
      operation: "inspect",
      operationId: OPERATION_ID,
      expectedControlEpoch: 2,
    }, context);

    expect(JSON.parse(raw)).toMatchObject({
      ok: true,
      accepted: "inspect",
      operation: {
        operationId: OPERATION_ID,
        result: { status: "completed", read: { answer: "The requested answer." } },
      },
    });
    expect(raw).not.toMatch(/runRef|sessionId|liveViewUrl|cdpUrl/iu);
  });

  test("rejects a terminal result outside the canonical account and fact bounds", async () => {
    const invalid = terminalProjection();
    const result = invalid.result;
    if (result.account === null) throw new Error("Expected private fixture");
    setConnectedWebOperationToolRuntime({
      manage: async (_actor, input) => ({
        ok: true,
        accepted: input.operation,
        operation: {
          ...invalid,
          result: {
            ...result,
            account: { ...result.account, service: "s".repeat(129) },
            read: { ...result.read!, facts: [{ label: "Status", value: "v".repeat(1_025) }] },
          },
        },
      }),
    });

    expect(JSON.parse(await dispatchManageConnectedWebOperation({
      operation: "inspect",
      operationId: OPERATION_ID,
      expectedControlEpoch: 2,
    }, context))).toEqual({ ok: false, code: "invalid_result", recovery: "none" });
  });
});

test("D568 direct command schema accepts only semantic snapshot refs and no page HTML", () => {
  const base = { operationId: OPERATION_ID, expectedControlEpoch: 2 };
  expect(controlConnectedWebOperationToolSchema.safeParse({ ...base, command: { kind: "click", ref: "e12" } }).success).toBe(true);
  expect(controlConnectedWebOperationToolSchema.safeParse({ ...base, command: { kind: "click", ref: "#submit" } }).success).toBe(false);
  expect(controlConnectedWebOperationToolSchema.safeParse({ ...base, command: { kind: "get", what: "html" } }).success).toBe(false);
  expect(controlConnectedWebOperationToolSchema.safeParse({ ...base, command: { kind: "get", what: "attr", ref: "@e2" } }).success).toBe(false);
});
