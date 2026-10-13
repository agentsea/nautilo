import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { getSharedDirectDb } from "../config/direct-database";
import { withTrustContext } from "../connection/with-trust-context";
import { externalRoomExecutionClaims } from "../schema/external-room-execution-claims";
import { jobs } from "../schema/jobs";
import { users } from "../schema/users";
import { moderationAccessAllowedSql } from "./moderation-admission";
import { actors } from "../schema/trust";
import { rooms, roomMembers } from "../schema/rooms";

export interface ExternalRoomExecutionClaim { readonly roomId: string; readonly jobId: string; readonly token: string }
export type ExternalRoomExecutionClaimResult = { readonly kind: "ordinary" } | ({ readonly kind: "claimed" } & ExternalRoomExecutionClaim)
  | { readonly kind: "busy" | "unavailable" };
export interface ExternalRoomExecutionOwnerContext { readonly userId: string }
export type ExternalRoomExecutionProductDatabase = ReturnType<typeof getSharedDirectDb>;

/** Privileged product role: explicit owner predicates, not an RLS isolation claim. */
export async function acquireExternalRoomExecutionClaimWith(db: ExternalRoomExecutionProductDatabase,
  ctx: ExternalRoomExecutionOwnerContext, jobId: string): Promise<ExternalRoomExecutionClaimResult> {
  try {
    return await withTrustContext(ctx, async tx => {
      const [candidate] = await tx.select({ roomId: jobs.roomId, type: jobs.type }).from(jobs).where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ctx.userId))).limit(1);
      if (!candidate) return { kind: "unavailable" };
      if (candidate.roomId === null || candidate.type !== "foreground") return { kind: "ordinary" };
      // Keep the outer relation explicit: single-table Drizzle selections strip
      // Column qualifiers inside SQL expressions, which would correlate each
      // nested namespace predicate to its own inner relation instead.
      const [room] = await tx.select({ id: rooms.id, externalContext: sql<boolean>`EXISTS (SELECT 1 FROM public.rooms boundary WHERE boundary.namespace_id = public.rooms.namespace_id AND boundary.external_context)`, archivedAt: rooms.archivedAt, archivedBoundary: sql<boolean>`EXISTS (SELECT 1 FROM public.rooms ancestor WHERE ancestor.namespace_id = public.rooms.namespace_id AND ancestor.kind <> 'subthread' AND ancestor.archived_at IS NOT NULL)` })
        .from(rooms).where(eq(rooms.id, candidate.roomId)).for("update");
      if (!room) return { kind: "unavailable" };
      if (!room.externalContext) return { kind: "ordinary" };
      if (room.archivedAt !== null || room.archivedBoundary === true) return { kind: "unavailable" };
      // Avoid locking a winning Job whose completion waits for the Room fence.
      const [claim] = await tx.select({ jobId: externalRoomExecutionClaims.jobId }).from(externalRoomExecutionClaims).where(eq(externalRoomExecutionClaims.roomId, room.id));
      if (claim) return { kind: "busy" };
      const [running] = await tx.select({ id: jobs.id }).from(jobs).where(and(eq(jobs.roomId, room.id), eq(jobs.type, "foreground"), eq(jobs.status, "running"))).limit(1);
      if (running) return { kind: "busy" };
      const [member] = await tx.select({ id: roomMembers.actorId }).from(roomMembers).innerJoin(actors, eq(actors.id, roomMembers.actorId)).innerJoin(users, eq(users.id, actors.ownerId))
        .where(and(eq(roomMembers.roomId, room.id), eq(actors.kind, "user"), eq(actors.ownerId, ctx.userId), sql`${users.disabledAt} IS NULL`, moderationAccessAllowedSql(sql`${actors.ownerId}`, sql`${room.id}::uuid`))).limit(1);
      if (!member) return { kind: "unavailable" };
      const [job] = await tx.select({ id: jobs.id, status: jobs.status, startedAt: jobs.startedAt, completedAt: jobs.completedAt }).from(jobs)
        .where(and(eq(jobs.id, jobId), eq(jobs.ownerId, ctx.userId), eq(jobs.roomId, room.id), eq(jobs.type, "foreground"))).for("update");
      if (!job) return { kind: "unavailable" };
      if (job.status !== "queued" || job.startedAt !== null || job.completedAt !== null) return { kind: "unavailable" };
      const token = randomUUID();
      await tx.insert(externalRoomExecutionClaims).values({ roomId: room.id, jobId, ownerUserId: ctx.userId, token });
      return { kind: "claimed", roomId: room.id, jobId, token };
    }, db);
  } catch { throw new Error("external_room_execution_claim_unavailable"); }
}

/** Only actual executor quiescence authorizes this call; Stop does not. */
export async function releaseExternalRoomExecutionClaimWith(db: ExternalRoomExecutionProductDatabase,
  ctx: ExternalRoomExecutionOwnerContext, claim: ExternalRoomExecutionClaim): Promise<boolean> {
  try {
    return await withTrustContext(ctx, async tx => {
      const [room] = await tx.select({ id: rooms.id }).from(rooms).where(eq(rooms.id, claim.roomId)).for("update");
      if (!room) return true;
      const rows = await tx.delete(externalRoomExecutionClaims).where(and(eq(externalRoomExecutionClaims.roomId, claim.roomId),
        eq(externalRoomExecutionClaims.ownerUserId, ctx.userId), eq(externalRoomExecutionClaims.jobId, claim.jobId), eq(externalRoomExecutionClaims.token, claim.token))).returning({ roomId: externalRoomExecutionClaims.roomId });
      if (rows.length === 1) return true;
      // A lost commit acknowledgement may replay release. Absence is safe;
      // another executor's retained claim must never be treated as ours.
      const [remaining] = await tx.select({ roomId: externalRoomExecutionClaims.roomId }).from(externalRoomExecutionClaims)
        .where(eq(externalRoomExecutionClaims.roomId, claim.roomId));
      return remaining === undefined;
    }, db);
  } catch { throw new Error("external_room_execution_release_unavailable"); }
}

/** Exact acquired token is transaction-local; never derive it from a Room read. */
export async function installExternalRoomExecutionClaimContext(tx: { execute: (query: ReturnType<typeof sql>) => Promise<unknown> }, claim: ExternalRoomExecutionClaim) {
  await tx.execute(sql`SELECT set_config('app.external_room_execution_token', ${claim.token}, true)`);
}
export const acquireExternalRoomExecutionClaim = (ctx: ExternalRoomExecutionOwnerContext, jobId: string) => acquireExternalRoomExecutionClaimWith(getSharedDirectDb(), ctx, jobId);
export const releaseExternalRoomExecutionClaim = (ctx: ExternalRoomExecutionOwnerContext, claim: ExternalRoomExecutionClaim) => releaseExternalRoomExecutionClaimWith(getSharedDirectDb(), ctx, claim);
