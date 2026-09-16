import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ToolRendererProps } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const apiStub = {
  getConnectedWebAccountActionActivity: mock(async () => ({ deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "browsing" as const, canWatch: true, canStop: true, terminal: null })),
  watchConnectedWebAccountAction: mock(async () => ({ liveViewUrl: "https://live.browser-use.com/?opaque" })),
  stopConnectedWebAccountAction: mock(async () => ({ deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "finishing" as const, canWatch: false, canStop: false, terminal: "ambiguous" as const })),
  replyConnectedWebActionAttention: mock(async () => ({ ok: true as const })),
};
const requestWebsiteConnection = mock(() => true);
let currentClientActionSessionId = "session-1";
let renderer: (typeof import("./connected-web-account-action"))["connectedWebAccountActionRenderer"];
let root: Root | null = null; let container: HTMLDivElement | null = null;
beforeAll(async () => {
  mock.module("../../../lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../../adapters/website-connection-intent", () => ({ requestWebsiteConnection }));
  mock.module("../../../hooks/use-auth", () => ({ useAuth: () => ({ viewer: { sessionUserId: "user-1", sessionActorId: "actor-1" } }) }));
  mock.module("../../../lib/browser-crypto-installation", () => ({ readOrCreateBrowserCryptoInstallationId: () => "installation-1" }));
  mock.module("../../../lib/client-action-session", () => ({ currentClientActionSessionIdForResume: () => currentClientActionSessionId }));
  mock.module("@nautilo/lattice-bridge/client/browser", () => ({ deriveBrowserCryptoDeviceId: () => "device-1" }));
  ({ connectedWebAccountActionRenderer: renderer } = await import("./connected-web-account-action"));
});
beforeEach(() => {
  apiStub.getConnectedWebAccountActionActivity.mockImplementation(async () => ({ deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "browsing" as const, canWatch: true, canStop: true, terminal: null }));
  apiStub.watchConnectedWebAccountAction.mockImplementation(async () => ({ liveViewUrl: "https://live.browser-use.com/?opaque" }));
  apiStub.stopConnectedWebAccountAction.mockImplementation(async () => ({ deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "finishing" as const, canWatch: false, canStop: false, terminal: "ambiguous" as const }));
  apiStub.getConnectedWebAccountActionActivity.mockClear(); apiStub.watchConnectedWebAccountAction.mockClear(); apiStub.stopConnectedWebAccountAction.mockClear();
  apiStub.replyConnectedWebActionAttention.mockClear(); requestWebsiteConnection.mockClear();
  currentClientActionSessionId = "session-1";
});
afterEach(async () => { await act(async () => root?.unmount()); container?.remove(); root = null; container = null; });
async function render(value = "", state: ToolRendererProps["state"] = "running", resultTruncated = false) { container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container); const props: ToolRendererProps = { args: { target: "Project plan" }, result: undefined, state, event: { toolCallId: "tool-call", toolName: "act_connected_web_account", args: { target: "Project plan" }, status: "running", startedAt: 1 }, resultText: value, resultTruncated }; await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); await new Promise((resolve) => setTimeout(resolve, 10)); }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((next) => { resolve = next; }); return { promise, resolve }; }
const completed = { ok: true, status: "completed", action: "save_item", target: "Project plan", account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" }, receipt: { executionRef: "execution", effectState: "observed", postcondition: "saved", evidenceCode: "postcondition_observed", cost: { amountUsd: null, state: "unknown" } } };
describe("connectedWebAccountActionRenderer", () => {
  test("reuses the protected sign-in journey and replies to the exact action without a room message", async () => {
    const attention = {
      type: "connected_web.action_attention" as const, threadId: "thread-1", laneKey: "room-1", toolCallId: "tool-call", revision: 1,
      intervention: { kind: "authentication_required" as const, mode: "reconnect" as const, reason: "mfa" as const, account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" } },
    };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    const props: ToolRendererProps = { args: { target: "Project plan" }, result: undefined, state: "blocked", event: { toolCallId: "tool-call", toolName: "act_connected_web_account", args: { target: "Project plan" }, status: "running", startedAt: 1, laneKey: "room-1", connectedWebActionAttention: attention }, resultText: "", resultTruncated: false };
    await act(async () => { root!.render(<renderer.ExpandedBody {...props} />); });
    expect(container.textContent).toContain("Sign in to Notion");
    expect(container.textContent).toContain("Cancel save");
    const button = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Sign in to Notion");
    await act(async () => { button?.click(); });
    const intent = requestWebsiteConnection.mock.calls[0]?.[0] as { kind: string; accountId: string; onFinished: (outcome: "done" | "cancelled") => void };
    expect(intent).toMatchObject({ kind: "reconnect", accountId: attention.intervention.account.id });
    currentClientActionSessionId = "session-2";
    await act(async () => { intent.onFinished("done"); await Promise.resolve(); });
    expect(apiStub.replyConnectedWebActionAttention).toHaveBeenCalledWith({ threadId: "thread-1", laneKey: "room-1", toolCallId: "tool-call", decision: "done" }, { clientActionSessionId: "session-2", authorizationDeviceId: "device-1" });
    expect(container.textContent).toContain("Saving Project plan");
    await act(async () => {
      root!.render(<renderer.ExpandedBody {...{ ...props, event: { ...props.event!, connectedWebActionAttention: { ...attention, revision: 2 } } }} />);
      await Promise.resolve();
    });
    expect(container.textContent).not.toContain("continuing this exact save");
    const retry = Array.from(container.querySelectorAll("button")).find((candidate) => candidate.textContent === "Sign in to Notion");
    expect(retry).toBeTruthy();
    await act(async () => { retry?.click(); });
    const repeatedIntent = requestWebsiteConnection.mock.calls[1]?.[0] as { onFinished: (outcome: "done" | "cancelled") => void };
    await act(async () => { repeatedIntent.onFinished("cancelled"); await Promise.resolve(); });
    expect(apiStub.replyConnectedWebActionAttention).toHaveBeenLastCalledWith({ threadId: "thread-1", laneKey: "room-1", toolCallId: "tool-call", decision: "cancel" }, { clientActionSessionId: "session-2", authorizationDeviceId: "device-1" });
    expect(container.textContent).toContain("Waiting for Nautilo to confirm");
    expect(container.textContent).not.toContain("Sign-in cancelled");
  });
  test("uses one delivery-keyed activity line and owner controls", async () => {
    await render();
    expect(apiStub.getConnectedWebAccountActionActivity).toHaveBeenCalledWith("tool-call");
    expect(container?.textContent).toContain("Saving Project plan");
    const watch = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live");
    await act(async () => { watch?.click(); });
    expect(apiStub.watchConnectedWebAccountAction).toHaveBeenCalledWith("tool-call");
    const iframe = container?.querySelector("iframe");
    expect(iframe?.getAttribute("src")).toContain("live.browser-use.com");
    expect(iframe?.getAttribute("tabindex")).toBe("-1");
    expect(iframe?.className).toContain("pointer-events-none");
    expect(iframe?.getAttribute("allow")).toBeNull();
    const stop = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Stop");
    await act(async () => { stop?.click(); });
    expect(apiStub.stopConnectedWebAccountAction).toHaveBeenCalledWith("tool-call");
    expect(container?.textContent).toContain("may or may not have completed");
    expect(container?.textContent).toContain("Stop unconfirmed");
  });
  test("shows explicit bounded truth instead of spinning after a protected resume fails", async () => {
    const resumeFailure = { type: "connected_web.action_resume_failed" as const, threadId: "thread-1", laneKey: "room-1", toolCallId: "tool-call", cancelRecovery: "available" as const };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => {
      root!.render(<renderer.ExpandedBody args={{ target: "Project plan" }} result={undefined} state="running" event={{ toolCallId: "tool-call", toolName: "act_connected_web_account", args: { target: "Project plan" }, status: "running", startedAt: 1, connectedWebActionResumeFailed: resumeFailure }} resultText="" resultTruncated={false} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("could not safely resume or cancel this save");
    expect(container.textContent).toContain("original save remains parked");
    expect(apiStub.getConnectedWebAccountActionActivity).not.toHaveBeenCalled();
    const cancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel parked save");
    await act(async () => { cancel?.click(); await Promise.resolve(); });
    expect(apiStub.replyConnectedWebActionAttention).toHaveBeenCalledWith({
      threadId: "thread-1",
      laneKey: "room-1",
      toolCallId: "tool-call",
      decision: "cancel",
    }, { clientActionSessionId: "session-1", authorizationDeviceId: "device-1" });
    expect(container.textContent).toContain("Cancellation requested");
    await act(async () => {
      root!.render(<renderer.ExpandedBody args={{ target: "Project plan" }} result={undefined} state="error" event={{ toolCallId: "tool-call", toolName: "act_connected_web_account", args: { target: "Project plan" }, status: "running", startedAt: 1, connectedWebActionResumeFailed: { ...resumeFailure } }} resultText="" resultTruncated={false} />);
      await Promise.resolve();
    });
    const retryCancel = Array.from(container.querySelectorAll("button")).find((button) => button.textContent === "Cancel parked save");
    expect(retryCancel?.disabled).toBe(false);
  });
  test("does not offer a dead cancellation control without durable recovery proof", async () => {
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => {
      root!.render(<renderer.ExpandedBody args={{ target: "Project plan" }} result={undefined} state="error" event={{ toolCallId: "tool-call", toolName: "act_connected_web_account", args: { target: "Project plan" }, status: "running", startedAt: 1, connectedWebActionResumeFailed: { type: "connected_web.action_resume_failed", threadId: "thread-1", laneKey: "room-1", toolCallId: "tool-call", cancelRecovery: "unavailable" } }} resultText="" resultTruncated={false} />);
      await Promise.resolve();
    });
    expect(container.textContent).toContain("exact recovery is unavailable");
    expect(container.textContent).not.toContain("Cancel parked save");
    expect(apiStub.replyConnectedWebActionAttention).not.toHaveBeenCalled();
  });
  test("stops polling and remains truthful for ambiguous terminal activity", async () => {
    apiStub.getConnectedWebAccountActionActivity.mockImplementation(async () => ({ deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "finishing" as const, canWatch: false, canStop: false, terminal: "ambiguous" as const }));
    await render(); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
    expect(apiStub.getConnectedWebAccountActionActivity).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("may or may not have completed");
    expect(container?.textContent).not.toContain("was cancelled");
  });
  test("rejects provider-shaped terminal data without rendering it", async () => {
    await render(JSON.stringify({ ok: true, status: "completed", action: "save_item", target: "Project plan", account: { id: "account", label: "Notion", service: "Notion", origin: "https://www.notion.so", runId: "provider-run" }, receipt: { executionRef: "execution", effectState: "observed", postcondition: "saved", evidenceCode: "ok", cost: { amountUsd: null, state: "unknown" }, liveViewUrl: "https://provider.example/live" } }), "success");
    expect(container?.textContent).toContain("could not be displayed safely");
    expect(container?.innerHTML).not.toContain("provider-run");
    expect(container?.innerHTML).not.toContain("provider.example");
  });
  test("rejects malformed sealed successes and never green-lights a truncated receipt", async () => {
    const malicious = [
      { ...completed, account: { ...completed.account, id: "not-a-uuid" } },
      { ...completed, account: { ...completed.account, origin: "https://user:secret@www.notion.so" } },
      { ...completed, target: " " },
      { ...completed, receipt: { ...completed.receipt, executionRef: "" } },
      { ...completed, receipt: { ...completed.receipt, cost: { amountUsd: 1, state: "unknown" } } },
      { ...completed, unexpectedProviderField: "provider-secret" },
    ];
    for (const value of malicious) {
      await render(JSON.stringify(value), "success");
      expect(container?.textContent).toContain("could not be displayed safely");
      await act(async () => root?.unmount()); container?.remove(); root = null; container = null;
    }
    await render(JSON.stringify(completed), "success", true);
    expect(container?.textContent).toContain("truncated and cannot be confirmed");
    expect(container?.textContent).not.toContain("Completed");
  });
  test("a late Watch response cannot resurrect the iframe after Stop", async () => {
    const watch = deferred<{ liveViewUrl: string }>();
    apiStub.watchConnectedWebAccountAction.mockImplementation(async () => watch.promise);
    await render();
    const watchButton = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live");
    await act(async () => { watchButton?.click(); await Promise.resolve(); });
    const stopButton = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Stop");
    await act(async () => { stopButton?.click(); await Promise.resolve(); });
    await act(async () => { watch.resolve({ liveViewUrl: "https://live.browser-use.com/?opaque" }); await Promise.resolve(); });
    expect(container?.querySelector("iframe")).toBeNull();
    expect(container?.textContent).toContain("may or may not have completed");
  });
  test("a natural terminal activity invalidates an in-flight Watch response", async () => {
    const watch = deferred<{ liveViewUrl: string }>();
    let calls = 0;
    apiStub.getConnectedWebAccountActionActivity.mockImplementation(async () => {
      calls++;
      return calls === 1
        ? { deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "browsing" as const, canWatch: true, canStop: true, terminal: null }
        : { deliveryId: "tool-call", accountId: "11111111-1111-4111-8111-111111111111", action: "save_item" as const, stage: "finishing" as const, canWatch: false, canStop: false, terminal: "ambiguous" as const };
    });
    apiStub.watchConnectedWebAccountAction.mockImplementation(async () => watch.promise);
    await render();
    const watchButton = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live");
    await act(async () => { watchButton?.click(); await Promise.resolve(); });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1_020)); });
    await act(async () => { watch.resolve({ liveViewUrl: "https://live.browser-use.com/?opaque" }); await Promise.resolve(); });
    expect(container?.querySelector("iframe")).toBeNull();
    expect(container?.textContent).toContain("may or may not have completed");
  });
});
