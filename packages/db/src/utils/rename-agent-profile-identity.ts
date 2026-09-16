import { and, eq, isNull, ne } from "drizzle-orm";
import {
  HANDLE_MAX_LEN,
  HANDLE_MIN_LEN,
  HANDLE_RE,
  slugifyToHandleBase,
} from "@nautilo/types";
import { getSharedDirectDb } from "../config/direct-database";
import { agents } from "../schema/agents";
import { profiles } from "../schema/profiles";
import { actors } from "../schema/trust";
import { users } from "../schema/users";

/**
 * M156 — single transaction that keeps the local Agent's identity
 * projections consistent on a rename. The Agent's name is single-sourced
 * on `profiles.name` (1:1 with the Agent via `profiles.agent_id`, M132);
 * the agent-kind `actors.display_name` row is a synced cache; and the
 * `agents.handle` auto-derives from the name until the user customizes it.
 *
 * All three writes (`profiles.name`, `actors.display_name`, and the
 * auto-derived `agents.handle`) commit together or fail together — there
 * is NO best-effort sync. If the actor cache row is missing, or no handle
 * candidate can be allocated, the whole rename rolls back.
 *
 * Non-identity Profile fields (soul / avatar / voice / model) are NOT
 * handled here — the caller applies those through the normal
 * `upsertProfile` writer; only `name` is identity-critical.
 *
 * Lives in `@nautilo/db` (the privileged layer) rather than the agent
 * package because the actor / agent / users writes need a full-privilege
 * connection, which `packages/agent` is forbidden from opening
 * (`d168-no-direct-db-in-agent`).
 */
export async function renameAgentProfileIdentity(args: {
  ownerUserId: string;
  agentId: string;
  name: string;
}): Promise<{ name: string; handle: string }> {
  const trimmedName = args.name.trim();
  if (!trimmedName) {
    throw new Error("renameAgentProfileIdentity: name cannot be empty");
  }

  const db = getSharedDirectDb();
  return await db.transaction(async (tx) => {
      const now = new Date();

      // 1. Canonical name on the Profile (insert-or-update by agent_id).
      await tx
        .insert(profiles)
        .values({ userId: args.ownerUserId, agentId: args.agentId, name: trimmedName, updatedAt: now })
        .onConflictDoUpdate({
          target: profiles.agentId,
          set: { name: trimmedName, updatedAt: now },
        });

      // 2. Synced participant-cache on the agent-kind actor row. Require
      //    exactly one local agent-kind actor; never blanket-update.
      const touchedActors = await tx
        .update(actors)
        .set({ displayName: trimmedName, updatedAt: now })
        .where(and(eq(actors.agentId, args.agentId), eq(actors.kind, "agent")))
        .returning({ id: actors.id });
      if (touchedActors.length !== 1) {
        throw new Error(
          `renameAgentProfileIdentity: expected exactly 1 agent-kind actor for agent ${args.agentId}, found ${touchedActors.length}`,
        );
      }

      // 3. Handle: frozen once the user customized it; otherwise re-derive.
      const [agentRow] = await tx
        .select({ handle: agents.handle, handleCustomized: agents.handleCustomized })
        .from(agents)
        .where(eq(agents.id, args.agentId))
        .limit(1);
      if (!agentRow) {
        throw new Error(`renameAgentProfileIdentity: agent ${args.agentId} not found`);
      }
      if (agentRow.handleCustomized) {
        return { name: trimmedName, handle: agentRow.handle };
      }

      const [ownerRow] = await tx
        .select({ handle: users.handle })
        .from(users)
        .where(and(eq(users.id, args.ownerUserId), isNull(users.server)))
        .limit(1);
      const ownerHandle = ownerRow?.handle?.trim() || "owner";

      const candidates = buildHandleCandidates(trimmedName, ownerHandle);
      for (const candidate of candidates) {
        if (candidate === agentRow.handle) {
          // Already on a valid derived handle — keep it, no churn.
          return { name: trimmedName, handle: candidate };
        }
        const [agentClash] = await tx
          .select({ id: agents.id })
          .from(agents)
          .where(and(eq(agents.handle, candidate), ne(agents.id, args.agentId)))
          .limit(1);
        if (agentClash) continue;
        const [humanClash] = await tx
          .select({ id: users.id })
          .from(users)
          .where(and(eq(users.handle, candidate), isNull(users.server)))
          .limit(1);
        if (humanClash) continue;

        await tx
          .update(agents)
          .set({ handle: candidate, updatedAt: now })
          .where(eq(agents.id, args.agentId));
        return { name: trimmedName, handle: candidate };
      }

      throw new Error(
        `renameAgentProfileIdentity: could not allocate a handle for "${trimmedName}" (owner @${ownerHandle})`,
      );
    });
}

/**
 * M156 — set the Agent handle by hand and freeze auto-derivation
 * (`handle_customized = true`). Uniqueness spans both other Agent handles
 * and local Human handles (`users.handle WHERE server IS NULL`) because
 * `findActorByHandle` / WebFinger resolve both through the shared
 * `@handle@server` namespace. Caller MUST pre-validate format
 * (`HANDLE_RE` + `normalizeHandle`).
 */
export async function setAgentHandle(
  agentId: string,
  handle: string,
): Promise<{ ok: true } | { ok: false; code: "handle_taken" }> {
  const db = getSharedDirectDb();
  const [agentClash] = await db
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.handle, handle), ne(agents.id, agentId)))
    .limit(1);
  if (agentClash) return { ok: false, code: "handle_taken" };

  const [humanClash] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.handle, handle), isNull(users.server)))
    .limit(1);
  if (humanClash) return { ok: false, code: "handle_taken" };

  try {
    await db
      .update(agents)
      .set({ handle, handleCustomized: true, updatedAt: new Date() })
      .where(eq(agents.id, agentId));
  } catch {
    // UNIQUE(handle) lost a race between the probe and the write.
    return { ok: false, code: "handle_taken" };
  }
  return { ok: true };
}

/**
 * Ordered handle candidates for a freshly renamed Agent:
 *   1. the slug of the name
 *   2. `slug_<owner handle>`
 *   3. `slug_<random digits>` (a few attempts)
 * The base is truncated BEFORE appending a suffix so the suffix survives
 * the `HANDLE_MAX_LEN` cap; each candidate is re-checked against
 * `HANDLE_RE` and skipped if it can't be made valid.
 */
export function buildHandleCandidates(name: string, ownerHandle: string): string[] {
  let base = slugifyToHandleBase(name);
  if (base.length < HANDLE_MIN_LEN) base = "genie";

  const out: string[] = [];
  const push = (raw: string) => {
    const candidate = raw.replace(/_+$/, "").slice(0, HANDLE_MAX_LEN).replace(/_+$/, "");
    if (HANDLE_RE.test(candidate) && !out.includes(candidate)) out.push(candidate);
  };

  push(base.slice(0, HANDLE_MAX_LEN));
  push(withSuffix(base, ownerHandle));
  for (let i = 0; i < 8; i++) {
    push(withSuffix(base, String(Math.floor(1000 + Math.random() * 9000))));
  }
  return out;
}

function withSuffix(base: string, suffix: string): string {
  const room = Math.max(1, HANDLE_MAX_LEN - suffix.length - 1);
  return `${base.slice(0, room)}_${suffix}`;
}
