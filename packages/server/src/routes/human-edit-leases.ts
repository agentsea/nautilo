import type { FastifyInstance, FastifyRequest } from "fastify";
import {
  deriveDocumentIdentityLockKeys,
  type DocumentLockManager,
  HumanEditLeaseRegistry,
} from "@nautilo/document-mutations";
import {
  applyAnchoredTextPatch,
  registerHumanEditLeaseRequestSchema,
  releaseHumanEditLeaseRequestSchema,
  renewHumanEditLeaseRequestSchema,
  updateHumanEditLeaseRequestSchema,
  type HumanEditLeaseCandidateTarget,
  type DocumentIdentity,
  type HumanEditLeaseStoreResult,
} from "@nautilo/types";
import type {
  ResolveHumanEditLeaseTargetResult,
  ResolvedHumanEditLeaseTarget,
} from "../document-mutations/human-edit-lease-targets";
import {
  requireArtifactWrite,
  type AssertCanWriteArtifacts,
} from "../lib/artifact-write-admission";

export interface HumanEditLeaseRoutesDeps {
  /** Process-local presence state. It is not document authorization. */
  readonly registry: HumanEditLeaseRegistry;
  /** Shared with every server-side Workspace mutation coordinator. */
  readonly workspaceLockManager: DocumentLockManager;
  /**
   * Resolves an untrusted candidate through the request's trusted authority
   * context and returns only server-derived identity/version/bytes.
   */
  readonly resolveTarget: (input: {
    readonly request: Pick<FastifyRequest, "sessionUserId" | "memoryEnvelope">;
    readonly candidate: Extract<HumanEditLeaseCandidateTarget, { kind: "workspace_artifact" }>;
  }) => Promise<ResolveHumanEditLeaseTargetResult>;
  /** M259 hermetic admission seam; production uses canonical RBAC. */
  readonly assertCanWriteArtifacts?: AssertCanWriteArtifacts;
}

function invalid(reason: string): HumanEditLeaseStoreResult {
  return { status: "invalid", reason };
}

function draftAppliesToTarget(
  target: ResolvedHumanEditLeaseTarget,
  draftPatch: unknown,
  state: "clean" | "dirty" | "saving" | "conflict",
): HumanEditLeaseStoreResult | null {
  if (draftPatch === undefined) return null;
  // A conflict lease records the exact draft that failed to rebase. Requiring
  // it to apply would erase the very state the human/editor needs to resolve.
  if (state === "conflict") return null;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(target.bytes);
  } catch {
    return invalid("draft patch requires a UTF-8 document snapshot");
  }
  const applied = applyAnchoredTextPatch(
    text,
    draftPatch as Parameters<typeof applyAnchoredTextPatch>[1],
  );
  return applied.ok ? null : invalid(`draft patch cannot rebase: ${applied.reason}`);
}

function sendTargetFailure(
  reply: { code(statusCode: number): { send(payload: unknown): unknown } },
  result: Extract<ResolveHumanEditLeaseTargetResult, { ok: false }>,
) {
  switch (result.code) {
    case "forbidden":
      return reply.code(403).send({ error: "target_forbidden" });
    case "not_found":
      return reply.code(404).send({ error: "not_found" });
  }
}

function sendStoreResult(
  reply: { code(statusCode: number): { send(payload: unknown): unknown }; send(payload: unknown): unknown },
  result: HumanEditLeaseStoreResult,
) {
  if (result.status === "not_found") return reply.code(404).send(result);
  if (result.status === "stale_generation" || result.status === "invalid") {
    return reply.code(409).send(result);
  }
  return reply.send(result);
}

function hasBoundLease(input: {
  readonly registry: HumanEditLeaseRegistry;
  readonly identity: DocumentIdentity;
  readonly leaseId: string;
  readonly humanId: string;
  readonly sessionId: string;
}): boolean {
  return input.registry
    .getForIdentity(input.identity)
    .some((record) =>
      record.lease.leaseId === input.leaseId &&
      record.lease.humanId === input.humanId &&
      record.lease.sessionId === input.sessionId,
    );
}

function sameWorkspaceIdentity(left: DocumentIdentity, right: DocumentIdentity): boolean {
  return (
    left.kind === "workspace_artifact" &&
    right.kind === "workspace_artifact" &&
    left.artifactId === right.artifactId &&
    left.logicalPath === right.logicalPath
  );
}

/**
 * HTTP transport for Workspace artifact presence only. Desktop filesystem
 * leases are process-local in the Desktop mutation runtime and never mirror
 * their canonical identity, bytes, or lifecycle over relay/server HTTP.
 */
export function humanEditLeaseRoutes(
  app: FastifyInstance,
  deps: HumanEditLeaseRoutesDeps,
): void {
  app.post("/api/document-mutations/human-edit-leases", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const parsed = registerHumanEditLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.target.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }

    const target = await deps.resolveTarget({
      request,
      candidate: parsed.data.target,
    });
    if (!target.ok) return sendTargetFailure(reply, target);
    if (target.target.identity.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }
    if (!(await requireArtifactWrite(
      { humanUserId: request.sessionUserId, artifactId: target.target.identity.artifactId },
      reply,
      deps.assertCanWriteArtifacts,
    ))) return;
    const lease = await deps.workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(target.target.identity),
    );
    try {
      // A Workspace mutation may have completed while the first target lookup
      // was waiting for its identity lock. Register only the freshly resolved
      // post-lock version.
      const currentTarget = await deps.resolveTarget({
        request,
        candidate: parsed.data.target,
      });
      if (!currentTarget.ok) return sendTargetFailure(reply, currentTarget);
      const draftFailure = draftAppliesToTarget(
        currentTarget.target,
        parsed.data.draftPatch,
        parsed.data.state,
      );
      if (draftFailure) return reply.code(409).send(draftFailure);
      return sendStoreResult(
        reply,
        deps.registry.register({
          sessionId: parsed.data.sessionId,
          humanId: request.sessionUserId,
          identity: currentTarget.target.identity,
          baseVersion: currentTarget.target.baseVersion,
          state: parsed.data.state,
          ...(parsed.data.draftPatch === undefined
            ? {}
            : { draftPatch: parsed.data.draftPatch }),
        }),
      );
    } finally {
      await lease?.release();
    }
  });

  app.patch("/api/document-mutations/human-edit-leases/:leaseId", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const parsed = updateHumanEditLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.target.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }
    const leaseId = (request.params as { leaseId?: unknown }).leaseId;
    if (typeof leaseId !== "string" || leaseId.length === 0) {
      return reply.code(400).send({ error: "invalid_lease_id" });
    }

    const target = await deps.resolveTarget({
      request,
      candidate: parsed.data.target,
    });
    if (!target.ok) return sendTargetFailure(reply, target);
    if (target.target.identity.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }
    if (!(await requireArtifactWrite(
      { humanUserId: request.sessionUserId, artifactId: target.target.identity.artifactId },
      reply,
      deps.assertCanWriteArtifacts,
    ))) return;
    const lease = await deps.workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(target.target.identity),
    );
    try {
      // Re-resolve after acquiring the same identity lock used by the
      // coordinator. A semantic lease generation/state change therefore
      // cannot race the coordinator's final admission fingerprint.
      const currentTarget = await deps.resolveTarget({
        request,
        candidate: parsed.data.target,
      });
      if (!currentTarget.ok) return sendTargetFailure(reply, currentTarget);
      if (!sameWorkspaceIdentity(currentTarget.target.identity, target.target.identity)) {
        return reply.code(404).send({ status: "not_found" });
      }
      // A lease cannot be switched to another target by an update request.
      if (!hasBoundLease({
        registry: deps.registry,
        identity: currentTarget.target.identity,
        leaseId,
        humanId: request.sessionUserId,
        sessionId: parsed.data.sessionId,
      })) {
        return reply.code(404).send({ status: "not_found" });
      }
      const draftFailure = draftAppliesToTarget(
        currentTarget.target,
        parsed.data.draftPatch,
        parsed.data.state,
      );
      if (draftFailure) return reply.code(409).send(draftFailure);
      return sendStoreResult(
        reply,
        deps.registry.update({
          leaseId,
          sessionId: parsed.data.sessionId,
          humanId: request.sessionUserId,
          expectedGeneration: parsed.data.expectedGeneration,
          baseVersion: currentTarget.target.baseVersion,
          state: parsed.data.state,
          ...(parsed.data.draftPatch === undefined
            ? {}
            : { draftPatch: parsed.data.draftPatch }),
        }),
      );
    } finally {
      await lease.release();
    }
  });

  app.post("/api/document-mutations/human-edit-leases/:leaseId/renew", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const parsed = renewHumanEditLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    if (parsed.data.target.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }
    const leaseId = (request.params as { leaseId?: unknown }).leaseId;
    if (typeof leaseId !== "string" || leaseId.length === 0) {
      return reply.code(400).send({ error: "invalid_lease_id" });
    }
    const target = await deps.resolveTarget({ request, candidate: parsed.data.target });
    if (!target.ok) return sendTargetFailure(reply, target);
    if (target.target.identity.kind !== "workspace_artifact") {
      return reply.code(400).send({ error: "workspace_artifact_required" });
    }
    if (!(await requireArtifactWrite(
      { humanUserId: request.sessionUserId, artifactId: target.target.identity.artifactId },
      reply,
      deps.assertCanWriteArtifacts,
    ))) return;
    if (!hasBoundLease({
      registry: deps.registry,
      identity: target.target.identity,
      leaseId,
      humanId: request.sessionUserId,
      sessionId: parsed.data.sessionId,
    })) {
      return reply.code(404).send({ status: "not_found" });
    }
    return sendStoreResult(reply, deps.registry.renew({
      leaseId,
      sessionId: parsed.data.sessionId,
      humanId: request.sessionUserId,
      expectedGeneration: parsed.data.expectedGeneration,
    }));
  });

  app.post("/api/document-mutations/human-edit-leases/:leaseId/release", async (request, reply) => {
    if (!request.sessionUserId) {
      return reply.code(401).send({ error: "authentication_required" });
    }
    const parsed = releaseHumanEditLeaseRequestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "invalid_request" });
    const leaseId = (request.params as { leaseId?: unknown }).leaseId;
    if (typeof leaseId !== "string" || leaseId.length === 0) {
      return reply.code(400).send({ error: "invalid_lease_id" });
    }
    const held = deps.registry.getByLeaseId(leaseId);
    if (
      held === null ||
      held.lease.identity.kind !== "workspace_artifact" ||
      held.lease.humanId !== request.sessionUserId ||
      held.lease.sessionId !== parsed.data.sessionId
    ) {
      return reply.code(404).send({ status: "not_found" });
    }
    const lease = await deps.workspaceLockManager.acquire(
      deriveDocumentIdentityLockKeys(held.lease.identity),
    );
    try {
      const current = deps.registry.getByLeaseId(leaseId);
      if (
        current === null ||
        current.lease.identity.kind !== "workspace_artifact" ||
        current.lease.humanId !== request.sessionUserId ||
        current.lease.sessionId !== parsed.data.sessionId ||
        !sameWorkspaceIdentity(current.lease.identity, held.lease.identity)
      ) {
        return reply.code(404).send({ status: "not_found" });
      }
      return sendStoreResult(reply, deps.registry.release({
        leaseId,
        sessionId: parsed.data.sessionId,
        humanId: request.sessionUserId,
        expectedGeneration: parsed.data.expectedGeneration,
      }));
    } finally {
      await lease.release();
    }
  });
}
