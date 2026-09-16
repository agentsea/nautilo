import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DesktopSystemPermissionsSnapshot } from "../../lib/desktop";
import type { ComputerUseConnection } from "./computer-use-connection-section";

const realUseAuth = await import("../../hooks/use-auth");
mock.module("../../hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: "computer-use-test-viewer", userIdentity: null } }) }));
const { ComputerUseConnectionSection } = await import("./computer-use-connection-section");

const genies = [{ agentId: "agent-jeannie", displayName: "Jeannie", handle: "jeannie" }];
const cuaReady = { cua: { ready: true as const, reason: null, lifecycle: "healthy" as const } };
const cuaNeedsAttention = { cua: { ready: false as const, reason: "unhealthy" as const, lifecycle: "unhealthy" as const } };

function status(overrides: Record<string, unknown> = {}) {
  return { state: "not-enabled" as const, reason: null, agentId: null, grantGeneration: null, canDisable: false, providers: cuaReady, effectiveProvider: { provider: "cua" as const }, ...overrides };
}
function connection(overrides: Partial<ComputerUseConnection> = {}): ComputerUseConnection {
  return { status: async () => status(), ownedAgents: async () => genies, enable: async () => undefined, disable: async () => undefined, ...overrides };
}

beforeEach(() => { reapplyHappyDomGlobals(); cleanup(); localStorage.clear(); });
afterAll(() => { mock.module("../../hooks/use-auth", () => realUseAuth); cleanup(); });

describe("Computer use for Genie", () => {
  test("shows a Cua-only connection card with no provider-policy controls", async () => {
    const view = render(<ComputerUseConnectionSection connection={connection()} />);
    await waitFor(() => expect(view.container.textContent).toContain("Ready (computer use)"));
    expect(view.container.textContent).toContain("Cua is ready for new Computer use work.");
    expect(view.queryByLabelText(/primary driver/i)).toBeNull();
    expect(view.queryByLabelText(/fallback driver/i)).toBeNull();
  });

  test("keeps the On switch usable when Cua needs attention", async () => {
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status({ providers: cuaNeedsAttention, effectiveProvider: null }),
      check: async () => status({ providers: cuaNeedsAttention, effectiveProvider: null }),
    })} />);
    await waitFor(() => expect(view.container.textContent).toContain("Needs attention"));
    expect((view.getByRole("switch", { name: "Turn on Computer use for Genie" }) as HTMLButtonElement).disabled).toBe(false);
    expect(view.getByRole("button", { name: "Check" })).toBeTruthy();
  });

  test("uses one cancellable PIN sheet to turn Computer Use on for the selected Genie", async () => {
    let enabled = false;
    const enable = mock(async (_pin: string, _agentId: string) => { enabled = true; });
    const view = render(<ComputerUseConnectionSection connection={connection({ status: async () => status(enabled ? { state: "enabled", agentId: "agent-jeannie", grantGeneration: 1, canDisable: true } : {}), enable })} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    const user = userEvent.setup({ document: globalThis.document });
    await user.type(view.getByPlaceholderText("••••••"), "847291");
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith("847291", "agent-jeannie"));
  });

  test("turns Off immediately even when Cua is unhealthy", async () => {
    let enabled = true;
    const disable = mock(async () => { enabled = false; });
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status(enabled ? { state: "enabled", agentId: "agent-jeannie", grantGeneration: 1, canDisable: true, providers: cuaNeedsAttention, effectiveProvider: null } : { providers: cuaNeedsAttention, effectiveProvider: null }),
      disable,
    })} />);
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn off Computer use for Genie" }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
  });

  test("links to the separate permissions card when a required macOS grant is missing", async () => {
    const permissionSnapshot: DesktopSystemPermissionsSnapshot = {
      version: 1,
      platform: "macos",
      permissions: [
        { id: "accessibility", label: "Accessibility", reason: "Required.", requiredFor: ["computer-use"], state: "denied", action: "request", restart: "not-required" },
        { id: "screen-recording", label: "Screen Recording", reason: "Required.", requiredFor: ["computer-use"], state: "granted", action: null, restart: "not-required" },
        { id: "microphone", label: "Microphone", reason: "Required for voice.", requiredFor: ["voice"], state: "granted", action: null, restart: "not-required" },
      ],
    };
    const permissions = { status: async () => permissionSnapshot, resolve: async () => permissionSnapshot, restart: async () => undefined, onStatusChanged: () => () => undefined };
    const view = render(<ComputerUseConnectionSection connection={connection()} permissions={permissions} isDesktopShell />);
    expect((await view.findByRole("link", { name: "Fix in Settings" })).getAttribute("href")).toBe("/settings#desktop-permissions");
  });

  test("refreshes an enabled card after Electron withdraws Cua readiness", async () => {
    let ready = true;
    let changed: (() => void) | null = null;
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status({ state: "enabled", agentId: "agent-jeannie", grantGeneration: 9, canDisable: true, providers: ready ? cuaReady : cuaNeedsAttention, effectiveProvider: ready ? { provider: "cua" } : null }),
      onStatusChanged: (callback) => { changed = callback; return () => undefined; },
    })} />);
    await waitFor(() => expect(view.container.textContent).toContain("Ready (computer use)"));
    ready = false;
    await act(async () => { changed?.(); });
    await waitFor(() => expect(view.container.textContent).toContain("Needs attention"));
    expect((view.getByRole("switch", { name: "Turn off Computer use for Genie" }) as HTMLButtonElement).disabled).toBe(false);
  });

  test("cancels a stale enable ceremony when another surface enables Computer use", async () => {
    let enabled = false;
    let changed: (() => void) | null = null;
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status(enabled
        ? { state: "enabled", agentId: "agent-jeannie", grantGeneration: 2, canDisable: true }
        : {}),
      onStatusChanged: (callback) => { changed = callback; return () => undefined; },
    })} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    expect(view.getByRole("heading", { name: "Turn on Computer use" })).toBeTruthy();

    enabled = true;
    await act(async () => { changed?.(); await Promise.resolve(); });
    await waitFor(() => expect(view.queryByRole("heading", { name: "Turn on Computer use" })).toBeNull());
    expect(view.getByText("On")).toBeTruthy();
  });

  test("retries owned-Genie discovery after the signed-in Human is rebound", async () => {
    let rebound = false;
    let changed: (() => void) | null = null;
    const ownedAgents = mock(async () => {
      if (!rebound) throw new Error("Nautilo could not verify the Genies you currently own on this Desktop.");
      return genies;
    });
    const view = render(<ComputerUseConnectionSection connection={connection({
      ownedAgents,
      onStatusChanged: (callback) => { changed = callback; return () => undefined; },
    })} />);
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("could not verify the Genies"));

    rebound = true;
    await act(async () => { changed?.(); await Promise.resolve(); });
    await waitFor(() => expect(ownedAgents).toHaveBeenCalledTimes(2));
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    await waitFor(() => expect(view.getByRole("heading", { name: "Turn on Computer use" })).toBeTruthy());
    expect(view.queryByRole("alert")).toBeNull();
  });

  test("requires an explicit Genie choice when more than one is owned", async () => {
    const enable = mock(async () => undefined);
    const view = render(<ComputerUseConnectionSection connection={connection({
      ownedAgents: async () => [
        ...genies,
        { agentId: "agent-moxie", displayName: "Moxie", handle: "moxie" },
      ],
      enable,
    })} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    const user = userEvent.setup({ document: globalThis.document });
    const select = view.getByRole("combobox", { name: "Genie allowed to operate this Mac" });
    expect((select as HTMLSelectElement).value).toBe("");
    await user.selectOptions(select, "agent-moxie");
    await user.type(view.getByPlaceholderText("••••••"), "847291");
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(enable).toHaveBeenCalledWith("847291", "agent-moxie"));
  });

  test("keeps Off usable during Check and ignores a late checked result after Off", async () => {
    let enabled = true;
    let resolveCheck: ((value: unknown) => void) | undefined;
    const pendingCheck = new Promise<unknown>((resolve) => { resolveCheck = resolve; });
    const disable = mock(async () => { enabled = false; });
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status(enabled
        ? { state: "enabled", agentId: "agent-jeannie", grantGeneration: 1, canDisable: true }
        : {}),
      check: () => pendingCheck,
      disable,
    })} />);
    await waitFor(() => expect(view.getByRole("switch", { name: "Turn off Computer use for Genie" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Check" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Checking…" })).toBeTruthy());
    const off = view.getByRole("switch", { name: "Turn off Computer use for Genie" }) as HTMLButtonElement;
    expect(off.disabled).toBe(false);
    fireEvent.click(off);
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());

    resolveCheck?.(status({ state: "enabled", agentId: "agent-jeannie", grantGeneration: 1, canDisable: true }));
    await pendingCheck;
    await Promise.resolve();
    expect(view.queryByRole("switch", { name: "Turn off Computer use for Genie" })).toBeNull();
  });

  test("keeps corrupt local authority and relay-unavailable authority recoverable with Off", async () => {
    for (const unavailableStatus of [
      status({ state: "unavailable", reason: "Nautilo could not read Computer use state on this Mac.", canDisable: true, providers: null, effectiveProvider: null }),
      status({ state: "unavailable", reason: "Relay is disconnected.", agentId: "agent-jeannie", grantGeneration: 4, canDisable: true }),
    ]) {
      const disable = mock(async () => undefined);
      const view = render(<ComputerUseConnectionSection connection={connection({
        status: async () => unavailableStatus,
        disable,
      })} />);
      await waitFor(() => expect(view.getByText("Needs Off")).toBeTruthy());
      const off = view.getByRole("switch", { name: "Turn off Computer use for Genie" }) as HTMLButtonElement;
      expect(off.disabled).toBe(false);
      fireEvent.click(off);
      await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
      view.unmount();
    }
  });

  test("keeps an active grant revocable without loading the owned-Genie list", async () => {
    const ownedAgents = mock(async () => { throw new Error("Profile is temporarily unavailable."); });
    const disable = mock(async () => undefined);
    const view = render(<ComputerUseConnectionSection connection={connection({
      status: async () => status({ state: "enabled", agentId: "agent-jeannie", grantGeneration: 5, canDisable: true }),
      ownedAgents,
      disable,
    })} />);
    await waitFor(() => expect(view.getByText("On")).toBeTruthy());
    expect(ownedAgents).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("switch", { name: "Turn off Computer use for Genie" }));
    await waitFor(() => expect(disable).toHaveBeenCalledTimes(1));
  });

  test("reports zero owned Genies without opening a PIN sheet", async () => {
    const enable = mock(async () => undefined);
    const view = render(<ComputerUseConnectionSection connection={connection({
      ownedAgents: async () => [],
      enable,
    })} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("do not own a Genie"));
    expect(view.queryByRole("heading", { name: "Turn on Computer use" })).toBeNull();
    expect(enable).not.toHaveBeenCalled();
  });

  test("supports PIN cancellation and retry while deduplicating a pending submit", async () => {
    let attempts = 0;
    let finishSecondAttempt: (() => void) | undefined;
    const enable = mock(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("Incorrect PIN");
      await new Promise<void>((resolve) => { finishSecondAttempt = resolve; });
    });
    const view = render(<ComputerUseConnectionSection connection={connection({ enable })} />);
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    fireEvent.click(view.getAllByRole("button", { name: "Cancel" })[1]!);
    expect(view.queryByRole("heading", { name: "Turn on Computer use" })).toBeNull();

    fireEvent.click(view.getByRole("switch", { name: "Turn on Computer use for Genie" }));
    const user = userEvent.setup({ document: globalThis.document });
    await user.type(view.getByPlaceholderText("••••••"), "847291");
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(view.getByRole("alert").textContent).toContain("Incorrect PIN"));
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    fireEvent.click(view.getByRole("button", { name: "Verify" }));
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(2));
    await act(async () => { finishSecondAttempt?.(); await Promise.resolve(); });
    await waitFor(() => expect(view.getByText("Off")).toBeTruthy());
  });
});
