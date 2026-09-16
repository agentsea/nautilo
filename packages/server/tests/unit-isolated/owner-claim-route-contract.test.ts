/** D488 0B.6A — strict controller API paths and redacted output contract. */
import { beforeAll, describe, expect, mock, test } from "bun:test";
import Fastify from "fastify";

const calls: Array<{ kind: string; value?: unknown }> = [];

beforeAll(() => {
  mock.module("../../src/lib/owner-claim-control.ts", () => ({
    getOwnerClaimProjection: async () => ({
      status: "claim-active",
      ownerBound: false,
      activeClaim: true,
    }),
    installOwnerClaim: async (value: unknown) => {
      calls.push({ kind: "install", value });
      return {
        ok: true,
        status: "installed",
        expiresAt: new Date("2026-08-07T12:10:00.000Z"),
      };
    },
    revokeOwnerClaim: async () => ({ ok: true, status: "revoked" }),
  }));
  mock.module("../../src/lib/request-trust.ts", () => ({
    requestAllowsPrivilegedSetup: () => true,
  }));
});

async function makeApp() {
  const { setupRoutes } = await import("../../src/routes/setup.ts");
  const app = Fastify({ logger: false });
  setupRoutes(app);
  await app.ready();
  return app;
}

describe("owner claim controller routes", () => {
  test("status path returns only the fixed schema and state", async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({ method: "GET", url: "/api/setup/owner-claim/status" });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ schemaVersion: 1, state: "claim-active" });
    } finally {
      await app.close();
    }
  });

  test("PUT accepts only hash/expiry input and never reflects them", async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/setup/owner-claim",
        payload: {
          schemaVersion: 1,
          claimHash: "a".repeat(64),
          expiresAt: "2026-08-07T12:10:00.000Z",
        },
      });
      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toEqual({ schemaVersion: 1, state: "claim-active" });
      expect(calls).toContainEqual({
        kind: "install",
        value: {
          claimHash: "a".repeat(64),
          expiresAt: "2026-08-07T12:10:00.000Z",
        },
      });
      expect(response.body).not.toContain("a".repeat(64));
    } finally {
      await app.close();
    }
  });

  test("PUT rejects a plaintext-token field instead of silently accepting it", async () => {
    const app = await makeApp();
    try {
      const response = await app.inject({
        method: "PUT",
        url: "/api/setup/owner-claim",
        payload: {
          schemaVersion: 1,
          claimHash: "a".repeat(64),
          expiresAt: "2026-08-07T12:10:00.000Z",
          token: "must-not-cross-the-boundary",
        },
      });
      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("must-not-cross-the-boundary");
    } finally {
      await app.close();
    }
  });

  test("PUT rejects a missing or unknown protocol version", async () => {
    const app = await makeApp();
    try {
      for (const payload of [
        { claimHash: "a".repeat(64), expiresAt: "2026-08-07T12:10:00.000Z" },
        { schemaVersion: 2, claimHash: "a".repeat(64), expiresAt: "2026-08-07T12:10:00.000Z" },
      ]) {
        const response = await app.inject({ method: "PUT", url: "/api/setup/owner-claim", payload });
        expect(response.statusCode).toBe(400);
        expect(JSON.parse(response.body)).toEqual({ schemaVersion: 1, error: "invalid_owner_claim_request" });
      }
    } finally {
      await app.close();
    }
  });

  test("accepts the actual CLI serializer bytes through the actual Fastify schema", async () => {
    const app = await makeApp();
    try {
      const { createRailwayOwnerClaimTarget } = await import(
        "../../../../apps/cli/src/lib/railway-owner-claim-target.ts"
      );
      const target = createRailwayOwnerClaimTarget((async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : input.toString());
        const headers = new Headers(init?.headers);
        const injected = await app.inject({
          method: "PUT",
          url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(headers.entries()),
          payload: typeof init?.body === "string" ? init.body : "",
        });
        return new globalThis.Response(injected.body, { status: injected.statusCode });
      }) as typeof fetch);

      const response = await target.install({
        targetUrl: "https://nautilo.example",
        bootstrapToken: "x".repeat(32),
        claimHash: "b".repeat(64),
        expiresAt: "2026-08-07T12:10:00.000Z",
      });
      expect(response).toEqual({ schemaVersion: 1, state: "claim-active" });
      expect(calls).toContainEqual({
        kind: "install",
        value: {
          claimHash: "b".repeat(64),
          expiresAt: "2026-08-07T12:10:00.000Z",
        },
      });
    } finally {
      await app.close();
    }
  });
});
