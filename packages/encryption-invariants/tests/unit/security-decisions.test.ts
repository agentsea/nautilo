import { describe, expect, test } from "bun:test";

import { parseWave0Activation } from "../../src/activation";
import {
  validateBaselineDebt,
  validateCoverageEntry,
  validateCoverageException,
} from "../../src/model";
import { auditCoverageRegistry } from "../../src/registry";

const common = {
  id: "db.example.payload",
  surface: "db",
  locator: "example.payload",
  owner: "security-platform",
  readers: ["packages/server/src/example.ts"],
  writers: ["packages/server/src/example.ts"],
  migrationState: "not_started",
  retention: "Retained for the owning entity lifetime.",
  testEvidence: ["packages/encryption-invariants/tests/unit/security-decisions.test.ts"],
} as const;

const publicEntry = {
  ...common,
  classification: "public",
  plaintextReason: "This fixture is deliberately public test catalogue data.",
} as const;

const validDebt = {
  id: "debt.db.example.secret",
  surface: "db",
  locator: "example.secret",
  owner: "security-platform",
  reason: "The encryption bridge for this surface is not implemented.",
  remediationState: "planned",
  releaseImpact: "blocks_enabled_scope",
  evidenceGap: "Ciphertext write and negative snapshot evidence is absent.",
} as const;

const validException = {
  id: "exception.processor.example",
  owner: "security-platform",
  scope: ["processor.example.input"],
  reason: "The external processor cannot attest remote deletion yet.",
  compensatingControls: ["The processor is disabled in supported production profiles."],
  testEvidence: ["packages/encryption-invariants/tests/unit/security-decisions.test.ts"],
  reviewBy: "2026-10-01",
  releaseImpact: "blocks_whole_product_claim",
} as const;

function onlyError(result: ReturnType<typeof validateCoverageEntry>, error: string): void {
  expect(result).toEqual({ ok: false, errors: [error] });
}

describe("coverage entry security decisions", () => {
  test.each([[null], [[]], ["entry"], [4], [true]])("rejects non-object entry %p", (value) => {
    onlyError(validateCoverageEntry(value), "coverage entry must be an object");
  });

  test.each([
    ["id", "invalid", "id must be a stable dotted identifier"],
    ["id", "UPPER.case", "id must be a stable dotted identifier"],
    ["surface", "unknown", "surface is invalid"],
    ["locator", " ", "locator must be non-empty"],
    ["locator", 42, "locator must be non-empty"],
    ["locator", "example.*", "locator must not end in an unbounded wildcard"],
    ["owner", "", "owner must be non-empty"],
    ["readers", "not-array", "readers must be a string array"],
    ["readers", ["ok", ""], "readers must be a string array"],
    ["writers", "not-array", "writers must be a string array"],
    ["writers", ["ok", " "], "writers must be a string array"],
    ["migrationState", "complete", "migrationState is invalid"],
    ["retention", "short", "retention must be descriptive"],
    ["retention", "12345678901", "retention must be descriptive"],
    ["retention", 42, "retention must be descriptive"],
    ["retention", "           x", "retention must be descriptive"],
    ["testEvidence", [], "testEvidence must contain at least one executable test path"],
    ["testEvidence", ["test.ts"], "testEvidence must contain at least one executable test path"],
    ["testEvidence", ["x.test.ts.bak"], "testEvidence must contain at least one executable test path"],
    ["testEvidence", ["good.test.ts", "bad.md"], "testEvidence must contain at least one executable test path"],
  ])("rejects invalid common field %s", (field, value, error) => {
    onlyError(validateCoverageEntry({ ...publicEntry, [field]: value }), error);
  });

  test("accepts every supported executable test suffix", () => {
    for (const suffix of ["ts", "tsx", "js", "jsx"]) {
      expect(validateCoverageEntry({
        ...publicEntry,
        testEvidence: [`a.test.${suffix}`],
      })).toEqual({ ok: true });
    }
  });

  test("accepts the exact descriptive-length boundary after trimming", () => {
    expect(validateCoverageEntry({
      ...publicEntry,
      retention: " 123456789012 ",
    })).toEqual({ ok: true });
  });

  test.each([
    ["keyFamily", "nope", "keyFamily is invalid"],
    ["bridgeRepository", "", "bridgeRepository must be a concrete repository path"],
    ["bridgeRepository", "future:messages", "bridgeRepository must be a concrete repository path"],
    ["bridgeRepository", "future:/messages", "bridgeRepository must be a concrete repository path"],
    ["bridgeRepository", 42, "bridgeRepository must be a concrete repository path"],
    ["bridgeRepository", "messages.ts", "bridgeRepository must be a concrete repository path"],
    ["negativeTestEvidence", [], "negativeTestEvidence must contain at least one executable test path"],
    ["negativeTestEvidence", ["negative.txt"], "negativeTestEvidence must contain at least one executable test path"],
  ])("rejects invalid protected field %s", (field, value, error) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: "packages/bridge/messages.ts",
      negativeTestEvidence: ["packages/bridge/messages-negative.test.ts"],
      [field]: value,
    }), error);
  });

  test.each([
    ["/packages/bridge/messages.ts"],
    ["../packages/bridge/messages.ts"],
    ["packages/bridge/../messages.ts"],
    ["packages\\bridge\\messages.ts"],
  ])("rejects non-repository-relative bridge path %s", (bridgeRepository) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository,
      negativeTestEvidence: ["packages/bridge/messages-negative.test.ts"],
    }), "bridgeRepository must be a concrete repository path");
  });

  test.each([
    ["/packages/bridge/messages.test.ts"],
    ["../packages/bridge/messages.test.ts"],
    ["packages/bridge/../messages.test.ts"],
    ["packages\\bridge\\messages.test.ts"],
  ])("rejects non-repository-relative test evidence %s", (testEvidence) => {
    onlyError(validateCoverageEntry({
      ...publicEntry,
      testEvidence: [testEvidence],
    }), "testEvidence must contain at least one executable test path");
  });

  test("does not reject a concrete path merely because it ends in future:", () => {
    expect(validateCoverageEntry({
      ...common,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: "packages/bridge/future:",
      negativeTestEvidence: ["packages/bridge/messages-negative.test.ts"],
    })).toEqual({ ok: true });
  });

  test.each([
    [" packages/bridge/messages.ts", "leading whitespace"],
    ["packages/bridge/messages.ts ", "trailing whitespace"],
    ["/packages/bridge/messages.ts", "absolute POSIX path"],
    ["C:/packages/bridge/messages.ts", "absolute Windows drive path"],
    ["packages\\bridge\\messages.ts", "Windows separators"],
    ["packages//bridge/messages.ts", "empty path segment"],
    ["packages/./bridge/messages.ts", "dot path segment"],
    ["packages/../bridge/messages.ts", "parent path segment"],
  ])("rejects protected bridge repository with %s (%s)", (bridgeRepository) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository,
      negativeTestEvidence: ["packages/bridge/messages-negative.test.ts"],
    }), "bridgeRepository must be a concrete repository path");
  });

  test("does not treat an embedded drive-like segment as an absolute path", () => {
    expect(validateCoverageEntry({
      ...common,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: "packages/C:/bridge/messages.ts",
      negativeTestEvidence: ["packages/bridge/messages-negative.test.ts"],
    })).toEqual({ ok: true });
  });

  test.each([
    [undefined],
    [[]],
    [["*"]],
    [["metadata.*"]],
    [[" metadata"]],
    [["exact", "*"]],
  ])("rejects imprecise bounded metadata allowlist %p", (metadataAllowlist) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "bounded_metadata",
      metadataAllowlist,
      plaintextReason: "Exact ordering metadata remains intentionally visible.",
    }), "metadataAllowlist must contain exact field names");
  });

  test.each([
    {
      ...common,
      classification: "bounded_metadata",
      metadataAllowlist: ["created_at"],
      plaintextReason: "short",
    },
    {
      ...common,
      classification: "public",
      plaintextReason: "short",
    },
  ])("requires a descriptive plaintext rationale", (entry) => {
    onlyError(validateCoverageEntry(entry), "plaintextReason must be descriptive");
  });

  test.each([
    ["secretStoreLocation", "short", "secretStoreLocation must be descriptive"],
    ["backupProcedure", "short", "backupProcedure must be descriptive"],
    ["excludedFromAgentGrants", false, "operator secrets must be excluded from Agent grants"],
  ])("rejects invalid operator-secret field %s", (field, value, error) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "operator_secret",
      secretStoreLocation: "Mode 0600 operator-owned instance storage.",
      backupProcedure: "Restricted encrypted operator backup procedure.",
      excludedFromAgentGrants: true,
      [field]: value,
    }), error);
  });

  test.each([
    ["deviceStorage", "short", "deviceStorage must be descriptive"],
    ["cleanupContract", "short", "cleanupContract must be descriptive"],
  ])("rejects invalid device-local field %s", (field, value, error) => {
    onlyError(validateCoverageEntry({
      ...common,
      classification: "device_local",
      deviceStorage: "Human-selected local filesystem storage.",
      cleanupContract: "Removed when the local account signs out.",
      [field]: value,
    }), error);
  });

  test("rejects an unknown classification", () => {
    onlyError(
      validateCoverageEntry({ ...common, classification: "unknown" }),
      "classification is invalid",
    );
  });
});

describe("baseline debt security decisions", () => {
  test.each([[null], [[]], ["debt"], [4], [true]])("rejects non-object debt %p", (value) => {
    expect(validateBaselineDebt(value)).toEqual({
      ok: false,
      errors: ["baseline debt must be an object"],
    });
  });

  test.each([
    ["id", "invalid", "id must be a stable dotted identifier"],
    ["id", 42, "id must be a stable dotted identifier"],
    ["id", { toString: () => "valid.id" }, "id must be a stable dotted identifier"],
    ["id", "!valid.id", "id must be a stable dotted identifier"],
    ["id", "valid.id!", "id must be a stable dotted identifier"],
    ["surface", "unknown", "surface is invalid"],
    ["locator", "", "locator must be non-empty"],
    ["owner", " ", "owner must be non-empty"],
    ["reason", "short", "reason must be descriptive"],
    ["remediationState", "done", "remediationState is invalid"],
    ["releaseImpact", "none", "releaseImpact is invalid"],
    ["evidenceGap", "short", "evidenceGap must be descriptive"],
  ])("rejects invalid debt field %s", (field, value, error) => {
    expect(validateBaselineDebt({ ...validDebt, [field]: value })).toEqual({
      ok: false,
      errors: [error],
    });
  });
});

describe("coverage exception security decisions", () => {
  test.each([[null], [[]], ["exception"], [4], [true]])("rejects non-object exception %p", (value) => {
    expect(validateCoverageException(value)).toEqual({
      ok: false,
      errors: ["coverage exception must be an object"],
    });
  });

  test.each([
    ["id", "invalid", "id must be a stable dotted identifier"],
    ["owner", "", "owner must be non-empty"],
    ["scope", [], "scope must contain at least one exact locator"],
    ["scope", ["*"], "scope must contain at least one exact locator"],
    ["scope", ["exact", "broad.*"], "scope must contain at least one exact locator"],
    ["scope", [" exact"], "scope must contain at least one exact locator"],
    ["reason", "short", "reason must be descriptive"],
    ["compensatingControls", [], "compensatingControls must not be empty"],
    ["compensatingControls", ["ok", ""], "compensatingControls must not be empty"],
    ["testEvidence", [], "testEvidence must contain at least one executable test path"],
    ["testEvidence", ["not-a-test.ts"], "testEvidence must contain at least one executable test path"],
    ["reviewBy", "never", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-1-1", "reviewBy must be an ISO calendar date"],
    ["reviewBy", " 2026-10-01", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-10-01T00:00:00Z", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-13-40", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "1999-12-31", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "0000-01-01", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "9999-13-01", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-02-29", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-02-30", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-00-01", "reviewBy must be an ISO calendar date"],
    ["reviewBy", "2026-01-00", "reviewBy must be an ISO calendar date"],
    ["reviewBy", 20261001, "reviewBy must be an ISO calendar date"],
    ["reviewBy", { toString: () => "2026-10-01" }, "reviewBy must be an ISO calendar date"],
    ["releaseImpact", "none", "releaseImpact is invalid"],
  ])("rejects invalid exception field %s", (field, value, error) => {
    expect(validateCoverageException({ ...validException, [field]: value })).toEqual({
      ok: false,
      errors: [error],
    });
  });

  test("rejects parseable dates unless their complete value is exact ISO calendar form", () => {
    for (const reviewBy of [
      " 2026-10-01",
      "2026-10-01 ",
      "2026-10-01T00:00:00Z",
      "2026-1-1",
    ]) {
      expect(validateCoverageException({
        ...validException,
        reviewBy,
      })).toEqual({
        ok: false,
        errors: ["reviewBy must be an ISO calendar date"],
      });
    }
  });

  test("accepts a real leap-day calendar date", () => {
    for (const reviewBy of ["2000-01-01", "2028-02-29", "9999-12-31"]) {
      expect(validateCoverageException({
        ...validException,
        reviewBy,
      })).toEqual({ ok: true });
    }
  });
});

describe("registry audit security decisions", () => {
  test("propagates entry, debt, and exception validation with stable identity", () => {
    expect(auditCoverageRegistry({
      entries: [{ ...publicEntry, owner: "" }],
      debt: [{ ...validDebt, reason: "short" }],
      exceptions: [{ ...validException, reviewBy: "never" }],
    })).toEqual({
      ok: false,
      errors: [
        "db.example.payload: owner must be non-empty",
        "debt.db.example.secret: reason must be descriptive",
        "exception.processor.example: reviewBy must be an ISO calendar date",
      ],
    });
  });

  test("accepts and counts a valid exception", () => {
    expect(auditCoverageRegistry({
      entries: [publicEntry],
      debt: [validDebt],
      exceptions: [validException],
    })).toEqual({
      ok: true,
      counts: {
        classified: 1,
        debt: 1,
        reviewedDebtLinks: 0,
        exceptions: 1,
      },
    });
  });

  test("sorts multiple duplicate and collision failures deterministically", () => {
    const secondEntry = {
      ...publicEntry,
      id: "db.alpha.value",
      locator: "alpha.value",
    } as const;
    const secondDebt = {
      ...validDebt,
      id: secondEntry.id,
      locator: secondEntry.locator,
    } as const;
    const firstCollisionDebt = {
      ...validDebt,
      id: publicEntry.id,
      locator: publicEntry.locator,
    } as const;
    const result = auditCoverageRegistry({
      entries: [
        publicEntry,
        secondEntry,
        publicEntry,
        secondEntry,
      ],
      debt: [
        validDebt,
        firstCollisionDebt,
        secondDebt,
        validDebt,
        firstCollisionDebt,
        secondDebt,
      ],
      exceptions: [],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "duplicate registry id: db.alpha.value",
        "duplicate registry id: db.example.payload",
        "duplicate registry locator: alpha.value",
        "duplicate registry locator: example.payload",
        "duplicate baseline debt id: db.alpha.value",
        "duplicate baseline debt id: db.example.payload",
        "duplicate baseline debt id: debt.db.example.secret",
        "duplicate baseline debt locator: alpha.value",
        "duplicate baseline debt locator: example.payload",
        "duplicate baseline debt locator: example.secret",
        "registry id collides with baseline debt: db.alpha.value",
        "registry id collides with baseline debt: db.example.payload",
        "registry locator collides with baseline debt: alpha.value",
        "registry locator collides with baseline debt: example.payload",
      ],
    });
  });
});

describe("activation security decisions", () => {
  test.each([["disabled"], [0], [false], [[]], [() => undefined]])(
    "rejects non-object activation input %p",
    (input) => {
      expect(parseWave0Activation(input)).toEqual({
        ok: false,
        error: "Wave 0 activation input must be an object when provided",
      });
    },
  );

  test("sorts and reports every unsupported field", () => {
    expect(parseWave0Activation({
      zeta: true,
      stage: "disabled",
      alpha: true,
    })).toEqual({
      ok: false,
      error: "Wave 0 activation input contains unsupported fields: alpha, zeta",
    });
  });
});
