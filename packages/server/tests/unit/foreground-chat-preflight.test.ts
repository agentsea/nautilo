import { describe, expect, test } from "bun:test";
import type { getDefaultModel } from "@nautilo/agent";
import { resolveForegroundChatPreflightFunding } from "../../src/lib/foreground-chat-preflight";

describe("foreground auxiliary preflight model selection", () => {
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
      defaultModel: () => ({ id: "openai:default" } as ReturnType<typeof getDefaultModel>),
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
});
