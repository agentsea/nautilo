import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ArtifactEncryptionImplementationState =
  | "legacy_only"
  | "protected"
  | "typed_unavailable";

export type ArtifactEncryptionSurface = Readonly<{
  id: string;
  sourcePath: string;
  anchor: string;
  implementationState: ArtifactEncryptionImplementationState;
  implementationAnchors: readonly Readonly<{
    sourcePath: string;
    anchor: string;
  }>[];
}>;

const legacy = (
  id: string,
  sourcePath: string,
  anchor: string,
): ArtifactEncryptionSurface => Object.freeze({
  id,
  sourcePath,
  anchor,
  implementationState: "legacy_only",
  implementationAnchors: Object.freeze([]),
});

const protectedFoundation = (
  id: string,
  sourcePath: string,
  anchor: string,
  implementationAnchors: ArtifactEncryptionSurface["implementationAnchors"],
): ArtifactEncryptionSurface => Object.freeze({
  id,
  sourcePath,
  anchor,
  implementationState: "protected",
  implementationAnchors: Object.freeze([...implementationAnchors]),
});

const typedUnavailable = (
  id: string,
  sourcePath: string,
  anchor: string,
  implementationAnchors: ArtifactEncryptionSurface["implementationAnchors"],
): ArtifactEncryptionSurface => Object.freeze({
  id,
  sourcePath,
  anchor,
  implementationState: "typed_unavailable",
  implementationAnchors: Object.freeze([...implementationAnchors]),
});

/**
 * Executable Wave-16/17 map of the Artifact byte boundary. Protected Human
 * lifecycle entries remain explicitly dormant; ordinary product consumers
 * stay legacy until a later activation wave lands.
 */
export const ARTIFACT_ENCRYPTION_SURFACES = Object.freeze([
  protectedFoundation(
    "artifact.schema.product",
    "packages/db/src/schema/artifacts.ts",
    "export const artifacts = pgTable",
    [
      {
        sourcePath: "packages/db/src/schema/artifacts.ts",
        anchor: "artifacts_crypto_mapping_coherent",
      },
      {
        sourcePath: "packages/db/src/schema/artifact-crypto-revisions.ts",
        anchor: "export const artifactCryptoRevisions = pgTable",
      },
      {
        sourcePath: "packages/db/src/schema/artifact-crypto-blobs.ts",
        anchor: "export const artifactCryptoBlobs = pgTable",
      },
      {
        sourcePath: "packages/db/src/schema/artifact-crypto-operations.ts",
        anchor: "expected_required_namespace_fingerprint",
      },
      {
        sourcePath: "packages/db/src/queries/artifacts.ts",
        anchor: "isNotNull(artifacts.storageUri)",
      },
      {
        sourcePath: "packages/db/src/queries/workspace-document-mutations.ts",
        anchor: "isNotNull(artifacts.storageUri)",
      },
    ],
  ),
  protectedFoundation(
    "artifact.crypto.blob",
    "packages/lattice-crypto/src/artifact/blob-v1.ts",
    "export interface ArtifactBlobHeaderV1",
    [
      {
        sourcePath: "packages/lattice-crypto/src/artifact/blob-v1.ts",
        anchor: "export function sealArtifactBlobChunkV1",
      },
      {
        sourcePath: "packages/lattice-crypto/src/artifact/blob-v1.ts",
        anchor: "export function openArtifactBlobRangeV1",
      },
    ],
  ),
  protectedFoundation(
    "artifact.crypto.control",
    "packages/lattice-crypto/src/artifact/control-v1.ts",
    "export interface ArtifactControlV1",
    [
      {
        sourcePath: "packages/lattice-crypto/src/artifact/control-v1.ts",
        anchor: "export function decodeArtifactControlV1",
      },
    ],
  ),
  protectedFoundation(
    "artifact.blob.filesystem",
    "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts",
    "export function createFilesystemEncryptedArtifactBlobStoreV1",
    [
      {
        sourcePath: "packages/lattice-bridge/src/artifact/filesystem-blob-store.ts",
        anchor: "export interface EncryptedArtifactBlobStoreV1",
      },
    ],
  ),
  protectedFoundation(
    "artifact.repository.shadow",
    "packages/lattice-bridge/src/artifact/artifact-shadow-saga.ts",
    "export function createDormantArtifactShadowRepository",
    [
      {
        sourcePath: "packages/lattice-bridge/src/server/artifact/postgres-artifact-crypto-completion.ts",
        anchor: "export function createPostgresArtifactCryptoCompletion",
      },
      {
        sourcePath: "packages/lattice-bridge/src/server/artifact/postgres-artifact-product-publication.ts",
        anchor: "export class PostgresArtifactProductPublication",
      },
    ],
  ),
  protectedFoundation(
    "artifact.crypto.human-publication",
    "packages/lattice-crypto/src/artifact/publication-request-v1.ts",
    "export function prepareHumanArtifactPublicationRequestV1",
    [
      {
        sourcePath: "packages/lattice-bridge/src/server/artifact/human-artifact-prepared-publication.ts",
        anchor: "export async function authenticateHumanArtifactPublication",
      },
    ],
  ),
  protectedFoundation(
    "artifact.crypto.human-access",
    "packages/lattice-crypto/src/artifact/exact-access-request-v1.ts",
    "export function prepareHumanArtifactExactAccessRequestV1",
    [
      {
        sourcePath: "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-crypto.ts",
        anchor: "export class PostgresHumanArtifactExactAccessCryptoCompletion",
      },
      {
        sourcePath: "packages/lattice-bridge/src/server/artifact/postgres-human-artifact-exact-access-product.ts",
        anchor: "export class PostgresHumanArtifactExactAccessProduct",
      },
    ],
  ),
  protectedFoundation(
    "artifact.client.human",
    "packages/lattice-bridge/src/client/artifact/authorized-human-artifact-client.ts",
    "export function createAuthorizedHumanArtifactClient",
    [
      {
        sourcePath: "packages/lattice-bridge/src/client/artifact/vault-human-artifact-device-content.ts",
        anchor: "export function createVaultHumanArtifactDeviceContentPort",
      },
      {
        sourcePath: "packages/lattice-bridge/src/client/artifact/prepared-artifact-ciphertext-sidecar.ts",
        anchor: "export function createPreparedArtifactMutationJournal",
      },
    ],
  ),
  protectedFoundation(
    "artifact.route.human-dormant",
    "packages/server/src/routes/protected-artifact-routes.ts",
    "export function protectedArtifactRoutes",
    [
      {
        sourcePath: "packages/server/src/routes/protected-artifact-composition.ts",
        anchor: "export function createProtectedArtifactTestComposition",
      },
      {
        sourcePath: "packages/server/src/routes/protected-artifact-exact-access-target.ts",
        anchor: "export function createHumanArtifactExactAccessTargetResolver",
      },
    ],
  ),
  protectedFoundation(
    "artifact.viewer.human-dormant",
    "apps/workbench/src/viewers/types.ts",
    "artifactBytes?: ArtifactViewerByteSource",
    [
      {
        sourcePath: "apps/workbench/src/components/work-surface/reader-surface.tsx",
        anchor: "artifactBytes?: ArtifactViewerByteSource",
      },
      {
        sourcePath: "packages/lattice-bridge/src/client/artifact/authorized-human-artifact-client.ts",
        anchor: "export function createAuthorizedHumanArtifactViewerByteSource",
      },
      {
        sourcePath: "apps/workbench/tests/unit/viewer-registry.test.ts",
        anchor: "explicit protected Artifact bytes reach a bounded existing viewer",
      },
    ],
  ),
  legacy("artifact.store.agent", "packages/agent/src/tools/file/artifact-store.ts", "export async function resolveWorkspaceArtifact"),
  legacy("artifact.route.server", "packages/server/src/routes/workspace-artifacts.ts", "export function workspaceArtifactsRoutes"),
  legacy("artifact.viewer.web", "apps/workbench/src/viewers/registry.ts", "export function adapterForFile"),
  legacy("artifact.office.wopi", "packages/server/src/routes/wopi.ts", "export function wopiRoutes"),
  legacy("artifact.office.mutation", "packages/server/src/document-mutations/workspace-editor-save-service.ts", "export async function saveWorkspaceEditorSnapshot"),
  legacy("artifact.agent.share", "packages/agent/src/tools/file/share-artifact.ts", "export function createShareArtifactTool"),
  legacy("artifact.agent.generated_image", "packages/agent/src/tools/media/generate-image.ts", "export function createGenerateImageTool"),
  legacy("artifact.backup.revisions", "packages/agent/src/tools/file/backups/record-revision.ts", "export async function recordRevision"),
  legacy("artifact.backup.gc", "packages/agent/src/tools/file/backups/gc.ts", "export async function sweepHourly"),
  legacy("artifact.state", "packages/db/src/schema/artifact-state.ts", "export const artifactState = pgTable"),
  legacy("artifact.events", "packages/db/src/schema/pending-artifact-events.ts", "export const pendingArtifactEvents = pgTable"),
  typedUnavailable(
    "artifact.portability",
    "packages/server/src/routes/profile-bundle.ts",
    "async function defaultReadArtifactBytes",
    [
      {
        sourcePath: "packages/server/src/routes/profile-bundle.ts",
        anchor: "AND a.crypto_object_id IS NULL",
      },
      {
        sourcePath: "packages/server/src/routes/profile-bundle.ts",
        anchor: "isNull(artifactsTable.cryptoObjectId)",
      },
    ],
  ),
] as const);

export function validateArtifactEncryptionInventory(
  repositoryRoot: string,
  surfaces: readonly ArtifactEncryptionSurface[] = ARTIFACT_ENCRYPTION_SURFACES,
): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const surface of surfaces) {
    if (ids.has(surface.id)) {
      errors.push(`duplicate Artifact encryption surface id: ${surface.id}`);
    }
    ids.add(surface.id);
    const path = resolve(repositoryRoot, surface.sourcePath);
    if (!existsSync(path)) {
      errors.push(`missing Artifact encryption source: ${surface.sourcePath}`);
      continue;
    }
    if (!readFileSync(path, "utf8").includes(surface.anchor)) {
      errors.push(
        `missing Artifact encryption anchor: ${surface.sourcePath}#${surface.anchor}`,
      );
    }
    if (
      surface.implementationState !== "legacy_only"
      && surface.implementationAnchors.length === 0
    ) {
      errors.push(`protected Artifact surface has no implementation anchor: ${surface.id}`);
    }
    for (const implementation of surface.implementationAnchors) {
      const implementationPath = resolve(repositoryRoot, implementation.sourcePath);
      if (!existsSync(implementationPath)) {
        errors.push(`missing Artifact implementation source: ${implementation.sourcePath}`);
      } else if (!readFileSync(implementationPath, "utf8").includes(implementation.anchor)) {
        errors.push(
          `missing Artifact implementation anchor: ${implementation.sourcePath}#${implementation.anchor}`,
        );
      }
    }
  }
  return errors.sort();
}
