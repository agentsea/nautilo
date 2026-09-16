/**
 * ISSUE-M193 — central workspace-artifact bus forwarding (cache + runtime emit).
 */

import type { WorkspaceArtifactBusEvent } from "@nautilo/agent";
import { appendWorkspaceArtifactPatchEvent } from "./workspace-artifact-patch-cache";

export function forwardWorkspaceArtifactBusEvent(
  event: WorkspaceArtifactBusEvent,
  emit: (event: WorkspaceArtifactBusEvent) => void,
): void {
  if (event.type === "document.patch.applied" && event.target.kind === "artifact") {
    appendWorkspaceArtifactPatchEvent(event.target.artifactInternalId, event);
  }
  emit(event);
}
