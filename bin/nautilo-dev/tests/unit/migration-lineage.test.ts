import approvedCommentRedactions from "../../../../dev/tools/db-migration-safety/comment-redactions.json";
import approvedAppliedRewrites from "../../src/lib/applied-migration-rewrites.json";
import { describe, expect, test } from "bun:test";
import {
  assertExactMigrationPrefix,
  captureDatabaseMigrationLineage,
  mapDatabaseLedgerToCheckout,
  parseDatabaseMigrationLedger,
  planMigrationLineageReconciliation,
  type MigrationLineageEntry,
} from "../../src/lib/migration-lineage";

const checkout: MigrationLineageEntry[] = [
  { index: 0, tag: "0000_first", createdAt: 100, sha256: "a".repeat(64) },
  { index: 1, tag: "0001_second", createdAt: 200, sha256: "b".repeat(64) },
  { index: 2, tag: "0002_third", createdAt: 300, sha256: "c".repeat(64) },
];

describe("migration lineage", () => {
  test("parses the exact Drizzle ledger transport and rejects malformed rows", () => {
    expect(parseDatabaseMigrationLedger(
      `100|${"a".repeat(64)}\n200|${"b".repeat(64)}`,
    )).toEqual([
      { createdAt: 100, sha256: "a".repeat(64) },
      { createdAt: 200, sha256: "b".repeat(64) },
    ]);
    expect(parseDatabaseMigrationLedger("   ")).toEqual([]);
    expect(() => parseDatabaseMigrationLedger("100|not-a-hash")).toThrow(
      "Invalid database migration row at position 0",
    );
  });
  test("maps an exact database ledger to checkout metadata", () => {
    expect(
      mapDatabaseLedgerToCheckout(
        checkout.slice(0, 2).map((entry) => ({
          createdAt: entry.createdAt,
          sha256: entry.sha256,
        })),
        checkout,
      ),
    ).toEqual(checkout.slice(0, 2));
  });

  test("rejects an ahead, divergent, or invalid database ledger", () => {
    expect(() =>
      mapDatabaseLedgerToCheckout(
        [...checkout, { index: 3, tag: "0003_next", createdAt: 400, sha256: "d".repeat(64) }],
        checkout,
      ),
    ).toThrow("branch migration journal is older");
    expect(() =>
      mapDatabaseLedgerToCheckout(
        [{ createdAt: 100, sha256: "f".repeat(64) }],
        checkout,
      ),
    ).toThrow("different migration hash");
    expect(() =>
      mapDatabaseLedgerToCheckout(
        [{ createdAt: 99, sha256: "a".repeat(64) }],
        checkout,
      ),
    ).toThrow("source timestamp 99, branch timestamp 100");
    expect(() =>
      mapDatabaseLedgerToCheckout(
        [
          { createdAt: 100, sha256: "a".repeat(64) },
          { createdAt: 100, sha256: "b".repeat(64) },
        ],
        checkout,
      ),
    ).toThrow("source timestamp 100, branch timestamp 200");
  });

  test("requires the running source to be an exact branch prefix with safe pending timestamps", () => {
    expect(() => assertExactMigrationPrefix(checkout.slice(0, 2), checkout)).not.toThrow();
    expect(() => assertExactMigrationPrefix(checkout, checkout.slice(0, 2))).toThrow(
      "branch migration journal is older",
    );
    expect(() =>
      assertExactMigrationPrefix(
        [{ ...checkout[0]!, createdAt: 99 }],
        checkout,
      ),
    ).toThrow("numbering/timestamps");
    expect(() =>
      assertExactMigrationPrefix(
        [{ ...checkout[0]!, tag: "0000_other" }],
        checkout,
      ),
    ).toThrow("history diverges");
    expect(() =>
      assertExactMigrationPrefix(
        [
          checkout[0]!,
          { ...checkout[1]!, createdAt: 300 },
        ],
        [
          checkout[0]!,
          { ...checkout[1]!, createdAt: 300 },
          { ...checkout[2]!, createdAt: 250 },
        ],
      ),
    ).toThrow("timestamp is too old");
  });

  test("preserves matching historical timestamp inversions already applied", () => {
    const historical = [
      checkout[0]!,
      { ...checkout[1]!, createdAt: 300 },
      { ...checkout[2]!, createdAt: 200 },
    ];
    expect(() => assertExactMigrationPrefix(historical, historical)).not.toThrow();
    expect(
      mapDatabaseLedgerToCheckout(
        historical.map((entry) => ({
          createdAt: entry.createdAt,
          sha256: entry.sha256,
        })),
        historical,
      ),
    ).toEqual(historical);
  });

  test("captures source lineage without requiring it to be a checkout prefix", () => {
    const sourceOnlyHash = "d".repeat(64);
    expect(captureDatabaseMigrationLineage([
      { createdAt: 100, sha256: checkout[0]!.sha256 },
      { createdAt: 999, sha256: checkout[2]!.sha256 },
      { createdAt: 150, sha256: sourceOnlyHash },
    ], checkout)).toEqual([
      checkout[0]!,
      { index: 1, tag: "0002_third", createdAt: 999, sha256: checkout[2]!.sha256 },
      {
        index: 2,
        tag: `source-opaque-0002-${sourceOnlyHash.slice(0, 12)}`,
        createdAt: 150,
        sha256: sourceOnlyHash,
      },
    ]);
    expect(() => captureDatabaseMigrationLineage([
      { createdAt: Number.NaN, sha256: checkout[0]!.sha256 },
    ], checkout)).toThrow("invalid entry at index 0");
    expect(() => captureDatabaseMigrationLineage([
      { createdAt: 100, sha256: "not-a-hash" },
    ], checkout)).toThrow("invalid entry at index 0");
  });

  test("plans exact-prefix sources without changing existing lineage rules", () => {
    expect(planMigrationLineageReconciliation(checkout.slice(0, 2), checkout)).toEqual({
      kind: "exact-prefix",
      commonPrefixLength: 2,
      alreadyAppliedCheckout: checkout.slice(0, 2),
      missingCheckout: checkout.slice(2),
      sourceOnly: [],
    });
  });

  test("reconciles divergent ledgers by SQL hash after an exact common prefix", () => {
    const sourceOnly = {
      index: 1,
      tag: `source-opaque-0001-${"d".repeat(12)}`,
      createdAt: 999,
      sha256: "d".repeat(64),
    };
    const relocatedCheckoutMigration = {
      index: 2,
      tag: "historical-renumbered",
      createdAt: 123,
      sha256: checkout[2]!.sha256,
    };
    const source = [checkout[0]!, sourceOnly, relocatedCheckoutMigration];

    expect(planMigrationLineageReconciliation(source, checkout)).toEqual({
      kind: "divergent",
      commonPrefixLength: 1,
      alreadyAppliedCheckout: [checkout[0]!, checkout[2]!],
      missingCheckout: [checkout[1]!],
      sourceOnly: [sourceOnly],
    });
  });

  test("does not replay exact recorded comment redactions or rewrite source evidence", () => {
    for (const receipt of approvedCommentRedactions.redactions) {
      const redacted = {
        index: 1, createdAt: 200,
        tag: receipt.path.split("/").at(-1)!.replace(/\.sql$/u, ""),
        sha256: receipt.afterSha256,
      };
      const current = [checkout[0]!, redacted, checkout[2]!];
      const source = captureDatabaseMigrationLineage([
        checkout[0]!, {createdAt: 200, sha256: receipt.beforeSha256},
      ], current);
      const before = structuredClone(source);
      expect(planMigrationLineageReconciliation(source, current)).toEqual({
        kind: "divergent", commonPrefixLength: 1,
        alreadyAppliedCheckout: current.slice(0, 2),
        missingCheckout: [checkout[2]!], sourceOnly: [],
      });
      expect(source).toEqual(before);
      expect(source[1]!.sha256).toBe(receipt.beforeSha256);
      expect(() => assertExactMigrationPrefix(source, current)).toThrow("history diverges");

      // A receipt must match both the exact checkout path and resulting bytes.
      for (const changed of [
        {...redacted, tag: "0001_unrecorded"},
        {...redacted, sha256: "e".repeat(64)},
      ]) {
        const rejected = planMigrationLineageReconciliation(source, [checkout[0]!, changed]);
        expect(rejected.missingCheckout).toEqual([changed]);
        expect(rejected.sourceOnly).toEqual([source[1]!]);
      }
      const reversedCheckout = {...redacted, sha256: receipt.beforeSha256};
      expect(planMigrationLineageReconciliation(
        [checkout[0]!, redacted], [checkout[0]!, reversedCheckout],
      ).missingCheckout).toEqual([reversedCheckout]);
      const unknown = {...source[1]!, sha256: "f".repeat(64)};
      expect(planMigrationLineageReconciliation([source[0]!, unknown], current).missingCheckout)
        .toEqual([redacted, checkout[2]!]);
      expect(() => planMigrationLineageReconciliation([source[1]!], [redacted]))
        .toThrow("no exact common prefix");
    }
  });

  test("refuses divergent or hash-overlapping ledgers with no exact common prefix", () => {
    expect(() => planMigrationLineageReconciliation([
      { ...checkout[0]!, tag: "renamed-first" },
      checkout[1]!,
    ], checkout)).toThrow("no exact common prefix");
    expect(() => planMigrationLineageReconciliation([
      { index: 0, tag: "foreign", createdAt: 1, sha256: "f".repeat(64) },
    ], checkout)).toThrow("no exact common prefix");
    expect(() => planMigrationLineageReconciliation([], checkout)).toThrow(
      "no exact common prefix",
    );
  });
});


describe("approved comment-redaction clone reconciliation", () => {
  for (const redaction of approvedCommentRedactions.redactions) {
    test(`does not replay ${redaction.path}`, () => {
      const current: MigrationLineageEntry = {
        index: 1, tag: redaction.path.split("/").at(-1)!.replace(/\.sql$/, ""),
        createdAt: 200, sha256: redaction.afterSha256,
      };
      const prior = { ...current, tag: "source-opaque-0001", sha256: redaction.beforeSha256 };
      const plan = planMigrationLineageReconciliation([checkout[0]!, prior], [checkout[0]!, current]);
      expect(plan.kind).toBe("divergent");
      expect(plan.missingCheckout).toEqual([]);
      expect(plan.alreadyAppliedCheckout).toEqual([checkout[0]!, current]);
      expect(plan.sourceOnly).toEqual([]);
      // Neither a changed SQL hash, wrong migration path nor timestamp can alias.
      for (const invalid of [
        { ...current, sha256: "f".repeat(64) },
        { ...current, tag: "unapproved" },
        { ...current, createdAt: 201 },
      ]) {
        const rejected = planMigrationLineageReconciliation([checkout[0]!, prior], [checkout[0]!, invalid]);
        expect(rejected.missingCheckout).toEqual([invalid]);
        expect(rejected.sourceOnly).toEqual([prior]);
      }
    });
  }
});

describe("approved already-applied migration rewrites", () => {
  for (const rewrite of approvedAppliedRewrites.rewrites) {
    test(`does not replay ${rewrite.path}`, () => {
      const tag = rewrite.path.split("/").at(-1)!.replace(/\.sql$/, "");
      const current: MigrationLineageEntry = {
        index: 1,
        tag,
        createdAt: rewrite.createdAt,
        sha256: rewrite.afterSha256,
      };
      const prior: MigrationLineageEntry = {
        ...current,
        tag: `source-opaque-0001-${rewrite.beforeSha256.slice(0, 12)}`,
        sha256: rewrite.beforeSha256,
      };
      const plan = planMigrationLineageReconciliation([checkout[0]!, prior], [checkout[0]!, current]);
      expect(plan.kind).toBe("divergent");
      expect(plan.missingCheckout).toEqual([]);
      expect(plan.alreadyAppliedCheckout).toEqual([checkout[0]!, current]);
      expect(plan.sourceOnly).toEqual([]);

      for (const invalid of [
        { ...current, tag: "unapproved" },
        { ...current, createdAt: rewrite.createdAt + 1 },
        { ...current, sha256: "f".repeat(64) },
      ]) {
        const rejected = planMigrationLineageReconciliation(
          [checkout[0]!, prior],
          [checkout[0]!, invalid],
        );
        expect(rejected.missingCheckout).toEqual([invalid]);
        expect(rejected.sourceOnly).toEqual([prior]);
      }
    });
  }
});
