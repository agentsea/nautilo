import { describe, expect, test } from "bun:test";

import {
  formatCoverageReport,
  verifyCoverageReport,
} from "../../src/report";

const input = {
  schemaVersion: 1,
  generatorVersion: "0.1.0",
  baselineDebtSnapshot: {
    version: "wave-0-initial",
    sha256: "fixture-fingerprint",
    entries: [{
      id: "debt.db.session_messages.content",
      surface: "db",
      locator: "session_messages.content",
    }],
  },
  registry: {
    entries: [{
      id: "db.capabilities.slug",
      surface: "db",
      locator: "capabilities.slug",
      classification: "public",
      owner: "packages/db",
      readers: ["packages/trust"],
      writers: ["packages/db/src/utils/seed-rbac.ts"],
      migrationState: "not_applicable",
      plaintextReason: "Static public authorization catalogue identifier.",
      retention: "Retained for the server lifetime.",
      testEvidence: ["packages/db/tests/unit/sensitive-tables-matrix-complete.test.ts"],
    }],
    debt: [{
      id: "debt.db.session_messages.content",
      surface: "db",
      locator: "session_messages.content",
      owner: "packages/runtime",
      reason: "The Wave 3 bridge repository does not exist yet.",
      remediationState: "planned",
      releaseImpact: "blocks_enabled_scope",
      evidenceGap: "No ciphertext writer or snapshot-negative test exists.",
    }],
    exceptions: [],
  },
  observed: [
    { id: "db.session_messages.content", surface: "db", locator: "session_messages.content" },
    { id: "db.capabilities.slug", surface: "db", locator: "capabilities.slug" },
  ],
  scannerMetadata: {
    source: {
      declarations: 2,
      alarms: 3,
      alarmFingerprint: "source-fingerprint",
      reviewedAlarmDebt: 3,
      reviewedAlarmExclusions: 0,
      unmappedAlarms: 0,
      exclusions: 11,
    },
    schema: { objects: 2, tables: 1, views: 1, columns: 2 },
    migrations: {
      files: 4,
      snapshots: 3,
      tip: 3,
      fingerprint: "migration-fingerprint",
      currentTables: 1,
      currentColumns: 2,
      historicalCreatedTables: 1,
      historicalDroppedTables: 0,
    },
    databaseWriters: {
      total: 7,
      insert: 3,
      update: 2,
      delete: 2,
      unresolved: 1,
      raw: 1,
      fingerprint: "database-writer-fingerprint",
      auditErrors: 0,
    },
    dto: {
      observations: 2,
      declarations: 2,
      arbitraryPayloads: 0,
      auditErrors: 0,
    },
    activation: {
      reachableReferences: 0,
      lifecycleDeclarations: 5,
      reviewedExclusions: 2,
      auditErrors: 0,
    },
  },
  verificationCategories: [
    { category: "activation", errors: [] },
    { category: "source_alarm_closure", errors: [] },
  ],
  sourceAlarmDebt: [{
    debtId:
      "debt.source-alarm.file.filesystem_write.0123456789abcdef",
    surface: "file",
    locator: "packages/example/src/write.ts#filesystem_write:0123456789abcdef:1",
    owner: "packages/example",
    reason:
      "packages/example/src/write.ts#filesystem_write:0123456789abcdef:1 is a reviewed filesystem-write alarm whose payload classification remains untriaged.",
    remediationState: "untriaged",
    releaseImpact: "blocks_whole_product_claim",
    evidenceGap:
      "packages/example/src/write.ts#filesystem_write:0123456789abcdef:1 lacks executable payload-boundary evidence for this filesystem-write alarm.",
  }],
} as const;

describe("coverage report", () => {
  test("is byte-deterministic across input ordering", () => {
    const expected = formatCoverageReport(input);
    const reordered = formatCoverageReport({
      ...input,
      observed: [...input.observed].reverse(),
      registry: {
        ...input.registry,
        entries: [...input.registry.entries].reverse(),
        debt: [...input.registry.debt].reverse(),
      },
    });

    expect(reordered).toBe(expected);
    expect(expected).toContain("Activation default | `disabled`");
    expect(expected).toContain("Frozen baseline debt snapshot | `wave-0-initial`");
    expect(expected).toContain("Frozen baseline debt count | 1");
    expect(expected).toContain(
      "Frozen baseline debt fingerprint | `fixture-fingerprint`",
    );
    expect(expected).toContain("`debt.db.session_messages.content`");
    expect(expected).toContain("Baseline debt blocks applicable release claims.");
    expect(expected).toContain("## Scanner metadata");
    expect(expected).toContain("source | Alarm fingerprint | `source-fingerprint`");
    expect(expected).toContain("migrations | Tree fingerprint | `migration-fingerprint`");
    expect(expected).toContain("| database writers | Total | 7 |");
    expect(expected).toContain("| database writers | Inserts | 3 |");
    expect(expected).toContain("| database writers | Updates | 2 |");
    expect(expected).toContain("| database writers | Deletes | 2 |");
    expect(expected).toContain("| database writers | Unresolved SQL | 1 |");
    expect(expected).toContain("| database writers | Raw SQL | 1 |");
    expect(expected).toContain(
      "| database writers | Fingerprint | `database-writer-fingerprint` |",
    );
    expect(expected).toContain("| database writers | Audit errors | 0 |");
    expect(expected).toContain("## Verification categories");
    expect(expected).toContain("| activation | pass | 0 |");
    expect(expected).toContain("## Source alarm debt");
    expect(expected).toContain(
      "`debt.source-alarm.file.filesystem_write.0123456789abcdef`",
    );
    expect(expected).toContain("| file |");
    expect(expected).toContain(
      "`packages/example/src/write.ts#filesystem_write:0123456789abcdef:1`",
    );
    expect(expected.endsWith("\n")).toBe(true);
  });

  test("reports invalid, duplicate, unknown, and stale state", () => {
    const report = formatCoverageReport({
      ...input,
      observed: [
        ...input.observed,
        { id: "wire.new.payload", surface: "wire", locator: "new.payload" },
      ],
      registry: {
        ...input.registry,
        entries: [input.registry.entries[0], input.registry.entries[0]],
        debt: [{
          ...input.registry.debt[0],
          id: "debt.wire.new.payload",
          surface: "wire",
          locator: "new.payload",
        }],
      },
      verificationCategories: [
        ...input.verificationCategories,
        {
          category: "fixture",
          errors: ["a scanner-specific verification error"],
        },
      ],
    });

    expect(report).toContain("duplicate registry id: db.capabilities.slug");
    expect(report).toContain("`wire:new.payload`");
    expect(report).toContain("`db:session_messages.content`");
    expect(report).toContain("## Unfrozen baseline debt");
    expect(report).toContain("`debt.wire.new.payload:wire:new.payload`");
    expect(report).toContain("| fixture | fail | 1 |");
    expect(report).toContain("a scanner-specific verification error");
  });

  test("renders exact bounded exception scope when an exception exists", () => {
    const report = formatCoverageReport({
      ...input,
      registry: {
        ...input.registry,
        exceptions: [{
          id: "exception.db.example",
          owner: "packages/example",
          scope: ["db:example.secret", "wire:example.secret"],
          reason: "A bounded compatibility exception pending removal.",
          compensatingControls: [
            "The exact paths are denied to untrusted callers.",
          ],
          testEvidence: [
            "packages/encryption-invariants/tests/unit/report.test.ts",
          ],
          reviewBy: "2026-08-15",
          releaseImpact: "blocks_enabled_scope",
        }],
      },
    });

    expect(report).toContain(
      "| `exception.db.example` | packages/example | `db:example.secret`<br>`wire:example.secret` | 2026-08-15 | blocks_enabled_scope |",
    );
  });

  test("renders reviewed debt links with their frozen target impact", () => {
    const report = formatCoverageReport({
      ...input,
      registry: {
        ...input.registry,
        reviewedDebtLinks: [{
          id: "debt-link.db.session-messages.preview",
          surface: "db",
          locator: "session_messages.preview",
          owner: "packages/runtime",
          targetDebtIds: ["debt.db.session_messages.content"],
          reason:
            "This derived preview is another representation of the same frozen content.",
          testEvidence: [
            "packages/encryption-invariants/tests/unit/report.test.ts",
          ],
        }],
      },
      observed: [
        ...input.observed,
        {
          id: "db.session_messages.preview",
          surface: "db",
          locator: "session_messages.preview",
        },
      ],
    });

    expect(report).toContain("## Reviewed existing-debt links");
    expect(report).toContain(
      "| `debt-link.db.session-messages.preview` | db | `session_messages.preview` | `debt.db.session_messages.content` | blocks_enabled_scope |",
    );
  });

  test("separates retired frozen debt from active counts and release-blocking debt", () => {
    const report = formatCoverageReport({
      ...input,
      registry: {
        ...input.registry,
        retiredFrozenDebt: [{
          debtId: "debt.db.session_messages.content",
          reason: "The owning product surface and observation were deleted.",
          testEvidence: [
            "packages/encryption-invariants/tests/unit/report.test.ts",
          ],
        }],
      },
    });

    expect(report).toContain("| db | 2 | 1 | 0 | 0 |");
    const activeDebt = report.slice(
      report.indexOf("## Baseline debt"),
      report.indexOf("## Retired frozen debt"),
    );
    expect(activeDebt).not.toContain("debt.db.session_messages.content");
    expect(report).toContain("## Retired frozen debt");
    expect(report).toContain(
      "| `debt.db.session_messages.content` | db | `session_messages.content` | packages/runtime | The owning product surface and observation were deleted. | `packages/encryption-invariants/tests/unit/report.test.ts` |",
    );
  });

  test("marks a reviewed debt link with a missing target as invalid", () => {
    const report = formatCoverageReport({
      ...input,
      registry: {
        ...input.registry,
        reviewedDebtLinks: [{
          id: "debt-link.db.session-messages.preview",
          surface: "db",
          locator: "session_messages.preview",
          owner: "packages/runtime",
          targetDebtIds: ["debt.db.missing.content"],
          reason:
            "This derived preview claims a frozen target which is no longer present.",
          testEvidence: [
            "packages/encryption-invariants/tests/unit/report.test.ts",
          ],
        }],
      },
    });

    expect(report).toContain(
      "| `debt-link.db.session-messages.preview` | db | `session_messages.preview` | `debt.db.missing.content` | invalid target |",
    );
  });

  test("renders explicit empty rows for an empty registry and verification set", () => {
    const report = formatCoverageReport({
      ...input,
      registry: {
        entries: [],
        debt: [],
        exceptions: [],
      },
      sourceAlarmDebt: [],
      verificationCategories: [],
    });

    expect(report).toContain("| — | pass | 0 |");
    expect(report).toContain("| — | — | — | — | — | — | — |");
    expect(report).toContain("| — | — | — | — | — | — |");
  });

  test("sorts every multi-row report section and escapes cell data", () => {
    const secondEntry = {
      ...input.registry.entries[0],
      id: "db.capabilities.label",
      locator: "capabilities.label",
      owner: "packages/db|catalogue",
      plaintextReason: "Static public catalogue label.",
    } as const;
    const secondDebt = {
      ...input.registry.debt[0],
      id: "debt.db.session_messages.summary",
      locator: "session_messages.summary",
      reason: "The exact summary bridge is not implemented.",
      evidenceGap: "No summary ciphertext evidence exists.",
    } as const;
    const firstException = {
      id: "exception.z-last",
      owner: "packages/z",
      scope: ["wire:z"],
      reason: "A bounded compatibility exception pending removal.",
      compensatingControls: ["The exact path is denied to untrusted callers."],
      testEvidence: ["packages/encryption-invariants/tests/unit/report.test.ts"],
      reviewBy: "2026-08-15",
      releaseImpact: "blocks_enabled_scope",
    } as const;
    const secondException = {
      ...firstException,
      id: "exception.a-first",
      owner: "packages/a",
      scope: ["wire:a"],
    } as const;
    const secondAlarm = {
      ...input.sourceAlarmDebt[0],
      debtId: "debt.source-alarm.file.filesystem_write.aaaaaaaaaaaaaaaa",
      locator: "packages/a/src/write.ts#filesystem_write:0123456789abcdef:1",
      owner: "packages/a",
    } as const;
    const lastReviewedLink = {
      id: "debt-link.db.session-messages.z-preview",
      surface: "db",
      locator: "session_messages.z_preview",
      owner: "packages/runtime",
      targetDebtIds: ["debt.db.session_messages.content"],
      reason: "This derived preview is another representation of the same frozen content.",
      testEvidence: ["packages/encryption-invariants/tests/unit/report.test.ts"],
    } as const;
    const firstReviewedLink = {
      ...lastReviewedLink,
      id: "debt-link.db.session-messages.a-preview",
      locator: "session_messages.a_preview",
    } as const;
    const report = formatCoverageReport({
      ...input,
      registry: {
        entries: [secondEntry, input.registry.entries[0]],
        debt: [secondDebt, input.registry.debt[0]],
        reviewedDebtLinks: [lastReviewedLink, firstReviewedLink],
        exceptions: [firstException, secondException],
      },
      sourceAlarmDebt: [input.sourceAlarmDebt[0], secondAlarm],
      verificationCategories: [
        { category: "z-last", errors: ["z-error", "a-error"] },
        { category: "a-first", errors: [] },
      ],
    });

    expect(report.indexOf("`db.capabilities.label`")).toBeLessThan(
      report.indexOf("`db.capabilities.slug`"),
    );
    expect(report.indexOf("`debt.db.session_messages.content`")).toBeLessThan(
      report.indexOf("`debt.db.session_messages.summary`"),
    );
    expect(report.indexOf("`debt-link.db.session-messages.a-preview`")).toBeLessThan(
      report.indexOf("`debt-link.db.session-messages.z-preview`"),
    );
    expect(report.indexOf("`exception.a-first`")).toBeLessThan(
      report.indexOf("`exception.z-last`"),
    );
    expect(report.indexOf(secondAlarm.locator)).toBeLessThan(
      report.indexOf(input.sourceAlarmDebt[0].locator),
    );
    expect(report).toContain("packages/db\\|catalogue");
    expect(report.indexOf("z-last: a-error")).toBeLessThan(
      report.indexOf("z-last: z-error"),
    );
  });

  test("check mode rejects byte drift and absolute path leakage", () => {
    const generated = formatCoverageReport(input);
    expect(verifyCoverageReport(generated, input)).toEqual({ ok: true });
    expect(verifyCoverageReport(`${generated}drift\n`, input)).toEqual({
      ok: false,
      errors: ["generated encryption coverage report is stale"],
    });

    expect(verifyCoverageReport(generated.replace(
      "packages/runtime",
      "/Users/alice/private/runtime",
    ), input)).toEqual({
      ok: false,
      errors: [
        "generated encryption coverage report contains an absolute local path",
        "generated encryption coverage report is stale",
      ],
    });
  });
});
