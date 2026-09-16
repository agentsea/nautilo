import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NautiloApiClient } from "../../src/client";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function readHeader(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

function whoamiBody() {
  return {
    sessionUserId: "user-1",
    sessionActorId: "actor-1",
    userIdentity: "id:user-1",
    handle: "alice",
    displayName: "Alice",
    externalId: "sub-1",
    instanceId: "instance-1",
    mustChangePassword: false,
    groups: [],
    capabilities: [],
    features: { office: { enabled: true } },
    highestRole: "member",
  };
}

describe("M214 conditional reads", () => {
  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("whoami, app list, and artifact list send validators and expose response ETags", async () => {
    const calls: Array<{
      url: string;
      ifNoneMatch: string | null;
      cache: RequestInit["cache"];
    }> = [];
    globalThis.fetch = Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        const url = requestUrl(input);
        calls.push({
          url,
          ifNoneMatch: readHeader(init, "If-None-Match"),
          cache: init?.cache,
        });
        if (url.endsWith("/api/auth/whoami")) {
          return new Response(JSON.stringify(whoamiBody()), {
            status: 200,
            headers: { "content-type": "application/json", etag: 'W/"who-v2"' },
          });
        }
        if (url.endsWith("/api/apps")) {
          return new Response(JSON.stringify({ apps: [] }), {
            status: 200,
            headers: { "content-type": "application/json", etag: 'W/"apps-v2"' },
          });
        }
        return new Response(JSON.stringify({ artifacts: [] }), {
          status: 200,
          headers: { "content-type": "application/json", etag: 'W/"artifacts-v2"' },
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token-a");
    const whoami = await client.whoamiConditional({ ifNoneMatch: 'W/"who-v1"' });
    const apps = await client.listMiniAppsConditional({ ifNoneMatch: 'W/"apps-v1"' });
    const artifacts = await client.listWorkspaceArtifactsConditional({
      roomId: "room-1",
      ifNoneMatch: 'W/"artifacts-v1"',
    });

    expect(whoami).toMatchObject({ status: 200, etag: 'W/"who-v2"' });
    expect(apps).toEqual({ status: 200, body: { apps: [] }, etag: 'W/"apps-v2"' });
    expect(artifacts).toEqual({
      status: 200,
      body: { artifacts: [] },
      etag: 'W/"artifacts-v2"',
    });
    expect(calls).toEqual([
      {
        url: "http://127.0.0.1:9/api/auth/whoami",
        ifNoneMatch: 'W/"who-v1"',
        cache: "no-store",
      },
      {
        url: "http://127.0.0.1:9/api/apps",
        ifNoneMatch: 'W/"apps-v1"',
        cache: "no-store",
      },
      {
        url: "http://127.0.0.1:9/api/workspace/artifacts?roomId=room-1",
        ifNoneMatch: 'W/"artifacts-v1"',
        cache: "no-store",
      },
    ]);
  });

  test("304 is returned as a typed not-modified result without parsing a body", async () => {
    globalThis.fetch = Object.assign(
      async () =>
        new Response(null, {
          status: 304,
          headers: { etag: 'W/"same"' },
        }),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token-a");

    expect(
      await client.whoamiConditional({ ifNoneMatch: 'W/"same"' }),
    ).toEqual({ status: 304, etag: 'W/"same"' });
    expect(
      await client.listMiniAppsConditional({ ifNoneMatch: 'W/"same"' }),
    ).toEqual({ status: 304, etag: 'W/"same"' });
    expect(
      await client.listWorkspaceArtifactsConditional({
        roomId: "room-1",
        ifNoneMatch: 'W/"same"',
      }),
    ).toEqual({ status: 304, etag: 'W/"same"' });
  });

  test("conditional single-flight separates validators and credential generations", async () => {
    let fetchCount = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    globalThis.fetch = Object.assign(
      async () => {
        fetchCount += 1;
        await gate;
        return new Response(null, { status: 304, headers: { etag: 'W/"same"' } });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("token-a");
    const sameA = client.listMiniAppsConditional({ ifNoneMatch: 'W/"a"' });
    const sameB = client.listMiniAppsConditional({ ifNoneMatch: 'W/"a"' });
    const differentValidator = client.listMiniAppsConditional({ ifNoneMatch: 'W/"b"' });
    client.setToken("token-b");
    const differentCredential = client.listMiniAppsConditional({ ifNoneMatch: 'W/"a"' });

    expect(fetchCount).toBe(3);
    expect(client.getInFlightGetCount()).toBe(3);
    release();
    await Promise.all([sameA, sameB, differentValidator, differentCredential]);
    expect(fetchCount).toBe(3);
  });

  test("legacy whoami keeps 401 guest fallback and 5xx propagation", async () => {
    let status = 401;
    globalThis.fetch = Object.assign(
      async () =>
        new Response(JSON.stringify({ error: "unavailable" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    expect((await client.whoami()).sessionUserId).toBeNull();

    status = 503;
    let error: unknown;
    try {
      await client.whoami();
    } catch (caught) {
      error = caught;
    }
    expect(error).toMatchObject({ status: 503 });
  });

  test("an expired JWT guest response stays transient until Logto refreshes", async () => {
    const now = 1_800_000_000_000;
    const payload = btoa(JSON.stringify({ exp: now / 1_000 }));
    const expiredToken = `header.${payload}.signature`;
    const authorizations: Array<string | null> = [];
    globalThis.fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
        authorizations.push(readHeader(init, "Authorization"));
        return Response.json({
          ...whoamiBody(),
          sessionUserId: null,
          sessionActorId: null,
          highestRole: null,
        });
      },
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const realDateNow = Date.now;
    Date.now = () => now;
    try {
      const client = new NautiloApiClient("http://127.0.0.1:9");
      client.setToken(expiredToken);

      const error = await client.whoami().catch((cause: unknown) => cause);

      expect(error).toMatchObject({
        status: 401,
        message: "GET /api/auth/whoami rejected an expired session bearer",
      });
      expect(authorizations).toEqual([`Bearer ${expiredToken}`]);
      expect(client.getToken()).toBe(expiredToken);
    } finally {
      Date.now = realDateNow;
    }
  });

  test("an opaque stale bearer keeps the existing guest recovery contract", async () => {
    globalThis.fetch = Object.assign(
      async () => Response.json({
        ...whoamiBody(),
        sessionUserId: null,
        sessionActorId: null,
        highestRole: null,
      }),
      { preconnect: realFetch.preconnect.bind(realFetch) },
    ) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("stale-opaque-bearer");

    expect((await client.whoami()).sessionUserId).toBeNull();
  });
});
