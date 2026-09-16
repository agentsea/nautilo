/**
 * M137 Phase 1 — `buildWideEnvelopeForSpeaker` with mocked query deps.
 * Uses `mock.restore()` + cache-busted dynamic import so `mock.module`
 * on `./queries` does not leak into other unit tests in the same process.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ToolAccess } from "../../src/types";

const SPEAKER_ACTOR_ID = "a-alice";
const SPEAKER_USER_ID = "user-alice";
const AGENT_ID = "agent-genie";
const TOOL_POLICY: Record<string, ToolAccess> = { save_memory: "allow" };

let mockFindDefaultRoomForActor: ReturnType<typeof mock>;
let mockGetRoomWithAccess: ReturnType<typeof mock>;
let mockFindReadableNamespacesForSubset: ReturnType<typeof mock>;

beforeEach(() => {
  mock.restore();
  mockFindDefaultRoomForActor = mock(async () => null);
  mockGetRoomWithAccess = mock(async () => null);
  mockFindReadableNamespacesForSubset = mock(async () => []);
});

afterEach(() => {
  mock.restore();
});

async function loadWideEnvelopeFresh(): Promise<
  typeof import("../../src/wide-envelope")
> {
  mock.module("../../src/queries", () => ({
    findDefaultRoomForActor: mockFindDefaultRoomForActor,
    getRoomWithAccess: mockGetRoomWithAccess,
    findReadableNamespacesForSubset: mockFindReadableNamespacesForSubset,
  }));
  const href = new URL("../../src/wide-envelope.ts", import.meta.url).href;
  return import(`${href}?t=${Date.now()}`) as Promise<
    typeof import("../../src/wide-envelope")
  >;
}

describe("buildWideEnvelopeForSpeaker (M137 Phase 1)", () => {
  test("happy path builds widest namespace envelope", async () => {
    mockFindDefaultRoomForActor = mock(async () => ({
      id: "room-priv",
      type: "private",
      graphThreadId: "t",
    }));
    mockGetRoomWithAccess = mock(async () => ({
      namespaceId: "ns-priv",
      humanActorIds: ["a-alice", "a-agent"],
    }));
    mockFindReadableNamespacesForSubset = mock(async () => [
      "ns-priv",
      "ns-group",
    ]);

    const { buildWideEnvelopeForSpeaker } = await loadWideEnvelopeFresh();
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: SPEAKER_ACTOR_ID,
      speakerUserId: SPEAKER_USER_ID,
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.privateRoomId).toBe("room-priv");
    expect(result.envelope.writableNamespaces).toEqual(["ns-priv"]);
    expect(result.envelope.readableNamespaces).toContain("ns-priv");
    expect(result.envelope.readableNamespaces).toContain("ns-group");
    expect(result.envelope.readableNamespaces).toHaveLength(2);
    expect(result.envelope.mutableNamespaces).toEqual(
      result.envelope.readableNamespaces,
    );
    expect(result.envelope.memoryMode).toBe("namespace");
    expect(result.envelope.ownerId).toBe(SPEAKER_USER_ID);
    expect(result.envelope.actorId).toBe(SPEAKER_ACTOR_ID);
    expect(result.envelope.agentId).toBe(AGENT_ID);
    expect(result.envelope.roomId).toBe("room-priv");
    expect(result.envelope.toolPolicy).toBe(TOOL_POLICY);

    expect(mockFindDefaultRoomForActor).toHaveBeenCalledWith(
      SPEAKER_ACTOR_ID,
      AGENT_ID,
    );
    expect(mockGetRoomWithAccess).toHaveBeenCalledWith("room-priv");
    expect(mockFindReadableNamespacesForSubset).toHaveBeenCalledWith([
      "a-alice",
      "a-agent",
    ]);
  });

  test("returnRoomNamespaceId becomes the primary write target (bring-it-here)", async () => {
    mockFindDefaultRoomForActor = mock(async () => ({
      id: "room-priv",
      type: "private",
      graphThreadId: "t",
    }));
    mockGetRoomWithAccess = mock(async () => ({
      namespaceId: "ns-priv",
      humanActorIds: ["a-alice", "a-agent"],
    }));
    mockFindReadableNamespacesForSubset = mock(async () => ["ns-priv", "ns-group"]);

    const { buildWideEnvelopeForSpeaker } = await loadWideEnvelopeFresh();
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: SPEAKER_ACTOR_ID,
      speakerUserId: SPEAKER_USER_ID,
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
      returnRoomNamespaceId: "ns-group",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Group room (return target) is writableNamespaces[0]; private NS second.
    expect(result.envelope.writableNamespaces).toEqual(["ns-group", "ns-priv"]);
    expect(result.envelope.readableNamespaces).toContain("ns-group");
    expect(result.envelope.readableNamespaces).toContain("ns-priv");
  });

  test("returnRoomNamespaceId equal to the private NS does not duplicate the write target", async () => {
    mockFindDefaultRoomForActor = mock(async () => ({
      id: "room-priv",
      type: "private",
      graphThreadId: "t",
    }));
    mockGetRoomWithAccess = mock(async () => ({
      namespaceId: "ns-priv",
      humanActorIds: ["a-alice", "a-agent"],
    }));
    mockFindReadableNamespacesForSubset = mock(async () => ["ns-priv"]);

    const { buildWideEnvelopeForSpeaker } = await loadWideEnvelopeFresh();
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: SPEAKER_ACTOR_ID,
      speakerUserId: SPEAKER_USER_ID,
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
      returnRoomNamespaceId: "ns-priv",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.envelope.writableNamespaces).toEqual(["ns-priv"]);
  });

  test("returns no_private_room when findDefaultRoomForActor is null", async () => {
    mockFindDefaultRoomForActor = mock(async () => null);

    const { buildWideEnvelopeForSpeaker } = await loadWideEnvelopeFresh();
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: SPEAKER_ACTOR_ID,
      speakerUserId: SPEAKER_USER_ID,
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result).toEqual({ ok: false, reason: "no_private_room" });
  });

  test("returns no_namespace when getRoomWithAccess is null", async () => {
    mockFindDefaultRoomForActor = mock(async () => ({
      id: "room-priv",
      type: "private",
      graphThreadId: "t",
    }));
    mockGetRoomWithAccess = mock(async () => null);

    const { buildWideEnvelopeForSpeaker } = await loadWideEnvelopeFresh();
    const result = await buildWideEnvelopeForSpeaker({
      speakerActorId: SPEAKER_ACTOR_ID,
      speakerUserId: SPEAKER_USER_ID,
      agentId: AGENT_ID,
      toolPolicy: TOOL_POLICY,
    });

    expect(result).toEqual({ ok: false, reason: "no_namespace" });
  });
});
