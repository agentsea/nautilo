import "../../../../tests/bun-dom-preload";
import { afterEach, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import type { ConnectedWebOperationProjection } from "@nautilo/types";
import type { ToolRendererProps } from "./types";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const image = {
  id: "internal-image", artifactId: "artifact-image", path: "captures/dashboard.png", mimeType: "image/png", size: 1024,
  revision: 1, updatedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", namespaceIds: [], canWrite: true,
};
const report = {
  id: "internal-report", artifactId: "artifact-report", path: "connected-web/0123456789abcdef-report.pdf", mimeType: "application/pdf", size: 2048,
  revision: 1, updatedAt: "2026-09-01T00:00:00.000Z", createdAt: "2026-09-01T00:00:00.000Z", namespaceIds: [], canWrite: true,
};
const apiStub = {
  getRoom: mock(async () => ({ members: [{
    actorId: "33333333-3333-4333-8333-333333333333",
    agentId: "22222222-2222-4222-8222-222222222222",
    kind: "agent" as const,
    displayName: "Moxie",
    roomRole: "member" as const,
  }] })),
  listWorkspaceArtifacts: mock(async () => ({ artifacts: [image, report] })),
  downloadArtifact: mock(async () => undefined),
  listConnectedWebAccounts: mock(async () => ({ accounts: [] })),
  getConnectedWebOperation: mock(async (): Promise<ConnectedWebOperationProjection> => ({ operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted" as const, lifecycle: "running" as const, controlEpoch: 1, activity: { phase: "working" as const, code: "browsing", summary: "Reading and navigating the website…" }, receipt: null, canWatch: true, canStop: true, result: null })),
  watchConnectedWebOperation: mock(async () => ({ liveViewUrl: "https://live.browser-use.com/?opaque" })),
  stopConnectedWebOperation: mock(async () => ({ operationId: "44444444-4444-4444-8444-444444444444", driver: "checking" as const, lifecycle: "running" as const, controlEpoch: 1, activity: { phase: "checking" as const, code: "stop_reconciliation_scheduled", summary: "Stop was requested; Nautilo is reconciling the connected website operation." }, receipt: null, canWatch: false, canStop: true, result: null })),
};
const requestOpenFile = mock(() => true);
const requestWebsiteConnection = mock(() => true);
const sendOrdinaryRoomMessage = mock(async () => ({ accepted: true, messageId: 1, jobId: "job-1", attachments: [], coalesced: false }));
let renderer: (typeof import("./connected-web-account-read"))["connectedWebAccountReadRenderer"];
let publishConnectedWebAccountRefresh: (typeof import("../../../adapters/connected-web-account-refresh"))["publishConnectedWebAccountRefresh"];
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const payload = {
  ok: true,
  status: "completed",
  account: { id: "11111111-1111-4111-8111-111111111111", label: "Notion", service: "Notion", origin: "https://www.notion.so" },
  read: {
    answer: "The project is ready.", facts: [{ label: "Status", value: "Ready" }], completeness: "complete",
    provenance: "authenticated_website", origin: "https://www.notion.so",
  },
  cost: { currency: "USD", amountUsd: 0, state: "actual" },
  page: { ref: "11111111-1111-4111-8111-111111111111", title: "Notion", origin: "https://www.notion.so" },
  outputs: [
    { artifactId: "artifact-image", path: "captures/dashboard.png", mime: "image/png", bytes: 1024 },
    { artifactId: "artifact-report", path: "connected-web/0123456789abcdef-report.pdf", mime: "application/pdf", bytes: 2048 },
  ],
  outputsTruncated: false,
};

beforeAll(async () => {
  mock.module("../../../lib/api", () => ({ apiClient: apiStub }));
  mock.module("../../../contexts/room-navigation-context", () => ({ useRoomNavigation: () => ({ activeRoomId: "room-1" }) }));
  mock.module("../../../adapters/open-file-ref", () => ({ requestOpenFile }));
  mock.module("../../../adapters/website-connection-intent", () => ({ requestWebsiteConnection }));
  mock.module("../../../lib/ordinary-room-message", () => ({ sendOrdinaryRoomMessage }));
  mock.module("./use-workspace-image", () => ({ useWorkspaceImage: () => ({ kind: "ok", dataUrl: "blob:preview" }) }));
  ({ connectedWebAccountReadRenderer: renderer } = await import("./connected-web-account-read"));
  ({ publishConnectedWebAccountRefresh } = await import("../../../adapters/connected-web-account-refresh"));
});

beforeEach(() => {
  sessionStorage.clear();
  apiStub.listWorkspaceArtifacts.mockClear();
  apiStub.getRoom.mockClear();
  apiStub.downloadArtifact.mockClear();
  apiStub.listConnectedWebAccounts.mockClear();
  apiStub.listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [] }));
  apiStub.getConnectedWebOperation.mockClear();
  apiStub.watchConnectedWebOperation.mockClear();
  apiStub.stopConnectedWebOperation.mockClear();
  apiStub.getConnectedWebOperation.mockImplementation(async () => ({ operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted" as const, lifecycle: "running" as const, controlEpoch: 1, activity: { phase: "working" as const, code: "browsing", summary: "Reading and navigating the website…" }, receipt: null, canWatch: true, canStop: true, result: null }));
  apiStub.watchConnectedWebOperation.mockImplementation(async () => ({ liveViewUrl: "https://live.browser-use.com/?opaque" }));
  apiStub.stopConnectedWebOperation.mockImplementation(async () => ({ operationId: "44444444-4444-4444-8444-444444444444", driver: "checking" as const, lifecycle: "running" as const, controlEpoch: 1, activity: { phase: "checking" as const, code: "stop_reconciliation_scheduled", summary: "Stop was requested; Nautilo is reconciling the connected website operation." }, receipt: null, canWatch: false, canStop: true, result: null }));
  requestOpenFile.mockClear();
  requestWebsiteConnection.mockClear();
  sendOrdinaryRoomMessage.mockClear();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderResult(
  value = JSON.stringify(payload),
  options: Partial<Pick<ToolRendererProps, "args" | "event" | "state">> = {},
  targetRenderer: typeof renderer = renderer,
): Promise<void> {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const props: ToolRendererProps = { args: options.args ?? {}, result: undefined, state: options.state ?? "success", event: options.event, resultText: value, resultTruncated: false };
  await act(async () => { root!.render(<targetRenderer.ExpandedBody {...props} />); });
  await act(async () => { await Promise.resolve(); });
}

describe("connectedWebAccountReadRenderer", () => {
  test("failed status lookup does not claim the historical run is still working and Retry recovers its completed result", async () => {
    const { ToolCard } = await import("../tool-card");
    const id = "44444444-4444-4444-8444-444444444444";
    const active = JSON.stringify({ ok: true, status: "active", target: { url: "https://www.notion.so", origin: "https://www.notion.so" }, operation: {
      operationId: id, driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading the website." }, receipt: null,
    } });
    apiStub.getConnectedWebOperation.mockImplementation(async () => { throw new Error("offline"); });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<ToolCard toolCallId="public-offline" toolName="browse_web" args={{ url: "https://www.notion.so" }} result={active} status={{ type: "complete" }} defaultExpanded />); });
    expect(container.textContent).toContain("Browser status unavailable");
    expect(container.textContent).not.toContain("Browser agent working");
    expect(container.textContent).not.toContain("Browser Use · working");
    expect(container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("unknown");
    expect([...container.querySelectorAll("button")].some(b => b.textContent === "Watch live" || b.textContent === "Stop")).toBe(false);
    apiStub.getConnectedWebOperation.mockImplementation(async () => ({ operationId: id, driver: "checking", lifecycle: "terminal", controlEpoch: 1,
      activity: { phase: "finishing", code: "done", summary: "Done." }, receipt: { outcome: "completed", code: "done", summary: "Done." }, canWatch: false, canStop: false, result: null }));
    await act(async () => { [...container!.querySelectorAll("button")].find(b => b.textContent === "Retry status")?.click(); });
    expect(apiStub.getConnectedWebOperation).toHaveBeenCalledTimes(2);
    expect(container.textContent).toContain("Browser Use · completed");
    expect(container.textContent).not.toContain("Browser status unavailable");
  });

  test("a finished browser awaiting settlement shows no stale working claim or live controls", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    apiStub.getConnectedWebOperation.mockImplementation(async () => ({ operationId: id, driver: "checking", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "finishing", code: "provider_terminal_pending", summary: "The browser run has ended. Recording its outcome." }, receipt: null, canWatch: false, canStop: false, result: null }));
    await renderResult(JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: id, driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading the website." }, receipt: null,
    } }));
    expect(container?.textContent).toContain("Browser finished; recording outcome");
    expect(container?.textContent).not.toContain("Browser agent working");
    expect([...container!.querySelectorAll("button")].some(b => b.textContent === "Watch live" || b.textContent === "Stop")).toBe(false);
  });

  test("a transcript reconciliation preserves observed activity and controls without refetching", async () => {
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "starting", code: "admitted", summary: "Connected website work is starting." }, receipt: null,
    } });
    const props: ToolRendererProps = { args: {}, result: undefined, state: "success", resultText: active, resultTruncated: false };
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<renderer.ExpandedBody key="before-next-tool" {...props} />); });
    expect(apiStub.getConnectedWebOperation).toHaveBeenCalledTimes(1);
    // Streaming a later message replaces the earlier card in the same React
    // commit. A slow refetch must not erase the already observed owner state.
    apiStub.getConnectedWebOperation.mockImplementation(() => new Promise(() => {}));
    await act(async () => { root!.render(<renderer.ExpandedBody key="after-next-tool" {...props} />); });
    expect(container.textContent).toContain("Reading and navigating the website…");
    expect(container.textContent).not.toContain("Connected website work is starting.");
    expect(apiStub.getConnectedWebOperation).toHaveBeenCalledTimes(1);
    expect([...container.querySelectorAll("button")].find(b => b.textContent === "Watch live")?.disabled).toBe(false);
    expect([...container.querySelectorAll("button")].find(b => b.textContent === "Stop")?.disabled).toBe(false);
  });

  test("the outer header follows terminal truth even after the Human collapses the active card", async () => {
    const { ToolCard } = await import("../tool-card");
    const { publishConnectedWebOperation } = await import("./use-connected-web-operation");
    const id = "44444444-4444-4444-8444-444444444444";
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: id, driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading the website." }, receipt: null,
    } });
    container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
    await act(async () => { root!.render(<ToolCard toolCallId="exact-read" toolName="read_connected_web_account" args={{ account: "Notion" }} result={active} status={{ type: "complete" }} defaultExpanded />); });
    await act(async () => { await Promise.resolve(); });
    expect(apiStub.getConnectedWebOperation).toHaveBeenCalledTimes(1);
    expect(container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("running");
    await act(async () => { (container!.querySelector('button[aria-label="Collapse Connected website"]') as HTMLButtonElement)?.click(); });
    await act(async () => { publishConnectedWebOperation({ operationId: id, driver: "hosted", lifecycle: "terminal", controlEpoch: 1,
      activity: { phase: "finishing", code: "done", summary: "Done." }, receipt: { outcome: "completed", code: "done", summary: "Done." }, canWatch: false, canStop: false, result: null }); });
    expect(container.querySelector("[data-tool-card-state]")?.getAttribute("data-tool-card-state")).toBe("success");
    expect(container.textContent).toContain("Connected website · completed");
    expect(container.textContent).not.toContain("Connected website · working");
  });

  test("shows timestamped reported actions and can read earlier pages without changing the live operation", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const base = { operationId: id, driver: "hosted" as const, lifecycle: "running" as const, controlEpoch: 1,
      activity: { phase: "working" as const, code: "browser_action", summary: "Inspect billing navigation" }, receipt: null, canWatch: true, canStop: true, result: null };
    apiStub.getConnectedWebOperation.mockImplementation(async (_id: string, before?: number) => ({ ...base,
      activityLog: { entries: [{ id: before ? 1 : 26, occurredAt: "2026-09-04T15:00:00.000Z", source: "browser_agent", status: "completed", summary: before ? "Open connected console" : "Inspect billing navigation" }], before: before ? null : 26, hasMore: !before },
    }));
    await renderResult(JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: id, driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: base.activity, receipt: null,
    } }));
    expect(container?.querySelector('[aria-label="Browser activity"]')?.textContent).toContain("Inspect billing navigation");
    expect(container?.textContent).toContain("not verified findings");
    await act(async () => { Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Earlier activity")?.click(); });
    expect(apiStub.getConnectedWebOperation).toHaveBeenLastCalledWith(id, 26);
    expect(container?.querySelector('[aria-label="Browser activity"]')?.textContent).toContain("Open connected console");
    expect(container?.textContent).toContain("Watch live");
  });

  test("a late observation cannot undo a newer direct-control epoch or terminal truth", async () => {
    const id = "44444444-4444-4444-8444-444444444444";
    const { publishConnectedWebOperation } = await import("./use-connected-web-operation");
    const base = { operationId: id, driver: "hosted" as const, lifecycle: "running" as const, controlEpoch: 1,
      activity: { phase: "working" as const, code: "browser_action", summary: "Inspect billing navigation" }, receipt: null, canWatch: true, canStop: true, result: null };
    await renderResult(JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: id, driver: base.driver, lifecycle: base.lifecycle, controlEpoch: 1, activity: base.activity, receipt: null,
    } }));
    await act(async () => { publishConnectedWebOperation({ ...base, driver: "direct", controlEpoch: 2, activity: { ...base.activity, summary: "Genie is inspecting billing" } }); });
    await act(async () => { publishConnectedWebOperation(base); });
    expect(container?.textContent).toContain("Genie is inspecting billing");
    expect(container?.textContent).not.toContain("Inspect billing navigation");
    await act(async () => { publishConnectedWebOperation({ ...base, lifecycle: "terminal", controlEpoch: 2, receipt: { outcome: "completed", code: "done", summary: "Done." } }); });
    await act(async () => { publishConnectedWebOperation({ ...base, controlEpoch: 2 }); });
    expect(container?.textContent).toContain("Browser run completed");
    expect(container?.textContent).not.toContain("Watch live");
  });

  test("renders an in-progress read truthfully before a result exists", async () => {
    await renderResult("", { state: "running", args: { account: "Disposable test account" } });
    expect(container?.textContent).toContain("Starting the connected website operation");
    expect(container?.textContent).not.toContain("could not be displayed safely");
    expect(renderer.collapsedSummary?.({ resultText: undefined, state: "running" } as never)).toBe("Connected website · working");
    expect(renderer.autoExpandWhileRunning).toBe(true);
  });

  test("uses the exact active operation receipt for owner controls", async () => {
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading and navigating the website…" }, receipt: null,
    } });
    await renderResult(active, { state: "success", args: { account: "Notion" } });
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(apiStub.getConnectedWebOperation).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(apiStub.listConnectedWebAccounts).not.toHaveBeenCalled();
    expect(container?.textContent).toContain("Browser agent working");
    expect(container?.textContent).toContain("Reading and navigating the website");

    const watch = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live");
    await act(async () => { watch?.click(); await Promise.resolve(); });
    expect(apiStub.watchConnectedWebOperation).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    const iframe = container?.querySelector('iframe[title="Live browser for Notion"]');
    expect(iframe).not.toBeNull();
    expect(iframe?.getAttribute("tabindex")).toBe("-1");
    expect(iframe?.className).toContain("pointer-events-none");
    expect(iframe?.getAttribute("allow")).toBeNull();
    expect(container?.textContent).not.toContain("live.browser-use.com");

    const stop = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Stop");
    await act(async () => { stop?.click(); await Promise.resolve(); });
    expect(apiStub.stopConnectedWebOperation).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(container?.textContent).toContain("Stop was requested; Nautilo is reconciling");
    expect((Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Stop") as HTMLButtonElement).disabled).toBe(false);
  });

  test("keeps Watch live open when a later tool call remounts the transcript card", async () => {
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading and navigating the website…" }, receipt: null,
    } });
    await renderResult(active);
    await act(async () => { await Promise.resolve(); });
    const watch = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live");
    await act(async () => { watch?.click(); await Promise.resolve(); });
    expect(container?.querySelector('iframe[title="Live browser for Notion"]')).not.toBeNull();
    expect(sessionStorage.getItem("nautilo:connected-web-live-view:44444444-4444-4444-8444-444444444444")).toBe("open");

    // The conversation framework can remount an earlier card when a new tool
    // event arrives. Only the open/closed preference survives; the private
    // provider URL must be fetched again from the owner-only endpoint.
    await renderResult(active);
    await act(async () => { await Promise.resolve(); });
    expect(apiStub.watchConnectedWebOperation).toHaveBeenCalledTimes(2);
    expect(container?.querySelector('iframe[title="Live browser for Notion"]')).not.toBeNull();
    expect(sessionStorage.getItem("nautilo:connected-web-live-view:44444444-4444-4444-8444-444444444444")).not.toContain("live.browser-use.com");
  });

  test("projects hosted, checking, direct, Human, and attention ownership without capability leakage", async () => {
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Initial safe activity." }, receipt: null,
    } });
    const cases = [
      { driver: "hosted" as const, lifecycle: "running" as const, phase: "working" as const, label: "Browser agent working" },
      { driver: "checking" as const, lifecycle: "running" as const, phase: "checking" as const, label: "Moxie checking" },
      { driver: "direct" as const, lifecycle: "running" as const, phase: "working" as const, label: "Moxie controlling browser" },
      { driver: "human" as const, lifecycle: "running" as const, phase: "attention" as const, label: "Human input needed" },
      { driver: "hosted" as const, lifecycle: "attention" as const, phase: "working" as const, label: "Human input needed" },
      { driver: "direct" as const, lifecycle: "attention" as const, phase: "attention" as const, code: "direct_browser_cleanup_unresolved", label: "Browser cleanup needs attention" },
      { driver: "checking" as const, lifecycle: "attention" as const, phase: "checking" as const, code: "direct_browser_control_recovered", label: "Checking final browser status" },
    ];

    for (const current of cases) {
      apiStub.getConnectedWebOperation.mockImplementation(async () => ({
        operationId: "44444444-4444-4444-8444-444444444444", ...current, controlEpoch: 2,
        activity: { phase: current.phase, code: current.code ?? "safe_progress", summary: "Server-selected current activity." },
        receipt: null, canWatch: current.driver !== "human", canStop: true, result: null,
        providerRunId: "provider-run-must-not-render", liveViewUrl: "https://provider.example/must-not-render", canTakeControl: true,
        rawEvent: "raw-event-must-not-render", reasoning: "reasoning-must-not-render", pageText: "page-text-must-not-render",
      }));
      await renderResult(active);
      await act(async () => { await Promise.resolve(); });
      expect(container?.textContent).toContain(current.label);
      expect(container?.textContent).toContain("Server-selected current activity.");
      expect(container?.querySelectorAll('[role="status"]')).toHaveLength(1);
      expect(container?.innerHTML).not.toContain("provider-run-must-not-render");
      expect(container?.innerHTML).not.toContain("provider.example");
      expect(container?.innerHTML).not.toContain("raw-event-must-not-render");
      expect(container?.innerHTML).not.toContain("reasoning-must-not-render");
      expect(container?.innerHTML).not.toContain("page-text-must-not-render");
      expect(container?.textContent).not.toContain("Take over");
    }
  });

  test("enables direct controls from the fresh exact projection and transitions quietly to terminal truth", async () => {
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Initial safe activity." }, receipt: null,
    } });
    apiStub.getConnectedWebOperation.mockImplementation(async () => ({
      operationId: "44444444-4444-4444-8444-444444444444", driver: "direct" as const, lifecycle: "running" as const, controlEpoch: 2,
      activity: { phase: "working" as const, code: "direct_control", summary: "Moxie is making a precise browser update." },
      receipt: null, canWatch: true, canStop: true, result: null,
    }));
    apiStub.stopConnectedWebOperation.mockImplementation(async () => ({
      operationId: "44444444-4444-4444-8444-444444444444", driver: "direct" as const, lifecycle: "terminal" as const, controlEpoch: 2,
      activity: { phase: "finishing" as const, code: "direct_failed", summary: "The operation ended." },
      receipt: { outcome: "failed" as const, code: "direct_failed", summary: "The operation ended." }, canWatch: false, canStop: false, result: null,
    }));
    await renderResult(active);
    await act(async () => { await Promise.resolve(); });

    expect(container?.textContent).toContain("Moxie controlling browser");
    const watch = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Watch live") as HTMLButtonElement;
    const stop = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Stop") as HTMLButtonElement;
    expect(watch.disabled).toBe(false);
    expect(stop.disabled).toBe(false);

    await act(async () => { stop.click(); await Promise.resolve(); });
    expect(apiStub.stopConnectedWebOperation).toHaveBeenCalledWith("44444444-4444-4444-8444-444444444444");
    expect(container?.textContent).toContain("Connected website could not complete");
    expect(container?.textContent).toContain("The operation ended.");
    expect(container?.textContent).not.toContain("Watch live");
    expect(container?.textContent).not.toContain("Take over");
  });

  test("renders the durable terminal result from the exact operation without launching another tool run", async () => {
    apiStub.getConnectedWebOperation.mockImplementation(async () => ({
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted" as const, lifecycle: "terminal" as const, controlEpoch: 1,
      activity: { phase: "finishing" as const, code: "completed", summary: "Browser run completed." },
      receipt: { outcome: "completed" as const, code: "completed", summary: "Browser run completed." }, canWatch: false, canStop: false, result: payload,
    }));
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading and navigating the website…" }, receipt: null,
    } });
    await renderResult(active);
    await act(async () => { await Promise.resolve(); });
    expect(container?.textContent).toContain("The project is ready.");
    expect(container?.textContent).not.toContain("could not be displayed safely");
  });

  test("does not label a terminal cancellation without a result as completed", async () => {
    apiStub.getConnectedWebOperation.mockImplementation(async () => ({
      operationId: "44444444-4444-4444-8444-444444444444", driver: "checking" as const, lifecycle: "terminal" as const, controlEpoch: 1,
      activity: { phase: "finishing" as const, code: "provider_cancelled", summary: "The browser run was stopped." },
      receipt: { outcome: "cancelled" as const, code: "provider_cancelled", summary: "The browser run was stopped." }, canWatch: false, canStop: false, result: null,
    }));
    const active = JSON.stringify({ ok: true, status: "active", account: payload.account, operation: {
      operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1,
      activity: { phase: "working", code: "browsing", summary: "Reading and navigating the website…" }, receipt: null,
    } });
    await renderResult(active);
    await act(async () => { await Promise.resolve(); });
    expect(container?.textContent).toContain("Browser run stopped");
    expect(container?.textContent).not.toContain("Browser run completed");
  });

  test("opens the opaque connected page and resolves saved outputs through Workspace IDs", async () => {
    await renderResult();
    expect(renderer.sealedResultParser).toBe(true);
    expect(container?.textContent).toContain("The project is ready.");
    expect(container?.textContent).toContain("report.pdf");
    expect(container?.textContent).not.toContain("0123456789abcdef-report.pdf");
    expect(container?.textContent).not.toContain(payload.page.ref);
    expect(container?.textContent).not.toContain(payload.page.origin);
    expect(apiStub.listWorkspaceArtifacts).toHaveBeenCalledWith({ roomId: "room-1" });

    const live = Array.from(container!.querySelectorAll("button")).find((button) => button.textContent === "Open live page");
    await act(async () => { live?.click(); });
    expect(requestWebsiteConnection).toHaveBeenCalledWith({ kind: "view", accountId: payload.account.id, title: "Notion" });

    const open = container!.querySelector('button[aria-label="Open report.pdf in Work"]');
    await act(async () => { open?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(requestOpenFile).toHaveBeenCalledWith(expect.objectContaining({ kind: "artifact", id: "internal-report", path: report.path, roomId: "room-1" }));

    const download = container!.querySelector('button[aria-label="Download report.pdf"]');
    await act(async () => { download?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(apiStub.downloadArtifact).toHaveBeenCalledWith("internal-report", "report.pdf", { roomId: "room-1" });

    const imageDownload = container!.querySelector('button[aria-label="Download dashboard.png"]');
    await act(async () => { imageDownload?.dispatchEvent(new window.MouseEvent("click", { bubbles: true })); });
    expect(apiStub.downloadArtifact).toHaveBeenCalledWith("internal-image", "dashboard.png", { roomId: "room-1" });
  });

  test("fails closed for provider-shaped data rather than displaying it", async () => {
    const unsafe = { ...payload, page: { ...payload.page, liveViewUrl: "https://provider.example/live" } };
    await renderResult(JSON.stringify(unsafe));
    expect(container?.textContent).toContain("could not be displayed safely");
    expect(container?.textContent).not.toContain("provider.example");
  });

  test("presents a completed provider run without a false error or retry instruction", async () => {
    const completed = JSON.stringify({ ok: false, code: "invalid_result", recovery: "none" });
    await renderResult(completed);

    expect(container?.textContent).toContain("Browser run completed.");
    expect(container?.textContent).not.toContain("Try again");
    expect(renderer.collapsedSummary?.({ resultText: completed, state: "error" } as never)).toBe("Connected website · completed");
    expect(renderer.stateOverride?.({ resultText: completed, state: "error" })).toBe("success");
  });

  test("presents a Human-stopped read as cancelled instead of unavailable", async () => {
    const cancelled = JSON.stringify({ ok: false, code: "cancelled", recovery: "none" });
    await renderResult(cancelled, { state: "error" });

    expect(container?.textContent).toContain("Stopped. The website read was cancelled.");
    expect(container?.textContent).not.toContain("Try again");
    expect(renderer.collapsedSummary?.({ resultText: cancelled, state: "error" } as never)).toBe("Connected website · stopped");
    expect(renderer.stateOverride?.({ resultText: cancelled, state: "error" })).toBe("cancelled");
  });

  test("renders the completed contract neutrally when its structured read is unavailable", async () => {
    const completed = JSON.stringify({ ...payload, read: null });
    await renderResult(completed);

    expect(container?.textContent).toContain("Browser run completed.");
    expect(container?.textContent).not.toContain("Try again");
    expect(renderer.collapsedSummary?.({ resultText: completed, state: "success" } as never)).toBe("Connected website · Notion");
  });

  test("binds page and read origins exactly to the connected account origin", async () => {
    const unsafeResults = [
      { ...payload, page: { ...payload.page, origin: "https://www.notion.so/projects" } },
      { ...payload, read: { ...payload.read, origin: "https://other.example" } },
      { ...payload, account: { ...payload.account, origin: "https://user@www.notion.so" } },
      { ...payload, page: { ...payload.page, title: "Injected title" } },
    ];
    for (const unsafe of unsafeResults) {
      await renderResult(JSON.stringify(unsafe));
      expect(container?.textContent).toContain("could not be displayed safely");
    }
  });

  test("shows only the server-derived imported-output truncation notice", async () => {
    await renderResult(JSON.stringify({ ...payload, outputsTruncated: true }));
    expect(container?.textContent).toContain("Some requested files could not be imported into this result.");
  });

  test("requires the complete server result projection", async () => {
    const { page: _page, ...withoutPage } = payload;
    for (const incomplete of [withoutPage, { ...payload, outputsTruncated: undefined }]) {
      await renderResult(JSON.stringify(incomplete));
      expect(container?.textContent).toContain("could not be displayed safely");
    }
  });

  test.each(["Find three Madrid stays", "Create the requested page and keep these details. ".repeat(100)])("resumes the exact sign-in request once after Done: %#", async (request) => {
    const authenticationRequired = {
      ok: false,
      code: "authentication_required",
      recovery: "connect",
      intervention: {
        kind: "authentication_required",
        mode: "connect",
        reason: "not_connected",
        target: { selector: "Airbnb" },
      },
      continuation: {
        account: "Airbnb",
        request,
        delivery: "text",
      },
    };
    const authenticationRequiredText = JSON.stringify(authenticationRequired);
    expect(renderer.collapsedSummary?.({ resultText: authenticationRequiredText, state: "error" } as never)).toBe("Connected website · sign-in needed");
    expect(renderer.stateOverride?.({ resultText: authenticationRequiredText, state: "error" })).toBe("blocked");
    await renderResult(authenticationRequiredText, {
      // Live lifecycle cards intentionally omit the private request from their
      // display arguments. The sealed result owns the exact continuation.
      args: { account: "Airbnb", delivery: "text" },
      event: {
        toolCallId: "call-auth",
        toolName: "read_connected_web_account",
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        args: {},
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });

    expect(container?.textContent).toContain("Sign in to Airbnb");
    expect(container?.textContent).not.toContain(request);
    const button = Array.from(container!.querySelectorAll("button")).find((candidate) => candidate.textContent === "Sign in to Airbnb");
    await act(async () => { button?.click(); });
    expect(requestWebsiteConnection).toHaveBeenCalledTimes(1);
    const intent = requestWebsiteConnection.mock.calls[0]![0] as { kind: string; websiteId: string; onFinished: (outcome: "done" | "cancelled") => void };
    expect(intent.kind).toBe("catalogue");
    expect(intent.websiteId).toBe("airbnb");

    await act(async () => { intent.onFinished("done"); await Promise.resolve(); });
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledTimes(1);
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledWith(apiStub, "room-1", {
      content: expect.stringContaining(`Request: ${JSON.stringify(request)}`),
      uiSelectedBotActorId: "33333333-3333-4333-8333-333333333333",
    });
    await act(async () => { intent.onFinished("done"); await Promise.resolve(); });
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledTimes(1);
    expect(container?.textContent).toContain("ConnectedGenie is continuing your request");
    expect(container?.textContent).not.toContain("Sign in to Airbnb");
  });

  test("offers a calm explicit continuation when the automatic send fails after sign-in", async () => {
    sendOrdinaryRoomMessage.mockRejectedValueOnce(new Error("offline"));
    await renderResult(JSON.stringify({
      ok: false,
      code: "authentication_required",
      recovery: "connect",
      intervention: { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: "Airbnb" } },
      continuation: { account: "Airbnb", request: "Find three Madrid stays", delivery: "text" },
    }), {
      args: { account: "Airbnb", delivery: "text" },
      event: {
        toolCallId: "call-auth-recovery",
        toolName: "read_connected_web_account",
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        args: {},
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });
    const signIn = Array.from(container!.querySelectorAll("button")).find((candidate) => candidate.textContent === "Sign in to Airbnb");
    await act(async () => { signIn?.click(); });
    const intent = requestWebsiteConnection.mock.calls.at(-1)![0] as { onFinished: (outcome: "done" | "cancelled") => void };
    await act(async () => { intent.onFinished("done"); await Promise.resolve(); await Promise.resolve(); });
    expect(container?.textContent).toContain("Connected. Your request has not continued yet.");
    expect(Array.from(container!.querySelectorAll("button")).some((candidate) => candidate.textContent === "Continue request")).toBe(true);
    expect(container?.textContent).not.toContain("could not resume");
  });

  test("resumes from authoritative connected state when the transient modal callback is lost", async () => {
    const authenticationRequired = {
      ok: false,
      code: "authentication_required",
      recovery: "connect",
      intervention: { kind: "authentication_required", mode: "connect", reason: "not_connected", target: { selector: "https://example.edu/" } },
      continuation: { account: "https://example.edu/", request: "Tell me the exact heading", delivery: "text" },
    };
    await renderResult(JSON.stringify(authenticationRequired), {
      args: { account: "https://example.edu/", delivery: "text" },
      event: {
        toolCallId: "call-auth-refresh",
        toolName: "read_connected_web_account",
        authorAgentId: "22222222-2222-4222-8222-222222222222",
        args: {},
        status: "ok",
        startedAt: 1,
        endedAt: 2,
      },
    });
    const signIn = Array.from(container!.querySelectorAll("button")).find((candidate) => candidate.textContent === "Sign in to https://example.edu/");
    await act(async () => { signIn?.click(); await Promise.resolve(); });
    expect(requestWebsiteConnection).toHaveBeenCalledTimes(1);

    apiStub.listConnectedWebAccounts.mockImplementation(async () => ({ accounts: [{
      ...payload.account,
      label: "example.edu",
      service: "example.edu",
      origin: "https://example.edu",
      status: "connected" as const,
      lastVerifiedAt: null,
      createdAt: "2026-09-03T00:00:00.000Z",
      updatedAt: "2026-09-03T00:00:00.000Z",
    }] }));
    await act(async () => { publishConnectedWebAccountRefresh(); await Promise.resolve(); await Promise.resolve(); });

    expect(sendOrdinaryRoomMessage).toHaveBeenCalledTimes(1);
    expect(sendOrdinaryRoomMessage).toHaveBeenCalledWith(apiStub, "room-1", {
      content: expect.stringContaining('Request: "Tell me the exact heading"'),
      uiSelectedBotActorId: "33333333-3333-4333-8333-333333333333",
    });
    expect(container?.textContent).toContain("ConnectedGenie is continuing your request.");
    expect(container?.textContent).not.toContain("Sign in to https://example.edu/");
  });

  test("rejects provider-shaped fields on an authentication intervention", async () => {
    await renderResult(JSON.stringify({
      ok: false,
      code: "authentication_required",
      recovery: "reconnect",
      intervention: {
        kind: "authentication_required",
        mode: "reconnect",
        reason: "sign_in",
        account: { id: payload.account.id, label: "Notion", service: "Notion", origin: "https://www.notion.so" },
        liveViewUrl: "https://provider.example/bearer",
      },
    }));
    expect(container?.textContent).toContain("could not be displayed safely");
    expect(container?.textContent).not.toContain("provider.example");
  });
});

test("D585 completed public result has a source link and no protected profile button", async () => {
  const publicRenderer = (await import("./connected-web-account-read")).publicBrowserReadRenderer;
  const result = { ...payload, account: null, outputs: [], page: { ref: "44444444-4444-4444-8444-444444444444", title: "example.com", origin: "https://example.com" }, read: { ...payload.read, provenance: "public_website", origin: "https://example.com" } };
  await renderResult(JSON.stringify(result), {}, publicRenderer);
  expect(container!.textContent).toContain("The project is ready.");
  expect(container!.querySelector('a[href="https://example.com"]')).not.toBeNull();
  expect(container!.textContent).not.toContain("Open live page");
  expect(requestWebsiteConnection).not.toHaveBeenCalled();
});

test("D585 zero-account public operation exposes Watch and Stop", async () => {
  const publicRenderer = (await import("./connected-web-account-read")).publicBrowserReadRenderer;
  const active = { ok: true, status: "active", target: { url: "https://example.com/search", origin: "https://example.com" }, operation: { operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: { phase: "working", code: "browsing", summary: "Reading public content" }, receipt: null } };
  await renderResult(JSON.stringify(active), { state: "running" }, publicRenderer);
  expect(container!.textContent).toContain("Watch live");
  expect(container!.textContent).toContain("Stop");
  expect(container!.textContent).not.toContain("Sign in");
  expect(apiStub.listConnectedWebAccounts).not.toHaveBeenCalled();
});

test.each([false, true])("website tasks expose Watch and Stop without claiming read-only; public=%s", async (publicSite) => {
  const taskRenderer = (await import("./connected-web-account-read")).websiteTaskRenderer;
  const active = { ok: true, status: "active", ...(publicSite ? { target: { url: "https://example.com", origin: "https://example.com" } } : { account: payload.account }),
    continuation: { account: publicSite ? "https://example.com" : "BookStack", request: "Create the requested page", delivery: "text" },
    operation: { operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: { phase: "working", code: "working", summary: "Working on the requested page" }, receipt: null } };
  await renderResult(JSON.stringify(active), { state: "running", args: publicSite ? { url: "https://example.com" } : { account: "BookStack" } }, taskRenderer);
  expect(container!.textContent).toContain("working on your behalf");
  expect(container!.textContent).toContain("Watch live");
  expect(container!.textContent).toContain("Stop");
  expect(container!.textContent).not.toContain("read only");
  expect(container!.textContent).not.toContain("outside this read operation");
});

test.each([false, true])("website task sign-in resumes complete receipt scope, not display args; public=%s", async (publicSite) => {
  const { websiteTaskRenderer, parseWebsiteTaskActive } = await import("./connected-web-account-read");
  const request = "Create the requested page and preserve every boundary. ".repeat(100).trim();
  const account = publicSite ? "https://example.com" : payload.account.label;
  const active = { ok: true, status: "active", ...(publicSite ? { target: { url: account, origin: account } } : { account: payload.account }),
    continuation: { account, request, delivery: "text" },
    operation: { operationId: "44444444-4444-4444-8444-444444444444", driver: "hosted", lifecycle: "running", controlEpoch: 1, activity: { phase: "working", code: "working", summary: "Working" }, receipt: null } };
  expect(parseWebsiteTaskActive(JSON.stringify(active))?.continuation.request).toBe(request);
  apiStub.getConnectedWebOperation.mockImplementation(async () => ({ operationId: active.operation.operationId, driver: "checking", lifecycle: "terminal", controlEpoch: 1,
    activity: { phase: "attention", code: "authentication_required", summary: "Sign-in needed" }, receipt: { outcome: "attention_required", code: "authentication_required", summary: "Sign-in needed" }, canWatch: false, canStop: false, result: null }));
  await renderResult(JSON.stringify(active), { state: "running", args: { account, request: "Shortened display only…" }, event: {
    toolCallId: "task-signin", toolName: "run_website_task", authorAgentId: "22222222-2222-4222-8222-222222222222", args: {}, status: "ok", startedAt: 1, endedAt: 2,
  } }, websiteTaskRenderer);
  const signIn = [...container!.querySelectorAll("button")].find(button => /Sign in|Reconnect/.test(button.textContent ?? ""));
  expect(signIn).toBeDefined();
  await act(async () => { signIn?.click(); });
  const intent = requestWebsiteConnection.mock.calls[0]![0] as { onFinished: (outcome: "done") => void };
  await act(async () => { intent.onFinished("done"); await Promise.resolve(); });
  expect(sendOrdinaryRoomMessage).toHaveBeenCalledWith(apiStub, "room-1", {
    content: expect.stringContaining(`Request: ${JSON.stringify(request)}`), uiSelectedBotActorId: "33333333-3333-4333-8333-333333333333",
  });
  expect(container!.textContent).not.toContain(request);
});
