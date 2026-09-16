import { describe, expect, test } from "bun:test";

const values = new Map<string, string>();
let storageBlocked = false;
Object.defineProperty(globalThis, "location", {
  configurable: true,
  value: { href: "https://one.example/mobile", origin: "https://one.example" },
});
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => {
      if (storageBlocked) throw new Error("storage blocked");
      return values.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (storageBlocked) throw new Error("storage blocked");
      values.set(key, value);
    },
    removeItem: (key: string) => {
      if (storageBlocked) throw new Error("storage blocked");
      values.delete(key);
    },
  },
});

const {
  loadRegistry,
  loadTokenSnapshot,
  removeServer,
  saveTokens,
  serverIdFromUrl,
  upsertServer,
} = await import("./server-store.web");

describe("Mobile Web current-origin registry", () => {
  test("persists exactly one current-origin record and rejects another origin", async () => {
    values.clear();
    const record = await upsertServer({
      serverUrl: "https://one.example",
      displayName: "One",
    });
    expect(await loadRegistry()).toEqual({ servers: [record], activeId: record.id });
    expect(record.id).toBe(serverIdFromUrl("https://one.example"));

    let crossOriginError: unknown;
    try {
      await upsertServer({ serverUrl: "https://two.example", displayName: "Two" });
    } catch (error) {
      crossOriginError = error;
    }
    expect(crossOriginError).toBeInstanceOf(Error);
    expect((crossOriginError as Error).message).toContain("current serving origin");
    expect((await loadRegistry()).servers).toEqual([record]);
  });

  test("explicit removal clears only this origin projection", async () => {
    const record = (await loadRegistry()).servers[0];
    await removeServer(record.id);
    expect(await loadRegistry()).toEqual({ servers: [], activeId: null });
  });

  test("fails closed for corrupt, blocked, and non-origin-scoped current-origin records", async () => {
    values.clear();
    const registryKey = "nautilo.web.v1.server-registry.https%3A%2F%2Fone%2Eexample.origin";
    values.set(registryKey, "not-json");
    expect(await loadRegistry()).toEqual({ servers: [], activeId: null });

    values.set(registryKey, JSON.stringify({
      v: 1,
      revision: 1,
      origin: "https://one.example",
      humanId: null,
      value: {
        activeId: serverIdFromUrl("https://one.example"),
        servers: [{
          id: serverIdFromUrl("https://one.example"),
          serverUrl: "https://one.example/mobile?returnTo=secret",
          displayName: "Not an origin",
          lastActive: 1,
        }],
      },
    }));
    expect(await loadRegistry()).toEqual({ servers: [], activeId: null });

    storageBlocked = true;
    expect(await loadRegistry()).toEqual({ servers: [], activeId: null });
    storageBlocked = false;
  });

  test("rejects a same-origin URL that carries a path, credentials, or query", async () => {
    values.clear();
    for (const serverUrl of [
      "https://one.example/mobile",
      "https://one.example/?returnTo=secret",
      "https://user:pass@one.example",
    ]) {
      let error: unknown;
      try {
        await upsertServer({ serverUrl, displayName: "One" });
      } catch (candidate) {
        error = candidate;
      }
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toContain("current serving origin");
    }
  });

  test("does not present browser localStorage as credential custody", async () => {
    expect(await loadTokenSnapshot("server")).toEqual({ tokens: null, revision: 0 });
    let custodyError: unknown;
    try {
      await saveTokens("server", { accessToken: "access", refreshToken: "refresh", expiresAt: 1 });
    } catch (error) {
      custodyError = error;
    }
    expect(custodyError).toBeInstanceOf(Error);
    expect((custodyError as Error).message).toContain("Task 1.3");
  });
});
