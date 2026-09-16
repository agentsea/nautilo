import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

describe("Codex request HTTP contract", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("scopes first-time Connections to the exact current Desktop relay", async () => {
    let seenRelayId: string | null = null;
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenRelayId = new Headers(init?.headers).get("x-nautilo-codex-relay-id");
      return new Response(JSON.stringify({
        runtime: {
          state: "absent",
          available: false,
          runtimeGeneration: null,
          collaborationModeAvailable: false,
        },
        profiles: [],
      }), { status: 200, headers: { "content-type": "application/json" } });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    await client.codex.summary("relay-current");
    expect(String(seenRelayId)).toBe("relay-current");
  });

  test("respondRequest derives request identity from the URL and sends only semantic response data", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON request body");
      }
      seenBody = init?.body === undefined ? undefined : JSON.parse(init.body);
      return new Response(JSON.stringify({ requestId: "request-ref" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await client.codex.respondRequest("request-ref", {
      kind: "permissions_approval_required",
      grants: { network: true, fileSystem: false },
      scope: "turn",
    });

    expect(seenUrl).toBe("http://127.0.0.1:9/api/codex/requests/request-ref/respond");
    expect(seenBody).toEqual({
      kind: "permissions_approval_required",
      grants: { network: true, fileSystem: false },
      scope: "turn",
    });
    expect(result).toEqual({ requestId: "request-ref" });
  });

  test("respondRequest serializes live permission selections", async () => {
    const seenBodies: unknown[] = [];
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (init?.body !== undefined && typeof init.body !== "string") {
        throw new Error("expected JSON request body");
      }
      seenBodies.push(init?.body === undefined ? undefined : JSON.parse(init.body));
      return new Response(JSON.stringify({ requestId: "request-ref" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    await client.codex.respondRequest("request-ref", {
      kind: "permission_selection_required",
      outcome: { kind: "selected", optionId: "allow_once" },
    });
    await client.codex.respondRequest("request-ref", {
      kind: "permission_selection_required",
      outcome: { kind: "cancelled" },
    });

    expect(seenBodies).toEqual([
      { kind: "permission_selection_required", outcome: { kind: "selected", optionId: "allow_once" } },
      { kind: "permission_selection_required", outcome: { kind: "cancelled" } },
    ]);
  });

  test("listUserInputRequests encodes the Room path and rejects malformed recovery DTOs", async () => {
    let seenUrl = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0]) => {
      seenUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      return new Response(JSON.stringify({ roomId: "room opaque/id", items: [{ availability: "actionable" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    let rejected = false;
    try {
      await client.codex.listUserInputRequests("room opaque/id");
    } catch {
      rejected = true;
    }
    expect(rejected).toBe(true);
    expect(seenUrl).toBe("http://127.0.0.1:9/api/codex/rooms/room%20opaque%2Fid/requests");
  });

  test("listUserInputRequests bypasses generic GET single-flight for independently fenced recovery reads", async () => {
    let calls = 0;
    const resolvers: Array<(response: Response) => void> = [];
    const mockFetch = async () => new Promise<Response>((resolve) => {
      calls += 1;
      resolvers.push(resolve);
    });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const first = client.codex.listUserInputRequests("room-a");
    const second = client.codex.listUserInputRequests("room-a");
    expect(calls).toBe(2);
    const body = {
      roomId: "room-a",
      items: [],
    };
    resolvers[0]?.(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    resolvers[1]?.(new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } }));
    expect(await Promise.all([first, second])).toEqual([body, body]);
  });

  test("removeProfile sends only its opaque id and optimistic revision", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      seenMethod = init?.method ?? "GET";
      if (init?.body === undefined) {
        seenBody = undefined;
      } else if (typeof init.body === "string") {
        seenBody = JSON.parse(init.body);
      } else {
        throw new Error("expected JSON request body");
      }
      return new Response(null, { status: 204 });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    const result = await client.codex.removeProfile("profile opaque/id", 7);

    expect(result).toBeUndefined();
    expect(seenUrl).toBe("http://127.0.0.1:9/api/codex/profiles/profile%20opaque%2Fid");
    expect(seenMethod).toBe("DELETE");
    expect(seenBody).toEqual({ expectedRevision: 7 });
  });
});
