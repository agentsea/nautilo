import {
  archiveCodexBindingWith,
  insertCodexBindingWith,
  insertCodexProfileWith,
  rebindCodexBindingWith,
  replaceCodexBindingWith,
  updateCodexBindingStateWith,
  updateCodexProfileStatusWith,
} from "@nautilo/db";
import type {
  CodexBindingMutationPort,
  CodexDerivedBindingScope,
  CodexInternalBindingMutation,
  CodexInternalOperationalMutation,
  CodexPersistedBindingIdentity,
  CodexProfilePersistencePort,
} from "./authority";
import { CodexAuthorityFailure } from "./authority";

type CodexDb = Parameters<typeof insertCodexBindingWith>[0];

function agentContext(scope: { userId: string; agentId: string }) {
  return { userId: scope.userId, agentId: scope.agentId };
}
function ownerContext(scope: { userId: string }) { return { userId: scope.userId }; }
function locator(scope: CodexDerivedBindingScope, id: string) {
  return {
    id,
    taskId: scope.taskId,
    taskRunId: scope.taskRunId,
    jobId: scope.jobId,
    roomId: scope.roomId,
    laneKey: scope.laneKey,
  };
}
function requireResult<T>(value: T | undefined): T {
  if (value === undefined) {
    throw new CodexAuthorityFailure("CODEX_CONFLICT");
  }
  return value;
}
function bindingInsert(
  scope: CodexDerivedBindingScope,
  mutation: CodexInternalBindingMutation,
) {
  return {
    ...(mutation.bindingId ? { id: mutation.bindingId } : {}),
    sourceAgentId: scope.agentId,
    taskId: scope.taskId,
    taskRunId: scope.taskRunId,
    jobId: scope.jobId,
    parentTaskId: scope.parentTaskId,
    roomId: scope.roomId,
    laneKey: scope.laneKey,
    bindingKind: mutation.bindingKind,
    relayId: scope.relayId,
    relaySessionId: scope.relaySessionId,
    desktopSessionId: scope.desktopSessionId,
    pairingGenerationRef: scope.pairingGenerationRef,
    capabilityRevision: scope.capabilityRevision,
    workspaceRef: scope.workspace.workspaceRef,
    workspaceRevision: scope.workspace.revision,
    workspaceFingerprint: scope.workspace.fingerprint,
    workspaceIssuedAt: new Date(scope.workspace.issuedAt),
    workspaceExpiresAt: new Date(scope.workspace.expiresAt),
    accountProfileId: scope.profileId,
    codexThreadId: mutation.codexThreadId,
    profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration,
    runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration,
    bindingGeneration: 0,
    selectedModel: mutation.selectedModel,
    codexSandboxMode: scope.codexSandboxMode,
    codexApprovalPolicy: scope.codexApprovalPolicy,
    state: "opening" as const,
    revision: 0,
  };
}

/**
 * Trusted server-only adapter. It consumes the authority service's canonical
 * scope and never reconstructs ownership/provenance from browser values.
 */
export class CodexPersistenceAdapter
  implements CodexBindingMutationPort, CodexProfilePersistencePort
{
  constructor(private readonly db: CodexDb) {}

  async insert(
    scope: CodexDerivedBindingScope,
    mutation: CodexInternalBindingMutation,
  ) {
    return requireResult(
      await insertCodexBindingWith(
        this.db,
        agentContext(scope),
        bindingInsert(scope, mutation),
      ),
    );
  }

  async replace(
    scope: CodexDerivedBindingScope,
    currentId: string,
    expectedRevision: number,
    mutation: CodexInternalBindingMutation,
  ) {
    return requireResult(
      await replaceCodexBindingWith(this.db, agentContext(scope), {
        current: locator(scope, currentId),
        expectedRevision,
        replacement: bindingInsert(scope, mutation),
      }),
    );
  }

  async update(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
    mutation: CodexInternalOperationalMutation,
  ) {
    const { state, ...cursor } = mutation;
    return requireResult(
      await updateCodexBindingStateWith(
        this.db,
        agentContext(scope),
        locator(scope, bindingId),
        state,
        expectedRevision,
        cursor,
      ),
    );
  }

  async archive(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
  ) {
    return requireResult(
      await archiveCodexBindingWith(
        this.db,
        agentContext(scope),
        locator(scope, bindingId),
        expectedRevision,
      ),
    );
  }

  async rebind(
    scope: CodexDerivedBindingScope,
    bindingId: string,
    expectedRevision: number,
    expectedBindingGeneration: number,
    persisted: CodexPersistedBindingIdentity,
  ) {
    return requireResult(
      await rebindCodexBindingWith(this.db, agentContext(scope), {
        binding: locator(scope, bindingId),
        expectedRevision,
        expectedBindingGeneration,
        relaySessionId: scope.relaySessionId,
        desktopSessionId: scope.desktopSessionId,
        capabilityRevision: scope.capabilityRevision,
        workspaceRef: scope.workspace.workspaceRef,
        workspaceRevision: scope.workspace.revision,
        workspaceIssuedAt: new Date(scope.workspace.issuedAt),
        workspaceExpiresAt: new Date(scope.workspace.expiresAt),
        childGeneration: scope.childGeneration,
        expected: {
          parentTaskId: scope.parentTaskId,
          bindingKind: persisted.bindingKind,
          relayId: scope.relayId,
          pairingGenerationRef: scope.pairingGenerationRef,
          workspaceFingerprint: scope.workspace.fingerprint,
          accountProfileId: scope.profileId,
          codexThreadId: persisted.codexThreadId,
          profileGeneration: scope.profileGeneration,
          accountGeneration: scope.accountGeneration,
          runtimeGeneration: scope.runtimeGeneration,
          selectedModel: persisted.selectedModel,
          codexSandboxMode: scope.codexSandboxMode,
          codexApprovalPolicy: scope.codexApprovalPolicy,
        },
      }),
    );
  }

  async createProfile(
    input: Parameters<CodexProfilePersistencePort["createProfile"]>[0],
  ) {
    return requireResult(
      await insertCodexProfileWith(this.db, ownerContext(input), {
        id: input.result.profileHandle,
        relayId: input.relayId,
        homeHandle: input.result.homeHandle,
        label: input.label,
        profileGeneration: input.result.profileGeneration,
        accountGeneration: input.result.accountGeneration,
        authState: input.result.authState,
      }),
    );
  }

  async updateProfileStatus(
    input: Parameters<CodexProfilePersistencePort["updateProfileStatus"]>[0],
  ) {
    return requireResult(
      await updateCodexProfileStatusWith(
        this.db,
        ownerContext(input.facts),
        {
          id: input.facts.profileId,
          authState: input.result.authState,
          profileGeneration: input.result.profileGeneration,
          accountGeneration: input.result.accountGeneration,
          expectedRevision: input.expectedRevision,
        },
      ),
    );
  }
}
