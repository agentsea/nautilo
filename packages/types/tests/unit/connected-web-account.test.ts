import { expect, test } from "bun:test";
import {
  connectedWebAccountCreateRequestSchema,
  connectedWebAccountSchema,
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
