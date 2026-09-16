import { describe, expect, mock, test } from "bun:test";
import type { FastifyReply, FastifyRequest } from "fastify";
import {
  DEFAULT_LOGTO_FRESHNESS_MAX_AGE_MS,
  isLogtoAccessTokenFresh,
  requireFreshLogtoAccessToken,
} from "../../src/lib/logto-freshness";

function reqWithIat(iat: number | null | undefined): FastifyRequest {
  return { accessTokenIssuedAt: iat ?? null } as FastifyRequest;
}

describe("logto-freshness", () => {
  test("isLogtoAccessTokenFresh — token issued ~1 min ago is fresh", () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    expect(isLogtoAccessTokenFresh(reqWithIat(iat))).toBe(true);
  });

  test("isLogtoAccessTokenFresh — token issued ~10 min ago is stale", () => {
    const iat = Math.floor(Date.now() / 1000) - 600;
    expect(isLogtoAccessTokenFresh(reqWithIat(iat))).toBe(false);
  });

  test("isLogtoAccessTokenFresh — future iat is not fresh", () => {
    const iat = Math.floor(Date.now() / 1000) + 3600;
    expect(isLogtoAccessTokenFresh(reqWithIat(iat))).toBe(false);
  });

  test("isLogtoAccessTokenFresh — missing accessTokenIssuedAt is not fresh", () => {
    expect(isLogtoAccessTokenFresh(reqWithIat(null))).toBe(false);
    expect(isLogtoAccessTokenFresh({} as FastifyRequest)).toBe(false);
  });

  test("requireFreshLogtoAccessToken — stale sends 401 body and returns true", async () => {
    const iat = Math.floor(Date.now() / 1000) - 600;
    const request = reqWithIat(iat);
    let status = 0;
    let body: unknown;
    const reply = {
      code(c: number) {
        status = c;
        return {
          send: async (b: unknown) => {
            body = b;
          },
        };
      },
    } as unknown as FastifyReply;
    const stop = await requireFreshLogtoAccessToken(request, reply);
    expect(stop).toBe(true);
    expect(status).toBe(401);
    expect(body).toEqual({
      error: "fresh_reauth_required",
      message:
        "This action requires a recently-issued access token. Re-authenticate with prompt=login and retry.",
      maxAgeMs: DEFAULT_LOGTO_FRESHNESS_MAX_AGE_MS,
    });
  });

  test("requireFreshLogtoAccessToken — fresh returns false (caller proceeds)", async () => {
    const iat = Math.floor(Date.now() / 1000) - 60;
    const request = reqWithIat(iat);
    const code = mock(() => ({ send: mock(async () => {}) }));
    const reply = { code } as unknown as FastifyReply;
    const stop = await requireFreshLogtoAccessToken(request, reply);
    expect(stop).toBe(false);
    expect(code).not.toHaveBeenCalled();
  });
});
