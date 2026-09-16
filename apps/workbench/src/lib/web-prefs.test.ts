import { describe, it, expect, beforeEach, beforeAll } from "bun:test";
import {
  DEFAULT_HOME,
  DEFAULT_PINNED_SITES,
  HISTORY_CAP,
  addPinnedSite,
  clearHistory,
  getHistory,
  getHome,
  getPinnedSites,
  isPinned,
  pushHistory,
  removePinnedSite,
  setHome,
  setPinnedSites,
  subscribeWebPrefs,
  type HistoryEntry,
  type PinnedSite,
} from "./web-prefs";

const VIEWER = "test-viewer";

function installLocalStoragePolyfill(): void {
  if (typeof globalThis.window === "undefined") {
    (globalThis as typeof globalThis & { window: typeof globalThis }).window =
      globalThis as typeof globalThis & { window: typeof globalThis };
  }
  if (typeof globalThis.localStorage !== "undefined") return;

  const store = new Map<string, string>();
  globalThis.localStorage = {
    get length() {
      return store.size;
    },
    clear() {
      store.clear();
    },
    getItem(key: string) {
      return store.get(key) ?? null;
    },
    key(index: number) {
      return Array.from(store.keys())[index] ?? null;
    },
    removeItem(key: string) {
      store.delete(key);
    },
    setItem(key: string, value: string) {
      store.set(key, value);
    },
  };
}

beforeAll(() => {
  installLocalStoragePolyfill();
});

beforeEach(() => {
  localStorage.clear();
});

describe("getHome / setHome", () => {
  it("returns DEFAULT_HOME when unset", () => {
    expect(getHome(VIEWER)).toBe(DEFAULT_HOME);
  });

  it("roundtrips a custom home URL", () => {
    setHome(VIEWER, "https://example.com");
    expect(getHome(VIEWER)).toBe("https://example.com");
  });

  it("returns default and no-ops write when viewerKey is null", () => {
    setHome(null, "https://example.com");
    expect(getHome(null)).toBe(DEFAULT_HOME);
    expect(localStorage.length).toBe(0);
  });
});

describe("getPinnedSites / setPinnedSites", () => {
  it("returns the (empty) defaults when unset", () => {
    const sites = getPinnedSites(VIEWER);
    expect(sites).toEqual([...DEFAULT_PINNED_SITES]);
    expect(sites).not.toBe(DEFAULT_PINNED_SITES);
  });

  it("roundtrips custom pinned sites", () => {
    const custom: PinnedSite[] = [
      { appId: "example", displayName: "Example", url: "https://example.com" },
    ];
    setPinnedSites(VIEWER, custom);
    expect(getPinnedSites(VIEWER)).toEqual(custom);
  });
});

describe("addPinnedSite / removePinnedSite / isPinned", () => {
  it("dedups by url case-insensitively", () => {
    const initial = getPinnedSites(VIEWER);
    const added = addPinnedSite(VIEWER, {
      appId: "example",
      displayName: "Example",
      url: "https://EXAMPLE.com/path",
    });
    expect(added).toHaveLength(initial.length + 1);
    expect(isPinned(VIEWER, "https://example.com/path")).toBe(true);

    const deduped = addPinnedSite(VIEWER, {
      appId: "example-updated",
      displayName: "Updated",
      url: "https://example.com/PATH",
    });
    expect(deduped).toHaveLength(initial.length + 1);
    expect(deduped.filter((s) => s.url.toLowerCase() === "https://example.com/path")).toHaveLength(
      1,
    );
    expect(deduped.at(-1)?.displayName).toBe("Updated");
  });

  it("does not mutate the input site", () => {
    const site: PinnedSite = {
      appId: "mutable",
      displayName: "Mutable",
      url: "https://mutable.test",
    };
    const before = { ...site };
    addPinnedSite(VIEWER, site);
    expect(site).toEqual(before);

    site.displayName = "Changed";
    expect(getPinnedSites(VIEWER).find((s) => s.appId === "mutable")?.displayName).toBe(
      "Mutable",
    );
  });

  it("removePinnedSite removes by url and isPinned reflects state", () => {
    addPinnedSite(VIEWER, {
      appId: "remove-me",
      displayName: "Remove Me",
      url: "https://remove.test",
    });
    expect(isPinned(VIEWER, "https://remove.test")).toBe(true);

    const next = removePinnedSite(VIEWER, "https://REMOVE.test");
    expect(next.some((s) => s.url.toLowerCase() === "https://remove.test")).toBe(false);
    expect(isPinned(VIEWER, "https://remove.test")).toBe(false);
  });
});

describe("getHistory / pushHistory / clearHistory", () => {
  it("returns empty history when none", () => {
    expect(getHistory(VIEWER)).toEqual([]);
  });

  it("unshifts newest entries first", () => {
    pushHistory(VIEWER, { url: "https://a.test", at: 1 });
    pushHistory(VIEWER, { url: "https://b.test", at: 2 });
    expect(getHistory(VIEWER).map((e) => e.url)).toEqual([
      "https://b.test",
      "https://a.test",
    ]);
  });

  it("replaces the most recent entry when url matches consecutively", () => {
    pushHistory(VIEWER, { url: "https://same.test", title: "First", at: 1 });
    pushHistory(VIEWER, { url: "https://same.test", title: "Second", at: 2 });
    const history = getHistory(VIEWER);
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({ url: "https://same.test", title: "Second", at: 2 });
  });

  it("caps history at HISTORY_CAP with newest first", () => {
    let latest: HistoryEntry[] = [];
    for (let i = 0; i < 25; i += 1) {
      latest = pushHistory(VIEWER, { url: `https://site-${i}.test`, at: i });
    }
    expect(latest).toHaveLength(HISTORY_CAP);
    expect(latest[0]?.url).toBe("https://site-24.test");
    expect(latest.at(-1)?.url).toBe("https://site-5.test");
    expect(getHistory(VIEWER)).toHaveLength(HISTORY_CAP);
  });

  it("clearHistory empties stored history", () => {
    pushHistory(VIEWER, { url: "https://clear.test", at: 1 });
    clearHistory(VIEWER);
    expect(getHistory(VIEWER)).toEqual([]);
  });
});

describe("corrupt JSON fallback", () => {
  it("falls back to defaults for home, pinned, and history", () => {
    localStorage.setItem(`nautilo.web.${VIEWER}.v1.home`, "{not json");
    localStorage.setItem(`nautilo.web.${VIEWER}.v1.pinned`, "[]]]");
    localStorage.setItem(`nautilo.web.${VIEWER}.v1.history`, "123");

    expect(getHome(VIEWER)).toBe(DEFAULT_HOME);
    expect(getPinnedSites(VIEWER)).toEqual([...DEFAULT_PINNED_SITES]);
    expect(getHistory(VIEWER)).toEqual([]);
  });
});

describe("subscribeWebPrefs", () => {
  it("notifies subscribers on mutations and stops after unsubscribe", () => {
    let count = 0;
    const unsub = subscribeWebPrefs(() => {
      count += 1;
    });
    setHome(VIEWER, "https://a.test");
    addPinnedSite(VIEWER, { appId: "x", displayName: "X", url: "https://x.test" });
    pushHistory(VIEWER, { url: "https://h.test", at: 1 });
    expect(count).toBe(3);
    unsub();
    setHome(VIEWER, "https://b.test");
    expect(count).toBe(3);
  });

  it("does not notify when viewerKey is null (no-op writes)", () => {
    let count = 0;
    const unsub = subscribeWebPrefs(() => {
      count += 1;
    });
    setHome(null, "https://a.test");
    setPinnedSites(null, []);
    clearHistory(null);
    expect(count).toBe(0);
    unsub();
  });
});
