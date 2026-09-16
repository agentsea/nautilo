import postgres from "postgres";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  __resetResolvedInstanceForTests,
  parseNautiloInstanceId,
  resolveInstance,
} from "@nautilo/config";
import { nautiloInstanceIdentity } from "../schema/instance-identity";

const DEFAULT_INSTANCE_ALIASES = new Set(["default", "(default)"]);

const DB_IDENTITY_ROW_ID = "self";
export const DB_CONNECTION_OVERRIDE_KEYS = [
  "DB_DIRECT_CONNECTION",
  "DB_CONNECTION_STRING",
  "DB_AGENT_DIRECT_CONNECTION",
  "DB_AGENT_CONNECTION_STRING",
  "NAUTILO_DB_PASSWORD",
  "NAUTILO_AGENT_DB_PASSWORD",
  "NAUTILO_DB_PORT",
] as const;

/**
 * Evidence that a protected default DB has had operator/user life before.
 * Used only when `users=0` to decide whether seedDefaultOwner is allowed
 * to create a fresh bootstrap owner.
 *
 * Intentionally EXCLUDES migration/boot-seeded catalog tables like
 * roles/capabilities/role_capabilities/groups/group_roles/group_members:
 * those exist on a genuinely fresh install after migrations and would
 * false-positive the first boot.
 */
export const DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES = [
  "langchain.checkpoints",
  "langchain.checkpoint_blobs",
  "langchain.checkpoint_writes",
  "public.actors",
  "public.agent_scopes",
  "public.agents",
  "public.approval_challenges",
  "public.artifact_namespaces",
  "public.artifact_scopes",
  "public.artifact_state",
  "public.artifacts",
  "public.workspace_document_mutations",
  "public.workspace_document_mutation_entries",
  "public.workspace_document_mutation_entry_identities",
  "public.workspace_document_mutation_outbox",
  "public.channel_identities",
  "public.credentials",
  "public.file_revisions",
  "public.focus_events",
  "public.invites",
  "public.jobs",
  "public.logto_account_security",
  "public.memories",
  "public.memory_namespaces",
  "public.memory_scopes",
  "public.message_attachments",
  "public.message_reactions",
  "public.pending_artifact_events",
  "public.profiles",
  "public.provider_catalog_cache",
  "public.recovery_codes",
  "public.relay_tokens",
  "public.room_members",
  "public.room_silence_state",
  "public.rooms",
  "public.server_context_config",
  "public.server_model_config",
  "public.server_profile",
  "public.session_message_recipient_state",
  "public.session_messages",
  "public.session_notifications",
  "public.sessions",
  "public.skills",
  "public.standing_approvals",
  "public.task_runs",
  "public.tasks",
] as const;

export type DbConnectionOverrideKey = (typeof DB_CONNECTION_OVERRIDE_KEYS)[number];

export interface DbIdentityCheckResult {
  expectedInstanceId: string;
  actualInstanceId: string;
  initialized: boolean;
}

/**
 * Pure decision for what a stamp attempt should do, given the observed
 * DB state. Extracted so the branch logic is exhaustively unit-testable
 * without a live Postgres (same discipline as `shouldAutoHealScratchDb`).
 *
 * - `skip-unverified`: table missing, OR row absent and we cannot prove
 *   this connection belongs to the resolved instance → do not stamp.
 * - `noop-matches`: row present and already equals the expected id.
 * - `throw-mismatch`: row present but names a DIFFERENT instance → the
 *   connection points at the wrong DB; fail loud.
 * - `insert`: row absent and either trusted (deploy config) or the
 *   connection provably matches the resolved instance.
 */
export type InstanceIdentityAction =
  | "insert"
  | "noop-matches"
  | "skip-unverified"
  | "throw-mismatch";

export function decideInstanceIdentityAction(params: {
  tableExists: boolean;
  rowExists: boolean;
  actualInstanceId: string | null;
  expectedInstanceId: string;
  trustConnection: boolean;
  connectionMatches: boolean;
}): InstanceIdentityAction {
  if (!params.tableExists) return "skip-unverified";
  if (params.rowExists) {
    const actual = normalizeInstanceId(params.actualInstanceId ?? "");
    return actual === params.expectedInstanceId ? "noop-matches" : "throw-mismatch";
  }
  if (params.trustConnection || params.connectionMatches) return "insert";
  return "skip-unverified";
}

type PostgresConnection = ReturnType<typeof postgres>;

function normalizeInstanceId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === "") return "";
  return DEFAULT_INSTANCE_ALIASES.has(trimmed.toLowerCase()) ? "" : trimmed;
}

export function resolveExpectedDbInstanceId(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return normalizeInstanceId(parseNautiloInstanceId(env));
}

function envWithoutConnectionOverrides(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const next = { ...env };
  for (const key of DB_CONNECTION_OVERRIDE_KEYS) {
    delete next[key];
  }
  return next;
}

export function listDbConnectionOverrides(
  env: NodeJS.ProcessEnv = process.env,
): DbConnectionOverrideKey[] {
  return DB_CONNECTION_OVERRIDE_KEYS.filter((key) => Boolean(env[key]?.trim()));
}

export function clearDbConnectionOverrides(
  env: NodeJS.ProcessEnv = process.env,
): DbConnectionOverrideKey[] {
  const cleared = listDbConnectionOverrides(env);
  for (const key of cleared) {
    delete env[key];
  }
  return cleared;
}

export function resolveExpectedDirectConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  // resolveInstance is process-cached; clear before resolving the sanitized
  // env so a stale NAUTILO_DB_PORT override cannot make "expected" equal
  // the poisoned active connection. Clear again afterwards so the sanitized
  // result does not leak into the cache and silently drop a legitimate
  // override for later resolveInstance() callers in this process.
  __resetResolvedInstanceForTests();
  try {
    return resolveInstance(envWithoutConnectionOverrides(env)).db.directConnection;
  } finally {
    __resetResolvedInstanceForTests();
  }
}

export function assertDirectConnectionMatchesInstance(
  directConnection: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const expectedInstanceId = resolveExpectedDbInstanceId(env);
  const expectedConnection = resolveExpectedDirectConnectionString(env);
  if (directConnection === expectedConnection) return;

  const overrides = listDbConnectionOverrides(env);
  throw new Error(
    `[D374] Refusing DB operation: resolved instance ${formatInstance(expectedInstanceId)} ` +
      `expects ${redactConnection(expectedConnection)}, but the active direct connection is ` +
      `${redactConnection(directConnection)}. Connection override(s): ` +
      `${overrides.length > 0 ? overrides.join(", ") : "none"}. ` +
      `Clear stale DB_* / NAUTILO_DB_PORT overrides or target the correct instance.`,
  );
}

/**
 * Boot-path identity check. Verifies the connected DB's self-identity
 * marker against the env-resolved instance id and throws on mismatch
 * (the marker is ground truth — a mismatch means the connection points
 * at a different instance's DB than the process believes).
 *
 * Deliberately does NOT hard-require connection-string equality on the
 * host path: flows like smoke scripts and deploy-config legitimately
 * override `NAUTILO_DB_PORT` / `DB_DIRECT_CONNECTION`. The marker row is
 * only STAMPED when either (a) `trustConnection` is set — the caller's
 * connection is authoritative, as in deploy/container mode where
 * `DB_DIRECT_CONNECTION` is the operator-configured truth — or (b) the
 * active connection provably equals the env-resolved instance
 * connection. So a poisoned override can never mis-stamp a foreign DB,
 * and an unstamped DB behind a legit host override stays unstamped until
 * a clean boot. Strict connection equality is enforced separately on the
 * destructive heal path (`assertDirectConnectionMatchesInstance`).
 *
 * A present marker that names a DIFFERENT instance always throws, in
 * both modes — that is the core "wrong DB" tripwire.
 */
export async function ensureConnectedDbIdentity(
  directConnection: string,
  env: NodeJS.ProcessEnv = process.env,
  opts: { trustConnection?: boolean } = {},
): Promise<DbIdentityCheckResult> {
  const expectedInstanceId = resolveExpectedDbInstanceId(env);
  const trustConnection = opts.trustConnection === true;

  const sql = postgres(directConnection, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);
  try {
    const tableExists = await identityTableExists(sql);

    let rowExists = false;
    let actualRaw: string | null = null;
    if (tableExists) {
      const rows = await db.select({
        instanceId: nautiloInstanceIdentity.instanceId,
      }).from(nautiloInstanceIdentity).where(eq(
        nautiloInstanceIdentity.id,
        DB_IDENTITY_ROW_ID,
      )).limit(1);
      if (rows.length > 0) {
        rowExists = true;
        actualRaw = rows[0]?.instanceId ?? "";
      }
    }

    // Only resolve the expected connection (which touches the
    // resolveInstance cache) when we might actually insert.
    let connectionMatches = false;
    if (tableExists && !rowExists && !trustConnection) {
      connectionMatches =
        directConnection === resolveExpectedDirectConnectionString(env);
    }

    const action = decideInstanceIdentityAction({
      tableExists,
      rowExists,
      actualInstanceId: actualRaw,
      expectedInstanceId,
      trustConnection,
      connectionMatches,
    });

    switch (action) {
      case "throw-mismatch":
        throw new Error(
          `[D374] Refusing DB operation: connected DB self-identifies as ` +
            `${formatInstance(normalizeInstanceId(actualRaw ?? ""))}, but env resolved to ` +
            `${formatInstance(expectedInstanceId)}.`,
        );
      case "noop-matches":
        return {
          expectedInstanceId,
          actualInstanceId: normalizeInstanceId(actualRaw ?? ""),
          initialized: false,
        };
      case "insert":
        await db.insert(nautiloInstanceIdentity).values({
          id: DB_IDENTITY_ROW_ID,
          instanceId: expectedInstanceId,
        });
        return {
          expectedInstanceId,
          actualInstanceId: expectedInstanceId,
          initialized: true,
        };
      case "skip-unverified":
      default:
        return {
          expectedInstanceId,
          actualInstanceId: tableExists ? "(unstamped)" : "(identity-table-missing)",
          initialized: false,
        };
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/**
 * Destructive-path marker assert: reads the connected DB's identity
 * marker and throws when it exists and names a DIFFERENT instance than
 * the env resolves to. Silent when the marker table/row is absent
 * (pre-0094 scratch DBs being healed). Used by `healScratchDatabase`
 * as the last line before `DROP SCHEMA`.
 */
export async function assertConnectedDbMarkerMatches(
  directConnection: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const expectedInstanceId = resolveExpectedDbInstanceId(env);
  const sql = postgres(directConnection, { max: 1, onnotice: () => {} });
  const db = drizzle(sql);
  try {
    const exists = await identityTableExists(sql);
    if (!exists) return;
    const rows = await db.select({
      instanceId: nautiloInstanceIdentity.instanceId,
    }).from(nautiloInstanceIdentity).where(eq(
      nautiloInstanceIdentity.id,
      DB_IDENTITY_ROW_ID,
    )).limit(1);
    if (rows.length === 0) return;
    const actualInstanceId = normalizeInstanceId(rows[0]?.instanceId ?? "");
    if (actualInstanceId !== expectedInstanceId) {
      throw new Error(
        `[D374] Refusing destructive DB operation: connected DB self-identifies as ` +
          `${formatInstance(actualInstanceId)}, but env resolved to ` +
          `${formatInstance(expectedInstanceId)}.`,
      );
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function hasDefaultPriorLifeEvidence(
  directConnection: string,
): Promise<string[]> {
  const sql = postgres(directConnection, { max: 1, onnotice: () => {} });
  try {
    const found: string[] = [];
    for (const table of DEFAULT_PRIOR_LIFE_EVIDENCE_TABLES) {
      const exists = await relationExists(sql, table);
      if (!exists) continue;
      const rows = (await sql.unsafe(
        `SELECT EXISTS (SELECT 1 FROM ${table} LIMIT 1) AS has_rows`,
      )) as unknown as Array<{ has_rows: boolean }>;
      if (rows[0]?.has_rows) found.push(table);
    }
    return found;
  } finally {
    await sql.end({ timeout: 5 });
  }
}

export async function assertCanCreateBootstrapOwner(
  directConnection: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const expectedInstanceId = resolveExpectedDbInstanceId(env);
  if (expectedInstanceId !== "") return;

  const evidence = await hasDefaultPriorLifeEvidence(directConnection);
  if (evidence.length === 0) return;

  throw new Error(
    `[D374] Refusing to create a fresh default owner: protected (default) DB ` +
      `has users=0 but prior-life evidence exists (${evidence.join(", ")}). ` +
      `This indicates a schema/table reset; restore or investigate instead of reseeding.`,
  );
}

async function identityTableExists(sql: PostgresConnection): Promise<boolean> {
  return relationExists(sql, "public.nautilo_instance_identity");
}

async function relationExists(sql: PostgresConnection, qualified: string): Promise<boolean> {
  const [schemaName, tableName] = qualified.split(".");
  if (!schemaName || !tableName) return false;
  const rows = (await sql`
    SELECT to_regclass(${`${schemaName}.${tableName}`}) IS NOT NULL AS exists
  `) as unknown as Array<{ exists: boolean }>;
  return Boolean(rows[0]?.exists);
}

function formatInstance(instanceId: string): string {
  return instanceId === "" ? "(default)" : instanceId;
}

function redactConnection(connection: string): string {
  try {
    const url = new URL(connection);
    if (url.password) url.password = "REDACTED";
    if (url.username) url.username = url.username ? "USER" : "";
    return url.toString();
  } catch {
    return connection.replace(/:\/\/([^:@]+):([^@]+)@/, "://USER:REDACTED@");
  }
}
