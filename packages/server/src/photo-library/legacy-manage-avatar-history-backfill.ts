/**
 * Recover legacy Agent photos only from an exact, server-authored
 * `manage_avatar` success transcript. Directory contents alone are never
 * ownership evidence.
 */
import { createHash } from "node:crypto";
import {
  actors,
  and,
  eq,
  inArray,
  listLegacyManageAvatarTranscriptCandidatesWith,
  nautiloInstanceIdentity,
  or,
  ownedPhotoEntries,
  profiles,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import {
  ensureLegacyGeneratedThumbnail,
  inspectLegacyAvatarMedia,
  type LegacyPhotoMediaInspection,
} from "./legacy-current-reference-backfill";

type PhotoKind = "generated" | "uploaded";

type TranscriptCandidate = {
  readonly messageId: number;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly createdAt: Date;
  readonly kind: PhotoKind;
  readonly blobId: string;
};

export type LegacyManageAvatarHistoryReport = {
  readonly serverInstanceId: string;
  readonly adopted: number;
  readonly alreadyAdopted: number;
  readonly skipped: number;
  readonly quarantined: number;
  readonly transcriptLimitReached: boolean;
};

export type LegacyManageAvatarHistoryDependencies = {
  readonly db: DirectDatabase;
  readonly inspectMedia?: (ref: { kind: PhotoKind; blobId: string }) => Promise<LegacyPhotoMediaInspection>;
  readonly ensureGeneratedThumbnail?: (ref: { kind: PhotoKind; blobId: string }) => Promise<boolean>;
};

const EXACT_SUCCESS = /^Avatar set to (generated|uploaded) image \(([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\)\.$/i;
const TRANSCRIPT_LIMIT = 5_000;
const ACTIVE_ENTRY_LIMIT = 200;

function stableUuid(parts: readonly unknown[]): string {
  const bytes = createHash("sha256").update(JSON.stringify(parts)).digest();
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fingerprint(candidate: TranscriptCandidate, media: {
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: string;
}): string {
  return createHash("sha256").update(JSON.stringify([
    "d487-legacy-manage-avatar-history:v1",
    candidate.messageId,
    candidate.ownerUserId,
    candidate.agentId,
    candidate.kind,
    candidate.blobId,
    media,
  ])).digest("hex");
}

async function readCandidates(db: DirectDatabase): Promise<{
  readonly candidates: TranscriptCandidate[];
  readonly transcriptLimitReached: boolean;
}> {
  const rows = await listLegacyManageAvatarTranscriptCandidatesWith(db);
  const candidates: TranscriptCandidate[] = [];
  for (const row of rows.slice(0, TRANSCRIPT_LIMIT)) {
    // Protected-only transcript rows do not carry the ordinary, exact success
    // string required as legacy ownership evidence.
    if (row.content === null) continue;
    const match = EXACT_SUCCESS.exec(row.content);
    if (!match || !row.agentId) continue;
    candidates.push({
      messageId: row.messageId,
      ownerUserId: row.ownerUserId,
      agentId: row.agentId,
      createdAt: row.createdAt,
      kind: match[1]!.toLowerCase() as PhotoKind,
      blobId: match[2]!.toLowerCase(),
    });
  }
  return { candidates, transcriptLimitReached: rows.length > TRANSCRIPT_LIMIT };
}

function sameSubject(entry: typeof ownedPhotoEntries.$inferSelect, candidate: TranscriptCandidate): boolean {
  return entry.ownerUserId === candidate.ownerUserId
    && entry.subjectKind === "agent"
    && entry.agentId === candidate.agentId
    && entry.avatarKind === candidate.kind
    && entry.blobId === candidate.blobId;
}

/** Idempotent boot/upgrade adoption. It never changes the selected photo. */
export async function backfillLegacyManageAvatarHistory(
  dependencies: LegacyManageAvatarHistoryDependencies,
): Promise<LegacyManageAvatarHistoryReport> {
  const [identity] = await dependencies.db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
  if (!identity) throw new Error("D487 history backfill requires the singleton server identity");
  const { candidates, transcriptLimitReached } = await readCandidates(dependencies.db);
  const inspect = dependencies.inspectMedia ?? inspectLegacyAvatarMedia;
  const ensureThumbnail = dependencies.ensureGeneratedThumbnail ?? ensureLegacyGeneratedThumbnail;
  const unique = new Map<string, TranscriptCandidate>();
  const conflicts = new Set<string>();
  for (const candidate of candidates) {
    const key = `${candidate.kind}\0${candidate.blobId}`;
    const prior = unique.get(key);
    if (prior && (prior.ownerUserId !== candidate.ownerUserId || prior.agentId !== candidate.agentId)) {
      conflicts.add(key);
    } else if (!prior) {
      unique.set(key, candidate);
    }
  }

  let adopted = 0;
  let alreadyAdopted = 0;
  let skipped = 0;
  let quarantined = conflicts.size;
  // Ordinary boots are idempotent and should not re-open/re-hash every photo
  // already in the library. This one bounded DB read turns reruns into cheap
  // provenance checks; only genuinely absent candidates touch media bytes.
  const generatedBlobIds = [...unique.values()].filter((row) => row.kind === "generated").map((row) => row.blobId);
  const uploadedBlobIds = [...unique.values()].filter((row) => row.kind === "uploaded").map((row) => row.blobId);
  const candidatePredicates = [
    ...(generatedBlobIds.length > 0 ? [and(eq(ownedPhotoEntries.avatarKind, "generated"), inArray(ownedPhotoEntries.blobId, generatedBlobIds))] : []),
    ...(uploadedBlobIds.length > 0 ? [and(eq(ownedPhotoEntries.avatarKind, "uploaded"), inArray(ownedPhotoEntries.blobId, uploadedBlobIds))] : []),
  ];
  const existingRows = candidatePredicates.length === 0
    ? []
    : await dependencies.db.select().from(ownedPhotoEntries).where(and(
      eq(ownedPhotoEntries.serverInstanceId, identity.serverInstanceId),
      candidatePredicates.length === 1 ? candidatePredicates[0] : or(...candidatePredicates),
    ));
  const existingByBlob = new Map(existingRows.map((entry) => [`${entry.avatarKind}\0${entry.blobId}`, entry]));
  for (const [key, candidate] of unique) {
    if (conflicts.has(key)) continue;
    const known = existingByBlob.get(key);
    if (known) {
      if (sameSubject(known, candidate)) alreadyAdopted += 1;
      else quarantined += 1;
      continue;
    }
    let media = await inspect({ kind: candidate.kind, blobId: candidate.blobId });
    if (!media.exists || media.mediaByteSize === undefined || !media.mediaSha256 || media.mediaMimeType !== "image/png") {
      quarantined += 1;
      continue;
    }
    if (candidate.kind === "generated" && media.generatedThumbnailReady !== true) {
      try {
        await ensureThumbnail({ kind: candidate.kind, blobId: candidate.blobId });
        media = await inspect({ kind: candidate.kind, blobId: candidate.blobId });
      } catch {
        quarantined += 1;
        continue;
      }
      if (media.generatedThumbnailReady !== true) {
        quarantined += 1;
        continue;
      }
    }
    const immutableMedia = {
      mediaByteSize: media.mediaByteSize!,
      mediaSha256: media.mediaSha256!,
      mediaMimeType: media.mediaMimeType!,
    };
    const result = await dependencies.db.transaction(async (tx) => {
      const [profile] = await tx.select({ id: profiles.id, libraryRevision: profiles.avatarLibraryRevision })
        .from(profiles).where(and(eq(profiles.userId, candidate.ownerUserId), eq(profiles.agentId, candidate.agentId)))
        .limit(1).for("update");
      const mirrors = await tx.select({ ownerUserId: actors.ownerId }).from(actors)
        .where(and(eq(actors.kind, "agent"), eq(actors.agentId, candidate.agentId))).for("update");
      if (!profile || mirrors.length !== 1 || mirrors[0]?.ownerUserId !== candidate.ownerUserId) return "quarantined" as const;
      const [existing] = await tx.select().from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, identity.serverInstanceId),
        eq(ownedPhotoEntries.avatarKind, candidate.kind),
        eq(ownedPhotoEntries.blobId, candidate.blobId),
      )).limit(1).for("update");
      if (existing) return sameSubject(existing, candidate) ? "already" as const : "quarantined" as const;
      const [currentPointers, capacity] = await Promise.all([
        tx.execute(sql`
          SELECT (
            (SELECT count(*)::int FROM profiles WHERE avatar_ref->>'kind' = ${candidate.kind} AND avatar_ref->>'blobId' = ${candidate.blobId})
            + (SELECT count(*)::int FROM users WHERE human_avatar_ref->>'kind' = ${candidate.kind} AND human_avatar_ref->>'blobId' = ${candidate.blobId})
          )::int AS count
        `) as unknown as Promise<Array<{ count: number }>>,
        tx.select({ count: sql<number>`count(*)::int` }).from(ownedPhotoEntries).where(and(
          eq(ownedPhotoEntries.serverInstanceId, identity.serverInstanceId),
          eq(ownedPhotoEntries.ownerUserId, candidate.ownerUserId),
          eq(ownedPhotoEntries.subjectKind, "agent"),
          eq(ownedPhotoEntries.agentId, candidate.agentId),
          sql`${ownedPhotoEntries.deletedAt} IS NULL`,
        )),
      ]);
      if (Number(currentPointers[0]?.count ?? 0) > 0 || Number(capacity[0]?.count ?? 0) >= ACTIVE_ENTRY_LIMIT) return "skipped" as const;
      const operationId = stableUuid([
        "d487-legacy-manage-avatar-history",
        identity.serverInstanceId,
        candidate.messageId,
        candidate.ownerUserId,
        candidate.agentId,
        candidate.kind,
        candidate.blobId,
      ]);
      const [created] = await tx.insert(ownedPhotoEntries).values({
        serverInstanceId: identity.serverInstanceId,
        ownerUserId: candidate.ownerUserId,
        subjectKind: "agent",
        agentId: candidate.agentId,
        avatarKind: candidate.kind,
        blobId: candidate.blobId,
        source: "legacy_backfill",
        origin: "legacy_backfill",
        operationId,
        requestFingerprint: fingerprint(candidate, immutableMedia),
        ...immutableMedia,
        createdAt: candidate.createdAt,
      }).onConflictDoNothing({
        target: [ownedPhotoEntries.serverInstanceId, ownedPhotoEntries.avatarKind, ownedPhotoEntries.blobId],
      }).returning({ id: ownedPhotoEntries.id });
      if (!created) return "quarantined" as const;
      await tx.update(profiles).set({
        avatarLibraryRevision: sql`${profiles.avatarLibraryRevision} + 1`,
      }).where(eq(profiles.id, profile.id));
      return "adopted" as const;
    });
    if (result === "adopted") adopted += 1;
    else if (result === "already") alreadyAdopted += 1;
    else if (result === "skipped") skipped += 1;
    else quarantined += 1;
  }
  return {
    serverInstanceId: identity.serverInstanceId,
    adopted,
    alreadyAdopted,
    skipped,
    quarantined,
    transcriptLimitReached,
  };
}
