/**
 * D525 Phase 3.1 — authorized, provider-opaque media-generation status read.
 *
 * The route deliberately maps a durable receipt to the closed API-client DTO;
 * it never serializes the DB row itself. Provider queue/admission fields,
 * request payloads, storage URIs, and raw failures remain server-only.
 */
import type { FastifyInstance } from "fastify";
import {
  mapMediaGenerationStatusV1,
  type MediaGenerationStatusSourceV1,
} from "@nautilo/api-client";
import {
  findArtifactByInternalIdForNamespaces,
  findMediaGeneration,
  type Artifact,
  type MediaGeneration,
  type MediaGenerationScope,
} from "@nautilo/db";
import {
  envelopeReadableNamespaces,
  isScopeMemoryEnvelope,
} from "@nautilo/trust";
import { getServerDirectDb } from "../lib/server-direct-db";

const RECEIPT_ID = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SCOPE_REJECTION_MESSAGE =
  "Artifact scope mode is not implemented yet; use namespace context or wait for M088 Phase 4.";
const MAX_PUBLIC_DURATION_SECONDS = 2_147_483_647;

type AuthorizedMediaScope = MediaGenerationScope;

export interface MediaGenerationsRouteService {
  readonly findMediaGeneration?: (
    scope: AuthorizedMediaScope,
    receiptId: string,
  ) => Promise<MediaGeneration | null>;
  readonly findArtifactByInternalIdForNamespaces?: (input: {
    internalId: string;
    readableNamespaceIds: string[];
  }) => Promise<Artifact | null>;
}

function isReadyArtifactState(state: MediaGeneration["state"]): boolean {
  return state === "ready";
}

function safeFailure(
  failure: MediaGeneration["safeFailure"],
): MediaGenerationStatusSourceV1["failure"] {
  if (!failure) return undefined;
  // Stored failure codes are server classifiers. If an old/malformed row does
  // not fit the current closed wire grammar, fail to a generic classifier;
  // never echo a value that could be a provider response.
  const code = /^[A-Z][A-Z0-9_]{0,127}$/u.test(failure.code)
    ? failure.code
    : "MEDIA_GENERATION_FAILED";
  return {
    code,
    message: "The generation could not continue. Review the available recovery options.",
    phase: failure.phase,
    retrySafe: failure.retrySafe,
    stateChanged: failure.stateChanged,
    completionCertainty: failure.completionCertainty,
    chargeCertainty: failure.chargeCertainty,
    ...(failure.creditsRefunded === undefined ? {} : { creditsRefunded: failure.creditsRefunded }),
  };
}

function safeTimingSeconds(value: number | null): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= MAX_PUBLIC_DURATION_SECONDS
    ? value
    : undefined;
}

/** Shared server-only safe projection; callers must authorize the receipt first. */
export function projectMediaGenerationStatusSource(
  row: MediaGeneration,
  artifact: Artifact | null,
): MediaGenerationStatusSourceV1 | null {
  // A receipt is only ready to render when its artifact has crossed the same
  // authenticated Artifact boundary the rest of Workbench uses. Do not invent
  // a MIME type or byte count for a malformed legacy row.
  if (
    isReadyArtifactState(row.state) &&
    (!artifact ||
      !artifact.mimeType ||
      !Number.isSafeInteger(artifact.size) ||
      artifact.size <= 0)
  ) {
    return null;
  }
  const artifactProjection = artifact
    ? {
        artifactId: artifact.artifactId,
        path: artifact.path,
        zone: "workspace" as const,
        mime: artifact.mimeType,
        bytes: artifact.size,
      }
    : undefined;
  // Worker progress and post-save cleanup retries are durable internal facts,
  // not user-facing generation failures. Project failure details only for the
  // closed recovery states required by the public DTO.
  const failure = row.state === "needs_action" || row.state === "failed" || row.state === "unknown"
    ? safeFailure(row.safeFailure)
    : undefined;
  // A PROCESSING retrieve response is durable provider evidence that the job
  // remains active. The two numbers are elapsed and P80 typical duration,
  // never percentage or countdown data. Terminal states intentionally omit
  // progress even though the DB may retain the evidence for receipt audit.
  const progress = row.state === "retrieving" && row.safeFailure?.code === "VENICE_PROCESSING"
    ? (() => {
        const elapsedSeconds = safeTimingSeconds(row.providerExecutionSeconds);
        const estimatedSeconds = safeTimingSeconds(row.providerAverageExecutionSeconds);
        return {
          phase: "generating" as const,
          ...(elapsedSeconds === undefined ? {} : { elapsedSeconds }),
          ...(estimatedSeconds === undefined ? {} : { estimatedSeconds }),
        };
      })()
    : undefined;
  return {
    receiptId: row.receiptId,
    revision: row.revision,
    kind: row.kind,
    modelId: row.providerModel,
    state: row.state,
    settings: row.safeSnapshot.normalizedSettings,
    cleanupState: row.cleanupState,
    ...(progress ? { progress } : {}),
    ...(artifactProjection ? { artifact: artifactProjection } : {}),
    ...(failure ? { failure } : {}),
    // Action handles are intentionally absent until durable/signed action
    // authority exists. The read surface must not mint or guess one.
    recoveryActions: [],
  };
}

export function mediaGenerationsRoutes(
  app: FastifyInstance,
  service: MediaGenerationsRouteService = {},
): void {
  const readGeneration = service.findMediaGeneration ?? ((scope, receiptId) =>
    findMediaGeneration(getServerDirectDb(), scope, receiptId));
  const readArtifact = service.findArtifactByInternalIdForNamespaces ??
    findArtifactByInternalIdForNamespaces;

  app.get("/api/media-generations/:receiptId", async (request, reply) => {
    const { receiptId } = request.params as { receiptId?: string };
    const { roomId } = request.query as { roomId?: string };
    if (typeof receiptId !== "string" || !RECEIPT_ID.test(receiptId)) {
      return reply.code(400).send({ error: "Malformed media generation receipt" });
    }
    if (typeof roomId !== "string" || !UUID.test(roomId)) {
      return reply.code(400).send({ error: "Malformed room id" });
    }

    const env = request.memoryEnvelope;
    if (!request.sessionUserId || !env) {
      return reply.code(401).send({ error: "Authentication required" });
    }
    if (isScopeMemoryEnvelope(env)) {
      return reply.code(501).send({ error: SCOPE_REJECTION_MESSAGE });
    }
    if (!env.agentId) {
      return reply.code(403).send({ error: "Authorized Room context required" });
    }
    // A receipt is intentionally undiscoverable outside its exact Human/Room
    // envelope. Keep all three scope misses identical to an absent receipt.
    if (request.sessionUserId !== env.ownerId || env.roomId !== roomId) {
      return reply.code(404).send({ error: "Not found" });
    }
    const namespaceId = env.writableNamespaces.length === 1 ? env.writableNamespaces[0] : undefined;
    if (!namespaceId) return reply.code(404).send({ error: "Not found" });

    try {
      const row = await readGeneration(
        { ownerId: env.ownerId, roomId: env.roomId, namespaceId },
        receiptId,
      );
      if (!row) return reply.code(404).send({ error: "Not found" });

      const artifact = row.artifactInternalId
        ? await readArtifact({
            internalId: row.artifactInternalId,
            readableNamespaceIds: envelopeReadableNamespaces(env),
          })
        : null;
      const source = projectMediaGenerationStatusSource(row, artifact);
      // A durable ready row is not client-readable until its Workspace
      // artifact is currently readable. Hide both artifact and receipt shape.
      if (!source) return reply.code(404).send({ error: "Not found" });
      return reply.send(mapMediaGenerationStatusV1(source));
    } catch {
      return reply.code(503).send({ error: "Media generation status is temporarily unavailable" });
    }
  });
}
