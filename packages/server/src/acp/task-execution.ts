import { randomUUID } from "node:crypto";
import { HERMES_ACP_READINESS_TIMEOUT_MS, type ForegroundExecutionRoute, type TaskExecutionRouteFacts, type TaskExecutionRouteSelector } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { ACP_RELAY_MAX_OPAQUE_ID_BYTES, ACP_RELAY_MAX_TEXT_BYTES, ACP_RELAY_PROTOCOL_VERSION, type AcpExecutionScope, type AcpProcessScope, type AcpSocketScope, type AcpWorkspaceReceipt, type RelayAcpSemanticEvent, type RelayAcpStartedResult, type RelayAcpTerminalEvent } from "@nautilo/relay";
import type { TaskHarnessExecutionRouteRegistration } from "../harness/task-execution-route";
import { TaskHarnessExecutionRouteProviderFailure } from "../harness/task-execution-route";
import { ACP_EXECUTION_FAILED } from "./task-run-lifecycle";
import type { HermesAcpTaskRunLifecyclePort } from "./task-run-lifecycle";

const HERMES = "hermes-acp" as const;
const encoder = new TextEncoder();
type RelayAcpExecutionEvent = RelayAcpSemanticEvent | RelayAcpTerminalEvent;

/** Private, closed diagnostics only. Never persisted or delivered to a Room. */
export const HERMES_ACP_EXECUTION_FAILURE_STAGES = ["setup", "semantic", "terminal", "report_back", "internal"] as const;
export type HermesAcpExecutionFailureStage = typeof HERMES_ACP_EXECUTION_FAILURE_STAGES[number];

export class HermesAcpTaskExecutionFailure extends Error {
  constructor(
    readonly code: "ACP_HARNESS_UNAVAILABLE" | typeof ACP_EXECUTION_FAILED,
    readonly stage: HermesAcpExecutionFailureStage = "setup",
  ) { super(code); this.name = "HermesAcpTaskExecutionFailure"; }
}

export type HermesAcpExecutionMetadata = Readonly<{ execution: Readonly<{ version: 1; harnessId: "hermes-acp"; source: "genie"; readiness: Readonly<{ relayId: string; relaySessionId: string; pairingGenerationRef: string; desktopSessionId: string; selectedProtocolVersion: number; capabilityRevision: number }> }> }>;
export type HermesAcpRouteTask = Readonly<{ id: string; ownerId: string; requestorId: string; agentId: string; parentTaskId: string | null; targetRoomId: string | null; prompt: string; metadata: Readonly<Record<string, unknown>> }>;
export type HermesAcpSession = Readonly<{ relayId: string; userId: string; relaySessionId: string; pairingGenerationRef: string; desktopSessionId: string; selectedProtocolVersion: number; capabilityRevision: number }>;

export interface HermesAcpTaskExecutionDeps {
  readonly tasks: Readonly<{ getTask(taskId: string): Promise<HermesAcpRouteTask | null> }>;
  readonly facts: Readonly<{ roomExists(roomId: string): Promise<boolean>; getAgentOwner(agentId: string): Promise<string | null>; isAgentMember(roomId: string, agentId: string): Promise<boolean> }>;
  readonly relay: Readonly<{
    listConnected(): Promise<readonly string[]>; getAcpSession(relayId: string, userId?: string): HermesAcpSession | null;
    requestAcpReadiness(input: Readonly<{ relayId: string; userId: string; requestId: string; registrationId: "hermes-acp"; timeoutMs?: number }>): Promise<"ready" | "missing" | "incompatible" | "authentication_required" | "unavailable">;
    requestAcpPrepare(input: Readonly<{ relayId: string; userId: string; requestId: string; binding: AcpExecutionScope["binding"]; timeoutMs?: number }>): Promise<AcpWorkspaceReceipt>;
    requestAcpStart(input: Readonly<{ relayId: string; userId: string; scope: AcpExecutionScope; prompt: string; timeoutMs?: number }>): Promise<RelayAcpStartedResult>;
    subscribeAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope): Readonly<{ next(): Promise<RelayAcpExecutionEvent | null>; acknowledge(eventId: string, eventSequence: number): void; close(): void }> | null;
    containAcpExecution(scope: AcpExecutionScope, process: AcpProcessScope): boolean;
  }>;
  readonly taskRuns: HermesAcpTaskRunLifecyclePort;
  /** Only safe delta/command projection is injected; completion is never projected. */
  readonly projector: Readonly<{ project(event: Extract<RelayAcpExecutionEvent, { type: "relay:acp-semantic" }>): Promise<ServerEvent | readonly ServerEvent[] | null> | ServerEvent | readonly ServerEvent[] | null }>;
  /** Private fixed-enum observability only; never receives task or upstream data. */
  readonly diagnostics?: Readonly<{ onFailureStage(stage: HermesAcpExecutionFailureStage): void }>;
  readonly mintOpaqueId?: () => string;
}

function opaque(value: unknown): value is string { return typeof value === "string" && value.length > 0 && !value.includes("\0") && encoder.encode(value).byteLength <= ACP_RELAY_MAX_OPAQUE_ID_BYTES; }
function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function safeText(value: unknown): value is string { return typeof value === "string" && value.trim().length > 0 && !value.includes("\0") && encoder.encode(value).byteLength <= ACP_RELAY_MAX_TEXT_BYTES; }

/** Strict full receipt parser. The generic three-field descriptor remains untouched. */
export function parseHermesAcpExecutionMetadata(value: unknown): HermesAcpExecutionMetadata | null {
  if (!exactKeys(value, ["execution"])) return null;
  const execution = value["execution"];
  if (!exactKeys(execution, ["version", "harnessId", "source", "readiness"])) return null;
  const record = execution; const readiness = record["readiness"];
  if (!exactKeys(readiness, ["relayId", "relaySessionId", "pairingGenerationRef", "desktopSessionId", "selectedProtocolVersion", "capabilityRevision"])) return null;
  const r = readiness;
  const relayId = r["relayId"]; const relaySessionId = r["relaySessionId"]; const pairingGenerationRef = r["pairingGenerationRef"]; const desktopSessionId = r["desktopSessionId"]; const selectedProtocolVersion = r["selectedProtocolVersion"]; const capabilityRevision = r["capabilityRevision"];
  if (record["version"] !== 1 || record["harnessId"] !== HERMES || record["source"] !== "genie" || !opaque(relayId) || !opaque(relaySessionId) || !opaque(pairingGenerationRef) || !opaque(desktopSessionId) || typeof selectedProtocolVersion !== "number" || !Number.isSafeInteger(selectedProtocolVersion) || selectedProtocolVersion < ACP_RELAY_PROTOCOL_VERSION || typeof capabilityRevision !== "number" || !Number.isSafeInteger(capabilityRevision) || capabilityRevision < 0) return null;
  return Object.freeze({ execution: Object.freeze({ version: 1, harnessId: HERMES, source: "genie", readiness: Object.freeze({ relayId, relaySessionId, pairingGenerationRef, desktopSessionId, selectedProtocolVersion, capabilityRevision }) }) });
}

function factsMatch(task: HermesAcpRouteTask, facts: TaskExecutionRouteFacts): boolean { return task.id === facts.taskId && task.ownerId === facts.ownerId && task.requestorId === facts.requestorId && task.agentId === facts.agentId && task.parentTaskId === facts.parentTaskId && task.targetRoomId === facts.roomId; }
function sessionMatches(session: HermesAcpSession | null, owner: string, r: HermesAcpExecutionMetadata["execution"]["readiness"]): session is HermesAcpSession { return !!session && session.userId === owner && session.relayId === r.relayId && session.relaySessionId === r.relaySessionId && session.desktopSessionId === r.desktopSessionId && session.pairingGenerationRef === r.pairingGenerationRef && session.selectedProtocolVersion === r.selectedProtocolVersion && session.capabilityRevision === r.capabilityRevision; }
function validOwnerSession(session: HermesAcpSession | null, owner: string): session is HermesAcpSession { return !!session && session.userId === owner && session.selectedProtocolVersion >= ACP_RELAY_PROTOCOL_VERSION && Number.isSafeInteger(session.selectedProtocolVersion) && Number.isSafeInteger(session.capabilityRevision) && session.capabilityRevision >= 0 && opaque(session.relayId) && opaque(session.relaySessionId) && opaque(session.desktopSessionId) && opaque(session.pairingGenerationRef); }
function sameScope(left: AcpExecutionScope, right: AcpExecutionScope): boolean { return left.socket.relayId === right.socket.relayId && left.socket.relaySessionId === right.socket.relaySessionId && left.socket.desktopSessionId === right.socket.desktopSessionId && left.socket.pairingGenerationRef === right.socket.pairingGenerationRef && left.socket.selectedProtocolVersion === right.socket.selectedProtocolVersion && left.socket.capabilityRevision === right.socket.capabilityRevision && left.binding.bindingId === right.binding.bindingId && left.binding.bindingGeneration === right.binding.bindingGeneration && left.binding.ownerId === right.binding.ownerId && left.binding.taskId === right.binding.taskId && left.binding.taskRunId === right.binding.taskRunId && left.binding.jobId === right.binding.jobId && left.binding.profileId === right.binding.profileId && left.binding.profileGeneration === right.binding.profileGeneration && left.binding.postureId === right.binding.postureId && left.binding.postureGeneration === right.binding.postureGeneration && left.workspace.workspaceReceiptId === right.workspace.workspaceReceiptId && left.workspace.workspaceRevision === right.workspace.workspaceRevision && left.workspace.workspaceFingerprint === right.workspace.workspaceFingerprint && left.workspace.workspaceExpiresAt === right.workspace.workspaceExpiresAt; }
function sameProcess(left: AcpProcessScope, right: AcpProcessScope): boolean { return left.connectionId === right.connectionId && left.processGeneration === right.processGeneration && left.acpSessionId === right.acpSessionId && left.turnGeneration === right.turnGeneration && left.turnRef === right.turnRef; }
function sameTask(left: HermesAcpRouteTask, right: HermesAcpRouteTask): boolean { return left.id === right.id && left.ownerId === right.ownerId && left.requestorId === right.requestorId && left.agentId === right.agentId && left.parentTaskId === right.parentTaskId && left.targetRoomId === right.targetRoomId && left.prompt === right.prompt && parseHermesAcpExecutionMetadata(left.metadata) !== null && parseHermesAcpExecutionMetadata(right.metadata) !== null && JSON.stringify(left.metadata) === JSON.stringify(right.metadata); }

export class HermesAcpTaskExecutionRouteSelector {
  constructor(private readonly deps: HermesAcpTaskExecutionDeps) {}
  readonly select: TaskExecutionRouteSelector = async (facts) => {
    try {
      const task = await this.deps.tasks.getTask(facts.taskId); const metadata = task && parseHermesAcpExecutionMetadata(task.metadata);
      if (!task || !metadata) return undefined;
      const session = await this.assertAuthority(task, facts, metadata);
      const snapshot = Object.freeze({ facts: Object.freeze({ ...facts }), task: Object.freeze({ ...task }), metadata, session: Object.freeze({ ...session }) });
      return Object.freeze({ coalescing: "separate", contention: "serialize", modelAttribution: "external", executor: this.executor(snapshot) } satisfies ForegroundExecutionRoute);
    } catch (error) { if (error instanceof HermesAcpTaskExecutionFailure) throw error; throw new HermesAcpTaskExecutionFailure("ACP_HARNESS_UNAVAILABLE"); }
  };

  async assertAuthority(task: HermesAcpRouteTask, facts: TaskExecutionRouteFacts, metadata: HermesAcpExecutionMetadata): Promise<HermesAcpSession> {
    if (!factsMatch(task, facts) || task.requestorId !== task.ownerId || !safeText(task.prompt)) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED);
    const [room, owner, member, connected] = await Promise.all([this.deps.facts.roomExists(facts.roomId), this.deps.facts.getAgentOwner(task.agentId), this.deps.facts.isAgentMember(facts.roomId, task.agentId), this.deps.relay.listConnected()]);
    if (!room || owner !== task.ownerId || !member) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED);
    const candidates = connected.map((id) => this.deps.relay.getAcpSession(id, task.ownerId)).filter((s): s is HermesAcpSession => validOwnerSession(s, task.ownerId));
    const candidate = candidates[0];
    if (candidates.length !== 1 || !candidate || !sessionMatches(candidate, task.ownerId, metadata.execution.readiness)) throw new HermesAcpTaskExecutionFailure("ACP_HARNESS_UNAVAILABLE");
    return candidate;
  }

  private executor(snapshot: Readonly<{ facts: TaskExecutionRouteFacts; task: HermesAcpRouteTask; metadata: HermesAcpExecutionMetadata; session: HermesAcpSession }>): ForegroundExecutionRoute["executor"] {
    const deps = this.deps; const mint = () => { const value = (deps.mintOpaqueId ?? randomUUID)(); if (!opaque(value)) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); return value; };
    return async function* (_ignored, jobId, _lane, signal): AsyncGenerator<ServerEvent> {
      let linked = false; let terminalized = false; let completedTerminal = false; let scope: AcpExecutionScope | null = null; let process: AcpProcessScope | null = null; let subscription: ReturnType<typeof deps.relay.subscribeAcpExecution> | null = null; let contained = false; let closed = false; let failureAttempted = false; let reportBackFailed = false; let currentRejected = false; let relaySessionLost = false; let resolveAbort: (() => void) | undefined; let removeAbort: (() => void) | undefined; let failureStage: HermesAcpExecutionFailureStage = "setup";
      const lifecycleFacts = { taskId: snapshot.facts.taskId, taskRunId: snapshot.facts.taskRunId, parentTaskId: snapshot.facts.parentTaskId, source: "room" as const, authority: { ownerId: snapshot.facts.ownerId, requestorId: snapshot.facts.requestorId, agentId: snapshot.facts.agentId, roomId: snapshot.facts.roomId } };
      const contain = () => { if (!contained && scope && process) { contained = true; try { deps.relay.containAcpExecution(scope, process); } catch { /* teardown is best effort */ } } };
      const close = () => { if (!closed && subscription) { closed = true; try { subscription.close(); } catch { /* teardown is best effort */ } } };
      const assertCurrent = async () => { try { await deps.taskRuns.assertCurrent({ ...lifecycleFacts, jobId }); } catch (error) { currentRejected = true; throw error; } };
      const reload = async () => { try { const task = await deps.tasks.getTask(snapshot.facts.taskId); const metadata = task && parseHermesAcpExecutionMetadata(task.metadata); if (!task || !metadata || !sameTask(task, snapshot.task) || !factsMatch(task, snapshot.facts) || task.requestorId !== task.ownerId) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); const session = deps.relay.getAcpSession(snapshot.session.relayId, snapshot.facts.ownerId); if (!sessionMatches(session, snapshot.facts.ownerId, metadata.execution.readiness)) { relaySessionLost = true; throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED); } await (new HermesAcpTaskExecutionRouteSelector(deps)).assertAuthority(task, snapshot.facts, metadata); return { task, metadata }; } catch (error) { currentRejected = true; throw error; } };
      /** Every host await returns through this fence before another side effect. */
      const fence = async (): Promise<boolean> => { if (signal.aborted) return false; await reload(); if (signal.aborted) return false; await assertCurrent(); return !signal.aborted; };
      // A relay/socket loss is an exact broker-owned terminal fact, not a
      // reason to leave its already-linked durable TaskRun running. The normal
      // fence deliberately requires the live relay before another host action;
      // for this one terminal write the lifecycle port is the authority fence
      // instead, so Stop still wins and stale Task/Run/Job tuples are rejected.
      const fail = async (afterRelayLoss = false) => { if (linked && !terminalized && !signal.aborted && !failureAttempted) { failureAttempted = true; if (!afterRelayLoss && !(await fence())) return; try { await deps.taskRuns.fail({ ...lifecycleFacts, jobId, code: ACP_EXECUTION_FAILED }); } catch { reportBackFailed = true; } if (!signal.aborted) terminalized = true; } };
      try {
        await deps.taskRuns.linkJob({ ...lifecycleFacts, jobId }); linked = true;
        if (!(await fence())) return;
        const ready = await deps.relay.requestAcpReadiness({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, requestId: mint(), registrationId: HERMES, timeoutMs: HERMES_ACP_READINESS_TIMEOUT_MS }); if (signal.aborted) return; if (ready !== "ready") throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "setup");
        if (!(await fence())) return;
        const binding = Object.freeze({ bindingId: mint(), bindingGeneration: mint(), ownerId: snapshot.facts.ownerId, taskId: snapshot.facts.taskId, taskRunId: snapshot.facts.taskRunId, jobId, profileId: mint(), profileGeneration: mint(), postureId: mint(), postureGeneration: mint() });
        if (signal.aborted) return; const workspace = await deps.relay.requestAcpPrepare({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, requestId: mint(), binding, timeoutMs: 5_000 }); if (signal.aborted) return;
        if (!(await fence())) return;
        scope = Object.freeze({ socket: Object.freeze({ relayId: snapshot.session.relayId, relaySessionId: snapshot.session.relaySessionId, desktopSessionId: snapshot.session.desktopSessionId, pairingGenerationRef: snapshot.session.pairingGenerationRef, selectedProtocolVersion: snapshot.session.selectedProtocolVersion, capabilityRevision: snapshot.session.capabilityRevision } satisfies AcpSocketScope), binding, workspace });
        if (!(await fence())) return; const started = await deps.relay.requestAcpStart({ relayId: snapshot.session.relayId, userId: snapshot.facts.ownerId, scope, prompt: snapshot.task.prompt, timeoutMs: 15_000 });
        if (!sameScope(started.scope, scope) || started.capabilities.requests !== "unsupported") throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "setup");
        process = started.process;
        const onAbort = () => { contain(); close(); resolveAbort?.(); };
        signal.addEventListener("abort", onAbort, { once: true }); removeAbort = () => signal.removeEventListener("abort", onAbort);
        if (signal.aborted) { onAbort(); return; }
        if (!(await fence())) return;
        subscription = deps.relay.subscribeAcpExecution(scope, process); if (!subscription) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "setup");
        if (signal.aborted) { onAbort(); return; }
        let candidate: string | null = null;
        for (;;) {
          if (signal.aborted) { contain(); close(); return; }
          const aborted = Symbol("acp-aborted");
          const abort = new Promise<typeof aborted>((resolve) => { resolveAbort = () => resolve(aborted); });
          const pending = subscription.next(); void pending.catch(() => undefined);
          if (signal.aborted) { resolveAbort?.(); }
          const event = await Promise.race([pending, abort]); resolveAbort = undefined;
          if (event === aborted || signal.aborted) { contain(); close(); return; } if (!event) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
          if (signal.aborted) { contain(); close(); return; }
          if (!(await fence())) return;
          if (!sameScope(event.scope, scope) || !sameProcess(event.process, process)) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
          if (event.type === "relay:acp-semantic") {
            failureStage = "semantic";
            if (event.capabilities.requests !== "unsupported") throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic");
            if (event.payload.kind === "assistant_completed") { if (!safeText(event.payload.text) || candidate !== null) throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "semantic"); candidate = event.payload.text; }
            else { const projected = await deps.projector.project(event); if (signal.aborted || !(await fence())) return; if (Array.isArray(projected)) { for (const output of projected as readonly ServerEvent[]) { if (!(await fence())) return; yield output; if (!(await fence())) return; } } else if (projected) { if (!(await fence())) return; yield projected as ServerEvent; if (!(await fence())) return; } }
            if (!(await fence())) return;
            subscription.acknowledge(event.eventId, event.eventSequence); continue;
          }
          failureStage = "terminal";
          if (event.status !== "completed" || candidate === null) { await fail(); if (!signal.aborted && !reportBackFailed) subscription.acknowledge(event.eventId, event.eventSequence); throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "terminal"); }
          if (!(await fence())) return; failureStage = "report_back"; try { await deps.taskRuns.complete({ ...lifecycleFacts, jobId, resultText: candidate }); } catch { reportBackFailed = true; throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, "report_back"); } if (signal.aborted) return; terminalized = true; completedTerminal = true; subscription.acknowledge(event.eventId, event.eventSequence); return;
        }
      } catch (error) {
        const stage = error instanceof HermesAcpTaskExecutionFailure ? error.stage : failureStage;
        const relayFailure = relaySessionLost || (error instanceof Error && (error.message === "ACP_RELAY_UNAVAILABLE" || error.message === "ACP_CONTEXT_STALE" || error.message === "ACP_SOCKET_GENERATION_LOST"));
        if (!signal.aborted && !reportBackFailed && (!currentRejected || relayFailure)) { try { await fail(relayFailure); } catch { /* stable public failure wins */ } }
        try { deps.diagnostics?.onFailureStage(stage); } catch { /* diagnostics cannot alter the stable terminal */ }
        throw new HermesAcpTaskExecutionFailure(ACP_EXECUTION_FAILED, stage);
      }
      finally { resolveAbort = undefined; removeAbort?.(); if (!completedTerminal) { close(); if (scope && process) contain(); } }
    };
  }
}

export function createHermesAcpTaskHarnessExecutionRouteRegistration(createSelector: () => TaskExecutionRouteSelector): TaskHarnessExecutionRouteRegistration {
  return { harnessId: HERMES, publicFailureCodes: ["ACP_HARNESS_UNAVAILABLE"], createSelector: () => ({ select: async ({ facts }) => { try { return await createSelector()(facts); } catch (error) { if (error instanceof HermesAcpTaskExecutionFailure) throw new TaskHarnessExecutionRouteProviderFailure(error.code); throw error; } } }) };
}

export function createHermesAcpTaskExecutionRouteSelector(deps: HermesAcpTaskExecutionDeps): TaskExecutionRouteSelector { return new HermesAcpTaskExecutionRouteSelector(deps).select; }
