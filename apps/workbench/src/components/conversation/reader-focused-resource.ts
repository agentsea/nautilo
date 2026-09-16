import type { ArtifactDto } from "@nautilo/api-client/browser";
import type { ChatFocusedResourceRef } from "@nautilo/types";

export type ReaderFocusedResourceTarget =
  | { readonly kind: "workspace-artifact"; readonly artifactInternalId: string }
  | { readonly kind: "local-file"; readonly path: string; readonly rootPath: string };

/**
 * Resolve the visible Reader resource for one send. Workspace artifacts pass
 * through the active Room's authoritative projection; local files require the
 * current preload-owned relay identity and retain no cached authority.
 */
export function readerFocusedResourcesForSend(input: {
  target?: ReaderFocusedResourceTarget;
  relayId?: string | null;
  activeRoomId: string | null | undefined;
  artifactProjectionRoomId: string | null | undefined;
  artifacts: readonly ArtifactDto[];
}): ChatFocusedResourceRef[] {
  const target = input.target;
  if (!target || !input.activeRoomId) return [];
  if (target.kind === "local-file") {
    if (!input.relayId) return [];
    const name = target.path.split(/[/\\]/).pop() ?? "file";
    return [{
      kind: "local-file",
      path: target.path,
      rootPath: target.rootPath,
      name,
      relayId: input.relayId,
    }];
  }
  if (input.artifactProjectionRoomId !== input.activeRoomId) return [];
  const artifact = input.artifacts.find(
    (row) => row.id === target.artifactInternalId,
  );
  return artifact?.artifactId
    ? [{ kind: "workspace-artifact", artifactId: artifact.artifactId }]
    : [];
}
