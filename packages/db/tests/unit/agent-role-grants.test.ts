/**
 * Unit tests for `agent-role-grants.ts` SQL shape — D129 P3 (Stack 11.5)
 * + Stack 198 langchain checkpoint grants.
 *
 * Pure SQL-shape assertions: no live Postgres. Verifies that the
 * idempotent grant block:
 *   - preserves the public-schema grants + users_public view contract,
 *   - revokes the sensitive credential-class tables,
 *   - conditionally grants USAGE + DML on the langchain checkpoint
 *     tables when the schema exists, and skips safely with notices
 *     when it does not,
 *   - does NOT grant unrelated schemas or DROP/CREATE SCHEMA.
 *
 * Stack 198 — also covers the narrow `buildLangchainCheckpointRoleGrantsSql()`
 * helper reused by the boot-time `PostgresSaver.setup()` path and the
 * operator repair path: exactly the three checkpoint tables, no
 * `checkpoint_migrations`, no `ALTER DEFAULT PRIVILEGES FOR ROLE nautilo`.
 */
import { describe, expect, test } from "bun:test";
import {
  AGENT_APPEND_NOTIFICATION_TABLES,
  AGENT_DENIED_NOTIFICATION_TABLES,
  AGENT_SELECT_ONLY_TABLES,
  buildAgentRoleGrantsSql,
  buildLangchainCheckpointRoleGrantsSql,
  buildMemoryCryptoLifecycleRoleGrantsSql,
  buildNotificationIntelligenceRoleGrantsSql,
  getAgentRoleConstants,
  LANGCHAIN_CHECKPOINT_TABLES,
  SENSITIVE_TABLES,
  USERS_PUBLIC_VIEW_COLUMNS,
} from "@nautilo/db";

describe("agent-role-grants SQL shape — public contract preserved", () => {
  const sql = buildAgentRoleGrantsSql();

  test("grants USAGE + DML on the public schema to nautilo_agent", () => {
    expect(sql).toContain("GRANT USAGE ON SCHEMA public TO nautilo_agent");
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO nautilo_agent",
    );
    expect(sql).toContain(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO nautilo_agent",
    );
  });

  test("sets default privileges for future public tables/sequences", () => {
    expect(sql).toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA public",
    );
    expect(sql).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO nautilo_agent",
    );
    expect(sql).toContain(
      "GRANT USAGE, SELECT ON SEQUENCES TO nautilo_agent",
    );
  });

  test("revokes each sensitive credential-class table conditionally", () => {
    for (const tbl of SENSITIVE_TABLES) {
      expect(sql).toContain(`'${tbl}'`);
      expect(sql).toContain(
        `REVOKE ALL ON TABLE public.%I FROM nautilo_agent`,
      );
    }
  });

  test("reconciles transition policy to SELECT-only after broad legacy grants", () => {
    expect(AGENT_SELECT_ONLY_TABLES).toEqual(["encryption_transition_policy"]);
    expect(SENSITIVE_TABLES).not.toContain("encryption_transition_policy");
    expect(sql).toContain("select_only_tables text[] := ARRAY['encryption_transition_policy']");
    expect(sql).toContain("REVOKE ALL ON TABLE public.%I FROM nautilo_agent");
    expect(sql).toContain("GRANT SELECT ON TABLE public.%I TO nautilo_agent");
    expect(sql.indexOf("GRANT SELECT ON TABLE public.%I TO nautilo_agent"))
      .toBeGreaterThan(sql.indexOf("GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES"));
  });

  test("preserves the M257 product-only Reflection boundary after role repair", () => {
    for (const table of [
      "reflection_records",
      "reflection_record_dependencies",
      "reflection_record_successors",
      "reflection_record_payload_representations",
      "reflection_record_payload_representation_heads",
      "reflection_record_publications",
      "reflection_record_authority_closure",
      "reflection_record_authority_projections",
      "reflection_record_authority_alternatives",
      "reflection_record_authority_changes",
      "reflection_record_authority_reconciliations",
      "reflection_record_authority_blocks",
      "reflection_record_search_projections",
      "reflection_record_semantic_work",
      "reflection_record_semantic_work_admissions",
      "reflection_record_dependency_change_repairs",
      "reflection_record_source_change_repairs",
      "reflection_record_source_dependency_index",
      "room_journal_record_cutover",
      "room_journal_record_rebuild_retirements",
    ] as const) {
      expect(SENSITIVE_TABLES).toContain(table);
      expect(sql).toContain(`'${table}'`);
    }
  });

  test("preserves the M322 product-only access receipt boundary after broad grants", () => {
    expect(SENSITIVE_TABLES).toContain("content_access_operations");
    expect(sql).toContain("'content_access_operations'");
    expect(sql.indexOf("'content_access_operations'")).toBeGreaterThan(
      sql.indexOf(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public",
      ),
    );
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.%I FROM nautilo_agent",
    );
  });

  test("creates users_public view with exactly the safe column subset", () => {
    expect(sql).toContain("CREATE OR REPLACE VIEW public.users_public AS SELECT");
    for (const col of USERS_PUBLIC_VIEW_COLUMNS) {
      expect(sql).toContain(col);
    }
    // Unsafe columns must NOT appear in the view SELECT list.
    expect(sql).not.toMatch(/users_public AS SELECT[^\n]*email/);
    expect(sql).not.toMatch(/users_public AS SELECT[^\n]*external_id/);
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.users FROM nautilo_agent",
    );
  });
});

describe("agent-role-grants SQL shape — M233 notification boundary", () => {
  const sql = buildNotificationIntelligenceRoleGrantsSql();

  test("denies Human-owned notification preference tables", () => {
    for (const table of AGENT_DENIED_NOTIFICATION_TABLES) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain(
      "REVOKE ALL ON TABLE public.%I FROM nautilo_agent",
    );
  });

  test("re-grants only SELECT and INSERT on append fact tables", () => {
    for (const table of AGENT_APPEND_NOTIFICATION_TABLES) {
      expect(sql).toContain(`'${table}'`);
    }
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.%I TO nautilo_agent",
    );
    expect(sql).not.toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.%I",
    );
  });

  test("is conditional and embedded after broad public grants", () => {
    expect(sql).toContain("to_regclass(format('public.%I', tbl))");
    const full = buildAgentRoleGrantsSql();
    expect(full).toContain(sql);
    expect(full.indexOf(sql)).toBeGreaterThan(
      full.indexOf(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public",
      ),
    );
  });
});

describe("agent-role-grants SQL shape — M243/M320 Memory crypto lifecycle", () => {
  const sql = buildMemoryCryptoLifecycleRoleGrantsSql();

  test("removes broad and historical column-level mutation grants", () => {
    expect(sql).toContain(
      "REVOKE ALL PRIVILEGES ON TABLE public.%I FROM nautilo_agent",
    );
    expect(sql).toContain(
      "REVOKE UPDATE (%s) ON TABLE public.%I FROM nautilo_agent",
    );
  });

  test("restores append access and the exact bounded update columns", () => {
    expect(sql).toContain(
      "GRANT SELECT, INSERT ON TABLE public.%I TO nautilo_agent",
    );
    expect(sql).toContain("GRANT UPDATE (%s) ON TABLE public.%I TO nautilo_agent");
    expect(sql).toContain("AND attname = ANY (ARRAY[");
    expect(sql).toContain("AND NOT attisdropped");
    expect(sql).toContain(
      "AND (attname <> 'semantic_change_kind' OR tbl = 'memory_crypto_operations')",
    );
    expect(sql).toContain("'crypto_completed_at', 'updated_at', 'semantic_change_kind'");
    expect(sql).not.toMatch(/GRANT[^;]*DELETE[^;]*memory_crypto_operations/);
    expect(sql).not.toMatch(/GRANT UPDATE \([\s\S]*operation_id/);
  });

  test("reconciles both Memory sequences to USAGE-only", () => {
    for (const sequence of [
      "memory_crypto_revisions_sequence_seq",
      "memory_crypto_operations_sequence_seq",
    ]) {
      expect(sql).toContain(`REVOKE ALL PRIVILEGES ON SEQUENCE public.${sequence}`);
      expect(sql).toContain(`GRANT USAGE ON SEQUENCE public.${sequence}`);
    }
  });

  test("runs after the broad public-table grant in the full repair", () => {
    const full = buildAgentRoleGrantsSql();
    expect(full).toContain(sql);
    expect(full.indexOf(sql)).toBeGreaterThan(
      full.indexOf(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public",
      ),
    );
  });
});

describe("agent-role-grants SQL shape — Stack 198 langchain checkpoint grants", () => {
  const sql = buildAgentRoleGrantsSql();

  test("gates the langchain block on schema existence and skips with a notice", () => {
    expect(sql).toContain("SELECT 1 FROM pg_namespace WHERE nspname = 'langchain'");
    expect(sql).toContain(
      "skipping langchain schema grants (schema does not exist",
    );
    expect(sql).toContain("RETURN;");
  });

  test("grants USAGE on the langchain schema to nautilo_agent", () => {
    expect(sql).toContain("GRANT USAGE ON SCHEMA langchain TO nautilo_agent");
  });

  test("grants DML on each exact langchain checkpoint table", () => {
    for (const tbl of LANGCHAIN_CHECKPOINT_TABLES) {
      expect(sql).toContain(`'${tbl}'`);
      expect(sql).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE langchain.%I TO nautilo_agent`,
      );
    }
  });

  test("emits a per-table skip notice for checkpoint tables that do not exist yet", () => {
    expect(sql).toContain(
      "skipping langchain.% (table does not exist",
    );
  });

  test("grants USAGE, SELECT on langchain sequences defensively", () => {
    expect(sql).toContain(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA langchain TO nautilo_agent",
    );
  });

  test("does NOT grant unrelated schemas, DROP, or CREATE SCHEMA", () => {
    expect(sql).not.toContain("DROP ");
    expect(sql).not.toContain("CREATE SCHEMA");
    // Only public + langchain schemas should appear in GRANT USAGE ON SCHEMA.
    const schemaGrants = sql.match(/GRANT USAGE ON SCHEMA (\w+) TO nautilo_agent/g) ?? [];
    const grantedSchemas = schemaGrants.map((m) => m.match(/SCHEMA (\w+)/)![1]);
    expect(grantedSchemas.sort()).toEqual(["langchain", "public"]);
  });

  test("does NOT grant checkpoint_migrations to the agent runtime", () => {
    expect(sql).not.toContain("checkpoint_migrations");
  });

  test("does NOT emit ALTER DEFAULT PRIVILEGES for the langchain schema", () => {
    expect(sql).not.toContain(
      "ALTER DEFAULT PRIVILEGES FOR ROLE nautilo IN SCHEMA langchain",
    );
  });
});

describe("buildLangchainCheckpointRoleGrantsSql — narrow reusable block", () => {
  const narrow = buildLangchainCheckpointRoleGrantsSql();

  test("gates on schema existence and skips with a notice when absent", () => {
    expect(narrow).toContain(
      "SELECT 1 FROM pg_namespace WHERE nspname = 'langchain'",
    );
    expect(narrow).toContain(
      "skipping langchain schema grants (schema does not exist",
    );
    expect(narrow).toContain("RETURN;");
  });

  test("grants USAGE on the langchain schema only", () => {
    expect(narrow).toContain("GRANT USAGE ON SCHEMA langchain TO nautilo_agent");
    const schemaGrants = narrow.match(/GRANT USAGE ON SCHEMA (\w+) TO nautilo_agent/g) ?? [];
    const grantedSchemas = schemaGrants.map((m) => m.match(/SCHEMA (\w+)/)![1]);
    expect(grantedSchemas).toEqual(["langchain"]);
  });

  test("grants DML on exactly the three checkpoint tables", () => {
    for (const tbl of LANGCHAIN_CHECKPOINT_TABLES) {
      expect(narrow).toContain(`'${tbl}'`);
      expect(narrow).toContain(
        `GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE langchain.%I TO nautilo_agent`,
      );
    }
  });

  test("grants defensive sequence access in the langchain schema", () => {
    expect(narrow).toContain(
      "GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA langchain TO nautilo_agent",
    );
  });

  test("does NOT grant checkpoint_migrations", () => {
    expect(narrow).not.toContain("checkpoint_migrations");
  });

  test("does NOT emit ALTER DEFAULT PRIVILEGES", () => {
    expect(narrow).not.toContain("ALTER DEFAULT PRIVILEGES");
  });

  test("does NOT DROP or CREATE SCHEMA — structure is untouched", () => {
    expect(narrow).not.toContain("DROP ");
    expect(narrow).not.toContain("CREATE SCHEMA");
  });

  test("is embedded verbatim in the full agent-role grant block", () => {
    expect(buildAgentRoleGrantsSql()).toContain(buildLangchainCheckpointRoleGrantsSql());
  });
});

describe("agent-role-grants constants", () => {
  test("getAgentRoleConstants exposes the langchain checkpoint tables", () => {
    const c = getAgentRoleConstants();
    expect(c.targetRole).toBe("nautilo_agent");
    expect(c.targetDb).toBe("nautilo");
    expect(c.langchainCheckpointTables).toEqual(LANGCHAIN_CHECKPOINT_TABLES);
    expect(c.sensitiveTables).toEqual(SENSITIVE_TABLES);
    expect(c.agentSelectOnlyTables).toEqual(AGENT_SELECT_ONLY_TABLES);
    expect(c.agentDeniedNotificationTables).toEqual(
      AGENT_DENIED_NOTIFICATION_TABLES,
    );
    expect(c.agentAppendNotificationTables).toEqual(
      AGENT_APPEND_NOTIFICATION_TABLES,
    );
  });

  test("LANGCHAIN_CHECKPOINT_TABLES lists the exact LangGraph PostgresSaver tables", () => {
    expect(LANGCHAIN_CHECKPOINT_TABLES).toEqual([
      "checkpoints",
      "checkpoint_blobs",
      "checkpoint_writes",
    ]);
  });
});
