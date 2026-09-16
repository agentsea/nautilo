import { afterEach, describe, expect, test } from "bun:test";
import {
  STORAGE_KEY,
  clearSession,
  readSession,
  writeSession,
  type InviteRedeemSession,
} from "../../src/lib/invite-redeem-session";

function makeStorage() {
  const m = new Map<string, string>();
  return {
    getItem(k: string) {
      return m.get(k) ?? null;
    },
    setItem(k: string, v: string) {
      m.set(k, v);
    },
    removeItem(k: string) {
      m.delete(k);
    },
  } as Storage;
}

describe("invite-redeem-session", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("read/write/clear round-trip (M107: handle, version: 2)", () => {
    const shim = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: shim, configurable: true });
    const s: InviteRedeemSession = {
      version: 2,
      token: "inv_x",
      state: "opaque",
      handle: "alice",
      stage: "awaiting-signup",
      startedAt: new Date().toISOString(),
    };
    writeSession(s);
    expect(readSession()).toEqual(s);
    clearSession();
    expect(readSession()).toBeNull();
    expect(shim.getItem(STORAGE_KEY)).toBeNull();
  });

  test("readSession rejects expired entries", () => {
    const shim = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: shim, configurable: true });
    const old = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    writeSession({
      version: 2,
      token: "inv_x",
      state: "opaque",
      handle: "alice",
      stage: "awaiting-signup",
      startedAt: old,
    });
    expect(readSession()).toBeNull();
  });

  test("falls back to localStorage when sessionStorage is unavailable", () => {
    const local = makeStorage();
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    const s: InviteRedeemSession = {
      version: 2,
      token: "inv_fallback",
      state: "opaque",
      handle: "alex",
      stage: "awaiting-signup",
      startedAt: new Date().toISOString(),
    };

    expect(writeSession(s)).toBe(true);
    expect(local.getItem(STORAGE_KEY)).not.toBeNull();
    expect(readSession()).toEqual(s);
    clearSession();
    expect(local.getItem(STORAGE_KEY)).toBeNull();
  });

  test("writes both stores so the OAuth callback survives sessionStorage loss", () => {
    const session = makeStorage();
    const local = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", {
      value: session,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    const s: InviteRedeemSession = {
      version: 2,
      token: "inv_navigation",
      state: "opaque",
      handle: "alex",
      stage: "awaiting-signup",
      startedAt: new Date().toISOString(),
    };

    expect(writeSession(s)).toBe(true);
    session.removeItem(STORAGE_KEY);
    expect(readSession()).toEqual(s);
  });

  test("reports failure when neither browser store accepts the handoff", () => {
    const blocked = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    Object.defineProperty(globalThis, "sessionStorage", {
      value: blocked,
      configurable: true,
    });
    Object.defineProperty(globalThis, "localStorage", {
      value: blocked,
      configurable: true,
    });

    expect(
      writeSession({
        version: 2,
        token: "inv_blocked",
        state: "opaque",
        handle: "alex",
        stage: "awaiting-signup",
        startedAt: new Date().toISOString(),
      }),
    ).toBe(false);
  });

  test("M107: legacy v1 payloads (with `email`, no version) are discarded on load and the storage slot is cleared", () => {
    const shim = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: shim, configurable: true });
    // Hand-write a pre-M107 payload directly.
    shim.setItem(
      STORAGE_KEY,
      JSON.stringify({
        token: "inv_x",
        state: "opaque",
        email: "a@b.co",
        stage: "awaiting-signup",
        startedAt: new Date().toISOString(),
      }),
    );
    expect(readSession()).toBeNull();
    // The discarded payload is cleared so the wizard's next mount loads
    // a clean slate.
    expect(shim.getItem(STORAGE_KEY)).toBeNull();
  });
});
