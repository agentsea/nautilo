import { randomUUID } from "node:crypto";
import { lstat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  agentPhotoSelectionRevisions,
  and,
  eq,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  or,
  ownedPhotoEntries,
  sql,
  type DirectDatabase,
  type OwnedPhotoEntry,
} from "@nautilo/db";
import { getAvatarBlobDir, isSafeBlobId } from "../routes/_helpers/avatar";

const MAX_GC_BATCH = 25;
const GC_LEASE_MS = 15 * 60 * 1000;
const REVISION_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
const REVISION_MAX_PER_AGENT = 100;
const REVISION_PRUNE_BATCH = 250;

type GcDecisionOutcome =
  | "eligible"
  | "protected_current"
  | "protected_history"
  | "state_changed"
  | "claimed"
  | "purged"
  | "cleanup_interrupted";

export interface OwnedPhotoGcDecision {
  readonly entryId: string;
  readonly outcome: GcDecisionOutcome;
  readonly filesRemoved?: number;
  readonly filesMissing?: number;
}

export interface OwnedPhotoGcReport {
  readonly dryRun: boolean;
  readonly batchSize: number;
  readonly scanned: number;
  readonly eligible: number;
  readonly claimed: number;
  readonly protectedCurrent: number;
  readonly protectedHistory: number;
  readonly stateChanged: number;
  readonly rowsPurged: number;
  readonly filesRemoved: number;
  readonly filesMissing: number;
  readonly cleanupInterrupted: number;
  readonly staleClaimsRecovered: number;
  readonly revisionsEligible: number;
  readonly revisionsPruned: number;
  /** Opaque entry ids and outcomes only; never paths, bytes, prompts, or hashes. */
  readonly decisions: OwnedPhotoGcDecision[];
}

export interface OwnedPhotoGcDependencies {
  readonly db: DirectDatabase;
  readonly now?: () => Date;
  readonly randomUuid?: () => string;
  readonly removeMedia?: (entry: OwnedPhotoEntry) => Promise<{ removed: number; missing: number }>;
  /** Test/worker coordination seam immediately before the transactional CAS. */
  readonly beforeClaim?: (entry: OwnedPhotoEntry) => Promise<void>;
}

type ClaimResult =
  | { outcome: "protected_current" | "protected_history" | "state_changed" }
  | { outcome: "eligible"; staleClaim: boolean }
  | { outcome: "claimed"; entry: OwnedPhotoEntry; token: string; staleClaim: boolean };

/**
 * Reference-safe, bounded maintenance. Discovery never scans directories and
 * request handlers never invoke this service. Each apply claim is committed
 * before exact known media paths are touched; finalization CASes that token.
 */
export class OwnedPhotoGarbageCollector {
  readonly #now: () => Date;
  readonly #randomUuid: () => string;
  readonly #removeMedia: (entry: OwnedPhotoEntry) => Promise<{ removed: number; missing: number }>;

  constructor(readonly dependencies: OwnedPhotoGcDependencies) {
    this.#now = dependencies.now ?? (() => new Date());
    this.#randomUuid = dependencies.randomUuid ?? randomUUID;
    this.#removeMedia = dependencies.removeMedia ?? removeKnownOwnedAvatarMedia;
  }

  async run(input: { dryRun: boolean; batchSize?: number }): Promise<OwnedPhotoGcReport> {
    const batchSize = input.batchSize ?? MAX_GC_BATCH;
    if (!Number.isInteger(batchSize) || batchSize < 1 || batchSize > MAX_GC_BATCH) {
      throw new Error(`Photo-library GC batch size must be an integer from 1 to ${MAX_GC_BATCH}`);
    }
    const now = this.#now();
    const revisionRetention = await pruneAgentPhotoSelectionHistory(this.dependencies.db, {
      now,
      dryRun: input.dryRun,
    });
    const leaseExpiredBefore = new Date(now.getTime() - GC_LEASE_MS);
    const candidates = await this.dependencies.db.select().from(ownedPhotoEntries).where(and(
      isNotNull(ownedPhotoEntries.deletedAt),
      lte(ownedPhotoEntries.purgeAfter, now),
      or(
        and(isNull(ownedPhotoEntries.gcClaimToken), isNull(ownedPhotoEntries.gcClaimedAt)),
        and(isNotNull(ownedPhotoEntries.gcClaimToken), lt(ownedPhotoEntries.gcClaimedAt, leaseExpiredBefore)),
      ),
    )).orderBy(ownedPhotoEntries.purgeAfter, ownedPhotoEntries.id).limit(batchSize);

    const metrics = {
      eligible: 0, claimed: 0, protectedCurrent: 0, protectedHistory: 0,
      stateChanged: 0, rowsPurged: 0, filesRemoved: 0, filesMissing: 0,
      cleanupInterrupted: 0, staleClaimsRecovered: 0,
    };
    const decisions: OwnedPhotoGcDecision[] = [];

    for (const candidate of candidates) {
      await this.dependencies.beforeClaim?.(candidate);
      const claim = await this.#claim(candidate, now, leaseExpiredBefore, input.dryRun);
      if (claim.outcome === "protected_current") {
        metrics.protectedCurrent += 1;
        decisions.push({ entryId: candidate.id, outcome: claim.outcome });
        continue;
      }
      if (claim.outcome === "protected_history") {
        metrics.protectedHistory += 1;
        decisions.push({ entryId: candidate.id, outcome: claim.outcome });
        continue;
      }
      if (claim.outcome === "state_changed") {
        metrics.stateChanged += 1;
        decisions.push({ entryId: candidate.id, outcome: claim.outcome });
        continue;
      }
      if (!("staleClaim" in claim)) throw new Error("invalid photo-library GC eligibility outcome");
      metrics.eligible += 1;
      if (claim.outcome === "eligible") {
        decisions.push({ entryId: candidate.id, outcome: "eligible" });
        continue;
      }
      if (claim.outcome !== "claimed") throw new Error("invalid photo-library GC claim outcome");

      if (claim.staleClaim) metrics.staleClaimsRecovered += 1;
      metrics.claimed += 1;
      decisions.push({ entryId: candidate.id, outcome: "claimed" });
      try {
        const cleanup = await this.#removeMedia(claim.entry);
        metrics.filesRemoved += cleanup.removed;
        metrics.filesMissing += cleanup.missing;
        const finalized = await this.#finalize(claim.entry.id, claim.token);
        if (!finalized) {
          metrics.cleanupInterrupted += 1;
          decisions.push({
            entryId: candidate.id,
            outcome: "cleanup_interrupted",
            filesRemoved: cleanup.removed,
            filesMissing: cleanup.missing,
          });
          continue;
        }
        metrics.rowsPurged += 1;
        decisions.push({
          entryId: candidate.id,
          outcome: "purged",
          filesRemoved: cleanup.removed,
          filesMissing: cleanup.missing,
        });
      } catch {
        // Keep the exact lease on the row. A later run may recover it only
        // after the bounded stale-lease interval and will reconcile any bytes
        // already removed before interruption.
        metrics.cleanupInterrupted += 1;
        decisions.push({ entryId: candidate.id, outcome: "cleanup_interrupted" });
      }
    }

    return {
      dryRun: input.dryRun,
      batchSize,
      scanned: candidates.length,
      ...metrics,
      revisionsEligible: revisionRetention.eligible,
      revisionsPruned: revisionRetention.pruned,
      decisions,
    };
  }

  async #claim(
    candidate: OwnedPhotoEntry,
    now: Date,
    leaseExpiredBefore: Date,
    dryRun: boolean,
  ): Promise<ClaimResult> {
    return this.dependencies.db.transaction(async (tx): Promise<ClaimResult> => {
      // Serialize against the canonical mutation authority before observing
      // either the pointer or entry. A select/restore transaction takes this
      // same subject-authority -> entry order, so GC cannot read an old
      // pointer and then resume behind a selection that has already won.
      const authority = candidate.subjectKind === "agent"
        ? await tx.execute(sql`
            SELECT id FROM profiles
            WHERE user_id = ${candidate.ownerUserId}
              AND agent_id = ${candidate.agentId}
            FOR UPDATE
          `) as unknown as Array<{ id: string }>
        : await tx.execute(sql`
            SELECT id FROM users
            WHERE id = ${candidate.ownerUserId}
            FOR UPDATE
          `) as unknown as Array<{ id: string }>;
      if (authority.length !== 1) return { outcome: "state_changed" };

      const [entry] = await tx.select().from(ownedPhotoEntries).where(eq(ownedPhotoEntries.id, candidate.id))
        .limit(1).for("update");
      if (!entry || entry.deletedAt === null || entry.purgeAfter === null || entry.purgeAfter > now) {
        return { outcome: "state_changed" };
      }
      const staleClaim = entry.gcClaimedAt !== null && entry.gcClaimedAt < leaseExpiredBefore;
      const unclaimed = entry.gcClaimToken === null && entry.gcClaimedAt === null;
      if (!unclaimed && !staleClaim) return { outcome: "state_changed" };

      // Recheck every pointer only after the subject authority and exact entry
      // are locked. The broad reads are corruption-safe; the exact authority
      // lock above is what fences valid concurrent selection transactions.
      const profilePointers = await tx.execute(sql`
        SELECT id FROM profiles
        WHERE avatar_ref->>'kind' = ${entry.avatarKind}
          AND avatar_ref->>'blobId' = ${entry.blobId}
        ORDER BY id
      `) as unknown as Array<{ id: string }>;
      const humanPointers = await tx.execute(sql`
        SELECT id FROM users
        WHERE human_avatar_ref->>'kind' = ${entry.avatarKind}
          AND human_avatar_ref->>'blobId' = ${entry.blobId}
        ORDER BY id
      `) as unknown as Array<{ id: string }>;
      if (profilePointers.length > 0 || humanPointers.length > 0) return { outcome: "protected_current" };

      const retained = await tx.select({ id: agentPhotoSelectionRevisions.id })
        .from(agentPhotoSelectionRevisions)
        .where(or(
          eq(agentPhotoSelectionRevisions.beforeEntryId, entry.id),
          eq(agentPhotoSelectionRevisions.afterEntryId, entry.id),
        )).limit(1);
      if (retained.length > 0) return { outcome: "protected_history" };
      if (dryRun) return { outcome: "eligible", staleClaim };

      const token = this.#randomUuid();
      const [claimed] = await tx.update(ownedPhotoEntries).set({
        gcClaimToken: token,
        gcClaimedAt: now,
      }).where(and(
        eq(ownedPhotoEntries.id, entry.id),
        eq(ownedPhotoEntries.deletedAt, entry.deletedAt),
        eq(ownedPhotoEntries.purgeAfter, entry.purgeAfter),
        staleClaim
          ? and(eq(ownedPhotoEntries.gcClaimToken, entry.gcClaimToken!), eq(ownedPhotoEntries.gcClaimedAt, entry.gcClaimedAt!))
          : and(isNull(ownedPhotoEntries.gcClaimToken), isNull(ownedPhotoEntries.gcClaimedAt)),
      )).returning();
      return claimed
        ? { outcome: "claimed", entry: claimed, token, staleClaim }
        : { outcome: "state_changed" };
    });
  }

  async #finalize(entryId: string, token: string): Promise<boolean> {
    return this.dependencies.db.transaction(async (tx) => {
      const deleted = await tx.delete(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.id, entryId),
        eq(ownedPhotoEntries.gcClaimToken, token),
        isNotNull(ownedPhotoEntries.deletedAt),
      )).returning({ id: ownedPhotoEntries.id });
      return deleted.length === 1;
    });
  }
}

/** Delete only the exact media variants defined by an owned row. */
export async function removeKnownOwnedAvatarMedia(
  entry: Pick<OwnedPhotoEntry, "avatarKind" | "blobId">,
  rootOverride?: string,
): Promise<{ removed: number; missing: number }> {
  if (!isSafeBlobId(entry.blobId)) throw new Error("unsafe owned-avatar blob id");
  if (entry.avatarKind !== "uploaded" && entry.avatarKind !== "generated") throw new Error("invalid owned-avatar kind");
  const root = rootOverride ?? getAvatarBlobDir(entry.avatarKind);
  const names = entry.avatarKind === "generated"
    ? [`${entry.blobId}.png`, `${entry.blobId}.thumb.webp`]
    : [`${entry.blobId}.png`];
  let removed = 0;
  let missing = 0;
  for (const name of names) {
    const target = join(root, name);
    let stat;
    try {
      stat = await lstat(target);
    } catch (error) {
      if (isMissing(error)) { missing += 1; continue; }
      throw error;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("owned-avatar media is not a regular file");
    try {
      await unlink(target);
      removed += 1;
    } catch (error) {
      if (isMissing(error)) { missing += 1; continue; }
      throw error;
    }
  }
  return { removed, missing };
}

export async function pruneAgentPhotoSelectionHistory(
  db: DirectDatabase,
  input: { now: Date; dryRun: boolean },
): Promise<{ eligible: number; pruned: number }> {
  const cutoff = new Date(input.now.getTime() - REVISION_MAX_AGE_MS);
  return db.transaction(async (tx) => {
    const rows = await tx.execute(sql`
      WITH ranked AS (
        SELECT r.id, r.created_at, r.revision,
          ROW_NUMBER() OVER (
            PARTITION BY r.server_instance_id, r.owner_user_id, r.agent_id
            ORDER BY r.revision DESC
          ) AS ordinal,
          p.avatar_selection_revision AS current_revision
        FROM agent_photo_selection_revisions r
        LEFT JOIN profiles p
          ON p.agent_id = r.agent_id AND p.user_id = r.owner_user_id
      )
      SELECT id FROM ranked
      WHERE (current_revision IS NULL OR revision <> current_revision)
        AND (ordinal > ${REVISION_MAX_PER_AGENT} OR created_at < ${cutoff.toISOString()}::timestamptz)
      ORDER BY created_at, id
      LIMIT ${REVISION_PRUNE_BATCH}
    `) as unknown as Array<{ id: string }>;
    if (input.dryRun || rows.length === 0) return { eligible: rows.length, pruned: 0 };
    const deleted = await tx.delete(agentPhotoSelectionRevisions)
      .where(inArray(agentPhotoSelectionRevisions.id, rows.map((row) => row.id)))
      .returning({ id: agentPhotoSelectionRevisions.id });
    return { eligible: rows.length, pruned: deleted.length };
  });
}

function isMissing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error
    && (error as { code?: unknown }).code === "ENOENT";
}
