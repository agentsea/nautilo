import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  NautiloApiClient,
  ApiError,
  StrictShadowProtectedContentRequiredError,
} from "../../src/client";
import { REMOTE_PAIRING_PROOF_ALGORITHM, type RemoteOrdinaryRequestProof } from "@nautilo/types";

function requestUrl(input: Parameters<typeof fetch>[0]): string {
  return typeof input === "string" ? input : (input as URL).toString();
}

describe("sendRoomMessage (D174 Phase 11.3)", () => {
  test("mints an Electron credential with the Relay bearer only on the mint request", async () => {
    const seen: Array<{ path: string; relayToken: string | null }> = [];
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seen.push({
        path: requestUrl(input),
        relayToken: new Headers(init?.headers).get("x-nautilo-relay-token"),
      });
      return new Response(
        JSON.stringify({ credential: "deo_one-use", expiresAt: new Date().toISOString() }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("session-token");
    await client.mintElectronOriginCredential({
      requestId: "550e8400-e29b-41d4-a716-446655440000",
      relayId: "relay-a",
      desktopSessionId: "660e8400-e29b-41d4-a716-446655440001",
      method: "POST",
      path: "/api/rooms/room/messages",
      bodySha256: "a".repeat(64),
    }, "rty_secret");
    expect(seen).toEqual([{
      path: "http://127.0.0.1:9/api/relay/electron-origin-credential",
      relayToken: "rty_secret",
    }]);
  });

  let realFetch: typeof fetch;

  beforeEach(() => {
    realFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("POST /api/rooms/:roomId/messages — URL, body uses content (no roomId/message)", async () => {
    let seenUrl = "";
    let bodyText = "";
    const roomId = "550e8400-e29b-41d4-a716-446655440000";
    const mockFetch = async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenUrl = requestUrl(input);
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          messageId: 42,
          jobId: "job-abc",
          accepted: true,
          attachments: [],
          coalesced: false,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.sendRoomMessage(roomId, {
      content: "hello room",
      mentionedHumanUserIds: [
        "11111111-1111-4111-8111-111111111111",
      ],
      laneKey: "app:default",
      voiceMode: true,
      autoApprove: true,
      clientActionSessionId: "A1b2C3d4E5f6G7h8I9j0K_",
    });

    expect(seenUrl).toBe(
      `http://127.0.0.1:9/api/rooms/${encodeURIComponent(roomId)}/messages`,
    );
    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed["content"]).toBe("hello room");
    expect(parsed["mentionedHumanUserIds"]).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
    expect(parsed["message"]).toBeUndefined();
    expect(parsed["roomId"]).toBeUndefined();
    expect(parsed["clientActionSessionId"]).toBe("A1b2C3d4E5f6G7h8I9j0K_");
    expect(parsed["autoApprove"]).toBe(true);
    expect(out.messageId).toBe(42);
    expect(out.jobId).toBe("job-abc");
    expect(out.accepted).toBe(true);
    expect(out.coalesced).toBe(false);
    expect(Array.isArray(out.attachments)).toBe(true);
  });

  test("forwards the selected ephemeral Auto-Approve posture unchanged", async () => {
    const seen: boolean[] = [];
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as { autoApprove?: boolean } : {};
      seen.push(body.autoApprove ?? false);
      return new Response(
        JSON.stringify({ messageId: 42, jobId: "job-abc", accepted: true, attachments: [], coalesced: false }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.sendRoomMessage("550e8400-e29b-41d4-a716-446655440000", {
      content: "enabled",
      autoApprove: true,
    });
    await client.sendRoomMessage("550e8400-e29b-41d4-a716-446655440000", {
      content: "disabled",
      autoApprove: false,
    });

    expect(seen).toEqual([true, false]);
  });

  test("adds paired-mobile proof only when the caller supplies verified-origin material", async () => {
    const seenHeaders: Array<string | null> = [];
    const electronHeaders: Array<string | null> = [];
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      seenHeaders.push(new Headers(init?.headers).get("x-nautilo-mobile-origin"));
      electronHeaders.push(new Headers(init?.headers).get("x-nautilo-electron-origin"));
      return new Response(
        JSON.stringify({
          messageId: 42,
          jobId: "job-abc",
          accepted: true,
          attachments: [],
          coalesced: false,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const proof: RemoteOrdinaryRequestProof = {
      algorithm: REMOTE_PAIRING_PROOF_ALGORITHM,
      serverInstanceId: "550e8400-e29b-41d4-a716-446655440000",
      serverBindingGeneration: 1,
      controllerInstallationId: "660e8400-e29b-41d4-a716-446655440001",
      installationId: "770e8400-e29b-41d4-a716-446655440002",
      installationGeneration: 1,
      requestId: "880e8400-e29b-41d4-a716-446655440003",
      issuedAtMs: 1_800_000_000_000,
      method: "POST",
      path: "/api/rooms/room/messages",
      bodySha256: "a".repeat(64),
      signature: "b".repeat(128),
    };
    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const body = { content: "same exact body" };

    await client.sendRoomMessage("room", body);
    await client.sendRoomMessage("room", body, { mobileOriginProof: proof });
    await client.sendRoomMessage("room", body, { electronOriginCredential: "deo_one-use" });

    expect(seenHeaders).toEqual([null, JSON.stringify(proof), null]);
    expect(electronHeaders).toEqual([null, null, "deo_one-use"]);
  });

  test("forwards activeMiniApp in request body", async () => {
    let bodyText = "";
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          messageId: 1,
          jobId: "job-1",
          accepted: true,
          attachments: [],
          coalesced: false,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.sendRoomMessage("550e8400-e29b-41d4-a716-446655440000", {
      content: "hello",
      activeMiniApp: {
        appId: "sample-app",
        appName: "Sample App",
        mode: "preview",
        documentPath: "budget.document.json",
        targetKind: "artifact",
        updatedAt: 1,
      },
    });

    const parsed = JSON.parse(bodyText) as Record<string, unknown>;
    expect(parsed["activeMiniApp"]).toEqual({
      appId: "sample-app",
      appName: "Sample App",
      mode: "preview",
      documentPath: "budget.document.json",
      targetKind: "artifact",
      updatedAt: 1,
    });
  });

  test("forwards the explicit sender-bound current-folder relay id", async () => {
    let bodyText = "";
    const mockFetch = async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      bodyText = typeof init?.body === "string" ? init.body : "";
      return new Response(
        JSON.stringify({
          messageId: 1,
          jobId: "job-1",
          accepted: true,
          attachments: [],
          coalesced: false,
        }),
        { status: 202, headers: { "content-type": "application/json" } },
      );
    };
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    await client.sendRoomMessage("550e8400-e29b-41d4-a716-446655440000", {
      content: "read this folder",
      currentFolder: "/Users/casey/Projects/kentauros",
      currentFolderRelayId: "relay-casey",
      workspacePath: "/Users/casey/Documents/Nautilo",
    });

    const parsedBody = JSON.parse(bodyText) as { model?: unknown };
    expect(parsedBody).toMatchObject({
      currentFolder: "/Users/casey/Projects/kentauros",
      currentFolderRelayId: "relay-casey",
      workspacePath: "/Users/casey/Documents/Nautilo",
    });
  });

  test("human-only branch — 201 JSON parses", async () => {
    const mockFetch = async () =>
      new Response(
        JSON.stringify({
          messageId: 7,
          jobId: null,
          accepted: true,
          attachments: [{ id: "a1", filename: "x.txt", decision: "accept" }],
          coalesced: false,
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      );
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const out = await client.sendRoomMessage("660e8400-e29b-41d4-a716-446655440001", {
      content: "peer hi",
    });
    expect(out.messageId).toBe(7);
    expect(out.jobId).toBeNull();
    expect(out.attachments).toHaveLength(1);
    expect(out.attachments[0]?.decision).toBe("accept");
  });

  test("non-2xx throws ApiError with server error string", async () => {
    const mockFetch = async () =>
      new Response(JSON.stringify({ error: "Forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    let caught: unknown;
    try {
      await client.sendRoomMessage("770e8400-e29b-41d4-a716-446655440002", {
        content: "x",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).status).toBe(403);
    expect((caught as ApiError).message).toBe("Forbidden");
  });

  test("preserves the content-free Strict Shadow reason on 425", async () => {
    const mockFetch = async () => new Response(JSON.stringify({
      error: "strict_shadow_protected_content_required",
      state: "waiting_for_authority",
      reason: "namespace_authority_converging",
      retryable: true,
    }), {
      status: 425,
      headers: { "content-type": "application/json" },
    });
    globalThis.fetch = Object.assign(mockFetch, {
      preconnect: realFetch.preconnect.bind(realFetch),
    }) as typeof fetch;

    const client = new NautiloApiClient("http://127.0.0.1:9");
    client.setToken("tok");
    const error = await client.sendRoomMessage("room", { content: "x" })
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(StrictShadowProtectedContentRequiredError);
    expect(error).toMatchObject({
      status: 425,
      state: "waiting_for_authority",
      reason: "namespace_authority_converging",
      retryable: true,
    });
  });
});
