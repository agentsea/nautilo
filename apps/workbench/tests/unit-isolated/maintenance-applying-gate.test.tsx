import "../bun-dom-preload";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, mock, test } from "bun:test";

mock.module(
  new URL("../../../../assets/brand/nautilo-logo_v1_logo_only_transparent.png?inline", import.meta.url).pathname + "?inline",
  () => ({ default: "data:image/png;base64,nautilo-brand-mark" }),
);

const {
  MaintenanceApplyingScreen,
  shouldCompleteMaintenanceRecovery,
  shouldShowMaintenanceApplyingGate,
} = await import("../../src/components/maintenance-applying-gate");

afterEach(() => cleanup());

describe("MaintenanceApplyingGate", () => {
  test("replaces applying with a branded recovery screen without fake progress", () => {
    const view = render(
      <MaintenanceApplyingScreen
        hasUnsentDraft={false}
        failure={null}
        onTryAgain={() => undefined}
        onSwitchServer={null}
        onCopyDetails={() => undefined}
        copied={false}
      />,
    );

    expect(view.getByTestId("maintenance-applying-gate")).toBeTruthy();
    expect(view.getByRole("heading", { name: "Applying a server upgrade" })).toBeTruthy();
    expect(view.getByText("The Workbench will reconnect automatically when the upgrade is ready.")).toBeTruthy();
    expect(view.queryByText(/\d+%|progress/i)).toBeNull();
    expect(view.container.querySelector("img")?.getAttribute("src")).toMatch(/^data:image\/png/);
    expect(view.container.querySelector("img")?.className).toContain("motion-reduce:animate-none");
    expect(view.getByTestId("maintenance-brand-halo").className).toContain("bg-white");
    expect(view.getByTestId("maintenance-brand-halo").className).toContain("ring-border-strong");
    expect(view.getByTestId("maintenance-applying-gate").className).toContain("bg-background");
    expect(view.getByTestId("maintenance-applying-gate").className).toContain("text-foreground");
  });

  test("keeps the full-screen gate through the first normal maintenance frame", () => {
    expect(shouldShowMaintenanceApplyingGate({ kind: "normal", applyingLatched: true })).toBe(true);
    expect(shouldShowMaintenanceApplyingGate({ kind: "normal", applyingLatched: false })).toBe(false);
  });

  test("requires explicit normal state before health can release a missed maintenance frame", () => {
    expect(
      shouldCompleteMaintenanceRecovery({
        healthMaintenanceState: "applying",
        normalCompletionObserved: false,
      }),
    ).toBe(false);
    expect(
      shouldCompleteMaintenanceRecovery({
        healthMaintenanceState: "draining",
        normalCompletionObserved: false,
      }),
    ).toBe(false);
    expect(
      shouldCompleteMaintenanceRecovery({
        healthMaintenanceState: "normal",
        normalCompletionObserved: false,
      }),
    ).toBe(true);
    // Older servers have no public state field, so only their authenticated
    // WS normal snapshot can complete recovery.
    expect(
      shouldCompleteMaintenanceRecovery({
        healthMaintenanceState: undefined,
        normalCompletionObserved: true,
      }),
    ).toBe(true);
  });

  test("keeps server switching available during planned maintenance", () => {
    let switchCount = 0;
    const view = render(
      <MaintenanceApplyingScreen
        hasUnsentDraft={false}
        failure={null}
        onTryAgain={() => undefined}
        onSwitchServer={() => {
          switchCount += 1;
        }}
        onCopyDetails={() => undefined}
        copied={false}
      />,
    );

    expect(
      view.getByText("The Workbench will reconnect automatically when the upgrade is ready."),
    ).toBeTruthy();
    const switchControls = view.getAllByRole("button", { name: "Switch server" });
    expect(switchControls).toHaveLength(2);
    expect(view.getByTestId("maintenance-server-rail")).toBeTruthy();
    fireEvent.click(switchControls[1]!);
    expect(switchCount).toBe(1);
    expect(view.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(view.queryByRole("button", { name: "Copy details" })).toBeNull();
  });

  test("does not invent a server switch control for single-server web clients", () => {
    const view = render(
      <MaintenanceApplyingScreen
        hasUnsentDraft={false}
        failure={null}
        onTryAgain={() => undefined}
        onSwitchServer={null}
        onCopyDetails={() => undefined}
        copied={false}
      />,
    );

    expect(view.queryByRole("button", { name: "Switch server" })).toBeNull();
  });
});
