import { eq, getSharedDirectDb, serverModerationPolicy, sql, type InviteSeedTx } from "@nautilo/db";
import type { ServerModerationPolicy } from "@nautilo/types";
import { ModerationError } from "./moderation-policy";
import { loadModerationAuthority } from "./moderation-store";
import { isAuthorityTransactionConflict, lockFingerprintState } from "./rbac-mutation-locks";

export async function readServerModerationPolicy(): Promise<ServerModerationPolicy> {
  const [row] = await getSharedDirectDb().select().from(serverModerationPolicy).where(eq(serverModerationPolicy.singleton, true));
  if (!row) throw new Error("Server moderation policy unavailable");
  return { enabled: row.enabled, joinsPaused: row.joinsPaused, approvalRequired: row.approvalRequired, revision: row.revision };
}

/** Hold policy through final enrollment publication. Pausing neither expels
 * existing members nor grants new rights to an already-bound signup.
 */
export async function assertServerEnrollmentOpenInTx(tx: InviteSeedTx): Promise<ServerModerationPolicy> {
  const [policy] = await tx.select().from(serverModerationPolicy).where(eq(serverModerationPolicy.singleton, true)).for("share");
  if (!policy) throw new Error("Server enrollment policy unavailable");
  if (policy.joinsPaused) throw new ModerationError("enrollment_paused");
  return policy;
}

export async function updateServerModerationPolicy(callerUserId: string, input: ServerModerationPolicy): Promise<ServerModerationPolicy> {
  if (typeof input.enabled !== "boolean" || typeof input.joinsPaused !== "boolean" || typeof input.approvalRequired !== "boolean" || !Number.isSafeInteger(input.revision) || input.revision < 1) {
    throw new ModerationError("invalid_request");
  }
  const db = getSharedDirectDb();
  try {
    return await db.transaction(async tx => {
      await tx.execute(sql`SET TRANSACTION ISOLATION LEVEL SERIALIZABLE`);
      await lockFingerprintState(tx);
      await requireEnrollmentManager(tx, callerUserId);
      const [current] = await tx.select().from(serverModerationPolicy).where(eq(serverModerationPolicy.singleton, true)).for("update");
      if (!current) throw new Error("Server moderation policy unavailable");
      if (current.revision !== input.revision) throw new ModerationError("stale_revision");
      // Disabling the controls cannot silently reopen admission during an incident.
      if (current.joinsPaused && !input.enabled && !input.joinsPaused) throw new ModerationError("invalid_request");
      if (current.approvalRequired && !input.enabled && !input.approvalRequired) throw new ModerationError("invalid_request");
      const [updated] = await tx.update(serverModerationPolicy).set({ enabled: input.enabled, joinsPaused: input.joinsPaused,
        approvalRequired: input.approvalRequired,
        revision: current.revision + 1, updatedAt: new Date(), updatedBy: callerUserId,
      }).where(eq(serverModerationPolicy.singleton, true)).returning();
      return { enabled: updated!.enabled, joinsPaused: updated!.joinsPaused, approvalRequired: updated!.approvalRequired, revision: updated!.revision };
    });
  } catch (error) {
    if (isAuthorityTransactionConflict(error)) throw new ModerationError("stale_revision");
    throw error;
  }
}

export async function requireEnrollmentManager(db: Pick<InviteSeedTx, "select" | "execute">, callerUserId: string): Promise<void> {
  const authority = await loadModerationAuthority(db, callerUserId);
  if (authority.disabled || !authority.grants.some(grant => grant.capabilities.includes("manage_server_enrollment"))) {
    throw new ModerationError("forbidden_scope");
  }
  const [allowed] = await db.execute<{ allowed: boolean }>(sql`SELECT public.moderation_access_allowed(${callerUserId}::uuid, NULL::uuid) AS allowed`);
  if (!allowed?.allowed) throw new ModerationError("forbidden_scope");
}
