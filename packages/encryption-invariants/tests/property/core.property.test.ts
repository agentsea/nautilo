import { describe, expect, test } from "bun:test";
import fc from "fast-check";

import {
  DEFAULT_ENCRYPTION_ACTIVATION,
  parseWave0Activation,
} from "../../src/activation";
import {
  COVERAGE_SURFACES,
  type CoverageSurface,
  type EncryptionCoverageEntry,
  validateBaselineDebt,
  validateCoverageEntry,
} from "../../src/model";
import {
  auditDtoDeclarations,
  type DtoDeclaration,
  type DtoInventoryObservation,
} from "../../src/node/dto-declaration-audit";
import {
  auditCoverageRegistry,
  compareInventory,
  type CoverageRegistry,
  type InventoryObservation,
} from "../../src/registry";
import {
  formatCoverageReport,
  verifyCoverageReport,
} from "../../src/report";

const PROPERTY_RUNS = 250;
const PROPERTY_SEEDS = {
  activationSequences: 0x4d323230,
  entryValidation: 0x4d323231,
  registryCollisions: 0x4d323232,
  pathSeparators: 0x4d323233,
  dtoWildcards: 0x4d323234,
  inventorySets: 0x4d323235,
  reportDeterminism: 0x4d323236,
  debtValidation: 0x4d323237,
  inventoryFreeze: 0x4d323238,
} as const;

const EMPTY_SCANNER_METADATA = {
  source: {
    declarations: 0,
    alarms: 0,
    alarmFingerprint: "property-source",
    reviewedAlarmDebt: 0,
    reviewedAlarmExclusions: 0,
    unmappedAlarms: 0,
    exclusions: 0,
  },
  schema: { objects: 0, tables: 0, views: 0, columns: 0 },
  migrations: {
    files: 0,
    snapshots: 0,
    tip: 0,
    fingerprint: "property-migrations",
    currentTables: 0,
    currentColumns: 0,
    historicalCreatedTables: 0,
    historicalDroppedTables: 0,
  },
  databaseWriters: {
    total: 0,
    insert: 0,
    update: 0,
    delete: 0,
    unresolved: 0,
    raw: 0,
    fingerprint: "property-database-writers",
    auditErrors: 0,
  },
  dto: {
    observations: 0,
    declarations: 0,
    arbitraryPayloads: 0,
    auditErrors: 0,
  },
  activation: {
    reachableReferences: 0,
    lifecycleDeclarations: 0,
    reviewedExclusions: 0,
    auditErrors: 0,
  },
} as const;

function propertyParameters(seed: number): fc.Parameters<unknown> {
  return {
    seed,
    numRuns: PROPERTY_RUNS,
  };
}

const surfaceArbitrary = fc.constantFrom<CoverageSurface>(...COVERAGE_SURFACES);
const segmentArbitrary = fc.stringMatching(/^[a-z][a-z0-9]{1,8}$/);
const locatorArbitrary = fc
  .tuple(segmentArbitrary, segmentArbitrary)
  .map(([parent, child]) => `${parent}.${child}`);

const observationArbitrary = fc
  .tuple(surfaceArbitrary, locatorArbitrary)
  .map(([surface, locator]): InventoryObservation => ({
    id: `${surface}.${locator}`,
    surface,
    locator,
  }));

function publicEntry(
  surface: CoverageSurface,
  locator: string,
): EncryptionCoverageEntry {
  return {
    id: `${surface}.${locator}`,
    surface,
    locator,
    classification: "public",
    owner: "security-platform",
    readers: ["packages/server"],
    writers: ["packages/runtime"],
    migrationState: "not_applicable",
    plaintextReason: "Generated public catalogue metadata for an invariant fixture.",
    retention: "Retained for the generated property fixture lifetime.",
    testEvidence: [
      "packages/encryption-invariants/tests/property/core.property.test.ts",
    ],
  };
}

const publicEntryArbitrary = fc
  .tuple(surfaceArbitrary, locatorArbitrary)
  .map(([surface, locator]) => publicEntry(surface, locator));

function debtFor(observation: InventoryObservation) {
  return {
    id: `debt.${observation.id}`,
    surface: observation.surface,
    locator: observation.locator,
    owner: "security-platform",
    reason: "Wave 0 has not yet classified this exact observed surface.",
    remediationState: "untriaged" as const,
    releaseImpact: "blocks_whole_product_claim" as const,
    evidenceGap: "Executable encryption bridge evidence is not yet available.",
  };
}

describe("seeded Wave 0 properties", () => {
  test("activation sequences never leave the frozen disabled state", () => {
    const nonDisabledStage = fc.string().map((stage) =>
      stage === "disabled" ? "shadow_writing" : stage
    );
    const activationInput = fc.oneof(
      fc.constant(undefined),
      fc.constant({ stage: "disabled" }),
      nonDisabledStage.map((stage) => ({ stage })),
      fc.record({
        stage: fc.constant("disabled"),
        extra: fc.anything(),
      }),
      fc.anything(),
    );

    fc.assert(
      fc.property(
        fc.array(activationInput, { minLength: 1, maxLength: 40 }),
        (inputs) => {
          let current = DEFAULT_ENCRYPTION_ACTIVATION;
          for (const input of inputs) {
            const result = parseWave0Activation(input);
            if (result.ok) current = result.value;
            expect(current).toEqual({ stage: "disabled" });
            if (result.ok) {
              expect(
                input === undefined
                || (
                  typeof input === "object"
                  && input !== null
                  && !Array.isArray(input)
                  && Object.keys(input).length === 1
                  && (input as Record<string, unknown>)["stage"] === "disabled"
                ),
              ).toBe(true);
            }
          }
        },
      ),
      propertyParameters(PROPERTY_SEEDS.activationSequences),
    );
  });

  test("valid entries survive validation and invalid required fields fail closed", () => {
    const invalidMutation = fc.constantFrom<
      (entry: EncryptionCoverageEntry) => unknown
    >(
      (entry) => ({ ...entry, id: "invalid" }),
      (entry) => ({ ...entry, locator: `${entry.locator}.*` }),
      (entry) => ({ ...entry, owner: " " }),
      (entry) => ({ ...entry, classification: "unknown" }),
      (entry) => ({ ...entry, testEvidence: [] }),
    );

    fc.assert(
      fc.property(publicEntryArbitrary, invalidMutation, (entry, invalidate) => {
        expect(validateCoverageEntry(entry)).toEqual({ ok: true });
        expect(validateCoverageEntry(invalidate(entry)).ok).toBe(false);
      }),
      propertyParameters(PROPERTY_SEEDS.entryValidation),
    );
  });

  test("duplicate and colliding registry identities always fail", () => {
    fc.assert(
      fc.property(publicEntryArbitrary, (entry) => {
        const collision = {
          ...debtFor({
            id: entry.id,
            surface: entry.surface,
            locator: entry.locator,
          }),
          id: entry.id,
        };
        const result = auditCoverageRegistry({
          entries: [entry, { ...entry }],
          debt: [collision],
          exceptions: [],
        });

        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(result.errors).toContain(`duplicate registry id: ${entry.id}`);
          expect(result.errors).toContain(
            `duplicate registry locator: ${entry.locator}`,
          );
          expect(result.errors).toContain(
            `registry id collides with baseline debt: ${entry.id}`,
          );
          expect(result.errors).toContain(
            `registry locator collides with baseline debt: ${entry.locator}`,
          );
        }
      }),
      propertyParameters(PROPERTY_SEEDS.registryCollisions),
    );
  });

  test("repository paths accept POSIX separators and reject Windows separators", () => {
    fc.assert(
      fc.property(segmentArbitrary, segmentArbitrary, (parent, child) => {
        const entry = publicEntry("db", `${parent}.${child}`);
        const protectedEntry = {
          ...entry,
          classification: "protected",
          keyFamily: "namespace_ai",
          bridgeRepository: `packages/${parent}/src/${child}.ts`,
          negativeTestEvidence: [
            "packages/encryption-invariants/tests/property/core.property.test.ts",
          ],
        } as const;

        expect(validateCoverageEntry(protectedEntry)).toEqual({ ok: true });
        expect(validateCoverageEntry({
          ...protectedEntry,
          bridgeRepository: `packages\\${parent}\\src\\${child}.ts`,
        }).ok).toBe(false);
      }),
      propertyParameters(PROPERTY_SEEDS.pathSeparators),
    );
  });

  test("DTO declarations reject wildcard paths and blanket JSON schemas", () => {
    const blanketSchemaArbitrary = fc.constantFrom(
      "unknown",
      "unknown[]",
      "any",
      "json",
      "Record<string, unknown>",
      "Payload*",
    );

    fc.assert(
      fc.property(
        segmentArbitrary,
        blanketSchemaArbitrary,
        (leaf, blanketSchema) => {
          const path = `payload.${leaf}`;
          const observation: DtoInventoryObservation = {
            id: `wire.test.${leaf}`,
            surface: "wire",
            locator: `http:accepted_arbitrary:test#${leaf}`,
            transport: "http",
            direction: "accepted_arbitrary",
            contract: `${leaf}Body`,
            sourcePath: "packages/server/src/routes/test.ts",
            structuralSignatures: [],
            arbitraryPayloads: [path],
          };
          const exactDeclaration: DtoDeclaration = {
            observationId: observation.id,
            locator: observation.locator,
            arbitraryPayloads: [{
              path,
              schema: `Closed${leaf}PayloadV1`,
            }],
          };

          expect(auditDtoDeclarations({
            observations: [observation],
            declarations: [exactDeclaration],
          }).ok).toBe(true);

          const blanket = auditDtoDeclarations({
            observations: [observation],
            declarations: [{
              ...exactDeclaration,
              arbitraryPayloads: [{ path, schema: blanketSchema }],
            }],
          });
          expect(blanket.ok).toBe(false);

          const wildcard = auditDtoDeclarations({
            observations: [observation],
            declarations: [{
              ...exactDeclaration,
              arbitraryPayloads: [{
                path: "payload.*",
                schema: `Closed${leaf}PayloadV1`,
              }],
            }],
          });
          expect(wildcard.ok).toBe(false);
        },
      ),
      propertyParameters(PROPERTY_SEEDS.dtoWildcards),
    );
  });

  test("inventory comparison is order-independent and set-exact", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(observationArbitrary, {
          selector: (value) => `${value.surface}:${value.locator}`,
          maxLength: 25,
        }),
        fc.uniqueArray(observationArbitrary, {
          selector: (value) => `${value.surface}:${value.locator}`,
          maxLength: 25,
        }),
        (observed, declaredObservations) => {
          const registry: CoverageRegistry = {
            entries: [],
            debt: declaredObservations.map(debtFor),
            exceptions: [],
          };
          const forward = compareInventory({
            observed,
            registry,
            frozenBaselineDebt: registry.debt,
          });
          const reversed = compareInventory({
            observed: [...observed].reverse(),
            registry: {
              ...registry,
              debt: [...registry.debt].reverse(),
            },
            frozenBaselineDebt: [...registry.debt].reverse(),
          });

          expect(reversed).toEqual(forward);
          expect([...forward.unknown]).toEqual([...forward.unknown].sort());
          expect([...forward.stale]).toEqual([...forward.stale].sort());
          expect(forward.unfrozenDebt).toEqual([]);
          expect(forward.unknown).toHaveLength(
            observed.filter((item) =>
              !declaredObservations.some((declared) =>
                declared.surface === item.surface
                && declared.locator === item.locator
              )
            ).length,
          );
          expect(forward.stale).toHaveLength(
            declaredObservations.filter((item) =>
              !observed.some((actual) =>
                actual.surface === item.surface
                && actual.locator === item.locator
              )
            ).length,
          );
        },
      ),
      propertyParameters(PROPERTY_SEEDS.inventorySets),
    );
  });

  test("new debt never extends the frozen baseline snapshot", () => {
    fc.assert(
      fc.property(
        fc.tuple(observationArbitrary, observationArbitrary)
          .filter(([baseline, introduced]) =>
            baseline.surface !== introduced.surface
            || baseline.locator !== introduced.locator
          ),
        ([baseline, introduced]) => {
          const baselineDebt = debtFor(baseline);
          const introducedDebt = debtFor(introduced);
          const result = compareInventory({
            observed: [baseline, introduced],
            registry: {
              entries: [],
              debt: [baselineDebt, introducedDebt],
              exceptions: [],
            },
            frozenBaselineDebt: [baselineDebt],
          });

          expect(result).toEqual({
            unknown: [`${introduced.surface}:${introduced.locator}`],
            stale: [],
            unfrozenDebt: [
              `${introducedDebt.id}:${introduced.surface}:${introduced.locator}`,
            ],
          });
        },
      ),
      propertyParameters(PROPERTY_SEEDS.inventoryFreeze),
    );
  });

  test("coverage reports are deterministic, idempotent, and drift-checkable", () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(observationArbitrary, {
          selector: (value) => `${value.surface}:${value.locator}`,
          maxLength: 25,
        }),
        (observed) => {
          const registry: CoverageRegistry = {
            entries: [],
            debt: observed.map(debtFor),
            exceptions: [],
          };
          const input = {
            schemaVersion: 1,
            generatorVersion: "property-v1",
            registry,
            baselineDebtSnapshot: {
              version: "property-initial",
              sha256: "property-fingerprint",
              entries: registry.debt,
            },
            observed,
            scannerMetadata: EMPTY_SCANNER_METADATA,
            verificationCategories: [],
            sourceAlarmDebt: [],
          };
          const generated = formatCoverageReport(input);
          const reordered = formatCoverageReport({
            ...input,
            registry: {
              ...registry,
              debt: [...registry.debt].reverse(),
            },
            baselineDebtSnapshot: {
              ...input.baselineDebtSnapshot,
              entries: [...input.baselineDebtSnapshot.entries].reverse(),
            },
            observed: [...observed].reverse(),
          });

          expect(reordered).toBe(generated);
          expect(formatCoverageReport(input)).toBe(generated);
          expect(verifyCoverageReport(generated, input)).toEqual({ ok: true });
          expect(verifyCoverageReport(`${generated}drift`, input).ok).toBe(false);
        },
      ),
      propertyParameters(PROPERTY_SEEDS.reportDeterminism),
    );
  });

  test("blank required debt fields never validate", () => {
    const fields = [
      "locator",
      "owner",
      "reason",
      "evidenceGap",
    ] as const;

    fc.assert(
      fc.property(
        fc.constantFrom(...fields),
        fc.constantFrom("", " ", "\t", "\n"),
        (field, blank) => {
          const candidate = {
            id: "debt.db.example.payload",
            surface: "db",
            locator: "example.payload",
            owner: "security-platform",
            reason: "This surface has not yet received an encryption bridge.",
            remediationState: "planned",
            releaseImpact: "blocks_enabled_scope",
            evidenceGap: "Ciphertext read and write evidence is not available yet.",
            [field]: blank,
          };
          expect(validateBaselineDebt(candidate).ok).toBe(false);
        },
      ),
      propertyParameters(PROPERTY_SEEDS.debtValidation),
    );
  });
});
