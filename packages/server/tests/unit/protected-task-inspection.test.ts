import { describe, expect, test } from "bun:test";
import {
  ClassifiedDataOperationError,
  deriveTaskContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";

import {
  createProtectedTaskRunResultInspectionAdapter,
  type ProtectedTaskRunResultInspectionSnapshot,
} from "../../src/routes/protected-task-inspection";

const OWNER = "owner-1";
const AGENT = "agent-1";
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const NAMESPACE = "30000000-0000-4000-8000-000000000003";
const DEFINITION_OBJECT = deriveTaskContentCryptoObjectIdV1({
  kind: "definition",
  taskId: TASK,
  contentRevision: 1,
});
const FINGERPRINT = new Uint8Array(32).fill(7);
const coordinate = Object.freeze({
  kind: "run_result" as const,
  taskId: TASK,
  taskRunId: RUN,
  contentRevision: 1,
});

function snapshot(
  adjust: Readonly<{
    task?: Partial<ProtectedTaskRunResultInspectionSnapshot["task"]>;
    run?: Partial<ProtectedTaskRunResultInspectionSnapshot["run"]>;
  }> = {},
): ProtectedTaskRunResultInspectionSnapshot {
  return Object.freeze({
    task: Object.freeze({
      id: TASK,
      ownerId: OWNER,
      requestorId: OWNER,
      agentId: AGENT,
      contentRepresentation: "protected" as const,
      contentNamespaceId: NAMESPACE,
      contentRevision: 1,
      cryptoObjectId: DEFINITION_OBJECT,
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: FINGERPRINT.slice(),
      cryptoMappingState: "verified",
      ...adjust.task,
    }),
    run: Object.freeze({
      id: RUN,
      taskId: TASK,
      status: "completed",
      resultRepresentation: "protected" as const,
      resultContentNamespaceId: NAMESPACE,
      resultRevision: 1,
      resultCryptoObjectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      resultCryptoAccessRevision: 0,
      resultCryptoRequiredNamespaceFingerprint: FINGERPRINT.slice(),
      resultCryptoMappingState: "verified",
      ...adjust.run,
    }),
  });
}

const request = Object.freeze({
  ownerId: OWNER,
  agentId: AGENT,
  taskId: TASK,
  taskRunId: RUN,
});

describe("protected TaskRun result inspection", () => {
  test("opens the exact protected result and rechecks current authority", async () => {
    const current = snapshot({ task: { contentRepresentation: "dual" },
      run: { resultRepresentation: "dual" } });
    let inspections = 0;
    let opened = 0;
    const inspect = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => {
        inspections += 1;
        return current;
      },
      openProtected: async (received) => {
        opened += 1;
        expect(received).toEqual(coordinate);
        return Object.freeze({ coordinate, payload: Object.freeze({
          formatVersion: 1 as const,
          resultText: "protected result",
          lastError: null,
        }) });
      },
    });

    expect(await inspect(request)).toEqual({
      status: "ready",
      section: "result",
      taskId: TASK,
      taskRunId: RUN,
      payload: {
        formatVersion: 1,
        resultText: "protected result",
        lastError: null,
      },
    });
    expect({ inspections, opened }).toEqual({ inspections: 2, opened: 1 });
  });

  test("reports a pristine in-flight result as waiting without an ordinary read", async () => {
    let opened = 0;
    const inspect = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ run: {
        status: "running",
        resultRepresentation: "ordinary",
        resultContentNamespaceId: null,
        resultRevision: 0,
        resultCryptoObjectId: null,
        resultCryptoRequiredNamespaceFingerprint: null,
        resultCryptoMappingState: "unmapped",
      } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });

    expect(await inspect(request)).toEqual({
      status: "waiting",
      section: "result",
      reason: "result_not_mapped",
    });
    expect(opened).toBe(0);
  });

  test("never opens an ordinary Task or terminal ordinary result", async () => {
    let opened = 0;
    const ordinaryTask = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ task: {
        contentRepresentation: "ordinary",
        contentNamespaceId: null,
        cryptoMappingState: "unmapped",
      } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });
    const ordinaryResult = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ run: {
        resultRepresentation: "ordinary",
        resultContentNamespaceId: null,
        resultRevision: 0,
        resultCryptoObjectId: null,
        resultCryptoRequiredNamespaceFingerprint: null,
        resultCryptoMappingState: "unmapped",
      } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });

    expect(await ordinaryTask(request)).toMatchObject({
      status: "unavailable",
      reason: "result_not_protected",
    });
    expect(await ordinaryResult(request)).toMatchObject({
      status: "unavailable",
      reason: "result_not_protected",
    });
    expect(opened).toBe(0);
  });

  test("hides foreign ownership and Agent bindings before opening", async () => {
    let opened = 0;
    const inspect = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ task: { ownerId: "other-owner" } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });

    expect(await inspect(request)).toEqual({
      status: "unavailable",
      section: "result",
      reason: "task_not_found",
    });
    expect(opened).toBe(0);
  });

  test("rejects authority drift after opening and substituted payload coordinates", async () => {
    const initial = snapshot();
    let current = initial;
    const drift = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => current,
      openProtected: async () => {
        current = snapshot({ task: { cryptoMappingState: "stale" } });
        return { coordinate, payload: {
          formatVersion: 1, resultText: "must not escape", lastError: null,
        } };
      },
    });
    expect(await drift(request)).toMatchObject({
      status: "unavailable",
      reason: "authority_changed",
    });

    const substituted = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => initial,
      openProtected: async () => ({
        coordinate: { ...coordinate, taskRunId:
          "40000000-0000-4000-8000-000000000004" },
        payload: { formatVersion: 1, resultText: "foreign", lastError: null },
      }),
    });
    expect(await substituted(request)).toMatchObject({
      status: "unavailable",
      reason: "integrity_failure",
    });
  });

  test("rejects changed crypto authority after open, including in-place fingerprint mutation", async () => {
    const shared = snapshot();
    let calls = 0;
    const inspect = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => {
        calls += 1;
        return shared;
      },
      openProtected: async () => {
        shared.task.cryptoRequiredNamespaceFingerprint![0] = 9;
        return { coordinate, payload: {
          formatVersion: 1, resultText: "must not escape", lastError: null,
        } };
      },
    });

    expect(await inspect(request)).toMatchObject({
      status: "unavailable",
      reason: "authority_changed",
    });
    expect(calls).toBe(2);
  });

  test("rejects representation mismatch and nonterminal mapped results before open", async () => {
    let opened = 0;
    const mismatch = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({
        task: { contentRepresentation: "dual" },
        run: { resultRepresentation: "protected" },
      }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });
    const running = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ run: { status: "running" } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });
    const cancelled = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot({ run: { status: "cancelled" } }),
      openProtected: async () => {
        opened += 1;
        throw new Error("must not open");
      },
    });

    expect(await mismatch(request)).toMatchObject({
      status: "unavailable",
      reason: "integrity_failure",
    });
    expect(await running(request)).toMatchObject({
      status: "unavailable",
      reason: "integrity_failure",
    });
    expect(await cancelled(request)).toMatchObject({
      status: "unavailable",
      reason: "integrity_failure",
    });
    expect(opened).toBe(0);
  });

  test("maps protected opener authority states without falling back", async () => {
    let mode: "waiting" | "stale" = "waiting";
    const inspect = createProtectedTaskRunResultInspectionAdapter({
      inspectCurrent: async () => snapshot(),
      openProtected: async () => Promise.reject(new ClassifiedDataOperationError(
        mode === "waiting" ? "key_waiting" : "stale",
        "unavailable",
      )),
    });

    expect(await inspect(request)).toEqual({
      status: "waiting",
      section: "result",
      reason: "authority_not_ready",
    });
    mode = "stale";
    expect(await inspect(request)).toEqual({
      status: "unavailable",
      section: "result",
      reason: "authority_changed",
    });
  });
});
