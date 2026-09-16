import { afterEach, describe, expect, test } from "bun:test";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  createManageConnectedWebOperationTool,
  dispatchManageConnectedWebOperation,
  manageConnectedWebOperationToolSchema,
  resolveManageConnectedWebOperationActor,
  type ManageConnectedWebOperationToolContext,
} from "./manage-connected-web-operation";
import {
  resetConnectedWebAccountReadToolRuntimeForTests,
  setConnectedWebOperationToolRuntime,
  type ConnectedWebOperationToolInput,
} from "./runtime";

const OWNER = "00000000-0000-4000-8000-000000000571";
const AGENT = "00000000-0000-4000-8000-000000000572";
const ROOM = "00000000-0000-4000-8000-000000000573";
const NAMESPACE = "00000000-0000-4000-8000-000000000574";
const OPERATION = "00000000-0000-4000-8000-000000000575";

function context(input: Partial<ManageConnectedWebOperationToolContext> = {}): ManageConnectedWebOperationToolContext {
  const memoryAccessEnvelope: MemoryAccessEnvelope = {
    ownerId: OWNER,
    actorId: OWNER,
    agentId: AGENT,
    roomId: ROOM,
    readableNamespaces: [NAMESPACE],
    mutableNamespaces: [NAMESPACE],
    writableNamespaces: [NAMESPACE],
    toolPolicy: {},
  };
  return {
    userId: OWNER,
    agentId: AGENT,
    roomId: ROOM,
    callingRoomId: null,
    memoryAccessEnvelope,
    toolCallId: "tool-call-d568",
    currentThreadId: "thread-d568",
    turnId: "turn-d568",
    laneKey: "room:lane-d568",
    ...input,
  };
}

function operationResult(input: ConnectedWebOperationToolInput) {
  return {
    ok: true as const,
    accepted: input.operation,
    operation: {
      operationId: input.operationId,
      driver: "hosted" as const,
      lifecycle: "running" as const,
      controlEpoch: input.expectedControlEpoch,
      activity: { phase: "working" as const, code: "progress", summary: "Reviewing the connected website." },
      receipt: null,
      result: null,
    },
  };
}

afterEach(() => resetConnectedWebAccountReadToolRuntimeForTests());

describe("manage_connected_web_operation", () => {
  test("inspect carries a sanitized paged action ledger and accepts its earlier-page cursor", async () => {
    const args = { operation: "inspect" as const, operationId: OPERATION, expectedControlEpoch: 1, activityBefore: 26 };
    expect(manageConnectedWebOperationToolSchema.safeParse(args).success).toBe(true);
    const activityLog = { entries: [{ id: 1, occurredAt: "2026-09-04T15:00:00.000Z", source: "browser_agent" as const, status: "completed" as const, summary: "Inspect billing navigation" }], before: null, hasMore: false };
    setConnectedWebOperationToolRuntime({ manage: async (_actor, input) => {
      expect(input).toEqual(args);
      const result = operationResult(input);
      return { ...result, operation: { ...result.operation, activityLog } };
    } });
    const inspected: unknown = JSON.parse(await dispatchManageConnectedWebOperation(args, context()));
    expect(inspected).toMatchObject({ operation: { activityLog } });
    setConnectedWebOperationToolRuntime({ manage: async (_actor, input) => {
      const result = operationResult(input);
      return { ...result, operation: { ...result.operation, activityLog: { ...activityLog, entries: [{ ...activityLog.entries[0]!, summary: "Open https://live.browser-use.com/private" }] } } };
    } });
    const rejected: unknown = JSON.parse(await dispatchManageConnectedWebOperation(args, context()));
    expect(rejected).toMatchObject({ code: "invalid_result" });
  });

  test("uses a strict discriminated control schema", () => {
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "inspect", operationId: OPERATION, expectedControlEpoch: 1,
    }).success).toBe(true);
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "steer", operationId: OPERATION, expectedControlEpoch: 1,
    }).success).toBe(false);
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "inspect", operationId: OPERATION, expectedControlEpoch: 1, instruction: "do this",
    }).success).toBe(false);
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "check_later", operationId: OPERATION, expectedControlEpoch: 1,
      dueAt: "not-a-date",
    }).success).toBe(false);
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "check_later", operationId: OPERATION, expectedControlEpoch: 1,
      dueAt: "2026-09-04T12:00:00.000Z", checkCondition: "The result is ready.",
    }).success).toBe(false);
    expect(manageConnectedWebOperationToolSchema.safeParse({
      operation: "steer", operationId: OPERATION, expectedControlEpoch: 1,
      instruction: "😀".repeat(1_025),
    }).success).toBe(false);
  });

  test("fails closed without the exact trusted foreground delivery context or runtime", async () => {
    const args = { operation: "inspect" as const, operationId: OPERATION, expectedControlEpoch: 1 };
    expect(resolveManageConnectedWebOperationActor(context({ turnId: "" }))).toBeNull();
    expect(await dispatchManageConnectedWebOperation(args, context({ turnId: "" }))).toBe(
      JSON.stringify({ ok: false, code: "unavailable", recovery: "none" }),
    );
    expect(await dispatchManageConnectedWebOperation(args, context())).toBe(
      JSON.stringify({ ok: false, code: "unavailable", recovery: "none" }),
    );
  });

  test("passes only trusted actor context and returns the narrow safe projection", async () => {
    let capturedActor: unknown;
    let capturedInput: unknown;
    setConnectedWebOperationToolRuntime({
      async manage(actor, input) {
        capturedActor = actor;
        capturedInput = input;
        return operationResult(input);
      },
    });
    const result = JSON.parse(await createManageConnectedWebOperationTool(context()).invoke({
      operation: "steer", operationId: OPERATION, expectedControlEpoch: 4, instruction: "Compare the two available options.",
    })) as Record<string, unknown>;

    expect(capturedActor).toEqual(expect.objectContaining({
      userId: OWNER, agentId: AGENT, roomId: ROOM, callingRoomId: null,
      toolCallId: "tool-call-d568", currentThreadId: "thread-d568", turnId: "turn-d568", laneKey: "room:lane-d568",
    }));
    expect(capturedInput).toEqual({
      operation: "steer", operationId: OPERATION, expectedControlEpoch: 4, instruction: "Compare the two available options.",
    });
    expect(result).toEqual({
      ok: true,
      accepted: "steer",
      operation: {
        operationId: OPERATION,
        driver: "hosted",
        lifecycle: "running",
        controlEpoch: 4,
        activity: { phase: "working", code: "progress", summary: "Reviewing the connected website." },
        receipt: null,
        result: null,
      },
    });
  });

  test("rejects an invalid or coordinate-bearing server projection rather than leaking it", async () => {
    setConnectedWebOperationToolRuntime({
      async manage(inputActor, input) {
        void inputActor;
        return {
          ...operationResult(input),
          operation: {
            ...operationResult(input).operation,
            providerRunRef: "secret-run-reference",
          },
        } as never;
      },
    });
    const result = await dispatchManageConnectedWebOperation(
      { operation: "inspect", operationId: OPERATION, expectedControlEpoch: 1 },
      context(),
    );
    expect(result).toBe(JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" }));
  });

  test("rejects an unrecognized failure envelope rather than projecting runtime text", async () => {
    setConnectedWebOperationToolRuntime({
      async manage() {
        return { ok: false, code: "wss://private-provider", recovery: "retry" } as never;
      },
    });
    const result = await dispatchManageConnectedWebOperation(
      { operation: "inspect", operationId: OPERATION, expectedControlEpoch: 1 },
      context(),
    );
    expect(result).toBe(JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" }));
  });

  test("admits every explicit management verb without an agent-side wait loop", async () => {
    const seen: ConnectedWebOperationToolInput[] = [];
    setConnectedWebOperationToolRuntime({
      async manage(actor, input) {
        expect(actor.toolCallId).toBe("tool-call-d568");
        seen.push(input);
        return operationResult(input);
      },
    });
    const inputs: ConnectedWebOperationToolInput[] = [
      { operation: "inspect", operationId: OPERATION, expectedControlEpoch: 1 },
      { operation: "continue", operationId: OPERATION, expectedControlEpoch: 1 },
      { operation: "check_later", operationId: OPERATION, expectedControlEpoch: 1, dueAt: "2026-09-04T12:00:00.000Z" },
      { operation: "steer", operationId: OPERATION, expectedControlEpoch: 1, instruction: "Prioritize the requested comparison." },
      { operation: "take_control", operationId: OPERATION, expectedControlEpoch: 1 },
      { operation: "release_control", operationId: OPERATION, expectedControlEpoch: 1 },
      { operation: "stop", operationId: OPERATION, expectedControlEpoch: 1 },
    ];
    for (const input of inputs) {
      const result = JSON.parse(await dispatchManageConnectedWebOperation(input, context())) as { ok: boolean; accepted?: string };
      expect(result.ok).toBe(true);
      expect(result.accepted).toBe(input.operation);
    }
    expect(seen).toEqual(inputs);
  });
});
