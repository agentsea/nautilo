import {
  findArtifactByInternalIdForNamespaces,
  getNamespacesForArtifactIds,
} from "@nautilo/db";
import { warn } from "@nautilo/logger";
import { eventBus } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";

type ArtifactChangedIdentity = Readonly<{
  id: string;
  artifactId: string;
  path: string;
}>;

export interface WorkspaceArtifactAccessInvalidationDependencies {
  resolveArtifact?: (internalId: string) => Promise<ArtifactChangedIdentity | null>;
  emit?: (event: ServerEvent) => void;
}

async function resolveArtifact(internalId: string): Promise<ArtifactChangedIdentity | null> {
  const namespaces = await getNamespacesForArtifactIds([internalId]);
  const readableNamespaceIds = namespaces.get(internalId) ?? [];
  if (readableNamespaceIds.length === 0) return null;
  return findArtifactByInternalIdForNamespaces({ internalId, readableNamespaceIds });
}

/**
 * Reuses the established Artifact event lane after an ordinary access commit.
 * The event's existing delivery-time Namespace check controls each recipient;
 * this bridge never carries access metadata and never changes commit outcome.
 */
export async function invalidateWorkspaceArtifactAccess(
  internalId: string,
  dependencies: WorkspaceArtifactAccessInvalidationDependencies = {},
): Promise<void> {
  try {
    const artifact = await (dependencies.resolveArtifact ?? resolveArtifact)(internalId);
    if (!artifact) return;
    (dependencies.emit ?? ((event) => eventBus.emit(event)))({
      type: "workspace.artifact.changed",
      id: artifact.id,
      artifactId: artifact.artifactId,
      path: artifact.path,
      reloadRequired: true,
    });
  } catch (error) {
    warn(
      `[workspace-artifacts] access invalidation failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
