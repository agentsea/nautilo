import { createHash, randomUUID } from "node:crypto";
import { and, count, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { getSharedDirectAgentDb } from "../config/agent-database";
import { getSharedDirectDb } from "../config/direct-database";
import { withTrustContext } from "../connection/with-trust-context";
import { installExternalRoomExecutionClaimContext, type ExternalRoomExecutionClaim } from "./external-room-execution-claims";
import { acquireEncryptionConsumptionFence } from "../utils/encryption-transition-queries";
import { jobs } from "../schema/jobs";
import { workAcceptances } from "../schema/work-acceptances";
import { sessions, sessionMessages } from "../schema/sessions";
import { bolterAttachmentDescriptorSchema, parseExternalMessageOrigin, type BolterAttachmentDescriptor, type ExternalMessageOrigin } from "@nautilo/types";
import { messageAttachments } from "../schema/message-attachments";
import { bolterConnections, bolterRoomBindings, bolterInboxReceipts, bolterOutbox, bolterExplicitShares, externalOperatorSessions, type BolterConnection, type BolterRoomBinding, type BolterInboxReceipt } from "../schema/bolter-bridge";

export type BolterBridgeDatabase = ReturnType<typeof getSharedDirectAgentDb>;
export type BolterFactoryDatabase = ReturnType<typeof getSharedDirectDb>;
export type BolterBridgeTransaction = Parameters<Parameters<BolterBridgeDatabase["transaction"]>[0]>[0];
/** Authenticated server-owned Human context. These queries do not authenticate input. */
export interface BolterOwnerContext { readonly userId: string }
export interface BolterReceiverContext extends BolterOwnerContext {
  readonly connectionId: string;
  readonly connectionGeneration: number;
  readonly transportKind?: "desktop-relay" | "operator-unix";
  readonly operatorBindingId?: string | null;
  readonly relayId: string | null;
  readonly desktopSessionId: string | null;
  readonly pairingGenerationRef: string | null;
}
export interface BolterBindingContext extends BolterReceiverContext {
  readonly bindingId: string;
  readonly bindingRevision: number;
}
export type BolterConnectionInsert = Pick<BolterConnection, "origin" | "providerAgentId" | "identityFingerprint"> & { readonly id?: string; readonly relayId: string; readonly desktopSessionId: string; readonly pairingGenerationRef: string; readonly homeHandle: string };
export type BolterBindingInsert = Pick<BolterRoomBinding, "roomId" | "namespaceId" | "agentId" | "chatId" | "threadId"> & { readonly id?: string; readonly modelSponsorshipAccepted?: boolean };
export interface BolterInboundInsert {
  readonly providerMessageId: string;
  readonly fingerprint: string;
  readonly externalSenderId: string;
}
export interface BolterCanonicalInbound {
  readonly sessionMessageId: number | null;
  readonly controlInput?: BolterInboxReceipt["controlInput"];
  readonly turnId: string;
  readonly jobId: string;
}
export type BolterInboundAcceptance =
  | { readonly status: "accepted" | "duplicate"; readonly receipt: BolterInboxReceipt }
  | { readonly status: "quarantined"; readonly receipt: BolterInboxReceipt }
  | { readonly status: "unavailable" };
export type BolterPublicationReason = { readonly sourceInboxId: string; readonly explicitShareId?: never } | { readonly explicitShareId: string; readonly sourceInboxId?: never };
export type BolterOutboxInsert = BolterPublicationReason & { readonly sessionMessageId: number; readonly fingerprint: string };

export interface ExternalRoomJobReference {
  readonly kind: "external_room_turn_v1";
  readonly receiptId: string;
  readonly bindingId: string;
  readonly bindingRevision: number;
  readonly connectionGeneration: number;
  readonly acceptanceId: string;
  readonly roomId: string;
  readonly agentId: string;
  readonly turnId: string;
}
export interface BolterExecutionInput { readonly jobId: string; readonly reference: ExternalRoomJobReference }
export interface BolterExecution {
  readonly reference: ExternalRoomJobReference;
  readonly job: typeof jobs.$inferSelect;
  readonly receipt: BolterInboxReceipt;
  readonly binding: BolterRoomBinding;
  readonly connection: BolterConnection;
  readonly receiverContext: BolterBindingContext;
  readonly acceptance: typeof workAcceptances.$inferSelect;
  readonly sourceMessage: Pick<typeof sessionMessages.$inferSelect, "content"> & { id: number | null };
  readonly session: { id: string | null; threadId: string };
  readonly origin: ExternalMessageOrigin;
}
export type BolterExecutionSettlement = { readonly kind: "transitioned" | "existing_terminal"; readonly status: string } | { readonly kind: "rejected" };
export type BolterCanonicalAttribution = { readonly status: "verified"; readonly origin: ExternalMessageOrigin } | { readonly status: "unverified" };

async function externalPlaintextFence(tx: BolterBridgeTransaction) {
  const policy = await acquireEncryptionConsumptionFence(tx);
  if (policy.mode !== "plaintext_only") throw new BolterBridgeAuthorityError();
}

export class BolterBridgeAuthorityError extends Error {
  readonly code = "bolter_bridge_authority_unavailable";
  constructor() { super("The current Bolter connection or Room binding is unavailable."); this.name = "BolterBridgeAuthorityError"; }
}
export class BolterBridgeIdentityConflictError extends Error {
  readonly code = "bolter_bridge_identity_conflict";
  constructor() { super("The qualified Bolter identity conflicts with retained connection metadata."); this.name = "BolterBridgeIdentityConflictError"; }
}

export function canonicalBolterOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new TypeError("Bolter origin must be a credential-free HTTPS origin");
  return url.origin;
}
function hasControlCharacter(value: string): boolean {
  return [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}
function opaque(value: string): void {
  if (!value.trim() || hasControlCharacter(value)) throw new TypeError("Bolter identity must be nonempty opaque text");
}
function fingerprint(value: string): void { if (!/^[0-9a-f]{64}$/u.test(value)) throw new TypeError("Bolter fingerprint must be a SHA-256 hexadecimal digest"); }
function scoped<T>(db: BolterBridgeDatabase | BolterFactoryDatabase, ctx: BolterOwnerContext, run: (tx: BolterBridgeTransaction) => Promise<T>) { return withTrustContext(ctx, run, db); }

export function bolterReceiverMatches(connection: BolterConnection, ctx: BolterReceiverContext): boolean {
  return connection.userId === ctx.userId && connection.id === ctx.connectionId && connection.generation === ctx.connectionGeneration
    && (connection.transportKind ?? "desktop-relay") === (ctx.transportKind ?? "desktop-relay")
    && (connection.operatorBindingId ?? null) === (ctx.operatorBindingId ?? null)
    && connection.relayId === ctx.relayId && connection.desktopSessionId === ctx.desktopSessionId
    && connection.pairingGenerationRef === ctx.pairingGenerationRef && connection.enabled && connection.revokedAt === null;
}
export function bolterBindingMatches(binding: BolterRoomBinding, ctx: BolterBindingContext): boolean {
  return binding.userId === ctx.userId && binding.connectionId === ctx.connectionId && binding.id === ctx.bindingId
    && binding.revision === ctx.bindingRevision && binding.state === "active";
}
async function lockConnection(tx: BolterBridgeTransaction, ctx: BolterReceiverContext): Promise<BolterConnection | null> {
  const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, ctx.connectionId))).for("update");
  return connection && bolterReceiverMatches(connection, ctx) ? connection : null;
}
async function lockBinding(tx: BolterBridgeTransaction, ctx: BolterBindingContext): Promise<BolterRoomBinding | null> {
  if (!await lockConnection(tx, ctx)) return null;
  const [binding] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.id, ctx.bindingId))).for("update");
  if (!binding || !bolterBindingMatches(binding, ctx)) return null;
  // This is content-free revalidation. Invocation capabilities and provider
  // funding remain independently admitted by Server/Trust.
  // The agent role cannot read raw users or invoke moderation directly.
  // The narrow product-owned function returns only exact Room admission.
  const rows = await tx.execute(sql`SELECT ${binding.roomId}::uuid AS id
    WHERE public.bolter_room_admission(${ctx.userId}::uuid, ${binding.roomId}::uuid, ${binding.namespaceId}::uuid, ${binding.agentId}::uuid)`);
  return Array.from(rows).length === 1 ? binding : null;
}

export function listBolterConnectionsWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext) {
  return scoped(db, ctx, tx => tx.select().from(bolterConnections).where(eq(bolterConnections.userId, ctx.userId)).orderBy(bolterConnections.createdAt, bolterConnections.id));
}
export function getBolterConnectionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, connectionId: string) {
  return scoped(db, ctx, async tx => (await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, connectionId))).limit(1))[0] ?? null);
}
type DesktopBolterConnection = BolterConnection & { provider: "bolter"; transportKind: "desktop-relay";
  operatorBindingId: null; relayId: string; desktopSessionId: string; pairingGenerationRef: string; homeHandle: string };
function desktopConnection(row: BolterConnection): DesktopBolterConnection {
  if (row.provider !== "bolter" || row.transportKind !== "desktop-relay" || row.operatorBindingId !== null
    || !row.relayId || !row.desktopSessionId || !row.pairingGenerationRef || !row.homeHandle) throw new BolterBridgeIdentityConflictError();
  return row as DesktopBolterConnection;
}
export function createBolterConnectionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: BolterConnectionInsert) {
  const origin = canonicalBolterOrigin(input.origin);
  for (const value of [input.relayId, input.desktopSessionId, input.pairingGenerationRef, input.providerAgentId, input.homeHandle]) opaque(value);
  if ((input.homeHandle.includes("/") || input.homeHandle.includes("\\")) || input.homeHandle.includes("..")) throw new TypeError("Bolter home handle must not be a path");
  fingerprint(input.identityFingerprint);
  return scoped(db, ctx, async tx => {
    const [row] = await tx.insert(bolterConnections).values({ ...input, origin, userId: ctx.userId, provider: "bolter", transportKind: "desktop-relay", operatorBindingId: null }).onConflictDoNothing({ target: [bolterConnections.userId, bolterConnections.relayId, bolterConnections.homeHandle] }).returning();
    if (row) return desktopConnection(row);
    const [existing] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.relayId, input.relayId), eq(bolterConnections.homeHandle, input.homeHandle))).for("update");
    if (!existing || existing.origin !== origin || existing.providerAgentId !== input.providerAgentId || existing.identityFingerprint !== input.identityFingerprint
      || existing.desktopSessionId !== input.desktopSessionId || existing.pairingGenerationRef !== input.pairingGenerationRef || existing.revokedAt !== null) throw new BolterBridgeIdentityConflictError();
    return desktopConnection(existing);
  });
}

/** A single operator capability is bound to immutable external routing and sponsor identity. */
export function createMagentOperatorConnectionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  input: { operatorBindingId: string; origin: string; providerAgentId: string; identityFingerprint: string }) {
  fingerprint(input.identityFingerprint);
  return scoped(db, ctx, async tx => {
    const [created] = await tx.insert(bolterConnections).values({ id: input.operatorBindingId, userId: ctx.userId,
      ...input, provider: "magent", transportKind: "operator-unix", relayId: null, desktopSessionId: null,
      pairingGenerationRef: null, homeHandle: null }).onConflictDoNothing({ target: bolterConnections.id }).returning();
    if (created) return created;
    const [existing] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.id, input.operatorBindingId),
      eq(bolterConnections.userId, ctx.userId))).for("update");
    if (!existing || existing.provider !== "magent" || existing.transportKind !== "operator-unix"
      || existing.operatorBindingId !== input.operatorBindingId || existing.origin !== input.origin
      || existing.providerAgentId !== input.providerAgentId || existing.identityFingerprint !== input.identityFingerprint) {
      throw new BolterBridgeIdentityConflictError();
    }
    return existing;
  });
}

/** Metadata-only recovery view; no transcript content is released here. */
export function getMagentReceiptStatusWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, receiptId: string) {
  return scoped(db, ctx, async tx => {
    const [row] = await tx.select({ receipt: bolterInboxReceipts, job: jobs, publication: bolterOutbox })
      .from(bolterInboxReceipts).leftJoin(jobs, and(eq(jobs.id, bolterInboxReceipts.jobId), eq(jobs.ownerId, ctx.userId)))
      .leftJoin(bolterOutbox, and(eq(bolterOutbox.sourceInboxId, bolterInboxReceipts.id), eq(bolterOutbox.userId, ctx.userId)))
      .where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.bindingId, ctx.bindingId),
        eq(bolterInboxReceipts.id, receiptId))).limit(1);
    if (!row) return null;
    const reference = parseExternalRoomJobReference(row.job?.input);
    if (!reference || reference.receiptId !== receiptId || reference.bindingId !== ctx.bindingId) return null;
    return { receiptId, state: row.receipt.state === "cancelled" || row.receipt.state === "quarantined" ? "cancelled"
      : row.job?.status === "completed" ? "completed" : ["failed", "timed_out"].includes(row.job?.status ?? "") ? "failed"
        : row.job?.status === "cancelled" ? "cancelled" : "pending",
      ...(row.publication ? { outboxId: row.publication.id, publicationState: row.publication.state } : {}) };
  });
}

/** Fence publication and durable execution before the service aborts its local executor. */
export function cancelMagentReceiptWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, receiptId: string) {
  return scoped(db, ctx, async tx => {
    const binding = await lockBinding(tx, ctx);
    if (!binding || binding.provider !== "magent") return null;
    const [receipt] = await tx.select().from(bolterInboxReceipts).where(and(eq(bolterInboxReceipts.id, receiptId),
      eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.bindingId, binding.id))).for("update");
    if (!receipt) return null;
    await settleFencedJobs(tx, ctx.userId, [binding.id], receipt.id);
    if (receipt.state === "pending" || receipt.state === "accepted") await tx.update(bolterInboxReceipts)
      .set({ state: "cancelled", updatedAt: new Date() }).where(eq(bolterInboxReceipts.id, receipt.id));
    await tx.update(bolterOutbox).set({ state: sql`CASE WHEN ${bolterOutbox.state} = 'publishing' THEN 'uncertain' ELSE 'cancelled' END`, updatedAt: new Date() })
      .where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.sourceInboxId, receipt.id), inArray(bolterOutbox.state, ["pending", "publishing"])));
    return { jobId: receipt.jobId };
  });
}

export function listBolterBindingsWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, connectionId?: string) {
  return scoped(db, ctx, tx => tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), connectionId === undefined ? undefined : eq(bolterRoomBindings.connectionId, connectionId))).orderBy(bolterRoomBindings.createdAt, bolterRoomBindings.id));
}
export function getBolterBindingWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, bindingId: string) {
  return scoped(db, ctx, async tx => (await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.id, bindingId))).limit(1))[0] ?? null);
}
export function resolveBolterBindingWith(db: BolterBridgeDatabase, ctx: BolterReceiverContext, input: { origin: string; providerAgentId: string; chatId: string; threadId: string }) {
  const origin = canonicalBolterOrigin(input.origin);
  return scoped(db, ctx, async tx => {
    const connection = await lockConnection(tx, ctx);
    if (!connection || connection.origin !== origin || connection.providerAgentId !== input.providerAgentId) return null;
    const [binding] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.connectionId, ctx.connectionId), eq(bolterRoomBindings.origin, origin), eq(bolterRoomBindings.providerAgentId, input.providerAgentId), eq(bolterRoomBindings.chatId, input.chatId), eq(bolterRoomBindings.threadId, input.threadId), eq(bolterRoomBindings.state, "active"))).limit(1);
    return binding ?? null;
  });
}
/**
 * Product-only canonical mint. This trusted role bypasses RLS, so explicit owner
 * predicates and mutation triggers carry its boundary. The factory must INSERT
 * a new Room and namespace using this transaction; never accept an old Room id.
 */
export function createFreshBolterBindingWith(db: BolterFactoryDatabase, ctx: BolterReceiverContext,
  createRoom: (tx: BolterBridgeTransaction, connection: BolterConnection) => Promise<BolterBindingInsert>) {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const role = await tx.execute(sql`SELECT current_user AS role`);
    if (role[0]?.["role"] !== "nautilo") throw new BolterBridgeAuthorityError();
    const connection = await lockConnection(tx, ctx);
    if (!connection) throw new BolterBridgeAuthorityError();
    const input = await createRoom(tx, connection);
    opaque(input.chatId);
    if (hasControlCharacter(input.threadId)) throw new TypeError("Invalid Bolter thread identity");
    const { modelSponsorshipAccepted, ...routing } = input;
    const [binding] = await tx.insert(bolterRoomBindings).values({ ...routing, modelSponsorshipAcceptedAt: modelSponsorshipAccepted === true ? new Date() : null, userId: ctx.userId, connectionId: connection.id, provider: connection.provider, origin: connection.origin, providerAgentId: connection.providerAgentId }).returning();
    if (!binding) throw new BolterBridgeAuthorityError();
    return binding;
  });
}

async function fenceDeliveries(tx: BolterBridgeTransaction, userId: string, bindingIds: string[]) {
  if (!bindingIds.length) return [];
  const cancelledJobIds = await settleFencedJobs(tx, userId, bindingIds);
  await tx.update(bolterInboxReceipts).set({ state: "cancelled", updatedAt: new Date() }).where(and(eq(bolterInboxReceipts.userId, userId), inArray(bolterInboxReceipts.bindingId, bindingIds), inArray(bolterInboxReceipts.state, ["pending", "accepted"])));
  await tx.update(bolterOutbox).set({ state: "cancelled", updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, userId), inArray(bolterOutbox.bindingId, bindingIds), eq(bolterOutbox.state, "pending")));
  await tx.update(bolterOutbox).set({ state: "uncertain", updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, userId), inArray(bolterOutbox.bindingId, bindingIds), eq(bolterOutbox.state, "publishing")));
  return cancelledJobIds;
}

/** Binding locks are held by callers; accepted ledger rows lock before Jobs. */
async function settleFencedJobs(tx: BolterBridgeTransaction, userId: string, bindingIds: string[], receiptId?: string) {
  const exactReference = sql`j.input = jsonb_build_object('kind','external_room_turn_v1',
    'receiptId',i.id::text,'bindingId',b.id::text,'bindingRevision',i.binding_revision,
    'connectionGeneration',i.connection_generation,'acceptanceId',a.id::text,
    'roomId',b.room_id::text,'agentId',b.agent_id::text,'turnId',i.turn_id)
    AND j.owner_id = ${userId}::uuid AND j.requestor_id = ${userId}::uuid
    AND j.room_id = b.room_id AND j.type = 'foreground' AND j.lane_key = 'room:' || b.room_id::text
    AND i.user_id = ${userId}::uuid AND b.user_id = ${userId}::uuid
    AND i.binding_id IN (${sql.join(bindingIds.map(id => sql`${id}::uuid`), sql`, `)})
    AND ${receiptId === undefined ? sql`true` : sql`i.id = ${receiptId}::uuid`}
    AND j.status IN ('queued','running') AND j.completed_at IS NULL`;
  await tx.execute(sql`UPDATE public.work_acceptances a
    SET status = 'maintenance_cancelled', cancelled_at = now(), cancellation_reason = 'authority_withdrawn'
    FROM public.jobs j JOIN public.bolter_inbox_receipts i ON i.job_id = j.id
      JOIN public.bolter_room_bindings b ON b.id = i.binding_id
    WHERE a.kind = 'foreground' AND a.status = 'accepted' AND a.job_id IS NULL AND ${exactReference}`);
  const cancelled = await tx.execute(sql`UPDATE public.jobs j
    SET status = 'cancelled', completed_at = now(), message = 'authority_withdrawn'
    FROM public.bolter_inbox_receipts i JOIN public.bolter_room_bindings b ON b.id = i.binding_id,
      public.work_acceptances a
    WHERE i.job_id = j.id AND a.kind = 'foreground'
      AND (a.job_id IS NULL OR a.job_id = j.id) AND ${exactReference} RETURNING j.id`);
  return Array.from(cancelled).map(row => String(row["id"]));
}
/** Trusted account-deletion authority supplies its already canonical deleted Genie IDs.
 * Call before touching Sessions or deleting provenance; retained claims are untouched.
 */
export async function cancelBolterExecutionsForDeletedAgentsInTransaction(tx: Pick<BolterFactoryDatabase, "execute">, authority: { readonly userId: string; readonly agentIds: readonly string[] }): Promise<void> {
  const affected = sql`b.user_id = ${authority.userId}::uuid OR ${authority.agentIds.length ? sql`b.agent_id IN (${sql.join(authority.agentIds.map(id => sql`${id}::uuid`), sql`, `)})` : sql`false`}`;
  // Match receiver -> binding -> ledger -> Job before deletion touches Rooms.
  await tx.execute(sql`SELECT c.id FROM public.bolter_connections c
    WHERE c.user_id = ${authority.userId}::uuid OR EXISTS (SELECT 1 FROM public.bolter_room_bindings b
      WHERE b.connection_id = c.id AND (${affected})) ORDER BY c.id FOR UPDATE`);
  await tx.execute(sql`SELECT b.id FROM public.bolter_room_bindings b WHERE (${affected}) ORDER BY b.id FOR UPDATE`);
  const exact = sql`(${affected}) AND i.user_id = b.user_id
    AND j.owner_id = b.user_id AND j.requestor_id = b.user_id AND j.room_id = b.room_id
    AND j.type = 'foreground' AND j.lane_key = 'room:' || b.room_id::text
    AND j.input->>'kind' = 'external_room_turn_v1' AND j.input->>'receiptId' = i.id::text
    AND j.input->>'bindingId' = b.id::text AND j.input->>'roomId' = b.room_id::text
    AND j.input->>'agentId' = b.agent_id::text AND j.input->>'acceptanceId' = a.id::text
    AND j.status IN ('queued','running')`;
  await tx.execute(sql`UPDATE public.work_acceptances a SET status = 'maintenance_cancelled',
    cancelled_at = now(), cancellation_reason = 'authority_withdrawn'
    FROM public.jobs j JOIN public.bolter_inbox_receipts i ON i.job_id = j.id JOIN public.bolter_room_bindings b ON b.id = i.binding_id
    WHERE a.kind = 'foreground' AND a.status = 'accepted' AND a.job_id IS NULL AND ${exact}`);
  await tx.execute(sql`UPDATE public.jobs j SET status = 'cancelled', completed_at = now(), message = 'authority_withdrawn'
    FROM public.bolter_inbox_receipts i JOIN public.bolter_room_bindings b ON b.id = i.binding_id, public.work_acceptances a
    WHERE i.job_id = j.id AND a.kind = 'foreground' AND (a.job_id IS NULL OR a.job_id = j.id) AND ${exact}`);
}
export function setBolterConnectionStateWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: { connectionId: string; expectedRevision: number; enabled: boolean; revoke?: boolean }) {
  return scoped(db, ctx, async tx => {
    const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, input.connectionId))).for("update");
    if (!connection || connection.revision !== input.expectedRevision || connection.revokedAt !== null) return null;
    const now = new Date();
    const [updated] = await tx.update(bolterConnections).set({ enabled: input.revoke ? false : input.enabled, revokedAt: input.revoke ? now : null, generation: connection.generation + 1, revision: connection.revision + 1, updatedAt: now }).where(eq(bolterConnections.id, connection.id)).returning();
    const bindings = await tx.select({ id: bolterRoomBindings.id }).from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.connectionId, connection.id))).for("update");
    await fenceDeliveries(tx, ctx.userId, bindings.map(binding => binding.id));
    if (input.revoke) await tx.update(bolterRoomBindings).set({ state: "revoked", revision: sql`${bolterRoomBindings.revision} + 1`, updatedAt: now }).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.connectionId, connection.id), ne(bolterRoomBindings.state, "revoked")));
    return updated ?? null;
  });
}
export function setBolterBindingStateWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, state: "paused" | "revoked") {
  return updateBolterBindingStateWith(db, ctx, { bindingId: ctx.bindingId, expectedRevision: ctx.bindingRevision, state });
}
/** Owner controls remain available after membership or receiver authority changes. */
export async function updateBolterBindingStateWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: { bindingId: string; expectedRevision: number; state: "active" | "paused" | "revoked" }) {
  return (await updateExternalBindingStateWith(db, ctx, input))?.binding ?? null;
}
export function withdrawMagentBindingWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  input: { bindingId: string; expectedRevision: number; state: "paused" | "revoked" }) {
  return updateExternalBindingStateWith(db, ctx, input, "magent");
}
function updateExternalBindingStateWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  input: { bindingId: string; expectedRevision: number; state: "active" | "paused" | "revoked" }, provider?: "magent") {
  return scoped(db, ctx, async tx => {
    // Resolve without a lock, then retain the universal connection-before-binding lock order.
    const [candidate] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.id, input.bindingId))).limit(1);
    if (!candidate) return null;
    const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, candidate.connectionId))).for("update");
    const [binding] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.id, input.bindingId))).for("update");
    if (!connection || !binding || binding.revision !== input.expectedRevision || binding.state === "revoked"
      || (provider && binding.provider !== provider)) return null;
    if (input.state === "active" && (!connection.enabled || connection.revokedAt !== null)) return null;
    const [updated] = await tx.update(bolterRoomBindings).set({ state: input.state, revision: binding.revision + 1, updatedAt: new Date() }).where(eq(bolterRoomBindings.id, binding.id)).returning();
    const cancelledJobIds = await fenceDeliveries(tx, ctx.userId, [binding.id]);
    return updated ? { binding: updated, cancelledJobIds } : null;
  });
}

/** Explicit receiver rotation fences every old delivery before the new generation can act. */
export function rotateBolterReceiverWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: { connectionId: string; expectedRevision: number; desktopSessionId: string; pairingGenerationRef: string }) {
  opaque(input.desktopSessionId); opaque(input.pairingGenerationRef);
  return scoped(db, ctx, async tx => {
    const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, input.connectionId))).for("update");
    if (!connection || connection.revision !== input.expectedRevision || connection.revokedAt !== null) return null;
    const [updated] = await tx.update(bolterConnections).set({ desktopSessionId: input.desktopSessionId, pairingGenerationRef: input.pairingGenerationRef, generation: connection.generation + 1, revision: connection.revision + 1, updatedAt: new Date() }).where(eq(bolterConnections.id, connection.id)).returning();
    const bindings = await tx.select({ id: bolterRoomBindings.id }).from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.connectionId, connection.id))).for("update");
    await fenceDeliveries(tx, ctx.userId, bindings.map(binding => binding.id));
    return updated ?? null;
  });
}

/** Canonical insertion and dedup receipt commit atomically; do not perform network work in persist. */
export function acceptBolterInboundWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, input: BolterInboundInsert,
  persist: (tx: BolterBridgeTransaction, binding: BolterRoomBinding, receiptId: string) => Promise<BolterCanonicalInbound>,
  operatorSessionId?: string): Promise<BolterInboundAcceptance> {
  opaque(input.providerMessageId); opaque(input.externalSenderId); fingerprint(input.fingerprint);
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const binding = await lockBinding(tx, ctx);
    if (!binding || binding.modelSponsorshipAcceptedAt === null) return { status: "unavailable" };
    if (binding.provider === "magent") {
      if (!operatorSessionId) return { status: "unavailable" };
      opaque(operatorSessionId);
      const [session] = await tx.select().from(externalOperatorSessions).where(and(
        eq(externalOperatorSessions.userId, ctx.userId), eq(externalOperatorSessions.bindingId, binding.id))).limit(1);
      if (session && session.sessionId !== operatorSessionId) return { status: "unavailable" };
      if (!session) await tx.insert(externalOperatorSessions).values({ userId: ctx.userId, bindingId: binding.id, sessionId: operatorSessionId });
    }
    const [existing] = await tx.select().from(bolterInboxReceipts).where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.bindingId, ctx.bindingId), eq(bolterInboxReceipts.providerMessageId, input.providerMessageId))).for("update");
    if (existing) {
      if (existing.fingerprint !== input.fingerprint || existing.externalSenderId !== input.externalSenderId) {
        const [quarantined] = await tx.update(bolterInboxReceipts).set({ state: "quarantined", updatedAt: new Date() }).where(eq(bolterInboxReceipts.id, existing.id)).returning();
        await settleFencedJobs(tx, ctx.userId, [binding.id], existing.id);
        await tx.update(bolterOutbox).set({ state: sql`CASE WHEN ${bolterOutbox.state} = 'publishing' THEN 'uncertain' ELSE 'cancelled' END`, updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.sourceInboxId, existing.id), inArray(bolterOutbox.state, ["pending", "publishing"])));
        return { status: "quarantined", receipt: quarantined! };
      }
      return { status: existing.state === "quarantined" ? "quarantined" : "duplicate", receipt: existing };
    }
    const [receipt] = await tx.insert(bolterInboxReceipts).values({ ...input, userId: ctx.userId, bindingId: ctx.bindingId, bindingRevision: ctx.bindingRevision, connectionGeneration: ctx.connectionGeneration }).returning();
    if (!receipt) throw new BolterBridgeAuthorityError();
    const canonical = await persist(tx, binding, receipt.id);
    const control = binding.provider === "magent" && canonical.sessionMessageId === null
      && canonical.controlInput?.kind === "operator_control_v1";
    const conversation = binding.provider === "bolter" && typeof canonical.sessionMessageId === "number"
      && Number.isSafeInteger(canonical.sessionMessageId) && canonical.sessionMessageId > 0 && !canonical.controlInput;
    if ((!control && !conversation) || !canonical.turnId || !canonical.jobId) throw new TypeError("External input identity is missing");
    const [accepted] = await tx.update(bolterInboxReceipts).set({ sessionMessageId: canonical.sessionMessageId, controlInput: canonical.controlInput ?? null, turnId: canonical.turnId, jobId: canonical.jobId, state: "accepted", updatedAt: new Date() }).where(eq(bolterInboxReceipts.id, receipt.id)).returning();
    return { status: "accepted", receipt: accepted! };
  });
}
export function attachBolterInboundJobWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, input: { receiptId: string; jobId: string }) {
  return scoped(db, ctx, async tx => {
    if (!await lockBinding(tx, ctx)) return null;
    const [row] = await tx.update(bolterInboxReceipts).set({ jobId: input.jobId, updatedAt: new Date() }).where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.bindingId, ctx.bindingId), eq(bolterInboxReceipts.id, input.receiptId), eq(bolterInboxReceipts.state, "accepted"), isNull(bolterInboxReceipts.jobId), eq(bolterInboxReceipts.bindingRevision, ctx.bindingRevision), eq(bolterInboxReceipts.connectionGeneration, ctx.connectionGeneration))).returning();
    return row ?? null;
  });
}
/** Stable request identity binds the exact reviewed body and destination. */
export function bolterReviewedTextFingerprint(bindingId: string, requestId: string, content: string, attachments: readonly BolterAttachmentDescriptor[] = []): string {
  const payload = attachments.length ? ["bolter-reviewed-files-v1", bindingId, requestId, content,
    attachments.map(file => [file.id, file.filename, file.mimeType, file.sizeBytes, file.sha256])]
    : ["bolter-reviewed-text-v1", bindingId, requestId, content];
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex");
}

/** Pending capabilities remain bound to their uploader and the exact connected Room. */
export function loadBolterShareAttachmentsWith(db: BolterBridgeDatabase, ctx: BolterBindingContext,
  input: { attachmentIds: readonly string[]; uploaderActorId: string }) {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const binding = await lockBinding(tx, ctx);
    if (!binding) throw new BolterBridgeAuthorityError();
    if (!input.attachmentIds.length) return [];
    const rows = await tx.select().from(messageAttachments).where(and(
      inArray(messageAttachments.id, [...input.attachmentIds]), eq(messageAttachments.namespaceId, binding.namespaceId),
      eq(messageAttachments.uploaderActorId, input.uploaderActorId), inArray(messageAttachments.status, ["pending", "retained"])));
    return input.attachmentIds.map(id => {
      const row = rows.find(item => item.id === id);
      if (!row || (row.status === "pending" && (!row.expiresAt || row.expiresAt <= new Date()))) throw new BolterBridgeAuthorityError();
      return row;
    });
  });
}

/** Called in the same transaction that persists the Human share and outbox. */
export async function retainBolterShareAttachmentsInTx(tx: BolterBridgeTransaction, input: {
  attachments: readonly BolterAttachmentDescriptor[]; uploaderActorId: string; namespaceId: string; fingerprint: string;
}) {
  for (const file of input.attachments) {
    const [row] = await tx.update(messageAttachments).set({ status: "retained", turnId: input.fingerprint,
      resolvedAt: new Date(), expiresAt: null }).where(and(eq(messageAttachments.id, file.id),
      eq(messageAttachments.namespaceId, input.namespaceId), eq(messageAttachments.uploaderActorId, input.uploaderActorId),
      eq(messageAttachments.status, "pending"), gt(messageAttachments.expiresAt, new Date()), isNull(messageAttachments.turnId),
      eq(messageAttachments.filename, file.filename), eq(messageAttachments.mimeType, file.mimeType),
      eq(messageAttachments.sizeBytes, file.sizeBytes))).returning();
    if (!row) throw new BolterBridgeAuthorityError();
  }
}

function shareAttachments(metadata: unknown): readonly BolterAttachmentDescriptor[] | null {
  if (!metadata || typeof metadata !== "object" || !("bolterAttachments" in metadata)) return [];
  const value = metadata.bolterAttachments;
  if (!Array.isArray(value)) return null;
  const parsed = value.map(file => bolterAttachmentDescriptorSchema.safeParse(file));
  if (parsed.some(file => !file.success)) return null;
  const files = parsed.map(file => file.data!);
  return new Set(files.map(file => file.id)).size === files.length ? files : null;
}

/** Trusted Human route only. This operation does not accept model or provider authority. */
export function acceptBolterReviewedShareWith(db: BolterBridgeDatabase, ctx: BolterBindingContext,
  input: { readonly requestId: string; readonly content: string; readonly attachments?: readonly BolterAttachmentDescriptor[] },
  persist: (tx: BolterBridgeTransaction, input: { shareId: string; fingerprint: string; binding: BolterRoomBinding }) => Promise<number>) {
  if (!input.content.trim()) throw new BolterBridgeAuthorityError();
  const digest = bolterReviewedTextFingerprint(ctx.bindingId, input.requestId, input.content, input.attachments);
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const binding = await lockBinding(tx, ctx);
    if (!binding) throw new BolterBridgeAuthorityError();
    const [existing] = await tx.select().from(bolterExplicitShares).where(and(
      eq(bolterExplicitShares.userId, ctx.userId), eq(bolterExplicitShares.requestId, input.requestId))).limit(1);
    if (existing) {
      if (existing.bindingId !== binding.id || existing.fingerprint !== digest) throw new BolterBridgeIdentityConflictError();
      const [outbox] = await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.explicitShareId, existing.id))).limit(1);
      if (!outbox) throw new BolterBridgeAuthorityError();
      return outbox;
    }
    const shareId = randomUUID();
    const sessionMessageId = await persist(tx, { shareId, fingerprint: digest, binding });
    const [canonical] = await tx.select({ content: sessionMessages.content, fingerprint: sessionMessages.fingerprint, metadata: sessionMessages.metadata })
      .from(sessionMessages).where(eq(sessionMessages.id, sessionMessageId)).limit(1);
    if (canonical?.content !== input.content || canonical.fingerprint !== digest) throw new BolterBridgeIdentityConflictError();
    const files = shareAttachments(canonical.metadata);
    if (!files || bolterReviewedTextFingerprint(binding.id, input.requestId, input.content, files) !== digest) throw new BolterBridgeIdentityConflictError();
    await tx.insert(bolterExplicitShares).values({ id: shareId, userId: ctx.userId, bindingId: binding.id,
      bindingRevision: binding.revision, connectionGeneration: ctx.connectionGeneration,
      requestId: input.requestId, sessionMessageId, fingerprint: digest });
    const [outbox] = await tx.insert(bolterOutbox).values({ userId: ctx.userId, bindingId: binding.id,
      bindingRevision: binding.revision, connectionGeneration: ctx.connectionGeneration,
      sessionMessageId, explicitShareId: shareId, fingerprint: digest }).returning();
    if (!outbox) throw new BolterBridgeAuthorityError();
    return outbox;
  });
}

export function enqueueBolterOutboxWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, input: BolterOutboxInsert) {
  fingerprint(input.fingerprint);
  if (!input.sourceInboxId || input.explicitShareId !== undefined) throw new BolterBridgeAuthorityError();
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    if (!await lockBinding(tx, ctx)) return null;
    if (input.sourceInboxId) {
      const [source] = await tx.select().from(bolterInboxReceipts).where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.bindingId, ctx.bindingId), eq(bolterInboxReceipts.id, input.sourceInboxId), eq(bolterInboxReceipts.state, "accepted"), eq(bolterInboxReceipts.bindingRevision, ctx.bindingRevision), eq(bolterInboxReceipts.connectionGeneration, ctx.connectionGeneration))).for("update");
      if (!source) return null;
    }
    const [row] = await tx.insert(bolterOutbox).values({ ...input, userId: ctx.userId, bindingId: ctx.bindingId, bindingRevision: ctx.bindingRevision, connectionGeneration: ctx.connectionGeneration }).onConflictDoNothing({ target: [bolterOutbox.bindingId, bolterOutbox.sessionMessageId] }).returning();
    if (row) return row;
    const [existing] = await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.sessionMessageId, input.sessionMessageId))).for("update");
    if (!existing || existing.fingerprint !== input.fingerprint || existing.sourceInboxId !== (input.sourceInboxId ?? null) || existing.explicitShareId !== (input.explicitShareId ?? null)) throw new BolterBridgeIdentityConflictError();
    return existing;
  });
}

/** Same access-scoped read handle; attribution never supplies content access. */
export async function getBolterCanonicalAttributionsWith(
  db: Pick<BolterBridgeDatabase, "select">, ctx: BolterOwnerContext, messageIds: readonly number[],
): Promise<ReadonlyMap<number, BolterCanonicalAttribution>> {
  if (!messageIds.length) return new Map();
  const rows = await db.select({ receipt: bolterInboxReceipts, binding: bolterRoomBindings,
    ownerId: sessions.ownerId, roomId: sessions.roomId, agentId: sessions.agentId,
    role: sessionMessages.role, humanTurnId: sessionMessages.humanTurnId, metadata: sessionMessages.metadata,
  }).from(bolterInboxReceipts)
    .innerJoin(bolterRoomBindings, eq(bolterRoomBindings.id, bolterInboxReceipts.bindingId))
    .innerJoin(sessionMessages, eq(sessionMessages.id, bolterInboxReceipts.sessionMessageId))
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
    .where(and(eq(bolterInboxReceipts.userId, ctx.userId), inArray(bolterInboxReceipts.sessionMessageId, [...messageIds])));
  const result = new Map<number, BolterCanonicalAttribution>();
  for (const row of rows) {
    const { receipt, binding } = row;
    if (receipt.sessionMessageId === null) continue;
    const origin = parseExternalMessageOrigin(row.metadata?.["externalOrigin"]);
    const valid = origin && row.metadata?.["externalReceiptId"] === receipt.id && row.role === "user"
      && row.ownerId === ctx.userId && binding.userId === ctx.userId && row.roomId === binding.roomId
      && row.agentId === binding.agentId && row.humanTurnId === receipt.turnId
      && origin.connectionId === binding.connectionId && origin.bindingId === binding.id
      && origin.provider === (binding.provider ?? "bolter") && origin.origin === binding.origin && origin.providerAgentId === binding.providerAgentId
      && origin.chatId === binding.chatId && (origin.threadRootId ?? "") === binding.threadId
      && origin.messageId === receipt.providerMessageId && origin.senderId === receipt.externalSenderId;
    result.set(receipt.sessionMessageId, valid ? { status: "verified", origin } : { status: "unverified" });
  }
  return result;
}
export const getBolterCanonicalAttributions = (ctx: BolterOwnerContext, ids: readonly number[]) => scoped(getSharedDirectAgentDb(), ctx, tx => getBolterCanonicalAttributionsWith(tx, ctx, ids));

/** Content-free receipt provenance for already authorized physical message ids. */
export async function getBolterReceiptMessageIdsWith(db: Pick<BolterBridgeDatabase, "select">, ctx: BolterOwnerContext, ids: readonly number[]): Promise<ReadonlySet<number>> {
  if (!ids.length) return new Set<number>();
  const rows = await db.select({ sessionMessageId: bolterInboxReceipts.sessionMessageId }).from(bolterInboxReceipts)
    .where(and(eq(bolterInboxReceipts.userId, ctx.userId), inArray(bolterInboxReceipts.sessionMessageId, [...ids])));
  return new Set(rows.flatMap(row => row.sessionMessageId === null ? [] : [row.sessionMessageId]));
}
export const getBolterReceiptMessageIds = (ctx: BolterOwnerContext, ids: readonly number[]) => scoped(getSharedDirectAgentDb(), ctx, tx => getBolterReceiptMessageIdsWith(tx, ctx, ids));

/** Outgoing canonical messages retain immutable publication provenance too. */
export async function getBolterOutboxMessageIdsWith(db: Pick<BolterBridgeDatabase, "select">, ctx: BolterOwnerContext, ids: readonly number[]): Promise<ReadonlySet<number>> {
  if (!ids.length) return new Set<number>();
  const rows = await db.select({ sessionMessageId: bolterOutbox.sessionMessageId }).from(bolterOutbox)
    .where(and(eq(bolterOutbox.userId, ctx.userId), inArray(bolterOutbox.sessionMessageId, [...ids])));
  return new Set(rows.flatMap(row => row.sessionMessageId === null ? [] : [row.sessionMessageId]));
}
export const getBolterOutboxMessageIds = (ctx: BolterOwnerContext, ids: readonly number[]) => scoped(getSharedDirectAgentDb(), ctx, tx => getBolterOutboxMessageIdsWith(tx, ctx, ids));

/** No prompt or response is ever admitted as durable Job input. */
export function parseExternalRoomJobReference(value: unknown): ExternalRoomJobReference | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const fields = ["kind", "receiptId", "bindingId", "bindingRevision", "connectionGeneration", "acceptanceId", "roomId", "agentId", "turnId"];
  if (Object.keys(row).length !== fields.length || fields.some(field => !(field in row)) || row["kind"] !== "external_room_turn_v1"
    || !Number.isSafeInteger(row["bindingRevision"]) || Number(row["bindingRevision"]) < 0
    || !Number.isSafeInteger(row["connectionGeneration"]) || Number(row["connectionGeneration"]) <= 0) return null;
  for (const field of ["receiptId", "bindingId", "acceptanceId", "roomId", "agentId"]) {
    if (typeof row[field] !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(row[field])) return null;
  }
  if (typeof row["turnId"] !== "string" || !row["turnId"].trim() || hasControlCharacter(row["turnId"])) return null;
  return row as unknown as ExternalRoomJobReference;
}

/** Consent changes revision, fencing any prior admitted receipt or work. */
export function acceptBolterModelSponsorshipWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  input: { bindingId: string; expectedRevision: number }) {
  return scoped(db, ctx, async tx => {
    const [candidate] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.id, input.bindingId), eq(bolterRoomBindings.userId, ctx.userId))).limit(1);
    if (!candidate) return null;
    const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.id, candidate.connectionId), eq(bolterConnections.userId, ctx.userId))).for("update");
    if (!connection || !connection.enabled || connection.revokedAt !== null) return null;
    const [binding] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.id, candidate.id), eq(bolterRoomBindings.userId, ctx.userId))).for("update");
    if (!binding || binding.state !== "active" || binding.revision !== input.expectedRevision) return null;
    if (binding.modelSponsorshipAcceptedAt !== null) return binding;
    const [updated] = await tx.update(bolterRoomBindings).set({ modelSponsorshipAcceptedAt: new Date(), revision: binding.revision + 1, updatedAt: new Date() })
      .where(and(eq(bolterRoomBindings.id, binding.id), eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.revision, input.expectedRevision))).returning();
    await fenceDeliveries(tx, ctx.userId, [binding.id]);
    return updated ?? null;
  });
}

async function lockBolterExecution(tx: BolterBridgeTransaction, ctx: BolterOwnerContext, input: BolterExecutionInput, current: boolean): Promise<Omit<BolterExecution, "sourceMessage" | "session" | "origin"> | null> {
  const reference = parseExternalRoomJobReference(input.reference);
  if (!reference) return null;
  const [candidate] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.id, reference.bindingId), eq(bolterRoomBindings.userId, ctx.userId))).limit(1);
  if (!candidate) return null;
  const [connection] = await tx.select().from(bolterConnections).where(and(eq(bolterConnections.id, candidate.connectionId), eq(bolterConnections.userId, ctx.userId))).for("update");
  const [binding] = await tx.select().from(bolterRoomBindings).where(and(eq(bolterRoomBindings.id, reference.bindingId), eq(bolterRoomBindings.userId, ctx.userId))).for("update");
  if (!connection || !binding || binding.connectionId !== connection.id || binding.roomId !== reference.roomId || binding.agentId !== reference.agentId) return null;
  const receiverContext: BolterBindingContext = { userId: ctx.userId, connectionId: connection.id,
    transportKind: connection.transportKind, operatorBindingId: connection.operatorBindingId, relayId: connection.relayId,
    desktopSessionId: connection.desktopSessionId, pairingGenerationRef: connection.pairingGenerationRef,
    connectionGeneration: reference.connectionGeneration, bindingId: binding.id, bindingRevision: reference.bindingRevision };
  if (current && (!bolterReceiverMatches(connection, receiverContext) || !bolterBindingMatches(binding, receiverContext)
    || binding.modelSponsorshipAcceptedAt === null)) return null;
  if (current) {
    const allowed = await tx.execute(sql`SELECT 1 AS allowed WHERE public.bolter_room_admission(${ctx.userId}::uuid, ${binding.roomId}::uuid, ${binding.namespaceId}::uuid, ${binding.agentId}::uuid)`);
    if (Array.from(allowed).length !== 1) return null;
  }
  const [receipt] = await tx.select().from(bolterInboxReceipts).where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.id, reference.receiptId), eq(bolterInboxReceipts.bindingId, binding.id))).for("update");
  if (!receipt || receipt.jobId !== input.jobId || receipt.turnId !== reference.turnId || receipt.bindingRevision !== reference.bindingRevision
    || receipt.connectionGeneration !== reference.connectionGeneration || (receipt.sessionMessageId === null && receipt.controlInput === null) || (current && receipt.state !== "accepted")) return null;
  // Link/update paths take the acceptance lock before the Job FK key lock.
  const [acceptance] = await tx.select().from(workAcceptances).where(eq(workAcceptances.id, reference.acceptanceId)).for("update");
  const [job] = await tx.select().from(jobs).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId),
    eq(jobs.roomId, binding.roomId), eq(jobs.type, "foreground"), eq(jobs.laneKey, `room:${binding.roomId}`), eq(jobs.input, { ...reference }))).for("update");
  if (!acceptance || acceptance.kind !== "foreground" || !job || (acceptance.jobId !== null && acceptance.jobId !== job.id)) return null;
  return { reference, receipt, binding, connection, receiverContext, job, acceptance };
}

async function hydrateBolterExecution(tx: BolterBridgeTransaction, ctx: BolterOwnerContext,
  execution: Omit<BolterExecution, "sourceMessage" | "session" | "origin">): Promise<BolterExecution | null> {
  if (execution.receipt.controlInput !== null) {
    const control = execution.receipt.controlInput;
    const origin = parseExternalMessageOrigin(control.origin);
    const binding = execution.binding;
    if (binding.provider !== "magent" || execution.connection.transportKind !== "operator-unix"
      || execution.receipt.sessionMessageId !== null || control.kind !== "operator_control_v1" || !origin
      || origin.provider !== "magent" || origin.bindingId !== binding.id || origin.connectionId !== execution.connection.id
      || origin.origin !== binding.origin || origin.providerAgentId !== binding.providerAgentId
      || origin.chatId !== binding.chatId || (origin.threadRootId ?? "") !== binding.threadId
      || origin.messageId !== execution.receipt.providerMessageId || origin.senderId !== execution.receipt.externalSenderId
      || origin.senderType !== "anima") return null;
    const digest = createHash("sha256").update(JSON.stringify([origin.provider, origin.origin, origin.providerAgentId,
      origin.chatId, origin.threadRootId, origin.messageId, origin.senderId, origin.senderType, origin.createdAt, control.content])).digest("hex");
    if (digest !== execution.receipt.fingerprint) return null;
    return { ...execution, origin, sourceMessage: { id: null, content: control.content },
      session: { id: null, threadId: `room:${binding.roomId}:operator:${execution.receipt.id}` } };
  }
  // Old operator receipts must never resume through the human conversation path.
  if (execution.binding.provider === "magent") return null;
  const [canonical] = await tx.select({ sourceMessage: sessionMessages, session: sessions }).from(sessionMessages)
    .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId)).where(and(eq(sessionMessages.id, execution.receipt.sessionMessageId!),
      eq(sessionMessages.role, "user"), eq(sessionMessages.humanTurnId, execution.reference.turnId), eq(sessions.ownerId, ctx.userId),
      eq(sessions.roomId, execution.binding.roomId), eq(sessions.agentId, execution.binding.agentId))).limit(1);
  if (!canonical || !canonical.sourceMessage.externalAuthorship || typeof canonical.sourceMessage.content !== "string") return null;
  const attribution = (await getBolterCanonicalAttributionsWith(tx, ctx, [canonical.sourceMessage.id])).get(canonical.sourceMessage.id);
  if (attribution?.status !== "verified") return null;
  const origin = attribution.origin;
  const digest = createHash("sha256").update(JSON.stringify([origin.provider, origin.origin, origin.providerAgentId,
    origin.chatId, origin.threadRootId, origin.messageId, origin.senderId, origin.senderType, origin.createdAt,
    canonical.sourceMessage.content]), "utf8").digest("hex");
  if (digest !== execution.receipt.fingerprint) return null;
  return { ...execution, ...canonical, origin };
}

export function loadBolterExecutionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: BolterExecutionInput): Promise<BolterExecution | null> {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const execution = await lockBolterExecution(tx, ctx, input, true);
    if (!execution || !["accepted", "dispatched"].includes(execution.acceptance.status)) return null;
    return hydrateBolterExecution(tx, ctx, execution);
  });
}

/** Receipt-derived lookup for duplicate delivery; never allocates replacement work. */
export function getBolterExecutionInputForReceiptWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, receiptId: string): Promise<BolterExecutionInput | null> {
  return scoped(db, ctx, async tx => {
    const [row] = await tx.select({ jobId: jobs.id, input: jobs.input }).from(bolterInboxReceipts)
      .innerJoin(jobs, eq(jobs.id, bolterInboxReceipts.jobId)).where(and(eq(bolterInboxReceipts.id, receiptId),
        eq(bolterInboxReceipts.userId, ctx.userId), eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId))).limit(1);
    const reference = parseExternalRoomJobReference(row?.input);
    return row && reference?.receiptId === receiptId ? { jobId: row.jobId, reference } : null;
  });
}

export function linkBolterExecutionAcceptanceWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: BolterExecutionInput): Promise<"linked" | "rejected"> {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const execution = await lockBolterExecution(tx, ctx, input, true);
    if (!execution || execution.job.status !== "queued" || execution.job.startedAt !== null || execution.job.completedAt !== null) return "rejected";
    if (execution.acceptance.status === "dispatched" && execution.acceptance.jobId === input.jobId) return "linked";
    if (execution.acceptance.status !== "accepted" || execution.acceptance.jobId !== null) return "rejected";
    await tx.update(workAcceptances).set({ status: "dispatched", jobId: input.jobId, dispatchedAt: new Date() })
      .where(and(eq(workAcceptances.id, input.reference.acceptanceId), eq(workAcceptances.status, "accepted"), isNull(workAcceptances.jobId)));
    return "linked";
  });
}

export function startBolterExecutionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: BolterExecutionInput & { executionClaim?: ExternalRoomExecutionClaim }): Promise<"started" | "rejected"> {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const execution = await lockBolterExecution(tx, ctx, input, true);
    if (!execution || execution.acceptance.status !== "dispatched" || execution.acceptance.jobId !== input.jobId) return "rejected";
    if (!input.executionClaim || input.executionClaim.jobId !== input.jobId || input.executionClaim.roomId !== execution.binding.roomId) return "rejected";
    await installExternalRoomExecutionClaimContext(tx, input.executionClaim);
    const [started] = await tx.update(jobs).set({ status: "running", startedAt: new Date() }).where(and(eq(jobs.id, input.jobId),
      eq(jobs.ownerId, ctx.userId), eq(jobs.status, "queued"), isNull(jobs.startedAt), isNull(jobs.completedAt))).returning({ id: jobs.id });
    return started ? "started" : "rejected";
  });
}

export function settleBolterExecutionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  input: BolterExecutionInput & { status: "failed" | "cancelled" | "timed_out" | "completed"; reason?: "process_lost" | "user_stop" | "authority_withdrawn" | "execution_failed" | "maintenance"; expectedPredecessor?: "queued" | "running" }): Promise<BolterExecutionSettlement> {
  return scoped(db, ctx, async tx => {
    const execution = await lockBolterExecution(tx, ctx, input, false);
    if (!execution) {
      const reference = parseExternalRoomJobReference(input.reference);
      if (!reference) return { kind: "rejected" };
      // Provenance deletion may legitimately precede a live executor's Stop
      // callback. Observe exact failure only; never reconstruct execution authority.
      const [terminal] = await tx.select({ status: jobs.status }).from(jobs).where(and(eq(jobs.id, input.jobId),
        eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId), eq(jobs.roomId, reference.roomId),
        eq(jobs.type, "foreground"), eq(jobs.laneKey, `room:${reference.roomId}`), eq(jobs.input, { ...reference }),
        isNotNull(jobs.completedAt), inArray(jobs.status, ["cancelled", "failed", "timed_out"]))).limit(1);
      return terminal ? { kind: "existing_terminal", status: terminal.status } : { kind: "rejected" };
    }
    if (["completed", "failed", "cancelled", "timed_out"].includes(execution.job.status) && execution.job.completedAt !== null) {
      if (execution.job.status === "completed") {
        const [publication] = await tx.select({ id: bolterOutbox.id }).from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId),
          eq(bolterOutbox.sourceInboxId, execution.receipt.id), eq(bolterOutbox.bindingId, execution.binding.id),
          eq(bolterOutbox.bindingRevision, input.reference.bindingRevision), eq(bolterOutbox.connectionGeneration, input.reference.connectionGeneration))).limit(1);
        if (!publication) return { kind: "rejected" };
      }
      return { kind: "existing_terminal", status: execution.job.status };
    }
    if (input.status === "completed" || (execution.job.status !== (input.expectedPredecessor ?? "queued")) || !["queued", "running"].includes(execution.job.status)) return { kind: "rejected" };
    if (input.reason === "process_lost" && execution.job.status !== "running") return { kind: "rejected" };
    await tx.update(jobs).set({ status: input.status, completedAt: new Date(), message: input.reason ?? "execution_failed" }).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ctx.userId), inArray(jobs.status, ["queued", "running"]), isNull(jobs.completedAt)));
    if (execution.acceptance.status === "accepted") await tx.update(workAcceptances).set({ status: input.status === "cancelled" && input.reason === "user_stop" ? "user_cancelled" : "maintenance_cancelled", cancelledAt: new Date(), cancellationReason: input.reason ?? "execution_failed" }).where(and(eq(workAcceptances.id, execution.acceptance.id), eq(workAcceptances.status, "accepted")));
    await tx.update(bolterOutbox).set({ state: sql`CASE WHEN ${bolterOutbox.state} = 'publishing' THEN 'uncertain' ELSE 'cancelled' END`, updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.sourceInboxId, execution.receipt.id), inArray(bolterOutbox.state, ["pending", "publishing"])));
    return { kind: "transitioned", status: input.status };
  });
}

export function completeBolterExecutionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, input: BolterExecutionInput,
  persistFinal: (tx: BolterBridgeTransaction, execution: BolterExecution) => Promise<{ sessionMessageId: number | null; controlResult?: string; fingerprint: string }>) {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const execution = await lockBolterExecution(tx, ctx, input, true);
    if (!execution || execution.acceptance.status !== "dispatched" || execution.acceptance.jobId !== input.jobId) return null;
    if (execution.job.status === "completed") return (await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.sourceInboxId, execution.receipt.id))).limit(1))[0] ?? null;
    if (execution.job.status !== "running" || execution.job.startedAt === null || execution.job.completedAt !== null) return null;
    const hydrated = await hydrateBolterExecution(tx, ctx, execution);
    if (!hydrated) return null;
    const final = await persistFinal(tx, hydrated);
    const validFinal = hydrated.receipt.controlInput !== null
      ? final.sessionMessageId === null && !!final.controlResult?.trim()
      : typeof final.sessionMessageId === "number" && Number.isSafeInteger(final.sessionMessageId)
        && final.sessionMessageId > 0 && final.controlResult === undefined;
    if (!validFinal) throw new TypeError("External result identity is missing");
    fingerprint(final.fingerprint);
    await tx.update(jobs).set({ status: "completed", completedAt: new Date() }).where(and(eq(jobs.id, input.jobId), eq(jobs.ownerId, ctx.userId), eq(jobs.status, "running"), isNull(jobs.completedAt)));
    const [outbox] = await tx.insert(bolterOutbox).values({ userId: ctx.userId, bindingId: execution.binding.id,
      bindingRevision: input.reference.bindingRevision, connectionGeneration: input.reference.connectionGeneration,
      sourceInboxId: execution.receipt.id, sessionMessageId: final.sessionMessageId, controlResult: final.controlResult ?? null, fingerprint: final.fingerprint }).returning();
    if (!outbox) throw new BolterBridgeAuthorityError();
    return outbox;
  });
}

export function listRecoverableBolterExecutionsWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext): Promise<BolterExecutionInput[]> {
  return scoped(db, ctx, async tx => {
    const rows = await tx.select({ id: jobs.id, input: jobs.input }).from(jobs).where(and(eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId), eq(jobs.type, "foreground"), inArray(jobs.status, ["queued", "running"]), isNull(jobs.completedAt), sql`${jobs.input}->>'kind' = 'external_room_turn_v1'`)).orderBy(jobs.createdAt, jobs.id);
    return rows.flatMap(row => { const reference = parseExternalRoomJobReference(row.input); return reference ? [{ jobId: row.id, reference }] : []; });
  });
}
export interface BolterRecoveryCursor { readonly createdAt: Date; readonly jobId: string }
const recoverableBolterJobs = (ctx: BolterOwnerContext) => and(eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId),
  eq(jobs.type, "foreground"), inArray(jobs.status, ["queued", "running"]), isNull(jobs.completedAt), sql`${jobs.input}->>'kind' = 'external_room_turn_v1'`);
/** Fixed upper coordinate bounds a pass even while new work arrives. */
export function getBolterRecoveryWindowWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext): Promise<BolterRecoveryCursor | null> {
  return scoped(db, ctx, async tx => {
    const [row] = await tx.select({ createdAt: jobs.createdAt, jobId: jobs.id }).from(jobs).where(recoverableBolterJobs(ctx))
      .orderBy(desc(sql`date_trunc('milliseconds', ${jobs.createdAt})`), desc(jobs.id)).limit(1);
    return row ?? null;
  });
}
/** Malformed refs advance the cursor without hydrating content or creating work. */
export function nextBolterRecoverableExecutionWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext,
  options: { readonly upperBound: BolterRecoveryCursor; readonly after?: BolterRecoveryCursor }): Promise<{ cursor: BolterRecoveryCursor; execution: BolterExecutionInput | null } | null> {
  return scoped(db, ctx, async tx => {
    const [row] = await tx.select({ id: jobs.id, input: jobs.input, createdAt: jobs.createdAt }).from(jobs).where(and(recoverableBolterJobs(ctx),
      sql`(date_trunc('milliseconds', ${jobs.createdAt}), ${jobs.id}) <= (${options.upperBound.createdAt.toISOString()}::timestamptz, ${options.upperBound.jobId}::uuid)`,
      options.after ? sql`(date_trunc('milliseconds', ${jobs.createdAt}), ${jobs.id}) > (${options.after.createdAt.toISOString()}::timestamptz, ${options.after.jobId}::uuid)` : undefined))
      .orderBy(sql`date_trunc('milliseconds', ${jobs.createdAt})`, jobs.id).limit(1);
    if (!row) return null;
    const reference = parseExternalRoomJobReference(row.input);
    return { cursor: { createdAt: row.createdAt, jobId: row.id }, execution: reference ? { jobId: row.id, reference } : null };
  });
}
export const getBolterRecoveryWindow = (ctx: BolterOwnerContext) => getBolterRecoveryWindowWith(getSharedDirectAgentDb(), ctx);
export const nextBolterRecoverableExecution = (ctx: BolterOwnerContext, options: Parameters<typeof nextBolterRecoverableExecutionWith>[2]) => nextBolterRecoverableExecutionWith(getSharedDirectAgentDb(), ctx, options);
export const acceptBolterModelSponsorship = (ctx: BolterOwnerContext, input: Parameters<typeof acceptBolterModelSponsorshipWith>[2]) => acceptBolterModelSponsorshipWith(getSharedDirectAgentDb(), ctx, input);
export const getBolterExecutionInputForReceipt = (ctx: BolterOwnerContext, receiptId: string) => getBolterExecutionInputForReceiptWith(getSharedDirectAgentDb(), ctx, receiptId);
export const loadBolterExecution = (ctx: BolterOwnerContext, input: BolterExecutionInput) => loadBolterExecutionWith(getSharedDirectAgentDb(), ctx, input);
export const linkBolterExecutionAcceptance = (ctx: BolterOwnerContext, input: BolterExecutionInput) => linkBolterExecutionAcceptanceWith(getSharedDirectAgentDb(), ctx, input);
export const startBolterExecution = (ctx: BolterOwnerContext, input: Parameters<typeof startBolterExecutionWith>[2]) => startBolterExecutionWith(getSharedDirectAgentDb(), ctx, input);
export const settleBolterExecution = (ctx: BolterOwnerContext, input: Parameters<typeof settleBolterExecutionWith>[2]) => settleBolterExecutionWith(getSharedDirectAgentDb(), ctx, input);
export const completeBolterExecution = (ctx: BolterOwnerContext, input: BolterExecutionInput, persist: Parameters<typeof completeBolterExecutionWith>[3]) => completeBolterExecutionWith(getSharedDirectAgentDb(), ctx, input, persist);
export const listRecoverableBolterExecutions = (ctx: BolterOwnerContext) => listRecoverableBolterExecutionsWith(getSharedDirectAgentDb(), ctx);
export function claimBolterOutboxWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, outboxId: string, claimToken?: string) {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    if (!await lockBinding(tx, ctx)) return null;
    const [row] = await tx.update(bolterOutbox).set({ state: "publishing", claimToken: claimToken ?? randomUUID(), updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.id, outboxId), eq(bolterOutbox.bindingRevision, ctx.bindingRevision), eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration), eq(bolterOutbox.state, "pending"))).returning();
    if (row) return row;
    if (!claimToken) return null;
    return (await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId),
      eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.id, outboxId), eq(bolterOutbox.claimToken, claimToken),
      eq(bolterOutbox.state, "publishing"), eq(bolterOutbox.bindingRevision, ctx.bindingRevision),
      eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration))).limit(1))[0] ?? null;
  });
}
/** A sender must recheck the same claim immediately before provider dispatch. */
export function getBolterPublicationClaimWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, input: { outboxId: string; claimToken: string }) {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    if (!await lockBinding(tx, ctx)) return null;
    return (await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.id, input.outboxId), eq(bolterOutbox.claimToken, input.claimToken), eq(bolterOutbox.state, "publishing"), eq(bolterOutbox.bindingRevision, ctx.bindingRevision), eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration))).limit(1))[0] ?? null;
  });
}

/** Only canonical, completed reply text and its exact provider destination. */
export interface BolterPublicationContent {
  readonly origin: string;
  readonly providerAgentId: string;
  readonly chatId: string;
  readonly threadRootId: string | null;
  readonly content: string;
  readonly files?: readonly (BolterAttachmentDescriptor & { readonly storageUri: string })[];
}

/**
 * Revalidate content, causality and current audience before handing a claimed
 * reply to Desktop. No caller-provided text, destination or share ID is used.
 * This read does not prove provider delivery or authorize a later retry.
 */
export function loadBolterPublicationContentWith(db: BolterBridgeDatabase, ctx: BolterBindingContext,
  input: { outboxId: string; claimToken: string }): Promise<BolterPublicationContent | null> {
  return scoped(db, ctx, async tx => {
    await externalPlaintextFence(tx);
    const binding = await lockBinding(tx, ctx);
    if (!binding || !binding.modelSponsorshipAcceptedAt) return null;
    const predicate = and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, ctx.bindingId),
      eq(bolterOutbox.id, input.outboxId), eq(bolterOutbox.claimToken, input.claimToken),
      eq(bolterOutbox.state, "publishing"), eq(bolterOutbox.bindingRevision, ctx.bindingRevision),
      eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration));
    const [candidate] = await tx.select().from(bolterOutbox).where(predicate).limit(1);
    if (!candidate || (candidate.sourceInboxId !== null) === (candidate.explicitShareId !== null)) return null;
    if (candidate.explicitShareId !== null) {
      if ((binding.provider ?? "bolter") !== "bolter") return null;
      const [share] = await tx.select().from(bolterExplicitShares).where(and(
        eq(bolterExplicitShares.id, candidate.explicitShareId), eq(bolterExplicitShares.userId, ctx.userId),
        eq(bolterExplicitShares.bindingId, binding.id), eq(bolterExplicitShares.bindingRevision, ctx.bindingRevision),
        eq(bolterExplicitShares.connectionGeneration, ctx.connectionGeneration))).limit(1);
      if (!share || share.sessionMessageId !== candidate.sessionMessageId || share.fingerprint !== candidate.fingerprint) return null;
      const [claim] = await tx.select().from(bolterOutbox).where(predicate).for("update");
      if (!claim || claim.explicitShareId !== share.id || claim.sourceInboxId !== null) return null;
      const [message] = await tx.select({ content: sessionMessages.content, fingerprint: sessionMessages.fingerprint, metadata: sessionMessages.metadata })
        .from(sessionMessages).innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId)).where(and(
          eq(sessionMessages.id, share.sessionMessageId), eq(sessions.ownerId, ctx.userId), eq(sessions.roomId, binding.roomId),
          eq(sessions.agentId, binding.agentId), eq(sessionMessages.role, "user"), eq(sessionMessages.externalAuthorship, false),
          eq(sessionMessages.transcriptOrigin, "main"), isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),
          sql`${sessionMessages.metadata}->'bolterReviewedShare' = ${JSON.stringify({ shareId: share.id, requestId: share.requestId })}::jsonb`
        )).limit(1);
      const files = shareAttachments(message?.metadata);
      if (!message || !files || typeof message.content !== "string" || !message.content.trim()
        || bolterReviewedTextFingerprint(binding.id, share.requestId, message.content, files) !== share.fingerprint
        || message.fingerprint !== share.fingerprint) return null;
      const retained = files.length ? await tx.select().from(messageAttachments).where(and(
        inArray(messageAttachments.id, files.map(file => file.id)), eq(messageAttachments.namespaceId, binding.namespaceId),
        eq(messageAttachments.status, "retained"), eq(messageAttachments.turnId, share.fingerprint))) : [];
      const selected = files.map(file => {
        const row = retained.find(item => item.id === file.id && item.filename === file.filename && item.mimeType === file.mimeType && item.sizeBytes === file.sizeBytes);
        return row ? { ...file, storageUri: row.storageUri } : null;
      });
      if (selected.some(file => file === null)) return null;
      return Object.freeze({ origin: binding.origin, providerAgentId: binding.providerAgentId,
        chatId: binding.chatId, threadRootId: binding.threadId || null, content: message.content,
        ...(files.length ? { files: selected as (BolterAttachmentDescriptor & { storageUri: string })[] } : {}) });
    }
    if (!candidate.sourceInboxId || !binding.modelSponsorshipAcceptedAt) return null;
    const [work] = await tx.select({ jobId: jobs.id, input: jobs.input }).from(bolterInboxReceipts)
      .innerJoin(jobs, eq(jobs.id, bolterInboxReceipts.jobId)).where(and(
        eq(bolterInboxReceipts.id, candidate.sourceInboxId), eq(bolterInboxReceipts.userId, ctx.userId),
        eq(bolterInboxReceipts.bindingId, ctx.bindingId), eq(jobs.ownerId, ctx.userId), eq(jobs.requestorId, ctx.userId))).limit(1);
    const reference = parseExternalRoomJobReference(work?.input);
    if (!work || !reference || reference.receiptId !== candidate.sourceInboxId
      || reference.bindingId !== ctx.bindingId || reference.bindingRevision !== ctx.bindingRevision
      || reference.connectionGeneration !== ctx.connectionGeneration) return null;
    // Preserve the execution lock order: connection, binding, receipt,
    // acceptance, Job, then outbox. No network operation runs in this transaction.
    const execution = await lockBolterExecution(tx, ctx, { jobId: work.jobId, reference }, true);
    if (!execution || execution.job.status !== "completed" || execution.job.startedAt === null
      || execution.job.completedAt === null || execution.acceptance.status !== "dispatched"
      || execution.acceptance.jobId !== work.jobId || execution.acceptance.dispatchedAt === null
      || execution.acceptance.cancelledAt !== null) return null;
    const hydrated = await hydrateBolterExecution(tx, ctx, execution);
    if (!hydrated || execution.connection.origin !== binding.origin
      || execution.connection.providerAgentId !== binding.providerAgentId) return null;
    const [claim] = await tx.select().from(bolterOutbox).where(predicate).for("update");
    if (!claim || claim.sourceInboxId !== reference.receiptId || claim.explicitShareId !== null) return null;
    if (hydrated.receipt.controlInput !== null) {
      if (claim.sessionMessageId !== null || !claim.controlResult?.trim()) return null;
      const digest = createHash("sha256").update(JSON.stringify([
        "external-room-final-v1", reference.receiptId, work.jobId, claim.controlResult,
      ])).digest("hex");
      if (digest !== claim.fingerprint) return null;
      return Object.freeze({ origin: binding.origin, providerAgentId: binding.providerAgentId,
        chatId: binding.chatId, threadRootId: binding.threadId || null, content: claim.controlResult });
    }
    if (claim.sessionMessageId === null || hydrated.session.id === null) return null;
    const [message] = await tx.select({ content: sessionMessages.content, fingerprint: sessionMessages.fingerprint })
      .from(sessionMessages).where(and(eq(sessionMessages.id, claim.sessionMessageId),
        eq(sessionMessages.sessionId, hydrated.session.id), eq(sessionMessages.role, "assistant"),
        eq(sessionMessages.transcriptOrigin, "main"), isNull(sessionMessages.humanTurnId),
        isNull(sessionMessages.toolCalls), isNull(sessionMessages.toolName),
        eq(sessionMessages.replyToMessageId, execution.receipt.sessionMessageId!),
        sql`${sessionMessages.metadata}->'externalFinalReply' = ${JSON.stringify({
          kind: hydrated.origin.provider === "bolter" ? "bolter_final_reply_v1" : "external_room_final_reply_v1", receiptId: reference.receiptId, jobId: work.jobId,
          turnId: reference.turnId, acceptanceId: reference.acceptanceId,
        })}::jsonb`)).limit(1);
    if (!message || typeof message.content !== "string" || !message.content.trim()) return null;
    const digest = createHash("sha256").update(JSON.stringify([
      "external-room-final-v1", reference.receiptId, work.jobId, message.content,
    ]), "utf8").digest("hex");
    if (digest !== claim.fingerprint || digest !== message.fingerprint) return null;
    return Object.freeze({ origin: binding.origin, providerAgentId: binding.providerAgentId,
      chatId: binding.chatId, threadRootId: binding.threadId || null, content: message.content });
  });
}
export function settleBolterOutboxWith(db: BolterBridgeDatabase, ctx: BolterBindingContext, input: { outboxId: string; claimToken: string } & ({ state: "published"; providerMessageId: string } | { state: "uncertain" | "cancelled" })) {
  if (input.state === "published") opaque(input.providerMessageId);
  return scoped(db, ctx, async tx => {
    // Repeated acknowledgement reveals no content and cannot resurrect a cancelled claim.
    const [existing] = await tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId),
      eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.id, input.outboxId), eq(bolterOutbox.claimToken, input.claimToken),
      eq(bolterOutbox.bindingRevision, ctx.bindingRevision), eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration))).limit(1);
    if (existing?.state === input.state && existing.providerMessageId === (input.state === "published" ? input.providerMessageId : null)) return existing;
    // Lost authority cannot claim success. Recovery retains uncertainty.
    if (!await lockBinding(tx, ctx)) return null;
    const [row] = await tx.update(bolterOutbox).set({ state: input.state, providerMessageId: input.state === "published" ? input.providerMessageId : null, updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, ctx.bindingId), eq(bolterOutbox.id, input.outboxId), eq(bolterOutbox.claimToken, input.claimToken), eq(bolterOutbox.state, "publishing"), eq(bolterOutbox.bindingRevision, ctx.bindingRevision), eq(bolterOutbox.connectionGeneration, ctx.connectionGeneration))).returning();
    return row ?? null;
  });
}
/** Called only after the server proves the preceding receiver generation retired. */
export function recoverBolterOutboxWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, connectionId: string) {
  return scoped(db, ctx, async tx => {
    await tx.select().from(bolterConnections).where(and(eq(bolterConnections.userId, ctx.userId), eq(bolterConnections.id, connectionId))).for("update");
    const bindings = await tx.select({ id: bolterRoomBindings.id }).from(bolterRoomBindings).where(and(eq(bolterRoomBindings.userId, ctx.userId), eq(bolterRoomBindings.connectionId, connectionId))).for("update");
    if (!bindings.length) return [];
    return tx.update(bolterOutbox).set({ state: "uncertain", updatedAt: new Date() }).where(and(eq(bolterOutbox.userId, ctx.userId), inArray(bolterOutbox.bindingId, bindings.map(binding => binding.id)), eq(bolterOutbox.state, "publishing"))).returning();
  });
}
export function listBolterOutboxWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, bindingId: string) {
  return scoped(db, ctx, tx => tx.select().from(bolterOutbox).where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, bindingId))).orderBy(bolterOutbox.createdAt, bolterOutbox.id));
}
export function getBolterInboxReceiptWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, receiptId: string) {
  return scoped(db, ctx, async tx => (await tx.select().from(bolterInboxReceipts).where(and(eq(bolterInboxReceipts.userId, ctx.userId), eq(bolterInboxReceipts.id, receiptId))).limit(1))[0] ?? null);
}

export const listBolterConnections = (ctx: BolterOwnerContext) => listBolterConnectionsWith(getSharedDirectAgentDb(), ctx);
export const getBolterConnection = (ctx: BolterOwnerContext, id: string) => getBolterConnectionWith(getSharedDirectAgentDb(), ctx, id);
export const createBolterConnection = (ctx: BolterOwnerContext, input: BolterConnectionInsert) => createBolterConnectionWith(getSharedDirectAgentDb(), ctx, input);
export const listBolterBindings = (ctx: BolterOwnerContext, connectionId?: string) => listBolterBindingsWith(getSharedDirectAgentDb(), ctx, connectionId);
export const getBolterBinding = (ctx: BolterOwnerContext, id: string) => getBolterBindingWith(getSharedDirectAgentDb(), ctx, id);
export const resolveBolterBinding = (ctx: BolterReceiverContext, input: Parameters<typeof resolveBolterBindingWith>[2]) => resolveBolterBindingWith(getSharedDirectAgentDb(), ctx, input);
export const createFreshBolterBinding = (ctx: BolterReceiverContext, createRoom: Parameters<typeof createFreshBolterBindingWith>[2]) => createFreshBolterBindingWith(getSharedDirectDb(), ctx, createRoom);
export const setBolterConnectionState = (ctx: BolterOwnerContext, input: Parameters<typeof setBolterConnectionStateWith>[2]) => setBolterConnectionStateWith(getSharedDirectAgentDb(), ctx, input);
export const setBolterBindingState = (ctx: BolterBindingContext, state: "paused" | "revoked") => setBolterBindingStateWith(getSharedDirectAgentDb(), ctx, state);
export const updateBolterBindingState = (ctx: BolterOwnerContext, input: Parameters<typeof updateBolterBindingStateWith>[2]) => updateBolterBindingStateWith(getSharedDirectAgentDb(), ctx, input);
export const rotateBolterReceiver = (ctx: BolterOwnerContext, input: Parameters<typeof rotateBolterReceiverWith>[2]) => rotateBolterReceiverWith(getSharedDirectAgentDb(), ctx, input);
export const acceptBolterInbound = (ctx: BolterBindingContext, input: BolterInboundInsert, persist: Parameters<typeof acceptBolterInboundWith>[3]) => acceptBolterInboundWith(getSharedDirectAgentDb(), ctx, input, persist);
export const attachBolterInboundJob = (ctx: BolterBindingContext, input: Parameters<typeof attachBolterInboundJobWith>[2]) => attachBolterInboundJobWith(getSharedDirectAgentDb(), ctx, input);
export const enqueueBolterOutbox = (ctx: BolterBindingContext, input: BolterOutboxInsert) => enqueueBolterOutboxWith(getSharedDirectAgentDb(), ctx, input);
export const claimBolterOutbox = (ctx: BolterBindingContext, id: string) => claimBolterOutboxWith(getSharedDirectAgentDb(), ctx, id);
export const getBolterPublicationClaim = (ctx: BolterBindingContext, input: Parameters<typeof getBolterPublicationClaimWith>[2]) => getBolterPublicationClaimWith(getSharedDirectAgentDb(), ctx, input);
export const settleBolterOutbox = (ctx: BolterBindingContext, input: Parameters<typeof settleBolterOutboxWith>[2]) => settleBolterOutboxWith(getSharedDirectAgentDb(), ctx, input);
export const recoverBolterOutbox = (ctx: BolterOwnerContext, id: string) => recoverBolterOutboxWith(getSharedDirectAgentDb(), ctx, id);
export const listBolterOutbox = (ctx: BolterOwnerContext, bindingId: string) => listBolterOutboxWith(getSharedDirectAgentDb(), ctx, bindingId);
export const getBolterInboxReceipt = (ctx: BolterOwnerContext, id: string) => getBolterInboxReceiptWith(getSharedDirectAgentDb(), ctx, id);

/** Owner-only request reconciliation; reply deliveries have no Human share request. */
export function getBolterDeliveryCountsWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, bindingId: string) {
  return scoped(db, ctx, async tx => {
    const rows = await tx.select({ state: bolterOutbox.state, quantity: count() }).from(bolterOutbox).where(and(
      eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, bindingId),
      inArray(bolterOutbox.state, ["pending", "publishing", "uncertain"]))).groupBy(bolterOutbox.state);
    return { pending: rows.filter(row => row.state === "pending" || row.state === "publishing").reduce((sum, row) => sum + row.quantity, 0),
      uncertain: rows.find(row => row.state === "uncertain")?.quantity ?? 0 };
  });
}
export function listBolterDeliverySummariesWith(db: BolterBridgeDatabase, ctx: BolterOwnerContext, bindingId: string,
  selection?: { outboxId?: string | undefined; requestId?: string | undefined }) {
  return scoped(db, ctx, tx => tx.select({ messageId: bolterOutbox.sessionMessageId, outboxId: bolterOutbox.id,
    state: bolterOutbox.state, createdAt: bolterOutbox.createdAt, requestId: bolterExplicitShares.requestId })
    .from(bolterOutbox).leftJoin(bolterExplicitShares, and(eq(bolterExplicitShares.id, bolterOutbox.explicitShareId),
      eq(bolterExplicitShares.userId, bolterOutbox.userId), eq(bolterExplicitShares.bindingId, bolterOutbox.bindingId)))
    .where(and(eq(bolterOutbox.userId, ctx.userId), eq(bolterOutbox.bindingId, bindingId),
      ...(selection?.outboxId ? [eq(bolterOutbox.id, selection.outboxId)] : []),
      ...(selection?.requestId ? [eq(bolterExplicitShares.requestId, selection.requestId)] : []))).orderBy(bolterOutbox.createdAt, bolterOutbox.id));
}
