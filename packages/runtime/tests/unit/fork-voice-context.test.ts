import { describe, expect, test } from "bun:test";
import { forkVoiceExecutionContext } from "../../src/executors/fork-langgraph-executor";

describe("fork voice execution context", () => {
  test("enables requested speech for the causal Human without consulting server-key state", () => {
    const previous = process.env["ELEVENLABS_API_KEY"];
    delete process.env["ELEVENLABS_API_KEY"];
    try {
      expect(forkVoiceExecutionContext({
        voiceMode: true,
        ownerId: "memory-owner",
        memoryAccessEnvelope: { ownerId: "envelope-owner" },
      }, "causal-human")).toEqual({
        voiceEnabled: true,
        voiceSubjectId: "causal-human",
      });
    } finally {
      if (previous === undefined) delete process.env["ELEVENLABS_API_KEY"];
      else process.env["ELEVENLABS_API_KEY"] = previous;
    }
  });

  test("does not create speech authority without both the request and causal Human", () => {
    expect(forkVoiceExecutionContext({ voiceMode: false }, "causal-human")).toEqual({
      voiceEnabled: false,
      voiceSubjectId: "causal-human",
    });
    expect(forkVoiceExecutionContext({ voiceMode: true }, null)).toEqual({
      voiceEnabled: false,
      voiceSubjectId: null,
    });
  });
});
