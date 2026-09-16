import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DROP_NAUTILO_DATABASE_SQL,
  NAUTILO_DB_POST_CREATE_GRANTS_SQL,
  buildDropAndRecreateNautiloDbSql,
} from "../../src/lib/docker-db";

/**
 * Regression guard for the named-instance restore failure:
 * `dropAndCreateDb()` terminated sessions then ran a plain
 * `DROP DATABASE`, but the Neon HTTP proxy reconnected in the race
 * window and Postgres rejected the drop with "database nautilo is being
 * accessed by other users".
 *
 * Fix: `DROP DATABASE ... WITH (FORCE)` on the pinned pg17 image, in a
 * single `psql` session (no separate `pg_terminate_backend` shell-out).
 */

const src = readFileSync(
  join(import.meta.dir, "..", "..", "src", "lib", "docker-db.ts"),
  "utf8",
);

describe("DROP_NAUTILO_DATABASE_SQL (restore race regression)", () => {
  test("uses Postgres FORCE drop so reconnects cannot wedge the drop", () => {
    expect(DROP_NAUTILO_DATABASE_SQL).toContain("DROP DATABASE IF EXISTS nautilo");
    expect(DROP_NAUTILO_DATABASE_SQL).toContain("WITH (FORCE)");
  });

  test("targets the nautilo database by name", () => {
    expect(DROP_NAUTILO_DATABASE_SQL).toMatch(/DROP DATABASE IF EXISTS nautilo\b/);
  });
});

describe("buildDropAndRecreateNautiloDbSql (restore race regression)", () => {
  test("orders FORCE drop before CREATE DATABASE", () => {
    const sql = buildDropAndRecreateNautiloDbSql();
    const dropIdx = sql.indexOf(DROP_NAUTILO_DATABASE_SQL);
    const createIdx = sql.indexOf("CREATE DATABASE nautilo OWNER nautilo;");
    expect(dropIdx).toBeGreaterThan(-1);
    expect(createIdx).toBeGreaterThan(-1);
    expect(dropIdx).toBeLessThan(createIdx);
  });

  test("includes post-create isolation grants after CREATE", () => {
    const sql = buildDropAndRecreateNautiloDbSql();
    const createIdx = sql.indexOf("CREATE DATABASE nautilo OWNER nautilo;");
    const grantsIdx = sql.indexOf(NAUTILO_DB_POST_CREATE_GRANTS_SQL.trim());
    expect(createIdx).toBeGreaterThan(-1);
    expect(grantsIdx).toBeGreaterThan(createIdx);
  });

  test("preserves nautilo_agent CONNECT grant and PUBLIC revoke", () => {
    const sql = buildDropAndRecreateNautiloDbSql();
    expect(sql).toContain("REVOKE ALL ON DATABASE nautilo FROM PUBLIC");
    expect(sql).toContain("GRANT ALL ON DATABASE nautilo TO nautilo");
    expect(sql).toContain("GRANT CONNECT ON DATABASE nautilo TO nautilo_agent");
  });
});

describe("dropAndCreateDb — source guard (restore race regression)", () => {
  test("does NOT use separate pg_terminate_backend before a plain DROP DATABASE", () => {
    // The bug pattern: terminate in one docker exec, DROP in the next —
    // Neon proxy reconnects in between.
    expect(src).not.toMatch(
      /pg_terminate_backend\(pid\).*DROP DATABASE IF EXISTS nautilo;/s,
    );
    expect(src).not.toContain(
      'DROP DATABASE IF EXISTS nautilo;" postgres',
    );
  });

  test("delegates drop+recreate to buildDropAndRecreateNautiloDbSql in one psql session", () => {
    expect(src).toContain("buildDropAndRecreateNautiloDbSql()");
    expect(src).toContain("DROP_NAUTILO_DATABASE_SQL");
    expect(src).toContain("WITH (FORCE)");
  });

  test("runs drop script via stdin psql with ON_ERROR_STOP (not multiple -c shell-outs)", () => {
    const fnStart = src.indexOf("export function dropAndCreateDb");
    const fnEnd = src.indexOf("/**", fnStart + 1);
    const fnBody = src.slice(fnStart, fnEnd);
    expect(fnBody).toContain("docker exec -i");
    expect(fnBody).toContain("ON_ERROR_STOP=1");
    expect(fnBody).toContain("buildDropAndRecreateNautiloDbSql()");
    // Old bug: three separate exec() calls for terminate / drop / create.
    const execCalls = (fnBody.match(/\bexec\(/g) ?? []).length;
    expect(execCalls).toBe(0);
  });
});
