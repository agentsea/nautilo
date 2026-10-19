import { describe, expect, test } from "bun:test";
import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";

const ID = "10000000-0000-4000-8000-000000000001";
const ROOM = "10000000-0000-4000-8000-000000000002";
const connection = { id: ID, revision: 2, displayName: "Fixture connection", identity: { label: "Fixture agent", providerAgentId: "fixture-agent" },
  device: { relayId: "fixture-device", label: "Fixture Desktop" }, status: "connected", receiver: "listening", canCreateRoom: true };
const link = { id: ID, revision: 3, roomId: ROOM, roomName: "Fixture exchange", agentId: ROOM, connectionId: ID,
  conversationLabel: "Fixture chat", chatId: "fixture-chat", threadRootId: null, providerAgentId: "fixture-agent", identityLabel: "Fixture agent",
  canManage: true, canSend: true, status: "active", receiver: "listening", outboundPolicy: "causal_replies_and_reviewed_messages", delivery: { pending: 0, uncertain: 0 } };
const operation = { operationId: ID, status: "completed", connection };
const delivery = { messageId: 1, outboxId: ID, state: "pending" as const };
function transport(response: unknown) {
  const seen: { path: string; method: string; body: unknown; authorization: string | null }[] = [];
  const fetchImpl: NautiloApiFetch = async (url, init) => {
    seen.push({ path: new URL(url instanceof Request ? url.url : url).pathname, method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      authorization: new Headers(init?.headers).get("authorization") });
    return new Response(JSON.stringify(response), { headers: { "content-type": "application/json" } });
  };
  const client = new NautiloApiClient("https://fixture.invalid", { fetchImpl }); client.setToken("fixture-token");
  return { client, seen };
}

describe("Bolter canonical HTTP client", () => {
  test("uses authenticated exact routes and strict projections for reads", async () => {
    const cases: { response: unknown; path: string; invoke: (client: NautiloApiClient) => Promise<unknown> }[] = [
      { response: { connections: [connection], availability: { state: "available" }, desktops: [{ relayId: "fixture-device", label: "Fixture Desktop" }] }, path: "/connections", invoke: client => client.getBolterConnections() },
      { response: operation, path: `/operations/${ID}`, invoke: client => client.getBolterOperation(ID) },
      { response: { status: "available", conversations: [{ id: "fixture-choice", label: "Fixture chat", chatId: "fixture-chat", threadRootId: null }] }, path: `/connections/${ID}/conversations`, invoke: client => client.getBolterConversations(ID) },
      { response: { links: [link] }, path: `/connections/${ID}/rooms`, invoke: client => client.getBolterRoomLinks(ID) },
      { response: { link }, path: `/rooms/${ROOM}`, invoke: client => client.getBolterRoom(ROOM) },
      { response: { deliveries: [{ ...delivery, requestId: ID, createdAt: "2030-01-01T00:00:00Z" }] }, path: `/bindings/${ID}/deliveries`, invoke: client => client.getBolterDeliveries(ID) },
    ];
    for (const item of cases) {
      const f = transport(item.response); expect(await item.invoke(f.client)).toEqual(item.response);
      expect(f.seen).toEqual([{ path: `/api/bolter${item.path}`, method: "GET", body: null, authorization: "Bearer fixture-token" }]);
    }
  });
  test("preserves exact reviewed text and request identity across explicit retry", async () => {
    const f = transport(delivery);
    const input = { expectedRevision: 3, requestId: ID, content: "  Fixture text\n/command stays literal\n  " };
    expect(await f.client.sendBolterMessage(ID, input)).toEqual(delivery);
    expect(await f.client.sendBolterMessage(ID, input)).toEqual(delivery);
    expect(f.seen.map(item => item.body)).toEqual([input, input]);
    expect(f.seen.every(item => item.path === `/api/bolter/bindings/${ID}/messages` && item.method === "POST")).toBe(true);
  });
  test("mutations send only consent, selection and revision fields", async () => {
    const cases: { response: unknown; path: string; method: string; body: unknown; invoke: (client: NautiloApiClient) => Promise<unknown> }[] = [
      { response: operation, path: "/connections/connect", method: "POST", body: {}, invoke: client => client.connectBolter() },
      { response: operation, path: `/operations/${ID}/cancel`, method: "POST", body: {}, invoke: client => client.cancelBolterOperation(ID) },
      { response: connection, path: `/connections/${ID}/check`, method: "POST", body: {}, invoke: client => client.checkBolterConnection(ID) },
      { response: connection, path: `/connections/${ID}`, method: "PATCH", body: { expectedRevision: 2, enabled: false }, invoke: client => client.updateBolterConnection(ID, { expectedRevision: 2, enabled: false }) },
      { response: connection, path: `/connections/${ID}`, method: "DELETE", body: { expectedRevision: 2 }, invoke: client => client.revokeBolterConnection(ID, { expectedRevision: 2 }) },
      { response: { roomId: ROOM, link }, path: `/connections/${ID}/rooms`, method: "POST", body: { choiceId: "fixture-choice", agentId: ROOM, name: "Fixture room", modelSponsorshipAccepted: true }, invoke: client => client.createBolterRoom(ID, { choiceId: "fixture-choice", agentId: ROOM, name: "Fixture room", modelSponsorshipAccepted: true }) },
      { response: link, path: `/bindings/${ID}`, method: "PATCH", body: { expectedRevision: 3, state: "paused" }, invoke: client => client.updateBolterBinding(ID, { expectedRevision: 3, state: "paused" }) },
    ];
    for (const item of cases) {
      const f = transport(item.response); expect(await item.invoke(f.client)).toEqual(item.response);
      expect(f.seen[0]).toEqual({ path: `/api/bolter${item.path}`, method: item.method, body: item.body, authorization: "Bearer fixture-token" });
    }
  });
  test("rejects authority-bearing request additions before dispatch", () => {
    const f = transport(delivery);
    expect(() => f.client.sendBolterMessage(ID, { expectedRevision: 3, requestId: ID, content: "Fixture text", ownerId: ROOM } as never)).toThrow();
    expect(() => f.client.createBolterRoom(ID, { choiceId: "fixture-choice", agentId: ROOM, name: "Fixture room", modelSponsorshipAccepted: false } as never)).toThrow();
    expect(() => f.client.connectBolter({ homePath: "fixture-path" } as never)).toThrow();
    expect(f.seen).toEqual([]);
  });
  test("rejects private transport data and off-origin sign-in links", async () => {
    const f = transport({ connections: [{ ...connection, homeHandle: "fixture-home" }], availability: { state: "available" }, desktops: [{ relayId: "fixture-device", label: "Fixture Desktop" }] });
    expect(await f.client.getBolterConnections().then(() => false, () => true)).toBe(true);
    const auth = transport({ operationId: ID, status: "auth_pending", auth: { url: "https://fixture.invalid/auth", code: "fixture-code" } });
    expect(await auth.client.connectBolter().then(() => false, () => true)).toBe(true);
  });
  test("credential switch during header preparation rejects before any connect dispatch", async () => {
    const f = transport(operation);
    let resolve!: (token: string) => void;
    f.client.setTokenProvider(() => new Promise<string>(done => { resolve = done; }));
    const pending = f.client.connectBolter();
    f.client.setToken("fixture-new-human-token");
    resolve("fixture-new-human-token");
    expect(await pending.then(() => null, (error: unknown) => error instanceof Error ? error.message : null)).toContain("session changed");
    expect(f.seen).toEqual([]);
  });
  test("401 from an old Human cannot replay connect under a replacement token", async () => {
    let complete!: (response: Response) => void;
    let dispatches = 0;
    const client = new NautiloApiClient("https://fixture.invalid", { fetchImpl: async () => {
      dispatches++; return new Promise<Response>(done => { complete = done; });
    } });
    client.setToken("fixture-old-human-token");
    client.setUnauthorizedResponseHandler(async () => "fixture-new-human-token");
    const pending = client.connectBolter();
    await Promise.resolve(); await Promise.resolve();
    client.setToken("fixture-new-human-token");
    complete(new Response("{}", { status: 401 }));
    expect(await pending.then(() => null, (error: unknown) => error instanceof Error ? error.message : null)).toContain("session changed");
    expect(dispatches).toBe(1);
  });
});

test("status refresh requests only its exact outbox or submitted request", async () => {
  const seen: URL[] = [];
  const client = new NautiloApiClient("https://fixture.invalid", { fetchImpl: async url => {
    seen.push(new URL(url instanceof Request ? url.url : url));
    return new Response(JSON.stringify({ deliveries: [] }), { headers: { "content-type": "application/json" } });
  } });
  client.setToken("fixture-token");
  await client.getBolterDeliveries(ID, undefined, { outboxId: ROOM });
  await client.getBolterDeliveries(ID, undefined, { requestId: ROOM });
  expect(seen.map(url => url.search)).toEqual([`?outboxId=${ROOM}`, `?requestId=${ROOM}`]);
});
