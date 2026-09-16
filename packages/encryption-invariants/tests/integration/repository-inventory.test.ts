import {
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  BASELINE_REGISTRY,
  WAVE_0_FROZEN_BASELINE_DEBT,
} from "../../baseline/existing-debt";
import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { formatCoverageReport } from "../../src/report";
import {
  collectRepositoryInventory,
  repositoryReportInput,
  type RepositoryInventory,
  verifyRepositoryInventory,
} from "../../src/node/repository-inventory";

const repositoryRoot = join(import.meta.dir, "../../../..");
const generatedReportPath = join(
  import.meta.dir,
  "../../generated/encryption-coverage.md",
);
let actualInventory: RepositoryInventory;
setDefaultTimeout(120_000);

beforeAll(async () => {
  actualInventory = await collectRepositoryInventory(repositoryRoot);
});

describe("actual repository coverage inventory", () => {
  test("has no new or stale observation, declaration, migration, or alarm drift", async () => {
    const inventory = actualInventory;
    expect(verifyRepositoryInventory(inventory, BASELINE_REGISTRY)).toEqual({
      ok: true,
      errors: [],
    });
    expect(inventory.observations.length).toBeGreaterThan(1_000);
    expect(inventory.schema.objects.filter((item) => item.kind === "table")).toHaveLength(205);
    expect(inventory.schema.columns).toHaveLength(2_764);
    expect(inventory.observations.filter((item) =>
      item.surface === "db" && item.locator === "public.session_messages"
    ).map(({ id, surface, locator }) => ({ id, surface, locator }))).toEqual([{
      id: "db.public.session_messages",
      surface: "db",
      locator: "public.session_messages",
    }]);
    expect(inventory.dto).toHaveLength(815);
    expect(inventory.source.observations).toHaveLength(52);
    expect(inventory.source.alarms.length).toBeGreaterThan(2_000);
    expect(inventory.source.alarmReviews.errors).toEqual([]);
    expect(inventory.source.alarmReviews.reviews).toHaveLength(
      inventory.source.alarms.length,
    );
    expect(
      inventory.source.alarmReviews.counts.declaration
      + inventory.source.alarmReviews.counts.baselineDebt
      + inventory.source.alarmReviews.counts.reviewedExclusion
      + inventory.source.alarmReviews.counts.unmapped,
    ).toBe(inventory.source.alarms.length);
  });

  test("generated report is byte-deterministic and current", async () => {
    const inventory = actualInventory;
    const input = repositoryReportInput(inventory, BASELINE_REGISTRY);
    const first = formatCoverageReport(input);
    const second = formatCoverageReport(input);
    const committed = await readFile(generatedReportPath, "utf8");

    expect(second).toBe(first);
    expect(committed).toBe(first);
    expect(committed).not.toContain(repositoryRoot);
    expect(committed).toContain("## Scanner metadata");
    expect(committed).toContain("## Verification categories");
    expect(committed).toContain("## Source alarm debt");
    expect(committed).toContain(
      `source | Alarms | ${inventory.source.alarms.length}`,
    );
    expect(committed).toContain(
      `migrations | Files | ${inventory.migrations.migrations.length}`,
    );
    expect(input.sourceAlarmDebt).toHaveLength(
      inventory.source.alarmReviews.counts.baselineDebt,
    );
    const sourceAlarmDebtSection = committed
      .split("## Source alarm debt\n", 2)[1]
      ?.split("\n## Exceptions", 1)[0];
    expect(sourceAlarmDebtSection).toBeDefined();
    for (const debt of input.sourceAlarmDebt) {
      expect(sourceAlarmDebtSection).toContain(
        `| \`${debt.debtId}\` | ${debt.surface} | \`${debt.locator}\` |`,
      );
      expect(["planned", "untriaged"]).toContain(debt.remediationState);
      expect(["blocks_enabled_scope", "blocks_whole_product_claim"]).toContain(
        debt.releaseImpact,
      );
      expect(debt.evidenceGap).toContain(debt.locator);
    }
  });

  test("a new observation fails closed instead of entering the baseline automatically", async () => {
    const inventory = actualInventory;
    expect(verifyRepositoryInventory({
      ...inventory,
      observations: [
        ...inventory.observations,
        {
          id: "wire.fixture.new-secret",
          surface: "wire",
          locator: "fixture:new-secret",
        },
      ],
    }, BASELINE_REGISTRY)).toEqual({
      ok: false,
      errors: ["unknown coverage observation: wire:fixture:new-secret"],
    });
  });

  test("adding untriaged debt cannot grandfather a new repository observation", () => {
    const newObservation = {
      id: "wire.fixture.new-secret",
      surface: "wire" as const,
      locator: "fixture:new-secret",
    };
    const newDebt = {
      id: "debt.wire.fixture.new-secret",
      surface: "wire" as const,
      locator: newObservation.locator,
      owner: "packages/example",
      reason: "A new plaintext transport surface has not been classified.",
      remediationState: "untriaged" as const,
      releaseImpact: "blocks_whole_product_claim" as const,
      evidenceGap: "No executable encrypted transport evidence exists yet.",
    };
    const result = verifyRepositoryInventory({
      ...actualInventory,
      observations: [...actualInventory.observations, newObservation],
    }, {
      ...BASELINE_REGISTRY,
      debt: [...BASELINE_REGISTRY.debt, newDebt],
    });

    expect(result).toEqual({
      ok: false,
      errors: [
        "unfrozen baseline debt declaration: "
          + "debt.wire.fixture.new-secret:wire:fixture:new-secret",
        "unknown coverage observation: wire:fixture:new-secret",
      ],
    });
  });

  test("the committed initial debt snapshot is count-and-fingerprint locked", () => {
    const result = verifyRepositoryInventory(
      actualInventory,
      BASELINE_REGISTRY,
      [
        ...WAVE_0_FROZEN_BASELINE_DEBT,
        {
          id: "debt.wire.fixture.new-secret",
          surface: "wire",
          locator: "fixture:new-secret",
        },
      ],
    );

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) =>
      error.startsWith("Wave 0 baseline debt snapshot drift:")
    )).toBe(true);
  });

  test("a new Drizzle writer against an existing table fails closed", () => {
    const addedWriter = {
      operation: "insert" as const,
      table: "public.session_messages",
      path: "packages/example/src/new-writer.ts",
      symbol: "persistSecret",
      locator:
        "packages/example/src/new-writer.ts#persistSecret:insert:public.session_messages:1",
    };
    const result = verifyRepositoryInventory({
      ...actualInventory,
      databaseWriters: [...actualInventory.databaseWriters, addedWriter],
      databaseWriterFingerprint: "fixture-new-writer",
    }, BASELINE_REGISTRY);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) =>
      error.startsWith("database writer baseline drift:")
    )).toBe(true);
  });

  test("schema/migration column semantic drift fails closed", () => {
    const result = verifyRepositoryInventory({
      ...actualInventory,
      schemaMigration: {
        ...actualInventory.schemaMigration,
        columnMismatches: [{
          locator: "public.session_messages.content",
          schema: {
            sqlType: "text",
            notNull: true,
            generated: false,
            defaultSql: null,
            primaryKey: false,
          },
          migration: {
            sqlType: "varchar(255)",
            notNull: false,
            generated: true,
            defaultSql: null,
            primaryKey: false,
          },
        }],
      },
    }, BASELINE_REGISTRY);

    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "schema/migration column mismatch: public.session_messages.content "
      + "schema=text/notNull:true/generated:false/default:none/primaryKey:false "
      + "migration=varchar(255)/notNull:false/generated:true/default:none/primaryKey:false",
    );
  });

  test("schema/migration constraint semantic drift fails closed", () => {
    const schemaConstraint = actualInventory.schema.constraints[0]!;
    const result = verifyRepositoryInventory({
      ...actualInventory,
      schemaMigration: {
        ...actualInventory.schemaMigration,
        constraintMismatches: [{
          locator: schemaConstraint.locator,
          schema: schemaConstraint,
          migration: null,
        }],
      },
    }, BASELINE_REGISTRY);

    expect(result.ok).toBe(false);
    expect(result.errors.some((error) =>
      error.startsWith(
        `schema/migration constraint mismatch: ${schemaConstraint.locator} `,
      )
    )).toBe(true);
  });

  test("an unmapped source alarm blocks repository verification", () => {
    const locator =
      "packages/example/src/new.ts#filesystem_write:0123456789abcdef:1";
    const inventory = {
      ...actualInventory,
      source: {
        ...actualInventory.source,
        alarmReviews: {
          ...actualInventory.source.alarmReviews,
          errors: [`new source alarm has no closure: ${locator}`],
          counts: {
            ...actualInventory.source.alarmReviews.counts,
            unmapped: 1,
          },
        },
      },
    };

    expect(
      verifyRepositoryInventory(inventory, BASELINE_REGISTRY).errors,
    ).toContain(`new source alarm has no closure: ${locator}`);
  });

  test("classified entries fail closed when repository evidence is missing", async () => {
    const inventory = actualInventory;
    const [candidate, ...remainingDebt] = BASELINE_REGISTRY.debt;
    expect(candidate).toBeDefined();
    const registry = {
      entries: [{
        id: "classified.fixture.missing-evidence",
        surface: candidate!.surface,
        locator: candidate!.locator,
        classification: "protected",
        keyFamily: "namespace_ai",
        bridgeRepository: "packages/missing-bridge/src/repository.ts",
        owner: candidate!.owner,
        readers: [],
        writers: [],
        migrationState: "not_started",
        retention: "Retained according to the existing product lifecycle.",
        testEvidence: ["packages/missing-bridge/tests/integration/roundtrip.test.ts"],
        negativeTestEvidence: [
          "packages/missing-bridge/tests/integration/plaintext-negative.test.ts",
        ],
      }],
      debt: remainingDebt,
      exceptions: [],
    } as const;

    const result = verifyRepositoryInventory(inventory, registry);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      "classified.fixture.missing-evidence: missing bridge repository path packages/missing-bridge/src/repository.ts",
    );
    expect(result.errors).toContain(
      "classified.fixture.missing-evidence: missing test evidence path packages/missing-bridge/tests/integration/roundtrip.test.ts",
    );
    expect(result.errors).toContain(
      "classified.fixture.missing-evidence: missing negative test evidence path packages/missing-bridge/tests/integration/plaintext-negative.test.ts",
    );
    expect(result.errors.join("\n")).not.toContain(repositoryRoot);
  });

  test("externally managed checkpoint tables remain pinned to reviewed evidence", async () => {
    const inventory = actualInventory;
    expect(inventory.externalDatabaseErrors).toEqual([]);
    expect(inventory.observations.filter((item) =>
      item.locator.startsWith("langchain."),
    ).map((item) => item.locator)).toEqual([
      "langchain.checkpoint_blobs",
      "langchain.checkpoint_migrations",
      "langchain.checkpoint_writes",
      "langchain.checkpoints",
    ]);

    expect(verifyRepositoryInventory({
      ...inventory,
      externalDatabaseErrors: [
        "external database dependency version drift: expected @langchain/langgraph-checkpoint-postgres 1.0.1, received 1.0.2",
      ],
    }, BASELINE_REGISTRY)).toEqual({
      ok: false,
      errors: [
        "external database dependency version drift: expected @langchain/langgraph-checkpoint-postgres 1.0.1, received 1.0.2",
      ],
    });
  });

  test("the initial debt remains exact while later reviewed decisions are separate", () => {
    expect(BASELINE_REGISTRY.entries.length).toBeGreaterThan(0);
    expect(BASELINE_REGISTRY.reviewedDebtLinks?.length).toBeGreaterThan(0);
    expect(BASELINE_REGISTRY.debt).toEqual(WAVE_0_FROZEN_BASELINE_DEBT);
    for (const debt of WAVE_0_FROZEN_BASELINE_DEBT) {
      expect(debt.remediationState).toBe("untriaged");
      expect(debt.reason).toContain(debt.locator);
      expect(debt.evidenceGap).toContain(debt.locator);
    }
  });

  test("arbitrary payload debt references resolve to their exact wire locator", async () => {
    const inventory = actualInventory;
    const declaration = DTO_BASELINE_DECLARATIONS.find((item) =>
      item.arbitraryPayloads.some((payload) => "debtId" in payload)
    );
    const payload = declaration?.arbitraryPayloads.find((item) => "debtId" in item);
    expect(declaration).toBeDefined();
    expect(payload && "debtId" in payload ? payload.debtId : undefined).toBeDefined();
    const debtId = payload && "debtId" in payload ? payload.debtId : "";
    const wrongLocator = "http:request_response:GET /api/account/security";
    const registry = {
      ...BASELINE_REGISTRY,
      debt: BASELINE_REGISTRY.debt.map((debt) =>
        debt.id === debtId ? { ...debt, locator: wrongLocator } : debt
      ),
    };

    const result = verifyRepositoryInventory(inventory, registry);
    expect(result.ok).toBe(false);
    expect(result.errors).toContain(
      `${declaration!.locator}: arbitrary payload ${payload!.path} references debt `
      + `${debtId} at ${wrongLocator}; expected ${declaration!.locator}#${payload!.path}`,
    );
  });
});
