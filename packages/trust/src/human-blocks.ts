import {
  and,
  eq,
  humanBlocks,
  or,
  type DirectDatabase,
} from "@nautilo/db";

export type HumanBlockStatus = Readonly<{
  blockedByViewer: boolean;
  viewerBlockedByPeer: boolean;
}>;

function assertDistinctHumans(blockerUserId: string, blockedUserId: string): void {
  if (blockerUserId === blockedUserId) {
    throw new TypeError("A Human cannot block themselves");
  }
}

/** Idempotently create the caller-owned directional relation. */
export async function blockHuman(
  db: DirectDatabase,
  blockerUserId: string,
  blockedUserId: string,
): Promise<void> {
  assertDistinctHumans(blockerUserId, blockedUserId);
  await db
    .insert(humanBlocks)
    .values({ blockerUserId, blockedUserId })
    .onConflictDoNothing();
}

/** Idempotently remove only the caller-owned directional relation. */
export async function unblockHuman(
  db: DirectDatabase,
  blockerUserId: string,
  blockedUserId: string,
): Promise<void> {
  assertDistinctHumans(blockerUserId, blockedUserId);
  await db
    .delete(humanBlocks)
    .where(
      and(
        eq(humanBlocks.blockerUserId, blockerUserId),
        eq(humanBlocks.blockedUserId, blockedUserId),
      ),
    );
}

export async function listBlockedHumanUserIds(
  db: DirectDatabase,
  blockerUserId: string,
): Promise<string[]> {
  const rows = await db
    .select({ blockedUserId: humanBlocks.blockedUserId })
    .from(humanBlocks)
    .where(eq(humanBlocks.blockerUserId, blockerUserId));
  return rows.map((row) => row.blockedUserId);
}

/** Read both directions without leaking which direction to message admission. */
export async function getHumanBlockStatus(
  db: DirectDatabase,
  viewerUserId: string,
  peerUserId: string,
): Promise<HumanBlockStatus> {
  if (viewerUserId === peerUserId) {
    return { blockedByViewer: false, viewerBlockedByPeer: false };
  }
  const rows = await db
    .select({
      blockerUserId: humanBlocks.blockerUserId,
      blockedUserId: humanBlocks.blockedUserId,
    })
    .from(humanBlocks)
    .where(
      or(
        and(
          eq(humanBlocks.blockerUserId, viewerUserId),
          eq(humanBlocks.blockedUserId, peerUserId),
        ),
        and(
          eq(humanBlocks.blockerUserId, peerUserId),
          eq(humanBlocks.blockedUserId, viewerUserId),
        ),
      ),
    );
  return {
    blockedByViewer: rows.some(
      (row) => row.blockerUserId === viewerUserId && row.blockedUserId === peerUserId,
    ),
    viewerBlockedByPeer: rows.some(
      (row) => row.blockerUserId === peerUserId && row.blockedUserId === viewerUserId,
    ),
  };
}

export async function humanPairIsBlocked(
  db: DirectDatabase,
  firstUserId: string,
  secondUserId: string,
): Promise<boolean> {
  const status = await getHumanBlockStatus(db, firstUserId, secondUserId);
  return status.blockedByViewer || status.viewerBlockedByPeer;
}

/**
 * Exact canonical Human-DM shape: two distinct Human users and no Agent.
 * Room kind is intentionally irrelevant because historical direct rooms do
 * not have a dedicated kind.
 */
export function directHumanPeerUserId(
  members: readonly Readonly<{ kind: "user" | "agent"; userId?: string }>[],
  viewerUserId: string,
): string | null {
  if (members.length !== 2 || members.some((member) => member.kind !== "user")) {
    return null;
  }
  const userIds = members.flatMap((member) =>
    member.kind === "user" && typeof member.userId === "string" && member.userId.length > 0
      ? [member.userId]
      : [],
  );
  if (userIds.length !== 2 || new Set(userIds).size !== 2 || !userIds.includes(viewerUserId)) {
    return null;
  }
  return userIds.find((userId) => userId !== viewerUserId) ?? null;
}
