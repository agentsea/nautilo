import { describe, expect, test } from "bun:test";
import { VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING } from "@nautilo/types";
import {
  MediaGenerationValidationError,
  LOCKED_VENICE_MEDIA_MODEL_FACTS,
  VENICE_MEDIA_MODELS,
  mediaGenerationApprovalDigest,
  normalizeMediaGenerationRequest,
  normalizeMediaGenerationIntent,
  publicMediaGenerationReceipt,
  toVeniceQuotePricingRequest,
} from "../../src/media-generation";

describe("media-generation request contract", () => {
  test.each([512, 513, 4096])("preserves Workspace reference paths of %i characters in intent and bound requests", (length) => {
    const path = "refs/" + "a".repeat(length - 9) + ".png";
    const image = { path, artifactId: "image", artifactInternalId: "11111111-1111-4111-8111-111111111111",
      revision: 1, mimeType: "image/png", sizeBytes: 1024, sha256: "a".repeat(64) };
    const video = { ...image, path: path.replace(/png$/, "mp4"), mimeType: "video/mp4", durationSeconds: 4 };
    const request = { model: VENICE_MEDIA_MODELS.seedanceReference, prompt: "Use ordered references", referenceImages: [image], referenceVideos: [video] };
    expect(normalizeMediaGenerationRequest(request)).toMatchObject(request);
    const intent = { ...request, referenceImages: [{ path }], referenceVideos: [{ path: video.path }] };
    expect(normalizeMediaGenerationIntent(intent)).toMatchObject(intent);
  });

  test.each(["a".repeat(4097), "", "/refs/image.png", "refs/../image.png", "refs/\u0000image.png", "refs/image.png\n"])("rejects invalid Workspace reference path %#", (path) => {
    for (const field of ["referenceImages", "referenceVideos"]) {
      expect(() => normalizeMediaGenerationIntent({ model: VENICE_MEDIA_MODELS.seedanceReference, prompt: "Use references", [field]: [{ path }] })).toThrow();
    }
  });

  test("does not silently trim a Workspace artifact identity", () => {
    const path = " refs/exact.png ";
    expect(normalizeMediaGenerationIntent({ model: VENICE_MEDIA_MODELS.seedanceReference, prompt: "Use reference", referenceImages: [{ path }] })).toMatchObject({ referenceImages: [{ path }] });
  });

  test("gives Genies the actionable provider size warning instead of a numeric schema error", () => {
    const video = { path: "refs/flight.mp4", artifactId: "flight", artifactInternalId: "11111111-1111-4111-8111-111111111111",
      revision: 1, mimeType: "video/mp4", sizeBytes: VENICE_REFERENCE_VIDEO_MAX_BYTES, sha256: "a".repeat(64), durationSeconds: 4 };
    const request = { model: VENICE_MEDIA_MODELS.seedanceReference, prompt: "Continue the flight", referenceImages: [], referenceVideos: [video] };
    expect(normalizeMediaGenerationRequest(request)).toMatchObject({ referenceVideos: [video] });
    expect(() => normalizeMediaGenerationRequest({ ...request, referenceVideos: [{ ...video, sizeBytes: video.sizeBytes + 1 }] })).toThrow(VENICE_REFERENCE_VIDEO_SIZE_WARNING);
  });

  test("preserves all Seedance 2.5 references within its published provider limits", () => {
    const image = {
      path: "refs/image.png", artifactId: "image", artifactInternalId: "11111111-1111-4111-8111-111111111111",
      revision: 1, mimeType: "image/png", sizeBytes: 1024, sha256: "a".repeat(64),
    };
    const referenceImages = Array.from({ length: 30 }, (_, index) => ({ ...image, path: `refs/image-${index}.png` }));
    const referenceVideos = Array.from({ length: 10 }, (_, index) => ({ ...image, path: `refs/video-${index}.mp4`, mimeType: "video/mp4", durationSeconds: 3 }));
    const request = { model: VENICE_MEDIA_MODELS.seedanceReference, prompt: "Use the ordered references.", referenceImages, referenceVideos };
    expect(normalizeMediaGenerationRequest(request)).toMatchObject({ referenceImages, referenceVideos });
    expect(toVeniceQuotePricingRequest(normalizeMediaGenerationRequest(request))).toMatchObject({ reference_video_total_duration: 30 });
    for (const invalid of [
      { ...request, referenceImages: [...referenceImages, image] },
      { ...request, referenceVideos: [...referenceVideos, referenceVideos[0]] },
      { ...request, referenceVideos: [{ ...referenceVideos[0], durationSeconds: 31 }] },
      { ...request, referenceVideos: [{ ...referenceVideos[0], durationSeconds: 1 }] },
      { ...request, referenceVideos: referenceVideos.map((video) => ({ ...video, durationSeconds: 4 })) },
    ]) expect(() => normalizeMediaGenerationRequest(invalid)).toThrow(MediaGenerationValidationError);
  });

  test("normalizes Seedance text-to-video with only supported combinations", () => {
    const request = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "  moonlit sea  ", durationSeconds: 30, resolution: "480p", aspectRatio: "9:16", audio: false });
    expect(request).toEqual({ model: VENICE_MEDIA_MODELS.seedance, prompt: "moonlit sea", durationSeconds: 30, resolution: "480p", aspectRatio: "9:16", audio: false });
    expect(toVeniceQuotePricingRequest(request)).toEqual({ model: VENICE_MEDIA_MODELS.seedance, duration: "30s", resolution: "480p", aspect_ratio: "9:16", audio: false });
  });

  test("accepts the live 1080p Seedance tier", () => {
    const request = normalizeMediaGenerationRequest({
      model: VENICE_MEDIA_MODELS.seedanceReference,
      prompt: "Use <Image 1> as the exact mark reference.",
      resolution: "1080p",
      referenceImages: [{
        path: "references/mark.png",
        artifactId: "workspace-mark",
        artifactInternalId: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        mimeType: "image/png",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
      }],
    });
    expect(toVeniceQuotePricingRequest(request)).toMatchObject({ resolution: "1080p" });
  });

  test("rejects Seedance bounds and MiniMax H3 audio control before quote", () => {
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "x", durationSeconds: 31 })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "x".repeat(15_001) })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxH3, prompt: "x", audio: false })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxH3, prompt: "x".repeat(7_001) })).toThrow(MediaGenerationValidationError);
    const h3 = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxH3, prompt: "moving fog", durationSeconds: 5, resolution: "2K" });
    expect(toVeniceQuotePricingRequest(h3)).toEqual({ model: VENICE_MEDIA_MODELS.minimaxH3, duration: "5s", aspect_ratio: "16:9", resolution: "2K" });
    expect(LOCKED_VENICE_MEDIA_MODEL_FACTS[VENICE_MEDIA_MODELS.minimaxH3].audio).toBe("forced_on");
  });

  test("keeps model-authored reference paths separate from server-bound artifacts", () => {
    const intent = normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.seedanceReference,
      prompt: "Refer to <Image 1> for lighting.",
      referenceImages: [{ path: "references/noir.png" }],
    });
    expect(intent).toMatchObject({ model: VENICE_MEDIA_MODELS.seedanceReference, referenceImages: [{ path: "references/noir.png" }] });
    expect(() => normalizeMediaGenerationRequest(intent)).toThrow(MediaGenerationValidationError);
    const bound = normalizeMediaGenerationRequest({
      ...intent,
      referenceImages: [{
        path: "references/noir.png",
        artifactId: "workspace-noir",
        artifactInternalId: "11111111-1111-4111-8111-111111111111",
        revision: 1,
        mimeType: "image/png",
        sizeBytes: 1024,
        sha256: "a".repeat(64),
      }],
    });
    expect(toVeniceQuotePricingRequest(bound)).toEqual({
      model: VENICE_MEDIA_MODELS.seedanceReference,
      duration: "10s",
      aspect_ratio: "16:9",
      resolution: "720p",
      audio: true,
    });
  });

  test("keeps Sonilo instrumental and validates its duration/prompt boundaries", () => {
    const sonilo = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.sonilo, prompt: "warm analog pulse" });
    expect(sonilo).toMatchObject({ durationSeconds: 90 });
    expect(toVeniceQuotePricingRequest(sonilo)).toEqual({ model: VENICE_MEDIA_MODELS.sonilo, duration_seconds: 90 });
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.sonilo, prompt: "x".repeat(4_097) })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.sonilo, prompt: "texture", lyrics: "not supported" })).toThrow(MediaGenerationValidationError);
    expect(LOCKED_VENICE_MEDIA_MODEL_FACTS[VENICE_MEDIA_MODELS.sonilo]).toMatchObject({ outputMime: "audio/mp4", outputExtension: "m4a" });
  });

  test("normalizes MiniMax Music lyrics/instrumental safely", () => {
    const song = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxMusic, prompt: "bright city pop with a gentle lift", lyrics: "Hello city" });
    expect(toVeniceQuotePricingRequest(song)).toEqual({ model: VENICE_MEDIA_MODELS.minimaxMusic });
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxMusic, prompt: "short" })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxMusic, prompt: "long enough music description", forceInstrumental: true, lyrics: "No vocals" })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.minimaxMusic, prompt: "long enough music description", durationSeconds: 30 })).toThrow(MediaGenerationValidationError);
  });

  test("normalizes only semantically empty music branch fields and preserves meaningful conflicts", () => {
    expect(normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.sonilo,
      prompt: "Warm analog pulse",
      durationSeconds: 5,
      lyrics: "",
      forceInstrumental: true,
    })).toEqual({
      model: VENICE_MEDIA_MODELS.sonilo,
      prompt: "Warm analog pulse",
      durationSeconds: 5,
    });

    expect(normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.minimaxMusic,
      prompt: "Warm analog pulse with a gentle rise",
      lyrics: "   ",
      forceInstrumental: true,
    })).toEqual({
      model: VENICE_MEDIA_MODELS.minimaxMusic,
      prompt: "Warm analog pulse with a gentle rise",
      forceInstrumental: true,
    });

    expect(() => normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.sonilo,
      prompt: "Warm analog pulse",
      lyrics: "Keep these words",
    })).toThrow("Choose MiniMax Music to preserve the requested lyrics");
    expect(() => normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.minimaxMusic,
      prompt: "Warm analog pulse with a gentle rise",
      durationSeconds: 10,
      lyrics: "",
      forceInstrumental: true,
    })).toThrow("Remove durationSeconds or choose Sonilo to preserve the duration");
  });

  test("normalizes the explicit video generation discriminator without losing paid settings", () => {
    const liveEquivalent = {
      action: "generate",
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "A kitten playing in soft daylight",
      durationSeconds: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: false,
      filename: "kitten.mp4",
      referenceImages: [],
      referenceVideos: [],
    } as const;
    expect(normalizeMediaGenerationIntent(liveEquivalent)).toEqual({
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "A kitten playing in soft daylight",
      durationSeconds: 5,
      resolution: "720p",
      aspectRatio: "16:9",
      audio: false,
      filename: "kitten.mp4",
    });
    expect(() => normalizeMediaGenerationIntent({ ...liveEquivalent, action: "prepare" })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationIntent({
      ...liveEquivalent,
      referenceImages: [{ path: "references/meaningful.png" }],
    })).toThrow(MediaGenerationValidationError);

    expect(normalizeMediaGenerationIntent({
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "A compatible legacy request",
      referenceImages: [],
      referenceVideos: [],
    })).toMatchObject({
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "A compatible legacy request",
    });
    expect(() => normalizeMediaGenerationIntent({
      action: "generate",
      model: VENICE_MEDIA_MODELS.minimaxH3,
      prompt: "A misty forest in motion",
      referenceImages: [],
      referenceVideos: [],
      audio: false,
    })).toThrow("audio");
    expect(() => normalizeMediaGenerationIntent({
      action: "unknown",
      model: VENICE_MEDIA_MODELS.seedance,
      prompt: "Do not reinterpret this action",
    })).toThrow(MediaGenerationValidationError);
    expect(() => normalizeMediaGenerationIntent({
      action: "generate",
      model: VENICE_MEDIA_MODELS.sonilo,
      prompt: "Do not expand the video action into music",
    })).toThrow(MediaGenerationValidationError);
  });

  test("rejects unsafe filenames and returns only opaque public receipts", () => {
    expect(() => normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "scene", filename: "../video.mp4" })).toThrow(MediaGenerationValidationError);
    const receipt = publicMediaGenerationReceipt({ generationId: "mg_0123456789abcdef", kind: "video", model: VENICE_MEDIA_MODELS.seedance, status: "queued" });
    expect(receipt).toEqual({ generationId: "mg_0123456789abcdef", kind: "video", model: VENICE_MEDIA_MODELS.seedance, status: "queued" });
    expect(() => publicMediaGenerationReceipt({ ...receipt, generationId: "provider_queue_123" })).toThrow(MediaGenerationValidationError);
  });

  test("approval binding changes when any paid input or quote changes", () => {
    const request = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "a sailboat" });
    const digest = mediaGenerationApprovalDigest(request, 0.12);
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    expect(digest).not.toBe(mediaGenerationApprovalDigest(request, 0.13));
    const changed = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "a sailboat", durationSeconds: 6 });
    expect(digest).not.toBe(mediaGenerationApprovalDigest(changed, 0.12));
    const creativeDrift = normalizeMediaGenerationRequest({ model: VENICE_MEDIA_MODELS.seedance, prompt: "a fishing boat" });
    expect(digest).not.toBe(mediaGenerationApprovalDigest(creativeDrift, 0.12));
  });
});
