import { afterEach, describe, expect, test } from "bun:test";
import {
  clearOwnerClaimTerminalMarker,
  OWNER_CLAIM_TERMINAL_STORAGE_KEY,
  readOwnerClaimTerminalMarker,
  writeOwnerClaimTerminalMarker,
} from "../../src/lib/owner-claim-terminal";

const store = new Map<string, string>();
const originalSessionStorage = globalThis.sessionStorage;
const originalLocalStorage = globalThis.localStorage;

const sessionStorageStub: Storage = {
  get length() { return store.size; },
  clear() { store.clear(); },
  getItem(key) { return store.get(key) ?? null; },
  key(index) { return [...store.keys()][index] ?? null; },
  removeItem(key) { store.delete(key); },
  setItem(key, value) { store.set(key, value); },
};

afterEach(() => {
  store.clear();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: originalSessionStorage });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: originalLocalStorage });
});

function installStorage(): void {
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionStorageStub });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: () => null, setItem: () => { throw new Error("local storage must not be used"); } },
  });
}

describe("owner claim terminal marker", () => {
  test("persists only the schema and requested terminal destination in session storage", () => {
    installStorage();

    expect(writeOwnerClaimTerminalMarker({ schemaVersion: 1, finish: "product" })).toBe(true);
    expect(JSON.parse(store.get(OWNER_CLAIM_TERMINAL_STORAGE_KEY) ?? "{}"))
      .toEqual({ schemaVersion: 1, finish: "product" });
    expect(readOwnerClaimTerminalMarker()).toEqual({ schemaVersion: 1, finish: "product" });
  });

  test("rejects and clears any marker with extra or malformed data", () => {
    installStorage();
    store.set(OWNER_CLAIM_TERMINAL_STORAGE_KEY, JSON.stringify({
      schemaVersion: 1,
      finish: "guide",
      claim: "must-never-persist",
    }));

    expect(readOwnerClaimTerminalMarker()).toBeNull();
    expect(store.has(OWNER_CLAIM_TERMINAL_STORAGE_KEY)).toBe(false);
  });

  test("is consumed by terminal navigation", () => {
    installStorage();
    writeOwnerClaimTerminalMarker({ schemaVersion: 1, finish: "guide" });
    clearOwnerClaimTerminalMarker();
    expect(readOwnerClaimTerminalMarker()).toBeNull();
  });

  test("has no browser/API/auth/handoff dependency and never uses local storage", async () => {
    const source = await Bun.file(new URL("../../src/lib/owner-claim-terminal.ts", import.meta.url)).text();
    expect(source).not.toMatch(/from\s+["'][^"']*(?:api|auth|handoff|react)/);
    expect(source).not.toContain("localStorage");
  });
});
