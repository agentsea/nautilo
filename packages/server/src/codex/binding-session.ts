import type { DirectDatabase } from "@nautilo/db";
import { getActiveCodexBindingForTaskWith } from "@nautilo/db";
import type { HarnessExecutionAdmission } from "@nautilo/runtime";
import {
  CodexRelaySemanticAdapter,
  type CodexRelaySemanticScopes,
} from "@nautilo/runtime";
import type {
  BindingIdentityScope,
  BindingOpenScope,
  BindingScope,
  ProfileLaunchScope,
  TurnScope,
  RelayCodexCommandMessage,
  RelayCodexCommandResponseMessage,
} from "@nautilo/relay";
import type { CodexBindingSessionPort, CodexBoundSession, CodexStartedTurn } from "./harness-execution";
import type {
  CodexBindingMutationPort,
  CodexDerivedBindingScope,
  CodexPersistedBindingIdentity,
} from "./authority";
import { CodexAuthorityFailure } from "./authority";
import {
  assertCodexExecutionAdmission,
  type CodexExecutionAdmission,
} from "./execution-admission";
import type { CodexRelayTurnScope } from "./turn-event-broker";

/** A bounded service failure. Raw app-server or relay text is never exposed. */
export type CodexBindingSessionFailureCode =
  | "CODEX_EXECUTION_ADMISSION_INVALID"
  | "CODEX_CHILD_UNAVAILABLE"
  | "CODEX_BINDING_MISMATCH"
  | "CODEX_BINDING_STALE"
  | "CODEX_BINDING_UNAVAILABLE"
  | "CODEX_WORKSPACE_UNAVAILABLE"
  | "CODEX_TURN_UNAVAILABLE"
  | "CODEX_PERSISTENCE_CONFLICT";

export class CodexBindingSessionFailure extends Error {
  constructor(readonly code: CodexBindingSessionFailureCode) {
    super(code);
    this.name = "CodexBindingSessionFailure";
  }
}

/** The exact persisted subset consumed by the task-only session state machine. */
export interface CodexTaskBindingRecord extends CodexPersistedBindingIdentity {
  readonly id: string;
  readonly userId: string;
  readonly sourceAgentId: string;
  readonly taskId: string;
  readonly taskRunId: string;
  readonly jobId: string;
  readonly parentTaskId: string | null;
  readonly roomId: string;
  readonly laneKey: string;
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  readonly capabilityRevision: number;
  readonly workspaceRef: string;
  readonly workspaceRevision: number;
  readonly workspaceFingerprint: string;
  readonly workspaceIssuedAt: Date;
  readonly workspaceExpiresAt: Date;
  readonly accountProfileId: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly runtimeGeneration: number;
  readonly childGeneration: number;
  readonly bindingGeneration: number;
  readonly codexSandboxMode: "default" | "workspace-write" | "danger-full-access";
  readonly codexApprovalPolicy: "default" | "on-request" | "never";
  readonly state: string;
  readonly revision: number;
  readonly archivedAt: Date | null;
}

export interface CodexTaskBindingLookupPort {
  getActiveTaskBinding(
    scope: CodexDerivedBindingScope,
  ): Promise<CodexTaskBindingRecord | null>;
}

/** Concrete task-only lookup. There is deliberately no Room binding fallback. */
export function createCodexTaskBindingLookup(
  db: DirectDatabase,
): CodexTaskBindingLookupPort {
  return {
    async getActiveTaskBinding(scope) {
      const row = await getActiveCodexBindingForTaskWith(
        db as Parameters<typeof getActiveCodexBindingForTaskWith>[0],
        { userId: scope.userId, agentId: scope.agentId },
        scope.taskId,
      );
      return row as CodexTaskBindingRecord | undefined ?? null;
    },
  };
}

export interface CodexBindingSessionRelayPort {
  sendCodexCommand(
    relayId: string,
    command: RelayCodexCommandMessage,
  ): Promise<RelayCodexCommandResponseMessage>;
}

export interface CodexBindingSessionDeps {
  readonly relay: CodexBindingSessionRelayPort;
  readonly bindings: CodexTaskBindingLookupPort;
  readonly mutations: CodexBindingMutationPort;
  /** Used only for relay command/input ids; binding and vendor ids are external. */
  readonly mintId: () => string;
}

interface PrivateCodexBoundSession extends CodexBoundSession {
  readonly id: string;
  readonly scope: BindingScope;
  readonly authorityScope: CodexDerivedBindingScope;
  readonly revision: number;
}

interface PrivateCodexStartedTurn extends CodexStartedTurn {
  readonly scope: CodexRelayTurnScope;
  readonly wireScope: TurnScope;
  readonly session: PrivateCodexBoundSession;
}

const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OPAQUE_BYTES = 512;
const encoder = new TextEncoder();

/**
 * Server-private binding state machine. It only accepts a branded admission,
 * derives every wire scope from it and persisted facts, and never indexes a
 * binding by arbitrary Room/thread input.
 */
export class CodexBindingSessionService implements CodexBindingSessionPort {
  /** Instance-local capability brands, not a process-wide binding/thread map. */
  private readonly sessions = new WeakSet<object>();
  private readonly turns = new WeakSet<object>();

  constructor(private readonly deps: CodexBindingSessionDeps) {}

  async openOrResume(admissionInput: HarnessExecutionAdmission): Promise<CodexBoundSession> {
    const admission = this.admission(admissionInput);
    const scope = admission.codex.scope;
    const identity = admittedBindingIdentity(admission);

    const child = await this.execute(scope, {
      resolveProfileLaunchScope: () => profileLaunchScope(scope),
    }, { operation: "ensure_profile_child", posture: postureName(scope) });
    if (child.status !== "ok" || child.result.kind !== "child_ready" || child.childGeneration !== scope.childGeneration) {
      throw new CodexBindingSessionFailure("CODEX_CHILD_UNAVAILABLE");
    }

    // This is intentionally the only read. A Room binding can never be shared
    // or silently substituted for a canonical Task binding.
    const persisted = await this.deps.bindings.getActiveTaskBinding(scope);
    if (!persisted) return this.open(admission, identity);
    if (!validTaskOwnedBinding(persisted, scope)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }

    if (!sameImmutableIdentity(persisted, scope, admission)) {
      if (!canReplaceImmutableDrift(persisted, scope, admission, identity)) {
        throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
      }
      return this.replace(admission, persisted, identity);
    }

    if (persisted.id !== identity.id || persisted.archivedAt !== null) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }

    if (persisted.state === "active") {
      if (persisted.bindingGeneration !== identity.generation) {
        throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
      }
      if (!sameLiveScope(persisted, scope)) {
        throw new CodexBindingSessionFailure("CODEX_BINDING_STALE");
      }
      const binding = bindingScope(scope, persisted.id, persisted.bindingGeneration, persisted.codexThreadId);
      await this.resume(scope, binding, persisted.codexThreadId);
      return this.session(binding, scope, persisted.revision);
    }

    // `open_binding` is intentionally host-first and persistence is fail-closed.
    // A process crash or CAS conflict after insert can therefore leave the one
    // exact durable row in `opening`. It is recoverable only for the original
    // live generation-0 identity: prove that same host binding still resumes,
    // then complete the pending state transition with its persisted revision.
    if (persisted.state === "opening") {
      if (persisted.bindingGeneration !== 0 || identity.generation !== 0) {
        throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
      }
      if (!sameLiveScope(persisted, scope)) {
        throw new CodexBindingSessionFailure("CODEX_BINDING_STALE");
      }
      const binding = bindingScope(scope, persisted.id, persisted.bindingGeneration, persisted.codexThreadId);
      await this.resume(scope, binding, persisted.codexThreadId);
      await this.persist(() => this.deps.mutations.update(
        scope,
        persisted.id,
        persisted.revision,
        { state: "active" },
      ));
      return this.session(binding, scope, persisted.revision + 1);
    }

    if (persisted.state !== "needs_rebind" ||
      identity.generation !== persisted.bindingGeneration + 1 ||
      !liveScopeChanged(persisted, scope)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_STALE");
    }

    const current = persistedBindingIdentityScope(
      persisted,
      scope.profileHandle,
      scope.selectedProtocolVersion,
    );
    const successor = bindingScope(
      scope,
      persisted.id,
      identity.generation,
      persisted.codexThreadId,
    );
    const rebound = await this.execute(scope, {
      resolveRebindScopes: () => ({ current, successor }),
    }, { operation: "rebind_binding" });
    // v8's rebind acknowledgement is `binding_rebound`; the mandatory exact
    // thread confirmation is the successor `resume_binding` immediately after.
    if (rebound.status !== "ok" || rebound.result.kind !== "binding_rebound") {
      throw new CodexBindingSessionFailure("CODEX_BINDING_UNAVAILABLE");
    }
    await this.persist(() => this.deps.mutations.rebind(
      scope,
      persisted.id,
      persisted.revision,
      persisted.bindingGeneration,
      persistedIdentity(persisted),
    ));
    await this.resume(scope, successor, persisted.codexThreadId);
    return this.session(successor, scope, persisted.revision + 1);
  }

  async startTurn(input: {
    readonly session: CodexBoundSession;
    readonly admission: HarnessExecutionAdmission;
  }): Promise<CodexStartedTurn> {
    const admission = this.admission(input.admission);
    const session = this.sessionFrom(input.session);
    const identity = admittedBindingIdentity(admission);
    if (session.id !== identity.id || session.scope.bindingGeneration !== identity.generation ||
      !sameScopeAdmission(session.scope, admission.codex.scope)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    if (!boundedText(admission.prompt)) {
      throw new CodexBindingSessionFailure("CODEX_TURN_UNAVAILABLE");
    }
    const started = await this.execute(admission.codex.scope, {
      resolveBindingScope: () => session.scope,
    }, {
      operation: "start_turn",
      userText: admission.prompt,
      collaborationMode: admission.codex.collaborationMode,
    }, "CODEX_TURN_UNAVAILABLE");
    if (started.status !== "ok" || started.result.kind !== "turn_started" || !started.turn) {
      throw new CodexBindingSessionFailure("CODEX_TURN_UNAVAILABLE");
    }
    const wireScope = Object.freeze({
        ...session.scope,
        turnId: started.turn.turnId,
      });
    const turn = Object.freeze({
      scope: wireScope,
      wireScope,
      session,
    }) as PrivateCodexStartedTurn;
    this.turns.add(turn);
    return turn;
  }

  async interruptTurn(input: {
    readonly session: CodexBoundSession;
    readonly turn: CodexStartedTurn;
  }): Promise<void> {
    const session = this.sessionFrom(input.session);
    const turn = this.turnFrom(input.turn);
    if (turn.session !== session || !sameBindingScope(turn.scope, session.scope)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    const result = await this.execute(session.authorityScope, {
      resolveTurnScope: () => turn.wireScope,
    }, { operation: "interrupt_turn", reason: "user_stop" }, "CODEX_TURN_UNAVAILABLE");
    if (result.status !== "ok" || result.result.kind !== "interrupted") {
      throw new CodexBindingSessionFailure("CODEX_TURN_UNAVAILABLE");
    }
  }

  async steerTurn(input: {
    readonly session: CodexBoundSession;
    readonly turn: CodexStartedTurn;
    readonly text: string;
    readonly actorRef: string;
  }): Promise<void> {
    const session = this.sessionFrom(input.session);
    const turn = this.turnFrom(input.turn);
    if (
      turn.session !== session
      || !sameBindingScope(turn.scope, session.scope)
      || !boundedText(input.text)
      || !boundedOpaque(input.actorRef)
    ) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    const result = await this.execute(session.authorityScope, {
      resolveTurnScope: () => turn.wireScope,
    }, {
      operation: "steer_turn",
      userText: input.text,
      actorRef: input.actorRef,
    }, "CODEX_TURN_UNAVAILABLE");
    if (result.status !== "ok" || result.result.kind !== "accepted") {
      throw new CodexBindingSessionFailure("CODEX_TURN_UNAVAILABLE");
    }
  }

  private async open(
    admission: CodexExecutionAdmission,
    identity: { id: string; generation: number },
  ): Promise<CodexBoundSession> {
    if (identity.generation !== 0) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    const scope = admission.codex.scope;
    const open = bindingOpenScope(scope, identity.id, identity.generation);
    const result = await this.openBinding(scope, open, admission);
    if (result.status !== "ok" || result.result.kind !== "binding_ready" ||
      !boundedOpaque(result.threadId)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_UNAVAILABLE");
    }
    // A thread is not durable until the host's correlated binding_ready arrives.
    await this.persist(() => this.deps.mutations.insert(scope, {
      bindingId: identity.id,
      bindingKind: "task",
      codexThreadId: result.threadId!,
      selectedModel: admission.codex.selectedModel,
    }));
    await this.persist(() => this.deps.mutations.update(scope, identity.id, 0, { state: "active" }));
    return this.session(bindingScope(scope, identity.id, identity.generation, result.threadId), scope, 1);
  }

  /**
   * Immutable provenance (account/host/workspace/posture/runtime/model)
   * never updates an existing binding or reuses its Codex thread. The only
   * legal transition is host-first open of a new generation-zero binding,
   * followed by the persistence adapter's archive-and-insert CAS.
   *
   * If the CAS loses after host success, the new host binding has no durable
   * owner. Best-effort release is correlated to this exact just-opened scope;
   * it cannot release the durable winner or a later generation.
   */
  private async replace(
    admission: CodexExecutionAdmission,
    predecessor: CodexTaskBindingRecord,
    identity: { id: string; generation: number },
  ): Promise<CodexBoundSession> {
    const scope = admission.codex.scope;
    const open = bindingOpenScope(scope, identity.id, identity.generation);
    const result = await this.openBinding(scope, open, admission);
    if (result.status !== "ok" || result.result.kind !== "binding_ready" ||
      !boundedOpaque(result.threadId) || result.threadId === predecessor.codexThreadId) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_UNAVAILABLE");
    }

    // `replace` is one transaction: losing its revision CAS leaves durable
    // state unchanged by this attempt and this fresh host binding unreachable
    // until its exact correlated release is attempted below.
    const opened = bindingScope(scope, identity.id, identity.generation, result.threadId);
    try {
      await this.deps.mutations.replace(
        scope,
        predecessor.id,
        predecessor.revision,
        {
          bindingId: identity.id,
          bindingKind: "task",
          codexThreadId: result.threadId,
          selectedModel: admission.codex.selectedModel,
        },
      );
    } catch (error) {
      // Only the persistence adapter's explicit compare-and-swap conflict
      // proves this open has no durable successor. A transport/DB exception
      // has an ambiguous commit outcome, so it must retain host state for
      // recovery rather than risk deleting a winner.
      if (error instanceof CodexAuthorityFailure && error.code === "CODEX_CONFLICT") {
        await this.releaseOpenedBinding(scope, opened);
      }
      throw new CodexBindingSessionFailure("CODEX_PERSISTENCE_CONFLICT");
    }
    await this.persist(() => this.deps.mutations.update(
      scope,
      identity.id,
      0,
      { state: "active" },
    ));
    return this.session(
      opened,
      scope,
      1,
    );
  }

  private async resume(
    scope: CodexDerivedBindingScope,
    binding: BindingScope,
    threadId: string,
  ): Promise<void> {
    const result = await this.execute(scope, {
      resolveBindingScope: () => binding,
    }, { operation: "resume_binding" });
    // The semantic adapter exposes a thread id only for open_binding. For
    // resume, its strict response correlation proves the supplied BindingScope
    // (including this exact thread id) was accepted.
    if (result.status !== "ok" || result.result.kind !== "binding_ready" || binding.threadId !== threadId) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_UNAVAILABLE");
    }
  }

  /** Releases only the binding scope opened by the immediately preceding call. */
  private async releaseOpenedBinding(
    scope: CodexDerivedBindingScope,
    binding: BindingScope,
  ): Promise<void> {
    try {
      const result = await this.execute(scope, {
        resolveBindingScope: () => binding,
      }, { operation: "release_binding" });
      if (result.status !== "ok" || result.result.kind !== "binding_released") return;
    } catch {
      // Cleanup never obscures the durable conflict that caused it.
    }
  }

  private async openBinding(
    scope: CodexDerivedBindingScope,
    open: BindingOpenScope,
    admission: CodexExecutionAdmission,
  ) {
    try {
      const adapter = this.adapter(scope, { resolveBindingOpenScope: () => open });
      const result = await adapter.openBinding(scope.relayId, {
        ...(admission.codex.selectedModel === null ? {} : { model: admission.codex.selectedModel }),
        posture: postureName(scope),
        ...(admission.codex.workingDirectory === null
          ? {}
          : { workingDirectory: admission.codex.workingDirectory }),
      });
      // The relay intentionally exposes no host path/message. An explicit
      // task cwd is the one case where a stale workspace rejection has an
      // actionable, retryable meaning for Genie instead of a generic binding
      // failure. Automatic cwd resolution keeps the closed generic outcome.
      if (
        admission.codex.workingDirectory !== null &&
        result.status === "rejected" &&
        result.result.kind === "rejected" &&
        result.result.code === "CODEX_CONTEXT_STALE"
      ) {
        throw new CodexBindingSessionFailure("CODEX_WORKSPACE_UNAVAILABLE");
      }
      return result;
    } catch (error) {
      throw this.mapRelay(error, "CODEX_BINDING_UNAVAILABLE");
    }
  }

  private async execute(
    scope: CodexDerivedBindingScope,
    scopes: Omit<CodexRelaySemanticScopes, "resolveHostScope">,
    command: unknown,
    failure: CodexBindingSessionFailureCode = "CODEX_BINDING_UNAVAILABLE",
  ) {
    try {
      return await this.adapter(scope, scopes).execute(scope.relayId, command);
    } catch (error) {
      throw this.mapRelay(
        error,
        command && typeof command === "object" && "operation" in command && command.operation === "ensure_profile_child"
          ? "CODEX_CHILD_UNAVAILABLE"
          : failure,
      );
    }
  }

  private adapter(
    scope: CodexDerivedBindingScope,
    scopes: Omit<CodexRelaySemanticScopes, "resolveHostScope">,
  ) {
    return new CodexRelaySemanticAdapter({
      mintId: this.deps.mintId,
      sendCommand: (relayId, command) => this.deps.relay.sendCodexCommand(relayId, command),
      scopes: { resolveHostScope: () => hostScope(scope), ...scopes },
    });
  }

  private admission(input: HarnessExecutionAdmission): CodexExecutionAdmission {
    try {
      assertCodexExecutionAdmission(input);
    } catch {
      throw new CodexBindingSessionFailure("CODEX_EXECUTION_ADMISSION_INVALID");
    }
    if (!sameAdmissionScope(input)) {
      throw new CodexBindingSessionFailure("CODEX_EXECUTION_ADMISSION_INVALID");
    }
    return input;
  }

  private session(
    scope: BindingScope,
    authorityScope: CodexDerivedBindingScope,
    revision: number,
  ): CodexBoundSession {
    const session = Object.freeze({
      id: scope.bindingId,
      scope: Object.freeze(scope),
      authorityScope: Object.freeze({ ...authorityScope }),
      revision,
    }) as PrivateCodexBoundSession;
    this.sessions.add(session);
    return session;
  }

  private sessionFrom(input: CodexBoundSession): PrivateCodexBoundSession {
    if (typeof input !== "object" || input === null || !this.sessions.has(input)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    return input as PrivateCodexBoundSession;
  }

  private turnFrom(input: CodexStartedTurn): PrivateCodexStartedTurn {
    if (typeof input !== "object" || input === null || !this.turns.has(input)) {
      throw new CodexBindingSessionFailure("CODEX_BINDING_MISMATCH");
    }
    return input as PrivateCodexStartedTurn;
  }

  private async persist(action: () => Promise<unknown>): Promise<void> {
    try {
      await action();
    } catch {
      throw new CodexBindingSessionFailure("CODEX_PERSISTENCE_CONFLICT");
    }
  }

  private mapRelay(error: unknown, fallback: CodexBindingSessionFailureCode): CodexBindingSessionFailure {
    if (error instanceof CodexBindingSessionFailure) return error;
    return new CodexBindingSessionFailure(fallback);
  }
}

function admittedBindingIdentity(admission: CodexExecutionAdmission) {
  const generation = Number(admission.binding.generation);
  if (!nonEmpty(admission.binding.id) || !Number.isSafeInteger(generation) || generation < 0 || String(generation) !== admission.binding.generation) {
    throw new CodexBindingSessionFailure("CODEX_EXECUTION_ADMISSION_INVALID");
  }
  return { id: admission.binding.id, generation };
}

function sameAdmissionScope(admission: CodexExecutionAdmission): boolean {
  const scope = admission.codex.scope;
  return admission.jobId === scope.jobId && admission.taskId === scope.taskId &&
    admission.taskRunId === scope.taskRunId && admission.ownerId === scope.userId &&
    admission.requesterId === scope.userId && admission.source === "room" &&
    admission.parentTaskId === scope.parentTaskId &&
    admission.roomId === scope.roomId && admission.laneKey === scope.laneKey &&
    admission.profile.id === scope.profileId &&
    admission.profile.generation === String(scope.profileGeneration) &&
    admission.workspace.pairingGeneration === scope.pairingGenerationRef &&
    admission.posture.id === scope.posture && nonEmpty(admission.posture.generation);
}

function profileLaunchScope(scope: CodexDerivedBindingScope): ProfileLaunchScope {
  return {
    ...hostScope(scope),
    profileHandle: scope.profileHandle,
    profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration,
    runtimeGeneration: scope.runtimeGeneration,
  };
}

function profileScope(scope: CodexDerivedBindingScope) {
  return { ...profileLaunchScope(scope), childGeneration: scope.childGeneration };
}

function hostScope(scope: CodexDerivedBindingScope) {
  return {
    relayId: scope.relayId,
    relaySessionId: scope.relaySessionId,
    desktopSessionId: scope.desktopSessionId,
    pairingGenerationRef: scope.pairingGenerationRef,
    selectedProtocolVersion: scope.selectedProtocolVersion,
    capabilityRevision: scope.capabilityRevision,
  };
}

function bindingOpenScope(scope: CodexDerivedBindingScope, bindingId: string, bindingGeneration: number): BindingOpenScope {
  return {
    ...profileScope(scope), workspace: scope.workspace, bindingId, bindingGeneration,
    taskId: scope.taskId, jobId: scope.jobId,
  };
}

function bindingScope(
  scope: CodexDerivedBindingScope,
  bindingId: string,
  bindingGeneration: number,
  threadId: string,
): BindingScope {
  return {
    ...profileScope(scope), bindingId, bindingGeneration, taskId: scope.taskId,
    jobId: scope.jobId, threadId, workspace: scope.workspace,
  };
}

function persistedBindingIdentityScope(
  record: CodexTaskBindingRecord,
  profileHandle: string,
  selectedProtocolVersion: number,
): BindingIdentityScope {
  return {
    relayId: record.relayId,
    relaySessionId: record.relaySessionId,
    desktopSessionId: record.desktopSessionId,
    pairingGenerationRef: record.pairingGenerationRef,
    selectedProtocolVersion,
    capabilityRevision: record.capabilityRevision,
    profileHandle,
    profileGeneration: record.profileGeneration,
    accountGeneration: record.accountGeneration,
    runtimeGeneration: record.runtimeGeneration,
    childGeneration: record.childGeneration,
    bindingId: record.id,
    bindingGeneration: record.bindingGeneration,
    taskId: record.taskId,
    jobId: record.jobId,
    threadId: record.codexThreadId,
  };
}

function persistedIdentity(record: CodexTaskBindingRecord): CodexPersistedBindingIdentity {
  return {
    bindingKind: record.bindingKind,
    codexThreadId: record.codexThreadId,
    selectedModel: record.selectedModel,
  };
}

function sameImmutableIdentity(
  record: CodexTaskBindingRecord,
  scope: CodexDerivedBindingScope,
  admission: CodexExecutionAdmission,
): boolean {
  return record.bindingKind === "task" && record.userId === scope.userId &&
    record.sourceAgentId === scope.agentId && record.taskId === scope.taskId &&
    record.taskRunId === scope.taskRunId && record.jobId === scope.jobId &&
    record.parentTaskId === scope.parentTaskId && record.roomId === scope.roomId &&
    record.laneKey === scope.laneKey && record.relayId === scope.relayId &&
    record.pairingGenerationRef === scope.pairingGenerationRef &&
    record.workspaceRef === scope.workspace.workspaceRef &&
    record.workspaceFingerprint === scope.workspace.fingerprint &&
    record.accountProfileId === scope.profileId &&
    record.profileGeneration === scope.profileGeneration &&
    record.accountGeneration === scope.accountGeneration &&
    record.runtimeGeneration === scope.runtimeGeneration &&
    record.selectedModel === admission.codex.selectedModel &&
    record.codexSandboxMode === scope.codexSandboxMode &&
    record.codexApprovalPolicy === scope.codexApprovalPolicy &&
    nonEmpty(record.codexThreadId);
}

function canReplaceImmutableDrift(
  record: CodexTaskBindingRecord,
  scope: CodexDerivedBindingScope,
  admission: CodexExecutionAdmission,
  identity: { id: string; generation: number },
): boolean {
  return identity.generation === 0 && boundedOpaque(identity.id) && identity.id !== record.id &&
    (record.state === "active" || record.state === "opening" || record.state === "needs_rebind") &&
    !sameImmutableIdentity(record, scope, admission);
}

function validTaskOwnedBinding(
  record: CodexTaskBindingRecord,
  scope: CodexDerivedBindingScope,
): boolean {
  return boundedOpaque(record.id) && safeGeneration(record.bindingGeneration) &&
    safeGeneration(record.revision) && safeGeneration(record.capabilityRevision) &&
    safeGeneration(record.workspaceRevision) && safeGeneration(record.profileGeneration) &&
    safeGeneration(record.accountGeneration) && safeGeneration(record.runtimeGeneration) &&
    safeGeneration(record.childGeneration) && validWindow(record.workspaceIssuedAt, record.workspaceExpiresAt) &&
    record.archivedAt === null && record.bindingKind === "task" &&
    record.userId === scope.userId && record.sourceAgentId === scope.agentId &&
    record.taskId === scope.taskId && record.taskRunId === scope.taskRunId &&
    record.jobId === scope.jobId && record.parentTaskId === scope.parentTaskId &&
    record.roomId === scope.roomId && record.laneKey === scope.laneKey &&
    boundedOpaque(record.relayId) && boundedOpaque(record.relaySessionId) &&
    boundedOpaque(record.desktopSessionId) && boundedOpaque(record.pairingGenerationRef) &&
    boundedOpaque(record.workspaceRef) && boundedOpaque(record.workspaceFingerprint) &&
    boundedOpaque(record.accountProfileId) && boundedOpaque(record.codexThreadId) &&
    (record.selectedModel === null || boundedOpaque(record.selectedModel)) &&
    validSandboxMode(record.codexSandboxMode) && validApprovalPolicy(record.codexApprovalPolicy);
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

function boundedOpaque(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 &&
    encoder.encode(value).byteLength <= MAX_OPAQUE_BYTES;
}

function sameLiveScope(record: CodexTaskBindingRecord, scope: CodexDerivedBindingScope): boolean {
  return record.relaySessionId === scope.relaySessionId &&
    record.desktopSessionId === scope.desktopSessionId &&
    record.capabilityRevision === scope.capabilityRevision &&
    record.workspaceRef === scope.workspace.workspaceRef &&
    record.workspaceRevision === scope.workspace.revision &&
    record.workspaceIssuedAt.toISOString() === scope.workspace.issuedAt &&
    record.workspaceExpiresAt.toISOString() === scope.workspace.expiresAt &&
    record.childGeneration === scope.childGeneration;
}

function liveScopeChanged(record: CodexTaskBindingRecord, scope: CodexDerivedBindingScope): boolean {
  return !sameLiveScope(record, scope);
}

function sameScopeAdmission(binding: BindingScope, scope: CodexDerivedBindingScope): boolean {
  return binding.relayId === scope.relayId && binding.relaySessionId === scope.relaySessionId &&
    binding.desktopSessionId === scope.desktopSessionId &&
    binding.pairingGenerationRef === scope.pairingGenerationRef &&
    binding.capabilityRevision === scope.capabilityRevision && binding.profileHandle === scope.profileHandle &&
    binding.profileGeneration === scope.profileGeneration && binding.accountGeneration === scope.accountGeneration &&
    binding.runtimeGeneration === scope.runtimeGeneration && binding.childGeneration === scope.childGeneration &&
    binding.taskId === scope.taskId && binding.jobId === scope.jobId &&
    binding.workspace.workspaceRef === scope.workspace.workspaceRef &&
    binding.workspace.revision === scope.workspace.revision &&
    binding.workspace.fingerprint === scope.workspace.fingerprint &&
    binding.workspace.issuedAt === scope.workspace.issuedAt && binding.workspace.expiresAt === scope.workspace.expiresAt;
}

function sameBindingScope(turn: CodexRelayTurnScope, binding: BindingScope): boolean {
  return turn.relayId === binding.relayId && turn.relaySessionId === binding.relaySessionId &&
    turn.desktopSessionId === binding.desktopSessionId && turn.pairingGenerationRef === binding.pairingGenerationRef &&
    turn.selectedProtocolVersion === binding.selectedProtocolVersion &&
    turn.capabilityRevision === binding.capabilityRevision && turn.profileHandle === binding.profileHandle &&
    turn.profileGeneration === binding.profileGeneration && turn.accountGeneration === binding.accountGeneration &&
    turn.runtimeGeneration === binding.runtimeGeneration && turn.childGeneration === binding.childGeneration &&
    turn.bindingId === binding.bindingId && turn.bindingGeneration === binding.bindingGeneration &&
    turn.taskId === binding.taskId && turn.jobId === binding.jobId && turn.threadId === binding.threadId &&
    turn.workspace.workspaceRef === binding.workspace.workspaceRef &&
    turn.workspace.revision === binding.workspace.revision &&
    turn.workspace.fingerprint === binding.workspace.fingerprint &&
    turn.workspace.issuedAt === binding.workspace.issuedAt &&
    turn.workspace.expiresAt === binding.workspace.expiresAt;
}

function postureName(scope: CodexDerivedBindingScope): "default" | "prompted_workspace" | "full_access_headless" {
  if (scope.posture === "prompted_workspace") return "prompted_workspace";
  if (scope.posture === "full_access_headless") return "full_access_headless";
  return "default";
}

function boundedText(value: string): boolean {
  return value.trim().length > 0 && encoder.encode(value).byteLength <= MAX_PROMPT_BYTES;
}

function nonEmpty(value: string): boolean { return value.length > 0; }
