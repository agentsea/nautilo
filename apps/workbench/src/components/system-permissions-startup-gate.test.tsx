import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { DesktopSystemPermissionsSnapshot } from "../lib/desktop";
import { SystemPermissionsStartupGate } from "./system-permissions-startup-gate";

function snapshot(accessibility: "granted" | "denied", screen: "granted" | "denied"): DesktopSystemPermissionsSnapshot {
  return {
    version: 1,
    platform: "macos",
    permissions: [
      { id: "accessibility", label: "Accessibility", reason: "Lets Nautilo control apps.", requiredFor: ["computer-use"], state: accessibility, action: accessibility === "granted" ? null : "request", restart: "not-required" },
      { id: "screen-recording", label: "Screen Recording", reason: "Lets Nautilo see the desktop.", requiredFor: ["computer-use"], state: screen, action: screen === "granted" ? null : "request", restart: "not-required" },
      { id: "microphone", label: "Microphone", reason: "Lets Nautilo hear you.", requiredFor: ["voice"], state: "not-determined", action: "request", restart: "not-required" },
    ],
  };
}

function ports(initial: DesktopSystemPermissionsSnapshot, initialShowAutomatically = true) {
  let current = initial;
  let showAutomatically = initialShowAutomatically;
  let listener: ((value: DesktopSystemPermissionsSnapshot) => void) | null = null;
  let guidedSetupListener: (() => void) | null = null;
  const permissions = {
    status: mock(async () => current),
    resolve: mock(async () => current),
    restart: mock(async () => undefined),
    onStatusChanged: mock((callback: (value: DesktopSystemPermissionsSnapshot) => void) => {
      listener = callback;
      return () => { listener = null; };
    }),
    onboardingPreference: mock(async () => ({ version: 1 as const, showAutomatically })),
    setOnboardingPreference: mock(async (next: boolean) => {
      showAutomatically = next;
      return { version: 1 as const, showAutomatically };
    }),
    requestGuidedSetup: mock(async () => { guidedSetupListener?.(); }),
    onGuidedSetupRequested: mock((callback: () => void) => {
      guidedSetupListener = callback;
      return () => { guidedSetupListener = null; };
    }),
  };
  const computerUse = {
    status: mock(async () => ({ providers: { cua: { ready: true, lifecycle: "healthy" } } })),
    check: mock(async () => undefined),
    onStatusChanged: mock(() => () => undefined),
  };
  return {
    permissions,
    computerUse,
    set: (next: DesktopSystemPermissionsSnapshot) => { current = next; listener?.(next); },
  };
}

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); });
afterEach(() => cleanup());

describe("SystemPermissionsStartupGate", () => {
  test("automatically opens a modal over Desktop when a required permission is missing", async () => {
    const port = ports(snapshot("denied", "granted"));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);

    await view.findByRole("heading", { name: "Prepare this Mac" });
    expect(view.getByRole("dialog")).toBeTruthy();
    expect(view.getByText("Ordinary workspace")).toBeTruthy();
    const microphone = await view.findByText("Microphone", { exact: true });
    expect(microphone.parentElement?.textContent).toContain("Optional");
    await waitFor(() => expect(view.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1"));
  });

  test("durably suppresses future automatic launches but keeps guided setup callable", async () => {
    const port = ports(snapshot("denied", "granted"));
    const first = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);
    await first.findByRole("dialog");
    fireEvent.click(first.getByRole("checkbox", { name: "Don’t show automatically again" }));
    await waitFor(() => expect(port.permissions.setOnboardingPreference).toHaveBeenCalledWith(false));
    expect(first.getByRole("dialog")).toBeTruthy();
    fireEvent.click(first.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(first.queryByRole("dialog")).toBeNull());
    first.unmount();

    const second = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);
    await waitFor(() => expect(port.permissions.onboardingPreference).toHaveBeenCalledTimes(2));
    expect(second.queryByRole("dialog")).toBeNull();
    await act(async () => { await port.permissions.requestGuidedSetup(); });
    await second.findByRole("dialog");
  });

  test("does not open automatically when the app-wide preference is already disabled", async () => {
    const port = ports(snapshot("denied", "granted"), false);
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);
    await waitFor(() => expect(port.permissions.onboardingPreference).toHaveBeenCalledTimes(1));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("Escape is ephemeral and guided setup restores focus to its caller", async () => {
    const port = ports(snapshot("denied", "granted"), false);
    const caller = document.createElement("button");
    caller.textContent = "Settings caller";
    document.body.append(caller);
    caller.focus();
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);
    await waitFor(() => expect(port.permissions.onboardingPreference).toHaveBeenCalledTimes(1));
    await act(async () => { await port.permissions.requestGuidedSetup(); });
    await view.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(caller);
    expect(port.permissions.setOnboardingPreference).not.toHaveBeenCalled();
    caller.remove();
  });

  test("keeps the dialog usable when durable preference persistence fails", async () => {
    const port = ports(snapshot("denied", "granted"));
    port.permissions.setOnboardingPreference.mockRejectedValueOnce(new Error("read only"));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);
    await view.findByRole("dialog");
    fireEvent.click(view.getByRole("checkbox", { name: "Don’t show automatically again" }));
    await view.findByRole("alert");
    expect(view.getByRole("dialog")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
  });

  test("lets the Human continue without optional functionality", async () => {
    const port = ports(snapshot("denied", "granted"));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);

    await view.findByRole("dialog");
    fireEvent.click(view.getByRole("button", { name: "Not now" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(view.getByText("Ordinary workspace")).toBeTruthy();

    act(() => port.set(snapshot("denied", "denied")));
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("starts normally when both required permissions are already ready", async () => {
    const port = ports(snapshot("granted", "granted"));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);

    await view.findByText("Ordinary workspace");
    expect(view.queryByRole("dialog")).toBeNull();
  });

  test("one checklist resolves the row and continues into Nautilo", async () => {
    const port = ports(snapshot("denied", "granted"));
    port.computerUse.status.mockResolvedValue({ providers: { cua: { ready: false, lifecycle: "stopped" } } });
    port.permissions.resolve.mockImplementation(async () => snapshot("granted", "granted"));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);

    const requestButtons = await view.findAllByRole("button", { name: "Request access" });
    fireEvent.click(requestButtons[0]!);
    await view.findByText(/Required permissions are ready\. Computer Use will finish starting separately\./);
    await waitFor(() => expect(view.getByRole("button", { name: "Continue to Nautilo" }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Continue to Nautilo" }));
    await waitFor(() => expect(view.queryByRole("dialog")).toBeNull());
    expect(view.getByText("Ordinary workspace")).toBeTruthy();
  });

  test("does not lose a missing-permission event behind a stale initial status", async () => {
    let settle: ((value: DesktopSystemPermissionsSnapshot) => void) | null = null;
    const port = ports(snapshot("granted", "granted"));
    port.permissions.status.mockImplementation(() => new Promise((resolve) => { settle = resolve; }));
    const view = render(<SystemPermissionsStartupGate permissions={port.permissions} computerUse={port.computerUse} isDesktopShell>
      <div>Ordinary workspace</div>
    </SystemPermissionsStartupGate>);

    await act(async () => {
      port.set(snapshot("denied", "granted"));
      settle?.(snapshot("granted", "granted"));
      await Promise.resolve();
    });
    await view.findByRole("heading", { name: "Prepare this Mac" });
    expect(view.getByText("Ordinary workspace")).toBeTruthy();
  });
});
