import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { ReactNode } from "react";
import type {
  AgentAccessStatus,
  ReadyToWorkAggregateStatus,
  ReadyToWorkComponentId,
  ReadyToWorkSelection,
} from "../../../desktop/electron/ready-to-work-contract";
import type { DesktopReadyToWorkAPI } from "../../src/lib/desktop";
import { StartupSection } from "../../src/pages/settings/sections/startup-section";

const componentIds: ReadyToWorkComponentId[] = ["voice", "auto_approve", "workstation", "computer_use", "coding_connection"];

function status(mode: "standard" | "ready" | "needs_attention", overrides: Partial<ReadyToWorkAggregateStatus["components"][number]> = {}): ReadyToWorkAggregateStatus {
  return {
    mode,
    ...(mode === "needs_attention" ? { persistence: { reason: "unavailable" as const, liveAccess: "unchanged" as const } } : {}),
    components: componentIds.map((id) => ({
      id,
      state: mode === "standard" ? "off_by_choice" as const : "needs_attention" as const,
      reason: mode === "standard" ? "not_selected" as const : "restore_requested" as const,
      repairTarget: mode === "standard" ? null : "startup_settings" as const,
      ...(id === "computer_use" ? overrides : {}),
    })),
  };
}

function readyPort(initial: ReadyToWorkAggregateStatus) {
  let listener: ((next: ReadyToWorkAggregateStatus) => void) | null = null;
  const get = mock(async () => initial);
  const enroll = mock(async (_input: { selection: ReadyToWorkSelection; pin: string }) => status("ready"));
  const restore = mock(async () => status("ready"));
  const disable = mock(async () => status("standard"));
  const unsubscribe = mock(() => undefined);
  const api: DesktopReadyToWorkAPI = {
    get,
    enroll,
    restore,
    disable,
    onRestoreRendererOwners: () => () => undefined,
    acknowledgeRendererOwners: async () => undefined,
    reportRendererOwners: async () => initial,
    onStatusChanged: (next) => { listener = next; return unsubscribe; },
  };
  return {
    api,
    get,
    enroll,
    restore,
    disable,
    unsubscribe,
    emit: async (next: ReadyToWorkAggregateStatus) => {
      await act(async () => { listener?.(next); });
    },
  };
}

async function openPin(view: ReturnType<typeof render>) {
  fireEvent.click(view.getByRole("button", { name: /enable with PIN|Update with PIN/ }));
  await view.findByRole("heading", { name: /Enable Ready to work|Update Ready to work/ });
  const input = view.container.querySelector<HTMLInputElement>('input[type="password"]');
  if (!input) throw new Error("PIN input was not rendered");
  return input;
}

async function submitPin(view: ReturnType<typeof render>, input: HTMLInputElement, pin: string) {
  const user = userEvent.setup();
  await user.click(input);
  await user.keyboard(pin);
  await view.findByText("Press Enter to verify");
  await user.click(view.getByRole("button", { name: "Verify" }));
}

function renderStartup(node: ReactNode) {
  return render(<MemoryRouter>{node}<LocationProbe /></MemoryRouter>);
}

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.hash}`}</output>;
}

beforeEach(() => {
  reapplyHappyDomGlobals();
  window.localStorage.clear();
});
afterEach(() => cleanup());

describe("StartupSection", () => {
  test("selects Ready to work by default and keeps Individual controls as the fallback", async () => {
    const port = readyPort(status("standard"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    const ready = await view.findByRole("radio", { name: /^Ready to work\b/ });
    expect((ready as HTMLInputElement).checked).toBe(true);
    expect((view.getByRole("radio", { name: /Individual controls/ }) as HTMLInputElement).checked).toBe(false);
    expect(view.getByRole("button", { name: "Review and enable with PIN" })).toBeTruthy();
  });

  test("enables the default bundle through one PIN prompt", async () => {
    const port = readyPort(status("standard"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await view.findByRole("radio", { name: /^Ready to work\b/ });
    const input = await openPin(view);
    await submitPin(view, input, "123456");

    await waitFor(() => expect(port.enroll).toHaveBeenCalledTimes(1));
    expect(port.enroll).toHaveBeenCalledWith({
      selection: { voice: true, auto_approve: true, workstation: true, computer_use: true, coding_connection: true },
      pin: "123456",
    });
  });

  test("shows immediate validation progress while Ready enrollment is pending", async () => {
    const port = readyPort(status("standard"));
    let finishEnrollment!: (next: ReadyToWorkAggregateStatus) => void;
    port.enroll.mockImplementationOnce(() => new Promise((resolve) => {
      finishEnrollment = resolve;
    }));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await view.findByRole("radio", { name: /^Ready to work\b/ });
    const input = await openPin(view);
    await submitPin(view, input, "123456");

    const checking = await view.findByRole("button", { name: "Checking and enabling…" });
    expect((checking as HTMLButtonElement).disabled).toBe(true);
    expect(input.disabled).toBe(true);
    expect(view.getAllByRole("button", { name: "Cancel" })
      .every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
    expect(view.getAllByText("Checking and enabling…")).toHaveLength(2);

    await act(async () => { finishEnrollment(status("ready")); });
    await waitFor(() => expect(view.queryByRole("heading", { name: "Enable Ready to work" })).toBeNull());
  });

  test("sends an omitted core choice through the same PIN prompt", async () => {
    const port = readyPort(status("standard"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await view.findByRole("radio", { name: /^Ready to work\b/ });
    fireEvent.click(view.getByText(/Included choices/));
    fireEvent.click(view.getByRole("checkbox", { name: "Voice" }));
    expect(view.getByText("No coding harnesses are turned on in Connections.")).toBeTruthy();
    const input = await openPin(view);
    await submitPin(view, input, "12345678");

    await waitFor(() => expect(port.enroll).toHaveBeenCalledTimes(1));
    expect(port.enroll.mock.calls[0]?.[0]).toEqual({
      selection: { voice: false, auto_approve: true, workstation: true, computer_use: true, coding_connection: true },
      pin: "12345678",
    });
  });

  test("shows enabled coding harnesses in the included count before enrollment", async () => {
    const initial: ReadyToWorkAggregateStatus = {
      ...status("standard"),
      codingHarnesses: [
        { id: "codex", state: "ready", reason: null, repairTarget: "coding_connection_settings" },
        { id: "hermes-acp", state: "needs_attention", reason: "coding_harness_unavailable", repairTarget: "coding_connection_settings" },
      ],
    };
    const port = readyPort(initial);
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);

    await view.findByText("Included choices (6 of 6)");
    const codex = view.getByRole("checkbox", { name: "Codex included from Connections" }) as HTMLInputElement;
    const hermes = view.getByRole("checkbox", { name: "Hermes included from Connections" }) as HTMLInputElement;
    expect(codex.checked).toBe(true);
    expect(codex.disabled).toBe(true);
    expect(hermes.checked).toBe(true);
    expect(hermes.disabled).toBe(true);
  });

  test("updates enrolled status from the Desktop subscription", async () => {
    const port = readyPort(status("ready"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await waitFor(() => expect(view.getAllByText("Ready to work has not restored this choice yet.")).toHaveLength(5));
    await port.emit(status("ready", {
      state: "needs_attention",
      reason: "computer_use_screen_recording_required",
      repairTarget: "computer_use_settings",
    }));
    await view.findByText("Computer Use needs macOS Screen Recording.");
    expect(view.getByRole("button", { name: "Open macOS permissions" })).toBeTruthy();
  });

  test("routes an unavailable Computer Use driver to its actual control", async () => {
    const port = readyPort(status("ready"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await waitFor(() => expect(view.getAllByText("Ready to work has not restored this choice yet.")).toHaveLength(5));
    await port.emit(status("ready", {
      state: "needs_attention",
      reason: "computer_use_provider_unavailable",
      repairTarget: "computer_use_settings",
    }));
    fireEvent.click(await view.findByRole("button", { name: "Open Computer use" }));
    await waitFor(() => expect(view.getByTestId("location").textContent).toBe("/connections#computer-use"));
  });

  test("restores or turns off an enrolled posture without inventing another PIN step", async () => {
    const port = readyPort(status("ready"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await view.findByRole("button", { name: "Restore Ready" });
    fireEvent.click(view.getByRole("button", { name: "Restore Ready" }));
    await waitFor(() => expect(port.restore).toHaveBeenCalledTimes(1));

    fireEvent.click(view.getByRole("radio", { name: /Individual controls/ }));
    expect(window.localStorage.getItem("nautilo.ready-to-work.presentation-mode.v1")).toBe("ready");
    fireEvent.click(view.getByRole("button", { name: "Use individual controls" }));
    await waitFor(() => expect(port.disable).toHaveBeenCalledTimes(1));
    expect(window.localStorage.getItem("nautilo.ready-to-work.presentation-mode.v1")).toBe("individual");
    expect(view.container.querySelector('input[type="password"]')).toBeNull();
  });

  test("renders a bounded error and neither displays nor persists a PIN", async () => {
    const port = readyPort(status("standard"));
    port.enroll.mockRejectedValueOnce(new Error("raw Desktop secret 123456"));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await view.findByRole("radio", { name: /^Ready to work\b/ });
    const input = await openPin(view);
    await submitPin(view, input, "123456");

    await view.findByRole("alert");
    expect(view.getByRole("alert").textContent).toBe("Ready to work could not be enabled. Nothing was changed. Try again.");
    expect(document.body.textContent).not.toContain("raw Desktop secret 123456");
    expect(Array.from({ length: window.localStorage.length }, (_, index) => window.localStorage.key(index))).toEqual([]);
  });

  test("keeps saved choices untouched while persistence needs attention and confirms Off only on Standard", async () => {
    const attention: ReadyToWorkAggregateStatus = {
      ...status("needs_attention"),
      persistence: { reason: "changed", liveAccess: "unchanged" },
    };
    const port = readyPort(attention);
    port.disable.mockResolvedValueOnce({
      ...attention,
      persistence: { reason: "changed", liveAccess: "stopping" },
    });
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);

    expect(await view.findByText("Saved settings need attention. Check the individual controls for current access.")).toBeTruthy();
    expect(view.getByText("Retry the status check. Turning off Ready to work will be confirmed only when Desktop reports Standard.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Turn off Ready to work" }));
    await view.findByText("Stopping current access. Saved startup settings still need attention.");
    expect(window.localStorage.getItem("nautilo.ready-to-work.presentation-mode.v1")).toBeNull();
    expect(view.getByRole("button", { name: "Retry turn off" })).toBeTruthy();

    await port.emit(status("standard"));
    expect(view.queryByText("Needs attention")).toBeNull();
  });

  test("offers status retry and compatible Desktop guidance for unsupported saved settings", async () => {
    const unsupported: ReadyToWorkAggregateStatus = {
      ...status("needs_attention"),
      persistence: { reason: "unsupported", liveAccess: "unchanged" },
    };
    const port = readyPort(unsupported);
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);

    expect(await view.findByText("Use a compatible Desktop version to read these saved settings.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Retry status" }));
    await waitFor(() => expect(port.get).toHaveBeenCalledTimes(2));
    expect(view.getByRole("button", { name: "Turn off Ready to work" })).toBeTruthy();
  });

  test("does not let the initial status reply overwrite a newer Desktop subscription", async () => {
    const port = readyPort(status("standard"));
    let resolveInitial!: (next: ReadyToWorkAggregateStatus) => void;
    port.get.mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }));
    const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
    await port.emit({
      ...status("needs_attention"),
      persistence: { reason: "invalid", liveAccess: "stopping" },
    });
    await act(async () => {
      resolveInitial(status("ready"));
      await Promise.resolve();
    });

    expect(await view.findByText("Stopping current access. Saved startup settings still need attention.")).toBeTruthy();
    expect(view.queryByRole("button", { name: "Restore Ready" })).toBeNull();
  });
});

function componentPort(initial: ReadyToWorkAggregateStatus) {
  const port = readyPort(initial);
  const access: AgentAccessStatus = { sandboxedChoice: "development", choiceReason: "chosen_by_user", readiness: "ready", reason: null, repairAction: null,
    fullMac: { state: "inactive", eligible: true }, capabilities: { commands: true, interactiveContainedTerminals: true, fullMacOneShot: false } };
  const enrollComponents = mock(async (_input: { selection: Omit<ReadyToWorkSelection, "workstation">; pin: string }) => status("ready"));
  const disableComponents = mock(async () => status("standard"));
  const restoreComponents = mock(async () => status("ready"));
  Object.assign(port.api, { getAgentAccess: async () => access, chooseAgentAccess: async () => access, restoreDevelopment: async () => access,
    onAgentAccessChanged: () => () => {}, enrollComponents, disableComponents, restoreComponents });
  return { ...port, enrollComponents, disableComponents, restoreComponents };
}

test("new Startup edits the four component choices without submitting a Development selection", async () => {
  const initial = status("ready");
  initial.components = initial.components.map(component => component.id === "coding_connection" || component.id === "voice"
    ? { ...component, state: "off_by_choice", reason: "not_selected", repairTarget: null } : component);
  const port = componentPort(initial);
  const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
  await view.findByRole("button", { name: "Update with PIN" });
  expect(view.queryByRole("checkbox", { name: "Developer Workstation" })).toBeNull();
  const input = await openPin(view); await submitPin(view, input, "123456");
  await waitFor(() => expect(port.enrollComponents).toHaveBeenCalledTimes(1));
  expect(port.enrollComponents.mock.calls[0]?.[0]).toEqual({ selection: { voice: false, auto_approve: true, computer_use: true, coding_connection: false }, pin: "123456" });
  expect(port.enroll).toHaveBeenCalledTimes(0);
});

test("new Startup Restore and Off preserve Development through the narrow component owner", async () => {
  const port = componentPort(status("ready"));
  const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
  fireEvent.click(await view.findByRole("button", { name: "Restore Ready" }));
  await waitFor(() => expect(port.restoreComponents).toHaveBeenCalledTimes(1));
  fireEvent.click(view.getByRole("radio", { name: /Individual controls/ }));
  fireEvent.click(view.getByRole("button", { name: "Use individual controls" }));
  await waitFor(() => expect(port.disableComponents).toHaveBeenCalledTimes(1));
  expect(port.restore).toHaveBeenCalledTimes(0); expect(port.disable).toHaveBeenCalledTimes(0);
});

test("a partial new bridge never falls back to aggregate startup mutations", async () => {
  const port = componentPort(status("ready")); delete port.api.disableComponents;
  const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
  await view.findByText("A compatible Desktop is required to change startup components without changing Development.");
  expect((view.getByRole("button", { name: "Update with PIN" }) as HTMLButtonElement).disabled).toBe(true);
  expect((view.getByRole("button", { name: "Restore Ready" }) as HTMLButtonElement).disabled).toBe(true);
  expect(port.enroll).toHaveBeenCalledTimes(0); expect(port.restore).toHaveBeenCalledTimes(0); expect(port.disable).toHaveBeenCalledTimes(0);
});

test("narrow component Off remains Individual when aggregate Ready retains Development", async () => {
  const port = componentPort(status("ready"));
  port.disableComponents.mockImplementation(async () => ({ ...status("ready"), components: status("ready").components.map(component =>
    component.id === "workstation" ? component : { ...component, state: "off_by_choice", reason: "not_selected", repairTarget: null }) }));
  const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
  await view.findByRole("button", { name: "Restore Ready" });
  fireEvent.click(view.getByRole("radio", { name: /Individual controls/ }));
  fireEvent.click(view.getByRole("button", { name: "Use individual controls" }));
  await waitFor(() => expect((view.getByRole("radio", { name: /Individual controls/ }) as HTMLInputElement).checked).toBe(true));
  await waitFor(() => expect(view.queryByRole("button", { name: "Restore Ready" })).toBeNull());
  expect(port.disableComponents).toHaveBeenCalledTimes(1); expect(port.disable).toHaveBeenCalledTimes(0);
});

test("missing new component status does not fabricate a selected startup choice", async () => {
  const initial = status("ready"); initial.components = initial.components.filter(component => component.id === "workstation");
  const port = componentPort(initial);
  const view = renderStartup(<StartupSection isDesktopShell readyToWork={port.api} />);
  await waitFor(() => expect((view.getByRole("radio", { name: /Individual controls/ }) as HTMLInputElement).checked).toBe(true));
  fireEvent.click(view.getByRole("radio", { name: /^Ready to work/ }));
  expect((view.getByRole("checkbox", { name: "Voice" }) as HTMLInputElement).checked).toBe(false);
  expect((view.getByRole("checkbox", { name: "Auto-approve" }) as HTMLInputElement).checked).toBe(false);
  expect((view.getByRole("checkbox", { name: "Computer Use" }) as HTMLInputElement).checked).toBe(false);
  expect((view.getByRole("button", { name: "Review and enable with PIN" }) as HTMLButtonElement).disabled).toBe(true);
});
