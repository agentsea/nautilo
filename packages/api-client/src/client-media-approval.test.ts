import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "./client";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("D525 paid media approval client echo", () => {
  test("sends the exact media receipt fields for once and deny only when supplied", async () => {
    const bodies: unknown[] = [];
    const mockFetch = async (_input: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body !== "string") throw new Error("expected JSON request body");
      bodies.push(JSON.parse(init.body) as unknown);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: originalFetch.preconnect?.bind(originalFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const media = { digest: "a".repeat(64), quoteDigest: "b".repeat(64), revision: 1 };
    await client.approvalReply(
      "once", "thread-1", "lane-1", "approval-1", undefined, media,
    );
    await client.approvalReply(
      "deny", "thread-2", "lane-2", "approval-2", undefined, media,
    );
    await client.approvalReply("once", "thread-3", "lane-3", "approval-3");

    expect(bodies[0]).toMatchObject({
      verb: "once",
      approvalId: "approval-1",
      laneKey: "lane-1",
      mediaGenerationDigest: media.digest,
      mediaGenerationQuoteDigest: media.quoteDigest,
      mediaGenerationRevision: 1,
    });
    expect(bodies[1]).toMatchObject({ verb: "deny", mediaGenerationDigest: media.digest });
    expect(bodies[2]).not.toHaveProperty("mediaGenerationDigest");
    expect(bodies[2]).not.toHaveProperty("mediaGenerationQuoteDigest");
    expect(bodies[2]).not.toHaveProperty("mediaGenerationRevision");
  });
});
