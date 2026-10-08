import { describe, expect, test } from "bun:test";
import { NautiloApiClient, whoamiResponseSchema, type NautiloApiFetch } from "../../src/client";

const ROOM_ID = "11111111-1111-4111-8111-111111111111";

function recordingClient() {
  const requests: Array<{ path: string; method: string; body: unknown }> = [];
  const fetchImpl: NautiloApiFetch = async (target, init) => {
    const url = typeof target === "string" ? target : target instanceof URL ? target.href : target.url;
    requests.push({
      path: new URL(url).pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return Response.json({ ok: true });
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("test-token");
  return { client, requests };
}

describe("room discoverability requests", () => {
  test("server support must be explicitly advertised, including after parsing whoami", () => {
    const identity = {
      sessionUserId: null,
      sessionActorId: null,
      userIdentity: null,
      handle: null,
      displayName: null,
      externalId: null,
      instanceId: "test",
      mustChangePassword: false,
    };
    expect(whoamiResponseSchema.parse(identity).features.roomDiscoverability).toBeUndefined();
    expect(whoamiResponseSchema.parse({
      ...identity,
      features: { roomDiscoverability: true },
    }).features.roomDiscoverability).toBe(true);
  });

  test("external room creation keeps the public kind and explicitly disables discovery", async () => {
    const { client, requests } = recordingClient();
    await client.createRoom({ label: "External collaboration", kind: "open", discoverable: false });
    expect(requests).toEqual([{
      path: "/api/rooms",
      method: "POST",
      body: { label: "External collaboration", kind: "open", discoverable: false },
    }]);
  });

  test("listing changes travel through the existing visibility endpoint", async () => {
    const { client, requests } = recordingClient();
    await client.setRoomVisibility(ROOM_ID, true, false);
    await client.setRoomVisibility(ROOM_ID, true, true);
    expect(requests.map((request) => request.body)).toEqual([
      { public: true, discoverable: false },
      { public: true, discoverable: true },
    ]);
    expect(requests.every((request) => request.path === `/api/rooms/${ROOM_ID}/visibility`
      && request.method === "POST")).toBe(true);
  });

  test("legacy visibility calls omit the flag so the server preserves the saved preference", async () => {
    const { client, requests } = recordingClient();
    await client.setRoomVisibility(ROOM_ID, false);
    await client.setRoomVisibility(ROOM_ID, true);
    expect(requests.map((request) => request.body)).toEqual([
      { public: false },
      { public: true },
    ]);
  });
});
