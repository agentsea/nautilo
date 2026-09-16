import { describe, expect, test } from "bun:test";
import { createLiveSessionFetch } from "../../src/lib/live-session-fetch";

const token = "session-a";
const capability = { sessionToken: token, expiresAt: Date.now() + 900_000 };
const issuePath = "/api/apps/slides/live-session";
const preparePath = `${issuePath}/prepare`;
const issuanceToken = "i".repeat(43);
const revokePath = `${issuePath}/revoke`;
const auth = { Authorization: "Bearer human" };
function storage(values = new Map<string, string>()) {
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
    copy: () => storage(new Map(values)),
  };
}
function lockManager() {
  const held = new Set<string>();
  return {
    async request(name: string, _options: { mode: "exclusive"; ifAvailable: true }, callback: (lock: object | null) => Promise<void>) {
      if (held.has(name)) return callback(null);
      held.add(name);
      try { await callback({}); } finally { held.delete(name); }
    },
  };
}
function setup(store = storage(), locks = lockManager(), failRevoke = false) {
  const calls: { path: string; init?: RequestInit }[] = [];
  let hide = (_persisted: boolean) => {};
  const transport: typeof fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path === revokePath && failRevoke) throw new Error("offline");
    return Response.json(path === issuePath ? capability : path === preparePath ? { issuanceToken } : { ok: true });
  };
  const fetcher = createLiveSessionFetch(transport, {
    storage: store, locks, onPageHide: (callback) => { hide = callback; },
  });
  return { fetcher, calls, hide: (persisted = false) => hide(persisted), store, locks };
}
const issue = (fetcher: typeof fetch) => fetcher(issuePath, { method: "POST", headers: auth, body: "{}" });
const chat = (fetcher: typeof fetch) => fetcher("/api/rooms/r/messages", { method: "POST", headers: auth, body: "draft" });
const settle = async () => { await new Promise((resolve) => setTimeout(resolve, 0)); };

describe("live mini-app unload and reload cleanup", () => {
  test("pagehide revokes the exact issued session with keepalive and existing auth", async () => {
    const app = setup();
    await issue(app.fetcher);
    app.hide();
    await settle();
    expect(app.calls[2]?.path).toBe(revokePath);
    expect(app.calls[2]?.init?.keepalive).toBe(true);
    expect(new Headers(app.calls[2]?.init?.headers).get("authorization")).toBe("Bearer human");
    expect(JSON.parse(String(app.calls[2]?.init?.body))).toEqual({
      clientSessionId: JSON.parse(String(app.calls[1]?.init?.body)).clientSessionId,
    });
    const reload = setup(app.store, app.locks);
    await chat(reload.fetcher);
    expect(reload.calls.map((c) => c.path)).toEqual(["/api/rooms/r/messages"]);
  });

  test("ordinary same-tab navigation recovers failed unload before the next agent mutation, without retaining auth headers", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    app.hide();
    await settle();
    expect(app.store.getItem("nautilo:live-mini-app-cleanup")).not.toContain("Bearer");
    const reload = setup(app.store, app.locks);
    await chat(reload.fetcher);
    expect(reload.calls.map((c) => c.path)).toEqual([revokePath, "/api/rooms/r/messages"]);
  });

  test("a duplicate/new tab does not revoke its opener's copied session", async () => {
    const app = setup();
    await issue(app.fetcher);
    const duplicate = setup(app.store.copy(), app.locks);
    await chat(duplicate.fetcher);
    expect(duplicate.calls.map((c) => c.path)).toEqual(["/api/rooms/r/messages"]);
    expect(duplicate.store.getItem("nautilo:live-mini-app-cleanup")).not.toBeNull();
    expect(app.store.getItem("nautilo:live-mini-app-cleanup")).not.toBeNull();
    app.hide();
    await settle();
    expect(app.calls.at(-1)?.path).toBe(revokePath);
  });

  test("a copied journal recovers when its owner leaves after an unavailable claim", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    const duplicate = setup(app.store.copy(), app.locks);
    await chat(duplicate.fetcher);
    expect(duplicate.calls.map((c) => c.path)).toEqual(["/api/rooms/r/messages"]);
    app.hide();
    await settle();
    await chat(duplicate.fetcher);
    expect(duplicate.calls.map((c) => c.path)).toEqual(["/api/rooms/r/messages", revokePath, "/api/rooms/r/messages"]);
    expect(duplicate.store.getItem("nautilo:live-mini-app-cleanup")).toBeNull();
  });

  test("recovery failure fences writes but permits reads and retries cleanup on the next attempt", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    app.hide();
    await settle();
    const reload = setup(app.store, app.locks, true);
    await expect(chat(reload.fetcher)).rejects.toThrow("offline");
    await reload.fetcher("/api/rooms/r/messages", { headers: auth });
    expect(reload.calls.map((c) => c.path)).toEqual([revokePath, "/api/rooms/r/messages"]);
    reload.hide();
    await settle();
    const retry = setup(app.store, app.locks);
    await chat(retry.fetcher);
    expect(retry.calls.map((c) => c.path)).toEqual([revokePath, "/api/rooms/r/messages"]);
  });

  test("ordinary close uses keepalive; a failed close is retried before another write", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    await expect(app.fetcher(revokePath, { method: "POST", headers: auth, body: JSON.stringify({ sessionToken: token }) })).rejects.toThrow();
    expect(app.calls[2]?.init?.keepalive).toBe(true);
    await expect(chat(app.fetcher)).rejects.toThrow();
    expect(app.calls.map((c) => c.path)).toEqual([preparePath, issuePath, revokePath, revokePath]);
  });

  test("live sessions are preserved across unrelated writes and BFCache suspension", async () => {
    const app = setup();
    await issue(app.fetcher);
    app.hide(true);
    await chat(app.fetcher);
    expect(app.calls.map((c) => c.path)).toEqual([preparePath, issuePath, "/api/rooms/r/messages"]);
  });

  test("a prepare response after pagehide cannot create a document lock", async () => {
    let finish!: (response: Response) => void;
    let hide = (_persisted: boolean) => {};
    const calls: string[] = [];
    const fetcher = createLiveSessionFetch(async (input) => {
      calls.push(String(input));
      return String(input) === preparePath ? new Promise<Response>((resolve) => { finish = resolve; }) : Response.json({ ok: true });
    }, { storage: storage(), locks: lockManager(), onPageHide: (callback) => { hide = callback; } });
    const pending = issue(fetcher);
    await settle();
    hide(false);
    finish(Response.json({ issuanceToken }));
    expect((await pending).status).toBe(409);
    expect(calls).not.toContain(issuePath);
    expect(calls).toContain(revokePath);
  });

  test("reload recovers an issuance whose response never reached the destroyed page", async () => {
    const store = storage();
    const locks = lockManager();
    let hide = (_persisted: boolean) => {};
    let issuedBody: Record<string, unknown> | undefined;
    const abandoned = createLiveSessionFetch(async (input, init) => {
      if (String(input) === preparePath) return Response.json({ issuanceToken });
      if (String(input) === issuePath) issuedBody = JSON.parse(String(init?.body));
      return new Promise<Response>(() => {});
    }, { storage: store, locks, onPageHide: callback => { hide = callback; } });
    void issue(abandoned);
    await settle();
    hide(false);
    await settle();
    const reload = setup(store, locks);
    await chat(reload.fetcher);
    expect(JSON.parse(String(reload.calls[0]?.init?.body))).toEqual({ clientSessionId: issuedBody?.clientSessionId });
    expect(reload.calls.map((c) => c.path)).toEqual([revokePath, "/api/rooms/r/messages"]);
    expect(JSON.stringify(issuedBody)).not.toContain(token);
  });

  test("cleanup 401 reaches the API bearer-refresh owner without dispatching the mutation", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    app.hide();
    await settle();
    const calls: string[] = [];
    const reload = createLiveSessionFetch(async (input, init) => {
      calls.push(String(input));
      if (new Headers(init?.headers).get("authorization") === "Bearer human") return Response.json({ error: "expired" }, { status: 401 });
      return Response.json({ ok: true });
    }, { storage: app.store, locks: app.locks, onPageHide: () => {} });
    expect((await chat(reload)).status).toBe(401);
    expect(calls).toEqual([revokePath]);
    await reload("/api/rooms/r/messages", { method: "POST", headers: { Authorization: "Bearer refreshed" }, body: "draft" });
    expect(calls).toEqual([revokePath, revokePath, "/api/rooms/r/messages"]);
  });

  test("unavailable ownership never erases recovery state or dispatches a write", async () => {
    const app = setup(storage(), lockManager(), true);
    await issue(app.fetcher);
    app.hide();
    await settle();
    const journal = app.store.getItem("nautilo:live-mini-app-cleanup");
    const calls: string[] = [];
    const unsupported = createLiveSessionFetch(async input => {
      calls.push(String(input)); return Response.json({ ok: true });
    }, { storage: app.store, locks: undefined, onPageHide: () => {} });
    await expect(chat(unsupported)).rejects.toThrow("coordinate document editors");
    expect(calls).toEqual([]);
    expect(app.store.getItem("nautilo:live-mini-app-cleanup")).toBe(journal);
  });

  test("leaving while ownership is being acquired never prepares or issues a session", async () => {
    let grant!: () => Promise<void>;
    let hide = (_persisted: boolean) => {};
    const calls: string[] = [];
    const store = storage();
    const fetcher = createLiveSessionFetch(async input => {
      calls.push(String(input)); return Response.json({ ok: true });
    }, { storage: store, locks: {
      request: async (_name, _options, callback) => { await new Promise<void>(resolve => { grant = async () => { await callback({}); resolve(); }; }); },
    }, onPageHide: callback => { hide = callback; } });
    const response = issue(fetcher);
    hide(false);
    void grant();
    expect((await response).status).toBe(409);
    expect(calls).toEqual([]);
    expect(store.getItem("nautilo:live-mini-app-cleanup")).toBeNull();
  });

});
