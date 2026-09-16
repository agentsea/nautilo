import { describe, expect, test } from "bun:test";

import {
  createBrowserScopedStore,
  type BrowserStorageArea,
} from "./browser-storage.web";

class MemoryStorage implements BrowserStorageArea {
  readonly values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

interface Preference { readonly theme: "light" | "dark" }
const validPreference = (value: unknown): value is Preference => {
  if (!value || typeof value !== "object") return false;
  const theme = (value as Partial<Preference>).theme;
  return theme === "light" || theme === "dark";
};

function store(storage: BrowserStorageArea | null, origin: string, humanId: string | null) {
  return createBrowserScopedStore({
    namespace: "preferences",
    scope: { origin, humanId },
    storage,
    validate: validPreference,
  });
}

describe("browser-scoped ordinary state", () => {
  test("isolates the same preference by exact origin and Human", async () => {
    const storage = new MemoryStorage();
    const humanA = store(storage, "https://one.example", "human-a");
    const humanB = store(storage, "https://one.example", "human-b");
    const otherOrigin = store(storage, "https://two.example", "human-a");

    expect(await humanA.replace({ theme: "dark" }, 0)).toBe(true);
    expect((await humanA.read()).value).toEqual({ theme: "dark" });
    expect((await humanB.read()).value).toBeNull();
    expect((await otherOrigin.read()).value).toBeNull();
  });

  test("revision fencing prevents stale logout cleanup from erasing newer state", async () => {
    const storage = new MemoryStorage();
    const preferences = store(storage, "https://one.example", "human-a");
    await preferences.replace({ theme: "light" }, 0);
    const stale = await preferences.read();

    const replacement = preferences.replace({ theme: "dark" }, stale.revision);
    const staleLogout = preferences.clear(stale.revision);

    expect(await replacement).toBe(true);
    expect(await staleLogout).toBe(false);
    expect((await preferences.read()).value).toEqual({ theme: "dark" });
  });

  test("corruption is removed and blocked storage fails closed", async () => {
    const storage = new MemoryStorage();
    storage.values.set(
      "nautilo.web.v1.preferences.https%3A%2F%2Fone%2Eexample.human.human-a",
      "not-json",
    );
    const preferences = store(storage, "https://one.example", "human-a");
    expect(await preferences.read()).toEqual({ value: null, revision: 0 });
    expect(storage.values.size).toBe(0);

    const blocked: BrowserStorageArea = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
    };
    expect(await store(blocked, "https://one.example", "human-a").read()).toEqual({
      value: null,
      revision: 0,
    });
  });
});
