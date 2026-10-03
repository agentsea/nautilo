import { and, eq, isNull, or, photoLibraryOperations, sql, type DirectDatabase } from "@nautilo/db";

/** Run under exclusive maintenance admission before replacing the previous server. */
export async function assertOwnedAvatarProtocolUpgradeReady(db: DirectDatabase): Promise<void> {
  const [row] = await db.select({ count: sql<number>`count(*)::int` })
    .from(photoLibraryOperations)
    .where(and(
      eq(photoLibraryOperations.operationKind, "create"),
      sql`substring(${photoLibraryOperations.reservationLeaseToken}::text from 15 for 1) <> '8'`,
      or(
        eq(photoLibraryOperations.state, "pending"),
        and(
          eq(photoLibraryOperations.state, "failed"),
          isNull(photoLibraryOperations.artifactCleanupCompletedAt),
          sql`${photoLibraryOperations.result}->'error'->>'code' IN ('operation_incomplete', 'photo_library_unavailable')`,
        ),
      ),
    ));
  if (!row || row.count !== 0) {
    throw new Error("Photo protocol upgrade requires the previous server to finish reservations and reconcile failed creation artifacts first");
  }
}
