import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { NautiloApiClient } from "../../src/client";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";
const coordinate = {
  originalJobId: "job-1",
  checkpointId: "checkpoint-1",
  turnId: "turn-1",
  toolCallId: "tool-1",
  agentId: "agent-1",
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function caughtFrom(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected request to reject");
}

describe("ordinary content access recovery API", () => {
  let realFetch: typeof fetch;

  beforeEach(() => { realFetch = globalThis.fetch; });
  afterEach(() => { globalThis.fetch = realFetch; });

  test("discovers opaque coordinates and submits the exact selected coordinate", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const responses = [
      jsonResponse({ recoveries: [coordinate] }),
      jsonResponse({ outcome: "completed" }),
    ];
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      requests.push({
        url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        ...(init === undefined ? {} : { init }),
      });
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const discovered = await client.discoverOrdinaryContentAccessRecoveries({ roomId: ROOM_ID });
    expect(discovered.recoveries).toEqual([coordinate]);
    expect(await client.recoverOrdinaryContentAccess(discovered.recoveries[0]!, {
      roomId: ROOM_ID,
    })).toEqual({ outcome: "completed" });

    expect(requests.map(({ url, init }) => ({
      url,
      method: init?.method,
      body: typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined,
    }))).toEqual([
      {
        url: `http://127.0.0.1:9/api/rooms/${ROOM_ID}/content-access-recovery`,
        method: "GET",
        body: undefined,
      },
      {
        url: `http://127.0.0.1:9/api/rooms/${ROOM_ID}/content-access-recovery`,
        method: "POST",
        body: coordinate,
      },
    ]);
  });

  test("accepts only the four truthful lifecycle outcomes", async () => {
    const outcomes: Array<"completed" | "busy" | "unavailable" | "retry_required"> =
      ["completed", "busy", "unavailable", "retry_required"];
    globalThis.fetch = Object.assign(async () => {
      const outcome = outcomes.shift();
      if (!outcome) return jsonResponse({ outcome: "accepted" });
      return jsonResponse({ outcome });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");

    for (const outcome of ["completed", "busy", "unavailable", "retry_required"] as const) {
      expect(await client.recoverOrdinaryContentAccess(coordinate, {
        roomId: ROOM_ID,
      })).toEqual({ outcome });
    }
    expect(await caughtFrom(client.recoverOrdinaryContentAccess(coordinate, {
      roomId: ROOM_ID,
    }))).toBeDefined();
  });

  test("rejects hidden recovery metadata in either response or request", async () => {
    const client = new NautiloApiClient("http://127.0.0.1:9");
    globalThis.fetch = Object.assign(
      async () => jsonResponse({ recoveries: [{ ...coordinate, graphThreadId: "hidden" }] }),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    expect(await caughtFrom(client.discoverOrdinaryContentAccessRecoveries({
      roomId: ROOM_ID,
    }))).toBeDefined();

    expect(await caughtFrom(client.recoverOrdinaryContentAccess({
      ...coordinate,
      graphThreadId: "not-allowed",
    } as typeof coordinate, { roomId: ROOM_ID }))).toBeDefined();
  });

  test("forwards AbortSignal for discovery and recovery", async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    globalThis.fetch = Object.assign(async (
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      signals.push(init?.signal);
      return jsonResponse(init?.method === "GET"
        ? { recoveries: [coordinate] }
        : { outcome: "busy" });
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const controller = new AbortController();

    await client.discoverOrdinaryContentAccessRecoveries({
      roomId: ROOM_ID,
      signal: controller.signal,
    });
    await client.recoverOrdinaryContentAccess(coordinate, {
      roomId: ROOM_ID,
      signal: controller.signal,
    });
    expect(signals).toEqual([controller.signal, controller.signal]);
  });

  test("traverses every bounded recovery page and rejects cursor cycles", async () => {
    const second = { ...coordinate, originalJobId: "job-2", toolCallId: "tool-2" };
    const urls: string[] = [];
    const signals: Array<AbortSignal | null | undefined> = [];
    const responses = [
      jsonResponse({ recoveries: [coordinate], nextCursor: "opaque page" }),
      jsonResponse({ recoveries: [second], nextCursor: null }),
    ];
    globalThis.fetch = Object.assign(async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      urls.push(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      signals.push(init?.signal);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected request");
      return response;
    }, { preconnect: realFetch.preconnect.bind(realFetch) }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    const controller = new AbortController();
    expect(await client.discoverAllOrdinaryContentAccessRecoveries({
      roomId: ROOM_ID,
      signal: controller.signal,
    }))
      .toEqual([coordinate, second]);
    expect(urls).toEqual([
      `http://127.0.0.1:9/api/rooms/${ROOM_ID}/content-access-recovery`,
      `http://127.0.0.1:9/api/rooms/${ROOM_ID}/content-access-recovery?cursor=opaque+page`,
    ]);
    expect(signals).toEqual([controller.signal, controller.signal]);

    globalThis.fetch = Object.assign(
      async () => jsonResponse({ recoveries: [], nextCursor: "cycle" }),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    expect(await caughtFrom(client.discoverAllOrdinaryContentAccessRecoveries({ roomId: ROOM_ID })))
      .toBeDefined();
  });
});
