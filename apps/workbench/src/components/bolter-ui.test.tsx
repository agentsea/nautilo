import { reapplyHappyDomGlobals } from "../../tests/bun-dom-preload";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { apiClient } from "../lib/api";
import { BolterConnectionSection } from "../pages/connections/bolter-connection-section";
import { BolterMessageComposer } from "./bolter-message-composer";
import { BolterRoomSection } from "./bolter-room-section";
import { bolterConnectionLabel } from "../pages/connections/bolter-presentation";
import type { BolterConnectionSummary, BolterRoomLinkSummary } from "@nautilo/types";

const CONNECTION = "10000000-0000-4000-8000-000000000001";
const ROOM = "10000000-0000-4000-8000-000000000002";
const OTHER_ROOM = "10000000-0000-4000-8000-000000000003";
const LINK = "10000000-0000-4000-8000-000000000004";
const OUTBOX = "10000000-0000-4000-8000-000000000005";
const connection: BolterConnectionSummary = { id: CONNECTION, revision: 2, displayName: "Fixture connection", identity: { label: "Fixture agent", providerAgentId: "fixture-agent" },
  device: { relayId: "fixture-device", label: "Fixture Desktop" }, status: "connected", receiver: "listening", canCreateRoom: true };
const link: BolterRoomLinkSummary = { id: LINK, revision: 3, roomId: ROOM, roomName: "Fixture exchange", agentId: ROOM, connectionId: CONNECTION,
  conversationLabel: "Fixture chat", chatId: "fixture-chat", threadRootId: "fixture-thread", providerAgentId: "fixture-agent", identityLabel: "Fixture agent",
  canManage: true, canSend: true, status: "active", receiver: "listening", outboundPolicy: "causal_replies_and_reviewed_messages", delivery: { pending: 0, uncertain: 0 } };
const originalFetch = globalThis.fetch;
let generation = 0;
let writes: { path: string; body: Record<string, unknown> }[];
let responder: (path: string, method: string, body: Record<string, unknown>) => unknown | Promise<unknown>;
function json(value: unknown) { return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } }); }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
function input(element: HTMLElement, value: string) {
  const key = Object.keys(element).find(key => key.startsWith("__reactProps$"));
  if (!key) throw new Error("Controlled input is unavailable");
  const props = (element as unknown as Record<string, { onChange: (event: { target: { value: string } }) => void }>)[key]!;
  act(() => props.onChange({ target: { value } }));
}
function defaults(path: string, method: string, body: Record<string, unknown>): unknown {
  if (path === "/api/bolter/connections") return { connections: [connection], availability: { state: "available" }, desktops: [{ relayId: "fixture-device", label: "Fixture Desktop" }] };
  if (path === `/api/bolter/connections/${CONNECTION}/rooms` && method === "GET") return { links: [link] };
  if (path === `/api/bolter/connections/${CONNECTION}/conversations`) return { status: "available", conversations: [{ id: "fixture-choice", label: "Fixture chat", chatId: "fixture-chat", threadRootId: "fixture-thread" }] };
  if (path === "/api/agents") return { agents: [{ agentId: ROOM, handle: "fixture-genie", displayName: "Fixture Genie" }] };
  if (path === `/api/bolter/rooms/${ROOM}`) return { link };
  if (path === `/api/bolter/rooms/${OTHER_ROOM}`) return { link: { ...link, roomId: OTHER_ROOM, conversationLabel: "Other fixture chat", chatId: "other-fixture-chat" } };
  if (path === `/api/bolter/bindings/${LINK}/messages`) return { messageId: 1, outboxId: OUTBOX, state: "pending" };
  if (path === `/api/bolter/bindings/${LINK}/deliveries`) return { deliveries: [] };
  if (path === `/api/bolter/bindings/${LINK}` && method === "PATCH") return { ...link, status: body["state"], revision: 4 };
  throw new Error("Unexpected synthetic transport request");
}
beforeEach(() => {
  reapplyHappyDomGlobals(); cleanup(); writes = []; responder = defaults;
  apiClient.setToken(`fixture-token-${++generation}`);
  globalThis.fetch = (async (request, init) => {
    const path = new URL(typeof request === "string" ? request : request instanceof URL ? request.href : request.url, "http://localhost").pathname;
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    if (method !== "GET") writes.push({ path, body });
    const result = await responder(path, method, body);
    return result instanceof Response ? result : json(result);
  }) as typeof fetch;
});
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; apiClient.setToken(null); });

describe("Bolter connection journey through the real HTTP client", () => {
  function pollClock() {
    const scheduled = new Map<number, () => void>();
    let sequence = 0;
    const originalSet = window.setTimeout.bind(window);
    const originalClear = window.clearTimeout.bind(window);
    const set = spyOn(window, "setTimeout").mockImplementation(((handler: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 2_000) return originalSet(handler, delay, ...args);
      if (typeof handler !== "function") throw new Error("Expected a polling callback");
      const id = --sequence; scheduled.set(id, () => handler(...args)); return id;
    }) as typeof window.setTimeout);
    const clear = spyOn(window, "clearTimeout").mockImplementation((id?: number) => {
      if (id !== undefined && scheduled.delete(id)) return;
      originalClear(id);
    });
    return { scheduled, async tick() {
      const next = scheduled.entries().next().value;
      if (!next) throw new Error("No pending operation refresh");
      scheduled.delete(next[0]); await act(async () => { next[1](); });
    }, restore() { set.mockRestore(); clear.mockRestore(); } };
  }
  const authPending = { operationId: CONNECTION, status: "auth_pending", auth: { url: "https://bolter.chat/device?code=ABCD-EFGH", code: "ABCD-EFGH" } };
  async function beginPending() {
    const view = render(<BolterConnectionSection scopeKey="fixture-scope" onRoomCreated={async () => {}} />);
    await waitFor(() => expect((view.getByRole("button", { name: "Connect Bolter" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Connect Bolter" }));
    await waitFor(() => expect(view.getByLabelText("Bolter sign-in")).toBeTruthy());
    return view;
  }
  test("sequential operation refresh discovers delayed auth and completion, sharing manual reads", async () => {
    const clock = pollClock(); const delayed = deferred<unknown>(); let reads = 0; let lists = 0;
    responder = (path, method, body) => {
      if (path.endsWith("/connect")) return { operationId: CONNECTION, status: "pending" };
      if (path === `/api/bolter/operations/${CONNECTION}`) return ++reads === 1 ? delayed.promise : { operationId: CONNECTION, status: "completed", connection };
      if (path === "/api/bolter/connections") lists++;
      return defaults(path, method, body);
    };
    try {
      const view = await beginPending();
      await clock.tick(); expect(reads).toBe(1); expect(clock.scheduled.size).toBe(0);
      fireEvent.click(view.getByRole("button", { name: "Check sign-in" }));
      expect(reads).toBe(1);
      await act(async () => { delayed.resolve(authPending); });
      expect(view.getByRole("link", { name: "Open Bolter sign-in" })).toBeTruthy();
      expect(clock.scheduled.size).toBe(1);
      await clock.tick();
      await waitFor(() => expect(view.queryByLabelText("Bolter sign-in")).toBeNull());
      expect(reads).toBe(2); expect(lists).toBe(2); expect(clock.scheduled.size).toBe(0);
      expect(writes).toHaveLength(1);
    } finally { cleanup(); clock.restore(); }
  });
  test.each(["unmount", "viewer", "cancel"] as const)("operation refresh discards delayed results after %s", async boundary => {
    const clock = pollClock(); const late = deferred<unknown>(); let reads = 0;
    responder = (path, method, body) => path.endsWith("/connect") ? { operationId: CONNECTION, status: "pending" }
      : path === `/api/bolter/operations/${CONNECTION}` ? (reads++, late.promise)
      : path.endsWith("/cancel") ? { operationId: CONNECTION, status: "unavailable", reason: "operation_cancelled" } : defaults(path, method, body);
    try {
      const view = await beginPending(); await clock.tick();
      if (boundary === "unmount") view.unmount();
      else if (boundary === "viewer") {
        apiClient.setToken("fixture-new-viewer");
        view.rerender(<BolterConnectionSection scopeKey="new-viewer" onRoomCreated={async () => {}} />);
      } else fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
      await act(async () => { late.resolve(authPending); });
      expect(view.queryByText("ABCD-EFGH")).toBeNull();
      expect(clock.scheduled.size).toBe(0); expect(reads).toBe(1);
    } finally { cleanup(); clock.restore(); }
  });
  test.each(["network", "not_found", "terminal"] as const)("operation %s stops automatic refresh with honest recovery", async failure => {
    const clock = pollClock(); let reads = 0;
    responder = (path, method, body) => {
      if (path.endsWith("/connect")) return authPending;
      if (path === `/api/bolter/operations/${CONNECTION}`) {
        reads++;
        if (failure === "network" && reads === 1) throw new Error("Synthetic network failure");
        if (failure === "not_found") return new Response(JSON.stringify({ code: "not_found" }), { status: 404, headers: { "content-type": "application/json" } });
        return { operationId: CONNECTION, status: "unavailable", reason: "desktop_offline" };
      }
      return defaults(path, method, body);
    };
    try {
      const view = await beginPending(); await clock.tick();
      expect(clock.scheduled.size).toBe(0); expect(reads).toBe(1);
      if (failure === "network") {
        expect(view.getByText("Could not check Bolter sign-in. Check sign-in to try again.")).toBeTruthy();
        expect(view.getByText("ABCD-EFGH")).toBeTruthy();
        fireEvent.click(view.getByRole("button", { name: "Check sign-in" }));
        await waitFor(() => expect(reads).toBe(2));
        await waitFor(() => expect(view.queryByText("ABCD-EFGH")).toBeNull());
      } else {
        expect(view.queryByText("ABCD-EFGH")).toBeNull();
        expect((view.getByRole("button", { name: "Connect Bolter" }) as HTMLButtonElement).disabled).toBe(false);
        if (failure === "not_found") expect(view.getByText(/Bolter sign-in was interrupted/)).toBeTruthy();
      }
      expect(clock.scheduled.size).toBe(0);
    } finally { cleanup(); clock.restore(); }
  });
  test("Connect after remount recovers the server's pending operation without storing its auth link", async () => {
    const clock = pollClock(); let connects = 0;
    responder = (path, method, body) => path.endsWith("/connect") ? (++connects === 1 ? { operationId: CONNECTION, status: "pending" } : authPending) : defaults(path, method, body);
    try {
      const first = await beginPending(); first.unmount(); expect(clock.scheduled.size).toBe(0);
      const second = await beginPending(); expect(second.getByText("ABCD-EFGH")).toBeTruthy();
      expect(connects).toBe(2); expect(clock.scheduled.size).toBe(1);
    } finally { cleanup(); clock.restore(); }
  });
  test.each([1, 2])("first connection selects its receiving Desktop from %i eligible devices", async count => {
    responder = (path, method, body) => path === "/api/bolter/connections"
      ? { connections: [], availability: { state: "available" }, desktops: Array.from({ length: count }, (_, index) => ({ relayId: `fixture-device-${index}`, label: `Fixture Desktop ${index}` })) }
      : path.endsWith("/connect") ? { operationId: CONNECTION, status: "unavailable", reason: "qualification_required" } : defaults(path, method, body);
    const view = render(<BolterConnectionSection scopeKey="fixture-scope" onRoomCreated={async () => {}} />);
    await waitFor(() => expect(view.queryByText("Checking Bolter…")).toBeNull());
    const connect = view.getByRole("button", { name: "Connect Bolter" }) as HTMLButtonElement;
    if (count > 1) {
      expect(connect.disabled).toBe(true);
      fireEvent.change(view.getByRole("combobox", { name: "Receiving Desktop" }), { target: { value: "fixture-device-1" } });
    } else expect(view.queryByRole("combobox", { name: "Receiving Desktop" })).toBeNull();
    expect(connect.disabled).toBe(false);
    fireEvent.click(connect);
    await waitFor(() => expect(writes).toEqual([{ path: "/api/bolter/connections/connect", body: { relayId: `fixture-device-${count - 1}` } }]));
    await waitFor(() => expect(view.getByText("This Bolter version is not qualified for messaging yet.")).toBeTruthy());
  });
  test.each(["desktop_required", "qualification_required", "mode_unsupported"] as const)("gates %s without invoking native or outbound actions", async state => {
    responder = path => path === "/api/bolter/connections" ? { connections: [], availability: { state }, desktops: [] } : defaults(path, "GET", {});
    const view = render(<BolterConnectionSection scopeKey="fixture-scope" onRoomCreated={async () => {}} />);
    await waitFor(() => expect((view.getByRole("button", { name: "Connect Bolter" }) as HTMLButtonElement).disabled).toBe(true));
    await waitFor(() => expect(view.queryByText("Checking Bolter…")).toBeNull());
    expect(writes).toEqual([]);
  });
  test("does not label process existence as Listening", () => {
    expect(bolterConnectionLabel({ ...connection, receiver: "running" })).toBe("Receiver running");
    expect(bolterConnectionLabel({ ...connection, receiver: "starting" })).toBe("Starting receiver");
    expect(bolterConnectionLabel({ ...connection, receiver: "stopped" })).toBe("Connected");
    expect(bolterConnectionLabel(connection)).toBe("Listening");
    expect(bolterConnectionLabel({ ...connection, reason: "receiver_unavailable" })).toBe("Delivery needs attention");
  });
  test("creates only a fresh room for the exact observed choice after explicit credit consent", async () => {
    let opened: string | null = null;
    responder = (path, method, body) => method === "POST" && path.endsWith("/rooms") ? { roomId: ROOM, link } : defaults(path, method, body);
    const view = render(<BolterConnectionSection scopeKey="fixture-scope" onRoomCreated={async room => { opened = room; }} />);
    await waitFor(() => expect((view.getByRole("button", { name: "Create a linked room" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Create a linked room" }));
    await waitFor(() => expect(view.getByText("Genie: Fixture Genie")).toBeTruthy());
    expect(view.queryByRole("combobox", { name: "Genie" })).toBeNull();
    input(view.getByRole("textbox", { name: "Room name" }), "Fixture new room");
    expect((view.getByRole("button", { name: "Create room", exact: true }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Create room", exact: true }));
    await waitFor(() => expect(opened).toBe(ROOM));
    expect(writes).toEqual([{ path: `/api/bolter/connections/${CONNECTION}/rooms`, body: { choiceId: "fixture-choice", agentId: ROOM, name: "Fixture new room", modelSponsorshipAccepted: true } }]);
    expect(writes[0]!.body).not.toHaveProperty("roomId");
  });
  test("shows sign-in link transiently and actually cancels its canonical operation", async () => {
    responder = (path, method, body) => path.endsWith("/connect") ? { operationId: CONNECTION, status: "auth_pending", auth: { url: "https://bolter.chat/auth?fixture=1", code: "fixture-code" } }
      : path.endsWith("/cancel") ? { operationId: CONNECTION, status: "unavailable", reason: "operation_cancelled" } : defaults(path, method, body);
    const view = render(<BolterConnectionSection scopeKey="fixture-scope" onRoomCreated={async () => {}} />);
    await waitFor(() => expect((view.getByRole("button", { name: "Connect Bolter" }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Connect Bolter" }));
    await waitFor(() => expect(view.getByRole("link", { name: "Open Bolter sign-in" }).getAttribute("rel")).toBe("noopener noreferrer"));
    fireEvent.click(view.getByRole("button", { name: "Cancel sign-in" }));
    await waitFor(() => expect(view.queryByText("fixture-code")).toBeNull());
    expect(writes.some(item => item.path === `/api/bolter/operations/${CONNECTION}/cancel`)).toBe(true);
  });
  test("discarded viewer response cannot expose its old identity", async () => {
    const late = deferred<unknown>(); let reads = 0;
    responder = (path, method, body) => path === "/api/bolter/connections" ? ++reads === 1 ? late.promise : { connections: [{ ...connection, identity: { label: "Current fixture agent", providerAgentId: "current-fixture" } }], availability: { state: "available" }, desktops: [{ relayId: "fixture-device", label: "Fixture Desktop" }] } : defaults(path, method, body);
    const view = render(<BolterConnectionSection key="old" scopeKey="old" onRoomCreated={async () => {}} />);
    await waitFor(() => expect(reads).toBe(1));
    apiClient.setToken("fixture-replacement-token");
    view.rerender(<BolterConnectionSection key="new" scopeKey="new" onRoomCreated={async () => {}} />);
    await waitFor(() => expect(view.getByText("Current fixture agent")).toBeTruthy());
    await act(async () => { late.resolve({ connections: [{ ...connection, identity: { label: "Retired fixture agent", providerAgentId: "retired-fixture" } }], availability: { state: "available" }, desktops: [{ relayId: "fixture-device", label: "Fixture Desktop" }] }); });
    expect(view.queryByText("Retired fixture agent")).toBeNull();
  });
});

describe("intentional Human text sharing", () => {
  async function reviewDraft(content = "  Fixture text\n<script>literal</script>\n/command  ") {
    const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture-scope" />);
    await waitFor(() => expect(view.getByRole("button", { name: "Open Bolter draft" })).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Open Bolter draft" }));
    input(view.getByRole("textbox", { name: "Message to Bolter" }), content);
    fireEvent.click(view.getByRole("button", { name: "Review & send" }));
    return view;
  }
  test("review displays exact text and destination without sending or interpreting markup", async () => {
    const view = await reviewDraft();
    expect(view.getByRole("region", { name: "Review message for Bolter" }).querySelector("pre")!.textContent).toBe("  Fixture text\n<script>literal</script>\n/command  ");
    expect(view.container.querySelector("script")).toBeNull();
    expect(view.getByText("Posting as Fixture agent")).toBeTruthy();
    expect(view.getByText(/Bolter · Fixture chat/)).toBeTruthy();
    expect(writes).toEqual([]);
    fireEvent.click(view.getByRole("button", { name: "Keep editing" }));
    expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).value).toContain("/command");
  });
  test("confirmation sends the reviewed bytes once and reports Queued rather than Sent", async () => {
    const view = await reviewDraft(" Fixture outgoing text ");
    fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(view.getByText("Queued for Bolter")).toBeTruthy());
    expect(view.queryByText("Sent to Bolter")).toBeNull();
    expect(writes).toHaveLength(1);
    expect(writes[0]!.body["content"]).toBe(" Fixture outgoing text ");
    expect(writes[0]!.body["expectedRevision"]).toBe(3);
    expect(typeof writes[0]!.body["requestId"]).toBe("string");
  });
  test("authority withdrawn after review blocks disclosure", async () => {
    const view = await reviewDraft();
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}` ? { link: { ...link, revision: 4, status: "paused", canSend: false } } : defaults(path, method, body);
    fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(view.getByRole("alert")).toBeTruthy());
    expect(writes).toEqual([]);
  });
  test("unknown HTTP outcome recovers the same exact request, never a replacement", async () => {
    let sends = 0;
    responder = (path, method, body) => {
      if (path.endsWith("/messages")) {
        if (++sends === 1) throw new Error("Synthetic private transport diagnostic");
        return { messageId: 1, outboxId: OUTBOX, state: "uncertain" };
      }
      return defaults(path, method, body);
    };
    const view = await reviewDraft("Fixture retained reviewed text");
    fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(view.getByRole("button", { name: "Recover same request" })).toBeTruthy());
    expect(view.queryByText("Synthetic private transport diagnostic")).toBeNull();
    expect((view.getByRole("button", { name: "Keep editing" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(view.getByRole("button", { name: "Recover same request" }));
    await waitFor(() => expect(view.getByText("Delivery uncertain — do not resend")).toBeTruthy());
    expect(writes).toHaveLength(2);
    expect(writes[1]!.body).toEqual(writes[0]!.body);
  });
  test("metadata reconciliation uses the exact request ID, ignoring unrelated causal replies", async () => {
    responder = (path, method, body) => {
      if (path.endsWith("/messages")) throw new Error("Synthetic transport loss");
      if (path.endsWith("/deliveries")) return { deliveries: [
        { messageId: 99, outboxId: CONNECTION, requestId: null, state: "published", createdAt: "2030-01-01T00:00:00Z" },
        { messageId: 1, outboxId: OUTBOX, requestId: writes[0]?.body["requestId"], state: "published", createdAt: "2030-01-01T00:00:00Z" },
      ] };
      return defaults(path, method, body);
    };
    const view = await reviewDraft(); fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(view.getByText("Sent to Bolter")).toBeTruthy());
    expect(writes).toHaveLength(1);
  });
  test("late accepted response cannot replace another room's UI", async () => {
    const late = deferred<unknown>();
    responder = (path, method, body) => path.endsWith("/messages") ? late.promise : defaults(path, method, body);
    const view = await reviewDraft(); fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(writes).toHaveLength(1));
    view.rerender(<BolterMessageComposer roomId={OTHER_ROOM} scopeKey="fixture-scope" />);
    await waitFor(() => expect(view.getByText(/Other fixture chat/)).toBeTruthy());
    await act(async () => { late.resolve({ messageId: 1, outboxId: OUTBOX, state: "published" }); });
    expect(view.queryByText("Sent to Bolter")).toBeNull();
    expect(view.queryByText("Fixture retained reviewed text")).toBeNull();
  });
  test("read-only linked viewer receives provenance without management or sharing authority", async () => {
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}` ? { link: { ...link, canManage: false, canSend: false } } : defaults(path, method, body);
    const view = render(<BolterRoomSection roomId={ROOM} scopeKey="fixture-scope" />);
    await waitFor(() => expect(view.getByText("Fixture agent → Fixture chat")).toBeTruthy());
    expect(view.queryByRole("button", { name: "Pause link" })).toBeNull();
    expect(view.queryByRole("button", { name: "Unlink", exact: true })).toBeNull();
    expect(writes).toEqual([]);
  });
  test("ordinary unlinked room renders no outbound control", async () => {
    let reads = 0;
    responder = () => { reads++; return { link: null }; };
    const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture-scope" />);
    await waitFor(() => expect(reads).toBe(1));
    expect(view.container.textContent).toBe("");
  });
});


describe("Bolter owner state invalidation", () => {
  function invalidate() {
    act(() => { window.dispatchEvent(new CustomEvent("nautilo:bolter-state-changed")); });
  }
  test("receiver changes reach both independent Room views without manual reload", async () => {
    let listening = false;
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}`
      ? { link: { ...link, receiver: listening ? "listening" : "running", canSend: listening } }
      : defaults(path, method, body);
    const view = render(<><BolterRoomSection roomId={ROOM} scopeKey="fixture" /><BolterMessageComposer roomId={ROOM} scopeKey="fixture" /></>);
    await view.findByRole("button", { name: "Open Bolter draft" });
    fireEvent.click(view.getByRole("button", { name: "Open Bolter draft" }));
    input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture draft");
    expect((view.getByRole("button", { name: "Review & send" }) as HTMLButtonElement).disabled).toBe(true);
    listening = true; invalidate();
    await waitFor(() => expect((view.getByRole("button", { name: "Review & send" }) as HTMLButtonElement).disabled).toBe(false));
    expect(view.getAllByText(/Listening/).length).toBeGreaterThan(0);
  });
  test("invalidation coalesces behind an outstanding Room read and rejects its stale response", async () => {
    const late = deferred<unknown>(); let reads = 0;
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}`
      ? ++reads === 1 ? late.promise : { link: { ...link, canSend: false, receiver: "stopped" } }
      : defaults(path, method, body);
    const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture" />);
    await waitFor(() => expect(reads).toBe(1));
    invalidate(); invalidate();
    expect(reads).toBe(1);
    await act(async () => { late.resolve({ link }); await late.promise; });
    await view.findByRole("button", { name: "Open Bolter draft" });
    fireEvent.click(view.getByRole("button", { name: "Open Bolter draft" }));
    expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).disabled).toBe(true);
    expect(reads).toBe(2);
  });
  test("an automatic state refresh cannot unlock controls while a mutation is pending", async () => {
    const mutation = deferred<unknown>();
    let paused = false;
    responder = (path, method, body) => {
      if (path === `/api/bolter/connections/${CONNECTION}` && method === "PATCH") return mutation.promise;
      if (path === "/api/bolter/connections") return {
        connections: [{ ...connection, status: paused ? "paused" : "connected", revision: paused ? 3 : 2 }],
        availability: { state: "available" }, desktops: [],
      };
      return defaults(path, method, body);
    };
    const view = render(<BolterConnectionSection scopeKey="fixture" onRoomCreated={async () => {}} />);
    const check = await view.findByRole("button", { name: "Check connection" });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(view.getByRole("button", { name: "Pause connection" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    paused = true; invalidate();
    const resume = await view.findByRole("button", { name: "Resume connection" });
    // The refreshed catalogue has finished, but the original mutation has not.
    await act(async () => {});
    expect((check as HTMLButtonElement).disabled).toBe(true);
    expect((resume as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(resume);
    expect(writes).toHaveLength(1);
    await act(async () => { mutation.resolve({ ...connection, status: "paused", revision: 3 }); await mutation.promise; });
    await waitFor(() => expect((check as HTMLButtonElement).disabled).toBe(false));
    expect(writes).toHaveLength(1);
  });
  test("Connections refreshes receiver status and coalesces stale catalogue reads", async () => {
    const late = deferred<unknown>(); let reads = 0;
    responder = (path, method, body) => path === "/api/bolter/connections"
      ? ++reads === 1 ? late.promise : { connections: [{ ...connection, receiver: "running" }], availability: { state: "available" }, desktops: [] }
      : defaults(path, method, body);
    const view = render(<BolterConnectionSection scopeKey="fixture" onRoomCreated={async () => {}} />);
    await waitFor(() => expect(reads).toBe(1));
    invalidate(); invalidate();
    expect(reads).toBe(1);
    await act(async () => { late.resolve({ connections: [connection], availability: { state: "available" }, desktops: [] }); await late.promise; });
    await waitFor(() => expect(view.getByText(/Receiver running/)).toBeDefined());
    expect(reads).toBe(2);
    expect(view.queryByText(/^Listening/)).toBeNull();
  });
});

describe("foldaway Bolter composer", () => {
  beforeEach(() => { window.localStorage.clear(); });
  async function open(viewerId = "fixture-viewer") {
    const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture" viewerId={viewerId} />);
    fireEvent.click(await view.findByRole("button", { name: "Open Bolter draft" }));
    return view;
  }
  test("direct send skips preview and remembers the choice only for this viewer and connection", async () => {
    const view = await open();
    input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture direct message");
    fireEvent.click(view.getByRole("checkbox", { name: "Review before sending" }));
    fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(view.queryByRole("region", { name: "Review message for Bolter" })).toBeNull();
    expect(writes[0]!.body["content"]).toBe("Fixture direct message");
    view.unmount();
    const same = await open();
    expect((same.getByRole("checkbox") as HTMLInputElement).checked).toBe(false);
    same.unmount();
    const other = await open("other-fixture-viewer");
    expect((other.getByRole("checkbox") as HTMLInputElement).checked).toBe(true);
  });
  test("folding preserves text and selected files, and sends only the explicit file IDs", async () => {
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}` ? { link: { ...link, canAttach: true } } : defaults(path, method, body);
    const upload = spyOn(apiClient, "uploadMessageAttachment").mockResolvedValue({ attachmentId: OTHER_ROOM, filename: "brief.txt", mimeType: "text/plain", sizeBytes: 5, status: "pending" });
    try {
      const view = await open();
      input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture draft");
      fireEvent.change(view.getByLabelText("Choose files for Bolter"), { target: { files: [new File(["brief"], "brief.txt")] } });
      await waitFor(() => expect(view.getByText("· ready")).toBeTruthy());
      fireEvent.click(view.getByRole("checkbox"));
      fireEvent.click(view.getByRole("button", { name: "Minimize Bolter draft" }));
      expect(view.queryByRole("textbox", { name: "Message to Bolter" })).toBeNull();
      fireEvent.click(view.getByRole("button", { name: "Open Bolter draft" }));
      expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).value).toBe("Fixture draft");
      expect(view.getByRole("button", { name: "Remove brief.txt" })).toBeTruthy();
      fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
      await waitFor(() => expect(writes).toHaveLength(1));
      expect(writes[0]!.body["attachmentIds"]).toEqual([OTHER_ROOM]);
      expect(upload.mock.calls[0]?.[2]).toEqual({ roomId: ROOM, purpose: "bolter" });
    } finally { upload.mockRestore(); }
  });
  test("removed pending files cannot reappear or become part of a send", async () => {
    responder = (path, method, body) => path === `/api/bolter/rooms/${ROOM}` ? { link: { ...link, canAttach: true } } : defaults(path, method, body);
    const pending = deferred<Awaited<ReturnType<typeof apiClient.uploadMessageAttachment>>>();
    const upload = spyOn(apiClient, "uploadMessageAttachment").mockReturnValue(pending.promise);
    const remove = spyOn(apiClient, "deleteMessageAttachment").mockResolvedValue({ ok: true });
    try {
      const view = await open();
      input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture with file");
      fireEvent.change(view.getByLabelText("Choose files for Bolter"), { target: { files: [new File(["brief"], "brief.txt")] } });
      expect((view.getByRole("button", { name: "Review & send" }) as HTMLButtonElement).disabled).toBe(true);
      fireEvent.click(view.getByRole("button", { name: "Remove brief.txt" }));
      await act(async () => { pending.resolve({ attachmentId: OTHER_ROOM, filename: "brief.txt", mimeType: "text/plain", sizeBytes: 5, status: "pending" }); });
      expect(view.queryByRole("button", { name: "Remove brief.txt" })).toBeNull();
      expect(remove).toHaveBeenCalledWith(OTHER_ROOM);
      expect(writes).toHaveLength(0);
    } finally { upload.mockRestore(); remove.mockRestore(); }
  });
  test.each(["nautilo:bolter-state-changed", "nautilo:reconnect-reconciled"])("delivery refresh on %s never erases a newer draft", async event => {
    let delivered = false;
    responder = (path, method, body) => path.endsWith("/deliveries") ? { deliveries: [{ messageId: 1, outboxId: OUTBOX,
      requestId: writes[0]?.body["requestId"] ?? null, state: delivered ? "published" : "pending", createdAt: "2030-01-01T00:00:00Z" }] } : defaults(path, method, body);
    const view = await open();
    input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture first message");
    fireEvent.click(view.getByRole("checkbox"));
    fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
    await view.findByText("Queued for Bolter");
    input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture next draft");
    delivered = true;
    act(() => { window.dispatchEvent(new CustomEvent(event)); });
    await view.findByText("Sent to Bolter");
    expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).value).toBe("Fixture next draft");
    expect(writes).toHaveLength(1);
    expect(view.queryByRole("button", { name: "Check delivery" })).toBeNull();
  });
});

test("an explicit HTTP rejection preserves editable draft text without inventing an uncertain send", async () => {
  responder = (path, method, body) => path.endsWith("/messages")
    ? new Response(JSON.stringify({ code: "invalid_request" }), { status: 400, headers: { "content-type": "application/json" } })
    : defaults(path, method, body);
  const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture" />);
  fireEvent.click(await view.findByRole("button", { name: "Open Bolter draft" }));
  input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture rejected draft");
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
  await view.findByText(/Bolter did not accept this message/);
  expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).value).toBe("Fixture rejected draft");
  expect((view.getByRole("checkbox") as HTMLInputElement).disabled).toBe(false);
  expect(view.queryByRole("button", { name: "Recover same request" })).toBeNull();
  expect(writes).toHaveLength(1);
});

test.each(["pending", "lost"])("a late %s HTTP response cannot undo confirmed delivery or replace a newer draft", async outcome => {
  const late = deferred<unknown>();
  responder = (path, method, body) => path.endsWith("/messages") ? late.promise
    : path.endsWith("/deliveries") ? { deliveries: [{ messageId: 1, outboxId: OUTBOX, requestId: writes[0]?.body["requestId"],
      state: "published", createdAt: "2030-01-01T00:00:00Z" }] } : defaults(path, method, body);
  const view = render(<BolterMessageComposer roomId={ROOM} scopeKey="fixture" />);
  fireEvent.click(await view.findByRole("button", { name: "Open Bolter draft" }));
  input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture sent message");
  fireEvent.click(view.getByRole("checkbox"));
  fireEvent.click(view.getByRole("button", { name: "Send to Bolter", exact: true }));
  await view.findByText("Sent to Bolter");
  expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).disabled).toBe(false);
  input(view.getByRole("textbox", { name: "Message to Bolter" }), "Fixture newer draft");
  await act(async () => {
    late.resolve(outcome === "pending" ? { messageId: 1, outboxId: OUTBOX, state: "pending" }
      : new Response(JSON.stringify({ code: "runtime_unavailable" }), { status: 503, headers: { "content-type": "application/json" } }));
    await late.promise;
  });
  expect(view.getByText("Sent to Bolter")).toBeTruthy();
  expect(view.queryByRole("alert")).toBeNull();
  expect((view.getByRole("textbox", { name: "Message to Bolter" }) as HTMLTextAreaElement).value).toBe("Fixture newer draft");
  expect(writes).toHaveLength(1);
});
