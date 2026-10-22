import { afterAll, describe, expect, mock, test } from "bun:test";
import * as realTurnContext from "../../src/conversation/live-shadow-turn-context";
import * as realWakeContext from "../../src/tasks/protected-task-wake-foreground-context";
import * as realExternalExecution from "../../src/external-room-execution";
import * as realExternalInput from "../../src/executors/external-room-context";
import type { ProtectedConversationExecutionServices, ProtectedConversationExecutorTurnScope } from
  "../../src/conversation/conversation-execution-services";

const reachedWakeInput = new Error("Reached authenticated wake input boundary");
let externalTurn: ReturnType<typeof realExternalExecution.getCurrentExternalRoomExecution>;
let externalContext = false;
let wakeInputChecks = 0;
mock.module("../../src/conversation/live-shadow-turn-context", () => ({
  ...realTurnContext,
  getCurrentProtectedTaskWakeForegroundContext: () => ({}),
}));
mock.module("../../src/tasks/protected-task-wake-foreground-context", () => ({
  ...realWakeContext,
  assertProtectedTaskWakeForegroundJobInput: () => {
    wakeInputChecks += 1;
    throw reachedWakeInput;
  },
}));
mock.module("../../src/external-room-execution", () => ({
  ...realExternalExecution,
  getCurrentExternalRoomExecution: () => externalTurn,
}));
mock.module("../../src/executors/external-room-context", () => ({
  ...realExternalInput,
  externalRoomExecutionInput: async (input: Record<string, unknown>) => ({
    input, externalContext,
  }),
}));
const { langgraphExecutor } = await import("../../src/executors/langgraph-executor");
afterAll(() => {
  mock.module("../../src/conversation/live-shadow-turn-context", () => realTurnContext);
  mock.module("../../src/tasks/protected-task-wake-foreground-context", () => realWakeContext);
  mock.module("../../src/external-room-execution", () => realExternalExecution);
  mock.module("../../src/executors/external-room-context", () => realExternalInput);
});

describe("protected wake executor entry", () => {
  test("an absent external turn reaches the authenticated wake input check", async () => {
    externalTurn = undefined;
    externalContext = false;
    wakeInputChecks = 0;
    const execution = langgraphExecutor({}, "wake-job", null, new AbortController().signal);
    const failure: unknown = await execution.next().then(() => undefined, (error: unknown) => error);
    expect(failure).toBe(reachedWakeInput);
    expect(wakeInputChecks).toBe(1);
  });

  test.each(["external_turn", "external_room", "human_turn"] as const)(
    "refuses mixed %s custody before opening wake input", async kind => {
      externalTurn = kind === "external_turn"
        ? {} as NonNullable<typeof externalTurn> : undefined;
      externalContext = kind === "external_room";
      wakeInputChecks = 0;
      const execution = langgraphExecutor({}, "wake-job", null,
        new AbortController().signal,
        kind === "human_turn" ? {} as ProtectedConversationExecutionServices : undefined,
        kind === "human_turn" ? {} as ProtectedConversationExecutorTurnScope : undefined);
      const failure: unknown = await execution.next().then(() => undefined, (error: unknown) => error);
      expect(failure).toBeInstanceOf(TypeError);
      expect(failure).toMatchObject({ message: "Protected Task wake cannot borrow a Human turn scope" });
      expect(wakeInputChecks).toBe(0);
    },
  );
});
