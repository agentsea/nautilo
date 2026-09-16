import { describe, expect, test } from "bun:test";
import {
  parseConnectedWebProviderOutcome,
  parseConnectedWebTerminalReadResult,
} from "../../src/connected-web-accounts/read-result-contract";

const origin = "https://example.com";

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    account: { id: "account-id", label: "Example", service: "example", origin },
    page: { ref: "account-id", title: "Example", origin },
    read: null,
    cost: { currency: "USD", amountUsd: 0, state: "actual" },
    outputs: [],
    outputsTruncated: false,
    ...overrides,
  };
}

describe("D568 terminal read result contract", () => {
  test("preserves the shared strict provider answer and fact bounds", () => {
    expect(parseConnectedWebProviderOutcome(JSON.stringify({ answer: "answer", facts: [{ label: "fact", value: "value" }], completeness: "complete", provenance: "authenticated_website", origin }), origin)?.kind).toBe("read");
    expect(parseConnectedWebProviderOutcome(JSON.stringify({ answer: "a".repeat(8_001), facts: [], completeness: "complete", provenance: "authenticated_website", origin }), origin)).toBeNull();
    expect(parseConnectedWebProviderOutcome(JSON.stringify({ answer: "answer", facts: [{ label: "fact", value: "v".repeat(1_025) }], completeness: "complete", provenance: "authenticated_website", origin }), origin)).toBeNull();
  });

  test("fails closed on overlong durable account labels and services", () => {
    expect(parseConnectedWebTerminalReadResult(snapshot({ account: { id: "account-id", label: "l".repeat(257), service: "example", origin } }))).toBeNull();
    expect(parseConnectedWebTerminalReadResult(snapshot({ account: { id: "account-id", label: "Example", service: "s".repeat(129), origin } }))).toBeNull();
  });
});


test("public authentication templates are projected without returning the provider's extra answer", () => {
  const checkpoint = { outcome: "authentication_required", reason: "sign_in", answer: "untrusted extra answer", facts: [], completeness: "unknown", provenance: "public_website", origin };
  expect(parseConnectedWebProviderOutcome(JSON.stringify(checkpoint), origin)).toEqual({ kind: "authentication_required", reason: "sign_in" });
  expect(parseConnectedWebProviderOutcome(JSON.stringify({ ...checkpoint, origin: "https://other.test" }), origin)).toBeNull();
  expect(parseConnectedWebProviderOutcome(JSON.stringify({ ...checkpoint, reason: "invented" }), origin)).toBeNull();
  expect(parseConnectedWebProviderOutcome(JSON.stringify({ ...checkpoint, providerUrl: "secret" }), origin)).toBeNull();
});
