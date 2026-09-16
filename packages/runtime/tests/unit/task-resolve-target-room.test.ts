import { describe, test, expect } from "bun:test";
import type { DirectDatabase, Task } from "@nautilo/db";
import { resolveTargetRoom } from "../../src/tasks/resolve-target-room";

const baseTask = (over: Partial<Task> = {}): Task =>
  ({
    id: "33333333-3333-3333-3333-333333333333",
    ownerId: "11111111-1111-1111-1111-111111111111",
    requestorId: "11111111-1111-1111-1111-111111111111",
    agentId: "22222222-2222-2222-2222-222222222222",
    prompt: "x",
    targetChat: "orphan",
    targetRoomId: null,
    callingRoomId: null,
    targetUserIds: [],
    scheduleKind: "now",
    timezone: "UTC",
    depth: 0,
    ...over,
  }) as unknown as Task;

/** A db that throws if any query runs — proves the branch under test is db-free. */
const explodingDb = {
  insert: () => {
    throw new Error("db should not be touched");
  },
  select: () => {
    throw new Error("db should not be touched");
  },
} as unknown as DirectDatabase;

describe("M142 — resolveTargetRoom", () => {
  test("orphan memoizes targetRoomId — reuses existing room, no new room", async () => {
    const task = baseTask({
      targetChat: "orphan",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
    });
    const r = await resolveTargetRoom(task, { db: explodingDb });
    expect(r.roomId).toBe("44444444-4444-4444-4444-444444444444");
    // Orphan run thread is a fresh subagent: thread.
    expect(r.graphThreadId.startsWith("subagent:")).toBe(true);
  });

  test("orphan thread anchors on the calling room when present", async () => {
    const task = baseTask({
      targetChat: "orphan",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      callingRoomId: "55555555-5555-5555-5555-555555555555",
    });
    const r = await resolveTargetRoom(task, { db: explodingDb });
    expect(r.graphThreadId).toContain("room:55555555-5555-5555-5555-555555555555");
  });

  // M151 (Phase 7b) — DM routing. The full create/reuse path needs a real DB
  // (findLocalUserByHandle + createRoomFromMembers) and is covered by the
  // integration suite. These unit tests lock the two db-free branches.
  test("last_dm memoizes targetRoomId — reuses the DM room, db-free", async () => {
    const task = baseTask({
      targetChat: "last_dm",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
    });
    const r = await resolveTargetRoom(task, { db: explodingDb });
    expect(r.roomId).toBe("44444444-4444-4444-4444-444444444444");
    // DM runs on the per-(room, bot) thread so the question is visible.
    expect(r.graphThreadId).toBe(
      "room:44444444-4444-4444-4444-444444444444:bot:22222222-2222-2222-2222-222222222222",
    );
  });

  test("new_dm with no target_chat_handle throws the missing-handle error (db-free)", () => {
    const task = baseTask({ targetChat: "new_dm" });
    return expect(resolveTargetRoom(task, { db: explodingDb })).rejects.toThrow(
      /missing target_chat_handle/,
    );
  });

  test("ping last_in_namespace honors a preselected targetRoomId, db-free", async () => {
    const task = baseTask({
      preset: "ping",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
    });
    const r = await resolveTargetRoom(task, { db: explodingDb });
    expect(r.roomId).toBe("44444444-4444-4444-4444-444444444444");
    expect(r.graphThreadId).toBe(
      "room:44444444-4444-4444-4444-444444444444:bot:22222222-2222-2222-2222-222222222222",
    );
  });

  test("strict Genie harness Codex descriptor uses the supplied Room without ping reuse", async () => {
    const task = baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {
        execution: {
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "work",
          harnessModelId: "picker-5.5",
          readiness: {
            relayId: "relay",
            pairingGenerationRef: "pairing-1",
            capabilityRevision: 4,
          },
        },
      },
    });
    const r = await resolveTargetRoom(task, { db: explodingDb });
    expect(r).toEqual({
      roomId: "44444444-4444-4444-4444-444444444444",
      graphThreadId: "room:44444444-4444-4444-4444-444444444444:bot:22222222-2222-2222-2222-222222222222",
    });
  });

  test("strict Genie harness Codex descriptor accepts its optional working directory", async () => {
    const r = await resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {
        execution: {
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "plan",
          harnessModelId: "picker-5.5",
          readiness: {
            relayId: "relay",
            pairingGenerationRef: "pairing-1",
            capabilityRevision: 4,
          },
          workingDirectory: "/projects/nautilo",
        },
      },
    }), { db: explodingDb });
    expect(r.roomId).toBe("44444444-4444-4444-4444-444444444444");
  });

  test("strict Claude Code descriptor uses the supplied Room on its isolated harness thread", async () => {
    const r = await resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {
        execution: {
          version: 1,
          harnessId: "claude-code",
          source: "genie",
          profileRef: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          catalogModelId: "claude-sonnet",
          selectedModel: "claude-sonnet-4",
        },
      },
    }), { db: explodingDb });
    expect(r).toEqual({
      roomId: "44444444-4444-4444-4444-444444444444",
      graphThreadId: "subagent:harness:claude-code:room:44444444-4444-4444-4444-444444444444:agent:22222222-2222-2222-2222-222222222222",
    });
  });

  test.each([
    [
      "Hermes",
      {
        execution: {
          version: 1,
          harnessId: "hermes-acp",
          source: "genie",
          readiness: {
            relayId: "relay",
            relaySessionId: "session",
            pairingGenerationRef: "pair",
            desktopSessionId: "desktop",
            selectedProtocolVersion: 14,
            capabilityRevision: 1,
          },
        },
      },
      "subagent:harness:hermes-acp:room:44444444-4444-4444-4444-444444444444:agent:22222222-2222-2222-2222-222222222222",
    ],
    [
      "OpenCode",
      {
        execution: {
          version: 1,
          harnessId: "opencode-acp",
          source: "genie",
          executionProfile: "autonomous",
          readiness: {
            relayId: "relay",
            relaySessionId: "session",
            pairingGenerationRef: "pair",
            desktopSessionId: "desktop",
            selectedProtocolVersion: 15,
            capabilityRevision: 1,
          },
        },
      },
      "subagent:harness:opencode-acp:room:44444444-4444-4444-4444-444444444444:agent:22222222-2222-2222-2222-222222222222",
    ],
  ] as const)("strict Genie %s ACP descriptor keeps Room output on an isolated per-harness queue", async (_name, metadata, graphThreadId) => {
    const r = await resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata,
    }), { db: explodingDb });
    expect(r).toEqual({
      roomId: "44444444-4444-4444-4444-444444444444",
      graphThreadId,
    });
  });

  test("near-match Codex metadata does not select harness Room routing", () => {
    const task = baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {
        execution: {
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "work",
          harnessModelId: "picker-5.5",
          readiness: {
            relayId: "relay",
            pairingGenerationRef: "pairing-1",
            capabilityRevision: 4,
          },
          extra: true,
        },
      },
    });
    return expect(resolveTargetRoom(task, { db: explodingDb })).rejects.toThrow(
      "db should not be touched",
    );
  });

  test.each([
    {
      execution: {
        version: 1,
        harnessId: "claude-code",
        source: "genie",
        profileRef: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        catalogModelId: "claude-sonnet",
        selectedModel: "claude-sonnet-4",
        extra: true,
      },
    },
    {
      execution: {
        version: 1,
        harnessId: "claude-code",
        source: "genie",
        profileRef: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        catalogModelId: "claude-sonnet",
        selectedModel: "claude-sonnet-4",
      },
      unrelated: true,
    },
    {
      execution: {
        version: 1,
        harnessId: "claude-code",
        source: "genie",
        profileRef: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        catalogModelId: "claude-sonnet",
        selectedModel: "",
      },
    },
  ])("near-match Claude Code metadata does not select isolated harness routing", (metadata) => {
    return expect(resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata,
    }), { db: explodingDb })).rejects.toThrow("db should not be touched");
  });

  test.each([
    undefined,
    { relayId: "relay", pairingGenerationRef: "pairing-1", capabilityRevision: -1 },
    { relayId: "relay", pairingGenerationRef: "pairing-1", capabilityRevision: 4, extra: true },
  ])("Codex metadata with missing or malformed readiness does not select harness Room routing", (readiness) => {
    return expect(resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {
        execution: {
          version: 1,
          harnessId: "codex",
          source: "genie",
          collaborationMode: "work",
          harnessModelId: "picker-5.5",
          ...(readiness === undefined ? {} : { readiness }),
        },
      },
    }), { db: explodingDb })).rejects.toThrow("db should not be touched");
  });

  test.each([
    {
      execution: {
        version: 1,
        harnessId: "hermes-acp",
        source: "genie",
        readiness: { relayId: "relay", relaySessionId: "session", pairingGenerationRef: "pair", desktopSessionId: "desktop", selectedProtocolVersion: 14, capabilityRevision: 1, extra: true },
      },
    },
    {
      execution: {
        version: 1,
        harnessId: "opencode-acp",
        source: "genie",
        executionProfile: "autonomous",
        readiness: { relayId: "relay", relaySessionId: "session", pairingGenerationRef: "pair", desktopSessionId: "desktop", selectedProtocolVersion: 15, capabilityRevision: 1 },
        extra: true,
      },
    },
    {
      execution: {
        version: 1,
        harnessId: "hermes-acp",
        source: "genie",
        readiness: { relayId: "relay", relaySessionId: "session", pairingGenerationRef: "pair", desktopSessionId: "desktop", selectedProtocolVersion: 14, capabilityRevision: 1 },
      },
      unrelated: true,
    },
  ])("near-match ACP metadata does not select isolated harness routing", (metadata) => {
    return expect(resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata,
    }), { db: explodingDb })).rejects.toThrow("db should not be touched");
  });

  test("Native last_in_namespace remains on its established namespace path", () => {
    return expect(resolveTargetRoom(baseTask({
      preset: "task",
      targetChat: "last_in_namespace",
      targetRoomId: "44444444-4444-4444-4444-444444444444",
      metadata: {},
    }), { db: explodingDb })).rejects.toThrow("db should not be touched");
  });
});
