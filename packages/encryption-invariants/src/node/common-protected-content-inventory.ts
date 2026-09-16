import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

export type ObjectAccessCodecFamily =
  | "common_v5"
  | "conversation_v2_v3"
  | "journal_v4"
  | "reflection_v3";

export type ObjectAccessCodecConsumer = Readonly<{
  id: string;
  family: ObjectAccessCodecFamily;
  sourcePath: string;
  anchor: string;
}>;

/**
 * Reviewed production-source ownership for every retained object-access codec
 * family. Wave 18 clean-breaks only dormant Memory and Artifact content; the
 * other families remain deliberately versioned and must not drift into a
 * permissive decode-any path.
 */
export const OBJECT_ACCESS_CODEC_CONSUMERS = Object.freeze([
  {
    id: "common.storage",
    family: "common_v5",
    sourcePath: "packages/lattice-crypto/src/format/object-access-manifest.ts",
    anchor: "export function decodeObjectAccessStorageManifest(",
  },
  {
    id: "common.server.history",
    family: "common_v5",
    sourcePath:
      "packages/lattice-bridge/src/server/storage/postgres-object-access-manifest-v5.ts",
    anchor: "export async function verifyStoredObjectAccessManifestChainV5(",
  },
  {
    id: "memory.human.client",
    family: "common_v5",
    sourcePath:
      "packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts",
    anchor: "verifyCommonObjectAccessManifestChain(input.crypto, {",
  },
  {
    id: "memory.agent.prepared",
    family: "common_v5",
    sourcePath: "packages/lattice-bridge/src/memory/memory-prepared-revision.ts",
    anchor: "decodeObjectAccessManifestV5(input.access.manifestBytes)",
  },
  {
    id: "artifact.human.client",
    family: "common_v5",
    sourcePath:
      "packages/lattice-bridge/src/client/artifact/vault-human-artifact-device-content.ts",
    anchor: "verifyCommonObjectAccessManifestChain(input.dependencies.crypto, {",
  },
  {
    id: "artifact.prepared",
    family: "common_v5",
    sourcePath: "packages/lattice-bridge/src/artifact/artifact-prepared-revision.ts",
    anchor: "decodeObjectAccessManifestV5(input.access.manifestBytes)",
  },
  {
    id: "conversation.prepared",
    family: "conversation_v2_v3",
    sourcePath:
      "packages/lattice-bridge/src/message/conversation-prepared-revision.ts",
    anchor: "decodeObjectAccessManifestV2(input.access.manifestBytes)",
  },
  {
    id: "journal.processor",
    family: "journal_v4",
    sourcePath:
      "packages/lattice-bridge/src/server/journal/postgres-protected-journal-processor-object-verifier.ts",
    anchor: "decodeObjectAccessManifestV4(manifestBytes)",
  },
  {
    id: "reflection.record",
    family: "reflection_v3",
    sourcePath: "packages/reflection-bridge/src/server/protected-record-crypto.ts",
    anchor: "decodeObjectAccessManifestV3(access.head.manifestBytes)",
  },
] satisfies readonly ObjectAccessCodecConsumer[]);

export const COMMON_PROTECTED_CONTENT_AI_BOUNDARIES = Object.freeze([
  {
    sourcePath:
      "packages/lattice-bridge/src/client/memory/vault-human-memory-device-content.ts",
    anchor: "payload.context.keyClass !== \"ai\"",
  },
  {
    sourcePath:
      "packages/lattice-bridge/src/client/artifact/vault-human-artifact-device-content.ts",
    anchor: "payload.context.keyClass !== \"ai\"",
  },
  {
    sourcePath: "packages/lattice-bridge/src/memory/memory-prepared-revision.ts",
    anchor: "payload.context.keyClass !== \"ai\"",
  },
  {
    sourcePath: "packages/lattice-bridge/src/artifact/artifact-prepared-revision.ts",
    anchor: "payload.context.keyClass !== \"ai\"",
  },
]);

export function validateCommonProtectedContentInventory(
  repositoryRoot: string,
): readonly string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const consumer of OBJECT_ACCESS_CODEC_CONSUMERS) {
    if (ids.has(consumer.id)) {
      errors.push(`duplicate object-access codec consumer: ${consumer.id}`);
    }
    ids.add(consumer.id);
    const path = resolve(repositoryRoot, consumer.sourcePath);
    if (!existsSync(path)) {
      errors.push(`missing object-access codec consumer: ${consumer.sourcePath}`);
    } else if (!readFileSync(path, "utf8").includes(consumer.anchor)) {
      errors.push(
        `moved object-access codec consumer: ${consumer.sourcePath}#${consumer.anchor}`,
      );
    }
  }
  for (const boundary of COMMON_PROTECTED_CONTENT_AI_BOUNDARIES) {
    const path = resolve(repositoryRoot, boundary.sourcePath);
    if (!existsSync(path)) {
      errors.push(`missing common protected-content boundary: ${boundary.sourcePath}`);
    } else if (!readFileSync(path, "utf8").includes(boundary.anchor)) {
      errors.push(
        `common protected-content boundary is not AI-only: ${boundary.sourcePath}`,
      );
    }
  }
  const appSource = readFileSync(
    resolve(repositoryRoot, "packages/server/src/app.ts"),
    "utf8",
  );
  for (const forbidden of [
    "protectedArtifactRoutes(",
    "protectedMemoryRoutes(",
    "protectedMemoryExactAccessRoutes(",
    "createProtectedArtifactTestComposition(",
    "createProtectedMemoryTestShadowComposition(",
    "createProtectedMemoryExactAccessTestComposition(",
  ]) {
    if (appSource.includes(forbidden)) {
      errors.push(`production app reaches dormant protected content: ${forbidden}`);
    }
  }
  return errors.sort();
}
