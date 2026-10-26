import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { classifyProfileAuthority, readProfileInstanceAuthority } from "@nautilo/instance-discovery/node";
import { appendCanonicalTranscriptRowsInTx, editCanonicalTranscriptMessageInTx, type CanonicalTranscriptAppendRow } from "../../../trust/src/canonical-transcript-mutations";
import { insertAcceptanceInTransaction } from "../../src/queries/work-acceptances";
import { persistJobInTransaction } from "../../src/queries/jobs";
import { insertPrivateRoomBundleTx } from "../../../trust/src/queries";
import { createDirectDb, getSharedDirectDb } from "../../src/config/direct-database";
import { __resetSharedDirectDbForTests } from "../../src/config/database";
import { createDirectAgentDb } from "../../src/config/agent-database";
import { buildBolterBridgeRoleGrantsSql } from "../../src/utils/agent-role-grants";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";
import { assertConnectedDbMarkerMatches } from "../../src/utils/db-identity-guard";
import { ensureDatabase } from "../../src/utils/ensure-database";
import { actors, agents, users, roomMembers, rooms, namespaces, sessions, sessionMessages, sessionMessageDirectedRecipients, jobs, workAcceptances, serverAdmission, bolterConnections, bolterRoomBindings, bolterInboxReceipts, bolterOutbox, bolterExplicitShares } from "../../src/schema";
import { acceptBolterReviewedShareWith, bolterReviewedTextFingerprint, cancelBolterExecutionsForDeletedAgentsInTransaction, acceptBolterInboundWith, attachBolterInboundJobWith, acceptBolterModelSponsorshipWith, loadBolterExecutionWith, linkBolterExecutionAcceptanceWith, startBolterExecutionWith, settleBolterExecutionWith, completeBolterExecutionWith, listRecoverableBolterExecutionsWith, getBolterRecoveryWindowWith, nextBolterRecoverableExecutionWith, getBolterBindingWith, getBolterExecutionInputForReceiptWith, getBolterReceiptMessageIdsWith, getBolterCanonicalAttributionsWith, claimBolterOutboxWith, createBolterConnectionWith, createFreshBolterBindingWith, enqueueBolterOutboxWith, getBolterPublicationClaimWith, loadBolterPublicationContentWith, listBolterConnectionsWith, rotateBolterReceiverWith, setBolterConnectionStateWith, settleBolterOutboxWith, updateBolterBindingStateWith, type BolterBindingContext, type BolterBridgeDatabase, type BolterBridgeTransaction, type BolterReceiverContext, type ExternalRoomJobReference } from "../../src/queries/bolter-bridge";

import { acquireExternalRoomExecutionClaimWith, releaseExternalRoomExecutionClaimWith, type ExternalRoomExecutionClaim } from "../../src/queries/external-room-execution-claims";
import { updateJobStatusWithDatabase } from "../../src/queries/jobs";

type Admin = ReturnType<typeof createDirectDb>;
type Tx = Parameters<Parameters<Admin["transaction"]>[0]>[0];
type Fixture = { owner: string; otherOwner: string; agent: string; humanActor: string; agentActor: string; roomIds: string[]; namespaceIds: string[]; acceptanceIds: string[] };
let admin: Admin;
let product: ReturnType<typeof getSharedDirectDb>;
let agentPool: ReturnType<typeof createDirectAgentDb>;
let cleanedFixtures = 0;
let ledgerDirectory: string;
const pendingFixtures = new Map<string, Fixture>();
function persistCleanupLedger() {
  writeFileSync(join(ledgerDirectory, "synthetic-fixtures.json"), JSON.stringify([...pendingFixtures.values()]), { mode: 0o600 });
}

beforeAll(async () => {
  if (bootstrapTestDbInstance() !== "test-cruft") throw new Error("Bolter fixtures require the authorized disposable scratch instance");
  // Preserve concurrent scratch work: do not reset schema or rotate credentials.
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  const instance = resolveInstance();
  const authority = classifyProfileAuthority("test-cruft", readProfileInstanceAuthority(homedir()));
  if (instance.instanceId !== "test-cruft" || existsSync(`${resolveNautiloRootDir()}/.protected-instance`)
    || (authority !== null && authority.retention !== "disposable")) throw new Error("Scratch retention authority is unavailable");
  await assertConnectedDbMarkerMatches(instance.db.directConnection);
  ledgerDirectory = mkdtempSync(join(tmpdir(), "bolter-db-fixtures-"));
  chmodSync(ledgerDirectory, 0o700);
  await ensureDatabase();
  admin = createDirectDb(1);
  product = getSharedDirectDb();
  agentPool = createDirectAgentDb(3);
  const [productRole] = await product.execute(sql`SELECT session_user AS session, current_user AS current`);
  const [agentRole] = await agentPool.execute(sql`SELECT session_user AS session, current_user AS current`);
  expect(productRole).toMatchObject({ session: "nautilo", current: "nautilo" });
  expect(agentRole).toMatchObject({ session: "nautilo_agent", current: "nautilo_agent" });
}, 60_000);
afterAll(async () => {
  try {
    for (const fixture of pendingFixtures.values()) await cleanupFixture(fixture);
    console.info(`Bolter fixture cleanup checks passed: ${cleanedFixtures}; tracked fixtures remaining: ${pendingFixtures.size}`);
    if (ledgerDirectory && pendingFixtures.size === 0) rmSync(ledgerDirectory, { recursive: true });
  } finally {
    if (pendingFixtures.size) console.error(`Synthetic cleanup ledger retained: ${ledgerDirectory}`);
    if (agentPool) await agentPool.end();
    await __resetSharedDirectDbForTests();
    if (admin) await admin.end();
  }
});

class FixtureRollback extends Error {}
async function withFixture(run: (tx: Tx, fixture: Fixture, db: BolterBridgeDatabase) => Promise<void>) {
  const fixture: Fixture = { owner: randomUUID(), otherOwner: randomUUID(), agent: randomUUID(), humanActor: randomUUID(), agentActor: randomUUID(), roomIds: [], namespaceIds: [], acceptanceIds: [] };
  pendingFixtures.set(fixture.owner, fixture);
  persistCleanupLedger();
  try {
    await admin.transaction(async tx => {
      await tx.insert(users).values([{ id: fixture.owner, name: `Bolter fixture owner ${fixture.owner}` }, { id: fixture.otherOwner, name: `Bolter fixture other owner ${fixture.owner}` }]);
      await tx.insert(serverAdmission).values([{ userId: fixture.owner, admitted: true }, { userId: fixture.otherOwner, admitted: true }]);
      await tx.insert(agents).values({ id: fixture.agent, handle: `bolter-fixture-${fixture.agent}` });
      await tx.insert(actors).values([{ id: fixture.humanActor, ownerId: fixture.owner, displayName: "Bolter fixture Human", kind: "user" }, { id: fixture.agentActor, ownerId: fixture.owner, displayName: "Bolter fixture Genie", kind: "agent", agentId: fixture.agent }]);
    });
    await agentPool.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
      await tx.execute(sql`SELECT set_config('app.current_agent_id', ${fixture.agent}, true)`);
      const role = await tx.execute(sql`SELECT current_user AS name`);
      expect(role[0]?.["name"]).toBe("nautilo_agent");
      // Lifecycle writes commit through the real agent pool so the separate product
      // claim transaction sees canonical Jobs. Exact fixture cleanup remains mandatory.
      await run(tx, fixture, agentPool);
      throw new FixtureRollback();
    });
  } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
  finally { await cleanupFixture(fixture); }
}

/** All coordinates were generated and recorded before committed fixture setup. */
async function cleanupFixture(fixture: Fixture) {
    await admin.transaction(async tx => {
      const owners = [fixture.owner, fixture.otherOwner];
      await tx.delete(bolterOutbox).where(inArray(bolterOutbox.userId, owners));
      await tx.delete(bolterExplicitShares).where(inArray(bolterExplicitShares.userId, owners));
      await tx.delete(bolterInboxReceipts).where(inArray(bolterInboxReceipts.userId, owners));
      await tx.delete(bolterRoomBindings).where(inArray(bolterRoomBindings.userId, owners));
      await tx.delete(bolterConnections).where(inArray(bolterConnections.userId, owners));
      if (fixture.acceptanceIds.length) await tx.delete(workAcceptances).where(inArray(workAcceptances.id, fixture.acceptanceIds));
      await tx.delete(jobs).where(or(inArray(jobs.ownerId, owners), inArray(jobs.requestorId, owners)));
      if (fixture.roomIds.length) await tx.delete(rooms).where(and(inArray(rooms.id, fixture.roomIds), eq(rooms.kind, "subthread")));
      await tx.execute(sql`DELETE FROM public.session_messages WHERE session_id IN (SELECT id FROM public.sessions WHERE owner_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))`);
      await tx.delete(sessions).where(inArray(sessions.ownerId, owners));
      if (fixture.roomIds.length) await tx.delete(rooms).where(inArray(rooms.id, fixture.roomIds));
      if (fixture.namespaceIds.length) await tx.delete(namespaces).where(inArray(namespaces.id, fixture.namespaceIds));
      await tx.delete(actors).where(inArray(actors.ownerId, owners));
      await tx.delete(agents).where(eq(agents.id, fixture.agent));
      await tx.delete(users).where(inArray(users.id, owners));
    });
    const [remaining] = await admin.execute(sql`SELECT
      (SELECT count(*) FROM public.users WHERE id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.actors WHERE owner_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.agents WHERE id = ${fixture.agent}::uuid)
      + (SELECT count(*) FROM public.bolter_connections WHERE user_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.bolter_room_bindings WHERE user_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.bolter_inbox_receipts WHERE user_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.bolter_explicit_shares WHERE user_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.bolter_outbox WHERE user_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.sessions WHERE owner_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.jobs WHERE owner_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid) OR requestor_id IN (${fixture.owner}::uuid,${fixture.otherOwner}::uuid))
      + (SELECT count(*) FROM public.work_acceptances WHERE id = ANY(${`{${fixture.acceptanceIds.join(",")}}`}::uuid[]))
      + (SELECT count(*) FROM public.external_room_execution_claims WHERE room_id = ANY(${`{${fixture.roomIds.join(",")}}`}::uuid[]))
      + (SELECT count(*) FROM public.rooms WHERE id = ANY(${`{${fixture.roomIds.join(",")}}`}::uuid[]))
      + (SELECT count(*) FROM public.namespaces WHERE id = ANY(${`{${fixture.namespaceIds.join(",")}}`}::uuid[])) AS rows`);
    expect(Number(remaining?.["rows"])).toBe(0);
    cleanedFixtures++;
    pendingFixtures.delete(fixture.owner);
    persistCleanupLedger();
}

async function receiver(_db: BolterBridgeDatabase, fixture: Fixture, suffix = "home"): Promise<BolterReceiverContext> {
  const c = await createBolterConnectionWith(agentPool, { userId: fixture.owner }, { relayId: `fixture-relay-${fixture.owner}`, desktopSessionId: "fixture-desktop", pairingGenerationRef: "fixture-pairing", homeHandle: suffix, origin: "https://bolter.chat", providerAgentId: "abc12345", identityFingerprint: "a".repeat(64) });
  return { userId: fixture.owner, connectionId: c.id, connectionGeneration: c.generation, relayId: c.relayId, desktopSessionId: c.desktopSessionId, pairingGenerationRef: c.pairingGenerationRef };
}
/** Canonical minting uses a connection actually authenticated as the product role. */
async function mintRoom(tx: BolterBridgeTransaction, params: Parameters<typeof insertPrivateRoomBundleTx>[1], fixture: Fixture) {
  fixture.roomIds.push(params.roomId);
  persistCleanupLedger();
  const bundle = await insertPrivateRoomBundleTx(tx, params);
  fixture.namespaceIds.push(bundle.namespaceId);
  persistCleanupLedger();
  return bundle;
}
async function freshBinding(_db: BolterBridgeDatabase, fixture: Fixture, ctx: BolterReceiverContext, chatId = "abc12345", sponsored = true) {
  const binding = await createFreshBolterBindingWith(product, ctx, async tx => {
    const roomId = randomUUID();
    const { namespaceId } = await mintRoom(tx, { roomId, ownerUserId: fixture.owner, label: `Bolter fixture ${roomId}`, graphThreadId: `room:${roomId}`, humanActorIds: [fixture.humanActor], memberRows: [{ actorId: fixture.humanActor, roomRole: "admin" }, { actorId: fixture.agentActor, roomRole: "member", agentResponseMode: "mention_only" }], createdByActorId: fixture.humanActor, externalContext: true }, fixture);
    return { roomId, namespaceId, agentId: fixture.agent, chatId, threadId: "", modelSponsorshipAccepted: sponsored };
  });
  return { binding, ctx: { ...ctx, bindingId: binding.id, bindingRevision: binding.revision } satisfies BolterBindingContext };
}
async function canonical(tx: BolterBridgeTransaction, fixture: Fixture, roomId: string, role: "user" | "assistant", turnId?: string) {
  const [session] = await tx.insert(sessions).values({ ownerId: fixture.owner, agentId: fixture.agent, roomId, threadId: `fixture:${randomUUID()}` }).returning();
  const [message] = await tx.insert(sessionMessages).values({ sessionId: session!.id, role, content: "Synthetic Bolter fixture text", humanTurnId: turnId ?? null }).returning();
  return message!.id;
}
const sourceText = "Synthetic Bolter fixture text";
const digest = (parts: readonly unknown[]) => createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function sourceOrigin(ctx: BolterBindingContext, providerMessageId: string, binding: { origin: string; providerAgentId: string; chatId: string; threadId: string }) {
  return { kind: "external_message", version: 1, provider: "bolter", origin: binding.origin,
    connectionId: ctx.connectionId, bindingId: ctx.bindingId, providerAgentId: binding.providerAgentId,
    chatId: binding.chatId, threadRootId: binding.threadId || null, messageId: providerMessageId,
    senderId: "outside-fixture", senderType: "user", senderLabel: "Synthetic outside speaker", createdAt: "2026-01-01T00:00:00Z" } as const;
}
function sourceFingerprint(origin: ReturnType<typeof sourceOrigin>) {
  return digest([origin.provider, origin.origin, origin.providerAgentId, origin.chatId, origin.threadRootId, origin.messageId,
    origin.senderId, origin.senderType, origin.createdAt, sourceText]);
}
function plainRow(input: Pick<CanonicalTranscriptAppendRow, "role" | "content" | "fingerprint" | "humanTurnId" | "metadata" | "replyToMessageId">): CanonicalTranscriptAppendRow {
  return { ...input, toolCalls: null, toolName: null, transcriptOrigin: "main", parentThreadId: null, scopeId: null, subthreadRoomId: null };
}
function inputReference(receiptId: string, acceptanceId: string, binding: { id: string; revision: number; roomId: string; agentId: string }, ctx: BolterBindingContext, turnId: string): ExternalRoomJobReference {
  return { kind: "external_room_turn_v1", receiptId, acceptanceId, bindingId: binding.id, bindingRevision: binding.revision,
    connectionGeneration: ctx.connectionGeneration, roomId: binding.roomId, agentId: binding.agentId, turnId };
}
async function accept(db: BolterBridgeDatabase, fixture: Fixture, ctx: BolterBindingContext, providerMessageId = "abc12345") {
  const binding = await getBolterBindingWith(db, { userId: fixture.owner }, ctx.bindingId);
  const origin = sourceOrigin(ctx, providerMessageId, binding!);
  return acceptBolterInboundWith(db, ctx, { providerMessageId, fingerprint: sourceFingerprint(origin), externalSenderId: "outside-fixture" }, async (tx, locked, receiptId) => {
    const turnId = randomUUID();
    const acceptanceId = randomUUID();
    fixture.acceptanceIds.push(acceptanceId); persistCleanupLedger();
    await insertAcceptanceInTransaction(tx, "foreground", acceptanceId);
    const reference: ExternalRoomJobReference = { kind: "external_room_turn_v1", receiptId, acceptanceId, bindingId: locked.id,
      bindingRevision: locked.revision, connectionGeneration: ctx.connectionGeneration, roomId: locked.roomId, agentId: locked.agentId, turnId };
    const appended = await appendCanonicalTranscriptRowsInTx(tx, {
      session: { threadId: `room:${locked.roomId}:bot:${locked.agentId}`, ownerId: fixture.owner, personaId: "owner", agentId: locked.agentId, roomId: locked.roomId, title: "Synthetic external conversation" },
      rows: [plainRow({ role: "user", content: sourceText, fingerprint: digest(["external-room-input-v1", receiptId]), humanTurnId: turnId,
        replyToMessageId: null, metadata: { externalOrigin: origin, externalReceiptId: receiptId } })],
      notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] },
    });
    if (appended.failedIndices.length || !appended.insertedRows[0]) throw new Error("Canonical fixture intake failed");
    const jobId = await persistJobInTransaction(tx, { ownerId: fixture.owner, requestorId: fixture.owner, roomId: locked.roomId,
      laneKey: `room:${locked.roomId}`, type: "foreground", input: { ...reference } });
    return { sessionMessageId: Number(appended.insertedRows[0].id), turnId, jobId };
  });
}
async function fixtureClaim(fixture: Fixture, jobId: string): Promise<ExternalRoomExecutionClaim> {
  const result = await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, jobId);
  if (result.kind !== "claimed") throw new Error("Synthetic claim unavailable");
  return result;
}
async function finish(db: BolterBridgeDatabase, fixture: Fixture, receiptId: string) {
  const input = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, receiptId);
  if (!input) throw new Error("Fixture execution reference unavailable");
  expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, input)).toBe("linked");
  const claim = await fixtureClaim(fixture, input.jobId);
  expect(await startBolterExecutionWith(db, { userId: fixture.owner }, { ...input, executionClaim: claim })).toBe("started");
  try {
  const outbox = await completeBolterExecutionWith(db, { userId: fixture.owner }, input, async (tx, execution) => {
    const fingerprint = digest(["external-room-final-v1", receiptId, input.jobId, "Synthetic final response"]);
    const appended = await appendCanonicalTranscriptRowsInTx(tx, {
      session: { threadId: execution.session.threadId, ownerId: fixture.owner, personaId: "owner", agentId: execution.binding.agentId, roomId: execution.binding.roomId, title: "Synthetic external conversation" },
      rows: [plainRow({ role: "assistant", content: "Synthetic final response", fingerprint, humanTurnId: null,
        replyToMessageId: execution.receipt.sessionMessageId, metadata: { externalFinalReply: { kind: "bolter_final_reply_v1", receiptId,
          jobId: input.jobId, turnId: input.reference.turnId, acceptanceId: input.reference.acceptanceId } } })],
      notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] },
    });
    if (appended.failedIndices.length || !appended.insertedRows[0]) throw new Error("Canonical fixture reply failed");
    return { sessionMessageId: Number(appended.insertedRows[0].id), fingerprint };
  });
  if (!outbox) throw new Error("Fixture final publication unavailable");
  const facts = await admin.select().from(sessionMessageDirectedRecipients).where(eq(sessionMessageDirectedRecipients.messageId, outbox.sessionMessageId!));
  expect(facts.some(row => row.reason === "direct_room" && row.recipientId === fixture.owner)).toBe(true);
  expect(facts.some(row => row.reason === "explicit_reply" || row.reason === "agent_response")).toBe(false);
  return outbox;
  } finally { expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true); }
}

describe("Bolter actual PostgreSQL authority and lifecycle", () => {
  test("durable claims serialize same Job, imported versus local work, and Stop until quiescence", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Synthetic intake unavailable");
    const input = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, accepted.receipt.id);
    if (!input) throw new Error("Synthetic execution unavailable");
    const window = await getBolterRecoveryWindowWith(db, { userId: fixture.owner });
    expect(window).not.toBeNull();
    const next = await nextBolterRecoverableExecutionWith(db, { userId: fixture.owner }, { upperBound: window! });
    expect(next?.execution).toEqual(input);
    expect(await nextBolterRecoverableExecutionWith(db, { userId: fixture.owner }, { upperBound: window!, after: next!.cursor })).toBeNull();
    const results = await Promise.all([1, 2].map(() => acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, input.jobId)));
    expect(results.filter(result => result.kind === "claimed")).toHaveLength(1);
    expect(results.filter(result => result.kind === "busy")).toHaveLength(1);
    const claim = results.find(result => result.kind === "claimed");
    if (!claim || claim.kind !== "claimed") throw new Error("Synthetic claim unavailable");
    const localJobId = await agentPool.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
      return persistJobInTransaction(tx, { ownerId: fixture.owner, requestorId: fixture.owner, roomId: first.binding.roomId,
        laneKey: `room:${first.binding.roomId}`, type: "foreground", input: { synthetic: true } });
    });
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.otherOwner }, localJobId)).toEqual({ kind: "unavailable" });
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, localJobId)).toEqual({ kind: "busy" });
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, { ...claim, token: randomUUID() })).toBe(false);
    expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, input)).toBe("linked");
    expect(await startBolterExecutionWith(db, { userId: fixture.owner }, { ...input, executionClaim: claim })).toBe("started");
    expect(await settleBolterExecutionWith(db, { userId: fixture.owner }, { ...input, status: "cancelled", expectedPredecessor: "running", reason: "user_stop" })).toEqual({ kind: "transitioned", status: "cancelled" });
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, localJobId)).toEqual({ kind: "busy" });
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true);
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true);
    const localClaim = await fixtureClaim(fixture, localJobId);
    await updateJobStatusWithDatabase(product, localJobId, "running", undefined, undefined, localClaim);
    // No model/executor exists in this fixture. Release simulates quiescence,
    // leaving a legacy running row: an empty claim table still cannot admit work.
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, localClaim)).toBe(true);
    const another = await accept(db, fixture, first.ctx, "synthetic-next");
    if (another.status !== "accepted") throw new Error("Synthetic second intake unavailable");
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, another.receipt.jobId!)).toEqual({ kind: "busy" });
    await updateJobStatusWithDatabase(product, localJobId, "cancelled");
    const orphanClaim = await fixtureClaim(fixture, another.receipt.jobId!);
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, orphanClaim)).toBe(true);
  }));

  test("inherited external subthread serializes distinct Jobs and archived parent denies admission", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const source = await accept(db, fixture, first.ctx);
    if (source.status !== "accepted") throw new Error("Synthetic source unavailable");
    const child = randomUUID(); fixture.roomIds.push(child); persistCleanupLedger();
    await admin.transaction(async tx => {
      await tx.insert(rooms).values({ id: child, ownerId: fixture.owner, namespaceId: first.binding.namespaceId,
        type: "private", kind: "subthread", label: "Synthetic inherited thread", graphThreadId: `room:${child}`,
        parentRoomId: first.binding.roomId, threadRootMessageId: source.receipt.sessionMessageId!, humanActorIds: [fixture.humanActor] });
      await tx.insert(roomMembers).values([{ roomId: child, actorId: fixture.humanActor }, { roomId: child, actorId: fixture.agentActor }]);
    });
    const jobIds = await agentPool.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
      return Promise.all([1, 2].map(() => persistJobInTransaction(tx, { ownerId: fixture.owner, requestorId: fixture.owner,
        roomId: child, laneKey: `room:${child}`, type: "foreground", input: { synthetic: true } })));
    });
    const [raw] = await product.select({ external: rooms.externalContext }).from(rooms).where(eq(rooms.id, child));
    expect(raw?.external).toBe(false);
    await Promise.resolve(expect(updateJobStatusWithDatabase(product, jobIds[0]!, "running")).rejects.toThrow());
    const race = await Promise.all(jobIds.map(jobId => acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, jobId)));
    expect(race.filter(result => result.kind === "claimed")).toHaveLength(1);
    expect(race.filter(result => result.kind === "busy")).toHaveLength(1);
    const claim = race.find(result => result.kind === "claimed");
    if (!claim || claim.kind !== "claimed") throw new Error("Synthetic inherited claim unavailable");
    await product.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, first.binding.roomId));
    await Promise.resolve(expect(updateJobStatusWithDatabase(product, claim.jobId, "running", undefined, undefined, claim)).rejects.toThrow());
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true);
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim.jobId)).toEqual({ kind: "unavailable" });
    await product.update(rooms).set({ archivedAt: null }).where(eq(rooms.id, first.binding.roomId));
    const retained = await fixtureClaim(fixture, claim.jobId);
    await product.delete(jobs).where(eq(jobs.id, claim.jobId));
    expect(await acquireExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, jobIds.find(id => id !== claim.jobId)!)).toEqual({ kind: "busy" });
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, retained)).toBe(true);
  }));

  test("agent cannot read claims, call private admission, forge a running insert, or use a wrong token", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Synthetic intake unavailable");
    await agentPool.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
      await Promise.resolve(expect(tx.transaction(inner => inner.execute(sql`SELECT room_id FROM public.external_room_execution_claims`))).rejects.toThrow());
      await Promise.resolve(expect(tx.transaction(inner => inner.execute(sql`SELECT public.external_room_job_start_allowed(${fixture.owner}::uuid,${first.binding.roomId}::uuid,${accepted.receipt.jobId}::uuid,${randomUUID()}::uuid)`))).rejects.toThrow());
      await tx.execute(sql`SELECT set_config('app.external_room_execution_token', ${randomUUID()}, true)`);
      await Promise.resolve(expect(tx.transaction(inner => inner.update(jobs).set({ status: "running", startedAt: new Date() }).where(eq(jobs.id, accepted.receipt.jobId!)))).rejects.toThrow());
      await Promise.resolve(expect(tx.transaction(inner => inner.insert(jobs).values({ ownerId: fixture.owner, requestorId: fixture.owner,
        roomId: first.binding.roomId, type: "foreground", status: "running", startedAt: new Date(), input: { synthetic: true } }))).rejects.toThrow());
    });
    const claim = await fixtureClaim(fixture, accepted.receipt.jobId!);
    await agentPool.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.otherOwner}, true)`);
      await tx.execute(sql`SELECT set_config('app.external_room_execution_token', ${claim.token}, true)`);
      await Promise.resolve(expect(tx.transaction(inner => inner.update(jobs).set({ status: "running", startedAt: new Date() }).where(eq(jobs.id, accepted.receipt.jobId!)))).rejects.toThrow());
    });
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true);
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true);
  }));

  test("forced RLS and bounded role privileges survive ordinary startup repair", async () => {
    const rows = await admin.execute(sql`SELECT c.relname, c.relrowsecurity, c.relforcerowsecurity,
      has_table_privilege('nautilo_agent', c.oid, 'SELECT') AS agent_select,
      has_table_privilege('nautilo_agent', c.oid, 'DELETE') AS agent_delete,
      has_table_privilege('nautilo', c.oid, 'SELECT') AS product_select,
      has_table_privilege('nautilo', c.oid, 'DELETE') AS product_delete
      FROM pg_class c WHERE c.relname IN ('bolter_connections','bolter_room_bindings','bolter_inbox_receipts','bolter_outbox')`);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toMatchObject({ relrowsecurity: true, relforcerowsecurity: true, agent_select: true, agent_delete: false, product_delete: true, product_select: ["bolter_connections", "bolter_room_bindings"].includes(String(row["relname"])) });
    const [helper] = await admin.execute(sql`SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig FROM pg_proc p WHERE p.oid = 'public.bolter_room_admission(uuid,uuid,uuid,uuid)'::regprocedure`);
    expect(helper).toMatchObject({ prosecdef: true, owner: "nautilo", proconfig: ["search_path=pg_catalog"] });
  });

  test("restricted helper denies forged GUC and cross-owner scans without exposing raw users", async () => withFixture(async (tx, fixture, db) => {
    const receiverCtx = await receiver(db, fixture);
    const { binding } = await freshBinding(db, fixture, receiverCtx);
    expect(await listBolterConnectionsWith(db, { userId: fixture.otherOwner })).toHaveLength(0);
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.otherOwner}, true)`);
    const [denied] = await tx.execute(sql`SELECT public.bolter_room_admission(${fixture.owner}::uuid, ${binding.roomId}::uuid, ${binding.namespaceId}::uuid, ${fixture.agent}::uuid) AS allowed`);
    expect(denied?.["allowed"]).toBe(false);
    await Promise.resolve(expect(tx.transaction(inner => inner.execute(sql`SELECT id FROM public.users LIMIT 0`))).rejects.toThrow());
    await Promise.resolve(expect(tx.transaction(inner => inner.delete(bolterConnections).where(eq(bolterConnections.id, receiverCtx.connectionId)))).rejects.toThrow());
    // As in withTrustContext everywhere, GUCs are established by trusted server
    // authentication; arbitrary SQL that sets another user's GUC is not auth.
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
    const [allowed] = await tx.execute(sql`SELECT public.bolter_room_admission(${fixture.owner}::uuid, ${binding.roomId}::uuid, ${binding.namespaceId}::uuid, ${fixture.agent}::uuid) AS allowed`);
    expect(allowed?.["allowed"]).toBe(true);
  }));

  test("canonical factory rolls back on binding failure and cannot convert ordinary Room context", async () => withFixture(async (tx, fixture, db) => {
    const receiverCtx = await receiver(db, fixture);
    const roomId = randomUUID();
    let namespaceId = "";
    await Promise.resolve(expect(createFreshBolterBindingWith(product, receiverCtx, async inner => {
      const bundle = await mintRoom(inner, { roomId, ownerUserId: fixture.owner, label: "Rollback fixture", graphThreadId: `room:${roomId}`, humanActorIds: [fixture.humanActor], memberRows: [{ actorId: fixture.humanActor, roomRole: "admin" }, { actorId: fixture.agentActor, roomRole: "member" }], createdByActorId: fixture.humanActor, externalContext: true }, fixture);
      namespaceId = bundle.namespaceId;
      return { roomId, namespaceId, agentId: randomUUID(), chatId: "fixture-chat", threadId: "" };
    })).rejects.toThrow());
    expect(await admin.select().from(rooms).where(eq(rooms.id, roomId))).toHaveLength(0);
    expect(await admin.select().from(namespaces).where(eq(namespaces.id, namespaceId))).toHaveLength(0);
    const ordinaryRoomId = randomUUID();
    await product.transaction(inner => mintRoom(inner, { roomId: ordinaryRoomId, ownerUserId: fixture.owner, label: "Ordinary fixture", graphThreadId: `room:${ordinaryRoomId}`, humanActorIds: [fixture.humanActor], memberRows: [{ actorId: fixture.humanActor, roomRole: "admin" }], createdByActorId: fixture.humanActor }, fixture));
    await Promise.resolve(expect(tx.transaction(inner => inner.update(rooms).set({ externalContext: true }).where(eq(rooms.id, ordinaryRoomId)))).rejects.toThrow());
  }));

  test("same provider short IDs in distinct connections stay separate; conflicting receipt quarantines without replacing canonical content", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture, "first"));
    const second = await freshBinding(db, fixture, await receiver(db, fixture, "second"));
    const accepted = await accept(db, fixture, first.ctx);
    const other = await accept(db, fixture, second.ctx);
    expect(accepted.status).toBe("accepted"); expect(other.status).toBe("accepted");
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    let repeated = 0;
    const duplicate = await acceptBolterInboundWith(db, first.ctx, { providerMessageId: "abc12345", fingerprint: accepted.receipt.fingerprint, externalSenderId: "outside-fixture" }, async () => { repeated++; throw new Error("Duplicate must not persist"); });
    expect(duplicate.status).toBe("duplicate"); expect(repeated).toBe(0);
    const outbox = await finish(db, fixture, accepted.receipt.id);
    const conflict = await acceptBolterInboundWith(db, first.ctx, { providerMessageId: "abc12345", fingerprint: "c".repeat(64), externalSenderId: "outside-fixture" }, async () => { throw new Error("Collision must not persist"); });
    expect(conflict.status).toBe("quarantined");
    if (conflict.status !== "quarantined") throw new Error("Fixture quarantine failed");
    expect(conflict.receipt.sessionMessageId).toBe(accepted.receipt.sessionMessageId);
    expect(conflict.receipt.fingerprint).toBe(accepted.receipt.fingerprint);
    const [cancelled] = await tx.select().from(bolterOutbox).where(eq(bolterOutbox.id, outbox.id));
    expect(cancelled?.state).toBe("cancelled");
    await Promise.resolve(expect(tx.transaction(inner => inner.update(bolterInboxReceipts).set({ fingerprint: "c".repeat(64) }).where(eq(bolterInboxReceipts.id, accepted.receipt.id)))).rejects.toThrow());
  }));

  test("canonical source and composite owner mismatches fail in PostgreSQL", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const second = await freshBinding(db, fixture, first.ctx, "different-chat");
    const wrongMessage = await canonical(tx, fixture, second.binding.roomId, "assistant");
    expect(() => enqueueBolterOutboxWith(db, first.ctx, { sessionMessageId: wrongMessage, fingerprint: "d".repeat(64), explicitShareId: randomUUID() })).toThrow();
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.otherOwner}, true)`);
    await Promise.resolve(expect(tx.transaction(inner => inner.insert(bolterRoomBindings).values({ userId: fixture.otherOwner, connectionId: first.ctx.connectionId, roomId: first.binding.roomId, namespaceId: first.binding.namespaceId, agentId: fixture.agent, origin: "https://example.test", providerAgentId: "abc12345", chatId: "forged-chat", threadId: "" }))).rejects.toThrow());
    await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    expect(await attachBolterInboundJobWith(db, first.ctx, { receiptId: accepted.receipt.id, jobId: randomUUID() })).toBeNull();
  }));

  test("claims are CAS and uncertain provider sends stay terminal", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const outbox = await finish(db, fixture, accepted.receipt.id);
    const claim = await claimBolterOutboxWith(db, first.ctx, outbox.id);
    expect(claim?.state).toBe("publishing");
    expect(await claimBolterOutboxWith(db, first.ctx, outbox.id)).toBeNull();
    expect(await getBolterPublicationClaimWith(db, first.ctx, { outboxId: outbox.id, claimToken: randomUUID() })).toBeNull();
    expect((await settleBolterOutboxWith(db, first.ctx, { outboxId: outbox.id, claimToken: claim!.claimToken!, state: "uncertain" }))?.state).toBe("uncertain");
    expect(await claimBolterOutboxWith(db, first.ctx, outbox.id)).toBeNull();
    await Promise.resolve(expect(tx.transaction(inner => inner.update(bolterOutbox).set({ state: "pending", claimToken: null }).where(eq(bolterOutbox.id, outbox.id)))).rejects.toThrow());
  }));

  test("claimed publication loads only the exact current canonical final reply", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const other = await freshBinding(db, fixture, first.ctx, "different-publication-chat");
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const outbox = await finish(db, fixture, accepted.receipt.id);
    expect(await loadBolterPublicationContentWith(db, first.ctx, { outboxId: outbox.id, claimToken: randomUUID() })).toBeNull();
    const claim = await claimBolterOutboxWith(db, first.ctx, outbox.id);
    if (!claim?.claimToken) throw new Error("Fixture publication claim unavailable");
    const input = { outboxId: outbox.id, claimToken: claim.claimToken };
    expect(await loadBolterPublicationContentWith(db, first.ctx, input)).toEqual({
      origin: "https://bolter.chat", providerAgentId: "abc12345", chatId: "abc12345", threadRootId: null,
      content: "Synthetic final response",
    });
    expect(await loadBolterPublicationContentWith(db, other.ctx, input)).toBeNull();
    expect(await loadBolterPublicationContentWith(db, { ...first.ctx, userId: fixture.otherOwner }, input)).toBeNull();
    expect(await loadBolterPublicationContentWith(db, { ...first.ctx, connectionGeneration: 2 }, input)).toBeNull();
    expect(await loadBolterPublicationContentWith(db, first.ctx, { ...input, claimToken: randomUUID() })).toBeNull();
    await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 0, state: "paused" });
    expect(await loadBolterPublicationContentWith(db, first.ctx, input)).toBeNull();
  }));

  test("mixed revoked/active bindings revoke atomically and retain permanent context fence", async () => withFixture(async (tx, fixture, db) => {
    const receiverCtx = await receiver(db, fixture);
    const retired = await freshBinding(db, fixture, receiverCtx, "retired");
    const active = await freshBinding(db, fixture, receiverCtx, "active");
    await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: retired.binding.id, expectedRevision: 0, state: "revoked" });
    const accepted = await accept(db, fixture, active.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const outbox = await finish(db, fixture, accepted.receipt.id);
    await claimBolterOutboxWith(db, active.ctx, outbox.id);
    const revoked = await setBolterConnectionStateWith(db, { userId: fixture.owner }, { connectionId: receiverCtx.connectionId, expectedRevision: 0, enabled: false, revoke: true });
    expect(revoked?.revokedAt).not.toBeNull();
    expect((await tx.select().from(bolterOutbox).where(eq(bolterOutbox.id, outbox.id)))[0]?.state).toBe("uncertain");
    expect((await tx.select().from(bolterInboxReceipts).where(eq(bolterInboxReceipts.id, accepted.receipt.id)))[0]?.state).toBe("cancelled");
    expect((await tx.select().from(bolterRoomBindings).where(eq(bolterRoomBindings.connectionId, receiverCtx.connectionId))).every(binding => binding.state === "revoked")).toBe(true);
    expect((await tx.select().from(rooms).where(eq(rooms.id, active.binding.roomId)))[0]?.externalContext).toBe(true);
    await Promise.resolve(expect(tx.transaction(inner => inner.update(rooms).set({ externalContext: false }).where(eq(rooms.id, active.binding.roomId)))).rejects.toThrow());
    expect(await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: active.binding.id, expectedRevision: 1, state: "active" })).toBeNull();
  }));

  test("receiver rotation and explicit pause/resume fence stale admitted work", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const rotated = await rotateBolterReceiverWith(db, { userId: fixture.owner }, { connectionId: first.ctx.connectionId, expectedRevision: 0, desktopSessionId: "new-fixture-desktop", pairingGenerationRef: "new-fixture-pairing" });
    expect(rotated?.generation).toBe(2);
    expect((await accept(db, fixture, first.ctx)).status).toBe("unavailable");
    const current = { ...first.ctx, desktopSessionId: rotated!.desktopSessionId, pairingGenerationRef: rotated!.pairingGenerationRef, connectionGeneration: rotated!.generation };
    const paused = await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 0, state: "paused" });
    expect(paused?.revision).toBe(1);
    expect((await accept(db, fixture, current)).status).toBe("unavailable");
    const resumed = await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 1, state: "active" });
    expect(resumed?.revision).toBe(2);
    expect((await accept(db, fixture, { ...current, bindingRevision: 2 })).status).toBe("accepted");
  }));

  test("real product mutations reject missing/wrong GUC; real agent SELECT remains RLS filtered", async () => withFixture(async (_tx, fixture, db) => {
    const receiverCtx = await receiver(db, fixture);
    const first = await freshBinding(db, fixture, receiverCtx);
    for (const userId of ["", fixture.otherOwner]) {
      await product.transaction(async tx => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
        await Promise.resolve(expect(tx.transaction(inner => inner.update(bolterConnections).set({ enabled: false, generation: 2, revision: 1 }).where(eq(bolterConnections.id, receiverCtx.connectionId)))).rejects.toThrow());
        await Promise.resolve(expect(tx.transaction(inner => inner.insert(bolterRoomBindings).values({ userId: fixture.owner, connectionId: receiverCtx.connectionId, roomId: first.binding.roomId, namespaceId: first.binding.namespaceId, agentId: fixture.agent, origin: first.binding.origin, providerAgentId: first.binding.providerAgentId, chatId: "forged-fixture", threadId: "" }))).rejects.toThrow());
      });
      await agentPool.transaction(async tx => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${userId}, true)`);
        expect(await tx.select().from(bolterConnections).where(eq(bolterConnections.id, receiverCtx.connectionId))).toHaveLength(0);
      });
    }
    // Product BYPASSRLS is deliberate: its query API's explicit owner predicate
    // isolates this result, while raw product SELECT is privileged.
    expect(await listBolterConnectionsWith(product, { userId: fixture.otherOwner })).toHaveLength(0);
  }));

  test("keyless product deletion removes exact shared-Genie bridge references and preserves the other Human's Room/history", async () => withFixture(async (_tx, fixture, db) => {
    const owned = await freshBinding(db, fixture, await receiver(db, fixture));
    const otherHuman = randomUUID();
    await admin.insert(actors).values({ id: otherHuman, ownerId: fixture.otherOwner, displayName: "Bolter fixture other Human", kind: "user" });
    const otherFixture: Fixture = { ...fixture, owner: fixture.otherOwner, humanActor: otherHuman };
    const shared = await freshBinding(db, otherFixture, await receiver(db, otherFixture));
    let ownedMessage = 0;
    let sharedMessage = 0;
    let jobId = "";
    for (const [currentFixture, current] of [[fixture, owned], [otherFixture, shared]] as const) {
      await agentPool.transaction(async tx => {
        await tx.execute(sql`SELECT set_config('app.current_user_id', ${currentFixture.owner}, true)`);
        await tx.execute(sql`SELECT set_config('app.current_agent_id', ${fixture.agent}, true)`);
        const actualDb = agentPool;
        const accepted = await accept(actualDb, currentFixture, current.ctx);
        if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
        await finish(actualDb, currentFixture, accepted.receipt.id);
        if (currentFixture.owner === fixture.owner) {
          ownedMessage = accepted.receipt.sessionMessageId!;
          jobId = accepted.receipt.jobId!;
        } else sharedMessage = accepted.receipt.sessionMessageId!;
      });
    }
    const queued = await accept(agentPool, otherFixture, shared.ctx, "synthetic-queued-deletion");
    const running = await accept(agentPool, otherFixture, shared.ctx, "synthetic-running-deletion");
    if (queued.status !== "accepted" || running.status !== "accepted") throw new Error("Synthetic deletion intake unavailable");
    const runningInput = await getBolterExecutionInputForReceiptWith(agentPool, { userId: otherFixture.owner }, running.receipt.id);
    if (!runningInput) throw new Error("Synthetic deletion execution unavailable");
    await linkBolterExecutionAcceptanceWith(agentPool, { userId: otherFixture.owner }, runningInput);
    const deletionClaim = await fixtureClaim(otherFixture, runningInput.jobId);
    expect(await startBolterExecutionWith(agentPool, { userId: otherFixture.owner }, { ...runningInput, executionClaim: deletionClaim })).toBe("started");
    try {
      await product.transaction(async tx => {
        await cancelBolterExecutionsForDeletedAgentsInTransaction(tx, { userId: fixture.owner, agentIds: [fixture.agent] });
        const states = await tx.select({ status: jobs.status }).from(jobs).where(inArray(jobs.id, [queued.receipt.jobId!, runningInput.jobId]));
        expect(states).toHaveLength(2); expect(states.every(row => row.status === "cancelled")).toBe(true);
        const [retainedClaim] = await tx.execute(sql`SELECT count(*)::integer AS count FROM public.external_room_execution_claims WHERE room_id = ${shared.binding.roomId}::uuid`);
        expect(retainedClaim?.["count"]).toBe(1);
        // No encryption keys or owner GUC: this is the existing trusted account
        // deletion role. Its mutations use explicit owner/exact-binding predicates.
        await Promise.resolve(expect(tx.transaction(inner => inner.execute(sql`SELECT fingerprint FROM public.bolter_inbox_receipts LIMIT 0`))).rejects.toThrow());
        await Promise.resolve(expect(tx.transaction(inner => inner.execute(sql`UPDATE public.bolter_inbox_receipts SET state='cancelled' WHERE false`))).rejects.toThrow());
        await Promise.resolve(expect(tx.transaction(inner => inner.delete(sessionMessages).where(eq(sessionMessages.id, ownedMessage)))).rejects.toThrow());
        await Promise.resolve(expect(tx.transaction(inner => inner.delete(jobs).where(eq(jobs.id, jobId)))).rejects.toThrow());
        const affected = await tx.select({ id: bolterRoomBindings.id }).from(bolterRoomBindings).where(eq(bolterRoomBindings.agentId, fixture.agent));
        expect(affected).toHaveLength(2);
        const bindingIds = affected.map(row => row.id);
        await tx.delete(bolterOutbox).where(or(eq(bolterOutbox.userId, fixture.owner), inArray(bolterOutbox.bindingId, bindingIds)));
        await tx.delete(bolterInboxReceipts).where(or(eq(bolterInboxReceipts.userId, fixture.owner), inArray(bolterInboxReceipts.bindingId, bindingIds)));
        await tx.delete(bolterRoomBindings).where(or(eq(bolterRoomBindings.userId, fixture.owner), inArray(bolterRoomBindings.id, bindingIds)));
        expect(await settleBolterExecutionWith(tx as unknown as BolterBridgeDatabase, { userId: otherFixture.owner },
          { ...runningInput, status: "failed", expectedPredecessor: "running" })).toEqual({ kind: "existing_terminal", status: "cancelled" });
        expect(await loadBolterExecutionWith(tx as unknown as BolterBridgeDatabase, { userId: otherFixture.owner }, runningInput)).toBeNull();
        await tx.delete(bolterConnections).where(eq(bolterConnections.userId, fixture.owner));
        await tx.execute(sql`DELETE FROM public.session_messages WHERE session_id IN (SELECT id FROM public.sessions WHERE owner_id=${fixture.owner}::uuid)`);
        await tx.delete(sessions).where(eq(sessions.ownerId, fixture.owner));
        await tx.delete(jobs).where(eq(jobs.id, jobId));
        await tx.update(sessions).set({ agentId: null }).where(eq(sessions.agentId, fixture.agent));
        await tx.delete(actors).where(eq(actors.agentId, fixture.agent));
        await tx.delete(agents).where(eq(agents.id, fixture.agent));
        await tx.delete(rooms).where(eq(rooms.id, owned.binding.roomId));
        await tx.delete(namespaces).where(eq(namespaces.id, owned.binding.namespaceId));
        await tx.delete(actors).where(eq(actors.ownerId, fixture.owner));
        await tx.delete(users).where(eq(users.id, fixture.owner));
        expect(await tx.select().from(bolterConnections).where(eq(bolterConnections.id, shared.ctx.connectionId))).toHaveLength(1);
        expect(await tx.select().from(rooms).where(eq(rooms.id, shared.binding.roomId))).toHaveLength(1);
        const retained = await tx.select().from(sessionMessages).where(eq(sessionMessages.id, sharedMessage));
        expect(retained).toHaveLength(1); expect(retained[0]?.externalAuthorship).toBe(true);
        await tx.update(sessionMessages).set({ metadata: null }).where(eq(sessionMessages.id, sharedMessage));
        expect(await editCanonicalTranscriptMessageInTx(tx, { messageId: sharedMessage, expectedRevision: 0,
          content: "Forged shared history edit", clearCryptoObjectId: false })).toBeNull();
        expect(await tx.select().from(users).where(eq(users.id, fixture.owner))).toHaveLength(0);
        throw new FixtureRollback();
      });
    } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
    expect(await releaseExternalRoomExecutionClaimWith(product, { userId: otherFixture.owner }, deletionClaim)).toBe(true);
  }));

  test("explicit sponsorship is required and immutable; consent advances the binding revision", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture), "unconsented", false);
    expect((await accept(db, fixture, first.ctx)).status).toBe("unavailable");
    const consent = await acceptBolterModelSponsorshipWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 0 });
    expect(consent?.revision).toBe(1); expect(consent?.modelSponsorshipAcceptedAt).not.toBeNull();
    expect((await accept(db, fixture, first.ctx)).status).toBe("unavailable");
    expect((await accept(db, fixture, { ...first.ctx, bindingRevision: 1 })).status).toBe("accepted");
    await Promise.resolve(expect(tx.transaction(inner => inner.update(bolterRoomBindings).set({ modelSponsorshipAcceptedAt: null, revision: 2 }).where(eq(bolterRoomBindings.id, first.binding.id)))).rejects.toThrow());
  }));

  test("intake callback failure rolls back canonical message, Job, acceptance and dedup receipt", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const acceptanceId = randomUUID(); fixture.acceptanceIds.push(acceptanceId); persistCleanupLedger();
    await Promise.resolve(expect(acceptBolterInboundWith(db, first.ctx, { providerMessageId: "rollback-input", fingerprint: "a".repeat(64), externalSenderId: "outside-fixture" }, async (inner, binding, receiptId) => {
      const turnId = randomUUID();
      const sessionMessageId = await canonical(inner, fixture, binding.roomId, "user", turnId);
      await insertAcceptanceInTransaction(inner, "foreground", acceptanceId);
      await persistJobInTransaction(inner, { ownerId: fixture.owner, requestorId: fixture.owner, roomId: binding.roomId,
        laneKey: `room:${binding.roomId}`, type: "foreground", input: { ...inputReference(receiptId, acceptanceId, binding, first.ctx, turnId) } });
      if (sessionMessageId) throw new Error("Synthetic intake rollback");
      throw new Error("Missing canonical fixture");
    })).rejects.toThrow("Synthetic intake rollback"));
    expect(await tx.select().from(bolterInboxReceipts).where(eq(bolterInboxReceipts.bindingId, first.binding.id))).toHaveLength(0);
    expect(await tx.select().from(jobs).where(eq(jobs.roomId, first.binding.roomId))).toHaveLength(0);
    expect(await tx.select().from(workAcceptances).where(eq(workAcceptances.id, acceptanceId))).toHaveLength(0);
    expect(await tx.select().from(sessions).where(eq(sessions.roomId, first.binding.roomId))).toHaveLength(0);
  }));

  test("durable queued recovery retains exact Job and acceptance identities across both enqueue cuts", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const input = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, accepted.receipt.id);
    if (!input) throw new Error("Fixture execution input missing");
    expect(await listRecoverableBolterExecutionsWith(db, { userId: fixture.owner })).toEqual([input]);
    expect((await loadBolterExecutionWith(db, { userId: fixture.owner }, input))?.acceptance.status).toBe("accepted");
    expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, input)).toBe("linked");
    expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, input)).toBe("linked");
    expect((await loadBolterExecutionWith(db, { userId: fixture.owner }, input))?.acceptance.status).toBe("dispatched");
    const claim = await fixtureClaim(fixture, input.jobId);
  expect(await startBolterExecutionWith(db, { userId: fixture.owner }, { ...input, executionClaim: claim })).toBe("started");
    expect(await startBolterExecutionWith(db, { userId: fixture.owner }, input)).toBe("rejected");
    expect(await settleBolterExecutionWith(db, { userId: fixture.owner }, { ...input, status: "failed", expectedPredecessor: "queued" })).toEqual({ kind: "rejected" });
    expect((await tx.select().from(jobs).where(eq(jobs.id, input.jobId)))[0]?.status).toBe("running");
    expect(await settleBolterExecutionWith(db, { userId: fixture.owner }, { ...input, status: "cancelled", reason: "user_stop", expectedPredecessor: "running" })).toEqual({ kind: "transitioned", status: "cancelled" });
    expect(await listRecoverableBolterExecutionsWith(db, { userId: fixture.owner })).toEqual([]);
    expect(await tx.select().from(jobs).where(eq(jobs.ownerId, fixture.owner))).toHaveLength(1);
    expect(await tx.select().from(workAcceptances).where(eq(workAcceptances.id, input.reference.acceptanceId))).toHaveLength(1);
  }));

  test("pause settles unadopted queued work and retains immutable imported authorship", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const input = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, accepted.receipt.id);
    if (!input) throw new Error("Fixture execution input missing");
    const messageId = accepted.receipt.sessionMessageId!;
    expect((await tx.select().from(sessionMessages).where(eq(sessionMessages.id, messageId)))[0]?.externalAuthorship).toBe(true);
    await Promise.resolve(expect(tx.transaction(inner => inner.update(sessionMessages).set({ externalAuthorship: false }).where(eq(sessionMessages.id, messageId)))).rejects.toThrow());
    await Promise.resolve(expect(tx.transaction(inner => inner.update(sessionMessages).set({ role: "assistant" }).where(eq(sessionMessages.id, messageId)))).rejects.toThrow());
    expect((await getBolterCanonicalAttributionsWith(tx, { userId: fixture.owner }, [messageId])).get(messageId)?.status).toBe("verified");
    const assertCannotEdit = async () => {
      const result = await editCanonicalTranscriptMessageInTx(tx, { messageId, content: "Forged local edit", expectedRevision: 0, clearCryptoObjectId: false });
      expect(result).toBeNull();
    };
    await assertCannotEdit();
    await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 0, state: "paused" });
    expect((await tx.select().from(jobs).where(eq(jobs.id, input.jobId)))[0]?.status).toBe("cancelled");
    expect((await tx.select().from(workAcceptances).where(eq(workAcceptances.id, input.reference.acceptanceId)))[0]?.status).toBe("maintenance_cancelled");
    expect(await loadBolterExecutionWith(db, { userId: fixture.owner }, input)).toBeNull();
    await assertCannotEdit();
    expect((await getBolterCanonicalAttributionsWith(tx, { userId: fixture.owner }, [messageId])).get(messageId)?.status).toBe("verified");
    await tx.update(sessionMessages).set({ metadata: {} }).where(eq(sessionMessages.id, messageId));
    expect((await getBolterCanonicalAttributionsWith(tx, { userId: fixture.owner }, [messageId])).get(messageId)?.status).toBe("unverified");
    expect((await getBolterReceiptMessageIdsWith(tx, { userId: fixture.owner }, [messageId])).has(messageId)).toBe(true);
    await assertCannotEdit();
    await updateBolterBindingStateWith(db, { userId: fixture.owner }, { bindingId: first.binding.id, expectedRevision: 1, state: "revoked" });
    await assertCannotEdit();
  }));

  test("final canonical reply and pending outbox commit together, reject forged causality and duplicate source", async () => withFixture(async (tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const accepted = await accept(db, fixture, first.ctx);
    if (accepted.status !== "accepted") throw new Error("Fixture acceptance failed");
    const input = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, accepted.receipt.id);
    if (!input) throw new Error("Fixture execution input missing");
    expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, input)).toBe("linked");
    const claim = await fixtureClaim(fixture, input.jobId);
  expect(await startBolterExecutionWith(db, { userId: fixture.owner }, { ...input, executionClaim: claim })).toBe("started");
    await Promise.resolve(expect(completeBolterExecutionWith(db, { userId: fixture.owner }, input, async inner => {
      await canonical(inner, fixture, first.binding.roomId, "assistant"); throw new Error("Synthetic final rollback");
    })).rejects.toThrow("Synthetic final rollback"));
    expect((await tx.select().from(jobs).where(eq(jobs.id, input.jobId)))[0]?.status).toBe("running");
    expect(await tx.select().from(bolterOutbox).where(eq(bolterOutbox.sourceInboxId, accepted.receipt.id))).toHaveLength(0);
    const finalId = await canonical(tx, fixture, first.binding.roomId, "assistant");
    await Promise.resolve(expect(completeBolterExecutionWith(db, { userId: fixture.owner }, input, async () => ({ sessionMessageId: finalId, fingerprint: "d".repeat(64) }))).rejects.toThrow());
    expect((await tx.select().from(jobs).where(eq(jobs.id, input.jobId)))[0]?.status).toBe("running");
    const result = await completeBolterExecutionWith(db, { userId: fixture.owner }, input, async (inner, execution) => {
      const fp = digest(["Synthetic exact final", input.jobId]);
      const [row] = await inner.insert(sessionMessages).values({ sessionId: execution.session.id!, role: "assistant", content: "Synthetic exact final",
        humanTurnId: null, replyToMessageId: accepted.receipt.sessionMessageId, fingerprint: fp,
        metadata: { externalFinalReply: { kind: "bolter_final_reply_v1", receiptId: accepted.receipt.id, jobId: input.jobId,
          turnId: input.reference.turnId, acceptanceId: input.reference.acceptanceId } } }).returning();
      return { sessionMessageId: row!.id, fingerprint: fp };
    });
    expect(result?.state).toBe("pending");
    expect((await tx.select().from(jobs).where(eq(jobs.id, input.jobId)))[0]?.status).toBe("completed");
    expect(await completeBolterExecutionWith(db, { userId: fixture.owner }, input, async () => { throw new Error("Must not duplicate final"); })).toEqual(result);
    const [finalRow] = await tx.select().from(sessionMessages).where(eq(sessionMessages.id, result!.sessionMessageId!));
    const alternateFingerprint = digest(["Synthetic second final", input.jobId]);
    const [alternate] = await tx.insert(sessionMessages).values({ sessionId: finalRow!.sessionId, role: "assistant", content: "Synthetic second final",
      fingerprint: alternateFingerprint, humanTurnId: null, replyToMessageId: accepted.receipt.sessionMessageId,
      metadata: finalRow!.metadata }).returning();
    let constraint: unknown;
    try {
      await tx.transaction(inner => inner.insert(bolterOutbox).values({ userId: fixture.owner, bindingId: first.binding.id,
        bindingRevision: 0, connectionGeneration: 1, sourceInboxId: accepted.receipt.id, sessionMessageId: alternate!.id, fingerprint: alternateFingerprint }));
    } catch (error) {
      const cause = error instanceof Error && error.cause ? error.cause : error;
      if (typeof cause === "object" && cause !== null && "constraint_name" in cause) constraint = cause.constraint_name;
    }
    expect(constraint).toBe("bolter_outbox_final_reply");
  }));

  test("bounded role repair tolerates absent table/functions without changing applied functions", async () => {
    const schemaName = `bolter_fixture_${randomUUID().replaceAll("-", "")}`;
    try {
      await admin.transaction(async tx => {
        await tx.execute(sql.raw(`CREATE SCHEMA "${schemaName}"`));
        // Relocate only the bounded SQL probe into an empty fixture schema.
        // Applied functions/tables remain untouched, and the schema rolls back.
        await tx.execute(sql.raw(buildBolterBridgeRoleGrantsSql().replaceAll("public.", `${schemaName}.`)));
        throw new FixtureRollback();
      });
    } catch (error) { if (!(error instanceof FixtureRollback)) throw error; }
    const [remaining] = await admin.execute(sql`SELECT count(*)::integer AS count FROM pg_namespace WHERE nspname = ${schemaName}`);
    expect(remaining?.["count"]).toBe(0);
  });
});


describe("reviewed Human publications on real database roles", () => {
  test("atomic exact grant, idempotent retry, canonical read and terminal ambiguity", async () => withFixture(async (_tx, fixture, db) => {
    const first = await freshBinding(db, fixture, await receiver(db, fixture));
    const second = await freshBinding(db, fixture, await receiver(db, fixture, "second"));
    const requestId = randomUUID();
    const text = "Synthetic reviewed text with exact trailing space ";
    let writes = 0;
    const persist = (body: string, forged = false) => async (tx: BolterBridgeTransaction, grant: { shareId: string; fingerprint: string }) => {
      writes++;
      const turnId = randomUUID();
      const appended = await appendCanonicalTranscriptRowsInTx(tx, {
        session: { threadId: `room:${first.binding.roomId}:reviewed`, ownerId: fixture.owner, personaId: "owner",
          agentId: fixture.agent, roomId: first.binding.roomId, title: "Synthetic reviewed text" },
        rows: [plainRow({ role: "user", content: body, fingerprint: grant.fingerprint, humanTurnId: turnId,
          replyToMessageId: null, metadata: { bolterReviewedShare: { shareId: grant.shareId, requestId },
            ...(forged ? { externalReceiptId: randomUUID() } : {}) } })],
        notificationContext: { causalHumanUserId: null, causalHumanTurnId: null, mentionedHumanUserIds: [] },
      });
      if (!appended.insertedRows[0] || appended.failedIndices.length) throw new Error("Synthetic canonical share failed");
      return Number(appended.insertedRows[0].id);
    };
    for (const altered of [{ ...first.ctx, userId: fixture.otherOwner }, { ...first.ctx, bindingRevision: 1 }, { ...first.ctx, connectionGeneration: 2 }]) {
      await Promise.resolve(expect(acceptBolterReviewedShareWith(db, altered, { requestId, content: text }, persist(text))).rejects.toThrow());
    }
    expect(writes).toBe(0);
    await Promise.resolve(expect(acceptBolterReviewedShareWith(db, first.ctx, { requestId, content: text }, persist(text, true))).rejects.toThrow());
    await Promise.resolve(expect(acceptBolterReviewedShareWith(db, first.ctx, { requestId, content: text }, persist("changed text"))).rejects.toThrow());
    const outbox = await acceptBolterReviewedShareWith(db, first.ctx, { requestId, content: text }, persist(text));
    expect(outbox.sourceInboxId).toBeNull(); expect(outbox.explicitShareId).not.toBeNull();
    expect(outbox.fingerprint).toBe(bolterReviewedTextFingerprint(first.binding.id, requestId, text));
    const beforeRetry = writes;
    expect((await acceptBolterReviewedShareWith(db, first.ctx, { requestId, content: text }, persist(text))).id).toBe(outbox.id);
    expect(writes).toBe(beforeRetry);
    await Promise.resolve(expect(acceptBolterReviewedShareWith(db, first.ctx, { requestId, content: "changed" }, persist("changed"))).rejects.toThrow());
    await Promise.resolve(expect(acceptBolterReviewedShareWith(db, second.ctx, { requestId, content: text }, persist(text))).rejects.toThrow());
    await Promise.resolve(expect(db.transaction(async tx => {
      await tx.execute(sql`SELECT set_config('app.current_user_id', ${fixture.owner}, true)`);
      await tx.update(bolterExplicitShares).set({ fingerprint: "b".repeat(64) }).where(eq(bolterExplicitShares.id, outbox.explicitShareId!));
    })).rejects.toThrow());
    const claim = await claimBolterOutboxWith(db, first.ctx, outbox.id);
    if (!claim?.claimToken) throw new Error("Synthetic share claim unavailable");
    const input = { outboxId: outbox.id, claimToken: claim.claimToken };
    expect((await loadBolterPublicationContentWith(db, first.ctx, input))?.content).toBe(text);
    expect(await loadBolterPublicationContentWith(db, second.ctx, input)).toBeNull();
    expect(await loadBolterPublicationContentWith(db, { ...first.ctx, bindingRevision: 1 }, input)).toBeNull();
    expect((await settleBolterOutboxWith(db, first.ctx, { ...input, state: "uncertain" }))?.state).toBe("uncertain");
    expect(await claimBolterOutboxWith(db, first.ctx, outbox.id)).toBeNull();
    expect(await loadBolterPublicationContentWith(db, first.ctx, input)).toBeNull();
    await product.transaction(async tx => {
      await tx.delete(bolterOutbox).where(eq(bolterOutbox.userId, fixture.owner));
      await tx.delete(bolterExplicitShares).where(eq(bolterExplicitShares.userId, fixture.owner));
    });
    expect(await admin.select().from(bolterExplicitShares).where(eq(bolterExplicitShares.userId, fixture.owner))).toHaveLength(0);
  }));
});

test("operator control commits input, result and publication without conversation or notification rows", async () => {
  await withFixture(async (_tx, fixture, db) => {
    const { createMagentOperatorConnectionWith } = await import("../../src/queries/bolter-bridge");
    const connection = await createMagentOperatorConnectionWith(db, { userId: fixture.owner }, {
      operatorBindingId: randomUUID(), origin: "https://operator.example", providerAgentId: "synthetic-genie",
      identityFingerprint: "c".repeat(64),
    });
    const receiver: BolterReceiverContext = { userId: fixture.owner, connectionId: connection.id,
      connectionGeneration: connection.generation, transportKind: "operator-unix", operatorBindingId: connection.operatorBindingId,
      relayId: null, desktopSessionId: null, pairingGenerationRef: null };
    const { binding, ctx } = await freshBinding(db, fixture, receiver, "synthetic-control-room");
    const content = "Synthetic operator control prompt";
    const origin = { ...sourceOrigin(ctx, "synthetic-control", binding), provider: "magent" as const,
      senderType: "anima" as const, senderId: "magent-connector:synthetic-genie" };
    const fingerprint = digest([origin.provider, origin.origin, origin.providerAgentId, origin.chatId, origin.threadRootId,
      origin.messageId, origin.senderId, origin.senderType, origin.createdAt, content]);
    const inbound = { providerMessageId: origin.messageId, externalSenderId: origin.senderId, fingerprint };
    const accepted = await acceptBolterInboundWith(db, ctx, inbound, async (tx, locked, receiptId) => {
      const turnId = randomUUID();
      const acceptanceId = randomUUID(); fixture.acceptanceIds.push(acceptanceId); persistCleanupLedger();
      await insertAcceptanceInTransaction(tx, "foreground", acceptanceId);
      const reference = inputReference(receiptId, acceptanceId, locked, ctx, turnId);
      const jobId = await persistJobInTransaction(tx, { ownerId: fixture.owner, requestorId: fixture.owner,
        roomId: locked.roomId, laneKey: `room:${locked.roomId}`, type: "foreground", input: { ...reference } });
      return { sessionMessageId: null, turnId, jobId, controlInput: { kind: "operator_control_v1", content, origin } };
    }, "synthetic-control-generation");
    if (accepted.status !== "accepted") throw new Error("Operator fixture was not accepted");
    expect(accepted.receipt.sessionMessageId).toBeNull();
    expect((await acceptBolterInboundWith(db, ctx, inbound, async () => { throw new Error("Duplicate execution"); }, "synthetic-control-generation")).status).toBe("duplicate");
    const execution = await getBolterExecutionInputForReceiptWith(db, { userId: fixture.owner }, accepted.receipt.id);
    if (!execution) throw new Error("Control reference unavailable");
    expect(await loadBolterExecutionWith(db, { userId: fixture.owner }, execution)).toMatchObject({ sourceMessage: { id: null, content } });
    expect(await linkBolterExecutionAcceptanceWith(db, { userId: fixture.owner }, execution)).toBe("linked");
    const claim = await fixtureClaim(fixture, execution.jobId);
    try {
      expect(await startBolterExecutionWith(db, { userId: fixture.owner }, { ...execution, executionClaim: claim })).toBe("started");
      const result = "Synthetic control result";
      const outbox = await completeBolterExecutionWith(db, { userId: fixture.owner }, execution, async () => ({
        sessionMessageId: null, controlResult: result,
        fingerprint: digest(["external-room-final-v1", accepted.receipt.id, execution.jobId, result]),
      }));
      if (!outbox) throw new Error("Control result unavailable");
      expect(outbox.sessionMessageId).toBeNull();
      const publication = await claimBolterOutboxWith(db, ctx, outbox.id, randomUUID());
      if (!publication?.claimToken) throw new Error("Control publication unavailable");
      expect(await loadBolterPublicationContentWith(db, ctx, { outboxId: outbox.id, claimToken: publication.claimToken }))
        .toMatchObject({ content: result });
      expect(await admin.select().from(sessions).where(eq(sessions.roomId, binding.roomId))).toHaveLength(0);
      expect(await admin.select().from(sessionMessageDirectedRecipients).where(eq(sessionMessageDirectedRecipients.recipientId, fixture.owner))).toHaveLength(0);
    } finally { expect(await releaseExternalRoomExecutionClaimWith(product, { userId: fixture.owner }, claim)).toBe(true); }
  });
});
