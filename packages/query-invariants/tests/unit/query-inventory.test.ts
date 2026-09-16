import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  QUERY_INVENTORY_SCHEMA_VERSION,
  auditQueryInventory,
  auditFullDrizzleSample,
  auditReviewedQueryDecisions,
  discoverQueryInventory,
  discoverQueriesInSource,
  fullDrizzleSampleSummary,
  parseFullDrizzleSample,
  parseQueryInventory,
  parseReviewedQueryDecisions,
  queryInventorySummary,
  reviewedQuerySummary,
  serializeReviewedQueryDecisions,
  serializeQueryInventory,
  type QueryInventoryDocument,
  type FullDrizzleSampleDocument,
  type ReviewedQueryDecisionDocument,
} from "../../src/node/query-inventory";

describe("M223 query inventory", () => {
  test("ignores transient tsup configuration bundles created during parallel CI", async () => {
    const repositoryRoot = await mkdtemp(join(tmpdir(), "nautilo-query-inventory-"));
    const packageRoot = join(repositoryRoot, "apps", "cli");
    await mkdir(packageRoot, { recursive: true });
    await writeFile(
      join(packageRoot, "tsup.config.bundled_ci123.mjs"),
      "db.query(`SELECT id FROM users`);",
    );
    await writeFile(
      join(packageRoot, "source.ts"),
      "db.query(`SELECT id FROM users LIMIT 1`);",
    );

    try {
      const inventory = await discoverQueryInventory(repositoryRoot);
      expect(inventory.observations.map((item) => item.path)).toEqual([
        "apps/cli/source.ts",
      ]);
    } finally {
      await rm(repositoryRoot, { recursive: true, force: true });
    }
  });

  test("discovers direct statements and SQL fragments with stable classifications", () => {
    const observations = discoverQueriesInSource(
      "packages/runtime/src/store/example.ts",
      `
        async function load(db: Database, id: string) {
          const rows = await db.query(\`SELECT id FROM users WHERE id = \${id} LIMIT 1\`);
          return db.execute(sql\`SELECT count(*) FROM \${users}\`);
        }
        const rank = sql\`ts_rank(search_vector, query)\`;
        const ordering = sql.raw("created_at DESC");
      `,
    );

    expect(observations).toHaveLength(4);
    expect(observations.map((item) => item.operation).sort()).toEqual(["fragment", "fragment", "select", "select"]);
    const ordinarySelect = observations.find((item) => item.handle === "db")!;
    const fragment = observations.find((item) => item.operation === "fragment")!;
    expect(ordinarySelect).toMatchObject({
      owner: "packages/runtime",
      reachability: "live",
      proposedDisposition: "drizzle_builder",
      safetyOpportunity: "full_drizzle",
      boundedness: "bounded",
    });
    expect(fragment).toMatchObject({
      proposedDisposition: "typed_db_primitive",
      safetyOpportunity: "typed_containment",
    });
  });

  test("does not promote embedded select fragments to full statements", () => {
    const [fragment, transport] = discoverQueriesInSource(
      "packages/server/src/rooms.ts",
      `
        const visible = sql\`(SELECT count(*) FROM memberships WHERE room_id = \${rooms.id}) > 0\`;
        async function load(sql: Sql) {
          return sql\`SELECT id FROM rooms LIMIT 1\`;
        }
      `,
    );

    expect(fragment).toMatchObject({ operation: "fragment", safetyOpportunity: "typed_containment" });
    expect(transport).toMatchObject({ operation: "select", safetyOpportunity: "full_drizzle" });
  });

  test("contains PostgreSQL vector casts and sequence primitives", () => {
    const observations = discoverQueriesInSource(
      "packages/trust/src/mutations.ts",
      `
        db.execute(sql\`UPDATE memories SET embedding = \${embedding}::vector WHERE id = \${id}\`);
        db.execute(sql\`SELECT nextval(pg_get_serial_sequence('messages', 'id'))\`);
      `,
    );

    expect(observations.map((item) => item.features).sort()).toEqual([["sequence"], ["vector", "dynamic_sql"]]);
    expect(observations.every((item) => item.safetyOpportunity === "typed_containment")).toBe(true);
  });

  test("classifies tests, operators, migrations, external schemas, and security features", () => {
    const testQuery = discoverQueriesInSource("packages/db/tests/example.test.ts", "db.execute(sql`DELETE FROM users`);")[0]!;
    const operatorQuery = discoverQueriesInSource("bin/nautilo-dev/src/check.ts", "db.execute(sql`SELECT * FROM users`);")[0]!;
    const migrationQuery = discoverQueriesInSource("packages/db/src/migrations/001.ts", "db.execute(sql`ALTER TABLE users ADD x text`);")[0]!;
    const externalQuery = discoverQueriesInSource("packages/server/src/logto.ts", "db.execute(sql`SELECT * FROM logto.users`);")[0]!;
    const lockedQuery = discoverQueriesInSource("packages/trust/src/store.ts", "db.execute(sql`SELECT * FROM grants FOR UPDATE SKIP LOCKED`);")[0]!;

    expect(testQuery.proposedDisposition).toBe("test_only");
    expect(operatorQuery.proposedDisposition).toBe("dev_operator");
    expect(migrationQuery.reachability).toBe("migration");
    expect(externalQuery.reachability).toBe("external");
    expect(lockedQuery).toMatchObject({ securitySensitive: true, safetyOpportunity: "typed_containment" });
    expect(lockedQuery.features).toEqual(["locking", "skip_locked"]);
  });

  test("fails closed for dynamic database SQL", () => {
    const [observation] = discoverQueriesInSource(
      "packages/server/src/dynamic.ts",
      "async function run(db: Database, statement: string) { return db.query(statement); }",
    );
    expect(observation).toMatchObject({
      operation: "unresolved",
      features: ["dynamic_sql"],
      safetyOpportunity: "retain_direct",
    });
  });

  test("does not confuse generic execute payload fields with SQL verbs", () => {
    const observations = discoverQueriesInSource(
      "packages/runtime/src/memory/port.ts",
      `
        async function authorizeCommit(execute: AuthorityExecutor, request: Request) {
          return execute({ operation: "encrypt", commit: request.commit });
        }
        async function protectedOperation(input: Input) {
          return input.authority.execute({ operation: "write", commit: input.commit });
        }
      `,
    );
    expect(observations).toEqual([]);
  });

  test("discovers psql statements without fingerprinting surrounding shell", () => {
    const observation = discoverQueriesInSource(
      "dev/scripts/check.sh",
      "#!/bin/sh\npsql \"$DATABASE_URL\" -c 'SELECT id FROM users;'\n",
    )[0]!;
    const sameSql = discoverQueriesInSource(
      "dev/scripts/check.sh",
      "#!/usr/bin/env bash\nset -eu\npsql \"$DATABASE_URL\" -c 'SELECT id FROM users;'\n",
    )[0]!;
    expect(observation).toMatchObject({ operation: "select", handle: "psql", reachability: "operator" });
    expect(observation.fingerprint).toBe(sameSql.fingerprint);
  });

  test("reports added, removed, and structurally changed observations", () => {
    const first = discoverQueriesInSource("packages/server/src/a.ts", "db.query(`SELECT id FROM users`);")[0]!;
    const changed = discoverQueriesInSource("packages/server/src/a.ts", "db.query(`SELECT name FROM users`);")[0]!;
    const added = { ...first, locator: "packages/server/src/a.ts#next:raw_sql:select:1" };
    const document = (observations: QueryInventoryDocument["observations"]): QueryInventoryDocument => ({
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      observations,
    });

    expect(auditQueryInventory(document([first]), document([changed, added]))).toMatchObject({
      ok: false,
      added: [added.locator],
      removed: [],
      changed: [first.locator],
    });
    expect(auditQueryInventory(document([first, added]), document([first]))).toMatchObject({
      ok: false,
      removed: [added.locator],
    });
    expect(parseQueryInventory(serializeQueryInventory(document([first])))).toEqual(document([first]));

    expect(queryInventorySummary(document([first, added]))).toMatchObject({
      total: 2,
      liveConsumerOwned: {
        total: 2,
        bySafetyOpportunity: { full_drizzle: 2 },
      },
    });
  });

  test("rejects unknown classification enum values from persisted baselines", () => {
    const observation = discoverQueriesInSource(
      "packages/server/src/a.ts",
      "db.query(`SELECT id FROM users`);",
    )[0]!;
    const serialized = serializeQueryInventory({
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      observations: [observation],
    });
    expect(() => parseQueryInventory(serialized.replace('"operation":"select"', '"operation":"magic"')))
      .toThrow("query inventory observation has invalid operation");
  });

  test("rejects unknown reviewed decision enum values", () => {
    const header = JSON.stringify({
      type: "reviewed-query-decisions",
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
    });
    const invalid = JSON.stringify({
      locator: "example",
      fingerprint: "fingerprint",
      outcome: "guessed_statement",
      reviewedDisposition: "typed_db_primitive",
      reviewedSafetyOpportunity: "retain_direct",
      rationale: "test",
    });
    expect(() => parseReviewedQueryDecisions(`${header}\n${invalid}\n`))
      .toThrow("reviewed query decision has invalid outcome");
  });

  test("rejects covered-elsewhere as a full-Drizzle sample result", () => {
    const header = JSON.stringify({
      type: "full-drizzle-sample",
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
    });
    const invalid = JSON.stringify({
      locator: "example",
      fingerprint: "fingerprint",
      reviewedSafetyOpportunity: "covered_elsewhere",
      rationale: "test",
    });
    expect(() => parseFullDrizzleSample(`${header}\n${invalid}\n`))
      .toThrow("full-Drizzle sample decision has invalid reviewedSafetyOpportunity");
  });

  test("pins reviewed uncertainty decisions to exact current fingerprints", () => {
    const observation = discoverQueriesInSource(
      "packages/server/src/dynamic.ts",
      "async function run(db: Database, statement: string) { return db.query(statement); }",
    )[0]!;
    const inventory: QueryInventoryDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      observations: [observation],
    };
    const reviews: ReviewedQueryDecisionDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      decisions: [{
        locator: observation.locator,
        fingerprint: observation.fingerprint,
        outcome: "transport_adapter",
        reviewedDisposition: "typed_db_primitive",
        reviewedSafetyOpportunity: "retain_direct",
        rationale: "The typed adapter deliberately owns a dynamic PostgreSQL transport boundary.",
      }],
    };

    expect(auditReviewedQueryDecisions({ inventory, reviews })).toMatchObject({ ok: true });
    expect(reviewedQuerySummary({ inventory, reviews })).toMatchObject({
      reviewedDecisions: 1,
      sampledFullDrizzleDecisions: 0,
      effectiveLiveConsumerOwned: 1,
      bySafetyOpportunity: { retain_direct: 1 },
    });
    expect(parseReviewedQueryDecisions(serializeReviewedQueryDecisions(reviews))).toEqual(reviews);
    expect(auditReviewedQueryDecisions({
      inventory: { ...inventory, observations: [{ ...observation, fingerprint: "changed" }] },
      reviews,
    })).toMatchObject({ ok: false, changed: [observation.locator] });
  });

  test("accepts a reviewed retain-direct decision for a full-Drizzle proposal", () => {
    const observation = discoverQueriesInSource(
      "packages/db/src/pre-schema.ts",
      "db.query(`SELECT datname FROM pg_database`);",
    )[0]!;
    const inventory: QueryInventoryDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      observations: [observation],
    };
    const reviews: ReviewedQueryDecisionDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      decisions: [{
        locator: observation.locator,
        fingerprint: observation.fingerprint,
        outcome: "confirmed_statement",
        reviewedDisposition: "typed_db_primitive",
        reviewedSafetyOpportunity: "retain_direct",
        rationale: "The pre-schema probe targets PostgreSQL's catalog rather than application tables.",
      }],
    };

    expect(auditReviewedQueryDecisions({ inventory, reviews })).toMatchObject({
      ok: true,
    });
  });

  test("pins a deterministic stratified sample of full-Drizzle proposals", () => {
    const observations = ["a", "b", "c", "d", "e"].map((symbol) =>
      discoverQueriesInSource(
        "packages/server/src/store.ts",
        `db.query(\`SELECT id FROM users WHERE name = '${symbol}'\`);`,
      )[0]!
    ).map((item, index) => ({ ...item, locator: `${item.locator}:${index}` }));
    const inventory: QueryInventoryDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      observations,
    };
    const picked = [observations[0]!, observations[2]!, observations[4]!];
    const sample: FullDrizzleSampleDocument = {
      schemaVersion: QUERY_INVENTORY_SCHEMA_VERSION,
      purpose: "test",
      decisions: picked.map((item) => ({
        locator: item.locator,
        fingerprint: item.fingerprint,
        reviewedSafetyOpportunity: "full_drizzle",
        rationale: "The schema-owned select is directly expressible by the typed query builder.",
      })),
    };

    expect(auditFullDrizzleSample({ inventory, sample })).toMatchObject({ ok: true });
    expect(fullDrizzleSampleSummary(sample)).toMatchObject({
      reviewedDecisions: 3,
      observedFullDrizzlePrecision: 1,
    });
    expect(auditFullDrizzleSample({ inventory, sample: { ...sample, decisions: sample.decisions.slice(1) } }))
      .toMatchObject({ ok: false, removed: [picked[0]!.locator] });
  });
});
