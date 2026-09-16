import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  createVideoGenerationLink,
  findArtifactByIdForNamespaces,
  findVideoGenerationLinkByTake,
  findMediaGeneration,
  findArtifactByInternalIdForNamespaces,
  listVideoGenerationLinks,
  markVideoGenerationLinkAdmitted,
  type Artifact,
} from "@nautilo/db";
import { mapMediaGenerationStatusV1 } from "@nautilo/api-client";
import { isScopeMemoryEnvelope } from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";
import { videoHostAttestationRegistry } from "../apps/video-host-attestation-registry";
import { projectMediaGenerationStatusSource } from "../routes/media-generations";
import {
  createVideoGenerationCoordinator,
  type VideoGenerationLinkRecord,
  type VideoGenerationProjectScope,
} from "./coordinator";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PLAN_FINGERPRINT = /^sha256:[a-f0-9]{64}$/u;
const TAKE_ID = /^take_[A-Za-z0-9_-]{16,128}$/u;
const SHOT_ID = /^(?:quick-brief|[A-Za-z][A-Za-z0-9_-]{0,63})$/u;
const VIDEO_CATALOG_MODELS = new Map([
  ["venice:seedance-2-5-text-to-video-basic", "seedance-2-5-text-to-video-basic"],
  ["venice:minimax-h3-enhanced-text-to-video", "minimax-h3-enhanced-text-to-video"],
  ["venice:seedance-2-5-reference-to-video-basic", "seedance-2-5-reference-to-video-basic"],
]);
const VIDEO_RATIOS = new Set(["21:9", "16:9", "4:3", "1:1", "3:4", "9:16"]);
const VIDEO_RESOLUTIONS = new Set(["480p", "720p", "1080p", "768P", "2K"]);

type Coordinator = ReturnType<typeof createVideoGenerationCoordinator>;

function linkScope(scope: VideoGenerationProjectScope) {
  return { ...scope, ownerId: scope.userId };
}

function invalid(reply: { code(status: number): { send(body: unknown): unknown } }, message: string) {
  return reply.code(400).send({ error: message });
}

/** Map the host's closed compiler job to D525's existing normalizer input. */
function videoJobIntent(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const job = value as Record<string, unknown>;
  if (Object.keys(job).some((key) => !["modelId", "prompt", "durationSeconds", "aspectRatio", "resolution", "audio", "referenceImages", "referenceVideos"].includes(key)) ||
      typeof job["modelId"] !== "string" || !VIDEO_CATALOG_MODELS.has(job["modelId"]) ||
      typeof job["prompt"] !== "string" || job["prompt"].trim().length === 0 ||
      (job["durationSeconds"] !== undefined && !Number.isSafeInteger(job["durationSeconds"])) ||
      (job["aspectRatio"] !== undefined && (typeof job["aspectRatio"] !== "string" || !VIDEO_RATIOS.has(job["aspectRatio"]))) ||
      (job["resolution"] !== undefined && (typeof job["resolution"] !== "string" || !VIDEO_RESOLUTIONS.has(job["resolution"]))) ||
      (job["audio"] !== undefined && typeof job["audio"] !== "boolean")) return null;
  const model = VIDEO_CATALOG_MODELS.get(job["modelId"]);
  if (!model) return null;
  const requested = {
    ...(job["durationSeconds"] === undefined ? {} : { durationSeconds: job["durationSeconds"] }),
    ...(job["aspectRatio"] === undefined ? {} : { aspectRatio: job["aspectRatio"] }),
    ...(job["resolution"] === undefined ? {} : { resolution: job["resolution"] }),
  };
  if (model === "seedance-2-5-reference-to-video-basic") {
    return { model, prompt: job["prompt"], ...requested, ...(job["audio"] === undefined ? {} : { audio: job["audio"] }),
      referenceImages: job["referenceImages"] ?? [], ...(job["referenceVideos"] === undefined ? {} : { referenceVideos: job["referenceVideos"] }) };
  }
  if (job["referenceImages"] !== undefined || job["referenceVideos"] !== undefined) return null;
  if (model === "seedance-2-5-text-to-video-basic") {
    return { model, prompt: job["prompt"], ...requested, ...(job["audio"] === undefined ? {} : { audio: job["audio"] }) };
  }
  if (job["audio"] !== undefined) return null;
  return { model, prompt: job["prompt"], ...requested };
}

function projectScope(
  request: FastifyRequest,
  roomId: unknown,
  artifact: Artifact | null,
): VideoGenerationProjectScope | null {
  const env = request.memoryEnvelope;
  if (!request.sessionUserId || !env || isScopeMemoryEnvelope(env) || !env.agentId ||
      typeof roomId !== "string" || env.ownerId !== request.sessionUserId || env.roomId !== roomId ||
      env.writableNamespaces.length !== 1 || !artifact ||
      !artifact.path.endsWith(".video.html")) return null;
  return {
    userId: request.sessionUserId,
    agentId: env.agentId,
    roomId: env.roomId,
    namespaceId: env.writableNamespaces[0]!,
    projectArtifactInternalId: artifact.id,
    projectArtifactId: artifact.artifactId,
  };
}

/**
 * A caller must supply a non-forgeable first-party host attestation. The
 * default is deny: an ordinary browser/iframe session cannot obtain Video
 * spend authority merely by knowing this route exists.
 */
export interface VideoGenerationRouteService {
  readonly attestFirstPartyVideo?: (request: FastifyRequest, scope: VideoGenerationProjectScope, revision: number) => Promise<boolean>;
  readonly findProjectArtifact?: (input: { artifactId: string; namespaceId: string }) => Promise<Artifact | null>;
  readonly coordinator?: Coordinator;
  readonly findByTake?: (scope: VideoGenerationProjectScope, takeId: string) => Promise<VideoGenerationLinkRecord | null>;
  readonly list?: (scope: VideoGenerationProjectScope) => Promise<readonly VideoGenerationLinkRecord[]>;
}

function defaultCoordinator(): Coordinator {
  const db = getServerDirectDb();
  return createVideoGenerationCoordinator({
    links: {
      async findByRequest(scope, requestId) {
        const { findVideoGenerationLinkByRequest } = await import("@nautilo/db");
        return findVideoGenerationLinkByRequest(db, linkScope(scope), requestId);
      },
      async create(input) {
        return createVideoGenerationLink(db, input);
      },
      async markAdmitted(scope, takeId) {
        return markVideoGenerationLinkAdmitted(db, linkScope(scope), takeId);
      },
    },
  });
}

/** Narrow parent-host API; it is never registered as a generic app tool. */
export function videoGenerationRoutes(
  app: FastifyInstance,
  service: VideoGenerationRouteService = {},
): void {
  const coordinator = service.coordinator ?? defaultCoordinator();
  const attest = service.attestFirstPartyVideo ?? ((request, scope, revision) => {
    const token = request.headers["x-nautilo-video-host-attestation"];
    return Promise.resolve(typeof token === "string" && videoHostAttestationRegistry.validateForProject(token, {
      userId: scope.userId, roomId: scope.roomId, namespaceId: scope.namespaceId,
      projectArtifactInternalId: scope.projectArtifactInternalId, projectArtifactId: scope.projectArtifactId,
      projectRevision: revision,
    }) !== null);
  });
  const readProject = service.findProjectArtifact ?? (async ({ artifactId, namespaceId }) =>
    findArtifactByIdForNamespaces({ artifactId, readableNamespaceIds: [namespaceId] }));
  const findTake = service.findByTake ?? (async (scope, takeId) =>
    (await findVideoGenerationLinkByTake(getServerDirectDb(), linkScope(scope), takeId)) ?? null);
  const list = service.list ?? ((scope) => listVideoGenerationLinks(getServerDirectDb(), linkScope(scope)));

  app.post("/api/video-generations/prepare", async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const roomId = body["roomId"];
    const projectArtifactId = body["projectArtifactId"];
    if (typeof roomId !== "string" || !UUID.test(roomId) || typeof projectArtifactId !== "string" || !UUID.test(projectArtifactId)) {
      return invalid(reply, "Malformed Video project context");
    }
    const env = request.memoryEnvelope;
    const namespaceId = env && !isScopeMemoryEnvelope(env) && env.writableNamespaces.length === 1
      ? env.writableNamespaces[0] : undefined;
    const scope = projectScope(request, roomId, namespaceId ? await readProject({ artifactId: projectArtifactId, namespaceId }) : null);
    if (!scope) return reply.code(404).send({ error: "Not found" });
    const project = namespaceId ? await readProject({ artifactId: projectArtifactId, namespaceId }) : null;
    if (!project || !(await attest(request, scope, project.revision))) return reply.code(403).send({ error: "First-party Video host required" });
    const requestId = body["requestId"];
    const shotId = body["shotId"];
    const shotLabel = body["shotLabel"];
    const briefDigest = body["briefDigest"];
    const documentRevision = body["documentRevision"];
    if (typeof requestId !== "string" || !UUID.test(requestId) || typeof shotId !== "string" || !SHOT_ID.test(shotId) ||
        typeof shotLabel !== "string" || shotLabel.length === 0 || /[\r\n\0]/u.test(shotLabel) ||
        typeof briefDigest !== "string" || !PLAN_FINGERPRINT.test(briefDigest) ||
        !Number.isSafeInteger(documentRevision)) return invalid(reply, "Malformed Video generation request");
    const intent = videoJobIntent(body["job"]);
    if (!intent) return invalid(reply, "Malformed Video generation job");
    const result = await coordinator.prepare({ scope, requestId, shotId, shotLabel, briefDigest, documentRevision: documentRevision as number, intent });
    return result.ok ? reply.send(result.review) : reply.code(result.code === "already_prepared" ? 409 : 422).send(result);
  });

  app.post("/api/video-generations/:takeId/submit", async (request, reply) => {
    const { takeId } = request.params as { takeId?: string };
    const body = (request.body ?? {}) as { roomId?: unknown; projectArtifactId?: unknown; reviewHandle?: unknown };
    if (typeof takeId !== "string" || !TAKE_ID.test(takeId) || typeof body.roomId !== "string" || !UUID.test(body.roomId) ||
        typeof body.projectArtifactId !== "string" || !UUID.test(body.projectArtifactId) || typeof body.reviewHandle !== "string") {
      return invalid(reply, "Malformed Video review");
    }
    const env = request.memoryEnvelope;
    const namespaceId = env && !isScopeMemoryEnvelope(env) && env.writableNamespaces.length === 1
      ? env.writableNamespaces[0] : undefined;
    const scope = projectScope(request, body.roomId, namespaceId ? await readProject({ artifactId: body.projectArtifactId, namespaceId }) : null);
    if (!scope) return reply.code(404).send({ error: "Not found" });
    const project = namespaceId ? await readProject({ artifactId: body.projectArtifactId, namespaceId }) : null;
    if (!project || !(await attest(request, scope, project.revision))) return reply.code(403).send({ error: "First-party Video host required" });
    const link = await findTake(scope, takeId);
    if (!link) return reply.code(404).send({ error: "Not found" });
    const result = await coordinator.submit({ scope, takeId, reviewHandle: body.reviewHandle });
    const { receiptId: _receiptId, kind: _kind, version: _version, artifact: _artifact, progress: _progress, ...safe } = result;
    return reply.send({ takeId, ...safe });
  });

  app.get("/api/video-generations", async (request, reply) => {
    const { roomId, projectArtifactId } = request.query as { roomId?: string; projectArtifactId?: string };
    if (!roomId || !UUID.test(roomId) || !projectArtifactId || !UUID.test(projectArtifactId)) return invalid(reply, "Malformed Video project context");
    const env = request.memoryEnvelope;
    const namespaceId = env && !isScopeMemoryEnvelope(env) && env.writableNamespaces.length === 1
      ? env.writableNamespaces[0] : undefined;
    const scope = projectScope(request, roomId, namespaceId ? await readProject({ artifactId: projectArtifactId, namespaceId }) : null);
    if (!scope) return reply.code(404).send({ error: "Not found" });
    const project = namespaceId ? await readProject({ artifactId: projectArtifactId, namespaceId }) : null;
    if (!project || !(await attest(request, scope, project.revision))) return reply.code(403).send({ error: "First-party Video host required" });
    const rows = await list(scope);
    return reply.send({ takes: rows.map((row) => ({ takeId: row.takeId, shotId: row.shotId, shotLabel: row.shotLabel, documentRevision: row.documentRevision })) });
  });

  app.get("/api/video-generations/:takeId/status", async (request, reply) => {
    const { takeId } = request.params as { takeId?: string };
    const { roomId, projectArtifactId } = request.query as { roomId?: string; projectArtifactId?: string };
    if (!takeId || !TAKE_ID.test(takeId) || !roomId || !UUID.test(roomId) || !projectArtifactId || !UUID.test(projectArtifactId)) return invalid(reply, "Malformed Video take context");
    const env = request.memoryEnvelope;
    const namespaceId = env && !isScopeMemoryEnvelope(env) && env.writableNamespaces.length === 1 ? env.writableNamespaces[0] : undefined;
    const project = namespaceId ? await readProject({ artifactId: projectArtifactId, namespaceId }) : null;
    const scope = projectScope(request, roomId, project);
    if (!scope) return reply.code(404).send({ error: "Not found" });
    if (!(await attest(request, scope, project!.revision))) return reply.code(403).send({ error: "First-party Video host required" });
    const link = await findTake(scope, takeId);
    if (!link || !link.admittedAt) return reply.code(404).send({ error: "Not found" });
    const dbScope = linkScope(scope);
    const row = await findMediaGeneration(getServerDirectDb(), dbScope, link.receiptId);
    if (!row) return reply.code(404).send({ error: "Not found" });
    const artifact = row.artifactInternalId
      ? await findArtifactByInternalIdForNamespaces({ internalId: row.artifactInternalId, readableNamespaceIds: [scope.namespaceId] })
      : null;
    const source = projectMediaGenerationStatusSource(row, artifact);
    if (!source) return reply.code(404).send({ error: "Not found" });
    const status = mapMediaGenerationStatusV1(source);
    const { receiptId: _receiptId, ...safe } = status;
    return reply.send({ takeId, ...safe });
  });
}
