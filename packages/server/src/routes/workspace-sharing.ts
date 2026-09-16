import type { FastifyInstance, FastifyReply } from "fastify";
import { findArtifactByInternalIdForNamespaces, shareWorkspaceArtifact, listWorkspaceSharesForHuman } from "@nautilo/db";
import {
  envelopeReadableNamespaces,
  findActorByOwnerId,
  isScopeMemoryEnvelope,
  isUuidString,
  type ContentAccessAdmission,
  type ContentAccessReceipt,
  type createContentAccessCoordinator,
} from "@nautilo/trust";
import { eventBus } from "@nautilo/runtime";
import { requireArtifactWrite, type AssertCanWriteArtifacts } from "../lib/artifact-write-admission";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";

type LegacyHumanContentAccessPort = Pick<
  ReturnType<typeof createContentAccessCoordinator>,
  "executeLegacyHuman"
>;

const LEGACY_HUMAN_SHARE_APPROVAL_CONTEXT =
  "nautilo/content-access/legacy-human-share/v1";

export interface WorkspaceSharingService {
  findArtifact?: typeof findArtifactByInternalIdForNamespaces;
  findActor?: typeof findActorByOwnerId;
  share?: typeof shareWorkspaceArtifact;
  list?: typeof listWorkspaceSharesForHuman;
  assertWrite?: AssertCanWriteArtifacts;
  emitChanged?: (artifact: { id: string; artifactId: string; path: string }) => void;
  contentAccessCoordinator?: LegacyHumanContentAccessPort;
  loadEncryptionPolicy?: typeof currentStrictShadowPolicy;
}

function emitArtifactChanged(
  service: WorkspaceSharingService,
  artifact: { id: string; artifactId: string; path: string },
): void {
  try {
    if (service.emitChanged) service.emitChanged(artifact);
    else eventBus.emit({ type: "workspace.artifact.changed", id: artifact.id,
      artifactId: artifact.artifactId, path: artifact.path });
  } catch { /* Next explicit list refresh observes the committed attachment. */ }
}

function legacyAdmission(input: {
  userId: string;
  actorId: string;
  roomId: string;
  agentId?: string;
}): ContentAccessAdmission {
  return {
    principal: { kind: "human", userId: input.userId, actorId: input.actorId,
      sourceRoomId: input.roomId, ...(input.agentId ? { agentId: input.agentId } : {}) },
    audienceContract: "legacy_personal_grant",
    approvalContext: LEGACY_HUMAN_SHARE_APPROVAL_CONTEXT,
  };
}

function receiptStatus(receipt: ContentAccessReceipt): "shared" | "already_shared" | null {
  if (receipt.outcome === "applied") return "shared";
  if (receipt.outcome === "already_applied") return "already_shared";
  return null;
}

function isTerminalReceiptOutcome(outcome: string): outcome is ContentAccessReceipt["outcome"] {
  return ["applied", "already_applied", "partial", "denied", "stale", "failed"].includes(outcome);
}

function unavailableLegacyResult(reply: FastifyReply) {
  return reply.code(503).send({ error: "File sharing result is unavailable",
    outcome: "failed", stateChanged: "unknown" });
}

export function workspaceSharingRoutes(app: FastifyInstance, service: WorkspaceSharingService = {}) {
  const findArtifact = service.findArtifact ?? findArtifactByInternalIdForNamespaces;
  const findActor = service.findActor ?? findActorByOwnerId;
  const share = service.share ?? shareWorkspaceArtifact;
  const list = service.list ?? listWorkspaceSharesForHuman;
  app.get("/api/workspace/shared-with-me", async (request, reply) => {
    if (!request.sessionUserId) return reply.code(401).send({ error: "Authentication required" });
    const actor = await findActor(request.sessionUserId);
    if (!actor) return reply.code(403).send({ error: "Human identity required" });
    const rows = await list(actor.id);
    reply.header("Cache-Control", "private, no-store");
    return { artifacts: rows };
  });

  app.post<{ Params: { id: string }; Body: { recipientUserId?: unknown } }>(
    "/api/workspace/artifacts/:id/share", async (request, reply) => {
      const env = request.memoryEnvelope;
      if (!request.sessionUserId || !env) return reply.code(401).send({ error: "Authentication required" });
      if (isScopeMemoryEnvelope(env)) return reply.code(403).send({ error: "Human workspace context required" });
      const recipientUserId = request.body?.recipientUserId;
      if (typeof recipientUserId !== "string" || !isUuidString(recipientUserId) || recipientUserId === request.sessionUserId) {
        return reply.code(400).send({ error: "Choose another person on this server" });
      }
      if (!isUuidString(request.params.id)) return reply.code(400).send({ error: "Invalid file id" });
      const readable = envelopeReadableNamespaces(env);
      const artifact = await findArtifact({ internalId: request.params.id, readableNamespaceIds: readable });
      if (!artifact) return reply.code(404).send({ error: "File not found or no longer available" });
      if (!(await requireArtifactWrite({ humanUserId: request.sessionUserId, artifactId: artifact.id,
        ...(env.roomId ? { roomId: env.roomId } : {}),
      }, reply, service.assertWrite))) return;
      const sender = await findActor(request.sessionUserId);
      const recipient = await findActor(recipientUserId);
      if (!sender || sender.id !== env.actorId || !recipient) {
        return reply.code(404).send({ error: "Person is no longer available" });
      }
      let policy: Awaited<ReturnType<typeof currentStrictShadowPolicy>>;
      try {
        policy = await (service.loadEncryptionPolicy ?? currentStrictShadowPolicy)();
      } catch {
        return reply.code(503).send({ error: "File sharing is temporarily unavailable",
          outcome: "failed", stateChanged: false });
      }
      if (policy.mode === "plaintext_only") {
        if (!service.contentAccessCoordinator) {
          return reply.code(503).send({ error: "File sharing is temporarily unavailable",
            outcome: "failed", stateChanged: false });
        }
        let result: Awaited<ReturnType<LegacyHumanContentAccessPort["executeLegacyHuman"]>>;
        try {
          result = await service.contentAccessCoordinator.executeLegacyHuman(
            legacyAdmission({ userId: request.sessionUserId, actorId: sender.id,
              roomId: env.roomId, ...(env.agentId ? { agentId: env.agentId } : {}) }),
            { object: { kind: "artifact", id: artifact.id },
              change: { kind: "grant_people", selectedActorIds: [recipient.id] } },
          );
        } catch {
          return unavailableLegacyResult(reply);
        }
        if ("kind" in result) {
          if (!result.receipt || !isTerminalReceiptOutcome(result.receipt.outcome)) {
            return unavailableLegacyResult(reply);
          }
          const status = receiptStatus(result.receipt);
          if (status) {
            emitArtifactChanged(service, artifact);
            return { status };
          }
          if (result.receipt.stateChanged) emitArtifactChanged(service, artifact);
          const outcome = result.receipt.outcome;
          return reply.code(outcome === "denied" ? 403 : outcome === "failed" ? 503 : 409).send({
            error: outcome === "partial" ? "File sharing only partially completed"
              : outcome === "denied" ? "File sharing denied"
              : outcome === "stale" ? "File or person changed. Refresh and try again."
              : "File sharing is temporarily unavailable",
            outcome,
            stateChanged: result.receipt.stateChanged,
            receiptPersisted: true,
          });
        }
        if (!(["denied", "stale", "failed"] as const).includes(result.outcome)) {
          return unavailableLegacyResult(reply);
        }
        return reply.code(result.outcome === "denied" ? 403
          : result.outcome === "stale" ? 409 : 503).send({
          error: result.outcome === "denied" ? "File sharing denied"
            : result.outcome === "stale" ? "File or person changed. Refresh and try again."
            : "File sharing is temporarily unavailable",
          outcome: result.outcome,
          stateChanged: result.stateChanged,
          receiptPersisted: result.receiptPersisted,
          recovery: result.recovery,
        });
      }
      const result = await share({ artifactId: artifact.id, readableNamespaceIds: readable,
        senderUserId: request.sessionUserId, senderActorId: sender.id,
        recipientUserId, recipientActorId: recipient.id });
      if (!result) return reply.code(409).send({ error: "File or person changed. Refresh and try again." });
      // The share is committed. Advisory refresh failure must not turn it into a failed delivery.
      emitArtifactChanged(service, artifact);
      return { status: result.alreadyShared ? "already_shared" as const : "shared" as const };
    },
  );
}
