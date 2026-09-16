import { randomUUID } from "node:crypto";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import { task } from "@langchain/langgraph";
import {
  StrictShadowEnforcementError,
  type ProtectedAgentMemoryRepository,
  type ProtectedAgentMemorySearchPort,
} from "@nautilo/lattice-bridge";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "../tools/memory/protected-memory-ports";
import { warn } from "@nautilo/logger";
import {
  assignStableToolMessageId,
  mergeMessagesPreservingInvariants,
} from "@nautilo/message-invariants";
import type { NautiloState } from "../agent/state";
import type { OrdinaryContentAccessForState, OrdinaryContentAccessSelection } from "../runtime/ordinary-content-access";
import {
  createNautiloToolInvocationSession,
  createServerToolInvocationContext,
  readToolInvocationStatus,
  type NautiloToolInvocationSnapshot,
} from "../tools/invocation-service";
import { computerUseHostToolDefinition } from "../config/computer-use-catalogue/host-tool-admission";
import {
  deriveComputerUseInvocationId,
  parseComputerUseInvocationBinding,
  resolveComputerUseHostInvocationRequest,
} from "../runtime/computer-use-admission";
import {
  applyToolResultsToStreaks,
  formatNoProgressLogToken,
  toNoProgressOutcome,
  type NoProgressStreakEntry,
  type NoProgressToolResult,
} from "../graph/no-progress";
import { resolveGraphExecutionPolicy } from "../graph/execution-policy";
import type {
  RecallRecordsPort,
  RecallRecordsPortForState,
} from "../tools/memory/recall-records";

export {
  RelayUnavailableError,
  buildWorkstationShellBindingFromPlan,
  formatGoogleAuthRequiredRelayError,
  getRelayRegistry,
  getWorkstationDispatchPlanRegistry,
  resolveExecutionPolicy,
  sanitizeToolCallArgsForEvent,
  setRelayRegistry,
  setWorkstationDispatchPlanRegistry,
  validateBeforeExecution,
} from "../tools/invocation-service";
export type {
  ActiveWorkstationSessionView,
  ExecutionPolicy,
  ToolRelayRegistry,
  WorkstationDispatchPlanRegistry,
  WorkstationDispatchPlanView,
  WorkstationPlanRevalidationReasonView,
  WorkstationPlanRevalidationResultView,
  WorkstationRelayFingerprintView,
  WorkstationShellDisposition,
} from "../tools/invocation-service";

type ApprovedToolCall = NonNullable<NautiloState["approvedToolCalls"]>[number];

export interface LiveShadowToolBoundary {
  /** Protect/self-open the complete canonical assistant Message before invoke. */
  protectAssistantToolCall(message: AIMessage): Promise<AIMessage | null>;
  /** Protect/self-open the complete canonical Tool Message before graph merge. */
  protectToolResult(message: ToolMessage): Promise<ToolMessage | null>;
}

/** A Strict Shadow boundary must stop rather than consume ordinary fallback. */
export class LiveShadowToolProtectionRequiredError extends Error {
  constructor() {
    super("Strict Shadow tool protection is required");
    this.name = "LiveShadowToolProtectionRequiredError";
  }
}

/**
 * Protection reached a terminal integrity/parity failure. Unlike ordinary
 * Shadow unavailability, this must stop the graph even while fallback is
 * enabled: continuing could execute work whose confidential transcript can no
 * longer be proved equivalent to the ordinary transcript.
 */
export class LiveShadowToolProtectionTerminalError extends Error {
  constructor() {
    super("Live Shadow tool protection failed terminally");
    this.name = "LiveShadowToolProtectionTerminalError";
  }
}

export type LiveShadowToolBoundaryForState = (
  state: NautiloState,
) => LiveShadowToolBoundary | undefined;

const protectedMemoryToolsNodeTestAuthorities = new WeakSet<object>();
const protectedMemoryToolsNodeTestAuthorityBrand = Symbol(
  "nautilo.protected-memory-tools-node-test-authority",
);
export interface ProtectedMemoryToolsNodeTestAuthority {
  readonly [protectedMemoryToolsNodeTestAuthorityBrand]: true;
}

export interface AdmittedToolInvocation {
  readonly call: ApprovedToolCall;
  readonly callId: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  /** Server-minted admission receipt. Never derived from a model tool-call id. */
  readonly authorityRef: string;
}

/**
 * Normalize the post-model admission list exactly once. Correlation ids and
 * authority receipts are separate namespaces: an id-less model call receives
 * a unique server correlation id, while every call receives an independent
 * opaque server-minted authority receipt.
 *
 * @internal Exported from this deep module for focused boundary tests only.
 */
export function normalizeAdmittedToolCalls(
  toolCalls: readonly ApprovedToolCall[],
): readonly AdmittedToolInvocation[] {
  return toolCalls.map((call) => ({
    call,
    callId: call.id ?? `nautilo-tool-call:${randomUUID()}`,
    toolName: call.name,
    args: (call.args ?? {}) as Record<string, unknown>,
    authorityRef: `nautilo-tool-authority:${randomUUID()}`,
  }));
}

type ProtectedToolComposition = Readonly<{
  ordinaryContentAccess?: OrdinaryContentAccessSelection;
  recallRecordsPort?: RecallRecordsPort;
  repository?: ProtectedAgentMemoryRepository;
  memorySearch?: ProtectedAgentMemorySearchPort;
  access?: ProtectedAgentMemoryAccessPort;
  projection?: ProtectedAgentMemoryProjectionPort;
  scopeLifecycle?: ProtectedAgentMemoryScopeLifecyclePort;
  liveShadowToolBoundary?: LiveShadowToolBoundary;
  fullEncryptionOnly?: boolean;
}>;

type ToolCompletion = Readonly<{
  message: ToolMessage;
  snapshot: NautiloToolInvocationSnapshot;
}>;

/** Scheduling permission is signed release metadata, never inferred from a tool name. */
function isCoordinatedRead(state: NautiloState, call: ApprovedToolCall): boolean {
  if (!call.id) return false;
  const definition = computerUseHostToolDefinition(call.name);
  const request = resolveComputerUseHostInvocationRequest(call.name, call.args);
  const binding = parseComputerUseInvocationBinding(state.computerUseInvocationBindings?.[call.id]);
  return definition?.entry.scheduling?.readConcurrency === "host_coordinated"
    && request?.contract.effectClass === "read"
    && request.contract.replayClass === "safe"
    && binding !== null
    && deriveComputerUseInvocationId(binding.computerUseContextId, call) === binding.computerUseInvocationId;
}

async function executeToolsNode(
  state: NautiloState,
  config: RunnableConfig | undefined,
  protectedComposition: ProtectedToolComposition,
): Promise<Partial<NautiloState>> {
  const toolCalls = state.approvedToolCalls;
  if (!toolCalls || toolCalls.length === 0) {
    return {
      messages: state.messages,
      approvedToolCalls: [],
      requiredHostRelays: {},
      computerUseInvocationBindings: {},
      ordinaryContentAccessBindings: {},
    };
  }

  const first = toolCalls[0]!;
  // This branch depends only on checkpointed admission, not the mutable active
  // catalogue. A resumed wave must visit the same durable plan and child tasks.
  if (toolCalls.length > 1 && first.id
    && state.computerUseInvocationBindings?.[first.id] !== undefined) {
    const plan = await task("computer_use_read_wave_plan", async () => {
      const opened = await protectAssistantCalls(state, toolCalls, protectedComposition);
      const barrier = opened.findIndex((call) => !isCoordinatedRead(state, call));
      const count = barrier < 0 ? opened.length : Math.max(1, barrier);
      return { calls: opened.slice(0, count), parallel: count > 1 };
    })();
    if (plan.parallel) {
      const read = task("computer_use_checkpointed_read", async (call: ApprovedToolCall) => {
        // Catalogue replacement cannot turn a saved read plan into a mutation.
        if (!isCoordinatedRead(state, call)) {
          throw new Error("Computer Use read contract changed before dispatch; fresh admission is required.");
        }
        return invokeToolCall(state, call, config, protectedComposition, true);
      });
      const settled = await Promise.allSettled(plan.calls.map((call) => read(call)));
      // Drain healthy siblings, including their protected task returns, before
      // propagating an interrupt/error. Never cancel them to recover a peer.
      const failed = settled.find((result) => result.status === "rejected");
      if (failed?.status === "rejected") throw failed.reason;
      const completions = settled.map((result) => {
        if (result.status !== "fulfilled") throw new Error("Unsettled Computer Use read");
        return result.value;
      });
      const snapshot = completions[0]!.snapshot;
      // Host tools are core registrations and cannot edit skill/activation
      // handles. Refuse a future unreviewed state effect instead of silently
      // dropping a sibling's delta or inventing concurrent eject/renew rules.
      if (completions.some((completion) => JSON.stringify(completion.snapshot) !== JSON.stringify(snapshot))) {
        throw new Error("Computer Use reads returned incompatible invocation state");
      }
      return settleToolsNode(state, plan.calls, completions.map((value) => value.message),
        snapshot, toolCalls.slice(plan.calls.length));
    }
    const completion = await invokeToolCall(state, plan.calls[0]!, config, protectedComposition);
    return settleToolsNode(state, plan.calls, [completion.message], completion.snapshot, toolCalls.slice(1));
  }
  // Unknown, mutation and Human-interrupting tools retain one call per graph
  // checkpoint. A durable read task is never used for an at-most-once effect.
  const [nextCall] = await protectAssistantCalls(state, [first], protectedComposition);
  const completion = await invokeToolCall(state, nextCall!, config, protectedComposition);
  return settleToolsNode(state, [nextCall!], [completion.message], completion.snapshot, toolCalls.slice(1));
}

async function protectAssistantCalls(
  state: NautiloState,
  calls: readonly ApprovedToolCall[],
  protectedComposition: ProtectedToolComposition,
): Promise<ApprovedToolCall[]> {
  const first = calls[0]!;
  const assistantSource = [...state.messages].reverse().find((message) =>
    AIMessage.isInstance(message)
    && message.tool_calls?.some((call) =>
      call.id === first.id
      && call.name === first.name
    )
  );
  if (
    protectedComposition.fullEncryptionOnly === true
    && (protectedComposition.liveShadowToolBoundary === undefined
      || assistantSource === undefined)
  ) {
    throw new LiveShadowToolProtectionRequiredError();
  }
  if (
    protectedComposition.liveShadowToolBoundary !== undefined
    && assistantSource !== undefined
    && AIMessage.isInstance(assistantSource)
  ) {
    let opened: AIMessage | null = null;
    try {
      opened = await protectedComposition.liveShadowToolBoundary
        .protectAssistantToolCall(assistantSource);
    } catch (error) {
      if (
        error instanceof LiveShadowToolProtectionRequiredError
        || error instanceof LiveShadowToolProtectionTerminalError
        || error instanceof StrictShadowEnforcementError
      ) throw error;
      if (protectedComposition.fullEncryptionOnly === true) {
        throw new LiveShadowToolProtectionRequiredError();
      }
      // The ordinary call is the one allowed fallback. Never restart or
      // duplicate the graph/tool invocation when protection is unavailable.
    }
    return calls.map((original) => {
      const openedCall = opened?.tool_calls?.find((call) =>
        call.id === original.id && call.name === original.name);
      if (protectedComposition.fullEncryptionOnly === true && openedCall === undefined) {
        throw new LiveShadowToolProtectionRequiredError();
      }
      return openedCall ?? original;
    });
  }
  return [...calls];
}

async function invokeToolCall(
  state: NautiloState,
  nextCall: ApprovedToolCall,
  config: RunnableConfig | undefined,
  protectedComposition: ProtectedToolComposition,
  requireUnchangedSnapshot = false,
): Promise<ToolCompletion> {
  const admittedCalls = normalizeAdmittedToolCalls([nextCall]);
  const admissionsByAuthorityRef = new Map(
    admittedCalls.map((admitted) => [
      admitted.authorityRef,
      {
        callId: admitted.callId,
        toolName: admitted.toolName,
        args: JSON.stringify(admitted.args),
      },
    ]),
  );
  const context = createServerToolInvocationContext(
    state,
    ({ call, authorityRef }) => {
      const admitted = admissionsByAuthorityRef.get(authorityRef);
      return admitted
          && admitted.callId === call.callId
          && admitted.toolName === call.toolName
          && admitted.args === JSON.stringify(call.args)
        ? { status: "allowed" as const }
        : {
          status: "denied" as const,
          reason:
            "Tool call admission receipt is absent or does not match the exact call.",
        };
    },
    {
      ...(protectedComposition.ordinaryContentAccess === undefined ? {} : { ordinaryContentAccess: protectedComposition.ordinaryContentAccess }),
      ...(protectedComposition.recallRecordsPort === undefined
        ? {}
        : { recallRecordsPort: protectedComposition.recallRecordsPort }),
      ...(protectedComposition.repository === undefined
        ? {}
        : { protectedMemoryRepository: protectedComposition.repository }),
      ...(protectedComposition.memorySearch === undefined
        ? {}
        : { protectedMemorySearch: protectedComposition.memorySearch }),
      ...(protectedComposition.access === undefined
        ? {}
        : { protectedMemoryAccessPort: protectedComposition.access }),
      ...(protectedComposition.projection === undefined
        ? {}
        : { protectedMemoryProjectionPort: protectedComposition.projection }),
      ...(protectedComposition.scopeLifecycle === undefined
        ? {}
        : { protectedMemoryScopeLifecyclePort: protectedComposition.scopeLifecycle }),
      ...(protectedComposition.fullEncryptionOnly === true
        ? { fullEncryptionOnly: true }
        : {}),
    },
  );
  const session = createNautiloToolInvocationSession(context, config);
  const initialSnapshot = session.snapshot();
  const admitted = admittedCalls[0]!;
  const result = await session.invoke({
    callId: admitted.callId,
    toolName: admitted.toolName,
    args: admitted.args,
    authorityRef: admitted.authorityRef,
  });
  const ordinaryMessage = new ToolMessage({
    content: result.content,
    tool_call_id: result.callId,
    name: result.toolName,
    status: result.status,
    ...(result.additionalKwargs ? { additional_kwargs: result.additionalKwargs } : {}),
  });
  assignStableToolMessageId(ordinaryMessage);
  ordinaryMessage.additional_kwargs = {
    ...(ordinaryMessage.additional_kwargs ?? {}),
    nautilo_tool_status: result.status,
  };
  let message = ordinaryMessage;
  if (protectedComposition.liveShadowToolBoundary !== undefined) {
    try {
      const openedResult = await protectedComposition.liveShadowToolBoundary
        .protectToolResult(ordinaryMessage);
      if (protectedComposition.fullEncryptionOnly === true && openedResult === null) {
        throw new LiveShadowToolProtectionRequiredError();
      }
      message = openedResult ?? ordinaryMessage;
    } catch (error) {
      if (
        error instanceof LiveShadowToolProtectionRequiredError
        || error instanceof LiveShadowToolProtectionTerminalError
        || error instanceof StrictShadowEnforcementError
      ) throw error;
      if (protectedComposition.fullEncryptionOnly === true) {
        throw new LiveShadowToolProtectionRequiredError();
      }
      // The side effect has already happened. Feed its one ordinary result
      // forward; never invoke the tool again to recover protected parity.
    }
  }
  const snapshot = session.snapshot();
  if (requireUnchangedSnapshot && JSON.stringify(snapshot) !== JSON.stringify(initialSnapshot)) {
    throw new Error("Computer Use read changed invocation state without a reviewed merge contract");
  }
  return { message, snapshot };
}

function settleToolsNode(
  state: NautiloState,
  executedCalls: readonly ApprovedToolCall[],
  results: readonly ToolMessage[],
  snapshot: NautiloToolInvocationSnapshot,
  remainingToolCalls: ApprovedToolCall[],
): Partial<NautiloState> {
  const executionPolicy = resolveGraphExecutionPolicy();
  // Calls are checkpointed individually, but no-progress rounds belong to
  // the model's whole batch. It cannot correct an error until every call in
  // that batch has returned. Reconstruct paired receipts on the final wave,
  // including calls completed before a serial barrier or checkpoint resume.
  const assistantSource = [...state.messages].reverse().find((message) =>
    AIMessage.isInstance(message)
    && message.tool_calls?.some((call) => executedCalls.some((executed) =>
      call.id === executed.id && call.name === executed.name))
  );
  const batchCalls = assistantSource && AIMessage.isInstance(assistantSource)
    ? assistantSource.tool_calls ?? executedCalls : executedCalls;
  const batchMessages = assistantSource
    ? mergeMessagesPreservingInvariants(state.messages.slice(state.messages.lastIndexOf(assistantSource) + 1), [...results])
    : results;
  const noProgressResults: NoProgressToolResult[] = remainingToolCalls.length > 0 ? [] : batchMessages.flatMap((tm) => {
    if (!ToolMessage.isInstance(tm)) return [];
    const call = batchCalls.find((candidate) => candidate.id === tm.tool_call_id && candidate.name === tm.name)
      ?? executedCalls[results.indexOf(tm)];
    if (!call) return [];
    const status = readToolInvocationStatus(tm);
    return [{
      toolName: call.name,
      args: call.args,
      status: status === "error" ? "error" : "success",
      ...(status === "error" && typeof tm.content === "string"
        ? { errorContent: tm.content }
        : {}),
    }];
  });
  const prevStreaks = state.noProgressStreaks ?? new Map<string, NoProgressStreakEntry>();
  const transition = applyToolResultsToStreaks(
    prevStreaks,
    noProgressResults,
    executionPolicy.repeatedFailureLimit,
  );
  if (transition.action.kind === "stop_no_progress") {
    warn(
      `[nautilo/tools] ${formatNoProgressLogToken(toNoProgressOutcome(transition.action.key))} ` +
        `(repeatedFailureLimit=${executionPolicy.repeatedFailureLimit}); stopping run.`,
    );
    // Return this completed invocation through the ordinary checkpoint/transcript
    // path. The next pre-model node raises the same breaker before any model work.
  }
  const pendingCorrection = transition.action.kind === "inject_corrective"
    ? {
        toolName: transition.action.key.toolName,
        operationDiscriminator: transition.action.key.operationDiscriminator,
        normalizedError: transition.action.key.normalizedError,
      }
    : null;
  const remainingToolCallIds = new Set(
    remainingToolCalls.flatMap((call) => call.id === undefined ? [] : [call.id]),
  );
  const remainingHostRelays = Object.fromEntries(
    Object.entries(state.requiredHostRelays ?? {}).filter(([toolCallId]) =>
      remainingToolCallIds.has(toolCallId),
    ),
  );
  const remainingComputerUseBindings = Object.fromEntries(
    Object.entries(state.computerUseInvocationBindings ?? {}).filter(([toolCallId]) =>
      remainingToolCallIds.has(toolCallId),
    ),
  );
  return {
    messages: mergeMessagesPreservingInvariants(state.messages, [...results]),
    approvedToolCalls: remainingToolCalls,
    requiredHostRelays: remainingHostRelays,
    computerUseInvocationBindings: remainingComputerUseBindings,
    ordinaryContentAccessBindings: Object.fromEntries(
      Object.entries(state.ordinaryContentAccessBindings ?? {}).filter(([id]) => remainingToolCallIds.has(id)),
    ),
    engagedSkillNames: [...snapshot.engagedSkillNames],
    noProgressStreaks: transition.streaks,
    noProgressPendingStop: transition.action.kind === "stop_no_progress" ? transition.action.key : null,
    ...(pendingCorrection ? { noProgressPendingCorrection: pendingCorrection } : {}),
    ...(state.actorRole !== "guest"
      ? {
          activatedToolNames: [...snapshot.activatedToolNames],
          activatedToolLeases: [...snapshot.activatedToolLeases],
          activationLeasesInitialized: state.activationLeasesInitialized === true,
        }
      : {}),
  };
}

/** Production graph entrypoint. It deliberately cannot receive a repository. */
export async function toolsNode(
  state: NautiloState,
  config?: RunnableConfig,
): Promise<Partial<NautiloState>> {
  return executeToolsNode(state, config, {});
}

/**
 * Production graph composition for invocation-bound optional tool ports.
 * Runtime resolves the exact Room authority; this node only forwards the
 * already-bound capability into the existing admission session.
 */
export function createToolsNode(input: Readonly<{
  ordinaryContentAccessForState?: OrdinaryContentAccessForState;
  recallRecordsPortForState?: RecallRecordsPortForState;
  liveShadowToolBoundaryForState?: LiveShadowToolBoundaryForState;
  protectedMemorySearchForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemorySearchPort | undefined;
  protectedMemoryRepositoryForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryRepository | undefined;
  protectedMemoryAccessPortForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryAccessPort | undefined;
  protectedMemoryProjectionPortForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryProjectionPort | undefined;
  fullEncryptionOnlyForState?: (state: NautiloState) => boolean;
}> = {}): typeof toolsNode {
  return async (state, config) => {
    const ordinaryContentAccess = await input.ordinaryContentAccessForState?.(state);
    const recallRecordsPort = input.recallRecordsPortForState?.(state);
    const liveShadowToolBoundary =
      input.liveShadowToolBoundaryForState?.(state);
    const memorySearch = input.protectedMemorySearchForState?.(state);
    const repository = input.protectedMemoryRepositoryForState?.(state);
    const access = input.protectedMemoryAccessPortForState?.(state);
    const projection = input.protectedMemoryProjectionPortForState?.(state);
    const fullEncryptionOnly = input.fullEncryptionOnlyForState?.(state) === true;
    return executeToolsNode(state, config, {
      ...(ordinaryContentAccess === undefined ? {} : { ordinaryContentAccess }),
      ...(recallRecordsPort === undefined ? {} : { recallRecordsPort }),
      ...(liveShadowToolBoundary === undefined
        ? {}
        : { liveShadowToolBoundary }),
      ...(memorySearch === undefined ? {} : { memorySearch }),
      ...(repository === undefined ? {} : { repository }),
      ...(access === undefined ? {} : { access }),
      ...(projection === undefined ? {} : { projection }),
      ...(fullEncryptionOnly ? { fullEncryptionOnly: true } : {}),
    });
  };
}

/**
 * Explicit dormant protected-Memory composition. The returned node runs the normal
 * Agent tool admission/invocation/checkpoint path while injecting one
 * invocation-bound protected Memory repository. It is not registered by the
 * production graph and requires an unforgeable process-local test authority.
 *
 * @internal Deep-module test/nonproduction seam only.
 */
export function createProtectedMemoryTestToolsNode(input: Readonly<{
  authority: ProtectedMemoryToolsNodeTestAuthority;
  repository: ProtectedAgentMemoryRepository;
  access?: ProtectedAgentMemoryAccessPort;
  projection?: ProtectedAgentMemoryProjectionPort;
  scopeLifecycle?: ProtectedAgentMemoryScopeLifecyclePort;
}>): typeof toolsNode {
  __assertProtectedMemoryToolsNodeTestAuthorityForTesting(input.authority);
  const protectedPorts = Object.freeze({
    repository: input.repository,
    ...(input.access === undefined ? {} : { access: input.access }),
    ...(input.projection === undefined ? {} : { projection: input.projection }),
    ...(input.scopeLifecycle === undefined
      ? {}
      : { scopeLifecycle: input.scopeLifecycle }),
  });
  return async (state, config) =>
    executeToolsNode(state, config, protectedPorts);
}

/** @internal Shared only by dormant protected graph test composition. */
export function __assertProtectedMemoryToolsNodeTestAuthorityForTesting(
  authority: ProtectedMemoryToolsNodeTestAuthority,
): void {
  if (!protectedMemoryToolsNodeTestAuthorities.has(authority)) {
    throw new TypeError(
      "Protected Memory tools-node composition requires recognized test authority",
    );
  }
}

/**
 * Internal direct-source test mint. It is deliberately omitted from the
 * package root so serialized configuration and ordinary production imports
 * cannot construct the dormant protected tools-node composition.
 */
export function __mintProtectedMemoryToolsNodeTestAuthorityForTesting():
  ProtectedMemoryToolsNodeTestAuthority {
  const authority = Object.freeze({
    [protectedMemoryToolsNodeTestAuthorityBrand]: true as const,
  });
  protectedMemoryToolsNodeTestAuthorities.add(authority);
  return authority;
}
