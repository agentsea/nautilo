/**
 * M161 Phase 1 — ServerSessionRegistry unit tests.
 *
 * Mocks `electron` per the `recent-servers.test.ts` pattern so the
 * registry can be exercised without a live Electron renderer. The
 * registry does not construct `WebContentsView` in Phase 1, so the
 * mock only needs to satisfy the type-only import.
 */
import { describe, expect, mock, test } from "bun:test";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
}));

// `url-canonical` imports `@nautilo/config/loopback-origin`, which is
// dependency-free — no mock needed.

let { ServerSessionRegistry } = await import("../../electron/server-sessions/registry");
let { serverUrlScope } = await import("../../electron/auth/token-store");

describe("ServerSessionRegistry (M161 Phase 1)", () => {
  test("list() is empty before ensure", () => {
    const r = new ServerSessionRegistry();
    expect(r.list()).toEqual([]);
  });

  test("active is null before ensure", () => {
    const r = new ServerSessionRegistry();
    expect(r.active).toBeNull();
  });

  test("ensure creates a session and marks it active", async () => {
    const r = new ServerSessionRegistry();
    const s = await r.ensure("https://example.com/");
    expect(s.scope).toBe(serverUrlScope("https://example.com"));
    expect(s.scope).toHaveLength(16);
    expect(s.serverUrl).toBe("https://example.com");
    expect(s.partition).toBe(`persist:server-${serverUrlScope("https://example.com")}`);
    expect(s.view).toBeNull();
    expect(s.logtoConfig).toBeNull();
    expect(s.signedIn).toBe(false);
    expect(s.relayActive).toBe(false);
    expect(s.profile).toBeNull();
    expect(s.connection).toBe("connecting");
    expect(r.active).toBe(s);
    expect(r.list()).toHaveLength(1);
    expect(r.list()[0]?.url).toBe("https://example.com");
  });

  test("ensure is idempotent — same URL returns the same session", async () => {
    const r = new ServerSessionRegistry();
    const a = await r.ensure("https://example.com/");
    const b = await r.ensure("https://example.com");
    expect(b).toBe(a);
    expect(r.list()).toHaveLength(1);
  });

  test("active is the first ensured session", async () => {
    const r = new ServerSessionRegistry();
    const first = await r.ensure("https://a.example");
    await r.ensure("https://b.example");
    expect(r.active).toBe(first);
  });

  test("scope/partition derive from the canonical URL (mixed-case + trailing slash)", async () => {
    const r = new ServerSessionRegistry();
    const s = await r.ensure("HTTPS://Example.COM/");
    const expectedScope = serverUrlScope("https://example.com");
    expect(s.scope).toBe(expectedScope);
    expect(s.scope).toHaveLength(16);
    expect(s.serverUrl).toBe("https://example.com");
    expect(s.partition).toBe(`persist:server-${expectedScope}`);
  });

  test("getBySender returns null for unknown ids", () => {
    const r = new ServerSessionRegistry();
    expect(r.getBySender(1)).toBeNull();
    expect(r.getBySender(99999)).toBeNull();
  });

  test("attachSender binds a sender and getBySender resolves it", async () => {
    const r = new ServerSessionRegistry();
    const s = await r.ensure("https://example.com");
    expect(r.attachSender(42, s.scope)).toBe(true);
    expect(r.getBySender(42)).toBe(s);
    expect(r.attachSender(42, s.scope)).toBe(true);
  });

  test("attachSender is a no-op for an unknown scope", async () => {
    const r = new ServerSessionRegistry();
    expect(r.attachSender(7, "0000000000000000")).toBe(false);
    expect(r.getBySender(7)).toBeNull();
  });

  test("attachSender fails closed when a sender is already bound to another scope", async () => {
    const r = new ServerSessionRegistry();
    const a = await r.ensure("https://a.example");
    const b = await r.ensure("https://b.example");
    expect(r.attachSender(100, a.scope)).toBe(true);
    expect(r.getBySender(100)).toBe(a);
    expect(r.attachSender(100, b.scope)).toBe(false);
    expect(r.getBySender(100)).toBe(a);
  });

  test("switchTo marks an existing session active; unknown URL is a no-op", async () => {
    const r = new ServerSessionRegistry();
    const a = await r.ensure("https://a.example");
    const b = await r.ensure("https://b.example");
    expect(r.active).toBe(a);
    await r.switchTo("https://b.example");
    expect(r.active).toBe(b);
    await r.switchTo("https://nope.example");
    expect(r.active).toBe(b);
  });

  test("close removes the session and clears its sender mappings", async () => {
    const r = new ServerSessionRegistry();
    const a = await r.ensure("https://a.example");
    r.attachSender(5, a.scope);
    expect(r.getBySender(5)).toBe(a);
    await r.close("https://a.example");
    expect(r.list()).toEqual([]);
    expect(r.active).toBeNull();
    expect(r.getBySender(5)).toBeNull();
  });

  test("close removes active A only after the injected fallback proves B active", async () => {
    const r = new ServerSessionRegistry();
    const a = await r.ensure("https://a.example");
    const b = await r.ensure("https://b.example");
    const activations: string[] = [];
    r.configure({
      activateFallback: async (url) => {
        activations.push(url);
        return (await r.switchTo(url)).ok
          ? { kind: "activated" }
          : { kind: "indeterminate" };
      },
    });
    await r.switchTo("https://a.example");
    expect(r.active).toBe(a);
    expect(await r.close("https://a.example")).toEqual({ ok: true });
    expect(activations).toEqual(["https://b.example"]);
    expect(r.active).toBe(b);
    expect(r.list().map((entry) => entry.url)).toEqual(["https://b.example"]);
  });

  test("list() entry shape — empty iconUrl when no profile", async () => {
    const r = new ServerSessionRegistry();
    await r.ensure("https://example.com");
    const entry = r.list()[0]!;
    expect(entry).toEqual({
      url: "https://example.com",
      iconUrl: "",
      connection: "connecting",
    });
    expect(entry).not.toHaveProperty("view");
    expect(entry).not.toHaveProperty("partition");
  });
});

describe("ServerSessionRegistry D552 deterministic enriched order", () => {
  test("freezes durable recency order after a recent-only server materializes", async () => {
    const r = new ServerSessionRegistry();
    let pending = new Map<string, () => void>();
    let recents: Array<{ url: string; lastUsedAt: string; fingerprint?: string }> = [
      {
        url: "https://alpha.example",
        fingerprint: "alpha-fingerprint",
        lastUsedAt: "2026-08-04T00:00:00.000Z",
      },
      {
        url: "https://alpha-alias.example",
        fingerprint: "alpha-fingerprint",
        lastUsedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        url: "https://bravo.example",
        lastUsedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        url: "https://charlie.example",
        lastUsedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        url: "https://delta.example",
        lastUsedAt: "2026-08-02T00:00:00.000Z",
      },
    ];

    r.configure({
      listRecents: () => recents,
      fetchListSetupStatus: async (url) => {
        await new Promise<void>((resolve) => pending.set(url, resolve));
        return {
          kind: "live",
          profile: {
            name: new URL(url).hostname,
            icon: { kind: "preset", id: "preset-orbit" },
          },
        };
      },
    });

    const settle = (urls: string[]) => {
      for (const url of urls) {
        const resolve = pending.get(url);
        expect(resolve).toBeDefined();
        resolve?.();
      }
    };
    const expectedOrder = [
      "https://alpha.example",
      "https://bravo.example",
      "https://charlie.example",
      "https://delta.example",
    ];

    const firstRefresh = r.listEnriched();
    settle([
      "https://delta.example",
      "https://charlie.example",
      "https://bravo.example",
      "https://alpha.example",
    ]);
    const firstEntries = await firstRefresh;

    // Bravo and Charlie have equal recency, so their canonical URLs break
    // the tie. The fingerprinted Alpha aliases remain one safe row.
    expect(firstEntries.map((entry) => entry.url)).toEqual(expectedOrder);
    expect(firstEntries.filter((entry) => entry.fingerprint === "alpha-fingerprint")).toHaveLength(1);

    // Charlie starts recent-only. Materializing/selecting it changes the
    // sessions map's insertion order, then the simulated recents write makes
    // it newest; neither event may move an already-visible row.
    await r.switchTo("https://charlie.example");
    recents = recents.map((recent) =>
      recent.url === "https://charlie.example"
        ? { ...recent, lastUsedAt: "2026-08-05T00:00:00.000Z" }
        : recent,
    );
    pending = new Map();
    const secondRefresh = r.listEnriched();
    settle([
      "https://bravo.example",
      "https://delta.example",
      "https://charlie.example",
      "https://alpha.example",
    ]);
    const entries = await secondRefresh;

    expect(entries.map((entry) => entry.url)).toEqual(expectedOrder);
    expect(entries.find((entry) => entry.url === "https://charlie.example")?.active).toBe(true);
    expect(entries.filter((entry) => entry.fingerprint === "alpha-fingerprint")).toHaveLength(1);
  });

  test("appends new membership deterministically after removing a ranked row", async () => {
    const r = new ServerSessionRegistry();
    let recents: Array<{ url: string; lastUsedAt: string }> = [
      { url: "https://alpha.example", lastUsedAt: "2026-08-03T00:00:00.000Z" },
      { url: "https://bravo.example", lastUsedAt: "2026-08-02T00:00:00.000Z" },
      { url: "https://charlie.example", lastUsedAt: "2026-08-01T00:00:00.000Z" },
    ];
    r.configure({
      listRecents: () => recents,
      fetchListSetupStatus: async () => ({ kind: "offline" }),
    });

    expect((await r.listEnriched()).map((entry) => entry.url)).toEqual([
      "https://alpha.example",
      "https://bravo.example",
      "https://charlie.example",
    ]);

    recents = [
      { url: "https://bravo.example", lastUsedAt: "2026-08-05T00:00:00.000Z" },
      { url: "https://charlie.example", lastUsedAt: "2026-08-04T00:00:00.000Z" },
      { url: "https://echo.example", lastUsedAt: "2026-08-03T00:00:00.000Z" },
      { url: "https://delta.example", lastUsedAt: "2026-08-03T00:00:00.000Z" },
    ];
    expect((await r.listEnriched()).map((entry) => entry.url)).toEqual([
      "https://bravo.example",
      "https://charlie.example",
      "https://delta.example",
      "https://echo.example",
    ]);
  });

  test("gives aliases unique frozen ranks when trusted metadata splits their row", async () => {
    const r = new ServerSessionRegistry();
    let recents: Array<{ url: string; lastUsedAt: string; fingerprint: string }> = [
      {
        url: "https://alpha.example",
        fingerprint: "shared-fingerprint",
        lastUsedAt: "2026-08-04T00:00:00.000Z",
      },
      {
        url: "https://beta.example",
        fingerprint: "shared-fingerprint",
        lastUsedAt: "2026-08-03T00:00:00.000Z",
      },
      {
        url: "https://charlie.example",
        fingerprint: "charlie-fingerprint",
        lastUsedAt: "2026-08-02T00:00:00.000Z",
      },
    ];
    r.configure({
      listRecents: () => recents,
      fetchListSetupStatus: async () => ({ kind: "offline" }),
    });

    expect((await r.listEnriched()).map((entry) => entry.url)).toEqual([
      "https://alpha.example",
      "https://charlie.example",
    ]);

    recents = [
      {
        url: "https://alpha.example",
        fingerprint: "alpha-fingerprint",
        lastUsedAt: "2026-08-01T00:00:00.000Z",
      },
      {
        url: "https://beta.example",
        fingerprint: "beta-fingerprint",
        lastUsedAt: "2026-08-05T00:00:00.000Z",
      },
      {
        url: "https://charlie.example",
        fingerprint: "charlie-fingerprint",
        lastUsedAt: "2026-08-02T00:00:00.000Z",
      },
    ];
    expect((await r.listEnriched()).map((entry) => entry.url)).toEqual([
      "https://alpha.example",
      "https://beta.example",
      "https://charlie.example",
    ]);

    recents = recents.map((recent) =>
      recent.url === "https://alpha.example"
        ? { ...recent, lastUsedAt: "2026-08-06T00:00:00.000Z" }
        : recent,
    );
    expect((await r.listEnriched()).map((entry) => entry.url)).toEqual([
      "https://alpha.example",
      "https://beta.example",
      "https://charlie.example",
    ]);
  });
});

describe("ServerSessionRegistry M240 notification summaries", () => {
  const summary = (
    epoch: string,
    generation: number,
    unreadCount: number,
    importantUnreadCount: number,
  ) => ({
    epoch,
    generation,
    generatedAt: "2026-08-04T12:00:00.000Z",
    unreadCount,
    importantUnreadCount,
  });

  test("accepts registered background senders and rejects invalid ordering", async () => {
    let nowMs = 1_000;
    const r = new ServerSessionRegistry(() => nowMs);
    const active = r.ensure("https://active.example");
    const background = r.ensure("https://background.example");
    active.signedIn = true;
    active.connection = "live";
    background.signedIn = true;
    background.connection = "live";
    r.attachSender(1, active.scope);
    r.attachSender(2, background.scope);

    expect(r.publishNotificationSummary(999, summary("a", 1, 1, 1))).toEqual({
      ok: false,
      reason: "unregistered-sender",
    });
    expect(r.publishNotificationSummary(2, summary("b", 1, 4, 2))).toEqual({
      ok: true,
    });
    expect(r.publishNotificationSummary(2, summary("b", 1, 5, 3))).toEqual({
      ok: false,
      reason: "stale-generation",
    });
    expect(r.publishNotificationSummary(2, summary("c", 2, 5, 3))).toEqual({
      ok: false,
      reason: "stale-generation",
    });
    expect(r.publishNotificationSummary(2, summary("c", 1, 5, 3))).toEqual({
      ok: true,
    });
    expect(r.active).toBe(active);

    const listed = await r.listEnrichedResult();
    expect(listed.aggregate).toEqual({
      unreadCount: 5,
      importantUnreadCount: 3,
      unavailableServerCount: 1,
    });
    expect(
      listed.servers.find((entry) => entry.url === background.serverUrl)
        ?.notificationSummary,
    ).toEqual({
      state: "fresh",
      unreadCount: 5,
      importantUnreadCount: 3,
    });

    nowMs += 120_000;
    expect(r.getNotificationAggregate()).toEqual({
      unreadCount: 0,
      importantUnreadCount: 0,
      unavailableServerCount: 2,
    });
    expect(
      (await r.listEnrichedResult()).servers.find(
        (entry) => entry.url === background.serverUrl,
      )?.notificationSummary,
    ).toEqual({
      state: "stale",
      unreadCount: 5,
      importantUnreadCount: 3,
    });
  });

  test("sign-out clears user-private summary and close drops ordering state", async () => {
    const r = new ServerSessionRegistry(() => 1_000);
    const session = r.ensure("https://example.com");
    session.signedIn = true;
    session.connection = "live";
    r.attachSender(5, session.scope);
    expect(r.publishNotificationSummary(5, summary("a", 1, 2, 1))).toEqual({
      ok: true,
    });

    r.updateSession(session.serverUrl, { signedIn: false });
    expect((await r.listEnrichedResult()).servers[0]?.notificationSummary).toEqual({
      state: "unknown",
    });

    r.updateSession(session.serverUrl, { signedIn: true });
    expect(r.publishNotificationSummary(5, summary("a", 1, 3, 2))).toEqual({
      ok: true,
    });
    await r.close(session.serverUrl);
    expect(r.getNotificationAggregate()).toEqual({
      unreadCount: 0,
      importantUnreadCount: 0,
      unavailableServerCount: 0,
    });
  });

  test("renderer replacement and destruction clear summary and sender authority", async () => {
    const r = new ServerSessionRegistry(() => 1_000);
    const session = r.ensure("https://example.com");
    session.signedIn = true;
    session.connection = "live";
    r.attachSender(5, session.scope);
    expect(r.publishNotificationSummary(5, summary("a", 1, 2, 1))).toEqual({
      ok: true,
    });

    expect(r.attachSender(6, session.scope)).toBe(true);
    expect(r.getBySender(5)).toBeNull();
    expect(r.getNotificationAggregate()).toEqual({
      unreadCount: 0,
      importantUnreadCount: 0,
      unavailableServerCount: 1,
    });
    expect(r.publishNotificationSummary(5, summary("a", 2, 3, 2))).toEqual({
      ok: false,
      reason: "unregistered-sender",
    });
    expect(r.publishNotificationSummary(6, summary("b", 1, 3, 2))).toEqual({
      ok: true,
    });

    r.detachSender(6);
    expect(r.getBySender(6)).toBeNull();
    expect((await r.listEnrichedResult()).servers[0]?.notificationSummary).toEqual({
      state: "unknown",
    });
  });

  test("deduplicates trusted aliases and uses the newest fresh summary once", async () => {
    let nowMs = 1_000;
    const r = new ServerSessionRegistry(() => nowMs);
    r.configure({
      listRecents: () => [
        {
          url: "https://one.example",
          fingerprint: "same-server",
          lastUsedAt: "2026-08-04T12:00:00.000Z",
        },
        {
          url: "https://alias.example",
          fingerprint: "same-server",
          lastUsedAt: "2026-08-04T12:01:00.000Z",
        },
      ],
    });
    const one = r.ensure("https://one.example");
    const alias = r.ensure("https://alias.example");
    one.signedIn = true;
    one.connection = "live";
    alias.signedIn = true;
    alias.connection = "live";
    r.attachSender(10, one.scope);
    r.attachSender(11, alias.scope);
    expect(r.publishNotificationSummary(10, summary("one", 1, 2, 1))).toEqual({
      ok: true,
    });
    nowMs += 1_000;
    expect(r.publishNotificationSummary(11, summary("alias", 1, 7, 4))).toEqual({
      ok: true,
    });

    const listed = await r.listEnrichedResult();
    expect(listed.servers).toHaveLength(1);
    expect(listed.servers[0]?.notificationSummary).toEqual({
      state: "fresh",
      unreadCount: 7,
      importantUnreadCount: 4,
    });
    expect(listed.aggregate).toEqual({
      unreadCount: 7,
      importantUnreadCount: 4,
      unavailableServerCount: 0,
    });
  });
});
