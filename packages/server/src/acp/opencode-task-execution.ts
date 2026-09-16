import { randomUUID } from "node:crypto";
import { OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS, type DelegatedTaskFailureReason, type DelegatedTaskFailureReceipt, type ForegroundExecutionRoute, type TaskExecutionRouteFacts, type TaskExecutionRouteSelector } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { ACP_RELAY_MAX_OPAQUE_ID_BYTES, ACP_RELAY_MAX_TEXT_BYTES, OPENCODE_ACP_RELAY_PROTOCOL_VERSION, isAcpStartFailureStage, type AcpExecutionProfile, type AcpExecutionScope, type AcpProcessScope, type AcpSocketScope, type AcpStartFailureStage, type AcpWorkspaceReceipt, type RelayAcpSemanticEvent, type RelayAcpStartedResult, type RelayAcpTerminalEvent } from "@nautilo/relay";
import type { TaskHarnessExecutionRouteRegistration } from "../harness/task-execution-route";
import { TaskHarnessExecutionRouteProviderFailure } from "../harness/task-execution-route";
import { ACP_EXECUTION_FAILED } from "./task-run-lifecycle";
import type { HermesAcpTaskRunLifecyclePort } from "./task-run-lifecycle";

const OPENCODE = "opencode-acp" as const;
const encoder = new TextEncoder();
type RelayAcpExecutionEvent = RelayAcpSemanticEvent | RelayAcpTerminalEvent;

/** Private, closed diagnostics only. Never persisted or delivered to a Room. */
export const OPENCODE_ACP_EXECUTION_FAILURE_STAGES = ["setup", "semantic", "terminal", "report_back", "internal"] as const;
export type OpenCodeAcpExecutionFailureStage = typeof OPENCODE_ACP_EXECUTION_FAILURE_STAGES[number];
export const OPENCODE_ACP_SETUP_CHECKPOINTS = ["linked", "readiness_requested", "readiness_ready", "prepare_requested", "prepared", "start_request", "start_wait", "started", "subscribed"] as const;
export type OpenCodeAcpSetupCheckpoint = typeof OPENCODE_ACP_SETUP_CHECKPOINTS[number];
export const OPENCODE_ACP_SETUP_FAILURE_CODES = ["relay_unavailable", "context_stale", "timeout", "socket_generation_lost", "queue_full", "correlation_replay", "request_invalid", "not_ready", "response_invalid", "subscription_unavailable", "internal"] as const;
export type OpenCodeAcpSetupFailureCode = typeof OPENCODE_ACP_SETUP_FAILURE_CODES[number];
export const OPENCODE_ACP_SELECTION_CHECKPOINTS = ["task", "metadata", "profile", "facts", "delegation", "prompt", "room", "agent_owner", "membership", "relay_snapshot"] as const;
export type OpenCodeAcpSelectionCheckpoint = typeof OPENCODE_ACP_SELECTION_CHECKPOINTS[number];
export const OPENCODE_ACP_SELECTION_FAILURE_CODES = ["mismatch", "unsupported", "invalid", "missing", "ambiguous", "stale", "internal"] as const;
export type OpenCodeAcpSelectionFailureCode = typeof OPENCODE_ACP_SELECTION_FAILURE_CODES[number];

class OpenCodeAcpSetupFailure extends Error {
  constructor(readonly setupCode: OpenCodeAcpSetupFailureCode) {
    super("ACP_SETUP_FAILED");
    this.name = "OpenCodeAcpSetupFailure";
  }
}

export class OpenCodeAcpTaskExecutionFailure extends Error {
  constructor(
    readonly code: "ACP_HARNESS_UNAVAILABLE" | typeof ACP_EXECUTION_FAILED,
    readonly stage: OpenCodeAcpExecutionFailureStage = "setup",
  ) { super(code); this.name = "OpenCodeAcpTaskExecutionFailure"; }
}

class OpenCodeAcpSelectionFailure extends OpenCodeAcpTaskExecutionFailure {
  constructor(
    code: "ACP_HARNESS_UNAVAILABLE" | typeof ACP_EXECUTION_FAILED,
    readonly checkpoint: OpenCodeAcpSelectionCheckpoint,
    readonly selectionCode: OpenCodeAcpSelectionFailureCode,
  ) { super(code); this.name = "OpenCodeAcpSelectionFailure"; }
}

export type OpenCodeAcpExecutionMetadata = Readonly<{ execution: Readonly<{ version: 1; harnessId: "opencode-acp"; source: "genie"; executionProfile: AcpExecutionProfile; readiness: Readonly<{ relayId: string; relaySessionId: string; pairingGenerationRef: string; desktopSessionId: string; selectedProtocolVersion: number; capabilityRevision: number }> }> }>;
export type OpenCodeAcpRouteTask = Readonly<{ id: string; ownerId: string; requestorId: string; agentId: string; parentTaskId: string | null; targetRoomId: string | null; prompt: string; metadata: Readonly<Record<string, unknown>> }>;
export type OpenCodeAcpSession = Readonly<{ relayId: string; userId: string; relaySessionId: string; pairingGenerationRef: string; desktopSessionId: string; selectedProtocolVersion: number; capabilityRevision: number }>;

export interface OpenCodeAcpTaskExecutionDeps {
  readonly tasks: Readonly<{ getTask(taskId: string): Promise<OpenCodeAcpRouteTask | null> }>;
  readonly facts: Readonly<{ roomExists(roomId: string): Promise<boolean>; getAgentOwner(agentId: string): Promise<string | null>; isAgentMember(roomId: string, agentId: string): Promise<boolean> }>;
  readonly relay: Readonly<{
    listConnected(): Promise<readonly string[]>; getAcpSessionForRegistration(relayId: string, userId: string, registrationId: "opencode-acp"): OpenCodeAcpSession | null;
    requestAcpReadiness(input: Readonly<{ relayId: string; userId: string; requestId: string; registrationId: "opencode-acp"; timeoutMs?: number }>): Promise<"ready" | "missing" | "incompatible" | "authentication_required" | "unavailable">;
    requestAcpPrepare(input: Readonly<{ relayId: string; userId: string; requestId: string; binding: AcpExecutionScope["binding"]; registrationId: "opencode-acp"; timeoutMs?: number }>): Promise<AcpWorkspaceReceipt>;
    requestAcpStart(input: Readonly<{ relayId: string; userId: string; scope: AcpExecutionScope; prompt: string; registrationId: "opencode-acp"; executionProfile: "autonomous"; timeoutMs?: number }>): Promise<RelayAcpStartedResult>;
    subscribeAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope, registrationId: "opencode-acp"): Readonly<{ next(): Promise<RelayAcpExecutionEvent | null>; acknowledge(eventId: string, eventSequence: number): void; close(): void }> | null;
    containAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope, registrationId: "opencode-acp"): boolean;
  }>;
  readonly taskRuns: HermesAcpTaskRunLifecyclePort;
  /** Only safe delta/command projection is injected; completion is never projected. */
  readonly projector: Readonly<{ project(event: Extract<RelayAcpExecutionEvent, { type: "relay:acp-semantic" }>): Promise<ServerEvent | readonly ServerEvent[] | null> | ServerEvent | readonly ServerEvent[] | null }>;
  /** Private fixed-enum observability only; never receives task or upstream data. */
  readonly diagnostics?: Readonly<{
    onFailureStage(stage: OpenCodeAcpExecutionFailureStage): void;
    onStartFailureAfter?(stage: AcpStartFailureStage): void;
    onSetupFailureAfter?(checkpoint: OpenCodeAcpSetupCheckpoint, code: OpenCodeAcpSetupFailureCode): void;
    onSelectionFailure?(checkpoint: OpenCodeAcpSelectionCheckpoint, code: OpenCodeAcpSelectionFailureCode): void;
  }>;
  readonly mintOpaqueId?: () => string;
}

function opaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && encoder.encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES; }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function safeText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && encoder.encode(value).byteLength <= ACP_RELAY_MAX_TEXT_BYTES; }
function startFailureAfter(error: unknown): AcpStartFailureStage | null {
  if (!(error instanceof Error) || error.message !== "ACP_START_FAILED") return null;
  const stage = (error as Readonly<{ acpStartFailureStage?: unknown }>).acpStartFailureStage;
  return isAcpStartFailureStage(stage) ? stage : null;
}
function setupFailureCode(error: unknown): OpenCodeAcpSetupFailureCode {
  if (error instanceof OpenCodeAcpSetupFailure) return error.setupCode;
  if (!(error instanceof Error)) return "internal";
  switch (error.message) {
    case "ACP_RELAY_UNAVAILABLE": return "relay_unavailable";
    case "ACP_CONTEXT_STALE": return "context_stale";
    case "ACP_TIMEOUT": return "timeout";
    case "ACP_SOCKET_GENERATION_LOST": return "socket_generation_lost";
    case "ACP_QUEUE_FULL": return "queue_full";
    case "ACP_CORRELATION_REPLAY": return "correlation_replay";
    case "ACP_REQUEST_INVALID": return "request_invalid";
    default: return "internal";
  }
}
function setupFailureCheckpoint(checkpoint: OpenCodeAcpSetupCheckpoint, code: OpenCodeAcpSetupFailureCode): OpenCodeAcpSetupCheckpoint {
  if (checkpoint !== "start_wait") return checkpoint;
  return code === "relay_unavailable" || code === "context_stale" || code === "queue_full"
    || code === "correlation_replay" || code === "request_invalid" ? "start_request" : "start_wait";
}
function publicFailureReason(error: unknown, stage: OpenCodeAcpExecutionFailureStage, relaySessionLost: boolean): DelegatedTaskFailureReason {
  if (relaySessionLost || (error instanceof Error && (error.message === "ACP_RELAY_UNAVAILABLE" || error.message === "ACP_CONTEXT_STALE" || error.message === "ACP_SOCKET_GENERATION_LOST"))) return "desktop_disconnected";
  if (startFailureAfter(error)) return "session_start_failed";
  if (stage === "terminal") return "ended_without_result";
  if (stage === "semantic") return "invalid_response";
  if (stage !== "setup") return "internal_failure";
  const code = setupFailureCode(error);
  if (code === "not_ready") return "harness_not_ready";
  if (code === "timeout") return "harness_unresponsive";
  if (code === "response_invalid" || code === "subscription_unavailable" || code === "request_invalid" || code === "correlation_replay") return "invalid_response";
  return "internal_failure";
}

/** Strict full receipt parser. The generic three-field descriptor remains untouched. */
export function parseOpenCodeAcpExecutionMetadata(value: unknown): OpenCodeAcpExecutionMetadata | null {
  if (!exactKeys(value, ["execution"])) return null;
  const execution = value["execution"];
  if (!exactKeys(execution, ["version", "harnessId", "source", "executionProfile", "readiness"])) return null;
  const record = execution; const readiness = record["readiness"];
  if (!exactKeys(readiness, ["relayId", "relaySessionId", "pairingGenerationRef", "desktopSessionId", "selectedProtocolVersion", "capabilityRevision"])) return null;
  const r = readiness;
  const relayId = r["relayId"]; const relaySessionId = r["relaySessionId"]; const pairingGenerationRef = r["pairingGenerationRef"]; const desktopSessionId = r["desktopSessionId"]; const selectedProtocolVersion = r["selectedProtocolVersion"]; const capabilityRevision = r["capabilityRevision"];
  const executionProfile = record["executionProfile"];
  if (record["version"] !== 1 || record["harnessId"] !== OPENCODE || record["source"] !== "genie" || (executionProfile !== "interactive" && executionProfile !== "autonomous" && executionProfile !== "plan") || !opaque(relayId) || !opaque(relaySessionId) || !opaque(pairingGenerationRef) || !opaque(desktopSessionId) || typeof selectedProtocolVersion !== "number" || !Number.isSafeInteger(selectedProtocolVersion) || selectedProtocolVersion < OPENCODE_ACP_RELAY_PROTOCOL_VERSION || typeof capabilityRevision !== "number" || !Number.isSafeInteger(capabilityRevision) || capabilityRevision < 0) return null;
  return Object.freeze({ execution: Object.freeze({ version: 1, harnessId: OPENCODE, source: "genie", executionProfile, readiness: Object.freeze({ relayId, relaySessionId, pairingGenerationRef, desktopSessionId, selectedProtocolVersion, capabilityRevision }) }) });
}

function factsMatch(task: OpenCodeAcpRouteTask, facts: TaskExecutionRouteFacts): boolean { return task.id === facts.taskId && task.ownerId === facts.ownerId && task.requestorId === facts.requestorId && task.agentId === facts.agentId && task.parentTaskId === facts.parentTaskId && task.targetRoomId === facts.roomId; }
function sessionMatches(session: OpenCodeAcpSession | null, owner: string, r: OpenCodeAcpExecutionMetadata["execution"]["readiness"]): session is OpenCodeAcpSession { return !!session && session.userId === owner && session.relayId === r.relayId && session.relaySessionId === r.relaySessionId && session.desktopSessionId === r.desktopSessionId && session.pairingGenerationRef === r.pairingGenerationRef && session.selectedProtocolVersion === r.selectedProtocolVersion && session.capabilityRevision === r.capabilityRevision; }
function validOwnerSession(session: OpenCodeAcpSession | null, owner: string): session is OpenCodeAcpSession { return !!session && session.userId === owner && session.selectedProtocolVersion >= OPENCODE_ACP_RELAY_PROTOCOL_VERSION && Number.isSafeInteger(session.selectedProtocolVersion) && Number.isSafeInteger(session.capabilityRevision) && session.capabilityRevision >= 0 && opaque(session.relayId) && opaque(session.relaySessionId) && opaque(session.desktopSessionId) && opaque(session.pairingGenerationRef); }
function sameScope(left: AcpExecutionScope, right: AcpExecutionScope): boolean { return left.socket.relayId === right.socket.relayId && left.socket.relaySessionId === right.socket.relaySessionId && left.socket.desktopSessionId === right.socket.desktopSessionId && left.socket.pairingGenerationRef === right.socket.pairingGenerationRef && left.socket.selectedProtocolVersion === right.socket.selectedProtocolVersion && left.socket.capabilityRevision === right.socket.capabilityRevision && left.binding.bindingId === right.binding.bindingId && left.binding.bindingGeneration === right.binding.bindingGeneration && left.binding.ownerId === right.binding.ownerId && left.binding.taskId === right.binding.taskId && left.binding.taskRunId === right.binding.taskRunId && left.binding.jobId === right.binding.jobId && left.binding.profileId === right.binding.profileId && left.binding.profileGeneration === right.binding.profileGeneration && left.binding.postureId === right.binding.postureId && left.binding.postureGeneration === right.binding.postureGeneration && left.workspace.workspaceReceiptId === right.workspace.workspaceReceiptId && left.workspace.workspaceRevision === right.workspace.workspaceRevision && left.workspace.workspaceFingerprint === right.workspace.workspaceFingerprint && left.workspace.workspaceExpiresAt === right.workspace.workspaceExpiresAt; }
function sameProcess(left: AcpProcessScope, right: AcpProcessScope): boolean { return left.connectionId === right.connectionId && left.processGeneration === right.processGeneration && left.acpSessionId === right.acpSessionId && left.turnGeneration === right.turnGeneration && left.turnRef === right.turnRef; }
function sameTask(left: OpenCodeAcpRouteTask, right: OpenCodeAcpRouteTask): boolean { return left.id === right.id && left.ownerId === right.ownerId && left.requestorId === right.requestorId && left.agentId === right.agentId && left.parentTaskId === right.parentTaskId && left.targetRoomId === right.targetRoomId && left.prompt === right.prompt && parseOpenCodeAcpExecutionMetadata(left.metadata) !== null && parseOpenCodeAcpExecutionMetadata(right.metadata) !== null && JSON.stringify(left.metadata) === JSON.stringify(right.metadata); }

export class OpenCodeAcpTaskExecutionRouteSelector {
  constructor(private readonly deps: OpenCodeAcpTaskExecutionDeps) {}
  readonly select: TaskExecutionRouteSelector = async (facts) => {
    let activeCheckpoint: OpenCodeAcpSelectionCheckpoint = "task";
    try {
      const task = await this.deps.tasks.getTask(facts.taskId);
      if (!task) { this.emitSelectionFailure("task", "missing"); return undefined; }
      activeCheckpoint = "metadata";
      const metadata = parseOpenCodeAcpExecutionMetadata(task.metadata);
      if (!metadata) { this.emitSelectionFailure("metadata", "invalid"); return undefined; }
      activeCheckpoint = "profile";
      if (metadata.execution.executionProfile !== "autonomous") throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", "profile", "unsupported");
      activeCheckpoint = "facts";
      const session = await this.assertAuthority(task, facts, metadata);
      const snapshot = Object.freeze({ facts: Object.freeze({ ...facts }), task: Object.freeze({ ...task }), metadata, session: Object.freeze({ ...session }) });
      return Object.freeze({ coalescing: "separate", contention: "serialize", modelAttribution: "external", executor: this.executor(snapshot) } satisfies ForegroundExecutionRoute);
    } catch (error) {
      if (error instanceof OpenCodeAcpSelectionFailure) {
        this.emitSelectionFailure(error.checkpoint, error.selectionCode);
        throw error;
      }
      if (error instanceof OpenCodeAcpTaskExecutionFailure) throw error;
      this.emitSelectionFailure(activeCheckpoint, "internal");
      throw new OpenCodeAcpTaskExecutionFailure("ACP_HARNESS_UNAVAILABLE");
    }
  };

  private emitSelectionFailure(checkpoint: OpenCodeAcpSelectionCheckpoint, code: OpenCodeAcpSelectionFailureCode): void {
    try { this.deps.diagnostics?.onSelectionFailure?.(checkpoint, code); } catch { /* diagnostics are best effort */ }
  }

  private async selectionDependency<T>(checkpoint: OpenCodeAcpSelectionCheckpoint, operation: () => Promise<T>): Promise<T> {
    try { return await operation(); } catch { throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", checkpoint, "internal"); }
  }

  async assertAuthority(task: OpenCodeAcpRouteTask, facts: TaskExecutionRouteFacts, metadata: OpenCodeAcpExecutionMetadata): Promise<OpenCodeAcpSession> {
    if (task.id !== facts.taskId) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "task", "mismatch");
    if (!factsMatch(task, facts)) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "facts", "mismatch");
    if (task.requestorId !== task.ownerId) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "delegation", "unsupported");
    if (!safeText(task.prompt)) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "prompt", "invalid");
    const room = await this.selectionDependency("room", () => this.deps.facts.roomExists(facts.roomId));
    if (!room) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "room", "missing");
    const owner = await this.selectionDependency("agent_owner", () => this.deps.facts.getAgentOwner(task.agentId));
    if (owner !== task.ownerId) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "agent_owner", "mismatch");
    const member = await this.selectionDependency("membership", () => this.deps.facts.isAgentMember(facts.roomId, task.agentId));
    if (!member) throw new OpenCodeAcpSelectionFailure(ACP_EXECUTION_FAILED, "membership", "missing");
    const connected = await this.selectionDependency("relay_snapshot", () => this.deps.relay.listConnected());
    let candidates: readonly OpenCodeAcpSession[];
    try { candidates = connected.map((id) => this.deps.relay.getAcpSessionForRegistration(id, task.ownerId, OPENCODE)).filter((s): s is OpenCodeAcpSession => validOwnerSession(s, task.ownerId)); }
    catch { throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", "relay_snapshot", "internal"); }
    const candidate = candidates[0];
    if (candidates.length === 0 || !candidate) throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", "relay_snapshot", "missing");
    if (candidates.length !== 1) throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", "relay_snapshot", "ambiguous");
    if (!sessionMatches(candidate, task.ownerId, metadata.execution.readiness)) throw new OpenCodeAcpSelectionFailure("ACP_HARNESS_UNAVAILABLE", "relay_snapshot", "stale");
    return candidate;
  }

  private executor(snapshot: Readonly<{ facts: TaskExecutionRouteFacts; task: OpenCodeAcpRouteTask; metadata: OpenCodeAcpExecutionMetadata; session: OpenCodeAcpSession }>): ForegroundExecutionRoute["executor"] {
    const deps = this.deps; const mint = () => { const value = (deps.mintOpaqueId ?? randomUUID)(); if (!opaque(value)) throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); return value; };
    return async function* (_ignored, jobId, _lane, signal): AsyncGenerator<ServerEvent> {
      let linked = false; let terminalized = false; let completedTerminal = false; let scope: AcpExecutionScope | null = null; let process: AcpProcessScope | null = null; let subscription: ReturnType<typeof deps.relay.subscribeAcpExecution> | null = null; let contained = false; let containmentAccepted = false; let closed = false; let failureAttempted = false; let reportBackFailed = false; let currentRejected = false; let relaySessionLost = false; let resolveAbort: (() => void) | undefined; let removeAbort: (() => void) | undefined; let failureStage: OpenCodeAcpExecutionFailureStage = "setup"; let setupCheckpoint: OpenCodeAcpSetupCheckpoint | null = null; let failureReason: DelegatedTaskFailureReason = "internal_failure"; let outputObserved = false; const commandActivityIds = new Set<string>();
      const lifecycleFacts = { taskId: snapshot.facts.taskId, taskRunId: snapshot.facts.taskRunId, parentTaskId: snapshot.facts.parentTaskId, source: "room" as const, authority: { ownerId: snapshot.facts.ownerId, requestorId: snapshot.facts.requestorId, agentId: snapshot.facts.agentId, roomId: snapshot.facts.roomId } };
      const contain = () => { if (!contained && scope && process) { contained = true; try { containmentAccepted = deps.relay.containAcpExecution(scope, process, OPENCODE); } catch { /* teardown is best effort */ } } };
      const close = () => { if (!closed && subscription) { closed = true; try { subscription.close(); } catch { /* teardown is best effort */ } } };
      const assertCurrent = async () => { try { await deps.taskRuns.assertCurrent({ ...lifecycleFacts, jobId }); } catch (error) { currentRejected = true; throw error; } };
      const reload = async () => { try { const task = await deps.tasks.getTask(snapshot.facts.taskId); const metadata = task && parseOpenCodeAcpExecutionMetadata(task.metadata); if (!task || !metadata || metadata.execution.executionProfile !== "autonomous" || !sameTask(task, snapshot.task) || !factsMatch(task, snapshot.facts) || task.requestorId !== task.ownerId) throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); const session = deps.relay.getAcpSessionForRegistration(snapshot.session.relayId, snapshot.facts.ownerId, OPENCODE); if (!sessionMatches(session, snapshot.facts.ownerId, metadata.execution.readiness)) { relaySessionLost = true; throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); } await (new OpenCodeAcpTaskExecutionRouteSelector(deps)).assertAuthority(task, snapshot.facts, metadata); return { task, metadata }; } catch (error) { currentRejected = true; throw error; } };
      /** Every host await returns through this fence before another side effect. */
      const fence = async (): Promise<boolean> => { if (signal.aborted) return false; await reload(); if (signal.aborted) return false; await assertCurrent(); return !signal.aborted; };
      // A relay/socket loss is an exact broker-owned terminal fact, not a
      // reason to leave its already-linked durable TaskRun running. The normal
      // fence deliberately requires the live relay before another host action;
      // for this one terminal write the lifecycle port is the authority fence
      // instead, so Stop still wins and stale Task/Run/Job tuples are rejected.
      const fail = async (afterRelayLoss = false) => { if (linked && !terminalized && !signal.aborted && !failureAttempted) { failureAttempted = true; if (!afterRelayLoss && !(await fence())) return; const phase: DelegatedTaskFailureReceipt["phase"] = process ? "running" : setupCheckpoint === "start_request" || setupCheckpoint === "start_wait" ? "starting" : "setup"; try { await deps.taskRuns.fail({ ...lifecycleFacts, jobId, code: ACP_EXECUTION_FAILED, failureReceipt: { provider: "OpenCode", reason: failureReason, phase, processStarted: process !== null, commandActivityCount: commandActivityIds.size, outputObserved, containmentRequested: containmentAccepted } }); } catch { reportBackFailed = true; } if (!signal.aborted) terminalized = true; } };
      try {
        await deps.taskRuns.linkJob({ ...lifecycleFacts, jobId }); linked = true; setupCheckpoint = "linked";
        if (!(await fence())) return;
        setupCheckpoint = "readiness_requested"; const ready = await deps.relay.requestAcpReadiness({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, requestId: mint(), registrationId: OPENCODE, timeoutMs: 5_000 }); if (signal.aborted) return; if (ready !== "ready") throw new OpenCodeAcpSetupFailure("not_ready"); setupCheckpoint = "readiness_ready";
        if (!(await fence())) return;
        const binding = Object.freeze({ bindingId: mint(), bindingGeneration: mint(), ownerId: snapshot.facts.ownerId, taskId: snapshot.facts.taskId, taskRunId: snapshot.facts.taskRunId, jobId, profileId: mint(), profileGeneration: mint(), postureId: mint(), postureGeneration: mint() });
        if (signal.aborted) return; setupCheckpoint = "prepare_requested"; const workspace = await deps.relay.requestAcpPrepare({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, requestId: mint(), binding, registrationId: OPENCODE, timeoutMs: 5_000 }); if (signal.aborted) return; setupCheckpoint = "prepared";
        if (!(await fence())) return;
        scope = Object.freeze({ socket: Object.freeze({ relayId: snapshot.session.relayId, relaySessionId: snapshot.session.relaySessionId, desktopSessionId: snapshot.session.desktopSessionId, pairingGenerationRef: snapshot.session.pairingGenerationRef, selectedProtocolVersion: snapshot.session.selectedProtocolVersion, capabilityRevision: snapshot.session.capabilityRevision } satisfies AcpSocketScope), binding, workspace });
        if (!(await fence())) return; setupCheckpoint = "start_request"; const pendingStart = deps.relay.requestAcpStart({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, scope, prompt: snapshot.task.prompt, registrationId: OPENCODE, executionProfile: "autonomous", timeoutMs: OPENCODE_ACP_EXECUTION_START_TIMEOUT_MS }); setupCheckpoint = "start_wait"; const started = await pendingStart;
        if (started.registrationId !== OPENCODE || !sameScope(started.scope, scope) || started.capabilities.requests !== "unsupported") throw new OpenCodeAcpSetupFailure("response_invalid");
        process = started.process; setupCheckpoint = "started";
        const onAbort = () => { contain(); close(); resolveAbort?.(); };
        signal.addEventListener("abort", onAbort, { once: true }); removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) { onAbort(); return; }
        if (!(await fence())) return;
        subscription = deps.relay.subscribeAcpExecution(scope, process, OPENCODE); if (!subscription) throw new OpenCodeAcpSetupFailure("subscription_unavailable"); setupCheckpoint = "subscribed";
        if (signal.aborted) { onAbort(); return; }
        let candidate: string | null = null;
        for (;;) {
          if (signal.aborted) { contain(); close(); return; }
          const aborted = Symbol("acp-aborted");
          const abort = new Promise<typeof aborted>((resolve) => { resolveAbort = () => resolve(aborted); });
          const pending = subscription.next(); void pending.catch(() => undefined);
          if (signal.aborted) { resolveAbort?.(); }
          const event = await Promise.race([pending, abort]); resolveAbort = undefined;
          if (event === aborted || signal.aborted) { contain(); close(); return; } if (!event) throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
          if (signal.aborted) { contain(); close(); return; }
          if (!(await fence())) return;
          if (event.registrationId !== OPENCODE || !sameScope(event.scope, scope) || !sameProcess(event.process, process)) throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
          if (event.type === "relay:acp-semantic") {
            failureStage = "semantic";
            if (event.capabilities.requests !== "unsupported") throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
            if (event.payload.kind === "assistant_completed") { if (!safeText(event.payload.text) || candidate !== null) throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic"); candidate = event.payload.text; }
            else { if (event.payload.kind === "output_delta" && event.payload.text.length > 0) outputObserved = true; if (event.payload.kind === "command_summary") commandActivityIds.add(event.payload.vendorItemId ?? event.eventId); const projected = await deps.projector.project(event); if (signal.aborted || !(await fence())) return; if (Array.isArray(projected)) { for (const output of projected as readonly ServerEvent[]) { if (!(await fence())) return; yield output; if (!(await fence())) return; } } else if (projected) { if (!(await fence())) return; yield projected as ServerEvent; if (!(await fence())) return; } }
            if (!(await fence())) return;
            subscription.acknowledge(event.eventId, event.eventSequence); continue;
          }
          failureStage = "terminal";
          if (event.status !== "completed" || candidate === null) { failureReason = "ended_without_result"; await fail(); if (!signal.aborted && !reportBackFailed) subscription.acknowledge(event.eventId, event.eventSequence); throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "terminal"); }
          if (!(await fence())) return; failureStage = "report_back"; try { await deps.taskRuns.complete({ ...lifecycleFacts, jobId, resultText: candidate }); } catch { reportBackFailed = true; throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "report_back"); } if (signal.aborted) return; terminalized = true; completedTerminal = true; subscription.acknowledge(event.eventId, event.eventSequence); return;
        }
      } catch (error) {
        const failedStartStage = startFailureAfter(error);
        const stage = error instanceof OpenCodeAcpTaskExecutionFailure ? error.stage : failureStage;
        const relayFailure = relaySessionLost || (error instanceof Error && (error.message === "ACP_RELAY_UNAVAILABLE" || error.message === "ACP_CONTEXT_STALE" || error.message === "ACP_SOCKET_GENERATION_LOST"));
        failureReason = publicFailureReason(error, stage, relaySessionLost);
        contain();
        if (!signal.aborted && !reportBackFailed && (!currentRejected || relayFailure)) { try { await fail(relayFailure); } catch { /* stable public failure wins */ } }
        try {
          if (failedStartStage) deps.diagnostics?.onStartFailureAfter?.(failedStartStage);
          else if (stage === "setup" && setupCheckpoint) { const code = setupFailureCode(error); deps.diagnostics?.onSetupFailureAfter?.(setupFailureCheckpoint(setupCheckpoint, code), code); }
          else deps.diagnostics?.onFailureStage(stage);
        } catch { /* diagnostics cannot alter the stable terminal */ }
        throw new OpenCodeAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, stage);
      }
      finally { resolveAbort = undefined; removeAbort?.(); if (!completedTerminal) { close(); if (scope && process) contain(); } }
    };
  }
}

export function createOpenCodeAcpTaskHarnessExecutionRouteRegistration(createSelector: () => TaskExecutionRouteSelector): TaskHarnessExecutionRouteRegistration {
  return { harnessId: OPENCODE, publicFailureCodes: ["ACP_HARNESS_UNAVAILABLE"], createSelector: () => ({ select: async ({ facts }) => { try { return await createSelector()(facts); } catch (error) { if (error instanceof OpenCodeAcpTaskExecutionFailure) throw new TaskHarnessExecutionRouteProviderFailure(error.code); throw error; } } }) };
}

export function createOpenCodeAcpTaskExecutionRouteSelector(deps: OpenCodeAcpTaskExecutionDeps): TaskExecutionRouteSelector { return new OpenCodeAcpTaskExecutionRouteSelector(deps).select; }
