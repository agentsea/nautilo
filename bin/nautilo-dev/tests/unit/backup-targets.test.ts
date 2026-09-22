import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { DATA_TABLES, SERIAL_PK_TABLES } from "../../src/lib/docker-db";
import { RESTORE_DATA_TABLES } from "../../src/lib/preflight";
import { RESTORE_MIGRATIONS } from "../../src/lib/restore-migrations";

const schemaDir = new URL("../../../../packages/db/src/schema/", import.meta.url);

function collectSchemaTableNames(): string[] {
  const tableNames = new Set<string>();
  for (const entry of readdirSync(schemaDir)) {
    if (!entry.endsWith(".ts") || entry === "index.ts") continue;
    const source = readFileSync(new URL(entry, schemaDir), "utf8");
    const matches = source.matchAll(/pgTable\(\s*["']([^"']+)["']/g);
    for (const match of matches) {
      tableNames.add(`public.${match[1]}`);
    }
  }
  return Array.from(tableNames).sort();
}

describe("backup restore target allowlists", () => {
  test("restores immutable M322 retry receipts unchanged after every foreign-key parent", () => {
    const receipts = "public.content_access_operations";
    const receiptIndex = DATA_TABLES.indexOf(receipts);
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    for (const parent of ["public.users", "public.actors", "public.memories", "public.artifacts"]) {
      const parentIndex = DATA_TABLES.indexOf(parent);
      expect(parentIndex).toBeGreaterThanOrEqual(0);
      expect(parentIndex).toBeLessThan(receiptIndex);
    }
    expect(RESTORE_DATA_TABLES.has(receipts)).toBe(true);
    // The canonical restore recreates the database and COPY-inserts these
    // original terminal rows. A skip/remap would lose or reinterpret retries;
    // immutable UPDATE/DELETE/TRUNCATE guards remain enabled during COPY.
    expect(RESTORE_MIGRATIONS.find((rule) => rule.table === receipts)).toBeUndefined();
  });
  test("restores personal feed events and read state after their parents", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    expect(indexOf("public.actors")).toBeLessThan(indexOf("public.feed_events"));
    expect(indexOf("public.users")).toBeLessThan(indexOf("public.feed_recipients"));
    expect(indexOf("public.feed_events")).toBeLessThan(indexOf("public.feed_recipients"));
  });
  test("restores reverse Message repair receipts after exact protected revisions", () => {
    expect(DATA_TABLES.indexOf("public.session_message_crypto_revisions"))
      .toBeLessThan(DATA_TABLES.indexOf("public.session_message_ordinary_repairs"));
  });
  test("restores M313 Message backfill state after its foreign-key parents", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const scans = "public.message_backfill_scans";
    const failures = "public.message_backfill_failures";
    const contexts = "public.message_backfill_tool_contexts";
    const pending = "public.message_backfill_tool_pending_calls";

    for (const child of [scans, contexts, pending]) {
      expect(indexOf("public.actors")).toBeLessThan(indexOf(child));
    }
    for (const child of [scans, failures]) {
      expect(indexOf("public.session_messages")).toBeLessThan(indexOf(child));
    }
    expect(indexOf(contexts)).toBeLessThan(indexOf(pending));
  });
  test("restores Memory source coverage after its canonical parents", () => {
    for (const parent of ["public.sessions", "public.agents", "public.rooms"]) {
      expect(DATA_TABLES.indexOf(parent)).toBeLessThan(DATA_TABLES.indexOf("public.memory_review_turns"));
    }
  });
  test("restore and preflight cover every current Drizzle schema table", () => {
    const schemaTables = collectSchemaTableNames();

    for (const table of schemaTables) {
      expect(DATA_TABLES).toContain(table);
      expect(RESTORE_DATA_TABLES.has(table)).toBe(true);
    }
    expect([...DATA_TABLES].sort()).toEqual(schemaTables);
    expect([...RESTORE_DATA_TABLES].sort()).toEqual(schemaTables);
  });

  test("restores Task crypto revisions before their mapped product rows", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.task_definition_crypto_revisions")).toBeLessThan(
      indexOf("public.tasks"),
    );
    expect(indexOf("public.task_run_result_crypto_revisions")).toBeLessThan(
      indexOf("public.task_runs"),
    );
  });

  test("advances Task crypto ledger sequences after COPY restore", () => {
    const byTable = new Map(
      SERIAL_PK_TABLES.map((entry) => [entry.table, entry]),
    );

    expect(byTable.get("task_definition_crypto_revisions")).toEqual({
      table: "task_definition_crypto_revisions",
      seq: "task_definition_crypto_revisions_sequence_seq",
      pkCol: "sequence",
    });
    expect(byTable.get("task_run_result_crypto_revisions")).toEqual({
      table: "task_run_result_crypto_revisions",
      seq: "task_run_result_crypto_revisions_sequence_seq",
      pkCol: "sequence",
    });
  });

  test("restores D468 push lifecycle rows after their foreign-key parents", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.users")).toBeLessThan(
      indexOf("public.push_installation_bindings"),
    );
    expect(indexOf("public.session_messages")).toBeLessThan(
      indexOf("public.push_message_candidates"),
    );
    expect(indexOf("public.push_installation_bindings")).toBeLessThan(
      indexOf("public.push_notification_test_intents"),
    );
    expect(indexOf("public.push_installation_bindings")).toBeLessThan(
      indexOf("public.push_notification_deliveries"),
    );
  });

  test("restores connected website accounts after their owning Human", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.users")).toBeLessThan(
      indexOf("public.connected_web_accounts"),
    );
  });

  test("restores connected website operations and activity after their foreign-key parents", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const accounts = "public.connected_web_accounts";
    const actions = "public.connected_web_action_operations";
    const operations = "public.connected_web_operations";
    const activity = "public.connected_web_operation_activity_entries";

    expect(indexOf("public.users")).toBeLessThan(indexOf(actions));
    expect(indexOf(accounts)).toBeLessThan(indexOf(actions));
    for (const parent of ["public.users", "public.agents", "public.rooms", accounts, actions]) {
      expect(indexOf(parent)).toBeLessThan(indexOf(operations));
    }
    expect(indexOf(operations)).toBeLessThan(indexOf(activity));
  });

  test("restores M282 live Shadow turns before linked Message revisions", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const turns = "public.conversation_shadow_turn_operations";
    const signers = "public.conversation_shadow_turn_agent_signers";
    const attempts = "public.conversation_shadow_turn_plan_attempts";

    expect(indexOf("public.sessions")).toBeLessThan(indexOf(turns));
    expect(indexOf("public.rooms")).toBeLessThan(indexOf(turns));
    expect(indexOf(turns)).toBeLessThan(indexOf(signers));
    expect(indexOf(turns)).toBeLessThan(indexOf(attempts));
    expect(indexOf(turns)).toBeLessThan(
      indexOf("public.session_message_crypto_revisions"),
    );
  });

  test("restores M295 Human-peer operations before their children and linked Message revisions", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const operations = "public.conversation_human_peer_shadow_operations";
    const acknowledgements =
      "public.conversation_human_peer_shadow_acknowledgements";
    const attempts = "public.conversation_human_peer_shadow_plan_attempts";

    expect(indexOf("public.sessions")).toBeLessThan(indexOf(operations));
    expect(indexOf("public.rooms")).toBeLessThan(indexOf(operations));
    expect(indexOf(operations)).toBeLessThan(indexOf(acknowledgements));
    expect(indexOf(operations)).toBeLessThan(indexOf(attempts));
    expect(indexOf(operations)).toBeLessThan(
      indexOf("public.session_message_crypto_revisions"),
    );
  });

  test("restores M296/M298 shared-Agent operations, Runtime invocations, and executions before their children and linked Message revisions", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const operations = "public.conversation_shared_agent_shadow_operations";
    const invocations =
      "public.conversation_shared_agent_shadow_invocations";
    const executions = "public.conversation_shared_agent_shadow_executions";
    const inputs =
      "public.conversation_shared_agent_shadow_execution_inputs";
    const acknowledgements =
      "public.conversation_shared_agent_shadow_acknowledgements";
    const attempts = "public.conversation_shared_agent_shadow_plan_attempts";
    const revisions = "public.session_message_crypto_revisions";

    expect(indexOf("public.sessions")).toBeLessThan(indexOf(operations));
    expect(indexOf("public.rooms")).toBeLessThan(indexOf(operations));
    expect(indexOf("public.sessions")).toBeLessThan(indexOf(invocations));
    expect(indexOf("public.rooms")).toBeLessThan(indexOf(invocations));
    expect(indexOf(invocations)).toBeLessThan(indexOf(executions));
    expect(indexOf(operations)).toBeLessThan(indexOf(executions));
    expect(indexOf(operations)).toBeLessThan(indexOf(inputs));
    expect(indexOf(executions)).toBeLessThan(indexOf(inputs));
    expect(indexOf(operations)).toBeLessThan(indexOf(acknowledgements));
    expect(indexOf(operations)).toBeLessThan(indexOf(attempts));
    expect(indexOf(operations)).toBeLessThan(indexOf(revisions));
    expect(indexOf(executions)).toBeLessThan(indexOf(revisions));
  });

  test("restores M301 V2 Domain authority in foreign-key order", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const operations = "public.domain_key_publication_operations";
    const heads = "public.domain_key_heads";
    const requests = "public.domain_key_recipient_requests";
    const envelopes = "public.domain_key_recipient_envelopes";
    const acknowledgements = "public.domain_key_envelope_acknowledgements";
    const bindings = "public.namespace_domain_key_bindings";
    const namespaceHeads = "public.namespace_domain_key_heads";

    expect(indexOf("public.crypto_domains")).toBeLessThan(indexOf(operations));
    expect(indexOf("public.human_crypto_devices")).toBeLessThan(
      indexOf(operations),
    );
    expect(indexOf(operations)).toBeLessThan(indexOf(heads));
    expect(indexOf(heads)).toBeLessThan(indexOf(requests));
    expect(indexOf(requests)).toBeLessThan(indexOf(envelopes));
    expect(indexOf(envelopes)).toBeLessThan(indexOf(acknowledgements));
    expect(indexOf(heads)).toBeLessThan(indexOf(bindings));
    expect(indexOf(bindings)).toBeLessThan(indexOf(namespaceHeads));
  });

  test("restores M303 device admissions after their canonical device parent", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const challenges = "public.human_crypto_device_admission_challenges";
    const admissions = "public.human_crypto_device_admissions";

    expect(indexOf("public.human_crypto_devices")).toBeLessThan(
      indexOf(challenges),
    );
    expect(indexOf("public.human_crypto_devices")).toBeLessThan(
      indexOf(admissions),
    );
    expect(indexOf("public.nautilo_instance_identity")).toBeLessThan(
      indexOf(challenges),
    );
    expect(indexOf("public.nautilo_instance_identity")).toBeLessThan(
      indexOf(admissions),
    );
  });

  test("restores M244 background authority children in foreign-key order", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);
    const parent = "public.background_crypto_authorization_requests";
    const domains =
      "public.background_crypto_authorization_domain_requirements";
    const namespaces =
      "public.background_crypto_authorization_namespace_requirements";

    expect(indexOf(parent)).toBeLessThan(indexOf(domains));
    expect(indexOf(domains)).toBeLessThan(indexOf(namespaces));
  });

  test("restores M251 scope-close operations before their captured items", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.users")).toBeLessThan(
      indexOf("public.agent_scope_close_operations"),
    );
    expect(indexOf("public.agents")).toBeLessThan(
      indexOf("public.agent_scope_close_operations"),
    );
    expect(indexOf("public.agent_scope_close_operations")).toBeLessThan(
      indexOf("public.agent_scope_close_items"),
    );
  });

  test("restores M261 protected Artifact parents before lifecycle references", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.crypto_objects")).toBeLessThan(
      indexOf("public.artifacts"),
    );
    expect(indexOf("public.artifacts")).toBeLessThan(
      indexOf("public.artifact_namespaces"),
    );
    expect(indexOf("public.artifact_crypto_blobs")).toBeLessThan(
      indexOf("public.artifact_crypto_revisions"),
    );
  });

  test("restores Video take links after every foreign-key parent", () => {
    const child = DATA_TABLES.indexOf("public.video_generation_links");
    expect(child).toBeGreaterThanOrEqual(0);
    for (const parent of ["public.users", "public.rooms", "public.namespaces", "public.artifacts", "public.media_generations"]) {
      expect(DATA_TABLES.indexOf(parent)).toBeGreaterThanOrEqual(0);
      expect(DATA_TABLES.indexOf(parent)).toBeLessThan(child);
    }
  });

  test("restores D518 rollout items after their rollout header", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.member_rollouts")).toBeLessThan(
      indexOf("public.member_rollout_items"),
    );
  });

  test("restores M258 authority alternatives after their projection parent", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.reflection_records")).toBeLessThan(
      indexOf("public.reflection_record_authority_projections"),
    );
    expect(indexOf("public.reflection_record_authority_projections")).toBeLessThan(
      indexOf("public.reflection_record_authority_alternatives"),
    );
  });

  test("restores M327 exposure dependencies after their Record parents", () => {
    const records = DATA_TABLES.indexOf("public.reflection_records");
    const dependencies = DATA_TABLES.indexOf(
      "public.reflection_record_authority_dependencies",
    );

    expect(records).toBeGreaterThanOrEqual(0);
    expect(dependencies).toBeGreaterThan(records);
    expect(
      RESTORE_DATA_TABLES.has(
        "public.reflection_record_authority_dependencies",
      ),
    ).toBe(true);
  });

  test("restores M264 search projections after their canonical Record parent", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.reflection_records")).toBeLessThan(
      indexOf("public.reflection_record_search_projections"),
    );
  });

  test("restores M260 Invite redemptions after both foreign-key parents", () => {
    const indexOf = (table: string): number => DATA_TABLES.indexOf(table);

    expect(indexOf("public.users")).toBeLessThan(
      indexOf("public.invite_redemptions"),
    );
    expect(indexOf("public.invites")).toBeLessThan(
      indexOf("public.invite_redemptions"),
    );
  });
});
