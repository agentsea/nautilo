import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";

function reqUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("NautiloApiClient invite list + revoke (M106)", () => {
  const base = "http://127.0.0.1:3001";
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("createInvite validates the handoff and normalizes an older receipt", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites`);
      expect(init?.method).toBe("POST");
      return new Response(JSON.stringify({
        id: "invite-id",
        url: "https://nautilo.example/redeem/inv_secret",
        token: "inv_secret",
        kind: "server",
        expiresAt: null,
        maxUses: 1,
      }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.createInvite({
      kind: "server",
      targetGroupRoleSlug: "member",
      maxUses: 1,
    });
    expect(out.mutation).toEqual({
      stateChanged: true,
      auditRecorded: "unknown",
      retrySafe: false,
      receiptId: "invite-id",
      recovery: [{ kind: "revoke_invite", inviteId: "invite-id" }],
    });
  });

  test("listMyInvites calls GET /api/invites and returns parsed envelope", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites`);
      expect(init?.method ?? "GET").toBe("GET");
      const h = new Headers(init?.headers);
      expect(h.get("authorization")).toBe("Bearer t");
      return new Response(
        JSON.stringify({
          invites: [
            {
              id: "inv_1",
              kind: "server",
              maxUses: 1,
              usedCount: 0,
              expiresAt: null,
              revokedAt: null,
              createdAt: "2026-01-01T00:00:00.000Z",
              displayName: null,
              targetRoomId: null,
              targetRoomLabel: null,
              targetRoleSlug: "member",
            },
            {
              id: "claim_1",
              kind: "claim",
              maxUses: 1,
              usedCount: 0,
              expiresAt: null,
              revokedAt: null,
              createdAt: "2025-12-31T00:00:00.000Z",
              displayName: null,
              targetRoomId: null,
              targetRoomLabel: null,
              targetRoleSlug: "owner",
            },
          ],
          page: {
            returned: 2,
            complete: true,
            hasMore: false,
            nextCursor: null,
            continuationAvailable: true,
          },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const out = await client.listMyInvites();
    expect(out.invites).toHaveLength(2);
    expect(out.invites[0]?.id).toBe("inv_1");
    expect(out.invites[0]?.kind).toBe("server");
    expect(out.invites[1]?.kind).toBe("claim");
    expect(out.page).toEqual({
      returned: 2,
      complete: true,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: true,
    });
  });

  test("revokeInvite calls DELETE /api/invites/:id encoded", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites/inv_xyz`);
      expect(init?.method).toBe("DELETE");
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.revokeInvite("inv_xyz");
    expect(out).toEqual({
      ok: true,
      mutation: {
        stateChanged: "unknown",
        auditRecorded: "unknown",
        retrySafe: true,
        receiptId: "inv_xyz",
        recovery: [],
      },
    });
  });

  test("listInvites encodes bounded continuation and all scope", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("t");

    globalThis.fetch = (async (url: Parameters<typeof fetch>[0]) => {
      expect(reqUrl(url)).toBe(`${base}/api/invites?all=true&cursor=next-page&limit=25`);
      return new Response(JSON.stringify({ invites: [] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const out = await client.listInvites({ all: true, cursor: "next-page", limit: 25 });
    expect(out.page).toEqual({
      returned: 0,
      complete: false,
      hasMore: false,
      nextCursor: null,
      continuationAvailable: false,
    });
  });

  test("listMyInvites 401 throws ApiError(401, Authentication required)", async () => {
    const client = new NautiloApiClient(base);
    client.setToken("bad");

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "nope" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;

    try {
      await client.listMyInvites();
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(ApiError);
      const err = e as ApiError;
      expect(err.status).toBe(401);
      expect(err.message).toBe("Authentication required");
    }
  });
});
