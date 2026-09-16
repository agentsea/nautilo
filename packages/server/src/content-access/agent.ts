import { createHmac } from "node:crypto";
import type { OrdinaryContentAccessForState, OrdinaryContentAccessPort,
  OrdinaryContentAccessPreparedOperation } from "@nautilo/agent";
import { collapseWhitespaceShareApprovalSnippet } from "@nautilo/agent";
import { findArtifactInternalIdByPublicId, getSharedDirectDb } from "@nautilo/db";
import { coerceHybridSensitivity } from "@nautilo/security";
import { findActorByHandle, findAuthorizedRoomNameCandidates,
  isScopeMemoryEnvelope, resolveAuthorizedRoomName, userHasCapability,
  type ContentAccessAdmission, type ContentAccessCommand,
  type ContentAccessPreparation, type createContentAccessCoordinator } from "@nautilo/trust";
import { currentStrictShadowPolicy } from "../lib/strict-shadow-policy";
import { resolveContentAccessPreviewKey } from "./preview-key";

type State = Parameters<OrdinaryContentAccessForState>[0];
type Coordinator = Pick<ReturnType<typeof createContentAccessCoordinator>, "prepare" | "commit" | "verifyPreparedGrantForContact">;

/** No model arguments, remembered admission, or process-local authority choose
 * the principal. Each graph boundary obtains a fresh state-bound adapter. */
export function createAgentContentAccessForState(coordinator: Coordinator): OrdinaryContentAccessForState {
  return async (state: State) => {
    if ((await currentStrictShadowPolicy()).mode !== "plaintext_only") return { mode: "unchanged" };
    const envelope = state.memoryAccessEnvelope;
    if (!state.userId || !state.agentId || !state.roomId || !envelope
      || isScopeMemoryEnvelope(envelope) || !envelope.actorId
      || envelope.roomId !== state.roomId || envelope.agentId !== state.agentId) {
      return { mode: "plaintext_only" };
    }
    const principal = Object.freeze({ kind: "agent" as const, userId: state.userId,
      actorId: envelope.actorId, agentId: state.agentId, sourceRoomId: state.roomId });
    const unavailable = (message = "Content access could not be prepared. No access was changed.") =>
      ({ status: "error" as const, message });
    const port: OrdinaryContentAccessPort = {
      async verifyPeerContact(operation) {
        const saved = operation.admission;
        if (saved.principal.kind !== principal.kind || saved.principal.userId !== principal.userId
          || saved.principal.actorId !== principal.actorId || saved.principal.agentId !== principal.agentId
          || saved.principal.sourceRoomId !== principal.sourceRoomId || saved.audienceContract !== "invoking_room") return false;
        return coordinator.verifyPreparedGrantForContact({ principal, audienceContract: "invoking_room", approvalContext: saved.approvalContext },
          operation.command, operation.previewToken);
      },
      async prepare(input) {
        if (input.operationIds.length !== input.intent.objects.length || !input.operationIds.length) return unavailable();
        try {
          let change: ContentAccessCommand["change"];
          let targetLabel: string;
          if (input.intent.target.kind === "person") {
            const target = await findActorByHandle(input.intent.target.handle);
            if (!target || target.kind !== "user") return unavailable("That local person is no longer available. No access was changed.");
            change = { kind: "grant_people", selectedActorIds: [target.actorId] };
            targetLabel = target.displayName;
          } else {
            // Choice tokens select only among freshly authorized candidates;
            // they confer neither sharing permission nor approval.
            const key = resolveContentAccessPreviewKey();
            const choice = (value: { requesterUserId: string; normalizedQuery: string; roomId: string }) =>
              createHmac("sha256", key).update("nautilo/content-access/room-choice/v1\0")
                .update(JSON.stringify([value.requesterUserId, value.normalizedQuery, value.roomId])).digest("base64url");
            const target = await resolveAuthorizedRoomName({ requesterUserId: principal.userId,
              requesterActorId: principal.actorId, targetRoomName: input.intent.target.name,
              ...(input.intent.target.choiceToken ? { roomChoiceToken: input.intent.target.choiceToken } : {}) }, {
              findAuthorizedRoomNameCandidates,
              // Reuse Room-name authority/ranking, but preserve the actual
              // object's capability instead of requiring Memory permission for files.
              userHasCapability: async (userId) => {
                for (const kind of new Set(input.intent.objects.map((object) => object.kind))) {
                  if (!await userHasCapability(userId, kind === "memory" ? "manage_memories" : "write_artifacts")) return false;
                }
                return true;
              },
              choiceTokenCodec: { issue: choice, verify: ({ token, requesterUserId, normalizedQuery, candidateRoomIds }) =>
                candidateRoomIds.find((roomId) => choice({ requesterUserId, normalizedQuery, roomId }) === token) ?? null },
            });
            if (target.status === "needs_disambiguation") return unavailable(
              `Ask which accessible Room the Human means, then prepare a new call with the same name and its choiceToken:\n${target.candidates.map((candidate) => `${candidate.label} (${candidate.kind}, ${candidate.memberCount} members): ${candidate.choiceToken}`).join("\n")}`,
            );
            if (target.status !== "resolved") return unavailable("That Room is not available for this access change. No access was changed.");
            change = { kind: "grant_room", targetRoomId: target.destination.roomId };
            targetLabel = target.destination.label;
          }
          const admission: ContentAccessAdmission = { principal, audienceContract: "invoking_room", approvalContext: input.approvalContext };
          const operations: OrdinaryContentAccessPreparedOperation[] = [];
          const preparations: ContentAccessPreparation[] = [];
          for (const [index, sourceObject] of input.intent.objects.entries()) {
            const operationId = input.operationIds[index];
            if (!operationId) return unavailable();
            const internalArtifactId = sourceObject.kind === "artifact"
              ? await findArtifactInternalIdByPublicId(sourceObject.id, getSharedDirectDb()) : null;
            if (sourceObject.kind === "artifact" && !internalArtifactId) return unavailable();
            const prepared = await coordinator.prepare(admission, { operationId,
              object: { kind: sourceObject.kind, id: internalArtifactId ?? sourceObject.id }, change });
            if (prepared.outcome !== "prepared") return unavailable();
            preparations.push(prepared);
            operations.push({ admission, command: prepared.command, previewToken: prepared.previewToken,
              expiresAt: prepared.expiresAt, sourceObject,
              ...(prepared.display.kind === "artifact" ? { artifact: { artifactId: sourceObject.id,
                path: prepared.display.path, mimeType: prepared.display.mimeType, size: prepared.display.size } } : {}) });
          }
          const first = preparations[0];
          if (!first) return unavailable();
          // Every object in one approval must have the exact same audience,
          // including display labels; a batch cannot hide later drift behind
          // its first operation. All preparations above remain read-only.
          const audienceKey = (prepared: ContentAccessPreparation) => JSON.stringify({
            humans: [...prepared.preview.humanActorIds].sort(),
            people: [...prepared.preview.people].sort((a, b) => a.actorId.localeCompare(b.actorId)),
            roomId: prepared.preview.targetRoomId, roomLabel: prepared.preview.targetRoomLabel,
            publicRoom: prepared.preview.publicRoom,
          });
          if (preparations.some((prepared) => audienceKey(prepared) !== audienceKey(first))) return unavailable(
            "The audience changed while preparing these Artifacts. Prepare the entire batch again; no access was changed.");
          if (change.kind === "grant_people") {
            const targetId = change.selectedActorIds[0];
            const target = first.preview.people.find((person) => person.actorId === targetId);
            if (!target) return unavailable();
            targetLabel = target.displayName;
          } else {
            if (!first.preview.targetRoomLabel) return unavailable();
            targetLabel = first.preview.targetRoomLabel;
          }
          const message = [...state.messages].reverse().find((entry) => entry.id === input.execution.assistantMessageId);
          const toolCall = message && "tool_calls" in message
            ? (message.tool_calls as { id?: string; args?: Record<string, unknown> }[] | undefined)?.find((call) => call.id === input.execution.toolCallId) : undefined;
          const sensitivity = coerceHybridSensitivity(toolCall?.args?.["sensitivity"]).value;
          const audience = change.kind === "grant_people"
            ? `Current conversation and ${targetLabel} (${first.preview.humanActorIds.length} people)`
            : `${targetLabel} — current and future Room members${first.preview.publicRoom ? " (public Room)" : ""}`;
          const display = first.display;
          return { status: "prepared", operations, preview: {
            name: input.execution.toolName, id: input.execution.toolCallId,
            args: { ...toolCall?.args, target: targetLabel, audience, artifacts: operations.flatMap((operation) => operation.artifact ? [operation.artifact] : []) },
            ...(display.kind === "memory" ? { shareMemoryPreview: {
              memoryContentSnippet: collapseWhitespaceShareApprovalSnippet(display.content), memoryType: display.type,
              targetHandle: input.intent.target.kind === "person" ? input.intent.target.handle : "",
              targetDisplayName: targetLabel, roomLabel: audience, wouldCreate: false, sensitivity,
            } } : { shareArtifactPreview: {
              artifactPathSnippet: collapseWhitespaceShareApprovalSnippet(display.path), mimeType: display.mimeType, size: display.size,
              targetHandle: input.intent.target.kind === "person" ? input.intent.target.handle : "",
              targetDisplayName: targetLabel, roomLabel: audience, wouldCreate: false, sensitivity,
            } }),
          } };
        } catch { return unavailable(); }
      },
      async commit(operation) {
        const saved = operation.admission;
        if (saved.principal.kind !== principal.kind || saved.principal.userId !== principal.userId
          || saved.principal.actorId !== principal.actorId || saved.principal.agentId !== principal.agentId
          || saved.principal.sourceRoomId !== principal.sourceRoomId || saved.audienceContract !== "invoking_room") {
          return { outcome: "denied", stateChanged: false, receiptPersisted: false, recovery: "prepare_again" };
        }
        return coordinator.commit({ principal, audienceContract: "invoking_room", approvalContext: saved.approvalContext },
          operation.command, operation.previewToken);
      },
    };
    return { mode: "plaintext_only", port };
  };
}
