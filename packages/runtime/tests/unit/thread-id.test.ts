import { describe, test, expect } from "bun:test";
import { botThreadId } from "../../src/conductor/thread-id";

describe("botThreadId", () => {
  test("returns room:roomId:bot:agentId format", () => {
    expect(botThreadId("r1", "a1")).toBe("room:r1:bot:a1");
  });

  test("different agentIds in the same room produce different ids", () => {
    const roomId = "r1";
    expect(botThreadId(roomId, "a1")).not.toBe(botThreadId(roomId, "a2"));
  });

  test("different roomIds with the same agentId produce different ids", () => {
    const agentId = "a1";
    expect(botThreadId("r1", agentId)).not.toBe(botThreadId("r2", agentId));
  });

  test("is stable and deterministic", () => {
    const id1 = botThreadId("r1", "a1");
    const id2 = botThreadId("r1", "a1");
    expect(id1).toBe(id2);
  });
});
