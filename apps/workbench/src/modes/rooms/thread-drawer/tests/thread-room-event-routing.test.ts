import { describe, expect, test } from "bun:test";
import type { ServerEvent } from "@nautilo/types";
import {
  shouldPublishThreadRoomFocusEvent,
  shouldRouteEventToThreadRoom,
  type ThreadRoomRegistration,
} from "../../../../adapters/runtime-contexts";

const rooms = new Map([
  ["room:parent-a", "parent-a"],
  ["room:child-a", "child-a"],
  ["room:child-b", "child-b"],
]);
const resolveRoom = (laneKey: string): string | null => rooms.get(laneKey) ?? null;

const registration: ThreadRoomRegistration = {
  roomId: "child-a",
  parentRoomId: "parent-a",
  anchorLogicalMessageKey: "row:10",
  ingestEvent: () => {},
  ownsJobId: (jobId) => jobId === "child-job",
};

describe("thread-room event routing", () => {
  test("routes each supported child-lane family before the parent gate", () => {
    const events: ServerEvent[] = [
      { type: "message.new", laneKey: "room:child-a", messageId: "1", role: "user", content: "hello" },
      { type: "message.updated", laneKey: "room:child-a", logicalMessageKey: "row:11", content: "fixed", editedAt: "2026-08-01T10:00:00.000Z", editRevision: 1 },
      { type: "message.tokens", laneKey: "room:child-a", content: "hi", chunkSequence: 1, done: false },
      { type: "message.deleted", laneKey: "room:child-a", messageId: 1 },
      { type: "job.dispatched", laneKey: "room:child-a", jobId: "child-job", virtualJobIds: [] },
      { type: "job.status", laneKey: "room:child-a", jobId: "child-job", status: "running" },
      { type: "job.progress", laneKey: "room:child-a", jobId: "child-job", phase: "tools" },
      { type: "tool.start", laneKey: "room:child-a", toolCallId: "tool-a", toolName: "read_file" },
      { type: "tool.end", laneKey: "room:child-a", toolCallId: "tool-a", toolName: "read_file", duration: 1, status: "success", sensitivity: "normal" },
      { type: "approval.ask", laneKey: "room:child-a", approvalId: "ask-a", threadId: "t", tools: [], reason: "approval", reasonCode: "destructive-tool", allowedVerbs: ["once"] },
      { type: "approval.resolved", laneKey: "room:child-a", approvalId: "ask-a", threadId: "t", userId: "u", resolution: "approved" },
      { type: "prove_it.challenge", laneKey: "room:child-a", threadId: "t", tools: [] },
    ];

    for (const event of events) {
      expect(shouldRouteEventToThreadRoom(registration, event, resolveRoom)).toBe(true);
    }
  });

  test("mirrors only the displayed parent anchor edit into the child controller", () => {
    const anchorEdit: ServerEvent = {
      type: "message.updated",
      laneKey: "room:parent-a",
      logicalMessageKey: "row:10",
      content: "fixed anchor",
      editedAt: "2026-08-01T10:00:00.000Z",
      editRevision: 1,
    };
    expect(shouldRouteEventToThreadRoom(registration, anchorEdit, resolveRoom)).toBe(true);
    expect(
      shouldRouteEventToThreadRoom(
        registration,
        { ...anchorEdit, logicalMessageKey: "row:other" },
        resolveRoom,
      ),
    ).toBe(false);
  });

  test("rejects parent and sibling traffic, including stale replay after a room switch", () => {
    const events: ServerEvent[] = [
      { type: "message.new", laneKey: "room:parent-a", messageId: "1", role: "user", content: "parent" },
      { type: "job.dispatched", laneKey: "room:child-b", jobId: "other-job", virtualJobIds: [] },
      { type: "approval.ask", laneKey: "room:parent-a", approvalId: "ask-parent", threadId: "t", tools: [], reason: "approval", reasonCode: "destructive-tool", allowedVerbs: ["once"] },
    ];

    for (const event of events) {
      expect(shouldRouteEventToThreadRoom(registration, event, resolveRoom)).toBe(false);
    }
  });

  test("admits a lane-less terminal only for a job the child already knows", () => {
    const known: ServerEvent = { type: "job.status", jobId: "child-job", status: "completed" };
    const unknown: ServerEvent = { type: "job.status", jobId: "parent-job", status: "completed" };

    expect(shouldRouteEventToThreadRoom(registration, known, resolveRoom)).toBe(true);
    expect(shouldRouteEventToThreadRoom(registration, unknown, resolveRoom)).toBe(false);
  });

  test("publishes focus feedback only for the displayed child room", () => {
    const child: ServerEvent = {
      type: "conductor.focus_changed",
      laneKey: "room:child-a",
      roomId: "child-a",
      userActorId: "viewer",
      change: "opened",
      botActorId: "jeannie",
      source: "mention",
      reason: "Explicit mention",
    };
    const parent: ServerEvent = { ...child, laneKey: "room:parent-a", roomId: "parent-a" };
    const sibling: ServerEvent = { ...child, laneKey: "room:child-b", roomId: "child-b" };
    const mismatchedLane: ServerEvent = { ...child, laneKey: "room:parent-a" };

    expect(shouldPublishThreadRoomFocusEvent(registration, child, resolveRoom)).toBe(true);
    expect(shouldPublishThreadRoomFocusEvent(registration, parent, resolveRoom)).toBe(false);
    expect(shouldPublishThreadRoomFocusEvent(registration, sibling, resolveRoom)).toBe(false);
    expect(shouldPublishThreadRoomFocusEvent(registration, mismatchedLane, resolveRoom)).toBe(false);
    expect(shouldRouteEventToThreadRoom(registration, child, resolveRoom)).toBe(false);
  });
});
