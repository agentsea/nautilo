import { describe, expect, test } from "bun:test";
import assert from "node:assert/strict";
import { VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING } from "@nautilo/types";
import type { DirectDatabase, MediaGenerationAdmissionProof } from "@nautilo/db";
import sharp from "sharp";
import { referenceMovieFixture } from "./reference-video-metadata.test";
import { normalizeMediaGenerationIntent, toVeniceQuotePricingRequest } from "../../../agent/src/media-generation/contracts";
import {
  resolveApprovedReferenceImageUrls,
  resolveApprovedReferenceMediaUrls,
  resolveMediaGenerationReferenceRequest,
  type MediaReferenceArtifactOperations,
} from "../../src/media-generation/reference-request";

const internalId = "11111111-1111-4111-8111-111111111111";
const scope = {
  ownerId: "22222222-2222-4222-8222-222222222222",
  roomId: "33333333-3333-4333-8333-333333333333",
  namespaceId: "44444444-4444-4444-8444-444444444444",
};

async function harness() {
  const bytes = new Uint8Array(await sharp({
    create: { width: 400, height: 400, channels: 3, background: "#223344" },
  }).png().toBuffer());
  const artifact = {
    id: internalId,
    artifactId: "workspace-image-1",
    path: "references/noir.png",
    mimeType: "image/png",
    size: bytes.byteLength,
    storageUri: "file:///test/noir.png",
    revision: 3,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    deletedAt: null,
  };
  const operations = {
    findByPath: async () => artifact,
    findByInternalId: async () => artifact,
    readBytes: async () => bytes,
  } as unknown as MediaReferenceArtifactOperations;
  return { artifact, bytes, operations };
}

describe("Seedance reference request authority", () => {
  test.each([512, 513, 4096])("resolves %i-character paths in namespace and revalidates ordered approved bytes", async (length) => {
    const { artifact, bytes, operations } = await harness();
    artifact.path = "refs/" + "a".repeat(length - 9) + ".png";
    const videoBytes = referenceMovieFixture();
    const video = { ...artifact, id: "55555555-5555-4555-8555-555555555555", artifactId: "video-public",
      path: artifact.path.replace(/png$/, "mp4"), mimeType: "video/mp4", size: videoBytes.length, storageUri: "file:///test/video.mp4" };
    const ops: MediaReferenceArtifactOperations = {
      ...operations,
      findByPath: async (query) => {
        expect(query.readableNamespaceIds).toEqual([scope.namespaceId]);
        return [artifact, video].find(item => item.path === query.path) ?? null;
      },
      findByInternalId: async (query) => {
        expect(query.mutableNamespaceIds).toEqual([scope.namespaceId]);
        return [artifact, video].find(item => item.id === query.internalId) ?? null;
      },
      readBytes: async (uri) => uri === video.storageUri ? videoBytes : bytes,
    };
    const intent = normalizeMediaGenerationIntent({ model: "seedance-2-5-reference-to-video-basic", prompt: "Continue <Video 1> using <Image 1>",
      referenceImages: [{ path: artifact.path }], referenceVideos: [{ path: video.path }] });
    const request = await resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent, ops);
    if (request.model !== "seedance-2-5-reference-to-video-basic") throw new Error("Expected references");
    expect(request.referenceImages[0]?.path).toBe(artifact.path);
    expect(request.referenceVideos?.[0]?.path).toBe(video.path);
    const proof = JSON.parse(JSON.stringify({ ...scope, requestPayload: { ...request, version: 1, normalizedSettings: {} } })) as MediaGenerationAdmissionProof;
    const delivery = await resolveApprovedReferenceMediaUrls({} as DirectDatabase, proof, ops);
    expect(delivery.images).toEqual([`data:image/png;base64,${Buffer.from(bytes).toString("base64")}`]);
    expect(delivery.videos).toEqual([`data:video/mp4;base64,${Buffer.from(videoBytes).toString("base64")}`]);
    await assert.rejects(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent,
      { ...ops, findByPath: async () => null }), /Workspace/);
    await assert.rejects(resolveApprovedReferenceMediaUrls({} as DirectDatabase, proof,
      { ...ops, findByInternalId: async () => null }), /available/);
    artifact.revision++;
    await assert.rejects(resolveApprovedReferenceMediaUrls({} as DirectDatabase, proof, ops), /changed/);
  });

  test("warns from authorized artifact size before reading or preparing an oversized video", async () => {
    const { artifact, operations } = await harness();
    Object.assign(artifact, { mimeType: "video/mp4", size: VENICE_REFERENCE_VIDEO_MAX_BYTES + 1, path: "refs/flight.mp4" });
    const before = { ...artifact };
    let reads = 0;
    await assert.rejects(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope,
      normalizeMediaGenerationIntent({ model: "seedance-2-5-reference-to-video-basic", prompt: "Continue the flight", referenceVideos: [{ path: artifact.path }] }),
      { ...operations, readBytes: async () => { reads++; throw new Error("Must not read oversized reference"); } },
    ), { message: VENICE_REFERENCE_VIDEO_SIZE_WARNING });
    expect(reads).toBe(0);
    expect(artifact).toEqual(before);
  });

  test("video-only references bind measured bytes, affect exact price, and reject changed admission bytes", async () => {
    const { artifact, operations } = await harness();
    const bytes = referenceMovieFixture();
    Object.assign(artifact, { mimeType: "video/mp4", size: bytes.length, path: "refs/motion.mp4" });
    const ops = { ...operations, readBytes: async () => bytes };
    const request = await resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope,
      normalizeMediaGenerationIntent({ model: "seedance-2-5-reference-to-video-basic", prompt: "Extend <Video 1>, walk outside",
        referenceVideos: [{ path: artifact.path }] }), ops);
    if (request.model !== "seedance-2-5-reference-to-video-basic") throw new Error("Expected reference model");
    expect(request.referenceImages).toEqual([]);
    expect(request.referenceVideos?.[0]).toMatchObject({ durationSeconds: 5.25, revision: 3, sizeBytes: bytes.length });
    expect(toVeniceQuotePricingRequest(request)).toMatchObject({ reference_video_total_duration: 5.25 });
    const proof = { ...scope, requestPayload: { version: 1, model: request.model, prompt: request.prompt,
      referenceImages: request.referenceImages, referenceVideos: request.referenceVideos, normalizedSettings: {} } } as unknown as MediaGenerationAdmissionProof;
    const delivery = await resolveApprovedReferenceMediaUrls({} as DirectDatabase, proof, ops);
    expect(delivery.images).toEqual([]);
    expect(delivery.videos[0]).toStartWith("data:video/mp4;base64,");
    artifact.revision++;
    await assert.rejects(resolveApprovedReferenceMediaUrls({} as DirectDatabase, proof, ops), /changed/u);
  });
  test("rejects oversized combined duration, unsupported codecs and out-of-namespace references before quote", async () => {
    const { artifact, operations } = await harness();
    const bytes = referenceMovieFixture(20);
    Object.assign(artifact, { mimeType: "video/mp4", size: bytes.length });
    const ops = { ...operations, readBytes: async () => bytes };
    const intent = normalizeMediaGenerationIntent({ model: "seedance-2-5-reference-to-video-basic", prompt: "Use video",
      referenceVideos: [{ path: "refs/one.mp4" }, { path: "refs/two.mp4" }] });
    await assert.rejects(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent, ops), /30 seconds/u);
    await assert.rejects(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent, { ...ops, findByPath: async () => null } as unknown as MediaReferenceArtifactOperations), /Workspace/u);
    const invalid = referenceMovieFixture(5, "vp09");
    Object.assign(artifact, { size: invalid.length });
    await assert.rejects(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent, { ...ops, readBytes: async () => invalid }), /H\.264/u);
  });
  test("upgrades ordered Workspace paths to immutable bindings without embedding bytes", async () => {
    const { artifact, operations } = await harness();
    const request = await resolveMediaGenerationReferenceRequest(
      {} as DirectDatabase,
      scope,
      {
        model: "seedance-2-5-reference-to-video-basic",
        prompt: "Refer to the lighting and composition in <Image 1>.",
        durationSeconds: 10,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: true,
        referenceImages: [{ path: artifact.path }],
      },
      operations,
    );
    if (request.model !== "seedance-2-5-reference-to-video-basic") throw new Error("expected reference request");
    expect(request.referenceImages[0]).toMatchObject({
      artifactId: artifact.artifactId,
      artifactInternalId: artifact.id,
      revision: 3,
      mimeType: "image/png",
      sizeBytes: artifact.size,
    });
    expect(request.referenceImages[0]?.sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(JSON.stringify(request)).not.toContain("data:image");
  });

  test("delivers undersized WebP references as deterministic provider-safe PNGs", async () => {
    const bytes = new Uint8Array(await sharp({
      create: { width: 256, height: 256, channels: 4, background: "#556677ff" },
    }).webp().toBuffer());
    const artifact = {
      id: internalId,
      artifactId: "workspace-avatar-1",
      path: "references/avatar.webp",
      mimeType: "image/webp",
      size: bytes.byteLength,
      storageUri: "file:///test/avatar.webp",
      revision: 1,
      createdAt: new Date(0),
      updatedAt: new Date(0),
      deletedAt: null,
    };
    const operations = {
      findByPath: async () => artifact,
      findByInternalId: async () => artifact,
      readBytes: async () => bytes,
    } as unknown as MediaReferenceArtifactOperations;
    const request = await resolveMediaGenerationReferenceRequest(
      {} as DirectDatabase,
      scope,
      {
        model: "seedance-2-5-reference-to-video-basic",
        prompt: "Use <Image 1> as the character reference.",
        durationSeconds: 5,
        aspectRatio: "16:9",
        resolution: "1080p",
        audio: true,
        referenceImages: [{ path: artifact.path }],
      },
      operations,
    );
    if (request.model !== "seedance-2-5-reference-to-video-basic") throw new Error("expected reference request");
    expect(request.referenceImages[0]).toMatchObject({ mimeType: "image/webp", sizeBytes: bytes.byteLength });
    const proof = {
      ...scope,
      receiptId: "mg_abcdefghijklmnop",
      revision: 1,
      admissionToken: "55555555-5555-4555-8555-555555555555",
      kind: "video",
      providerModel: request.model,
      requestPayload: {
        version: 1,
        model: request.model,
        prompt: request.prompt,
        referenceImages: request.referenceImages,
        normalizedSettings: {
          durationSeconds: request.durationSeconds,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          audioEnabled: request.audio,
        },
      },
    } as unknown as MediaGenerationAdmissionProof;
    const urls = await resolveApprovedReferenceImageUrls({} as DirectDatabase, proof, operations);
    expect(urls[0]).toStartWith("data:image/png;base64,");
    const delivered = Buffer.from(urls[0]!.split(",", 2)[1]!, "base64");
    expect(await sharp(delivered).metadata()).toMatchObject({ format: "png", width: 300, height: 300 });
  });

  test("re-reads exact approved bytes only at admission and rejects substitution", async () => {
    const { artifact, operations } = await harness();
    const request = await resolveMediaGenerationReferenceRequest(
      {} as DirectDatabase,
      scope,
      {
        model: "seedance-2-5-reference-to-video-basic",
        prompt: "Use <Image 1> as the visual reference.",
        durationSeconds: 8,
        aspectRatio: "16:9",
        resolution: "720p",
        audio: false,
        referenceImages: [{ path: artifact.path }],
      },
      operations,
    );
    if (request.model !== "seedance-2-5-reference-to-video-basic") throw new Error("expected reference request");
    const proof = {
      ...scope,
      receiptId: "mg_abcdefghijklmnop",
      revision: 1,
      admissionToken: "55555555-5555-4555-8555-555555555555",
      kind: "video",
      providerModel: request.model,
      requestPayload: {
        version: 1,
        model: request.model,
        prompt: request.prompt,
        referenceImages: request.referenceImages,
        normalizedSettings: {
          durationSeconds: request.durationSeconds,
          aspectRatio: request.aspectRatio,
          resolution: request.resolution,
          audioEnabled: request.audio,
        },
      },
    } as unknown as MediaGenerationAdmissionProof;
    const urls = await resolveApprovedReferenceImageUrls({} as DirectDatabase, proof, operations);
    expect(urls).toHaveLength(1);
    expect(urls[0]).toStartWith("data:image/png;base64,");

    const changed = { ...operations, readBytes: async () => new Uint8Array([1, 2, 3]) };
    expect(resolveApprovedReferenceImageUrls({} as DirectDatabase, proof, changed)).rejects.toThrow("changed");
  });

  test("rejects person-workflow-hostile dimensions and duplicate paths before quote", async () => {
    const { artifact, operations } = await harness();
    const intent = {
      model: "seedance-2-5-reference-to-video-basic" as const,
      prompt: "Use the ordered references.",
      durationSeconds: 8,
      aspectRatio: "16:9" as const,
      resolution: "720p" as const,
      audio: false,
      referenceImages: [{ path: artifact.path }, { path: artifact.path }],
    };
    expect(resolveMediaGenerationReferenceRequest({} as DirectDatabase, scope, intent, operations)).rejects.toThrow("once");
  });
});
