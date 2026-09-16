import * as nautiloSchema from "@nautilo/db/schema";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

import { DTO_BASELINE_DECLARATIONS } from "../../baseline/dto-declarations";
import { CURRENT_FROZEN_BASELINE_DEBT } from "../../baseline/existing-debt";
import {
  DATABASE_WRITER_BASELINE,
  MIGRATION_TREE_BASELINE,
  SOURCE_ALARM_BASELINE,
  WAVE_0_BASELINE_DEBT_LOCK,
} from "../../baseline/inventory-fingerprints";
import { RAW_DATABASE_WRITER_DEBT } from "../../baseline/raw-database-writer-debt";
import {
  auditCoverageRegistry,
  canonicalDatabaseWriterLocator,
  compareInventory,
  retiredFrozenDebtErrors,
  reviewedDebtLinkErrors,
  type CoverageRegistry,
  type FrozenBaselineDebt,
  type InventoryObservation,
} from "../registry";
import { rawDatabaseWriterDebtId } from "../raw-database-writer-debt";
import type {
  CoverageReportInput,
  CoverageVerificationCategory,
} from "../report";
import {
  findEncryptionActivationReferences,
  inspectActivationLifecycleDeclarations,
  inspectActivationReferenceExclusions,
} from "./activation-inventory";
import {
  auditRawDatabaseWriterDebt,
  discoverDatabaseWriterInventory,
  fingerprintDatabaseWriterInventory,
  type DatabaseWriterObservation,
} from "./database-writer-inventory";
import {
  auditDtoDeclarations,
  discoverDtoInventory,
  type DtoInventoryObservation,
} from "./dto-inventory";
import {
  compareSchemaAndMigrationInventory,
  inventoryMigrationTree,
  type MigrationTreeInventory,
  type SchemaMigrationComparison,
} from "./migration-inventory";
import {
  inventoryDrizzleSchema,
  type DrizzleSchemaInventory,
} from "./schema-inventory";
import {
  DEFAULT_SOURCE_SCAN_EXCLUSIONS,
  inspectDeclaredSourceInventory,
  scanSourceAlarms,
  type SourceAlarm,
  type SourceInventoryInspection,
} from "./source-inventory";
import {
  inspectSourceAlarmReviews,
  type SourceAlarmReviewInspection,
} from "./source-alarm-review";
import { collectInventorySteps } from "./inventory-collection";

export type RepositoryInventory = {
  readonly repositoryRoot: string;
  readonly observations: readonly InventoryObservation[];
  readonly schema: DrizzleSchemaInventory;
  readonly migrations: MigrationTreeInventory;
  readonly schemaMigration: SchemaMigrationComparison;
  readonly databaseWriters: readonly DatabaseWriterObservation[];
  readonly databaseWriterFingerprint: string;
  readonly dto: readonly DtoInventoryObservation[];
  readonly dtoAuditErrors: readonly string[];
  readonly source: SourceInventoryInspection & {
    readonly alarms: readonly SourceAlarm[];
    readonly scanErrors: readonly string[];
    readonly alarmReviews: SourceAlarmReviewInspection;
  };
  readonly activationReferences: Awaited<
    ReturnType<typeof findEncryptionActivationReferences>
  >;
  readonly activationLifecycle: Awaited<
    ReturnType<typeof inspectActivationLifecycleDeclarations>
  >;
  readonly activationExclusions: Awaited<
    ReturnType<typeof inspectActivationReferenceExclusions>
  >;
  readonly sourceAlarmFingerprint: string;
  readonly migrationFingerprint: string;
  readonly externalDatabaseErrors: readonly string[];
};

export type RepositoryInventoryVerification = {
  readonly ok: boolean;
  readonly errors: readonly string[];
};

function fnv1a(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function fingerprint(values: readonly string[]): string {
  return createHash("sha256").update(values.join("\n")).digest("hex");
}

const EXTERNAL_DATABASE_DEPENDENCY = {
  packageName: "@langchain/langgraph-checkpoint-postgres",
  version: "1.0.1",
  packageManifest: "packages/agent/package.json",
  evidencePath: "packages/agent/src/checkpoints/checkpoint-saver.ts",
} as const;

async function inspectExternalDatabaseInventory(
  repositoryRoot: string,
): Promise<{
  readonly observations: readonly InventoryObservation[];
  readonly errors: readonly string[];
}> {
  const observations = [
    {
      id: "db.external.langchain.checkpoints",
      surface: "db",
      locator: "langchain.checkpoints",
    },
    {
      id: "db.external.langchain.checkpoint-blobs",
      surface: "db",
      locator: "langchain.checkpoint_blobs",
    },
    {
      id: "db.external.langchain.checkpoint-writes",
      surface: "db",
      locator: "langchain.checkpoint_writes",
    },
    {
      id: "db.external.langchain.checkpoint-migrations",
      surface: "db",
      locator: "langchain.checkpoint_migrations",
    },
  ] as const satisfies readonly InventoryObservation[];
  const errors: string[] = [];
  const manifest = JSON.parse(await readFile(
    join(repositoryRoot, EXTERNAL_DATABASE_DEPENDENCY.packageManifest),
    "utf8",
  )) as { dependencies?: Record<string, string> };
  const actualVersion =
    manifest.dependencies?.[EXTERNAL_DATABASE_DEPENDENCY.packageName];
  if (actualVersion !== EXTERNAL_DATABASE_DEPENDENCY.version) {
    errors.push(
      `external database dependency version drift: expected `
      + `${EXTERNAL_DATABASE_DEPENDENCY.packageName} ${EXTERNAL_DATABASE_DEPENDENCY.version}, `
      + `received ${actualVersion ?? "missing"}`,
    );
  }

  const evidence = await readFile(
    join(repositoryRoot, EXTERNAL_DATABASE_DEPENDENCY.evidencePath),
    "utf8",
  );
  for (const observation of observations) {
    const tableName = observation.locator.slice("langchain.".length);
    if (!evidence.includes(tableName)) {
      errors.push(
        `external database evidence missing table ${observation.locator} from `
        + EXTERNAL_DATABASE_DEPENDENCY.evidencePath,
      );
    }
  }

  return { observations, errors: errors.sort() };
}

function dtoCoverageObservations(
  dto: readonly DtoInventoryObservation[],
): readonly InventoryObservation[] {
  return dto.flatMap((item) => [
    {
      id: item.id,
      surface: "wire" as const,
      locator: item.locator,
    },
    ...item.arbitraryPayloads.map((path) => ({
      id: `wire.arbitrary.${fnv1a(`${item.locator}#${path}`)}`,
      surface: "wire" as const,
      locator: `${item.locator}#${path}`,
    })),
  ]);
}

function rawDatabaseWriterCoverageObservations(
  writers: readonly DatabaseWriterObservation[],
): readonly InventoryObservation[] {
  return writers
    .filter((writer) => writer.locator.includes(":raw_sql:"))
    .map((writer) => ({
      id: rawDatabaseWriterDebtId(writer.locator),
      surface: "db" as const,
      locator: writer.locator,
    }));
}

function sortObservations(
  values: readonly InventoryObservation[],
): readonly InventoryObservation[] {
  const byLocator = new Map<string, InventoryObservation>();
  for (const value of values) {
    const key = `${value.surface}:${value.locator}`;
    const existing = byLocator.get(key);
    if (existing && existing.id !== value.id) {
      throw new Error(
        `Conflicting inventory IDs for ${key}: ${existing.id}, ${value.id}`,
      );
    }
    byLocator.set(key, value);
  }
  return [...byLocator.values()].sort((left, right) => {
    const leftKey = `${left.surface}:${left.locator}:${left.id}`;
    const rightKey = `${right.surface}:${right.locator}:${right.id}`;
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function drizzleTableExportLocators(
  schema: DrizzleSchemaInventory,
): Readonly<Record<string, string>> {
  return Object.fromEntries(
    schema.objects
      .filter((object) => object.kind === "table")
      .flatMap((object) =>
        object.exportNames.map((exportName) => [exportName, object.locator])
      ),
  );
}

export async function collectRepositoryInventory(
  repositoryRoot: string,
): Promise<RepositoryInventory> {
  const normalizedRepositoryRoot = resolve(repositoryRoot);
  const schema = inventoryDrizzleSchema(nautiloSchema);
  const [
    databaseWriters,
    migrations,
    dto,
    sourceInspection,
    sourceScan,
    activationReferences,
    activationLifecycle,
    activationExclusions,
    externalDatabase,
  ] = await collectInventorySteps([
    {
      label: "database writer inventory",
      collect: () => discoverDatabaseWriterInventory(
        repositoryRoot,
        drizzleTableExportLocators(schema),
      ),
    },
    {
      label: "migration tree",
      collect: () => inventoryMigrationTree(join(
        repositoryRoot,
        "packages/db/src/migrations",
      )),
    },
    {
      label: "DTO inventory",
      collect: () => discoverDtoInventory(repositoryRoot),
    },
    {
      label: "source declarations",
      collect: () => inspectDeclaredSourceInventory({
        repoRoot: repositoryRoot,
      }),
    },
    {
      label: "source alarms",
      collect: () => scanSourceAlarms({ repoRoot: repositoryRoot }),
    },
    {
      label: "activation references",
      collect: () => findEncryptionActivationReferences(repositoryRoot),
    },
    {
      label: "activation lifecycle",
      collect: () => inspectActivationLifecycleDeclarations(repositoryRoot),
    },
    {
      label: "activation exclusions",
      collect: () => inspectActivationReferenceExclusions(repositoryRoot),
    },
    {
      label: "external database",
      collect: () => inspectExternalDatabaseInventory(repositoryRoot),
    },
  ] as const);
  const dtoAudit = auditDtoDeclarations({
    observations: dto,
    declarations: DTO_BASELINE_DECLARATIONS,
  });
  const alarmReviews = inspectSourceAlarmReviews(sourceScan.alarms);

  return {
    repositoryRoot: normalizedRepositoryRoot,
    observations: sortObservations([
      ...schema.objects,
      ...schema.columns,
      ...migrations.currentTables,
      ...externalDatabase.observations,
      ...rawDatabaseWriterCoverageObservations(databaseWriters),
      ...dtoCoverageObservations(dto),
      ...sourceInspection.observations,
    ]),
    schema,
    migrations,
    schemaMigration: compareSchemaAndMigrationInventory(schema, migrations),
    databaseWriters,
    databaseWriterFingerprint:
      fingerprintDatabaseWriterInventory(databaseWriters),
    dto,
    dtoAuditErrors: dtoAudit.ok ? [] : dtoAudit.errors,
    source: {
      ...sourceInspection,
      alarms: sourceScan.alarms,
      scanErrors: sourceScan.errors,
      alarmReviews,
    },
    activationReferences,
    activationLifecycle,
    activationExclusions,
    sourceAlarmFingerprint: fingerprint(
      sourceScan.alarms.map((item) => item.locator),
    ),
    migrationFingerprint: fingerprint([
      ...migrations.migrations.map((item) => `${item.path}:${item.sha256}`),
      ...migrations.snapshots.map((item) => `${item.path}:${item.sha256}`),
    ]),
    externalDatabaseErrors: externalDatabase.errors,
  };
}

function isExistingRepositoryPath(
  repositoryRoot: string,
  declaredPath: string,
): boolean {
  if (
    isAbsolute(declaredPath)
    || declaredPath.includes("\\")
    || declaredPath.split("/").some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    return false;
  }
  const absolute = resolve(repositoryRoot, declaredPath);
  const relativePath = relative(repositoryRoot, absolute);
  return relativePath.length > 0
    && !relativePath.startsWith("..")
    && !isAbsolute(relativePath)
    && existsSync(absolute);
}

function verifyRepositoryEvidence(
  inventory: RepositoryInventory,
  registry: CoverageRegistry,
): readonly string[] {
  const errors: string[] = [];
  for (const entry of registry.entries) {
    for (const path of entry.testEvidence) {
      if (!isExistingRepositoryPath(inventory.repositoryRoot, path)) {
        errors.push(`${entry.id}: missing test evidence path ${path}`);
      }
    }
    if (entry.classification === "protected") {
      if (!isExistingRepositoryPath(
        inventory.repositoryRoot,
        entry.bridgeRepository,
      )) {
        errors.push(
          `${entry.id}: missing bridge repository path ${entry.bridgeRepository}`,
        );
      }
      for (const path of entry.negativeTestEvidence) {
        if (!isExistingRepositoryPath(inventory.repositoryRoot, path)) {
          errors.push(`${entry.id}: missing negative test evidence path ${path}`);
        }
      }
    }
  }
  for (const exception of registry.exceptions) {
    for (const path of exception.testEvidence) {
      if (!isExistingRepositoryPath(inventory.repositoryRoot, path)) {
        errors.push(`${exception.id}: missing test evidence path ${path}`);
      }
    }
  }
  for (const link of registry.reviewedDebtLinks ?? []) {
    for (const path of link.testEvidence) {
      if (!isExistingRepositoryPath(inventory.repositoryRoot, path)) {
        errors.push(`${link.id}: missing test evidence path ${path}`);
      }
    }
  }
  return errors;
}

function dtoDebtReferenceErrors(
  registry: CoverageRegistry,
): readonly string[] {
  const errors: string[] = [];
  const debtById = new Map(registry.debt.map((item) => [item.id, item]));
  for (const declaration of DTO_BASELINE_DECLARATIONS) {
    for (const payload of declaration.arbitraryPayloads) {
      if ("debtId" in payload && payload.debtId) {
        const debt = debtById.get(payload.debtId);
        if (!debt) {
          errors.push(
            `${declaration.locator}: arbitrary payload references missing debt ${payload.debtId}`,
          );
          continue;
        }
        const expectedLocator = `${declaration.locator}#${payload.path}`;
        if (debt.surface !== "wire" || debt.locator !== expectedLocator) {
          errors.push(
            `${declaration.locator}: arbitrary payload ${payload.path} references debt `
            + `${payload.debtId} at ${debt.locator}; expected ${expectedLocator}`,
          );
        }
      }
    }
  }
  return errors;
}

function sourceAlarmBaselineErrors(
  inventory: RepositoryInventory,
): readonly string[] {
  const errors = [...inventory.source.alarmReviews.errors];
  if (
    inventory.source.alarms.length !== SOURCE_ALARM_BASELINE.count
    || inventory.sourceAlarmFingerprint !== SOURCE_ALARM_BASELINE.sha256
  ) {
    errors.push(
      `source alarm baseline drift: expected ${SOURCE_ALARM_BASELINE.count}/${SOURCE_ALARM_BASELINE.sha256}, `
      + `received ${inventory.source.alarms.length}/${inventory.sourceAlarmFingerprint}`,
    );
  }
  return errors;
}

function migrationVerificationErrors(
  inventory: RepositoryInventory,
): readonly string[] {
  const errors = [
    ...inventory.schemaMigration.missingTablesInMigration.map(
      (item) => `schema table missing from migration snapshot: ${item}`,
    ),
    ...inventory.schemaMigration.missingTablesInSchema.map(
      (item) => `migration snapshot table missing from schema: ${item}`,
    ),
    ...inventory.schemaMigration.missingInMigration.map(
      (item) => `schema column missing from migration snapshot: ${item}`,
    ),
    ...inventory.schemaMigration.missingInSchema.map(
      (item) => `migration snapshot column missing from schema: ${item}`,
    ),
    ...inventory.schemaMigration.columnMismatches.map(
      (item) =>
        `schema/migration column mismatch: ${item.locator} `
        + `schema=${item.schema.sqlType}/notNull:${item.schema.notNull}`
        + `/generated:${item.schema.generated}/default:${item.schema.defaultSql ?? "none"}`
        + `/primaryKey:${item.schema.primaryKey} `
        + `migration=${item.migration.sqlType}/notNull:${item.migration.notNull}`
        + `/generated:${item.migration.generated}`
        + `/default:${item.migration.defaultSql ?? "none"}`
        + `/primaryKey:${item.migration.primaryKey}`,
    ),
    ...inventory.schemaMigration.constraintMismatches.map(
      (item) =>
        `schema/migration constraint mismatch: ${item.locator} `
        + `schema=${item.schema === null ? "missing" : JSON.stringify(item.schema)} `
        + `migration=${item.migration === null ? "missing" : JSON.stringify(item.migration)}`,
    ),
  ];
  if (
    inventory.migrations.migrations.length !== MIGRATION_TREE_BASELINE.migrations
    || inventory.migrations.snapshots.length !== MIGRATION_TREE_BASELINE.snapshots
    || inventory.migrations.latestSnapshotIndex !== MIGRATION_TREE_BASELINE.tip
    || inventory.migrationFingerprint !== MIGRATION_TREE_BASELINE.sha256
  ) {
    errors.push(
      `migration tree baseline drift: expected ${MIGRATION_TREE_BASELINE.migrations}/`
      + `${MIGRATION_TREE_BASELINE.snapshots}/${MIGRATION_TREE_BASELINE.tip}/`
      + `${MIGRATION_TREE_BASELINE.sha256}, received ${inventory.migrations.migrations.length}/`
      + `${inventory.migrations.snapshots.length}/${inventory.migrations.latestSnapshotIndex}/`
      + inventory.migrationFingerprint,
    );
  }
  return errors;
}

function databaseWriterVerificationErrors(
  inventory: RepositoryInventory,
  registry: CoverageRegistry,
): readonly string[] {
  const debtLocators = new Set(
    RAW_DATABASE_WRITER_DEBT.map((item) => item.locator),
  );
  const rawDebtAudit = auditRawDatabaseWriterDebt({
    observations: inventory.databaseWriters,
    declarations: RAW_DATABASE_WRITER_DEBT,
    reviewedLocators: [
      ...registry.entries,
      ...(registry.reviewedDebtLinks ?? []),
    ]
      .filter((entry) =>
        entry.surface === "db"
        && entry.locator.includes(":raw_sql:")
        && !debtLocators.has(entry.locator)
      )
      .map((entry) => entry.locator),
  });
  const operationCounts = {
    insert: inventory.databaseWriters.filter((item) => item.operation === "insert").length,
    update: inventory.databaseWriters.filter((item) => item.operation === "update").length,
    delete: inventory.databaseWriters.filter((item) => item.operation === "delete").length,
    unresolved: inventory.databaseWriters.filter(
      (item) => item.operation === "unresolved",
    ).length,
  };
  if (
    inventory.databaseWriters.length === DATABASE_WRITER_BASELINE.count
    && operationCounts.insert === DATABASE_WRITER_BASELINE.insert
    && operationCounts.update === DATABASE_WRITER_BASELINE.update
    && operationCounts.delete === DATABASE_WRITER_BASELINE.delete
    && operationCounts.unresolved === DATABASE_WRITER_BASELINE.unresolved
    && inventory.databaseWriterFingerprint === DATABASE_WRITER_BASELINE.sha256
  ) {
    return rawDebtAudit.errors;
  }
  return [
    `database writer baseline drift: expected ${DATABASE_WRITER_BASELINE.count}/`
    + `${DATABASE_WRITER_BASELINE.insert}/${DATABASE_WRITER_BASELINE.update}/`
    + `${DATABASE_WRITER_BASELINE.delete}/${DATABASE_WRITER_BASELINE.unresolved}/`
    + `${DATABASE_WRITER_BASELINE.sha256}, received `
    + `${inventory.databaseWriters.length}/${operationCounts.insert}/`
    + `${operationCounts.update}/${operationCounts.delete}/`
    + `${operationCounts.unresolved}/`
    + inventory.databaseWriterFingerprint,
    ...rawDebtAudit.errors,
  ];
}

function baselineDebtSnapshotVerificationErrors(
  frozenBaselineDebt: readonly FrozenBaselineDebt[],
): readonly string[] {
  const values = frozenBaselineDebt
    .map((item) => `${item.id}:${item.surface}:${item.locator}`)
    .sort();
  const actualFingerprint = fingerprint(values);
  if (
    frozenBaselineDebt.length === WAVE_0_BASELINE_DEBT_LOCK.count
    && actualFingerprint === WAVE_0_BASELINE_DEBT_LOCK.sha256
  ) {
    return [];
  }
  return [
    `Wave 0 baseline debt snapshot drift: expected `
    + `${WAVE_0_BASELINE_DEBT_LOCK.count}/${WAVE_0_BASELINE_DEBT_LOCK.sha256}, `
    + `received ${frozenBaselineDebt.length}/${actualFingerprint}`,
  ];
}

export function repositoryVerificationCategories(
  inventory: RepositoryInventory,
  registry: CoverageRegistry,
  frozenBaselineDebt: readonly FrozenBaselineDebt[] =
    CURRENT_FROZEN_BASELINE_DEBT,
): readonly CoverageVerificationCategory[] {
  const registryAudit = auditCoverageRegistry(registry);
  const drift = compareInventory({
    observed: inventory.observations,
    registry,
    frozenBaselineDebt,
  });
  const currentWriterLocators = new Set(
    inventory.databaseWriters.map((item) =>
      canonicalDatabaseWriterLocator(item.locator)
    ),
  );
  const meaningfulStaleCoverage = drift.stale.filter((key) => {
    if (!key.startsWith("db:")) return true;
    const locator = key.slice("db:".length);
    return !locator.includes(":raw_sql:")
      || !currentWriterLocators.has(canonicalDatabaseWriterLocator(locator));
  });
  return [
    {
      category: "registry_declarations",
      errors: registryAudit.ok ? [] : registryAudit.errors,
    },
    {
      category: "inventory_closure",
      errors: [
        ...drift.unknown.map((item) => `unknown coverage observation: ${item}`),
        ...meaningfulStaleCoverage.map(
          (item) => `stale coverage declaration: ${item}`,
        ),
        ...drift.unfrozenDebt.map(
          (item) => `unfrozen baseline debt declaration: ${item}`,
        ),
        ...reviewedDebtLinkErrors(registry, frozenBaselineDebt),
        ...retiredFrozenDebtErrors(registry, frozenBaselineDebt),
        ...baselineDebtSnapshotVerificationErrors(frozenBaselineDebt),
      ],
    },
    {
      category: "dto_declarations",
      errors: [...inventory.dtoAuditErrors, ...dtoDebtReferenceErrors(registry)],
    },
    {
      category: "source_declarations",
      errors: [...inventory.source.errors, ...inventory.source.scanErrors],
    },
    {
      category: "source_alarm_closure",
      errors: sourceAlarmBaselineErrors(inventory),
    },
    {
      category: "database_migrations",
      errors: migrationVerificationErrors(inventory),
    },
    {
      category: "database_writers",
      errors: databaseWriterVerificationErrors(inventory, registry),
    },
    {
      category: "external_database",
      errors: inventory.externalDatabaseErrors,
    },
    {
      category: "repository_evidence",
      errors: verifyRepositoryEvidence(inventory, registry),
    },
    {
      category: "activation",
      errors: [
        ...inventory.activationLifecycle.errors,
        ...inventory.activationExclusions.errors,
        ...inventory.activationReferences.map(
          (item) =>
            `reachable encryption activation reference: ${item.path}:${item.line}#${item.token}`,
        ),
      ],
    },
  ].map((category) => ({
    ...category,
    errors: [...category.errors].sort(),
  }));
}

export function verifyRepositoryInventory(
  inventory: RepositoryInventory,
  registry: CoverageRegistry,
  frozenBaselineDebt: readonly FrozenBaselineDebt[] =
    CURRENT_FROZEN_BASELINE_DEBT,
): RepositoryInventoryVerification {
  const errors = repositoryVerificationCategories(
    inventory,
    registry,
    frozenBaselineDebt,
  )
    .flatMap((category) => category.errors)
    .sort();
  return {
    ok: errors.length === 0,
    errors,
  };
}

export function repositoryReportInput(
  inventory: RepositoryInventory,
  registry: CoverageRegistry,
  frozenBaselineDebt: readonly FrozenBaselineDebt[] =
    CURRENT_FROZEN_BASELINE_DEBT,
): CoverageReportInput {
  return {
    schemaVersion: 1,
    generatorVersion: "0.1.0",
    registry,
    baselineDebtSnapshot: {
      version: WAVE_0_BASELINE_DEBT_LOCK.version,
      sha256: WAVE_0_BASELINE_DEBT_LOCK.sha256,
      entries: frozenBaselineDebt,
    },
    observed: inventory.observations,
    scannerMetadata: {
      source: {
        declarations: inventory.source.observations.length,
        alarms: inventory.source.alarms.length,
        alarmFingerprint: inventory.sourceAlarmFingerprint,
        reviewedAlarmDebt: inventory.source.alarmReviews.counts.baselineDebt,
        reviewedAlarmExclusions:
          inventory.source.alarmReviews.counts.reviewedExclusion,
        unmappedAlarms: inventory.source.alarmReviews.counts.unmapped,
        exclusions: DEFAULT_SOURCE_SCAN_EXCLUSIONS.length,
      },
      schema: {
        objects: inventory.schema.objects.length,
        tables: inventory.schema.objects.filter((object) => object.kind === "table").length,
        views: inventory.schema.objects.filter((object) => object.kind === "view").length,
        columns: inventory.schema.columns.length,
      },
      migrations: {
        files: inventory.migrations.migrations.length,
        snapshots: inventory.migrations.snapshots.length,
        tip: inventory.migrations.latestSnapshotIndex,
        fingerprint: inventory.migrationFingerprint,
        currentTables: inventory.migrations.currentTables.length,
        currentColumns: inventory.migrations.currentColumns.length,
        historicalCreatedTables: inventory.migrations.historicalCreatedTables.length,
        historicalDroppedTables: inventory.migrations.historicalDroppedTables.length,
      },
      databaseWriters: {
        total: inventory.databaseWriters.length,
        insert: inventory.databaseWriters.filter(
          (item) => item.operation === "insert",
        ).length,
        update: inventory.databaseWriters.filter(
          (item) => item.operation === "update",
        ).length,
        delete: inventory.databaseWriters.filter(
          (item) => item.operation === "delete",
        ).length,
        unresolved: inventory.databaseWriters.filter(
          (item) => item.operation === "unresolved",
        ).length,
        raw: inventory.databaseWriters.filter(
          (item) => item.locator.includes(":raw_sql:"),
        ).length,
        fingerprint: inventory.databaseWriterFingerprint,
        auditErrors: databaseWriterVerificationErrors(
          inventory,
          registry,
        ).length,
      },
      dto: {
        observations: inventory.dto.length,
        declarations: DTO_BASELINE_DECLARATIONS.length,
        arbitraryPayloads: inventory.dto.reduce(
          (count, observation) => count + observation.arbitraryPayloads.length,
          0,
        ),
        auditErrors: inventory.dtoAuditErrors.length,
      },
      activation: {
        reachableReferences: inventory.activationReferences.length,
        lifecycleDeclarations: inventory.activationLifecycle.observations.length,
        reviewedExclusions: inventory.activationExclusions.count,
        auditErrors:
          inventory.activationLifecycle.errors.length
          + inventory.activationExclusions.errors.length,
      },
    },
    verificationCategories:
      repositoryVerificationCategories(
        inventory,
        registry,
        frozenBaselineDebt,
      ),
    sourceAlarmDebt: inventory.source.alarmReviews.reviews.flatMap((review) =>
      review.closure === "baseline_debt"
        ? [{
            debtId: review.debtId,
            surface: review.surface,
            locator: review.locator,
            owner: review.owner,
            reason: review.reason,
            remediationState: review.remediationState,
            releaseImpact: review.releaseImpact,
            evidenceGap: review.evidenceGap,
          }]
        : []
    ),
  };
}
