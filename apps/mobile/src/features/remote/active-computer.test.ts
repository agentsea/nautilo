import { describe, expect, test } from "bun:test";

import {
  loadActiveComputer,
  resolveActiveComputer,
  saveActiveComputer,
  type ActiveComputerStorage,
} from "./active-computer";

function memoryStorage(): ActiveComputerStorage {
  const values = new Map<string, string>();
  return {
    getItem: async (key) => values.get(key) ?? null,
    setItem: async (key, value) => { values.set(key, value); },
    removeItem: async (key) => { values.delete(key); },
  };
}

describe("active computer preference", () => {
  test("is isolated by server and can be cleared", async () => {
    const storage = memoryStorage();
    await saveActiveComputer("server-a", "host-a", storage);
    await saveActiveComputer("server-b", "host-b", storage);
    expect(await loadActiveComputer("server-a", storage)).toBe("host-a");
    expect(await loadActiveComputer("server-b", storage)).toBe("host-b");
    await saveActiveComputer("server-a", null, storage);
    expect(await loadActiveComputer("server-a", storage)).toBeNull();
  });

  test("preserves an available explicit choice", () => {
    expect(resolveActiveComputer("host-b", ["host-a", "host-b"])).toBe("host-b");
  });

  test("adopts a sole pairing but never guesses among several", () => {
    expect(resolveActiveComputer(null, ["host-a"])).toBe("host-a");
    expect(resolveActiveComputer(null, ["host-a", "host-b"])).toBeNull();
    expect(resolveActiveComputer("revoked", ["host-a", "host-b"])).toBeNull();
  });
});
