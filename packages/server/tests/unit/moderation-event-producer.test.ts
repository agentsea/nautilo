import { randomUUID } from "node:crypto";
import { expect, mock, test } from "bun:test";
import type { ModerationActionRow } from "@nautilo/db";
import type { EventFeedRecordInput, ModerationReceipt } from "@nautilo/types";
import { createModerationEventProducer } from "../../src/event-feed/moderation-producer";

function fixture() {
  const row: ModerationActionRow = {
    operationId: randomUUID(), requesterUserId: randomUUID(), subjectId: randomUUID(),
    action: "ban", roomId: null, requestDigest: "a".repeat(64), restrictionId: randomUUID(),
    reason: "Private reason", privateNote: "Private note", expiresAt: null, createdAt: new Date(),
    auditRecordedAt: new Date(), convergedAt: null, deleteCommunityMessages: true,
    communityMessagesDeletedAt: new Date(),
  };
  const recordBestEffort = mock(async (_input: EventFeedRecordInput) => ({ status: "stored" as const, eventId: randomUUID() }));
  const authorize = mock(async (): Promise<ModerationReceipt> => ({ operationId: row.operationId,
    action: row.action, roomId: null, restrictionId: row.restrictionId, createdAt: row.createdAt.toISOString(),
    expiresAt: null, committed: true, replayed: true, auditRecorded: true, converged: false }));
  const identity = { actorId: randomUUID(), userId: randomUUID() };
  const identities = mock(async () => identity);
  return { row, recordBestEffort, authorize, identities, identity,
    notify: createModerationEventProducer({ feed: { recordBestEffort }, authorize, identities }) };
}

test("moderation confirmation targets only its authorized requester, with no Room audience or private text", async () => {
  const f = fixture();
  await f.notify(f.row);
  expect(f.authorize).toHaveBeenCalledWith(f.row.requesterUserId, f.row.operationId);
  const input = f.recordBestEffort.mock.calls[0]?.[0];
  expect(input).toEqual({ key: `moderation:${f.row.operationId}`, type: "moderation.action",
    actorKind: "human", actorId: f.identity.actorId, recipientUserIds: [f.row.requesterUserId!],
    data: { operationId: f.row.operationId, action: "ban", userId: f.identity.userId } });
});

test("recovery uses the same occurrence key and refuses newly revoked authority", async () => {
  const f = fixture();
  await f.notify(f.row); await f.notify(f.row);
  expect(f.recordBestEffort.mock.calls.map(call => call[0].key)).toEqual([
    `moderation:${f.row.operationId}`, `moderation:${f.row.operationId}`,
  ]);
  f.authorize.mockImplementation(async () => { throw new Error("revoked"); });
  const failure = await f.notify(f.row).then(() => null, (cause: unknown) => cause);
  expect(failure).toBeInstanceOf(Error);
  expect(f.recordBestEffort).toHaveBeenCalledTimes(2);
});
