import {
  getEncryptionTransitionPolicy,
  terminalizeDualTaskRunResult,
  terminalizeProtectedTaskRunResult,
  type DirectDatabase,
  type DualTaskRunTerminalInput,
  type ProtectedTaskRunTerminalInput,
} from "@nautilo/db";
import type {
  DualTaskRunResultTerminalPort,
  ProtectedTaskRunTerminalPort,
} from "@nautilo/runtime";

type ProtectedTerminalInput = Parameters<
  ProtectedTaskRunTerminalPort["terminalize"]
>[0];
type DualTerminalInput = Parameters<
  DualTaskRunResultTerminalPort["terminalizeDual"]
>[0];
type ProtectedTerminalResult = Awaited<ReturnType<
  ProtectedTaskRunTerminalPort["terminalize"]
>>;

type TerminalOperations = Readonly<{
  readPolicy: typeof getEncryptionTransitionPolicy;
  terminalizeProtected: typeof terminalizeProtectedTaskRunResult;
  terminalizeDual: typeof terminalizeDualTaskRunResult;
}>;

export type ProtectedTaskRunTerminalPorts = Readonly<{
  terminal: ProtectedTaskRunTerminalPort;
  dualTerminal: DualTaskRunResultTerminalPort;
}>;

const defaultOperations: TerminalOperations = Object.freeze({
  readPolicy: getEncryptionTransitionPolicy,
  terminalizeProtected: terminalizeProtectedTaskRunResult,
  terminalizeDual: terminalizeDualTaskRunResult,
});

function authorityChanged(): ProtectedTerminalResult {
  return Object.freeze({ status: "rejected", reason: "authority_changed" });
}

function assertPolicyToken(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError("Protected Task terminal policy token is invalid");
  }
}

async function hasCurrentPolicy(
  db: DirectDatabase,
  operations: TerminalOperations,
  input: Readonly<{
    policyRevalidationToken: number;
    resultRepresentation: "protected" | "dual";
  }>,
): Promise<boolean> {
  assertPolicyToken(input.policyRevalidationToken);
  const policy = await operations.readPolicy(db);
  return policy.revision === input.policyRevalidationToken
    && policy.mode === (input.resultRepresentation === "dual"
      ? "shadow_encryption"
      : "encrypted_only");
}

/**
 * Adapts the runtime's content-free result callbacks to the durable TaskRun
 * terminal CAS. The DB operation remains the final authority: it locks the
 * exact Task, TaskRun, Job, result reservation, definition, and policy row.
 */
export function createProtectedTaskRunTerminalPorts(
  db: DirectDatabase,
  operations: TerminalOperations = defaultOperations,
): ProtectedTaskRunTerminalPorts {
  const terminal: ProtectedTaskRunTerminalPort = Object.freeze({
    terminalize: async (input: ProtectedTerminalInput) => {
      if (!await hasCurrentPolicy(db, operations, input)) {
        return authorityChanged();
      }
      const exact: ProtectedTaskRunTerminalInput = Object.freeze({
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        scheduleKind: input.scheduleKind,
        operationId: input.operationId,
        requestDigest: input.requestDigest.slice(),
        resultObjectId: input.resultObjectId,
        resultRevision: input.resultRevision,
        resultRepresentation: "protected",
        outcome: input.outcome,
        completedAt: new Date(input.completedAt.getTime()),
        requiredRunStatus: input.requiredRunStatus,
      });
      return operations.terminalizeProtected(db, exact);
    },
  });

  const dualTerminal: DualTaskRunResultTerminalPort = Object.freeze({
    terminalizeDual: async (input: DualTerminalInput) => {
      const coordinate = input.ordinaryContent.coordinate;
      if (
        coordinate.kind !== "run_result"
        || coordinate.taskId !== input.taskId
        || coordinate.taskRunId !== input.taskRunId
        || coordinate.contentRevision !== input.resultRevision
      ) {
        throw new TypeError(
          "Dual Task result ordinary sibling disagrees with its exact Task run",
        );
      }
      if (!await hasCurrentPolicy(db, operations, input)) {
        return authorityChanged();
      }
      const payload = input.ordinaryContent.payload;
      const exact: DualTaskRunTerminalInput = Object.freeze({
        taskId: input.taskId,
        taskRunId: input.taskRunId,
        scheduleKind: input.scheduleKind,
        operationId: input.operationId,
        requestDigest: input.requestDigest.slice(),
        resultObjectId: input.resultObjectId,
        resultRevision: input.resultRevision,
        resultRepresentation: "dual",
        outcome: input.outcome,
        completedAt: new Date(input.completedAt.getTime()),
        requiredRunStatus: input.requiredRunStatus,
        ordinaryResult: Object.freeze({
          formatVersion: payload.formatVersion,
          resultText: payload.resultText,
          lastError: payload.lastError,
        }),
      });
      return operations.terminalizeDual(db, exact);
    },
  });

  return Object.freeze({ terminal, dualTerminal });
}
