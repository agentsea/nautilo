/**
 * D448 Workspace file-tool final-commit port.
 *
 * File command handlers remain agent-side planners. This module is only the
 * narrow hand-off for an exact content candidate; it carries no storage or DB
 * capability and has no legacy fallback.
 */
import { createHash } from "node:crypto";
import type { MemoryAccessEnvelope } from "@nautilo/trust";
import type { AnchoredEdit } from "./staged-patches";

function canonicalizeMutationSemantics(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalizeMutationSemantics);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key]) => key !== "retryRequestId")
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeMutationSemantics(child)]),
    );
  }
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalizeMutationSemantics(value)))
    .digest("hex");
}

/**
 * The durable token binds a trusted dispatch correlation to exact normalized
 * public semantics without exposing either value as an authorization grant.
 */
export function createFileMutationRequestId(
  trustedDispatchId: string,
  args: Readonly<Record<string, unknown>>,
): string {
  return `d448:${digest(trustedDispatchId)}:${digest(args)}`;
}

export function fileMutationRetryMatches(
  retryRequestId: string,
  args: Readonly<Record<string, unknown>>,
): boolean {
  const parts = retryRequestId.split(":");
  return (
    parts.length === 3 &&
    parts[0] === "d448" &&
    /^[a-f0-9]{64}$/.test(parts[1]!) &&
    parts[2] === digest(args)
  );
}

export type WorkspaceFileContentSnapshot = Readonly<{
  artifactInternalId: string;
  artifactId: string;
  logicalPath: string;
  revision: number;
  bytes: Uint8Array;
}>;

export type WorkspaceFileContentCommitRequest = Readonly<{
  authority: Readonly<{
    envelope: MemoryAccessEnvelope;
    ownerId: string;
    agentId: string;
    roomId: string;
    turnId: string;
  }>;
  mutationRequestId: string;
  command: string;
  commandArgs: Readonly<Record<string, unknown>>;
  source?: WorkspaceFileContentSnapshot;
  output: Readonly<{
    artifactInternalId: string;
    artifactId: string;
    logicalPath: string;
    bytes: Uint8Array;
  }>;
  anchoredEdit?: AnchoredEdit;
}>;

export type WorkspaceFileContentCommitResult =
  | Readonly<{
      ok: true;
      revisionId: string;
      /** Exact immutable postimage proven by the committed receipt. */
      committed?: Readonly<{
        bytes: Uint8Array;
        sha256: string;
        revision: number;
        size: number;
      }>;
      rebased?: true;
      artifactId?: string;
      artifactInternalId?: string;
    }>
  | Readonly<{
      ok: false;
      code:
        | "missing_context"
        | "human_edit_conflict"
        | "reapply_required"
        | "failed"
        | "unknown";
      message: string;
      retryable?: boolean;
      mutationRequestId?: string;
    }>;

export type WorkspaceFileContentCommitExecution = (
  request: WorkspaceFileContentCommitRequest,
) => Promise<WorkspaceFileContentCommitResult>;

export type WorkspaceFileContentRecoveryRequest = Readonly<{
  authority: WorkspaceFileContentCommitRequest["authority"];
  mutationRequestId: string;
  command: string;
}>;

export type WorkspaceFileContentRecoveryExecution = (
  request: WorkspaceFileContentRecoveryRequest,
) => Promise<WorkspaceFileContentCommitResult>;

export type WorkspaceCanonicalHistoryRestoreRequest = Readonly<{
  authority: WorkspaceFileContentCommitRequest["authority"];
  mutationRequestId: string;
  command: "undo" | "redo";
  logicalPath: string;
  revisionId?: string;
  targetTurnId?: string;
}>;

export type WorkspaceCanonicalHistoryRestoreResult =
  | Readonly<{
      ok: true;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    }>
  | Readonly<{
      ok: false;
      code:
        | "missing_context"
        | "no_revisions"
        | "nothing_to_redo"
        | "revision_not_found"
        | "legacy_history_unverifiable"
        | "human_edit_conflict"
        | "reapply_required"
        | "failed"
        | "unknown";
      message: string;
      retryable?: boolean;
      mutationRequestId?: string;
    }>;

export type WorkspaceCanonicalHistoryRestoreExecution = (
  request: WorkspaceCanonicalHistoryRestoreRequest,
) => Promise<WorkspaceCanonicalHistoryRestoreResult>;

export type WorkspaceCanonicalUndoTurnRequest = Readonly<{
  authority: WorkspaceFileContentCommitRequest["authority"];
  mutationRequestId: string;
  targetTurnId: string;
}>;

export type WorkspaceCanonicalUndoTurnOutcome = Readonly<{
  revisionId: string;
  artifactId: string;
  artifactInternalId: string;
  path: string;
}>;

export type WorkspaceCanonicalUndoTurnResult =
  | Readonly<{
      ok: true;
      outcomes: readonly WorkspaceCanonicalUndoTurnOutcome[];
    }>
  | Readonly<{
      ok: false;
      code:
        | "missing_context"
        | "no_revisions_for_turn"
        | "legacy_history_unverifiable"
        | "ineligible_history"
        | "human_edit_conflict"
        | "reapply_required"
        | "unknown";
      message: string;
      retryable?: boolean;
      mutationRequestId?: string;
    }>;

export type WorkspaceCanonicalUndoTurnExecution = (
  request: WorkspaceCanonicalUndoTurnRequest,
) => Promise<WorkspaceCanonicalUndoTurnResult>;

export type WorkspaceFileStructuralMutationRequest = Readonly<{
  authority: WorkspaceFileContentCommitRequest["authority"];
  mutationRequestId: string;
  command: "delete" | "move" | "copy";
  logicalPath: string;
  destinationPath?: string;
  recursive?: boolean;
}>;

export type WorkspaceFileStructuralMutationResult =
  | Readonly<{
      ok: true;
      revisionId: string;
      artifactId: string;
      artifactInternalId: string;
    }>
  | Readonly<{
      ok: false;
      code:
        | "missing_context"
        | "not_found"
        | "destination_exists"
        | "recursive_not_supported"
        | "human_edit_conflict"
        | "reapply_required"
        | "failed"
        | "unknown";
      message: string;
      retryable?: boolean;
      mutationRequestId?: string;
    }>;

export type WorkspaceFileStructuralMutationExecution = (
  request: WorkspaceFileStructuralMutationRequest,
) => Promise<WorkspaceFileStructuralMutationResult>;

let execution: WorkspaceFileContentCommitExecution | undefined;
let recoveryExecution: WorkspaceFileContentRecoveryExecution | undefined;
let historyRestoreExecution:
  | WorkspaceCanonicalHistoryRestoreExecution
  | undefined;
let structuralMutationExecution:
  | WorkspaceFileStructuralMutationExecution
  | undefined;
let undoTurnExecution: WorkspaceCanonicalUndoTurnExecution | undefined;

export function setWorkspaceFileContentCommitExecution(
  next: WorkspaceFileContentCommitExecution | undefined,
): void {
  execution = next;
}

export function getWorkspaceFileContentCommitExecution():
  | WorkspaceFileContentCommitExecution
  | undefined {
  return execution;
}

export function setWorkspaceFileContentRecoveryExecution(
  next: WorkspaceFileContentRecoveryExecution | undefined,
): void {
  recoveryExecution = next;
}

export function getWorkspaceFileContentRecoveryExecution():
  | WorkspaceFileContentRecoveryExecution
  | undefined {
  return recoveryExecution;
}

export function setWorkspaceCanonicalHistoryRestoreExecution(
  next: WorkspaceCanonicalHistoryRestoreExecution | undefined,
): void {
  historyRestoreExecution = next;
}

export function getWorkspaceCanonicalHistoryRestoreExecution():
  | WorkspaceCanonicalHistoryRestoreExecution
  | undefined {
  return historyRestoreExecution;
}

export function setWorkspaceFileStructuralMutationExecution(
  next: WorkspaceFileStructuralMutationExecution | undefined,
): void {
  structuralMutationExecution = next;
}

export function getWorkspaceFileStructuralMutationExecution():
  | WorkspaceFileStructuralMutationExecution
  | undefined {
  return structuralMutationExecution;
}

export function setWorkspaceCanonicalUndoTurnExecution(
  next: WorkspaceCanonicalUndoTurnExecution | undefined,
): void {
  undoTurnExecution = next;
}

export function getWorkspaceCanonicalUndoTurnExecution():
  | WorkspaceCanonicalUndoTurnExecution
  | undefined {
  return undoTurnExecution;
}
