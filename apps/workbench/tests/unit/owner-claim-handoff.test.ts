import { afterEach, describe, expect, test } from "bun:test";
import {
  OWNER_CLAIM_STORAGE_KEY,
  consumeOwnerClaimFragment,
  readOwnerClaimHandoff,
} from "../../src/lib/owner-claim-handoff";

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem(key: string) {
      return values.get(key) ?? null;
    },
    setItem(key: string, value: string) {
      values.set(key, value);
    },
    removeItem(key: string) {
      values.delete(key);
    },
  } as Storage;
}

function browserFor(hash: string) {
  const calls: string[] = [];
  return {
    browser: {
      location: { hash, pathname: "/claim", search: "?source=railway" },
      history: {
        state: null,
        replaceState(_state: unknown, _title: string, url?: string | URL | null) {
          calls.push(String(url));
        },
      },
    } as unknown as { location: Location; history: History },
    calls,
  };
}

const claim = `inv_${"a".repeat(32)}`;

describe("owner-claim-handoff", () => {
  afterEach(() => {
    Reflect.deleteProperty(globalThis, "sessionStorage");
    Reflect.deleteProperty(globalThis, "localStorage");
  });

  test("scrubs a valid same-origin fragment before retaining its claim in sessionStorage", () => {
    const session = makeStorage();
    const local = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    const { browser, calls } = browserFor(`#claim=${claim}`);

    const result = consumeOwnerClaimFragment(browser);

    expect(result).toEqual({ outcome: "stored" });
    expect(JSON.stringify(result)).not.toContain(claim);
    expect(calls).toEqual(["/claim?source=railway"]);
    expect(readOwnerClaimHandoff()?.claim).toBe(claim);
    expect(readOwnerClaimHandoff()?.finish).toBe("guide");
    expect(local.getItem(OWNER_CLAIM_STORAGE_KEY)).toBeNull();
  });

  test("accepts only the code-owned product finish mode and keeps it session-scoped", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const { browser, calls } = browserFor(`#claim=${claim}&finish=product`);

    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "stored" });
    expect(calls).toEqual(["/claim?source=railway"]);
    expect(readOwnerClaimHandoff()?.finish).toBe("product");
    expect(session.getItem(OWNER_CLAIM_STORAGE_KEY)).not.toContain("/claim");
  });

  test("accepts a validated non-secret handle prefill without changing legacy handoffs", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const { browser } = browserFor(`#claim=${claim}&finish=product&handle=mini_cloud_owner`);
    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "stored" });
    expect(readOwnerClaimHandoff()).toMatchObject({ handle: "mini_cloud_owner", stage: "preview" });
  });

  test("defaults a pre-D508 v1 handoff to guide but rejects unknown or URL-shaped finishes", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    session.setItem(OWNER_CLAIM_STORAGE_KEY, JSON.stringify({
      version: 1,
      claim,
      state: "opaque",
      handle: "owner",
      stage: "profile",
      startedAt: new Date().toISOString(),
    }));
    expect(readOwnerClaimHandoff()?.finish).toBe("guide");

    const { browser, calls } = browserFor(`#claim=${claim}&finish=https%3A%2F%2Fevil.example`);
    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "invalid" });
    expect(calls).toEqual(["/claim?source=railway"]);
    expect(readOwnerClaimHandoff()).toBeNull();
  });

  test("returns the same redacted result for an immediate StrictMode remount after scrub", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const { browser, calls } = browserFor(`#claim=${claim}`);

    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "stored" });
    (browser.location as unknown as { hash: string }).hash = "";
    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "stored" });
    expect(calls).toEqual(["/claim?source=railway"]);
  });

  test("rejects duplicate or non-claim fragment parameters and still removes the fragment", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const { browser, calls } = browserFor(`#claim=${claim}&next=/rooms`);

    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "invalid" });
    expect(calls).toEqual(["/claim?source=railway"]);
    expect(readOwnerClaimHandoff()).toBeNull();
  });

  test("requires the exact canonical 32-character capability shape", () => {
    const session = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    const { browser, calls } = browserFor(`#claim=inv_${"a".repeat(31)}`);

    expect(consumeOwnerClaimFragment(browser)).toEqual({ outcome: "invalid" });
    expect(calls).toEqual(["/claim?source=railway"]);
  });

  test("retains a paused session handoff for server-side expiry evaluation and never falls back to localStorage", () => {
    const session = makeStorage();
    const local = makeStorage();
    Object.defineProperty(globalThis, "sessionStorage", { value: session, configurable: true });
    Object.defineProperty(globalThis, "localStorage", { value: local, configurable: true });
    local.setItem(OWNER_CLAIM_STORAGE_KEY, JSON.stringify({
      version: 1,
      claim,
      state: "opaque",
      handle: "owner",
      stage: "awaiting-bind",
      startedAt: new Date().toISOString(),
    }));
    expect(readOwnerClaimHandoff()).toBeNull();

    session.setItem(OWNER_CLAIM_STORAGE_KEY, JSON.stringify({
      version: 1,
      claim,
      state: "opaque",
      handle: "owner",
      stage: "awaiting-bind",
      startedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString(),
    }));
    // Browser retention cannot pronounce a still-valid paused claim expired:
    // preview/bind/completion ask the server for that canonical decision.
    expect(readOwnerClaimHandoff()).toMatchObject({ claim, stage: "awaiting-bind" });
    expect(session.getItem(OWNER_CLAIM_STORAGE_KEY)).not.toBeNull();
  });
});
