import {
  and, eq, inArray, sql,
  artifactNamespaces, memoryNamespaces, contentAccessOperations,
  type ContentAccessOperation, type InviteSeedTx,
} from "@nautilo/db";
import type { ContentAccessMutationPlan } from "./content-access-plan";
import { resolveContentAccessNamespaceInTx } from "./content-access-namespace";

export type ContentAccessReceipt = Readonly<{
  operationId: string;
  outcome: ContentAccessOperation["outcome"];
  /** False for historical replay, even if the original call changed state. */
  stateChanged: boolean;
  originalStateChanged: boolean;
  replayed: boolean;
  attachedCount: number;
  detachedCount: number;
  skippedCount: number;
}>;

export type ContentAccessPublishedDestination = Readonly<{
  namespaceId: string;
  roomId: string;
  /** True only when the namespace resolver created this destination now. */
  minted: boolean;
}>;

export type DetailedContentAccessPublication = Readonly<{
  receipt: ContentAccessReceipt;
  /** Transient adapter facts. These are never persisted in the receipt. */
  destinations: readonly ContentAccessPublishedDestination[];
  /** Destinations whose junction rows were inserted by this transaction.
   * Namespace creation and aggregate receipt outcomes are not substitutes for
   * this fresh-attachment evidence. */
  freshDestinations: readonly ContentAccessPublishedDestination[];
  /** Exact authorized plan accounting, retained only for the immediate caller. */
  accounting: ContentAccessMutationPlan["accounting"];
}>;

function projectReceipt(row: ContentAccessOperation, replayed: boolean): ContentAccessReceipt {
  return Object.freeze({
    operationId: row.operationId, outcome: row.outcome,
    stateChanged: !replayed && row.changed, originalStateChanged: row.changed, replayed,
    attachedCount: row.attachedCount, detachedCount: row.detachedCount,
    skippedCount: row.skippedCount,
  });
}

/**
 * Take before loading/planning the current access state. The caller first
 * verifies the authenticated principal and exact signed request binding.
 * A terminal result is historical evidence; do not re-plan or grant again.
 * The caller owns this transaction and must not expose another user's receipt.
 */
export class ContentAccessReplayBindingError extends Error {
  override readonly name = "ContentAccessReplayBindingError";
  constructor() { super("Content access operation binding does not match"); }
}

export async function findContentAccessReplayInTx(
  tx: InviteSeedTx,
  input: Readonly<{ operationId: string; requestDigest: string; requesterUserId: string; requesterActorId: string }>,
): Promise<ContentAccessReceipt | null> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`content-access:operation:${input.operationId}`}, 0))`);
  const [receipt] = await tx.select().from(contentAccessOperations)
    .where(eq(contentAccessOperations.operationId, input.operationId));
  if (!receipt) return null;
  if (receipt.requestDigest !== input.requestDigest
    || receipt.requesterUserId !== input.requesterUserId
    || receipt.requesterActorId !== input.requesterActorId) {
    throw new ContentAccessReplayBindingError();
  }
  return projectReceipt(receipt, true);
}

/**
 * Attachment/receipt persistence primitive, NOT an authorization entry point.
 * Only the owning coordinator may call this after checking the exact preview,
 * reloading current authority with lockContentAccessAuthorityInTx, and matching
 * the re-planned request digest. The same transaction owns every lock, Room
 * construction, attachment mutation and terminal receipt. Never export this as
 * a route or raw Agent capability.
 *
 * Existing database edge triggers invalidate retained protected mappings; no
 * crypto coordinates are fabricated here and protected-only objects are not
 * admitted by the authority loader. The coordinator must emit best-effort
 * invalidation/audit only after commit, without changing a committed outcome.
 */
export async function publishContentAccessPlanDetailedInTx(
  tx: InviteSeedTx,
  input: Readonly<{
    operationId: string;
    requestDigest: string;
    requesterUserId: string;
    plan: ContentAccessMutationPlan;
  }>,
): Promise<DetailedContentAccessPublication> {
  const { plan } = input;
  const destinations = new Set<string>();
  const destinationFacts = new Map<string, ContentAccessPublishedDestination>();
  // Stable destination lock order for removal that re-homes several audiences.
  const ordered = [...plan.attachDestinations].sort((a, b) =>
    JSON.stringify(a.kind === "immutable_human_set" ? a.humanActorIds : [a.namespaceId])
      .localeCompare(JSON.stringify(b.kind === "immutable_human_set" ? b.humanActorIds : [b.namespaceId])));
  for (const destination of ordered) {
    if (destination.kind === "room_namespace") {
      destinations.add(destination.namespaceId);
      destinationFacts.set(destination.namespaceId, Object.freeze({
        namespaceId: destination.namespaceId,
        roomId: destination.roomId,
        minted: false,
      }));
    } else if (destination.existingNamespaceId) {
      // The revalidated attachment already satisfies this exact audience;
      // don't attach a second historical duplicate just to canonicalize it.
      if (!destination.existingRoomId) {
        throw new Error("Existing content access destination is incomplete");
      }
      destinations.add(destination.existingNamespaceId);
      destinationFacts.set(destination.existingNamespaceId, Object.freeze({
        namespaceId: destination.existingNamespaceId,
        roomId: destination.existingRoomId,
        minted: false,
      }));
    } else {
      const resolved = await resolveContentAccessNamespaceInTx(tx, {
        requesterUserId: input.requesterUserId,
        requesterActorId: plan.requesterActorId,
        humanActorIds: destination.humanActorIds,
      });
      destinations.add(resolved.namespaceId);
      destinationFacts.set(resolved.namespaceId, Object.freeze({
        namespaceId: resolved.namespaceId,
        roomId: resolved.roomId,
        minted: resolved.minted,
      }));
    }
  }
  let attachedCount = 0;
  let detachedCount = 0;
  const freshDestinations: ContentAccessPublishedDestination[] = [];
  // Attach before detaching. Junction uniqueness makes already-present
  // destinations no-ops without copying an object or changing its revision.
  for (const namespaceId of destinations) {
    const inserted = plan.object.kind === "memory"
      ? await tx.insert(memoryNamespaces).values({ memoryId: plan.object.id, namespaceId })
        .onConflictDoNothing().returning({ id: memoryNamespaces.namespaceId })
      : await tx.insert(artifactNamespaces).values({ artifactId: plan.object.id, namespaceId })
        .onConflictDoNothing().returning({ id: artifactNamespaces.namespaceId });
    attachedCount += inserted.length;
    if (inserted.length > 0) {
      const destination = destinationFacts.get(namespaceId);
      if (!destination) throw new Error("Inserted content access destination is incomplete");
      freshDestinations.push(destination);
    }
  }
  if (plan.detachNamespaceIds.length) {
    const deleted = plan.object.kind === "memory"
      ? await tx.delete(memoryNamespaces).where(and(eq(memoryNamespaces.memoryId, plan.object.id),
        inArray(memoryNamespaces.namespaceId, [...plan.detachNamespaceIds])))
        .returning({ id: memoryNamespaces.namespaceId })
      : await tx.delete(artifactNamespaces).where(and(eq(artifactNamespaces.artifactId, plan.object.id),
        inArray(artifactNamespaces.namespaceId, [...plan.detachNamespaceIds])))
        .returning({ id: artifactNamespaces.namespaceId });
    detachedCount = deleted.length;
  }
  const remaining = plan.object.kind === "memory"
    ? await tx.select({ id: memoryNamespaces.namespaceId }).from(memoryNamespaces)
      .where(eq(memoryNamespaces.memoryId, plan.object.id))
    : await tx.select({ id: artifactNamespaces.namespaceId }).from(artifactNamespaces)
      .where(eq(artifactNamespaces.artifactId, plan.object.id));
  if (!remaining.length) throw new Error("Content access change would leave no attachment");
  const changed = attachedCount > 0 || detachedCount > 0;
  const partial = plan.accounting.skippedAttachmentCount > 0
    || plan.accounting.residualDynamicRoomIds.length > 0
    || plan.accounting.residualAccessNamespaceIds.length > 0;
  const [receipt] = await tx.insert(contentAccessOperations).values({
    operationId: input.operationId, requestDigest: input.requestDigest,
    requesterUserId: input.requesterUserId, requesterActorId: plan.requesterActorId,
    memoryId: plan.object.kind === "memory" ? plan.object.id : null,
    artifactId: plan.object.kind === "artifact" ? plan.object.id : null,
    outcome: partial ? "partial" : changed ? "applied" : "already_applied",
    changed, attachedCount, detachedCount, skippedCount: plan.accounting.skippedAttachmentCount,
  }).returning();
  if (!receipt) throw new Error("Content access receipt was not persisted");
  return Object.freeze({
    receipt: projectReceipt(receipt, false),
    destinations: Object.freeze([...destinationFacts.values()]),
    freshDestinations: Object.freeze(freshDestinations),
    accounting: Object.freeze({
      removedAttachmentCount: plan.accounting.removedAttachmentCount,
      skippedAttachmentCount: plan.accounting.skippedAttachmentCount,
      skippedNamespaceIds: Object.freeze([...plan.accounting.skippedNamespaceIds]),
      residualDynamicRoomIds: Object.freeze([...plan.accounting.residualDynamicRoomIds]),
      residualDynamicNamespaceIds: Object.freeze([...plan.accounting.residualDynamicNamespaceIds]),
      residualAccessNamespaceIds: Object.freeze([...plan.accounting.residualAccessNamespaceIds]),
    }),
  });
}

/** Receipt-only coordinator API. Transient adapter details cannot escape it. */
export async function publishContentAccessPlanInTx(
  tx: InviteSeedTx,
  input: Readonly<{
    operationId: string;
    requestDigest: string;
    requesterUserId: string;
    plan: ContentAccessMutationPlan;
  }>,
): Promise<ContentAccessReceipt> {
  const { receipt } = await publishContentAccessPlanDetailedInTx(tx, input);
  return receipt;
}
