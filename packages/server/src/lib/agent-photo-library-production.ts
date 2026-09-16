import {
  and,
  eq,
  isNotNull,
  lt,
  photoLibraryOperations,
  profiles,
  sql,
  type DirectDatabase,
} from "@nautilo/db";
import { error as logError } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import { AGENT_AVATAR_PRESET_IDS } from "@nautilo/types";
import { AgentPhotoLibraryCreateCoordinator } from "./agent-photo-library-create-coordinator";
import {
  AgentPhotoLibraryService,
  type AgentPhotoCreateResult,
  type AgentPhotoMutationResult,
} from "./agent-photo-library-service";
import { hasCompleteOwnedAvatarMedia } from "../photo-library/strict-avatar-media";

/** One canonical Human-scoped invalidation for every committed photo mutation. */
async function publishPhotoLibraryProfileUpdate(
  db: DirectDatabase,
  result: AgentPhotoMutationResult | AgentPhotoCreateResult,
): Promise<void> {
  const [profile] = await db.select({
    id: profiles.id,
    name: profiles.name,
    onboardingCompleted: profiles.onboardingCompleted,
  }).from(profiles).where(and(
    eq(profiles.userId, result.scope.viewerUserId),
    eq(profiles.agentId, result.scope.agentId),
  )).limit(1);
  if (!profile) return;
  eventBus.emit({
    type: "profile.updated",
    profileId: profile.id,
    name: profile.name,
    onboardingCompleted: profile.onboardingCompleted,
    userId: result.scope.viewerUserId,
  });
}

/**
 * Production creation/selection construction. Mutation routes and tools must
 * use this factory instead of independently deciding blob validation or event
 * publication; retries never re-emit because the service publishes only for
 * a newly committed receipt.
 */
export function createProductionAgentPhotoLibraryService(db: DirectDatabase): AgentPhotoLibraryService {
  const publish = (result: AgentPhotoMutationResult | AgentPhotoCreateResult) =>
    publishPhotoLibraryProfileUpdate(db, result);
  return new AgentPhotoLibraryService({
    db,
    blobExists: hasCompleteOwnedAvatarMedia,
    presetExists: (presetId) => AGENT_AVATAR_PRESET_IDS.includes(presetId as never),
    afterCommit: publish,
    afterCreateCommit: publish,
  });
}

/**
 * Reclaims a bounded page on boot and on a low-frequency timer. It obtains
 * each authority tuple from the durable reservation itself, then delegates to
 * the profile-locked service/coordinator; it does not generate, retry, or
 * inspect arbitrary filesystem paths.
 */
export function startAgentPhotoLibraryReservationRecovery(input: {
  readonly db: DirectDatabase;
  readonly intervalMs?: number;
  readonly pageSize?: number;
}): () => void {
  const intervalMs = input.intervalMs ?? 60_000;
  const pageSize = input.pageSize ?? 32;
  const run = async (): Promise<void> => {
    try {
      const expired = await input.db.select({
        serverInstanceId: photoLibraryOperations.serverInstanceId,
        viewerUserId: photoLibraryOperations.viewerUserId,
        ownerUserId: photoLibraryOperations.ownerUserId,
        agentId: photoLibraryOperations.agentId,
      }).from(photoLibraryOperations).where(and(
        eq(photoLibraryOperations.operationKind, "create"),
        isNotNull(photoLibraryOperations.viewerUserId),
        lt(photoLibraryOperations.reservationExpiresAt, new Date()),
        sql`(${photoLibraryOperations.state} = 'pending' OR (${photoLibraryOperations.state} = 'failed' AND ${photoLibraryOperations.artifactCleanupCompletedAt} IS NULL))`,
      )).limit(pageSize);
      const seen = new Set<string>();
      const coordinator = new AgentPhotoLibraryCreateCoordinator(
        createProductionAgentPhotoLibraryService(input.db),
      );
      for (const authority of expired) {
        // Account-deletion retention may anonymize an old receipt. It cannot
        // regain a viewer authority merely because a maintenance timer saw it.
        const viewerUserId = authority.viewerUserId;
        if (typeof viewerUserId !== "string") continue;
        const liveAuthority = { ...authority, viewerUserId };
        const key = `${liveAuthority.serverInstanceId}:${liveAuthority.viewerUserId}:${liveAuthority.ownerUserId}:${liveAuthority.agentId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        await coordinator.reapExpiredReservations(liveAuthority);
      }
    } catch (error) {
      logError("[agent-photo-library] expired reservation recovery failed", error);
    }
  };
  void run();
  const timer = setInterval(() => { void run(); }, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
