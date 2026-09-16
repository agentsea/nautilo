import * as fsp from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import * as path from "node:path";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import {
  applyWorkspaceArtifactRowChange,
  envelopeFactsForArtifacts,
  resolveWorkspaceArtifact,
  validateLogicalPath,
  type WorkspaceArtifactPatchMeta,
  type WorkspaceArtifactCreationActor,
  type WorkspaceArtifactRowApplyResult,
} from "./artifact-store";
import {
  AtomicPublishCommittedError,
  publishFileIfAbsent,
  writeAtomic,
  writeAtomicIfAbsent,
} from "./atomic-write";
import { sha256Hex } from "./staged-patches";

export type CreateWorkspaceBinaryArtifactResult =
  | {
      ok: true;
      artifactId: string;
      artifactInternalId: string;
      displayPath: string;
      revision: number | null;
      size: number;
      sha256: string;
    }
  | {
      ok: false;
      code: string;
      message: string;
      /** Present when bytes changed but authoritative row metadata is unconfirmed. */
      displayPath?: string;
      bytesWritten?: number;
      metadataConfirmed?: false;
      stateChanged?: true;
      retrySafe?: false;
    };

type WorkspaceBinaryArtifactInput = {
  envelope: MemoryAccessEnvelope;
  /** True initiating author, or explicit null for an excluded/internal producer. */
  actor: WorkspaceArtifactCreationActor | null;
  logicalPath: string;
  mimeType: string;
  clientMutationId?: string | undefined;
  /**
   * M205 — pin the new artifact to a specific namespace instead of the
   * default `writableNamespaces[0]`. Used by conversion-import so an imported
   * artifact lands in the SAME namespace as its source. Ignored (falls back to
   * the default) if it isn't in the caller's writable set, since attaching to a
   * non-writable namespace would fail RLS.
   */
  namespaceId?: string | undefined;
  /**
   * M205 — collision policy. When false (default) an existing artifact at the
   * logical path is a hard `EXISTS` collision (the UI prompts overwrite /
   * rename / cancel). When true, an existing artifact is overwritten in place:
   * its bytes are replaced and its revision is bumped (the row id + history are
   * preserved), so viewers re-bind rather than orphaning.
   */
  overwrite?: boolean | undefined;
};

async function createWorkspaceBinaryArtifactWithWriter(
  input: WorkspaceBinaryArtifactInput,
  write: (
    physicalPath: string,
    overwrite: boolean,
  ) => Promise<{ size: number; sha256: string }>,
): Promise<CreateWorkspaceBinaryArtifactResult> {
  const factsResult = envelopeFactsForArtifacts(input.envelope);
  if (!factsResult.ok) {
    return { ok: false, code: "FORBIDDEN", message: factsResult.reason };
  }
  const facts = factsResult.facts;
  if (!facts.agentId) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "workspace artifact access requires an authenticated agent context.",
    };
  }
  if (facts.writableNamespaces.length === 0) {
    return {
      ok: false,
      code: "FORBIDDEN",
      message: "No writable namespace for artifact create.",
    };
  }

  const pathCheck = validateLogicalPath(input.logicalPath);
  if (!pathCheck.ok) {
    return { ok: false, code: "INVALID_PATH", message: pathCheck.reason };
  }

  const resolution = await resolveWorkspaceArtifact({
    logicalPath: pathCheck.path,
    facts,
    intent: input.overwrite ? "create_or_update" : "create",
  });
  if (!resolution.ok) {
    // Under intent "create" the sole resolver failure is a pre-existing
    // artifact at this path → a distinct `EXISTS` code the conversion tools
    // map to a user-facing overwrite/rename/cancel prompt. Under
    // "create_or_update" a failure is a genuine conflict (e.g. a row with an
    // unrecognized storage_uri scheme), not a plain collision.
    return {
      ok: false,
      code: input.overwrite ? "CONFLICT" : "EXISTS",
      message: resolution.reason,
    };
  }

  const targetNamespaceId =
    input.namespaceId && facts.writableNamespaces.includes(input.namespaceId)
      ? input.namespaceId
      : facts.writableNamespaces[0]!;
  // Overwrite of an existing artifact updates the row in place (bump revision,
  // reuse id/uri); a fresh path creates a new row + namespace junction.
  const existingRow = resolution.artifact;
  const meta: WorkspaceArtifactPatchMeta = existingRow
    ? {
        mode: "update",
        artifactId: resolution.artifactId,
        logicalPath: resolution.logicalPath,
        namespaceId: targetNamespaceId,
        storageUri: resolution.storageUri,
        rowId: existingRow.id,
        mimeType: input.mimeType,
        ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
      }
    : {
        mode: "create",
        artifactId: resolution.artifactId,
        logicalPath: resolution.logicalPath,
        namespaceId: targetNamespaceId,
        storageUri: resolution.storageUri,
        mimeType: input.mimeType,
        ...(input.clientMutationId ? { clientMutationId: input.clientMutationId } : {}),
      };

  let written: { size: number; sha256: string };
  try {
    await fsp.mkdir(path.dirname(resolution.physicalPath), { recursive: true });
    written = await write(resolution.physicalPath, input.overwrite === true);
  } catch (err) {
    if (err instanceof AtomicPublishCommittedError) {
      const publishedSize = await fsp
        .stat(resolution.physicalPath)
        .then((stat) => stat.size)
        .catch(() => undefined);
      return {
        ok: false,
        code: "PARTIAL_WRITE",
        message:
          `Workspace bytes were published to "${resolution.logicalPath}", but post-commit ` +
          `durability or cleanup was not confirmed; metadata was not attempted and the ` +
          `artifact must be reconciled before retrying. ${err.message}`,
        displayPath: resolution.logicalPath,
        ...(publishedSize === undefined ? {} : { bytesWritten: publishedSize }),
        metadataConfirmed: false,
        stateChanged: true,
        retrySafe: false,
      };
    }
    if (!input.overwrite && (err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return {
        ok: false,
        code: "EXISTS",
        message: `An artifact already exists at "${resolution.logicalPath}".`,
      };
    }
    return {
      ok: false,
      code: "WRITE_FAILED",
      message: err instanceof Error ? err.message : String(err),
    };
  }

  let rowResult: WorkspaceArtifactRowApplyResult | null;
  try {
    rowResult = await applyWorkspaceArtifactRowChange(
      meta,
      written.size,
      facts.userId,
      facts.agentId,
      input.actor,
    );
  } catch (err) {
    return {
      ok: false,
      code: "PARTIAL_WRITE",
      message:
        `Workspace bytes were written to "${resolution.logicalPath}" (${written.size} bytes), ` +
        `but authoritative artifact metadata was not confirmed; state is unknown/partial and ` +
        `must be reconciled before retrying. ${err instanceof Error ? err.message : String(err)}`,
      displayPath: resolution.logicalPath,
      bytesWritten: written.size,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    };
  }

  if (!rowResult) {
    return {
      ok: false,
      code: "PARTIAL_WRITE",
      message:
        `Workspace bytes were written to "${resolution.logicalPath}" (${written.size} bytes), ` +
        `but its authoritative artifact row changed or disappeared; metadata was not confirmed, ` +
        `state is unknown/partial, and the artifact must be reconciled before retrying.`,
      displayPath: resolution.logicalPath,
      bytesWritten: written.size,
      metadataConfirmed: false,
      stateChanged: true,
      retrySafe: false,
    };
  }

  return {
    ok: true,
    artifactId: rowResult.artifactId,
    artifactInternalId: rowResult.internalId,
    displayPath: rowResult.path,
    revision: rowResult.revision,
    size: written.size,
    sha256: written.sha256,
  };
}

export async function createWorkspaceBinaryArtifact(input: WorkspaceBinaryArtifactInput & {
  bytes: Buffer | Uint8Array;
}): Promise<CreateWorkspaceBinaryArtifactResult> {
  const bytes = Buffer.isBuffer(input.bytes) ? input.bytes : Buffer.from(input.bytes);
  return createWorkspaceBinaryArtifactWithWriter(
    input,
    async (physicalPath, overwrite) => {
      if (overwrite) await writeAtomic(physicalPath, bytes);
      else await writeAtomicIfAbsent(physicalPath, bytes);
      return { size: bytes.byteLength, sha256: sha256Hex(bytes) };
    },
  );
}

/**
 * Stream provider output directly into the ordinary Workspace artifact lane.
 * The temporary file is fsynced and atomically published on the artifact
 * filesystem; no provider bytes or base64 payloads enter the tool receipt or
 * model context.
 */
export async function createWorkspaceBinaryArtifactFromStream(input: WorkspaceBinaryArtifactInput & {
  chunks: AsyncIterable<Uint8Array>;
}): Promise<CreateWorkspaceBinaryArtifactResult> {
  return createWorkspaceBinaryArtifactWithWriter(input, async (physicalPath, overwrite) => {
    const temporaryPath = `${physicalPath}.${randomUUID()}.tmp`;
    const hash = createHash("sha256");
    let size = 0;
    let handle: Awaited<ReturnType<typeof fsp.open>> | null = null;
    try {
      handle = await fsp.open(temporaryPath, "wx", 0o644);
      for await (const chunk of input.chunks) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        let offset = 0;
        while (offset < bytes.byteLength) {
          const { bytesWritten } = await handle.write(bytes, offset, bytes.byteLength - offset);
          if (bytesWritten <= 0) throw new Error("workspace artifact stream made no write progress");
          offset += bytesWritten;
        }
        size += bytes.byteLength;
        hash.update(bytes);
      }
      await handle.sync();
      await handle.close();
      handle = null;
      if (overwrite) await fsp.rename(temporaryPath, physicalPath);
      else await publishFileIfAbsent(temporaryPath, physicalPath);
      return { size, sha256: hash.digest("hex") };
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await fsp.rm(temporaryPath, { force: true }).catch(() => undefined);
      throw error;
    }
  });
}
