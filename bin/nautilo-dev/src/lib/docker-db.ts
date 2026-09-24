import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { execSync, spawnSync } from "node:child_process";
import { createGunzip } from "node:zlib";
import {
  closeSync,
  createReadStream,
  openSync,
  rmSync,
} from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { buildFullLegacyRoleRepairSql } from "@nautilo/db";
import {
  RESTORE_MIGRATIONS,
  applyCopyHeaderRewrite,
  makePsqlExec,
  parseCopyRows,
} from "./restore-migrations";
import type { DumpRow } from "./restore-migrations";
import { resolveInstanceServiceSecrets } from "./compose-infra";
import { importPostgresDatabaseGzip, queryPostgresContainer } from "./postgres-archive";
import { parseDatabaseMigrationLedger, type MigrationLineageEntry } from "./migration-lineage";
import { assertImportedRestoreLineage } from "./full-dev-restore";

function legacyPostgresContainer(): string {
  return resolveInstance().compose.containers.legacyPostgres;
}

const DB_NAME = "nautilo";
const DB_USER = "postgres";

/**
 * Atomically drop `nautilo`, terminating any lingering sessions (Neon
 * proxy reconnects, app pools, etc.). `WITH (FORCE)` is supported on the
 * pinned pg17 image; a separate `pg_terminate_backend` + plain
 * `DROP DATABASE` pair races reconnects between the two statements.
 * Exported for unit-test inspection.
 */
export const DROP_NAUTILO_DATABASE_SQL = `DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE);`;

/** Post-create isolation grants for the empty `nautilo` DB. Exported for tests. */
export const NAUTILO_DB_POST_CREATE_GRANTS_SQL = `
  REVOKE ALL ON DATABASE ${DB_NAME} FROM PUBLIC;
  GRANT ALL ON DATABASE ${DB_NAME} TO nautilo;
  DO $$
  BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'logto') THEN
      EXECUTE 'REVOKE ALL ON DATABASE ${DB_NAME} FROM logto';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'nautilo_agent') THEN
      EXECUTE 'REVOKE ALL ON DATABASE ${DB_NAME} FROM nautilo_agent';
      EXECUTE 'GRANT CONNECT ON DATABASE ${DB_NAME} TO nautilo_agent';
    END IF;
  END
  $$;
`;

/** Full drop + recreate script run against the `postgres` maintenance DB. */
export function buildDropAndRecreateNautiloDbSql(): string {
  return [
    DROP_NAUTILO_DATABASE_SQL,
    `CREATE DATABASE ${DB_NAME} OWNER nautilo;`,
    NAUTILO_DB_POST_CREATE_GRANTS_SQL,
  ].join("\n");
}

function exec(cmd: string): Buffer {
  return execSync(cmd, { maxBuffer: 512 * 1024 * 1024 });
}

function psql(sql: string, db = DB_NAME): string {
  return exec(
    `docker exec ${legacyPostgresContainer()} psql -U ${DB_USER} -t -A -c ${JSON.stringify(sql)} ${db}`,
  )
    .toString()
    .trim();
}

export function isContainerRunning(): boolean {
  try {
    const out = exec(
      `docker inspect -f '{{.State.Running}}' ${legacyPostgresContainer()} 2>/dev/null`,
    )
      .toString()
      .trim();
    return out === "true";
  } catch {
    return false;
  }
}

/** Write a physical base backup of the full Postgres cluster to a gzipped tar file. */
export function pgBaseBackupTarGzip(outPath: string): void {
  const c = legacyPostgresContainer();
  if (!isContainerRunning()) {
    throw new Error(`Docker container "${c}" is not running. Start with: bun run db:dev`);
  }
  const script = [
    "set -euo pipefail",
    'tmp="$(mktemp -d /tmp/nautilo-basebackup.XXXXXX)"',
    'trap \'rm -rf "$tmp"\' EXIT',
    `pg_basebackup -U ${DB_USER} -D "$tmp" -F tar -X stream`,
    'tar -C "$tmp" -czf - .',
  ].join("; ");
  const outFd = openSync(outPath, "w");
  try {
    const result = spawnSync("docker", ["exec", c, "bash", "-lc", script], {
      stdio: ["ignore", outFd, "inherit"],
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      rmSync(outPath, { force: true });
      throw new Error(`pg_basebackup exited ${result.status ?? "unknown"}`);
    }
  } finally {
    closeSync(outFd);
  }
}

/** Drop and recreate the database (empty). */
export function dropAndCreateDb(): void {
  const c = legacyPostgresContainer();
  if (!isContainerRunning()) {
    throw new Error(`Docker container "${c}" is not running. Start with: bun run db:dev`);
  }
  // Single psql session: FORCE drop terminates reconnect races (Neon proxy)
  // inside the DROP statement instead of between separate shell-outs.
  execSync(`docker exec -i ${c} psql -U ${DB_USER} -v ON_ERROR_STOP=1 postgres`, {
    input: buildDropAndRecreateNautiloDbSql(),
    maxBuffer: 512 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

/**
 * Data-only tables to restore from a snapshot. Each entry names a
 * schema-qualified table that `restoreFromGzip` will attempt to COPY.
 * Tables NOT in this list are IGNORED even if they exist in the dump.
 *
 * Add entries here when a new table is added to the schema AND wants
 * to carry over user data on restore. Do NOT add tables that are
 * re-seeded at boot (e.g. roles) — they are handled by the
 * restore-migration registry if they need special treatment.
 */
export const DATA_TABLES = [
  // Identity roots.
  "public.users",
  // Owner-scoped Claude harness enablement and safe runtime observations.
  "public.claude_connections",
  // M297 — directional Human safety policy. References users in both directions.
  "public.human_blocks",
  "public.agents",
  "public.agent_scopes",
  // M251 — content-free protected AgentScope close receipt + captured items.
  // The operation references users/agents and the items reference it, so keep
  // this exact parent-before-child order. Both must survive an instance move
  // or a partially completed close could be mistaken for a fresh scope.
  "public.agent_scope_close_operations",
  "public.agent_scope_close_items",
  "public.actors",
  "public.profiles",
  // Codex connection state. Account profiles must precede the
  // user/agent preference rows that reference them.
  "public.codex_account_profiles",
  "public.codex_user_preferences",
  // Owned photo metadata first, then selection history that may point
  // at those entries, followed by the owner/agent-scoped operation ledger.
  "public.owned_photo_entries",
  "public.agent_photo_selection_revisions",
  "public.photo_library_operations",
  // Unfinished post-commit blob deletion must survive backup/restore.
  "public.account_deletion_photo_cleanup",
  "public.relay_tokens",
  // Durable controller enrollment, pairing ceremonies, host bindings,
  // and short-lived ordinary-request admissions. Keep this FK-safe order.
  "public.remote_controller_installations",
  "public.remote_pairing_challenges",
  "public.remote_controller_bindings",
  "public.ordinary_request_admissions",
  "public.logto_account_security",
  "public.nautilo_instance_identity",
  "public.credentials",
  "public.recovery_codes",
  "public.channel_identities",
  // M233 — Human-owned notification default. References users only.
  "public.user_notification_settings",
  // Persistent feed references actors/users; recipient state follows its event.
  "public.feed_events",
  "public.feed_recipients",
  // M297 — append-only Mobile agreement history. References users only.
  "public.mobile_user_agreement_acceptances",

  // Trust/catalog seed state. Roles and their joins are restored via
  // boot-time seeds, not old snapshot IDs (see RESTORE_MIGRATIONS).
  "public.capabilities",
  "public.roles",
  "public.role_capabilities",
  "public.groups",
  "public.group_roles",
  "public.group_members",
  // Rollout headers reference their creating user; items reference the
  // header and may reference the committed member. Restore parent first.
  "public.member_rollouts",
  "public.member_rollout_items",

  // Namespaces/rooms before anything that points at rooms.
  "public.namespaces",
  // Provider setup and Human-scoped connection state reference users
  // and namespaces; preserve all three across backup/restore.
  "public.connected_app_provider_configs",
  "public.connected_app_profiles",
  "public.connected_app_oauth_attempts",
  // Personal connected-website profiles reference users only. Persist the
  // opaque provider profile/checkpoint coordinates so restored accounts can
  // be verified, resumed, or explicitly revoked instead of silently lost.
  "public.connected_web_accounts",
  "public.rooms",
  // Restore operation custody and reported activity after all owner,
  // account, Genie, and Room parents; effects precede their operation links.
  "public.connected_web_action_operations",
  "public.connected_web_operations",
  "public.connected_web_operation_activity_entries",
  "public.room_members",
  "public.room_agent_model_control_selections",
  "public.room_silence_state",
  // Room-scoped bindings reference users, rooms, and Codex profiles.
  "public.codex_thread_bindings",
  // M233 — optional Human policy override. References users + rooms.
  "public.room_notification_settings",
  // M297 — bounded report snapshots reference the reporter and Room only;
  // message/person targets deliberately remain stable identifiers without FKs.
  "public.content_reports",

  // MCP server config store (config only; no secrets at rest).
  "public.mcp_servers",

  // Permanent maintenance lease singleton (no FK deps).
  "public.server_maintenance",

  // Memory/session/message substrate.
  "public.memories",
  "public.memory_namespaces",
  "public.message_attachments",
  "public.memory_scopes",
  // M243 — content-free protected Memory revision and operation receipts.
  // Neither table owns product/crypto FKs, but both must survive restore so
  // publication and deletion retries remain exact after an instance move.
  "public.memory_crypto_revisions",
  "public.memory_crypto_operations",
  "public.jobs",
  // Payload-free work-acceptance ledger (FK jobs.id ON DELETE SET NULL).
  "public.work_acceptances",
  "public.sessions",
  "public.session_messages",
  // Content-free deletion receipts have no foreign-key parents and survive the
  // message they record; keep them in every full backup and restore.
  "public.message_deletion_receipts",
  // M313 — durable Message backfill sweep, sparse failure, and resumable Tool
  // correlation state. Actor and Message parents are restored above; the Tool
  // pending rows share Human custody with their parser context.
  "public.message_backfill_scans",
  "public.message_backfill_failures",
  "public.message_backfill_tool_contexts",
  "public.message_backfill_tool_pending_calls",
  "public.memory_review_turns",
  "public.memory_review_receipts",
  // M282 — content-free live Shadow turn receipt. It references Session and
  // Room, and message crypto revisions may reference it, so restore it after
  // the product parents and before the per-Message crypto lifecycle.
  "public.conversation_shadow_turn_operations",
  // M282 follow-up receipts are children of the reserved turn (or bind to the
  // same Session/Room before the turn exists), so restore them after the turn
  // parent and before any linked per-Message crypto rows.
  "public.conversation_shadow_turn_agent_signers",
  "public.conversation_shadow_turn_plan_attempts",
  // M295 — Human-only protected sibling operations are a distinct parent for
  // per-Message lifecycle rows. Device acknowledgements and retry attempts
  // are children of that operation and follow it during restore.
  "public.conversation_human_peer_shadow_operations",
  "public.conversation_human_peer_shadow_acknowledgements",
  "public.conversation_human_peer_shadow_plan_attempts",
  // M296/M298 — shared-Room Human writes and Runtime invocations parent
  // optional Agent executions; ordered execution inputs reference both the
  // Human operation and execution, while plan attempts may link to the Human
  // operation. Message lifecycle rows follow the entire family.
  "public.conversation_shared_agent_shadow_operations",
  "public.conversation_shared_agent_shadow_invocations",
  "public.conversation_shared_agent_shadow_executions",
  "public.conversation_shared_agent_shadow_execution_inputs",
  "public.conversation_shared_agent_shadow_acknowledgements",
  "public.conversation_shared_agent_shadow_plan_attempts",
  // Durable push state. The installation binding owns the encrypted
  // provider token; candidates reference canonical messages; test intents and
  // deliveries both reference the binding. Full backups restore these rows
  // together with the separately protected per-instance encryption key, so
  // none of this lifecycle may silently disappear during restore.
  "public.push_installation_bindings",
  "public.push_message_candidates",
  "public.push_notification_test_intents",
  "public.push_notification_deliveries",
  "public.session_message_crypto_revisions",
  "public.session_message_ordinary_repairs",
  "public.session_message_recipient_state",
  "public.session_message_artifacts",
  // M233 — immutable classification facts. Both reference session_messages;
  // Subthread participation also references rooms + users.
  "public.session_message_directed_recipients",
  "public.subthread_notification_participants",
  "public.message_reactions",
  // M219 — Room-owned derived journal. Restore batches before events because
  // room_events.source_batch_id is a required FK.
  "public.room_journal_state",
  "public.room_journal_batches",
  "public.room_events",
  "public.room_event_rollups",
  // M241 — content-free crypto-first journal publication receipts. Restored
  // after their Room and source-batch parents.
  "public.room_journal_crypto_publications",
  // M257 — dormant Reflection Record graph, immutable representations, and
  // content-free protected publication receipts. Restore FK parents first;
  // publications remain last so exact replay/recovery state survives moves.
  "public.reflection_records",
  "public.reflection_record_dependencies",
  "public.reflection_record_authority_dependencies",
  "public.reflection_record_successors",
  "public.reflection_record_payload_representations",
  "public.reflection_record_payload_representation_heads",
  "public.reflection_record_publications",
  // M267 — content-free native Stenographer cutover and edit-rebuild state.
  // Both tables reference canonical Records; rebuild retirements also refer
  // to Rooms, whose rows are restored earlier.
  "public.room_journal_record_cutover",
  "public.room_journal_record_rebuild_retirements",
  // M258 — rebuildable authority closure/projection and content-free work.
  // Alternatives follow their projection parent; no row stores semantic data.
  "public.reflection_record_authority_closure",
  "public.reflection_record_authority_projections",
  "public.reflection_record_authority_alternatives",
  "public.reflection_record_authority_changes",
  "public.reflection_record_authority_reconciliations",
  "public.reflection_record_authority_blocks",
  // M264 — rebuildable plaintext semantic-search projection. It references
  // only the canonical Record parent and remains safe to restore verbatim;
  // compatibility is checked by its explicit embedding provenance.
  "public.reflection_record_search_projections",
  // M271 — content-free semantic source index, durable repair cursor, replay
  // receipts, and coalesced work. Record-referencing rows follow their parent.
  "public.reflection_record_source_change_repairs",
  // M287 — content-free direct-parent repair cursor. Its changed Record parent
  // is restored above; dependent edges already exist before the worker resumes.
  "public.reflection_record_dependency_change_repairs",
  "public.reflection_record_source_dependency_index",
  "public.reflection_record_semantic_work_admissions",
  "public.reflection_record_semantic_work",
  // Durable thread-responder focus; FKs rooms, actors, session_messages.
  "public.subthread_user_focus",

  // Approval/invite surfaces.
  "public.standing_approvals",
  "public.approval_challenges",
  "public.invites",
  // M260 — per-Human Invite state; both Invite and User parents are earlier.
  "public.invite_redemptions",

  // Files, focus, notifications, artifacts.
  "public.file_revisions",
  "public.focus_events",
  "public.session_notifications",
  "public.server_context_config",
  "public.server_model_config",
  "public.server_profile",
  // M274 — server transition policy, bounded aggregate telemetry, cumulative
  // epoch totals, and unconsumed one-shot observation admissions. These rows
  // are content-free but must survive instance backup and restore.
  "public.encryption_transition_policy",
  "public.encryption_transition_boundary_health",
  "public.encryption_transition_observation_buckets",
  "public.encryption_transition_outcome_totals",
  "public.encryption_transition_observation_admissions",
  // M275 — signed, content-free Browser Room-history read receipts and their
  // exactly-once terminal outcome counts.
  "public.encryption_transition_history_read_admissions",
  // M261 — protected Artifact rows reference their encrypted control object.
  // The object table has no foreign-key parents, so restore it before the
  // mixed legacy/protected Artifact table and omit it from the later crypto
  // block. Blob rows precede revision rows for the exact retained-blob FK.
  "public.crypto_objects",
  "public.artifacts",
  // M322 — immutable exact-operation receipts must survive restore so a retry
  // cannot regrant access. COPY inserts unchanged receipts after all four FK
  // parents (users, actors, memories, artifacts); no trigger bypass is needed.
  "public.content_access_operations",
  // Durable paid-media receipts reference users, a room/namespace
  // pair, and (once ready) an Artifact. Restore after the Artifact parent so
  // restart/recovery state is preserved without weakening foreign keys.
  "public.media_generations",
  // Video project/take links depend on the project Artifact and paid receipt.
  "public.video_generation_links",
  "public.artifact_namespaces",
  "public.artifact_scopes",
  "public.artifact_state",
  "public.artifact_crypto_operations",
  "public.artifact_crypto_blobs",
  "public.artifact_crypto_revisions",
  // Canonical Workspace mutation receipts, per-entry identities, and
  // durable publication outbox. Ordered after artifacts to satisfy FKs.
  "public.workspace_document_mutations",
  "public.workspace_document_mutation_entries",
  "public.workspace_document_mutation_entry_identities",
  "public.workspace_document_mutation_outbox",
  "public.pending_artifact_events",
  "public.provider_catalog_cache",
  // LLM usage metering for costs dashboard. FKs users + rooms (both earlier).
  "public.llm_usage_events",
  // Paid provider/tool cost evidence. FKs users + rooms + agents (all earlier).
  "public.provider_cost_events",
  // Task substrate. Crypto revision ledgers depend only on namespaces and must
  // be restored before the Task/TaskRun rows that point at their current
  // protected representations. The product rows remain after all of their
  // users/agents/rooms/agent_scopes/jobs parents.
  "public.task_definition_crypto_revisions",
  "public.task_run_result_crypto_revisions",
  "public.tasks",
  "public.task_runs",
  // Pending/recoverable Plan input references the Task, run, Job,
  // Room, and Codex binding, so every parent must be restored first.
  "public.codex_user_input_requests",
  // Agent skills. FKs agents + users (both earlier), so safe at the tail.
  "public.skills",
  // Agent slash-commands. FKs agents + users (both earlier), safe at the tail.
  "public.commands",

  // M231 — dormant lattice persistence. Public metadata and opaque
  // ciphertext remain restorable even though no product path can write them
  // while encryption activation is disabled. Parent/head ordering mirrors
  // the generated internal crypto foreign keys.
  "public.crypto_domains",
  "public.crypto_domain_provider_heads",
  "public.namespace_crypto_bindings",
  "public.namespace_crypto_heads",
  "public.object_crypto_access_manifests",
  "public.object_crypto_namespace_envelopes",
  "public.object_crypto_access_heads",
  "public.agent_crypto_runtime_states",
  "public.agent_crypto_runtime_signers",
  "public.agent_crypto_runtime_config_objects",
  "public.agent_crypto_runtime_domain_envelopes",
  "public.agent_crypto_runtime_challenges",
  "public.crypto_grants",
  "public.human_crypto_recovery_archives",
  // M241 — content-free background authorization lifecycle and append-only
  // public processor signer verification evidence.
  "public.background_crypto_authorization_requests",
  // M244 — immutable exact Domain/Namespace authority inventory. Domains must
  // precede Namespaces because the latter bind to the former within a request.
  "public.background_crypto_authorization_domain_requirements",
  "public.background_crypto_authorization_namespace_requirements",
  "public.processor_crypto_signer_authorizations",
  // M232 — durable device custody, recovery, and Delivery Service state.
  // Keep the generated schema's parent-before-child order so COPY restores
  // satisfy every crypto foreign key.
  "public.human_crypto_custodies",
  "public.human_crypto_devices",
  "public.human_crypto_device_challenges",
  "public.human_crypto_recovery_keys",
  // M304 — one MLS-authenticated device group per Human. Heads and pending
  // join requests depend only on custody/device parents; commits depend on the
  // head coordinates; target-only Welcomes depend on commits; acknowledgements
  // depend on current devices. Keep this exact FK-safe restore order.
  "public.human_crypto_device_group_heads",
  "public.human_crypto_device_group_join_requests",
  "public.human_crypto_device_group_commits",
  "public.human_crypto_device_group_welcomes",
  "public.human_crypto_device_group_acknowledgements",
  // M303 — credential-bound device-possession challenges and admissions.
  // Both reference the canonical device generation and Server identity, so
  // they follow those parents; neither is content or Domain-key authority.
  "public.human_crypto_device_admission_challenges",
  "public.human_crypto_device_admissions",
  // M301 — class-bound V2 Domain authority. Operations and heads depend on
  // canonical Domains plus device custody; requests precede the immutable
  // envelopes they may source, and bindings precede their current heads.
  "public.domain_key_publication_operations",
  "public.domain_key_heads",
  "public.domain_key_recipient_requests",
  "public.domain_key_recipient_envelopes",
  "public.domain_key_envelope_acknowledgements",
  "public.namespace_domain_key_bindings",
  "public.namespace_domain_key_heads",
  "public.human_crypto_device_key_packages",
  "public.crypto_domain_devices",
  "public.crypto_delivery_operations",
  "public.crypto_human_membership_transitions",
  "public.crypto_device_epoch_operations",
  "public.crypto_domain_transition_steps",
  "public.crypto_domain_transition_namespaces",
  "public.crypto_delivery_messages",
  "public.crypto_delivery_acknowledgements",
  "public.crypto_operation_outbox",
];

/**
 * Tables with a serial (auto-increment) primary key whose sequence
 * must be reset after COPY-based restore. Migrations create sequences
 * starting at 1; COPY inserts rows with their original IDs but does
 * NOT advance the sequence, causing every subsequent INSERT to
 * collide on the PK and be silently dropped.
 *
 * Fix: after import, call setval() so the sequence is ahead of the
 * max row ID.
 */
export const SERIAL_PK_TABLES: ReadonlyArray<{
  table: string;
  seq: string;
  pkCol: string;
}> = [
  { table: "session_messages", seq: "session_messages_id_seq", pkCol: "id" },
  {
    table: "memory_crypto_revisions",
    seq: "memory_crypto_revisions_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "memory_crypto_operations",
    seq: "memory_crypto_operations_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "artifact_crypto_operations",
    seq: "artifact_crypto_operations_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "artifact_crypto_blobs",
    seq: "artifact_crypto_blobs_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "artifact_crypto_revisions",
    seq: "artifact_crypto_revisions_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "task_definition_crypto_revisions",
    seq: "task_definition_crypto_revisions_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "task_run_result_crypto_revisions",
    seq: "task_run_result_crypto_revisions_sequence_seq",
    pkCol: "sequence",
  },
  {
    table: "agent_scope_close_operations",
    seq: "agent_scope_close_operations_sequence_seq",
    pkCol: "sequence",
  },
  // M134 — focus_events.id is serial; reset its sequence after COPY restore.
  { table: "focus_events", seq: "focus_events_id_seq", pkCol: "id" },
];

/**
 * Restore a gzipped pg_dump using a migration-safe strategy:
 *
 *   1. Drop + recreate DB (empty).
 *   2. Run Drizzle migrations to get the current schema.
 *   3. Re-create the neon_control_plane schema the proxy needs.
 *   4. For each table in DATA_TABLES:
 *        - If the restore-migration registry has a `skipCopy` entry,
 *          skip the COPY entirely (the registry's `postRestore` hook
 *          will hand-insert).
 *        - Otherwise run COPY. If COPY fails, LOG IT LOUDLY (we do not
 *          want silent data loss) and move on.
 *   5. Invoke every registered `postRestore` hook in registry order.
 *   6. Reset serial PK sequences.
 *   7. Restart the neon proxy.
 *
 * LangGraph checkpoint tables (langchain schema) are left to the
 * server's setupCheckpointSaver() — they use custom operators that
 * can't be replicated with plain DDL.
 */
export async function restoreFromGzip(
  gzipPath: string,
  log: (msg: string) => void = console.log,
  options: { fullArchive?: { expectedMigrationLineage: readonly MigrationLineageEntry[] } } = {},
): Promise<void> {
  // Resolve selected-instance credentials before any destructive work. Restore
  // runs outside server startup and cannot rely on its dotenv loading.
  const migrationEnv = buildRestoreMigrationEnv();
  dropAndCreateDb();
  if (options.fullArchive) {
    // Current backups include schema, migration ledger, and all data. Loading
    // them before migrations avoids seed collisions and legacy COPY omissions.
    await importPostgresDatabaseGzip({ container: legacyPostgresContainer(), database: DB_NAME, inputPath: gzipPath });
    const ledger = parseDatabaseMigrationLedger(queryPostgresContainer({
      container: legacyPostgresContainer(), database: DB_NAME,
      sql: "SELECT created_at::text || '|' || hash FROM drizzle.__drizzle_migrations ORDER BY id ASC;",
    }));
    assertImportedRestoreLineage(ledger, options.fullArchive.expectedMigrationLineage);
    repairOwnershipAndGrants(legacyPostgresContainer(), log);
    runRestoreMigrations(log, undefined, migrationEnv);
    rebindRestoredInstanceIdentity(log);
    repairOwnershipAndGrants(legacyPostgresContainer(), log);
    assertRestoreIntegrity(legacyPostgresContainer(), log);
    log("  Complete database archive restored, including its migration ledger.");
    return;
  }
  // Dropping the database removes pgvector. Reuse the canonical privileged
  // repair before migrations, which correctly run as the non-superuser owner.
  repairOwnershipAndGrants(legacyPostgresContainer(), log);

  // CRITICAL: invoke the `packages/db` migration script DIRECTLY (cwd =
  // packages/db) with DB_CONNECTION_STRING in the spawned env — never
  // `bun run db:migrate` from the repo root, which routes through Turbo.
  // The M212 direct-Postgres migration env supplies both DB_DIRECT_CONNECTION
  // and DB_CONNECTION_STRING, so Drizzle targets the named restore DB.
  // Without it, a named source instance using a different port would
  // migrate the WRONG database, leaving the target DB with zero public
  // tables and causing restore to fail at `COPY public.users`.
  runRestoreMigrations(log, undefined, migrationEnv);

  repairOwnershipAndGrants(legacyPostgresContainer(), log);

  psql("CREATE SCHEMA IF NOT EXISTS neon_control_plane;");
  psql(
    "CREATE TABLE IF NOT EXISTS neon_control_plane.endpoints (endpoint_id varchar(255) NOT NULL PRIMARY KEY, allowed_ips varchar(255));",
  );

  // Pre-compute which tables are covered by the restore-migration
  // registry. Tables with `skipCopy: true` get their COPY dropped;
  // all registered tables get their `postRestore` hook invoked after
  // the main COPY loop.
  const skipCopy = new Set(
    RESTORE_MIGRATIONS.filter((r) => r.skipCopy).map((r) => r.table),
  );

  // Tables whose COPY block needs a header rewrite (e.g. a dropped
  // column stripped) but is NOT fully hand-inserted via postRestore.
  const rewriteByTable = new Map(
    RESTORE_MIGRATIONS.filter((r) => r.rewriteCopyHeader && !r.skipCopy).map(
      (r) => [r.table, r] as const,
    ),
  );

  // Extract just the COPY blocks we care about by STREAMING the dump,
  // never materialising it as one string. A full dogfood dump can be
  // multiple GB once decompressed (LangGraph `langchain`-schema
  // checkpoint blobs dominate), which blows past V8/Bun's ~2.1 GB max
  // string length. We only need the allowlisted `public.*` data tables
  // (tens of MB total), so we capture only those line-anchored blocks
  // and stream past everything else.
  const wantedTables = new Set<string>(DATA_TABLES);
  // postRestore hooks read their own table's rows via dumpRowsFor; those
  // tables are all in DATA_TABLES, so wantedTables already covers them.
  const copyBlocks = await extractCopyBlocksStreaming(gzipPath, wantedTables, log);
  const pgContainer = legacyPostgresContainer();

  log("  Importing data from snapshot...");
  let totalRows = 0;
  const skipped: Array<{ table: string; reason: string }> = [];

  for (const table of DATA_TABLES) {
    if (skipCopy.has(table)) {
      const rule = RESTORE_MIGRATIONS.find((r) => r.table === table);
      skipped.push({ table, reason: rule?.reason ?? "skipCopy" });
      continue;
    }

    try {
      // Look up the COPY block captured during the streaming pass.
      let copyBlock = copyBlocks.get(table) ?? null;
      if (!copyBlock) {
        // Dump simply has no data for this table — not an error.
        continue;
      }

      // Apply a registered header rewrite (e.g. strip a dropped column)
      // so the COPY matches today's schema. Value-preserving — only the
      // named columns are removed from the header + each row.
      const rewriteRule = rewriteByTable.get(table);
      if (rewriteRule?.rewriteCopyHeader) {
        const rewritten = applyCopyHeaderRewrite(
          copyBlock,
          rewriteRule.rewriteCopyHeader,
        );
        if (rewritten === null) {
          skipped.push({ table, reason: rewriteRule.reason });
          continue;
        }
        copyBlock = rewritten;
      }

      // ON_ERROR_STOP makes real import failures loud. Do NOT disable
      // triggers/FKs here: the restore table order must be dependency-safe,
      // and seeded tables must be skipped coherently. A FK failure is a
      // restore bug, not something to bypass.
      const out = execSync(
        `docker exec -i ${pgContainer} psql -U ${DB_USER} -v ON_ERROR_STOP=1 ${DB_NAME}`,
        {
          input: copyBlock,
          encoding: "utf8",
          stdio: ["pipe", "pipe", "pipe"],
          maxBuffer: 512 * 1024 * 1024,
        },
      ).trim();

      const match = out.match(/COPY (\d+)/);
      if (match) {
        const count = parseInt(match[1]!, 10);
        if (count > 0) {
          totalRows += count;
          log(`    ${table}: ${count} rows`);
        }
      } else if (out.toLowerCase().includes("error")) {
        // Don't silently swallow — LOUD log so the operator can
        // decide whether to file a restore-migration rule.
        log(`    SKIPPED ${table}: ${out.replace(/\s+/g, " ").slice(0, 200)}`);
        skipped.push({ table, reason: out.slice(0, 200) });
      }
    } catch (err) {
      // ON_ERROR_STOP makes psql exit non-zero on a real failure, which
      // throws here. Surface psql's stderr (the actual SQL error) and
      // abort restore — never a silently-empty table again.
      const e = err as { stderr?: Buffer | string; message?: string };
      const stderr = e.stderr ? e.stderr.toString() : "";
      const msg = (stderr || e.message || String(err)).replace(/\s+/g, " ").trim();
      throw new Error(`Restore COPY failed for ${table}: ${msg.slice(0, 500)}`);
    }
  }

  log(`  Imported ${totalRows} row(s) via COPY.`);

  // Registry post-restore hooks — each handles its own table's
  // shape-change-too-big-for-COPY path.
  const psqlExec = makePsqlExec(pgContainer, DB_NAME);
  for (const rule of RESTORE_MIGRATIONS) {
    if (!rule.postRestore) continue;
    log(`  Applying restore migration: ${rule.table}`);
    try {
      rule.postRestore({
        psqlExec,
        dumpRowsFor: (tableName: string): DumpRow[] =>
          parseCopyRows(copyBlocks.get(tableName) ?? "", tableName),
        log,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Restore migration failed for ${rule.table}: ${msg}`);
    }
  }

  // Reset serial sequences so INSERT doesn't collide with existing row IDs.
  log("  Resetting serial sequences...");
  for (const { table, seq, pkCol } of SERIAL_PK_TABLES) {
    try {
      psql(`SELECT setval('${seq}', COALESCE((SELECT MAX(${pkCol}) FROM ${table}), 1));`);
      log(`    ${seq} reset.`);
    } catch {
      // Table may be empty or sequence may not exist — fine.
    }
  }

  // Loud recap of what didn't restore cleanly, so the operator can
  // decide whether to open an issue.
  if (skipped.length > 0) {
    log("");
    log(`  ${skipped.length} table(s) skipped (see above). Full list:`);
    for (const s of skipped) {
      log(`    - ${s.table}`);
    }
  }

  rebindRestoredInstanceIdentity(log);
  repairOwnershipAndGrants(pgContainer, log);
  assertRestoreIntegrity(pgContainer, log);
}

function resolveNautiloOwnerConnectionString(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const inst = resolveInstance(env);
  const instanceEnvPath = join(resolveNautiloRootDir({ env }), "instance.env");
  const { serviceSecrets } = resolveInstanceServiceSecrets(
    { instanceId: inst.instanceId, instanceEnvPath }, env,
  );
  const password = serviceSecrets.NAUTILO_DB_PASSWORD;
  return `postgresql://nautilo:${encodeURIComponent(password)}@localhost:${inst.db.postgresHostPort}/${DB_NAME}`;
}

/**
 * Env for `bun run db:migrate` during restore. Drizzle (M212 D5) reads
 * `DB_DIRECT_CONNECTION` first; legacy installs may only supply
 * `DB_CONNECTION_STRING`, so both are set to the operator/admin URL.
 * Inherited runtime direct URLs are always overridden.
 */
export function buildRestoreMigrationEnv(
  parentEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const adminUrl = resolveNautiloOwnerConnectionString(parentEnv);
  return {
    ...parentEnv,
    DB_DIRECT_CONNECTION: adminUrl,
    DB_CONNECTION_STRING: adminUrl,
  };
}

/** Spawned-process shape for {@link runRestoreMigrations} (subset of SpawnSyncReturns). */
export type RestoreMigrationSpawnFn = (
  cmd: string,
  args: readonly string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    stdio: readonly ("ignore" | "pipe")[];
    maxBuffer: number;
  },
) => { status: number | null; stdout?: string | Buffer; stderr?: string | Buffer };

/**
 * Apply Drizzle migrations to the restore target DB.
 *
 * Runs `bun run db:migrate` with cwd pinned to `packages/db` and M212's
 * explicit direct/admin migration env. Bypasses the repo-root Turbo wrapper,
 * which does not forward the restore target connection to packages/db.
 */
export function runRestoreMigrations(
  log: (msg: string) => void = console.log,
  spawnFn: RestoreMigrationSpawnFn = spawnSync as unknown as RestoreMigrationSpawnFn,
  parentEnv: NodeJS.ProcessEnv = process.env,
): void {
  const dbPkgDir = join(process.cwd(), "packages", "db");
  log("  Running migrations on clean database...");
  const result = spawnFn("bun", ["run", "db:migrate"], {
    cwd: dbPkgDir,
    env: buildRestoreMigrationEnv(parentEnv),
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 512 * 1024 * 1024,
  });
  if (result.status !== 0) {
    const stderr = (result.stderr ?? "").toString().trim();
    const stdout = (result.stdout ?? "").toString().trim();
    const detail = (stderr || stdout || "no output").replace(/\s+/g, " ").slice(0, 1000);
    throw new Error(`Schema migration failed (exit ${result.status ?? "unknown"}): ${detail}`);
  }
}

function repairOwnershipAndGrants(
  pgContainer: string,
  log: (msg: string) => void = console.log,
): void {
  log("  Repairing DB ownership and app-role grants...");
  execSync(`docker exec -i ${pgContainer} psql -U ${DB_USER} -d ${DB_NAME} -v ON_ERROR_STOP=1`, {
    input: buildFullLegacyRoleRepairSql(),
    maxBuffer: 32 * 1024 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function rebindRestoredInstanceIdentity(log: (msg: string) => void = console.log): void {
  const instanceId = resolveInstance().instanceId;
  const instanceIdLiteral = `'${instanceId.replaceAll("'", "''")}'`;
  psql(
    `INSERT INTO nautilo_instance_identity (id, instance_id) VALUES ('self', ${instanceIdLiteral}) ON CONFLICT (id) DO UPDATE SET instance_id = EXCLUDED.instance_id;`,
  );
  log(`  Rebound database instance identity to ${instanceId === "" ? "(default)" : instanceId}.`);
}

function assertRestoreIntegrity(
  pgContainer: string,
  log: (msg: string) => void = console.log,
): void {
  log("  Validating restored DB ownership, grants, and FK surface...");
  const sql = `
    SELECT 'db_owner', CASE WHEN pg_catalog.pg_get_userbyid(datdba) = 'nautilo' THEN 'ok' ELSE pg_catalog.pg_get_userbyid(datdba) END
    FROM pg_database WHERE datname = 'nautilo'
    UNION ALL
    SELECT 'public_table_owners', CASE WHEN count(*) = 0 THEN 'ok' ELSE count(*)::text END
    FROM pg_tables
    WHERE schemaname = 'public' AND tableowner <> 'nautilo'
    UNION ALL
    SELECT 'nautilo_profiles_select', CASE WHEN has_table_privilege('nautilo', 'public.profiles', 'SELECT') THEN 'ok' ELSE 'missing' END
    UNION ALL
    SELECT 'agent_profiles_select', CASE WHEN has_table_privilege('nautilo_agent', 'public.profiles', 'SELECT') THEN 'ok' ELSE 'missing' END
    UNION ALL
    SELECT 'agent_sessions_select', CASE WHEN has_table_privilege('nautilo_agent', 'public.sessions', 'SELECT') THEN 'ok' ELSE 'missing' END
    UNION ALL
    SELECT 'agent_messages_select', CASE WHEN has_table_privilege('nautilo_agent', 'public.session_messages', 'SELECT') THEN 'ok' ELSE 'missing' END
    UNION ALL
    SELECT 'agent_users_revoked', CASE WHEN has_table_privilege('nautilo_agent', 'public.users', 'SELECT') THEN 'has-raw-users' ELSE 'ok' END
    UNION ALL
    SELECT 'orphan_role_capabilities', count(*)::text
    FROM role_capabilities rc LEFT JOIN roles r ON r.id = rc.role_id
    WHERE r.id IS NULL
    UNION ALL
    SELECT 'orphan_group_roles', count(*)::text
    FROM group_roles gr LEFT JOIN roles r ON r.id = gr.role_id
    WHERE r.id IS NULL
    UNION ALL
    SELECT 'orphan_sessions_room', count(*)::text
    FROM sessions s LEFT JOIN rooms r ON r.id = s.room_id
    WHERE s.room_id IS NOT NULL AND r.id IS NULL
    UNION ALL
    SELECT 'orphan_messages_session', count(*)::text
    FROM session_messages sm LEFT JOIN sessions s ON s.id = sm.session_id
    WHERE s.id IS NULL;
  `;
  const out = execSync(
    `docker exec -i ${pgContainer} psql -U ${DB_USER} -d ${DB_NAME} -t -A -F '|' -v ON_ERROR_STOP=1`,
    {
      input: sql,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    },
  );
  const failures: string[] = [];
  for (const line of out.trim().split("\n")) {
    if (!line.trim()) continue;
    const [name, value] = line.split("|");
    if (!name || value === undefined) continue;
    const isCountCheck = name.startsWith("orphan_");
    const ok = isCountCheck ? value === "0" : value === "ok";
    log(`    ${name}: ${value}`);
    if (!ok) failures.push(`${name}=${value}`);
  }
  if (failures.length > 0) {
    throw new Error(`Post-restore integrity check failed: ${failures.join(", ")}`);
  }
}

/**
 * Stream a gzipped pg_dump and capture ONLY the COPY blocks for the
 * requested tables, returning `table → block` where each block is what
 * psql expects on stdin: the "COPY ... FROM stdin;" header, the
 * tab-separated rows, and the trailing "\\." terminator + newline.
 *
 * Why streaming: a full dogfood dump decompresses to several GB (the
 * `langchain`-schema LangGraph checkpoint blobs dominate), which exceeds
 * V8/Bun's ~2.1 GB max string length — so `gunzip().toString()` throws
 * before we can extract anything. We only need the allowlisted
 * `public.*` data tables (tens of MB), so we read line-by-line off the
 * decompression stream, buffer just the wanted blocks, and skip past
 * everything else without holding it in memory.
 *
 * Header detection is LINE-ANCHORED (the readline boundary guarantees we
 * only inspect line starts), so a literal "COPY public.foo (" embedded
 * in another table's row data can never be mistaken for a real header —
 * pg_dump escapes real newlines in TEXT data as the two chars `\n`.
 */
export async function extractCopyBlocksStreaming(
  gzipPath: string,
  tables: ReadonlySet<string>,
  log: (msg: string) => void = () => {},
): Promise<Map<string, string>> {
  const blocks = new Map<string, string>();
  const headerRe = /^COPY (public\.[A-Za-z0-9_]+) \(/;

  const rl = createInterface({
    input: createReadStream(gzipPath).pipe(createGunzip()),
    crlfDelay: Infinity,
  });

  let current: string | null = null;
  let buf: string[] = [];

  for await (const line of rl) {
    if (current === null) {
      const m = headerRe.exec(line);
      if (m && tables.has(m[1]!) && !blocks.has(m[1]!)) {
        current = m[1]!;
        buf = [line];
      }
      // else: not a wanted header — stream past it (no buffering).
      continue;
    }

    buf.push(line);
    if (line === "\\.") {
      // psql wants header + rows + "\\." + trailing newline.
      blocks.set(current, buf.join("\n") + "\n");
      current = null;
      buf = [];
    }
  }

  if (current !== null) {
    // Truncated dump — a COPY block never terminated. Surface it rather
    // than importing a partial table.
    log(`    WARNING: COPY block for ${current} had no "\\." terminator; dropped.`);
  }

  return blocks;
}
