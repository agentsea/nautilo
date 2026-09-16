import { describe, expect, test } from "bun:test";

import {
  createOwnerClaimTarget, OwnerClaimControllerError,
} from "../../src/lib/owner-claim-target.ts";
import {
  createRailwayOwnerClaimTarget, RailwayOwnerClaimControllerError,
} from "../../src/lib/railway-owner-claim-target.ts";

const claimHash = "a".repeat(64);
const bootstrapToken = "b".repeat(32);
const loopbackPolicy = {
  validateTargetUrl(value: string): URL {
    const url = new URL(value);
    if (url.protocol !== "http:" || url.hostname !== "localhost" || url.search !== "" || url.hash !== "") {
      throw new Error("Compose owner target is invalid");
    }
    return url;
  },
};

describe("provider-neutral owner-claim target", () => {
  test("permits an injected Compose loopback HTTP policy without importing Railway semantics", async () => {
    const requests: string[] = [];
    const target = createOwnerClaimTarget({
      transport: loopbackPolicy,
      fetchImpl: (async (url: string | URL | Request) => {
        const urlString = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
        requests.push(urlString);
        return new Response(JSON.stringify({ schemaVersion: 1, state: "claim-active" }));
      }) as unknown as typeof fetch,
    });
    await target.install({
      targetUrl: "http://localhost:3101",
      authorization: { kind: "bearer", token: bootstrapToken },
      claimHash,
      expiresAt: "2026-08-07T00:15:00.000Z",
    });
    expect(requests).toEqual(["http://localhost:3101/api/setup/owner-claim"]);
  });

  test("trusted loopback installation sends no authorization header", async () => {
    let authorization: string | null = "unset";
    const target = createOwnerClaimTarget({
      transport: loopbackPolicy,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        authorization = new Headers(init?.headers).get("authorization");
        return new Response(JSON.stringify({ schemaVersion: 1, state: "claim-active" }));
      }) as unknown as typeof fetch,
    });
    await target.install({
      targetUrl: "http://localhost:3101",
      authorization: { kind: "trusted-loopback" },
      claimHash,
      expiresAt: "2026-08-07T00:15:00.000Z",
    });
    expect(authorization).toBeNull();
  });

  test("trusted loopback authority cannot be sent to a public origin", async () => {
    let fetched = false;
    const target = createOwnerClaimTarget({
      transport: { validateTargetUrl: (value) => new URL(value) },
      fetchImpl: (async () => {
        fetched = true;
        return new Response(JSON.stringify({ schemaVersion: 1, state: "claim-active" }));
      }) as unknown as typeof fetch,
    });
    try {
      await target.install({
        targetUrl: "https://nautilo.example",
        authorization: { kind: "trusted-loopback" },
        claimHash,
        expiresAt: "2026-08-07T00:15:00.000Z",
      });
      throw new Error("expected target rejection");
    } catch (error) {
      expect(error).toHaveProperty("message", "Trusted owner claim installation requires an exact HTTP loopback target");
    }
    expect(fetched).toBe(false);
  });

  test("bearer authority cannot be sent over public cleartext HTTP", async () => {
    let fetched = false;
    const target = createOwnerClaimTarget({
      transport: { validateTargetUrl: (value) => new URL(value) },
      fetchImpl: (async () => {
        fetched = true;
        return new Response(JSON.stringify({ schemaVersion: 1, state: "claim-active" }));
      }) as unknown as typeof fetch,
    });
    try {
      await target.install({
        targetUrl: "http://nautilo.example",
        authorization: { kind: "bearer", token: bootstrapToken },
        claimHash,
        expiresAt: "2026-08-07T00:15:00.000Z",
      });
      throw new Error("expected target rejection");
    } catch (error) {
      expect(error).toHaveProperty("message", "Bearer owner claim installation requires HTTPS or exact HTTP loopback");
    }
    expect(fetched).toBe(false);
  });

  test("keeps strict two-key response parsing under the neutral category", async () => {
    const target = createOwnerClaimTarget({
      transport: loopbackPolicy,
      fetchImpl: (async () => new Response(JSON.stringify({
        schemaVersion: 1, state: "owner-bound", continuation: "not-allowed",
      }))) as unknown as typeof fetch,
    });
    try {
      await target.status({ targetUrl: "http://localhost:3101" });
      throw new Error("expected strict status rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(OwnerClaimControllerError);
      expect((error as OwnerClaimControllerError).failure).toBe("invalid-response");
    }
  });

  test("maps the same strict failure back to Railway's exact public error", async () => {
    const target = createRailwayOwnerClaimTarget((async () => new Response(JSON.stringify({
      schemaVersion: 1, state: "owner-bound", continuation: "not-allowed",
    }))) as unknown as typeof fetch);
    try {
      await target.status({ targetUrl: "https://nautilo.example" });
      throw new Error("expected strict status rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(RailwayOwnerClaimControllerError);
      expect((error as RailwayOwnerClaimControllerError).name).toBe("RailwayOwnerClaimControllerError");
      expect((error as RailwayOwnerClaimControllerError).code).toBe("railway.owner-claim.invalid-response");
    }
  });

  test("rejects the wrong policy before transport", async () => {
    const target = createOwnerClaimTarget({ transport: loopbackPolicy });
    try {
      await target.status({ targetUrl: "https://nautilo.example" });
      throw new Error("expected policy rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toBe("Compose owner target is invalid");
    }
    expect(OwnerClaimControllerError.name).toBe("OwnerClaimControllerError");
  });
});
