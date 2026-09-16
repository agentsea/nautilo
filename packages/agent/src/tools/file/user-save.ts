/**
 * M180 — human workbench artifact byte-save helper.
 *
 * Persists editor text to workspace artifact storage with revision + sha
 * conflict guards and sparse user-authored checkpoint recording.
 */

import { randomUUID } from "node:crypto";
import * as fsp from "node:fs/promises";
import { FILE_REVISION_AUTHOR, findRecentRevision, type Artifact, type DirectDatabase } from "@nautilo/db";
import { warn } from "@nautilo/logger";
import {
  assertCanWriteArtifacts,
  type MemoryAccessEnvelope,
} from "@nautilo/trust";
import { withAgentTrustContext } from "../../store/trust-agent-db";
import {
  applyWorkspaceArtifactRowChange,
  envelopeFactsForArtifacts,
  physicalPathFromStorageUri,
  resolveWorkspaceArtifact,
  validateLogicalPath,
  type WorkspaceArtifactPatchMeta,
} from "./artifact-store";
import { writeAtomic } from "./atomic-write";
import { recordRevision } from "./backups/record-revision";
import { pickMutationNamespaceId } from "./workspace-commands";
import { sha256Hex } from "./staged-patches";

/**
 * Ceiling for user-driven workspace-artifact text saves, patches, and mini-app
 * document reads. Raised to the officecli `.docx` generated cap (50 MB, see
 * `DELIVERED_FORMAT_LIMITS.generatedBytesDocx`) so Writer/office documents —
 * which embed inline base64 images and round-trip to `.docx` — can be saved
 * and re-opened. Kept in lock-step with the Writer container cap
 * (`MAX_DOCUMENT_BYTES`) and the app-bridge document-read cap
 * (`MAX_APP_DOCUMENT_BYTES`).
 */
export const USER_SAVE_TEXT_LIMIT_BYTES = 50 * 1024 * 1024;

export const CHECKPOINT_COALESCE_MS = 5 * 60 * 1000;

export type UserSaveResult =
  | { ok: true; revision: number; size: number; sha256: string }
  | { ok: false; code: "conflict"; currentSha256: string | null }
  | {
      ok: false;
      code: "not_found" | "forbidden" | "too_large" | "error";
      message: string;
    };

export function shouldRecordCheckpoint(
  checkpoint: boolean,
  lastCreatedAt: Date | null,
  now: Date,
): boolean {
  if (!checkpoint) return false;
  if (lastCreatedAt === null) return true;
  return now.getTime() - lastCreatedAt.getTime() >= CHECKPOINT_COALESCE_MS;
}

export function conflictReason(input: {
  baseRevision: number | null;
  rowRevision: number | null;
  baseSha256: string | null;
  currentSha256: string;
}): null | "revision" | "sha" {
  if (
    input.baseRevision !== null &&
    input.rowRevision !== null &&
    input.baseRevision !== input.rowRevision
  ) {
    return "revision";
  }
  if (input.baseSha256 !== null && input.baseSha256 !== input.currentSha256) {
    return "sha";
  }
  return null;
}

async function readCurrentBytes(physicalPath: string): Promise<Buffer | { error: string }> {
  try {
    return await fsp.readFile(physicalPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return Buffer.alloc(0);
    }
    return { error: msg };
  }
}

export async function userSaveWorkspaceArtifact(input: {
  envelope: MemoryAccessEnvelope;
  logicalPath?: string;
  artifact?: Artifact;
  newText: string;
  baseSha256: string | null;
  baseRevision: number | null;
  checkpoint: boolean;
  mimeType?: string | undefined;
  clientMutationId?: string | undefined;
  now?: Date | undefined;
}): Promise<UserSaveResult> {
  const now = input.now ?? new Date();

  const factsResult = envelopeFactsForArtifacts(input.envelope);
  if (!factsResult.ok) {
    return { ok: false, code: "forbidden", message: factsResult.reason };
  }
  const facts = factsResult.facts;
  if (!facts.agentId) {
    return {
      ok: false,
      code: "forbidden",
      message: "workspace artifact access requires an authenticated agent context.",
    };
  }
  if (facts.mutableNamespaces.length === 0) {
    return {
      ok: false,
      code: "forbidden",
      message: "no mutable namespace for workspace artifact writes.",
    };
  }

  const logicalPath = input.artifact?.path ?? input.logicalPath;
  const validated = validateLogicalPath(logicalPath);
  if (!validated.ok) {
    return { ok: false, code: "error", message: validated.reason };
  }

  const newBytes = Buffer.from(input.newText, "utf8");
  if (newBytes.byteLength > USER_SAVE_TEXT_LIMIT_BYTES) {
    return {
      ok: false,
      code: "too_large",
      message: `content exceeds ${USER_SAVE_TEXT_LIMIT_BYTES} byte limit`,
    };
  }

  const resolved = input.artifact
    ? (() => {
        const physicalPath = physicalPathFromStorageUri(input.artifact.storageUri);
        if (!physicalPath) {
          return {
            ok: false as const,
            code: "error" as const,
            message: `Artifact ${input.artifact.artifactId} has unrecognized storage_uri scheme; M088B only handles file:// URIs.`,
          };
        }
        return {
          ok: true as const,
          row: input.artifact,
          physicalPath,
          artifactId: input.artifact.artifactId,
          storageUri: input.artifact.storageUri,
          logicalPath: validated.path,
        };
      })()
    : await (async () => {
        const resolution = await resolveWorkspaceArtifact({
          logicalPath: validated.path,
          facts,
          intent: "mutate",
        });
        if (!resolution.ok) {
          if (resolution.reason.includes("No workspace artifact found at")) {
            return { ok: false as const, code: "not_found" as const, message: resolution.reason };
          }
          return { ok: false as const, code: "forbidden" as const, message: resolution.reason };
        }
        if (!resolution.artifact) {
          return {
            ok: false as const,
            code: "not_found" as const,
            message: `No workspace artifact at "${validated.path}".`,
          };
        }
        return {
          ok: true as const,
          row: resolution.artifact,
          physicalPath: resolution.physicalPath,
          artifactId: resolution.artifactId,
          storageUri: resolution.storageUri,
          logicalPath: resolution.logicalPath,
        };
      })();
  if (!resolved.ok) {
    return resolved;
  }

  const row = resolved.row;
  const namespaceId = await pickMutationNamespaceId(row.id, facts);
  if (!namespaceId) {
    return {
      ok: false,
      code: "error",
      message: `artifact ${resolved.artifactId} has no namespace attachment (orphaned junction).`,
    };
  }
  await assertCanWriteArtifacts({
    humanUserId: facts.userId,
    namespaceId,
    artifactId: row.id,
  });

  const preBytesResult = await readCurrentBytes(resolved.physicalPath);
  if (!Buffer.isBuffer(preBytesResult)) {
    return {
      ok: false,
      code: "error",
      message: `could not read artifact bytes: ${preBytesResult.error}`,
    };
  }
  const preBytes = preBytesResult;
  const currentSha256 = sha256Hex(preBytes);

  const conflict = conflictReason({
    baseRevision: input.baseRevision,
    rowRevision: row.revision,
    baseSha256: input.baseSha256,
    currentSha256,
  });
  if (conflict) {
    return { ok: false, code: "conflict", currentSha256 };
  }

  let lastCreatedAt: Date | null = null;
  if (input.checkpoint) {
    const recent = await withAgentTrustContext(
      { userId: facts.userId, agentId: facts.agentId },
      async (tx) => {
        const conn = tx as unknown as DirectDatabase;
        return findRecentRevision(conn, {
          agentId: facts.agentId,
          absolutePath: resolved.physicalPath,
          authoredBy: FILE_REVISION_AUTHOR.USER,
          userId: facts.userId,
        });
      },
    );
    lastCreatedAt = recent?.createdAt ?? null;
  }

  try {
    await writeAtomic(resolved.physicalPath, newBytes);
  } catch (err) {
    return {
      ok: false,
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  const mimeType =
    input.mimeType !== undefined && input.mimeType.length > 0
      ? input.mimeType
      : undefined;

  const meta: WorkspaceArtifactPatchMeta = {
    mode: "update",
    artifactId: resolved.artifactId,
    logicalPath: resolved.logicalPath,
    namespaceId,
    storageUri: resolved.storageUri,
    ...(mimeType ? { mimeType } : {}),
    ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
    rowId: row.id,
  };

  try {
    await applyWorkspaceArtifactRowChange(
      meta,
      newBytes.byteLength,
      facts.userId,
      facts.agentId,
      { kind: "human", userId: facts.userId },
    );
  } catch (err) {
    return {
      ok: false,
      code: "error",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  if (shouldRecordCheckpoint(input.checkpoint, lastCreatedAt, now)) {
    try {
      const revision = await recordRevision({
        preBytes,
        postBytes: newBytes,
        absolutePath: resolved.physicalPath,
        operation: "write",
        ownerId: facts.userId,
        agentId: facts.agentId,
        roomId: input.envelope.roomId,
        turnId: `user-edit:${randomUUID()}`,
        authoredBy: FILE_REVISION_AUTHOR.USER,
        userId: facts.userId,
      });
      if (!revision.ok) {
        warn(
          `[user-save] checkpoint skipped for ${resolved.logicalPath}: ${revision.reason}`,
        );
      }
    } catch (err) {
      warn(
        `[user-save] checkpoint failed for ${resolved.logicalPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return {
    ok: true,
    revision: row.revision + 1,
    size: newBytes.byteLength,
    sha256: sha256Hex(newBytes),
  };
}
