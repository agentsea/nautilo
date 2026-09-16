import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MediaGenerationValidationError,
  normalizeMediaGenerationRequest,
  type NormalizedMediaGenerationIntent,
  type NormalizedMediaGenerationRequest,
} from "@nautilo/agent";
import { getArtifactsRoot } from "@nautilo/config";
import {
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findArtifactByPathForNamespaces,
  type DirectDatabase,
  type MediaGenerationAdmissionProof,
  type MediaGenerationReferenceImageBinding,
  type MediaGenerationScope,
} from "@nautilo/db";
import sharp from "sharp";
import { VENICE_REFERENCE_VIDEO_MAX_BYTES, VENICE_REFERENCE_VIDEO_SIZE_WARNING } from "@nautilo/types";
import { inspectReferenceVideo } from "./reference-video-metadata";

const MAX_REFERENCE_BYTES = 30 * 1024 * 1024;
const MAX_QUEUE_JSON_BYTES = 35 * 1024 * 1024;
const MIN_IMAGE_SIDE = 300;
const MIN_ASPECT_RATIO = 0.4;
const MAX_ASPECT_RATIO = 2.5;
const ALLOWED_MIME = new Set([
  "image/jpeg", "image/png", "image/webp", "image/bmp", "image/tiff", "image/gif", "image/heic", "image/heif",
]);

export interface MediaReferenceArtifactOperations {
  readonly findByPath: typeof findArtifactByPathForNamespaces;
  readonly findByInternalId: typeof findArtifactByInternalIdForNamespacesIncludingDeleted;
  readonly readBytes: (storageUri: string) => Promise<Uint8Array>;
}

async function confinedRead(storageUri: string): Promise<Uint8Array> {
  if (!storageUri.startsWith("file://")) throw new MediaGenerationValidationError("Reference image is not stored locally.");
  const root = await realpath(getArtifactsRoot());
  const candidate = await realpath(fileURLToPath(storageUri));
  const edge = relative(root, candidate);
  if (edge === "" || edge === ".." || edge.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || resolve(root, edge) !== candidate) {
    throw new MediaGenerationValidationError("Reference image is outside the Workspace media root.");
  }
  return new Uint8Array(await readFile(candidate));
}

const DEFAULT_OPERATIONS: MediaReferenceArtifactOperations = {
  findByPath: findArtifactByPathForNamespaces,
  findByInternalId: findArtifactByInternalIdForNamespacesIncludingDeleted,
  readBytes: confinedRead,
};

function assertArtifactShape(artifact: {
  readonly mimeType: string | null;
  readonly size: number | null;
  readonly storageUri: string | null;
}): asserts artifact is { mimeType: string; size: number; storageUri: string } {
  if (!artifact.mimeType || !ALLOWED_MIME.has(artifact.mimeType) || !artifact.storageUri ||
      !Number.isSafeInteger(artifact.size) || artifact.size === null || artifact.size < 1 || artifact.size > MAX_REFERENCE_BYTES) {
    throw new MediaGenerationValidationError("Reference image must be a supported Workspace image no larger than 30 MB.");
  }
}

type PreparedReferenceImage = Readonly<{ mimeType: string; bytes: Uint8Array }>;

async function prepareReferenceImage(bytes: Uint8Array, expectedMimeType: string): Promise<PreparedReferenceImage> {
  let metadata: Awaited<ReturnType<ReturnType<typeof sharp>["metadata"]>>;
  try {
    metadata = await sharp(bytes, { limitInputPixels: 100_000_000 }).metadata();
  } catch {
    throw new MediaGenerationValidationError("Reference image could not be decoded safely.");
  }
  const width = metadata.width;
  const height = metadata.height;
  const formatMime = metadata.format === "jpeg" ? "image/jpeg"
    : metadata.format === "tiff" ? "image/tiff"
      : metadata.format === "heif" ? new Set(["image/heic", "image/heif"])
        : metadata.format ? `image/${metadata.format}` : null;
  if (formatMime === null || (formatMime instanceof Set
    ? !formatMime.has(expectedMimeType)
    : formatMime !== expectedMimeType)) {
    throw new MediaGenerationValidationError("Reference image content does not match its Workspace media type.");
  }
  if (!width || !height) {
    throw new MediaGenerationValidationError("Reference image dimensions could not be read safely.");
  }
  const ratio = width / height;
  if (ratio <= MIN_ASPECT_RATIO || ratio >= MAX_ASPECT_RATIO) {
    throw new MediaGenerationValidationError("Reference image aspect ratio must be between 0.4 and 2.5.");
  }
  if (Math.min(width, height) >= MIN_IMAGE_SIDE) return { mimeType: expectedMimeType, bytes };

  // Venice accepts these formats but requires a 300 px shortest side. Preserve
  // the immutable Workspace binding while deriving a deterministic PNG only
  // for provider delivery, so small built-in avatars need no manual rewrite.
  try {
    const resized = await sharp(bytes, { limitInputPixels: 100_000_000 })
      .resize(width <= height ? { width: MIN_IMAGE_SIDE } : { height: MIN_IMAGE_SIDE })
      .png()
      .toBuffer();
    return { mimeType: "image/png", bytes: new Uint8Array(resized) };
  } catch {
    throw new MediaGenerationValidationError("Reference image could not be resized safely for Venice.");
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function assertQueueSize(prompt: string, references: readonly { mimeType: string; bytes: Uint8Array }[]): void {
  const encodedBytes = references.reduce((total, reference) =>
    total + Buffer.byteLength(`data:${reference.mimeType};base64,`) + Math.ceil(reference.bytes.byteLength / 3) * 4, 0);
  const conservativeJsonBytes = encodedBytes + Buffer.byteLength(prompt, "utf8") + 16_384;
  if (conservativeJsonBytes > MAX_QUEUE_JSON_BYTES) {
    throw new MediaGenerationValidationError("References exceed Venice's 35 MB JSON request limit after encoding. Use smaller reference files.");
  }
}

export async function resolveMediaGenerationReferenceRequest(
  db: DirectDatabase,
  scope: MediaGenerationScope,
  intent: NormalizedMediaGenerationIntent,
  operations: MediaReferenceArtifactOperations = DEFAULT_OPERATIONS,
  readableNamespaceIds: readonly string[] = [scope.namespaceId],
): Promise<NormalizedMediaGenerationRequest> {
  if (intent.model !== "seedance-2-5-reference-to-video-basic") {
    return normalizeMediaGenerationRequest(intent);
  }
  if (new Set(intent.referenceImages.map((reference) => reference.path)).size !== intent.referenceImages.length) {
    throw new MediaGenerationValidationError("Choose each reference image once; order controls <Image N> mapping.");
  }
  const videoBindings: NonNullable<Extract<NormalizedMediaGenerationRequest, { model: "seedance-2-5-reference-to-video-basic" }>["referenceVideos"]> = [];
  const videoDeliveries: PreparedReferenceImage[] = [];
  const paths = [...intent.referenceImages, ...(intent.referenceVideos ?? [])].map(ref => ref.path);
  if (new Set(paths).size !== paths.length) throw new MediaGenerationValidationError("Choose each reference once.");
  for (const reference of intent.referenceVideos ?? []) {
    const artifact = await operations.findByPath({ path: reference.path, readableNamespaceIds: [...readableNamespaceIds] }, db);
    if (!artifact || artifact.deletedAt !== null || !artifact.storageUri ||
        !["video/mp4", "video/quicktime"].includes(artifact.mimeType ?? "") ||
        !Number.isSafeInteger(artifact.size) || !artifact.size || artifact.size < 1) {
      throw new MediaGenerationValidationError("Choose a saved Workspace MP4 or MOV video as your reference.");
    }
    if (artifact.size > VENICE_REFERENCE_VIDEO_MAX_BYTES) {
      throw new MediaGenerationValidationError(VENICE_REFERENCE_VIDEO_SIZE_WARNING);
    }
    const bytes = await operations.readBytes(artifact.storageUri);
    if (bytes.byteLength !== artifact.size) throw new MediaGenerationValidationError("Reference video changed during preparation.");
    let durationSeconds: number;
    try { durationSeconds = inspectReferenceVideo(bytes).durationSeconds; }
    catch { throw new MediaGenerationValidationError("Reference video needs readable MP4/MOV timing and H.264 or H.265 video. Export a compatible clip and replace this reference."); }
    if (durationSeconds < 2 || durationSeconds > 30) throw new MediaGenerationValidationError("Each reference video must be 2–30 seconds. Choose a shorter clip.");
    videoBindings.push({ path: reference.path, artifactId: artifact.artifactId, artifactInternalId: artifact.id,
      revision: artifact.revision, mimeType: artifact.mimeType as "video/mp4" | "video/quicktime",
      sizeBytes: bytes.byteLength, sha256: sha256(bytes), durationSeconds });
    videoDeliveries.push({ mimeType: artifact.mimeType, bytes });
  }
  const inspected: { binding: MediaGenerationReferenceImageBinding; delivery: PreparedReferenceImage }[] = [];
  for (const reference of intent.referenceImages) {
    const artifact = await operations.findByPath({
      path: reference.path,
      readableNamespaceIds: [...readableNamespaceIds],
    }, db);
    if (!artifact || artifact.deletedAt !== null) throw new MediaGenerationValidationError("A selected Workspace reference is no longer available.");
    assertArtifactShape(artifact);
    const bytes = await operations.readBytes(artifact.storageUri);
    if (bytes.byteLength !== artifact.size) throw new MediaGenerationValidationError("A selected Workspace reference changed while it was being prepared.");
    const delivery = await prepareReferenceImage(bytes, artifact.mimeType);
    inspected.push({
      delivery,
      binding: {
        path: reference.path,
        artifactId: artifact.artifactId,
        artifactInternalId: artifact.id,
        revision: artifact.revision,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.size,
        sha256: sha256(bytes),
      },
    });
  }
  assertQueueSize(intent.prompt, [...inspected.map(({ delivery }) => delivery), ...videoDeliveries]);
  return normalizeMediaGenerationRequest({
    ...intent,
    referenceImages: inspected.map(({ binding }) => binding),
    ...(videoBindings.length ? { referenceVideos: videoBindings } : {}),
  });
}

/** Combined resolution checks the aggregate encoded request before any paid submit. */
export async function resolveApprovedReferenceMediaUrls(
  db: DirectDatabase, proof: MediaGenerationAdmissionProof,
  operations: MediaReferenceArtifactOperations = DEFAULT_OPERATIONS,
  readableNamespaceIds: readonly string[] = [proof.namespaceId],
): Promise<{ images: readonly string[]; videos: readonly string[] }> {
  const images = await resolveApprovedReferenceImageUrls(db, proof, operations, readableNamespaceIds);
  const videos: string[] = [];
  for (const binding of proof.requestPayload.referenceVideos ?? []) {
    const artifact = await operations.findByInternalId({ internalId: binding.artifactInternalId, mutableNamespaceIds: [...readableNamespaceIds] }, db);
    if (!artifact || artifact.deletedAt !== null || !artifact.storageUri ||
        artifact.artifactId !== binding.artifactId || artifact.revision !== binding.revision ||
        artifact.mimeType !== binding.mimeType || artifact.size !== binding.sizeBytes) throw new MediaGenerationValidationError("An approved reference video changed before submission.");
    const bytes = await operations.readBytes(artifact.storageUri);
    if (bytes.byteLength !== binding.sizeBytes || sha256(bytes) !== binding.sha256 ||
        inspectReferenceVideo(bytes).durationSeconds !== binding.durationSeconds) throw new MediaGenerationValidationError("An approved reference video changed before submission.");
    videos.push(`data:${binding.mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
  }
  if (Buffer.byteLength(JSON.stringify({ images, videos, prompt: proof.requestPayload.prompt }), "utf8") + 16_384 > MAX_QUEUE_JSON_BYTES) {
    throw new MediaGenerationValidationError("References exceed Venice's 35 MB request limit.");
  }
  return { images, videos };
}

export async function resolveApprovedReferenceImageUrls(
  db: DirectDatabase,
  proof: MediaGenerationAdmissionProof,
  operations: MediaReferenceArtifactOperations = DEFAULT_OPERATIONS,
  readableNamespaceIds: readonly string[] = [proof.namespaceId],
): Promise<readonly string[]> {
  const bindings = proof.requestPayload.referenceImages;
  if (proof.requestPayload.model !== "seedance-2-5-reference-to-video-basic" || !bindings) {
    throw new Error("Approved reference bindings are missing.");
  }
  const resolved: { mimeType: string; bytes: Uint8Array }[] = [];
  for (const binding of bindings) {
    const artifact = await operations.findByInternalId({
      internalId: binding.artifactInternalId,
      mutableNamespaceIds: [...readableNamespaceIds],
    }, db);
    if (!artifact || artifact.deletedAt !== null) throw new MediaGenerationValidationError("An approved reference image is no longer available.");
    assertArtifactShape(artifact);
    if (artifact.artifactId !== binding.artifactId || artifact.revision !== binding.revision ||
        artifact.mimeType !== binding.mimeType || artifact.size !== binding.sizeBytes) {
      throw new MediaGenerationValidationError("An approved reference image changed before submission.");
    }
    const bytes = await operations.readBytes(artifact.storageUri);
    if (bytes.byteLength !== binding.sizeBytes || sha256(bytes) !== binding.sha256) {
      throw new MediaGenerationValidationError("An approved reference image changed before submission.");
    }
    resolved.push(await prepareReferenceImage(bytes, binding.mimeType));
  }
  assertQueueSize(proof.requestPayload.prompt, resolved);
  return resolved.map(({ mimeType, bytes }) => `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`);
}
