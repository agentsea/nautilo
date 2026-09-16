import { describe, expect, test } from "bun:test";
import { NautiloApiClient, ApiError } from "./client";
import type { MediaGenerationStatusDtoV1 } from "./media-generations";

function queuedDto(): MediaGenerationStatusDtoV1 {
  return {
    dtoVersion: 1,
    receiptId: "mg_1234567890abcdef",
    revision: 2,
    mediaKind: "video",
    state: "queued",
    modelId: "venice:seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    progress: { phase: "queued" },
    recoveryActions: [],
  };
}

async function expectFailure(promise: Promise<unknown>): Promise<void> {
  let failed = false;
  try {
    await promise;
  } catch {
    failed = true;
  }
  expect(failed).toBe(true);
}

describe("D525 media generation status client", () => {
  test("sends an authenticated encoded scoped GET and strictly parses the DTO", async () => {
    let request: { url: string; init: RequestInit | undefined } | undefined;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async (url, init) => {
        request = {
          url: typeof url === "string" ? url : url instanceof URL ? url.toString() : url.url,
          init,
        };
        return new Response(JSON.stringify(queuedDto()), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    client.setToken("test-token");
    const controller = new AbortController();
    expect(await client.getMediaGenerationStatus("mg_1234567890abcdef", {
      roomId: "room / one",
      signal: controller.signal,
    })).toEqual(queuedDto());
    expect(request?.url).toBe("https://nautilo.test/api/media-generations/mg_1234567890abcdef?roomId=room+%2F+one");
    expect(new Headers(request?.init?.headers).get("authorization")).toBe("Bearer test-token");
    expect(request?.init?.signal).toBe(controller.signal);
  });

  test("rejects unknown topology fields instead of returning them", async () => {
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => new Response(JSON.stringify({
        ...queuedDto(),
        providerUrl: "https://provider.example/private",
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    await expectFailure(client.getMediaGenerationStatus("mg_1234567890abcdef", { roomId: "room-1" }));
  });

  test("rejects unbound/provider-shaped identity before transport", async () => {
    let calls = 0;
    const client = new NautiloApiClient("https://nautilo.test", {
      fetchImpl: async () => {
        calls += 1;
        return new Response(JSON.stringify(queuedDto()));
      },
    });
    await expectFailure(client.getMediaGenerationStatus("provider-queue-id", { roomId: "room-1" }));
    await expectFailure(client.getMediaGenerationStatus("mg_1234567890abcdef", { roomId: " " }));
    expect(calls).toBe(0);
  });

  test("surfaces 404 and 503 as typed temporary-safe request failures", async () => {
    for (const status of [404, 503]) {
      const client = new NautiloApiClient("https://nautilo.test", {
        fetchImpl: async () => new Response(JSON.stringify({ error: "Status unavailable" }), {
          status,
          headers: { "content-type": "application/json" },
        }),
      });
      try {
        await client.getMediaGenerationStatus("mg_1234567890abcdef", { roomId: "room-1" });
        throw new Error("expected request to fail");
      } catch (error) {
        expect(error).toBeInstanceOf(ApiError);
        expect((error as ApiError).status).toBe(status);
      }
    }
  });
});
