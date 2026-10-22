import {
  taskContentBackfillAckRequestSchema,
  taskContentBackfillAckResponseSchema,
  taskContentBackfillClaimIdRequestSchema,
  taskContentBackfillClaimRequestSchema,
  taskContentBackfillClaimResponseSchema,
  taskContentBackfillDiscoverResponseSchema,
  taskContentBackfillProgressResponseSchema,
  taskContentBackfillPublishRequestSchema,
  taskContentBackfillPublishResponseSchema,
  taskContentBackfillRecoverResponseSchema,
  taskContentBackfillReleaseRequestSchema,
  taskContentBackfillReleaseResponseSchema,
  taskContentBackfillSourceResponseSchema,
} from "@nautilo/api-client";
import {
  ClassifiedDataOperationError,
} from "@nautilo/lattice-bridge";
import {
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
} from "@nautilo/lattice-crypto/wire-limits";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { decodeCanonicalBase64url } from "../lib/canonical-base64url";
import { liveShadowLargeRequestRouteOptions } from "./live-shadow-request-boundary";
import type { TaskContentBackfillSubject } from "./task-content-backfill-authority";
import type { createTaskContentBackfillPublication } from
  "./task-content-backfill-publication";
import type { createTaskContentBackfillScanService } from
  "./task-content-backfill-scan";

type ScanService = ReturnType<typeof createTaskContentBackfillScanService>;
type PublicationService = ReturnType<typeof createTaskContentBackfillPublication>;

export type TaskContentBackfillRouteServices = Readonly<{
  scan: Pick<ScanService, "discover" | "claim" | "progress" | "release" | "acknowledge">;
  publication: Pick<PublicationService, "source" | "publish" | "recover">;
  isActive(): Promise<boolean>;
  now?: () => number;
}>;

const publicationBodyBytes = JSON.stringify({
  claimId: "00000000-0000-4000-8000-000000000000",
  payloadBytesBase64url: "",
  manifestBytesBase64url: "",
  envelopeBytesBase64url: "",
  requestBytesBase64url: "",
}).length + [
  MAX_ENCRYPTED_PAYLOAD_WIRE_BYTES_V2,
  MAX_OBJECT_ACCESS_MANIFEST_WIRE_BYTES_V5,
  MAX_NAMESPACE_OBJECT_ENVELOPE_WIRE_BYTES_V2,
  MAX_HUMAN_EXISTING_TASK_REPRESENTATION_PUBLICATION_REQUEST_WIRE_BYTES_V1,
].reduce((total, bytes) => total + Math.ceil(bytes * 4 / 3), 0);

function noStore(reply: FastifyReply): void {
  reply.header("Cache-Control", "private, no-store");
  reply.header("Vary", "Authorization");
}

type AuthenticatedSubject = Readonly<{ userId: string; humanActorId: string }>;

function authenticatedSubject(request: FastifyRequest): AuthenticatedSubject {
  if (!request.sessionUserId || !request.sessionActorId) {
    throw Object.assign(new Error("Authentication required"), { statusCode: 401 });
  }
  return Object.freeze({
    userId: request.sessionUserId,
    humanActorId: request.sessionActorId,
  });
}

function subject(
  request: FastifyRequest,
  identity: AuthenticatedSubject,
  now: number,
): TaskContentBackfillSubject {
  const admission = request.cryptoDeviceAdmission;
  if (!admission || admission.expiresAt <= now) {
    throw Object.assign(new Error("Current device admission is required"), {
      statusCode: 428,
    });
  }
  return Object.freeze({
    ...identity,
    admission,
  });
}

function invalid(reply: FastifyReply, operation: string) {
  return reply.code(400).send({ error: `Invalid Task content repair ${operation}` });
}

function hasNoQuery(request: FastifyRequest): boolean {
  return typeof request.query === "object" && request.query !== null
    && !Array.isArray(request.query)
    && Object.keys(request.query).length === 0;
}

function isEmptyBody(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && Object.keys(value).length === 0;
}

function wireCandidate(candidate: Parameters<ScanService["claim"]>[1]["candidate"]) {
  return candidate.kind === "definition"
    ? Object.freeze({
        ...candidate,
        sourceCreatedAt: candidate.sourceCreatedAt.getTime(),
        sourceUpdatedAt: candidate.sourceUpdatedAt.getTime(),
      })
    : Object.freeze({
        ...candidate,
        sourceUpdatedAt: candidate.sourceUpdatedAt.getTime(),
        sourceStartedAt: candidate.sourceStartedAt.getTime(),
        sourceCompletedAt: candidate.sourceCompletedAt.getTime(),
      });
}

function serviceCandidate(candidate: ReturnType<typeof wireCandidate>) {
  return candidate.kind === "definition"
    ? Object.freeze({
        ...candidate,
        sourceCreatedAt: new Date(candidate.sourceCreatedAt),
        sourceUpdatedAt: new Date(candidate.sourceUpdatedAt),
      })
    : Object.freeze({
        ...candidate,
        sourceUpdatedAt: new Date(candidate.sourceUpdatedAt),
        sourceStartedAt: new Date(candidate.sourceStartedAt),
        sourceCompletedAt: new Date(candidate.sourceCompletedAt),
      });
}

function wireClaim(claim: Readonly<{
  claimId: string;
  humanActorId: string;
  requesterUserId: string;
  deviceId: string;
  policyRevision: number;
  expiresAt: Date;
  candidate: Parameters<ScanService["claim"]>[1]["candidate"];
}>) {
  return Object.freeze({
    ...claim,
    expiresAt: claim.expiresAt.getTime(),
    candidate: wireCandidate(claim.candidate),
  });
}

function wireScanResult(result: Awaited<ReturnType<ScanService["discover"]>>) {
  if (result.status !== "ready") return result;
  const value = result.value;
  if (value.status === "candidate") {
    return Object.freeze({ ...result, value: Object.freeze({
      status: value.status,
      candidate: wireCandidate(value.candidate),
      policyRevision: value.policyRevision,
    }) });
  }
  if (value.status === "claimed") {
    return Object.freeze({ ...result, value: Object.freeze({
      ...value,
      claim: wireClaim(value.claim),
    }) });
  }
  if (value.status === "waiting" || value.status === "swept") {
    return Object.freeze({ ...result, value: Object.freeze({
      ...value,
      resumeAt: value.resumeAt === null ? null : value.resumeAt.getTime(),
    }) });
  }
  return result;
}

function wireClaimResult(result: Awaited<ReturnType<ScanService["claim"]>>) {
  return result.status === "ready" && result.value.status === "claimed"
    ? Object.freeze({ ...result, value: Object.freeze({
        ...result.value,
        claim: wireClaim(result.value.claim),
      }) })
    : result;
}

function availabilityStatus(error: unknown): "waiting_for_authority" | "integrity" | null {
  if (!(error instanceof ClassifiedDataOperationError)) return null;
  if (error.failureClass === "integrity") return "integrity";
  return error.failureClass === "authority" || error.failureClass === "key_waiting"
    ? "waiting_for_authority"
    : null;
}

async function publicationOutcome<Status extends string>(
  operation: () => Promise<boolean | null>,
  success: Status,
  pending: Status,
): Promise<Readonly<{ status: Status | "waiting_for_authority" | "integrity" }>> {
  try {
    const result = await operation();
    return Object.freeze({ status: result === true ? success
      : result === false ? pending : "waiting_for_authority" });
  } catch (error) {
    const classified = availabilityStatus(error);
    if (classified === null) throw error;
    return Object.freeze({ status: classified });
  }
}

/** Authenticated, current-device transport for historical Task content repair. */
export function taskContentBackfillRoutes(
  app: FastifyInstance,
  services: TaskContentBackfillRouteServices,
): void {
  const now = services.now ?? Date.now;
  const current = (request: FastifyRequest, identity: AuthenticatedSubject) =>
    subject(request, identity, now());

  app.post("/api/tasks/content/backfill/discover", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillDiscoverResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request) || !isEmptyBody(request.body)) {
      return invalid(reply, "discovery");
    }
    return taskContentBackfillDiscoverResponseSchema.parse(
      wireScanResult(await services.scan.discover(current(request, identity))),
    );
  });

  app.post("/api/tasks/content/backfill/claim", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillClaimResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "claim");
    const parsed = taskContentBackfillClaimRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "claim");
    const candidate = serviceCandidate(parsed.data.candidate);
    return taskContentBackfillClaimResponseSchema.parse(wireClaimResult(
      await services.scan.claim(current(request, identity), {
        candidate,
        policyRevision: parsed.data.policyRevision,
      }),
    ));
  });

  app.post("/api/tasks/content/backfill/source", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillSourceResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "source request");
    const parsed = taskContentBackfillClaimIdRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "source request");
    try {
      const source = await services.publication.source(
        current(request, identity), parsed.data.claimId,
      );
      return taskContentBackfillSourceResponseSchema.parse(
        source?.status === "source"
          ? source
          : { status: source?.status ?? "waiting_for_authority", resumeAt: null },
      );
    } catch (error) {
      const status = availabilityStatus(error);
      if (status === null) throw error;
      return taskContentBackfillSourceResponseSchema.parse({ status, resumeAt: null });
    }
  });

  app.post("/api/tasks/content/backfill/publish", {
    ...liveShadowLargeRequestRouteOptions,
    bodyLimit: publicationBodyBytes,
  }, async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillPublishResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "publication");
    const parsed = taskContentBackfillPublishRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "publication");
    const upload = {
      payloadBytes: decodeCanonicalBase64url(
        parsed.data.payloadBytesBase64url,
      ),
      manifestBytes: decodeCanonicalBase64url(
        parsed.data.manifestBytesBase64url,
      ),
      envelopeBytes: decodeCanonicalBase64url(
        parsed.data.envelopeBytesBase64url,
      ),
      signedPublicationRequestBytes: decodeCanonicalBase64url(
        parsed.data.requestBytesBase64url,
      ),
    };
    if (Object.values(upload).some(value => value === null)) {
      for (const bytes of Object.values(upload)) bytes?.fill(0);
      return invalid(reply, "publication");
    }
    const owned = upload as {
      payloadBytes: Uint8Array;
      manifestBytes: Uint8Array;
      envelopeBytes: Uint8Array;
      signedPublicationRequestBytes: Uint8Array;
    };
    try {
      return taskContentBackfillPublishResponseSchema.parse(await publicationOutcome(
        () => services.publication.publish(
          current(request, identity), parsed.data.claimId, owned,
        ),
        "published",
        "waiting_for_authority",
      ));
    } finally {
      for (const bytes of Object.values(owned)) bytes.fill(0);
    }
  });

  app.post("/api/tasks/content/backfill/recover", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillRecoverResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "recovery request");
    const parsed = taskContentBackfillClaimIdRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "recovery request");
    return taskContentBackfillRecoverResponseSchema.parse(await publicationOutcome(
      () => services.publication.recover(current(request, identity), parsed.data.claimId),
      "mapped",
      "pending",
    ));
  });

  app.get("/api/tasks/content/backfill/progress", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillProgressResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) {
      return invalid(reply, "progress request");
    }
    return taskContentBackfillProgressResponseSchema.parse(
      await services.scan.progress(current(request, identity)),
    );
  });

  app.post("/api/tasks/content/backfill/release", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillReleaseResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "release request");
    const parsed = taskContentBackfillReleaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "release request");
    return taskContentBackfillReleaseResponseSchema.parse(await services.scan.release(
      current(request, identity), parsed.data.claimId, parsed.data.advance,
    ));
  });

  app.post("/api/tasks/content/backfill/ack", async (request, reply) => {
    noStore(reply);
    const identity = authenticatedSubject(request);
    if (!await services.isActive()) {
      return taskContentBackfillAckResponseSchema.parse({ status: "inactive" });
    }
    if (!hasNoQuery(request)) return invalid(reply, "acknowledgement");
    const parsed = taskContentBackfillAckRequestSchema.safeParse(request.body);
    if (!parsed.success) return invalid(reply, "acknowledgement");
    return taskContentBackfillAckResponseSchema.parse(await services.scan.acknowledge(
      current(request, identity), parsed.data.claimId, parsed.data.outcome,
    ));
  });
}
