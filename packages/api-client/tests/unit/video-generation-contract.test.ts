import { describe, expect, test } from "bun:test";
import {
  videoGenerationPrepareRequestV1Schema,
  videoGenerationReviewDtoV1Schema,
  videoGenerationTakeStatusDtoV1Schema,
  videoGenerationTakeListDtoV1Schema,
} from "../../src/media-generations";

function reviewWithReferences() {
  return {
    takeId: `take_${"t".repeat(16)}`,
    reviewHandle: "reviewhandle1234",
    approval: {
      version: "media-generation-approval-v1" as const,
      digest: "a".repeat(64),
      quoteDigest: "b".repeat(64),
      revision: 1 as const,
      expiresAt: "2026-09-14T12:28:27.471Z",
      preview: {
        mediaKind: "video" as const,
        model: "seedance-2-5-reference-to-video-basic" as const,
        settings: {
          durationSeconds: 12,
          aspectRatio: "16:9" as const,
          resolution: "1080p" as const,
          audio: true,
          referenceImages: 1,
          referenceVideos: 1,
          referenceVideoSeconds: 4,
        },
        referenceImages: [{
          index: 1,
          artifactId: "fixture-image-1",
          label: "fixture-1.png",
          content: { sha256: "c".repeat(64), sizeBytes: 1_024, mimeType: "image/png" as const },
        }],
        referenceVideos: [{
          index: 1,
          artifactId: "fixture-video-1",
          label: "fixture-1.mp4",
          durationSeconds: 4,
          content: { sha256: "d".repeat(64), sizeBytes: 2_048, mimeType: "video/mp4" as const },
        }],
        prompt: { characterCount: 16, summary: "A test landscape", truncated: false },
        quote: { currency: "USD" as const, amountMicros: 6_140_000, display: "USD 6.140000" },
        spendNotice: "Approving starts a paid generation using this exact quote." as const,
      },
    },
  };
}

describe("Video generation parent-host contracts", () => {
  test("round-trips canonical image and video reference fingerprints while retaining legacy compatibility", () => {
    const review = reviewWithReferences();
    expect(videoGenerationReviewDtoV1Schema.parse(review)).toEqual(review);

    const legacy = structuredClone(review);
    delete (legacy.approval.preview.referenceImages[0]! as { content?: unknown }).content;
    delete (legacy.approval.preview.referenceVideos[0]! as { content?: unknown }).content;
    expect(videoGenerationReviewDtoV1Schema.parse(legacy)).toEqual(legacy);
  });

  test("retains audio donors and their approved content without accepting transport URLs", () => {
    const original = reviewWithReferences();
    const reference = { index: 1, artifactId: "fixture-audio-1", label: "dialogue.mp3", durationSeconds: 4,
      content: { sha256: "e".repeat(64), sizeBytes: 2048, mimeType: "audio/mpeg" as const } };
    const review = { ...original, approval: { ...original.approval, preview: { ...original.approval.preview,
      settings: { ...original.approval.preview.settings, referenceAudios: 1, referenceAudioSeconds: 4 },
      referenceAudios: [reference] } } };
    expect(videoGenerationReviewDtoV1Schema.parse(review)).toEqual(review);
    for (const content of [{ ...reference.content, mimeType: "video/mp4" }, { ...reference.content, url: "https://provider.invalid/audio" }]) {
      expect(videoGenerationReviewDtoV1Schema.safeParse({ ...review, approval: { ...review.approval,
        preview: { ...review.approval.preview, referenceAudios: [{ ...reference, content }] } } }).success).toBe(false);
    }
    const request = { roomId: "room-1", projectArtifactId: "artifact-1", requestId: "request-1", shotId: "shot-1", shotLabel: "Opening",
      briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 1,
      job: { modelId: "venice:seedance-2-5-reference-to-video-basic" as const, prompt: "Follow <Audio 1>",
        referenceImages: [{ path: "subject.png" }], referenceAudios: [{ path: "dialogue.mp3" }] } };
    expect(videoGenerationPrepareRequestV1Schema.parse(request)).toEqual(request);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...request, job: { ...request.job,
      referenceAudios: [{ path: "dialogue.mp3", durationSeconds: 4 }] } }).success).toBe(false);
  });

  test("rejects malformed reference fingerprints", () => {
    const review = reviewWithReferences();
    const invalidContent = [
      { sha256: "C".repeat(64), sizeBytes: 1_024, mimeType: "image/png" },
      { sha256: "c".repeat(63), sizeBytes: 1_024, mimeType: "image/png" },
      { sha256: "c".repeat(64), sizeBytes: 0, mimeType: "image/png" },
      { sha256: "c".repeat(64), sizeBytes: 1.5, mimeType: "image/png" },
      { sha256: "c".repeat(64), sizeBytes: Number.MAX_SAFE_INTEGER + 1, mimeType: "image/png" },
    ];
    for (const content of invalidContent) {
      const candidate = structuredClone(review);
      candidate.approval.preview.referenceImages[0]!.content = content as typeof candidate.approval.preview.referenceImages[0]["content"];
      expect(videoGenerationReviewDtoV1Schema.safeParse(candidate).success).toBe(false);
    }
  });

  test("rejects media-kind mismatches and unknown reference content fields", () => {
    const review = reviewWithReferences();
    const videoAsImage = structuredClone(review);
    videoAsImage.approval.preview.referenceImages[0]!.content.mimeType = "video/mp4" as "image/png";
    expect(videoGenerationReviewDtoV1Schema.safeParse(videoAsImage).success).toBe(false);

    const imageAsVideo = structuredClone(review);
    imageAsVideo.approval.preview.referenceVideos[0]!.content.mimeType = "image/png" as "video/mp4";
    expect(videoGenerationReviewDtoV1Schema.safeParse(imageAsVideo).success).toBe(false);

    const unknown = structuredClone(review) as unknown as Record<string, unknown>;
    const preview = (unknown["approval"] as { preview: { referenceImages: Array<{ content: Record<string, unknown> }> } }).preview;
    preview.referenceImages[0]!.content["storagePath"] = "/private/reference.png";
    expect(videoGenerationReviewDtoV1Schema.safeParse(unknown).success).toBe(false);
  });

  test("accepts only the closed compiled video job shape", () => {
    const base = {
      roomId: "room-1", projectArtifactId: "artifact-1", requestId: "request-1", shotId: "shot-1", shotLabel: "Opening",
      briefDigest: `sha256:${"a".repeat(64)}`, documentRevision: 1,
      // Matches the Video compiler wire: catalog model and only the settings a human requested.
      job: { modelId: "venice:seedance-2-5-text-to-video-basic", prompt: "A bird crosses a blue sky." },
    };
    expect(videoGenerationPrepareRequestV1Schema.safeParse(base).success).toBe(true);
    expect(videoGenerationPrepareRequestV1Schema.parse({ ...base, job: { ...base.job, prompt: "景".repeat(15_000) } }).job.prompt).toBe("景".repeat(15_000));
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, job: { ...base.job, prompt: " " } }).success).toBe(false);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, intent: {} }).success).toBe(false);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, job: { ...base.job, providerId: "secret" } }).success).toBe(false);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, shotId: "shot!" }).success).toBe(false);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, shotLabel: "あ".repeat(85) }).success).toBe(true);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, shotLabel: "あ".repeat(1000) }).success).toBe(true);
    expect(videoGenerationPrepareRequestV1Schema.safeParse({ ...base, shotLabel: "Bad\nlabel" }).success).toBe(false);
  });

  test("take status excludes the private receipt handle", () => {
    const safe = {
      takeId: `take_${"a".repeat(16)}`, dtoVersion: 1, revision: 1, mediaKind: "video", state: "queued",
      modelId: "seedance-2-5-text-to-video-basic", settings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audioEnabled: true },
      recoveryActions: [],
    };
    expect(videoGenerationTakeStatusDtoV1Schema.safeParse(safe).success).toBe(true);
    expect(videoGenerationTakeStatusDtoV1Schema.safeParse({ ...safe, receiptId: "mg_private" }).success).toBe(false);
  });

  test("take discovery preserves every retained take and its complete display label", () => {
    const takes = Array.from({ length: 513 }, (_, index) => ({
      takeId: `take_${String(index).padStart(16, "0")}`,
      shotId: `shot-${index}`, shotLabel: "Scene description ".repeat(50), documentRevision: index,
    }));
    expect(videoGenerationTakeListDtoV1Schema.parse({ takes }).takes).toEqual(takes);
    expect(videoGenerationTakeListDtoV1Schema.safeParse({ takes: [{ ...takes[0], receiptId: "private" }] }).success).toBe(false);
  });
});
