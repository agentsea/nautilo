/**
 * M055 — refresh-token rotation.
 */
import { describe, expect, test } from "bun:test";
import { isAccessTokenExpiring, refreshTokens } from "../../../electron/auth/refresh";
import type { TokenBundle } from "../../../electron/auth/token-store";

const FROZEN_NOW = 1_700_000_000_000;

function bundle(overrides: Partial<TokenBundle> = {}): TokenBundle {
  return {
    access_token: "at",
    refresh_token: "rt",
    id_token: "it",
    expires_in: 3600,
    refreshed_at: FROZEN_NOW,
    ...overrides,
  };
}

describe("refreshTokens", () => {
  const baseConfig = {
    endpoint: "http://x",
    appId: "id",
    resource: "https://api.example.test",
  };

  test("returns null when no current bundle", async () => {
    const out = await refreshTokens(baseConfig, {
      fetchImpl: globalThis.fetch,
      loadTokens: () => null,
      saveTokens: () => {},
      clearTokens: () => {},
    });
    expect(out).toBeNull();
  });

  test("rotates refresh_token when server returns a new one", async () => {
    const saves: TokenBundle[] = [];
    const calls: string[] = [];
    const fetchImpl = (async (
      _input: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      calls.push(typeof init?.body === "string" ? init.body : String(init?.body));
      return new Response(
        JSON.stringify({
          access_token: "at-new",
          refresh_token: "rt-new",
          id_token: "it-new",
          expires_in: 1800,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    const out = await refreshTokens(baseConfig, {
      fetchImpl,
      loadTokens: () => bundle(),
      saveTokens: (b) => saves.push(b),
      clearTokens: () => {},
    });
    expect(out?.access_token).toBe("at-new");
    expect(out?.refresh_token).toBe("rt-new");
    expect(saves[0]?.refresh_token).toBe("rt-new");
    // RFC 8707 — refresh exchange must carry the same resource so
    // the rotated access token keeps the API audience. Without this
    // verifyLogtoAccessToken on the server falls through to guest.
    expect(calls[0]).toContain("resource=https%3A%2F%2Fapi.example.test");
  });

  test("preserves prior refresh_token when server omits it (no rotation)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ access_token: "at-2", expires_in: 1800 }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as typeof fetch;
    const out = await refreshTokens(baseConfig, {
      fetchImpl,
      loadTokens: () => bundle({ refresh_token: "rt-original" }),
      saveTokens: () => {},
      clearTokens: () => {},
    });
    expect(out?.refresh_token).toBe("rt-original");
    expect(out?.id_token).toBe("it");
  });

  test("clears tokens + returns null on non-2xx (e.g. revoked refresh)", async () => {
    let cleared = 0;
    const fetchImpl = (async () =>
      new Response("nope", { status: 400 })) as typeof fetch;
    const out = await refreshTokens(baseConfig, {
      fetchImpl,
      loadTokens: () => bundle(),
      saveTokens: () => {},
      clearTokens: () => {
        cleared += 1;
      },
    });
    expect(out).toBeNull();
    expect(cleared).toBe(1);
  });

  test("clears tokens on network error", async () => {
    let cleared = 0;
    const fetchImpl = (async () => {
      throw new Error("ECONNREFUSED");
    }) as typeof fetch;
    const out = await refreshTokens(baseConfig, {
      fetchImpl,
      loadTokens: () => bundle(),
      saveTokens: () => {},
      clearTokens: () => {
        cleared += 1;
      },
    });
    expect(out).toBeNull();
    expect(cleared).toBe(1);
  });
});

describe("M060 contract — post-fast-forward silent refresh", () => {
  // Phase 3 #7 — fixture-based round-trip: sign-in saved a bundle,
  // time advances past the access-token expiry, the next request
  // hits the refresh path, and a new access_token + refreshed_at
  // land back on disk. The "old" bundle is what `loadTokens`
  // returns; the "new" bundle is what `saveTokens` receives. We
  // assert (a) the new access token bubbles up to the caller (not
  // null — that's what would have happened pre-M060), and (b) the
  // saved bundle's refreshed_at advanced.
  test("expired bundle → refresh returns new access token and persists rotated bundle", async () => {
    const SIGN_IN_AT = 1_700_000_000_000;
    const NOW = SIGN_IN_AT + 3700 * 1000; // > expires_in (3600)
    const originalNow = Date.now;
    Date.now = () => NOW;
    try {
      const initialBundle: TokenBundle = {
        access_token: "at-from-sign-in",
        refresh_token: "rt-from-sign-in",
        id_token: "id-from-sign-in",
        expires_in: 3600,
        refreshed_at: SIGN_IN_AT,
      };
      expect(isAccessTokenExpiring(initialBundle)).toBe(true);

      const saves: TokenBundle[] = [];
      const fetchImpl = (async () =>
        new Response(
          JSON.stringify({
            access_token: "at-rotated",
            refresh_token: "rt-rotated",
            id_token: "id-rotated",
            expires_in: 3600,
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )) as typeof fetch;

      const out = await refreshTokens(
        {
          endpoint: "http://logto",
          appId: "desktop",
          resource: "https://api.nautilo.local",
        },
        {
          fetchImpl,
          loadTokens: () => initialBundle,
          saveTokens: (b) => saves.push(b),
          clearTokens: () => {},
        },
      );

      expect(out).not.toBeNull();
      expect(out?.access_token).toBe("at-rotated");
      expect(saves).toHaveLength(1);
      expect(saves[0]?.refreshed_at).toBe(NOW);
      expect(saves[0]?.refresh_token).toBe("rt-rotated");
    } finally {
      Date.now = originalNow;
    }
  });
});

describe("isAccessTokenExpiring", () => {
  test("false when freshly minted", () => {
    expect(isAccessTokenExpiring(bundle({ refreshed_at: Date.now() }))).toBe(false);
  });
  test("true when 90 minutes old (1h TTL)", () => {
    const past = Date.now() - 90 * 60_000;
    expect(isAccessTokenExpiring(bundle({ refreshed_at: past, expires_in: 3600 }))).toBe(
      true,
    );
  });
  test("respects skewMs — flagged early before actual expiry", () => {
    const refreshedAt = Date.now() - 50 * 60_000; // 50min ago, 60min TTL
    // With default 60s skew, 10min remaining → not expiring.
    expect(
      isAccessTokenExpiring(bundle({ refreshed_at: refreshedAt, expires_in: 3600 })),
    ).toBe(false);
    // With 15-minute skew, 10min remaining → flagged as expiring.
    expect(
      isAccessTokenExpiring(
        bundle({ refreshed_at: refreshedAt, expires_in: 3600 }),
        15 * 60_000,
      ),
    ).toBe(true);
  });
});
