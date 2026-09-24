import { describe, test, expect, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  __resetResolvedInstanceForTests,
  resolveInstance,
} from "@nautilo/config";
import {
  pgValue,
  parseCopyRows,
  RESTORE_MIGRATIONS,
  resolvePsqlExecTarget,
} from "../../src/lib/restore-migrations";

describe("moderation policy snapshot restoration", () => {
  test("restores saved policy over the seeded default and leaves older snapshots alone", () => {
    const rule = RESTORE_MIGRATIONS.find((entry) => entry.table === "public.server_moderation_policy")!;
    expect(rule.skipCopy).toBe(true);
    expect(rule.intentionalSkip).toBeUndefined();
    const statements: string[] = [];
    const context = { psqlExec: (sql: string) => { statements.push(sql); return ""; }, log: () => {} };
    rule.postRestore!({ ...context, dumpRowsFor: () => [] });
    expect(statements).toEqual([]);
    rule.postRestore!({ ...context, dumpRowsFor: () => [{
      columns: ["singleton", "enabled", "joins_paused", "approval_required", "revision", "updated_by", "updated_at"],
      values: ["t", "t", "t", "t", "9", "\\N", "2026-09-24 00:00:00+00"],
    }] });
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("VALUES ('t', 't', 't', 't', '9', NULL, '2026-09-24 00:00:00+00')");
    expect(statements[0]).toContain("ON CONFLICT (singleton) DO UPDATE SET");
    for (const column of ["enabled", "joins_paused", "approval_required", "revision", "updated_by", "updated_at"]) {
      expect(statements[0]).toContain(`${column} = EXCLUDED.${column}`);
    }
  });
});

describe("pgValue — pg_dump TEXT literal → SQL literal", () => {
  test("NULL sentinel becomes NULL", () => {
    expect(pgValue("\\N")).toBe("NULL");
  });

  test("undefined becomes NULL", () => {
    expect(pgValue(undefined)).toBe("NULL");
  });

  test("plain string is single-quoted", () => {
    expect(pgValue("hello")).toBe("'hello'");
  });

  test("embedded single quote is doubled", () => {
    expect(pgValue("she's")).toBe("'she''s'");
  });

  test("pg TEXT escapes are undone", () => {
    expect(pgValue("line1\\nline2")).toBe("'line1\nline2'");
    expect(pgValue("col1\\tcol2")).toBe("'col1\tcol2'");
  });

  test("double backslash is unescaped to single", () => {
    expect(pgValue("path\\\\to")).toBe("'path\\to'");
  });
});

describe("parseCopyRows — extract typed rows from dump", () => {
  const syntheticDump = [
    "--- preamble ---",
    "COPY public.credentials (id, actor_id, type, value, created_at, updated_at) FROM stdin;",
    "row-1\tactor-1\tpin\thash-1\t2026-04-01 00:00:00\t2026-04-01 00:00:00",
    "row-2\tactor-2\tpin\thash-2\t2026-04-02 00:00:00\t2026-04-02 00:00:00",
    "\\.",
    "",
    "COPY public.other_table (id, value) FROM stdin;",
    "a\tb",
    "\\.",
    "",
  ].join("\n");

  test("finds the named table's rows", () => {
    const rows = parseCopyRows(syntheticDump, "public.credentials");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.columns).toEqual([
      "id",
      "actor_id",
      "type",
      "value",
      "created_at",
      "updated_at",
    ]);
    expect(rows[0]!.values[0]).toBe("row-1");
    expect(rows[1]!.values[1]).toBe("actor-2");
  });

  test("returns empty array for unknown table", () => {
    expect(parseCopyRows(syntheticDump, "public.nope")).toHaveLength(0);
  });

  test("skips rows whose column count does not match header", () => {
    const badDump = [
      "COPY public.credentials (id, actor_id, type, value, created_at, updated_at) FROM stdin;",
      "row-1\tactor-1\tpin\thash-1\t2026-04-01 00:00:00\t2026-04-01 00:00:00",
      "malformed-too-few-columns",
      "row-3\tactor-3\tpin\thash-3\t2026-04-03 00:00:00\t2026-04-03 00:00:00",
      "\\.",
    ].join("\n");
    const rows = parseCopyRows(badDump, "public.credentials");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.values[0]).toBe("row-1");
    expect(rows[1]!.values[0]).toBe("row-3");
  });
});

describe("RESTORE_MIGRATIONS registry", () => {
  test("covers credentials.actor_id → user_id (M043)", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.credentials");
    expect(rule).toBeDefined();
    expect(rule!.rewriteCopyHeader).toBeDefined();
    expect(rule!.postRestore).toBeDefined();
    expect(rule!.reason).toContain("M043");
    expect(rule!.reason).toContain("actor_id");
    // Pre-M043 dumps drop COPY; post-M043 dumps COPY directly.
    expect(rule!.rewriteCopyHeader!("COPY public.credentials (id, actor_id)", ["id", "actor_id"])).toBeNull();
    expect(
      rule!.rewriteCopyHeader!("COPY public.credentials (id, user_id)", ["id", "user_id"]),
    ).toBe("COPY public.credentials (id, user_id)");
  });

  test("covers recovery_codes.actor_id → user_id (M043)", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.recovery_codes");
    expect(rule).toBeDefined();
    expect(rule!.rewriteCopyHeader).toBeDefined();
    expect(rule!.postRestore).toBeDefined();
    expect(rule!.rewriteCopyHeader!("COPY public.recovery_codes (id, actor_id)", ["id", "actor_id"])).toBeNull();
    expect(
      rule!.rewriteCopyHeader!("COPY public.recovery_codes (id, user_id)", ["id", "user_id"]),
    ).toBe("COPY public.recovery_codes (id, user_id)");
  });

  test("skips roles COPY (group_type dropped; re-seeded at boot)", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.roles");
    expect(rule).toBeDefined();
    expect(rule!.skipCopy).toBe(true);
    // roles is re-seeded at boot — no postRestore hook needed.
    expect(rule!.postRestore).toBeUndefined();
    expect(rule!.reason).toContain("re-seeded");
  });

  test("every rule with skipCopy:false MUST provide rewriteCopyHeader", () => {
    for (const rule of RESTORE_MIGRATIONS) {
      if (rule.skipCopy === false) {
        expect(rule.rewriteCopyHeader).toBeDefined();
      }
    }
  });

  test("every rule has a human-readable reason", () => {
    for (const rule of RESTORE_MIGRATIONS) {
      expect(rule.reason).toBeTruthy();
      expect(rule.reason.length).toBeGreaterThan(20);
    }
  });

  // -------------------------------------------------------------------------
  // Guard: intentional skips must be real skips, not silent discards.
  // A rule that claims `intentionalSkip` MUST drop the COPY (skipCopy) and
  // MUST NOT promise a postRestore hook — otherwise rows would either be
  // COPY'd into a broken shape or silently revived via a hook, defeating
  // the "explicit, never silent" contract. This keeps the general
  // "data-bearing drift must fail unless registered" guard intact: the
  // skip is REGISTERED and shaped correctly, so unregistered drift still
  // fails.
  // -------------------------------------------------------------------------
  test("every intentionalSkip rule sets skipCopy and has no postRestore", () => {
    const skips = RESTORE_MIGRATIONS.filter((r) => r.intentionalSkip === true);
    expect(skips.length).toBeGreaterThan(0);
    for (const rule of skips) {
      expect(rule.skipCopy).toBe(true);
      expect(rule.postRestore).toBeUndefined();
      expect(rule.reason).toContain("intentional");
    }
  });

  test("intentionalSkip rules do NOT also carry rewriteCopyHeader (no half-measures)", () => {
    for (const rule of RESTORE_MIGRATIONS) {
      if (rule.intentionalSkip === true) {
        expect(rule.rewriteCopyHeader).toBeUndefined();
      }
    }
  });
});

describe("D425 — disposable source-clone restore compatibility", () => {
  test("registers relay_tokens as an intentional skip (dropped installation_id)", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.relay_tokens");
    expect(rule).toBeDefined();
    expect(rule!.skipCopy).toBe(true);
    expect(rule!.intentionalSkip).toBe(true);
    expect(rule!.postRestore).toBeUndefined();
    // No header rewrite — the whole COPY is dropped, not reshaped.
    expect(rule!.rewriteCopyHeader).toBeUndefined();
    // Reason must explain BOTH the trigger (dropped binding) and that
    // the skip is intentional / non-portable, so preflight output reads
    // as an explicit decision rather than a silent discard.
    expect(rule!.reason).toContain("installation_id");
    expect(rule!.reason).toContain("non-portable");
    expect(rule!.reason).toContain("intentional");
  });

  test("registers server_maintenance as an intentional skip (table removed)", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.server_maintenance");
    expect(rule).toBeDefined();
    expect(rule!.skipCopy).toBe(true);
    expect(rule!.intentionalSkip).toBe(true);
    expect(rule!.postRestore).toBeUndefined();
    expect(rule!.rewriteCopyHeader).toBeUndefined();
    expect(rule!.reason).toContain("removed");
    expect(rule!.reason).toContain("non-portable");
    expect(rule!.reason).toContain("intentional");
  });

  test("the two D425 rules are the ONLY intentionalSkip entries", () => {
    const skips = RESTORE_MIGRATIONS
      .filter((r) => r.intentionalSkip === true)
      .map((r) => r.table);
    expect(skips).toEqual(["public.relay_tokens", "public.server_maintenance"]);
  });
});

describe("credentials postRestore hook — exercised with a fake psqlExec", () => {
  test("skips rows with NULL actor_id instead of failing", () => {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === "public.credentials")!;
    const executed: string[] = [];
    const psqlExec = (sql: string) => {
      executed.push(sql);
      return "";
    };
    const dumpText = [
      "COPY public.credentials (id, actor_id, type, value, created_at, updated_at) FROM stdin;",
      "row-null\t\\N\tpin\thash-x\t2026-04-01 00:00:00\t2026-04-01 00:00:00",
      "row-real\tactor-123\tpin\thash-y\t2026-04-02 00:00:00\t2026-04-02 00:00:00",
      "\\.",
    ].join("\n");

    rule.postRestore!({
      psqlExec,
      dumpRowsFor: (t) => parseCopyRows(dumpText, t),
      log: () => {},
    });

    // Only the row with a real actor_id should generate an INSERT.
    expect(executed).toHaveLength(1);
    expect(executed[0]).toContain("actor-123");
    expect(executed[0]).toContain("credentials");
    expect(executed[0]).toContain("ON CONFLICT (id) DO NOTHING");
  });
});

describe("resolvePsqlExecTarget — default container derives from resolved instance", () => {
  // Resolve against a throwaway HOME so the operator's real ~/.nautilo
  // (and any named ~/.nautilo-<id>) is never touched or written. Same
  // convention as compose-propagate.test.ts.
  let userHomeDir: string;
  const savedInstance = process.env["NAUTILO_INSTANCE_ID"];
  const savedHome = process.env["HOME"];

  beforeAll(() => {
    userHomeDir = mkdtempSync(join(tmpdir(), "nautilo-restore-mig-"));
  });

  afterAll(() => {
    if (savedInstance === undefined) delete process.env["NAUTILO_INSTANCE_ID"];
    else process.env["NAUTILO_INSTANCE_ID"] = savedInstance;
    if (savedHome === undefined) delete process.env["HOME"];
    else process.env["HOME"] = savedHome;
    __resetResolvedInstanceForTests();
    rmSync(userHomeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    process.env["HOME"] = userHomeDir;
    __resetResolvedInstanceForTests();
  });

  afterEach(() => {
    __resetResolvedInstanceForTests();
  });

  test("omitted container falls back to the resolved instance's legacyPostgres", () => {
    delete process.env["NAUTILO_INSTANCE_ID"];
    __resetResolvedInstanceForTests();
    const expected = resolveInstance().compose.containers.legacyPostgres;
    const target = resolvePsqlExecTarget();
    expect(target.container).toBe(expected);
    expect(target.db).toBe("nautilo");
  });

  test("default db is 'nautilo' when db arg is omitted", () => {
    const target = resolvePsqlExecTarget("some-container");
    expect(target.db).toBe("nautilo");
  });

  test("explicit container override is preserved unchanged", () => {
    const target = resolvePsqlExecTarget("my-explicit-postgres");
    expect(target.container).toBe("my-explicit-postgres");
  });

  test("explicit db override is preserved unchanged", () => {
    const target = resolvePsqlExecTarget("some-container", "other-db");
    expect(target.db).toBe("other-db");
  });

  test("named NAUTILO_INSTANCE_ID routes container through the resolver (not the default)", () => {
    process.env["NAUTILO_INSTANCE_ID"] = "stack-198";
    __resetResolvedInstanceForTests();
    const expected = resolveInstance().compose.containers.legacyPostgres;
    const target = resolvePsqlExecTarget();
    expect(target.container).toBe(expected);
    // The original bug: a named instance silently fell back to the
    // hardcoded (default) `nautilo-postgres`. The derived name for a
    // named instance must be its own project's container.
    expect(target.container).not.toBe("nautilo-postgres");
    expect(target.container).toBe("nautilo-stack-198-postgres");
  });

  test("rejects unsafe container names (shell-injection guard)", () => {
    expect(() => resolvePsqlExecTarget("nautilo;rm -rf /")).toThrow(
      /safe docker identifier/,
    );
    expect(() => resolvePsqlExecTarget("nautilo-postgres\nevil")).toThrow(
      /safe docker identifier/,
    );
  });

  test("rejects unsafe db names (shell-injection guard)", () => {
    expect(() => resolvePsqlExecTarget("ok-container", "db;psql")).toThrow(
      /safe docker identifier/,
    );
  });

  test("treats whitespace-only container as omitted (uses resolver default)", () => {
    delete process.env["NAUTILO_INSTANCE_ID"];
    __resetResolvedInstanceForTests();
    const expected = resolveInstance().compose.containers.legacyPostgres;
    const target = resolvePsqlExecTarget("   ");
    expect(target.container).toBe(expected);
  });
});
