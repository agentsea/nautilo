/**
 * M322 — frozen Mobile sharing compatibility.
 *
 * These are transport characterizations for the api-client methods bundled
 * into the release-frozen Mobile application. They intentionally exercise
 * mocked fetch only: no server, database, or rebuilt Mobile application is
 * involved.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ApiError, NautiloApiClient } from "../../src/client";

type CapturedRequest = {
  url: string;
  method: string;
  body: unknown;
  authorization: string | null;
};

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

function header(init: RequestInit | undefined, name: string): string | null {
  const headers = new Headers(init?.headers);
  return headers.get(name);
}

function parsedBody(init: RequestInit | undefined): unknown {
  return typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
}

describe("M322 frozen Mobile sharing api-client contract", () => {
  let realFetch: typeof fetch;
  let requests: CapturedRequest[];
  let responses: Array<{ status: number; body: unknown }>;

  beforeEach(() => {
    realFetch = globalThis.fetch;
    requests = [];
    responses = [];
    const mockedFetch = async (
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ): Promise<Response> => {
      requests.push({
        url: requestUrl(input),
        method: init?.method ?? "GET",
        body: parsedBody(init),
        authorization: header(init, "authorization"),
      });
      const response = responses.shift();
      if (!response) throw new Error("Missing mocked response");
      return Response.json(response.body, { status: response.status });
    };
    globalThis.fetch = Object.assign(mockedFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function client(): NautiloApiClient {
    const value = new NautiloApiClient("http://127.0.0.1:9");
    value.setToken("frozen-mobile-token");
    return value;
  }

  test("getMemory preserves the flat access list and action-authority envelope", async () => {
    const memoryId = "memory/id with space";
    const detail = {
      memory: {
        id: memoryId,
        type: "fact",
        content: "A shared fact",
        importance: 0.7,
        tier: 1,
        createdAt: "2026-09-01T10:00:00.000Z",
        updatedAt: "2026-09-02T10:00:00.000Z",
        namespaceIds: ["ns-original", "ns-access"],
        demotedAt: null,
        demotedFrom: null,
        accessList: [
          { displayName: "Alex", userHandle: "alex" },
          { displayName: "Casey", userHandle: "casey" },
        ],
      },
      memoryMode: "namespace" as const,
      actionAuthority: {
        canEdit: true,
        canArchive: true,
        canHardDelete: false,
        canManageAccess: true,
      },
    };
    responses.push({ status: 200, body: detail });

    expect(await client().getMemory(memoryId)).toEqual(detail);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:9/api/memory/memory%2Fid%20with%20space",
        method: "GET",
        body: undefined,
        authorization: "Bearer frozen-mobile-token",
      },
    ]);
  });

  test("listWorkspaceArtifacts remains one request and does not consume an additive cursor", async () => {
    const response = {
      artifacts: [
        {
          id: "artifact-one",
          artifactId: "public-artifact-one",
          path: "projects/one.md",
          mimeType: "text/markdown",
          size: 42,
          revision: 3,
          updatedAt: "2026-09-02T10:00:00.000Z",
          createdAt: "2026-09-01T10:00:00.000Z",
          namespaceIds: ["ns-room"],
          canWrite: true,
        },
      ],
      nextCursor: "server-added-cursor",
    };
    responses.push({ status: 200, body: response });

    const result = await client().listWorkspaceArtifacts({ roomId: "room/one" });

    expect(result.artifacts).toEqual(response.artifacts);
    expect(result as unknown).toEqual(response);
    expect(requests).toEqual([
      {
        url: "http://127.0.0.1:9/api/workspace/artifacts?roomId=room%2Fone",
        method: "GET",
        body: undefined,
        authorization: "Bearer frozen-mobile-token",
      },
    ]);
  });

  test("Memory grant keeps the legacy one-target bodies and consumed result fields", async () => {
    responses.push(
      {
        status: 200,
        body: { status: "granted", roomLabel: "Alex + Casey", minted: true },
      },
      {
        status: 200,
        body: { status: "granted", namespaceId: "ns-target-room" },
      },
    );
    const api = client();

    expect(
      await api.grantMemory("memory/one", { userHandle: "casey" }),
    ).toEqual({
      status: "granted",
      roomLabel: "Alex + Casey",
      minted: true,
    });
    expect(
      await api.grantMemory("memory/one", { roomId: "room-target" }),
    ).toEqual({ status: "granted", namespaceId: "ns-target-room" });

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "http://127.0.0.1:9/api/memory/memory%2Fone/grant",
        method: "POST",
        body: { user_handle: "casey" },
      },
      {
        url: "http://127.0.0.1:9/api/memory/memory%2Fone/grant",
        method: "POST",
        body: { room_id: "room-target" },
      },
    ]);
  });

  test("Memory revoke and make-private preserve partial-outcome accounting", async () => {
    responses.push(
      {
        status: 200,
        body: {
          status: "revoked",
          reHomed: 2,
          skipped: ["ns-unmodifiable", "ns-room-owned"],
        },
      },
      {
        status: 200,
        body: { status: "private", skipped: ["ns-unmodifiable"] },
      },
    );
    const api = client();

    expect(await api.revokeMemory("memory/one", "casey")).toEqual({
      status: "revoked",
      reHomed: 2,
      skipped: ["ns-unmodifiable", "ns-room-owned"],
    });
    expect(await api.makeMemoryPrivate("memory/one")).toEqual({
      status: "private",
      skipped: ["ns-unmodifiable"],
    });

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "http://127.0.0.1:9/api/memory/memory%2Fone/revoke",
        method: "POST",
        body: { user_handle: "casey" },
      },
      {
        url: "http://127.0.0.1:9/api/memory/memory%2Fone/make_private",
        method: "POST",
        body: {},
      },
    ]);
  });

  test("Artifact share sends one recipient plus optional source Room and preserves both success statuses", async () => {
    responses.push(
      { status: 200, body: { status: "shared" } },
      { status: 200, body: { status: "already_shared" } },
    );
    const api = client();

    expect(
      await api.shareWorkspaceArtifact("artifact/one", "person-one", {
        roomId: "source room/one",
      }),
    ).toEqual({ status: "shared" });
    expect(
      await api.shareWorkspaceArtifact("artifact/one", "person-two"),
    ).toEqual({ status: "already_shared" });

    expect(requests.map(({ url, method, body }) => ({ url, method, body }))).toEqual([
      {
        url: "http://127.0.0.1:9/api/workspace/artifacts/artifact%2Fone/share?roomId=source%20room%2Fone",
        method: "POST",
        body: { recipientUserId: "person-one" },
      },
      {
        url: "http://127.0.0.1:9/api/workspace/artifacts/artifact%2Fone/share",
        method: "POST",
        body: { recipientUserId: "person-two" },
      },
    ]);
  });

  test("legacy calls require no plan token, operation id, or new audience field", async () => {
    responses.push(
      { status: 200, body: { status: "granted", roomLabel: "A + C", minted: false } },
      { status: 200, body: { status: "shared" } },
    );
    const api = client();
    await api.grantMemory("memory", { userHandle: "c" });
    await api.shareWorkspaceArtifact("artifact", "person-c", { roomId: "room-a-b" });

    expect(Object.keys(requests[0]?.body as object)).toEqual(["user_handle"]);
    expect(Object.keys(requests[1]?.body as object)).toEqual(["recipientUserId"]);
    expect(requests[0]?.url).not.toContain("roomId=");
  });

  test("non-2xx detail, mutation, and Artifact outcomes remain rejected", async () => {
    const calls: Array<() => Promise<unknown>> = [];
    const api = client();
    responses.push(
      { status: 404, body: { error: "Memory not found" } },
      { status: 403, body: { error: "Memory not readable in this context" } },
      { status: 409, body: { error: "No private namespace to re-home into" } },
      { status: 403, body: { error: "manage_memories capability required" } },
      { status: 409, body: { error: "Sharing is pending; retry later" } },
    );
    calls.push(
      () => api.getMemory("memory"),
      () => api.grantMemory("memory", { userHandle: "casey" }),
      () => api.revokeMemory("memory", "casey"),
      () => api.makeMemoryPrivate("memory"),
      () => api.shareWorkspaceArtifact("artifact", "person-c"),
    );

    const errors: ApiError[] = [];
    for (const call of calls) {
      try {
        await call();
        throw new Error("Expected request to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        errors.push(error as ApiError);
      }
    }
    expect(errors.map(({ status, message }) => ({ status, message }))).toEqual([
      { status: 404, message: "Memory not found" },
      { status: 403, message: "Memory not readable in this context" },
      { status: 409, message: "No private namespace to re-home into" },
      { status: 403, message: "manage_memories capability required" },
      { status: 409, message: "Sharing is pending; retry later" },
    ]);
  });

  test("a frozen Artifact client treats every 2xx body as resolved, so pending must not be 2xx", async () => {
    responses.push({ status: 202, body: { status: "pending" } });

    const result = await client().shareWorkspaceArtifact("artifact", "person-c");

    expect(result as unknown).toEqual({ status: "pending" });
  });
});
