import { createHash } from "node:crypto";
import { HumanMessage, SystemMessage, type BaseMessage } from "@langchain/core/messages";
import { GraphRecursionError } from "@langchain/langgraph";
import type {
  ForegroundContextRefreshRequest,
  ForegroundContextRefreshSource,
  NautiloState,
} from "../agent/state";
import { estimateTokenCount } from "../utils/history-manager";

export interface ForegroundGraph {
  streamEvents(input: unknown, config?: Record<string, unknown>): AsyncIterable<unknown>;
  getState(config: Record<string, unknown>): Promise<{
    values: Record<string, unknown>;
  } | undefined>;
  updateState(
    inputConfig: Record<string, unknown>,
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<unknown>;
}

export interface ForegroundContextRefreshTransition {
  readonly state: NautiloState;
  readonly request: ForegroundContextRefreshRequest;
  readonly signal?: AbortSignal;
}

export interface ForegroundContextRebuild {
  readonly messages: BaseMessage[];
  readonly source: ForegroundContextRefreshSource;
}

export type RebuildForegroundContext = (
  transition: ForegroundContextRefreshTransition,
) => Promise<BaseMessage[] | ForegroundContextRebuild>;

export interface StreamForegroundGraphOptions {
  readonly rebuildForegroundContext?: RebuildForegroundContext;
  readonly signal?: AbortSignal;
}

export interface ForegroundGraphOutcome {
  readonly kind: "terminal";
  readonly state: NautiloState | null;
  readonly refreshCount: number;
}

/**
 * Carry each admitted Human message exactly once. Original occurrences are
 * consumed as a multiset so two legitimate identical replies remain distinct,
 * while the same original messages projected into current state are not added
 * a second time. Transient context is never promoted into an accepted request.
 */
export function acceptedForegroundMessages(
  original: readonly BaseMessage[],
  current: readonly BaseMessage[],
): BaseMessage[] {
  const accepted = [...original];
  const overlap = new Map<string, number>();
  for (const message of original) {
    const key = JSON.stringify(message.content);
    overlap.set(key, (overlap.get(key) ?? 0) + 1);
  }
  for (const message of current) {
    if (
      !HumanMessage.isInstance(message)
      || message.additional_kwargs["nautilo_transient_context"] === true
    ) continue;
    const key = JSON.stringify(message.content);
    const remaining = overlap.get(key) ?? 0;
    if (remaining > 0) {
      overlap.set(key, remaining - 1);
      continue;
    }
    accepted.push(message);
  }
  return accepted;
}

/**
 * Room narrative receives only the actual prepared-message allowance left
 * after immutable instructions and the accepted live request are reserved.
 * Bound tool definitions and completion headroom were already removed by the
 * caller when it resolved `maximumPreparedMessageTokens`.
 */
export function foregroundContextNarrativeAllowanceCharacters(
  maximumPreparedMessageTokens: number,
  preparedMessages: readonly BaseMessage[],
  acceptedMessages: readonly BaseMessage[],
): number {
  const reservedTokens = foregroundContextReservedMessageTokens(
    preparedMessages,
    acceptedMessages,
  );
  return Math.max(0, maximumPreparedMessageTokens - reservedTokens) * 4;
}

export function foregroundContextReservedMessageTokens(
  preparedMessages: readonly BaseMessage[],
  acceptedMessages: readonly BaseMessage[],
): number {
  const seenIds = new Set<string>();
  const seenObjects = new Set<BaseMessage>();
  const acceptedOnce = acceptedMessages.filter((message) => {
    if (message.id) {
      if (seenIds.has(message.id)) return false;
      seenIds.add(message.id);
      return true;
    }
    if (seenObjects.has(message)) return false;
    seenObjects.add(message);
    return true;
  });
  const immutableMessages = [
    ...preparedMessages.filter((message) => SystemMessage.isInstance(message)),
    ...acceptedOnce,
  ];
  return estimateTokenCount(immutableMessages);
}

function abortSignal(
  config: Readonly<Record<string, unknown>>,
  options: StreamForegroundGraphOptions,
): AbortSignal | undefined {
  return options.signal
    ?? (config["signal"] instanceof AbortSignal ? config["signal"] : undefined);
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

function completedGraphNode(event: unknown): boolean {
  if (!event || typeof event !== "object") return false;
  const record = event as Record<string, unknown>;
  if (record["event"] !== "on_chain_end") return false;
  return new Set([
    "pre_model",
    "agent",
    "model_output_preflight",
    "projection_preflight",
    "ordinary_content_access_preflight",
    "post_model",
    "tools",
    "browser_decision",
    "await_reply",
    "foreground_context_refresh",
  ]).has(record["name"] as string);
}

function aggregateRecursionError(limit: number): GraphRecursionError {
  return new GraphRecursionError(
    `Recursion limit of ${limit} reached without hitting a stop condition.`,
    { lc_error_code: "GRAPH_RECURSION_LIMIT" },
  );
}

/**
 * Content-free projection identity used only to reject an unchanged refresh
 * loop. Message bodies never enter checkpoint coordination metadata.
 */
export function foregroundContextProjectionFingerprint(
  messages: readonly BaseMessage[],
  modelId: string,
  maximumContextCharacters: number,
): string {
  const descriptor = messages.map((message) => {
    const content = typeof message.content === "string"
      ? message.content
      : JSON.stringify(message.content);
    const calls = "tool_calls" in message && Array.isArray(message.tool_calls)
      ? JSON.stringify(message.tool_calls)
      : "";
    return `${message.constructor.name}:${message.id ?? ""}:${content}:${calls}`;
  }).join("|");
  const input = `${modelId}:${maximumContextCharacters}:${descriptor}`;
  return `${messages.length}:${createHash("sha256").update(input).digest("hex")}`;
}

/** Explicit carry/reset map for a settled internal refresh boundary. */
export function foregroundContextRefreshInput(
  messages: BaseMessage[],
  request: ForegroundContextRefreshRequest,
  source?: ForegroundContextRefreshSource,
): Partial<NautiloState> {
  const appliedProjectionFingerprint = foregroundContextProjectionFingerprint(
    messages,
    request.modelId,
    request.maximumContextCharacters,
  );
  return {
    messages,
    ...(source === undefined ? {} : { foregroundContextRefreshSource: source }),
    preparedMessages: [],
    preparedStableSystemPrefixLength: 0,
    toolNames: [],
    approvedToolCalls: [],
    pendingApproval: [],
    approvalDenied: false,
    ordinaryContentAccessBindings: {},
    ordinaryContentAccessRejectedToolCallIds: [],
    computerUseInvocationBindings: {},
    fullMacInvocationBindings: {},
    delegatedLocalExecutionBindings: {},
    githubInvocationBindings: {},
    humanTerminalInvocationBindings: {},
    requiredHostRelays: {},
    identityEnrollmentToolCallIds: [],
    projectionSnapshots: [],
    projectionRoomChoices: [],
    projectionRejectedToolCallIds: [],
    modelRejectedToolCallIds: [],
    researchContinuationRequired: false,
    awaitResponse: false,
    foregroundContextRefresh: null,
    foregroundContextRefreshLastProjection: appliedProjectionFingerprint,
    foregroundContextPreparedModelId: "",
    foregroundContextMaximumCharacters: 0,
    foregroundContextBoundToolTokens: 0,
    foregroundContextReservedMessageTokens: 0,
  };
}

/**
 * Stream one logical foreground execution across any number of internal
 * context segments. The caller persists each yielded segment event before
 * this generator can observe the segment's settled checkpoint and rebuild.
 */
export async function* streamForegroundGraph(
  graph: ForegroundGraph,
  input: unknown,
  config: Record<string, unknown>,
  options: StreamForegroundGraphOptions = {},
): AsyncGenerator<unknown, ForegroundGraphOutcome, void> {
  const signal = abortSignal(config, options);
  const configuredRecursionLimit = typeof config["recursionLimit"] === "number"
    ? config["recursionLimit"]
    : null;
  let remainingRecursion = configuredRecursionLimit;
  let segmentInput = input;
  let refreshCount = 0;

  while (true) {
    assertNotAborted(signal);
    const segmentConfig = remainingRecursion === null
      ? config
      : { ...config, recursionLimit: remainingRecursion };
    for await (const event of graph.streamEvents(segmentInput, segmentConfig)) {
      if (remainingRecursion !== null && completedGraphNode(event)) {
        remainingRecursion -= 1;
      }
      yield event;
    }

    assertNotAborted(signal);
    if (options.rebuildForegroundContext === undefined) {
      return { kind: "terminal", state: null, refreshCount };
    }
    const checkpoint = await graph.getState(config);
    assertNotAborted(signal);
    const state = checkpoint?.values as NautiloState | undefined;
    const request = state?.foregroundContextRefresh;
    if (
      state === undefined
      || request?.kind !== "foreground_context_refresh"
      || request.status !== "ready"
    ) {
      return { kind: "terminal", state: state ?? null, refreshCount };
    }

    if (remainingRecursion !== null && remainingRecursion < 1) {
      throw aggregateRecursionError(configuredRecursionLimit!);
    }
    assertNotAborted(signal);
    const rebuilt = await options.rebuildForegroundContext({
      state,
      request,
      ...(signal === undefined ? {} : { signal }),
    });
    assertNotAborted(signal);
    const replacement = Array.isArray(rebuilt) ? rebuilt : rebuilt.messages;
    segmentInput = foregroundContextRefreshInput(
      replacement,
      request,
      Array.isArray(rebuilt) ? undefined : rebuilt.source,
    );
    refreshCount += 1;
  }
}
