import { describe, expect, test } from "bun:test";

import {
  createRailwayOwnerClaimBrowserHandoff,
} from "../../src/lib/railway-owner-claim-handoff.ts";
import {
  KeyringRailwayOwnerClaimStore,
  type RailwayOwnerClaimKeyringEntry,
} from "../../src/lib/railway-owner-claim-store.ts";
import {
  createRailwayOwnerClaimTarget,
  hashRailwayOwnerClaim,
  RailwayOwnerClaimControllerError,
} from "../../src/lib/railway-owner-claim-target.ts";

class MemoryEntry implements RailwayOwnerClaimKeyringEntry {
  value: string | null = null;
  writes = 0;

  getPassword(): Promise<string | null> { return Promise.resolve(this.value); }
  setPassword(value: string): Promise<void> {
    this.value = value;
    this.writes += 1;
    return Promise.resolve();
  }
  deleteCredential(): Promise<boolean> {
    const existed = this.value !== null;
    this.value = null;
    return Promise.resolve(existed);
  }
}

const claimA = `inv_${"a".repeat(32)}`;
const claimB = `inv_${"b".repeat(32)}`;

describe("Railway first-owner claim custody", () => {
  test("persists before a retry and reuses the exact claim after a lost response", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayOwnerClaimStore(entry);

    const first = await store.getOrCreate({
      launchId: "launch-1",
      releaseId: "release-1",
      generate: () => claimA,
    });
    const resumed = await store.getOrCreate({
      launchId: "launch-1",
      releaseId: "release-1",
      generate: () => claimB,
    });

    expect(first).toBe(claimA);
    expect(resumed).toBe(claimA);
    expect(entry.writes).toBe(1);
    expect(entry.value).not.toBeNull();
    expect(entry.value).not.toContain("claimHash");
  });

  test("rotates an expired prior claim before reissue", async () => {
    const entry = new MemoryEntry();
    const store = new KeyringRailwayOwnerClaimStore(entry);
    await store.getOrCreate({ launchId: "launch-1", releaseId: "release-1", generate: () => claimA });

    const replacement = await store.rotate({
      launchId: "launch-1",
      releaseId: "release-1",
      generate: () => claimB,
    });

    expect(replacement).toBe(claimB);
    expect(entry.writes).toBe(2);
    expect(await store.getOrCreate({ launchId: "launch-1", releaseId: "release-1" })).toBe(claimB);
  });
});

describe("Railway first-owner target protocol", () => {
  test("sends only a hash in a protected request body", async () => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const target = createRailwayOwnerClaimTarget((async (url, init) => {
      requests.push({ url: url instanceof Request ? url.url : url.toString(), init });
      return new Response(JSON.stringify({ schemaVersion: 1, state: "claim-active" }), { status: 200 });
    }) as typeof fetch);

    await target.install({
      targetUrl: "https://nautilo.example",
      bootstrapToken: "x".repeat(32),
      claimHash: hashRailwayOwnerClaim(claimA),
      expiresAt: "2026-08-07T00:15:00.000Z",
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toBe("https://nautilo.example/api/setup/owner-claim");
    expect(requests[0]!.init?.headers).toMatchObject({ Authorization: `Bearer ${"x".repeat(32)}` });
    const body = requests[0]!.init?.body;
    if (typeof body !== "string") throw new Error("expected JSON owner-claim body");
    expect(JSON.parse(body)).toEqual({
      schemaVersion: 1,
      claimHash: hashRailwayOwnerClaim(claimA),
      expiresAt: "2026-08-07T00:15:00.000Z",
    });
    expect(body).not.toContain(claimA);
  });

  test("classifies redacted controller failures without inventing target state", async () => {
    const errorCode = async (operation: Promise<unknown>): Promise<string> => {
      try {
        await operation;
      } catch (error) {
        expect(error).toBeInstanceOf(RailwayOwnerClaimControllerError);
        return (error as RailwayOwnerClaimControllerError).code;
      }
      throw new Error("expected a classified controller failure");
    };
    const statusFailure = async (response: Response): Promise<string> => {
      const target = createRailwayOwnerClaimTarget((async () => response) as unknown as typeof fetch);
      try {
        await target.status({ targetUrl: "https://nautilo.example" });
      } catch (error) {
        expect(error).toBeInstanceOf(RailwayOwnerClaimControllerError);
        return (error as RailwayOwnerClaimControllerError).code;
      }
      throw new Error("expected a classified status failure");
    };
    expect(await statusFailure(new Response("", { status: 403 }))).toBe("railway.owner-claim.authorization-rejected");
    expect(await statusFailure(new Response("", { status: 409 }))).toBe("railway.owner-claim.contract-rejected");
    expect(await statusFailure(new Response("not-json", { status: 200 }))).toBe("railway.owner-claim.invalid-response");

    const unreachable = createRailwayOwnerClaimTarget((async () => {
      throw new Error("socket refused");
    }) as unknown as typeof fetch);
    expect(await errorCode(unreachable.status({ targetUrl: "https://nautilo.example" })))
      .toBe("railway.owner-claim.unreachable");
    const timedOut = createRailwayOwnerClaimTarget((async () => {
      const error = new Error("timed out");
      error.name = "TimeoutError";
      throw error;
    }) as unknown as typeof fetch);
    expect(await errorCode(timedOut.status({ targetUrl: "https://nautilo.example" })))
      .toBe("railway.owner-claim.timeout");

    const ambiguousWrite = createRailwayOwnerClaimTarget((async () => {
      throw new Error("connection dropped after request write");
    }) as unknown as typeof fetch);
    expect(await errorCode(ambiguousWrite.install({
      targetUrl: "https://nautilo.example",
      bootstrapToken: "x".repeat(32),
      claimHash: hashRailwayOwnerClaim(claimA),
      expiresAt: "2026-08-07T00:15:00.000Z",
    }))).toBe("railway.owner-claim.ambiguous-write");

    const rejectedWrite = createRailwayOwnerClaimTarget((async () => new Response("", { status: 403 })) as unknown as typeof fetch);
    expect(await errorCode(rejectedWrite.install({
      targetUrl: "https://nautilo.example",
      bootstrapToken: "x".repeat(32),
      claimHash: hashRailwayOwnerClaim(claimA),
      expiresAt: "2026-08-07T00:15:00.000Z",
    }))).toBe("railway.owner-claim.authorization-rejected");
  });
});

describe("Railway first-owner browser handoff", () => {
  test("opens a non-secret localhost URL and redirects once to the exact fragment contract", async () => {
    const handoff = await createRailwayOwnerClaimBrowserHandoff({
      targetUrl: "https://nautilo.example",
      claim: claimA,
      finish: "product",
      nonce: "n".repeat(43),
    });
    try {
      expect(handoff.localUrl).not.toContain(claimA);
      const response = await fetch(handoff.localUrl, { redirect: "manual" });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `https://nautilo.example/claim#claim=${claimA}&finish=product`,
      );
      expect(response.headers.get("cache-control")).toContain("no-store");
      expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    } finally {
      await handoff.close();
    }
  });
});
