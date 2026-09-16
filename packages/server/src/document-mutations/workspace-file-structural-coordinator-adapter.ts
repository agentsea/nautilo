/** Server-owned canonical commit seam for Workspace file-tool structure. */
import { createHash } from "node:crypto";
import type {
  WorkspaceFileStructuralMutationExecution,
  WorkspaceFileStructuralMutationRequest,
} from "@nautilo/agent";
import {
  findArtifactByInternalIdForNamespacesIncludingDeleted,
  findArtifactByPathForNamespaces,
  resolveWorkspaceRoomMutationAuthority,
  type Artifact,
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
import { readWorkspaceDocumentMutationContent } from "./workspace-artifact-mutation-backend";
import {
  workspaceFileMutationOperationId,
} from "./workspace-file-content-coordinator-adapter";
import { getServerDirectDb } from "../lib/server-direct-db";

export type WorkspaceFileStructuralCoordinatorAdapterDependencies =
  WorkspaceAgentMutationCoordinatorDependencies & {
    readonly readContent?: (storageUri: string) => Promise<Uint8Array>;
  };

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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

function deterministicPublicArtifactId(
  operationId: string,
  logicalPath: string,
): string {
  return deterministicArtifactId(
    `${operationId}:public-artifact`,
    logicalPath,
  );
}

function identity(
  artifactInternalId: string,
  logicalPath: string,
): WorkspaceDocumentIdentity {
  return {
    kind: "workspace_artifact",
    artifactId: artifactInternalId,
    logicalPath,
  };
}

function snapshot(row: Artifact, bytes: Uint8Array) {
  const sha256 = sha256Hex(bytes);
  const documentIdentity = identity(row.id, row.path);
  const expectedVersion: WorkspaceDocumentVersion = {
    identity: documentIdentity,
    backendVersion: {
      kind: "artifact_revision",
      revision: row.revision,
    },
    sha256,
  };
  return {
    identity: documentIdentity,
    expectedVersion,
    bytes: Uint8Array.from(bytes),
  };
}

export function buildWorkspaceFileStructuralPlan(input: {
  readonly operationId: string;
  readonly request: WorkspaceFileStructuralMutationRequest;
  readonly source: Artifact;
  readonly sourceBytes: Uint8Array;
}): BackendCommitPlan<"workspace"> | null {
  const { request, source } = input;
  if (
    request.mutationRequestId.trim().length === 0 ||
    !validLogicalPath(request.logicalPath) ||
    request.logicalPath !== source.path ||
    source.deletedAt !== null ||
    source.size !== input.sourceBytes.byteLength
  ) return null;
  const before = snapshot(source, input.sourceBytes);
  const common = {
    operationId: input.operationId,
    actor: {
      kind: "agent" as const,
      agentId: request.authority.agentId,
    },
    turnId: request.authority.turnId,
  };
  if (request.command === "delete") {
    if (request.destinationPath !== undefined || request.recursive === true) {
      return null;
    }
    return { ...common, entries: [{ kind: "delete", before }] };
  }
  if (
    request.destinationPath === undefined ||
    !validLogicalPath(request.destinationPath) ||
    request.destinationPath === source.path
  ) return null;
  const after = {
    identity: identity(
      request.command === "copy"
        ? deterministicArtifactId(input.operationId, request.destinationPath)
        : source.id,
      request.destinationPath,
    ),
    bytes: Uint8Array.from(input.sourceBytes),
    sha256: sha256Hex(input.sourceBytes),
  };
  return request.command === "move"
    ? {
        ...common,
        entries: [{ kind: "move", source: before, after }],
      }
    : {
        ...common,
        preconditions: [before],
        entries: [{ kind: "create", after }],
      };
}

function authorityMatches(
  request: WorkspaceFileStructuralMutationRequest,
): boolean {
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

export function createWorkspaceFileStructuralMutationExecution(
  dependencies: WorkspaceFileStructuralCoordinatorAdapterDependencies,
): WorkspaceFileStructuralMutationExecution {
  return async (request) => {
    if (!authorityMatches(request)) {
      return {
        ok: false,
        code: "missing_context",
        message: "Workspace structural mutation authority is unavailable.",
      };
    }
    if (request.command === "delete" && request.recursive === true) {
      return {
        ok: false,
        code: "recursive_not_supported",
        message: "Recursive Workspace artifact delete is not supported.",
      };
    }
    if (
      !validLogicalPath(request.logicalPath) ||
      (request.command !== "delete" &&
        (request.destinationPath === undefined ||
          !validLogicalPath(request.destinationPath) ||
          request.destinationPath === request.logicalPath))
    ) {
      return {
        ok: false,
        code: "failed",
        message: "Workspace structural mutation paths are invalid.",
      };
    }

    const db = dependencies.db ?? getServerDirectDb();
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
        message: "Current Room authority no longer permits this mutation.",
      };
    }
    const source = await findArtifactByPathForNamespaces(
      {
        path: request.logicalPath,
        readableNamespaceIds: [...currentAuthority.readableNamespaceIds],
      },
      db,
    );
    if (!source) {
      return {
        ok: false,
        code: "not_found",
        message: `No Workspace artifact exists at "${request.logicalPath}".`,
      };
    }
    if (request.destinationPath !== undefined) {
      const destination = await findArtifactByPathForNamespaces(
        {
          path: request.destinationPath,
          readableNamespaceIds: [...currentAuthority.readableNamespaceIds],
        },
        db,
      );
      if (destination) {
        return {
          ok: false,
          code: "destination_exists",
          message:
            `A Workspace artifact already exists at "${request.destinationPath}".`,
        };
      }
    }

    const readContent =
      dependencies.readContent ?? readWorkspaceDocumentMutationContent;
    let sourceBytes: Uint8Array;
    try {
      sourceBytes = await readContent(source.storageUri);
    } catch {
      return {
        ok: false,
        code: "reapply_required",
        message: "The Workspace artifact bytes are unavailable.",
      };
    }
    const operationId = workspaceFileMutationOperationId(
      request.mutationRequestId,
    );
    const plan = buildWorkspaceFileStructuralPlan({
      operationId,
      request,
      source,
      sourceBytes,
    });
    if (!plan) {
      return {
        ok: false,
        code: "reapply_required",
        message: "The Workspace artifact changed before mutation planning.",
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
        revisionGroupId:
          `workspace-file-turn:${request.authority.turnId}`,
        lane: "file_tool",
        historyOperation: request.command,
        ...(request.command === "copy" &&
          request.destinationPath !== undefined &&
          plan.entries[0]?.kind === "create"
          ? {
              createdArtifactPublicIds: {
                [plan.entries[0].after.identity.artifactId]:
                  deterministicPublicArtifactId(
                    operationId,
                    request.destinationPath,
                  ),
              },
            }
          : {}),
        plan,
      },
      dependencies,
    );
    if (outcome.kind === "unknown") {
      return {
        ok: false,
        code: "unknown",
        message: "Workspace structural mutation outcome is unknown.",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      };
    }
    if (outcome.kind === "rejected") {
      const humanEditConflict =
        outcome.outcome.result.kind === "conflict" &&
        outcome.outcome.result.code === "human_edit_conflict";
      if (humanEditConflict) {
        return {
          ok: false,
          code: "human_edit_conflict",
          message:
            "A human edit conflicts with this Workspace structural mutation.",
        };
      }
      if (outcome.diagnosticCodes.includes("occupied_target")) {
        return {
          ok: false,
          code: "destination_exists",
          message: "The Workspace mutation destination is no longer vacant.",
        };
      }
      return {
        ok: false,
        code: "reapply_required",
        message:
          "The Workspace source or current Room authority changed before commit.",
      };
    }

    const outputArtifactInternalId =
      request.command === "copy"
        ? outcome.outputArtifactIds[0]
        : source.id;
    const outputArtifact =
      request.command === "copy" && outputArtifactInternalId
        ? await findArtifactByInternalIdForNamespacesIncludingDeleted(
            {
              internalId: outputArtifactInternalId,
              mutableNamespaceIds: [
                ...currentAuthority.readableNamespaceIds,
              ],
            },
            db,
          )
        : source;
    if (!outputArtifact) {
      return {
        ok: false,
        code: "unknown",
        message: "Workspace structural mutation receipt is incomplete.",
        retryable: true,
        mutationRequestId: request.mutationRequestId,
      };
    }
    return {
      ok: true,
      revisionId: outcome.revisionIds[0]!.at(-1)!,
      artifactId: outputArtifact.artifactId,
      artifactInternalId: outputArtifact.id,
    };
  };
}
