/**
 * D448 Workspace OfficeCLI final-commit port.
 *
 * OfficeCLI itself is deliberately still an agent-side, invocation-private
 * producer. This module is only the narrow trusted hand-off for its exact
 * binary post-image; it has no filesystem or artifact-storage capability.
 */
import type { MemoryAccessEnvelope } from "@nautilo/trust";

export type WorkspaceOfficeCliSnapshot = Readonly<{
  /** Internal artifact row UUID used by the document-mutation identity. */
  artifactInternalId: string;
  /** Public, agent-facing artifact id. */
  artifactId: string;
  logicalPath: string;
  revision: number;
  bytes: Uint8Array;
}>;

export type WorkspaceOfficeCliCommitRequest = Readonly<{
  authority: Readonly<{
    envelope: MemoryAccessEnvelope;
    ownerId: string;
    agentId: string;
    roomId: string;
    turnId: string;
  }>;
  /** Absent only for OfficeCLI create. A distinct output retains it as CAS. */
  source?: WorkspaceOfficeCliSnapshot;
  outputPath: string;
  postImage: Uint8Array;
  commandArgs: Readonly<Record<string, unknown>>;
}>;

export type WorkspaceOfficeCliCommitResult =
  | Readonly<{
      ok: true;
      revisionId: string;
      artifactInternalId: string;
      artifactId: string;
    }>
  | Readonly<{
      ok: false;
      code: "missing_context" | "conflict" | "failed" | "unknown";
      message: string;
      retryable?: boolean;
    }>;

export type WorkspaceOfficeCliCommitExecution = (
  request: WorkspaceOfficeCliCommitRequest,
) => Promise<WorkspaceOfficeCliCommitResult>;

let execution: WorkspaceOfficeCliCommitExecution | undefined;

/** Server app lifecycle owns installation; tests may inject a hermetic port. */
export function setWorkspaceOfficeCliCommitExecution(
  next: WorkspaceOfficeCliCommitExecution | undefined,
): void {
  execution = next;
}

export function getWorkspaceOfficeCliCommitExecution(): WorkspaceOfficeCliCommitExecution | undefined {
  return execution;
}
