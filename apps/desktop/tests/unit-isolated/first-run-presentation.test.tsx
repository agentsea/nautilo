import { beforeEach, describe, expect, test } from "bun:test";
import { reapplyHappyDomGlobals } from "../../../workbench/tests/bun-dom-preload";

let listener: ((snapshot: Record<string, unknown>) => void) | null = null;
let finish: ((result: Record<string, unknown>) => void) | null = null;
let copied = "";
let copyFails = false;
let confirmIds: string[] = [];
let acceptIds: string[] = [];
let commitImpl = () => new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
let confirmImpl = async (): Promise<Record<string, unknown>> => ({ ok: false, reason: "stale" });
let acceptImpl = async (): Promise<Record<string, unknown>> => ({ ok: false, reason: "stale" });
reapplyHappyDomGlobals();
Object.defineProperty(navigator, "clipboard", { configurable: true, value: {
  writeText: async (value: string) => { if (copyFails) throw new Error("denied"); copied = value; },
} });
Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
const { act, cleanup, fireEvent, render, waitFor } = await import("@testing-library/react");
Object.assign(window, { nautiloFirstRun: {
  getConnectTargets: async () => ({ candidates: [], recentServers: [], suggestedUrl: null,
    localDiscovery: { kind: "unavailable" }, mode: "first-run", currentServerUrl: null }),
  commit: () => commitImpl(),
  confirmDowngrade: (id: string) => { confirmIds.push(id); return confirmImpl(); },
  acceptIdentity: (id: string) => { acceptIds.push(id); return acceptImpl(); },
  abortAttempt: async () => true, cancel: async () => undefined,
  onConnectionPresentation: (cb: (snapshot: Record<string, unknown>) => void) => {
    listener = cb; return () => { listener = null; };
  },
} });
const { App } = await import("../../first-run/index");

beforeEach(() => {
  cleanup(); finish = null; copied = ""; copyFails = false;
  confirmIds = []; acceptIds = [];
  commitImpl = () => new Promise<Record<string, unknown>>((resolve) => { finish = resolve; });
  confirmImpl = async () => ({ ok: false, reason: "stale" });
  acceptImpl = async () => ({ ok: false, reason: "stale" });
});

describe("first-run connection presentation", () => {
  test("keeps a fresh install empty while showing public server guidance", async () => {
    const view = render(<App />);
    const input = await view.findByLabelText("Server URL");
    expect((input as HTMLInputElement).value).toBe("");
    expect(input.getAttribute("placeholder")).toBe("community.nautilo.dev");
  });

  test("replaces the server form with the normal setup surface while sign-in is in flight", async () => {
    const view = render(<App />);
    fireEvent.change(await view.findByLabelText("Server URL"), { target: { value: "alpha.example.test" } });
    fireEvent.click(view.getByRole("button", { name: /Connect/ }));
    const connectionScreen = await view.findByRole("main", { name: "Connecting to server" });
    expect(connectionScreen.getAttribute("style")).toContain("background: var(--bg)");
    expect(connectionScreen.getAttribute("style")).not.toContain("linear-gradient");
    expect(view.queryByLabelText("Server URL")).toBeNull();
    expect(view.getByRole("status").textContent).toContain("Preparing your secure sign-in");
    await act(async () => finish?.({ ok: false, reason: "cancelled" }));
    expect(await view.findByLabelText("Server URL")).toBeTruthy();
  });

  test("fences stale phases, shows indeterminate activity, and focuses identity action", async () => {
    const view = render(<App />);
    const input = await view.findByLabelText("Server URL");
    fireEvent.change(input, { target: { value: "alpha.example.test" } });
    fireEvent.click(view.getByRole("button", { name: /Connect/ }));
    const base = { version: 1, lastObservationAtMs: Date.now() - 2_000, retrySafe: false,
      validActions: ["cancel", "wait"], priorPairing: "present", pairingStateChange: "unchanged",
      failureCode: null, supportReceipt: null };
    await act(async () => listener?.({ ...base, revision: 2, phase: "verifying-server" }));
    await act(async () => listener?.({ ...base, revision: 1, phase: "contacting" }));
    const status = view.getByRole("status");
    expect(status.textContent).toContain("Verifying the server");
    expect(status.querySelector(".connection-activity")?.children).toHaveLength(3);
    expect(status.textContent).not.toMatch(/\d+s (?:in this phase|since)/);
    const supportReceipt = { version: 1, kind: "desktop-connection-failure", attemptRef: "conn_public",
      outcome: "failed", complete: false, failureCode: "setup-discovery-failed",
      recovery: { retrySafe: false, validActions: ["cancel"] },
      pairing: { priorPairing: "present", stateChange: "unchanged" },
      phases: [{ phase: "discovering-setup", visits: 1, durationMs: 12, outcome: "failed" }],
      omitted: ["server-url", "server-origin", "server-identity", "response-body", "provider-configuration",
        "credentials", "tokens", "internal-attempt-id", "authority-receipts"] };
    await act(async () => listener?.({ ...base, revision: 3, phase: "failed",
      failureCode: "setup-discovery-failed", supportReceipt }));
    await act(async () => finish?.({ ok: false, reason: "wrong-server", decisionId: "safe-decision" }));
    expect(view.getByRole("alert").textContent).toContain("could not check this server’s setup");
    fireEvent.click(view.getByRole("button", { name: "Copy diagnostic details" }));
    await waitFor(() => expect(copied).toBe(JSON.stringify(supportReceipt, null, 2)));
    expect(view.getByText("Diagnostic details copied.")).toBeTruthy();
    copyFails = true;
    fireEvent.click(view.getByRole("button", { name: "Copy diagnostic details" }));
    await waitFor(() => expect(view.getByText("Could not copy diagnostic details.")).toBeTruthy());
    const decision = view.getByRole("button", { name: "Use this server identity" });
    await waitFor(() => expect(document.activeElement).toBe(decision));
  });

  test("delivers each displayed downgrade and identity decision exactly once with actionable failures", async () => {
    commitImpl = async () => ({ ok: false, reason: "downgrade-confirmation-required", decisionId: "downgrade-exact" });
    const downgrade = render(<App />);
    fireEvent.change(await downgrade.findByLabelText("Server URL"), { target: { value: "http://alpha.example.test" } });
    fireEvent.click(downgrade.getByRole("button", { name: /Connect/ }));
    const confirm = await downgrade.findByRole("button", { name: "Confirm HTTP connection" });
    fireEvent.click(confirm);
    await waitFor(() => expect(confirmIds).toEqual(["downgrade-exact"]));
    expect((await downgrade.findByRole("alert")).textContent).toContain("replaced");

    cleanup();
    commitImpl = async () => ({ ok: false, reason: "wrong-server", decisionId: "identity-exact" });
    acceptImpl = async () => { throw new Error("renderer transport rejected"); };
    const identity = render(<App />);
    fireEvent.change(await identity.findByLabelText("Server URL"), { target: { value: "alpha.example.test" } });
    fireEvent.click(identity.getByRole("button", { name: /Connect/ }));
    const accept = await identity.findByRole("button", { name: "Use this server identity" });
    fireEvent.click(accept);
    await waitFor(() => expect(acceptIds).toEqual(["identity-exact"]));
    expect((await identity.findByRole("alert")).textContent).toContain("Connect again to retry safely");
  });

  test("turns an unexpected rejected commit into a focused actionable error", async () => {
    const originalError = console.error;
    const logged: unknown[][] = [];
    console.error = (...args: unknown[]) => { logged.push(args); };
    commitImpl = async () => { throw new Error("private transport detail"); };
    try {
      const view = render(<App />);
      const input = await view.findByLabelText("Server URL");
      fireEvent.change(input, { target: { value: "alpha.example.test" } });
      fireEvent.click(view.getByRole("button", { name: /Connect/ }));
      expect((await view.findByRole("alert")).textContent).toContain("Check the address and try again");
      const restoredInput = await view.findByLabelText("Server URL");
      await waitFor(() => expect(document.activeElement).toBe(restoredInput));
      expect(view.queryByText(/private transport detail/)).toBeNull();
      expect(JSON.stringify(logged)).not.toContain("private transport detail");
    } finally {
      console.error = originalError;
    }
  });
});
