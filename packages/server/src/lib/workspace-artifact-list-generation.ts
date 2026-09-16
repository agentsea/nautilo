/**
 * M213 Phase 8/11 — authoritative in-process generation for
 * `GET /api/workspace/artifacts` conditional reads.
 *
 * Invalidation owner: workspace artifact bus events (`workspace.artifact.*`,
 * `document.patch.applied` on artifact targets) emitted through the existing
 * `@nautilo/runtime` `eventBus` (route handlers + agent artifact-store sink).
 */

import { getNamespacesForArtifactIds } from "@nautilo/db";
import type { ServerEvent } from "@nautilo/types";
import { eventBus } from "@nautilo/runtime";
import { sha256Base64Url } from "../http/conditional-http";

export type ArtifactListReadScope = Readonly<{
  readableNamespaceIds: readonly string[];
  /** Canonical authenticated subject; prevents cross-viewer conditional reads. */
  viewerActorId: string;
  agentId: string;
  roomId: string;
  pathPrefix?: string | undefined;
  limit: number;
}>;

type NamespaceResolver = (internalIds: readonly string[]) => Promise<Map<string, string[]>>;

const generationByNamespace = new Map<string, number>();

let namespaceResolver: NamespaceResolver = (internalIds) =>
  getNamespacesForArtifactIds([...internalIds]);

let eventSubscriptionInstalled = false;

function bumpNamespaces(namespaceIds: readonly string[]): void {
  for (const namespaceId of namespaceIds) {
    if (!namespaceId) continue;
    generationByNamespace.set(namespaceId, (generationByNamespace.get(namespaceId) ?? 0) + 1);
  }
}

function artifactInternalIdFromListEvent(event: ServerEvent): string | null {
  switch (event.type) {
    case "workspace.artifact.changed":
    case "workspace.artifact.renamed":
    case "workspace.artifact.deleted":
      return event.id;
    case "document.patch.applied":
      return event.target.kind === "artifact" ? event.target.artifactInternalId : null;
    case "document.mutation.committed":
      return (event.mutation === "create" || event.mutation === "update") &&
        event.after.identity.kind === "workspace_artifact"
        ? event.after.identity.artifactId
        : null;
    default:
      return null;
  }
}

function isArtifactListInvalidatingEvent(event: ServerEvent): boolean {
  return (
    event.type === "workspace.artifact.changed" ||
    event.type === "workspace.artifact.renamed" ||
    event.type === "workspace.artifact.deleted" ||
    (event.type === "document.mutation.committed" &&
      (event.mutation === "create" || event.mutation === "update") &&
      event.after.identity.kind === "workspace_artifact") ||
    (event.type === "document.patch.applied" && event.target.kind === "artifact")
  );
}

/** Test and integration seam for the eventBus invalidation handler. */
export async function invalidateWorkspaceArtifactListFromServerEvent(
  event: ServerEvent,
): Promise<void> {
  if (!isArtifactListInvalidatingEvent(event)) return;

  if (event.type === "workspace.artifact.deleted") {
    bumpNamespaces(event.namespaceIds);
    return;
  }

  const internalId = artifactInternalIdFromListEvent(event);
  if (!internalId) return;

  const namespaces = await namespaceResolver([internalId]);
  bumpNamespaces(namespaces.get(internalId) ?? []);
}

function installEventBusInvalidationSubscription(): void {
  if (eventSubscriptionInstalled) return;
  eventSubscriptionInstalled = true;
  eventBus.on((event) => {
    void invalidateWorkspaceArtifactListFromServerEvent(event);
  });
}

/** Idempotent hook; safe to call from route registration and tests. */
export function ensureWorkspaceArtifactListGenerationSubscription(): void {
  installEventBusInvalidationSubscription();
}

/** Direct invalidation for tests and explicit namespace-scoped writers. */
export function bumpWorkspaceArtifactListGenerationForNamespaces(
  namespaceIds: readonly string[],
): void {
  bumpNamespaces(namespaceIds);
}

export function getWorkspaceArtifactListNamespaceGeneration(namespaceId: string): number {
  return generationByNamespace.get(namespaceId) ?? 0;
}

/** Opaque digest of viewer+room+query scope plus namespace generations. */
export function artifactListScopeGenerationDigest(scope: ArtifactListReadScope): string {
  const namespaceGenerations = [...scope.readableNamespaceIds]
    .sort((a, b) => a.localeCompare(b))
    .map((namespaceId) => `${namespaceId}:${generationByNamespace.get(namespaceId) ?? 0}`);
  const scopeInput = [
    scope.viewerActorId,
    scope.agentId,
    scope.roomId,
    scope.pathPrefix ?? "",
    String(scope.limit),
    namespaceGenerations.join(","),
  ].join("|");
  return sha256Base64Url(scopeInput);
}

/** Test-only reset. */
export function clearWorkspaceArtifactListGenerationForTests(): void {
  generationByNamespace.clear();
}

/** Test seam for namespace resolution on bus events without DB. */
export function setWorkspaceArtifactListNamespaceResolverForTests(
  resolver: NamespaceResolver | null,
): void {
  namespaceResolver = resolver ?? ((internalIds) => getNamespacesForArtifactIds([...internalIds]));
}
