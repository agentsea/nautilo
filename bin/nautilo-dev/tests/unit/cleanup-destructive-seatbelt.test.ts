/**
 * Stack 198 / D266 — no-DB unit tests for the D374 default-DB seatbelt
 * SQL helper (`destructiveSeatbeltSql` + `DESTRUCTIVE_SEATBELT_GUC`).
 *
 * Why a pure helper test: `cleanupTestCruft` builds its own
 * `createDirectDb` and runs an inline `db.transaction` — there is no
 * transaction-injection seam, so the live `tx.execute(sql.raw(...))`
 * call inside the transaction cannot be exercised in a no-DB unit test.
 * The exact SQL string that lifts the D374 seatbelt is therefore
 * captured in a pure helper and locked here. The transaction body is
 * expected to call `tx.execute(sql.raw(destructiveSeatbeltSql()))` as
 * the first statement after `assertDeletionOrderInvariant` and before
 * any mutation.
 *
 * Residual coverage limitation (stated plainly): these tests verify the
 * pure SQL helper only. They do NOT verify:
 *   - that the live `tx.execute(sql.raw(destructiveSeatbeltSql()))` call
 *     is actually present inside the transaction body (that is a code-
 *     review invariant, not a no-DB-testable one);
 *   - that the call is positioned AFTER all manifest/fingerprint/keep-
 *     list/cap/high-footprint/default-guard/ordering checks and BEFORE
 *     the first mutation (same — code-review invariant);
 *   - that the seatbelt is actually lifted at runtime against a real
 *     Postgres with the D374 trigger installed (requires a live default
 *     DB; out of scope for no-DB unit tests).
 * The structural reachability guarantee (plan-json / dry-run paths
 * `return` before `db.transaction` opens, so the setting can never be
 * reached in read-only modes) is likewise a code-review invariant, not
 * exercised here.
 */
import { describe, expect, test } from "bun:test";
import {
  DESTRUCTIVE_SEATBELT_GUC,
  destructiveSeatbeltSql,
} from "../../src/commands/cleanup-test-cruft";

describe("destructiveSeatbeltSql — D374 seatbelt lift SQL (no DB)", () => {
  test("returns the exact expected transaction-local SQL string", () => {
    expect(destructiveSeatbeltSql()).toBe(
      "SET LOCAL nautilo.allow_destructive = '1'",
    );
  });

  test("targets the exact D374 GUC name", () => {
    expect(DESTRUCTIVE_SEATBELT_GUC).toBe("nautilo.allow_destructive");
    expect(destructiveSeatbeltSql()).toContain(
      `SET LOCAL ${DESTRUCTIVE_SEATBELT_GUC}`,
    );
  });

  test("uses SET LOCAL (transaction-scoped), never a session/global SET", () => {
    const sqlStr = destructiveSeatbeltSql();
    expect(sqlStr.startsWith("SET LOCAL ")).toBe(true);
    // A bare session-level "SET nautilo.allow_destructive" (no LOCAL) would
    // leak the escape hatch past the transaction boundary — reject it.
    expect(sqlStr).not.toMatch(/^SET nautilo\.allow_destructive\b/);
    expect(sqlStr.toLowerCase()).not.toContain("session");
  });

  test("sets a D374-accepted truthy value", () => {
    // The D374 trigger accepts 1 / true / yes / on (case-insensitive).
    // The helper pins '1' — assert exactly that literal, quoted.
    expect(destructiveSeatbeltSql()).toMatch(/= '1'$/);
    expect(destructiveSeatbeltSql()).toContain("= '1'");
  });

  test("is deterministic / idempotent (same string every call)", () => {
    const a = destructiveSeatbeltSql();
    const b = destructiveSeatbeltSql();
    const c = destructiveSeatbeltSql();
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  test("contains no caller input / interpolation surface (constant literal)", () => {
    // The helper takes no arguments and emits a constant string, so there
    // is no injection surface. Guard against a future refactor that adds a
    // parameter by asserting the function takes zero args.
    expect(destructiveSeatbeltSql.length).toBe(0);
    const sqlStr = destructiveSeatbeltSql();
    expect(sqlStr).not.toContain("${");
    expect(sqlStr).not.toContain("$1");
  });

  test("regression guard: SQL string matches the D374 trigger's documented escape hatch", () => {
    // The D374 trigger error string names the exact escape hatch:
    //   "without SET nautilo.allow_destructive=1"
    // The helper must emit a transaction-local form of that same setting.
    expect(destructiveSeatbeltSql()).toBe("SET LOCAL nautilo.allow_destructive = '1'");
  });
});
