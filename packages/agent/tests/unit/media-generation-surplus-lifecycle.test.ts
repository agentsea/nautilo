import { describe, expect, test } from "bun:test";
import { beginMediaGenerationAdmission, type MediaGenerationAdmissionProof } from "@nautilo/db";
import {
  resolveSurplusMediaRoute,
  SurplusMediaLifecycleAdapter,
  VeniceMediaLifecycleError,
} from "../../src/media-generation";

const receiptId = "mg_surplus_0123456789abcdef";
const ownerId = "11111111-1111-4111-8111-111111111111";
const fingerprint = "a".repeat(64);

async function surplusProof(model = "minimax-music-v26"): Promise<MediaGenerationAdmissionProof> {
  const fundingBinding = {
    humanUserId: ownerId,
    provider: "surplus" as const,
    binding: {
      kind: "personal" as const,
      providerRoute: "surplus",
      credentialId: "22222222-2222-4222-8222-222222222222",
      credentialRevision: 3,
    },
    credentialFingerprint: fingerprint,
  };
  const chain = {
    set() { return chain; },
    where() { return chain; },
    returning: async () => [{
      kind: "music" as const,
      provider: "surplus" as const,
      providerModel: model,
      providerAccountFingerprint: fingerprint,
      fundingBinding,
      requestPayload: {
        version: 1 as const,
        model,
        prompt: "private melody",
        lyrics: "private lyrics",
        normalizedSettings: { instrumental: false },
      },
    }],
  };
  const proof = await beginMediaGenerationAdmission(
    { update: () => chain } as never,
    { ownerId, roomId: "room", namespaceId: "namespace", receiptId, expectedRevision: 0 },
  );
  if (!proof) throw new Error("expected admission proof");
  return proof;
}

describe("Surplus durable music lifecycle", () => {
  test("qualifies only the exact probed music model and submits with receipt idempotency", async () => {
    expect(resolveSurplusMediaRoute("minimax-music-v26")).toBe("venice-minimax-music-v26");
    expect(resolveSurplusMediaRoute("seedance-2-5-text-to-video-basic")).toBeNull();
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return new Response(JSON.stringify({ id: "market-job", kind: "music", status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const accepted = await lifecycle.queueVeniceMediaGeneration(await surplusProof());
    expect(accepted.providerQueueId).toBe("market-job");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.surplusintelligence.ai/v1/music/generations");
    expect((requests[0]?.init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(receiptId);
    const requestBody = requests[0]?.init?.body;
    if (typeof requestBody !== "string") throw new Error("expected serialized Surplus request");
    expect(JSON.parse(requestBody)).toEqual({
      model: "venice-minimax-music-v26",
      prompt: "private melody",
      lyrics_prompt: "private lyrics",
      force_instrumental: false,
    });

    try {
      await lifecycle.queueVeniceMediaGeneration(await surplusProof("seedance-2-5-text-to-video-basic"));
      throw new Error("expected unsupported route");
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
      expect((error as VeniceMediaLifecycleError).failure).toMatchObject({
        code: "SURPLUS_MEDIA_ROUTE_UNSUPPORTED", completionCertainty: "not_started",
      });
    }
    expect(requests).toHaveLength(1);
  });

  test("an uncertain submit is never classified as retry-safe", async () => {
    let calls = 0;
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async () => { calls += 1; throw new Error("connection reset"); },
    });
    try {
      await lifecycle.queueVeniceMediaGeneration(await surplusProof());
      throw new Error("expected uncertain admission");
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
      expect((error as VeniceMediaLifecycleError).failure).toMatchObject({
        code: "SURPLUS_ADMISSION_UNKNOWN",
        retrySafe: false,
        completionCertainty: "unknown",
        chargeCertainty: "unknown",
      });
    }
    expect(calls).toBe(1);
  });

  test("captures the final buyer micro-charge and authenticates only the marketplace artifact hop", async () => {
    const seen: Array<{ url: string; authorization?: string }> = [];
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      signedDeliveryAllowedHosts: ["delivery.example"],
      fetchImpl: async (url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seen.push({ url: String(url), ...(headers?.["Authorization"] ? { authorization: headers["Authorization"] } : {}) });
        if (String(url).endsWith("/v1/music/generations/market-job")) {
          return new Response(JSON.stringify({
            id: "market-job", kind: "music", status: "succeeded",
            results: [{ content_type: "audio/mpeg", url: "https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0" }],
            usage: { buyer_cost_usdc: "105600", settlement_status: "captured" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).startsWith("https://api.surplusintelligence.ai/v1/media/artifacts/")) {
          return new Response(null, { status: 302, headers: { location: "https://delivery.example/audio.mp3" } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      },
    });
    const accepted = { receiptId, model: "minimax-music-v26" as const, kind: "music" as const, providerQueueId: "market-job" };
    const retrieved = await lifecycle.retrieve({ accepted, attempt: 1 });
    expect(retrieved).toMatchObject({ state: "signed_delivery", actualCostUsdMicros: 105_600 });
    if (retrieved.state !== "signed_delivery") throw new Error("expected signed delivery");
    const downloaded = await lifecycle.downloadSignedDelivery({ accepted, signedDeliveryUrl: retrieved.signedDeliveryUrl });
    expect(downloaded).toMatchObject({ state: "binary", contentType: "audio/mpeg" });
    expect(seen).toEqual([
      { url: "https://api.surplusintelligence.ai/v1/music/generations/market-job", authorization: "Bearer surplus-secret" },
      { url: "https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0", authorization: "Bearer surplus-secret" },
      { url: "https://delivery.example/audio.mp3" },
    ]);
  });

  test("records cancellation as terminal and preserves a captured charge", async () => {
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        id: "market-job", kind: "music", status: "cancelled",
        usage: { buyer_cost_usdc: "2400", settlement_status: "captured" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });
    try {
      await lifecycle.retrieve({
        accepted: { receiptId, model: "minimax-music-v26", kind: "music", providerQueueId: "market-job" },
        attempt: 2,
      });
      throw new Error("expected cancellation");
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
      expect((error as VeniceMediaLifecycleError).failure).toMatchObject({
        code: "SURPLUS_CANCELLED",
        retrySafe: false,
        chargeCertainty: "charged_or_committed",
      });
      expect((error as VeniceMediaLifecycleError).actualCostUsdMicros).toBe(2_400);
    }
  });
});
