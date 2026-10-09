import { beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import {
  CostsRecoveryPanel,
  CostsServiceOperations,
  CostsServiceRecoveryPanel,
  CostsTaskAttribution,
} from "./costs-recovery-panel";

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });

test("shows content-free recent recovery evidence and preserves original-account repair", () => {
  const view = render(<CostsRecoveryPanel keysPath="/settings#personal-provider-keys" attempts={[{
    attemptId: "attempt-ref", status: "blocked", reason: "credential_revision_changed",
    providerRoute: "surplus", requestReference: "receipt-hash", lastObservedAt: "2026-10-06T10:00:00Z",
    repairAction: "check_receipt_access", taskId: "task-ref",
  }]} />);
  expect(view.getByText("surplus · blocked")).toBeTruthy();
  expect(view.getByText(/key that created this request/)).toBeTruthy();
  expect(view.container.textContent).toContain("credential revision changed");
  expect(view.container.textContent).toContain("Request reference receipt-hash");
  expect(view.getByRole("link", { name: "Manage provider keys" }).getAttribute("href")).toBe("/settings#personal-provider-keys");
});

test("shows Task model and service spend with total unresolved counts", () => {
  const view = render(<CostsTaskAttribution rows={[{
    taskId: "task-ref", calls: 3, providerOperations: 4,
    unknownProviderOperations: 2, actualCostUsd: 0.03, estimatedCostUsd: 0.02,
    totalCostUsd: 0.05, pendingAttempts: 1, unknownAttempts: 1,
  } as never]} />);
  expect(view.getByText("By Task")).toBeTruthy();
  expect(view.getByText("task-ref")).toBeTruthy();
  expect(view.getByText("Model attempts")).toBeTruthy();
  expect(view.getByText("Paid operations")).toBeTruthy();
  expect(view.getAllByText("4")).toHaveLength(2);
  expect(view.container.textContent).toContain("older service costs");
});

test("shows service outcomes without inferring outcomes for older rows", () => {
  const view = render(<CostsServiceOperations summary={{
    operations: 7, succeeded: 2, failed: 1, cancelled: 1,
    interrupted: 1, unknown: 1, legacy: 1,
  }} />);
  expect(view.getByText("Paid service outcomes")).toBeTruthy();
  expect(view.container.textContent).toContain("1 older unclassified");
  expect(view.container.textContent).toContain("no outcome is inferred");
});

test("shows content-free unresolved service diagnostics", () => {
  const view = render(<CostsServiceRecoveryPanel attempts={[{
    provider: "tavily", operation: "search", workload: "deep_research",
    attemptOutcome: "failed", failureCode: "upstream_error",
    taskId: "task-ref", runId: null, jobId: "job-ref",
    occurredAt: "2026-10-08T10:00:00Z",
  }]} />);
  expect(view.getByText("Recent unresolved paid services")).toBeTruthy();
  expect(view.container.textContent).toContain("tavily · search · deep research");
  expect(view.container.textContent).toContain("Failure upstream error");
  expect(view.container.textContent).toContain("Task task-ref");
  expect(view.container.textContent).toContain("Job job-ref");
});
