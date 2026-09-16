/** D448 server-owned final commit seam for Workspace file-tool content candidates. */
import { createHash } from "node:crypto";
import type {
  WorkspaceFileContentCommitExecution,
  WorkspaceFileContentCommitRequest,
  WorkspaceFileContentRecoveryExecution,
  WorkspaceFileContentRecoveryRequest,
  WorkspaceFileContentSnapshot,
} from "@nautilo/agent";
import {
  acquireWorkspaceDocumentMutationOperationLock,
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findWorkspaceDocumentMutationForRecovery,
  resolveWorkspaceRoomMutationAuthority,
} from "@nautilo/db";
import type { BackendCommitPlan } from "@nautilo/document-mutations";
import type {
  WorkspaceDocumentIdentity,
  WorkspaceDocumentVersion,
} from "@nautilo/types";
import {
  executeWorkspaceAgentMutation,
  type WorkspaceAgentMutationCoordinatorDependencies,
} from "./workspace-agent-mutation-coordinator";
import { getServerDirectDb } from "../lib/server-direct-db";
import { readWorkspaceDocumentMutationContent } from "./workspace-artifact-mutation-backend";

export type WorkspaceFileContentCoordinatorAdapterDependencies =
  WorkspaceAgentMutationCoordinatorDependencies & {
    /** Hermetic immutable-content read seam. */
    readonly readCommittedContent?: (storageUri: string) => Promise<Uint8Array>;
  };

export function workspaceFileMutationOperationId(
  mutationRequestId: string,
): string {
  return `workspace-file:${mutationRequestId}`;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function verifiedCommittedPostimage(
  descriptor: Readonly<{
    revision: number;
    sha256: string;
    size: number;
    storageUri: string;
  }> | null | undefined,
  dependencies: WorkspaceFileContentCoordinatorAdapterDependencies,
): Promise<Readonly<{
  bytes: Uint8Array;
  sha256: string;
  revision: number;
  size: number;
}> | null> {
  if (descriptor === null || descriptor === undefined) return null;
  let bytes: Uint8Array;
  try {
    bytes = await (dependencies.readCommittedContent ?? readWorkspaceDocumentMutationContent)(descriptor.storageUri);
  } catch {
    return null;
  }
  if (
    bytes.byteLength !== descriptor.size ||
    sha256Hex(bytes) !== descriptor.sha256
  ) return null;
  return {
    bytes,
    sha256: descriptor.sha256,
    revision: descriptor.revision,
    size: descriptor.size,
  };
}

function validLogicalPath(path: string): boolean {
  return (
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !path
      .split("/")
      .some((part) => part.length === 0 || part === "." || part === "..")
  );
}

function deterministicArtifactId(
  operationId: string,
  logicalPath: string,
): string {
  const chars = createHash("sha256")
    .update(JSON.stringify([operationId, logicalPath]))
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function identity(input: {
  readonly artifactInternalId: string;
  readonly logicalPath: string;
}): WorkspaceDocumentIdentity {
  return {
    kind: "workspace_artifact",
    artifactId: input.artifactInternalId,
    logicalPath: input.logicalPath,
  };
}

function version(source: WorkspaceFileContentSnapshot): WorkspaceDocumentVersion {
  return {
    identity: identity(source),
    backendVersion: { kind: "artifact_revision", revision: source.revision },
    sha256: sha256Hex(source.bytes),
  };
}

export function buildWorkspaceFileContentPlan(input: {
  readonly operationId: string;
  readonly request: WorkspaceFileContentCommitRequest;
}): BackendCommitPlan<"workspace"> | null {
  const { request } = input;
  if (
    request.mutationRequestId.trim().length === 0 ||
    request.command.trim().length === 0 ||
    !validLogicalPath(request.output.logicalPath)
  ) {
    return null;
  }
  const outputIdentity =
    request.source === undefined
      ? identity({
          artifactInternalId: deterministicArtifactId(
            input.operationId,
            request.output.logicalPath,
          ),
          logicalPath: request.output.logicalPath,
        })
      : identity(request.output);
  const after = {
    identity: outputIdentity,
    bytes: Uint8Array.from(request.output.bytes),
    sha256: sha256Hex(request.output.bytes),
  };
  const actor = {
    kind: "agent" as const,
    agentId: request.authority.agentId,
  };
  if (request.source === undefined) {
    return {
      operationId: input.operationId,
      actor,
      turnId: request.authority.turnId,
      entries: [{ kind: "create", after }],
    };
  }
  if (
    !validLogicalPath(request.source.logicalPath) ||
    request.source.artifactInternalId !== request.output.artifactInternalId ||
    request.source.logicalPath !== request.output.logicalPath
  ) {
    return null;
  }
  return {
    operationId: input.operationId,
    actor,
    turnId: request.authority.turnId,
    entries: [{
      kind: "update",
      before: {
        identity: identity(request.source),
        expectedVersion: version(request.source),
        bytes: Uint8Array.from(request.source.bytes),
      },
      after,
    }],
  };
}

function authorityMatches(request: WorkspaceFileContentCommitRequest): boolean {
  const { authority } = request;
  return (
    authority.ownerId.length > 0 &&
    authority.agentId.length > 0 &&
    authority.roomId.length > 0 &&
    authority.turnId.length > 0 &&
    authority.envelope.ownerId === authority.ownerId &&
    authority.envelope.agentId === authority.agentId &&
    authority.envelope.roomId === authority.roomId
  );
}

export function createWorkspaceFileContentCommitExecution(
  dependencies: WorkspaceFileContentCoordinatorAdapterDependencies,
): WorkspaceFileContentCommitExecution {
  return async (request) => {
    if (!authorityMatches(request)) {
      return {
        ok: false,
        code: "missing_context",
        message: "Workspace file mutation authority is unavailable for this turn.",
      };
    }
    const operationId = workspaceFileMutationOperationId(
      request.mutationRequestId,
    );
    const plan = buildWorkspaceFileContentPlan({ operationId, request });
    if (plan === null) {
      return {
        ok: false,
        code: "failed",
        message: "Workspace file mutation produced an invalid commit plan.",
      };
    }
    const outcome = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: request.authority.envelope.actorId,
          ownerId: request.authority.ownerId,
          agentId: request.authority.agentId,
          roomId: request.authority.roomId,
        },
        operationId,
        revisionGroupId: `workspace-file-turn:${request.authority.turnId}`,
        lane: "file_tool",
        historyOperation: request.command,
        includeCommittedPostimages: true,
        plan,
      },
      dependencies,
    );
    if (outcome.kind === "rejected") {
      if (outcome.outcome.result.kind === "conflict") {
        const code =
          outcome.outcome.result.code === "human_edit_conflict"
            ? "human_edit_conflict"
            : "reapply_required";
        return {
          ok: false,
          code,
          message:
            code === "human_edit_conflict"
              ? "A human edit conflicts with this Workspace file mutation."
              : "The Workspace artifact changed before this file mutation committed.",
        };
      }
      if (
        outcome.diagnosticCodes.includes("stale_precondition") ||
        outcome.diagnosticCodes.includes("occupied_target")
      ) {
        return {
          ok: false,
          code: "reapply_required",
          message: "The Workspace file mutation source or destination is no longer current.",
        };
      }
      return {
        ok: false,
        code: "failed",
        message: "Workspace file mutation commit was rejected.",
      };
    }
    const committed = outcome.kind === "committed"
      ? await verifiedCommittedPostimage(
          outcome.postimages?.length === 1 ? outcome.postimages[0] : null,
          dependencies,
        )
      : null;
    if (
      outcome.kind === "unknown" ||
      outcome.revisionIds.length !== 1 ||
      committed === null
    ) {
      return {
        ok: false,
        code: "unknown",
        message: "Workspace file mutation commit outcome is unknown.",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      };
    }
    return {
      ok: true,
      revisionId: outcome.revisionIds[0]!.at(-1)!,
      committed,
      ...(outcome.rebased ? { rebased: true as const } : {}),
      ...(request.source === undefined && outcome.outputArtifactIds[0] !== null
        ? {
            artifactId: outcome.outputArtifactIds[0]!,
            artifactInternalId: outcome.outputArtifactIds[0]!,
          }
        : {}),
    };
  };
}

export function createWorkspaceFileContentRecoveryExecution(
  dependencies: WorkspaceFileContentCoordinatorAdapterDependencies,
): WorkspaceFileContentRecoveryExecution {
  return async (request: WorkspaceFileContentRecoveryRequest) => {
    if (!authorityMatches(request as WorkspaceFileContentCommitRequest)) {
      return {
        ok: false,
        code: "missing_context",
        message: "Workspace file mutation authority is unavailable for this retry.",
      };
    }
    const db = dependencies.db ?? getServerDirectDb();
    const operationId = workspaceFileMutationOperationId(
      request.mutationRequestId,
    );
    const authorityInput = {
      humanActorId: request.authority.envelope.actorId,
      agentId: request.authority.agentId,
      roomId: request.authority.roomId,
    };
    const currentAuthority = dependencies.resolveRoomAuthority
      ? await dependencies.resolveRoomAuthority(authorityInput)
      : await resolveWorkspaceRoomMutationAuthority(authorityInput, db);
    if (!currentAuthority) {
      return {
        ok: false,
        code: "reapply_required",
        message:
          "Current Room authority no longer permits this Workspace mutation recovery.",
      };
    }
    const recovered = await db.transaction(async (tx) => {
      const operationLock =
        await acquireWorkspaceDocumentMutationOperationLock(tx, operationId);
      return findWorkspaceDocumentMutationForRecovery(tx, operationLock);
    });
    const recoveredArtifactId = recovered?.artifactInternalIds[0];
    const recoveredArtifact = recoveredArtifactId
      ? await findArtifactByInternalIdForNamespacesIncludingDeleted(
          {
            internalId: recoveredArtifactId,
            mutableNamespaceIds: [
              ...currentAuthority.readableNamespaceIds,
            ],
          },
          db,
        )
      : null;
    if (
      recovered === null ||
      recoveredArtifact === null ||
      recovered.mutation.ownerId !== request.authority.ownerId ||
      recovered.mutation.agentId !== request.authority.agentId ||
      recovered.mutation.roomId !== request.authority.roomId ||
      recovered.mutation.actorKind !== "agent" ||
      recovered.mutation.actorId !== request.authority.agentId ||
      recovered.mutation.lane !== "file_tool" ||
      recovered.revisionIds.length !== 1 ||
      recovered.historyOperations.some(
        (operation) => operation !== request.command,
      )
    ) {
      return {
        ok: false,
        code: "reapply_required",
        message:
          "No matching committed Workspace mutation receipt was found. Re-read the artifact and reapply the edit.",
      };
    }
    const committed = await verifiedCommittedPostimage(
      recovered?.postimages[0],
      dependencies,
    );
    if (committed === null) {
      return {
        ok: false,
        code: "reapply_required",
        message:
          "The committed Workspace postimage could not be verified. Re-read the artifact and reapply the edit.",
      };
    }
    return {
      ok: true,
      revisionId: recovered.revisionIds[0]!.at(-1)!,
      committed,
      artifactId: recoveredArtifact.artifactId,
      artifactInternalId: recoveredArtifact.id,
    };
  };
}
