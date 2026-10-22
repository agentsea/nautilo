import { describe, expect, test } from "bun:test";

import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";

const CLAIM = "40000000-0000-4000-8000-000000000001";
const TASK = "40000000-0000-4000-8000-000000000002";

const candidate = Object.freeze({
  kind: "definition" as const,
  taskId: TASK,
  sourceCreatedAt: 1_000,
  sourceUpdatedAt: 2_000,
  sourceRevision: 0,
  sourceStatus: "paused",
});

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

describe("Task content backfill HTTP methods", () => {
  test("uses the current session, exact named commands, and closed request bodies", async () => {
    const requests: Array<Readonly<{
      method: string;
      path: string;
      authorization: string | null;
      body: unknown;
      signal: AbortSignal | null | undefined;
    }>> = [];
    const fetchImpl: NautiloApiFetch = async (target, init) => {
      const url = new URL(typeof target === "string" ? target
        : target instanceof URL ? target.href : target.url);
      requests.push({
        method: init?.method ?? "GET",
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        signal: init?.signal,
      });
      if (url.pathname.endsWith("/discover")) {
        return response({ status: "ready", value: { status: "more" } });
      }
      if (url.pathname.endsWith("/claim")) {
        return response({ status: "ready", value: { status: "held" } });
      }
      if (url.pathname.endsWith("/source")) {
        return response({ status: "waiting_for_authority", resumeAt: null });
      }
      if (url.pathname.endsWith("/publish")) return response({ status: "published" });
      if (url.pathname.endsWith("/recover")) return response({ status: "pending" });
      if (url.pathname.endsWith("/progress")) return response({ status: "inactive" });
      if (url.pathname.endsWith("/release")) {
        return response({ status: "ready", value: false });
      }
      return response({ status: "ready", value: "lease_lost" });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("session-token");
    const controller = new AbortController();
    const options = { signal: controller.signal };

    await client.discoverTaskContentBackfill(options);
    await client.claimTaskContentBackfill({ candidate, policyRevision: 7 }, options);
    await client.readTaskContentBackfillSource({ claimId: CLAIM }, options);
    await client.publishTaskContentBackfill({
      claimId: CLAIM,
      requestBytesBase64url: "AQ",
      payloadBytesBase64url: "Ag",
      manifestBytesBase64url: "Aw",
      envelopeBytesBase64url: "BA",
    }, options);
    await client.recoverTaskContentBackfill({ claimId: CLAIM }, options);
    await client.getTaskContentBackfillProgress(options);
    await client.releaseTaskContentBackfill({ claimId: CLAIM, advance: false }, options);
    await client.acknowledgeTaskContentBackfill({
      claimId: CLAIM,
      outcome: "waiting_parent",
    }, options);

    expect(requests.map(({ method, path }) => [method, path])).toEqual([
      ["POST", "/api/tasks/content/backfill/discover"],
      ["POST", "/api/tasks/content/backfill/claim"],
      ["POST", "/api/tasks/content/backfill/source"],
      ["POST", "/api/tasks/content/backfill/publish"],
      ["POST", "/api/tasks/content/backfill/recover"],
      ["GET", "/api/tasks/content/backfill/progress"],
      ["POST", "/api/tasks/content/backfill/release"],
      ["POST", "/api/tasks/content/backfill/ack"],
    ]);
    expect(requests.every(({ authorization }) => authorization === "Bearer session-token"))
      .toBeTrue();
    expect(requests.every(({ signal }) => signal === controller.signal)).toBeTrue();
    expect(requests.map(({ body }) => body)).toEqual([
      {},
      { candidate, policyRevision: 7 },
      { claimId: CLAIM },
      {
        claimId: CLAIM,
        requestBytesBase64url: "AQ",
        payloadBytesBase64url: "Ag",
        manifestBytesBase64url: "Aw",
        envelopeBytesBase64url: "BA",
      },
      { claimId: CLAIM },
      null,
      { claimId: CLAIM, advance: false },
      { claimId: CLAIM, outcome: "waiting_parent" },
    ]);
  });

  test("rejects authority selectors and noncanonical wire bytes before transport", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => { calls += 1; return response({ status: "inactive" }); },
    });
    client.setToken("session-token");

    expect(client.claimTaskContentBackfill({
      candidate,
      policyRevision: 7,
      requesterUserId: "40000000-0000-4000-8000-000000000003",
    } as never)).rejects.toThrow();
    expect(client.publishTaskContentBackfill({
      claimId: CLAIM,
      requestBytesBase64url: "a===",
      payloadBytesBase64url: "Ag",
      manifestBytesBase64url: "Aw",
      envelopeBytesBase64url: "BA",
    })).rejects.toThrow();
    expect(calls).toBe(0);
  });
});
