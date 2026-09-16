/**
 * M161 Phase 3.1 — in-process switchTo / add / close / onChanged / listEnriched.
 *
 * Exercises the registry's Phase 3 orchestration through injected hooks
 * (no live Electron / relay / network). Asserts:
 *   - switchTo creates the target view lazily, navigates it to `${url}/`,
 *     shows it, hides the previous view (kept alive), and hands the
 *     relay off to the target AFTER navigation (stop-before-start is
 *     inside the handoffRelay hook, covered by relay-active-handoff.test.ts).
 *   - a second switchTo to an already-loaded view does NOT re-navigate
 *     (preserves the background session's SPA state).
 *   - close destroys the view, drops the session, and fires onChanged.
 *   - onChanged is unsubscribe-safe and fires on switch/add/close.
 *   - listEnriched merges recents + live, enriches from setup status +
 *     icon URL, marks active/signedIn, degrades offline without dropping
 *     the entry, and copies the recent fingerprint.
 *   - re-auth is required only when credentials are absent (loadTokens null);
 *     a valid bundle is never cleared on an ordinary switch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ServerFallbackActivationResult } from "../../electron/server-sessions/registry";

mock.module("electron", () => ({
  app: { getPath: () => "/tmp", isPackaged: false },
}));

let tempRoot = "";

mock.module("electron-log/main", () => ({
  default: {
    warn: () => {},
    info: () => {},
    error: () => {},
  },
}));

mock.module("../../electron/paths", () => ({
  recentServersFilePath: () => path.join(tempRoot, "recent-servers.json"),
  browserControlStateFilePath: () => path.join(tempRoot, "browser-control-state.json"),
  browserControlAgentBrowserConfigPath: () =>
    path.join(tempRoot, "agent-browser-provider.json"),
  toolRuntimeConfigFilePath: () => path.join(tempRoot, "tool-runtimes.json"),
  localFileHistoryDirPath: () => path.join(tempRoot, "local-file-history"),
}));

let {
  ServerSessionRegistry,
  buildVersionedServerIconUrl,
  parseServerSetupStatusSummary,
} = await import("../../electron/server-sessions/registry");
let { serverUrlScope } = await import("../../electron/auth/token-store");
let recentServers = await import("../../electron/recent-servers");

type MockView = { id: number; _nautiloLoadedOnce?: boolean };

function makeHooks() {
  const calls: string[] = [];
  let nextViewId = 1;
  const views = new Map<string, MockView>();
  const createView = (session: { serverUrl: string }): MockView => {
    const v: MockView = { id: nextViewId++ };
    views.set(session.serverUrl, v);
    calls.push(`createView:${session.serverUrl}`);
    return v;
  };
  return {
    calls,
    views,
    hooks: {
      createView,
      showView: (v: MockView) => calls.push(`showView:${v.id}`),
      hideView: (v: MockView) => calls.push(`hideView:${v.id}`),
      setRendererActive: (v: MockView, active: boolean) =>
        calls.push(`active:${v.id}:${active}`),
      navigateView: (v: MockView, url: string) => calls.push(`navigateView:${v.id}:${url}`),
      navigateHome: (v: MockView) => calls.push(`navigateHome:${v.id}`),
      destroyView: (v: MockView) => calls.push(`destroyView:${v.id}`),
      activateFallback: undefined as ((serverUrl: string) => Promise<ServerFallbackActivationResult>) | undefined,
      handoffRelay: async (session: { serverUrl: string }) => {
        calls.push(`handoffRelay:${session.serverUrl}`);
      },
      resolveLogtoConfig: async (serverUrl: string) => {
        calls.push(`resolveLogtoConfig:${serverUrl}`);
        return true;
      },
      loadTokens: (serverUrl: string) => {
        calls.push(`loadTokens:${serverUrl}`);
        return null;
      },
      refreshTokens: async (serverUrl: string) => {
        calls.push(`refreshTokens:${serverUrl}`);
        return true;
      },
      probeFingerprint: async (serverUrl: string) => {
        calls.push(`probeFingerprint:${serverUrl}`);
        return {
          ok: true as const,
          fingerprint: serverUrl === "https://a.example" ? "fp-a" : `fp:${serverUrl}`,
        };
      },
      storeFingerprint: (serverUrl: string, fingerprint: string) => {
        calls.push(`storeFingerprint:${serverUrl}:${fingerprint}`);
        return true;
      },
      listRecents: () => [
        {
          url: "https://a.example",
          lastUsedAt: "2026-01-01T00:00:00.000Z",
          fingerprint: "fp-a",
        },
        {
          url: "https://offline.example",
          lastUsedAt: "2026-02-01T00:00:00.000Z",
        },
      ],
      fetchListSetupStatus: async (serverUrl: string) => {
        if (serverUrl === "https://offline.example") throw new Error("offline");
        return {
          kind: "live" as const,
          profile: {
            name: `${serverUrl}-name`,
            description: "desc",
            icon: { kind: "preset" as const, id: "preset-orbit" },
          },
        };
      },
      iconUrlFor: buildVersionedServerIconUrl,
    },
  };
}

describe("ServerSessionRegistry switch/add/close (M161 Phase 3.1)", () => {
  test("switchTo creates the target view, navigates to /, shows it, hides previous, hands relay off", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    expect(r.active).toBe(a);

    const ok = await r.switchTo("https://b.example");
    expect(ok).toEqual({ ok: true });
    expect(r.active).toBe(b);

    // View created for B (A had none and was never switched to).
    expect(calls).toContain("createView:https://b.example");
    const viewB = views.get("https://b.example")!;
    // Navigated to `${serverUrl}/` (lands target on /).
    expect(calls).toContain(`navigateView:${viewB.id}:https://b.example/`);
    // Target shown.
    expect(calls).toContain(`showView:${viewB.id}`);
    // Previous (A) had no view, so hideView is not called for it here.
    // Relay handed off to B AFTER navigation.
    const navIdx = calls.indexOf(`navigateView:${viewB.id}:https://b.example/`);
    const relayIdx = calls.indexOf("handoffRelay:https://b.example");
    expect(navIdx).toBeGreaterThanOrEqual(0);
    expect(relayIdx).toBeGreaterThan(navIdx);
    expect(calls).toContain("handoffRelay:https://b.example");
  });

  test("switchTo hides the previous view when it exists (previous kept alive)", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    r.configure(hooks);
    r.ensure("https://a.example");
    // First switch to A creates + shows A's view.
    await r.switchTo("https://a.example");
    const viewA = views.get("https://a.example")!;
    r.ensure("https://b.example");
    calls.length = 0;

    await r.switchTo("https://b.example");
    const viewB = views.get("https://b.example")!;
    // A hidden (not destroyed), B shown.
    expect(calls).toContain(`hideView:${viewA.id}`);
    expect(calls).toContain(`showView:${viewB.id}`);
    expect(calls).not.toContain(`destroyView:${viewA.id}`);
    // A's session is still alive in the registry.
    expect(r.list().map((e) => e.url)).toContain("https://a.example");
  });

  test("active lifecycle deactivates old renderer before activating new and clears closed state", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    hooks.activateFallback = async (url) => (await r.switchTo(url)).ok
      ? { kind: "activated" }
      : { kind: "indeterminate" };
    r.configure(hooks);
    r.ensure("https://a.example");
    r.ensure("https://b.example");
    await r.switchTo("https://a.example");
    const viewA = views.get("https://a.example")!;
    calls.length = 0;

    await r.switchTo("https://b.example");
    const viewB = views.get("https://b.example")!;
    expect(calls.indexOf(`active:${viewA.id}:false`)).toBeLessThan(
      calls.indexOf(`active:${viewB.id}:true`),
    );
    expect(calls.filter((call) => call.endsWith(":true"))).toEqual([
      `active:${viewB.id}:true`,
    ]);

    calls.length = 0;
    await r.close("https://b.example");
    expect(calls).toContain(`active:${viewB.id}:false`);
    expect(calls).toContain(`active:${viewA.id}:true`);
  });

  test("a second switchTo to an already-loaded view does NOT re-navigate (preserves SPA state)", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    r.configure(hooks);
    r.ensure("https://a.example");
    r.ensure("https://b.example");
    await r.switchTo("https://b.example");
    const viewB = views.get("https://b.example")!;
    const navCountBefore = calls.filter((c) => c.startsWith(`navigateView:${viewB.id}`)).length;
    expect(navCountBefore).toBe(1);

    // Switch away to A and back to B.
    calls.length = 0;
    await r.switchTo("https://a.example");
    await r.switchTo("https://b.example");
    // B was not re-navigated on the return switch.
    const navCountAfter = calls.filter((c) => c.startsWith(`navigateView:${viewB.id}`)).length;
    expect(navCountAfter).toBe(0);
    expect(calls).toContain(`navigateHome:${viewB.id}`);
  });

  test("recent-only target is lazily ensured and switched after fingerprint preflight", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://recent.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      fingerprint: "fp-recent",
    }];
    hooks.probeFingerprint = async (url) => {
      calls.push(`probeFingerprint:${url}`);
      return { ok: true, fingerprint: "fp-recent" };
    };
    r.configure(hooks);
    const current = r.ensure("https://a.example");

    expect(r.getByServerUrl("https://recent.example")).toBeNull();
    const result = await r.switchTo("HTTPS://RECENT.EXAMPLE/");
    expect(result).toEqual({ ok: true });
    expect(r.active?.serverUrl).toBe("https://recent.example");
    expect(r.active).not.toBe(current);
    expect(r.getByServerUrl("https://recent.example")).toBe(r.active);
    expect(calls.indexOf("probeFingerprint:https://recent.example")).toBeLessThan(
      calls.indexOf("createView:https://recent.example"),
    );
    expect(views.get("https://recent.example")).toBeDefined();
  });

  test("switchTo to an unknown URL is a no-op (active unchanged)", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    const ok = await r.switchTo("https://nope.example");
    expect(ok).toEqual({ ok: false, reason: "unknown-server" });
    expect(r.active).toBe(a);
    expect(calls).not.toContain("probeFingerprint:https://nope.example");
    expect(r.getByServerUrl("https://nope.example")).toBeNull();
  });

  test("fingerprint match activates target after preflight", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://b.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      fingerprint: "fp-b",
    }];
    hooks.probeFingerprint = async () => ({ ok: true, fingerprint: "fp-b" });
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    expect(r.active).toBe(a);

    const result = await r.switchTo(b.serverUrl);
    expect(result).toEqual({ ok: true });
    expect(r.active).toBe(b);
    expect(calls).toContain("createView:https://b.example");
  });

  test("fingerprint mismatch returns wrong-server and leaves current active/view visible", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://b.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      fingerprint: "expected-b",
    }];
    hooks.probeFingerprint = async () => ({ ok: true, fingerprint: "found-other" });
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    r.ensure("https://b.example");

    const result = await r.switchTo("https://b.example");
    expect(result).toEqual({
      ok: false,
      reason: "wrong-server",
      expectedFingerprint: "expected-b",
      foundFingerprint: "found-other",
    });
    expect(r.active).toBe(a);
    expect(calls).not.toContain("createView:https://b.example");
    expect(calls.some((call) => call.startsWith("handoffRelay:"))).toBe(false);
  });

  test("wrong-fingerprint recent-only target is not ensured and leaves current view unchanged", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://recent.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
      fingerprint: "expected-recent",
    }];
    hooks.probeFingerprint = async () => ({
      ok: true,
      fingerprint: "found-other",
    });
    r.configure(hooks);
    const current = r.ensure("https://a.example");
    await r.switchTo(current.serverUrl);
    const currentView = views.get(current.serverUrl);
    calls.length = 0;

    const result = await r.switchTo("https://recent.example");
    expect(result).toEqual({
      ok: false,
      reason: "wrong-server",
      expectedFingerprint: "expected-recent",
      foundFingerprint: "found-other",
    });
    expect(r.active).toBe(current);
    expect(r.active?.view).toBe(currentView);
    expect(r.getByServerUrl("https://recent.example")).toBeNull();
    expect(calls).not.toContain("createView:https://recent.example");
    expect(calls.some((call) => call.startsWith("hideView:"))).toBe(false);
  });

  test("missing fingerprint learns first-connect identity before activation", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://b.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    }];
    hooks.probeFingerprint = async () => ({ ok: true, fingerprint: "learned-b" });
    r.configure(hooks);
    r.ensure("https://a.example");
    const b = r.ensure("https://b.example");

    const result = await r.switchTo(b.serverUrl);
    expect(result).toEqual({ ok: true });
    const storeIndex = calls.indexOf(
      "storeFingerprint:https://b.example:learned-b",
    );
    const createIndex = calls.indexOf("createView:https://b.example");
    expect(storeIndex).toBeGreaterThanOrEqual(0);
    expect(createIndex).toBeGreaterThan(storeIndex);
    expect(r.active).toBe(b);
  });

  test("offline fingerprint preflight leaves current server active", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.probeFingerprint = async () => ({ ok: false, reason: "offline" });
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    r.ensure("https://b.example");

    const result = await r.switchTo("https://b.example");
    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(r.active).toBe(a);
    expect(calls).not.toContain("createView:https://b.example");
  });

  test("first-connect fingerprint persistence failure leaves current active", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.listRecents = () => [];
    hooks.probeFingerprint = async () => ({ ok: true, fingerprint: "learned-b" });
    hooks.storeFingerprint = () => false;
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    r.ensure("https://b.example");

    const result = await r.switchTo("https://b.example");
    expect(result).toEqual({
      ok: false,
      reason: "fingerprint-storage-failed",
    });
    expect(r.active).toBe(a);
    expect(calls).not.toContain("createView:https://b.example");
  });

  test("re-auth required only when credentials absent; valid tokens are not cleared on switch", async () => {
    const r = new ServerSessionRegistry();
    let tokensForB: { token: string } | null = { token: "valid" };
    const refreshCalls: string[] = [];
    const { hooks } = makeHooks();
    hooks.loadTokens = (url) => (url === "https://b.example" ? tokensForB : null);
    hooks.refreshTokens = async (url) => {
      refreshCalls.push(url);
      return true;
    };
    r.configure(hooks);
    const b = r.ensure("https://b.example");
    await r.switchTo("https://b.example");
    // Valid bundle → signedIn true, silent refresh attempted, no clear.
    expect(b.signedIn).toBe(true);
    expect(refreshCalls).toContain("https://b.example");
    // Now simulate absent credentials for a fresh server C.
    const c = r.ensure("https://c.example");
    hooks.loadTokens = () => null;
    await r.switchTo("https://c.example");
    expect(c.signedIn).toBe(false);
    // B's tokens were never cleared (still "valid" in this mock).
    expect(tokensForB).toEqual({ token: "valid" });

    // Expiring + unrefreshable credentials require re-auth.
    const d = r.ensure("https://d.example");
    hooks.loadTokens = () => ({ token: "expiring" });
    hooks.refreshTokens = async () => false;
    await r.switchTo("https://d.example");
    expect(d.signedIn).toBe(false);
  });

  test("close destroys the view, drops the session, and falls back to a remaining active", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls, views } = makeHooks();
    hooks.activateFallback = async (url) => (await r.switchTo(url)).ok
      ? { kind: "activated" }
      : { kind: "indeterminate" };
    r.configure(hooks);
    r.ensure("https://a.example");
    r.ensure("https://b.example");
    await r.switchTo("https://b.example");
    const viewB = views.get("https://b.example")!;
    calls.length = 0;

    const result = await r.close("https://b.example");
    expect(result).toEqual({ ok: true });
    expect(calls).toContain(`destroyView:${viewB.id}`);
    expect(calls).toContain("handoffRelay:https://a.example");
    expect(r.list().map((e) => e.url)).not.toContain("https://b.example");
    // Active falls back to the remaining session.
    expect(r.active?.serverUrl).toBe("https://a.example");
  });

  test("close is a no-op for an unknown URL", async () => {
    const r = new ServerSessionRegistry();
    r.configure(makeHooks().hooks);
    const result = await r.close("https://nope.example");
    expect(result).toEqual({ ok: false, reason: "unknown-server" });
    expect(r.list()).toEqual([]);
  });

  test("active close keeps current session when fallback fingerprint preflight fails", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.activateFallback = async () => ({
      kind: "not-activated",
      result: { ok: false, reason: "offline" },
    });
    r.configure(hooks);
    r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await r.switchTo("https://b.example");
    calls.length = 0;

    const result = await r.close("https://b.example");
    expect(result).toEqual({ ok: false, reason: "offline" });
    expect(r.active).toBe(b);
    expect(r.list().map((entry) => entry.url)).toContain("https://b.example");
    expect(calls.some((call) => call.startsWith("destroyView:"))).toBe(false);
  });

  test("active close treats missing or indeterminate fallback activation as handoff-pending", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    r.configure(hooks);
    r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await r.switchTo(b.serverUrl);
    calls.length = 0;
    expect(await r.close(b.serverUrl)).toEqual({ ok: false, reason: "handoff-pending" });
    expect(r.active).toBe(b);
    expect(r.list().map((entry) => entry.url)).toContain(b.serverUrl);
    expect(calls.some((call) => call.startsWith("destroyView:"))).toBe(false);
    for (const activateFallback of [
      async () => { throw new Error("activation failed"); },
      async () => ({ kind: "activated" as const }),
      async () => ({ kind: "indeterminate" as const }),
    ]) {
      hooks.activateFallback = activateFallback;
      expect(await r.close(b.serverUrl)).toEqual({ ok: false, reason: "handoff-pending" });
      expect(r.active).toBe(b);
      expect(r.list()).toHaveLength(2);
    }
  });

  test("forget switches to the fallback first, then destroys the active view", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.activateFallback = async (url) => (await r.switchTo(url)).ok
      ? { kind: "activated" }
      : { kind: "indeterminate" };
    r.configure(hooks);
    r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await r.switchTo(b.serverUrl);
    calls.length = 0;

    const result = await r.forget("https://b.example", ["https://b.example"], "https://a.example");
    expect(result).toEqual({ ok: true, fallbackFailed: false, landedEmpty: false });
    expect(r.active?.serverUrl).toBe("https://a.example");
    expect(calls.indexOf("handoffRelay:https://a.example")).toBeLessThan(
      calls.findIndex((call) => call.startsWith("destroyView:")),
    );
    expect(r.list().map((entry) => entry.url)).not.toContain("https://b.example");
  });

  test("forget continues to empty state after a fallback failure", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    let teardown = 0;
    hooks.activateFallback = async () => ({
      kind: "not-activated",
      result: { ok: false, reason: "offline" },
    });
    Object.assign(hooks, { teardownForgottenActive: async () => { teardown += 1; } });
    r.configure(hooks);
    r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await r.switchTo(b.serverUrl);
    calls.length = 0;

    const result = await r.forget("https://b.example", ["https://b.example"], "https://a.example");
    expect(result).toEqual({ ok: true, fallbackFailed: true, landedEmpty: true });
    expect(teardown).toBe(1);
    expect(r.active).toBeNull();
    expect(calls.some((call) => call.startsWith("destroyView:"))).toBe(true);
  });

  test("forget deletes nothing when fallback activation is indeterminate or misclassified after authority changes", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    let teardown = 0;
    hooks.activateFallback = async () => ({ kind: "indeterminate" });
    hooks.teardownForgottenActive = async () => { teardown += 1; };
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    const b = r.ensure("https://b.example");
    await r.switchTo(b.serverUrl);
    calls.length = 0;
    expect(await r.forget(b.serverUrl, [b.serverUrl], a.serverUrl)).toEqual({
      ok: false, reason: "handoff-pending",
    });
    expect(teardown).toBe(0);
    expect(r.list()).toHaveLength(2);
    hooks.activateFallback = async (url) => {
      await r.switchTo(url);
      return { kind: "not-activated", result: { ok: false, reason: "offline" } };
    };
    expect(await r.forget(b.serverUrl, [b.serverUrl], a.serverUrl)).toEqual({
      ok: false, reason: "handoff-pending",
    });
    expect(teardown).toBe(0);
    expect(r.list()).toHaveLength(2);
    expect(calls.some((call) => call.startsWith("destroyView:"))).toBe(false);
  });

  test("forget clears every alias partition through the registry seam", async () => {
    const r = new ServerSessionRegistry();
    const cleared: string[] = [];
    r.configure({
      clearPersistentPartition: async (partition) => { cleared.push(partition); },
    });
    await r.clearPersistentPartitionsFor([
      "http://localhost:3001",
      "http://127.0.0.1:3001",
    ]);
    expect(cleared).toHaveLength(2);
    expect(cleared.every((partition) => partition.startsWith("persist:server-"))).toBe(true);
  });

  test("onChanged fires on switch, add, and close; unsubscribe is safe", async () => {
    const r = new ServerSessionRegistry();
    const { hooks } = makeHooks();
    hooks.activateFallback = async (url) => (await r.switchTo(url)).ok
      ? { kind: "activated" }
      : { kind: "indeterminate" };
    r.configure(hooks);
    const events: string[] = [];
    const off = r.onChange(() => events.push("change"));
    r.ensure("https://a.example");
    await r.switchTo("https://a.example");
    await r.add("https://b.example");
    await r.close("https://b.example");
    expect(events.length).toBeGreaterThanOrEqual(3);

    off();
    await r.switchTo("https://a.example");
    // No new events after unsubscribe.
    const after = events.length;
    await r.close("https://nope.example"); // no-op close still notifies? no — no-op close returns early
    expect(events.length).toBe(after);
  });

  test("onChanged survives a throwing listener (does not silence the rest)", async () => {
    const r = new ServerSessionRegistry();
    r.configure(makeHooks().hooks);
    const ok: string[] = [];
    r.onChange(() => {
      throw new Error("dead subscriber");
    });
    r.onChange(() => ok.push("alive"));
    await r.switchTo(r.ensure("https://a.example").serverUrl);
    expect(ok).toContain("alive");
  });
});

describe("ServerSessionRegistry listEnriched (M161 Phase 3.1)", () => {
  test("requires current profile contract while accepting server-default rolling alias", () => {
    expect(parseServerSetupStatusSummary({})).toBeNull();
    expect(
      parseServerSetupStatusSummary({
        serverProfile: { name: "Old", icon: null },
      }),
    ).toBeNull();
    expect(
      parseServerSetupStatusSummary({
        serverProfile: {
          name: "",
          icon: { kind: "preset", id: "preset-orbit" },
        },
      }),
    ).toBeNull();
    expect(
      parseServerSetupStatusSummary({
        serverProfile: {
          name: "Invalid icon",
          icon: { kind: "uploaded", blobId: "" },
        },
      }),
    ).toBeNull();
    expect(
      parseServerSetupStatusSummary({
        serverProfile: {
          name: "Rolling",
          icon: { kind: "preset", id: "server-default" },
        },
      }),
    ).toEqual({
      name: "Rolling",
      icon: { kind: "preset", id: "server-default" },
    });
  });

  test("builds versioned icon URLs for preset, uploaded, and generated AvatarRefs", () => {
    expect(buildVersionedServerIconUrl("https://old.example", null)).toBe(
      "https://old.example/api/server/icon",
    );
    expect(
      buildVersionedServerIconUrl("https://a.example", {
        icon: { kind: "preset", id: "preset-orbit" },
      }),
    ).toBe("https://a.example/api/server/icon?v=preset-orbit");
    expect(
      buildVersionedServerIconUrl("https://a.example/", {
        icon: { kind: "uploaded", blobId: "blob/upload 1" },
      }),
    ).toBe("https://a.example/api/server/icon?v=blob%2Fupload%201");
    expect(
      buildVersionedServerIconUrl("https://a.example", {
        icon: { kind: "generated", blobId: "generated-1" },
      }),
    ).toBe("https://a.example/api/server/icon?v=generated-1");
  });

  test("merges recents + live, enriches, marks active/signedIn, copies fingerprint", async () => {
    const r = new ServerSessionRegistry();
    const { hooks } = makeHooks();
    r.configure(hooks);
    const a = r.ensure("https://a.example");
    a.signedIn = true;
    a.connection = "live";
    r.ensure("https://b.example"); // live but not active, not signed in

    const entries = await r.listEnriched();
    const byUrl = new Map(entries.map((e) => [e.url, e]));
    expect(byUrl.get("https://a.example")?.active).toBe(true);
    expect(byUrl.get("https://a.example")?.signedIn).toBe(true);
    expect(byUrl.get("https://a.example")?.connection).toBe("live");
    expect(byUrl.get("https://a.example")?.fingerprint).toBe("fp-a");
    expect(byUrl.get("https://a.example")?.name).toBe("https://a.example-name");
    expect(byUrl.get("https://a.example")?.iconUrl).toBe(
      "https://a.example/api/server/icon?v=preset-orbit",
    );

    expect(byUrl.get("https://b.example")?.active).toBe(false);
    expect(byUrl.get("https://b.example")?.signedIn).toBe(false);

    // Recent-only offline entry degrades without being dropped.
    const offline = byUrl.get("https://offline.example");
    expect(offline).toBeDefined();
    expect(offline?.connection).toBe("offline");
    expect(offline?.signedIn).toBe(false);
    expect(offline?.iconUrl).toBe("https://offline.example/api/server/icon");
    expect(offline?.fingerprint).toBeUndefined();
  });

  test("degrades offline without dropping the entry (fetchListSetupStatus throws)", async () => {
    const r = new ServerSessionRegistry();
    const { hooks } = makeHooks();
    r.configure(hooks);
    r.ensure("https://a.example");
    const entries = await r.listEnriched();
    const offline = entries.find((e) => e.url === "https://offline.example");
    expect(offline).toBeDefined();
    expect(offline?.connection).toBe("offline");
  });

  test("reachable incompatible recent server remains visible with URL and icon fallback", async () => {
    const r = new ServerSessionRegistry();
    const { hooks } = makeHooks();
    hooks.listRecents = () => [{
      url: "https://old.example",
      lastUsedAt: "2026-01-01T00:00:00.000Z",
    }];
    hooks.fetchListSetupStatus = async () => ({ kind: "incompatible" });
    r.configure(hooks);

    const entries = await r.listEnriched();
    expect(entries).toEqual([{
      url: "https://old.example",
      iconUrl: "https://old.example/api/server/icon",
      connection: "incompatible",
      active: false,
      signedIn: false,
      notificationSummary: { state: "unknown" },
    }]);
  });

  test("without hooks, degrades to basic live list (no recents, no enrichment)", async () => {
    const r = new ServerSessionRegistry();
    r.ensure("https://a.example");
    const entries = await r.listEnriched();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.url).toBe("https://a.example");
    expect(entries[0]?.active).toBe(true);
    expect(entries[0]?.signedIn).toBe(false);
    expect(entries[0]?.iconUrl).toBe("");
  });

  test("repeated list re-fetches profile but emits no duplicate change when unchanged", async () => {
    const r = new ServerSessionRegistry();
    const { hooks } = makeHooks();
    hooks.listRecents = () => [];
    r.configure(hooks);
    r.ensure("https://a.example");
    let changes = 0;
    r.onChange(() => {
      changes += 1;
    });

    await r.listEnriched();
    expect(changes).toBe(1); // initial connecting/null → live/profile
    await r.listEnriched();
    expect(changes).toBe(1); // identical profile: no loop
  });

  test("profile change on repeated list updates live session and emits exactly once", async () => {
    const r = new ServerSessionRegistry();
    let name = "Alpha";
    const { hooks } = makeHooks();
    hooks.listRecents = () => [];
    hooks.fetchListSetupStatus = async () => ({
      kind: "live",
      profile: {
        name,
        description: "desc",
        icon: { kind: "uploaded", blobId: "blob-1" },
      },
    });
    r.configure(hooks);
    r.ensure("https://a.example");
    let changes = 0;
    r.onChange(() => {
      changes += 1;
    });

    await r.listEnriched();
    expect(changes).toBe(1);
    name = "Beta";
    const entries = await r.listEnriched();
    expect(changes).toBe(2);
    expect(entries[0]?.name).toBe("Beta");
    expect(entries[0]?.iconUrl).toBe(
      "https://a.example/api/server/icon?v=blob-1",
    );
    await r.listEnriched();
    expect(changes).toBe(2);
  });
});

describe("ServerSessionRegistry listEnriched alias collapse (M161 Phase 6.4)", () => {
  function makeCollapseHooks(opts: {
    recents: { url: string; lastUsedAt: string; fingerprint?: string }[];
    fetchListSetupStatus?: (url: string) => Promise<{
      kind: "live" | "offline" | "incompatible";
      profile?: { name: string; description?: string; icon: { kind: "preset"; id: string } };
    }>;
  }) {
    return {
      listRecents: () => opts.recents,
      fetchListSetupStatus: async (url: string) => {
        if (opts.fetchListSetupStatus) {
          const r = await opts.fetchListSetupStatus(url);
          return r.kind === "live"
            ? { kind: "live" as const, profile: r.profile! }
            : { kind: r.kind as "offline" | "incompatible" };
        }
        return {
          kind: "live" as const,
          profile: {
            name: `${url}-name`,
            description: "desc",
            icon: { kind: "preset" as const, id: "preset-orbit" },
          },
        };
      },
      iconUrlFor: buildVersionedServerIconUrl,
    };
  }

  test("same-fingerprint loopback live + recent alias collapses to one row", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-x" },
        { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-x" },
      ],
    });
    r.configure(hooks);
    const live = r.ensure("http://localhost:3001");
    live.connection = "live";
    live.signedIn = true;

    const entries = await r.listEnriched();
    expect(entries).toHaveLength(1);
    // Active/live session wins; its URL is the anchor.
    expect(entries[0]?.url).toBe("http://localhost:3001");
    expect(entries[0]?.active).toBe(true);
    expect(entries[0]?.signedIn).toBe(true);
    // Trusted fingerprint preserved across the collapse.
    expect(entries[0]?.fingerprint).toBe("fp-x");
  });

  test("distinct nonempty fingerprints remain 2 (never collapse)", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-a" },
        { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-b" },
      ],
    });
    r.configure(hooks);

    const entries = await r.listEnriched();
    expect(entries).toHaveLength(2);
    const fps = entries.map((e) => e.fingerprint).sort();
    expect(fps).toEqual(["fp-a", "fp-b"]);
  });

  test("no-fingerprint loopback fallback collapses only same protocol/port", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z" },
        { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z" },
        { url: "http://localhost:3000", lastUsedAt: "2026-03-01T00:00:00.000Z" },
        { url: "https://localhost:3001", lastUsedAt: "2026-04-01T00:00:00.000Z" },
      ],
    });
    r.configure(hooks);

    const entries = await r.listEnriched();
    const urls = entries.map((e) => e.url).sort();
    // localhost:3001 + 127.0.0.1:3001 collapse (most-recent recent wins,
    // so the anchor URL is the 127.0.0.1 alias); :3000 and https :3001 stay.
    expect(urls).toEqual([
      "http://127.0.0.1:3001",
      "http://localhost:3000",
      "https://localhost:3001",
    ]);
  });

  test("fingerprinted loopback and unfingerprinted alias collapse only at the same protocol/port", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-local" },
        { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z" },
        { url: "http://[::1]:3000", lastUsedAt: "2026-03-01T00:00:00.000Z" },
      ],
    });
    r.configure(hooks);

    const entries = await r.listEnriched();
    // The untrusted 127 alias joins the single matching trusted loopback
    // group. The different-port alias remains independently visible.
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.url).sort()).toEqual([
      "http://127.0.0.1:3001",
      "http://[::1]:3000",
    ]);
    expect(entries.find((entry) => entry.fingerprint === "fp-local")).toBeDefined();
  });

  test("fingerprinted loopback and unfingerprinted different-port alias do not collapse", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-local" },
        { url: "http://127.0.0.1:3000", lastUsedAt: "2026-02-01T00:00:00.000Z" },
      ],
    });
    r.configure(hooks);

    const entries = await r.listEnriched();
    expect(entries).toHaveLength(2);
    expect(entries.map((entry) => entry.url).sort()).toEqual([
      "http://127.0.0.1:3000",
      "http://localhost:3001",
    ]);
  });

  test("profile look-alikes at distinct non-loopback URLs remain 2", async () => {
    const r = new ServerSessionRegistry();
    const hooks = makeCollapseHooks({
      recents: [
        { url: "https://nautilo.example.test", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-test" },
        { url: "https://upgrade.example.test", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-dev" },
      ],
      fetchListSetupStatus: async () => ({
        kind: "live",
        profile: {
          name: "Same Name",
          description: "Same Desc",
          icon: { kind: "preset", id: "preset-orbit" },
        },
      }),
    });
    r.configure(hooks);

    const entries = await r.listEnriched();
    expect(entries).toHaveLength(2);
    expect(entries.map((e) => e.url).sort()).toEqual([
      "https://nautilo.example.test",
      "https://upgrade.example.test",
    ]);
    // Both rows carry the identical look-alike profile but stay separate.
    expect(entries[0]?.name).toBe("Same Name");
    expect(entries[1]?.name).toBe("Same Name");
  });

  test("listEnriched never writes fingerprints during list (no side-effect learning)", async () => {
    const r = new ServerSessionRegistry();
    let stored = false;
    const hooks = makeCollapseHooks({
      recents: [
        { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z" },
        { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z" },
      ],
    });
    (hooks as Record<string, unknown>).storeFingerprint = () => {
      stored = true;
      return true;
    };
    r.configure(hooks as never);

    const entries = await r.listEnriched();
    expect(entries).toHaveLength(1);
    // No fingerprint was learned/written during list — collapse is read-only.
    expect(stored).toBe(false);
    expect(entries[0]?.fingerprint).toBeUndefined();
  });

  test("switchTo preflight reuses an existing same-fingerprint alias session instead of creating a duplicate", async () => {
    const r = new ServerSessionRegistry();
    const { hooks, calls } = makeHooks();
    hooks.listRecents = () => [
      { url: "http://localhost:3001", lastUsedAt: "2026-01-01T00:00:00.000Z", fingerprint: "fp-x" },
      { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-x" },
    ];
    hooks.fetchListSetupStatus = async () => ({
      kind: "live",
      profile: { name: "Local", description: "d", icon: { kind: "preset", id: "preset-orbit" } },
    });
    hooks.probeFingerprint = async () => ({ ok: true, fingerprint: "fp-x" });
    r.configure(hooks);

    // Boot the canonical localhost session first.
    await r.switchTo("http://localhost:3001");
    expect(r.active?.serverUrl).toBe("http://localhost:3001");
    calls.length = 0;

    // Switching via the 127.0.0.1 alias must reuse the localhost session,
    // NOT create a duplicate 127.0.0.1 session with its own partition.
    const result = await r.switchTo("http://127.0.0.1:3001");
    expect(result).toEqual({ ok: true });
    expect(r.active?.serverUrl).toBe("http://localhost:3001");
    expect(r.list().map((e) => e.url)).not.toContain("http://127.0.0.1:3001");
    expect(r.getByServerUrl("http://127.0.0.1:3001")).toBeNull();
    // No duplicate view was created for the alias.
    expect(calls).not.toContain("createView:http://127.0.0.1:3001");
  });
});

describe("servers:navigate-home bridge contract (M161 Phase 3.1)", () => {
  test("main emits and preload exposes unsubscribe-safe listener without reload", () => {
    const desktopRoot = join(import.meta.dir, "../..");
    const mainSource = readFileSync(
      join(desktopRoot, "electron/main.ts"),
      "utf-8",
    );
    const preloadSource = readFileSync(
      join(desktopRoot, "electron/preload.ts"),
      "utf-8",
    );

    expect(mainSource).toContain(
      'view.webContents.send("servers:navigate-home")',
    );
    expect(preloadSource).toContain(
      'ipcRenderer.on("servers:navigate-home", listener)',
    );
    expect(preloadSource).toContain(
      'ipcRenderer.off("servers:navigate-home", listener)',
    );
    // Existing-view Home navigation is event-only; main does not reload it.
    expect(mainSource).not.toContain(
      'loadURL("servers:navigate-home")',
    );
  });

  test("preload exposes an unsubscribe-safe active-session lifecycle listener", () => {
    const desktopRoot = join(import.meta.dir, "../..");
    const preloadSource = readFileSync(
      join(desktopRoot, "electron/preload.ts"),
      "utf-8",
    );

    expect(preloadSource).toContain('ipcRenderer.on("desktop:active-session-state", listener)');
    expect(preloadSource).toContain('ipcRenderer.off("desktop:active-session-state", listener)');
    expect(preloadSource).toContain('ipcRenderer.send("desktop:subscribe-active-session-state")');
  });

  test("server change pushes wake only the active renderer", () => {
    const mainSource = readFileSync(
      join(import.meta.dir, "../../electron/main.ts"),
      "utf-8",
    );
    expect(mainSource).toContain(
      "const activeSenderId = serverSessions.active?.view?.webContents.id",
    );
    expect(mainSource).toContain("if (id !== activeSenderId) continue");
  });

  test("registered background renderers may read the renderer-safe server list", () => {
    const mainSource = readFileSync(
      join(import.meta.dir, "../../electron/main.ts"),
      "utf-8",
    );
    const start = mainSource.indexOf('ipcMain.handle("servers:list"');
    const block = mainSource.slice(start, mainSource.indexOf("\n});", start));
    expect(block).toContain("serverSessions.getBySender(e.sender.id)");
    expect(block).not.toContain("assertMainWindowSender(e)");
  });
});

// Silence unused-import linter for serverUrlScope (kept for parity with
// the sibling registry test's import surface).
void serverUrlScope;

describe("ServerSessionRegistry Stack 198 loopback alias regression (M161 Phase 6.6)", () => {
  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nautilo-stack198-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  function writeRecents(servers: { url: string; lastUsedAt: string; fingerprint?: string }[]) {
    fs.writeFileSync(
      path.join(tempRoot, "recent-servers.json"),
      JSON.stringify({ v: 2, servers }),
    );
  }

  function realPersistedHooks(opts: {
    probeFingerprint: (url: string) => Promise<{ ok: true; fingerprint: string } | { ok: false; reason: "offline" }>;
  }) {
    return {
      listRecents: () => recentServers.listRecentServers(),
      storeFingerprint: (url: string, fp: string) =>
        recentServers.setRecentServerFingerprint(url, fp),
      probeFingerprint: opts.probeFingerprint,
      fetchListSetupStatus: async () => ({
        kind: "live" as const,
        profile: {
          name: "Local",
          description: "d",
          icon: { kind: "preset" as const, id: "preset-orbit" },
        },
      }),
      iconUrlFor: buildVersionedServerIconUrl,
      createView: (session: { serverUrl: string }) => ({ id: 1 }),
      showView: () => {},
      hideView: () => {},
      navigateView: () => {},
      navigateHome: () => {},
      destroyView: () => {},
      handoffRelay: async () => {},
      resolveLogtoConfig: async () => true,
      loadTokens: () => null,
      refreshTokens: async () => true,
    };
  }

  test("stored localhost fingerprint + switch 127 alias succeeds and remains the same session", async () => {
    writeRecents([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
    ]);
    const r = new ServerSessionRegistry();
    r.configure(realPersistedHooks({
      probeFingerprint: async () => ({ ok: true, fingerprint: "fp-local" }),
    }) as never);

    // The live session is the 127 alias; only the localhost recent carries trust.
    const live = r.ensure("http://127.0.0.1:3001");
    expect(r.active).toBe(live);

    const result = await r.switchTo("http://127.0.0.1:3001");
    expect(result).toEqual({ ok: true });
    // Same session remains active — no duplicate alias session created.
    expect(r.active).toBe(live);
    expect(r.active?.serverUrl).toBe("http://127.0.0.1:3001");
    expect(r.list().map((e) => e.url)).toEqual(["http://127.0.0.1:3001"]);
    // The localhost trust was not mutated (no store needed — probe matched).
    expect(recentServers.listRecentServers()[0]?.fingerprint).toBe("fp-local");
  });

  test("127 store learns fingerprint through the localhost recent entry", async () => {
    writeRecents([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z" },
    ]);
    const r = new ServerSessionRegistry();
    r.configure(realPersistedHooks({
      probeFingerprint: async () => ({ ok: true, fingerprint: "fp-learned" }),
    }) as never);

    const live = r.ensure("http://127.0.0.1:3001");
    const result = await r.switchTo("http://127.0.0.1:3001");
    expect(result).toEqual({ ok: true });
    expect(r.active).toBe(live);

    // The first trust persisted on the matching loopback recent (localhost),
    // never creating a new 127 recent entry or partition identity.
    const recents = recentServers.listRecentServers();
    expect(recents).toHaveLength(1);
    expect(recents[0]?.url).toBe("http://localhost:3001");
    expect(recents[0]?.fingerprint).toBe("fp-learned");
    // The 127 alias now resolves the learned fingerprint through localhost.
    expect(recentServers.getRecentServerFingerprint("http://127.0.0.1:3001")).toBe("fp-learned");
  });

  test("mismatching existing trusted fingerprint still refuses", async () => {
    writeRecents([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-trusted" },
    ]);
    const r = new ServerSessionRegistry();
    r.configure(realPersistedHooks({
      probeFingerprint: async () => ({ ok: true, fingerprint: "fp-attacker" }),
    }) as never);

    const live = r.ensure("http://127.0.0.1:3001");
    const result = await r.switchTo("http://127.0.0.1:3001");
    expect(result).toEqual({
      ok: false,
      reason: "wrong-server",
      expectedFingerprint: "fp-trusted",
      foundFingerprint: "fp-attacker",
    });
    // Current session remains untouched.
    expect(r.active).toBe(live);
    // The trusted localhost fingerprint was not overwritten.
    expect(recentServers.listRecentServers()[0]?.fingerprint).toBe("fp-trusted");
  });

  test("port, protocol, and non-loopback aliases do not inherit the loopback trust", async () => {
    writeRecents([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
    ]);
    const r = new ServerSessionRegistry();
    r.configure(realPersistedHooks({
      probeFingerprint: async () => ({ ok: true, fingerprint: "fp-local" }),
    }) as never);

    // Different port — no loopback alias match; the store has no recent
    // to persist on, so the first-connect trust fails closed.
    r.ensure("http://127.0.0.1:3000");
    const portResult = await r.switchTo("http://127.0.0.1:3000");
    expect(portResult).toEqual({ ok: false, reason: "fingerprint-storage-failed" });

    // Different protocol — no loopback alias match either.
    r.ensure("https://127.0.0.1:3001");
    const protoResult = await r.switchTo("https://127.0.0.1:3001");
    expect(protoResult).toEqual({ ok: false, reason: "fingerprint-storage-failed" });

    // Non-loopback host never merges with a loopback alias.
    r.ensure("http://192.168.1.10:3001");
    const lanResult = await r.switchTo("http://192.168.1.10:3001");
    expect(lanResult).toEqual({ ok: false, reason: "fingerprint-storage-failed" });

    // The localhost trust was never mutated or bridged.
    expect(recentServers.listRecentServers()).toEqual([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
    ]);
    expect(recentServers.getRecentServerFingerprint("http://127.0.0.1:3000")).toBeNull();
    expect(recentServers.getRecentServerFingerprint("https://127.0.0.1:3001")).toBeNull();
    expect(recentServers.getRecentServerFingerprint("http://192.168.1.10:3001")).toBeNull();
  });

  test("switching the localhost alias reuses the live 127 session instead of creating a duplicate", async () => {
    writeRecents([
      { url: "http://localhost:3001", lastUsedAt: "2026-03-01T00:00:00.000Z", fingerprint: "fp-local" },
      { url: "http://127.0.0.1:3001", lastUsedAt: "2026-02-01T00:00:00.000Z", fingerprint: "fp-local" },
    ]);
    const r = new ServerSessionRegistry();
    r.configure(realPersistedHooks({
      probeFingerprint: async () => ({ ok: true, fingerprint: "fp-local" }),
    }) as never);

    // Boot the 127 session first.
    await r.switchTo("http://127.0.0.1:3001");
    expect(r.active?.serverUrl).toBe("http://127.0.0.1:3001");

    // Switching via the localhost alias must reuse the 127 session.
    const result = await r.switchTo("http://localhost:3001");
    expect(result).toEqual({ ok: true });
    expect(r.active?.serverUrl).toBe("http://127.0.0.1:3001");
    expect(r.list().map((e) => e.url)).not.toContain("http://localhost:3001");
    expect(r.getByServerUrl("http://localhost:3001")).toBeNull();
  });
});
