import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";

const getDesktopRelayId = mock(async () => "relay-current");
const harnesses = mock(async () => ({
  harnesses: [{
    id: "hermes-acp",
    displayName: "Hermes",
    setup: { installation: "manual", activation: "user_initiated" },
    integration: { authentication: "existing_session", resume: "new_session_only" },
    declaredCapabilities: {
      execution: "supported",
      resume: "unsupported",
      stop: "unsupported",
      steer: "unsupported",
      requests: "unsupported",
    },
  }, {
    id: "opencode-acp",
    displayName: "OpenCode",
    setup: { installation: "manual", activation: "user_initiated" },
    integration: { authentication: "existing_session", resume: "new_session_only" },
    declaredCapabilities: {
      execution: "supported",
      resume: "unsupported",
      stop: "unsupported",
      steer: "unsupported",
      requests: "unsupported",
    },
  }],
}));
const readiness = mock(async () => ({
  state: "ready" as const,
  action: null,
}));
const getHermesStatus = mock(async () => ({ enabled: true, relay: "connected" as const }));
const enableHermes = mock(async () => ({ enabled: true, relay: "connected" as const }));
const disableHermes = mock(async () => ({ enabled: false, relay: "connected" as const }));
let relayListener: ((status: string) => void) | null = null;

import { HermesConnectionSection, OpenCodeConnectionSection, type HermesConnectionPorts } from "./hermes-connection-section";

const ports: HermesConnectionPorts = {
  getRelayId: getDesktopRelayId,
  listHarnesses: harnesses,
  inspectReadiness: readiness,
  getHermesStatus,
  enableHermes,
  disableHermes,
  onRelayStatusChanged: (callback) => {
    relayListener = callback;
    return () => { relayListener = null; };
  },
};

beforeEach(() => {
  reapplyHappyDomGlobals();
  cleanup();
  getDesktopRelayId.mockClear();
  getDesktopRelayId.mockImplementation(async () => "relay-current");
  harnesses.mockClear();
  readiness.mockClear();
  getHermesStatus.mockClear();
  enableHermes.mockClear();
  disableHermes.mockClear();
  getHermesStatus.mockImplementation(async () => ({ enabled: true, relay: "connected" as const }));
  readiness.mockImplementation(async () => ({
    state: "ready" as const,
    action: null,
  }));
});

describe("HermesConnectionSection", () => {
  test("shows exact desktop readiness without inventing accounts or Nautilo controls", async () => {
    const view = render(<HermesConnectionSection isDesktopShell ports={ports} />);

    expect(await view.findByText("Ready")).toBeTruthy();
    expect(view.getByText("Hermes is ready for a new Task on this desktop.")).toBeTruthy();
    expect(view.getByText("nautilo-acp")).toBeTruthy();
    expect(view.getByText("Managed in Hermes")).toBeTruthy();
    expect(view.getByText(/does not inspect Hermes accounts, keys/i)).toBeTruthy();
    expect(view.getByRole("switch", { name: "Disable Hermes" }).getAttribute("aria-checked")).toBe("true");
    expect(view.queryByText(/select account/i)).toBeNull();
    expect(harnesses).toHaveBeenCalledTimes(1);
    expect(readiness).toHaveBeenCalledWith("hermes-acp", "relay-current");
  });

  test("persists an explicit Hermes owner choice without starting a resident process", async () => {
    getHermesStatus.mockImplementation(async () => ({ enabled: false, relay: "connected" as const }));
    const view = render(<HermesConnectionSection isDesktopShell ports={ports} />);
    const toggle = await view.findByRole("switch", { name: "Enable Hermes" });
    expect(view.getByText(/Hermes is off/)).toBeTruthy();
    expect(readiness).not.toHaveBeenCalled();
    fireEvent.click(toggle);
    await waitFor(() => expect(enableHermes).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(readiness).toHaveBeenCalledWith("hermes-acp", "relay-current"));
    expect(view.getByText("A fresh ACP process starts for each accepted Task")).toBeTruthy();
  });

  test("waits for relay readiness and then checks automatically", async () => {
    getHermesStatus.mockImplementation(async () => ({ enabled: true, relay: "starting" as const }));
    const view = render(<HermesConnectionSection isDesktopShell ports={ports} />);
    expect(await view.findByText(/Waiting for the Desktop relay/)).toBeTruthy();
    expect(readiness).not.toHaveBeenCalled();
    relayListener?.("connected");
    await waitFor(() => expect(readiness).toHaveBeenCalledWith("hermes-acp", "relay-current"));
  });

  test("renders safe missing guidance and retries only on the explicit action", async () => {
    readiness.mockImplementation(async () => ({
      state: "missing" as const,
      action: "Install Hermes on this desktop, then retry.",
    }));
    const view = render(<HermesConnectionSection isDesktopShell ports={ports} />);

    expect(await view.findByText("Not installed")).toBeTruthy();
    expect(view.getByText("Install Hermes on this desktop, then retry.")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(readiness).toHaveBeenCalledTimes(2));
  });

  test("feature-detects desktop custody and does not probe from a browser", () => {
    const view = render(<HermesConnectionSection isDesktopShell={false} ports={ports} />);
    expect(view.getByText("Open Nautilo desktop to check Hermes.")).toBeTruthy();
    expect(view.queryByText("Checking")).toBeNull();
    expect(view.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(harnesses).not.toHaveBeenCalled();
    expect(readiness).not.toHaveBeenCalled();
  });

  test("shows OpenCode as a separate native-permission ACP harness", async () => {
    const view = render(<OpenCodeConnectionSection isDesktopShell ports={ports} />);
    expect(await view.findByText("OpenCode is ready for a new Task on this desktop.")).toBeTruthy();
    expect(view.getByText("opencode acp")).toBeTruthy();
    expect(view.getByText("Managed in OpenCode")).toBeTruthy();
    expect(view.getByText(/does not inspect OpenCode accounts, keys/i)).toBeTruthy();
    expect(readiness).toHaveBeenCalledWith("opencode-acp", "relay-current");
    expect(view.queryByRole("switch")).toBeNull();
  });
});
