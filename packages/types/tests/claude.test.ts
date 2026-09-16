import { expect, test } from "bun:test";
import { claudeConnectionAccountSchema, claudeConnectionSummarySchema } from "../src/claude";

const fresh = {
  enabled: true,
  selectedModel: "claude-fable-5",
  selectedModelAdmitted: true,
  runtime: { state: "ready", version: "2.1.235", executionQualified: true },
  account: { state: "connected", email: "writer@example.test" },
  catalog: { state: "complete", complete: true, models: [{ id: "fable", resolvedModel: "claude-fable-5", displayName: "Fable", description: "Frontier" }] },
  connectionState: "connected",
  observedAt: "2026-08-20T12:00:00.000Z",
  observationStale: false,
} as const;

test("Claude Connections summary rejects invented connected/admitted truth", () => {
  expect(claudeConnectionSummarySchema.safeParse(fresh).success).toBe(true);
  expect(claudeConnectionSummarySchema.safeParse({ ...fresh, observationStale: true }).success).toBe(false);
  expect(claudeConnectionSummarySchema.safeParse({ ...fresh, enabled: false }).success).toBe(false);
  expect(claudeConnectionSummarySchema.safeParse({ ...fresh, selectedModel: null }).success).toBe(false);
});

test("a retained Claude model is valid but not admitted when discovery is stale", () => {
  expect(claudeConnectionSummarySchema.safeParse({
    ...fresh,
    selectedModelAdmitted: false,
    connectionState: "unavailable",
    observationStale: true,
  }).success).toBe(true);
});

test("Genie may be disabled while fresh account and model truth remain available", () => {
  expect(claudeConnectionSummarySchema.safeParse({ ...fresh, enabled: false, connectionState: "disabled" }).success).toBe(true);
});

test("an unreviewed runtime retains fresh account and model setup without claiming execution admission", () => {
  expect(claudeConnectionSummarySchema.safeParse({
    ...fresh,
    runtime: { state: "ready", version: "2.1.39", executionQualified: false },
    selectedModelAdmitted: false,
    connectionState: "unavailable",
  }).success).toBe(true);
  expect(claudeConnectionSummarySchema.safeParse({
    ...fresh,
    runtime: { state: "ready", version: "2.1.39", executionQualified: false },
  }).success).toBe(false);
});

test("credential provenance is a presence-only browser-safe fact", () => {
  expect(claudeConnectionAccountSchema.safeParse({ state: "connected", credentialsAvailable: true }).success).toBe(true);
  expect(claudeConnectionAccountSchema.safeParse({ state: "connected", credentialsAvailable: false }).success).toBe(false);
  expect(claudeConnectionAccountSchema.safeParse({ state: "connected", tokenSource: "a private helper path" }).success).toBe(false);
});
