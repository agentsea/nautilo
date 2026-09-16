import { afterEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("getThreadDetail", () => {
  test("uses the encoded canonical detail route and returns the typed snapshot", async () => {
    let seenUrl = "";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0]) => {
        seenUrl = typeof input === "string" ? input : (input as URL).toString();
        return new Response(
          JSON.stringify({
            parentRoomId: "parent",
            subthreadRoomId: "child/id",
            anchor: {
              id: "42",
              role: "user",
              content: "anchor",
              createdAt: "2026-07-22T00:00:00.000Z",
              replyCount: 2,
              lastReplyAt: "2026-07-22T00:01:00.000Z",
              summaryRevision: 3,
            },
            summary: {
              replyCount: 2,
              lastReplyAt: "2026-07-22T00:01:00.000Z",
              summaryRevision: 3,
            },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const result = await client.getThreadDetail("child/id");

    expect(seenUrl).toBe("http://127.0.0.1:9/api/rooms/child%2Fid/thread-detail");
    expect(result.summary).toEqual({
      replyCount: 2,
      lastReplyAt: "2026-07-22T00:01:00.000Z",
      summaryRevision: 3,
    });
  });

  test("lists subthreads through the encoded parent route", async () => {
    let seenUrl = "";
    let seenMethod = "";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seenUrl = typeof input === "string" ? input : (input as URL).toString();
        seenMethod = init?.method ?? "GET";
        return new Response(JSON.stringify({ subthreads: [{
          id: "child-1",
          parentRoomId: "parent/id",
          anchorMessageId: 42,
          label: "Thread",
          replyCount: 2,
          lastReplyAt: null,
          createdAt: "2026-07-22T00:00:00.000Z",
        }] }), { status: 200, headers: { "content-type": "application/json" } });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const result = await client.listSubthreads("parent/id");
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/rooms/parent%2Fid/subthreads");
    expect(result.subthreads[0]?.id).toBe("child-1");
  });

  test("creates a subthread through the encoded anchor route", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody = "";
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seenUrl = typeof input === "string" ? input : (input as URL).toString();
        seenMethod = init?.method ?? "GET";
        seenBody = typeof init?.body === "string" ? init.body : "";
        return new Response(JSON.stringify({ subthreadRoomId: "child-2" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const result = await client.createSubthread("parent/id", 42);
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/rooms/parent%2Fid/messages/42/subthreads");
    expect(JSON.parse(seenBody)).toEqual({});
    expect(result).toEqual({ subthreadRoomId: "child-2" });
  });
});
