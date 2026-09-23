/**
 * D145 / Stack 19 — persisted-viewer-cache contract.
 *
 * Pins read/write/clear behavior + storage-failure tolerance for the
 * device-level localStorage cache that hydrates `useViewerAuth` on
 * mount. Mirrors the test shape of `persisted-ws-history.test.ts`
 * (single device-level slot, JSON envelope, schema version, safe-storage
 * fallthrough).
 */
import { beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  __resetForTests,
  clearLastKnownViewer,
  readLastKnownViewer,
  writeLastKnownViewer,
  type CachedViewer,
} from "../../src/lib/persisted-viewer-cache";
import { installLocalStorageShim } from "../../src/test-helpers/local-storage-shim";

const ownerViewer: CachedViewer = {
  role: "owner",
  label: "Operator",
  userIdentity: "operator@example.com",
  sessionUserId: "550e8400-e29b-41d4-a716-446655440000",
  isVerified: true,
  capabilities: ["manage_server_security", "manage_members"],
};

const guestViewer: CachedViewer = {
  role: "guest",
  label: "Jeannie",
  userIdentity: "jeannie@example.com",
  sessionUserId: "550e8400-e29b-41d4-a716-446655440001",
  isVerified: false,
  capabilities: [],
};

describe("persisted-viewer-cache (D145 / Stack 19)", () => {
  beforeAll(() => {
    installLocalStorageShim();
  });

  beforeEach(() => {
    __resetForTests();
  });

  test("read on empty storage returns null (genuine first launch)", () => {
    expect(readLastKnownViewer()).toBeNull();
  });

  test("write then read round-trips all fields (incl. M129 capabilities)", () => {
    writeLastKnownViewer(ownerViewer);
    const got = readLastKnownViewer();
    expect(got).not.toBeNull();
    expect(got?.role).toBe("owner");
    expect(got?.label).toBe("Operator");
    expect(got?.userIdentity).toBe("operator@example.com");
    expect(got?.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(got?.isVerified).toBe(true);
    expect(got?.capabilities).toEqual(["manage_server_security", "manage_members"]);
  });

  test("round-trips every canonical viewer role used by whoami", () => {
    const roles: CachedViewer["role"][] = [
      "owner",
      "admin",
      "superuser",
      "member",
      "contributor",
      "community",
      "guest",
      "anonymous",
      "stranger",
    ];

    for (const role of roles) {
      writeLastKnownViewer({
        ...ownerViewer,
        role,
        isVerified: role !== "guest" && role !== "stranger" && role !== "anonymous",
      });
      expect(readLastKnownViewer()?.role).toBe(role);
    }
  });

  test("second write overwrites first (single device-level slot, no LRU)", () => {
    writeLastKnownViewer(ownerViewer);
    writeLastKnownViewer(guestViewer);
    const got = readLastKnownViewer();
    expect(got?.label).toBe("Jeannie");
    expect(got?.sessionUserId).toBe("550e8400-e29b-41d4-a716-446655440001");
  });

  test("clearLastKnownViewer wipes the slot", () => {
    writeLastKnownViewer(ownerViewer);
    expect(readLastKnownViewer()).not.toBeNull();
    clearLastKnownViewer();
    expect(readLastKnownViewer()).toBeNull();
  });

  test("write tolerates storage failure (private window — setItem throws)", () => {
    writeLastKnownViewer(ownerViewer); // populate the shim once
    // Simulate quota-exceeded / private-browsing setItem failure. The
    // module must NOT throw; subsequent read returns the previously-stored
    // value (write was a no-op).
    //
    // Stack 19 Phase 6.9.6 lesson — MUST use Object.defineProperty here,
    // NOT direct assignment (`ls.setItem = () => throw`). Direct
    // assignment is a silent no-op on Linux CI where happy-dom backs
    // Storage with a Proxy that rejects own-property writes; the throw
    // never fires, the real setItem runs, write succeeds, and the
    // subsequent assertion fails ("Expected 'owner' but got 'Jeannie'").
    // `defineProperty` shadows the prototype method via an own property
    // descriptor and works portably.
    const ls = window.localStorage;
    const originalSetItem = ls.setItem.bind(ls);
    Object.defineProperty(ls, "setItem", {
      value: () => {
        throw new Error("QuotaExceededError");
      },
      configurable: true,
      writable: true,
    });
    expect(() => writeLastKnownViewer(guestViewer)).not.toThrow();
    Object.defineProperty(ls, "setItem", {
      value: originalSetItem,
      configurable: true,
      writable: true,
    });
    // Previously-stored owner is still there because the failed write
    // didn't overwrite it.
    expect(readLastKnownViewer()?.role).toBe("owner");
  });

  test("read tolerates storage failure (getItem throws)", () => {
    writeLastKnownViewer(ownerViewer);
    // See sibling test above for the defineProperty rationale.
    const ls = window.localStorage;
    const originalGetItem = ls.getItem.bind(ls);
    Object.defineProperty(ls, "getItem", {
      value: () => {
        throw new Error("storage access denied");
      },
      configurable: true,
      writable: true,
    });
    expect(readLastKnownViewer()).toBeNull();
    Object.defineProperty(ls, "getItem", {
      value: originalGetItem,
      configurable: true,
      writable: true,
    });
  });

  test("read returns null on malformed JSON", () => {
    window.localStorage.setItem("nautilo.viewer.last-known.v2", "{not json");
    expect(readLastKnownViewer()).toBeNull();
  });

  test("read returns null on schema-version mismatch (M129 — v1 record dropped)", () => {
    // A pre-M129 v1 record must be treated as a cache miss so we never
    // hydrate a viewer that predates the capabilities field.
    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({ v: 1, role: "owner", label: "Operator" }),
    );
    expect(readLastKnownViewer()).toBeNull();
  });

  test("read returns null on bogus role (incl. retired M133 slugs)", () => {
    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({
        v: 2,
        role: "household",
        label: "Operator",
        userIdentity: null,
        sessionUserId: null,
        isVerified: true,
        capabilities: [],
        cachedAt: Date.now(),
      }),
    );
    expect(readLastKnownViewer()).toBeNull();

    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({
        v: 2,
        role: "evil-role",
        label: "Operator",
        userIdentity: null,
        sessionUserId: null,
        isVerified: true,
        capabilities: [],
        cachedAt: Date.now(),
      }),
    );
    expect(readLastKnownViewer()).toBeNull();
  });

  test("read normalizes non-string userIdentity / sessionUserId to null", () => {
    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({
        v: 2,
        role: "owner",
        label: "Operator",
        userIdentity: 42, // bogus type
        sessionUserId: { foo: "bar" }, // bogus type
        isVerified: true,
        capabilities: [],
        cachedAt: Date.now(),
      }),
    );
    const got = readLastKnownViewer();
    expect(got).not.toBeNull();
    expect(got?.userIdentity).toBeNull();
    expect(got?.sessionUserId).toBeNull();
  });

  test("M129 — read defaults a missing/garbled capabilities field to [] (AR-6)", () => {
    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({
        v: 2,
        role: "owner",
        label: "Operator",
        userIdentity: null,
        sessionUserId: null,
        isVerified: true,
        // capabilities omitted entirely
        cachedAt: Date.now(),
      }),
    );
    expect(readLastKnownViewer()?.capabilities).toEqual([]);
  });

  test("M129 — read drops unknown capability slugs (never grants an unknown privilege)", () => {
    window.localStorage.setItem(
      "nautilo.viewer.last-known.v2",
      JSON.stringify({
        v: 2,
        role: "owner",
        label: "Operator",
        userIdentity: null,
        sessionUserId: null,
        isVerified: true,
        capabilities: ["manage_members", "totally_made_up_cap", 42],
        cachedAt: Date.now(),
      }),
    );
    expect(readLastKnownViewer()?.capabilities).toEqual(["manage_members"]);
  });
});
