import { reapplyHappyDomGlobals } from "../../../../tests/bun-dom-preload";
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import type { CapabilitySlug, MemoryAdminStatus } from "@nautilo/types";

let capabilities = new Set<CapabilitySlug>();
let load: () => Promise<MemoryAdminStatus>;
const retry = mock(async () => ({ requested: 1 }));
const set = mock(async () => ({}));
mock.module("../../../hooks/use-can", () => ({ useCan: () => (cap: CapabilitySlug) => capabilities.has(cap) }));
mock.module("../../../lib/api", () => ({ apiClient: { admin: {
  memoryStatus: { get: () => load(), retry }, serverContext: { set },
} } }));
const { MemorySection } = await import("./memory-health-card");

function fixture(): MemoryAdminStatus {
  return {
    generatedAt: "2026-09-05T12:00:00Z", window: { since: "2026-09-04T12:00:00Z", until: "2026-09-05T12:00:00Z" },
    enabled: true, model: { id: "test:model", provider: "test", source: "conductor", available: true },
    encryption: { mode: "ordinary", available: true }, trackedSince: null, health: "waiting",
    current: { accumulating: 1, due: 0, processing: 0, retrying: 0, blocked: 0, caughtUp: 0, safelyRetryable: 1, oldestOverdueMs: null },
    lastSuccessfulReviewAt: null, lastAttemptAt: null,
    last24h: { completedReviews: 0, noChangeReviews: 0, created: 0, replaced: 0, promoted: 0, demoted: 0, failures: 0, lastReviewDurationMs: null },
    recentFailures: [], followUpPending: 0, exitFlush: "not_scheduled",
  };
}
beforeEach(() => {
  reapplyHappyDomGlobals(); cleanup(); capabilities = new Set(["read_server_settings"]);
  load = async () => fixture(); retry.mockClear(); set.mockClear();
});
afterEach(cleanup);
const show = () => render(<MemoryRouter><MemorySection /></MemoryRouter>);

test("read permission gates requests and write/billing controls independently", async () => {
  capabilities.clear();
  let calls = 0; load = async () => { calls++; return fixture(); };
  const denied = show(); expect(denied.queryByText("Memory processing")).toBeNull(); expect(calls).toBe(0); denied.unmount();
  capabilities.add("read_server_settings");
  const view = show(); await waitFor(() => expect(view.getByText("Waiting for more conversation")).toBeTruthy());
  expect(view.queryByText("Retry failed reviews")).toBeNull();
  expect(view.queryByText(/View model costs/)).toBeNull();
  expect(view.getByText("Exit flush: not scheduled")).toBeTruthy();
  expect(view.getAllByText("Not measured").length).toBeGreaterThan(0);
});
test("failed refresh preserves last good values visibly stale", async () => {
  const view = show(); await waitFor(() => expect(view.getByText("Waiting for more conversation")).toBeTruthy());
  load = async () => { throw new Error("offline"); };
  fireEvent.click(view.getByText("Refresh"));
  await waitFor(() => expect(view.getByRole("alert").textContent).toContain("stale"));
  expect(view.getByText("Waiting for more conversation")).toBeTruthy();
});
test("focus refresh coalesces with an in-flight read and retry requires operator authority", async () => {
  capabilities.add("manage_server_operations");
  let calls = 0;
  let resolve!: (value: MemoryAdminStatus) => void;
  load = () => { calls++; return new Promise(done => { resolve = done; }); };
  const view = show(); window.dispatchEvent(new Event("focus")); window.dispatchEvent(new Event("focus"));
  expect(calls).toBe(1); resolve(fixture());
  await waitFor(() => expect(view.getByText("Retry failed reviews")).toBeTruthy());
  load = async () => fixture();
  fireEvent.click(view.getByText("Retry failed reviews"));
  await waitFor(() => expect(retry).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(view.getByText("1 failed review scheduled for normal retry.")).toBeTruthy());
});

test("pause, model outage and saved follow-up states do not claim healthy completion", async () => {
  const { memoryStatusHeadline } = await import("./memory-health-card");
  expect(memoryStatusHeadline({ ...fixture(), enabled: false })).toContain("Paused");
  expect(memoryStatusHeadline({ ...fixture(), model: { ...fixture().model, available: false } })).toContain("Model unavailable");
  expect(memoryStatusHeadline({ ...fixture(), followUpPending: 1 })).toBe("Memory saved; follow-up processing pending");
  expect(memoryStatusHeadline({ ...fixture(), encryption: { mode: "strict", available: false } })).toContain("authorized processing access");
});

test("enable control changes only reviewer policy and refreshes the resulting state", async () => {
  capabilities.add("manage_server_operations");
  load = async () => ({ ...fixture(), enabled: false });
  const view = show();
  await waitFor(() => expect(view.getByText("Enable automatic review")).toBeTruthy());
  fireEvent.click(view.getByText("Enable automatic review"));
  await waitFor(() => expect(set).toHaveBeenCalledWith({ memoryReviewEnabled: true }));
});

test("hidden-document refresh waits until returning and does not overwrite last good data", async () => {
  let calls = 0;
  load = async () => { calls++; return fixture(); };
  const view = show();
  await waitFor(() => expect(view.getByText("Waiting for more conversation")).toBeTruthy());
  const descriptor = Object.getOwnPropertyDescriptor(document, "visibilityState");
  try {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    expect(calls).toBe(1);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    await waitFor(() => expect(calls).toBe(2));
  } finally {
    if (descriptor) Object.defineProperty(document, "visibilityState", descriptor);
    else Reflect.deleteProperty(document, "visibilityState");
  }
});


test("health uses the sibling status style and leaves model identity in Model settings", async () => {
  load = async () => ({ ...fixture(), health: "healthy" });
  const view = show();
  await waitFor(() => expect(view.getByTestId("memory-health-pill").textContent).toBe("healthy"));
  expect(view.getByTestId("memory-health-pill").className).toContain("bg-emerald-500/10");
  expect(view.queryByText(/test:model/)).toBeNull();
  expect(view.queryByText(/Runtime configuration/)).toBeNull();
  expect(view.getByRole("link", { name: "Model settings" }).getAttribute("href")).toBe("/admin#models");
  expect(view.getByText("Accumulating").parentElement?.className).toContain("border-border/60");
});
