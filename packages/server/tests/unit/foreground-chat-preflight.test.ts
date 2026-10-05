import { describe, expect, test } from "bun:test";
import { getDefaultForegroundAgentModelId } from "@nautilo/agent";
import {
  DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS,
  resolveForegroundChatPreflightFunding,
} from "../../src/lib/foreground-chat-preflight";

describe("foreground auxiliary preflight model selection", () => {
  test("production uses the same Surplus-aware default resolver as the executors", () => {
    expect(DEFAULT_FOREGROUND_CHAT_PREFLIGHT_DEPS.defaultForegroundModelId)
      .toBe(getDefaultForegroundAgentModelId);
  });

  test.each([
    { turn: "openai:turn", room: "anthropic:room", profile: "openrouter:profile", expected: "openai:turn" },
    { turn: null, room: "anthropic:room", profile: "openrouter:profile", expected: "anthropic:room" },
    { turn: null, room: null, profile: "openrouter:profile", expected: "openrouter:profile" },
    { turn: null, room: null, profile: null, expected: "openai:default" },
  ])("uses executor precedence for $expected", async ({ turn, room, profile, expected }) => {
    const lookups: string[] = [];
    const result = await resolveForegroundChatPreflightFunding({
      humanUserId: "caller", roomId: "private-room", agentId: "own-genie", turnModelId: turn,
    }, {
      loadSnapshot: async (roomId, agentId, turnModelId) => {
        lookups.push(`${roomId}:${agentId}`);
        return {
          roomSelection: room ? { modelId: room } : null,
          agentSelection: profile ? { modelId: profile } : null,
          serverReasoningPolicy: null, turnModelId: turnModelId ?? null,
        };
      },
      getExecutionConfig: async (agentId) => {
        lookups.push(agentId);
        return { name: "Genie", defaultModel: profile, soulFile: null };
      },
      defaultForegroundModelId: () => "openai:default",
      resolveFunding: async (input) => {
        expect(input).toEqual({
          humanUserId: "caller", modelId: expected, workload: "foreground_text_chat",
        });
        return { ...input, kind: "server", providerRoute: "server-route" };
      },
    });
    expect(result.kind).toBe("server");
    expect(lookups).toEqual(["private-room:own-genie", "own-genie"]);
  });

  test("uses the executor's Surplus-aware foreground default before funding admission", async () => {
    const surplusOnlyDefault = "openrouter:openai/gpt-5.6-sol";
    let defaultReads = 0;
    const result = await resolveForegroundChatPreflightFunding({
      humanUserId: "caller", roomId: "private-room", agentId: "own-genie", turnModelId: null,
    }, {
      loadSnapshot: async () => ({
        roomSelection: null,
        agentSelection: null,
        serverReasoningPolicy: null,
        turnModelId: null,
      }),
      getExecutionConfig: async () => ({ name: "Genie", defaultModel: null, soulFile: null }),
      defaultForegroundModelId: () => {
        defaultReads += 1;
        return surplusOnlyDefault;
      },
      resolveFunding: async (input) => {
        expect(input).toEqual({
          humanUserId: "caller",
          modelId: surplusOnlyDefault,
          workload: "foreground_text_chat",
        });
        return { ...input, kind: "server", providerRoute: "surplus" };
      },
    });

    expect(defaultReads).toBe(1);
    expect(result).toMatchObject({ kind: "server", providerRoute: "surplus" });
  });
});
