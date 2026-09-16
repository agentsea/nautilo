/**
 * D129 P3 part 2 (Stack 11.5) — live four-scenario role-isolation
 * integration test against a real Postgres.
 *
 * Verifies the structural M1 defense: after the agent-role
 * provisioning (`infra/postgres-init.sh` for fresh volumes, OR
 * `nautilo-dev migrate-add-agent-role --apply` for existing
 * volumes), the `nautilo_agent` role:
 *
 *   1. CANNOT `SELECT` from `credentials` → permission denied.
 *   2. CAN `SELECT` from `memories` → succeeds (zero rows OK; the
 *      assertion is that NO permission error fires).
 *   3. CANNOT `SELECT` from raw `users` → permission denied.
 *   4. CAN `SELECT` from `users_public` view → succeeds; the
 *      returned columns are the safe subset (`id`, `handle`,
 *      `name`, `server`, `server_role`, `created_at`, `updated_at`)
 *      and do NOT include `email` or `external_id`.
 *
 * Test fixture provisions the agent role + grants + view via the same
 * SQL that `infra/postgres-init.sh` runs, using the existing
 * `createDirectDb()` (postgres-js, superuser auth) — does NOT shell
 * out to `nautilo-dev migrate-add-agent-role` to keep the test
 * self-contained.
 *
 * The agent-role connection uses `resolveDirectAgentDatabaseConnectionString()`
 * (same credential as runtime `agentDb`). Setup must NOT rotate an existing
 * role password — shared dev-stack DBs rely on the operator-configured secret.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import postgres from "postgres";
import {
  ensureDatabase,
  createDirectDb,
  resolveDirectAgentDatabaseConnectionString,
} from "@nautilo/db";
import { bootstrapTestDbInstance } from "../../src/testing/instance-guard";

const AGENT_ROLE = "nautilo_agent";

/** Password used only when CREATE ROLE runs (role absent). Never ALTER on existing role. */
function resolveAgentPasswordForProvisioning(): string {
  const password = new URL(
    resolveDirectAgentDatabaseConnectionString(),
  ).password;
  if (!password) {
    throw new Error(
      "Role-isolation integration test: set DB_AGENT_DIRECT_CONNECTION or NAUTILO_AGENT_DB_PASSWORD for nautilo_agent",
    );
  }
  return decodeURIComponent(password);
}

async function provisionAgentRole(
  db: ReturnType<typeof createDirectDb>,
): Promise<void> {
  // Mirror of the SQL in `infra/postgres-init.sh` / `migrate-add-agent-role.ts`.
  // CREATE ROLE only when missing; never ALTER … PASSWORD on existing role.
  const agentPassword = resolveAgentPasswordForProvisioning().replace(
    /'/g,
    "''",
  );
  await db.execute(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${AGENT_ROLE}') THEN
        EXECUTE format('CREATE ROLE ${AGENT_ROLE} LOGIN PASSWORD %L', '${agentPassword}');
      END IF;
    END $$;
  `);

  await db.execute(`GRANT CONNECT ON DATABASE nautilo TO ${AGENT_ROLE}`);
  await db.execute(`GRANT USAGE ON SCHEMA public TO ${AGENT_ROLE}`);
  await db.execute(`
    ALTER DEFAULT PRIVILEGES IN SCHEMA public
      GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${AGENT_ROLE};
  `);
  await db.execute(`
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${AGENT_ROLE};
  `);

  // REVOKE on credential-class tables (conditional on existence).
  await db.execute(`
    DO $$
    DECLARE
      sensitive_tables text[] := ARRAY['credentials','recovery_codes','logto_account_security','channel_identities'];
      tbl text;
    BEGIN
      FOREACH tbl IN ARRAY sensitive_tables LOOP
        IF EXISTS (
          SELECT 1 FROM pg_class c
          JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE c.relname = tbl AND n.nspname = 'public' AND c.relkind = 'r'
        ) THEN
          EXECUTE format('REVOKE ALL ON TABLE public.%I FROM ${AGENT_ROLE}', tbl);
        END IF;
      END LOOP;
    END $$;
  `);

  // users_public view + REVOKE on raw users.
  await db.execute(`
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = 'users' AND n.nspname = 'public' AND c.relkind = 'r'
      ) THEN
        EXECUTE 'CREATE OR REPLACE VIEW public.users_public AS SELECT id, handle, name, server, created_at, updated_at FROM public.users';
        EXECUTE 'GRANT SELECT ON public.users_public TO ${AGENT_ROLE}';
        EXECUTE 'REVOKE ALL ON TABLE public.users FROM ${AGENT_ROLE}';
      END IF;
    END $$;
  `);
}

describe("D129 P3 — nautilo_agent role isolation (live)", () => {
  let supDb: ReturnType<typeof createDirectDb>;
  let agentSql: ReturnType<typeof postgres>;

  beforeAll(async () => {
    bootstrapTestDbInstance();
    await ensureDatabase();
    supDb = createDirectDb(1);
    await provisionAgentRole(supDb);
    agentSql = postgres(resolveDirectAgentDatabaseConnectionString(), {
      max: 1,
    });
  });

  afterAll(async () => {
    await agentSql.end({ timeout: 1 });
    await supDb.end();
  });

  test("scenario 1: agent role CANNOT SELECT from credentials (permission denied)", async () => {
    let caught: unknown = null;
    try {
      await agentSql`SELECT 1 FROM credentials LIMIT 1`;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const message = String(
      (caught as { message?: string } | null)?.message ?? caught,
    );
    expect(message).toMatch(/permission denied/i);
    expect(message.toLowerCase()).toContain("credentials");
  });

  test("scenario 2: agent role CAN SELECT from memories (no permission error)", async () => {
    // We don't care whether rows exist; we only care that no
    // permission error fires. `LIMIT 0` shape avoids any data assertion.
    let caught: unknown = null;
    try {
      await agentSql`SELECT 1 FROM memories LIMIT 0`;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeNull();
  });

  test("scenario 3: agent role CANNOT SELECT from raw users table (permission denied)", async () => {
    let caught: unknown = null;
    try {
      await agentSql`SELECT 1 FROM users LIMIT 1`;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeTruthy();
    const message = String(
      (caught as { message?: string } | null)?.message ?? caught,
    );
    expect(message).toMatch(/permission denied/i);
  });

  test("scenario 4: agent role CAN SELECT from users_public view; only safe columns visible", async () => {
    let caught: unknown = null;
    let columns: string[] = [];
    try {
      const rows = await agentSql`SELECT * FROM users_public LIMIT 0`;
      // postgres-js exposes column metadata on the result; introspect via
      // a second query against information_schema to get the safe-column list.
      const colRows = await agentSql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'users_public'
        ORDER BY ordinal_position
      `;
      columns = colRows.map((r) => r.column_name);
      void rows;
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeNull();

    // The safe columns we put in the view, in order. D219 dropped
    // `server_role` (capability-derived authority is the only RBAC axis).
    const expected = [
      "id",
      "handle",
      "name",
      "server",
      "created_at",
      "updated_at",
    ];
    expect(columns).toEqual(expected);

    // Confirm the unsafe columns are NOT in the view.
    expect(columns).not.toContain("email");
    expect(columns).not.toContain("external_id");
    expect(columns).not.toContain("server_role");
  });
});
