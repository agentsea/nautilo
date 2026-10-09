import { expect, test } from "bun:test";
import {
  connectedWebAccountCreateRequestSchema,
  connectedWebAccountSchema,
  connectedWebOperationTerminalReadResultSchema,
} from "../../src/connected-web-accounts";

const account = {
  id: "11111111-1111-4111-8111-111111111111",
  service: "Example",
  origin: "https://example.test",
  label: "Example work account",
  status: "connected",
  lastVerifiedAt: "2026-09-01T12:00:00.000Z",
  createdAt: "2026-09-01T11:00:00.000Z",
  updatedAt: "2026-09-01T12:00:00.000Z",
} as const;

test("Connected Web Account public contract excludes server-only browser capability coordinates", () => {
  expect(connectedWebAccountSchema.safeParse(account).success).toBe(true);
  for (const forbidden of ["profileRef", "browserId", "runId", "liveViewUrl", "cdpUrl", "executionCheckpoint"]) {
    expect(connectedWebAccountSchema.safeParse({ ...account, [forbidden]: "opaque-provider-value" }).success).toBe(false);
  }
});

test("connected website workspace results expose only owned artifact receipts", () => {
  const result = {
    ok: true as const,
    status: "completed" as const,
    account: { id: account.id, label: account.label, service: account.service, origin: account.origin },
    page: { ref: account.id, title: account.label, origin: account.origin },
    read: null,
    cost: { currency: "USD" as const, amountUsd: 0.01, state: "actual" as const },
    outputs: [{ artifactId: "artifact-1", path: "downloads/report.pdf", mime: "application/pdf", bytes: 42 }],
    outputsTruncated: false,
  };
  expect(connectedWebOperationTerminalReadResultSchema.safeParse(result).success).toBe(true);
  expect(connectedWebOperationTerminalReadResultSchema.safeParse({
    ...result,
    outputs: [{ ...result.outputs[0], path: "https://provider.example/private" }],
  }).success).toBe(false);
  expect(connectedWebOperationTerminalReadResultSchema.safeParse({
    ...result,
    account: null,
  }).success).toBe(false);
});

test("Connected Web Account creation carries only safe site metadata", () => {
  expect(connectedWebAccountCreateRequestSchema.safeParse({
    service: "Example",
    origin: "https://example.test",
    label: "Example work account",
  }).success).toBe(true);
  expect(connectedWebAccountCreateRequestSchema.safeParse({
    service: "Example",
    origin: "https://example.test",
    label: "Example work account",
    profileRef: "provider-profile",
  }).success).toBe(false);
});
