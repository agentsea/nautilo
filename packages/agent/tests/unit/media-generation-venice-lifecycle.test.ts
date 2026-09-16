import { describe, expect, test } from "bun:test";
import { beginMediaGenerationAdmission, type MediaGenerationAdmissionProof } from "@nautilo/db";
import {
  VENICE_MEDIA_MODELS,
  VeniceMediaLifecycleAdapter,
  VeniceMediaLifecycleError,
  scheduleVeniceRetrieve,
  toVeniceQueuePayload,
  validateVeniceSignedDeliveryUrl,
  type VeniceAcceptedMediaWork,
  type VeniceMediaModel,
} from "../../src/media-generation";

const receiptId = "mg_0123456789abcdef";

test("video reference transport submits only the exact resolved videos and no images", async () => {
  const proof = await admissionProof({ model: VENICE_MEDIA_MODELS.seedanceReference, kind: "video", prompt: "Extend <Video 1>, continue",
    referenceImages: [], referenceVideos: [{ path: "refs/scene.mp4", artifactId: "public", artifactInternalId: "11111111-1111-4111-8111-111111111111",
      revision: 1, mimeType: "video/mp4", sizeBytes: 100, sha256: "a".repeat(64), durationSeconds: 5 }],
    normalizedSettings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioEnabled: true } });
  expect(() => toVeniceQueuePayload(proof, [], [])).toThrow("resolved");
  const payload = toVeniceQueuePayload(proof, [], ["data:video/mp4;base64,AQID"]);
  expect(payload).toMatchObject({ reference_video_urls: ["data:video/mp4;base64,AQID"] });
  expect(payload).not.toHaveProperty("reference_image_urls");
});

type ProofInput = {
  readonly model: VeniceMediaModel;
  readonly kind: "video" | "music";
  readonly prompt: string;
  readonly lyrics?: string;
  readonly referenceImages?: MediaGenerationAdmissionProof["requestPayload"]["referenceImages"];
  readonly referenceVideos?: MediaGenerationAdmissionProof["requestPayload"]["referenceVideos"];
  readonly normalizedSettings: Record<string, string | number | boolean>;
};

async function admissionProof(input: ProofInput): Promise<MediaGenerationAdmissionProof> {
  const chain = {
    set() { return chain; },
    where() { return chain; },
    returning: async () => [{
      kind: input.kind,
      providerModel: input.model,
      requestPayload: {
        version: 1 as const,
        model: input.model,
        prompt: input.prompt,
        ...(input.lyrics === undefined ? {} : { lyrics: input.lyrics }),
        ...(input.referenceImages === undefined ? {} : { referenceImages: input.referenceImages }),
        ...(input.referenceVideos === undefined ? {} : { referenceVideos: input.referenceVideos }),
        normalizedSettings: input.normalizedSettings,
      },
    }],
  };
  const proof = await beginMediaGenerationAdmission(
    { update: () => chain } as never,
    { ownerId: "owner", roomId: "room", namespaceId: "namespace", receiptId, expectedRevision: 0 },
  );
  if (proof === null) throw new Error("expected DB-minted admission proof");
  return proof;
}

function videoProof(prompt = "private ocean", durationSeconds = 10): Promise<MediaGenerationAdmissionProof> {
  return admissionProof({
    model: VENICE_MEDIA_MODELS.seedance,
    kind: "video",
    prompt,
    normalizedSettings: { durationSeconds, aspectRatio: "16:9", resolution: "720p", audioEnabled: false },
  });
}

function musicProof(prompt = "bright city song", lyrics?: string): Promise<MediaGenerationAdmissionProof> {
  return admissionProof({
    model: VENICE_MEDIA_MODELS.minimaxMusic,
    kind: "music",
    prompt,
    ...(lyrics === undefined ? {} : { lyrics }),
    normalizedSettings: { instrumental: false },
  });
}

function accepted(kind: "video" | "music" = "video"): VeniceAcceptedMediaWork {
  return {
    receiptId,
    model: kind === "video" ? VENICE_MEDIA_MODELS.seedance : VENICE_MEDIA_MODELS.minimaxMusic,
    kind,
    providerQueueId: "provider-queue-opaque",
  };
}

function adapter(responses: Array<Response | Error>, allowedHosts: readonly string[] = ["delivery.venice.example"]) {
  const requests: Array<{ url: string; init?: RequestInit }> = [];
  const fetchImpl = async (url: string | URL, init?: RequestInit): Promise<Response> => {
    requests.push({ url: String(url), ...(init === undefined ? {} : { init }) });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    if (!next) throw new Error("unexpected fetch");
    return next;
  };
  return {
    requests,
    client: new VeniceMediaLifecycleAdapter({
      apiKey: "test-key",
      fetchImpl,
      signedDeliveryAllowedHosts: allowedHosts,
      now: () => new Date("2026-08-14T12:00:00.000Z"),
    }),
  };
}

function requestJson(request: { init?: RequestInit } | undefined): unknown {
  const body = request?.init?.body;
  if (typeof body !== "string") throw new Error("expected a JSON string request body");
  return JSON.parse(body) as unknown;
}

async function lifecycleFailure(operation: Promise<unknown>): Promise<VeniceMediaLifecycleError> {
  try {
    await operation;
  } catch (error) {
    if (error instanceof VeniceMediaLifecycleError) return error;
    throw error;
  }
  throw new Error("expected lifecycle error");
}

declare const typeCheckedClient: VeniceMediaLifecycleAdapter;

void function typeCheckDbAdmissionProofBoundary() {
  const forgedPlainObject = {
    receiptId,
    revision: 1,
    admissionToken: "not-a-db-minted-proof",
    kind: "video" as const,
    providerModel: VENICE_MEDIA_MODELS.seedance,
    requestPayload: { version: 1 as const, model: VENICE_MEDIA_MODELS.seedance, prompt: "forged", normalizedSettings: {} },
  };
  // @ts-expect-error MediaGenerationAdmissionProof carries a DB-private brand.
  void typeCheckedClient.queueVeniceMediaGeneration(forgedPlainObject);
};

describe("Venice media queue/retrieve/complete adapter", () => {
  test("uses exact queue endpoints and DB-approved creative queue payloads rather than quote payloads", async () => {
    const video = await videoProof();
    const music = await musicProof("bright city song", "private chorus");
    expect(toVeniceQueuePayload(video)).toEqual({
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "private ocean",
      duration: "10s",
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: false,
    });
    expect(toVeniceQueuePayload(music)).toEqual({
      model: VENICE_MEDIA_MODELS.minimaxMusic,
      prompt: "bright city song",
      lyrics_prompt: "private chorus",
      force_instrumental: false,
    });

    const first = adapter([
      Response.json({ model: VENICE_MEDIA_MODELS.seedance, queue_id: "video-private-queue" }),
      Response.json({ model: VENICE_MEDIA_MODELS.minimaxMusic, queue_id: "music-private-queue", status: "QUEUED" }),
    ]);
    const queuedVideo = await first.client.queueVeniceMediaGeneration(video);
    const queuedMusic = await first.client.queueVeniceMediaGeneration(music);
    expect(queuedVideo).toMatchObject({ receiptId, providerQueueId: "video-private-queue", kind: "video" });
    expect(queuedMusic).toMatchObject({ receiptId, providerQueueId: "music-private-queue", kind: "music" });
    expect(first.requests.map((request) => request.url)).toEqual([
      "https://api.venice.ai/api/v1/video/queue",
      "https://api.venice.ai/api/v1/audio/queue",
    ]);
    expect(requestJson(first.requests[0])).not.toHaveProperty("duration_seconds");
    expect(requestJson(first.requests[1])).not.toHaveProperty("duration");
  });

  test("resolves approved Seedance images once into the documented reference_image_urls queue field", async () => {
    const proof = await admissionProof({
      model: VENICE_MEDIA_MODELS.seedanceReference,
      kind: "video",
      prompt: "Refer to the lighting in <Image 1>.",
      referenceImages: [{
        path: "references/noir.png",
        artifactId: "workspace-noir",
        artifactInternalId: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        mimeType: "image/png",
        sizeBytes: 3,
        sha256: "a".repeat(64),
      }],
      normalizedSettings: { durationSeconds: 10, aspectRatio: "16:9", resolution: "720p", audioEnabled: true },
    });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const client = new VeniceMediaLifecycleAdapter({
      apiKey: "test-key",
      resolveReferenceImageUrls: async (received) => {
        expect(received).toBe(proof);
        return ["data:image/png;base64,AQID"];
      },
      fetchImpl: async (url, init) => {
        requests.push({ url: String(url), ...(init ? { init } : {}) });
        return Response.json({ model: VENICE_MEDIA_MODELS.seedanceReference, queue_id: "reference-private-queue" });
      },
    });
    await client.queueVeniceMediaGeneration(proof);
    expect(requestJson(requests[0])).toEqual({
      model: VENICE_MEDIA_MODELS.seedanceReference,
      prompt: "Refer to the lighting in <Image 1>.",
      duration: "10s",
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
      reference_image_urls: ["data:image/png;base64,AQID"],
    });
  });

  test("malformed acceptance and network uncertainty fence paid admission instead of yielding a retryable queue", async () => {
    const proof = await videoProof("private request");
    for (const response of [Response.json({ model: proof.providerModel }), new Error("socket closed")]) {
      const { client } = adapter([response]);
      const error = await lifecycleFailure(client.queueVeniceMediaGeneration(proof));
      expect(error.receiptId).toBe(receiptId);
      expect(error.failure).toMatchObject({
        code: "VENICE_QUEUE_COMPLETION_UNKNOWN",
        phase: "admission",
        retrySafe: false,
        completionCertainty: "unknown",
      });
      expect(error.message).not.toContain("private request");
      expect(error.message).not.toContain("socket");
    }
  });

  test("preserves documented top-level moderation refund facts while stripping raw provider refusal bodies", async () => {
    const proof = await musicProof();
    const { client } = adapter([
      Response.json({
        code: "CONTENT_POLICY_VIOLATION",
        error: "private prompt echo https://provider.example/refusal?token=secret",
        credits_refunded: true,
      }, { status: 422 }),
    ]);
    const error = await lifecycleFailure(client.queueVeniceMediaGeneration(proof));
    expect(error.failure).toMatchObject({
      code: "VENICE_CONTENT_POLICY",
      phase: "admission",
      retrySafe: false,
      chargeCertainty: "refunded",
      creditsRefunded: true,
      recoveryActions: ["revise_request", "switch_model"],
    });
    expect(error.message).not.toContain("private prompt echo");
    expect(error.message).not.toContain("https://");
  });

  test("classifies nested consent requirements without exposing provider consent topology", async () => {
    const proof = await videoProof("private character request");
    const { client } = adapter([
      Response.json({
        error: { code: "needs_consent", message: "https://provider.example/consent?private=1" },
        consent_flow: "provider-private",
        docs_url: "https://provider.example/docs?secret=1",
      }, { status: 409 }),
    ]);
    const error = await lifecycleFailure(client.queueVeniceMediaGeneration(proof));
    expect(error.failure).toMatchObject({
      code: "VENICE_NEEDS_CONSENT",
      phase: "admission",
      retrySafe: false,
      recoveryActions: ["provider_consent", "switch_model"],
    });
    expect(error.message).not.toContain("provider.example");
    expect(error.message).not.toContain("private character request");
  });

  test("polls accepted work as processing JSON with bounded provider-informed scheduling", async () => {
    const { client, requests } = adapter([
      Response.json({ status: "PROCESSING", average_execution_time: 145_000, execution_duration: 53_200 }),
    ]);
    const result = await client.retrieve({ accepted: accepted(), attempt: 2 });
    expect(result).toMatchObject({
      state: "processing",
      receiptId,
      estimatedExecutionMs: 145_000,
      executionDurationMs: 53_200,
      schedule: { delayMs: 60_000, nextAttemptAt: new Date("2026-08-14T12:01:00.000Z") },
    });
    expect(requests[0]?.url).toBe("https://api.venice.ai/api/v1/video/retrieve");
    expect(requestJson(requests[0])).toEqual({
      model: VENICE_MEDIA_MODELS.seedance,
      queue_id: "provider-queue-opaque",
      delete_media_on_completion: false,
    });
    expect(scheduleVeniceRetrieve({ now: new Date(0), attempt: 30 }).delayMs).toBe(60_000);
    expect(() => scheduleVeniceRetrieve({ now: new Date(0), attempt: 31 })).toThrow("retrieve attempt must be between 0 and 30");
  });

  test("streams direct binary retrieve responses without parsing them as JSON", async () => {
    const { client } = adapter([
      new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "audio/mpeg" } }),
    ]);
    const result = await client.retrieve({ accepted: accepted("music"), attempt: 0 });
    expect(result.state).toBe("binary");
    if (result.state !== "binary") throw new Error("expected binary result");
    expect(result.contentType).toBe("audio/mpeg");
    expect(Array.from(new Uint8Array(await new Response(result.body).arrayBuffer()))).toEqual([1, 2, 3]);
  });

  test("uses only an allowlisted HTTPS signed URL after completed polling, then downloads without credentials or redirects", async () => {
    const work: VeniceAcceptedMediaWork = { ...accepted(), signedDeliveryUrl: "https://delivery.venice.example/media.mp4?signature=private" };
    const { client, requests } = adapter([
      Response.json({ status: "COMPLETED" }),
      new Response(new Uint8Array([9, 8]), { headers: { "content-type": "video/mp4" } }),
    ]);
    const retrieved = await client.retrieve({ accepted: work, attempt: 0 });
    expect(retrieved.state).toBe("signed_delivery");
    if (retrieved.state !== "signed_delivery") throw new Error("expected signed delivery result");
    expect(retrieved.receiptId).toBe(receiptId);
    expect(retrieved.signedDeliveryUrl).toContain("signature=private");
    const downloaded = await client.downloadSignedDelivery({ accepted: work, signedDeliveryUrl: retrieved.signedDeliveryUrl });
    expect(downloaded).toMatchObject({ state: "binary", receiptId, contentType: "video/mp4" });
    expect(requests[1]).toMatchObject({
      url: "https://delivery.venice.example/media.mp4?signature=private",
      init: { method: "GET", redirect: "error", credentials: "omit" },
    });
    expect(validateVeniceSignedDeliveryUrl("http://delivery.venice.example/x", ["delivery.venice.example"])).toBeUndefined();
    expect(validateVeniceSignedDeliveryUrl("https://127.0.0.1/x", ["127.0.0.1"])).toBeUndefined();
    expect(validateVeniceSignedDeliveryUrl("https://delivery.venice.example/x#fragment", ["delivery.venice.example"])).toBeUndefined();
    const rejected = await lifecycleFailure(client.downloadSignedDelivery({
      accepted: work,
      signedDeliveryUrl: "http://delivery.venice.example/unsafe",
    }));
    expect(rejected.failure).toMatchObject({ code: "VENICE_SIGNED_DELIVERY_REJECTED", completionCertainty: "accepted" });
    const substituted = await lifecycleFailure(client.downloadSignedDelivery({
      accepted: work,
      signedDeliveryUrl: "https://delivery.venice.example/another-receipt.mp4?signature=private",
    }));
    expect(substituted.failure).toMatchObject({ code: "VENICE_SIGNED_DELIVERY_REJECTED", completionCertainty: "accepted" });
    expect(requests).toHaveLength(2);
  });

  test("classifies retrieve overloads as same-receipt retries and missing media as an explicit fresh paid generation", async () => {
    const overloaded = adapter([Response.json({ error: "private body" }, { status: 503 })]);
    const overloadError = await lifecycleFailure(overloaded.client.retrieve({ accepted: accepted(), attempt: 0 }));
    expect(overloadError.failure).toMatchObject({
      phase: "retrieve",
      retrySafe: true,
      completionCertainty: "accepted",
      recoveryActions: ["retry_retrieval"],
    });

    const expired = adapter([Response.json({ error: "private body" }, { status: 404 })]);
    const expiredError = await lifecycleFailure(expired.client.retrieve({ accepted: accepted(), attempt: 0 }));
    expect(expiredError.failure).toMatchObject({
      code: "VENICE_MEDIA_EXPIRED",
      retrySafe: false,
      completionCertainty: "unavailable",
      recoveryActions: ["start_new_generation"],
    });
  });

  test("does not call complete until the exact receipt has a durable artifact commit proof", async () => {
    const { client, requests } = adapter([Response.json({ success: true })]);
    let invalidProofError: unknown;
    try {
      await client.complete({
        accepted: accepted(),
        commitProof: { receiptId: "mg_anotherreceipt123", artifactInternalId: "artifact-private", artifactRevision: 1, state: "durably_committed" },
      });
    } catch (error) {
      invalidProofError = error;
    }
    expect(invalidProofError).toBeInstanceOf(Error);
    expect((invalidProofError as Error).message).toContain("complete requires a durable artifact commit proof for the same receipt");
    expect(requests).toHaveLength(0);

    await client.complete({
      accepted: accepted(),
      commitProof: { receiptId, artifactInternalId: "artifact-private", artifactRevision: 1, state: "durably_committed" },
    });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.venice.ai/api/v1/video/complete");
    expect(requestJson(requests[0])).toEqual({ model: VENICE_MEDIA_MODELS.seedance, queue_id: "provider-queue-opaque" });
  });

  const commitProof = { receiptId, artifactInternalId: "artifact-private", artifactRevision: 1, state: "durably_committed" as const };
  const invalidCleanupId = () => Response.json({ error: "Request ID is invalid." }, { status: 400 });

  test("falls back to draining retrieve-and-delete for a saved video's rejected cleanup ID, never queueing", async () => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulls++ < 3) controller.enqueue(new Uint8Array([1, 2, 3]));
      else controller.close();
    } });
    const { client, requests } = adapter([invalidCleanupId(), new Response(body, { headers: { "Content-Type": "video/mp4" } })]);
    const work = { ...accepted(), model: VENICE_MEDIA_MODELS.seedanceReference };
    await client.complete({ accepted: work, commitProof });
    expect(pulls).toBe(4);
    expect(requests.map(r => new URL(r.url).pathname)).toEqual(["/api/v1/video/complete", "/api/v1/video/retrieve"]);
    expect(requestJson(requests[1])).toEqual({ model: work.model, queue_id: work.providerQueueId, delete_media_on_completion: true });
  });

  test("resumed cleanup accepts provider-confirmed absence, not a generic 404", async () => {
    for (const body of [{ code: "media_not_found" }, { error: "The requested task synthetic-id is not found. Request id: synthetic-correlation" }]) {
      const { client, requests } = adapter([invalidCleanupId(), Response.json(body, { status: 404 })]);
      await client.complete({ accepted: accepted(), commitProof });
      expect(requests).toHaveLength(2);
    }
    for (const response of [new Response("Not found", { status: 404 }), Response.json({ error: "Route not found" }, { status: 404 })]) {
      const { client } = adapter([invalidCleanupId(), response]);
      const error = await lifecycleFailure(client.complete({ accepted: accepted(), commitProof }));
      expect(error.failure.phase).toBe("cleanup");
      expect(error.failure.recoveryActions).toEqual(["retry_cleanup"]);
    }
  });

  test("does not fall back for music, unrelated 400s, authentication errors, or missing commit proof", async () => {
    for (const [work, response] of [
      [accepted("music"), invalidCleanupId()],
      [accepted(), Response.json({ error: "Invalid model" }, { status: 400 })],
      [accepted(), Response.json({ error: "Request ID is invalid." }, { status: 401 })],
    ] as const) {
      const { client, requests } = adapter([response]);
      await lifecycleFailure(client.complete({ accepted: work, commitProof }));
      expect(requests).toHaveLength(1);
    }
    const { client, requests } = adapter([invalidCleanupId()]);
    const proofError: unknown = await client.complete({ accepted: accepted(), commitProof: { ...commitProof, receiptId: "other" } }).catch((error: unknown) => error);
    expect(proofError).toBeInstanceOf(Error);
    expect((proofError as Error).message).toContain("durable artifact commit proof");
    expect(requests).toHaveLength(0);
  });

  test("cleanup stays pending for processing, empty, interrupted, or rejected fallback responses", async () => {
    const broken = new ReadableStream<Uint8Array>({ start(controller) { controller.error(new Error("network interrupted")); } });
    for (const response of [
      Response.json({ status: "PROCESSING" }),
      new Response(new Uint8Array(), { headers: { "Content-Type": "video/mp4" } }),
      new Response(broken, { headers: { "Content-Type": "video/mp4" } }),
      Response.json({ error: "private provider diagnostic" }, { status: 503 }),
      new Error("network unavailable"),
    ]) {
      const { client, requests } = adapter([invalidCleanupId(), response]);
      const error = await lifecycleFailure(client.complete({ accepted: accepted(), commitProof }));
      expect(error.failure.phase).toBe("cleanup");
      expect(error.failure.recoveryActions).toEqual(["retry_cleanup"]);
      expect(requests).toHaveLength(2);
      expect(JSON.stringify(error.failure)).not.toContain("private provider diagnostic");
    }
  });
});
