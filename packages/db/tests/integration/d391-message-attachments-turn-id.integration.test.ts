/**
 * D391 — durable message attachments: live-Postgres test for the turn-link
 * query surface (stamp + read + fingerprint lookup).
 *
 * Verifies the core mechanism the room history read relies on: a retained
 * attachment stamped with the human message's M134 `fingerprint` (as
 * `turn_id`) is found by `getAttachmentsForTurns([fingerprint])`. This is
 * the join the read-side dedup reconciles on, so an attachment renders once
 * per deduped human turn.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  ensureDatabase,
  createDirectDb,
  eq,
  users,
  agents,
  actors,
  namespaces,
  sessions,
  sessionMessages,
  messageAttachments,
  stampTurnIdOnAttachments,
  getAttachmentsForTurns,
  getSessionMessageFingerprintById,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

let db: ReturnType<typeof createDirectDb>;

const createdUserIds: string[] = [];
const createdAgentIds: string[] = [];
const createdActorIds: string[] = [];
const createdNamespaceIds: string[] = [];
const createdSessionIds: string[] = [];
const createdMessageIds: number[] = [];
const createdAttachmentIds: string[] = [];

beforeAll(async () => {
  bootstrapTestDbInstance();
  await ensureDatabase();
  db = createDirectDb();
});

afterAll(async () => {
  // FK-safe order: attachments -> messages -> sessions -> namespaces -> actors -> agents -> users
  for (const id of createdAttachmentIds) {
    await db.delete(messageAttachments).where(eq(messageAttachments.id, id)).catch(() => {});
  }
  for (const id of createdSessionIds) {
    await db.delete(sessionMessages).where(eq(sessionMessages.sessionId, id)).catch(() => {});
    await db.delete(sessions).where(eq(sessions.id, id)).catch(() => {});
  }
  for (const id of createdNamespaceIds) await db.delete(namespaces).where(eq(namespaces.id, id)).catch(() => {});
  for (const id of createdActorIds) await db.delete(actors).where(eq(actors.id, id)).catch(() => {});
  for (const id of createdAgentIds) await db.delete(agents).where(eq(agents.id, id)).catch(() => {});
  for (const id of createdUserIds) await db.delete(users).where(eq(users.id, id)).catch(() => {});
  await db.end().catch(() => {});
});

async function seed() {
  const ts = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const [user] = await db
    .insert(users)
    .values({ name: `d391-${ts}`, email: `d391-${ts}@test.local` })
    .returning({ id: users.id });
  createdUserIds.push(user!.id);
  const [agent] = await db
    .insert(agents)
    .values({ handle: `d391-${ts}` })
    .returning({ id: agents.id });
  createdAgentIds.push(agent!.id);
  const [actor] = await db
    .insert(actors)
    .values({ ownerId: user!.id, displayName: `d391-${ts}`, kind: "user" })
    .returning({ id: actors.id });
  createdActorIds.push(actor!.id);
  const [ns] = await db
    .insert(namespaces)
    .values({ scope: "room", label: `d391-${ts}` })
    .returning({ id: namespaces.id });
  createdNamespaceIds.push(ns!.id);
  const [session] = await db
    .insert(sessions)
    .values({ threadId: `d391-${ts}`, ownerId: user!.id, personaId: "owner" })
    .returning({ id: sessions.id });
  createdSessionIds.push(session!.id);
  return { userId: user!.id, actorId: actor!.id, namespaceId: ns!.id, sessionId: session!.id, agentId: agent!.id };
}

describe("D391 message attachment turn-link (live DB)", () => {
  test("stamp + read: a retained attachment linked by fingerprint is found by getAttachmentsForTurns", async () => {
    const { actorId, namespaceId, sessionId } = await seed();
    const FINGERPRINT = `fp:v1:human:d391-${Date.now().toString(36)}`;

    // 1) persist a human session_messages row with a known fingerprint
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId, role: "user", content: "d391 hello with image", fingerprint: FINGERPRINT })
      .returning({ id: sessionMessages.id });
    const messageId = Number(msg!.id);
    createdMessageIds.push(messageId);

    // 2) insert a pending attachment, then resolve it to retained (mirrors send)
    const [pendingRow] = await db
      .insert(messageAttachments)
      .values({
        namespaceId,
        uploaderActorId: actorId,
        status: "pending",
        filename: "pic.png",
        mimeType: "image/png",
        sizeBytes: 5,
        storageUri: "file:///tmp/d391-pic.png",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const pending = pendingRow!;
    createdAttachmentIds.push(pending.id);
    await db
      .update(messageAttachments)
      .set({ status: "retained", resolvedAt: new Date(), expiresAt: null })
      .where(eq(messageAttachments.id, pending.id));

    // 3) fingerprint lookup by message id
    const fp = await getSessionMessageFingerprintById(messageId, db);
    expect(fp).toBe(FINGERPRINT);

    // 4) before stamping, getAttachmentsForTurns finds nothing
    const before = await getAttachmentsForTurns([FINGERPRINT], db);
    expect(before).toHaveLength(0);

    // 5) stamp turn_id
    await stampTurnIdOnAttachments({ attachmentIds: [pending.id], turnId: FINGERPRINT }, db);

    // 6) after stamping, getAttachmentsForTurns returns the row, once
    const after = await getAttachmentsForTurns([FINGERPRINT], db);
    expect(after).toHaveLength(1);
    expect(after[0]!.id).toBe(pending.id);
    expect(after[0]!.turnId).toBe(FINGERPRINT);
    expect(after[0]!.status).toBe("retained");
    expect(after[0]!.mimeType).toBe("image/png");

    // 7) idempotent re-stamp (same value) does not duplicate or error
    await stampTurnIdOnAttachments({ attachmentIds: [pending.id], turnId: FINGERPRINT }, db);
    const after2 = await getAttachmentsForTurns([FINGERPRINT], db);
    expect(after2).toHaveLength(1);
  });

  test("getAttachmentsForTurns excludes non-retained rows", async () => {
    const { actorId, namespaceId, sessionId } = await seed();
    const FINGERPRINT = `fp:v1:human:d391-exclude-${Date.now().toString(36)}`;
    const [msg] = await db
      .insert(sessionMessages)
      .values({ sessionId, role: "user", content: "d391 exclude", fingerprint: FINGERPRINT })
      .returning({ id: sessionMessages.id });
    createdMessageIds.push(Number(msg!.id));

    const [pendingRow2] = await db
      .insert(messageAttachments)
      .values({
        namespaceId,
        uploaderActorId: actorId,
        status: "pending",
        filename: "doc.md",
        mimeType: "text/markdown",
        sizeBytes: 3,
        storageUri: "file:///tmp/d391-doc.md",
        expiresAt: new Date(Date.now() + 60_000),
      })
      .returning();
    const pending = pendingRow2!;
    createdAttachmentIds.push(pending.id);
    // resolve as consumed (text path) — not retained
    await db
      .update(messageAttachments)
      .set({ status: "consumed", resolvedAt: new Date(), expiresAt: null })
      .where(eq(messageAttachments.id, pending.id));
    await stampTurnIdOnAttachments({ attachmentIds: [pending.id], turnId: FINGERPRINT }, db);

    const rows = await getAttachmentsForTurns([FINGERPRINT], db);
    expect(rows).toHaveLength(0); // consumed rows are excluded
  });
});
