import { describe, expect, it, afterEach } from "bun:test";
import {
  buildPresenceStrip,
  MAX_VISIBLE_PRESENCE_CHIPS,
  resetAgentStreamingVisibleOutputForTests,
  setAgentStreamingVisibleOutput,
  getAgentStreamingVisibleOutputSnapshot,
  subscribeAgentStreamingVisibleOutput,
} from "../presence-typing-strip-model";
import type { TypingOther } from "../use-typing-others";

function human(userId: string, displayName: string): TypingOther {
  return { userId, displayName, lastPingAt: 0 };
}

afterEach(() => {
  resetAgentStreamingVisibleOutputForTests();
});

describe("buildPresenceStrip (D278 §8.3 model C, D313)", () => {
  it("renders nothing when agent idle and nobody typing", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: false,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [],
    });
    expect(visible).toHaveLength(0);
    expect(overflow).toBe(0);
  });

  it("shows the bot chip during the pre-first-token dead air", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [],
    });
    expect(visible).toEqual([{ key: "agent", kind: "agent", label: "Jeannie" }]);
    expect(overflow).toBe(0);
  });

  it("hides the bot chip while visible text is actively streaming", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: true,
      assistantName: "Jeannie",
      others: [],
    });
    expect(visible).toHaveLength(0);
    expect(overflow).toBe(0);
  });

  it("shows the bot chip again in inter-message quiet gaps (D313)", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [],
    });
    expect(visible).toEqual([{ key: "agent", kind: "agent", label: "Jeannie" }]);
    expect(overflow).toBe(0);
  });

  it("keeps human chips even while the bot is streaming", () => {
    const { visible } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: true,
      assistantName: "Jeannie",
      others: [human("u1", "Maya")],
    });
    expect(visible).toEqual([{ key: "human:u1", kind: "human", label: "Maya" }]);
  });

  it("shows a single human chip when one person types", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: false,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [human("u1", "Maya")],
    });
    expect(visible).toHaveLength(1);
    expect(visible[0]).toMatchObject({ kind: "human", label: "Maya" });
    expect(overflow).toBe(0);
  });

  it("sorts the bot chip first, then humans (pre-stream)", () => {
    const { visible } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [human("u1", "Maya")],
    });
    expect(visible.map((c) => c.kind)).toEqual(["agent", "human"]);
  });

  it("collapses 3+ actors to the first two chips + overflow", () => {
    const { visible, overflow } = buildPresenceStrip({
      agentRunning: true,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [human("u1", "Maya"), human("u2", "Alex"), human("u3", "Nova")],
    });
    expect(visible).toHaveLength(MAX_VISIBLE_PRESENCE_CHIPS);
    expect(visible.map((c) => c.label)).toEqual(["Jeannie", "Maya"]);
    expect(overflow).toBe(2);
  });

  it("gives each human chip a stable per-user key", () => {
    const { visible } = buildPresenceStrip({
      agentRunning: false,
      agentStreamingVisibleOutput: false,
      assistantName: "Jeannie",
      others: [human("u1", "Maya"), human("u2", "Alex")],
    });
    expect(visible.map((c) => c.key)).toEqual(["human:u1", "human:u2"]);
  });
});

describe("agentStreamingVisibleOutput store (D313)", () => {
  it("notifies subscribers when streaming visibility changes", () => {
    let calls = 0;
    const unsubscribe = subscribeAgentStreamingVisibleOutput(() => {
      calls += 1;
    });
    expect(getAgentStreamingVisibleOutputSnapshot()).toBe(false);
    setAgentStreamingVisibleOutput(true);
    expect(getAgentStreamingVisibleOutputSnapshot()).toBe(true);
    expect(calls).toBe(1);
    setAgentStreamingVisibleOutput(true);
    expect(calls).toBe(1);
    setAgentStreamingVisibleOutput(false);
    expect(calls).toBe(2);
    unsubscribe();
  });
});
