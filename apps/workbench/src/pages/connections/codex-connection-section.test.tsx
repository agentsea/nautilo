import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { useEffect, type ReactElement } from "react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { act, cleanup, fireEvent, render as renderTesting, waitFor } from "@testing-library/react";

let state: "disabled" | "enabling" | "enabled" | "disabling" | "faulted" = "disabled";
const status = mock(async () => ({ state, ready: state === "enabled", relayReconciliation: null }));
const enable = mock(async () => { state = "enabled"; });
const disable = mock(async () => { state = "disabled"; });
const getDesktopRelayId = mock(async () => "relay-current");
const summary = mock(async () => null);
const inspectRuntime = mock(async () => ({ state: "absent", available: false, runtimeGeneration: null }));
const installRuntime = mock(async () => ({ state: "installing", available: false, runtimeGeneration: null }));
const cancelRuntimeInstall = mock(async () => ({ state: "absent", available: false, runtimeGeneration: null }));
const activateRuntime = mock(async () => ({ state: "ready", available: true, runtimeGeneration: 7 }));
const createProfile = mock(async () => ({
  loginRef: "login-ref",
  profile: {
    id: "11111111-1111-4111-8111-111111111111",
    label: "Codex account",
    accountEmail: null,
    authState: "login_pending" as const,
    registrationState: "provisional" as const,
    reconciliationState: "current" as const,
    planType: null,
    rateLimits: null,
    usage: null,
    usageObservedAt: null,
    lastErrorCode: null,
    revision: 0,
  },
}));
const startLogin = mock(async () => ({ loginRef: "login-ref" }));
const accountResult = { authState: "signed_out" as const, profile: {} };
const cancelLogin = mock(async () => accountResult);
const readAccount = mock(async () => accountResult);
const logout = mock(async () => accountResult);
const renameProfile = mock(async () => ({}));
const removeProfile = mock(async () => undefined);
const usage = mock(async () => ({
  summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
  daily: [],
  observedAt: "2026-08-01T10:00:00.000Z",
  freshness: "live" as const,
}));
const rateLimits = mock(async () => ({
  primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: "2026-08-01T12:00:00.000Z" },
  secondary: null,
  plan: "pro" as const,
  credits: null,
  spendControl: null,
  reached: null,
  observedAt: "2026-08-01T10:00:00.000Z",
  freshness: "live" as const,
}));
const userPreference = mock(async () => ({
  enabled: false,
  profileId: null,
  posture: "codex_default" as const,
  revision: 0,
}));
const setUserPreference = mock(async (input: {
  enabled: boolean;
  profileId: string | null;
  posture: "codex_default" | "prompted_workspace" | "full_access_headless";
  expectedRevision: number;
}) => ({ ...input, revision: input.expectedRevision + 1 }));

mock.module("../../lib/desktop", () => ({
  isDesktop: true,
  getDesktopRelayId,
  desktopAPI: { codexConnection: { status, enable, disable } },
}));
mock.module("../../lib/api", () => ({
  apiClient: { codex: { summary, inspectRuntime, installRuntime, cancelRuntimeInstall, activateRuntime, createProfile, startLogin, cancelLogin, readAccount, logout, renameProfile, removeProfile, usage, rateLimits, userPreference, setUserPreference } },
}));

const { CodexConnectionSection } = await import("./codex-connection-section");
let navigateTo: ((to: string) => void) | null = null;

function render(ui: ReactElement) {
  return renderTesting(<MemoryRouter initialEntries={["/connections"]}>{ui}</MemoryRouter>);
}

function NavigationCapture() {
  const navigate = useNavigate();
  useEffect(() => { navigateTo = navigate; }, [navigate]);
  return null;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  navigateTo = null;
  state = "disabled";
  status.mockClear();
  enable.mockClear();
  disable.mockClear();
  summary.mockClear();
  summary.mockImplementation(async () => null);
  inspectRuntime.mockClear();
  inspectRuntime.mockImplementation(async () => ({ state: "absent", available: false, runtimeGeneration: null }));
  installRuntime.mockClear();
  installRuntime.mockImplementation(async () => ({ state: "installing", available: false, runtimeGeneration: null }));
  cancelRuntimeInstall.mockClear();
  cancelRuntimeInstall.mockImplementation(async () => ({ state: "absent", available: false, runtimeGeneration: null }));
  activateRuntime.mockClear();
  activateRuntime.mockImplementation(async () => ({ state: "ready", available: true, runtimeGeneration: 7 }));
  createProfile.mockClear();
  userPreference.mockClear();
  userPreference.mockImplementation(async () => ({
    enabled: false,
    profileId: null,
    posture: "codex_default" as const,
    revision: 0,
  }));
  setUserPreference.mockClear();
  renameProfile.mockClear();
  removeProfile.mockClear();
  usage.mockClear();
  usage.mockImplementation(async () => ({
    summary: { lifetimeTokens: null, peakDailyTokens: null, longestRunningTurnSec: null, currentStreakDays: null, longestStreakDays: null },
    daily: [],
    observedAt: "2026-08-01T10:00:00.000Z",
    freshness: "live" as const,
  }));
  rateLimits.mockClear();
  rateLimits.mockImplementation(async () => ({
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: "2026-08-01T12:00:00.000Z" },
    secondary: null,
    plan: "pro" as const,
    credits: null,
    spendControl: null,
    reached: null,
    observedAt: "2026-08-01T10:00:00.000Z",
    freshness: "live" as const,
  }));
});

afterAll(() => {
  mock.restore();
});

describe("CodexConnectionSection", () => {
  test("reacts to a same-route Codex hash change by expanding and focusing its semantic anchor", async () => {
    const view = renderTesting(
      <MemoryRouter initialEntries={["/connections"]}>
        <NavigationCapture />
        <CodexConnectionSection />
      </MemoryRouter>,
    );
    const section = view.container.querySelector("#codex") as HTMLElement;
    const scrollIntoView = mock(() => undefined);
    const focus = mock(() => undefined);
    Object.assign(section, { scrollIntoView, focus });

    await waitFor(() => expect(navigateTo).not.toBeNull());
    await act(async () => { navigateTo?.("/connections#codex"); });
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" }));
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  test("feature-detects the desktop surface without exposing controls in a browser", () => {
    const view = render(<CodexConnectionSection isDesktopShell={false} />);
    expect(view.getByText("Open Nautilo desktop to connect Codex.")).toBeTruthy();
    expect(view.queryByRole("switch", { name: "Enable Codex" })).toBeNull();
    expect(status).not.toHaveBeenCalled();
  });

  test("renders a disabled state and only invokes the no-argument enable bridge", async () => {
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("switch", { name: "Enable Codex" })).toBeTruthy());
    expect(summary).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("switch", { name: "Enable Codex" }));
    await waitFor(() => expect(enable).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(view.getByText("Connecting")).toBeTruthy());
    expect(enable.mock.calls[0]).toEqual([]);
  });

  test("keeps local controls available and retries the server handoff", async () => {
    state = "enabled";
    let reads = 0;
    summary.mockImplementation(async () => {
      reads += 1;
      if (reads === 1) throw new Error("host status not published yet");
      return {
        runtime: { state: "ready", available: false, runtimeGeneration: 7 },
        profiles: [],
      };
    });
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("switch", { name: "Disable Codex" })).toBeTruthy());
    expect(view.getByText(/waiting for Nautilo to receive its status/i)).toBeTruthy();
    await waitFor(
      () => expect(view.getByText("Detected")).toBeTruthy(),
      { timeout: 2_000 },
    );
    expect(reads).toBeGreaterThanOrEqual(2);
  });

  test("keeps one slow summary request in flight and discards it after disable", async () => {
    state = "enabled";
    let settleSummary: (() => void) | undefined;
    const slowSummary = new Promise((resolve) => {
      settleSummary = () => resolve({
        runtime: { state: "ready", available: false, runtimeGeneration: 7 },
        profiles: [],
      });
    });
    summary.mockImplementation(() => slowSummary);

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(1));

    // The enabled-without-summary retry begins after one second. It must join
    // the pending cold inspection rather than queue a second server request.
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    });
    expect(summary).toHaveBeenCalledTimes(1);

    fireEvent.click(view.getByRole("switch", { name: "Disable Codex" }));
    await waitFor(() => expect(view.getByRole("switch", { name: "Enable Codex" })).toBeTruthy());
    await act(async () => {
      settleSummary?.();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(view.queryByText("Detected")).toBeNull();
  });

  test("projects stopping immediately while desktop disable is still pending", async () => {
    state = "enabled";
    let finishDisable: (() => void) | undefined;
    disable.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finishDisable = () => {
        state = "disabled";
        resolve();
      };
    }));

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("switch", { name: "Disable Codex" })).toBeTruthy());
    fireEvent.click(view.getByRole("switch", { name: "Disable Codex" }));

    await waitFor(() => expect(view.getByText("Codex is stopping…")).toBeTruthy());
    expect(view.queryByText("Connecting")).toBeNull();
    expect(summary).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishDisable?.();
      await Promise.resolve();
    });
    await waitFor(() => expect(view.getByRole("switch", { name: "Enable Codex" })).toBeTruthy());
  });

  test("stops the pending-summary retry when the section unmounts", async () => {
    state = "enabled";
    let settleSummary: (() => void) | undefined;
    const slowSummary = new Promise((resolve) => {
      settleSummary = () => resolve({
        runtime: { state: "ready", available: false, runtimeGeneration: 7 },
        profiles: [],
      });
    });
    summary.mockImplementation(() => slowSummary);

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(summary).toHaveBeenCalledTimes(1));

    // Resolving after unmount must neither schedule another retry nor attempt
    // a late render into this detached section.
    view.unmount();
    await act(async () => {
      settleSummary?.();
      await Promise.resolve();
    });
    await new Promise((resolve) => window.setTimeout(resolve, 1_100));
    expect(summary).toHaveBeenCalledTimes(1);
  });

  test("treats a terminal fault as restart-only recovery", async () => {
    state = "faulted";
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText("Restart Nautilo to recover Codex.")).toBeTruthy());
    expect(view.getByRole("switch", { name: "Enable Codex" }).hasAttribute("disabled")).toBe(true);
    expect(view.queryByRole("switch", { name: "Disable Codex" })).toBeNull();
  });

  test("keeps the opaque login reference out of the account card", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: "11111111-1111-4111-8111-111111111111",
        label: "Work account",
        authState: "signed_out",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("button", { name: "Choose account" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Choose account" }));
    await waitFor(() => expect(view.getByRole("button", { name: "Cancel sign in" })).toBeTruthy());
    expect(startLogin).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(view.queryByText("login-ref")).toBeNull();
  });

  test("activates only an inactive runtime with a canonical generation", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: false, runtimeGeneration: 7 },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("button", { name: "Use this Codex" })).toBeTruthy());
    expect(view.getByText("Activate a compatible runtime before adding or signing in to an account.")).toBeTruthy();
    expect(view.getByRole("button", { name: "Connect Codex account" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Use this Codex" }));
    await waitFor(() => expect(activateRuntime).toHaveBeenCalledWith(7, "relay-current"));
  });

  test("renders a managed transfer receipt and keeps cancellation actionable", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "installing", available: false, runtimeGeneration: null, source: "managed", version: "1.2.3", installation: { phase: "downloading", receivedBytes: 64 * 1024, totalBytes: 128 * 1024, canCancel: true } },
      profiles: [],
    }));

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText("Installing")).toBeTruthy());
    expect(view.getByText("Managed runtime · v1.2.3")).toBeTruthy();
    expect(view.getByText(/Managed install: Downloading · 64 KiB of 128 KiB/i)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Cancel installation" }));
    await waitFor(() => expect(cancelRuntimeInstall).toHaveBeenCalledTimes(1));
  });

  test("re-inspects and activates a managed runtime after its install completes", async () => {
    state = "enabled";
    let runtime: { state: "absent" | "installing" | "ready"; available: boolean; runtimeGeneration: number | null } = {
      state: "absent",
      available: false,
      runtimeGeneration: null,
    };
    summary.mockImplementation(async () => ({ runtime, profiles: [] }));
    installRuntime.mockImplementation(async () => {
      runtime = { state: "installing", available: false, runtimeGeneration: null };
      return runtime;
    });
    inspectRuntime.mockImplementation(async () => {
      runtime = { state: "ready", available: false, runtimeGeneration: 7 };
      return runtime;
    });
    activateRuntime.mockImplementation(async (runtimeGeneration: number) => {
      expect(runtimeGeneration).toBe(7);
      runtime = { state: "ready", available: true, runtimeGeneration };
      return runtime;
    });

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("button", { name: "Install Codex" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Install Codex" }));
    await waitFor(() => expect(view.getByText("Installing")).toBeTruthy());

    runtime = { state: "ready", available: false, runtimeGeneration: null };
    await waitFor(() => expect(inspectRuntime).toHaveBeenCalledTimes(1), { timeout: 3_000 });
    await waitFor(() => expect(activateRuntime).toHaveBeenCalledWith(7, "relay-current"));
    await waitFor(() => expect(view.getByText("Active")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Use this Codex" })).toBeNull();
  });

  test("offers an explicit retry after a managed install failure", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "failed", available: false, runtimeGeneration: null },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByRole("button", { name: "Retry install" })).toBeTruthy());
    expect(view.getByText(/could not install or verify Codex/i)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry install" }));
    await waitFor(() => expect(installRuntime).toHaveBeenCalledTimes(1));
  });

  test("preserves completed bytes and explains a managed runtime health failure", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: {
        state: "failed",
        available: false,
        runtimeGeneration: null,
        source: "managed",
        version: "0.146.0",
        installation: {
          phase: "failed",
          receivedBytes: 104581332,
          totalBytes: 104581332,
          canCancel: false,
          code: "CODEX_RUNTIME_UNHEALTHY",
        },
      },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText(/Managed install: Failed · 102130 KiB of 102130 KiB/i)).toBeTruthy());
    expect(view.getByText(/downloaded and passed artifact verification/i)).toBeTruthy();
    expect(view.getByText(/did not pass Nautilo's startup check/i)).toBeTruthy();
  });

  test("explains an incompatible external runtime and offers the reviewed managed fallback", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: {
        state: "incompatible",
        available: false,
        runtimeGeneration: null,
        source: "external",
        version: "0.146.0-alpha.3.1",
        compatibilityDiagnostics: [{
          feature: "core" as const,
          reason: "changed_field_shape" as const,
        }],
      },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText("External runtime incompatible")).toBeTruthy());
    expect(view.getByText("External runtime · v0.146.0-alpha.3.1")).toBeTruthy();
    expect(view.getByText(/app-server protocol is incompatible with this Nautilo build/i)).toBeTruthy();
    expect(view.getByText(/Compatibility check — Core conversations: a protocol field has an unsafe shape/i)).toBeTruthy();
    expect(view.getByText(/existing Codex installation and data will not be changed/i)).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Install reviewed runtime" }));
    await waitFor(() => expect(installRuntime).toHaveBeenCalledTimes(1));
  });

  test("explains the exact disabled feature for a limited external runtime", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: {
        state: "limited",
        available: true,
        runtimeGeneration: 7,
        source: "external",
        version: "0.146.0-alpha.3.1",
        compatibilityDiagnostics: [{
          feature: "request_user_input" as const,
          reason: "changed_field_shape" as const,
        }],
      },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText("Active (limited)")).toBeTruthy());
    expect(view.getByText(/Compatibility check — Questions for you: a protocol field has an unsafe shape/i)).toBeTruthy();
    expect(view.queryByRole("button", { name: "Install reviewed runtime" })).toBeNull();
  });

  test("configures one owner default without selecting a Genie", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: false,
      profileId,
      posture: "codex_default" as const,
      revision: 4,
    }));

    const view = render(<CodexConnectionSection />);
    await waitFor(() => expect(view.getByText("Genie access")).toBeTruthy());
    expect(view.queryByText(/select.*genie/i)).toBeNull();
    expect(view.getByText(/Account and default changes affect only new Codex Tasks and threads/i)).toBeTruthy();
    fireEvent.click(view.getByRole("switch", { name: "Enable Codex" }));
    await waitFor(() => expect(setUserPreference).toHaveBeenCalledWith({
      enabled: true,
      profileId,
      posture: "codex_default",
      expectedRevision: 4,
    }));
  });

  test("shows provider identity and disambiguates duplicate unsigned account slots", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          label: "Primary",
          accountEmail: "work@example.test",
          authState: "signed_in" as const,
          planType: "pro",
          rateLimits: null,
          usage: null,
          usageObservedAt: null,
          lastErrorCode: null,
          revision: 1,
        },
        ...["22222222-2222-4222-8222-222222222222", "33333333-3333-4333-8333-333333333333"].map((id) => ({
          id,
          label: "Primary",
          accountEmail: null,
          authState: "signed_out" as const,
          planType: null,
          rateLimits: null,
          usage: null,
          usageObservedAt: null,
          lastErrorCode: null,
          revision: 1,
        })),
      ],
    }));

    const view = render(<CodexConnectionSection />);
    expect(await view.findByText("work@example.test")).toBeTruthy();
    expect(view.getByText("Primary · Slot 1")).toBeTruthy();
    expect(view.getByText("Primary · Slot 2")).toBeTruthy();
    expect(view.getByRole("option", { name: "work@example.test · Pro" })).toBeTruthy();
    expect(view.getAllByRole("button", { name: "Choose account" })).toHaveLength(2);
  });

  test("collapses the management surface to a useful connection summary", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: {
        state: "ready",
        available: true,
        runtimeGeneration: 7,
        source: "external" as const,
        version: "0.146.0",
      },
      profiles: [{
        id: profileId,
        label: "Work account",
        accountEmail: "work@example.test",
        authState: "signed_in" as const,
        planType: "pro",
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: true,
      profileId,
      posture: "full_access_headless" as const,
      revision: 4,
    }));

    const view = render(<CodexConnectionSection />);
    await view.findByLabelText("Default account");
    fireEvent.click(view.getByRole("button", { name: "Collapse" }));

    expect(view.queryByLabelText("Default account")).toBeNull();
    expect(view.getByText("External runtime · v0.146.0 · work@example.test · Full access")).toBeTruthy();
    const expand = view.getByRole("button", { name: "Expand" });
    expect(expand.getAttribute("aria-expanded")).toBe("false");
    const header = expand.closest("header");
    expect(header?.className).not.toContain("flex-wrap");
    expect(header?.firstElementChild?.className).toContain("flex-1");
    expect(expand.parentElement?.className).toContain("shrink-0");
    fireEvent.click(expand);
    expect(view.getByLabelText("Default account")).toBeTruthy();
  });

  test("selecting a signed-in default enables Codex and clearing it disables Codex", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Primary",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));

    const view = render(<CodexConnectionSection />);
    const account = await view.findByLabelText("Default account");

    fireEvent.change(account, { target: { value: profileId } });
    await waitFor(() => expect(setUserPreference).toHaveBeenLastCalledWith({
      enabled: true,
      profileId,
      posture: "codex_default",
      expectedRevision: 0,
    }));

    setUserPreference.mockClear();
    fireEvent.change(account, { target: { value: "" } });
    await waitFor(() => expect(setUserPreference).toHaveBeenLastCalledWith({
      enabled: false,
      profileId: null,
      posture: "codex_default",
      expectedRevision: 1,
    }));
  });

  test("keeps account controls inline, refreshes safe usage, and requires explicit removal", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: "pro",
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: "AUTH_TOKEN_SECRET",
        revision: 3,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: true,
      profileId,
      posture: "codex_default" as const,
      revision: 4,
    }));

    const view = render(<CodexConnectionSection />);
    await view.findByRole("button", { name: "Account actions for Work account" });
    expect(view.queryByText("AUTH_TOKEN_SECRET")).toBeNull();

    const actions = view.getByRole("button", { name: "Account actions for Work account" });
    fireEvent.click(actions);
    expect(actions.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(document, { key: "Escape" });
    expect(view.queryByRole("menu", { name: "Account actions for Work account" })).toBeNull();
    fireEvent.click(actions);
    fireEvent.click(view.getByRole("menuitem", { name: "Rename" }));
    await act(async () => {
      fireEvent.change(view.getByLabelText("Rename Work account"), { target: { value: "Personal" } });
    });
    expect((view.getByLabelText("Rename Work account") as HTMLInputElement).value).toBe("Personal");
    fireEvent.click(view.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(renameProfile).toHaveBeenCalledWith(profileId, "Personal", 3));

    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Refresh usage" }));
    await waitFor(() => expect(usage).toHaveBeenCalledWith(profileId));
    expect(rateLimits).toHaveBeenCalledWith(profileId);
    await waitFor(() => expect(view.getByText("Primary 25% used")).toBeTruthy());
    expect(view.getByText("Usage live")).toBeTruthy();
    expect(view.getAllByText("Pro")).toHaveLength(1);

    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
    expect(view.getByText("Remove this account?")).toBeTruthy();
    expect(removeProfile).not.toHaveBeenCalled();
    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByText("Remove this account?")).toBeNull();

    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(view.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removeProfile).toHaveBeenCalledWith(profileId, 3));
  });

  test("requires a compact explicit confirmation before saving full access", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: true,
      profileId,
      posture: "prompted_workspace" as const,
      revision: 8,
    }));

    const view = render(<CodexConnectionSection />);
    const permissions = await view.findByLabelText("Codex permissions");
    fireEvent.change(permissions, { target: { value: "full_access_headless" } });
    expect(setUserPreference).not.toHaveBeenCalled();
    expect(view.getByRole("alert", { name: "Confirm full access" })).toBeTruthy();
    expect(view.getByText(/Codex may run commands and modify files without Nautilo approval/i)).toBeTruthy();

    fireEvent.click(view.getByRole("button", { name: "Cancel" }));
    expect(view.queryByRole("alert", { name: "Confirm full access" })).toBeNull();

    fireEvent.change(permissions, { target: { value: "full_access_headless" } });
    fireEvent.click(view.getByRole("button", { name: "Enable full access" }));
    await waitFor(() => expect(setUserPreference).toHaveBeenCalledWith({
      enabled: true,
      profileId,
      posture: "full_access_headless",
      expectedRevision: 8,
    }));
    expect(view.getByText(/never mutate a running Codex binding/i)).toBeTruthy();
  });

  test("keeps permission and Genie controls local until a default account is selected", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: "11111111-1111-4111-8111-111111111111",
        label: "Work account",
        authState: "signed_in" as const,
        planType: "pro",
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));

    const view = render(<CodexConnectionSection />);
    const permissions = await view.findByLabelText("Codex permissions");
    const genieAccess = view.getByRole("switch", { name: "Enable Codex" });
    expect(permissions.hasAttribute("disabled")).toBe(true);
    expect(genieAccess.hasAttribute("disabled")).toBe(true);
    expect(view.getByText("Choose a default account first.")).toBeTruthy();

    fireEvent.change(permissions, { target: { value: "full_access_headless" } });
    fireEvent.click(genieAccess);
    expect(setUserPreference).not.toHaveBeenCalled();
    expect(view.queryByText("Codex connection could not be updated.")).toBeNull();
  });

  test("keeps a failed defaults write adjacent to the compact form", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{ id: profileId, label: "Work account", authState: "signed_in" as const, planType: "pro", rateLimits: null, usage: null, usageObservedAt: null, lastErrorCode: null, revision: 1 }],
    }));
    setUserPreference.mockImplementationOnce(async () => { throw new Error("CODEX_CONFLICT"); });

    const view = render(<CodexConnectionSection />);
    fireEvent.change(await view.findByLabelText("Default account"), { target: { value: profileId } });
    expect(await view.findByText("Codex defaults could not be saved. Try again.")).toBeTruthy();
    expect(view.queryByText("Codex connection could not be updated.")).toBeNull();
    expect(view.queryByText("CODEX_CONFLICT")).toBeNull();
  });

  test("retains successful usage when rate-limit refresh is unavailable", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 1,
      }],
    }));
    rateLimits.mockImplementation(async () => {
      throw new Error("unsupported by runtime");
    });

    const view = render(<CodexConnectionSection />);
    await view.findByRole("button", { name: "Account actions for Work account" });
    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Refresh usage" }));

    await waitFor(() => expect(view.getByText("Usage live")).toBeTruthy());
    expect(view.getByText("Rate limits unavailable")).toBeTruthy();
    expect(view.queryByText("Codex connection could not be updated.")).toBeNull();
  });

  test("keeps the server-selected default visible after a failed account removal", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 6,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: true,
      profileId,
      posture: "codex_default" as const,
      revision: 9,
    }));
    removeProfile.mockImplementation(async () => {
      throw new Error("CODEX_CONFLICT");
    });

    const view = render(<CodexConnectionSection />);
    await view.findByRole("button", { name: "Account actions for Work account" });
    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(view.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(view.getByText("Codex connection could not be updated.")).toBeTruthy());
    expect((view.getByLabelText("Default account") as HTMLSelectElement).value).toBe(profileId);
    expect(view.getAllByText("Work account").length).toBeGreaterThan(0);
    expect(view.queryByText("CODEX_CONFLICT")).toBeNull();
  });

  test("uses refreshed server truth to clear a removed default", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    let removed = false;
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: removed ? [] : [{
        id: profileId,
        label: "Work account",
        authState: "signed_in",
        planType: null,
        rateLimits: null,
        usage: null,
        usageObservedAt: null,
        lastErrorCode: null,
        revision: 6,
      }],
    }));
    userPreference.mockImplementation(async () => ({
      enabled: !removed,
      profileId: removed ? null : profileId,
      posture: "codex_default" as const,
      revision: removed ? 10 : 9,
    }));
    removeProfile.mockImplementation(async () => {
      removed = true;
    });

    const view = render(<CodexConnectionSection />);
    await view.findByRole("button", { name: "Account actions for Work account" });
    fireEvent.click(view.getByRole("button", { name: "Account actions for Work account" }));
    fireEvent.click(view.getByRole("menuitem", { name: "Remove" }));
    fireEvent.click(view.getByRole("button", { name: "Remove" }));

    await waitFor(() => expect(view.getByText("Account not connected.")).toBeTruthy());
    expect((view.getByLabelText("Default account") as HTMLSelectElement).value).toBe("");
  });

  test("connects without a label form and keeps the internal provisional label hidden", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [],
    }));
    const view = render(<CodexConnectionSection />);
    const connect = await view.findByRole("button", { name: "Connect Codex account" });
    expect(view.getByText(/first connected account becomes the default/i)).toBeTruthy();
    expect(view.queryByLabelText("Account label")).toBeNull();
    fireEvent.click(connect);
    await waitFor(() => expect(createProfile).toHaveBeenCalledWith("relay-current"));
  });

  test("shows only canonical cleanup for a stranded provisional account", async () => {
    state = "enabled";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: "11111111-1111-4111-8111-111111111111",
        label: "Codex account",
        accountEmail: null,
        authState: "login_pending" as const,
        registrationState: "provisional" as const,
        reconciliationState: "cleanup_required" as const,
        planType: null, rateLimits: null, usage: null, usageObservedAt: null, lastErrorCode: null, revision: 4,
      }],
    }));
    const view = render(<CodexConnectionSection />);
    expect(await view.findByText("Cleanup required")).toBeTruthy();
    expect(view.getByRole("button", { name: "Finish cleanup" })).toBeTruthy();
    expect(view.getByRole("button", { name: "Connect Codex account" }).hasAttribute("disabled")).toBe(true);
    expect(view.queryByText("Codex account")).toBeNull();
    expect(view.queryByRole("button", { name: /Account actions/ })).toBeNull();
  });

  test("retains a reconnecting default visibly but disables Genie and account mutations", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId, label: "Work account", accountEmail: "work@example.test",
        authState: "signed_in" as const, registrationState: "registered" as const,
        reconciliationState: "reconnecting" as const,
        planType: "pro", rateLimits: null, usage: null, usageObservedAt: null, lastErrorCode: null, revision: 8,
      }],
    }));
    userPreference.mockImplementation(async () => ({ enabled: true, profileId, posture: "codex_default" as const, revision: 2 }));
    const view = render(<CodexConnectionSection />);
    expect(await view.findByText("Reconnecting")).toBeTruthy();
    const account = view.getByLabelText("Default account") as HTMLSelectElement;
    expect(account.value).toBe(profileId);
    expect(view.getByRole("option", { name: "work@example.test · Pro · Reconnecting" })).toBeTruthy();
    expect(view.getByText(/Genie availability: Unavailable/)).toBeTruthy();
    expect(view.queryByText("Available to all non-Guest Genies")).toBeNull();
    expect(view.queryByRole("button", { name: /Account actions/ })).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Collapse" }));
    expect(view.getByText(/work@example.test · Reconnecting · Genie unavailable/)).toBeTruthy();
  });

  test("retries first-default refresh after a transient preference read failure", async () => {
    state = "enabled";
    const profileId = "11111111-1111-4111-8111-111111111111";
    summary.mockImplementation(async () => ({
      runtime: { state: "ready", available: true, runtimeGeneration: 7 },
      profiles: [{
        id: profileId, label: "Work account", accountEmail: "work@example.test",
        authState: "signed_in" as const, registrationState: "registered" as const,
        reconciliationState: "current" as const,
        planType: "plus", rateLimits: null, usage: null, usageObservedAt: null, lastErrorCode: null, revision: 2,
      }],
    }));
    readAccount.mockImplementation(async () => ({
      authState: "signed_in" as const,
      profile: { id: profileId },
    }));
    let preferenceReads = 0;
    userPreference.mockImplementation(async () => {
      preferenceReads += 1;
      if (preferenceReads === 2) throw new Error("temporary");
      return preferenceReads >= 3
        ? { enabled: true, profileId, posture: "codex_default" as const, revision: 1 }
        : { enabled: false, profileId: null, posture: "codex_default" as const, revision: 0 };
    });
    const view = render(<CodexConnectionSection />);
    fireEvent.click(await view.findByRole("button", { name: "Connect Codex account" }));
    await waitFor(() => expect(view.getByText("Genie availability: Available for new Codex work")).toBeTruthy(), { timeout: 6_500 });
    expect(preferenceReads).toBeGreaterThanOrEqual(3);
  });
});
