import { describe, expect, test } from "bun:test";
import {
  EventFeedQueryError,
  type EventFeedItem,
  type EventFeedRecordInput,
} from "@nautilo/types";
import {
  createEventFeed,
  type EventFeedStorage,
  type EventFeedStorageRecordResult,
  type NormalizedEventFeedRecordInput,
} from "../../src/event-feed";

const actorId = "10000000-0000-4000-8000-000000000001";
const userA = "aaaaaaaa-0000-4000-8000-000000000002";
const userB = "10000000-0000-4000-8000-000000000003";
const roomId = "10000000-0000-4000-8000-000000000004";
const eventId = "10000000-0000-4000-8000-000000000005";

const input: EventFeedRecordInput = {
  key: "membership:operation-1",
  type: "room.member_joined",
  actorKind: "human",
  actorId,
  recipientUserIds: [userA, userA.toUpperCase(), userB],
  data: { roomId, userId: userB },
};

const item: EventFeedItem = {
  id: eventId,
  type: "room.member_joined",
  actorKind: "human",
  actorId,
  data: { roomId, userId: userB },
  createdAt: "2026-09-09T12:00:00.000Z",
  readAt: null,
};

function fakeStorage(overrides: Partial<EventFeedStorage> = {}) {
  const recorded: NormalizedEventFeedRecordInput[] = [];
  const storage: EventFeedStorage = {
    async record(recordInput): Promise<EventFeedStorageRecordResult> {
      recorded.push(recordInput);
      return { status: "stored", eventId };
    },
    async list() {
      return { events: [item], nextCursor: null };
    },
    async countUnread() {
      return 1;
    },
    async setRead(_userId, requestedEventId, read) {
      return {
        eventId: requestedEventId,
        readAt: read ? "2026-09-09T12:01:00.000Z" : null,
        changed: true,
      };
    },
    async markAllRead() {
      return { updatedCount: 1 };
    },
    ...overrides,
  };
  return { storage, recorded };
}

describe("createEventFeed", () => {
  test("normalizes a case-insensitive Human audience and hints only after storage", async () => {
    const { storage, recorded } = fakeStorage();
    const sequence: string[] = [];
    const feed = createEventFeed({
      storage: {
        ...storage,
        async record(recordInput) {
          sequence.push("stored");
          return storage.record(recordInput);
        },
      },
      onChanged({ userIds }) {
        sequence.push(`hint:${userIds.join(",")}`);
      },
    });

    expect(await feed.recordBestEffort(input)).toEqual({
      status: "stored",
      eventId,
    });
    expect(recorded[0]?.recipientUserIds).toEqual([userA, userB]);
    expect(sequence).toEqual(["stored", `hint:${userA},${userB}`]);
  });

  test("skips an empty audience without creating an orphan event", async () => {
    const { storage, recorded } = fakeStorage();
    const feed = createEventFeed({ storage });

    expect(await feed.recordBestEffort({ ...input, recipientUserIds: [] })).toEqual({
      status: "skipped",
      code: "empty_audience",
    });
    expect(recorded).toHaveLength(0);
  });

  test("contains invalid inputs, storage failures, and conflicting key reuse", async () => {
    const warnings: string[] = [];
    const invalidHarness = fakeStorage();
    const invalidFeed = createEventFeed({
      storage: invalidHarness.storage,
      warn: ({ code }) => warnings.push(code),
    });
    const conflictingShape = {
      ...input,
      data: { artifactId: "artifact-1", roomId },
    } as unknown as EventFeedRecordInput;
    expect(await invalidFeed.recordBestEffort(conflictingShape)).toEqual({
      status: "failed",
      code: "invalid_input",
    });
    expect(invalidHarness.recorded).toHaveLength(0);

    const conflict = fakeStorage({
      async record() {
        return { status: "conflict" };
      },
    });
    expect(await createEventFeed({ storage: conflict.storage }).recordBestEffort(input)).toEqual({
      status: "failed",
      code: "conflicting_key",
    });

    const failed = fakeStorage({
      async record() {
        throw new Error("private database detail");
      },
    });
    expect(await createEventFeed({ storage: failed.storage }).recordBestEffort(input)).toEqual({
      status: "failed",
      code: "storage_failed",
    });
    expect(warnings).toEqual(["invalid_input"]);
  });

  test("does not hint for a duplicate or let hint failure change stored success", async () => {
    let hints = 0;
    const duplicate = fakeStorage({
      async record() {
        return { status: "duplicate", eventId };
      },
    });
    const duplicateFeed = createEventFeed({
      storage: duplicate.storage,
      onChanged() {
        hints += 1;
      },
    });
    expect(await duplicateFeed.recordBestEffort(input)).toEqual({ status: "duplicate", eventId });
    expect(hints).toBe(0);

    const stored = fakeStorage();
    const warnings: string[] = [];
    const storedFeed = createEventFeed({
      storage: stored.storage,
      onChanged() {
        throw new Error("socket unavailable");
      },
      warn: ({ code }) => warnings.push(code),
    });
    expect(await storedFeed.recordBestEffort(input)).toEqual({ status: "stored", eventId });
    expect(warnings).toEqual(["hint_failed"]);
  });

  test("propagates read failures and emits best-effort hints after read changes", async () => {
    const hints: string[][] = [];
    const { storage } = fakeStorage();
    const feed = createEventFeed({
      storage,
      onChanged: ({ userIds }) => {
        hints.push([...userIds]);
      },
    });

    expect(await feed.list(userA)).toEqual({ events: [item], nextCursor: null });
    expect(await feed.countUnread(userA)).toBe(1);
    expect(await feed.setRead(userA, eventId, true)).toMatchObject({ changed: true });
    expect(await feed.markAllRead(userA)).toEqual({ updatedCount: 1 });
    expect(hints).toEqual([[userA], [userA]]);

    const failed = fakeStorage({
      async list() {
        throw new EventFeedQueryError("invalid_cursor");
      },
      async setRead() {
        throw new EventFeedQueryError("not_found");
      },
      async countUnread() {
        throw new Error("database unavailable");
      },
    });
    const failedFeed = createEventFeed({ storage: failed.storage });
    const listError = await failedFeed.list(userA, { cursor: "bad" }).catch((error: unknown) => error);
    const readError = await failedFeed.setRead(userA, eventId, true).catch((error: unknown) => error);
    const countError = await failedFeed.countUnread(userA).catch((error: unknown) => error);
    expect(listError).toMatchObject({ code: "invalid_cursor" });
    expect(readError).toMatchObject({ code: "not_found" });
    expect(countError).toBeInstanceOf(Error);
    expect((countError as Error).message).toBe("database unavailable");
  });
});
