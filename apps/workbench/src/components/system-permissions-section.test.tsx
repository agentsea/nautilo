import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type {
  DesktopSystemPermission,
  DesktopSystemPermissionsSnapshot,
} from "../lib/desktop";
import { SystemPermissionsSection } from "./system-permissions-section";

type State = DesktopSystemPermission["state"];

function snapshot(accessibility: State = "not-determined", screenRecording: State = "not-determined", microphone: State = "not-determined", restart: DesktopSystemPermission["restart"] = "not-required"): DesktopSystemPermissionsSnapshot {
  return {
    version: 1,
    platform: "macos",
    permissions: [
      { id: "accessibility", label: "Accessibility", reason: "Required for Genies to click, type, and control apps.", requiredFor: ["computer-use"], state: accessibility, action: accessibility === "granted" || accessibility === "restricted" || accessibility === "unsupported" ? null : "request", restart: "not-required" },
      { id: "screen-recording", label: "Screen Recording", reason: "Required for Genies to see app windows and verify work.", requiredFor: ["computer-use"], state: screenRecording, action: screenRecording === "granted" || screenRecording === "restricted" || screenRecording === "unsupported" ? null : "request", restart: "not-required" },
      { id: "microphone", label: "Microphone", reason: "Used only when you turn on voice features.", requiredFor: ["voice"], state: microphone, action: microphone === "granted" || microphone === "restricted" || microphone === "unsupported" ? null : microphone === "not-determined" ? "request" : "open-settings", restart },
    ],
  };
}

function permissionPort(current: () => DesktopSystemPermissionsSnapshot) {
  let callback: ((next: DesktopSystemPermissionsSnapshot) => void) | null = null;
  const unsubscribe = mock(() => undefined);
  return {
    status: mock(async () => current()),
    resolve: mock(async () => current()),
    restart: mock(async () => undefined),
    onStatusChanged: (next: (snapshot: DesktopSystemPermissionsSnapshot) => void) => { callback = next; return unsubscribe; },
    emit: async () => { await act(async () => { callback?.(current()); await Promise.resolve(); }); },
    unsubscribe,
  };
}

function computerUse(ready: () => boolean, subscribe = false, checkWork?: () => Promise<unknown>) {
  let callback: (() => void) | null = null;
  const unsubscribe = mock(() => undefined);
  const check = checkWork ? mock(checkWork) : undefined;
  return {
    status: async () => ({ providers: { cua: ready() ? { ready: true, reason: null, lifecycle: "healthy" } : { ready: false, reason: "unhealthy", lifecycle: "unhealthy" } } }) as never,
    ...(check ? { check } : {}),
    ...(subscribe ? { onStatusChanged: (next: () => void) => { callback = next; return unsubscribe; } } : {}),
    emit: async () => { await act(async () => { callback?.(); await Promise.resolve(); }); },
    unsubscribe,
  };
}

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });
afterEach(() => cleanup());

describe("System permissions", () => {
  test("lets Settings disable or re-enable automatic setup and run it on demand", async () => {
    const base = permissionPort(() => snapshot("granted", "granted", "granted"));
    let showAutomatically = false;
    const requestGuidedSetup = mock(async () => undefined);
    const permissions = {
      ...base,
      onboardingPreference: mock(async () => ({ version: 1 as const, showAutomatically })),
      setOnboardingPreference: mock(async (next: boolean) => {
        showAutomatically = next;
        return { version: 1 as const, showAutomatically };
      }),
      requestGuidedSetup,
    };
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell collapseWhenReady showOnboardingControls />);
    await view.findByRole("checkbox", { name: /Show setup automatically/ });
    await waitFor(() => expect((view.getByRole("checkbox", { name: /Show setup automatically/ }) as HTMLInputElement).checked).toBe(false));
    const checkbox = view.getByRole("checkbox", { name: /Show setup automatically/ });
    fireEvent.click(checkbox);
    await waitFor(() => expect(permissions.setOnboardingPreference).toHaveBeenCalledWith(true));
    fireEvent.click(view.getByRole("button", { name: "Run guided setup" }));
    await waitFor(() => expect(requestGuidedSetup).toHaveBeenCalledTimes(1));
    expect(view.getByText("This preference applies to this Nautilo Desktop identity on this Mac. Development builds keep a separate preference.")).toBeTruthy();
  });

  test("collapses a fully ready Connections card and expands on demand", async () => {
    const permissions = permissionPort(() => snapshot("granted", "granted", "granted"));
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell collapseWhenReady />);
    await view.findByText("✓ 3 permissions ready");
    expect(view.queryByText("Accessibility", { exact: true })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Show details" }));
    await view.findByText("Accessibility", { exact: true });
    fireEvent.click(view.getByRole("button", { name: "Hide details" }));
    await view.findByText("✓ 3 permissions ready");
  });

  test("shows required missing permissions and requests only the documented Accessibility route", async () => {
    let current = snapshot();
    const permissions = permissionPort(() => current);
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell />);
    await view.findByText("0 of 2 required ready");
    expect(view.getAllByText("Not enabled")).toHaveLength(3);
    fireEvent.click(view.getAllByRole("button", { name: "Request access" })[0]);
    await waitFor(() => expect(permissions.resolve).toHaveBeenCalledWith("accessibility"));
    current = snapshot("granted");
    await permissions.emit();
    await view.findByText("1 of 2 required ready");
  });

  test("updates first then second required permission live without a manual check or remount", async () => {
    let current = snapshot();
    const permissions = permissionPort(() => current);
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell />);
    await view.findByText("0 of 2 required ready");
    current = snapshot("granted");
    await permissions.emit();
    await view.findByText("1 of 2 required ready");
    current = snapshot("granted", "granted");
    await permissions.emit();
    await view.findByText("2 of 2 required ready");
    expect(view.queryByRole("button", { name: /^Check$/ })).toBeNull();
  });

  test("moves Screen Recording from native request to the predefined Settings fallback", async () => {
    const current = snapshot();
    const permissions = permissionPort(() => current);
    permissions.resolve.mockImplementation(async (id) => {
      if (id === "screen-recording") {
        (current.permissions[1] as unknown as Record<string, unknown>).action = "open-settings";
      }
      return current;
    });
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell />);
    await view.findByText("0 of 2 required ready");
    fireEvent.click(view.getAllByRole("button", { name: "Request access" })[1]);
    await waitFor(() => expect(permissions.resolve).toHaveBeenCalledWith("screen-recording"));
    await view.findByRole("button", { name: "Open System Settings" });
  });

  test("keeps Continue locked until Cua is actually healthy, then focuses Computer Use", async () => {
    const permissions = permissionPort(() => snapshot("granted", "granted"));
    let ready = false;
    const driver = computerUse(() => ready, true);
    const target = document.createElement("section");
    target.id = "computer-use";
    target.tabIndex = -1;
    document.body.append(target);
    const view = render(<SystemPermissionsSection permissions={permissions} computerUse={driver} isDesktopShell />);
    await view.findByText("Computer Use is waiting for Cua");
    expect((view.getByRole("button", { name: "Continue to Computer Use" }) as HTMLButtonElement).disabled).toBe(true);
    ready = true;
    await driver.emit();
    await view.findByText(/Cua driver healthy · Computer Use is ready/);
    const continueButton = view.getByRole("button", { name: "Continue to Computer Use" });
    expect((continueButton as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(continueButton);
    expect(document.activeElement).toBe(target);
    target.remove();
  });

  test("does not let optional microphone block Computer Use", async () => {
    const permissions = permissionPort(() => snapshot("granted", "granted", "denied"));
    const driver = computerUse(() => true);
    const view = render(<SystemPermissionsSection permissions={permissions} computerUse={driver} isDesktopShell />);
    await view.findByText(/Cua driver healthy · Computer Use is ready/);
    expect(view.getByText("Access denied")).toBeTruthy();
    expect((view.getByRole("button", { name: "Continue to Computer Use" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("checks Cua once after the last required live grant, then unlocks Continue", async () => {
    let current = snapshot("granted", "not-determined");
    let ready = false;
    const permissions = permissionPort(() => current);
    const driver = computerUse(
      () => ready,
      true,
      async () => {
        ready = true;
        return { providers: { cua: { ready: true, reason: null, lifecycle: "healthy" } } } as never;
      },
    );
    const view = render(<SystemPermissionsSection permissions={permissions} computerUse={driver} isDesktopShell />);
    await view.findByText("1 of 2 required ready");
    current = snapshot("granted", "granted");
    await permissions.emit();
    await waitFor(() => expect(driver.check).toHaveBeenCalledTimes(1));
    await view.findByText(/Cua driver healthy · Computer Use is ready/);
    expect((view.getByRole("button", { name: "Continue to Computer Use" }) as HTMLButtonElement).disabled).toBe(false);
    await driver.emit();
    expect(driver.check).toHaveBeenCalledTimes(1);
  });

  test.each([
    ["denied", "Access denied"],
    ["restricted", "Restricted by macOS"],
    ["unsupported", "Not available on this Mac"],
  ] as const)("keeps %s status truthful", async (state, expected) => {
    const permissions = permissionPort(() => snapshot(state));
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell />);
    await view.findByText(expected);
    expect((view.getByRole("button", { name: "Continue to Computer Use" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("offers the real restart seam only when the typed row says restart is required", async () => {
    const permissionWithRestart = permissionPort(() => snapshot("not-determined", "not-determined", "granted", "required"));
    const first = render(<SystemPermissionsSection permissions={permissionWithRestart} isDesktopShell />);
    await first.findByText("Restart Nautilo after changing this permission.");
    fireEvent.click(first.getByRole("button", { name: "Restart Nautilo" }));
    await waitFor(() => expect(permissionWithRestart.restart).toHaveBeenCalledTimes(1));
    first.unmount();
    const ordinaryPermissions = permissionPort(() => snapshot());
    const second = render(<SystemPermissionsSection permissions={ordinaryPermissions} isDesktopShell />);
    await second.findByText("0 of 2 required ready");
    expect(second.queryByRole("button", { name: "Restart Nautilo" })).toBeNull();
  });

  test("accepts the denied Microphone restart latch after its Settings route returns", async () => {
    const deniedMicrophoneRestart = permissionPort(() => snapshot("not-determined", "not-determined", "denied", "required"));
    const view = render(<SystemPermissionsSection permissions={deniedMicrophoneRestart} isDesktopShell />);
    await view.findByText("Access denied");
    fireEvent.click(view.getByRole("button", { name: "Restart Nautilo" }));
    await waitFor(() => expect(deniedMicrophoneRestart.restart).toHaveBeenCalledTimes(1));
  });

  test("unsubscribes and fails closed on an older Desktop shell", async () => {
    const permissions = permissionPort(() => snapshot());
    const driver = computerUse(() => true, true);
    const view = render(<SystemPermissionsSection permissions={permissions} computerUse={driver} isDesktopShell />);
    await view.findByText("0 of 2 required ready");
    view.unmount();
    expect(permissions.unsubscribe).toHaveBeenCalledTimes(1);
    expect(driver.unsubscribe).toHaveBeenCalledTimes(1);

    const oldShell = render(<SystemPermissionsSection isDesktopShell />);
    await oldShell.findByText("Update Nautilo Desktop to check and guide this Mac’s system permissions.");
    expect(oldShell.getByTestId("system-permissions-section").textContent).not.toContain("0 of 2 required ready");
  });

  test("fails closed on impossible or expanded snapshots rather than trusting new bytes", async () => {
    const impossible = snapshot("granted");
    (impossible.permissions[0] as unknown as Record<string, unknown>).action = "request";
    const wrongRoute = snapshot();
    (wrongRoute.permissions[0] as unknown as Record<string, unknown>).action = "open-settings";
    const wrongRestartRow = snapshot();
    (wrongRestartRow.permissions[0] as unknown as Record<string, unknown>).restart = "required";
    const wrongRestartState = snapshot();
    (wrongRestartState.permissions[2] as unknown as Record<string, unknown>).restart = "required";
    const unexpectedTopLevel = snapshot();
    (unexpectedTopLevel as unknown as Record<string, unknown>).providerUrl = "https://untrusted.example";
    const unexpectedRow = snapshot();
    (unexpectedRow.permissions[1] as unknown as Record<string, unknown>).settingsUrl = "x-apple.systempreferences:untrusted";
    for (const invalid of [impossible, wrongRoute, wrongRestartRow, wrongRestartState, unexpectedTopLevel, unexpectedRow]) {
      const view = render(<SystemPermissionsSection permissions={permissionPort(() => invalid)} isDesktopShell />);
      await view.findByText("Update Nautilo Desktop to check and guide this Mac’s system permissions.");
      view.unmount();
    }
  });

  test("keeps a newer subscription snapshot when the initial status read settles stale", async () => {
    let settleInitial: ((value: DesktopSystemPermissionsSnapshot) => void) | null = null;
    let subscribed: ((value: DesktopSystemPermissionsSnapshot) => void) | null = null;
    const permissions = {
      status: () => new Promise<DesktopSystemPermissionsSnapshot>((resolve) => { settleInitial = resolve; }),
      resolve: async () => snapshot(),
      restart: async () => undefined,
      onStatusChanged: (callback: (next: DesktopSystemPermissionsSnapshot) => void) => { subscribed = callback; return () => undefined; },
    };
    const view = render(<SystemPermissionsSection permissions={permissions} isDesktopShell />);
    await waitFor(() => expect(subscribed).not.toBeNull());
    await act(async () => { subscribed?.(snapshot("granted", "granted")); await Promise.resolve(); });
    await view.findByText("2 of 2 required ready");
    await act(async () => { settleInitial?.(snapshot()); await Promise.resolve(); });
    expect(view.getByText("2 of 2 required ready")).toBeTruthy();
  });
});
