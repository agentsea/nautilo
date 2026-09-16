/**
 * Dev-only: purge test-fixture users and orphan agents from a local DB while
 * preserving an explicit allow-list of real users (handles or UUIDs).
 * Default dry-run; `--apply` runs a single transaction.
 */
import {
  agents,
  actors,
  and,
  approvalChallenges,
  channelIdentities,
  count,
  eq,
  inArray,
  isNotNull,
  or,
  sql,
  createDirectDb,
  credentials,
  groups,
  jobs,
  memoryNamespaces,
  profiles,
  recoveryCodes,
  roomMembers,
  rooms,
  sessionMessages,
  sessions,
  standingApprovals,
  users,
} from "@nautilo/db";
import {
  chmodSync,
  existsSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";
import {
  classifyUserIdentity,
  computePlanFingerprint,
  findOldestUserId,
  isExplicitOverrideEligible,
  isProtectedRefusalClass,
  isSha256Hex,
  validateCleanupPlanManifest,
  type CanonicalPlanFingerprintInput,
  type CleanupUserRecord,
  type UserIdentityClass,
} from "./cleanup-test-cruft-classification";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface CleanupTestCruftArgs {
  keepUserHandles?: string | undefined;
  keepUserIds?: string | undefined;
  apply?: boolean | undefined;
  maxDeletions?: string | undefined;
  allowHighFootprint?: boolean | undefined;
  /**
   * DEPRECATED: retained only as a compatibility no-op. It emits a
   * deprecation warning and NEVER authorizes deletion. The only
   * identity-refusal override is `--allow-fixture-user-ids`.
   */
  allowHalfRedeemedFixtures?: boolean | undefined;
  /**
   * D266 Wave 2: explicit, operator-confirmed UUID(s) of credentialless
   * or half-redeemed fixture users to permit past the identity refusal.
   * Must be valid UUIDs and must exist. NEVER authorizes a bootstrap-seed
   * user. Bypasses neither the default guard, deletion cap, high-footprint
   * checks, transaction, nor keep-list. Allowed for read-only / dry plan
   * review; on `--apply` it CANNOT authorize protected-identity deletion
   * — that requires the `--fixture-plan` + `--approve-plan` manifest gate.
   */
  allowFixtureUserIds?: string | undefined;
  /** D266 Wave 2: emit a complete read-only structured JSON plan and exit. */
  planJson?: boolean | undefined;
  /**
   * Stack 198 / D266 follow-up: when supplied alongside `--plan-json`,
   * atomically write the serialized plan to this path (mode 0600 where the
   * platform supports it) in addition to stdout. Refuses if the destination
   * already exists (never overwrites a reviewed manifest) or if the parent
   * directory does not exist. Only valid with `--plan-json`; ignored for
   * every other mode. Never authorizes deletion — `--plan-json` remains
   * read-only to the DB and `--apply` cannot cause deletion.
   */
  planOut?: string | undefined;
  /**
   * D266 Wave 3: path to a saved `--plan-json` fixture manifest. Required
   * with `--approve-plan` to authorize deletion of protected credentialless
   * / half-redeemed candidates on `--apply`.
   */
  fixturePlan?: string | undefined;
  /**
   * D266 Wave 3: operator-supplied SHA-256 that must equal BOTH the
   * manifest's `planFingerprint` and the freshly computed current plan
   * fingerprint. Rejects stale / tampered / mismatched manifests before
   * any DB mutation.
   */
  approvePlan?: string | undefined;
  configEnvPath?: string | undefined;
  /** D202: explicit opt-in to apply cleanup against the protected (default) instance. */
  iKnowWhatIAmDoing?: boolean | undefined;
  /** Test seam: override cwd for guard resolution. */
  cwd?: string | undefined;
  /** Test seam: env snapshot for guard resolution. */
  env?: NodeJS.ProcessEnv | undefined;
}

function parseCommaList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

function bucketUserHandle(handle: string | null): string {
  if (!handle) return "<null-handle>";
  const h = handle.toLowerCase();
  if (h.startsWith("authrx")) return "authrx*";
  if (h.startsWith("chatmu")) return "chatmu*";
  if (h.startsWith("claimer")) return "claimer*";
  if (h.startsWith("d104acct")) return "d104acct*";
  if (h.startsWith("dummy")) return "dummy*";
  if (h.startsWith("first")) return "first*";
  if (h.startsWith("lr_")) return "lr_*";
  if (h.startsWith("smpeer")) return "smpeer*";
  if (h.startsWith("smug")) return "smug*";
  if (h.startsWith("srvusr")) return "srvusr*";
  if (/^t2?mpc[0-9a-z]+$/.test(h)) return "tmpc*/t2mpc*";
  if (h.startsWith("whoami-")) return "whoami-*";
  if (h.startsWith("ws")) return "ws*";
  if (h.startsWith("sabridge")) return "sabridge*";
  if (h.startsWith("sess-")) return "sess-*";
  if (h.startsWith("m088c")) return "m088c*";
  if (h.startsWith("mgate")) return "mgate*";
  if (h.startsWith("msgrt")) return "msgrt*";
  return "<other-test>";
}

function bucketAgentHandle(handle: string | null): string {
  if (!handle) return "<null-handle>";
  const h = handle.toLowerCase();
  if (h.startsWith("undo-turn-e2e")) return "undo-turn-e2e*";
  if (h.startsWith("backup-e2e")) return "backup-e2e*";
  if (h.startsWith("find-agent-")) return "find-agent-*";
  if (h.startsWith("jeannie-test-")) return "jeannie-test-*";
  if (h.startsWith("fk-invariant-")) return "fk-invariant-*";
  if (h.startsWith("m088c-fam-ag-")) return "m088c-fam-ag-*";
  return "<other>";
}

export function isKnownFixtureAgentHandle(handle: string | null): boolean {
  const bucket = bucketAgentHandle(handle);
  return bucket !== "<other>" && bucket !== "<null-handle>";
}

export interface OrphanAgentFootprint {
  readonly actorCount: number;
  readonly sessionCount: number;
  readonly profileCount: number;
  readonly roomMembershipCount: number;
}

export function isZeroFootprintFixtureOrphanAgent(
  handle: string | null,
  footprint: OrphanAgentFootprint,
): boolean {
  return (
    isKnownFixtureAgentHandle(handle) &&
    footprint.actorCount === 0 &&
    footprint.sessionCount === 0 &&
    footprint.profileCount === 0 &&
    footprint.roomMembershipCount === 0
  );
}

function tallyBuckets(
  handles: readonly (string | null)[],
  bucket: (h: string | null) => string,
): Map<string, number> {
  const m = new Map<string, number>();
  for (const raw of handles) {
    const key = bucket(raw);
    m.set(key, (m.get(key) ?? 0) + 1);
  }
  return m;
}

function formatBuckets(m: Map<string, number>): string[] {
  const entries = [...m.entries()].sort((a, b) => b[1] - a[1]);
  const lines: string[] = [];
  let i = 0;
  for (const [k, n] of entries) {
    lines.push(`[cleanup]     ${k}: ${n}`);
    if (++i >= 8) break;
  }
  return lines;
}

function deletedRowCount(r: unknown): number {
  const o = r as { rowCount?: number; count?: number };
  if (typeof o.rowCount === "number") return o.rowCount;
  if (typeof o.count === "number") return o.count;
  return 0;
}

/**
 * Stack 198 / D266 follow-up: atomically write the serialized plan to
 * `targetPath` with mode 0600 (where the platform honors it). Writes to a
 * uniquely-named temp file in the same directory, then renames — rename is
 * atomic on POSIX so a reviewed manifest is never partially overwritten and
 * a write failure never leaves a partial plan file behind. Exported for
 * focused no-DB unit tests of the JSON plan file semantics. Throws on any
 * failure; the caller surfaces it as a nonzero refusal.
 */
export function atomicWritePlanFile(targetPath: string, content: string): void {
  const dir = dirname(targetPath);
  const dirStat = statSync(dir);
  if (!dirStat.isDirectory()) {
    throw new Error(
      `--plan-out parent is not a directory: ${dir}`,
    );
  }
  const tmp = join(
    dir,
    `.nautilo-cleanup-plan.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    writeFileSync(tmp, content, { mode: 0o600, flag: "wx" });
    try {
      chmodSync(tmp, 0o600);
    } catch {
      // Best-effort: the open-time mode already requested 0600; a chmod
      // failure (e.g. restricted platform) is not fatal to atomicity.
    }
    renameSync(tmp, targetPath);
  } catch (e) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // Swallow cleanup errors so the original write failure surfaces.
    }
    throw e;
  }
}

/**
 * Stack 198 / D266: canonical deletion-phase ordering for the `--apply`
 * transaction. Pure (no DB) so it can be unit-tested without a live
 * Postgres — there is no transaction-injection seam on `cleanupTestCruft`
 * (it builds its own `createDirectDb` and runs an inline `db.transaction`),
 * so the live transaction execution cannot be exercised in a no-DB unit
 * test. This helper is the load-bearing source of truth for the ORDER
 * invariant that bit production: profiles whose `user_id` is in candidate
 * users MUST be deleted before the associated agents, because
 * `profiles.agent_id → agents.id` is `ON DELETE NO ACTION`
 * (migration 0067_m132) — deleting agents first aborts the whole
 * transaction with `profiles_agent_id_agents_id_fk`.
 *
 * The helper returns the ordered list of phases the transaction performs.
 * A phase is omitted when its driving id list is empty (matching the
 * `if (…length > 0)` guards in the transaction). The transaction body is
 * expected to follow this exact ordering; `assertDeletionOrderInvariant`
 * locks the contract so a future edit to the helper cannot silently break
 * the profiles-before-agents rule.
 */
export type CleanupDeletionPhase =
  | "null-session-agent"
  | "delete-session-messages"
  | "delete-sessions"
  | "null-room-refs"
  | "delete-memory-namespaces"
  | "delete-profiles"
  | "delete-agents"
  | "delete-approval-challenges"
  | "delete-standing-approvals"
  | "delete-jobs"
  | "delete-users";

export interface CleanupDeletionOrderInput {
  readonly agentIdList: readonly string[];
  readonly sessionIdList: readonly string[];
  readonly roomIdList: readonly string[];
  readonly roomNamespaceIds: readonly string[];
  readonly candidateUserIds: readonly string[];
}

export function cleanupDeletionOrder(
  input: CleanupDeletionOrderInput,
): CleanupDeletionPhase[] {
  const phases: CleanupDeletionPhase[] = [];
  if (input.agentIdList.length > 0) phases.push("null-session-agent");
  if (input.sessionIdList.length > 0) {
    phases.push("delete-session-messages");
    phases.push("delete-sessions");
  }
  if (input.roomIdList.length > 0) {
    phases.push("null-room-refs");
    if (input.roomNamespaceIds.length > 0) {
      phases.push("delete-memory-namespaces");
    }
  }
  // profiles BEFORE agents — the load-bearing fix for
  // profiles_agent_id_agents_id_fk (ON DELETE NO ACTION).
  if (input.candidateUserIds.length > 0) phases.push("delete-profiles");
  if (input.agentIdList.length > 0) phases.push("delete-agents");
  if (input.candidateUserIds.length > 0) {
    phases.push("delete-approval-challenges");
    phases.push("delete-standing-approvals");
    phases.push("delete-jobs");
    phases.push("delete-users");
  }
  return phases;
}

/**
 * Lock the ordering invariant: `delete-profiles` must precede
 * `delete-agents`, and `delete-profiles` must appear at most once (no
 * double-delete / double-counting of dependent rows). Throws if the
 * contract is violated. Called at the start of the `--apply` transaction
 * so a future edit to `cleanupDeletionOrder` cannot silently reintroduce
 * the FK ordering bug.
 */
export function assertDeletionOrderInvariant(
  input: CleanupDeletionOrderInput,
): void {
  const phases = cleanupDeletionOrder(input);
  const profilesIndices: number[] = [];
  let agentsIndex = -1;
  for (let i = 0; i < phases.length; i++) {
    if (phases[i] === "delete-profiles") profilesIndices.push(i);
    else if (phases[i] === "delete-agents") agentsIndex = i;
  }
  if (profilesIndices.length > 1) {
    throw new Error(
      `cleanupDeletionOrder invariant violated: delete-profiles appears ${profilesIndices.length} times (must be at most once to avoid double-counting dependent rows).`,
    );
  }
  if (profilesIndices.length === 1 && agentsIndex !== -1) {
    if (profilesIndices[0]! >= agentsIndex) {
      throw new Error(
        `cleanupDeletionOrder invariant violated: delete-profiles (index ${profilesIndices[0]}) must precede delete-agents (index ${agentsIndex}) — profiles.agent_id → agents.id is ON DELETE NO ACTION.`,
      );
    }
  }
}

/**
 * Stack 198 / D266: the exact transaction-local SQL that lifts the D374
 * default-DB seatbelt for the remainder of THIS transaction only.
 *
 * The D374 seatbelt (migration 0094_d374_db_identity_marker.sql) installs a
 * `BEFORE DELETE OR TRUNCATE` statement trigger on `public.users` that
 * raises `insufficient_privilege` (42501) whenever a DELETE/TRUNCATE runs
 * against the protected default DB without `nautilo.allow_destructive` set
 * to a truthy value (`1` / `true` / `yes` / `on`, case-insensitive). On the
 * default instance, the cleanup `--apply` transaction reaches the final
 * `DELETE FROM public.users` only after every manifest / fingerprint /
 * keep-list / cap / high-footprint / default-guard / ordering check has
 * passed — yet the seatbelt still aborted the user delete and rolled the
 * whole transaction back (observed: users stayed at 316). This helper is
 * the bridge: it is executed on the transaction connection AFTER all of
 * those checks have passed but BEFORE any mutation, so the seatbelt is
 * lifted only for the reviewed, approved, in-flight transaction.
 *
 * `SET LOCAL` (not `SET`) is load-bearing: the GUC expires at
 * commit/rollback and can never leak into the session, another pooled
 * connection, or a future run. It is the SQL-string equivalent of
 * `set_config('nautilo.allow_destructive', '1', true)` (the `true` third
 * arg is the transaction-local flag — see
 * packages/runtime/tests/integration/helpers.ts). The value is a constant
 * literal with no caller input, so no GUC escaping is required (contrast
 * withTrustContext, which must escape user-supplied GUC values).
 *
 * Pure + exported so the exact SQL string is unit-testable without a live
 * Postgres — `cleanupTestCruft` builds its own `createDirectDb` and runs
 * an inline `db.transaction`, so there is no transaction-injection seam
 * to exercise the live `tx.execute(sql.raw(...))` call in a no-DB test.
 * The helper is the source of truth for the SQL; the transaction body is
 * expected to call it verbatim via `tx.execute(sql.raw(destructiveSeatbeltSql()))`
 * as the first statement after `assertDeletionOrderInvariant` and before
 * any mutation. Reachability is structurally guaranteed: the only call
 * site is inside `db.transaction`, which is reached solely on `--apply`
 * (plan-json and dry-run paths `return` before the transaction opens),
 * so this setting can NEVER be reached in plan/dry-run modes.
 */
export const DESTRUCTIVE_SEATBELT_GUC = "nautilo.allow_destructive";

export function destructiveSeatbeltSql(): string {
  return `SET LOCAL ${DESTRUCTIVE_SEATBELT_GUC} = '1'`;
}

export async function cleanupTestCruft(
  args: CleanupTestCruftArgs,
): Promise<number> {
  const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
    commandName: "dev:cleanup-test-cruft",
    cwd: args.cwd ?? process.cwd(),
    isDryRunOrReadOnly: args.apply !== true || args.planJson === true,
    ...(args.env ? { env: args.env } : {}),
    ...(args.iKnowWhatIAmDoing === true ? { iKnowWhatIAmDoing: true } : {}),
  });
  if (!guard.allowed) {
    console.error(guard.message);
    return 2;
  }

  loadConfigEnvIntoProcess({ path: args.configEnvPath });

  // D266 Wave 2: --allow-half-redeemed-fixtures is a DEPRECATED no-op for
  // compatibility. It never authorizes deletion; the only identity-refusal
  // override is the exact UUID-only --allow-fixture-user-ids.
  if (args.allowHalfRedeemedFixtures === true) {
    console.error(
      "[cleanup] DEPRECATED: --allow-half-redeemed-fixtures is a no-op and no longer authorizes deletion. " +
        "Use --allow-fixture-user-ids <uuid,…> to permit a specific credentialless / half-redeemed fixture user.",
    );
  }

  const handleTokens = parseCommaList(args.keepUserHandles);
  const rawIdTokens = parseCommaList(args.keepUserIds);
  const invalidIds = rawIdTokens.filter((t) => !isUuid(t));
  if (invalidIds.length > 0) {
    console.error(
      `[cleanup] Refusing: invalid UUID(s) in --keep-user-ids: ${invalidIds.join(", ")}`,
    );
    return 1;
  }
  const idTokens = rawIdTokens.filter(isUuid);

  // D266 Wave 2: validate explicit fixture-user-id override UUIDs up front,
  // before any DB connection. Prefixes / wildcards are rejected by the UUID
  // shape check; existence is verified after the users table is loaded.
  const rawFixtureIds = parseCommaList(args.allowFixtureUserIds);
  const invalidFixtureIds = rawFixtureIds.filter((t) => !isUuid(t));
  if (invalidFixtureIds.length > 0) {
    console.error(
      `[cleanup] Refusing: invalid UUID(s) in --allow-fixture-user-ids: ${invalidFixtureIds.join(", ")}. Only exact UUIDs are accepted (no prefixes / wildcards).`,
    );
    return 1;
  }
  const fixtureIdTokens = rawFixtureIds.filter(isUuid);

  if (handleTokens.length === 0 && idTokens.length === 0) {
    console.error(
      "[cleanup] Refusing: provide at least one of --keep-user-handles <h1,h2> or --keep-user-ids <uuid,…>.",
    );
    return 1;
  }

  const maxParsed = args.maxDeletions?.trim()
    ? Number.parseInt(args.maxDeletions.trim(), 10)
    : 1000;
  if (!Number.isFinite(maxParsed) || maxParsed < 1) {
    console.error(
      "[cleanup] Refusing: --max-deletions must be a positive integer.",
    );
    return 1;
  }
  const maxDeletions = maxParsed;
  const allowHighFootprint = args.allowHighFootprint === true;
  const apply = args.apply === true;
  const planJson = args.planJson === true;

  // Stack 198 / D266 follow-up: --plan-out is only meaningful with --plan-json.
  // Validate up front, before any DB connection, so a misuse fails fast and
  // never opens a read-only plan query. plan-json remains read-only to the
  // DB and --apply cannot cause deletion; --plan-out never authorizes
  // anything — it only persists the already-serialized plan.
  const planOutRaw =
    typeof args.planOut === "string" ? args.planOut.trim() : "";
  if (planOutRaw.length > 0 && !planJson) {
    console.error(
      "[cleanup] Refusing: --plan-out <path> is only valid with --plan-json. Re-run with --plan-json --plan-out <path>.",
    );
    return 1;
  }
  const planOutPath =
    planOutRaw.length > 0
      ? resolve(args.cwd ?? process.cwd(), planOutRaw)
      : null;
  if (planOutPath !== null) {
    if (existsSync(planOutPath)) {
      console.error(
        `[cleanup] Refusing: --plan-out destination already exists: ${planOutPath}. A reviewed manifest is never overwritten — remove the file or choose a new path.`,
      );
      return 1;
    }
    const parentDir = dirname(planOutPath);
    if (!existsSync(parentDir)) {
      console.error(
        `[cleanup] Refusing: --plan-out parent directory does not exist: ${parentDir}. Create the directory first.`,
      );
      return 1;
    }
    let parentIsDir = false;
    try {
      parentIsDir = statSync(parentDir).isDirectory();
    } catch {
      parentIsDir = false;
    }
    if (!parentIsDir) {
      console.error(
        `[cleanup] Refusing: --plan-out parent path is not a directory: ${parentDir}.`,
      );
      return 1;
    }
  }
  /**
   * Human-oriented progress belongs on stdout for normal cleanup runs, but a
   * `--plan-json` invocation must reserve stdout for its one JSON document.
   * Keep this routing local to the command; rejected malformed/unsafe input
   * continues to use stderr via `console.error`.
   */
  const humanLog = (...values: unknown[]): void => {
    if (!planJson) console.log(...values);
  };

  const db = createDirectDb(1);
  try {
    const keepByHandle =
      handleTokens.length > 0
        ? await db
            .select({
              id: users.id,
              handle: users.handle,
              name: users.name,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(inArray(users.handle, handleTokens))
        : [];

    const keepByIdExtra =
      idTokens.length > 0
        ? await db
            .select({
              id: users.id,
              handle: users.handle,
              name: users.name,
              createdAt: users.createdAt,
            })
            .from(users)
            .where(inArray(users.id, idTokens))
        : [];

    const keepMap = new Map<string, (typeof keepByHandle)[0]>();
    for (const r of [...keepByHandle, ...keepByIdExtra]) {
      keepMap.set(r.id, r);
    }
    const keepRows = [...keepMap.values()];
    const keepIds = [...keepMap.keys()];

    humanLog(
      `[cleanup] keep-user-handles: ${handleTokens.length ? handleTokens.join(",") : "(none)"}`,
    );
    humanLog(
      `[cleanup] keep-user-ids: ${idTokens.length ? idTokens.join(",") : "(none)"}`,
    );

    if (keepRows.length === 0) {
      console.error(
        "[cleanup] Refusing: keep-set resolved to zero users (check handles / UUIDs for typos).",
      );
      return 1;
    }

    const keepLabel = keepRows
      .map((r) => r.handle ?? r.name ?? r.id)
      .sort()
      .join(", ");
    humanLog(`[cleanup] resolved keep-set: ${keepRows.length} user(s)`);
    humanLog(`[cleanup] keep-set: ${keepRows.length} user(s) — ${keepLabel}`);
    for (const r of keepRows.sort((a, b) =>
      (a.handle ?? "").localeCompare(b.handle ?? ""),
    )) {
      humanLog(
        `[cleanup]   - ${r.handle ?? "(no handle)"} (id=${r.id}, created=${r.createdAt.toISOString().slice(0, 10)})`,
      );
    }

    const allUsers = await db
      .select({
        id: users.id,
        handle: users.handle,
        name: users.name,
        email: users.email,
        externalId: users.externalId,
        createdAt: users.createdAt,
      })
      .from(users);

    // D266 Wave 2: project credential presence per user so the pure
    // classifier can assign identity classes without a second join inside
    // the predicate. No credential material is ever printed.
    const credentialUserIds =
      await db
        .select({ userId: credentials.userId })
        .from(credentials)
        .then((rows) => new Set(rows.map((r) => r.userId)));
    const hasCredentialsById = new Map<string, boolean>();
    for (const u of allUsers) {
      hasCredentialsById.set(u.id, credentialUserIds.has(u.id));
    }

    const cleanupUserRecords: CleanupUserRecord[] = allUsers.map((u) => ({
      id: u.id,
      handle: u.handle,
      name: u.name,
      email: u.email,
      externalId: u.externalId,
      hasCredentials: hasCredentialsById.get(u.id) ?? false,
      createdAt: u.createdAt,
    }));
    const oldestUserId = findOldestUserId(cleanupUserRecords);
    const identityByUserId = new Map<string, UserIdentityClass>();
    for (const u of cleanupUserRecords) {
      identityByUserId.set(
        u.id,
        classifyUserIdentity(u, u.id === oldestUserId),
      );
    }

    // D266 Wave 2: resolve explicit fixture-user-id overrides. Each must
    // exist; a bootstrap-seed UUID is NEVER authorizable and aborts the run.
    // IDs that fall inside the keep-set are preserved (keep-list wins) and
    // noted as redundant. Ordinary-authenticated explicit IDs are redundant
    // (already automatic candidates) and noted but not added to the override
    // set — the override only matters for refusal-class users.
    const explicitOverrideIds = new Set<string>();
    const explicitRedundantIds: string[] = [];
    const explicitPreservedIds: string[] = [];
    if (fixtureIdTokens.length > 0) {
      const userById = new Map(allUsers.map((u) => [u.id, u]));
      for (const fid of fixtureIdTokens) {
        const u = userById.get(fid);
        if (!u) {
          console.error(
            `[cleanup] Refusing: --allow-fixture-user-ids UUID ${fid} does not match any user. Verify the ID and that it is not already in the keep-set.`,
          );
          return 1;
        }
        if (keepIds.includes(u.id)) {
          explicitPreservedIds.push(u.id);
          continue;
        }
        const cls = identityByUserId.get(u.id)!;
        if (cls === "bootstrap-seed") {
          console.error(
            `[cleanup] Refusing: --allow-fixture-user-ids UUID ${u.id} resolves to the bootstrap-seed owner (${u.handle ?? u.name ?? u.id}). The seed owner is never deletable via cleanup — run \`nautilo-dev repair-orphan-default-agent --keep-user-id <claimed-uuid> --apply\` (D140) to merge it instead.`,
          );
          return 1;
        }
        if (isExplicitOverrideEligible(cls)) {
          explicitOverrideIds.add(u.id);
        } else {
          explicitRedundantIds.push(u.id);
        }
      }
    }

    const candidateUsers = allUsers.filter((u) => !keepIds.includes(u.id));
    const candidateUserIds = candidateUsers.map((u) => u.id);

    const preservedAgents = await db
      .select({
        id: agents.id,
        handle: agents.handle,
        ownerId: actors.ownerId,
      })
      .from(agents)
      .innerJoin(
        actors,
        and(eq(actors.agentId, agents.id), eq(actors.kind, "agent")),
      )
      .where(inArray(actors.ownerId, keepIds));

    const preservedIds = [...new Set(preservedAgents.map((a) => a.id))];
    const msgByPreservedAgent = new Map<string, number>();
    const memByPreservedAgent = new Map<string, number>();
    if (preservedIds.length > 0) {
      const msgRows = await db
        .select({ agentId: sessions.agentId, c: count() })
        .from(sessionMessages)
        .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
        .where(inArray(sessions.agentId, preservedIds))
        .groupBy(sessions.agentId);
      for (const r of msgRows) {
        if (r.agentId) msgByPreservedAgent.set(r.agentId, Number(r.c));
      }
      // M127: memories.agent_id is gone — per-agent memory counts can
      // no longer be derived from the row. Memory rows are scoped by
      // Namespace; per-agent breakdowns require joining through actor
      // / Room paths which is out of scope for this dashboard.
      void preservedIds;
    }

    humanLog("");
    humanLog("[cleanup] preserved agents (owned by keep-set users):");
    if (preservedAgents.length === 0) {
      humanLog("[cleanup]   (none)");
    } else {
      for (const a of preservedAgents) {
        const owner = keepRows.find((k) => k.id === a.ownerId);
        const msgs = msgByPreservedAgent.get(a.id) ?? 0;
        const mems = memByPreservedAgent.get(a.id) ?? 0;
        humanLog(
          `[cleanup]   [preserved] ${a.handle} (id=${a.id}) — owned by ${owner?.handle ?? owner?.id ?? "?"}, msgs=${msgs}, mems=${mems}`,
        );
      }
    }

    const orphanAgentScanRows = (await db.execute(sql`
      SELECT
        ag.id,
        ag.handle,
        (SELECT count(*)::int FROM actors a WHERE a.agent_id = ag.id) AS actor_count,
        (SELECT count(*)::int FROM sessions s WHERE s.agent_id = ag.id) AS session_count,
        (SELECT count(*)::int FROM profiles p WHERE p.agent_id = ag.id) AS profile_count,
        (
          SELECT count(*)::int
          FROM room_members rm
          INNER JOIN actors a ON a.id = rm.actor_id
          WHERE a.agent_id = ag.id
        ) AS room_membership_count
      FROM agents ag
      WHERE NOT EXISTS (
        SELECT 1 FROM actors a WHERE a.agent_id = ag.id AND a.kind = 'agent'
      )
      ORDER BY ag.created_at NULLS LAST, ag.id
    `)) as unknown as Array<{
      id: string;
      handle: string | null;
      actor_count: number;
      session_count: number;
      profile_count: number;
      room_membership_count: number;
    }>;

    const orphanAgentRows = orphanAgentScanRows
      .filter((row) =>
        isZeroFootprintFixtureOrphanAgent(row.handle, {
          actorCount: Number(row.actor_count),
          sessionCount: Number(row.session_count),
          profileCount: Number(row.profile_count),
          roomMembershipCount: Number(row.room_membership_count),
        }),
      )
      .map((row) => ({ id: row.id, handle: row.handle ?? "<null-handle>" }));

    const preservedOrphanAgentRows = orphanAgentScanRows.filter(
      (row) => !orphanAgentRows.some((candidate) => candidate.id === row.id),
    );

    const ownedAgentIdsByOwner = await db
      .select({
        ownerId: actors.ownerId,
        agentId: actors.agentId,
      })
      .from(actors)
      .where(and(eq(actors.kind, "agent"), isNotNull(actors.agentId)));

    const agentsOwnedByCandidate = new Set<string>();
    for (const row of ownedAgentIdsByOwner) {
      if (row.agentId && candidateUserIds.includes(row.ownerId)) {
        agentsOwnedByCandidate.add(row.agentId);
      }
    }

    const orphanIds = new Set(orphanAgentRows.map((a) => a.id));
    const agentIdsToDelete = new Set<string>([
      ...orphanIds,
      ...agentsOwnedByCandidate,
    ]);
    const agentIdList = [...agentIdsToDelete];

    const actorCounts =
      candidateUserIds.length > 0
        ? await db
            .select({
              ownerId: actors.ownerId,
              kind: actors.kind,
              c: count(),
            })
            .from(actors)
            .where(inArray(actors.ownerId, candidateUserIds))
            .groupBy(actors.ownerId, actors.kind)
        : [];

    let actorsUserKind = 0;
    let actorsAgentKind = 0;
    for (const r of actorCounts) {
      if (r.kind === "user") actorsUserKind += Number(r.c);
      else if (r.kind === "agent") actorsAgentKind += Number(r.c);
    }

    const [roomsRow] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(rooms)
            .where(inArray(rooms.ownerId, candidateUserIds))
        : [{ c: 0 }];

    const [sessionsRow] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(sessions)
            .where(inArray(sessions.ownerId, candidateUserIds))
        : [{ c: 0 }];

    const [sessMsgUser] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .where(inArray(sessions.ownerId, candidateUserIds))
        : [{ c: 0 }];

    const [sessMsgByAgent] =
      agentIdList.length > 0
        ? await db
            .select({ c: count() })
            .from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .where(inArray(sessions.agentId, agentIdList))
        : [{ c: 0 }];

    // M127: memories no longer carry agent_id. Memory rows are not
    // counted per-agent for the cleanup dashboard anymore — they
    // remain attached to their Namespace and are reaped via Namespace
    // / Room cascades.
    const memTotal = { c: 0 };

    const [credTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(credentials)
            .where(inArray(credentials.userId, candidateUserIds))
        : [{ c: 0 }];

    const [chanTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(channelIdentities)
            .where(inArray(channelIdentities.userId, candidateUserIds))
        : [{ c: 0 }];

    const [recTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(recoveryCodes)
            .where(inArray(recoveryCodes.userId, candidateUserIds))
        : [{ c: 0 }];

    const roomIdsSub =
      candidateUserIds.length > 0
        ? db
            .select({ id: rooms.id })
            .from(rooms)
            .where(inArray(rooms.ownerId, candidateUserIds))
        : db.select({ id: rooms.id }).from(rooms).where(sql`false`);

    const [rmTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(roomMembers)
            .where(inArray(roomMembers.roomId, roomIdsSub))
        : [{ c: 0 }];

    const [jobsTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(jobs)
            .where(
              or(
                inArray(jobs.ownerId, candidateUserIds),
                inArray(jobs.requestorId, candidateUserIds),
              ),
            )
        : [{ c: 0 }];

    const [profTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(profiles)
            .where(inArray(profiles.userId, candidateUserIds))
        : [{ c: 0 }];

    const candGroupRows =
      candidateUserIds.length > 0
        ? await db
            .select({ id: groups.id })
            .from(groups)
            .where(inArray(groups.ownerId, candidateUserIds))
        : [];
    const candGroupIds = candGroupRows.map((g) => g.id);

    const [saTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(standingApprovals)
            .where(
              or(
                inArray(standingApprovals.createdBy, candidateUserIds),
                inArray(standingApprovals.actorPattern, candidateUserIds),
              ),
            )
        : [{ c: 0 }];

    const acWhere =
      candGroupIds.length > 0
        ? or(
            inArray(approvalChallenges.requestedBy, candidateUserIds),
            inArray(approvalChallenges.resolvedBy, candidateUserIds),
            inArray(approvalChallenges.groupId, candGroupIds),
          )
        : or(
            inArray(approvalChallenges.requestedBy, candidateUserIds),
            inArray(approvalChallenges.resolvedBy, candidateUserIds),
          );

    const [acTotal] =
      candidateUserIds.length > 0
        ? await db
            .select({ c: count() })
            .from(approvalChallenges)
            .where(acWhere)
        : [{ c: 0 }];

    humanLog("");
    humanLog(
      `[cleanup] DELETE-candidate users: ${candidateUsers.length}`,
    );
    const ub = tallyBuckets(
      candidateUsers.map((u) => u.handle),
      bucketUserHandle,
    );
    humanLog("[cleanup]   by handle pattern:");
    for (const line of formatBuckets(ub)) humanLog(line);

    humanLog("[cleanup]   total footprint:");
    humanLog(
      `[cleanup]     agents owned: ~${agentsOwnedByCandidate.size}   actors owned: ~${actorsUserKind + actorsAgentKind} (user-kind=${actorsUserKind}, agent-kind=${actorsAgentKind})`,
    );
    humanLog(
      `[cleanup]     rooms owned: ~${Number(roomsRow?.c ?? 0)}    sessions owned: ~${Number(sessionsRow?.c ?? 0)}`,
    );
    humanLog(
      `[cleanup]     session_messages:   ~${Number(sessMsgUser?.c ?? 0)}    memories: ~${Number(memTotal?.c ?? 0)}`,
    );
    humanLog(
      "[cleanup]     credentials / channel_identities / recovery_codes: cascade",
    );

    humanLog("");
    humanLog(
      `[cleanup] DELETE-candidate orphan agents (no ownership group): ${orphanAgentRows.length}`,
    );
    const ob = tallyBuckets(
      orphanAgentRows.map((a) => a.handle),
      bucketAgentHandle,
    );
    humanLog("[cleanup]   by handle prefix:");
    for (const line of formatBuckets(ob)) humanLog(line);
    if (preservedOrphanAgentRows.length > 0) {
      humanLog(
        "[cleanup]   preserved no-mirror agents (not known fixture zero-footprint):",
      );
      for (const row of preservedOrphanAgentRows.slice(0, 12)) {
        humanLog(
          `[cleanup]     ${row.handle ?? row.id}: actors=${row.actor_count} sessions=${row.session_count} profiles=${row.profile_count} room_memberships=${row.room_membership_count}`,
        );
      }
      if (preservedOrphanAgentRows.length > 12) {
        humanLog(
          `[cleanup]     ... ${preservedOrphanAgentRows.length - 12} more preserved no-mirror agent(s)`,
        );
      }
    }

    const userMsgCounts =
      candidateUserIds.length > 0
        ? await db
            .select({ ownerId: sessions.ownerId, c: count() })
            .from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .where(inArray(sessions.ownerId, candidateUserIds))
            .groupBy(sessions.ownerId)
        : [];

    const userMsgMap = new Map(userMsgCounts.map((r) => [r.ownerId, Number(r.c)]));

    const orphanIdList = orphanAgentRows.map((a) => a.id);
    const orphanMsgByAgent =
      orphanIdList.length > 0
        ? await db
            .select({ agentId: sessions.agentId, c: count() })
            .from(sessionMessages)
            .innerJoin(sessions, eq(sessions.id, sessionMessages.sessionId))
            .where(inArray(sessions.agentId, orphanIdList))
            .groupBy(sessions.agentId)
        : [];

    // M127: per-agent memory counts no longer derivable from the row.
    const orphanMemByAgent: { agentId: string | null; c: number }[] = [];

    const oMsgMap = new Map(
      orphanMsgByAgent
        .filter((r) => r.agentId)
        .map((r) => [r.agentId!, Number(r.c)]),
    );
    const oMemMap = new Map(
      orphanMemByAgent
        .filter((r) => r.agentId)
        .map((r) => [r.agentId!, Number(r.c)]),
    );

    const warnings: string[] = [];
    type PlanBlocker =
      | {
          kind: "high-footprint-user";
          userId: string;
          handle: string | null;
          sessionMessages: number;
          threshold: 1000;
        }
      | {
          kind: "high-footprint-orphan-agent";
          agentId: string;
          handle: string;
          sessionMessages: number;
          memories: number;
          sessionMessagesThreshold: 1000;
          memoriesThreshold: 100;
        }
      | {
          kind: "protected-identity";
          userId: string;
          handle: string | null;
          identityClass: UserIdentityClass;
        }
      | {
          kind: "deletion-cap";
          estimatedDeletions: number;
          maxDeletions: number;
        };
    const planBlockers: PlanBlocker[] = [];

    for (const u of candidateUsers) {
      const n = userMsgMap.get(u.id) ?? 0;
      if (n > 100 && n <= 1000) {
        warnings.push(
          `[cleanup]   - WARN candidate user ${u.handle ?? u.id} has ${n} session_messages — elevated activity.`,
        );
      }
      if (n > 1000 && !allowHighFootprint) {
        planBlockers.push({
          kind: "high-footprint-user",
          userId: u.id,
          handle: u.handle,
          sessionMessages: n,
          threshold: 1000,
        });
        if (!planJson) {
          console.error(
            `[cleanup] Refusing: candidate user ${u.handle ?? u.id} has ${n} session_messages (>1000). Pass --allow-high-footprint to delete anyway.`,
          );
          return 1;
        }
      }
      if (n > 1000 && allowHighFootprint) {
        warnings.push(
          `[cleanup]   - WARN candidate user ${u.handle ?? u.id} has ${n.toLocaleString()} session_messages — looks active.`,
        );
      }
    }

    for (const a of orphanAgentRows) {
      const mc = oMsgMap.get(a.id) ?? 0;
      const memc = oMemMap.get(a.id) ?? 0;
      if (mc > 1000 || memc > 100) {
        if (!allowHighFootprint) {
          planBlockers.push({
            kind: "high-footprint-orphan-agent",
            agentId: a.id,
            handle: a.handle,
            sessionMessages: mc,
            memories: memc,
            sessionMessagesThreshold: 1000,
            memoriesThreshold: 100,
          });
          if (!planJson) {
            console.error(
              `[cleanup] Refusing: candidate orphan agent ${a.handle} has ${mc} session_messages, ${memc} memories (threshold msgs>1000 or mems>100). Pass --allow-high-footprint.`,
            );
            return 1;
          }
        }
        warnings.push(
          `[cleanup]   - WARN candidate orphan agent ${a.handle} has ${mc.toLocaleString()} session_messages, ${memc} memories — looks like real data.`,
        );
      } else if (memc >= 50 && memc <= 100) {
        warnings.push(
          `[cleanup]   - WARN candidate orphan agent ${a.handle} has ${memc} memories — looks like real data.`,
        );
      }
    }

    // D266 Wave 2: classify every candidate by identity and split them into
    // automatic candidates (ordinary-authenticated), explicit-ID overrides
    // (operator-confirmed credentialless / half-redeemed fixture UUIDs),
    // and protected refusals (bootstrap-seed always; half-redeemed /
    // unknown-credentialless without an explicit override). Known fixture
    // handle patterns are reporting-only and never authorize deletion.
    interface CandidateIdentity {
      id: string;
      handle: string | null;
      name: string | null;
      identityClass: UserIdentityClass;
      sessionMessages: number;
      overridden: boolean;
    }
    const automaticCandidates: CandidateIdentity[] = [];
    const explicitOverrideCandidates: CandidateIdentity[] = [];
    const protectedRefusals: CandidateIdentity[] = [];
    for (const u of candidateUsers) {
      const cls = identityByUserId.get(u.id)!;
      const msgs = userMsgMap.get(u.id) ?? 0;
      const entry: CandidateIdentity = {
        id: u.id,
        handle: u.handle,
        name: u.name,
        identityClass: cls,
        sessionMessages: msgs,
        overridden: false,
      };
      if (explicitOverrideIds.has(u.id)) {
        entry.overridden = true;
        explicitOverrideCandidates.push(entry);
      } else if (isProtectedRefusalClass(cls)) {
        protectedRefusals.push(entry);
      } else {
        automaticCandidates.push(entry);
      }
    }

    // D266 Wave 3: derive the DB-state review surface that feeds the plan
    // fingerprint. These sets are computed directly from the resolved
    // candidates + identity classes, INDEPENDENT of the operator's
    // --allow-fixture-user-ids choice, so the fingerprint is stable for
    // semantically identical DB state and does not vary with the override
    // the operator is previewing. `protectedIdentities` is the exact-UUID
    // override-eligible set (credentialless / half-redeemed); bootstrap-seed
    // is never override-eligible and never appears here.
    const protectedIdentitiesAll = candidateUsers
      .map((u) => ({
        id: u.id,
        identityClass: identityByUserId.get(u.id)!,
      }))
      .filter((e) => isExplicitOverrideEligible(e.identityClass))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const protectedIdentities = protectedIdentitiesAll.map((e) => e.id);

    const fingerprintInput: CanonicalPlanFingerprintInput = {
      command: "dev:cleanup-test-cruft",
      keepSet: keepRows.map((r) => ({
        id: r.id,
        handle: r.handle,
        name: r.name,
        createdAt: r.createdAt.toISOString(),
      })),
      deletionCap: maxDeletions,
      automaticCandidates: automaticCandidates.map((c) => ({
        id: c.id,
        identityClass: c.identityClass,
      })),
      protectedRefusals: candidateUsers
        .map((u) => ({
          id: u.id,
          identityClass: identityByUserId.get(u.id)!,
        }))
        .filter((e) => isProtectedRefusalClass(e.identityClass)),
      protectedIdentities: protectedIdentitiesAll,
      orphanAgentsToDelete: orphanAgentRows.map((a) => ({
        id: a.id,
        handle: a.handle,
      })),
    };
    const currentPlanFingerprint = computePlanFingerprint(fingerprintInput);


    humanLog("");
    humanLog("[cleanup] candidate identity classification:");
    humanLog(
      `[cleanup]   automatic candidates (ordinary-authenticated, will be deleted): ${automaticCandidates.length}`,
    );
    for (const c of automaticCandidates) {
      humanLog(
        `[cleanup]     - ${c.handle ?? "(no handle)"} (id=${c.id}, class=${c.identityClass}, msgs=${c.sessionMessages})`,
      );
    }
    humanLog(
      `[cleanup]   explicit-ID overrides (--allow-fixture-user-ids): ${explicitOverrideCandidates.length}`,
    );
    for (const c of explicitOverrideCandidates) {
      humanLog(
        `[cleanup]     - ${c.handle ?? "(no handle)"} (id=${c.id}, class=${c.identityClass}, msgs=${c.sessionMessages}) — override permits this ${c.identityClass} candidate past the identity refusal`,
      );
    }
    if (explicitRedundantIds.length > 0) {
      humanLog(
        `[cleanup]   explicit-ID overrides (redundant — already automatic candidates): ${explicitRedundantIds.length}`,
      );
      for (const id of explicitRedundantIds) {
        humanLog(`[cleanup]     - id=${id} (ordinary-authenticated, no refusal to override)`);
      }
    }
    if (explicitPreservedIds.length > 0) {
      humanLog(
        `[cleanup]   explicit-ID overrides (ignored — in keep-set, preserved wins): ${explicitPreservedIds.length}`,
      );
      for (const id of explicitPreservedIds) {
        humanLog(`[cleanup]     - id=${id} (preserved by keep-list)`);
      }
    }
    humanLog(
      `[cleanup]   protected refusals (run will abort unless overridden): ${protectedRefusals.length}`,
    );
    for (const c of protectedRefusals) {
      const reason =
        c.identityClass === "bootstrap-seed"
          ? "bootstrap-seed owner is never deletable via cleanup — run `nautilo-dev repair-orphan-default-agent --keep-user-id <claimed-uuid> --apply` (D140) to merge it"
          : c.identityClass === "half-redeemed"
            ? "M105 half-redeemed in-flight claim (no credentials, external_id set) — complete the claim via completeInviteProfile or revoke the Logto user, or pass its UUID to --allow-fixture-user-ids"
            : "unknown credentialless user (no credentials, no external_id, not the seed owner) — pass its UUID to --allow-fixture-user-ids to permit";
      humanLog(
        `[cleanup]     - ${c.handle ?? "(no handle)"} (id=${c.id}, class=${c.identityClass}, msgs=${c.sessionMessages}) — ${reason}`,
      );
    }

    for (const refusal of protectedRefusals) {
      planBlockers.push({
        kind: "protected-identity",
        userId: refusal.id,
        handle: refusal.handle,
        identityClass: refusal.identityClass,
      });
    }

    // D266 Wave 3: cautious manifest-and-plan-hash apply gate. On `--apply`,
    // protected credentialless / half-redeemed candidates (the
    // `protectedIdentities` set) can ONLY be deleted via a saved `--plan-json`
    // fixture manifest supplied with `--fixture-plan <path>` plus
    // `--approve-plan <sha256>`. The approval hash must equal BOTH the
    // manifest's `planFingerprint` and the freshly computed current plan
    // fingerprint; the manifest's `protectedIdentities` must exactly equal
    // the current override-eligible set. `--allow-fixture-user-ids` alone
    // cannot authorize protected-identity deletion on apply (it remains
    // available for read-only / dry plan review). bootstrap-seed is never
    // overridable. Keep-list, high-footprint, deletion cap, default instance
    // guard, and transaction behavior remain non-bypassable.
    const hasManifestPath = typeof args.fixturePlan === "string" && args.fixturePlan.trim().length > 0;
    const hasApproveHash = typeof args.approvePlan === "string" && args.approvePlan.trim().length > 0;

    if (apply && protectedIdentities.length > 0) {
      if (!hasManifestPath || !hasApproveHash) {
        console.error(
          `[cleanup] Refusing: ${protectedIdentities.length} protected credentialless / half-redeemed candidate(s) require the manifest gate to apply. Re-run with --plan-json (optionally with --allow-fixture-user-ids for review), save the output, then apply with --fixture-plan <path> --approve-plan <sha256> (the manifest's planFingerprint). --allow-fixture-user-ids alone cannot authorize protected-identity deletion on apply.`,
        );
        return 1;
      }
      if (!isSha256Hex(args.approvePlan!.trim())) {
        console.error(
          "[cleanup] Refusing: --approve-plan must be a 64-char lowercase hex SHA-256 (the manifest's planFingerprint).",
        );
        return 1;
      }
      const approveHash = args.approvePlan!.trim();
      let manifestRaw: unknown;
      try {
        manifestRaw = JSON.parse(readFileSync(args.fixturePlan!.trim(), "utf8"));
      } catch (e) {
        console.error(
          `[cleanup] Refusing: could not read / parse --fixture-plan ${args.fixturePlan}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return 1;
      }
      const validation = validateCleanupPlanManifest(manifestRaw, "dev:cleanup-test-cruft");
      if (!validation.ok) {
        console.error(`[cleanup] Refusing: invalid fixture manifest: ${validation.reason}`);
        return 1;
      }
      const manifestFingerprint = validation.planFingerprint;
      if (approveHash !== manifestFingerprint) {
        console.error(
          `[cleanup] Refusing: --approve-plan hash does not match the manifest's planFingerprint (tampered or wrong manifest). approve=${approveHash} manifest=${manifestFingerprint}. Re-run --plan-json, save the fresh manifest, and apply its planFingerprint.`,
        );
        return 1;
      }
      if (approveHash !== currentPlanFingerprint) {
        console.error(
          `[cleanup] Refusing: manifest is stale — its planFingerprint does not match the freshly computed current plan fingerprint (DB state changed since the manifest was saved). manifest=${manifestFingerprint} current=${currentPlanFingerprint}. Re-run --plan-json and save a fresh manifest before applying.`,
        );
        return 1;
      }
      // The manifest's protectedIdentities must exactly equal the current
      // override-eligible set (fingerprint already bound it, but this is the
      // load-bearing override-set check — it prevents a tampered manifest
      // from authorizing UUIDs that are not currently protected-eligible).
      const manifestProtected = new Set(validation.protectedIdentities);
      const currentProtectedSet = new Set(protectedIdentities);
      if (manifestProtected.size !== currentProtectedSet.size) {
        console.error(
          `[cleanup] Refusing: manifest protectedIdentities count (${manifestProtected.size}) does not match current override-eligible set (${currentProtectedSet.size}). DB state changed since the manifest was saved — re-run --plan-json and save a fresh manifest.`,
        );
        return 1;
      }
      for (const id of manifestProtected) {
        if (!currentProtectedSet.has(id)) {
          console.error(
            `[cleanup] Refusing: manifest protectedIdentities UUID ${id} is not a current override-eligible protected candidate. DB state changed since the manifest was saved — re-run --plan-json and save a fresh manifest.`,
          );
          return 1;
        }
      }
      // Never permit a bootstrap-seed identity via the manifest. The
      // protectedIdentities set is override-eligible only (credentialless /
      // half-redeemed), but defend explicitly: any current protected refusal
      // that is bootstrap-seed remains non-overridable and aborts the run.
      for (const id of manifestProtected) {
        const u = allUsers.find((r) => r.id === id);
        if (u && identityByUserId.get(u.id) === "bootstrap-seed") {
          console.error(
            `[cleanup] Refusing: manifest protectedIdentities UUID ${id} resolves to the bootstrap-seed owner, which is never deletable via cleanup. The manifest is invalid — re-run --plan-json and do not include the seed owner.`,
          );
          return 1;
        }
        if (u && keepIds.includes(u.id)) {
          console.error(
            `[cleanup] Refusing: manifest protectedIdentities UUID ${id} is in the keep-set. The keep-list is non-bypassable — remove it from the manifest or the keep-set.`,
          );
          return 1;
        }
      }
      // Gate passed: use the manifest's protectedIdentities as the exact
      // override set. Reclassify those candidates from protected refusals
      // into explicit overrides so the apply path deletes them.
      const manifestOverrideIds = new Set(manifestProtected);
      for (let i = protectedRefusals.length - 1; i >= 0; i--) {
        const c = protectedRefusals[i]!;
        if (manifestOverrideIds.has(c.id)) {
          c.overridden = true;
          explicitOverrideCandidates.push(c);
          protectedRefusals.splice(i, 1);
        }
      }
      if (fixtureIdTokens.length > 0) {
        humanLog(
          "[cleanup] NOTE: --allow-fixture-user-ids is ignored on --apply when the manifest gate is in effect; the manifest's protectedIdentities are the exact override set.",
        );
      }
      humanLog(
        `[cleanup] manifest gate: approved ${manifestOverrideIds.size} protected identity override(s) via --fixture-plan (fingerprint match confirmed).`,
      );
      // After applying the manifest override, any remaining protected refusal
      // is a bootstrap-seed (never overridable) — abort before any mutation.
      if (protectedRefusals.length > 0) {
        console.error(
          `[cleanup] Refusing: ${protectedRefusals.length} protected identity refusal(s) remain after the manifest override (bootstrap-seed is never deletable via cleanup). Run \`nautilo-dev repair-orphan-default-agent --keep-user-id <claimed-uuid> --apply\` (D140) to merge it instead.`,
        );
        return 1;
      }
    } else if (protectedRefusals.length > 0 && !planJson) {
      // No override-eligible protected identities to manifest-gate, but a
      // protected refusal remains (e.g. bootstrap-seed, which is never
      // overridable). Abort the run.
      console.error(
        `[cleanup] Refusing: ${protectedRefusals.length} protected identity refusal(s) listed above. bootstrap-seed is never overridable; credentialless / half-redeemed fixtures require the --fixture-plan + --approve-plan manifest gate on --apply (or --allow-fixture-user-ids for read-only / dry plan review).`,
      );
      return 1;
    }

    const cascadeCredBundle =
      Number(credTotal?.c ?? 0) +
      Number(chanTotal?.c ?? 0) +
      Number(recTotal?.c ?? 0);

    const totalEstimated =
      candidateUsers.length +
      agentIdList.length +
      actorsUserKind +
      actorsAgentKind +
      Number(roomsRow?.c ?? 0) +
      Number(rmTotal?.c ?? 0) +
      Number(sessMsgUser?.c ?? 0) +
      Number(sessMsgByAgent?.c ?? 0) +
      Number(memTotal?.c ?? 0) +
      cascadeCredBundle +
      Number(profTotal?.c ?? 0) +
      Number(jobsTotal?.c ?? 0) +
      Number(saTotal?.c ?? 0) +
      Number(acTotal?.c ?? 0) +
      Number(sessionsRow?.c ?? 0);

    humanLog("");
    humanLog("[cleanup] HIGH-FOOTPRINT WARNINGS:");
    if (warnings.length === 0) {
      humanLog(
        "[cleanup]   (none — all candidates have <100 session_messages, <50 memories for orphan path where applicable)",
      );
    } else {
      for (const w of warnings) humanLog(w);
      if (!allowHighFootprint) {
        humanLog(
          "[cleanup]   Pass --allow-high-footprint to delete rows that exceed automatic thresholds.",
        );
      }
    }

    humanLog("");
    humanLog("[cleanup] estimated row deletions (post-cascade):");
    humanLog(`[cleanup]   users: ${candidateUsers.length}`);
    humanLog(
      `[cleanup]   actors: ~${actorsUserKind + actorsAgentKind} (cascade via owner_id on user delete + agent mirror cascade on agent delete)`,
    );
    const orphanOnly = orphanAgentRows.length;
    const testOwned = Math.max(0, agentIdList.length - orphanOnly);
    humanLog(
      `[cleanup]   agents: ~${agentIdList.length} (orphan: ${orphanOnly} + test-owned: ${testOwned} + cascade via agent_ownership delete)`,
    );
    humanLog("[cleanup]   rooms: ~" + Number(roomsRow?.c ?? 0) + " (cascade via owner_id)");
    humanLog(
      "[cleanup]   room_members: ~" + Number(rmTotal?.c ?? 0) + " (cascade via room delete)",
    );
    humanLog(
      `[cleanup]   session_messages: ~${Number(sessMsgUser?.c ?? 0) + Number(sessMsgByAgent?.c ?? 0)}`,
    );
    humanLog("[cleanup]   memories: ~" + Number(memTotal?.c ?? 0));
    humanLog(
      `[cleanup]   credentials / channel_identities / recovery_codes / profiles: ~${cascadeCredBundle + Number(profTotal?.c ?? 0)} (cascade + explicit deletes)`,
    );

    humanLog("");
    humanLog(`[cleanup] total estimated deletions: ~${totalEstimated} rows`);
    humanLog(
      `[cleanup] max-deletions limit: ${maxDeletions} (override with --max-deletions <N>)`,
    );

    if (totalEstimated > maxDeletions) {
      planBlockers.push({
        kind: "deletion-cap",
        estimatedDeletions: totalEstimated,
        maxDeletions,
      });
      if (!planJson) {
        console.error(
          `[cleanup] Refusing: estimated deletions (~${totalEstimated}) exceed --max-deletions ${maxDeletions}. Raise the limit intentionally if this matches your intent.`,
        );
        return 1;
      }
    }

    // D266 Wave 2: --plan-json emits a complete read-only structured plan
    // (no credential material) and exits without applying, even if --apply
    // was also supplied. It does not waive a safety condition: protected
    // identities, high-footprint candidates, and deletion-cap breaches are
    // recorded in `blockers` so the operator can review the full plan.
    if (planJson) {
      const plan = {
        command: "dev:cleanup-test-cruft",
        mode: "plan-json",
        readOnly: true,
        applyWouldRun: apply,
        planFingerprint: currentPlanFingerprint,
        protectedIdentities,
        keepSet: keepRows
          .map((r) => ({
            id: r.id,
            handle: r.handle,
            name: r.name,
            createdAt: r.createdAt.toISOString(),
          }))
          .sort((a, b) => (a.handle ?? "").localeCompare(b.handle ?? "")),
        deletionCap: maxDeletions,
        allowFixtureUserIds: fixtureIdTokens,
        blockers: planBlockers,
        candidates: {
          automatic: automaticCandidates.map((c) => ({
            id: c.id,
            handle: c.handle,
            identityClass: c.identityClass,
            sessionMessages: c.sessionMessages,
          })),
          explicitOverrides: explicitOverrideCandidates.map((c) => ({
            id: c.id,
            handle: c.handle,
            identityClass: c.identityClass,
            sessionMessages: c.sessionMessages,
            reason: `operator-confirmed ${c.identityClass} fixture via --allow-fixture-user-ids`,
          })),
          explicitRedundant: explicitRedundantIds.map((id) => ({
            id,
            reason: "ordinary-authenticated — already an automatic candidate",
          })),
          explicitPreserved: explicitPreservedIds.map((id) => ({
            id,
            reason: "in keep-set — preserved by keep-list",
          })),
          protectedRefusals: protectedRefusals.map((c) => ({
            id: c.id,
            handle: c.handle,
            identityClass: c.identityClass,
            sessionMessages: c.sessionMessages,
          })),
        },
        preservedAgents: preservedAgents.map((a) => {
          const owner = keepRows.find((k) => k.id === a.ownerId);
          return {
            id: a.id,
            handle: a.handle,
            ownerId: a.ownerId,
            ownerHandle: owner?.handle ?? null,
            sessionMessages: msgByPreservedAgent.get(a.id) ?? 0,
          };
        }),
        orphanAgentsToDelete: orphanAgentRows.map((a) => ({
          id: a.id,
          handle: a.handle,
        })),
        preservedUnknownAgents: preservedOrphanAgentRows.map((row) => ({
          id: row.id,
          handle: row.handle,
          footprint: {
            actors: row.actor_count,
            sessions: row.session_count,
            profiles: row.profile_count,
            roomMemberships: row.room_membership_count,
          },
        })),
        estimatedDeletions: {
          users: candidateUsers.length,
          agents: agentIdList.length,
          orphanAgents: orphanAgentRows.length,
          testOwnedAgents: testOwned,
          actors: actorsUserKind + actorsAgentKind,
          rooms: Number(roomsRow?.c ?? 0),
          roomMembers: Number(rmTotal?.c ?? 0),
          sessionMessages:
            Number(sessMsgUser?.c ?? 0) + Number(sessMsgByAgent?.c ?? 0),
          memories: Number(memTotal?.c ?? 0),
          credentialsChannelRecoveryProfiles:
            cascadeCredBundle + Number(profTotal?.c ?? 0),
          sessions: Number(sessionsRow?.c ?? 0),
        },
        totalEstimated,
        highFootprintWarnings: warnings,
      };
      const serialized = JSON.stringify(plan, null, 2);
      // Stack 198 / D266 follow-up: when --plan-out is supplied, persist the
      // exact same serialized plan atomically BEFORE emitting to stdout. A
      // write failure returns nonzero and emits nothing to stdout (no
      // partial data); the atomic temp-then-rename guarantees a reviewed
      // manifest is never partially overwritten and no partial plan file
      // is left behind. Re-check destination existence here as a race
      // defense in case the file appeared between pre-DB validation and
      // the write.
      if (planOutPath !== null) {
        if (existsSync(planOutPath)) {
          console.error(
            `[cleanup] Refusing: --plan-out destination already exists: ${planOutPath}. A reviewed manifest is never overwritten — remove the file or choose a new path.`,
          );
          return 1;
        }
        try {
          atomicWritePlanFile(planOutPath, serialized);
        } catch (e) {
          console.error(
            `[cleanup] Refusing: could not write --plan-out ${args.planOut}: ${e instanceof Error ? e.message : String(e)}`,
          );
          return 1;
        }
      }
      console.log(serialized);
      return 0;
    }

    const hasWork =
      candidateUserIds.length > 0 || orphanAgentRows.length > 0;
    if (apply && !hasWork) {
      humanLog("[cleanup] instance is clean — nothing to delete");
      return 0;
    }

    if (!apply) {
      humanLog("");
      humanLog(
        "[cleanup] DRY-RUN — no rows changed. Re-run with --apply to commit.",
      );
      return 0;
    }

    const sessionIdsToPurge =
      candidateUserIds.length > 0
        ? await db
            .select({ id: sessions.id })
            .from(sessions)
            .where(inArray(sessions.ownerId, candidateUserIds))
        : [];
    const sessionIdList = sessionIdsToPurge.map((s) => s.id);

    const roomIdsToClear =
      candidateUserIds.length > 0
        ? await db
            .select({ id: rooms.id })
            .from(rooms)
            .where(inArray(rooms.ownerId, candidateUserIds))
        : [];
    const roomIdList = roomIdsToClear.map((r) => r.id);

    let deletedUsers = 0;
    const orphanAgentDeleteCount = orphanAgentRows.length;
    const testOwnedAgentDeleteCount = Math.max(
      0,
      agentIdList.length - orphanAgentDeleteCount,
    );
    let dependentRows = 0;

    await db.transaction(async (tx) => {
      // Stack 198 / D266: fail fast if the canonical ordering helper ever
      // drifts from the profiles-before-agents invariant. rooms.namespace_id
      // is NOT NULL, so roomIdList is an accurate non-empty proxy for the
      // memory-namespaces phase. This guards the helper, not the live tx
      // body ordering (see cleanupDeletionOrder doc for the residual
      // limitation).
      assertDeletionOrderInvariant({
        agentIdList,
        sessionIdList,
        roomIdList,
        roomNamespaceIds: roomIdList,
        candidateUserIds,
      });

      // Stack 198 / D266: lift the D374 default-DB seatbelt for THIS
      // transaction only. Every plan / manifest / fingerprint / keep-list /
      // cap / high-footprint / default-guard / ordering check has already
      // passed before the transaction opened; this is the first statement
      // inside the transaction and precedes every mutation. `SET LOCAL`
      // (via sql.raw — Drizzle parameter binding emits `$1` placeholders
      // which Postgres rejects in `SET LOCAL`, and the value is a constant
      // literal anyway) scopes the GUC to the transaction: it expires at
      // commit/rollback and cannot leak into the session, another pooled
      // connection, or a future run. This call site is unreachable in
      // plan-json / dry-run modes — those paths `return` before
      // `db.transaction` opens — so the seatbelt is never lifted for
      // read-only plans. See `destructiveSeatbeltSql` for the contract.
      await tx.execute(sql.raw(destructiveSeatbeltSql()));

      if (agentIdList.length > 0) {
        await tx
          .update(sessions)
          .set({ agentId: null })
          .where(inArray(sessions.agentId, agentIdList));
      }

      if (sessionIdList.length > 0) {
        const sm = await tx
          .delete(sessionMessages)
          .where(inArray(sessionMessages.sessionId, sessionIdList));
        dependentRows += deletedRowCount(sm);
        const ss = await tx
          .delete(sessions)
          .where(inArray(sessions.id, sessionIdList));
        dependentRows += deletedRowCount(ss);
      }

      if (roomIdList.length > 0) {
        await tx
          .update(sessions)
          .set({ roomId: null })
          .where(inArray(sessions.roomId, roomIdList));
        await tx
          .update(jobs)
          .set({ roomId: null })
          .where(inArray(jobs.roomId, roomIdList));

        const nsRows = await tx
          .select({ ns: rooms.namespaceId })
          .from(rooms)
          .where(inArray(rooms.id, roomIdList));
        const nsIds = [...new Set(nsRows.map((r) => r.ns))];
        if (nsIds.length > 0) {
          const mn = await tx
            .delete(memoryNamespaces)
            .where(inArray(memoryNamespaces.namespaceId, nsIds));
          dependentRows += deletedRowCount(mn);
        }
      }

      // Stack 198 / D266: delete profiles whose user_id is in candidate
      // users BEFORE deleting the associated agents. profiles.agent_id →
      // agents.id is ON DELETE NO ACTION (migration 0067_m132), so an
      // agent row cannot be removed while any profile still references
      // it — deleting agents first aborts the whole transaction with
      // profiles_agent_id_agents_id_fk (observed in production: the
      // rollback left users at 316). A candidate-owned agent's profile
      // is owned (user_id) by that same candidate user, so deleting
      // profiles by candidate user_id clears every profile that would
      // otherwise block the agent delete. Orphan agents in agentIdList
      // have a zero profile footprint by construction
      // (isZeroFootprintFixtureOrphanAgent), so they contribute no
      // profile rows here. profiles is deleted exactly once; the later
      // candidate block no longer touches it (accounting stays accurate).
      // The canonical phase ordering is `cleanupDeletionOrder` — this
      // block must keep `delete-profiles` ahead of `delete-agents`.
      if (candidateUserIds.length > 0) {
        const profDel = await tx
          .delete(profiles)
          .where(inArray(profiles.userId, candidateUserIds));
        dependentRows += deletedRowCount(profDel);
      }

      if (agentIdList.length > 0) {
        // M127: memories.agent_id is gone; deleting an Agent no longer
        // reaps that Agent's authored memories — they remain on their
        // Namespace by design (Namespace-only content scope). Memory
        // rows are reaped via Namespace / Room cascades when the
        // surrounding scaffolding is torn down.
        const agDel = await tx
          .delete(agents)
          .where(inArray(agents.id, agentIdList));
        dependentRows += deletedRowCount(agDel);
      }

      if (candidateUserIds.length > 0) {
        const candGroupRowsTx = await tx
          .select({ id: groups.id })
          .from(groups)
          .where(inArray(groups.ownerId, candidateUserIds));
        const candGroupIdsTx = candGroupRowsTx.map((g) => g.id);

        const acWhereTx =
          candGroupIdsTx.length > 0
            ? or(
                inArray(approvalChallenges.requestedBy, candidateUserIds),
                inArray(approvalChallenges.resolvedBy, candidateUserIds),
                inArray(approvalChallenges.groupId, candGroupIdsTx),
              )
            : or(
                inArray(approvalChallenges.requestedBy, candidateUserIds),
                inArray(approvalChallenges.resolvedBy, candidateUserIds),
              );

        const ac = await tx
          .delete(approvalChallenges)
          .where(acWhereTx);
        dependentRows += deletedRowCount(ac);

        const sa = await tx
          .delete(standingApprovals)
          .where(
            or(
              inArray(standingApprovals.createdBy, candidateUserIds),
              inArray(standingApprovals.actorPattern, candidateUserIds),
            ),
          );
        dependentRows += deletedRowCount(sa);

        const j = await tx
          .delete(jobs)
          .where(
            or(
              inArray(jobs.ownerId, candidateUserIds),
              inArray(jobs.requestorId, candidateUserIds),
            ),
          );
        dependentRows += deletedRowCount(j);

        // profiles were already deleted above, BEFORE the agents delete,
        // to satisfy profiles.agent_id → agents.id (ON DELETE NO ACTION).
        // Do NOT delete profiles here a second time — that would double-
        // count dependent rows and is a no-op anyway.

        const uDel = await tx
          .delete(users)
          .where(inArray(users.id, candidateUserIds));
        deletedUsers = deletedRowCount(uDel);
      }
    });

    humanLog("");
    humanLog(
      `[cleanup] applied: deleted ${deletedUsers} users, ${agentIdList.length} agents (orphan: ${orphanAgentDeleteCount} + test-owned: ${testOwnedAgentDeleteCount}), ~${dependentRows} dependent rows.`,
    );
    humanLog("[cleanup] re-run is a no-op (idempotent).");
    return 0;
  } finally {
    await db.end();
  }
}
