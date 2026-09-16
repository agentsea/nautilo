import { describe, expect, test } from "bun:test";
import {
  eventFeedItemSchema,
  eventFeedListOptionsSchema,
  eventFeedRecordInputSchema,
} from "../../src/event-feed";

describe("event-feed browser-safe contracts", () => {
  test("accepts the four reference-only event shapes", () => {
    const actorId = "10000000-0000-4000-8000-000000000001";
    const recipientId = "10000000-0000-4000-8000-000000000002";
    const subjectId = "10000000-0000-4000-8000-000000000003";
    const roomId = "10000000-0000-4000-8000-000000000004";
    const common = {
      key: "membership:operation-1",
      actorKind: "human",
      actorId,
      recipientUserIds: [recipientId],
    } as const;

    expect(eventFeedRecordInputSchema.safeParse({
      ...common,
      type: "room.member_joined",
      data: { roomId, userId: subjectId },
    }).success).toBe(true);
    expect(eventFeedRecordInputSchema.safeParse({
      ...common,
      type: "room.member_left",
      data: { roomId, userId: subjectId },
    }).success).toBe(true);
    expect(eventFeedRecordInputSchema.safeParse({
      ...common,
      type: "artifact.added",
      data: { artifactId: "artifact-1", roomId },
    }).success).toBe(true);
    expect(eventFeedRecordInputSchema.safeParse({
      ...common,
      type: "artifact.shared",
      data: { artifactId: "artifact-1", destination: { kind: "person", userId: subjectId } },
    }).success).toBe(true);
  });

  test("rejects copied presentation, mismatched data, and memory events", () => {
    const actorId = "10000000-0000-4000-8000-000000000001";
    const recipientId = "10000000-0000-4000-8000-000000000002";
    const roomId = "10000000-0000-4000-8000-000000000004";
    expect(eventFeedRecordInputSchema.safeParse({
      key: "artifact:operation-1",
      type: "artifact.added",
      actorKind: "agent",
      actorId,
      recipientUserIds: [recipientId],
      data: { artifactId: "artifact-1", roomId, title: "Secret" },
    }).success).toBe(false);
    expect(eventFeedRecordInputSchema.safeParse({
      key: "bad-shape",
      type: "room.member_joined",
      actorKind: "human",
      actorId,
      recipientUserIds: [recipientId],
      data: { artifactId: "artifact-1", roomId },
    }).success).toBe(false);
    expect(eventFeedRecordInputSchema.safeParse({
      key: "memory:operation-1",
      type: "memory.shared",
      actorKind: "human",
      actorId,
      recipientUserIds: [recipientId],
      data: { memoryId: "memory-1" },
    }).success).toBe(false);
  });

  test("allows nullable persisted actor references and validates list controls", () => {
    const eventId = "10000000-0000-4000-8000-000000000005";
    const roomId = "10000000-0000-4000-8000-000000000004";
    expect(eventFeedItemSchema.safeParse({
      id: eventId,
      type: "artifact.shared",
      actorKind: "agent",
      actorId: null,
      data: { artifactId: "artifact-1", destination: { kind: "room", roomId } },
      createdAt: "2026-09-09T12:00:00.000Z",
      readAt: null,
    }).success).toBe(true);
    expect(eventFeedListOptionsSchema.safeParse({ types: [] }).success).toBe(false);
    expect(eventFeedListOptionsSchema.safeParse({ limit: 0 }).success).toBe(false);
  });

  test("projects unsupported future events to a content-free generic item", () => {
    const parsed = eventFeedItemSchema.parse({
      id: "10000000-0000-4000-8000-000000000005",
      type: "task.finished",
      actorKind: "agent",
      actorId: "10000000-0000-4000-8000-000000000001",
      data: {
        taskId: "private-task",
        title: "Sensitive future label",
        nested: { content: "must not survive" },
      },
      label: "also dropped",
      createdAt: "2026-09-09T12:00:00.000Z",
      readAt: null,
    });

    expect(parsed).toEqual({
      id: "10000000-0000-4000-8000-000000000005",
      type: "unknown",
      actorKind: null,
      actorId: null,
      data: {},
      createdAt: "2026-09-09T12:00:00.000Z",
      readAt: null,
    });
  });

  test("does not disguise malformed known events as unknown", () => {
    expect(eventFeedItemSchema.safeParse({
      id: "10000000-0000-4000-8000-000000000005",
      type: "artifact.added",
      actorKind: "human",
      actorId: "10000000-0000-4000-8000-000000000001",
      data: { artifactId: "artifact-1", title: "missing room" },
      createdAt: "2026-09-09T12:00:00.000Z",
      readAt: null,
    }).success).toBe(false);
  });

  test("rejects invalid identifiers even for unsupported event kinds", () => {
    expect(eventFeedItemSchema.safeParse({
      id: "not-an-event-id",
      type: "task.finished",
      data: { title: "dropped" },
      createdAt: "2026-09-09T12:00:00.000Z",
      readAt: null,
    }).success).toBe(false);
  });
});
