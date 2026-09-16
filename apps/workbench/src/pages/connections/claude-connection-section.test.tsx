import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { claudeConnectionSummarySchema, type ClaudeConnectionSummary } from "@nautilo/types";

const getDesktopRelayId = mock(async () => "relay-current");
const summary = mock(async (): Promise<ClaudeConnectionSummary> => connectionSummary());
const toggle = mock(async (enabled: boolean): Promise<ClaudeConnectionSummary> => ({ ...connectionSummary(), enabled, connectionState: enabled ? "connected" : "disabled" }));
const checkAgain = mock(async (): Promise<ClaudeConnectionSummary> => connectionSummary());
const selectModel = mock(async (modelId: string | null): Promise<ClaudeConnectionSummary> => ({ ...connectionSummary(), selectedModel: modelId === "provider-fable" ? "claude-fable-5" : null, selectedModelAdmitted: modelId !== null }));

mock.module("../../hooks/use-auth", () => ({
  useAuth: () => ({ viewer: { sessionUserId: "owner", userIdentity: "owner" } }),
}));
mock.module("../../lib/desktop", () => ({ getDesktopRelayId }));
mock.module("../../lib/api", () => ({
  apiClient: { claudeConnections: { summary, toggle, checkAgain, selectModel } },
}));

const { ClaudeConnectionSection, claudeModelPickerEnabled, claudeSelectedProviderRowId } = await import("./claude-connection-section");

function connectionSummary(overrides: Partial<ClaudeConnectionSummary> = {}): ClaudeConnectionSummary {
  return {
    enabled: false,
    selectedModel: "claude-fable-5",
    selectedModelAdmitted: true,
    runtime: { state: "ready", version: "2.1.235", executionQualified: true },
    account: { state: "connected", email: "writer@example.test", apiProvider: "firstParty", credentialsAvailable: true },
    catalog: { state: "complete", complete: true, models: [{ id: "provider-fable", resolvedModel: "claude-fable-5", displayName: "Fable", description: "Frontier reasoning" }] },
    connectionState: "disabled",
    observedAt: "2026-08-20T12:00:00.000Z",
    observationStale: false,
    ...overrides,
  } as ClaudeConnectionSummary;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  window.localStorage.clear();
  getDesktopRelayId.mockClear();
  summary.mockClear();
  summary.mockImplementation(async () => connectionSummary());
  toggle.mockClear();
  toggle.mockImplementation(async (enabled) => ({ ...connectionSummary(), enabled, connectionState: enabled ? "connected" : "disabled" }));
  checkAgain.mockClear();
  selectModel.mockClear();
  selectModel.mockImplementation(async (modelId) => ({ ...connectionSummary(), selectedModel: modelId === "provider-fable" ? "claude-fable-5" : null, selectedModelAdmitted: modelId !== null }));
});

afterAll(() => mock.restore());

test("Claude picker uses provider row ids for canonical selected models and stays off for empty catalogs", () => {
  expect(claudeSelectedProviderRowId(connectionSummary())).toBe("provider-fable");
  expect(claudeModelPickerEnabled(connectionSummary())).toBe(true);
  expect(claudeModelPickerEnabled(connectionSummary({ catalog: { state: "complete", complete: true, models: [] } }))).toBe(false);
});

test("renders a detected Claude account and keeps model configuration independent from the Genie switch", async () => {
  const view = render(<ClaudeConnectionSection />);
  await waitFor(() => expect(view.getByText("Ready")).toBeTruthy());
  expect(view.getByText("writer@example.test · Claude · Claude Code credentials")).toBeTruthy();
  expect(view.getByText("Fable — Frontier reasoning")).toBeTruthy();
  const picker = view.getByRole("combobox", { name: "Claude Code model" }) as HTMLSelectElement;
  expect(picker.disabled).toBe(false);
  expect(picker.value).toBe("provider-fable");
  fireEvent.change(picker, { target: { value: "provider-fable" } });
  await waitFor(() => expect(selectModel).toHaveBeenCalledWith("provider-fable", "relay-current"));
  fireEvent.click(view.getByRole("switch", { name: "Enable Claude Code" }));
  await waitFor(() => expect(toggle).toHaveBeenCalledWith(true, "relay-current"));
  expect(view.queryByText(/tokenSource|apiKeySource|firstParty|pricing|cost/i)).toBeNull();
  expect(view.queryByLabelText(/email|login/i)).toBeNull();
});

test("shows account and model setup on an unqualified runtime without claiming Claude Task readiness", async () => {
  summary.mockImplementation(async () => connectionSummary({
    enabled: true,
    runtime: { state: "ready", version: "2.1.39", executionQualified: false },
    selectedModelAdmitted: false,
    connectionState: "unavailable",
  }));
  const view = render(<ClaudeConnectionSection />);
  await waitFor(() => expect(view.getByText("Account detected")).toBeTruthy());
  expect(view.getByText("Detected for account setup · Claude Code 2.1.39")).toBeTruthy();
  expect(view.getByText("writer@example.test · Claude · Claude Code credentials")).toBeTruthy();
  expect(view.getByRole("combobox", { name: "Claude Code model" })).not.toHaveProperty("disabled", true);
  expect(view.getByText(/Claude Tasks remain unavailable until this runtime is qualified/)).toBeTruthy();
  expect(view.queryByText(/^Ready$/)).toBeNull();
});

test("stale retained facts distinguish active rechecking from an unavailable desktop", async () => {
  const reconnecting = connectionSummary({ enabled: true, observationStale: true, selectedModelAdmitted: false, connectionState: "reconnecting" });
  claudeConnectionSummarySchema.parse(reconnecting);
  summary.mockImplementation(async () => reconnecting);
  const active = render(<ClaudeConnectionSection />);
  await waitFor(() => expect(active.getByText(/Current desktop truth is being rechecked/)).toBeTruthy());
  cleanup();
  const unavailableState = connectionSummary({ observationStale: true, selectedModelAdmitted: false, connectionState: "disabled" });
  claudeConnectionSummarySchema.parse(unavailableState);
  summary.mockImplementation(async () => unavailableState);
  const unavailable = render(<ClaudeConnectionSection />);
  await waitFor(() => expect(unavailable.getByText(/Those retained facts are not currently confirmed/)).toBeTruthy());
  expect(unavailable.queryByText(/Current desktop truth is being rechecked/)).toBeNull();
});
