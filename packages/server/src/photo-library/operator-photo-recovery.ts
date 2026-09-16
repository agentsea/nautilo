/**
 * D487 operator-only recovery for one explicitly named quarantined blob.
 *
 * This module never enumerates a directory and has no HTTP registration. A
 * dry run binds one exact DB/media snapshot into a ten-minute confirmation;
 * apply revalidates it under Nautilo's durable maintenance lease and creates
 * an unselected `operator_adoption` entry.
 */
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import {
  actors,
  and,
  clearMaintenanceWith,
  createOwnedPhotoEntryIdempotently,
  enterDrainingWith,
  eq,
  groupMembers,
  groupRoles,
  groups,
  isNull,
  nautiloInstanceIdentity,
  ownedPhotoEntries,
  photoLibraryOperations,
  profiles,
  roles,
  sql,
  transitionApplyingWith,
  type DirectDatabase,
} from "@nautilo/db";
import { gt } from "drizzle-orm";
import type { AvatarRef } from "@nautilo/types";
import {
  ensureLegacyGeneratedThumbnail,
  inspectLegacyAvatarMedia,
  type LegacyPhotoMediaInspection,
} from "./legacy-current-reference-backfill";
import type { PhotoLibraryRecoveryAuditEvent } from "./operator-photo-recovery-audit";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SAFE_BLOB_ID = /^[A-Za-z0-9._-]{1,256}$/;
const TOKEN_LIFETIME_MS = 10 * 60 * 1000;
const ACTIVE_ENTRY_LIMIT = 200;
const MAX_TOKEN = Number.MAX_SAFE_INTEGER;
const TOKEN_DOMAIN = "nautilo.photo-library-recovery.v1\0";

export type PhotoRecoveryKind = "generated" | "uploaded";
export type PhotoRecoveryRefusalReason =
  | "server_identity_mismatch"
  | "operator_not_owner"
  | "owner_agent_mismatch"
  | "missing_or_invalid_media"
  | "missing_generated_thumbnail"
  | "existing_ownership_conflict"
  | "current_reference_conflict"
  | "confirmation_invalid"
  | "confirmation_expired"
  | "confirmation_mismatch"
  | "media_changed"
  | "target_state_changed"
  | "library_capacity_reached"
  | "library_revision_exhausted"
  | "maintenance_unavailable";

export interface PhotoLibraryRecoveryTarget {
  readonly serverInstanceId: string;
  readonly operatorUserId: string;
  readonly ownerUserId: string;
  readonly agentId: string;
  readonly kind: PhotoRecoveryKind;
  readonly blobId: string;
}

export type PhotoLibraryRecoveryResult = PhotoLibraryRecoveryTarget & {
  readonly action: "dry_run" | "apply";
  readonly outcome: "would_adopt" | "adopted" | "already_adopted" | "refused";
  readonly operationId: string;
  readonly source: "operator_adoption";
  readonly mediaByteSize?: number;
  readonly mediaSha256?: string;
  readonly mediaMimeType?: string;
  readonly entryId?: string;
  readonly confirmToken?: string;
  readonly confirmExpiresAt?: string;
  readonly reason?: PhotoRecoveryRefusalReason;
};

type RecoveryTokenClaims = PhotoLibraryRecoveryTarget & {
  readonly version: 1;
  readonly operationId: string;
  readonly issuedAtMs: number;
  readonly expiresAtMs: number;
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: string;
  readonly targetStateHash: string;
  readonly requestFingerprint: string;
};

export interface PhotoLibraryRecoveryDependencies {
  readonly db: DirectDatabase;
  readonly now?: () => Date;
  readonly operationId?: () => string;
  readonly inspectMedia?: (ref: { kind: PhotoRecoveryKind; blobId: string }) => Promise<LegacyPhotoMediaInspection>;
  /** Apply-only derivative repair. Dry-run never mutates media. */
  readonly ensureGeneratedThumbnail?: (ref: { kind: PhotoRecoveryKind; blobId: string }) => Promise<boolean>;
  readonly audit?: (event: PhotoLibraryRecoveryAuditEvent) => void | Promise<void>;
}

class RecoveryRefusal extends Error {
  constructor(readonly reason: PhotoRecoveryRefusalReason, message: string) {
    super(message);
    this.name = "RecoveryRefusal";
  }
}

type Preflight = {
  readonly operatorActorId: string;
  readonly profileId: string;
  readonly avatarRef: AvatarRef | null;
  readonly selectionRevision: number;
  readonly libraryRevision: number;
  readonly mediaByteSize: number;
  readonly mediaSha256: string;
  readonly mediaMimeType: string;
  readonly generatedThumbnailReady: boolean;
  readonly existing: typeof ownedPhotoEntries.$inferSelect | null;
};

function assertTarget(target: PhotoLibraryRecoveryTarget): void {
  for (const [label, value] of [
    ["server instance", target.serverInstanceId],
    ["operator user", target.operatorUserId],
    ["owner user", target.ownerUserId],
    ["Agent", target.agentId],
  ] as const) {
    if (!UUID.test(value)) throw new Error(`Invalid ${label} UUID`);
  }
  if ((target.kind !== "generated" && target.kind !== "uploaded") || !SAFE_BLOB_ID.test(target.blobId)) {
    throw new Error("Invalid explicit photo recovery kind/blob target");
  }
}

function canonical(value: unknown): string {
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonical(value)).digest("hex");
}

function requestFingerprint(target: PhotoLibraryRecoveryTarget, media: {
  mediaByteSize: number;
  mediaSha256: string;
  mediaMimeType: string;
}): string {
  return digest(["d487-operator-adoption:v1", target, media]);
}

function targetStateHash(target: PhotoLibraryRecoveryTarget, preflight: Pick<
  Preflight,
  "profileId" | "avatarRef" | "selectionRevision" | "libraryRevision"
>): string {
  return digest([
    "d487-operator-adoption-target:v1",
    target.serverInstanceId,
    target.operatorUserId,
    target.ownerUserId,
    target.agentId,
    preflight.profileId,
    preflight.avatarRef,
    preflight.selectionRevision,
    preflight.libraryRevision,
    "unowned",
    "unreferenced",
  ]);
}

function tokenChecksum(payload: string, serverInstanceId: string): string {
  // The confirmation is an exact-change ceremony, not authentication: the
  // operator already has local DB/media access and a current Owner role.
  // Domain separation + the durable server UUID detects editing/cross-server
  // reuse without introducing another secret or credential fallback.
  return createHash("sha256")
    .update(TOKEN_DOMAIN)
    .update(serverInstanceId)
    .update("\0")
    .update(payload)
    .digest("base64url");
}

function issueToken(claims: RecoveryTokenClaims): string {
  const payload = Buffer.from(canonical(claims), "utf8").toString("base64url");
  return `${payload}.${tokenChecksum(payload, claims.serverInstanceId)}`;
}

function readToken(token: string, expectedServerInstanceId: string): RecoveryTokenClaims {
  const [payload, supplied, extra] = token.split(".");
  if (!payload || !supplied || extra !== undefined) {
    throw new RecoveryRefusal("confirmation_invalid", "Confirmation token is malformed");
  }
  const expected = tokenChecksum(payload, expectedServerInstanceId);
  const suppliedBytes = Buffer.from(supplied, "utf8");
  const expectedBytes = Buffer.from(expected, "utf8");
  if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
    throw new RecoveryRefusal("confirmation_invalid", "Confirmation token is invalid");
  }
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as RecoveryTokenClaims;
    if (
      parsed.version !== 1
      || !UUID.test(parsed.operationId)
      || !Number.isSafeInteger(parsed.issuedAtMs)
      || !Number.isSafeInteger(parsed.expiresAtMs)
      || parsed.expiresAtMs - parsed.issuedAtMs !== TOKEN_LIFETIME_MS
      || !Number.isSafeInteger(parsed.mediaByteSize)
      || parsed.mediaByteSize < 1
      || !/^[0-9a-f]{64}$/.test(parsed.mediaSha256)
      || parsed.mediaMimeType !== "image/png"
      || !/^[0-9a-f]{64}$/.test(parsed.targetStateHash)
      || !/^[0-9a-f]{64}$/.test(parsed.requestFingerprint)
    ) throw new Error("invalid claims");
    assertTarget(parsed);
    return parsed;
  } catch {
    throw new RecoveryRefusal("confirmation_invalid", "Confirmation token payload is invalid");
  }
}

function sameTarget(left: PhotoLibraryRecoveryTarget, right: PhotoLibraryRecoveryTarget): boolean {
  return left.serverInstanceId === right.serverInstanceId
    && left.operatorUserId === right.operatorUserId
    && left.ownerUserId === right.ownerUserId
    && left.agentId === right.agentId
    && left.kind === right.kind
    && left.blobId === right.blobId;
}

function exactReplay(entry: typeof ownedPhotoEntries.$inferSelect, claims: RecoveryTokenClaims): boolean {
  return entry.serverInstanceId === claims.serverInstanceId
    && entry.ownerUserId === claims.ownerUserId
    && entry.subjectKind === "agent"
    && entry.agentId === claims.agentId
    && entry.avatarKind === claims.kind
    && entry.blobId === claims.blobId
    && entry.source === "operator_adoption"
    && entry.origin === "operator_adoption"
    && entry.operationId === claims.operationId
    && entry.requestFingerprint === claims.requestFingerprint
    && entry.mediaMimeType === claims.mediaMimeType
    && entry.mediaByteSize === claims.mediaByteSize
    && entry.mediaSha256 === claims.mediaSha256;
}

async function inspectExactMedia(
  dependencies: PhotoLibraryRecoveryDependencies,
  target: PhotoLibraryRecoveryTarget,
): Promise<Required<Pick<LegacyPhotoMediaInspection, "mediaByteSize" | "mediaSha256" | "mediaMimeType">> & {
  readonly generatedThumbnailReady: boolean;
}> {
  const inspected = await (dependencies.inspectMedia ?? inspectLegacyAvatarMedia)({
    kind: target.kind,
    blobId: target.blobId,
  });
  if (!inspected.exists || inspected.mediaByteSize === undefined || !inspected.mediaSha256 || inspected.mediaMimeType !== "image/png") {
    throw new RecoveryRefusal("missing_or_invalid_media", "The exact regular image is missing or invalid");
  }
  return {
    mediaByteSize: inspected.mediaByteSize,
    mediaSha256: inspected.mediaSha256,
    mediaMimeType: inspected.mediaMimeType,
    generatedThumbnailReady: target.kind !== "generated" || inspected.generatedThumbnailReady === true,
  };
}

async function operatorActorId(
  db: DirectDatabase,
  operatorUserId: string,
  lock = false,
): Promise<string> {
  const membershipQuery = db
    .select({ userId: groupMembers.userId })
    .from(groupMembers)
    .innerJoin(groups, eq(groups.id, groupMembers.groupId))
    .innerJoin(groupRoles, eq(groupRoles.groupId, groups.id))
    .innerJoin(roles, eq(roles.id, groupRoles.roleId))
    .where(and(
      eq(groupMembers.userId, operatorUserId),
      eq(groups.type, "owners"),
      eq(roles.slug, "owner"),
    ))
    .limit(1);
  const [membership] = lock ? await membershipQuery.for("update") : await membershipQuery;
  if (!membership) throw new RecoveryRefusal("operator_not_owner", "Operator is not a current Server Owner");
  const mirrorQuery = db.select({ id: actors.id }).from(actors).where(and(
    eq(actors.kind, "user"),
    eq(actors.ownerId, operatorUserId),
  ));
  const mirrors = lock ? await mirrorQuery.for("update") : await mirrorQuery;
  if (mirrors.length !== 1) throw new RecoveryRefusal("operator_not_owner", "Operator Owner actor mirror is invalid");
  return mirrors[0]!.id;
}

async function currentReferenceCount(
  db: DirectDatabase,
  target: Pick<PhotoLibraryRecoveryTarget, "kind" | "blobId">,
): Promise<number> {
  const [row] = await db.execute(sql`
    SELECT (
      (SELECT count(*)::int FROM profiles
       WHERE avatar_ref->>'kind' = ${target.kind}
         AND avatar_ref->>'blobId' = ${target.blobId})
      +
      (SELECT count(*)::int FROM users
       WHERE human_avatar_ref->>'kind' = ${target.kind}
         AND human_avatar_ref->>'blobId' = ${target.blobId})
    )::int AS count
  `) as unknown as Array<{ count: number }>;
  return Number(row?.count ?? 0);
}

async function preflight(
  dependencies: PhotoLibraryRecoveryDependencies,
  target: PhotoLibraryRecoveryTarget,
): Promise<Preflight> {
  const [identity] = await dependencies.db.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
    .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1);
  if (!identity || identity.serverInstanceId !== target.serverInstanceId) {
    throw new RecoveryRefusal("server_identity_mismatch", "Explicit Server identity does not match this database");
  }
  const auditActorId = await operatorActorId(dependencies.db, target.operatorUserId);
  const [profile] = await dependencies.db.select({
    id: profiles.id,
    userId: profiles.userId,
    agentId: profiles.agentId,
    avatarRef: profiles.avatarRef,
    avatarSelectionRevision: profiles.avatarSelectionRevision,
    avatarLibraryRevision: profiles.avatarLibraryRevision,
  }).from(profiles).where(eq(profiles.agentId, target.agentId)).limit(1);
  const mirrors = await dependencies.db.select({ ownerUserId: actors.ownerId })
    .from(actors).where(and(eq(actors.kind, "agent"), eq(actors.agentId, target.agentId)));
  if (
    !profile
    || profile.userId !== target.ownerUserId
    || mirrors.length !== 1
    || mirrors[0]?.ownerUserId !== target.ownerUserId
  ) {
    throw new RecoveryRefusal("owner_agent_mismatch", "Explicit owner and Agent are not the canonical mirror pair");
  }
  const media = await inspectExactMedia(dependencies, target);
  const [existing] = await dependencies.db.select().from(ownedPhotoEntries).where(and(
    eq(ownedPhotoEntries.serverInstanceId, target.serverInstanceId),
    eq(ownedPhotoEntries.avatarKind, target.kind),
    eq(ownedPhotoEntries.blobId, target.blobId),
  )).limit(1);
  if (existing) {
    return {
      operatorActorId: auditActorId,
      profileId: profile.id,
      avatarRef: profile.avatarRef,
      selectionRevision: profile.avatarSelectionRevision,
      libraryRevision: profile.avatarLibraryRevision,
      ...media,
      existing,
    };
  }
  if (await currentReferenceCount(dependencies.db, target) !== 0) {
    throw new RecoveryRefusal("current_reference_conflict", "The blob is already named by a current photo reference");
  }
  return {
    operatorActorId: auditActorId,
    profileId: profile.id,
    avatarRef: profile.avatarRef,
    selectionRevision: profile.avatarSelectionRevision,
    libraryRevision: profile.avatarLibraryRevision,
    ...media,
    existing: null,
  };
}

function baseResult(
  target: PhotoLibraryRecoveryTarget,
  action: PhotoLibraryRecoveryResult["action"],
  outcome: PhotoLibraryRecoveryResult["outcome"],
  operationId: string,
): PhotoLibraryRecoveryResult {
  return { ...target, action, outcome, operationId, source: "operator_adoption" };
}

async function emitAudit(
  dependencies: PhotoLibraryRecoveryDependencies,
  result: PhotoLibraryRecoveryResult,
  operatorActor: string | null,
): Promise<void> {
  await dependencies.audit?.({
    ts: (dependencies.now?.() ?? new Date()).toISOString(),
    kind: "photo_library_recovery",
    actorId: operatorActor,
    ip: "local",
    action: result.action,
    outcome: result.outcome,
    operationId: result.operationId,
    serverInstanceId: result.serverInstanceId,
    operatorUserId: result.operatorUserId,
    ownerUserId: result.ownerUserId,
    agentId: result.agentId,
    avatarKind: result.kind,
    blobId: result.blobId,
    ...(result.mediaByteSize === undefined ? {} : { mediaByteSize: result.mediaByteSize }),
    ...(result.mediaSha256 === undefined ? {} : { mediaSha256: result.mediaSha256 }),
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  });
}

export async function previewPhotoLibraryRecovery(
  dependencies: PhotoLibraryRecoveryDependencies,
  target: PhotoLibraryRecoveryTarget,
): Promise<PhotoLibraryRecoveryResult> {
  assertTarget(target);
  const operationId = dependencies.operationId?.() ?? randomUUID();
  let auditActor: string | null = null;
  try {
    const checked = await preflight(dependencies, target);
    auditActor = checked.operatorActorId;
    if (checked.existing) {
      const result = {
        ...baseResult(target, "dry_run", "refused", operationId),
        mediaByteSize: checked.mediaByteSize,
        mediaSha256: checked.mediaSha256,
        mediaMimeType: checked.mediaMimeType,
        reason: "existing_ownership_conflict" as const,
      };
      await emitAudit(dependencies, result, auditActor);
      return result;
    }
    const now = dependencies.now?.() ?? new Date();
    const media = {
      mediaByteSize: checked.mediaByteSize,
      mediaSha256: checked.mediaSha256,
      mediaMimeType: checked.mediaMimeType,
    };
    const claims: RecoveryTokenClaims = {
      version: 1,
      ...target,
      operationId,
      issuedAtMs: now.getTime(),
      expiresAtMs: now.getTime() + TOKEN_LIFETIME_MS,
      ...media,
      targetStateHash: targetStateHash(target, checked),
      requestFingerprint: requestFingerprint(target, media),
    };
    const result = {
      ...baseResult(target, "dry_run", "would_adopt", operationId),
      ...media,
      confirmToken: issueToken(claims),
      confirmExpiresAt: new Date(claims.expiresAtMs).toISOString(),
    };
    await emitAudit(dependencies, result, auditActor);
    return result;
  } catch (error) {
    if (!(error instanceof RecoveryRefusal)) throw error;
    const result = { ...baseResult(target, "dry_run", "refused", operationId), reason: error.reason };
    await emitAudit(dependencies, result, auditActor);
    return result;
  }
}

export async function applyPhotoLibraryRecovery(
  dependencies: PhotoLibraryRecoveryDependencies,
  target: PhotoLibraryRecoveryTarget,
  confirmToken: string,
): Promise<PhotoLibraryRecoveryResult> {
  assertTarget(target);
  let operationId = dependencies.operationId?.() ?? randomUUID();
  let auditActor: string | null = null;
  let maintenanceHeld = false;
  try {
    const claims = readToken(confirmToken, target.serverInstanceId);
    operationId = claims.operationId;
    const now = dependencies.now?.() ?? new Date();
    if (now.getTime() > claims.expiresAtMs) {
      throw new RecoveryRefusal("confirmation_expired", "Confirmation token expired");
    }
    if (!sameTarget(target, claims)) {
      throw new RecoveryRefusal("confirmation_mismatch", "Confirmation token is bound to another explicit target");
    }
    try {
      await enterDrainingWith(dependencies.db, operationId, { leaseMs: 2 * 60_000, hardMs: 10 * 60_000 }, now);
      maintenanceHeld = true;
      await transitionApplyingWith(dependencies.db, operationId, now);
    } catch (error) {
      throw new RecoveryRefusal("maintenance_unavailable", error instanceof Error ? error.message : "Maintenance lock unavailable");
    }

    let checked = await preflight(dependencies, target);
    if (target.kind === "generated" && !checked.generatedThumbnailReady) {
      try {
        await (dependencies.ensureGeneratedThumbnail ?? ensureLegacyGeneratedThumbnail)(target);
      } catch {
        throw new RecoveryRefusal("missing_generated_thumbnail", "The exact generated thumbnail could not be rebuilt");
      }
      checked = await preflight(dependencies, target);
      if (!checked.generatedThumbnailReady) {
        throw new RecoveryRefusal("missing_generated_thumbnail", "The rebuilt generated thumbnail is invalid");
      }
    }
    auditActor = checked.operatorActorId;
    if (
      checked.mediaByteSize !== claims.mediaByteSize
      || checked.mediaSha256 !== claims.mediaSha256
      || checked.mediaMimeType !== claims.mediaMimeType
    ) {
      throw new RecoveryRefusal("media_changed", "Photo bytes changed after dry run");
    }
    if (checked.existing) {
      if (!exactReplay(checked.existing, claims)) {
        throw new RecoveryRefusal("existing_ownership_conflict", "The blob is already owned by another operation or subject");
      }
      const result = {
        ...baseResult(target, "apply", "already_adopted", operationId),
        mediaByteSize: claims.mediaByteSize,
        mediaSha256: claims.mediaSha256,
        mediaMimeType: claims.mediaMimeType,
        entryId: checked.existing.id,
      };
      await emitAudit(dependencies, result, auditActor);
      return result;
    }
    if (targetStateHash(target, checked) !== claims.targetStateHash) {
      throw new RecoveryRefusal("target_state_changed", "Owner/Agent photo-library state changed after dry run");
    }

    const result = await dependencies.db.transaction(async (tx) => {
      const [identity] = await tx.select({ serverInstanceId: nautiloInstanceIdentity.serverInstanceId })
        .from(nautiloInstanceIdentity).where(eq(nautiloInstanceIdentity.id, "self")).limit(1).for("update");
      if (!identity || identity.serverInstanceId !== target.serverInstanceId) {
        throw new RecoveryRefusal("server_identity_mismatch", "Server identity changed during apply");
      }
      const lockedOperatorActorId = await operatorActorId(
        tx as unknown as DirectDatabase,
        target.operatorUserId,
        true,
      );
      if (lockedOperatorActorId !== auditActor) {
        throw new RecoveryRefusal("operator_not_owner", "Operator Owner actor mirror changed during apply");
      }
      const [lockedProfile] = await tx.select({
        id: profiles.id,
        userId: profiles.userId,
        agentId: profiles.agentId,
        avatarRef: profiles.avatarRef,
        avatarSelectionRevision: profiles.avatarSelectionRevision,
        avatarLibraryRevision: profiles.avatarLibraryRevision,
      }).from(profiles).where(eq(profiles.agentId, target.agentId)).limit(1).for("update");
      const lockedMirrors = await tx.select({ ownerUserId: actors.ownerId }).from(actors)
        .where(and(eq(actors.kind, "agent"), eq(actors.agentId, target.agentId))).for("update");
      if (
        !lockedProfile
        || lockedProfile.userId !== target.ownerUserId
        || lockedMirrors.length !== 1
        || lockedMirrors[0]?.ownerUserId !== target.ownerUserId
      ) throw new RecoveryRefusal("owner_agent_mismatch", "Owner/Agent mirror changed during apply");
      if (targetStateHash(target, {
        profileId: lockedProfile.id,
        avatarRef: lockedProfile.avatarRef,
        selectionRevision: lockedProfile.avatarSelectionRevision,
        libraryRevision: lockedProfile.avatarLibraryRevision,
      }) !== claims.targetStateHash) {
        throw new RecoveryRefusal("target_state_changed", "Owner/Agent photo-library state changed during apply");
      }
      if (lockedProfile.avatarLibraryRevision >= MAX_TOKEN) {
        throw new RecoveryRefusal("library_revision_exhausted", "Agent photo-library revision capacity is exhausted");
      }
      if (await currentReferenceCount(tx as unknown as DirectDatabase, target) !== 0) {
        throw new RecoveryRefusal("current_reference_conflict", "The blob became a current photo reference");
      }
      const [owned] = await tx.select().from(ownedPhotoEntries).where(and(
        eq(ownedPhotoEntries.serverInstanceId, target.serverInstanceId),
        eq(ownedPhotoEntries.avatarKind, target.kind),
        eq(ownedPhotoEntries.blobId, target.blobId),
      )).limit(1).for("update");
      if (owned) {
        if (exactReplay(owned, claims)) return { entry: owned, replayed: true };
        throw new RecoveryRefusal("existing_ownership_conflict", "The blob became owned by another operation or subject");
      }
      const capacityNow = dependencies.now?.() ?? new Date();
      const [activeRows, reservationRows] = await Promise.all([
        tx.select({ count: sql<number>`count(*)::int` }).from(ownedPhotoEntries).where(and(
          eq(ownedPhotoEntries.serverInstanceId, target.serverInstanceId),
          eq(ownedPhotoEntries.ownerUserId, target.ownerUserId),
          eq(ownedPhotoEntries.subjectKind, "agent"),
          eq(ownedPhotoEntries.agentId, target.agentId),
          isNull(ownedPhotoEntries.deletedAt),
        )),
        tx.select({ count: sql<number>`coalesce(sum(${photoLibraryOperations.reservedSlots}), 0)::int` })
          .from(photoLibraryOperations)
          .where(and(
            eq(photoLibraryOperations.serverInstanceId, target.serverInstanceId),
            eq(photoLibraryOperations.ownerUserId, target.ownerUserId),
            eq(photoLibraryOperations.agentId, target.agentId),
            eq(photoLibraryOperations.operationKind, "create"),
            eq(photoLibraryOperations.state, "pending"),
            gt(photoLibraryOperations.reservationExpiresAt, capacityNow),
          )),
      ]);
      const occupiedSlots = Number(activeRows[0]?.count ?? 0) + Number(reservationRows[0]?.count ?? 0);
      if (occupiedSlots + 1 > ACTIVE_ENTRY_LIMIT) {
        throw new RecoveryRefusal("library_capacity_reached", "The active Agent photo library is full");
      }
      const created = await createOwnedPhotoEntryIdempotently(tx, {
        serverInstanceId: target.serverInstanceId,
        ownerUserId: target.ownerUserId,
        subjectKind: "agent",
        agentId: target.agentId,
        avatarKind: target.kind,
        blobId: target.blobId,
        source: "operator_adoption",
        origin: "operator_adoption",
        operationId: claims.operationId,
        requestFingerprint: claims.requestFingerprint,
        mediaMimeType: claims.mediaMimeType,
        mediaByteSize: claims.mediaByteSize,
        mediaSha256: claims.mediaSha256,
      });
      if (created.kind === "collision") {
        throw new RecoveryRefusal("existing_ownership_conflict", "The blob became owned by another operation or subject");
      }
      if (created.kind === "created") {
        await tx.update(profiles).set({
          avatarLibraryRevision: lockedProfile.avatarLibraryRevision + 1,
          updatedAt: new Date(),
        }).where(eq(profiles.id, lockedProfile.id));
      }
      return { entry: created.entry, replayed: created.kind === "replayed" };
    });
    const output = {
      ...baseResult(target, "apply", result.replayed ? "already_adopted" : "adopted", operationId),
      mediaByteSize: claims.mediaByteSize,
      mediaSha256: claims.mediaSha256,
      mediaMimeType: claims.mediaMimeType,
      entryId: result.entry.id,
    };
    await emitAudit(dependencies, output, auditActor);
    return output;
  } catch (error) {
    if (!(error instanceof RecoveryRefusal)) throw error;
    const result = { ...baseResult(target, "apply", "refused", operationId), reason: error.reason };
    await emitAudit(dependencies, result, auditActor);
    return result;
  } finally {
    if (maintenanceHeld) await clearMaintenanceWith(dependencies.db, operationId);
  }
}
