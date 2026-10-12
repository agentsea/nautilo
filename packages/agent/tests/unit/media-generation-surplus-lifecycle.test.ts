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

const approvedRequests = {
  "seedance-2-5-text-to-video-basic": {
    kind: "video" as const,
    requestPayload: {
      version: 1 as const,
      model: "seedance-2-5-text-to-video-basic",
      prompt: "private harbor scene",
      normalizedSettings: { durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audioEnabled: true },
    },
  },
  "minimax-h3-enhanced-text-to-video": {
    kind: "video" as const,
    requestPayload: {
      version: 1 as const,
      model: "minimax-h3-enhanced-text-to-video",
      prompt: "private harbor scene",
      normalizedSettings: { durationSeconds: 10, aspectRatio: "16:9", resolution: "2K" },
    },
  },
  "minimax-music-v26": {
    kind: "music" as const,
    requestPayload: {
      version: 1 as const,
      model: "minimax-music-v26",
      prompt: "private melody",
      lyrics: "private lyrics",
      normalizedSettings: { instrumental: false },
    },
  },
} as const;

type SupportedModel = keyof typeof approvedRequests;

async function surplusProof(model: SupportedModel = "minimax-music-v26"): Promise<MediaGenerationAdmissionProof> {
  const approved = approvedRequests[model];
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
      kind: approved.kind,
      provider: "surplus" as const,
      providerModel: model,
      providerAccountFingerprint: fingerprint,
      fundingBinding,
      requestPayload: approved.requestPayload,
    }],
  };
  const proof = await beginMediaGenerationAdmission(
    { update: () => chain } as never,
    { ownerId, roomId: "room", namespaceId: "namespace", receiptId, expectedRevision: 0 },
  );
  if (!proof) throw new Error("expected admission proof");
  return proof;
}

describe("Surplus durable media lifecycle", () => {
  test("maps only exact same-model non-reference routes", () => {
    expect(resolveSurplusMediaRoute("seedance-2-5-text-to-video-basic")).toBe("venice-seedance-2-5-text-to-video-basic");
    expect(resolveSurplusMediaRoute("minimax-h3-enhanced-text-to-video")).toBe("venice-minimax-h3-enhanced-text-to-video");
    expect(resolveSurplusMediaRoute("sonilo-v1-1-music")).toBeNull();
    expect(resolveSurplusMediaRoute("minimax-music-v26")).toBe("venice-minimax-music-v26");
    expect(resolveSurplusMediaRoute("seedance-2-5-reference-to-video-basic")).toBeNull();
    expect(resolveSurplusMediaRoute("seedance-2-fast-t2v")).toBeNull();
  });

  test("submits the exact qualified approved request shapes to their family endpoints", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        const kind = String(url).includes("/video/") ? "video" : "music";
        return new Response(JSON.stringify({ id: `market-${kind}`, kind, status: "queued" }), {
          status: 202,
          headers: { "content-type": "application/json" },
        });
      },
    });

    const cases = [
      ["seedance-2-5-text-to-video-basic", "video", {
        model: "venice-seedance-2-5-text-to-video-basic", prompt: "private harbor scene",
        duration: "8s", aspect_ratio: "16:9", resolution: "720p", audio: true,
      }],
      ["minimax-h3-enhanced-text-to-video", "video", {
        model: "venice-minimax-h3-enhanced-text-to-video", prompt: "private harbor scene",
        duration: "10s", aspect_ratio: "16:9", resolution: "2K",
      }],
      ["minimax-music-v26", "music", {
        model: "venice-minimax-music-v26", prompt: "private melody",
        lyrics_prompt: "private lyrics", force_instrumental: false,
      }],
    ] as const;
    for (const [model, kind, expectedBody] of cases) {
      const accepted = await lifecycle.queueVeniceMediaGeneration(await surplusProof(model));
      expect(accepted).toMatchObject({ model, kind, providerQueueId: `market-${kind}` });
      const request = requests.at(-1);
      expect(request?.url).toBe(`https://api.surplusintelligence.ai/v1/${kind}/generations`);
      expect((request?.init?.headers as Record<string, string>)["Idempotency-Key"]).toBe(receiptId);
      if (typeof request?.init?.body !== "string") throw new Error("expected serialized Surplus request");
      expect(JSON.parse(request.init.body)).toEqual(expectedBody);
    }
    expect(requests).toHaveLength(3);
  });

  test("rejects reference media and approximate model aliases before submission", async () => {
    let calls = 0;
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async () => {
        calls += 1;
        throw new Error("must not submit unsupported media");
      },
    });
    const base = await surplusProof();
    const unsupported = {
      ...base,
      kind: "video",
      providerModel: "seedance-2-5-reference-to-video-basic",
      requestPayload: {
        version: 1,
        model: "seedance-2-5-reference-to-video-basic",
        prompt: "private references",
        referenceImages: [{ path: "references/private.png", revision: 1, sha256: "a".repeat(64) }],
        normalizedSettings: { durationSeconds: 8, aspectRatio: "16:9", resolution: "720p", audioEnabled: true },
      },
    } as unknown as MediaGenerationAdmissionProof;

    try {
      await lifecycle.queueVeniceMediaGeneration(unsupported);
      throw new Error("expected unsupported route");
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
      expect((error as VeniceMediaLifecycleError).failure).toMatchObject({
        code: "SURPLUS_MEDIA_ROUTE_UNSUPPORTED", completionCertainty: "not_started",
      });
    }
    expect(calls).toBe(0);
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
      fetchImpl: async (url, init) => {
        const headers = init?.headers as Record<string, string> | undefined;
        seen.push({ url: String(url), ...(headers?.["Authorization"] ? { authorization: headers["Authorization"] } : {}) });
        if (String(url).endsWith("/v1/music/generations/market-job")) {
          return new Response(JSON.stringify({
            id: "market-job", kind: "music", status: "succeeded",
            results: [{
              artifact_index: 0,
              content_type: "audio/mpeg",
              // The canonical artifact coordinate comes from job + index. A
              // seller URL cannot expand the authenticated download boundary.
              url: "https://untrusted-delivery.example/private?signature=secret",
            }],
            usage: { buyer_cost_usdc: "105600", settlement_status: "captured" },
          }), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (String(url).startsWith("https://api.surplusintelligence.ai/v1/media/artifacts/")) {
          return new Response(null, { status: 302, headers: {
            location: "https://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3?X-Amz-Signature=secret",
          } });
        }
        return new Response(new Uint8Array([1, 2, 3]), { status: 200, headers: { "content-type": "audio/mpeg" } });
      },
    });
    const accepted = { receiptId, model: "minimax-music-v26" as const, kind: "music" as const, providerQueueId: "market-job" };
    const retrieved = await lifecycle.retrieve({ accepted, attempt: 1 });
    expect(retrieved).toMatchObject({ state: "signed_delivery", actualCostUsdMicros: 105_600 });
    if (retrieved.state !== "signed_delivery") throw new Error("expected signed delivery");
    expect(retrieved.signedDeliveryUrl).toBe("https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0");
    const downloaded = await lifecycle.downloadSignedDelivery({ accepted, signedDeliveryUrl: retrieved.signedDeliveryUrl });
    expect(downloaded).toMatchObject({ state: "binary", contentType: "audio/mpeg" });
    expect(seen).toEqual([
      { url: "https://api.surplusintelligence.ai/v1/music/generations/market-job", authorization: "Bearer surplus-secret" },
      { url: "https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0", authorization: "Bearer surplus-secret" },
      { url: "https://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3?X-Amz-Signature=secret" },
    ]);
  });

  test("rejects sibling buckets and unsafe variants without sending a bearer token", async () => {
    const candidates = [
      "https://surplus-artifacts-569215998805.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3?signature=secret",
      "https://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/other-job/0/audio.mp3?signature=secret",
      "http://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3",
      "https://user:password@surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3",
      "https://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com:444/media/market-job/0/audio.mp3",
      "https://surplus-artifacts-569215998804.s3.us-east-1.amazonaws.com/media/market-job/0/audio.mp3#fragment",
    ];
    for (const candidate of candidates) {
      const seen: Array<{ url: string; authorization?: string }> = [];
      const lifecycle = new SurplusMediaLifecycleAdapter({
        apiKey: "surplus-secret",
        fetchImpl: async (url, init) => {
          const headers = init?.headers as Record<string, string> | undefined;
          seen.push({ url: String(url), ...(headers?.["Authorization"] ? { authorization: headers["Authorization"] } : {}) });
          return new Response(null, { status: 302, headers: { location: candidate } });
        },
      });
      try {
        await lifecycle.downloadSignedDelivery({
          accepted: { receiptId, model: "minimax-music-v26", kind: "music", providerQueueId: "market-job" },
          signedDeliveryUrl: "https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0",
        });
        throw new Error("expected unsafe redirect rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
        expect((error as VeniceMediaLifecycleError).failure.code).toBe("SURPLUS_DELIVERY_UNSAFE");
      }
      expect(seen).toEqual([{
        url: "https://api.surplusintelligence.ai/v1/media/artifacts/market-job/0",
        authorization: "Bearer surplus-secret",
      }]);
    }
  });

  test("retrieves video from the video job endpoint and requires its exact output contract", async () => {
    const urls: string[] = [];
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          id: "video-job", kind: "video", status: "succeeded",
          results: [{ artifact_index: 0, content_type: "video/mp4" }],
          usage: { buyer_cost_usdc: "40000", settlement_status: "captured" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const retrieved = await lifecycle.retrieve({
      accepted: {
        receiptId, model: "seedance-2-5-text-to-video-basic", kind: "video", providerQueueId: "video-job",
      },
      attempt: 1,
    });
    expect(retrieved).toMatchObject({ state: "signed_delivery", actualCostUsdMicros: 40_000 });
    expect(urls).toEqual(["https://api.surplusintelligence.ai/v1/video/generations/video-job"]);
  });

  test("rejects an invalid artifact index while preserving captured settlement", async () => {
    const lifecycle = new SurplusMediaLifecycleAdapter({
      apiKey: "surplus-secret",
      fetchImpl: async () => new Response(JSON.stringify({
        id: "market-job", kind: "music", status: "succeeded",
        results: [{ artifact_index: 1, content_type: "audio/mpeg" }],
        usage: { buyer_cost_usdc: "96000", settlement_status: "captured" },
      }), { status: 200, headers: { "content-type": "application/json" } }),
    });

    try {
      await lifecycle.retrieve({
        accepted: { receiptId, model: "minimax-music-v26", kind: "music", providerQueueId: "market-job" },
        attempt: 1,
      });
      throw new Error("expected invalid artifact index");
    } catch (error) {
      expect(error).toBeInstanceOf(VeniceMediaLifecycleError);
      expect((error as VeniceMediaLifecycleError).failure).toMatchObject({
        code: "SURPLUS_STATUS_INVALID",
        completionCertainty: "accepted",
      });
      expect((error as VeniceMediaLifecycleError).actualCostUsdMicros).toBe(96_000);
    }
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
