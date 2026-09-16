import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("admin room recovery HTTP contract (mocked fetch)", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("ownedSharedRooms — GET, parses rooms + eligible owners", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const payload = {
      rooms: [
        {
          roomId: "room-1",
          label: "Household Ops",
          eligibleNewOwners: [
            { userId: "u2", handle: "casey", displayName: "Casey", federated: false },
          ],
        },
      ],
    };
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.users.ownedSharedRooms("u1");
    expect(seenMethod).toBe("GET");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/users/u1/owned-shared-rooms");
    expect(out.rooms[0]?.eligibleNewOwners[0]?.userId).toBe("u2");
  });

  test("transferOwner — POST with newOwnerUserId body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    let seenBody: unknown = null;
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      seenBody = init?.body ? JSON.parse(init.body as string) : null;
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.rooms.transferOwner("room-1", "u2");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/rooms/room-1/transfer-owner");
    expect(seenBody).toEqual({ newOwnerUserId: "u2" });
    expect(out.ok).toBe(true);
  });

  test("archive — POST with empty body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.rooms.archive("room-1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/rooms/room-1/archive");
    expect(out.ok).toBe(true);
  });

  test("unarchive — POST with empty body", async () => {
    let seenUrl = "";
    let seenMethod = "";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      seenMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.admin.rooms.unarchive("room-1");
    expect(seenMethod).toBe("POST");
    expect(seenUrl).toBe("http://127.0.0.1:9/api/admin/rooms/room-1/unarchive");
    expect(out.ok).toBe(true);
  });
});
