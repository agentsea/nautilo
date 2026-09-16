import type { DocumentMutationLane } from "./lane-cutover";

/**
 * Stable coordinator phases. Diagnostics describe observation only; they are
 * never used to decide whether a mutation committed.
 */
export const DOCUMENT_MUTATION_DIAGNOSTIC_PHASES = [
  "validate",
  "lock",
  "prepare",
  "commit",
  "history",
  "compensate",
  "event",
] as const;

export type DocumentMutationDiagnosticPhase =
  (typeof DOCUMENT_MUTATION_DIAGNOSTIC_PHASES)[number];

export const DOCUMENT_MUTATION_DIAGNOSTIC_SEVERITIES = [
  "debug",
  "info",
  "warning",
  "error",
] as const;

export type DocumentMutationDiagnosticSeverity =
  (typeof DOCUMENT_MUTATION_DIAGNOSTIC_SEVERITIES)[number];

export const DOCUMENT_MUTATION_DIAGNOSTIC_OUTCOMES = [
  "started",
  "succeeded",
  "rejected",
  "failed",
  "pending",
] as const;

export type DocumentMutationDiagnosticOutcome =
  (typeof DOCUMENT_MUTATION_DIAGNOSTIC_OUTCOMES)[number];

export type DocumentMutationDiagnosticBackend = "workspace" | "desktop";

/**
 * Closed, content-free diagnostic input. Deliberately absent are document
 * identities, paths, patches, hashes, byte buffers, messages, and arbitrary
 * metadata bags: those values must not reach an operator sink through this
 * primitive.
 */
export interface DocumentMutationDiagnosticInput {
  operationId: string;
  backend: DocumentMutationDiagnosticBackend;
  lane: DocumentMutationLane;
  phase: DocumentMutationDiagnosticPhase;
  severity: DocumentMutationDiagnosticSeverity;
  outcome: DocumentMutationDiagnosticOutcome;
}

/**
 * The exact record delivered to an injected diagnostics sink.
 *
 * `sequence` is local to an emitter and records invocation order. It is not a
 * mutation ordering token and MUST NOT be used as commit authority.
 */
export interface DocumentMutationDiagnostic extends DocumentMutationDiagnosticInput {
  schemaVersion: 1;
  sequence: number;
}

export type DocumentMutationDiagnosticSink = (
  diagnostic: Readonly<DocumentMutationDiagnostic>,
) => void | Promise<void>;

export interface DocumentMutationDiagnosticEmitter {
  /**
   * Enqueue one observation without waiting for the sink. The returned promise
   * always fulfills immediately; use `flush` only outside mutation-critical
   * paths when a caller deliberately wants to await delivery.
   */
  emit(diagnostic: DocumentMutationDiagnosticInput): Promise<void>;

  /** Wait until all observations enqueued so far have been attempted. */
  flush(): Promise<void>;
}

/**
 * Creates a best-effort, ordered diagnostic emitter.
 *
 * Records are projected field-by-field into the closed public shape, so even a
 * structurally widened JavaScript input cannot pass document bytes or paths to
 * the sink. Sink failures are swallowed and the queue remains usable: telemetry
 * can never change mutation truth or block later observations.
 */
export function createDocumentMutationDiagnosticEmitter(
  sink?: DocumentMutationDiagnosticSink,
): DocumentMutationDiagnosticEmitter {
  let sequence = 0;
  let tail = Promise.resolve();

  const emit = (input: DocumentMutationDiagnosticInput): Promise<void> => {
    const diagnostic: Readonly<DocumentMutationDiagnostic> = Object.freeze({
      schemaVersion: 1,
      sequence: sequence++,
      operationId: input.operationId,
      backend: input.backend,
      lane: input.lane,
      phase: input.phase,
      severity: input.severity,
      outcome: input.outcome,
    });

    if (!sink) {
      return Promise.resolve();
    }

    const attempted = tail.then(() => sink(diagnostic));
    tail = attempted.then(
      () => undefined,
      () => undefined,
    );
    return Promise.resolve();
  };

  return {
    emit,
    flush: () => tail,
  };
}
