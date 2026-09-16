import { describe, expect, jest, test } from "bun:test";
import type { WebContents } from "electron";
import {
  BrowserControlManager,
  type BrowserControlManagerDeps,
} from "../../electron/browser-control-manager";

class FakeWebContents {
  url: string;
  destroyed = false;
  canBack = false;
  canForward = false;
  navigationCalls: string[] = [];
  private destroyHandlers: Array<() => void> = [];
  constructor(url: string) {
    this.url = url;
  }
  getURL(): string {
    return this.url;
  }
  once(event: string, cb: () => void): void {
    if (event === "destroyed") this.destroyHandlers.push(cb);
  }
  emitDestroyed(): void {
    this.destroyed = true;
    const handlers = this.destroyHandlers;
    this.destroyHandlers = [];
    for (const cb of handlers) cb();
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  reload(): void {
    this.navigationCalls.push("reload");
  }
  navigationHistory = {
    canGoBack: () => this.canBack,
    canGoForward: () => this.canForward,
    goBack: () => this.navigationCalls.push("back"),
    goForward: () => this.navigationCalls.push("forward"),
  };
}

function makeHarness(): {
  manager: BrowserControlManager;
  deps: BrowserControlManagerDeps;
  startedShims: string[];
  closedShims: string[];
  providerStates: unknown[];
  needsHumanActions: unknown[];
} {
  const startedShims: string[] = [];
  const closedShims: string[] = [];
  const providerStates: unknown[] = [];
  const needsHumanActions: unknown[] = [];
  let shimSeq = 0;
  const deps: BrowserControlManagerDeps = {
    async startCdpShim() {
      shimSeq += 1;
      const url = `ws://127.0.0.1:0/test-${shimSeq}`;
      startedShims.push(url);
      return {
        url,
        close() {
          closedShims.push(url);
        },
      };
    },
    writeProviderState(state) {
      providerStates.push(state);
    },
    onNeedsHumanAction(payload) {
      needsHumanActions.push(payload);
    },
  };
  return {
    manager: new BrowserControlManager(deps),
    deps,
    startedShims,
    closedShims,
    providerStates,
    needsHumanActions,
  };
}

function wc(url: string): WebContents {
  return new FakeWebContents(url) as unknown as WebContents;
}

describe("BrowserControlManager", () => {
  test("constructor clears stale persisted provider state before any adoption", () => {
    const { providerStates } = makeHarness();
    expect(providerStates).toEqual([
      {
        version: 1,
        activeAppId: null,
        views: [],
      },
    ]);
  });

  test("adopts a webview webContents and starts a scoped CDP shim", async () => {
    const { manager, startedShims, providerStates } = makeHarness();

    const result = await manager.adopt(
      {
        appId: "google-docs",
        mode: "app",
        partition: "persist:google-docs",
        url: "https://docs.google.com",
      },
      wc("https://docs.google.com"),
    );

    expect(result).toEqual({
      appId: "google-docs",
      mode: "app",
      partition: "persist:google-docs",
      url: "https://docs.google.com",
      cdpUrl: "ws://127.0.0.1:0/test-1",
    });
    expect(startedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
    expect(providerStates.at(-1)).toEqual({
      version: 1,
      activeAppId: "google-docs",
      views: [result],
    });
  });

  test("re-adopting the same webContents is idempotent (no new shim)", async () => {
    const { manager, startedShims } = makeHarness();
    const guest = wc("https://docs.google.com");
    const descriptor = {
      appId: "google-docs",
      mode: "app" as const,
      partition: "persist:google-docs",
      url: "https://docs.google.com",
    };

    await manager.adopt(descriptor, guest);
    await manager.adopt(descriptor, guest);

    expect(startedShims).toHaveLength(1);
  });

  test("waits beyond the former five-second cold-open deadline for exact adoption", async () => {
    jest.useFakeTimers();
    try {
      const { manager, deps, providerStates } = makeHarness();
      let releaseShim: ((value: Awaited<ReturnType<NonNullable<BrowserControlManagerDeps["startCdpShim"]>>>) => void) | undefined;
      deps.startCdpShim = () => new Promise((resolve) => {
        releaseShim = resolve;
      });

      let settled = false;
      const ready = manager.waitForActiveView("browser", 30_000).then((snapshot) => {
        settled = true;
        return snapshot;
      });
      const adoption = manager.adopt(
        {
          appId: "browser",
          mode: "browser",
          partition: "persist:browser",
          url: "https://example.com",
        },
        wc("https://example.com"),
      );

      jest.advanceTimersByTime(5_001);
      await Promise.resolve();
      expect(settled).toBe(false);

      releaseShim?.({
        url: "ws://127.0.0.1:0/cold-browser",
        close() {},
      });
      const adopted = await adoption;

      expect(await ready).toEqual(adopted);
      expect(providerStates.at(-1)).toEqual({
        version: 1,
        activeAppId: "browser",
        views: [adopted],
      });
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  test("active-view handshake resolves current state immediately and times out boundedly", async () => {
    const { manager } = makeHarness();
    const adopted = await manager.adopt(
      {
        appId: "browser",
        mode: "browser",
        partition: "persist:browser",
        url: "https://example.com",
      },
      wc("https://example.com"),
    );

    expect(await manager.waitForActiveView("browser", 30_000)).toEqual(adopted);
    expect(await manager.waitForActiveView("missing", 1)).toBeNull();
  });

  test("re-adopting a new webContents closes the old shim and starts a fresh one", async () => {
    const { manager, startedShims, closedShims } = makeHarness();
    const descriptor = {
      appId: "google-docs",
      mode: "app" as const,
      partition: "persist:google-docs",
      url: "https://docs.google.com",
    };

    await manager.adopt(descriptor, wc("https://docs.google.com"));
    await manager.adopt(descriptor, wc("https://docs.google.com/document/d/1"));

    expect(startedShims).toEqual([
      "ws://127.0.0.1:0/test-1",
      "ws://127.0.0.1:0/test-2",
    ]);
    expect(closedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
  });

  test("release closes the shim and clears the active app", async () => {
    const { manager, closedShims, providerStates } = makeHarness();
    await manager.adopt(
      {
        appId: "google-docs",
        mode: "app",
        partition: "persist:google-docs",
        url: "https://docs.google.com",
      },
      wc("https://docs.google.com"),
    );

    expect(manager.release("google-docs")).toBe(true);
    expect(closedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
    expect(manager.list()).toEqual([]);
    expect(providerStates.at(-1)).toEqual({
      version: 1,
      activeAppId: null,
      views: [],
    });
  });

  test("release returns false for an unknown app", () => {
    const { manager } = makeHarness();
    expect(manager.release("missing")).toBe(false);
  });

  test("auto-releases when the adopted webContents is destroyed", async () => {
    const { manager, closedShims } = makeHarness();
    const guest = new FakeWebContents("https://docs.google.com");
    await manager.adopt(
      { appId: "google-docs", mode: "app", partition: "persist:google-docs", url: "https://docs.google.com" },
      guest as unknown as WebContents,
    );

    guest.emitDestroyed();

    expect(closedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
    expect(manager.list()).toEqual([]);
  });

  test("a destroyed old guest does not release a record re-adopted onto a new guest", async () => {
    const { manager, closedShims } = makeHarness();
    const descriptor = {
      appId: "google-docs",
      mode: "app" as const,
      partition: "persist:google-docs",
      url: "https://docs.google.com",
    };
    const oldGuest = new FakeWebContents("https://accounts.google.com/signin");
    const newGuest = new FakeWebContents("https://docs.google.com/document/d/1");

    await manager.adopt(descriptor, oldGuest as unknown as WebContents);
    await manager.adopt(descriptor, newGuest as unknown as WebContents);
    // Old guest dies AFTER the swap; its stale handler must not kill the record.
    oldGuest.emitDestroyed();

    expect(manager.list()).toHaveLength(1);
    // Only the old shim was closed (by the swap), not the live one.
    expect(closedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
  });

  test("list prunes a destroyed record before exposing provider snapshots", async () => {
    const { manager, closedShims } = makeHarness();
    const guest = new FakeWebContents("https://docs.google.com");
    await manager.adopt(
      { appId: "google-docs", mode: "app", partition: "persist:google-docs", url: "https://docs.google.com" },
      guest as unknown as WebContents,
    );

    guest.destroyed = true;

    expect(manager.list()).toEqual([]);
    expect(closedShims).toEqual(["ws://127.0.0.1:0/test-1"]);
  });


  test("setActive marks an adopted app as the provider target", async () => {
    const { manager, providerStates } = makeHarness();
    await manager.adopt(
      { appId: "a", mode: "app", partition: "persist:a", url: "https://a.example" },
      wc("https://a.example"),
    );
    await manager.adopt(
      { appId: "b", mode: "browser", partition: "persist:b", url: "https://b.example" },
      wc("https://b.example"),
    );

    manager.setActive("a");
    expect((providerStates.at(-1) as { activeAppId: string }).activeAppId).toBe("a");
  });

  test("native navigation controls the adopted guest and rejects absent history", async () => {
    const { manager } = makeHarness();
    const guest = new FakeWebContents("https://example.com");
    await manager.adopt(
      { appId: "browser", mode: "browser", partition: "persist:browser", url: guest.url },
      guest as unknown as WebContents,
    );

    expect(manager.navigateActive("back")).toEqual({
      ok: false,
      error: "The embedded Browser has no previous history entry",
    });
    guest.canBack = true;
    guest.canForward = true;
    expect(manager.navigateActive("back")).toEqual({ ok: true });
    expect(manager.navigateActive("forward")).toEqual({ ok: true });
    expect(manager.navigateActive("reload")).toEqual({ ok: true });
    expect(guest.navigationCalls).toEqual(["back", "forward", "reload"]);
  });

  test("native navigation fails closed without an active adopted guest", () => {
    const { manager } = makeHarness();
    expect(manager.navigateActive("reload")).toEqual({
      ok: false,
      error: "No active embedded Browser view",
    });
  });

  test("reports needs-human action payload for an adopted app", async () => {
    const { manager, needsHumanActions } = makeHarness();
    await manager.adopt(
      {
        appId: "google-docs",
        mode: "app",
        partition: "persist:google-docs",
        url: "https://docs.google.com",
      },
      wc("https://accounts.google.com/signin"),
    );

    const payload = manager.reportNeedsHumanAction(
      "google-docs",
      "auth",
      "Complete Google sign-in",
    );

    expect(payload).toEqual({
      appId: "google-docs",
      url: "https://accounts.google.com/signin",
      reason: "auth",
      summary: "Complete Google sign-in",
    });
    expect(needsHumanActions).toEqual([payload]);
  });

  test("returns null when reporting needs-human for unknown app", () => {
    const { manager, needsHumanActions } = makeHarness();
    expect(manager.reportNeedsHumanAction("missing", "unknown")).toBeNull();
    expect(needsHumanActions).toEqual([]);
  });
});
