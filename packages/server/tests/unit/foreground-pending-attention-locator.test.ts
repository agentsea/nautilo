import { expect, test } from "bun:test";
import { alias, and, eq, memoryReviewTurns } from "@nautilo/db";
import { drizzle } from "drizzle-orm/postgres-js";

import {
  decodeForegroundPendingAttentionCursor,
  encodeForegroundPendingAttentionCursor,
  foregroundPendingAttentionAfterAnchor,
  resolveForegroundPendingAttentionTurnCoordinates,
  sameForegroundPendingAttentionLocator,
} from "../../src/routes/foreground-pending-attention";
import type { ForegroundCheckpointReadLocator } from
  "../../src/routes/foreground-checkpoint-read-authority";

const ROOM = "00000000-0000-4000-8000-000000000001";
const HUMAN = "00000000-0000-4000-8000-000000000002";
const HUMAN_TWO = "00000000-0000-4000-8000-000000000003";
const AGENT = "00000000-0000-4000-8000-000000000004";
const AGENT_TWO = "00000000-0000-4000-8000-000000000005";
const TURN = "00000000-0000-4000-8000-000000000006";

test("pending-attention coordinates follow direct, group and fork dispatch identities", () => {
  const direct = {
    id: ROOM,
    graphThreadId: "app:default",
    members: [
      { kind: "user" as const },
      { kind: "agent" as const, agentId: AGENT },
    ],
  };
  expect(resolveForegroundPendingAttentionTurnCoordinates(direct, HUMAN, {
    agentId: AGENT,
    threadId: "app:default",
    checkpointThreadId: "app:default",
    turnId: TURN,
  })).toEqual({
    entrypointId: "foreground.main",
    laneKey: `room:${ROOM}`,
  });
  expect(resolveForegroundPendingAttentionTurnCoordinates(direct, HUMAN, {
    agentId: AGENT,
    threadId: "app:default",
    checkpointThreadId: `app:default:fork:${TURN}:deadbeef`,
    turnId: TURN,
  })).toEqual({
    entrypointId: "foreground.fork",
    laneKey: `room:${ROOM}`,
  });

  const group = {
    id: ROOM,
    graphThreadId: `room:${ROOM}`,
    members: [
      { kind: "user" as const },
      { kind: "user" as const },
      { kind: "agent" as const, agentId: AGENT },
      { kind: "agent" as const, agentId: AGENT_TWO },
    ],
  };
  const groupThread = `room:${ROOM}:bot:${AGENT_TWO}`;
  const groupLane = `room:${ROOM}:user:${HUMAN_TWO}:bot:${AGENT_TWO}`;
  expect(resolveForegroundPendingAttentionTurnCoordinates(group, HUMAN_TWO, {
    agentId: AGENT_TWO,
    threadId: groupThread,
    checkpointThreadId: groupThread,
    turnId: TURN,
  })).toEqual({ entrypointId: "foreground.main", laneKey: groupLane });
  expect(resolveForegroundPendingAttentionTurnCoordinates(group, HUMAN_TWO, {
    agentId: AGENT_TWO,
    threadId: groupThread,
    checkpointThreadId: `${groupThread}:fork:${TURN}:0123abcd`,
    turnId: TURN,
  })).toEqual({ entrypointId: "foreground.fork", laneKey: groupLane });

  expect(resolveForegroundPendingAttentionTurnCoordinates(group, HUMAN_TWO, {
    agentId: AGENT_TWO,
    threadId: `room:${ROOM}`,
    checkpointThreadId: `room:${ROOM}`,
    turnId: TURN,
  })).toBeNull();
  expect(resolveForegroundPendingAttentionTurnCoordinates(direct, HUMAN, {
    agentId: AGENT_TWO,
    threadId: "app:default",
    checkpointThreadId: "app:default",
    turnId: TURN,
  })).toBeNull();
  expect(resolveForegroundPendingAttentionTurnCoordinates(direct, HUMAN, {
    agentId: AGENT,
    threadId: "app:default",
    checkpointThreadId: `app:default:fork:${TURN}:not-a-fork`,
    turnId: TURN,
  })).toBeNull();
});

test("pending-attention cursor is canonical and preserves creation order coordinates", () => {
  const input = {
    version: 1 as const,
    createdAt: new Date("2026-09-09T14:05:50.985Z"),
    reviewTurnId: "00000000-0000-4000-8000-000000000007",
  };
  const encoded = encodeForegroundPendingAttentionCursor(input);
  expect(decodeForegroundPendingAttentionCursor(encoded)).toEqual(input);
  expect(decodeForegroundPendingAttentionCursor(`${encoded}=`)).toBeNull();
  expect(decodeForegroundPendingAttentionCursor(Buffer.from(JSON.stringify({
    ...input,
    createdAt: input.createdAt.toISOString(),
    extra: true,
  })).toString("base64url"))).toBeNull();
});

test("pending-attention exact locator identity rejects a reopened generation", () => {
  const locator: ForegroundCheckpointReadLocator = {
    reviewTurnId: "00000000-0000-4000-8000-000000000007",
    generationId: "00000000-0000-4000-8000-000000000008",
    turnId: TURN,
    checkpointThreadId: `room:${ROOM}`,
    threadId: `room:${ROOM}`,
    sessionId: "00000000-0000-4000-8000-000000000009",
    roomId: ROOM,
    topLevelRoomId: ROOM,
    agentId: AGENT,
    namespaceId: "00000000-0000-4000-8000-000000000010",
    accessScope: "namespace",
    firstMessageId: 41,
    createdAt: new Date("2026-09-09T14:05:50.985Z"),
    entrypointId: "foreground.main",
    laneKey: `room:${ROOM}`,
  };
  expect(sameForegroundPendingAttentionLocator(locator, locator)).toBe(true);
  expect(sameForegroundPendingAttentionLocator(locator, {
    ...locator,
    generationId: "00000000-0000-4000-8000-000000000011",
  })).toBe(false);
});

test("pagination compares against the canonical timestamp, not its rounded cursor Date", () => {
  // Real QA coordinate: .426432 in PostgreSQL becomes .426 in JS. Binding
  // that Date in a greater-than predicate would select this same row again.
  const cursor = decodeForegroundPendingAttentionCursor(encodeForegroundPendingAttentionCursor({
    version: 1,
    createdAt: new Date("2026-09-09T16:23:24.426432Z"),
    reviewTurnId: TURN,
  }))!;
  expect(cursor.createdAt.toISOString()).toBe("2026-09-09T16:23:24.426Z");
  const database = drizzle.mock();
  const anchor = alias(memoryReviewTurns, "pending_attention_cursor_anchor");
  const canonicalCreatedAt = database.select({ createdAt: anchor.createdAt })
    .from(anchor).where(and(
      eq(anchor.id, cursor.reviewTurnId), eq(anchor.ownerId, "owner"),
      eq(anchor.actorId, HUMAN), eq(anchor.roomId, ROOM),
    ));
  const query = database.select({ id: memoryReviewTurns.id }).from(memoryReviewTurns)
    .where(foregroundPendingAttentionAfterAnchor(canonicalCreatedAt, cursor.reviewTurnId)).toSQL();
  expect(query.sql).toContain('"created_at" > (select "created_at"');
  expect(query.sql).toContain('"created_at" = (select "created_at"');
  expect(query.sql).toContain('"pending_attention_cursor_anchor"."owner_id"');
  expect(query.sql).toContain('"pending_attention_cursor_anchor"."actor_id"');
  expect(query.sql).toContain('"pending_attention_cursor_anchor"."room_id"');
  expect(query.params).toEqual([TURN, "owner", HUMAN, ROOM, TURN, "owner", HUMAN, ROOM, TURN]);
  expect(query.params).not.toContain(cursor.createdAt.toISOString());
  expect(query.sql).not.toContain('"state"');
});
