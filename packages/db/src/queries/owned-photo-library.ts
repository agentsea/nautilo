/**
 * D487 query substrate.  These helpers deliberately accept an explicit
 * DirectDatabase: authorization, server identity, storage IO, and mutation
 * transactions stay in the service layer.  The queries only enforce exact
 * durable scope and identity predicates so callers cannot accidentally turn a
 * user/agent scoped operation into a broad lookup.
 */
import { and, desc, eq, gt, isNotNull, isNull, lt, lte, or, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import {
  OWNED_PHOTO_SUBJECT_KIND,
  agentPhotoSelectionRevisions,
  ownedPhotoEntries,
  profiles,
  users,
  type NewOwnedPhotoEntry,
  type OwnedPhotoEntry,
  type OwnedPhotoSubjectKind,
} from "../schema";

export interface OwnedAgentPhotoScope {
  serverInstanceId: string;
  ownerUserId: string;
  agentId: string;
}

/** A direct connection or its transaction, so a service can retain one snapshot. */
export type OwnedPhotoQueryDatabase =
  | DirectDatabase
  | Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0];

export interface OwnedHumanPhotoScope {
  serverInstanceId: string;
  ownerUserId: string;
}

export type OwnedPhotoScope = OwnedAgentPhotoScope | OwnedHumanPhotoScope;

export interface OwnedPhotoListCursor {
  /** Exact PostgreSQL epoch microseconds, never a lossy JS Date round-trip. */
  createdAtMicros: string;
  id: string;
}

export interface ListOwnedAgentPhotoEntriesInput {
  scope: OwnedAgentPhotoScope;
  limit: number;
  cursor?: OwnedPhotoListCursor;
  deleted?: boolean;
  /** Deleted view is only recoverable, unclaimed rows at this point in time. */
  now?: Date;
}

export interface OwnedPhotoListPage {
  entries: OwnedPhotoEntry[];
  nextCursor: OwnedPhotoListCursor | null;
  hasMore: boolean;
}

function agentScopePredicate(scope: OwnedAgentPhotoScope) {
  return and(
    eq(ownedPhotoEntries.serverInstanceId, scope.serverInstanceId),
    eq(ownedPhotoEntries.ownerUserId, scope.ownerUserId),
    eq(ownedPhotoEntries.subjectKind, OWNED_PHOTO_SUBJECT_KIND.AGENT),
    eq(ownedPhotoEntries.agentId, scope.agentId),
  );
}

function ownedPhotoScopePredicate(scope: OwnedPhotoScope) {
  const common = [
    eq(ownedPhotoEntries.serverInstanceId, scope.serverInstanceId),
    eq(ownedPhotoEntries.ownerUserId, scope.ownerUserId),
    eq(
      ownedPhotoEntries.subjectKind,
      "agentId" in scope
        ? OWNED_PHOTO_SUBJECT_KIND.AGENT
        : OWNED_PHOTO_SUBJECT_KIND.HUMAN,
    ),
  ];
  if ("agentId" in scope) {
    common.push(eq(ownedPhotoEntries.agentId, scope.agentId));
  } else {
    common.push(isNull(ownedPhotoEntries.agentId));
  }
  return and(...common);
}

/** Exact owner/server/agent lookup; other users' rows are intentionally invisible. */
export async function findOwnedAgentPhotoEntry(
  db: OwnedPhotoQueryDatabase,
  scope: OwnedAgentPhotoScope,
  entryId: string,
): Promise<OwnedPhotoEntry | null> {
  const rows = await db
    .select()
    .from(ownedPhotoEntries)
    .where(and(agentScopePredicate(scope), eq(ownedPhotoEntries.id, entryId)))
    .limit(1);
  return rows[0] ?? null;
}

/** Stable keyset page used by history/recent views.  No offset drift. */
export async function listOwnedAgentPhotoEntries(
  db: OwnedPhotoQueryDatabase,
  input: ListOwnedAgentPhotoEntriesInput,
): Promise<OwnedPhotoListPage> {
  if (!Number.isInteger(input.limit) || input.limit < 1 || input.limit > 48) {
    throw new Error("Owned photo page limit must be an integer from 1 to 48");
  }
  const visibility = input.deleted
    ? and(
        isNotNull(ownedPhotoEntries.deletedAt),
        gt(ownedPhotoEntries.purgeAfter, input.now ?? new Date()),
        isNull(ownedPhotoEntries.gcClaimedAt),
        isNull(ownedPhotoEntries.gcClaimToken),
      )
    : isNull(ownedPhotoEntries.deletedAt);
  const cursorTimestamp = input.cursor
    ? sql`timestamptz 'epoch' + (${input.cursor.createdAtMicros}::numeric * interval '1 microsecond')`
    : undefined;
  const cursor = input.cursor && cursorTimestamp
    ? or(
        lt(ownedPhotoEntries.createdAt, cursorTimestamp),
        and(
          eq(ownedPhotoEntries.createdAt, cursorTimestamp),
          lt(ownedPhotoEntries.id, input.cursor.id),
        ),
      )
    : undefined;
  const rows = await db
    .select({
      entry: ownedPhotoEntries,
      createdAtMicros: sql<string>`(extract(epoch from ${ownedPhotoEntries.createdAt}) * 1000000)::numeric(20,0)::text`,
    })
    .from(ownedPhotoEntries)
    .where(and(agentScopePredicate(input.scope), visibility, cursor))
    .orderBy(desc(ownedPhotoEntries.createdAt), desc(ownedPhotoEntries.id))
    .limit(input.limit + 1);
  const hasMore = rows.length > input.limit;
  const pageRows = hasMore ? rows.slice(0, input.limit) : rows;
  const entries = pageRows.map((row) => row.entry);
  const last = pageRows.at(-1);
  return {
    entries,
    hasMore,
    nextCursor: hasMore && last ? { createdAtMicros: last.createdAtMicros, id: last.entry.id } : null,
  };
}

export interface CreateOwnedPhotoEntryInput extends Omit<NewOwnedPhotoEntry,
  "id" | "createdAt" | "deletedAt" | "purgeAfter" | "gcClaimToken" | "gcClaimedAt"
> {
  serverInstanceId: string;
  ownerUserId: string;
  subjectKind: OwnedPhotoSubjectKind;
  avatarKind: "generated" | "uploaded";
  blobId: string;
  operationId: string;
  requestFingerprint: string;
  mediaMimeType: string;
  mediaByteSize: number;
  mediaSha256: string;
}

export type CreateOwnedPhotoEntryResult =
  | { kind: "created"; entry: OwnedPhotoEntry }
  | { kind: "replayed"; entry: OwnedPhotoEntry }
  | { kind: "collision" };

/**
 * Atomically reserves the canonical server/kind/blob identity.  An existing
 * row is a retry only when all creation semantics match exactly; otherwise
 * callers receive a collision rather than silently adopting another owner’s
 * bytes.
 */
export async function createOwnedPhotoEntryIdempotently(
  db: OwnedPhotoQueryDatabase,
  input: CreateOwnedPhotoEntryInput,
): Promise<CreateOwnedPhotoEntryResult> {
  const [created] = await db
    .insert(ownedPhotoEntries)
    .values({
      ...input,
      deletedAt: null,
      purgeAfter: null,
      gcClaimToken: null,
      gcClaimedAt: null,
    })
    .onConflictDoNothing({
      target: [
        ownedPhotoEntries.serverInstanceId,
        ownedPhotoEntries.avatarKind,
        ownedPhotoEntries.blobId,
      ],
    })
    .returning();
  if (created) return { kind: "created", entry: created };

  const [existing] = await db
    .select()
    .from(ownedPhotoEntries)
    .where(
      and(
        eq(ownedPhotoEntries.serverInstanceId, input.serverInstanceId),
        eq(ownedPhotoEntries.avatarKind, input.avatarKind),
        eq(ownedPhotoEntries.blobId, input.blobId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Owned photo insert conflict had no canonical entry");

  const replay = existing.ownerUserId === input.ownerUserId
    && existing.subjectKind === input.subjectKind
    && existing.agentId === (input.agentId ?? null)
    && existing.source === input.source
    && existing.origin === input.origin
    && existing.operationId === input.operationId
    && existing.requestFingerprint === input.requestFingerprint
    && existing.generationPrompt === (input.generationPrompt ?? null)
    && existing.generationProvider === (input.generationProvider ?? null)
    && existing.generationModel === (input.generationModel ?? null)
    && existing.generationBatchOrdinal === (input.generationBatchOrdinal ?? null)
    && existing.mediaMimeType === input.mediaMimeType
    && existing.mediaByteSize === input.mediaByteSize
    && existing.mediaSha256 === input.mediaSha256;
  return replay ? { kind: "replayed", entry: existing } : { kind: "collision" };
}

/**
 * True only for a due, soft-deleted row that no current pointer or retained
 * selection revision names. This deliberately fails closed across all owners
 * so legacy duplicate pointers cannot make a still-visible byte collectible.
 * A stale GC lease is safely reclaimable after 15 minutes; the deleting
 * service must CAS the token before touching storage.
 */
export async function isOwnedPhotoEntryEligibleForGc(
  db: DirectDatabase,
  scope: OwnedPhotoScope,
  entryId: string,
  now = new Date(),
): Promise<boolean> {
  const leaseExpiredBefore = new Date(now.getTime() - 15 * 60 * 1000);
  const [entry] = await db
    .select()
    .from(ownedPhotoEntries)
    .where(
      and(
        ownedPhotoScopePredicate(scope),
        eq(ownedPhotoEntries.id, entryId),
        isNotNull(ownedPhotoEntries.deletedAt),
        lte(ownedPhotoEntries.purgeAfter, now),
        or(
          isNull(ownedPhotoEntries.gcClaimedAt),
          lt(ownedPhotoEntries.gcClaimedAt, leaseExpiredBefore),
        ),
      ),
    )
    .limit(1);
  if (!entry) return false;

  const [profilePointer, humanPointer, retainedRevision] = await Promise.all([
    db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(
          sql`${profiles.avatarRef}->>'kind' = ${entry.avatarKind}`,
          sql`${profiles.avatarRef}->>'blobId' = ${entry.blobId}`,
        ),
      )
      .limit(1),
    db
      .select({ id: users.id })
      .from(users)
      .where(
        and(
          sql`${users.humanAvatarRef}->>'kind' = ${entry.avatarKind}`,
          sql`${users.humanAvatarRef}->>'blobId' = ${entry.blobId}`,
        ),
      )
      .limit(1),
    db
      .select({ id: agentPhotoSelectionRevisions.id })
      .from(agentPhotoSelectionRevisions)
      .where(
        or(
          eq(agentPhotoSelectionRevisions.beforeEntryId, entry.id),
          eq(agentPhotoSelectionRevisions.afterEntryId, entry.id),
        ),
      )
      .limit(1),
  ]);
  return profilePointer.length === 0 && humanPointer.length === 0 && retainedRevision.length === 0;
}
