import type { TaskExecutionRouteFacts } from "@nautilo/runtime";
import type { CodexDerivedBindingScope } from "./authority";
import type {
  CodexTaskBindingLookupPort,
  CodexTaskBindingRecord,
} from "./binding-session";
import {
  createCodexExecutionAdmission,
  type CodexExecutionAdmission,
} from "./execution-admission";
import type { CodexExecutionAdmissionFactoryPort } from "./harness-admission";
import type { CodexModelOutputContract } from "./model-output-contract";

const MAX_OPAQUE_BYTES = 512;
const encoder = new TextEncoder();

export type CodexExecutionAdmissionFactoryFailureCode =
  | "CODEX_ADMISSION_FACTS_INVALID"
  | "CODEX_BINDING_IDENTITY_INVALID"
  | "CODEX_CAPABILITY_UNAVAILABLE";

/** A bounded failure at the server-only admission seam. */
export class CodexExecutionAdmissionFactoryFailure extends Error {
  constructor(readonly code: CodexExecutionAdmissionFactoryFailureCode) {
    super(code);
    this.name = "CodexExecutionAdmissionFactoryFailure";
  }
}

export interface CodexExecutionAdmissionFactoryDeps {
  /** One exact task binding lookup, shared with the binding session service. */
  readonly bindings: CodexTaskBindingLookupPort;
  /** Server allocator used for a new or immutable-provenance replacement binding. */
  readonly mintId: () => string;
}

type BindingIdentity = Readonly<{ id: string; generation: number }>;
type ExpectedBindingProvenance = Readonly<{ selectedModel: string | null }>;

/**
 * Builds one private Codex admission after semantic authority has produced its
 * canonical scope. Binding identity is selected exactly once before admission
 * branding; Codex never receives Nautilo callback declarations.
 */
export class CodexExecutionAdmissionFactory
  implements CodexExecutionAdmissionFactoryPort
{
  constructor(private readonly deps: CodexExecutionAdmissionFactoryDeps) {}

  async create(input: {
    readonly facts: TaskExecutionRouteFacts;
    readonly scope: CodexDerivedBindingScope;
    readonly jobId: string;
    readonly prompt: string;
    readonly selectedModel: string | null;
    readonly outputContract: CodexModelOutputContract;
    readonly collaborationMode: "work" | "plan";
    readonly workingDirectory: string | null;
    readonly signal: AbortSignal;
  }): Promise<CodexExecutionAdmission> {
    if (!exactFacts(input.facts, input.scope, input.jobId) ||
      !validModel(input.selectedModel) ||
      (input.collaborationMode !== "work" && input.collaborationMode !== "plan")) {
      throw new CodexExecutionAdmissionFactoryFailure("CODEX_ADMISSION_FACTS_INVALID");
    }

    const persisted = await this.deps.bindings.getActiveTaskBinding(input.scope);
    const identity = prepareCodexBindingIdentity(
      input.scope,
      persisted,
      this.deps.mintId,
      { selectedModel: input.selectedModel },
    );

    return createCodexExecutionAdmission({
      jobId: input.jobId,
      taskId: input.facts.taskId,
      taskRunId: input.facts.taskRunId,
      ownerId: input.facts.ownerId,
      requesterId: input.facts.requestorId,
      roomId: input.facts.roomId,
      laneKey: input.facts.laneKey,
      source: "room",
      parentTaskId: input.facts.parentTaskId,
      binding: { id: identity.id, generation: String(identity.generation) },
      workspace: {
        id: input.scope.workspace.workspaceRef,
        currentFolderReceiptId: input.scope.workspace.fingerprint,
        pairingGeneration: input.scope.pairingGenerationRef,
      },
      profile: {
        id: input.scope.profileId,
        generation: String(input.scope.profileGeneration),
      },
      posture: {
        id: input.scope.posture,
        generation: `${input.scope.codexSandboxMode}:${input.scope.codexApprovalPolicy}`,
      },
      prompt: input.prompt,
      abortSignal: input.signal,
      codex: {
        scope: input.scope,
        selectedModel: input.selectedModel,
        outputContract: input.outputContract,
        collaborationMode: input.collaborationMode,
        workingDirectory: input.workingDirectory,
        bindingKind: "task",
      },
    });
  }
}

/**
 * Selects the only identity the binding session can later accept. A valid
 * Task-owned predecessor with immutable provenance drift gets a fresh id at
 * generation zero; the binding session then opens a fresh upstream thread and
 * atomically archives/replaces that predecessor. Malformed or foreign rows
 * remain fail-closed and can never be displaced by this path.
 */
export function prepareCodexBindingIdentity(
  scope: CodexDerivedBindingScope,
  persisted: CodexTaskBindingRecord | null,
  mintId: () => string,
  expected: ExpectedBindingProvenance,
): BindingIdentity {
  if (!persisted) {
    return freshBindingIdentity(mintId);
  }
  if (!isValidTaskOwnedBinding(persisted, scope)) {
    throw new CodexExecutionAdmissionFactoryFailure("CODEX_BINDING_IDENTITY_INVALID");
  }
  if (!sameImmutableProvenance(persisted, scope, expected)) {
    return freshBindingIdentity(mintId);
  }
  if (persisted.state === "active" || persisted.state === "opening") {
    return Object.freeze({ id: persisted.id, generation: persisted.bindingGeneration });
  }
  if (persisted.state === "needs_rebind" &&
    persisted.bindingGeneration < Number.MAX_SAFE_INTEGER) {
    return Object.freeze({ id: persisted.id, generation: persisted.bindingGeneration + 1 });
  }
  throw new CodexExecutionAdmissionFactoryFailure("CODEX_BINDING_IDENTITY_INVALID");
}

function freshBindingIdentity(mintId: () => string): BindingIdentity {
  const id = mintId();
  if (!opaque(id)) {
    throw new CodexExecutionAdmissionFactoryFailure("CODEX_BINDING_IDENTITY_INVALID");
  }
  return Object.freeze({ id, generation: 0 });
}

function exactFacts(
  facts: TaskExecutionRouteFacts,
  scope: CodexDerivedBindingScope,
  jobId: string,
): boolean {
  return facts.taskId === scope.taskId && facts.taskRunId === scope.taskRunId &&
    facts.parentTaskId === scope.parentTaskId && facts.ownerId === scope.userId &&
    facts.requestorId === scope.userId && facts.agentId === scope.agentId &&
    facts.roomId === scope.roomId && facts.laneKey === scope.laneKey &&
    jobId === scope.jobId;
}

function isValidTaskOwnedBinding(
  record: CodexTaskBindingRecord,
  scope: CodexDerivedBindingScope,
): boolean {
  return opaque(record.id) && safeGeneration(record.bindingGeneration) &&
    safeGeneration(record.revision) && safeGeneration(record.capabilityRevision) &&
    safeGeneration(record.workspaceRevision) && safeGeneration(record.profileGeneration) &&
    safeGeneration(record.accountGeneration) && safeGeneration(record.runtimeGeneration) &&
    safeGeneration(record.childGeneration) && validWindow(record.workspaceIssuedAt, record.workspaceExpiresAt) &&
    record.archivedAt === null && record.bindingKind === "task" &&
    record.userId === scope.userId && record.sourceAgentId === scope.agentId &&
    record.taskId === scope.taskId && record.taskRunId === scope.taskRunId &&
    record.jobId === scope.jobId && record.parentTaskId === scope.parentTaskId &&
    record.roomId === scope.roomId && record.laneKey === scope.laneKey &&
    opaque(record.relayId) && opaque(record.relaySessionId) &&
    opaque(record.desktopSessionId) && opaque(record.pairingGenerationRef) &&
    opaque(record.workspaceRef) && opaque(record.workspaceFingerprint) &&
    opaque(record.accountProfileId) && validSandboxMode(record.codexSandboxMode) &&
    validApprovalPolicy(record.codexApprovalPolicy) &&
    opaque(record.codexThreadId) &&
    validModel(record.selectedModel);
}

function sameImmutableProvenance(
  record: CodexTaskBindingRecord,
  scope: CodexDerivedBindingScope,
  expected: ExpectedBindingProvenance,
): boolean {
  return record.relayId === scope.relayId &&
    record.pairingGenerationRef === scope.pairingGenerationRef &&
    record.workspaceRef === scope.workspace.workspaceRef &&
    record.workspaceFingerprint === scope.workspace.fingerprint &&
    record.accountProfileId === scope.profileId &&
    record.profileGeneration === scope.profileGeneration &&
    record.accountGeneration === scope.accountGeneration &&
    record.runtimeGeneration === scope.runtimeGeneration &&
    record.codexSandboxMode === scope.codexSandboxMode &&
    record.codexApprovalPolicy === scope.codexApprovalPolicy &&
    record.selectedModel === expected.selectedModel;
}

function validModel(value: string | null): boolean {
  return value === null || opaque(value);
}

function validWindow(issuedAt: Date, expiresAt: Date): boolean {
  if (!(issuedAt instanceof Date) || !(expiresAt instanceof Date)) return false;
  const issued = issuedAt.getTime();
  const expires = expiresAt.getTime();
  return Number.isFinite(issued) && Number.isFinite(expires) && issued < expires;
}

function validSandboxMode(value: string): boolean {
  return value === "default" || value === "workspace-write" || value === "danger-full-access";
}

function validApprovalPolicy(value: string): boolean {
  return value === "default" || value === "on-request" || value === "never";
}

function safeGeneration(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function opaque(value: string): boolean {
  return value.trim().length > 0 && encoder.encode(value).byteLength <= MAX_OPAQUE_BYTES;
}
