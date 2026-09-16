import { describe, expect, test } from "bun:test";
import { parseVerifiedOrdinaryOrigin } from "../../src/executors/langgraph-executor";

describe("M085 fork terminal authority parser", () => {
  test("accepts the complete server-authored local Electron proof", () => {
    expect(parseVerifiedOrdinaryOrigin({
      kind: "local_electron",
      userId: "user-1",
      actorId: "actor-1",
      relayId: "relay-1",
      desktopSessionId: "desktop-session-1",
      pairingGeneration: "pairing-1",
      requestId: "request-1",
    })).toMatchObject({ kind: "local_electron", relayId: "relay-1" });
  });

  test("rejects a partial proof rather than synthesizing host authority", () => {
    expect(parseVerifiedOrdinaryOrigin({
      kind: "local_electron",
      userId: "user-1",
      actorId: "actor-1",
      relayId: "relay-1",
    })).toBeNull();
  });
});
