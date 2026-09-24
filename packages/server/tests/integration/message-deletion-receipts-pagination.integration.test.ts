import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { eq, messageDeletionReceipts } from "@nautilo/db";
import { inArray, sql } from "drizzle-orm";
import { findMessageDeletionReceiptByReportId } from "../../src/lib/message-deletion-receipts";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

let fixture: AppFixture;
let ownerBearer: string;

beforeAll(async () => {
  fixture = await setupOwnerAppFixture({ suiteName: "receipt-pages", withDefaultAgentGraph: true });
  ownerBearer = await fixture.mintOwnerBearer();
});

afterAll(async () => {
  if (!fixture) return;
  await fixture.db.delete(messageDeletionReceipts)
    .where(eq(messageDeletionReceipts.roomId, fixture.defaultRoomId!));
  await fixture.cleanup();
});

describe("message deletion receipt pagination", () => {
  test("a report ID finds its one indexed deletion receipt", async () => {
    const reportId = randomUUID();
    const operationId = randomUUID();
    await fixture.db.insert(messageDeletionReceipts).values({
      operationId,
      roomId: fixture.defaultRoomId!,
      messageId: 2_000_000_100,
      actorUserId: fixture.ownerId,
      actorId: fixture.ownerActorId,
      source: "content_report",
      authority: "report_action",
      reportId,
      outcome: "deleted",
    });

    try {
      expect(await findMessageDeletionReceiptByReportId(reportId)).toMatchObject({
        operationId,
        reportId,
      });
      expect(await findMessageDeletionReceiptByReportId(randomUUID())).toBeNull();
    } finally {
      await fixture.db.delete(messageDeletionReceipts)
        .where(eq(messageDeletionReceipts.operationId, operationId));
    }
  });

  test("a one-row page can continue through every receipt with equal timestamps", async () => {
    const roomId = fixture.defaultRoomId!;
    const operationIds = Array.from({ length: 3 }, () => randomUUID()).sort().reverse();
    const committedAt = new Date("2026-01-01T00:00:00.000Z");
    await fixture.db.insert(messageDeletionReceipts).values(operationIds.map((operationId, index) => ({
      operationId,
      roomId,
      messageId: 2_000_000_000 + index,
      actorUserId: fixture.ownerId,
      actorId: fixture.ownerActorId,
      source: "room_message" as const,
      authority: "author" as const,
      outcome: "deleted" as const,
      committedAt,
    })));

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let pageNumber = 0; pageNumber < operationIds.length; pageNumber += 1) {
      const response = await authedInject(fixture.app, {
        method: "GET",
        url: `/api/security/message-deletions?roomId=${roomId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        bearer: ownerBearer,
      });
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body) as {
        receipts: Array<{ operationId: string }>;
        nextCursor: string | null;
      };
      expect(body.receipts).toHaveLength(1);
      seen.push(body.receipts[0]!.operationId);
      cursor = body.nextCursor;
      if (pageNumber < operationIds.length - 1) expect(cursor).toBeString();
    }
    expect(cursor).toBeNull();
    expect(seen).toEqual(operationIds);
  });

  test("a one-row page preserves microsecond timestamp order", async () => {
    const roomId = fixture.defaultRoomId!;
    const operationIds = Array.from({ length: 3 }, () => randomUUID());
    const timestamps = [
      "2026-01-01T00:00:00.123900Z",
      "2026-01-01T00:00:00.123500Z",
      "2026-01-01T00:00:00.123100Z",
    ];
    await fixture.db.insert(messageDeletionReceipts).values(operationIds.map((operationId, index) => ({
      operationId,
      roomId,
      messageId: 2_000_000_200 + index,
      actorUserId: fixture.ownerId,
      actorId: fixture.ownerActorId,
      source: "room_message" as const,
      authority: "author" as const,
      outcome: "deleted" as const,
      committedAt: new Date("2026-01-01T00:00:00.000Z"),
    })));
    try {
      for (let index = 0; index < operationIds.length; index += 1) {
        await fixture.db.execute(sql`UPDATE message_deletion_receipts
          SET committed_at = ${timestamps[index]}::timestamptz
          WHERE operation_id = ${operationIds[index]}::uuid`);
      }

      const seen: string[] = [];
      let cursor: string | null = null;
      for (let pageNumber = 0; pageNumber < operationIds.length; pageNumber += 1) {
        const response = await authedInject(fixture.app, {
          method: "GET",
          url: `/api/security/message-deletions?roomId=${roomId}&limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
          bearer: ownerBearer,
        });
        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body) as {
          receipts: Array<{ operationId: string }>;
          nextCursor: string | null;
        };
        expect(body.receipts).toHaveLength(1);
        seen.push(body.receipts[0]!.operationId);
        cursor = body.nextCursor;
      }
      expect(seen).toEqual(operationIds);
    } finally {
      await fixture.db.delete(messageDeletionReceipts)
        .where(inArray(messageDeletionReceipts.operationId, operationIds));
    }
  });
});
