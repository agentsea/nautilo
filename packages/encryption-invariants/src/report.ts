import { DEFAULT_ENCRYPTION_ACTIVATION } from "./activation";
import {
  COVERAGE_SURFACES,
  type CoverageSurface,
  type EncryptionClassification,
  type ReleaseImpact,
  type RemediationState,
} from "./model";
import {
  auditCoverageRegistry,
  compareInventory,
  type CoverageRegistry,
  type FrozenBaselineDebt,
  type InventoryObservation,
} from "./registry";
import {
  type ReportVerificationResult,
  verifyRenderedCoverageReport,
} from "./report-verification";

export type { ReportVerificationResult } from "./report-verification";

export type CoverageReportInput = {
  readonly schemaVersion: number;
  readonly generatorVersion: string;
  readonly registry: CoverageRegistry;
  readonly baselineDebtSnapshot: {
    readonly version: string;
    readonly sha256: string;
    readonly entries: readonly FrozenBaselineDebt[];
  };
  readonly observed: readonly InventoryObservation[];
  readonly scannerMetadata: CoverageScannerMetadata;
  readonly verificationCategories: readonly CoverageVerificationCategory[];
  readonly sourceAlarmDebt: readonly CoverageSourceAlarmDebt[];
};

export type CoverageScannerMetadata = {
  readonly source: {
    readonly declarations: number;
    readonly alarms: number;
    readonly alarmFingerprint: string;
    readonly reviewedAlarmDebt: number;
    readonly reviewedAlarmExclusions: number;
    readonly unmappedAlarms: number;
    readonly exclusions: number;
  };
  readonly schema: {
    readonly objects: number;
    readonly tables: number;
    readonly views: number;
    readonly columns: number;
  };
  readonly migrations: {
    readonly files: number;
    readonly snapshots: number;
    readonly tip: number;
    readonly fingerprint: string;
    readonly currentTables: number;
    readonly currentColumns: number;
    readonly historicalCreatedTables: number;
    readonly historicalDroppedTables: number;
  };
  readonly databaseWriters: {
    readonly total: number;
    readonly insert: number;
    readonly update: number;
    readonly delete: number;
    readonly unresolved: number;
    readonly raw: number;
    readonly fingerprint: string;
    readonly auditErrors: number;
  };
  readonly dto: {
    readonly observations: number;
    readonly declarations: number;
    readonly arbitraryPayloads: number;
    readonly auditErrors: number;
  };
  readonly activation: {
    readonly reachableReferences: number;
    readonly lifecycleDeclarations: number;
    readonly reviewedExclusions: number;
    readonly auditErrors: number;
  };
};

export type CoverageVerificationCategory = {
  readonly category: string;
  readonly errors: readonly string[];
};

export type CoverageSourceAlarmDebt = {
  readonly debtId: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
  readonly owner: string;
  readonly reason: string;
  readonly remediationState: RemediationState;
  readonly releaseImpact: ReleaseImpact;
  readonly evidenceGap: string;
};

const CLASSIFICATIONS: readonly EncryptionClassification[] = [
  "protected",
  "bounded_metadata",
  "public",
  "operator_secret",
  "device_local",
];

function escapeCell(value: unknown): string {
  return String(value).replaceAll("|", "\\|").replaceAll("\n", " ");
}

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => {
    const leftKey = key(left);
    const rightKey = key(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function bulletList(values: readonly string[]): string[] {
  if (values.length === 0) return ["- None."];
  return values.map((value) => `- \`${escapeCell(value)}\``);
}

function countBySurface(
  input: CoverageReportInput,
  surface: CoverageSurface,
): { observed: number; classified: number; linkedDebt: number; debt: number } {
  const retiredDebtIds = new Set(
    (input.registry.retiredFrozenDebt ?? []).map((item) => item.debtId),
  );
  return {
    observed: input.observed.filter((item) => item.surface === surface).length,
    classified: input.registry.entries.filter((item) => item.surface === surface).length,
    linkedDebt: (input.registry.reviewedDebtLinks ?? []).filter(
      (item) => item.surface === surface,
    ).length,
    debt: input.registry.debt.filter(
      (item) => item.surface === surface && !retiredDebtIds.has(item.id),
    ).length,
  };
}

export function formatCoverageReport(input: CoverageReportInput): string {
  const audit = auditCoverageRegistry(input.registry);
  const drift = compareInventory({
    observed: input.observed,
    registry: input.registry,
    frozenBaselineDebt: input.baselineDebtSnapshot.entries,
  });
  const invalid = audit.ok ? [] : [...audit.errors].sort();
  const entries = sorted(input.registry.entries, (item) => `${item.surface}:${item.locator}:${item.id}`);
  const allDebt = sorted(input.registry.debt, (item) => `${item.surface}:${item.locator}:${item.id}`);
  const retiredDebtById = new Map(
    (input.registry.retiredFrozenDebt ?? []).map((item) => [item.debtId, item]),
  );
  const debt = allDebt.filter((item) => !retiredDebtById.has(item.id));
  const retiredDebt = allDebt.flatMap((item) => {
    const retirement = retiredDebtById.get(item.id);
    return retirement ? [{ debt: item, retirement }] : [];
  });
  const reviewedDebtLinks = sorted(
    input.registry.reviewedDebtLinks ?? [],
    (item) => `${item.surface}:${item.locator}:${item.id}`,
  );
  const sourceAlarmDebt = sorted(
    input.sourceAlarmDebt,
    (item) => `${item.surface}:${item.locator}:${item.debtId}`,
  );
  const exceptions = sorted(input.registry.exceptions, (item) => item.id);
  const lines: string[] = [
    "# Encryption coverage",
    "",
    "> Generated file. Do not edit by hand.",
    "",
    "| Property | Value |",
    "|---|---|",
    `| Generator version | \`${escapeCell(input.generatorVersion)}\` |`,
    `| Schema version | \`${input.schemaVersion}\` |`,
    `| Activation default | \`${DEFAULT_ENCRYPTION_ACTIVATION.stage}\` |`,
    `| Frozen baseline debt snapshot | \`${escapeCell(input.baselineDebtSnapshot.version)}\` |`,
    `| Frozen baseline debt count | ${input.baselineDebtSnapshot.entries.length} |`,
    `| Frozen baseline debt fingerprint | \`${escapeCell(input.baselineDebtSnapshot.sha256)}\` |`,
    `| Regenerate | \`bun run encryption:inventory\` |`,
    `| Verify | \`bun run encryption:check\` |`,
    "",
    "Baseline debt blocks applicable release claims.",
    "",
    "## Inventory source summary",
    "",
    "| Surface | Observed | Classified | Reviewed debt links | Baseline debt |",
    "|---|---:|---:|---:|---:|",
  ];

  for (const surface of COVERAGE_SURFACES) {
    const count = countBySurface(input, surface);
    lines.push(
      `| ${surface} | ${count.observed} | ${count.classified} | ${count.linkedDebt} | ${count.debt} |`,
    );
  }

  lines.push(
    "",
    "## Scanner metadata",
    "",
    "| Scanner | Metric | Value |",
    "|---|---|---:|",
    `| source | Semantic declarations | ${input.scannerMetadata.source.declarations} |`,
    `| source | Alarms | ${input.scannerMetadata.source.alarms} |`,
    `| source | Alarm fingerprint | \`${escapeCell(input.scannerMetadata.source.alarmFingerprint)}\` |`,
    `| source | Alarm baseline debt | ${input.scannerMetadata.source.reviewedAlarmDebt} |`,
    `| source | Reviewed alarm exclusions | ${input.scannerMetadata.source.reviewedAlarmExclusions} |`,
    `| source | Unmapped alarms | ${input.scannerMetadata.source.unmappedAlarms} |`,
    `| source | Scan exclusions | ${input.scannerMetadata.source.exclusions} |`,
    `| schema | Objects | ${input.scannerMetadata.schema.objects} |`,
    `| schema | Tables | ${input.scannerMetadata.schema.tables} |`,
    `| schema | Views | ${input.scannerMetadata.schema.views} |`,
    `| schema | Columns | ${input.scannerMetadata.schema.columns} |`,
    `| migrations | Files | ${input.scannerMetadata.migrations.files} |`,
    `| migrations | Snapshots | ${input.scannerMetadata.migrations.snapshots} |`,
    `| migrations | Tail index | ${input.scannerMetadata.migrations.tip} |`,
    `| migrations | Tree fingerprint | \`${escapeCell(input.scannerMetadata.migrations.fingerprint)}\` |`,
    `| migrations | Current tables | ${input.scannerMetadata.migrations.currentTables} |`,
    `| migrations | Current columns | ${input.scannerMetadata.migrations.currentColumns} |`,
    `| migrations | Historical created tables | ${input.scannerMetadata.migrations.historicalCreatedTables} |`,
    `| migrations | Historical dropped tables | ${input.scannerMetadata.migrations.historicalDroppedTables} |`,
    `| database writers | Total | ${input.scannerMetadata.databaseWriters.total} |`,
    `| database writers | Inserts | ${input.scannerMetadata.databaseWriters.insert} |`,
    `| database writers | Updates | ${input.scannerMetadata.databaseWriters.update} |`,
    `| database writers | Deletes | ${input.scannerMetadata.databaseWriters.delete} |`,
    `| database writers | Unresolved SQL | ${input.scannerMetadata.databaseWriters.unresolved} |`,
    `| database writers | Raw SQL | ${input.scannerMetadata.databaseWriters.raw} |`,
    `| database writers | Fingerprint | \`${escapeCell(input.scannerMetadata.databaseWriters.fingerprint)}\` |`,
    `| database writers | Audit errors | ${input.scannerMetadata.databaseWriters.auditErrors} |`,
    `| DTO | Observations | ${input.scannerMetadata.dto.observations} |`,
    `| DTO | Declarations | ${input.scannerMetadata.dto.declarations} |`,
    `| DTO | Arbitrary payload leaves | ${input.scannerMetadata.dto.arbitraryPayloads} |`,
    `| DTO | Audit errors | ${input.scannerMetadata.dto.auditErrors} |`,
    `| activation | Reachable references | ${input.scannerMetadata.activation.reachableReferences} |`,
    `| activation | Lifecycle declarations | ${input.scannerMetadata.activation.lifecycleDeclarations} |`,
    `| activation | Reviewed exclusions | ${input.scannerMetadata.activation.reviewedExclusions} |`,
    `| activation | Audit errors | ${input.scannerMetadata.activation.auditErrors} |`,
    "",
    "## Verification categories",
    "",
    "| Category | Status | Errors |",
    "|---|---|---:|",
  );
  const verificationCategories = sorted(
    input.verificationCategories,
    (item) => item.category,
  );
  if (verificationCategories.length === 0) {
    lines.push("| — | pass | 0 |");
  } else {
    for (const category of verificationCategories) {
      lines.push(
        `| ${escapeCell(category.category)} | ${category.errors.length === 0 ? "pass" : "fail"} | ${category.errors.length} |`,
      );
    }
  }

  lines.push(
    "",
    "## Classification counts",
    "",
    "| Classification | Count |",
    "|---|---:|",
  );
  for (const classification of CLASSIFICATIONS) {
    lines.push(
      `| ${classification} | ${entries.filter((item) => item.classification === classification).length} |`,
    );
  }

  lines.push(
    "",
    "## Registered entries",
    "",
    "| ID | Surface | Locator | Classification | Owner | Migration | Evidence |",
    "|---|---|---|---|---|---|---|",
  );
  if (entries.length === 0) {
    lines.push("| — | — | — | — | — | — | — |");
  } else {
    for (const entry of entries) {
      lines.push(
        `| \`${escapeCell(entry.id)}\` | ${entry.surface} | \`${escapeCell(entry.locator)}\` | ${entry.classification} | ${escapeCell(entry.owner)} | ${entry.migrationState} | ${entry.testEvidence.map((item) => `\`${escapeCell(item)}\``).join("<br>")} |`,
      );
    }
  }

  lines.push(
    "",
    "## Reviewed existing-debt links",
    "",
    "These observations are exact additional representations or call sites of a frozen plaintext boundary. They inherit the target debt's release impact and do not create or weaken baseline debt.",
    "",
    "| ID | Surface | Locator | Frozen debt target | Inherited release impact | Owner | Reason | Evidence |",
    "|---|---|---|---|---|---|---|---|",
  );
  if (reviewedDebtLinks.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — |");
  } else {
    const debtById = new Map(allDebt.map((item) => [item.id, item]));
    for (const link of reviewedDebtLinks) {
      const impacts = [...new Set(link.targetDebtIds.flatMap((targetId) => {
        const target = debtById.get(targetId);
        return target ? [target.releaseImpact] : [];
      }))].sort();
      lines.push(
        `| \`${escapeCell(link.id)}\` | ${link.surface} | \`${escapeCell(link.locator)}\` | ${link.targetDebtIds.map((item) => `\`${escapeCell(item)}\``).join("<br>")} | ${impacts.join("<br>") || "invalid target"} | ${escapeCell(link.owner)} | ${escapeCell(link.reason)} | ${link.testEvidence.map((item) => `\`${escapeCell(item)}\``).join("<br>")} |`,
      );
    }
  }

  lines.push(
    "",
    "## Baseline debt",
    "",
    "| ID | Surface | Locator | Owner | State | Release impact | Reason | Evidence gap |",
    "|---|---|---|---|---|---|---|---|",
  );
  if (debt.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — |");
  } else {
    for (const item of debt) {
      lines.push(
        `| \`${escapeCell(item.id)}\` | ${item.surface} | \`${escapeCell(item.locator)}\` | ${escapeCell(item.owner)} | ${item.remediationState} | ${item.releaseImpact} | ${escapeCell(item.reason)} | ${escapeCell(item.evidenceGap)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Retired frozen debt",
    "",
    "These immutable baseline rows remain as audit history, but their deleted observations are not active debt and do not block current release claims.",
    "",
    "| ID | Surface | Former locator | Former owner | Retirement reason | Evidence |",
    "|---|---|---|---|---|---|",
  );
  if (retiredDebt.length === 0) {
    lines.push("| — | — | — | — | — | — |");
  } else {
    for (const { debt: item, retirement } of retiredDebt) {
      lines.push(
        `| \`${escapeCell(item.id)}\` | ${item.surface} | \`${escapeCell(item.locator)}\` | ${escapeCell(item.owner)} | ${escapeCell(retirement.reason)} | ${retirement.testEvidence.map((evidence) => `\`${escapeCell(evidence)}\``).join("<br>")} |`,
      );
    }
  }

  lines.push(
    "",
    "## Source alarm debt",
    "",
    "These exact heuristic call sites were reviewed as alarms; their semantic payload classification remains untriaged. They block the whole-product encryption claim without pretending each alarm is a distinct persisted-data surface.",
    "",
    "| Debt ID | Surface | Locator | Owner | State | Release impact | Reason | Evidence gap |",
    "|---|---|---|---|---|---|---|---|",
  );
  if (sourceAlarmDebt.length === 0) {
    lines.push("| — | — | — | — | — | — | — | — |");
  } else {
    for (const item of sourceAlarmDebt) {
      lines.push(
        `| \`${escapeCell(item.debtId)}\` | ${item.surface} | \`${escapeCell(item.locator)}\` | ${escapeCell(item.owner)} | ${item.remediationState} | ${item.releaseImpact} | ${escapeCell(item.reason)} | ${escapeCell(item.evidenceGap)} |`,
      );
    }
  }

  lines.push(
    "",
    "## Exceptions",
    "",
    "| ID | Owner | Exact scope | Review by | Release impact |",
    "|---|---|---|---|---|",
  );
  if (exceptions.length === 0) {
    lines.push("| — | — | — | — | — |");
  } else {
    for (const exception of exceptions) {
      lines.push(
        `| \`${escapeCell(exception.id)}\` | ${escapeCell(exception.owner)} | ${exception.scope.map((item) => `\`${escapeCell(item)}\``).join("<br>")} | ${exception.reviewBy} | ${exception.releaseImpact} |`,
      );
    }
  }

  lines.push(
    "",
    "## Invalid declarations",
    "",
    ...bulletList(invalid),
    "",
    "## Unknown observations",
    "",
    ...bulletList(drift.unknown),
    "",
    "## Stale declarations",
    "",
    ...bulletList(drift.stale),
    "",
    "## Unfrozen baseline debt",
    "",
    ...bulletList(drift.unfrozenDebt),
    "",
    "## Scanner verification errors",
    "",
    ...bulletList(verificationCategories.flatMap((category) =>
      [...category.errors]
        .sort()
        .map((error) => `${category.category}: ${error}`)
    )),
    "",
  );

  return lines.join("\n");
}

export function verifyCoverageReport(
  current: string,
  input: CoverageReportInput,
): ReportVerificationResult {
  return verifyRenderedCoverageReport(current, formatCoverageReport(input));
}
