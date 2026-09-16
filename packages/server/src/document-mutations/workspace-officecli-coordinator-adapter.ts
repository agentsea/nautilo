/** D448 server-owned final commit seam for Workspace OfficeCLI candidates. */
import { createHash } from "node:crypto";
import type {
  WorkspaceOfficeCliCommitExecution,
  WorkspaceOfficeCliCommitRequest,
  WorkspaceOfficeCliSnapshot,
} from "@nautilo/agent";
import type { BackendCommitPlan } from "@nautilo/document-mutations";
import type {
  WorkspaceDocumentIdentity,
  WorkspaceDocumentVersion,
} from "@nautilo/types";
import {
  executeWorkspaceAgentMutation,
  type WorkspaceAgentMutationCoordinatorDependencies,
} from "./workspace-agent-mutation-coordinator";

export type WorkspaceOfficeCliCoordinatorAdapterDependencies =
  WorkspaceAgentMutationCoordinatorDependencies;

function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonical(value: unknown): unknown {
  if (value instanceof Uint8Array)
    return { $bytes: Buffer.from(value).toString("base64") };
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)]),
    );
  }
  return value;
}

function operationId(request: WorkspaceOfficeCliCommitRequest): string {
  return `workspace-officecli:${createHash("sha256")
    .update(JSON.stringify(canonical(request)))
    .digest("hex")}`;
}

function deterministicArtifactId(
  operation: string,
  logicalPath: string,
): string {
  const chars = createHash("sha256")
    .update(JSON.stringify([operation, logicalPath]))
    .digest("hex")
    .slice(0, 32)
    .split("");
  chars[12] = "4";
  chars[16] = ((Number.parseInt(chars[16]!, 16) & 0x3) | 0x8).toString(16);
  const value = chars.join("");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

function identity(
  source: WorkspaceOfficeCliSnapshot,
): WorkspaceDocumentIdentity {
  return {
    kind: "workspace_artifact",
    artifactId: source.artifactInternalId,
    logicalPath: source.logicalPath,
  };
}

function version(source: WorkspaceOfficeCliSnapshot): WorkspaceDocumentVersion {
  return {
    identity: identity(source),
    backendVersion: { kind: "artifact_revision", revision: source.revision },
    sha256: sha256Hex(source.bytes),
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

export function buildWorkspaceOfficeCliPlan(input: {
  readonly operationId: string;
  readonly request: WorkspaceOfficeCliCommitRequest;
}): BackendCommitPlan<"workspace"> | null {
  const { request } = input;
  if (!validLogicalPath(request.outputPath)) return null;
  const source = request.source;
  if (source !== undefined && !validLogicalPath(source.logicalPath))
    return null;
  const outputIdentity: WorkspaceDocumentIdentity =
    source !== undefined && source.logicalPath === request.outputPath
      ? identity(source)
      : {
          kind: "workspace_artifact",
          artifactId: deterministicArtifactId(
            input.operationId,
            request.outputPath,
          ),
          logicalPath: request.outputPath,
        };
  const after = {
    identity: outputIdentity,
    bytes: Uint8Array.from(request.postImage),
    sha256: sha256Hex(request.postImage),
  };
  const actor = { kind: "agent" as const, agentId: request.authority.agentId };
  if (source === undefined) {
    return {
      operationId: input.operationId,
      actor,
      turnId: request.authority.turnId,
      entries: [{ kind: "create", after }],
    };
  }
  const before = {
    identity: identity(source),
    expectedVersion: version(source),
    bytes: Uint8Array.from(source.bytes),
  };
  if (source.logicalPath === request.outputPath) {
    return {
      operationId: input.operationId,
      actor,
      turnId: request.authority.turnId,
      entries: [{ kind: "update", before, after }],
    };
  }
  return {
    operationId: input.operationId,
    actor,
    turnId: request.authority.turnId,
    // A copy-to-new-output must not silently apply to a changed source.
    preconditions: [before],
    entries: [{ kind: "create", after }],
  };
}

function authorityMatches(request: WorkspaceOfficeCliCommitRequest): boolean {
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

export function createWorkspaceOfficeCliCommitExecution(
  dependencies: WorkspaceOfficeCliCoordinatorAdapterDependencies,
): WorkspaceOfficeCliCommitExecution {
  return async (request) => {
    if (!authorityMatches(request))
      return {
        ok: false,
        code: "missing_context",
        message: "Workspace OfficeCLI authority is unavailable for this turn.",
      };
    const id = operationId(request);
    const plan = buildWorkspaceOfficeCliPlan({ operationId: id, request });
    if (!plan)
      return {
        ok: false,
        code: "failed",
        message: "Workspace OfficeCLI produced an invalid commit plan.",
      };
    const outcome = await executeWorkspaceAgentMutation(
      {
        authority: {
          humanActorId: request.authority.envelope.actorId,
          ownerId: request.authority.ownerId,
          agentId: request.authority.agentId,
          roomId: request.authority.roomId,
        },
        operationId: id,
        revisionGroupId: `workspace-officecli-group:${id}`,
        lane: "officecli",
        plan,
      },
      dependencies,
    );
    if (outcome.kind === "rejected") {
      const conflict = outcome.outcome.result.kind === "conflict";
      const staleSource =
        outcome.diagnosticCodes.includes("stale_precondition");
      const occupiedTarget =
        outcome.diagnosticCodes.includes("occupied_target");
      if (
        outcome.outcome.result.kind === "failed" &&
        (staleSource || occupiedTarget)
      ) {
        return {
          ok: false,
          code: "conflict",
          message: staleSource
            ? "Workspace OfficeCLI source changed before the new output could be created; re-read and regenerate."
            : "Workspace OfficeCLI output target is now occupied; re-read and choose or regenerate a new output.",
          retryable: true,
        };
      }
      return {
        ok: false,
        code: conflict ? "conflict" : "failed",
        message: conflict
          ? "Workspace OfficeCLI source or target changed; re-read and retry."
          : "Workspace OfficeCLI commit was rejected.",
        retryable: conflict,
      };
    }
    if (outcome.kind === "unknown") {
      return {
        ok: false,
        code: "unknown",
        message: "Workspace OfficeCLI commit outcome is unknown.",
        retryable: true,
      };
    }
    if (outcome.revisionIds.length !== 1) {
      return {
        ok: false,
        code: "unknown",
        message: "Workspace OfficeCLI commit receipt is unavailable.",
        retryable: true,
      };
    }
    const artifactInternalId = outcome.outputArtifactIds[0];
    if (artifactInternalId === null || artifactInternalId === undefined) {
      return {
        ok: false,
        code: "unknown",
        message:
          "Workspace OfficeCLI committed output identity is unavailable.",
        retryable: true,
      };
    }
    const inPlace =
      request.source !== undefined &&
      request.source.logicalPath === request.outputPath;
    return {
      ok: true,
      revisionId: outcome.revisionIds[0]!.at(-1)!,
      artifactInternalId,
      artifactId: inPlace ? request.source.artifactId : artifactInternalId,
    };
  };
}
