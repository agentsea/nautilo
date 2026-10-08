import { describe, expect, test } from "bun:test";
import { parseHumanTerminalOperation, parseHumanTerminalOwner, sameHumanTerminalOwner, type HumanTerminalOwner } from "../../src/human-terminal";

const owner: HumanTerminalOwner = { humanUserId: "human-a", agentId: "agent-a", roomId: "room-a", conversationId: "conversation-a",
  relayId: "relay-a", desktopSessionId: "desktop-a", pairingGeneration: "pairing-a", serverOrigin: "https://server.example", serverFingerprint: "fingerprint-a" };

describe("closed Human Terminal contracts", () => {
  test("only read/run/write with safe cursor and exact input bytes", () => {
    for (const value of [{ action: "read" }, { action: "read", cursor: 0 }, { action: "run", command: "print(1)" }, { action: "write", data: "\x03" }] as const) {
      expect(parseHumanTerminalOperation(value)).toEqual(value);
    }
    for (const value of [{ action: "spawn" }, { action: "kill" }, { action: "list" }, { action: "read", cursor: -1 },
      { action: "read", cursor: 1.5 }, { action: "read", cursor: Number.MAX_SAFE_INTEGER + 1 }, { action: "read", cursor: "0" },
      { action: "run", command: " " }, { action: "run", command: "x\0" }, { action: ["read"] }, { action: "read", session_id: "t1" },
      { action: "read", owner }, { action: "write", data: "x", generation: "chosen" }]) expect(parseHumanTerminalOperation(value)).toBeNull();
  });
  test("all exact owner dimensions matter and parsing returns a copy", () => {
    expect(parseHumanTerminalOwner(owner)).toEqual(owner);
    expect(parseHumanTerminalOwner(owner)).not.toBe(owner);
    for (const key of Object.keys(owner) as (keyof HumanTerminalOwner)[]) {
      const changed = { ...owner, [key]: key === "serverOrigin" ? "https://other.example" : "other" };
      expect(sameHumanTerminalOwner(owner, changed)).toBeFalse();
      expect(parseHumanTerminalOwner({ ...owner, [key]: "" })).toBeNull();
      expect(parseHumanTerminalOwner({ ...owner, [key]: [owner[key]] })).toBeNull();
    }
    for (const serverOrigin of ["https://server.example/path", "https://server.example/", "https://fixture@example.invalid", "file:///tmp"]) {
      expect(parseHumanTerminalOwner({ ...owner, serverOrigin })).toBeNull();
    }
    expect(parseHumanTerminalOwner({ ...owner, extra: true })).toBeNull();
  });
});
