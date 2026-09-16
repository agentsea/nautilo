/**
 * M056 — `validateRelayToken` (in-band validator used by
 * `relay-endpoint.ts`'s `relay:register` switch arm).
 *
 * Pure-store tests: the DB seam is stubbed via `setRelayTokenStore`
 * so the helper is exercised without touching Postgres.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  resetRelayTokenStore,
  setRelayTokenStore,
  type RelayTokenStore,
} from "../../src/lib/relay-token-store";
import { validateRelayToken } from "../../src/realtime/relay-token";

function sha256Hex(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

describe("validateRelayToken (M056)", () => {
  afterEach(() => {
    resetRelayTokenStore();
  });

  test("returns null for undefined token without hitting the store", async () => {
    let called = false;
    const store: RelayTokenStore = {
      insertToken: async () => ({ id: "" }),
      pairForInstallation: async () => ({ id: "" }),
      findActiveByHash: async () => {
        called = true;
        return null;
      },
      touchLastSeen: async () => {},
      listForUser: async () => [],
      revokeForUser: async () => false,
    };
    setRelayTokenStore(store);
    expect(await validateRelayToken(undefined)).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null for a token without the rty_ prefix without hitting the store", async () => {
    let called = false;
    const store: RelayTokenStore = {
      insertToken: async () => ({ id: "" }),
      pairForInstallation: async () => ({ id: "" }),
      findActiveByHash: async () => {
        called = true;
        return null;
      },
      touchLastSeen: async () => {},
      listForUser: async () => [],
      revokeForUser: async () => false,
    };
    setRelayTokenStore(store);
    expect(await validateRelayToken("not-a-relay-token")).toBeNull();
    expect(called).toBe(false);
  });

  test("returns null when the store reports no active row", async () => {
    setRelayTokenStore({
      insertToken: async () => ({ id: "" }),
      pairForInstallation: async () => ({ id: "" }),
      findActiveByHash: async () => null,
      touchLastSeen: async () => {},
      listForUser: async () => [],
      revokeForUser: async () => false,
    });
    expect(await validateRelayToken("rty_abc123")).toBeNull();
  });

  test("returns the validated identity for a known token and bumps last_seen", async () => {
    const plaintext = "rty_known-token-value";
    const expectedHash = sha256Hex(plaintext);
    let touched = "";
    let observedHash = "";
    setRelayTokenStore({
      insertToken: async () => ({ id: "" }),
      pairForInstallation: async () => ({ id: "" }),
      findActiveByHash: async (hash) => {
        observedHash = hash;
        return { id: "tok-1", userId: "user-1", actorId: "actor-1" };
      },
      touchLastSeen: async (id) => {
        touched = id;
      },
      listForUser: async () => [],
      revokeForUser: async () => false,
    });
    const result = await validateRelayToken(plaintext);
    expect(result).toEqual({
      tokenId: "tok-1",
      userId: "user-1",
      actorId: "actor-1",
    });
    expect(observedHash).toBe(expectedHash);
    // touchLastSeen runs fire-and-forget — yield once for the
    // microtask queue then assert.
    await new Promise((r) => setTimeout(r, 0));
    expect(touched).toBe("tok-1");
  });

  test("touchLastSeen failure does NOT reject the validation promise", async () => {
    setRelayTokenStore({
      insertToken: async () => ({ id: "" }),
      pairForInstallation: async () => ({ id: "" }),
      findActiveByHash: async () => ({
        id: "tok-1",
        userId: "user-1",
        actorId: "actor-1",
      }),
      touchLastSeen: async () => {
        throw new Error("transient db hiccup");
      },
      listForUser: async () => [],
      revokeForUser: async () => false,
    });
    const result = await validateRelayToken("rty_anything");
    expect(result?.userId).toBe("user-1");
    // Yield so the caught rejection settles.
    await new Promise((r) => setTimeout(r, 0));
  });
});
