import { describe, expect, test } from "bun:test";

import { createReactTool } from "../../src/tools/social/react";

describe("react tool (M121)", () => {
  test("invalid emoji short-circuits before DB", async () => {
    const tool = createReactTool({
      roomId: "room-1",
      memoryAccessEnvelope: {
        agentId: "agent-1",
        ownerId: "user-1",
        roomId: "room-1",
      } as never,
    });
    const raw = await tool.invoke({ emoji: "\u0000", at: "2026-06-01T13:02:11Z" });
    expect(JSON.parse(String(raw))).toEqual({ ok: false, error: "invalid_emoji" });
  });

  test("missing agent envelope short-circuits before DB", async () => {
    const tool = createReactTool();
    const raw = await tool.invoke({ emoji: "🎉", at: "2026-06-01T13:02:11Z" });
    expect(JSON.parse(String(raw))).toEqual({ ok: false, error: "no_agent_in_envelope" });
  });
});
