import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  shouldApplyWsEventForActiveRoom,
  roomIdFromLaneKey,
} from "../../src/adapters/ws-event-room";

/**
 * M134 regression — the Room Conductor streams group-room agent turns on a
 * per-(user,bot) lane (`room:<id>:user:<actor>:bot:<agentId>`). A naive
 * `slice("room:".length)` made these never match the active room, so the
 * bot's streamed reply was filtered out client-side — "I @-mention a bot and
 * nothing appears." These guard the bare-uuid extraction.
 */
describe("roomIdFromLaneKey (M134 client lane routing)", () => {
  const ROOM = "809996bd-5db4-44a1-875d-82eb9ff84c82";
  const USER = "ee834034-1988-4e71-81e8-182354098ac2";
  const BOT = "d900b3a1-423d-498f-87ae-292553a6744a";

  test("bare room lane → room", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}`)).toBe(ROOM);
  });
  test("per-(user,bot) group lane → room (the regression)", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}:user:${USER}:bot:${BOT}`)).toBe(ROOM);
  });
  test("per-user lane → room", () => {
    expect(roomIdFromLaneKey(`room:${ROOM}:user:${USER}`)).toBe(ROOM);
  });
  test("explicit lane→room map wins over parsing", () => {
    expect(
      roomIdFromLaneKey("lane-x", new Map([["lane-x", "room-mapped"]])),
    ).toBe("room-mapped");
  });
  test("non-room lane → null", () => {
    expect(roomIdFromLaneKey("app:default")).toBeNull();
    expect(roomIdFromLaneKey("guest:abc")).toBeNull();
  });

  test("group bot stream event applies to the active room", () => {
    const ev = {
      type: "message.tokens",
      laneKey: `room:${ROOM}:user:${USER}:bot:${BOT}`,
      content: "hi",
      chunkSequence: 0,
      done: false,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: ROOM,
        laneKeyToRoomId: new Map(),
        jobIdToRoomId: new Map(),
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });
});

describe("D502 run_shell progress room routing", () => {
  test("routes a lane-scoped progress event only to its matching room", () => {
    const event = {
      type: "tool.run_shell.progress" as const,
      laneKey: "room:room-a",
      toolCallId: "call-1",
      version: 1 as const,
      sequence: 0,
      stream: "stdout" as const,
      offsetBytes: 0,
      endOffsetBytes: 2,
      text: "ok",
      elapsedMs: 1,
      phase: "running" as const,
    } satisfies ServerEvent;
    expect(shouldApplyWsEventForActiveRoom({
      event, activeRoomId: "room-a", laneKeyToRoomId: new Map(), jobIdToRoomId: new Map(), lastStreamLaneKey: null,
    })).toBe(true);
    expect(shouldApplyWsEventForActiveRoom({
      event, activeRoomId: "room-b", laneKeyToRoomId: new Map(), jobIdToRoomId: new Map(), lastStreamLaneKey: null,
    })).toBe(false);
  });
});

describe("D500 structured SSH progress room routing", () => {
  test("routes a scoped SSH progress event only to its matching room", () => {
    const event = {
      type: "tool.structured_ssh.progress" as const,
      laneKey: "room:room-a",
      toolCallId: "ssh-1",
      version: 1 as const,
      sequence: 0,
      operation: "exec" as const,
      kind: "exec-output" as const,
      stream: "stdout" as const,
      offsetBytes: 0,
      endOffsetBytes: 2,
      text: "ok",
      elapsedMs: 1,
      phase: "running" as const,
    } satisfies ServerEvent;
    expect(shouldApplyWsEventForActiveRoom({
      event, activeRoomId: "room-a", laneKeyToRoomId: new Map(), jobIdToRoomId: new Map(), lastStreamLaneKey: null,
    })).toBe(true);
    expect(shouldApplyWsEventForActiveRoom({
      event, activeRoomId: "room-b", laneKeyToRoomId: new Map(), jobIdToRoomId: new Map(), lastStreamLaneKey: null,
    })).toBe(false);
  });
});

describe("shouldApplyWsEventForActiveRoom (D106)", () => {
  const laneMap = new Map([
    ["lane-a", "room-a"],
    ["lane-b", "room-b"],
  ]);
  const jobMap = new Map([["job-a", "room-a"]]);

  test("D570 — voice applies only to its exact active room", () => {
    const event = {
      type: "voice.audio",
      data: "audio",
      chunkIndex: 0,
      sentenceIndex: 0,
      final: false,
      roomId: "room-a",
    } satisfies ServerEvent;
    const route = (activeRoomId: string | null) =>
      shouldApplyWsEventForActiveRoom({
        event,
        activeRoomId,
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      });

    expect(route("room-a")).toBe(true);
    expect(route("room-b")).toBe(false);
    expect(route(null)).toBe(false);
    expect(route("room-a")).toBe(true);
  });

  test("D570 — voice without Room provenance fails closed", () => {
    const event = {
      type: "voice.audio",
      data: "audio",
      chunkIndex: 0,
      sentenceIndex: 0,
      final: false,
    } satisfies ServerEvent;
    expect(shouldApplyWsEventForActiveRoom({
      event,
      activeRoomId: "room-a",
      laneKeyToRoomId: laneMap,
      jobIdToRoomId: jobMap,
      lastStreamLaneKey: null,
    })).toBe(false);
  });

  test("guest / no active room → always applies chat events", () => {
    const ev = {
      type: "message.tokens",
      laneKey: "lane-a",
      content: "x",
      chunkSequence: 0,
      done: false,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: null,
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("mapped lane matches active room → applies", () => {
    const ev = {
      type: "message.tokens",
      laneKey: "lane-a",
      content: "x",
      chunkSequence: 0,
      done: false,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("mapped lane for another room → drops", () => {
    const ev = {
      type: "message.tokens",
      laneKey: "lane-a",
      content: "x",
      chunkSequence: 0,
      done: false,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("unmapped lane with active room selected → drops (no legacy bleed)", () => {
    const ev = {
      type: "message.tokens",
      laneKey: "unknown-lane",
      content: "x",
      chunkSequence: 0,
      done: false,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("job.status routes by jobId map", () => {
    const ok = {
      type: "job.status",
      jobId: "job-a",
      status: "completed",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ok,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);

    expect(
      shouldApplyWsEventForActiveRoom({
        event: ok,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("D353 — job.status falls back to its laneKey when the jobId map misses", () => {
    // Repro of the cap-64 eviction leak: a still-live job's jobId→room
    // mapping was evicted, so `jobIdToRoomId` no longer has it. Without the
    // fallback this terminal frame would resolve to null → be filtered →
    // never retire the job (stuck isRunning). The event carries its lane key
    // (M075), so it must still route to its room.
    const evicted = {
      type: "job.status",
      jobId: "job-evicted",
      status: "completed",
      laneKey: "room:room-a",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: evicted,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap, // no "job-evicted" entry
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    // Still room-scoped: the same fallback must NOT leak into another room.
    expect(
      shouldApplyWsEventForActiveRoom({
        event: evicted,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
    // No laneKey AND no map entry → still filtered (unchanged behavior).
    const noProvenance = {
      type: "job.status",
      jobId: "job-unknown",
      status: "completed",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: noProvenance,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("D353 — job.forked / fork.spliced route by laneKey (not global)", () => {
    const forked = {
      type: "job.forked",
      laneKey: "room:room-a",
      jobId: "job-fork",
      virtualJobIds: [],
      parentThreadId: "room:room-a:bot:b1",
      forkThreadId: "room:room-a:bot:b1:fork:1",
      syntheticNoteCount: 0,
      sequence: 1,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: forked,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    // The whole point: a fork in another room must NOT apply to the active one.
    expect(
      shouldApplyWsEventForActiveRoom({
        event: forked,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);

    const spliced = {
      type: "fork.spliced",
      laneKey: "room:room-a",
      jobId: "job-fork",
      parentThreadId: "room:room-a:bot:b1",
      forkThreadId: "room:room-a:bot:b1:fork:1",
      sequence: 2,
      splicedMessageCount: 3,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: spliced,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("model.fallback (D323) applies only to its own room", () => {
    const ev = {
      type: "model.fallback",
      laneKey: "lane-a",
      turnId: "turn-1",
      from: "anthropic:claude-sonnet-4-6",
      to: "anthropic:claude-opus-4-7",
      reason: "timeout",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    // Fallback for room-a must NOT surface while viewing room-b (cross-room misfire).
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("tool.start routes by its own lane provenance", () => {
    const ev = {
      type: "tool.start",
      laneKey: "lane-a",
      toolCallId: "tc1",
      toolName: "file",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: "lane-b",
      }),
    ).toBe(true);
  });

  test("room-prefixed lane routes even before HTTP response seeds the lane map", () => {
    const ev = {
      type: "tool.start",
      laneKey: "room:room-c",
      toolCallId: "tc1",
      toolName: "file",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-c",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("tool.start with another room's lane provenance → drops", () => {
    const ev = {
      type: "tool.start",
      laneKey: "lane-a",
      toolCallId: "tc1",
      toolName: "run_shell",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: "lane-a",
      }),
    ).toBe(false);
  });

  test("legacy tool.start does not inherit another room's last stream lane", () => {
    const ev = {
      type: "tool.start",
      toolCallId: "tc1",
      toolName: "run_shell",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: "lane-a",
      }),
    ).toBe(false);
  });

  test("job.dispatched routes by laneKey", () => {
    const ev = {
      type: "job.dispatched",
      laneKey: "lane-a",
      jobId: "job-new",
      virtualJobIds: ["v1"],
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("policy.changed is global", () => {
    const ev = {
      type: "policy.changed",
      deploymentMode: "server",
      securityLevel: "standard",
      networkPolicy: { mode: "host" },
      at: "2026-01-01T00:00:00.000Z",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: "lane-a",
      }),
    ).toBe(true);
  });

  test("room.catalog.changed bypasses the active-room transcript gate", () => {
    const ev = { type: "room.catalog.changed" } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: "lane-a",
      }),
    ).toBe(true);
  });

  test("room.silence.changed applies only when roomId matches active room", () => {
    const ev = {
      type: "room.silence.changed",
      roomId: "room-b",
      laneKey: "room:room-b",
      silence: null,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("room.conductor_mode.changed applies only when roomId matches active room", () => {
    const ev = {
      type: "room.conductor_mode.changed",
      roomId: "room-b",
      laneKey: "room:room-b",
      conductorMode: "standard",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("room_members_changed always applies (roster + transcript invalidation)", () => {
    const ev = {
      type: "room_members_changed",
      roomId: "room-b",
      event: {
        kind: "member_added",
        actorId: "act-1",
        actorKind: "agent",
        displayName: "Genie",
      },
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("conductor.ask_user is room-scoped via laneKey", () => {
    const ev = {
      type: "conductor.ask_user",
      laneKey: "lane-a",
      roomId: "room-a",
      userId: "user-1",
      userActorId: "u1",
      messageId: "1",
      options: [
        { botActorId: "a1", handle: "daria" },
        { botActorId: "a2", handle: "nova" },
      ],
      reason: "ambiguous",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("Task approval.ask (origin=task) bypasses active-room filter", () => {
    const ev = {
      type: "approval.ask",
      approvalId: "ap1",
      threadId: "subagent:abc",
      laneKey: "task:task-1",
      tools: [],
      reason: "destructive tool",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "always", "deny"],
      origin: "task",
      taskId: "task-1",
      taskRunId: "run-1",
      userId: "owner-1",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("Task prove_it.challenge (origin=task) bypasses active-room filter", () => {
    const ev = {
      type: "prove_it.challenge",
      threadId: "subagent:abc",
      laneKey: "task:task-1",
      tools: [],
      origin: "task",
      taskId: "task-1",
      taskRunId: "run-1",
      userId: "owner-1",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("Task identity.challenge (origin=task) bypasses active-room filter", () => {
    const ev = {
      type: "identity.challenge",
      laneKey: "task:task-1",
      challengeId: "c1",
      expiresAt: "2026-01-01T00:00:00.000Z",
      threadId: "subagent:abc",
      mode: "enrollPin",
      origin: "task",
      taskId: "task-1",
      taskRunId: "run-1",
      userId: "owner-1",
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("Task approval bypasses via task: lane prefix even without origin field", () => {
    const ev = {
      type: "approval.ask",
      approvalId: "ap1",
      threadId: "subagent:abc",
      laneKey: "task:task-1",
      tools: [],
      reason: "x",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "always", "deny"],
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
  });

  test("main-thread approval.ask for another room is still filtered out", () => {
    const ev = {
      type: "approval.ask",
      approvalId: "ap1",
      threadId: "room:room-b",
      laneKey: "room:room-b",
      tools: [],
      reason: "x",
      reasonCode: "destructive-tool",
      allowedVerbs: ["once", "room", "always", "deny"],
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("main-thread prove_it.challenge for another room is still filtered out", () => {
    const ev = {
      type: "prove_it.challenge",
      threadId: "room:room-b",
      laneKey: "room:room-b",
      tools: [],
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("agent.progress (M178) routes like message.tokens", () => {
    const ev = {
      type: "agent.progress",
      laneKey: "lane-a",
      turnId: "turn-1",
      phase: "thinking",
    } as const;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });

  test("message.deleted applies only when laneKey matches active room", () => {
    const ev = {
      type: "message.deleted",
      laneKey: "room:room-a",
      messageId: 5,
    } satisfies ServerEvent;
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-a",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(true);
    expect(
      shouldApplyWsEventForActiveRoom({
        event: ev,
        activeRoomId: "room-b",
        laneKeyToRoomId: laneMap,
        jobIdToRoomId: jobMap,
        lastStreamLaneKey: null,
      }),
    ).toBe(false);
  });
});
