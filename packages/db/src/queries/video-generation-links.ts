import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { videoGenerationLinks, type NewVideoGenerationLink, type VideoGenerationLink } from "../schema/video-generation-links";

export interface VideoGenerationLinkScope {
  readonly ownerId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly projectArtifactInternalId: string;
}

function where(scope: VideoGenerationLinkScope) {
  return and(
    eq(videoGenerationLinks.ownerId, scope.ownerId),
    eq(videoGenerationLinks.roomId, scope.roomId),
    eq(videoGenerationLinks.namespaceId, scope.namespaceId),
    eq(videoGenerationLinks.projectArtifactInternalId, scope.projectArtifactInternalId),
  );
}

export async function findVideoGenerationLinkByRequest(
  db: DirectDatabase,
  scope: VideoGenerationLinkScope,
  requestId: string,
): Promise<VideoGenerationLink | null> {
  const [row] = await db.select().from(videoGenerationLinks).where(and(where(scope), eq(videoGenerationLinks.requestId, requestId))).limit(1);
  return row ?? null;
}

export async function findVideoGenerationLinkByTake(
  db: DirectDatabase,
  scope: VideoGenerationLinkScope,
  takeId: string,
): Promise<VideoGenerationLink | null> {
  const [row] = await db.select().from(videoGenerationLinks).where(and(where(scope), eq(videoGenerationLinks.takeId, takeId))).limit(1);
  return row ?? null;
}

export async function listVideoGenerationLinks(
  db: DirectDatabase,
  scope: VideoGenerationLinkScope,
): Promise<VideoGenerationLink[]> {
  return db.select().from(videoGenerationLinks)
    .where(and(where(scope), isNotNull(videoGenerationLinks.admittedAt)))
    .orderBy(desc(videoGenerationLinks.admittedAt));
}

/** Idempotently reveals a take only after D525 durably acknowledged admission. */
export async function markVideoGenerationLinkAdmitted(
  db: DirectDatabase,
  scope: VideoGenerationLinkScope,
  takeId: string,
  now = new Date(),
): Promise<boolean> {
  const [updated] = await db.update(videoGenerationLinks)
    .set({ admittedAt: now })
    .where(and(where(scope), eq(videoGenerationLinks.takeId, takeId), isNull(videoGenerationLinks.admittedAt)))
    .returning({ takeId: videoGenerationLinks.takeId });
  if (updated) return true;
  const [existing] = await db.select({ admittedAt: videoGenerationLinks.admittedAt })
    .from(videoGenerationLinks)
    .where(and(where(scope), eq(videoGenerationLinks.takeId, takeId)))
    .limit(1);
  return existing?.admittedAt !== null && existing?.admittedAt !== undefined;
}

export async function createVideoGenerationLink(
  db: DirectDatabase,
  input: NewVideoGenerationLink,
): Promise<VideoGenerationLink> {
  const [row] = await db.insert(videoGenerationLinks).values(input).returning();
  if (!row) throw new Error("video generation link was not created");
  return row;
}
