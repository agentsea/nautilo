import { describe, expect, test } from "bun:test";
import {
  isMediaGenerationApproval,
  isMediaGenerationPreparedApproval,
} from "./media-generation-approval";

const approval = {
  version: "media-generation-approval-v1",
  digest: "a".repeat(64),
  quoteDigest: "b".repeat(64),
  revision: 1,
  expiresAt: "2099-01-01T00:00:00.000Z",
  preview: {
    mediaKind: "video",
    model: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true },
    prompt: { characterCount: 13, summary: "Ocean at dusk", truncated: false },
    quote: { currency: "USD", amountMicros: 1_250_000, display: "USD 1.250000" },
    spendNotice: "Approving starts a paid generation using this exact quote.",
  },
} as const;

describe("D525 media generation approval envelope", () => {
  test("preview content is a strict quote binding, not a provider URL or arbitrary blob", () => {
    const reference = { index: 1, artifactId: "public-image", label: "Subject", content: { sha256: "a".repeat(64), sizeBytes: 24, mimeType: "image/png" } };
    const value = { ...approval, preview: { ...approval.preview, model: "seedance-2-5-reference-to-video-basic", settings: { ...approval.preview.settings, referenceImages: 1 }, referenceImages: [reference] } };
    expect(isMediaGenerationApproval(value)).toBe(true);
    for (const content of [{ ...reference.content, sha256: "bad" }, { ...reference.content, sizeBytes: 0 }, { ...reference.content, mimeType: "text/html" }, { ...reference.content, url: "https://provider.invalid/file" }]) {
      expect(isMediaGenerationApproval({ ...value, preview: { ...value.preview, referenceImages: [{ ...reference, content }] } })).toBe(false);
    }
  });
  test("video reference approval exposes measured duration and rejects mismatched counts or private fields", () => {
    const value = { ...approval, preview: { ...approval.preview, model: "seedance-2-5-reference-to-video-basic",
      settings: { ...approval.preview.settings, referenceVideos: 1, referenceVideoSeconds: 5.25 }, referenceImages: [],
      referenceVideos: [{ index: 1, artifactId: "public-video", label: "motion.mp4", durationSeconds: 5.25 }] } };
    expect(isMediaGenerationApproval(value)).toBe(true);
    expect(isMediaGenerationApproval({ ...value, preview: { ...value.preview, settings: { ...value.preview.settings, referenceVideoSeconds: 6 } } })).toBe(false);
    expect(isMediaGenerationApproval({ ...value, preview: { ...value.preview, referenceVideos: [{ ...value.preview.referenceVideos[0], storageUri: "file:///private" }] } })).toBe(false);
  });
  test("accepts the exact bounded public projection", () => {
    expect(isMediaGenerationApproval(approval)).toBe(true);
    expect(isMediaGenerationApproval({
      ...approval,
      preview: { ...approval.preview, settings: { ...approval.preview.settings, resolution: "1080p" } },
    })).toBe(true);
  });

  test("rejects provider URLs and unexpected settings", () => {
    expect(isMediaGenerationApproval({
      ...approval,
      preview: {
        ...approval.preview,
        prompt: { ...approval.preview.prompt, summary: "https://provider.example/job/1" },
      },
    })).toBe(false);
    expect(isMediaGenerationApproval({
      ...approval,
      preview: { ...approval.preview, settings: { queueId: "provider-1" } },
    })).toBe(false);
    expect(isMediaGenerationApproval({
      ...approval,
      preview: {
        ...approval.preview,
        prompt: { ...approval.preview.prompt, summary: "blob:private-artifact" },
      },
    })).toBe(false);
    expect(isMediaGenerationApproval({
      ...approval,
      preview: {
        ...approval.preview,
        settings: { ...approval.preview.settings, durationSeconds: 1.5 },
      },
    })).toBe(false);
  });

  test("accepts only ordered safe reference labels for Advanced Seedance approval", () => {
    const referenceApproval = {
      ...approval,
      preview: {
        ...approval.preview,
        model: "seedance-2-5-reference-to-video-basic",
        settings: { ...approval.preview.settings, referenceImages: 1 },
        referenceImages: [{ index: 1, artifactId: "workspace-noir", label: "noir.png" }],
      },
    };
    expect(isMediaGenerationApproval(referenceApproval)).toBe(true);
    expect(isMediaGenerationApproval({
      ...referenceApproval,
      preview: { ...referenceApproval.preview, referenceImages: [{ index: 2, artifactId: "workspace-noir", label: "noir.png" }] },
    })).toBe(false);
    expect(isMediaGenerationApproval({
      ...referenceApproval,
      preview: { ...referenceApproval.preview, referenceImages: [{ index: 1, artifactId: "workspace-noir", label: "https://provider.example/noir.png" }] },
    })).toBe(false);
  });

  test("requires integer USD micros and strict prepared keys", () => {
    const prepared = {
      version: "media-generation-prepared-v1",
      binding: {
        userId: "user-1", roomId: "room-1", threadId: "thread-1", turnId: "turn-1",
        laneKey: "lane-1", toolCallId: "call-1", toolName: "generate_video",
        origin: { kind: "genie_tool", threadId: "thread-1", turnId: "turn-1", laneKey: "lane-1", toolCallId: "call-1", toolName: "generate_video" },
        approvalId: "approval-1", approvalDigest: approval.digest,
        receiptId: "mg_1234567890abcdef",
        quoteDigest: approval.quoteDigest, revision: 1, expiresAt: approval.expiresAt,
      },
      request: { model: approval.preview.model, prompt: "Ocean at dusk" },
      quoteUsdMicros: approval.preview.quote.amountMicros,
      preview: approval.preview,
    };
    expect(isMediaGenerationPreparedApproval(prepared)).toBe(true);
    expect(isMediaGenerationPreparedApproval({ ...prepared, quoteUsdMicros: 1.5 })).toBe(false);
    expect(isMediaGenerationPreparedApproval({ ...prepared, providerUrl: "https://example.test" })).toBe(false);
  });

  test("accepts the closed Video origin without synthetic graph ids", () => {
    const prepared = {
      version: "media-generation-prepared-v1",
      binding: {
        userId: "user-1", roomId: "room-1",
        origin: { kind: "video_app", projectArtifactId: "11111111-1111-4111-8111-111111111111", requestId: "22222222-2222-4222-8222-222222222222" },
        approvalId: "video:22222222-2222-4222-8222-222222222222", approvalDigest: approval.digest,
        receiptId: "mg_1234567890abcdef", quoteDigest: approval.quoteDigest, revision: 1, expiresAt: approval.expiresAt,
      },
      request: { model: approval.preview.model, prompt: "Ocean at dusk", durationSeconds: 5, aspectRatio: "16:9", resolution: "720p", audio: true },
      quoteUsdMicros: approval.preview.quote.amountMicros,
      preview: approval.preview,
    };
    expect(isMediaGenerationPreparedApproval(prepared)).toBe(true);
    expect(isMediaGenerationPreparedApproval({ ...prepared, binding: { ...prepared.binding, threadId: "fake-turn" } })).toBe(false);
  });
});
