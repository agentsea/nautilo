/**
 * D168 P2 (Stack 11.5) — Path C RLS trust-context wrapper.
 *
 * Every database read/write against an RLS-protected table MUST go
 * through this wrapper. It opens a Postgres transaction, sets the
 * `app.current_user_id` and (optionally) `app.current_agent_id`
 * GUCs via `SET LOCAL`, and runs the caller's callback inside the
 * same transaction so the GUCs are visible to the policy walker.
 *
 * RLS-protected tables (D168 P2 v1 scope): memories, artifacts,
 * memory_namespaces, memory_scopes, artifact_namespaces,
 * artifact_scopes, room_members, agent_scopes, credentials,
 * recovery_codes, sessions.
 *
 * The Path C policy form is the **simpler-than-canonical** direct
 * Room-membership join. The SQL policies are defined in
 * `../migrations/0050_d168_p2_rls_path_c.sql` and later migrations.
 *
 * Two GUCs (not three) by design:
 *   - `app.current_user_id` (required) — the speaker / caller
 *   - `app.current_agent_id` (optional) — required only for
 *     namespace-scoped reads in multi-Agent Rooms; auth-route code
 *     paths may omit it
 *
 * The `app.current_room_id` GUC that would be needed for the
 * canonical subset rule is intentionally NOT plumbed; Path C trades
 * the "narrows as widens" UX property for engineering simplicity.
 *
 * IMPORTANT — transaction semantics. The runtime agent DB
 * (`createAgentDatabase()` / `agentDb` / `getSharedDirectAgentDb()`)
 * uses postgres-js. `SET LOCAL` only survives inside a single
 * transaction; outside a transaction it's a no-op. This wrapper opens
 * a transaction via the Drizzle handle so the subsequent reads see
 * the GUCs. Production agent trust paths pass the shared runtime
 * postgres-js handle as the third argument — see `session-store.ts`,
 * `memory-store.ts`, `trust-agent-db.ts`.
 *
 * `createDirectAgentDb()` remains for migrations / integration tests
 * that need a disposable direct factory with a separate connection string.
 *
 * Caller responsibility: pass the correct `userId` for the SPEAKER
 * (resolved from the request envelope's `actorId` → `actors.owner_id`).
 * Passing a wrong user_id IS a security boundary violation; this
 * wrapper trusts its caller to have authenticated the user beforehand.
 */

import { sql } from "drizzle-orm";
import { agentDb } from "../config/agent-database";

/**
 * D168 P3 — minimal transactional shape `withTrustContext` requires.
 *
 * Runtime postgres-js Drizzle handles (`agentDb`, `getSharedDirectAgentDb()`)
 * and the superuser `createDirectDb()` factory all expose
 * `.transaction(callback)` whose callback receives a transaction handle
 * with `.execute()`. We don't constrain the transaction's HKT here
 * because different Drizzle drivers declare incompatible HKT generics
 * even though the runtime `.execute()` / `.select()` / `.insert()` /
 * `.update()` / etc. APIs are identical. Callers narrow at the call site.
 *
 * Widened from the original `AgentDatabase` constraint to support
 * D168 P3's credentials chokepoint, which uses the superuser
 * `createDirectDb()` path (the `nautilo_agent` role has no GRANT on
 * `credentials` per D129 P3 part 1, so the chokepoint MUST use the
 * superuser; `ALTER TABLE credentials FORCE ROW LEVEL SECURITY` in
 * migration #48 is what makes the GUC-driven Path C policy
 * meaningful for that role).
 */
type TxHandle = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

export type TransactableDatabase = {
  transaction: <T>(callback: (tx: TxHandle) => Promise<T>) => Promise<T>;
};

export interface TrustContext {
  /**
   * The authenticated caller's `users.id` (resolved from the speaker's
   * Actor row's `owner_id`). Required for every RLS-protected read.
   */
  userId: string;

  /**
   * The agent the caller is interacting with (`agents.id`). Required
   * for memory/artifact/connection reads in multi-Agent Rooms so the
   * `agentId` content-scope clause fires correctly. Auth-route code
   * paths may omit it.
   */
  agentId?: string;
}

/**
 * Run `fn` inside a transaction with the trust-context GUCs set.
 * Reads inside `fn` against RLS-protected tables will be filtered by
 * the Path C policies using the supplied GUCs.
 *
 * Example:
 *
 *   const memories = await withTrustContext(
 *     { userId: speakerId, agentId },
 *     async (tx) => tx.select().from(memoriesTable)
 *   );
 *
 * If the wrapper's database handle is not provided, it uses the
 * default `agentDb` singleton (postgres-js runtime pool, restricted role).
 */
// Generic over the DB handle so caller-side narrowing preserves the
// full Drizzle transaction type at the call site. Callers that want
// full typed Drizzle ops on the transaction handle should call with
// the concrete db handle directly; the inferred TX type will match
// their underlying driver.
export async function withTrustContext<TDb extends TransactableDatabase, T>(
  ctx: TrustContext,
  fn: (tx: Parameters<Parameters<TDb["transaction"]>[0]>[0]) => Promise<T>,
  db?: TDb,
): Promise<T> {
  const handle = (db ?? (agentDb as unknown as TDb));
  if (!ctx.userId || ctx.userId.length === 0) {
    throw new Error(
      "withTrustContext: ctx.userId is required (non-empty string). " +
        "Pass the authenticated speaker's users.id. RLS-protected reads " +
        "WILL return zero rows if the GUC isn't set; this guard catches " +
        "the call-site bug eagerly instead.",
    );
  }

  return await handle.transaction(async (tx) => {
    // `SET LOCAL` requires literal-quoted values; raw sql.raw is used
    // because Drizzle's parameter binding would emit `$1`-style
    // placeholders which Postgres rejects in `SET LOCAL` contexts.
    // The values are validated/escaped via `escapeGucValue` below to
    // prevent injection at the SQL-string level.
    await tx.execute(
      sql.raw(`SET LOCAL app.current_user_id = ${escapeGucValue(ctx.userId)}`),
    );
    if (ctx.agentId) {
      await tx.execute(
        sql.raw(
          `SET LOCAL app.current_agent_id = ${escapeGucValue(ctx.agentId)}`,
        ),
      );
    }
    return await fn(tx as Parameters<Parameters<TDb["transaction"]>[0]>[0]);
  });
}

/**
 * D168 P3 — establish trust-context GUCs on an EXISTING transaction.
 *
 * Use this when the caller already owns a multi-statement transaction
 * (e.g. `packages/server/src/lib/redeem-invite.ts`'s atomic
 * user+actor+credential seed) and can't nest a `withTrustContext`
 * wrapper. The GUCs are scoped to the calling transaction via
 * `SET LOCAL`; they're automatically cleared at commit/rollback.
 *
 * Prefer `withTrustContext` whenever the caller is opening its own
 * transaction — that path is harder to misuse (fail-closed on missing
 * userId, automatic transaction boundary). This helper exists for the
 * narrow case where transaction nesting is genuinely required.
 */
export async function setTrustContextOnTx(
  tx: TxHandle,
  ctx: TrustContext,
): Promise<void> {
  if (!ctx.userId || ctx.userId.length === 0) {
    throw new Error(
      "setTrustContextOnTx: ctx.userId is required (non-empty string). " +
        "Pass the authenticated speaker's users.id.",
    );
  }
  await tx.execute(
    sql.raw(`SET LOCAL app.current_user_id = ${escapeGucValue(ctx.userId)}`),
  );
  if (ctx.agentId) {
    await tx.execute(
      sql.raw(`SET LOCAL app.current_agent_id = ${escapeGucValue(ctx.agentId)}`),
    );
  }
}

/**
 * Validate + literal-quote a UUID string for use in `SET LOCAL`.
 * Refuses anything that isn't a plain UUID — this is the SQL-injection
 * guard at the trust-context boundary.
 */
function escapeGucValue(value: string): string {
  if (!/^[0-9a-fA-F-]+$/.test(value)) {
    throw new Error(
      `withTrustContext: trust-context value contains characters unsafe ` +
        `for SET LOCAL string assembly. Got ${JSON.stringify(value)}; ` +
        `expected a UUID-shaped string (hex + dash only).`,
    );
  }
  return `'${value}'`;
}
