import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";

const sha = "a".repeat(64);
const artifactTarget = {
  kind: "workspace_artifact" as const,
  artifactInternalId: "11111111-1111-4111-8111-111111111111",
  logicalPath: "notes/today.md",
};
const record = {
  lease: {
    leaseId: "lease-1",
    sessionId: "session-1",
    humanId: "human-1",
    identity: {
      kind: "workspace_artifact",
      artifactId: "11111111-1111-4111-8111-111111111111",
      logicalPath: "notes/today.md",
    },
    baseVersion: {
      identity: {
        kind: "workspace_artifact",
        artifactId: "11111111-1111-4111-8111-111111111111",
        logicalPath: "notes/today.md",
      },
      backendVersion: { kind: "artifact_revision", revision: 4 },
      sha256: sha,
    },
    generation: 0,
    state: "clean",
  },
  expiresAtMs: 1234,
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

function requestJson(init: RequestInit | undefined): unknown {
  if (typeof init?.body !== "string") throw new Error("expected JSON request body");
  return JSON.parse(init.body) as unknown;
}

async function expectApiFailure(promise: Promise<unknown>): Promise<void> {
  try {
    await promise;
    throw new Error("expected ApiError");
  } catch (error) {
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  }
}

describe("human-edit lease HTTP contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("register sends only candidate/editor fields and Workspace roomId query", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    globalThis.fetch = (async (input, init) => {
      seenUrl = requestUrl(input);
      seenInit = init;
      return response({ status: "ok", record });
    }) as typeof fetch;

    const client = new NautiloApiClient("http://server.test");
    client.setToken("token");
    const result = await client.registerHumanEditLease(
      { sessionId: "session-1", target: artifactTarget, state: "clean" },
      { roomId: "room/1" },
    );

    expect(result.status).toBe("ok");
    expect(seenUrl).toBe("http://server.test/api/document-mutations/human-edit-leases?roomId=room%2F1");
    expect(seenInit?.method).toBe("POST");
    expect(seenInit?.headers).toEqual({
      Authorization: "Bearer token",
      "Content-Type": "application/json",
    });
    expect(requestJson(seenInit)).toEqual({
      sessionId: "session-1",
      target: artifactTarget,
      state: "clean",
    });
  });

  test("update, renew, and release use exact paths/bodies with no authority fields", async () => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    globalThis.fetch = (async (input, init) => {
      seen.push({ url: requestUrl(input), init });
      return response({ status: "ok", record: { ...record, lease: { ...record.lease, generation: 1 } } });
    }) as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    client.setToken("token");

    await client.updateHumanEditLease(
      "lease /1",
      {
        sessionId: "session-1",
        target: artifactTarget,
        expectedGeneration: 0,
        state: "dirty",
        draftPatch: { kind: "anchored_text", oldString: "old", newString: "new" },
      },
      { roomId: "room/1" },
    );
    await client.renewHumanEditLease(
      "lease /1",
      { sessionId: "session-1", target: artifactTarget, expectedGeneration: 1 },
      { roomId: "room/1" },
    );
    await client.releaseHumanEditLease("lease /1", { sessionId: "session-1", expectedGeneration: 1 });

    expect(seen.map(({ url, init }) => ({ url, method: init?.method, body: requestJson(init) }))).toEqual([
      {
        url: "http://server.test/api/document-mutations/human-edit-leases/lease%20%2F1?roomId=room%2F1",
        method: "PATCH",
        body: {
          sessionId: "session-1",
          target: artifactTarget,
          expectedGeneration: 0,
          state: "dirty",
          draftPatch: { kind: "anchored_text", oldString: "old", newString: "new" },
        },
      },
      {
        url: "http://server.test/api/document-mutations/human-edit-leases/lease%20%2F1/renew?roomId=room%2F1",
        method: "POST",
        body: { sessionId: "session-1", target: artifactTarget, expectedGeneration: 1 },
      },
      {
        url: "http://server.test/api/document-mutations/human-edit-leases/lease%20%2F1/release",
        method: "POST",
        body: { sessionId: "session-1", expectedGeneration: 1 },
      },
    ]);
  });

  test("malformed success response is an ApiError, not an unchecked cast", async () => {
    globalThis.fetch = (async () => response({ status: "ok", record: { nope: true } })) as unknown as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    try {
      await client.registerHumanEditLease({ sessionId: "session-1", target: artifactTarget, state: "clean" });
      throw new Error("expected malformed response rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
    }
  });

  test("returns typed not_found and stale_generation outcomes from 404 and 409", async () => {
    let count = 0;
    globalThis.fetch = (async () => {
      count += 1;
      return count === 1
        ? response({ status: "not_found" }, 404)
        : response({ status: "stale_generation", record }, 409);
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient("http://server.test");

    const missing = await client.renewHumanEditLease("lease-1", {
      sessionId: "session-1",
      target: artifactTarget,
      expectedGeneration: 0,
    });
    const stale = await client.updateHumanEditLease("lease-1", {
      sessionId: "session-1",
      target: artifactTarget,
      expectedGeneration: 0,
      state: "clean",
    });

    expect(missing).toEqual({ status: "not_found" });
    expect(stale.status).toBe("stale_generation");
    if (stale.status !== "stale_generation") throw new Error("expected stale outcome");
    expect(stale.record.lease.leaseId).toBe("lease-1");
    expect(stale.record.lease.generation).toBe(0);
  });

  test("malformed 409 outcome is an ApiError", async () => {
    globalThis.fetch = (async () => response({ status: "stale_generation" }, 409)) as unknown as typeof fetch;
    const client = new NautiloApiClient("http://server.test");
    try {
      await client.renewHumanEditLease("lease-1", {
        sessionId: "session-1",
        target: artifactTarget,
        expectedGeneration: 0,
      });
      throw new Error("expected malformed response rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
    }
  });

  test("rejects Zod-valid lease outcomes paired with the wrong HTTP status", async () => {
    const responses = [
      response({ status: "ok", record }, 404),
      response({ status: "stale_generation", record }, 200),
      response({ status: "not_found" }, 409),
    ];
    globalThis.fetch = (async () => {
      const next = responses.shift();
      if (!next) throw new Error("unexpected fetch");
      return next;
    }) as unknown as typeof fetch;
    const client = new NautiloApiClient("http://server.test");

    await expectApiFailure(
      client.registerHumanEditLease({ sessionId: "session-1", target: artifactTarget, state: "clean" }),
    );
    await expectApiFailure(
      client.updateHumanEditLease("lease-1", {
        sessionId: "session-1",
        target: artifactTarget,
        expectedGeneration: 0,
        state: "clean",
      }),
    );
    await expectApiFailure(
      client.renewHumanEditLease("lease-1", {
        sessionId: "session-1",
        target: artifactTarget,
        expectedGeneration: 0,
      }),
    );
  });
});
