import { describe, expect, test } from "bun:test";
import { NautiloApiClient, type NautiloApiFetch } from "../../src/client";

const ROOM = "11111111-1111-4111-8111-111111111111";

function clientFor(response: Response, visited: string[]) {
  const fetchImpl: NautiloApiFetch = async (target) => {
    visited.push(typeof target === "string" ? target : target instanceof URL ? target.href : target.url);
    return response;
  };
  const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
  client.setToken("test-token");
  return client;
}

describe("getRoomPresence", () => {
  test("requests one encoded Room snapshot and validates Human statuses", async () => {
    const visited: string[] = [];
    const client = clientFor(new Response(JSON.stringify({ members: [
      { actorId: "actor:one", status: "online" },
      { actorId: "actor:two", status: "idle" },
      { actorId: "actor:three", status: "offline" },
    ] }), { status: 200, headers: { "content-type": "application/json" } }), visited);
    const snapshot = await client.getRoomPresence(ROOM);
    expect(visited).toEqual([`https://nautilo.test/api/rooms/${ROOM}/presence`]);
    expect(snapshot.members.map((member) => member.status)).toEqual(["online", "idle", "offline"]);
  });

  test("older server 404 remains a failed read", async () => {
    const client = clientFor(new Response(JSON.stringify({ error: "Not found" }), {
      status: 404, headers: { "content-type": "application/json" },
    }), []);
    const error = await client.getRoomPresence(ROOM).then(() => null, (cause: unknown) => cause);
    expect(error).toBeInstanceOf(Error);
  });

  test("passes the poller's abort signal to the fetch", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | null | undefined;
    const fetchImpl: NautiloApiFetch = async (_target, init) => {
      observed = init?.signal;
      return new Response(JSON.stringify({ members: [] }), {
        status: 200, headers: { "content-type": "application/json" },
      });
    };
    const client = new NautiloApiClient("https://nautilo.test", { fetchImpl });
    client.setToken("test-token");
    await client.getRoomPresence(ROOM, { signal: controller.signal });
    expect(observed).toBe(controller.signal);
  });

  test("malformed snapshot cannot be treated as offline", async () => {
    for (const body of [{ members: [{ actorId: "actor:one", status: "away" }] }, { members: null }]) {
      const client = clientFor(new Response(JSON.stringify(body), {
        status: 200, headers: { "content-type": "application/json" },
      }), []);
      const error = await client.getRoomPresence(ROOM).then(() => null, (cause: unknown) => cause);
      expect(error).toBeInstanceOf(Error);
    }
  });
});
