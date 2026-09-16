import { describe, expect, mock, test } from "bun:test";
import type { CodexDerivedBindingScope } from "../../src/codex/authority";
import { CodexAuthorityFailure } from "../../src/codex/authority";
import { CodexPersistenceAdapter } from "../../src/codex/persistence";

const scope: CodexDerivedBindingScope = {
  userId: crypto.randomUUID(),
  agentId: crypto.randomUUID(),
  taskId: crypto.randomUUID(),
  taskRunId: crypto.randomUUID(),
  jobId: crypto.randomUUID(),
  parentTaskId: null,
  roomId: crypto.randomUUID(),
  laneKey: `room:${crypto.randomUUID()}`,
  profileId: crypto.randomUUID(),
  relayId: "relay",
  profileHandle: "profile",
  profileGeneration: 2,
  accountGeneration: 3,
  posture: "prompted_workspace",
  explicitSteer: true,
  relaySessionId: "relay-session",
  desktopSessionId: "desktop-session",
  pairingGenerationRef: "pairing",
  selectedProtocolVersion: 8,
  capabilityRevision: 4,
  runtimeGeneration: 5,
  childGeneration: 6,
  workspace: {
    workspaceRef: "workspace",
    revision: 7,
    fingerprint: "fingerprint",
    issuedAt: "2026-07-27T09:55:00.000Z",
    expiresAt: "2026-07-27T10:05:00.000Z",
  },
  codexSandboxMode: "workspace-write",
  codexApprovalPolicy: "on-request",
};
const mutation = {
  bindingKind: "task" as const,
  codexThreadId: "thread",
  selectedModel: "gpt-test",
};

describe("CodexPersistenceAdapter", () => {
  test("maps only canonical scope into exact binding provenance", async () => {
    const values: unknown[] = [];
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: async () => undefined,
          insert: () => ({
            values: (value: unknown) => {
              values.push(value);
              return { returning: async () => [{ id: "binding" }] };
            },
          }),
        }),
    };
    const adapter = new CodexPersistenceAdapter(db as never);
    await adapter.insert(scope, mutation);
    expect(values[0]).toMatchObject({
      userId: scope.userId,
      sourceAgentId: scope.agentId,
      taskId: scope.taskId,
      taskRunId: scope.taskRunId,
      jobId: scope.jobId,
      roomId: scope.roomId,
      laneKey: scope.laneKey,
      relayId: scope.relayId,
      relaySessionId: scope.relaySessionId,
      desktopSessionId: scope.desktopSessionId,
      pairingGenerationRef: scope.pairingGenerationRef,
      workspaceFingerprint: scope.workspace.fingerprint,
      accountProfileId: scope.profileId,
      profileGeneration: scope.profileGeneration,
      accountGeneration: scope.accountGeneration,
      runtimeGeneration: scope.runtimeGeneration,
      childGeneration: scope.childGeneration,
      codexSandboxMode: "workspace-write",
      codexApprovalPolicy: "on-request",
    });
  });

  test("translates an undefined optimistic result into CODEX_CONFLICT", async () => {
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: async () => undefined,
          update: () => ({
            set: () => ({
              where: () => ({ returning: async () => [] }),
            }),
          }),
        }),
    };
    const adapter = new CodexPersistenceAdapter(db as never);
    try {
      await adapter.archive(scope, crypto.randomUUID(), 9);
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toMatchObject({
        code: "CODEX_CONFLICT",
      } satisfies Partial<CodexAuthorityFailure>);
    }
  });

  test("rebind predicates every immutable authority dimension", async () => {
    const where = mock(() => ({ returning: async () => [] }));
    const db = {
      transaction: async (callback: (tx: unknown) => Promise<unknown>) =>
        callback({
          execute: async () => undefined,
          update: () => ({ set: () => ({ where }) }),
        }),
    };
    const adapter = new CodexPersistenceAdapter(db as never);
    try {
      await adapter.rebind(scope, crypto.randomUUID(), 2, 1, {
        bindingKind: "task",
        codexThreadId: "thread",
        selectedModel: "gpt-test",
      });
      throw new Error("expected conflict");
    } catch (error) {
      expect(error).toMatchObject({ code: "CODEX_CONFLICT" });
    }
    expect(where).toHaveBeenCalledTimes(1);
  });
});
