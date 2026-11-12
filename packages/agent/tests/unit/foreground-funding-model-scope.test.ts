import { describe, expect, test } from "bun:test";
import {
  readMindSwapperConnection,
  withMindSwapperModels,
  type MindSwapperChatModel,
} from "../../src/config/mindswapper-models";
import { getModelTokenLimit, resolveModelExecutionLimits } from "../../src/providers/models";
import {
  getForegroundFundingSession,
  runWithForegroundFundingSession,
  type ForegroundChatFundingSession,
} from "../../src/runtime/foreground-chat-funding";

const modelId = "mindswapper:maker/resumed-chat";

function model(input: number, output: number): MindSwapperChatModel {
  return {
    id: modelId, displayName: "Resumed chat",
    offers: [{ inputModalities: ["text"], supportedParameters: ["tools"], maxInputTokens: input, maxOutputTokens: output }],
  };
}

function session(row?: MindSwapperChatModel): ForegroundChatFundingSession {
  return {
    kind: "personal",
    ...(row ? { mindswapperModels: [row] } : {}),
    async runAttempt() { throw new Error("Context preparation must not dispatch a provider attempt"); },
    async recheckAttempt() {},
  };
}

describe("restored foreground funding model context", () => {
  test("keeps asynchronous context budgets isolated for concurrent restored operations", async () => {
    const first = session(model(500, 50));
    const second = session(model(800, 40));
    const limits = await Promise.all([first, second].map((funding) =>
      runWithForegroundFundingSession(funding, async () => {
        await Promise.resolve();
        expect(getForegroundFundingSession()).toBe(funding);
        expect(readMindSwapperConnection()).toBeUndefined();
        const contextTokens = getModelTokenLimit(modelId);
        const execution = await resolveModelExecutionLimits(modelId);
        return { contextTokens, input: execution.maxInputTokens, output: execution.maxOutputTokens };
      }),
    ));
    expect(limits).toEqual([
      { contextTokens: 550, input: 500, output: 50 },
      { contextTokens: 840, input: 800, output: 40 },
    ]);
    expect(getForegroundFundingSession()).toBeUndefined();
    expect(() => getModelTokenLimit(modelId)).toThrow("unavailable through the current MindSwapper connection");
  });

  test("does not inherit another operation's catalogue when funding is absent or has no projection", () => {
    const outer = session(model(500, 50));
    runWithForegroundFundingSession(outer, () => {
      expect(getModelTokenLimit(modelId)).toBe(550);
      for (const funding of [null, session()]) {
        withMindSwapperModels([model(900, 90)], () => {
          runWithForegroundFundingSession(funding, () => {
            expect(getForegroundFundingSession()).toBe(funding ?? undefined);
            expect(() => getModelTokenLimit(modelId)).toThrow("unavailable through the current MindSwapper connection");
          });
        });
      }
      expect(getModelTokenLimit(modelId)).toBe(550);
      expect(getForegroundFundingSession()).toBe(outer);
    });
  });
});
