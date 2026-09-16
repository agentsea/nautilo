import { describe, expect, test } from "bun:test";
import type { TaskExecutionRouteFacts } from "@nautilo/runtime";
import type { CodexDerivedBindingScope } from "../../src/codex/authority";
import {
  CodexExecutionAdmissionFactory,
  CodexExecutionAdmissionFactoryFailure,
  prepareCodexBindingIdentity,
  type CodexExecutionAdmissionFactoryDeps,
} from "../../src/codex/admission-factory";
import type { CodexTaskBindingRecord } from "../../src/codex/binding-session";
import { isCodexExecutionAdmission } from "../../src/codex/execution-admission";

const facts: TaskExecutionRouteFacts = {
  taskId: "task", taskRunId: "run", parentTaskId: null,
  ownerId: "owner", requestorId: "owner", agentId: "agent", roomId: "room",
  laneKey: "room:agent", graphThreadId: "room:agent:graph",
};
const outputContract = {
  version: 1, capabilityModelId: "openai:gpt-test", catalogVersion: "test-v1",
  contextTokens: 1_000_000, outputTokens: 128_000,
} as const;

const scope: CodexDerivedBindingScope = {
  userId: "owner", agentId: "agent", taskId: "task", taskRunId: "run", jobId: "job",
  parentTaskId: null, roomId: "room", laneKey: "room:agent", profileId: "profile",
  relayId: "relay", profileHandle: "profile-handle", profileGeneration: 2,
  accountGeneration: 3, posture: "prompted_workspace", explicitSteer: true,
  relaySessionId: "relay-session",
  desktopSessionId: "desktop-session", pairingGenerationRef: "pairing", selectedProtocolVersion: 8, capabilityRevision: 4,
  runtimeGeneration: 5, childGeneration: 6,
  workspace: {
    workspaceRef: "workspace", revision: 7, fingerprint: "fingerprint",
    issuedAt: "2026-07-29T00:00:00.000Z", expiresAt: "2026-07-30T00:00:00.000Z",
  },
  codexSandboxMode: "workspace-write", codexApprovalPolicy: "on-request",
};

function binding(overrides: Partial<CodexTaskBindingRecord> = {}): CodexTaskBindingRecord {
  return {
    id: "binding", userId: scope.userId, sourceAgentId: scope.agentId,
    taskId: scope.taskId, taskRunId: scope.taskRunId, jobId: scope.jobId,
    parentTaskId: scope.parentTaskId, roomId: scope.roomId, laneKey: scope.laneKey,
    relayId: scope.relayId, relaySessionId: scope.relaySessionId,
    desktopSessionId: scope.desktopSessionId, pairingGenerationRef: scope.pairingGenerationRef,
    capabilityRevision: scope.capabilityRevision, workspaceRef: scope.workspace.workspaceRef,
    workspaceRevision: scope.workspace.revision, workspaceFingerprint: scope.workspace.fingerprint,
    workspaceIssuedAt: new Date(scope.workspace.issuedAt), workspaceExpiresAt: new Date(scope.workspace.expiresAt),
    accountProfileId: scope.profileId, profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration, runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration, bindingGeneration: 3, bindingKind: "task",
    codexThreadId: "thread", selectedModel: null,
    codexSandboxMode: scope.codexSandboxMode, codexApprovalPolicy: scope.codexApprovalPolicy,
    state: "active", revision: 9, archivedAt: null,
    ...overrides,
  };
}

function deps(row: CodexTaskBindingRecord | null): CodexExecutionAdmissionFactoryDeps {
  return {
    bindings: { getActiveTaskBinding: async () => row },
    mintId: () => "minted-binding",
  };
}

async function create(row: CodexTaskBindingRecord | null, selectedModel: string | null = null) {
  return new CodexExecutionAdmissionFactory(deps(row)).create({
    facts, scope, jobId: scope.jobId, prompt: "Inspect the repository",
    selectedModel, outputContract, collaborationMode: "work", workingDirectory: null, signal: new AbortController().signal,
  });
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
    throw new Error("expected rejection");
  } catch (error) {
    return error;
  }
}

describe("CodexExecutionAdmissionFactory", () => {
  test("mints generation zero once before branding when no exact binding exists", async () => {
    const admission = await create(null);
    expect(isCodexExecutionAdmission(admission)).toBe(true);
    expect(admission.binding).toEqual({ id: "minted-binding", generation: "0" });
    expect(admission.codex.selectedModel).toBeNull();
    expect(Object.isFrozen(admission)).toBe(true);
  });

  test("uses the exact persisted active/opening binding id and generation", () => {
    const expected = { selectedModel: null } as const;
    expect(prepareCodexBindingIdentity(scope, binding({ state: "active", bindingGeneration: 3 }), () => "new", expected))
      .toEqual({ id: "binding", generation: 3 });
    expect(prepareCodexBindingIdentity(scope, binding({ state: "opening", bindingGeneration: 0 }), () => "new", expected))
      .toEqual({ id: "binding", generation: 0 });
  });

  test("prepares the only legal needs_rebind successor generation", () => {
    expect(prepareCodexBindingIdentity(
      scope,
      binding({ state: "needs_rebind", bindingGeneration: 3 }),
      () => "new",
      { selectedModel: null },
    ))
      .toEqual({ id: "binding", generation: 4 });
  });

  test("mints a fresh generation-zero identity for valid immutable provenance drift", () => {
    expect(prepareCodexBindingIdentity(
      scope,
      binding({ runtimeGeneration: scope.runtimeGeneration + 1 }),
      () => "replacement-binding",
      { selectedModel: null },
    )).toEqual({ id: "replacement-binding", generation: 0 });
    expect(prepareCodexBindingIdentity(
      scope,
      binding({ workspaceRef: "previous-workspace" }),
      () => "replacement-binding",
      { selectedModel: null },
    )).toEqual({ id: "replacement-binding", generation: 0 });
  });

  test("uses the durable thread only when its selected model still agrees, otherwise mints a replacement", async () => {
    expect((await create(binding())).binding).toEqual({ id: "binding", generation: "3" });
    expect((await create(binding({ selectedModel: "stale-model" }))).binding)
      .toEqual({ id: "minted-binding", generation: "0" });
  });

  test("fails closed rather than minting around a mismatched durable binding", () => {
    expect(() => prepareCodexBindingIdentity(
      scope,
      binding({ sourceAgentId: "another-agent" }),
      () => "should-not-mint",
      { selectedModel: null },
    )).toThrow(CodexExecutionAdmissionFactoryFailure);
    expect(() => prepareCodexBindingIdentity(
      scope,
      binding({ relayId: "" }),
      () => "should-not-mint",
      { selectedModel: null },
    )).toThrow(CodexExecutionAdmissionFactoryFailure);
  });

  test("retains a nullable selected model and rejects an invalid model identifier", async () => {
    const explicit = await create(null, "gpt-5.6-codex");
    expect(explicit.codex.selectedModel).toBe("gpt-5.6-codex");
    expect(await rejected(create(null, " "))).toMatchObject({
      code: "CODEX_ADMISSION_FACTS_INVALID",
    });
  });

});
