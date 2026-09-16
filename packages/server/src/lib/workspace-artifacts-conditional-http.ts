import { weakETagFromDigestInput } from "../http/conditional-http";
import { artifactListScopeGenerationDigest, type ArtifactListReadScope } from "./workspace-artifact-list-generation";

export type WorkspaceArtifactListDto = {
  id: string;
  artifactId: string;
  path: string;
  mimeType: string;
  size: number;
  revision: number | null;
  updatedAt: string;
  createdAt: string;
  namespaceIds: string[];
  canWrite: boolean;
};

/** Stable JSON input for list hashing; does not mutate or reorder the live body. */
export function canonicalArtifactListProjectionForHash(body: {
  artifacts: WorkspaceArtifactListDto[];
}): { artifacts: WorkspaceArtifactListDto[] } {
  return {
    artifacts: [...body.artifacts]
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((artifact) => ({
        ...artifact,
        namespaceIds: [...artifact.namespaceIds].sort(),
      })),
  };
}

/** Opaque weak ETag for an authorized artifact list (M213 Phase 8/11). */
export function workspaceArtifactListWeakETagFromProjection(
  scope: ArtifactListReadScope,
  body: { artifacts: WorkspaceArtifactListDto[] },
): string {
  const generationDigest = artifactListScopeGenerationDigest(scope);
  const canonical = canonicalArtifactListProjectionForHash(body);
  return weakETagFromDigestInput(`${generationDigest}:${JSON.stringify(canonical)}`);
}
