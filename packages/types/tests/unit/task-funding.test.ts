import { describe, expect, test } from "bun:test";

import {
  parseTaskFundingBinding,
  taskFundingFailureMessage,
  type TaskFundingFailureCode,
} from "../../src/task-funding";

describe("Task funding binding", () => {
  test("parses the exact non-secret server and personal shapes", () => {
    expect(parseTaskFundingBinding({
      kind: "server",
      providerRoute: "openrouter",
    })).toEqual({ kind: "server", providerRoute: "openrouter" });

    expect(parseTaskFundingBinding({
      kind: "personal",
      providerRoute: "openai",
      credentialId: "10000000-0000-4000-8000-000000000001",
      credentialRevision: 3,
    })).toEqual({
      kind: "personal",
      providerRoute: "openai",
      credentialId: "10000000-0000-4000-8000-000000000001",
      credentialRevision: 3,
    });
  });

  test("rejects legacy null, widened objects, and malformed authority facts", () => {
    for (const value of [
      null,
      { kind: "server", providerRoute: "OpenAI" },
      { kind: "server", providerRoute: "openai", credentialId: "secret" },
      {
        kind: "personal",
        providerRoute: "openai",
        credentialId: "not-a-uuid",
        credentialRevision: 1,
      },
      {
        kind: "personal",
        providerRoute: "openai",
        credentialId: "10000000-0000-4000-8000-000000000001",
        credentialRevision: 0,
      },
      {
        kind: "personal",
        providerRoute: "openai",
        credentialId: "10000000-0000-4000-8000-000000000001",
        credentialRevision: 1.5,
      },
    ]) {
      expect(() => parseTaskFundingBinding(value)).toThrow(TypeError);
    }
  });

  test("provides safe user-facing text for every typed failure code", () => {
    const codes: readonly TaskFundingFailureCode[] = [
      "personal_credentials_disabled",
      "personal_credentials_forbidden",
      "personal_credential_missing",
      "server_credentials_forbidden",
      "provider_credentials_missing",
      "personal_credential_stale",
      "personal_credential_unavailable",
      "personal_provider_unavailable",
      "funding_source_changed",
      "unsupported_workload",
      "unsupported_provider",
      "funding_interrupted_uncertain",
    ];
    for (const code of codes) {
      expect(taskFundingFailureMessage(code)).not.toContain("credentialId");
      expect(taskFundingFailureMessage(code).length).toBeGreaterThan(0);
    }
  });
});
