import {
  COVERAGE_SURFACES,
  type CoverageException,
  type CoverageSurface,
  type EncryptionBaselineDebt,
  type EncryptionCoverageEntry,
  validateBaselineDebt,
  validateCoverageEntry,
  validateCoverageException,
} from "./model";

export type CoverageRegistry = {
  readonly entries: readonly EncryptionCoverageEntry[];
  readonly debt: readonly EncryptionBaselineDebt[];
  readonly reviewedDebtLinks?: readonly ReviewedDebtLink[];
  readonly retiredFrozenDebt?: readonly RetiredFrozenDebt[];
  readonly exceptions: readonly CoverageException[];
};

/**
 * Records that an observation from the immutable Wave 0 snapshot no longer
 * exists. The debt row stays frozen for audit history, while its locator stops
 * participating in the current-inventory closure.
 */
export type RetiredFrozenDebt = {
  readonly debtId: string;
  readonly reason: string;
  readonly testEvidence: readonly string[];
};

export type ReviewedDebtLink = {
  readonly id: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
  readonly owner: string;
  readonly targetDebtIds: readonly string[];
  readonly reason: string;
  readonly testEvidence: readonly string[];
  /**
   * Explicit proof that a new database table projects an already-frozen
   * plaintext content class rather than introducing unrelated debt.
   */
  readonly crossBoundaryProjection?: {
    readonly fields: readonly string[];
    readonly rationale: string;
  };
};

export type InventoryObservation = {
  readonly id: string;
  readonly surface: CoverageSurface;
  readonly locator: string;
};

export type FrozenBaselineDebt = Pick<
  EncryptionBaselineDebt,
  "id" | "surface" | "locator"
>;

export type RegistryAuditResult =
  | {
      readonly ok: true;
      readonly counts: {
        readonly classified: number;
        readonly debt: number;
        readonly reviewedDebtLinks: number;
        readonly exceptions: number;
      };
    }
  | { readonly ok: false; readonly errors: readonly string[] };

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicate = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicate.add(value);
    else seen.add(value);
  }
  return [...duplicate].sort();
}

export function auditCoverageRegistry(registry: CoverageRegistry): RegistryAuditResult {
  const errors: string[] = [];
  for (const entry of registry.entries) {
    const result = validateCoverageEntry(entry);
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `${entry.id}: ${error}`));
    }
  }
  for (const item of registry.debt) {
    const result = validateBaselineDebt(item);
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `${item.id}: ${error}`));
    }
  }
  for (const exception of registry.exceptions) {
    const result = validateCoverageException(exception);
    if (!result.ok) {
      errors.push(...result.errors.map((error) => `${exception.id}: ${error}`));
    }
  }
  for (const link of registry.reviewedDebtLinks ?? []) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u.test(link.id)) {
      errors.push(`${link.id}: reviewed debt link id must be a stable dotted identifier`);
    }
    if (!link.locator.trim()) {
      errors.push(`${link.id}: reviewed debt link locator must be non-empty`);
    }
    if (!COVERAGE_SURFACES.includes(link.surface)) {
      errors.push(`${link.id}: reviewed debt link surface is invalid`);
    }
    if (!link.owner.trim()) {
      errors.push(`${link.id}: reviewed debt link owner must be non-empty`);
    }
    if (
      link.targetDebtIds.length === 0
      || link.targetDebtIds.some((id) => !id.trim())
    ) {
      errors.push(`${link.id}: reviewed debt link must target exact baseline debt IDs`);
    }
    if (duplicates(link.targetDebtIds).length > 0) {
      errors.push(`${link.id}: reviewed debt link target IDs must be unique`);
    }
    if (link.reason.trim().length < 12) {
      errors.push(`${link.id}: reviewed debt link reason must be descriptive`);
    }
    if (
      link.testEvidence.length === 0
      || link.testEvidence.some((path) =>
        !/^[^/\\]+(?:\/[^/\\]+)*[.]test[.](?:ts|tsx|js|jsx)$/u.test(path)
        || path.split("/").some((segment) =>
          segment === "." || segment === ".."
        )
      )
    ) {
      errors.push(`${link.id}: reviewed debt link needs executable test evidence`);
    }
    if (link.crossBoundaryProjection) {
      if (
        link.surface !== "db"
        || link.crossBoundaryProjection.fields.length === 0
        || link.crossBoundaryProjection.fields.some((field) =>
          !field.trim()
          || field.includes("*")
          || field.startsWith(".")
          || field.endsWith(".")
        )
      ) {
        errors.push(
          `${link.id}: cross-boundary projection requires exact database fields`,
        );
      }
      if (link.crossBoundaryProjection.rationale.trim().length < 24) {
        errors.push(
          `${link.id}: cross-boundary projection rationale must be descriptive`,
        );
      }
    }
  }
  for (const retirement of registry.retiredFrozenDebt ?? []) {
    if (!/^[a-z0-9]+(?:[._-][a-z0-9]+)+$/u.test(retirement.debtId)) {
      errors.push(
        `${retirement.debtId}: retired frozen debt ID must be a stable dotted identifier`,
      );
    }
    if (retirement.reason.trim().length < 24) {
      errors.push(
        `${retirement.debtId}: retired frozen debt reason must be descriptive`,
      );
    }
    if (
      retirement.testEvidence.length === 0
      || retirement.testEvidence.some((path) =>
        !/^[^/\\]+(?:\/[^/\\]+)*[.]test[.](?:ts|tsx|js|jsx)$/u.test(path)
        || path.split("/").some((segment) => segment === "." || segment === "..")
      )
    ) {
      errors.push(
        `${retirement.debtId}: retired frozen debt needs executable test evidence`,
      );
    }
  }

  for (const id of duplicates(registry.entries.map((entry) => entry.id))) {
    errors.push(`duplicate registry id: ${id}`);
  }
  for (const locator of duplicates(registry.entries.map((entry) => entry.locator))) {
    errors.push(`duplicate registry locator: ${locator}`);
  }
  for (const id of duplicates(registry.debt.map((item) => item.id))) {
    errors.push(`duplicate baseline debt id: ${id}`);
  }
  for (const locator of duplicates(registry.debt.map((item) => item.locator))) {
    errors.push(`duplicate baseline debt locator: ${locator}`);
  }
  for (const id of duplicates(
    // Stryker disable next-line ArrayDeclaration: a synthetic singleton default has no duplicate.
    (registry.reviewedDebtLinks ?? []).map((item) => item.id),
  )) {
    errors.push(`duplicate reviewed debt link id: ${id}`);
  }
  for (const locator of duplicates(
    // Stryker disable next-line ArrayDeclaration: a synthetic singleton default has no duplicate.
    (registry.reviewedDebtLinks ?? []).map((item) => item.locator),
  )) {
    errors.push(`duplicate reviewed debt link locator: ${locator}`);
  }
  for (const debtId of duplicates(
    // Stryker disable next-line ArrayDeclaration: a synthetic singleton default has no duplicate.
    (registry.retiredFrozenDebt ?? []).map((item) => item.debtId),
  )) {
    errors.push(`duplicate retired frozen debt ID: ${debtId}`);
  }

  const entryIds = new Set(registry.entries.map((entry) => entry.id));
  const entryLocators = new Set(registry.entries.map((entry) => entry.locator));
  const debtIds = new Set(registry.debt.map((item) => item.id));
  const debtLocators = new Set(registry.debt.map((item) => item.locator));
  for (const id of [...new Set(registry.debt.map((item) => item.id))].sort()) {
    if (entryIds.has(id)) errors.push(`registry id collides with baseline debt: ${id}`);
  }
  for (const locator of [...new Set(registry.debt.map((item) => item.locator))].sort()) {
    if (entryLocators.has(locator)) {
      errors.push(`registry locator collides with baseline debt: ${locator}`);
    }
  }
  // Stryker disable next-line ArrayDeclaration: a synthetic string default cannot collide with typed registry identities.
  for (const link of registry.reviewedDebtLinks ?? []) {
    if (entryIds.has(link.id)) {
      errors.push(`reviewed debt link id collides with registry entry: ${link.id}`);
    }
    if (debtIds.has(link.id)) {
      errors.push(`reviewed debt link id collides with baseline debt: ${link.id}`);
    }
    if (entryLocators.has(link.locator)) {
      errors.push(
        `reviewed debt link locator collides with registry entry: ${link.locator}`,
      );
    }
    if (debtLocators.has(link.locator)) {
      errors.push(
        `reviewed debt link locator collides with baseline debt: ${link.locator}`,
      );
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    counts: {
      classified: registry.entries.length,
      debt: registry.debt.length,
      reviewedDebtLinks: registry.reviewedDebtLinks?.length ?? 0,
      exceptions: registry.exceptions.length,
    },
  };
}

function observationKey(value: Pick<InventoryObservation, "surface" | "locator">): string {
  return `${value.surface}:${value.locator}`;
}

export function reviewedDebtLinkErrors(
  registry: CoverageRegistry,
  frozenBaselineDebt: readonly FrozenBaselineDebt[],
): readonly string[] {
  const frozenIds = new Set(
    frozenBaselineDebt.map((item) =>
      `${item.id}:${item.surface}:${item.locator}`
    ),
  );
  const currentDebt = new Map(
    registry.debt.map((item) => [item.id, item]),
  );
  const errors: string[] = [];
  // Stryker disable next-line ArrayDeclaration: a synthetic string default cannot yield a target iteration.
  for (const link of registry.reviewedDebtLinks ?? []) {
    for (const targetId of link.targetDebtIds) {
      const target = currentDebt.get(targetId);
      if (!target) {
        errors.push(`${link.id}: reviewed debt link target is missing: ${targetId}`);
        continue;
      }
      if (
        !frozenIds.has(`${target.id}:${target.surface}:${target.locator}`)
      ) {
        errors.push(`${link.id}: reviewed debt link target is not frozen: ${targetId}`);
      }
      if (target.surface !== link.surface) {
        errors.push(
          `${link.id}: reviewed debt link surface ${link.surface} does not match target ${targetId} surface ${target.surface}`,
        );
      }
      if (link.surface === "db") {
        const linkedBoundary = databaseBoundary(link.locator);
        const targetBoundary = databaseBoundary(target.locator);
        if (
          linkedBoundary === undefined
          || (
            linkedBoundary !== targetBoundary
            && !link.crossBoundaryProjection
          )
        ) {
          errors.push(
            `${link.id}: reviewed debt link database boundary ${linkedBoundary ?? "unknown"} does not match target ${targetId} boundary ${targetBoundary ?? "unknown"}`,
          );
        }
      }
    }
  }
  return errors.sort();
}

export function retiredFrozenDebtErrors(
  registry: CoverageRegistry,
  frozenBaselineDebt: readonly FrozenBaselineDebt[],
): readonly string[] {
  const currentDebt = new Map(registry.debt.map((item) => [item.id, item]));
  const frozen = new Set(
    frozenBaselineDebt.map((item) => `${item.id}:${observationKey(item)}`),
  );
  const errors: string[] = [];
  for (const retirement of registry.retiredFrozenDebt ?? []) {
    const target = currentDebt.get(retirement.debtId);
    if (!target) {
      errors.push(
        `${retirement.debtId}: retired frozen debt target is missing`,
      );
      continue;
    }
    if (!frozen.has(`${target.id}:${observationKey(target)}`)) {
      errors.push(
        `${retirement.debtId}: retired frozen debt target is not frozen`,
      );
    }
  }
  return errors.sort();
}

function databaseBoundary(locator: string): string | undefined {
  const rawMarker = ":raw_sql:";
  const rawIndex = locator.indexOf(rawMarker);
  if (rawIndex >= 0) {
    const parts = locator.slice(rawIndex + rawMarker.length).split(":");
    return parts.length >= 2 ? `${parts[0]}:${parts[1]}` : undefined;
  }
  const parts = locator.split(".");
  if (parts.length === 2) return parts[0] === "public" ? locator : parts[0];
  // Stryker disable next-line EqualityOperator: two-part locators return above.
  return parts.length > 2 ? parts.slice(0, -1).join(".") : undefined;
}

/**
 * Raw-SQL versus typed-Drizzle is scanner provenance, not part of the
 * reviewed mutation boundary. Preserve an exact review when the source path,
 * symbol, operation, table, and occurrence remain identical.
 */
export function canonicalDatabaseWriterLocator(locator: string): string {
  const withoutRawProvenance = locator.replace(":raw_sql:", ":");
  return /#[^:]+:(?:insert|update|delete|unresolved):[^:]+:\d+$/u.test(
      withoutRawProvenance,
    )
    ? withoutRawProvenance
    : locator;
}

export function compareInventory(input: {
  readonly observed: readonly InventoryObservation[];
  readonly registry: CoverageRegistry;
  /**
   * The committed Wave 0 snapshot is the only debt allowed to grandfather an
   * observation. Current registry debt is deliberately not self-authorizing:
   * adding a new observation and a matching untriaged debt row must fail until
   * the observation is classified.
   */
  readonly frozenBaselineDebt: readonly FrozenBaselineDebt[];
}): {
  readonly unknown: readonly string[];
  readonly stale: readonly string[];
  readonly unfrozenDebt: readonly string[];
} {
  const observed = new Set(input.observed.map(observationKey));
  const frozen = new Set(
    input.frozenBaselineDebt.map(
      (item) => `${item.id}:${observationKey(item)}`,
    ),
  );
  const grandfatheredDebt = input.registry.debt.filter((item) =>
    frozen.has(`${item.id}:${observationKey(item)}`)
    && !input.registry.retiredFrozenDebt?.some(
      (retirement) => retirement.debtId === item.id,
    )
  );
  const linkedDebt = (input.registry.reviewedDebtLinks ?? []).filter((link) =>
    link.targetDebtIds.length > 0
    && link.targetDebtIds.every((targetId) =>
      input.registry.debt.some((item) =>
        item.id === targetId
        && item.surface === link.surface
        && frozen.has(`${item.id}:${observationKey(item)}`)
      )
    )
  );
  const declared = new Set([
    ...input.registry.entries.map(observationKey),
    ...grandfatheredDebt.map(observationKey),
    ...linkedDebt.map(observationKey),
  ]);

  return {
    unknown: [...observed].filter((key) => !declared.has(key)).sort(),
    stale: [...declared].filter((key) => !observed.has(key)).sort(),
    unfrozenDebt: input.registry.debt
      .filter((item) => !frozen.has(`${item.id}:${observationKey(item)}`))
      .map((item) => `${item.id}:${observationKey(item)}`)
      .sort(),
  };
}
