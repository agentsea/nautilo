import { describe, expect, mock, test } from "bun:test";
import { PgDialect } from "drizzle-orm/pg-core";
import * as actualDb from "@nautilo/db";

let selectedProjection: Record<string, unknown> | null = null;
let ordinaryContentAbsent = true;

const queryBuilder = {
  from: () => queryBuilder,
  innerJoin: () => queryBuilder,
  where: () => queryBuilder,
  limit: async () => [{
    id: 42,
    role: "user",
    ordinaryContentAbsent,
    editRevision: 0,
    fingerprint: "operation:full-peer",
    humanTurnId: "operation:full-peer",
    ownerId: "user:sender",
  }],
};

mock.module("@nautilo/db", () => ({
  ...actualDb,
  db: {
    select: (projection: Record<string, unknown>) => {
      selectedProjection = projection;
      return queryBuilder;
    },
    insert: () => ({
      values: () => ({ onConflictDoNothing: async () => undefined }),
    }),
  },
}));

const { finalizeProtectedHumanPeerMessage } = await import(
  "../../src/messaging/peer-broadcast"
);

const room = {
  id: "room:peer",
  members: [{ kind: "user", userId: "user:sender" }],
} as never;

describe("protected Human-peer finalization", () => {
  test("selects only a compiled ordinary-absence predicate", async () => {
    ordinaryContentAbsent = true;
    await finalizeProtectedHumanPeerMessage({
      room,
      senderUserId: "user:sender",
      messageId: 42,
      operationId: "operation:full-peer",
      attachmentStatuses: [],
    });

    expect(selectedProjection).not.toBeNull();
    expect(Object.keys(selectedProjection!)).not.toContain("content");
    const compiled = new PgDialect().sqlToQuery(
      selectedProjection!["ordinaryContentAbsent"] as actualDb.SQL,
    );
    expect(compiled.sql).toContain('"session_messages"."content" is null');
    expect(compiled.params).toEqual([]);
  });

  test("rejects a row whose ordinary representation is present", async () => {
    ordinaryContentAbsent = false;
    const error = await finalizeProtectedHumanPeerMessage({
      room,
      senderUserId: "user:sender",
      messageId: 42,
      operationId: "operation:full-peer",
      attachmentStatuses: [],
    }).then(() => null, (reason: unknown) => reason);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(
      "Protected Human peer publication identity is unavailable",
    );
  });
});
