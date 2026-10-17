import { afterAll, expect, mock, test } from "bun:test";
import type { ForegroundChatFundingAttempt, ForegroundChatFundingSession } from "@nautilo/agent";

const invoke = mock(async (..._args: unknown[]) => ({
  response: { content: "routed" },
  modelId: "openrouter:conductor",
}));

mock.module("@nautilo/agent", () => ({
  invokeChatModelWithFallback: invoke,
  resolveModelRole: (_role: string, options: { configuredId?: string }) =>
    options.configuredId ?? "openrouter:conductor",
  runWithUsageContext: async (_context: unknown, run: () => Promise<unknown>) => run(),
}));

const { createConductorModelInvoker } = await import("../../src/conductor/conductor-model");

afterAll(() => mock.restore());

test("Conductor provider calls retain the request-local payer session", async () => {
  const fundingSession: ForegroundChatFundingSession = {
    kind: "personal" as const,
    async runAttempt<T>(_modelId: string, callback: (attempt: ForegroundChatFundingAttempt) => Promise<T>) {
      return callback({
        usageFunding: {
          kind: "personal",
          humanUserId: "payer-human",
          payerHumanId: "payer-human",
          providerRoute: "openrouter",
          credentialId: "credential",
          credentialRevision: 1,
        },
      });
    },
    recheckAttempt: async () => undefined,
  };
  const invokeConductor = createConductorModelInvoker({
    modelId: "openrouter:conductor",
    userId: "payer-human",
    agentId: null,
    laneKey: "room:shared-room:conductor",
    fundingSession,
  });

  expect(await invokeConductor("choose a responder")).toBe("routed");
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(invoke.mock.calls[0]?.[7]).toMatchObject({
    fundingHumanUserId: "payer-human",
    fundingSession,
    reasoningOutput: false,
  });
});
