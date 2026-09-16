import { describe, expect, test } from "bun:test";
import { validateGeneratedTake, validateGeneratedTakes, type GeneratedTake } from "./generation-takes";

export function sampleGeneratedTake(overrides: Partial<GeneratedTake> = {}): GeneratedTake {
  return {
    id: "take_abcdefghijklmnop",
    briefRevision: 4,
    shotId: "shot-opening",
    shotLabel: "Opening move",
    mediaKind: "video",
    modelId: "seedance-2-5-text-to-video-basic",
    settings: { durationSeconds: 5, resolution: "720p", aspectRatio: "16:9", audioEnabled: true },
    artifact: {
      artifactId: "48a0266d-b1c2-4ffd-9c10-2865bea8fc53",
      path: "generated-media/take-opening.mp4",
      zone: "workspace",
      mime: "video/mp4",
      bytes: 1_024,
    },
    ...overrides,
  };
}

describe("GeneratedTake document projection", () => {
  test("copies only the safe completed-take projection", () => {
    const take = sampleGeneratedTake();
    expect(validateGeneratedTake(take)).toEqual(take);
  });

  test("rejects receipts, provider topology, URLs, and artifact internals", () => {
    const receipt = { ...sampleGeneratedTake(), receiptId: "mg_abcdefghijklmnop" };
    expect(() => validateGeneratedTake(receipt)).toThrow("receiptId is not supported");

    const internal = { ...sampleGeneratedTake(), artifact: { ...sampleGeneratedTake().artifact, internalId: "internal-row" } };
    expect(() => validateGeneratedTake(internal)).toThrow("internalId is not supported");

    const url = { ...sampleGeneratedTake(), artifact: { ...sampleGeneratedTake().artifact, path: "https://provider.test/video.mp4" } };
    expect(() => validateGeneratedTake(url)).toThrow("logical Workspace path");
  });

  test("requires media-kind/mime coherence and a local opaque take handle", () => {
    expect(() => validateGeneratedTake({ ...sampleGeneratedTake(), id: "mg_provider_receipt" })).toThrow("local opaque take handle");
    expect(() => validateGeneratedTake({ ...sampleGeneratedTake(), mediaKind: "audio" })).toThrow("must match the take media kind");
  });

  test("rejects duplicate take and Workspace artifact identity", () => {
    const take = sampleGeneratedTake();
    expect(() => validateGeneratedTakes([take, take])).toThrow("repeats take id");
    expect(() => validateGeneratedTakes([take, { ...take, id: "take_bcdefghijklmnopq" }])).toThrow("repeats a Workspace artifact");
  });
});
