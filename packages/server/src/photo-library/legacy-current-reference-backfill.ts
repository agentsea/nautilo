/**
 * D487 Phase 1.3 — conservative, database-led adoption of legacy CURRENT
 * avatar references.  This module intentionally never enumerates a media
 * directory: a byte is considered only after a canonical DB pointer names it.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, rm } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";
import {
  actors,
  and,
  eq,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  profiles,
  sql,
  users,
  type DirectDatabase,
} from "@nautilo/db";
import { getProfileAvatarsRoot } from "@nautilo/config";
import type { AvatarRef } from "@nautilo/types";

type CustomAvatarRef = Extract<AvatarRef, { kind: "generated" | "uploaded" }>;
type SubjectKind = "agent" | "human";

export type LegacyPhotoBackfillReason =
  | "missing_current_bytes"
  | "invalid_current_ref"
  | "duplicate_current_ref"
  | "owner_mismatch"
  | "changed_current_bytes"
  | "current_ref_changed"
  | "missing_generated_thumbnail";

export type LegacyPhotoBackfillRow = {
  readonly serverInstanceId: string;
  readonly subjectKind: SubjectKind;
  readonly ownerUserId: string;
  readonly agentId: string | null;
  readonly avatarKind: CustomAvatarRef["kind"];
  /** Null only for an invalid raw DB ref; use refToken for reconciliation. */
  readonly blobId: string | null;
  /** Fixed-size digest of the ref, never an unsafe raw DB value. */
  readonly refToken: string;
  readonly outcome: "would_adopt" | "adopted" | "already_adopted" | "quarantined";
  readonly reason?: LegacyPhotoBackfillReason;
  readonly mediaByteSize?: number;
  readonly mediaSha256?: string;
  readonly mediaMimeType?: string;
  readonly generatedThumbnailReady?: boolean;
};

export type LegacyPhotoBackfillReport = {
  readonly dryRun: boolean;
  readonly serverInstanceId: string;
  readonly rows: readonly LegacyPhotoBackfillRow[];
  readonly counts: Readonly<Record<LegacyPhotoBackfillRow["outcome"], number>>;
  readonly ignoredPresetReferences: number;
};

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type LegacyPhotoMediaInspection = {
  readonly exists: boolean;
  readonly mediaByteSize?: number;
  readonly mediaSha256?: string;
  readonly mediaMimeType?: string;
  readonly generatedThumbnailReady?: boolean;
};

export type LegacyPhotoBackfillDependencies = {
  readonly db: DirectDatabase;
  /**
   * Receives only a validated kind/blob pair.  The default resolves the
   * exact known root and checks a regular image file; it never scans roots.
   */
  readonly inspectMedia?: (ref: CustomAvatarRef) => Promise<LegacyPhotoMediaInspection>;
  /** Strictly creates the required generated derivative; true means this call created it. */
  readonly ensureGeneratedThumbnail?: (ref: CustomAvatarRef) => Promise<boolean>;
  readonly removeGeneratedThumbnail?: (ref: CustomAvatarRef) => Promise<void>;
  readonly operationId?: (row: {
    readonly serverInstanceId: string;
    readonly subjectKind: SubjectKind;
    readonly ownerUserId: string;
    readonly agentId: string | null;
    readonly ref: CustomAvatarRef;
    readonly mediaSha256: string;
    readonly mediaByteSize: number;
  }) => string;
};

type Candidate = {
  readonly subjectKind: SubjectKind;
  readonly ownerUserId: string;
  readonly agentId: string | null;
  readonly profileId: string | null;
  readonly ref: CustomAvatarRef;
};

type RawCandidate = Candidate | {
  readonly subjectKind: SubjectKind;
  readonly ownerUserId: string;
  readonly agentId: string | null;
  readonly profileId: string | null;
  readonly invalidRef: true;
  readonly avatarKind: "generated" | "uploaded";
  readonly blobId: string;
};

const SAFE_BLOB_ID = /^[A-Za-z0-9._-]{1,256}$/;
const MAX_UPLOADED_AVATAR_BYTES = 5 * 1024 * 1024;
const MAX_GENERATED_AVATAR_BYTES = 8 * 1024 * 1024;
const MAX_LEGACY_AVATAR_DIMENSION = 8192;
const MIME_BY_SHARP_FORMAT: Record<string, string | undefined> = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

function asCustomAvatarRef(value: unknown): CustomAvatarRef | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const valueRecord = value as Record<string, unknown>;
  const kind = valueRecord["kind"];
  const blobId = valueRecord["blobId"];
  if ((kind !== "generated" && kind !== "uploaded") || typeof blobId !== "string") return null;
  if (!SAFE_BLOB_ID.test(blobId)) return null;
  if (Object.keys(valueRecord).length !== 2) return null;
  return { kind, blobId };
}

function isPresetAvatarRef(value: unknown): boolean {
  return !!value
    && typeof value === "object"
    && !Array.isArray(value)
    && (value as Record<string, unknown>)["kind"] === "preset";
}

function invalidRefShape(value: unknown): { avatarKind: "generated" | "uploaded"; blobId: string } {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return {
      avatarKind: record["kind"] === "uploaded" ? "uploaded" : "generated",
      blobId: typeof record["blobId"] === "string" ? record["blobId"] : "",
    };
  }
  return { avatarKind: "generated", blobId: "" };
}

function candidateKey(serverInstanceId: string, candidate: Candidate): string {
  return [serverInstanceId, candidate.ref.kind, candidate.ref.blobId].join("\u0000");
}

function redactedRow(
  serverInstanceId: string,
  candidate: Candidate | RawCandidate,
  outcome: LegacyPhotoBackfillRow["outcome"],
  reason?: LegacyPhotoBackfillReason,
): LegacyPhotoBackfillRow {
  const invalid = "invalidRef" in candidate;
  const ref = "ref" in candidate
    ? candidate.ref
    : { kind: candidate.avatarKind, blobId: candidate.blobId };
  const refToken = createHash("sha256")
    .update(ref.kind)
    .update("\u0000")
    .update(String(ref.blobId).slice(0, 1024))
    .update("\u0000")
    .update(String(ref.blobId).slice(-1024))
    .update("\u0000")
    .update(String(ref.blobId).length.toString())
    .digest("hex")
    .slice(0, 24);
  return {
    serverInstanceId,
    subjectKind: candidate.subjectKind,
    ownerUserId: candidate.ownerUserId,
    agentId: candidate.agentId,
    avatarKind: ref.kind,
    blobId: invalid ? null : ref.blobId,
    refToken,
    outcome,
    ...(reason ? { reason } : {}),
  };
}

function stableOperationId(input: {
  readonly serverInstanceId: string;
  readonly subjectKind: SubjectKind;
  readonly ownerUserId: string;
  readonly agentId: string | null;
  readonly ref: CustomAvatarRef;
  readonly mediaSha256: string;
  readonly mediaByteSize: number;
}): string {
  const digest = createHash("sha256")
    .update(JSON.stringify(["d487-legacy-current-reference", input]))
    .digest();
  // RFC 4122 variant + version 5-shaped stable UUID. It is an opaque durable
  // operation correlation, not an identity claim or user-visible identifier.
  digest[6] = (digest[6]! & 0x0f) | 0x50;
  digest[8] = (digest[8]! & 0x3f) | 0x80;
  const hex = digest.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function fingerprint(candidate: Candidate, media: Required<Pick<LegacyPhotoMediaInspection, "mediaByteSize" | "mediaSha256" | "mediaMimeType">>): string {
  return createHash("sha256")
    .update(JSON.stringify([
      "d487-legacy-current-reference:v1",
      candidate.subjectKind,
      candidate.ownerUserId,
      candidate.agentId,
      candidate.ref,
      media.mediaByteSize,
      media.mediaSha256,
      media.mediaMimeType,
    ]))
    .digest("hex");
}

function sameRef(left: unknown, right: CustomAvatarRef): boolean {
  const parsed = asCustomAvatarRef(left);
  return parsed?.kind === right.kind && parsed.blobId === right.blobId;
}

function sameEntry(
  entry: typeof ownedPhotoEntries.$inferSelect,
  candidate: Candidate,
  media: Required<Pick<LegacyPhotoMediaInspection, "mediaByteSize" | "mediaSha256" | "mediaMimeType">>,
): boolean {
  return entry.ownerUserId === candidate.ownerUserId
    && entry.subjectKind === candidate.subjectKind
    && entry.agentId === candidate.agentId
    && entry.avatarKind === candidate.ref.kind
    && entry.blobId === candidate.ref.blobId
    && entry.deletedAt === null
    && entry.gcClaimToken === null
    && entry.gcClaimedAt === null
    && entry.mediaByteSize === media.mediaByteSize
    && entry.mediaSha256 === media.mediaSha256
    && entry.mediaMimeType === media.mediaMimeType;
}

function sameSubject(entry: typeof ownedPhotoEntries.$inferSelect, candidate: Candidate): boolean {
  return entry.ownerUserId === candidate.ownerUserId
    && entry.subjectKind === candidate.subjectKind
    && entry.agentId === candidate.agentId;
}

async function readRegularImageNoFollow(filePath: string, maximumBytes: number): Promise<Buffer | null> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(filePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size < 1 || stat.size > maximumBytes) return null;
    const bytes = Buffer.allocUnsafe(stat.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (bytesRead === 0) return null;
      offset += bytesRead;
    }
    return bytes;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function inspectImageBytes(bytes: Buffer): Promise<{ mimeType: string; width: number; height: number } | null> {
  try {
    const metadata = await sharp(bytes, { limitInputPixels: MAX_LEGACY_AVATAR_DIMENSION ** 2 }).metadata();
    const mimeType = metadata.format ? MIME_BY_SHARP_FORMAT[metadata.format] : undefined;
    if (!mimeType || !metadata.width || !metadata.height || metadata.width < 1 || metadata.height < 1) return null;
    if (metadata.width > MAX_LEGACY_AVATAR_DIMENSION || metadata.height > MAX_LEGACY_AVATAR_DIMENSION) return null;
    return { mimeType, width: metadata.width, height: metadata.height };
  } catch {
    return null;
  }
}

function generatedThumbnailPath(ref: CustomAvatarRef): string {
  return join(getProfileAvatarsRoot(), "generated", `${ref.blobId}.thumb.webp`);
}

export async function ensureLegacyGeneratedThumbnail(ref: CustomAvatarRef): Promise<boolean> {
  if (ref.kind !== "generated") return false;
  const original = await readRegularImageNoFollow(
    join(getProfileAvatarsRoot(), "generated", `${ref.blobId}.png`),
    MAX_GENERATED_AVATAR_BYTES,
  );
  if (!original || !(await inspectImageBytes(original))) {
    throw new Error("Generated avatar original is unavailable for thumbnail creation");
  }
  const thumbnail = await sharp(original, {
    limitInputPixels: MAX_LEGACY_AVATAR_DIMENSION ** 2,
  })
    .resize(256, 256, { fit: "cover", position: "center" })
    .webp({ quality: 82 })
    .toBuffer();
  const path = generatedThumbnailPath(ref);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(
      path,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    await handle.writeFile(thumbnail);
    await handle.sync();
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const existing = await readRegularImageNoFollow(path, MAX_UPLOADED_AVATAR_BYTES);
      const inspected = existing ? await inspectImageBytes(existing) : null;
      if (inspected?.mimeType === "image/webp" && inspected.width === 256 && inspected.height === 256) {
        return false;
      }
    }
    throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function removeLegacyGeneratedThumbnail(ref: CustomAvatarRef): Promise<void> {
  if (ref.kind === "generated") await rm(generatedThumbnailPath(ref), { force: true });
}

export async function inspectLegacyAvatarMedia(ref: CustomAvatarRef): Promise<LegacyPhotoMediaInspection> {
  const filePath = join(getProfileAvatarsRoot(), ref.kind, `${ref.blobId}.png`);
  const bytes = await readRegularImageNoFollow(
    filePath,
    ref.kind === "uploaded" ? MAX_UPLOADED_AVATAR_BYTES : MAX_GENERATED_AVATAR_BYTES,
  );
  if (!bytes) return { exists: false };
  const image = await inspectImageBytes(bytes);
  if (!image) return { exists: false };
  if (
    image.mimeType !== "image/png"
    || (ref.kind === "uploaded" && (image.width !== 256 || image.height !== 256))
    || (ref.kind === "generated" && (image.width !== 1024 || image.height !== 1024))
  ) {
    return { exists: false };
  }
  let generatedThumbnailReady: boolean | undefined;
  if (ref.kind === "generated") {
    const thumbnailBytes = await readRegularImageNoFollow(
      join(getProfileAvatarsRoot(), "generated", `${ref.blobId}.thumb.webp`),
      MAX_UPLOADED_AVATAR_BYTES,
    );
    const thumbnail = thumbnailBytes ? await inspectImageBytes(thumbnailBytes) : null;
    generatedThumbnailReady = thumbnail?.mimeType === "image/webp"
      && thumbnail.width === 256
      && thumbnail.height === 256;
  }
  return {
    exists: true,
    mediaByteSize: bytes.byteLength,
    mediaSha256: createHash("sha256").update(bytes).digest("hex"),
    mediaMimeType: image.mimeType,
    ...(generatedThumbnailReady === undefined ? {} : { generatedThumbnailReady }),
  };
}

async function readLegacyCurrentPhotoCandidates(
  db: DirectDatabase,
  options: { readonly ownerUserIds?: readonly string[] } = {},
): Promise<{
  readonly candidates: Candidate[];
  readonly invalid: RawCandidate[];
  readonly ownerMismatches: Candidate[];
  readonly ignoredPresetReferences: number;
}> {
  const ownerFilter = options.ownerUserIds ? new Set(options.ownerUserIds) : null;
  const [profileRows, humanRows, agentActors] = await Promise.all([
    db.select({ id: profiles.id, userId: profiles.userId, agentId: profiles.agentId, avatarRef: profiles.avatarRef }).from(profiles),
    db.select({ id: users.id, humanAvatarRef: users.humanAvatarRef }).from(users),
    db.select({ ownerUserId: actors.ownerId, agentId: actors.agentId }).from(actors).where(eq(actors.kind, "agent")),
  ]);
  const actorOwners = new Map<string, Set<string>>();
  for (const actor of agentActors) {
    if (!actor.agentId) continue;
    const owners = actorOwners.get(actor.agentId) ?? new Set<string>();
    owners.add(actor.ownerUserId);
    actorOwners.set(actor.agentId, owners);
  }

  const candidates: Candidate[] = [];
  const invalid: RawCandidate[] = [];
  const ownerMismatches: Candidate[] = [];
  let ignoredPresetReferences = 0;
  for (const profile of profileRows) {
    if (ownerFilter && !ownerFilter.has(profile.userId)) continue;
    if (isPresetAvatarRef(profile.avatarRef) || profile.avatarRef === null) {
      if (isPresetAvatarRef(profile.avatarRef)) ignoredPresetReferences += 1;
      continue;
    }
    const ref = asCustomAvatarRef(profile.avatarRef);
    if (!ref) {
      invalid.push({ subjectKind: "agent", ownerUserId: profile.userId, agentId: profile.agentId, profileId: profile.id, invalidRef: true, ...invalidRefShape(profile.avatarRef) });
      continue;
    }
    const candidate: Candidate = { subjectKind: "agent", ownerUserId: profile.userId, agentId: profile.agentId, profileId: profile.id, ref };
    const owners = actorOwners.get(profile.agentId);
    if (!owners || owners.size !== 1 || !owners.has(profile.userId)) ownerMismatches.push(candidate);
    else candidates.push(candidate);
  }
  for (const user of humanRows) {
    if (ownerFilter && !ownerFilter.has(user.id)) continue;
    if (isPresetAvatarRef(user.humanAvatarRef) || user.humanAvatarRef === null) {
      if (isPresetAvatarRef(user.humanAvatarRef)) ignoredPresetReferences += 1;
      continue;
    }
    const ref = asCustomAvatarRef(user.humanAvatarRef);
    if (!ref) {
      invalid.push({ subjectKind: "human", ownerUserId: user.id, agentId: null, profileId: null, invalidRef: true, ...invalidRefShape(user.humanAvatarRef) });
      continue;
    }
    candidates.push({ subjectKind: "human", ownerUserId: user.id, agentId: null, profileId: null, ref });
  }
  return { candidates, invalid, ownerMismatches, ignoredPresetReferences };
}

async function applyCandidate(
  dependencies: LegacyPhotoBackfillDependencies,
  serverInstanceId: string,
  candidate: Candidate,
  media: Required<Pick<LegacyPhotoMediaInspection, "mediaByteSize" | "mediaSha256" | "mediaMimeType">>,
): Promise<LegacyPhotoBackfillRow> {
  const inspect = dependencies.inspectMedia ?? inspectLegacyAvatarMedia;
  const ensureThumbnail = dependencies.ensureGeneratedThumbnail ?? ensureLegacyGeneratedThumbnail;
  const removeThumbnail = dependencies.removeGeneratedThumbnail ?? removeLegacyGeneratedThumbnail;
  let createdThumbnail = false;
  try {
    const result = await dependencies.db.transaction(async (tx) => {
    const [transactionIdentity] = await tx
      .select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
      .from(nautiloInstanceIdentity)
      .where(eq(nautiloInstanceIdentity.id, "self"))
      .limit(1);
    if (transactionIdentity?.serverInstanceId !== serverInstanceId) {
      throw new Error("D487 backfill Server identity changed before apply");
    }
    // Re-read the exact bytes while this candidate's DB work is pending. This
    // is the only honest response to a file that changed after dry-run.
    let fresh = await inspect(candidate.ref);
    if (!fresh.exists || fresh.mediaByteSize === undefined || !fresh.mediaSha256 || !fresh.mediaMimeType) {
      return redactedRow(serverInstanceId, candidate, "quarantined", "missing_current_bytes");
    }
    if (candidate.ref.kind === "generated" && fresh.generatedThumbnailReady !== true) {
      try {
        createdThumbnail = await ensureThumbnail(candidate.ref);
        fresh = await inspect(candidate.ref);
      } catch {
        return redactedRow(serverInstanceId, candidate, "quarantined", "missing_generated_thumbnail");
      }
      if (fresh.generatedThumbnailReady !== true) {
        return redactedRow(serverInstanceId, candidate, "quarantined", "missing_generated_thumbnail");
      }
    }
    if (fresh.mediaByteSize !== media.mediaByteSize || fresh.mediaSha256 !== media.mediaSha256 || fresh.mediaMimeType !== media.mediaMimeType) {
      return redactedRow(serverInstanceId, candidate, "quarantined", "changed_current_bytes");
    }

    // This is a one-time offline maintenance operation. Taking the admission
    // lock before any subject row lock makes Human/Agent candidates share one
    // order and prevents a legacy pointer writer from creating a phantom
    // duplicate after the in-transaction recount.
    await tx.execute(sql`LOCK TABLE profiles, users, actors IN ACCESS EXCLUSIVE MODE NOWAIT`);

    if (candidate.subjectKind === "agent") {
      const lockedRows = await tx.execute(sql`
        SELECT id, avatar_ref
        FROM profiles
        WHERE id = ${candidate.profileId!}
          AND user_id = ${candidate.ownerUserId}
          AND agent_id = ${candidate.agentId!}
        FOR UPDATE
      `);
      const locked = (lockedRows as unknown as Array<{ id: string; avatar_ref: unknown }>)[0];
      if (!locked || !sameRef(locked.avatar_ref, candidate.ref)) {
        return redactedRow(serverInstanceId, candidate, "quarantined", "current_ref_changed");
      }
      // Keep the same profile -> actor lock order as interactive selection,
      // deletion, and restore so an operator backfill cannot deadlock them.
      const actorRows = await tx.execute(sql`
        SELECT id, owner_id
        FROM actors
        WHERE agent_id = ${candidate.agentId!} AND kind = 'agent'
        ORDER BY id
        FOR UPDATE
      `);
      const mirrors = actorRows as unknown as Array<{ id: string; owner_id: string }>;
      if (mirrors.length !== 1 || mirrors[0]?.owner_id !== candidate.ownerUserId) {
        return redactedRow(serverInstanceId, candidate, "quarantined", "owner_mismatch");
      }
    } else {
      const lockedRows = await tx.execute(sql`
        SELECT id, human_avatar_ref
        FROM users
        WHERE id = ${candidate.ownerUserId}
        FOR UPDATE
      `);
      const locked = (lockedRows as unknown as Array<{ id: string; human_avatar_ref: unknown }>)[0];
      if (!locked || !sameRef(locked.human_avatar_ref, candidate.ref)) {
        return redactedRow(serverInstanceId, candidate, "quarantined", "current_ref_changed");
      }
    }

    // Discovery was only a preflight. Lock and recount every canonical
    // current pointer for this exact blob before publishing ownership so a
    // new Human/Agent pointer cannot turn it into a shared legacy claim.
    const profilePointers = await tx.execute(sql`
      SELECT id
      FROM profiles
      WHERE avatar_ref->>'kind' = ${candidate.ref.kind}
        AND avatar_ref->>'blobId' = ${candidate.ref.blobId}
      ORDER BY id
      FOR UPDATE
    `) as unknown as Array<{ id: string }>;
    const humanPointers = await tx.execute(sql`
      SELECT id
      FROM users
      WHERE human_avatar_ref->>'kind' = ${candidate.ref.kind}
        AND human_avatar_ref->>'blobId' = ${candidate.ref.blobId}
      ORDER BY id
      FOR UPDATE
    `) as unknown as Array<{ id: string }>;
    const ownPointerCount = candidate.subjectKind === "agent"
      ? profilePointers.filter((pointer) => pointer.id === candidate.profileId).length
      : humanPointers.filter((pointer) => pointer.id === candidate.ownerUserId).length;
    if (profilePointers.length + humanPointers.length !== 1 || ownPointerCount !== 1) {
      return redactedRow(serverInstanceId, candidate, "quarantined", "duplicate_current_ref");
    }

    const [existing] = await tx.select().from(ownedPhotoEntries).where(and(
      eq(ownedPhotoEntries.serverInstanceId, serverInstanceId),
      eq(ownedPhotoEntries.avatarKind, candidate.ref.kind),
      eq(ownedPhotoEntries.blobId, candidate.ref.blobId),
    )).limit(1).for("update");
    if (existing) {
      if (sameEntry(existing, candidate, media)) {
        return { ...redactedRow(serverInstanceId, candidate, "already_adopted"), ...media };
      }
      return redactedRow(
        serverInstanceId,
        candidate,
        "quarantined",
        sameSubject(existing, candidate) ? "changed_current_bytes" : "duplicate_current_ref",
      );
    }

    const operationInput = {
      serverInstanceId,
      subjectKind: candidate.subjectKind,
      ownerUserId: candidate.ownerUserId,
      agentId: candidate.agentId,
      ref: candidate.ref,
      mediaSha256: media.mediaSha256,
      mediaByteSize: media.mediaByteSize,
    };
    const operationId = dependencies.operationId?.(operationInput) ?? stableOperationId(operationInput);
    const [created] = await tx.insert(ownedPhotoEntries).values({
      serverInstanceId,
      ownerUserId: candidate.ownerUserId,
      subjectKind: candidate.subjectKind,
      agentId: candidate.agentId,
      avatarKind: candidate.ref.kind,
      blobId: candidate.ref.blobId,
      source: "legacy_backfill",
      origin: "legacy_backfill",
      operationId,
      requestFingerprint: fingerprint(candidate, media),
      mediaMimeType: media.mediaMimeType,
      mediaByteSize: media.mediaByteSize,
      mediaSha256: media.mediaSha256,
    }).onConflictDoNothing({
      target: [ownedPhotoEntries.serverInstanceId, ownedPhotoEntries.avatarKind, ownedPhotoEntries.blobId],
    }).returning();
    if (!created) {
      // A concurrent rerun won after our locked read. Re-read in the same
      // transaction and only accept its exact immutable provenance.
      const [raced] = await tx.select().from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, serverInstanceId),
        eq(ownedPhotoEntries.avatarKind, candidate.ref.kind),
        eq(ownedPhotoEntries.blobId, candidate.ref.blobId),
      )).limit(1);
      if (raced && sameEntry(raced, candidate, media)) {
        return { ...redactedRow(serverInstanceId, candidate, "already_adopted"), ...media };
      }
      return redactedRow(
        serverInstanceId,
        candidate,
        "quarantined",
        raced && !sameSubject(raced, candidate)
          ? "duplicate_current_ref"
          : "changed_current_bytes",
      );
    }
    if (candidate.subjectKind === "agent") {
      await tx.update(profiles).set({
        avatarLibraryRevision: sql`${profiles.avatarLibraryRevision} + 1`,
      }).where(and(
        eq(profiles.id, candidate.profileId!),
        eq(profiles.userId, candidate.ownerUserId),
        eq(profiles.agentId, candidate.agentId!),
      ));
    }
    return { ...redactedRow(serverInstanceId, candidate, "adopted"), ...media };
    });
    if (createdThumbnail && result.outcome === "quarantined") {
      await removeThumbnail(candidate.ref);
    }
    return result;
  } catch (error) {
    if (createdThumbnail) await removeThumbnail(candidate.ref).catch(() => {});
    throw error;
  }
}

/**
 * Backfill only current, provable references. `dryRun` defaults to true so a
 * command invocation cannot write without a deliberate explicit opt-in.
 */
export async function backfillLegacyCurrentPhotoReferences(
  dependencies: LegacyPhotoBackfillDependencies,
  options: {
    readonly dryRun?: boolean;
    readonly ownerUserIds?: readonly string[];
    readonly expectedServerInstanceId?: string;
    /** Apply is deliberately an offline/exclusive maintenance operation. */
    readonly exclusiveMaintenance?: boolean;
  } = {},
): Promise<LegacyPhotoBackfillReport> {
  const dryRun = options.dryRun !== false;
  const [identity] = await dependencies.db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  if (!identity) throw new Error("D487 backfill requires the singleton server identity");
  const serverInstanceId = identity.serverInstanceId;
  if (!dryRun) {
    if (!options.expectedServerInstanceId || !UUID_PATTERN.test(options.expectedServerInstanceId)) {
      throw new Error("D487 apply requires an explicit expected Server UUID");
    }
    if (options.expectedServerInstanceId !== serverInstanceId) {
      throw new Error("D487 apply refused because the expected Server UUID does not match");
    }
    if (options.exclusiveMaintenance !== true) {
      throw new Error("D487 apply requires explicit exclusive maintenance admission");
    }
  }
  const { candidates, invalid, ownerMismatches, ignoredPresetReferences } = await readLegacyCurrentPhotoCandidates(
    dependencies.db,
    options.ownerUserIds ? { ownerUserIds: options.ownerUserIds } : {},
  );
  const rows: LegacyPhotoBackfillRow[] = [
    ...invalid.map((candidate) => redactedRow(serverInstanceId, candidate, "quarantined", "invalid_current_ref")),
    ...ownerMismatches.map((candidate) => redactedRow(serverInstanceId, candidate, "quarantined", "owner_mismatch")),
  ];
  const grouped = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const key = candidateKey(serverInstanceId, candidate);
    const group = grouped.get(key) ?? [];
    group.push(candidate);
    grouped.set(key, group);
  }
  const inspect = dependencies.inspectMedia ?? inspectLegacyAvatarMedia;
  for (const group of grouped.values()) {
    if (group.length !== 1) {
      rows.push(...group.map((candidate) => redactedRow(serverInstanceId, candidate, "quarantined", "duplicate_current_ref")));
      continue;
    }
    const candidate = group[0]!;
    const inspected = await inspect(candidate.ref);
    if (!inspected.exists || inspected.mediaByteSize === undefined || !inspected.mediaSha256 || !inspected.mediaMimeType) {
      rows.push(redactedRow(serverInstanceId, candidate, "quarantined", "missing_current_bytes"));
      continue;
    }
    const media = {
      mediaByteSize: inspected.mediaByteSize,
      mediaSha256: inspected.mediaSha256,
      mediaMimeType: inspected.mediaMimeType,
    };
    if (dryRun) {
      const [existing] = await dependencies.db.select().from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, serverInstanceId),
        eq(ownedPhotoEntries.avatarKind, candidate.ref.kind),
        eq(ownedPhotoEntries.blobId, candidate.ref.blobId),
      )).limit(1);
      rows.push(existing
        ? (sameEntry(existing, candidate, media)
          ? { ...redactedRow(serverInstanceId, candidate, "already_adopted"), ...media }
          : redactedRow(
            serverInstanceId,
            candidate,
            "quarantined",
            sameSubject(existing, candidate)
              ? "changed_current_bytes"
              : "duplicate_current_ref",
          ))
        : { ...redactedRow(serverInstanceId, candidate, "would_adopt"), ...media });
    } else {
      rows.push(await applyCandidate(dependencies, serverInstanceId, candidate, media));
    }
  }
  rows.sort((left, right) =>
    [left.subjectKind, left.ownerUserId, left.agentId ?? "", left.avatarKind, left.blobId]
      .join("\u0000")
      .localeCompare([right.subjectKind, right.ownerUserId, right.agentId ?? "", right.avatarKind, right.blobId].join("\u0000")),
  );
  const counts: Record<LegacyPhotoBackfillRow["outcome"], number> = {
    would_adopt: 0,
    adopted: 0,
    already_adopted: 0,
    quarantined: 0,
  };
  for (const row of rows) counts[row.outcome] += 1;
  return { dryRun, serverInstanceId, rows, counts, ignoredPresetReferences };
}
