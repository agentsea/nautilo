import { expect, test } from "bun:test";

import type {
  DirectDatabase,
  DualTaskRunTerminalInput,
  ProtectedTaskRunTerminalInput,
} from "@nautilo/db";
import type {
  DualTaskRunResultTerminalPort,
  ProtectedTaskRunTerminalPort,
} from "@nautilo/runtime";
import {
  createProtectedTaskRunTerminalPorts,
} from "../../src/routes/protected-task-run-terminal";

const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const OBJECT = `task-run-result:v1:${"a".repeat(64)}`;
const COMPLETED_AT = new Date("2026-09-28T12:00:00.000Z");

function protectedInput(
  overrides: Partial<Parameters<ProtectedTaskRunTerminalPort["terminalize"]>[0]> = {},
): Parameters<ProtectedTaskRunTerminalPort["terminalize"]>[0] {
  return {
    taskId: TASK,
    taskRunId: RUN,
    scheduleKind: "now",
    operationId: `task-run-result:${RUN}`,
    requestDigest: new Uint8Array(32).fill(7),
    resultObjectId: OBJECT,
    resultRevision: 1,
    resultRepresentation: "protected",
    outcome: "completed",
    completedAt: COMPLETED_AT,
    requiredRunStatus: "running",
    policyRevalidationToken: 11,
    ...overrides,
  };
}

function dualInput(
  overrides: Partial<Parameters<DualTaskRunResultTerminalPort["terminalizeDual"]>[0]> = {},
): Parameters<DualTaskRunResultTerminalPort["terminalizeDual"]>[0] {
  return {
    ...protectedInput(),
    resultRepresentation: "dual",
    ordinaryContent: Object.freeze({
      coordinate: Object.freeze({
        kind: "run_result" as const,
        taskId: TASK,
        taskRunId: RUN,
        contentRevision: 1,
      }),
      payload: Object.freeze({
        formatVersion: 1 as const,
        resultText: "finished",
        lastError: null,
      }),
    }),
    ...overrides,
  };
}

function operations(input: Readonly<{
  mode?: "shadow_encryption" | "encrypted_only";
  revision?: number;
  protectedResult?: Awaited<ReturnType<
    typeof import("@nautilo/db")["terminalizeProtectedTaskRunResult"]
  >>;
  dualResult?: Awaited<ReturnType<
    typeof import("@nautilo/db")["terminalizeDualTaskRunResult"]
  >>;
}> = {}) {
  const protectedCalls: ProtectedTaskRunTerminalInput[] = [];
  const dualCalls: DualTaskRunTerminalInput[] = [];
  return {
    protectedCalls,
    dualCalls,
    value: {
      readPolicy: async () => ({
        mode: input.mode ?? "encrypted_only",
        shadowBehavior: "fallback" as const,
        revision: input.revision ?? 11,
        shadowEncryptionStartedAt: null,
        updatedAt: new Date(0),
      }),
      terminalizeProtected: async (_db: DirectDatabase, value: ProtectedTaskRunTerminalInput) => {
        protectedCalls.push(value);
        return input.protectedResult ?? { status: "transitioned" as const };
      },
      terminalizeDual: async (_db: DirectDatabase, value: DualTaskRunTerminalInput) => {
        dualCalls.push(value);
        return input.dualResult ?? { status: "transitioned" as const };
      },
    },
  };
}

test("forwards the exact protected terminal receipt and preserves replay", async () => {
  const dependency = operations({ protectedResult: { status: "exact_replay" } });
  const ports = createProtectedTaskRunTerminalPorts(
    {} as DirectDatabase,
    dependency.value,
  );
  const input = protectedInput();

  expect(await ports.terminal.terminalize(input)).toEqual({
    status: "exact_replay",
  });
  expect(dependency.protectedCalls).toHaveLength(1);
  expect(dependency.protectedCalls[0]).toEqual({
    taskId: TASK,
    taskRunId: RUN,
    scheduleKind: "now",
    operationId: `task-run-result:${RUN}`,
    requestDigest: input.requestDigest,
    resultObjectId: OBJECT,
    resultRevision: 1,
    resultRepresentation: "protected",
    outcome: "completed",
    completedAt: COMPLETED_AT,
    requiredRunStatus: "running",
  });
  expect(dependency.protectedCalls[0]?.requestDigest)
    .not.toBe(input.requestDigest);
  expect(dependency.protectedCalls[0]?.completedAt).not.toBe(COMPLETED_AT);
});

test("returns authority_changed before the durable CAS for a stale policy token", async () => {
  const dependency = operations({ revision: 12 });
  const ports = createProtectedTaskRunTerminalPorts(
    {} as DirectDatabase,
    dependency.value,
  );

  expect(await ports.terminal.terminalize(protectedInput())).toEqual({
    status: "rejected",
    reason: "authority_changed",
  });
  expect(dependency.protectedCalls).toHaveLength(0);
});

test("preserves durable conflicts without converting them to replay", async () => {
  const dependency = operations({
    protectedResult: { status: "rejected", reason: "conflict" },
  });
  const ports = createProtectedTaskRunTerminalPorts(
    {} as DirectDatabase,
    dependency.value,
  );

  expect(await ports.terminal.terminalize(protectedInput())).toEqual({
    status: "rejected",
    reason: "conflict",
  });
});

test("passes only the canonical dual result payload to the product terminal", async () => {
  const dependency = operations({ mode: "shadow_encryption" });
  const ports = createProtectedTaskRunTerminalPorts(
    {} as DirectDatabase,
    dependency.value,
  );
  const input = dualInput();

  expect(await ports.dualTerminal.terminalizeDual(input)).toEqual({
    status: "transitioned",
  });
  expect(dependency.dualCalls).toHaveLength(1);
  expect(dependency.dualCalls[0]).toMatchObject({
    taskId: TASK,
    taskRunId: RUN,
    operationId: `task-run-result:${RUN}`,
    requestDigest: input.requestDigest,
    resultRepresentation: "dual",
    ordinaryResult: {
      formatVersion: 1,
      resultText: "finished",
      lastError: null,
    },
  });
  expect("ordinaryContent" in dependency.dualCalls[0]!).toBe(false);
});

test("rejects a dual ordinary sibling for another TaskRun", async () => {
  const dependency = operations({ mode: "shadow_encryption" });
  const ports = createProtectedTaskRunTerminalPorts(
    {} as DirectDatabase,
    dependency.value,
  );
  const input = dualInput({
    ordinaryContent: {
      coordinate: {
        kind: "run_result",
        taskId: TASK,
        taskRunId: "30000000-0000-4000-8000-000000000003",
        contentRevision: 1,
      },
      payload: { formatVersion: 1, resultText: "finished", lastError: null },
    },
  });

  await Promise.resolve(
    expect(ports.dualTerminal.terminalizeDual(input)).rejects.toThrow(
      "ordinary sibling disagrees",
    ),
  );
  expect(dependency.dualCalls).toHaveLength(0);
});
