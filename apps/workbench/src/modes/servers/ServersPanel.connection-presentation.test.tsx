import { beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { reapplyHappyDomGlobals } from "../../../tests/bun-dom-preload";

let presentationListener: ((snapshot: Record<string, unknown>) => void) | null = null;
let copied = "";
let copyFails = false;
let acceptedIds: string[] = [];
let acceptImpl = async (): Promise<{ ok: false; reason: "stale" }> => ({ ok: false, reason: "stale" });
type SwitchFailure = { ok: false; reason: "offline" } | { ok: false; reason: "wrong-server"; decisionId: string };
let finishSwitch: ((result: SwitchFailure) => void) | null = null;

const servers = {
  list: mock(async () => ({
    servers: [{ url: "https://a.test", iconUrl: "", connection: "live", active: false,
      signedIn: true, notificationSummary: { state: "unknown" } }],
    aggregate: { unreadCount: 0, importantUnreadCount: 0, unavailableServerCount: 0 },
  })),
  switchTo: mock(() => new Promise<SwitchFailure>((resolve) => { finishSwitch = resolve; })),
  acceptIdentity: mock((id: string) => { acceptedIds.push(id); return acceptImpl(); }),
  onConnectionPresentation: mock((listener: (snapshot: Record<string, unknown>) => void) => {
    presentationListener = listener;
    return () => { presentationListener = null; };
  }),
};

mock.module("../../lib/desktop", () => ({ desktopAPI: { servers } }));
const { ServersPanel } = await import("./ServersPanel");

beforeEach(() => {
  reapplyHappyDomGlobals();
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
    writeText: async (value: string) => { if (copyFails) throw new Error("denied"); copied = value; },
  } });
  Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
  cleanup();
  localStorage.clear();
  servers.switchTo.mockClear();
  presentationListener = null;
  finishSwitch = null;
  copied = "";
  copyFails = false;
  acceptedIds = [];
  acceptImpl = async () => ({ ok: false, reason: "stale" });
});

describe("ServersPanel connection presentation", () => {
  test("forwards the selected Workbench theme when switching servers", async () => {
    localStorage.setItem("nautilo-theme", "light");
    const view = render(<ServersPanel onCollapse={() => undefined} />);
    await waitFor(() => expect(view.getAllByText("a.test")).toHaveLength(2));

    fireEvent.click(view.getByRole("button", { name: /a\.test/i }));

    await waitFor(() => {
      expect(servers.switchTo).toHaveBeenCalledWith("https://a.test", "light");
    });
    await act(async () => finishSwitch?.({ ok: false, reason: "offline" }));
  });

  test("announces phase changes with an indeterminate activity indicator", async () => {
    const view = render(<ServersPanel onCollapse={() => undefined} />);
    await waitFor(() => expect(view.getAllByText("a.test")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: /a\.test/i }));
    await act(async () => {
      const supportReceipt = { version: 1, kind: "desktop-connection-failure", attemptRef: "conn_public",
        outcome: "failed", complete: false, failureCode: "health-unavailable",
        recovery: { retrySafe: false, validActions: ["cancel"] },
        pairing: { priorPairing: "present", stateChange: "unchanged" },
        phases: [{ phase: "verifying-server", visits: 1, durationMs: 9, outcome: "failed" }],
        omitted: ["server-url", "server-origin", "server-identity", "response-body", "provider-configuration",
          "credentials", "tokens", "internal-attempt-id", "authority-receipts"] };
      presentationListener?.({ version: 1, revision: 1, phase: "verifying-server",
        lastObservationAtMs: Date.now() - 2_000, retrySafe: false, validActions: ["cancel", "wait"],
        priorPairing: "present", pairingStateChange: "unchanged", failureCode: "health-unavailable", supportReceipt });
    });
    const status = view.getByRole("status");
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.textContent).toContain("Verifying the server");
    expect(status.querySelector("[aria-hidden='true']")?.children).toHaveLength(3);
    expect(status.textContent).not.toMatch(/\d+s (?:in this phase|since)/);
    await act(async () => finishSwitch?.({ ok: false, reason: "offline" }));
    expect(view.getByRole("alert").textContent).toContain("compatibility check");
    fireEvent.click(view.getByRole("button", { name: "Copy diagnostic details" }));
    await waitFor(() => expect(copied).toContain('"attemptRef": "conn_public"'));
    expect(view.getByText("Diagnostic details copied.")).toBeTruthy();
    copyFails = true;
    fireEvent.click(view.getByRole("button", { name: "Copy diagnostic details" }));
    await waitFor(() => expect(view.getByText("Could not copy diagnostic details.")).toBeTruthy());
    expect(view.getByRole("alert").textContent).toContain("current server remains active");
  });

  test("focuses identity recovery and delivers its exact decision once on stale", async () => {
    const view = render(<ServersPanel onCollapse={() => undefined} />);
    await waitFor(() => expect(view.getAllByText("a.test")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: /a\.test/i }));
    await act(async () => finishSwitch?.({ ok: false, reason: "wrong-server", decisionId: "decision-safe" }));
    const action = view.getByRole("button", { name: "Use this server identity" });
    await waitFor(() => expect(document.activeElement).toBe(action));
    fireEvent.click(action);
    await waitFor(() => expect(acceptedIds).toEqual(["decision-safe"]));
    expect((await view.findByRole("alert")).textContent).toContain("Select the server to retry");
  });

  test("keeps identity recovery actionable when acceptance rejects", async () => {
    acceptImpl = async () => { throw new Error("private rejection detail"); };
    const view = render(<ServersPanel onCollapse={() => undefined} />);
    await waitFor(() => expect(view.getAllByText("a.test")).toHaveLength(2));
    fireEvent.click(view.getByRole("button", { name: /a\.test/i }));
    await act(async () => finishSwitch?.({ ok: false, reason: "wrong-server", decisionId: "decision-rejected" }));
    fireEvent.click(await view.findByRole("button", { name: "Use this server identity" }));
    await waitFor(() => expect(acceptedIds).toEqual(["decision-rejected"]));
    expect((await view.findByRole("alert")).textContent).toContain("Select the server to retry");
    expect(view.queryByText(/private rejection detail/)).toBeNull();
  });
});
