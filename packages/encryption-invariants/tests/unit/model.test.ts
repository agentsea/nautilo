import { describe, expect, test } from "bun:test";

import {
  validateBaselineDebt,
  validateCoverageEntry,
  validateCoverageException,
} from "../../src/model";

const commonEntry = {
  id: "db.session_messages.content",
  surface: "db",
  locator: "session_messages.content",
  owner: "packages/db",
  readers: ["packages/agent"],
  writers: ["packages/runtime"],
  migrationState: "not_started",
  retention: "Retained with the Room transcript.",
  testEvidence: ["packages/runtime/tests/integration/session-messages-ordering.test.ts"],
} as const;

const transientPlaintext = {
  ...commonEntry,
  id: "source.fixture.transient",
  surface: "processor",
  locator: "packages/fixture/src/processor.ts#fixedProcessor",
  classification: "authorized_plaintext",
  migrationState: "not_applicable",
  mode: "plaintext_only",
  transientOnly: true,
  modeGate: "Canonical plaintext-only fence precedes content admission.",
  recipientAuthority: "One current owner-bound recipient is verified before disclosure.",
  cleanupContract: "No extra durable body or log is created by this transient carrier.",
  noRetentionTestEvidence: ["packages/fixture/tests/unit/no-retention.test.ts"],
  releaseImpact: "blocks_whole_product_claim",
} as const;

describe("authorized transient plaintext contracts", () => {
  test("accepts an exact transient carrier without claiming encryption", () => {
    expect(validateCoverageEntry(transientPlaintext)).toEqual({ ok: true });
    expect(validateCoverageEntry({ ...transientPlaintext, surface: "wire" })).toEqual({ ok: true });
  });

  test("accepts exact HTTP boundaries only with source and transient-disclosure evidence", () => {
    const entry = { ...transientPlaintext, surface: "wire", locator: "http:request_response:POST /api/fixture/:id/messages",
      writers: ["packages/fixture/src/routes.ts"] };
    expect(validateCoverageEntry(entry)).toEqual({ ok: true });
    for (const locator of ["http:request_response:/api/fixture", "http:request_response:POST /api/*",
      "http:request_response:POST /api/../fixture", "http:request_response:POST /api/%2e%2e/fixture",
      "http:request_response:POST /api/fixture?wildcard=true", "http:request_response:POST https://example.test/api/fixture"]) {
      expect(validateCoverageEntry({ ...entry, locator }).ok).toBe(false);
    }
    for (const writers of [[], ["packages/fixture"], ["../routes.ts"], ["packages/fixture/*.ts"]]) {
      expect(validateCoverageEntry({ ...entry, writers }).ok).toBe(false);
    }
    expect(validateCoverageEntry({ ...entry, noRetentionTestEvidence: [] }).ok).toBe(false);
    expect(validateCoverageEntry({ ...entry, surface: "processor" }).ok).toBe(false);
    expect(validateCoverageEntry({ ...entry, mode: "full" }).ok).toBe(false);
  });

  test.each([undefined, "shadow_encryption", "full", "all"])("rejects missing or wider mode %s", mode => {
    expect(validateCoverageEntry({ ...transientPlaintext, mode }).ok).toBe(false);
  });

  test.each(["db", "file", "cache", "log", "notification", "backup", "export"])("cannot classify durable or unrelated %s surfaces", surface => {
    expect(validateCoverageEntry({ ...transientPlaintext, surface }).ok).toBe(false);
  });

  test.each([
    { recipientAuthority: undefined }, { recipientAuthority: "anyone" },
    { modeGate: undefined }, { modeGate: "allowed" },
    { cleanupContract: undefined }, { cleanupContract: "retained" },
    { noRetentionTestEvidence: undefined }, { noRetentionTestEvidence: [] },
    { noRetentionTestEvidence: ["future:evidence"] },
    { noRetentionTestEvidence: ["../outside.test.ts"] },
    { transientOnly: undefined }, { transientOnly: false },
    { releaseImpact: undefined }, { releaseImpact: "blocks_enabled_scope" },
    { migrationState: "verified" }, { migrationState: "ciphertext_only" },
    { locator: "packages/fixture/*#fixedProcessor" },
    { locator: "packages/fixture/src/processor.ts#*" },
    { locator: "packages/fixture/src/processor.ts" },
    { locator: "../fixture.ts#processor" },
  ])("rejects incomplete or blanket review %#", change => {
    expect(validateCoverageEntry({ ...transientPlaintext, ...change }).ok).toBe(false);
  });
});

describe("coverage model validation", () => {
  test("accepts each precise classification contract", () => {
    expect(validateCoverageEntry({
      ...commonEntry,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: "packages/lattice-bridge/src/repositories/messages.ts",
      negativeTestEvidence: ["packages/encryption-invariants/tests/integration/snapshot-leak.test.ts"],
    })).toEqual({ ok: true });

    expect(validateCoverageEntry({
      ...commonEntry,
      id: "wire.human-message-edit.protected",
      surface: "wire",
      locator: "http:request_response:PATCH /api/rooms/:roomId/messages/:messageId/protected",
      classification: "protected",
      keyFamily: "namespace_ai_or_human",
      bridgeRepository: "packages/lattice-bridge/src/client/message/vault-human-message-edit.ts",
      negativeTestEvidence: ["packages/lattice-bridge/tests/unit/human-ai-readable-live-shadow-message.test.ts"],
    })).toEqual({ ok: true });

    expect(validateCoverageEntry({
      ...commonEntry,
      id: "db.sessions.created_at",
      locator: "sessions.created_at",
      classification: "bounded_metadata",
      metadataAllowlist: ["created_at"],
      plaintextReason: "Required for stable transcript ordering.",
      migrationState: "not_applicable",
    })).toEqual({ ok: true });

    expect(validateCoverageEntry({
      ...commonEntry,
      id: "db.capabilities.slug",
      locator: "capabilities.slug",
      classification: "public",
      plaintextReason: "Static public authorization catalogue identifier.",
      migrationState: "not_applicable",
    })).toEqual({ ok: true });

    expect(validateCoverageEntry({
      ...commonEntry,
      id: "file.instance_env",
      surface: "file",
      locator: "~/.nautilo/instance.env",
      classification: "operator_secret",
      secretStoreLocation: "mode-0600 instance root",
      backupProcedure: "Restricted encrypted operator backup.",
      excludedFromAgentGrants: true,
      migrationState: "not_applicable",
    })).toEqual({ ok: true });

    expect(validateCoverageEntry({
      ...commonEntry,
      id: "file.current_folder",
      surface: "file",
      locator: "relay:current-folder",
      classification: "device_local",
      deviceStorage: "Human-selected local filesystem root.",
      cleanupContract: "Nautilo retains no server-side copy.",
      migrationState: "not_applicable",
    })).toEqual({ ok: true });
  });

  test("rejects protected entries without implemented bridge and negative evidence", () => {
    const result = validateCoverageEntry({
      ...commonEntry,
      classification: "protected",
      keyFamily: "namespace_ai",
      bridgeRepository: "future:messages",
      negativeTestEvidence: [],
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "bridgeRepository must be a concrete repository path",
        "negativeTestEvidence must contain at least one executable test path",
      ],
    });
  });

  test("rejects blanket JSON and wildcard locators", () => {
    const result = validateCoverageEntry({
      ...commonEntry,
      classification: "bounded_metadata",
      locator: "tasks.metadata.*",
      metadataAllowlist: ["*"],
      plaintextReason: "metadata",
      migrationState: "not_applicable",
    });
    expect(result).toEqual({
      ok: false,
      errors: [
        "locator must not end in an unbounded wildcard",
        "metadataAllowlist must contain exact field names",
        "plaintextReason must be descriptive",
      ],
    });
  });

  test("requires complete, release-impacting baseline debt", () => {
    expect(validateBaselineDebt({
      id: "debt.db.session_messages.content",
      surface: "db",
      locator: "session_messages.content",
      owner: "packages/runtime",
      reason: "The Wave 3 bridge repository does not exist yet.",
      remediationState: "planned",
      releaseImpact: "blocks_enabled_scope",
      evidenceGap: "No ciphertext writer or snapshot-negative test exists.",
    })).toEqual({ ok: true });

    expect(validateBaselineDebt({
      id: "",
      surface: "db",
      locator: "",
      owner: "",
      reason: "",
      remediationState: "unknown",
      releaseImpact: "none",
      evidenceGap: "",
    })).toEqual({
      ok: false,
      errors: [
        "id must be a stable dotted identifier",
        "locator must be non-empty",
        "owner must be non-empty",
        "reason must be descriptive",
        "remediationState is invalid",
        "releaseImpact is invalid",
        "evidenceGap must be descriptive",
      ],
    });
  });

  test("requires bounded, expiring exceptions with compensating evidence", () => {
    expect(validateCoverageException({
      id: "exception.processor.example",
      owner: "packages/server",
      scope: ["processor.example"],
      reason: "The external sandbox cannot yet attest deletion.",
      compensatingControls: ["Output is never persisted outside ciphertext fixtures."],
      testEvidence: ["packages/server/tests/integration/processor-cleanup.test.ts"],
      reviewBy: "2026-10-01",
      releaseImpact: "blocks_whole_product_claim",
    })).toEqual({ ok: true });

    expect(validateCoverageException({
      id: "exception.bad",
      owner: "",
      scope: [],
      reason: "later",
      compensatingControls: [],
      testEvidence: [],
      reviewBy: "never",
      releaseImpact: "none",
    })).toEqual({
      ok: false,
      errors: [
        "owner must be non-empty",
        "scope must contain at least one exact locator",
        "reason must be descriptive",
        "compensatingControls must not be empty",
        "testEvidence must contain at least one executable test path",
        "reviewBy must be an ISO calendar date",
        "releaseImpact is invalid",
      ],
    });
  });
});
