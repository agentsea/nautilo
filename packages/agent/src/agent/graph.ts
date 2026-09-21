import {
  StateGraph,
  END,
  type BaseCheckpointSaver,
} from "@langchain/langgraph";
import { AIMessage, ToolMessage } from "@langchain/core/messages";
import type { PolicyResolver } from "@nautilo/trust";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryRepository,
  ProtectedAgentMemorySearchPort,
} from
  "@nautilo/lattice-bridge";
import { NautiloStateAnnotation, type NautiloState } from "./state";
import { preModelNode } from "../nodes/pre-model";
import { createBrowserDecisionNode } from "../nodes/browser-decision";
import { currentBrowserDecision } from "../graph/browser-decision";
import { currentNativeDecision } from "../graph/native-decision";
import { computerUseContractsForState } from "../config/computer-use-catalogue/live-selection";
import { withComputerUseContractSelection } from "../config/computer-use-catalogue/selection";
import { createNativeDecisionNode } from "../nodes/native-decision";
import { agentNode } from "../nodes/agent";
import {
  createPostModelNode,
  type PostModelDeps,
} from "../nodes/post-model";
import {
  createToolsNode,
  type LiveShadowToolBoundaryForState,
} from "../nodes/tools";
import { awaitReplyNode } from "../nodes/await-reply";
import { createProjectionPreflightNode } from "../nodes/projection-preflight";
import { createOrdinaryContentAccessPreflightNode } from "../nodes/ordinary-content-access-preflight";
import {
  preflightProjectionShareCalls,
  preflightProtectedProjectionShareCalls,
} from "../tools/memory/projection-sharing";
import { modelOutputPreflightNode } from "../nodes/model-output-preflight";
import { EmptyTerminalResponseError } from "../graph/empty-terminal-response";
import { researchNoteDraftNodes } from "../tools/security/research-note-draft-nodes";
import type { ResearchNoteDraft } from "../tools/security/research-note-draft";

function hasVisibleTerminalContent(content: unknown): boolean {
  if (typeof content === "string") return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((block) => {
    if (typeof block === "string") return block.trim().length > 0;
    if (!block || typeof block !== "object") return false;
    const record = block as Record<string, unknown>;
    const type = record["type"];
    if (type === "reasoning" || type === "redacted_thinking" || type === "thinking") {
      return false;
    }
    if (typeof record["text"] === "string") return record["text"].trim().length > 0;
    if (typeof record["content"] === "string") return record["content"].trim().length > 0;
    return type === "image" || type === "image_url" || type === "audio";
  });
}

function parseToolResult(content: unknown): Record<string, unknown> | null {
  if (typeof content !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(content);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * `react` and `skip` deliberately replace a visible assistant reply. Accept
 * that silence only for the immediately preceding, explicitly successful
 * tool result; malformed, failed, and unrelated results remain empty-response
 * failures.
 */
function followsSuccessfulIntentionalSilence(state: NautiloState): boolean {
  const priorMessage = state.messages[state.messages.length - 2];
  if (
    !priorMessage || !ToolMessage.isInstance(priorMessage) ||
    priorMessage.additional_kwargs?.["nautilo_tool_status"] !== "success"
  ) {
    return false;
  }
  const result = parseToolResult(priorMessage.content);
  if (!result) return false;
  if (priorMessage.name === "react") return result["ok"] === true;
  if (priorMessage.name === "skip") {
    return result["skipped"] === true || result["recorded"] === true;
  }
  return false;
}

/** @internal Exported for unit testing only. */
export function shouldContinue(
  state: NautiloState,
): "tools" | "pre_model" | "await_reply" | typeof END {
  if (state.approvedToolCalls && state.approvedToolCalls.length > 0) {
    return "tools";
  }
  if (
    state.modelRejectedToolCallIds?.length
    || state.projectionRejectedToolCallIds?.length
    || state.ordinaryContentAccessRejectedToolCallIds?.length
    || state.researchContinuationRequired
  ) return "pre_model";
  if (state.approvalDenied) {
    return "pre_model";
  }
  // (Task ) — a run with `awaitResponse` set parks on a human
  // reply instead of ending. The `await_reply` node raises `await_human_reply`
  // (persisted checkpoint); on resume it injects the reply + clears the flag.
  if (state.awaitResponse) {
    return "await_reply";
  }
  const terminalMessage = state.messages[state.messages.length - 1];
  if (
    terminalMessage && AIMessage.isInstance(terminalMessage) &&
    !hasVisibleTerminalContent(terminalMessage.content) &&
    !(
      !terminalMessage.tool_calls?.length &&
      followsSuccessfulIntentionalSilence(state)
    )
  ) {
    throw new EmptyTerminalResponseError();
  }
  return END;
}

/**
 * A tools-node invocation checkpoints exactly one completed call. Keep a
 * remaining approved batch on the tools lane so a later tool's interrupt
 * cannot replay an earlier completed call.
 *
 * @internal Exported for unit testing only.
 */
export function shouldContinueAfterTools(
  state: NautiloState,
): "tools" | "pre_model" | "browser_decision" | "native_decision" {
  if (state.approvedToolCalls?.length) return "tools";
  if (state.noProgressPendingCorrection || state.noProgressPendingStop || state.approvalDenied
    || state.modelRejectedToolCallIds?.length || state.projectionRejectedToolCallIds?.length
    || state.ordinaryContentAccessRejectedToolCallIds?.length) return "pre_model";
  const decision = currentBrowserDecision(state);
  const native = currentNativeDecision(state);
  if (native?.phase === "decide" || native?.phase === "observe") return "native_decision";
  return decision?.phase === "decide" || decision?.phase === "observe" ? "browser_decision" : "pre_model";
}

interface CompiledGraph {
  // Input accepts Record for normal invocations and Command for resume
  invoke(input: unknown, config?: Record<string, unknown>): Promise<unknown>;
  stream(input: unknown, config?: Record<string, unknown>): Promise<AsyncIterable<unknown>>;
  streamEvents(input: unknown, config?: Record<string, unknown>): AsyncIterable<unknown>;
  getState(config: Record<string, unknown>): Promise<{ values: Record<string, unknown> } | undefined>;
  updateState(
    inputConfig: Record<string, unknown>,
    values: Record<string, unknown>,
    asNode?: string,
  ): Promise<unknown>;
}

export interface NautiloGraphDeps extends PostModelDeps {
  readonly researchNoteDraft?: ResearchNoteDraft;
  readonly liveShadowToolBoundaryForState?:
    LiveShadowToolBoundaryForState;
  readonly protectedMemorySearchForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemorySearchPort | undefined;
  readonly protectedMemoryRepositoryForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryRepository | undefined;
  readonly protectedMemoryAccessPortForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryAccessPort | undefined;
  readonly protectedMemoryProjectionPortForState?: (
    state: NautiloState,
  ) => ProtectedAgentMemoryProjectionPort | undefined;
}

export function createNautiloGraph(
  checkpointSaver?: BaseCheckpointSaver,
  policyResolver?: PolicyResolver | null,
  deps?: NautiloGraphDeps,
): CompiledGraph {
  const postModelNode = createPostModelNode(policyResolver, deps);
  const graphProjectionPreflightNode = createProjectionPreflightNode(
    async (state, calls) => {
      const projection = deps?.protectedMemoryProjectionPortForState?.(state);
      return projection === undefined
        ? preflightProjectionShareCalls(state, calls)
        : preflightProtectedProjectionShareCalls(state, calls, projection);
    },
    { sanitizeProjectionToolArgs: true },
  );
  const recallRecordsPortForState = deps?.recallRecordsPortForState;
  const draftNodes = researchNoteDraftNodes({
    ...(deps?.researchNoteDraft ? { helper: deps.researchNoteDraft } : {}),
    prepare: (state, config) =>
    preModelNode(
      state,
      config,
      recallRecordsPortForState,
      undefined,
      deps?.fullEncryptionOnlyForState?.(state) === true,
      deps?.ordinaryContentAccessForState,
    ),
    agent: (state, config, draft) =>
    agentNode(
      state,
      config,
      recallRecordsPortForState,
      deps?.fullEncryptionOnlyForState?.(state) === true,
      draft,
      deps?.ordinaryContentAccessForState,
      deps?.nativeRoomHistoryPortForState,
    ),
  });
  const graphToolsNode = createToolsNode({
    ...(deps?.nativeRoomHistoryPortForState === undefined ? {} : { nativeRoomHistoryPortForState: deps.nativeRoomHistoryPortForState }),
    ...(deps?.ordinaryContentAccessForState === undefined ? {} : { ordinaryContentAccessForState: deps.ordinaryContentAccessForState }),
    ...(recallRecordsPortForState === undefined ? {} : { recallRecordsPortForState }),
    ...(deps?.liveShadowToolBoundaryForState === undefined
      ? {}
      : {
        liveShadowToolBoundaryForState:
          deps.liveShadowToolBoundaryForState,
      }),
    ...(deps?.protectedMemorySearchForState === undefined
      ? {}
      : {
        protectedMemorySearchForState:
          deps.protectedMemorySearchForState,
      }),
    ...(deps?.protectedMemoryRepositoryForState === undefined
      ? {}
      : {
        protectedMemoryRepositoryForState:
          deps.protectedMemoryRepositoryForState,
      }),
    ...(deps?.protectedMemoryAccessPortForState === undefined
      ? {}
      : { protectedMemoryAccessPortForState: deps.protectedMemoryAccessPortForState }),
    ...(deps?.protectedMemoryProjectionPortForState === undefined
      ? {}
      : { protectedMemoryProjectionPortForState: deps.protectedMemoryProjectionPortForState }),
    ...(deps?.fullEncryptionOnlyForState === undefined
      ? {}
      : { fullEncryptionOnlyForState: deps.fullEncryptionOnlyForState }),
  });

  function scoped<A extends unknown[], R>(node: (state: NautiloState, ...args: A) => R) {
    return (state: NautiloState, ...args: A) => withComputerUseContractSelection(
      state.computerUseContractSelection ?? [], () => node(state, ...args),
    );
  }
  const workflow = new StateGraph(NautiloStateAnnotation)
    .addNode("pre_model", async (state, config) => {
      const contracts = computerUseContractsForState(state);
      return withComputerUseContractSelection(contracts, async () => ({
        ...await draftNodes.prepare(state, config),
        computerUseContractSelection: contracts,
        // Ordinary Genie reasoning suspends an unfinished fast segment. The evidence remains checkpointed.
        browserDecision: state.browserDecision ? { ...state.browserDecision, phase: "handoff" as const, pending: null } : null,
        nativeDecision: state.nativeDecision ? { ...state.nativeDecision, phase: "handoff" as const, pending: null } : null,
      }));
    })
    .addNode("browser_decision", scoped(createBrowserDecisionNode(deps)))
    .addNode("native_decision", scoped(createNativeDecisionNode(deps)))
    .addNode("agent", scoped(draftNodes.agent))
    .addNode("model_output_preflight", scoped(modelOutputPreflightNode))
    .addNode("projection_preflight", scoped(graphProjectionPreflightNode))
    .addNode("ordinary_content_access_preflight", scoped(createOrdinaryContentAccessPreflightNode(deps?.ordinaryContentAccessForState, deps?.isPinEnrolled)))
    .addNode("post_model", scoped(postModelNode))
    .addNode("tools", scoped(graphToolsNode))
    .addNode("await_reply", scoped(awaitReplyNode))
    .setEntryPoint("pre_model")
    .addEdge("pre_model", "agent")
    .addEdge("agent", "model_output_preflight")
    .addEdge("model_output_preflight", "projection_preflight")
    .addEdge("projection_preflight", "ordinary_content_access_preflight")
    .addEdge("ordinary_content_access_preflight", "post_model")
    .addConditionalEdges("post_model", shouldContinue)
    .addConditionalEdges("tools", shouldContinueAfterTools)
    .addConditionalEdges("native_decision", (state) => {
      const phase = currentNativeDecision(state)?.phase;
      return phase === "waiting" ? "model_output_preflight"
        : phase === "observe" || phase === "decide" ? "native_decision" : "pre_model";
    })
    .addConditionalEdges("browser_decision", (state) => {
      const phase = currentBrowserDecision(state)?.phase;
      return phase === "waiting" ? "model_output_preflight"
        : phase === "observe" || phase === "decide" ? "browser_decision" : "pre_model";
    })
    // on resume the await_reply node injects the human reply + clears
    // `awaitResponse`, then drives one more turn that reaches real END. (The
    // first-entry interrupt throws to suspend, so this edge is only traversed
    // post-resume.)
    .addEdge("await_reply", "pre_model");

  if (checkpointSaver) {
    return workflow.compile({ checkpointer: checkpointSaver }) as CompiledGraph;
  }

  return workflow.compile() as CompiledGraph;
}
