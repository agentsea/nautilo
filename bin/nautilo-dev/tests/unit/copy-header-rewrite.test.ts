import { describe, test, expect } from "bun:test";
import {
  applyCopyHeaderRewrite,
  dropColumnsHeaderRewrite,
  RESTORE_MIGRATIONS,
} from "../../src/lib/restore-migrations";

/**
 * Covers the D140 `is_bootstrap_seed` drift fix: a snapshot taken before
 * the column was dropped still carries it in the COPY block. The restore
 * path strips the obsolete column from the header AND every data row,
 * preserving all surviving values byte-for-byte.
 */
describe("applyCopyHeaderRewrite — value-preserving column drop", () => {
  // A realistic agents COPY block: the dropped column sits in the MIDDLE,
  // and one row carries a jsonb value with embedded tabs-as-\t and a
  // backslash, to prove we never re-serialise surviving fields.
  const block =
    'COPY public.agents (id, handle, is_bootstrap_seed, config, created_at) FROM stdin;\n' +
    'a1\tjeannie\tt\t{"k": "v\\\\x", "n": 1}\t2026-06-05 10:00:00\n' +
    'a2\tgenie\tf\t\\N\t2026-06-05 11:00:00\n' +
    "\\.\n";

  test("drops the named column from the header and every row", () => {
    const out = applyCopyHeaderRewrite(
      block,
      dropColumnsHeaderRewrite(["is_bootstrap_seed"]),
    );
    expect(out).not.toBeNull();
    const lines = out!.split("\n");

    expect(lines[0]).toBe(
      "COPY public.agents (id, handle, config, created_at) FROM stdin;",
    );
    // is_bootstrap_seed value (`t` / `f`) removed; every other field is
    // preserved exactly, including the jsonb literal and the \N null.
    expect(lines[1]).toBe('a1\tjeannie\t{"k": "v\\\\x", "n": 1}\t2026-06-05 10:00:00');
    expect(lines[2]).toBe("a2\tgenie\t\\N\t2026-06-05 11:00:00");
    expect(lines[3]).toBe("\\.");
  });

  test("no-op when the column is already absent (newer dump)", () => {
    const already =
      "COPY public.agents (id, handle) FROM stdin;\n" +
      "a1\tjeannie\n" +
      "\\.\n";
    const out = applyCopyHeaderRewrite(
      already,
      dropColumnsHeaderRewrite(["is_bootstrap_seed"]),
    );
    expect(out).toBe(already);
  });

  test("null rewrite drops the whole COPY block", () => {
    const out = applyCopyHeaderRewrite(block, () => null);
    expect(out).toBeNull();
  });

  test("throws if the rewrite names a column the dump never had", () => {
    expect(() =>
      applyCopyHeaderRewrite(
        block,
        () =>
          "COPY public.agents (id, handle, bogus, created_at) FROM stdin;",
      ),
    ).toThrow(/not present in the dump/);
  });

  test("handles an empty COPY body", () => {
    const empty =
      "COPY public.users (id, name, is_bootstrap_seed) FROM stdin;\n\\.\n";
    const out = applyCopyHeaderRewrite(
      empty,
      dropColumnsHeaderRewrite(["is_bootstrap_seed"]),
    );
    expect(out).toBe("COPY public.users (id, name) FROM stdin;\n\\.\n");
  });

  test("matches quoted pg_dump identifiers by their PostgreSQL name", () => {
    const quoted =
      'COPY public.example (id, "position", obsolete) FROM stdin;\n' +
      "a1\t0\told\n" +
      "\\.\n";
    const out = applyCopyHeaderRewrite(
      quoted,
      dropColumnsHeaderRewrite(["obsolete"]),
    );
    expect(out).toBe(
      'COPY public.example (id, "position") FROM stdin;\n' +
      "a1\t0\n" +
      "\\.\n",
    );
  });
});

/**
 * M043 credentials/recovery_codes are re-keyed conditionally: a PRE-M043
 * dump (actor_id) drops its COPY and is remapped via postRestore; a
 * POST-M043 dump (user_id) COPYs directly. Lock that branch decision.
 */
describe("M043 conditional remap rules (credentials / recovery_codes)", () => {
  for (const table of ["public.credentials", "public.recovery_codes"]) {
    const rule = RESTORE_MIGRATIONS.find((r) => r.table === table)!;

    test(`${table}: rule is present with a conditional header rewrite`, () => {
      expect(rule).toBeDefined();
      expect(rule.rewriteCopyHeader).toBeDefined();
      expect(rule.skipCopy).toBeFalsy();
    });

    test(`${table}: pre-M043 dump (actor_id) drops the COPY`, () => {
      const header = `COPY ${table} (id, actor_id, value) FROM stdin;`;
      expect(
        rule.rewriteCopyHeader!(header, ["id", "actor_id", "value"]),
      ).toBeNull();
    });

    test(`${table}: post-M043 dump (user_id) keeps the COPY`, () => {
      const header = `COPY ${table} (id, user_id, value) FROM stdin;`;
      expect(
        rule.rewriteCopyHeader!(header, ["id", "user_id", "value"]),
      ).toBe(header);
    });
  }
});
