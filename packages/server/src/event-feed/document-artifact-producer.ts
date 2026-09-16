import { emitWorkspaceArtifactCreatedFact } from "@nautilo/agent";
import type { DocumentMutationCommittedEvent } from "@nautilo/types";

/** Called by the coordinator only for a fresh, validated Workspace commit. */
export async function emitCreatedDocumentArtifacts(
  events: readonly DocumentMutationCommittedEvent[],
  namespaceId: string,
) {
  for (const event of events) {
    if (event.mutation !== "create" || event.after.identity.kind !== "workspace_artifact") continue;
    await emitWorkspaceArtifactCreatedFact({
      artifactInternalId: event.after.identity.artifactId,
      namespaceId,
      occurrenceKey: `document:${event.operationId}:${event.sequence}`,
      actor: event.actor.kind === "human" ? { kind: "human", userId: event.actor.humanId } : event.actor,
    });
  }
}
