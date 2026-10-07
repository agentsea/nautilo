import { beforeEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { CostsRecoveryPanel, CostsTaskAttribution } from "./costs-recovery-panel";

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

test("shows Task spend and unresolved counts without protected Task content", () => {
  const view = render(<CostsTaskAttribution rows={[{
    taskId: "task-ref", calls: 3, actualCostUsd: 0, estimatedCostUsd: 0,
    totalCostUsd: 0, pendingAttempts: 1, unknownAttempts: 1,
  }]} />);
  expect(view.getByText("By Task")).toBeTruthy();
  expect(view.getByText("task-ref")).toBeTruthy();
  expect(view.getByText("2")).toBeTruthy();
});
