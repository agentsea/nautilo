import { CRYPTO_STORAGE_TABLE_NAMES } from "../schema/crypto-storage";
import { DOMAIN_KEY_AUTHORITY_TABLE_NAMES } from "../schema/domain-key-authority";

const TARGET_ROLE = "nautilo_agent";
const TARGET_DB = "nautilo";

export const SENSITIVE_TABLES = [
  "feed_events",
  "feed_recipients",
  "credentials",
  "recovery_codes",
  "logto_account_security",
  "channel_identities",
  // M297 — caller-owned Human safety policy. Agent runtime must neither
  // inspect relationship state nor create/remove blocks.
  "human_blocks",
  // M297 — the Agent runtime must never inspect or alter Human agreement
  // acceptance history.
  "mobile_user_agreement_acceptances",
  // M322 — ordinary content-access operation receipts are product-owned
  // replay history, not Agent runtime authority. Keep them denied after the
  // broad legacy/default grants are reconciled.
  "content_access_operations",
  ...CRYPTO_STORAGE_TABLE_NAMES,
  ...DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
  // M257 — durable Reflection state is product-owned. Organizer/Sleep reach
  // it through the narrow bridge; the agent runtime role never scans or
  // mutates these tables directly. Keep this denial in the role reconciler so
  // its broad legacy grant does not undo the migration finalizer.
  "reflection_records",
  "reflection_record_dependencies",
  "reflection_record_successors",
  "reflection_record_payload_representations",
  "reflection_record_payload_representation_heads",
  "reflection_record_publications",
  // M258 — rebuildable authority projections are likewise product-owned.
  "reflection_record_authority_closure",
  "reflection_record_authority_projections",
  "reflection_record_authority_alternatives",
  "reflection_record_authority_changes",
  "reflection_record_authority_reconciliations",
  "reflection_record_authority_blocks",
  // M264 — semantic-search projections are product-owned rebuildable state.
  // The runtime searches them only through the authority-filtering bridge.
  "reflection_record_search_projections",
  // M274 — aggregate transition observations are product control-plane state,
  // never Agent runtime authority. The structural policy row is separately
  // SELECT-only so runtime publication transactions can fence their revision.
  "encryption_transition_observation_buckets",
  "encryption_transition_outcome_totals",
  "encryption_transition_observation_admissions",
  "encryption_transition_history_read_admissions",
  // M313 — device backlog discovery is product-owned, never an Agent task source.
  "message_backfill_scans",
  "message_backfill_failures",
  "message_backfill_tool_contexts",
  "message_backfill_tool_pending_calls",
  // M295 — Human-peer protected lifecycle and device acknowledgements are
  // product-owned. The Agent role has no part in a zero-Agent Room.
  "conversation_human_peer_shadow_operations",
  "conversation_human_peer_shadow_acknowledgements",
  "conversation_human_peer_shadow_plan_attempts",
  // M271 — semantic scheduling, replay receipts, and source-dependency
  // commitments are product-owned control state. Broad legacy role repair
  // must not undo the migration's product-only boundary.
  "reflection_record_semantic_work",
  "reflection_record_semantic_work_admissions",
  "reflection_record_dependency_change_repairs",
  "reflection_record_source_change_repairs",
  "reflection_record_source_dependency_index",
  // M267 — cutover/rebuild coordinates are product-owned control state. The
  // Runtime reaches them through the Stenographer bridge, never by scanning.
  "room_journal_record_cutover",
  "room_journal_record_rebuild_retirements",
] as const;

export const AGENT_SELECT_ONLY_TABLES = [
  "encryption_transition_policy",
] as const;

/** M233 — Human-owned policy is never visible through the agent runtime role. */
export const AGENT_DENIED_NOTIFICATION_TABLES = [
  "user_notification_settings",
  "room_notification_settings",
] as const;

/**
 * M233 — immutable append facts need only conflict-aware reads and inserts.
 * Cleanup is FK-owned; historical materialization uses the application role.
 */
export const AGENT_APPEND_NOTIFICATION_TABLES = [
  "session_message_directed_recipients",
  "subthread_notification_participants",
] as const;

// D219 — `server_role` dropped (capability-derived authority is now the
// only RBAC axis); the agent-facing view no longer exposes it.
export const USERS_PUBLIC_VIEW_COLUMNS = [
  "id",
  "handle",
  "name",
  "server",
  "created_at",
  "updated_at",
] as const;

/**
 * LangGraph `PostgresSaver` checkpoint tables, created in the `langchain`
 * schema by `PostgresSaver.setup()` (see
 * `packages/agent/src/checkpoints/checkpoint-saver.ts`). The agent runtime
 * reads/writes these as `nautilo_agent`; without `USAGE` on the schema +
 * DML on the tables, runtime integration fails with
 * `permission denied for schema langchain`.
 *
 * Stack 198 — `checkpoint_migrations` is INTENTIONALLY ABSENT from this
 * list. That table is DDL bookkeeping owned by whichever role ran
 * `setup()` (commonly `postgres` via `DB_DIRECT_CONNECTION`). Granting
 * the agent runtime DML on it would be an unnecessary privilege
 * expansion — the runtime never reads or writes migration state; only
 * `setup()` does, over the setup pool. Do not add it unless a future
 * change proves the runtime needs it.
 */
export const LANGCHAIN_CHECKPOINT_TABLES = [
  "checkpoints",
  "checkpoint_blobs",
  "checkpoint_writes",
] as const;

/**
 * Narrow idempotent grant block for the langchain (LangGraph
 * `PostgresSaver`) checkpoint schema, granting the `nautilo_agent`
 * runtime role exactly what it needs to get/put/putWrites/list:
 * `USAGE` on the schema + DML on the three checkpoint tables, plus
 * defensive sequence access. No `checkpoint_migrations`, no
 * `ALTER DEFAULT PRIVILEGES`.
 *
 * Reused by:
 *   - `PostgresSaver.setup()` boot path
 *     (`packages/agent/src/checkpoints/checkpoint-saver.ts`), which runs
 *     this over the short-lived setup pool immediately after
 *     `setup()` creates/migrates the schema; AND
 *   - the operator repair path (`buildAgentRoleGrantsSql()` below), so
 *     `nautilo-dev migrate-add-agent-role --apply` reconciles an
 *     existing cluster without a server boot.
 *
 * Conditional: the schema/tables are created lazily by
 * `PostgresSaver.setup()`, so they may not exist yet when this block
 * runs (first-boot / pre-`setup()` path). Grants against them are
 * gated on existence with skip notices. No `DROP`/`CREATE SCHEMA` —
 * this block never mutates structure, only privileges.
 *
 * Stack 198 — no `ALTER DEFAULT PRIVILEGES FOR ROLE nautilo` here. The
 * setup owner may be `postgres` (when `DB_DIRECT_CONNECTION` points at
 * the superuser), in which case `FOR ROLE nautilo` defaults would not
 * cover objects `setup()` creates. Explicit post-setup grants on the
 * tables that now exist are authoritative, and `setup()` re-runs
 * idempotently on every boot, so the grants stay correct without
 * relying on default-privilege inheritance.
 */
export function buildLangchainCheckpointRoleGrantsSql(): string {
  const checkpointTableArrayLiteral = LANGCHAIN_CHECKPOINT_TABLES.map(
    (t) => `'${t}'`,
  ).join(",");

  return `
-- langchain schema (LangGraph PostgresSaver checkpoints). The agent
-- runtime connects as ${TARGET_ROLE} and reads/writes these checkpoint
-- tables; without USAGE on the schema + DML on the tables, runtime
-- integration fails with 'permission denied for schema langchain'.
-- Conditional: the schema/tables are created by PostgresSaver.setup()
-- at runtime, so they may not exist yet when this block runs. Skip
-- safely with notices in that case; do NOT grant unrelated schemas.
DO $$
DECLARE
  checkpoint_tables text[] := ARRAY[${checkpointTableArrayLiteral}];
  tbl text;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_namespace WHERE nspname = 'langchain'
  ) THEN
    RAISE NOTICE 'D129 P3: skipping langchain schema grants (schema does not exist — PostgresSaver.setup() has not run yet)';
    RETURN;
  END IF;

  EXECUTE 'GRANT USAGE ON SCHEMA langchain TO ${TARGET_ROLE}';

  FOREACH tbl IN ARRAY checkpoint_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = tbl AND n.nspname = 'langchain' AND c.relkind IN ('r', 'p')
    ) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE langchain.%I TO ${TARGET_ROLE}', tbl
      );
      RAISE NOTICE 'D129 P3: granted ${TARGET_ROLE} DML on langchain.%', tbl;
    ELSE
      RAISE NOTICE 'D129 P3: skipping langchain.% (table does not exist — PostgresSaver.setup() has not created it yet)', tbl;
    END IF;
  END LOOP;

  -- Sequences in langchain schema. LangGraph uses VARCHAR primary keys
  -- today so none exist; grant defensively in case PostgresSaver adds
  -- one. No-op when there are none.
  EXECUTE 'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA langchain TO ${TARGET_ROLE}';
END $$;
`.trim();
}

/**
 * Reconcile the exact M233 notification privilege boundary after the broad
 * public-table defaults have run. Conditional table probes keep first boot and
 * pre-migration repair idempotent.
 */
export function buildNotificationIntelligenceRoleGrantsSql(): string {
  const deniedTables = AGENT_DENIED_NOTIFICATION_TABLES.map(
    (table) => `'${table}'`,
  ).join(",");
  const appendTables = AGENT_APPEND_NOTIFICATION_TABLES.map(
    (table) => `'${table}'`,
  ).join(",");

  return `
-- M233 notification intelligence. Preference tables are Human-owned policy;
-- append facts expose only the SELECT/INSERT needed by canonical persistence.
DO $$
DECLARE
  denied_tables text[] := ARRAY[${deniedTables}];
  append_tables text[] := ARRAY[${appendTables}];
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY denied_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${TARGET_ROLE}', tbl);
    END IF;
  END LOOP;

  FOREACH tbl IN ARRAY append_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${TARGET_ROLE}', tbl);
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO ${TARGET_ROLE}', tbl
      );
    END IF;
  END LOOP;
END $$;
`.trim();
}

/**
 * Reconcile the M243 Memory crypto lifecycle tables after the broad legacy
 * public-schema grant. These tables intentionally expose only append access
 * plus the bounded lifecycle columns used by the coordinator. In particular,
 * DELETE and immutable identity updates must remain unavailable.
 */
export function buildMemoryCryptoLifecycleRoleGrantsSql(): string {
  return `
-- M243/M320 Memory crypto lifecycle. Remove both table-level and historical
-- column-level UPDATE grants before restoring the exact coordinator contract.
DO $$
DECLARE
  tbl text;
  update_columns text;
BEGIN
  FOREACH tbl IN ARRAY ARRAY['memory_crypto_revisions', 'memory_crypto_operations'] LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE public.%I FROM ${TARGET_ROLE}', tbl);
      SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum)
        INTO update_columns
        FROM pg_attribute
       WHERE attrelid = to_regclass(format('public.%I', tbl))
         AND attnum > 0
         AND NOT attisdropped;
      IF update_columns IS NOT NULL THEN
        EXECUTE format(
          'REVOKE UPDATE (%s) ON TABLE public.%I FROM ${TARGET_ROLE}',
          update_columns,
          tbl
        );
      END IF;
      EXECUTE format(
        'GRANT SELECT, INSERT ON TABLE public.%I TO ${TARGET_ROLE}', tbl
      );
      -- Upgrade and old-bundle restore reconcile grants before migrations.
      -- Keep the coordinator allowlist, granting only columns already present.
      SELECT string_agg(format('%I', attname), ', ' ORDER BY attnum)
        INTO update_columns
        FROM pg_attribute
       WHERE attrelid = to_regclass(format('public.%I', tbl))
         AND attnum > 0
         AND NOT attisdropped
         AND attname = ANY (ARRAY[
           'completion', 'disposition', 'attempt_count', 'next_attempt_at',
           'lease_token', 'lease_expires_at', 'failure_code',
           'crypto_completed_at', 'updated_at', 'semantic_change_kind'
         ])
         AND (attname <> 'semantic_change_kind' OR tbl = 'memory_crypto_operations');
      IF update_columns IS NOT NULL THEN
        EXECUTE format(
          'GRANT UPDATE (%s) ON TABLE public.%I TO ${TARGET_ROLE}',
          update_columns,
          tbl
        );
      END IF;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.memory_crypto_revisions_sequence_seq') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON SEQUENCE public.memory_crypto_revisions_sequence_seq
      FROM PUBLIC, nautilo_agent, nautilo_crypto;
    GRANT USAGE ON SEQUENCE public.memory_crypto_revisions_sequence_seq
      TO nautilo_agent;
  END IF;
  IF to_regclass('public.memory_crypto_operations_sequence_seq') IS NOT NULL THEN
    REVOKE ALL PRIVILEGES ON SEQUENCE public.memory_crypto_operations_sequence_seq
      FROM PUBLIC, nautilo_agent, nautilo_crypto;
    GRANT USAGE ON SEQUENCE public.memory_crypto_operations_sequence_seq
      TO nautilo_agent;
  END IF;
END $$;
`.trim();
}

/**
 * Idempotent SQL block that mirrors `infra/postgres-init.sh`'s
 * agent-role provisioning (block 2 + 3). Does NOT create the role
 * (the init script handles that on first volume boot, and the
 * operator-repair path in `migrate-add-agent-role.ts` does it via a
 * separate step that has access to the password). Safe to re-run
 * inside the `nautilo` database after migrations have populated the
 * schema.
 */
export function buildAgentRoleGrantsSql(): string {
  const userPublicColumns = USERS_PUBLIC_VIEW_COLUMNS.join(", ");
  const sensitiveTableArrayLiteral = SENSITIVE_TABLES.map((t) => `'${t}'`).join(",");
  const selectOnlyTableArrayLiteral = AGENT_SELECT_ONLY_TABLES.map((t) => `'${t}'`).join(",");

  return `
GRANT USAGE ON SCHEMA public TO ${TARGET_ROLE};

-- Default privileges for FUTURE tables created by the nautilo owner.
ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${TARGET_ROLE};
ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${TARGET_ROLE};

-- Existing tables — populated DB path.
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${TARGET_ROLE};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${TARGET_ROLE};

-- REVOKE on credential-class tables (idempotent: pg_class lookup gates).
DO $$
DECLARE
  sensitive_tables text[] := ARRAY[${sensitiveTableArrayLiteral}];
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY sensitive_tables LOOP
    IF EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = tbl AND n.nspname = 'public' AND c.relkind = 'r'
    ) THEN
      EXECUTE format(
        'REVOKE ALL ON TABLE public.%I FROM ${TARGET_ROLE}', tbl
      );
      RAISE NOTICE 'D129 P3: revoked ${TARGET_ROLE} grants on %', tbl;
    ELSE
      RAISE NOTICE 'D129 P3: skipping % (table does not exist)', tbl;
    END IF;
  END LOOP;
END $$;

-- Structural publication-fence policy reads. Revoke the broad legacy DML
-- grant first, then restore SELECT only; the Agent role never mutates policy.
DO $$
DECLARE
  select_only_tables text[] := ARRAY[${selectOnlyTableArrayLiteral}];
  tbl text;
BEGIN
  FOREACH tbl IN ARRAY select_only_tables LOOP
    IF to_regclass(format('public.%I', tbl)) IS NOT NULL THEN
      EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${TARGET_ROLE}', tbl);
      EXECUTE format('GRANT SELECT ON TABLE public.%I TO ${TARGET_ROLE}', tbl);
    END IF;
  END LOOP;
END $$;

-- users_public view (created if users table exists).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'users' AND n.nspname = 'public' AND c.relkind = 'r'
  ) THEN
    EXECUTE 'CREATE OR REPLACE VIEW public.users_public AS SELECT ${userPublicColumns} FROM public.users';
    EXECUTE 'GRANT SELECT ON public.users_public TO ${TARGET_ROLE}';
    EXECUTE 'REVOKE ALL ON TABLE public.users FROM ${TARGET_ROLE}';
    RAISE NOTICE 'D129 P3: created users_public view + grants';
  ELSE
    RAISE NOTICE 'D129 P3: skipping users_public view (users table does not exist)';
  END IF;
END $$;

${buildNotificationIntelligenceRoleGrantsSql()}

${buildMemoryCryptoLifecycleRoleGrantsSql()}

-- M319: role repair must not broaden Memory coverage or receipt mutation.
DO $$
BEGIN
  IF to_regclass('public.memory_review_turns') IS NOT NULL THEN
    REVOKE ALL ON public.memory_review_turns FROM nautilo_agent;
    GRANT SELECT, INSERT, UPDATE ON public.memory_review_turns TO nautilo_agent;
  END IF;
  IF to_regclass('public.memory_review_receipts') IS NOT NULL THEN
    REVOKE ALL ON public.memory_review_receipts FROM nautilo_agent;
    GRANT SELECT, INSERT ON public.memory_review_receipts TO nautilo_agent;
  END IF;
END $$;

-- langchain checkpoint grants — shared with the boot-time setup path.
-- See buildLangchainCheckpointRoleGrantsSql() for the narrow contract.
${buildLangchainCheckpointRoleGrantsSql()}
`;
}

export function getAgentRoleConstants() {
  return {
    targetRole: TARGET_ROLE,
    targetDb: TARGET_DB,
    sensitiveTables: SENSITIVE_TABLES,
    agentSelectOnlyTables: AGENT_SELECT_ONLY_TABLES,
    agentDeniedNotificationTables: AGENT_DENIED_NOTIFICATION_TABLES,
    agentAppendNotificationTables: AGENT_APPEND_NOTIFICATION_TABLES,
    usersPublicViewColumns: USERS_PUBLIC_VIEW_COLUMNS,
    langchainCheckpointTables: LANGCHAIN_CHECKPOINT_TABLES,
  };
}
