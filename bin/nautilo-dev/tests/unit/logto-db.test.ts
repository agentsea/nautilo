/**
 * M059 — `getLogtoDbUrl` shape contract.
 *
 * The other helpers in `lib/logto-db.ts` shell out to `docker exec` and
 * are therefore covered by manual smoke + Phase 4 integration testing
 * (out of unit scope by design — see `clean.ts`/`docker-db.ts` which
 * follow the same convention). What we lock down here is the URL the
 * `nautilo-dev upgrade` command hands to `npx @logto/cli db alteration
 * deploy` via `DB_URL`.
 */
import { describe, expect, test } from "bun:test";
import {
  buildLogtoTenantResyncSql,
  DROP_LOGTO_TENANT_ROLES_SQL,
  getLogtoDbUrl,
  isLogtoResyncDryRunEnv,
  redactTenantRowPasswords,
  resolveLogtoContainer,
  runResyncLogtoTenantRoles,
} from "../../src/lib/logto-db";
import type { LogtoTenantRow } from "../../src/lib/logto-db";

describe("getLogtoDbUrl (M059)", () => {
  /** Compose default host port; explicit so unit tests ignore operator `process.env`. */
  const composeLogtoDbPort = { LOGTO_DB_PORT: "5432" } as const;

  test("defaults match the compose-stack credentials", () => {
    const url = getLogtoDbUrl({ ...composeLogtoDbPort });
    expect(url).toBe(
      "postgres://logto:logto@localhost:5432/logto_nautilo",
    );
  });

  test("respects LOGTO_DB_PASSWORD override", () => {
    const url = getLogtoDbUrl({ ...composeLogtoDbPort, LOGTO_DB_PASSWORD: "ratherStrong!" });
    expect(url).toBe(
      "postgres://logto:ratherStrong!@localhost:5432/logto_nautilo",
    );
  });

  test("URL-encodes special characters in the password", () => {
    const url = getLogtoDbUrl({ ...composeLogtoDbPort, LOGTO_DB_PASSWORD: "p@ss/word#1" });
    // `@`, `/`, `#` all need percent-encoding so the userinfo segment
    // doesn't collide with the host / path separators.
    expect(url).toBe(
      "postgres://logto:p%40ss%2Fword%231@localhost:5432/logto_nautilo",
    );
  });

  test("respects LOGTO_DB_HOST + LOGTO_DB_PORT overrides for non-default compose projects", () => {
    const url = getLogtoDbUrl({
      LOGTO_DB_HOST: "172.18.0.4",
      LOGTO_DB_PORT: "55432",
    });
    expect(url).toBe(
      "postgres://logto:logto@172.18.0.4:55432/logto_nautilo",
    );
  });
});

describe("DROP_LOGTO_TENANT_ROLES_SQL (clean follow-up)", () => {
  // Regression guard for the M118-followup "infra:start: role
  // already exists" bug. `DROP DATABASE logto_nautilo` does NOT
  // remove the cluster-level per-tenant roles Logto's seed
  // container creates on first run (`logto_tenant_logto_nautilo`,
  // `_admin`, `_default`). Next `logto db seed --swe` then fails
  // with Postgres 42710 "role already exists". `dropAndCreateLogtoDb`
  // therefore runs this SQL between DROP DATABASE and CREATE
  // DATABASE so a subsequent `infra:start` re-seeds cleanly.

  test("matches every Logto per-tenant role pattern (incl. _admin / _default siblings)", () => {
    expect(DROP_LOGTO_TENANT_ROLES_SQL).toContain(
      "rolname LIKE 'logto_tenant_logto_nautilo%'",
    );
  });

  test("drops each match individually via DROP ROLE IF EXISTS so missing roles aren't a hard error", () => {
    expect(DROP_LOGTO_TENANT_ROLES_SQL).toContain("DROP ROLE IF EXISTS");
  });

  test("uses a DO block + format(%I) so role names are SQL-identifier-safe", () => {
    expect(DROP_LOGTO_TENANT_ROLES_SQL).toContain("DO $do$");
    expect(DROP_LOGTO_TENANT_ROLES_SQL).toContain("format('DROP ROLE IF EXISTS %I'");
  });
});

describe("resolveLogtoContainer (M059)", () => {
  test("returns the canonical nautilo-postgres-1 by default", () => {
    expect(resolveLogtoContainer({})).toBe("nautilo-postgres-1");
  });

  test("respects LOGTO_DB_CONTAINER override for non-default compose project names", () => {
    expect(resolveLogtoContainer({ LOGTO_DB_CONTAINER: "myproj-postgres-1" })).toBe(
      "myproj-postgres-1",
    );
  });
});

// ---------------------------------------------------------------------------
// Stack 132 — Logto tenant role password resync (SQL generator + dry-run).
// The runtime path shells `docker exec psql` and is covered by manual
// smoke; the SQL generator + dry-run branch are pure functions and
// have the bug surface (escape handling, idempotence, empty-rows,
// role-not-exist), so they are unit-tested here.
// ---------------------------------------------------------------------------

describe("buildLogtoTenantResyncSql (Stack 132)", () => {
  const sampleRows: LogtoTenantRow[] = [
    {
      id: "default",
      dbUser: "logto_tenant_logto_nautilo_default",
      dbUserPassword: "mbglv2o1m05rvfqm2v50cudlp1yofb89",
    },
    {
      id: "admin",
      dbUser: "logto_tenant_logto_nautilo_admin",
      dbUserPassword: "s5yue1mnt10f8ja8q334kaw8u7j813by",
    },
  ];

  test("empty rows → empty string (caller short-circuits without emitting SQL)", () => {
    expect(buildLogtoTenantResyncSql([])).toBe("");
  });

  test("emits one DO block per row", () => {
    const sql = buildLogtoTenantResyncSql(sampleRows);
    const doCount = (sql.match(/DO \$do\$/g) ?? []).length;
    expect(doCount).toBe(2);
  });

  test("each DO block has both ALTER and CREATE branches (idempotent across fresh + restored states)", () => {
    const sql = buildLogtoTenantResyncSql([sampleRows[0]!]);
    expect(sql).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
    expect(sql).toContain("CREATE ROLE %I WITH LOGIN PASSWORD %L");
    expect(sql).toContain("IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = v_role)");
  });

  test("uses format(%I, %L) inside EXECUTE for SQL-identifier + literal safe quoting", () => {
    const sql = buildLogtoTenantResyncSql([sampleRows[0]!]);
    expect(sql).toContain("format('ALTER ROLE %I WITH LOGIN PASSWORD %L'");
    expect(sql).toContain("format('CREATE ROLE %I WITH LOGIN PASSWORD %L'");
  });

  test("embeds the role name + password as DECLARE literals (not interpolated into EXECUTE)", () => {
    const sql = buildLogtoTenantResyncSql([sampleRows[0]!]);
    expect(sql).toContain("v_role text := 'logto_tenant_logto_nautilo_default'");
    expect(sql).toContain("v_pw text := 'mbglv2o1m05rvfqm2v50cudlp1yofb89'");
  });

  test("escapes single quotes in db_user and db_user_password (SQL-injection-shaped safety)", () => {
    const rows: LogtoTenantRow[] = [
      {
        id: "default",
        dbUser: "weird'o'brien_role",
        dbUserPassword: "p@ss'with'quotes",
      },
    ];
    const sql = buildLogtoTenantResyncSql(rows);
    // Each single quote in the source value must be doubled in the SQL literal.
    expect(sql).toContain("v_role text := 'weird''o''brien_role'");
    expect(sql).toContain("v_pw text := 'p@ss''with''quotes'");
    // And the original un-escaped values must NOT appear in the SQL.
    expect(sql).not.toMatch(/weird'o'brien_role/);
    expect(sql).not.toMatch(/p@ss'with'quotes/);
  });

  test("dollar-quotes the DO body so the inner SQL syntax parses cleanly", () => {
    const sql = buildLogtoTenantResyncSql([sampleRows[0]!]);
    expect(sql).toContain("DO $do$");
    expect(sql).toContain("END\n$do$;");
  });
});

describe("redactTenantRowPasswords (Stack 132)", () => {
  test("replaces each row's dbUserPassword with '***'", () => {
    const rows: LogtoTenantRow[] = [
      { id: "default", dbUser: "r1", dbUserPassword: "sekret1" },
      { id: "admin", dbUser: "r2", dbUserPassword: "sekret2" },
    ];
    const redacted = redactTenantRowPasswords(rows);
    expect(redacted[0]!.dbUserPassword).toBe("***");
    expect(redacted[1]!.dbUserPassword).toBe("***");
    // Other fields preserved.
    expect(redacted[0]!.id).toBe("default");
    expect(redacted[1]!.dbUser).toBe("r2");
  });

  test("does not mutate the input rows", () => {
    const rows: LogtoTenantRow[] = [
      { id: "default", dbUser: "r1", dbUserPassword: "sekret1" },
    ];
    redactTenantRowPasswords(rows);
    expect(rows[0]!.dbUserPassword).toBe("sekret1");
  });
});

describe("isLogtoResyncDryRunEnv (Stack 132)", () => {
  test("'1' → dry-run active", () => {
    expect(isLogtoResyncDryRunEnv({ LOGTO_RESYNC_DRY_RUN: "1" })).toBe(true);
  });

  test("'0', 'false', arbitrary string, unset → dry-run inactive (only '1' triggers)", () => {
    expect(isLogtoResyncDryRunEnv({ LOGTO_RESYNC_DRY_RUN: "0" })).toBe(false);
    expect(isLogtoResyncDryRunEnv({ LOGTO_RESYNC_DRY_RUN: "false" })).toBe(false);
    expect(isLogtoResyncDryRunEnv({ LOGTO_RESYNC_DRY_RUN: "true" })).toBe(false);
    expect(isLogtoResyncDryRunEnv({ LOGTO_RESYNC_DRY_RUN: "  1  " })).toBe(true); // trimmed
    expect(isLogtoResyncDryRunEnv({})).toBe(false);
  });
});

describe("runResyncLogtoTenantRoles (Stack 132 — pure runner)", () => {
  const sampleRows: LogtoTenantRow[] = [
    {
      id: "default",
      dbUser: "logto_tenant_logto_nautilo_default",
      dbUserPassword: "mbglv2o1m05rvfqm2v50cudlp1yofb89",
    },
  ];

  test("empty tenant rows → no exec, no dry-run log, executed=false", () => {
    const logCalls: string[] = [];
    let execCalled = false;
    const result = runResyncLogtoTenantRoles(
      {},
      {
        readTenantRows: () => [],
        execPsql: () => {
          execCalled = true;
        },
        log: (m) => logCalls.push(m),
      },
    );
    expect(result).toEqual({ executed: false, sql: "", rowCount: 0, dryRun: false });
    expect(execCalled).toBe(false);
    expect(logCalls).toEqual(["[logto-resync] no tenant rows; nothing to resync"]);
  });

  test("dry-run via env → redacted SQL logged, execPsql NOT called, executed=false", () => {
    const logCalls: string[] = [];
    let execCalled = false;
    const result = runResyncLogtoTenantRoles(
      { dryRun: true },
      {
        readTenantRows: () => sampleRows,
        execPsql: () => {
          execCalled = true;
        },
        log: (m) => logCalls.push(m),
      },
    );
    expect(result.executed).toBe(false);
    expect(result.dryRun).toBe(true);
    expect(result.rowCount).toBe(1);
    expect(execCalled).toBe(false);
    // Redacted SQL is logged.
    const loggedSql = logCalls.find((m) => m.includes("DO $do$"));
    expect(loggedSql).toBeDefined();
    // Real password must NOT appear in any logged line.
    for (const line of logCalls) {
      expect(line).not.toContain(sampleRows[0]!.dbUserPassword);
    }
    // Real password IS preserved in the returned sql (caller may need it).
    expect(result.sql).toContain(sampleRows[0]!.dbUserPassword);
  });

  test("non-dry-run → execPsql called once with real SQL, executed=true", () => {
    let execCalled = 0;
    let capturedSql = "";
    const result = runResyncLogtoTenantRoles(
      {},
      {
        readTenantRows: () => sampleRows,
        execPsql: (sql) => {
          execCalled += 1;
          capturedSql = sql;
        },
        log: () => {},
      },
    );
    expect(result.executed).toBe(true);
    expect(result.dryRun).toBe(false);
    expect(result.rowCount).toBe(1);
    expect(execCalled).toBe(1);
    expect(capturedSql).toContain("ALTER ROLE %I WITH LOGIN PASSWORD %L");
    expect(capturedSql).toContain(sampleRows[0]!.dbUserPassword);
  });

  test("explicit dryRun:false option overrides LOGTO_RESYNC_DRY_RUN=1 env", () => {
    // Simulate the env being set but the caller forcing execute.
    const original = process.env["LOGTO_RESYNC_DRY_RUN"];
    process.env["LOGTO_RESYNC_DRY_RUN"] = "1";
    try {
      let execCalled = false;
      const result = runResyncLogtoTenantRoles(
        { dryRun: false },
        {
          readTenantRows: () => sampleRows,
          execPsql: () => {
            execCalled = true;
          },
          log: () => {},
        },
      );
      expect(result.executed).toBe(true);
      expect(result.dryRun).toBe(false);
      expect(execCalled).toBe(true);
    } finally {
      if (original === undefined) delete process.env["LOGTO_RESYNC_DRY_RUN"];
      else process.env["LOGTO_RESYNC_DRY_RUN"] = original;
    }
  });
});
