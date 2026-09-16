import { describe, expect, test } from "bun:test";

import {
  DOCUMENT_MUTATION_DIAGNOSTIC_OUTCOMES,
  DOCUMENT_MUTATION_DIAGNOSTIC_PHASES,
  DOCUMENT_MUTATION_DIAGNOSTIC_SEVERITIES,
  createDocumentMutationDiagnosticEmitter,
  type DocumentMutationDiagnostic,
  type DocumentMutationDiagnosticInput,
} from "../../src/diagnostics";

const baseDiagnostic = {
  operationId: "operation-1",
  backend: "workspace",
  lane: "apply_patch",
  phase: "validate",
  severity: "info",
  outcome: "started",
} as const satisfies DocumentMutationDiagnosticInput;

describe("document mutation diagnostics", () => {
  test("freezes the stable phases, severities, outcomes, and exact record shape", async () => {
    expect(DOCUMENT_MUTATION_DIAGNOSTIC_PHASES).toEqual([
      "validate",
      "lock",
      "prepare",
      "commit",
      "history",
      "compensate",
      "event",
    ]);
    expect(DOCUMENT_MUTATION_DIAGNOSTIC_SEVERITIES).toEqual([
      "debug",
      "info",
      "warning",
      "error",
    ]);
    expect(DOCUMENT_MUTATION_DIAGNOSTIC_OUTCOMES).toEqual([
      "started",
      "succeeded",
      "rejected",
      "failed",
      "pending",
    ]);

    const received: DocumentMutationDiagnostic[] = [];
    const emitter = createDocumentMutationDiagnosticEmitter((diagnostic) => {
      received.push(diagnostic);
    });

    await emitter.emit(baseDiagnostic);
    await emitter.flush();

    expect(received).toEqual([
      {
        schemaVersion: 1,
        sequence: 0,
        operationId: "operation-1",
        backend: "workspace",
        lane: "apply_patch",
        phase: "validate",
        severity: "info",
        outcome: "started",
      },
    ]);
    expect(Object.keys(received[0] ?? {}).sort()).toEqual([
      "backend",
      "lane",
      "operationId",
      "outcome",
      "phase",
      "schemaVersion",
      "sequence",
      "severity",
    ]);
    expect(Object.isFrozen(received[0])).toBe(true);
  });

  test("preserves invocation order through an asynchronous sink", async () => {
    const received: number[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const emitter = createDocumentMutationDiagnosticEmitter(async (diagnostic) => {
      if (diagnostic.sequence === 0) {
        await firstBlocked;
      }
      received.push(diagnostic.sequence);
    });

    const first = emitter.emit(baseDiagnostic);
    const second = emitter.emit({
      ...baseDiagnostic,
      phase: "lock",
      outcome: "succeeded",
    });

    await Promise.resolve();
    expect(received).toEqual([]);
    releaseFirst?.();
    await Promise.all([first, second, emitter.flush()]);

    expect(received).toEqual([0, 1]);
  });

  test("projects away raw paths, bytes, messages, and arbitrary metadata", async () => {
    const received: DocumentMutationDiagnostic[] = [];
    const emitter = createDocumentMutationDiagnosticEmitter((diagnostic) => {
      received.push(diagnostic);
    });
    const widenedInput = {
      ...baseDiagnostic,
      canonicalPath: "/private/documents/secret.md",
      logicalPath: "private/secret.md",
      bytes: new Uint8Array([83, 69, 67, 82, 69, 84]),
      patch: "*** secret patch ***",
      message: "secret diagnostic",
      metadata: { content: "secret metadata" },
    };

    await emitter.emit(widenedInput);
    await emitter.flush();

    const serialized = JSON.stringify(received);
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("canonicalPath");
    expect(serialized).not.toContain("logicalPath");
    expect(serialized).not.toContain("bytes");
    expect(serialized).not.toContain("message");
    expect(serialized).not.toContain("metadata");
    expect(Object.hasOwn(received[0] ?? {}, "patch")).toBe(false);
  });

  test("swallows synchronous and asynchronous sink failures without poisoning the queue", async () => {
    const attempts: number[] = [];
    const emitter = createDocumentMutationDiagnosticEmitter(
      (diagnostic): void | Promise<void> => {
        attempts.push(diagnostic.sequence);
        if (diagnostic.sequence === 0) {
          throw new Error("sync sink failure");
        }
        if (diagnostic.sequence === 1) {
          return Promise.reject(new Error("async sink failure"));
        }
        return undefined;
      },
    );

    await emitter.emit(baseDiagnostic);
    await emitter.emit({ ...baseDiagnostic, phase: "commit", outcome: "failed" });
    await emitter.emit({
      ...baseDiagnostic,
      phase: "compensate",
      outcome: "succeeded",
    });
    await emitter.flush();

    expect(attempts).toEqual([0, 1, 2]);
  });

  test("is a safe no-op when no sink is installed", async () => {
    const emitter = createDocumentMutationDiagnosticEmitter();

    await emitter.emit(baseDiagnostic);
    await emitter.flush();
  });

  test("never blocks the mutation path on a hung sink", async () => {
    const neverDelivered = new Promise<void>(() => {});
    const emitter = createDocumentMutationDiagnosticEmitter(() => neverDelivered);

    await emitter.emit(baseDiagnostic);

    // Reaching this assertion proves enqueue completion is independent of the
    // sink. Deliberately do not flush a sink that never resolves.
    expect(true).toBe(true);
  });
});
