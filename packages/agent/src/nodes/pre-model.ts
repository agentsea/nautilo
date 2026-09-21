import { deepResearchReturnContextForState } from "../runtime/deep-research-return-context";
import { assertResearchDesktopAvailable } from "../tools/invocation-service";
import { projectSecurityResearchConsolidationTools } from "../tools/security/security-scan";
import { SystemMessage, AIMessage, ToolMessage, HumanMessage, type BaseMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { NautiloState } from "../agent/state";
import { fromRuntimeConfig, type ToolExposureMode } from "@nautilo/config";
import { getToolCatalog } from "@nautilo/catalog";
import type { ToolCatalog } from "@nautilo/catalog";
import { envelopeReadableNamespaces } from "@nautilo/trust";
import { withholdSkipForExplicitSelection } from "./skip-gate";
import { turnContextKey } from "../runtime/turn-context";
import { effectiveLiveMiniAppSessionForState } from "../runtime/live-mini-app-execution-context";
import {
  buildSystemPrompt,
  buildConnectedWebAccountCapabilityBlock,
  buildInitiatingClientSurfaceGuidance,
  buildTimeContextBlock,
  VOICE_MODE_PROMPT,
  buildAssignedVoicesPrompt,
  SOUL_FILE_HEADER,
  MEMORY_BRIEF_HEADER,
  MEMORY_DELTA_HEADER,
  ROOM_PARTICIPANTS_HEADER,
  buildPendingTerminalHandoffBlock,
  buildTwoPathBlock,
  buildActiveMiniAppBlock,
  buildLiveMiniAppSessionBlock,
  buildArtifactRefsBlock,
  buildFocusedResourcesBlock,
  buildReplyPointerBlock,
  buildFileEditsBlock,
  HTML_WORKSPACE_RICH_ARTIFACT_PROMPT,
  buildAvailableSkillsBlock,
  buildSkillBodyBlock,
  SKILL_BODY_HEADER_PREFIX,
} from "../prompts/templates";
import {
  selectSkillsForTurn,
  requiresToolsMet,
} from "../skills/select-skills-for-turn";
import { log } from "@nautilo/logger";
import { validateMessageHistory, assertMessageInvariants } from "@nautilo/message-invariants";
import { activeComputerUseModelGuidanceForBoundTools } from "../config/computer-use-catalogue/host-tool-admission";
import { processHistory, estimateTokenCount, taskReadResponseByteBudget, pendingTaskReadPages, type HistoryConfig } from "../utils/history-manager";
import { getModelTokenLimit, resolveModelExecutionLimits } from "../providers/models";
import { estimateBoundToolTokens } from "../utils/chat-model-invocation";
import { budgetResearchContext, isResearchPreEvictionConsolidating, prepareResearchContextOrigins, restoreResearchContextControlCycle } from "../tools/security/research-context-rollover";
import { SECURITY_RESEARCH_WORKFLOW } from "../tools/security/research-protocol";
import { buildResearchWorkContextMessage } from "../tools/security/research-work-context";
import { prepareResearchRoleHistory } from "../tools/security/research-role-history";
import { modelSupportsInput as mcSupportsInput } from "@nautilo/model-capabilities";
import { browserDecisionHandoffContent, browserHandoffToolResultIndex, currentBrowserDecision } from "../graph/browser-decision";
import {
  drainSessionNotifications,
  buildSessionNotificationsBlock,
} from "../notifications/session-notifications";
import {
  hasMultimodalToolContent,
  hasImageContent,
  hasPdfDocumentContent,
  isImageContentBlock,
  isPdfDocumentContentBlock,
} from "../utils/message-modalities";
import {
  expandToolFamilies,
  resolveFocusedResourceToolActivations,
  resolveIntentPacks,
} from "../tools/exposure/manifest";
import {
  measureProgressiveToolExposure,
  selectIntentPackToolsForTelemetry,
  type ToolExposureTelemetry,
} from "../tools/exposure/telemetry";
import {
  advanceActivatedToolLeases,
  mergeEligibleActivatedToolNames,
  normalizeActivatedToolLeases,
  normalizeEligibleActivatedToolNames,
  selectedActivatedToolNamesForActor,
} from "../tools/meta/activated-tools-handle";
import {
  NoProgressError,
  NO_PROGRESS_CORRECTIVE_INSTRUCTION,
  type NoProgressStreakEntry,
} from "../graph/no-progress";
import { buildApplyPatchToolContext } from "../tools/apply-patch/execution-router";
import { ordinaryContentAccessToolContextForState, type OrdinaryContentAccessForState } from "../runtime/ordinary-content-access";
import { getRelayRegistry } from "./tools";
import { modelIdForCapabilityProjection } from "../config/model-role-resolution";
import {
  usesOpenAICompatibleChatTransport,
} from "../providers/model-route";
import { modelUsesAnthropicPromptCache } from "../utils/model-context-cache";
import { projectSystemMessagesForProvider } from "../utils/provider-system-messages";
import { COMPUTER_RESULT_DURABLE_SIDECAR_KEY } from "../tools/computer/model-result-projector";
import { getCurrentInitiatingClientSurface } from "../runtime/initiating-client-surface-context";
import {
  recallRecordsToolContextForState,
  toolPolicyWithRecallRecordsAvailability,
  type RecallRecordsPortForState,
  type RecallRecordsToolContext,
} from "../tools/memory/recall-records";
import { buildRuntimeCapabilityTokens } from "../runtime/relay-capabilities";
import { getVoices } from "../store/profile-store";
import { listConnectedWebAccountCapabilities } from "../tools/connected-web-accounts/read-connected-web-account";
import { connectedAppEligibleProviderIdsForContext } from "../tools/connected-apps/runtime";

export type AssignedVoicesPortForState = typeof getVoices;

export function reconcileLiveTerminalHandoffCapabilities(
  checkpointCapabilities: Readonly<Record<string, boolean>> | undefined,
  liveCapabilities: Readonly<Record<string, boolean>> | undefined,
): Readonly<Record<string, boolean>> | undefined {
  if (
    liveCapabilities?.["canUseTerminal"] === true &&
    liveCapabilities["hasPendingTerminalHandoff"] === true
  ) {
    return {
      ...checkpointCapabilities,
      canUseTerminal: true,
      hasPendingTerminalHandoff: true,
    };
  }
  if (checkpointCapabilities?.["hasPendingTerminalHandoff"] !== true) {
    return checkpointCapabilities;
  }
  const reconciled = { ...checkpointCapabilities };
  delete reconciled["hasPendingTerminalHandoff"];
  return Object.keys(reconciled).length > 0 ? reconciled : undefined;
}

/**
 * Selects schemas only after the catalog has applied its shared eligibility
 * gates. The eager rollback deliberately reuses that resolver instead of
 * recreating policy, relay, namespace, whitelist, or model-capability checks.
 */
export function resolveToolsForExposure(
  catalog: ToolCatalog,
  mode: ToolExposureMode,
  options: Parameters<ToolCatalog["resolveProgressiveTools"]>[0],
) {
  const resolverOptions = options ?? {};
  const recallContext = resolverOptions.context as RecallRecordsToolContext | undefined;
  const recallAwareOptions = {
    ...resolverOptions,
    context: {
      ...resolverOptions.context,
      fullEncryptionOnly: resolverOptions.fullEncryptionOnly === true,
    },
    toolPolicy: toolPolicyWithRecallRecordsAvailability(
      resolverOptions.toolPolicy,
      recallContext,
    ),
  };
  const progressive = catalog.resolveProgressiveTools(recallAwareOptions);
  if (mode === "progressive") return progressive;

  const eagerActivatedToolNames = progressive.eligible.entries.map(
    (entry) => entry.name,
  );

  return catalog.resolveProgressiveTools({
    ...recallAwareOptions,
    ...(recallAwareOptions.context !== undefined
      ? {
          context: {
            ...recallAwareOptions.context,
            // Factories must observe the same eager selection that the
            // resolver binds. In particular, discover_tools uses this field
            // to report whether an eligible tool is already callable.
            activatedToolNames: eagerActivatedToolNames,
          },
        }
      : {}),
    // These names came from the resolver's already policy/relay/namespace-
    // eligible snapshot. The second resolver pass still applies whitelist and
    // model-capability gates before any schema can be instantiated.
    activatedToolNames: eagerActivatedToolNames,
    intentPackToolNames: [],
  });
}

function flattenContentToString(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content == null ? "" : JSON.stringify(content);
  return (content as unknown[])
    .map((block: unknown) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object" && "text" in block) return String((block as { text: unknown }).text);
      return "";
    })
    .filter(Boolean)
    .join("");
}

export function logProgressiveToolExposure(
  node: "pre_model" | "agent",
  telemetry: ToolExposureTelemetry,
  mode: ToolExposureMode,
): void {
  log(
    `[nautilo/${node}] tool-exposure mode=${mode} ` +
      `registered=${telemetry.registeredCatalogTools} ` +
      `eligible=${telemetry.eligibleTools} ` +
      `core=${telemetry.coreTools} ` +
      `intent=${telemetry.intentPackTools} ` +
      `activated=${telemetry.activatedTools} ` +
      `retained=${telemetry.retainedTools} ` +
      `prompt_schemas=${telemetry.promptSchemas} ` +
      `provider_schemas=${telemetry.providerSchemas} ` +
      `description_chars=${telemetry.descriptionChars} ` +
      `description_tokens_estimate=${telemetry.descriptionEstimatedTokens} ` +
      `schema_chars=${telemetry.serializedSchemaChars} ` +
      `schema_tokens_estimate=${telemetry.serializedSchemaEstimatedTokens} ` +
      `exclusions=${JSON.stringify(telemetry.exclusionReasons)}`,
  );
}

function sanitizeToolCallId(id: string | undefined): string {
  if (!id) return `tc_${Date.now()}`;
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function normalizeMessagesForProvider(messages: BaseMessage[]): BaseMessage[] {
  const idMap = new Map<string, string>();
  for (const msg of messages) {
    if (AIMessage.isInstance(msg) && msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        if (tc.id && tc.id !== sanitizeToolCallId(tc.id)) idMap.set(tc.id, sanitizeToolCallId(tc.id));
      }
    }
  }

  return messages.map((msg) => {
    if (AIMessage.isInstance(msg)) {
      const needsFlatten = Array.isArray(msg.content);
      const needsSanitize = msg.tool_calls?.some((tc) => tc.id && idMap.has(tc.id));
      if (needsFlatten || needsSanitize) {
        const toolCalls = msg.tool_calls?.map((tc) => ({ ...tc, id: tc.id ? (idMap.get(tc.id) ?? tc.id) : tc.id }));
        const normalized = new AIMessage({
          content: needsFlatten ? flattenContentToString(msg.content) : msg.content,
          ...(toolCalls?.length ? { tool_calls: toolCalls } : {}),
          additional_kwargs: msg.additional_kwargs,
          response_metadata: msg.response_metadata,
        } as ConstructorParameters<typeof AIMessage>[0]);
        if (msg.id) normalized.id = msg.id;
        return normalized;
      }
      return msg;
    }
    if (ToolMessage.isInstance(msg) && msg.tool_call_id && idMap.has(msg.tool_call_id)) {
      const normalized = new ToolMessage({
        content: msg.content,
        tool_call_id: idMap.get(msg.tool_call_id)!,
        ...(msg.name ? { name: msg.name } : {}),
      });
      if (msg.id) normalized.id = msg.id;
      return normalized;
    }
    return msg;
  });
}

/** Project durable handoffs at their original receipts, even after ordinary verification. */
export function projectBrowserHandoffForProvider(
  messages: BaseMessage[],
  state: NautiloState,
): { messages: BaseMessage[]; projected: boolean } {
  const decision = currentBrowserDecision(state);
  let currentRecorded = false;
  const replacements = new Map<number, ToolMessage>();
  const projectedEvents = new Set<number>();
  for (const [eventIndex, event] of messages.entries()) {
    if (!SystemMessage.isInstance(event) || typeof event.content !== "string") continue;
    const binding = event.additional_kwargs["nautilo_browser_handoff"] as
      { turnId?: unknown; toolCallId?: unknown; toolName?: unknown } | undefined;
    if (!binding) continue;
    if (decision && binding.turnId === decision.turnId && decision.reason
      && event.content === browserDecisionHandoffContent(decision.reason, decision.target, decision)) currentRecorded = true;
    if (typeof binding.toolCallId !== "string" || typeof binding.toolName !== "string") continue;
    const matches = messages.flatMap((message, index) => ToolMessage.isInstance(message)
      && message.tool_call_id === binding.toolCallId ? [index] : []);
    if (matches.length !== 1 || matches[0]! >= eventIndex) continue;
    const index = matches[0]!;
    const source = replacements.get(index) ?? messages[index];
    if (!ToolMessage.isInstance(source) || source.name !== binding.toolName || typeof source.content !== "string") continue;
    replacements.set(index, new ToolMessage({
      ...source,
      content: `${source.content}\n\n[Runtime browser supervision]\n${event.content}`,
    }));
    projectedEvents.add(eventIndex);
  }
  const projected = replacements.size > 0;
  const retained = projected ? messages.flatMap((message, index) => projectedEvents.has(index)
    ? [] : [replacements.get(index) ?? message]) : messages;
  if (currentRecorded) return { messages: retained, projected };
  // Older checkpoints may have the active handoff only in execution state.
  const legacy = projectCurrentBrowserHandoffForProvider(retained, state);
  return { messages: legacy.messages, projected: projected || legacy.projected };
}

/** Compatibility projection for handoffs recorded before durable receipt binding. */
function projectCurrentBrowserHandoffForProvider(
  messages: BaseMessage[],
  state: NautiloState,
): { messages: BaseMessage[]; projected: boolean } {
  const decision = currentBrowserDecision(state);
  if (decision?.phase !== "handoff" || !decision.reason || decision.reason === "ordinary_genie_control") {
    return { messages, projected: false };
  }
  const supervision = browserDecisionHandoffContent(decision.reason, decision.target, decision);
  const fallback = (): { messages: BaseMessage[]; projected: boolean } => {
    const alreadyPresent = messages.some((message) => SystemMessage.isInstance(message)
      && typeof message.content === "string" && message.content === supervision);
    return alreadyPresent
      ? { messages, projected: false }
      : { messages: [...messages, new SystemMessage({
        id: `browser-handoff-provider:${decision.turnId}`,
        content: supervision,
      })], projected: false };
  };
  const index = browserHandoffToolResultIndex(messages, decision);
  if (index === null) return fallback();
  const source = messages[index];
  if (!ToolMessage.isInstance(source) || typeof source.content !== "string") return fallback();
  const projected = new ToolMessage({
    content: `${source.content}\n\n[Runtime browser supervision]\n${supervision}`,
    tool_call_id: source.tool_call_id,
    ...(source.name !== undefined ? { name: source.name } : {}),
    additional_kwargs: { ...source.additional_kwargs, nautilo_browser_supervision: decision.reason },
    response_metadata: source.response_metadata,
    ...(source.artifact === undefined ? {} : { artifact: source.artifact as unknown }),
    ...(source.status === undefined ? {} : { status: source.status }),
  });
  if (source.id) projected.id = source.id;
  const next = [...messages];
  next[index] = projected;
  return { messages: next, projected: true };
}

/**
 * The full scanned Computer Use result is durable host diagnostics, not prompt
 * content. Strip that exact sidecar from provider-bound clones while leaving
 * checkpoint messages untouched. The compact text and any vision image part
 * remain available to the model.
 */
function stripHostOnlyComputerResultSidecars(messages: BaseMessage[]): BaseMessage[] {
  return messages.map((message) => {
    if (!(message instanceof ToolMessage)) return message;
    const kwargs = message.additional_kwargs ?? {};
    if (!(COMPUTER_RESULT_DURABLE_SIDECAR_KEY in kwargs)) return message;
    const { [COMPUTER_RESULT_DURABLE_SIDECAR_KEY]: _hostOnly, ...providerKwargs } = kwargs;
    const clone = new ToolMessage({
      content: message.content,
      tool_call_id: message.tool_call_id,
      ...(message.name !== undefined ? { name: message.name } : {}),
      additional_kwargs: providerKwargs,
      response_metadata: message.response_metadata,
      ...(message.artifact !== undefined ? { artifact: message.artifact as unknown } : {}),
      ...(message.status !== undefined ? { status: message.status } : {}),
    });
    if (message.id) clone.id = message.id;
    return clone;
  });
}

function collectSkillNamesAlreadyInContext(
  messages: BaseMessage[],
  skillNames: readonly string[],
): Set<string> {
  if (skillNames.length === 0) return new Set();
  const found = new Set<string>();
  for (const msg of messages) {
    const text = flattenContentToString(msg.content);
    for (const name of skillNames) {
      if (text.includes(`${SKILL_BODY_HEADER_PREFIX}${name}\n`)) {
        found.add(name);
      }
    }
  }
  return found;
}

/**
 * — eject eviction. A skill body pulled by `view_skill` lives on
 * as that tool's result message. When the agent later `eject`s the skill, its
 * name leaves `engagedSkillNames`; on the next rebuild we collapse the lingering
 * body to a one-line tombstone so it actually leaves context (the agent's "get
 * it out of my context" model) — while keeping the `view_skill` tool-call/result
 * pairing intact (content swap only, never a RemoveMessage that would orphan the
 * call and trip message-invariants). Idempotent: a tombstoned message no longer
 * starts with the skill-body header, so it is never rewritten twice.
 */
function tombstoneEjectedSkillBodies(
  messages: BaseMessage[],
  engagedNames: readonly string[],
): BaseMessage[] {
  const engaged = new Set(engagedNames);
  let changed = false;
  const next = messages.map((msg) => {
    if (!ToolMessage.isInstance(msg) || msg.name !== "view_skill") return msg;
    const text = flattenContentToString(msg.content);
    if (!text.startsWith(SKILL_BODY_HEADER_PREFIX)) return msg;
    const name = /^## Skill: (.+)$/m.exec(text)?.[1]?.trim();
    if (!name || engaged.has(name)) return msg;
    changed = true;
    return cloneMessageWithContent(
      msg,
      `[skill "${name}" ejected — pull again with view_skill if you need it]`,
    );
  });
  return changed ? next : messages;
}

function latestHumanMessageIndex(messages: BaseMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] instanceof HumanMessage) return i;
  }
  return -1;
}

export function resolveTurnIntentPack(messages: BaseMessage[]) {
  const index = latestHumanMessageIndex(messages);
  return resolveIntentPacks(
    index >= 0 ? flattenContentToString(messages[index]?.content) : "",
  );
}

function cloneMessageWithContent(msg: BaseMessage, content: unknown): BaseMessage {
  const base = {
    content,
    additional_kwargs: msg.additional_kwargs,
    response_metadata: msg.response_metadata,
  };
  let cloned: BaseMessage;
  if (msg instanceof HumanMessage) cloned = new HumanMessage(base as ConstructorParameters<typeof HumanMessage>[0]);
  else if (msg instanceof SystemMessage) cloned = new SystemMessage(base as ConstructorParameters<typeof SystemMessage>[0]);
  else if (AIMessage.isInstance(msg)) {
    cloned = new AIMessage({
      ...base,
      ...(msg.tool_calls?.length ? { tool_calls: msg.tool_calls } : {}),
    } as ConstructorParameters<typeof AIMessage>[0]);
  } else if (ToolMessage.isInstance(msg)) {
    cloned = new ToolMessage({
      content,
      tool_call_id: msg.tool_call_id,
      ...(msg.name ? { name: msg.name } : {}),
    } as ConstructorParameters<typeof ToolMessage>[0]);
  } else {
    return msg;
  }
  if (msg.id) cloned.id = msg.id;
  return cloned;
}

export function sanitizeImagesForModel(messages: BaseMessage[], modelId: string): { messages: BaseMessage[]; stripped: number } {
  const supportsImage = mcSupportsInput(modelId, "image");
  const supportsFile = mcSupportsInput(modelId, "file");
  if (supportsImage && supportsFile) return { messages, stripped: 0 };

  const currentHumanIndex = latestHumanMessageIndex(messages);
  let stripped = 0;
  const sanitized = messages.map((msg, index) => {
    if (!Array.isArray(msg.content) || !hasMultimodalToolContent(msg.content)) return msg;

    const mustStripImage = !supportsImage && hasImageContent(msg.content);
    const mustStripPdf = !supportsFile && hasPdfDocumentContent(msg.content);
    if (!mustStripImage && !mustStripPdf) return msg;

    if (index === currentHumanIndex && (mustStripImage || mustStripPdf)) {
      const kind = !supportsImage && !supportsFile ? "image or PDF" : !supportsImage ? "image" : "PDF";
      throw new Error(
        `Selected model ${modelId} does not support ${kind} inputs. Switch to a multimodal-capable model.`,
      );
    }

    const nextContent = msg.content.map((block) => {
      if (mustStripImage && isImageContentBlock(block)) {
        stripped += 1;
        return {
          type: "text",
          text: "[Historical image omitted because the selected model does not support image inputs.]",
        };
      }
      if (mustStripPdf && isPdfDocumentContentBlock(block)) {
        stripped += 1;
        return {
          type: "text",
          text: "[Historical PDF omitted because the selected model does not support PDF inputs.]",
        };
      }
      return block;
    });
    return cloneMessageWithContent(msg, nextContent);
  });

  return { messages: sanitized, stripped };
}

/**
 * OpenAI accepts image/PDF inputs on user-role messages, while tool/function
 * result payloads are text-oriented (standard file blocks are serialized as
 * JSON and cease to be documents). Keep the required AI→Tool pairing intact,
 * then add a non-persisted HumanMessage carrying the exact scanned tool bytes
 * for the following model invocation. Other providers retain their native
 * multimodal ToolMessage behavior.
 */
export function projectOpenAIMultimodalToolResults(
  messages: BaseMessage[],
  modelId: string,
): BaseMessage[] {
  if (!usesOpenAICompatibleChatTransport(modelId)) return messages;

  const projected: BaseMessage[] = [];
  const attachments: HumanMessage[] = [];
  for (const message of messages) {
    // All results in a parallel tool cycle must precede a user-role message.
    if (!ToolMessage.isInstance(message)) projected.push(...attachments.splice(0));
    if (!ToolMessage.isInstance(message) || !Array.isArray(message.content) || !hasMultimodalToolContent(message.content)) {
      projected.push(message);
      continue;
    }

    const text = message.content
      .filter((block): block is { type: "text"; text: string } =>
        typeof block === "object" && block !== null &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string")
      .map((block) => block.text)
      .join("\n");
    const pairedToolMessage = new ToolMessage({
      content: text || "The tool returned multimodal content for the next model step.",
      tool_call_id: message.tool_call_id,
      ...(message.name ? { name: message.name } : {}),
      additional_kwargs: message.additional_kwargs,
      response_metadata: message.response_metadata,
      ...(message.status !== undefined ? { status: message.status } : {}),
      ...(message.artifact !== undefined ? { artifact: message.artifact as unknown } : {}),
    });
    if (message.id) pairedToolMessage.id = message.id;

    const openAIContent = message.content.filter((block) =>
      !(typeof block === "object" && block !== null &&
        (block as Record<string, unknown>)["type"] === "text" &&
        typeof (block as Record<string, unknown>)["text"] === "string"),
    ).map((block) => {
      if (typeof block !== "object" || block === null) return block;
      const record = block as Record<string, unknown>;
      if (
        record["type"] === "file" &&
        record["source_type"] === "base64" &&
        typeof record["data"] === "string"
      ) {
        const mimeType = typeof record["mime_type"] === "string"
          ? record["mime_type"]
          : "application/octet-stream";
        const filename = typeof record["filename"] === "string" && record["filename"].trim()
          ? record["filename"]
          : mimeType === "application/pdf" ? "document.pdf" : "document.bin";
        return {
          type: "input_file",
          file_data: `data:${mimeType};base64,${record["data"]}`,
          filename,
        };
      }
      return block;
    });
    projected.push(pairedToolMessage);
    attachments.push(new HumanMessage({
      content: [
        { type: "text", text: `Attachments from tool call ${message.tool_call_id}${message.name ? ` (${message.name})` : ""}. The tool result contains their text context.` },
        ...openAIContent,
      ],
      additional_kwargs: { nautilo_multimodal_tool_projection: true },
    }));
  }
  projected.push(...attachments);
  return projected;
}

export async function preModelNode(
  state: NautiloState,
  _invocationConfig?: RunnableConfig,
  recallRecordsPortForState?: RecallRecordsPortForState,
  assignedVoicesPortForState: AssignedVoicesPortForState = getVoices,
  fullEncryptionOnly = false,
  ordinaryContentAccessForState?: OrdinaryContentAccessForState,
): Promise<Partial<NautiloState>> {
  if (state.noProgressPendingStop) throw new NoProgressError(state.noProgressPendingStop);
  assertResearchDesktopAvailable(state);
  const config = fromRuntimeConfig();
  const ordinaryContentAccessContext = await ordinaryContentAccessToolContextForState(state, ordinaryContentAccessForState);
  const configuredModelId = state.model || config.nautilo_model;
  // Explicit selections are enforced at the mutation and model-invocation
  // boundaries. This node only needs the ID to project model capabilities;
  // re-validating here would make harmless preprocessing require credentials.
  const requestedModelId = modelIdForCapabilityProjection("chat", configuredModelId);

  const isGuest = state.actorRole === "guest";
  const initiatingClientSurface = getCurrentInitiatingClientSurface();
  // Relay capability snapshots enter with the Human message, but Let Genie
  // drive can happen while that turn is already running. Re-read only this
  // transient presence signal at every model step so the continuation after
  // a fenced run_shell receives terminal immediately. Execution authority and
  // the exact PTY remain Electron-local.
  const relayRegistry = getRelayRegistry();
  const capabilitiesAtModelStep = relayRegistry === null
    ? state.relayCapabilities
    : reconcileLiveTerminalHandoffCapabilities(
        state.relayCapabilities,
        buildRuntimeCapabilityTokens(relayRegistry, state.userId, state.agentId),
      );
  const relayCapabilities = capabilitiesAtModelStep;
  // refresh from the connected-app runtime at every model step. The
  // checkpointed snapshot feeds every later resolver in this graph step; a
  // concurrent disconnect is still rejected by the execution-time profile
  // check inside ConnectedAppService.
  const connectedAppProviderIds = await connectedAppEligibleProviderIdsForContext({
    userId: state.userId,
    memoryAccessEnvelope: state.memoryAccessEnvelope,
  });

  // Evict ejected skill bodies before assembling this turn.
  // Persisted back via the `messages` return so the eviction is durable.
  const turnMessages = isGuest
    ? state.messages
    : tombstoneEjectedSkillBodies(
      state.messages,
      state.engagedSkillNames ?? [],
    );

  const catalog = getToolCatalog();
  const recallRecordsContext = recallRecordsToolContextForState(
    state,
    recallRecordsPortForState?.(state),
  );
  const activeModelCapabilities = (["image", "file"] as const).filter(
    (capability) => mcSupportsInput(requestedModelId, capability),
  );
  const intentPack = resolveTurnIntentPack(turnMessages);
  // Intent packs are an owner convenience. Guest turns deliberately retain
  // the core-only selection: automatic activation must not leave an
  // actor-dependent name in a shared-thread checkpoint.
  const intentPackToolNames = isGuest
    ? []
    : expandToolFamilies(intentPack.families);
  // a resolved focus entry with a `file` target is already an
  // authorized, model-facing pointer. Make only `file` eligible for this
  // turn so the model can follow the focused-resource manifest without
  // widening to the rest of the filesystem family. The normal catalog
  // eligibility projection below still applies all policy/runtime gates.
  const focusedResourceToolNames = isGuest
    ? []
    : resolveFocusedResourceToolActivations(state.focusedResources);
  if (intentPack.reasons.length > 0) {
    log(`[nautilo/pre_model] intent-pack candidates=${intentPack.reasons.join(",")}`);
  }
  if (focusedResourceToolNames.length > 0) {
    log("[nautilo/pre_model] focused-resource candidates=file");
  }
  // skill metadata may name an authorized deferred dependency, but
  // must not cause its schema to be constructed or bound for this model step.
  // Resolve the same policy/runtime/whitelist/model-capability ceiling from
  // catalog metadata only; `resolveProgressiveTools` below remains the sole
  // binding path.
  const eligibleToolNames = catalog
    ? catalog
        .getFiltered(
          toolPolicyWithRecallRecordsAvailability(
            state.memoryAccessEnvelope?.toolPolicy,
            recallRecordsContext,
          ),
          relayCapabilities ?? undefined,
          {
            readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
            context: {
              turnId: state.turnId,
              fullEncryptionOnly,
              connectedAppProviderIds,
              deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
            },
          },
        )
        .entries
        .filter((entry) =>
          (!state.toolWhitelist || state.toolWhitelist.includes(entry.name)) &&
          !entry.requiredModelCapabilities?.some(
            (capability) => !activeModelCapabilities.includes(capability),
          ),
        )
        .map((entry) => entry.name)
    : [];
  const eligibleToolNameSet = new Set(eligibleToolNames);
  // Normalize before prompt/schema construction. Existing checkpoint names
  // may belong to a previous actor on this shared thread; discard those which
  // are not currently eligible, then admit intent names only into remaining
  // capacity. This exact selection is persisted for the following agent node.
  const selectedCheckpointNames = selectedActivatedToolNamesForActor(
    state.actorRole,
    state.activatedToolNames,
  );
  const discoverableEligibleToolNameSet = new Set(
    eligibleToolNames.filter((name) => catalog?.get(name)?.exposure === "discoverable"),
  );
  const turnId = state.turnId ?? "";
  const hasForegroundTurnId = turnId.trim().length > 0;
  const leaseTransition = !isGuest && hasForegroundTurnId
    ? advanceActivatedToolLeases({
        // Legacy checkpoint names are only safe migration candidates after
        // current eligibility and discoverable exposure have both been proven.
        names: state.activationLeasesInitialized
          ? selectedCheckpointNames
          : normalizeEligibleActivatedToolNames(
              selectedCheckpointNames,
              discoverableEligibleToolNameSet,
            ),
        leases: state.activatedToolLeases,
        initialized: state.activationLeasesInitialized,
        agedForTurnId: state.activationLeasesAgedForTurnId ?? "",
        turnId,
        retentionTurns: config.nautilo_tool_activation_retention_turns,
      })
    : null;
  // The transition preserves same-turn mutations while pruning any lease made
  // over-age by a live config reduction. On a new owner foreground turn it
  // instead rebuilds the projection from the surviving leases.
  const currentTurnNames = leaseTransition?.names ?? selectedCheckpointNames;
  const retainedActivatedToolNames = normalizeEligibleActivatedToolNames(
    currentTurnNames,
    eligibleToolNameSet,
  );
  const intentAlreadyApplied = hasForegroundTurnId &&
    state.activationIntentAppliedForTurnId === turnId;
  // A focused file pointer is the concrete resource the model was asked to
  // discuss. It must win the bounded current-turn projection over optional
  // retained activations; otherwise a full retained set could render the
  // pointer unusable. It remains only a current-turn selection: lease writes
  // below still come solely from `leaseTransition`.
  const prioritizedActivationBase = focusedResourceToolNames.length > 0
    ? [...focusedResourceToolNames, ...retainedActivatedToolNames]
    : retainedActivatedToolNames;
  const ordinaryActivatedToolNames = !isGuest && !intentAlreadyApplied
    ? mergeEligibleActivatedToolNames(
        prioritizedActivationBase,
        intentPackToolNames,
        eligibleToolNameSet,
      )
    : retainedActivatedToolNames;
  // Let Genie drive is an explicit local authority event, not model intent.
  // Whenever its presence-only relay token is live, bind `terminal` on this
  // very model step even if the progressive intent pack was already applied.
  // Normal catalog eligibility still enforces actor policy + live PTY relay.
  const activatedToolNames = !isGuest && relayCapabilities?.["hasPendingTerminalHandoff"] === true
    ? mergeEligibleActivatedToolNames(
        ordinaryActivatedToolNames,
        ["terminal"],
        eligibleToolNameSet,
      )
    : ordinaryActivatedToolNames;
  const applyPatchContext = buildApplyPatchToolContext({
    ownerId: state.userId,
    actorRole: state.actorRole,
    agentId: state.agentId,
    turnId: state.turnId,
    roomId: state.roomId,
    memoryAccessEnvelope: state.memoryAccessEnvelope,
    currentFolder: state.currentFolder ?? "",
    currentFolderRelayId: state.currentFolderRelayId ?? "",
    focusedResources: state.focusedResources ?? [],
  }, { relayRegistry: getRelayRegistry() });
  const progressiveResolution = catalog
    ? resolveToolsForExposure(catalog, config.nautilo_tool_exposure_mode, {
        context: {
          ...ordinaryContentAccessContext,
          deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
          ownerId: state.userId,
          personaId: state.personaId,
          currentThreadId: state.currentThreadId,
          actorRole: state.actorRole,
          memoryAccessEnvelope: state.memoryAccessEnvelope,
          userId: state.userId,
          liveMiniAppSession: effectiveLiveMiniAppSessionForState(state),
          auditActorId: state.memoryAccessEnvelope?.actorId ?? null,
          securityAuditClientMeta: state.securityAuditClientMeta,
          currentFolder: state.currentFolder,
          workspacePath: state.workspacePath,
          userTimezone: state.userTimezone,
          agentId: state.agentId,
          roomId: state.roomId,
          callingRoomId: state.callingRoomId,
          turnId,
          turnContextId: turnContextKey(turnId, state.agentId ?? ""),
          subagentDepth: state.subagentDepth,
          subagentMaxDepth: state.subagentMaxDepth,
          roomRoster: state.roomRoster,
          activeModelId: requestedModelId,
          relayCapabilities,
          // Keep the authoritative manifest available to context-aware tool
          // factories (for example ask_peer's focused Artifact handoff).
          focusedResources: state.focusedResources ?? [],
          connectedAppProviderIds,
          activatedToolNames: selectedActivatedToolNamesForActor(state.actorRole, activatedToolNames),
          readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
          activeModelCapabilities,
          toolWhitelist: state.toolWhitelist,
          trustedExecutionEntrypoint: state.trustedExecutionEntrypoint,
          verifiedOrdinaryOrigin: state.verifiedOrdinaryOrigin,
          taskReportBackContinuation: state.taskReportBackContinuation,
          initiatingClientSurface,
          ...recallRecordsContext,
          ...applyPatchContext,
        },
        toolPolicy: state.memoryAccessEnvelope?.toolPolicy,
        relayCapabilities: relayCapabilities ?? undefined,
        readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
        activeModelCapabilities,
        toolNameWhitelist: state.toolWhitelist,
        activatedToolNames: selectedActivatedToolNamesForActor(state.actorRole, activatedToolNames),
        fullEncryptionOnly,
        intentPackToolNames: [],
      })
    : null;
  const rawTools = progressiveResolution?.tools ?? [];
  // `skip` is the sole yield tool (targetless silence OR
  // one-hop redirect via `target_handle`). The explicit-picker withhold
  // stays; targetless skip is always valid and redirect eligibility is
  // enforced server-side.
  const consolidating = isResearchPreEvictionConsolidating(state);
  const availableTools = withholdSkipForExplicitSelection(rawTools, state.explicitlySelected);
  const tools = projectSecurityResearchConsolidationTools(availableTools, consolidating);
  const progressiveToolExposure = measureProgressiveToolExposure({
    registeredCatalogTools: catalog?.size ?? 0,
    eligibleEntries: progressiveResolution?.eligible.entries ?? [],
    exclusionReasons: (progressiveResolution?.snapshot.exclusions ?? []).map(
      (exclusion) => exclusion.reason,
    ),
    activatedToolNames: selectedActivatedToolNamesForActor(state.actorRole, activatedToolNames),
    activatedToolLeases: isGuest
      ? []
      : leaseTransition?.leases ?? state.activatedToolLeases ?? [],
    intentPackToolNames: selectIntentPackToolsForTelemetry(
      intentPackToolNames,
      selectedActivatedToolNamesForActor(state.actorRole, activatedToolNames),
    ),
    tools,
  });

  // the STABLE system prefix (base prompt + tool guidance) is captured
  // separately so we can cache it (see systemMessage construction below).
  // Everything appended after this point is per-turn-volatile to varying
  // degrees (time, memory, notifications) and stays OUT of the cached span.
  const stableSystemPrefix = buildSystemPrompt({
    assistantName: state.assistantName || "Genie",
    tools,
    isGuest,
    explicitlySelected: state.explicitlySelected,
  }) + activeComputerUseModelGuidanceForBoundTools(tools);
  let systemPrompt = stableSystemPrefix;

  if (
    !isGuest &&
    tools.some(
      (tool) =>
        tool.name === "read_connected_web_account" ||
        tool.name === "act_connected_web_account",
    )
  ) {
    const connectedWebAccounts = await listConnectedWebAccountCapabilities({
      userId: state.userId,
      agentId: state.agentId,
      roomId: state.roomId,
      callingRoomId: state.callingRoomId ?? null,
      memoryAccessEnvelope: state.memoryAccessEnvelope ?? undefined,
    });
    systemPrompt += buildConnectedWebAccountCapabilityBlock(connectedWebAccounts);
  }

  // Exact client surface is process-local and varies per accepted turn, so it
  // must stay outside the cached stable prefix.
  systemPrompt += buildInitiatingClientSurfaceGuidance(initiatingClientSurface);

  if (
    !isGuest &&
    relayCapabilities?.["hasPendingTerminalHandoff"] === true &&
    tools.some((tool) => tool.name === "terminal")
  ) {
    systemPrompt += buildPendingTerminalHandoffBlock();
  }

  // owner-only `## Current time` block: local time + day + IANA tz +
  // UTC offset, the UTC ISO timestamp, and the bucketed "last user message in
  // this room" line. Guests deliberately skip it (no room/owner context).
  const promptTurnId = typeof state.turnId === "string" ? state.turnId.trim() : "";
  const priorPromptTimeReference = state.promptTimeReference;
  const canReusePromptTime = promptTurnId.length > 0
    && priorPromptTimeReference?.turnId === promptTurnId
    && Number.isFinite(priorPromptTimeReference.nowMs);
  const promptNowMs = canReusePromptTime
    ? priorPromptTimeReference.nowMs
    : Date.now();
  const promptTimeReference = !isGuest && promptTurnId.length > 0
    ? { turnId: promptTurnId, nowMs: promptNowMs }
    : null;
  if (!isGuest) {
    systemPrompt += buildTimeContextBlock({
      nowMs: promptNowMs,
      userTimezone: state.userTimezone || "UTC",
      previousUserMessageAt: state.previousUserMessageAt,
    });
    if (promptTimeReference) {
      systemPrompt += "\nTime reference: captured at the start of this turn; it does not advance during tool calls.";
    }
  }

  // inject the room participant roster before the soul file so
  // the agent knows who it's talking to (and, in future iterations,
  // which other participants are present). Guest turns skip — they
  // have no room context and the roster is empty by construction.
  if (!isGuest && state.roomRoster && state.roomRoster.length > 0) {
    const lines = state.roomRoster
      .map((p) => {
        const adminTag = p.roomRole === "admin" ? ", admin" : "";
        // show each participant's @handle and mark the CURRENT agent
        // as "you". Multi-agent rooms can hold two bots that share a display
        // name (e.g. both "Genie"); without the handle + self-marker a woken
        // bot can't tell which @mention is itself and wrongly `skip`s when
        // addressed by its own handle. See .
        const handleTag = p.handle ? ` @${p.handle}` : "";
        const isSelf =
          p.kind === "agent" && !!state.agentId && p.agentId === state.agentId;
        const youTag = isSelf ? " — this is you" : "";
        // Multi-Human Rooms need the same explicit current-participant marker
        // humans naturally get from a 1:1 chat. The live HumanMessage is kept
        // separate from the labelled transcript, so bind its author here from
        // trusted ingress state instead of asking the model to infer a speaker.
        const isCurrentSpeaker =
          p.kind === "user" &&
          !!state.causalHumanUserId &&
          p.userId === state.causalHumanUserId;
        const currentSpeakerTag = isCurrentSpeaker
          ? " — current speaker; authored the final user message"
          : "";
        return `- ${p.displayName}${handleTag} (${p.kind}${adminTag})${youTag}${currentSpeakerTag}`;
      })
      .join("\n");
    systemPrompt += ROOM_PARTICIPANTS_HEADER + lines;
  }

  if (!isGuest && state.soulFile) {
    const soulFile =
      state.soulFile.length > config.nautilo_soul_char_limit
        ? `${state.soulFile.slice(0, config.nautilo_soul_char_limit)}\n\n[truncated]`
        : state.soulFile;
    systemPrompt += SOUL_FILE_HEADER + soulFile;
  }

  // catalog-only + engaged-set re-injection (guest-withheld).
  // Prompt text only — never mutates memoryAccessEnvelope / toolPolicy .
  const enabledSkills = state.skills ?? [];
  if (!isGuest && enabledSkills.length > 0) {
    const toolNames = tools.map((t) => t.name);
    const availableToolNames = new Set(toolNames);
    const alreadyInContext = collectSkillNamesAlreadyInContext(
      turnMessages,
      enabledSkills.map((s) => s.name),
    );
    const { catalog } = selectSkillsForTurn({
      skills: enabledSkills,
      availableToolNames: toolNames,
      eligibleToolNames,
    });
    const catalogBlock = buildAvailableSkillsBlock(catalog);
    if (catalogBlock) systemPrompt += catalogBlock;

    const skillByName = new Map(enabledSkills.map((s) => [s.name, s]));
    for (const name of state.engagedSkillNames ?? []) {
      const skill = skillByName.get(name);
      if (!skill || !requiresToolsMet(skill, availableToolNames)) continue;
      if (alreadyInContext.has(name)) continue;
      systemPrompt += buildSkillBodyBlock(skill);
    }
  }

  // two-path file-surface block. Omitted entirely if
  // both paths are empty (guest turns, legacy pre-Phase-2 callers).
  // When only `currentFolder` or only `workspacePath` is set, only
  // that sub-block appears. Guest sessions have both empty by
  // construction (no workspace access without identity; no folder
  // context picked up in guest mode), so this is a no-op for them.
  if (!isGuest) {
    const twoPathBlock = buildTwoPathBlock({
      currentFolder: state.currentFolder ?? "",
      workspacePath: state.workspacePath ?? "",
      securityResearchReadOnly: state.toolWhitelist?.includes("security_scan") === true,
    });
    if (twoPathBlock) systemPrompt += twoPathBlock;
    const activeMiniAppBlock = buildActiveMiniAppBlock(state.activeMiniApp);
    if (activeMiniAppBlock) systemPrompt += activeMiniAppBlock;
    const liveMiniAppSessionBlock = buildLiveMiniAppSessionBlock(
      effectiveLiveMiniAppSessionForState(state),
      { backgroundTask: state.trustedExecutionEntrypoint === "background.task" },
    );
    if (liveMiniAppSessionBlock) systemPrompt += liveMiniAppSessionBlock;
    // quote-reply pointer. The reply FK rides on the latest human
    // HumanMessage's `additional_kwargs.nautilo_reply_to_message_id` (set
    // by `buildForegroundUserHumanMessage`). We inject a LIGHTWEIGHT
    // POINTER (id + optional ≤80-char snippet/author) — NEVER the
    // replied-to message's full body — so the model has the cue without
    // re-reading bytes already in history (or off-screen for a long
    // thread). Snippet/author enrichment would require a
    // room-message-by-id DB read the agent package doesn't own; v1
    // ships id-only and leaves snippet-enrichment as a TRACKED
    // deferral (see the stack-126 done-report). The latest-human
    // lookup reuses the same helper the modality sanitizer uses.
    const replyHumanIdx = latestHumanMessageIndex(turnMessages);
    if (replyHumanIdx >= 0) {
      const replyHuman = turnMessages[replyHumanIdx];
      if (HumanMessage.isInstance(replyHuman)) {
        const rawReplyId = (replyHuman.additional_kwargs ?? {})["nautilo_reply_to_message_id"];
        if (typeof rawReplyId === "number" && Number.isInteger(rawReplyId) && rawReplyId >= 0) {
          systemPrompt += buildReplyPointerBlock({ replyToMessageId: rawReplyId });
        }
      }
    }
    // Match createFileTool's server-owned security research read-only ceiling.
    // Exposing file reads does not authorize edit or artifact-creation guidance.
    if (tools.some((t) => t.name === "file") && !state.toolWhitelist?.includes("security_scan")) {
      systemPrompt += buildFileEditsBlock();
      systemPrompt += HTML_WORKSPACE_RICH_ARTIFACT_PROMPT;
    }
  }

  if (state.voiceMode) {
    systemPrompt += VOICE_MODE_PROMPT;
    if (!isGuest && state.agentId) {
      const assignedVoices = await assignedVoicesPortForState(state.agentId).catch(() => ({}));
      systemPrompt += buildAssignedVoicesPrompt(assignedVoices);
    }
  }

  if (!isGuest && state.memoryBrief) {
    systemPrompt += MEMORY_BRIEF_HEADER + state.memoryBrief;
  }

  if (!isGuest && state.memoryDelta) {
    systemPrompt += MEMORY_DELTA_HEADER + state.memoryDelta;
  }

  if (!isGuest) {
    // ONE authoritative focused-resource manifest. Keep this
    // volatile, turn-specific UI context at the tail of the normal system
    // prompt so it remains salient after the larger generic file-authoring
    // instructions and persistent memory blocks. When the server resolved a
    // manifest, it subsumes legacy artifact refs; old checkpoints and direct
    // executor callers retain the legacy fallback.
    const focusedResourcesBlock = buildFocusedResourcesBlock(state.focusedResources);
    if (focusedResourcesBlock) {
      systemPrompt += focusedResourcesBlock;
    } else {
      const artifactRefsBlock = buildArtifactRefsBlock(state.artifactRefs);
      if (artifactRefsBlock) systemPrompt += artifactRefsBlock;
    }
  }

  // drain session_notifications for this (threadId,
  // agentId) pair and, if non-empty, append a one-shot "Since your
  // last turn" block to the system prompt. The drain is a
  // best-effort DB call: a failure logs a warning (helper-internal)
  // and returns []; we never block the turn on notifications. The
  // block is intentionally appended AFTER memory-brief / memory-
  // delta so the agent reads the most-recent feedback last — LLMs
  // attend to the tail of the system message more heavily than the
  // middle, and rejections are the most load-bearing piece of
  // information for the next turn's tool-planning.
  if (!isGuest && state.langgraphThreadId && state.agentId && !state.subagentRun) {
    try {
      const notifications = await drainSessionNotifications(
        state.langgraphThreadId,
        state.agentId,
      );
      const block = buildSessionNotificationsBlock(notifications);
      if (block) {
        systemPrompt += "\n\n" + block + "\n";
        log(
          `[pre-model] injected ${notifications.length} session-notification(s) for thread=${state.langgraphThreadId} agent=${state.agentId}`,
        );
      }
    } catch (err) {
      // Belt-and-suspenders — the helper catches and swallows, but
      // any upstream DB-pool exhaustion could still throw. Drop
      // the block, keep the turn alive.
      const msg = err instanceof Error ? err.message : String(err);
      log(
        `[pre-model] session-notifications drain failed (turn proceeds without injection): ${msg}`,
      );
    }
  }

  const researchContinuity = state.subagentRun === true
    && state.toolWhitelist?.includes("security_scan") === true;
  if (researchContinuity) systemPrompt += "\n\n" + SECURITY_RESEARCH_WORKFLOW;
  if (researchContinuity) {
    const roleMessage = buildResearchWorkContextMessage({ ...state, messages: turnMessages });
    if (roleMessage) systemPrompt += "\n\n" + roleMessage;
  }
  const canManageMemory = state.toolWhitelist === undefined || state.toolWhitelist === null
    || state.toolWhitelist.includes("manage_memory");
  let compactionHint: SystemMessage | null = null;

  if (!isGuest) {
    const tokenBudget = Math.floor(getModelTokenLimit(requestedModelId) * config.nautilo_token_budget_fraction);
    const currentTokens = estimateTokenCount(state.messages);
    if (currentTokens > tokenBudget * 0.8) {
      compactionHint = new SystemMessage(
        researchContinuity
          ? `[RESEARCH CHECKPOINT] Context is filling. Before further investigation, use security_scan record ` +
            `to persist all unsaved material notes, traced flows, protections, unresolved work, and source references, ` +
            `then save a checkpoint with nextWork and openRecordIds. Earlier tool cycles can leave the model ` +
            `window only after that durable checkpoint is accepted. Continue the same scan; do not summarize ` +
            `away unfinished work or use unavailable memory tools.`
          : `[MEMORY SAVE] Your conversation context is getting long and will soon be trimmed. ` +
            (canManageMemory ? `Use manage_memory to save any important information you haven't saved yet.`
              : `Preserve important information using the durable tools available to this Task.`),
      );
    }
  }

  // no-progress breaker: inject exactly ONE corrective
  // instruction into this model turn when the tools node flagged a failure
  // streak that hit the repeated-failure limit . The flag is set by the
  // tools node and consumed + cleared here so the corrective turn happens
  // exactly once, between the limit-failure and the next identical failure
  // (which would map to a typed `no_progress` stop). The instruction is
  // generic — it names no tool, no args, no raw error — so no payload leaks
  // into the prompt; the model already has its own tool result in history.
  //
  // Appended to the volatile system-prompt suffix (NOT as a trailing
  // SystemMessage) so Anthropic's "system is the first message only"
  // contract stays satisfied — a late SystemMessage would be rejected by
  // the provider. Appended here (before `systemMessage` is built) so the
  // instruction rides the existing system message.
  const pendingCorrection = state.noProgressPendingCorrection ?? null;
  if (pendingCorrection !== null) {
    systemPrompt += "\n\n" + NO_PROGRESS_CORRECTIVE_INSTRUCTION + "\n";
    log("[nautilo/pre_model] no_progress corrective turn injected");
  }

  // Anthropic prompt caching. Split the single system string into a
  // cached STABLE block (byte-identical across turns) + an uncached VOLATILE
  // block, with an ephemeral `cache_control` breakpoint on the stable block.
  // The breakpoint caches the tool schemas too (tools precede system on the
  // Anthropic wire), which is the bulk of the prompt. Anthropic concatenates
  // system text blocks, so the model sees a byte-identical prompt — no turn
  // behavior change. Eligibility follows the parsed upstream family so an
  // Anthropic model routed through OpenRouter gets the same marker as a
  // direct Anthropic route. Other upstream families and transports without
  // this qualified extension (including Venice) keep the plain string.
  const volatileSystemSuffix = systemPrompt.slice(stableSystemPrefix.length);
  const useAnthropicCache =
    modelUsesAnthropicPromptCache(requestedModelId) &&
    stableSystemPrefix.length > 0;
  let systemMessage: SystemMessage;
  if (useAnthropicCache) {
    // `cache_control` is a valid Anthropic runtime field the LangChain
    // content-block types don't model yet; the adapter reads it off the text
    // block. Width-subtyping keeps this assignable without a cast.
    const content = [
      {
        type: "text" as const,
        text: stableSystemPrefix,
        cache_control: { type: "ephemeral" as const },
      },
      ...(volatileSystemSuffix.length > 0
        ? [{ type: "text" as const, text: volatileSystemSuffix }]
        : []),
    ];
    systemMessage = new SystemMessage({ content });
  } else {
    systemMessage = new SystemMessage(systemPrompt);
  }

  const roleHistory = researchContinuity ? prepareResearchRoleHistory(state, turnMessages) : turnMessages;
  const llmMessages = roleHistory.filter((msg) => {
    if (msg instanceof AIMessage && msg.additional_kwargs?.["synthetic"]) return false;
    return true;
  });

  const historyConfig: HistoryConfig = {
    validationEnabled: config.nautilo_history_validation_enabled,
    pruningEnabled: config.nautilo_history_pruning_enabled,
    tokenBudgetFraction: config.nautilo_token_budget_fraction,
    windowKeepRecent: config.nautilo_window_keep_recent,
    modelId: requestedModelId,
    researchContinuity,
    nativeHistoryAvailable: tools.some(tool => tool.name === "computer_observe")
      && (state.nativeDecision?.unresolved.length ?? 0) === 0,
  };

  const processedHistory = processHistory(llmMessages, historyConfig);

  if (researchContinuity && estimateTokenCount(processedHistory.messages)
    <= Math.floor(getModelTokenLimit(requestedModelId) * config.nautilo_token_budget_fraction) * 0.8) {
    compactionHint = null;
  }
  if (processedHistory.windowing.researchReloadRequired) {
    compactionHint = new SystemMessage(
      `[RESEARCH RELOAD] Earlier completed tool cycles were projected out after the accepted checkpoint ` +
      `retained below. The canonical transcript and scan ledger remain unchanged. Use the checkpoint as fallible ` +
      `saved notes. Reconcile its nextWork and openRecordIds with the active workspace objective, exact inventory ` +
      `and accepted records. Omitted earlier source is not necessarily unread, and prior claims still need evidence. ` +
      `When current work is unclear, use security_scan status for coverage and the latest checkpoint. Reload ` +
      `needed notes with results category=research, recordIds set to the relevant saved IDs, finalize=false. ` +
      `For a paged selection, use continueResults=true until nextCursor is null. Do not load the entire historical ` +
      `ledger into context; use recordKinds checkpoint/review_unit only if you need to discover the current plan. ` +
      `During active context recovery, follow its requiredAction and allowed operations first. ` +
      `After recovery, resume the active workspace objective; without workspace instructions, continue the original ` +
      `research brief. Re-read cited source when needed while the research ledger remains open. ` +
      `Do not restart scanners or infer that omitted work was completed.`,
    );
  } else if (!isGuest && !researchContinuity && processedHistory.windowing.removedCount > 0 && !compactionHint) {
    compactionHint = new SystemMessage(
      `[MEMORY FLUSH] ${processedHistory.windowing.removedCount} older messages were removed from context. ` +
      (canManageMemory ? `Use manage_memory to save any important information from the remaining conversation.`
        : `Use the available durable tools to retain important information.`),
    );
  }

  if (processedHistory.windowing.researchConclusionsProjected) {
    const finalNotesHint = `[FINAL RESEARCH CONTEXT] Finalized pages were projected for synthesis to fit this configured context budget. ` +
      `Accepted finding and dismissal conclusions are retained whole when they fit; bulky indexes remain in the canonical review log. ` +
      `A contextProjection object is a disclosed model-window view, not a new tool receipt or additional proof of completeness. ` +
      `Never infer severity counts, absent findings or overall safety from the last page. Use the retained conclusion records ` +
      `and targeted recordIds retrieval when details are needed; do not reload the whole ledger. ` +
      `A projected latest page retains status, reportReady and nextCursor under finalPage. If its nextCursor is non-null, continue the original final pagination with the same arguments and continueResults:true. ` +
      (processedHistory.windowing.researchConclusionsOverview
        ? `The complete conclusion set does not fit this configured context budget. A recovery index replaces full conclusions in this window, with omissions disclosed. ` +
          `Label the final prose an overview, do not invent conclusions or severity counts, and state that the complete accepted review log is appended by the runtime. ` +
          `Retrieve relevant finalized notes using security_scan results category=research, recordIds:[one needed id], limit:1, finalize:false. ` +
          `Use recordKinds:[finding,dismissal], limit:1 and continueResults to page conclusions outside the index. Do not replay the oversized full page.`
        : `The runtime appends the full accepted review log independently of your narrative; distinguish your synthesis from that complete log.`);
    compactionHint = new SystemMessage((typeof compactionHint?.content === "string" ? compactionHint.content + "\n\n" : "") + finalNotesHint);
  }

  const controlSafeHistory = researchContinuity
    ? restoreResearchContextControlCycle({ ...state, messages: llmMessages }, processedHistory.messages) : processedHistory.messages;
  const researchOrigins = researchContinuity ? prepareResearchContextOrigins(state, controlSafeHistory) : null;
  const providerSafeHistory = stripHostOnlyComputerResultSidecars(researchOrigins?.messages ?? processedHistory.messages);
  const browserSupervisedHistory = projectBrowserHandoffForProvider(providerSafeHistory, state).messages;
  const normalizedHistory = normalizeMessagesForProvider(browserSupervisedHistory);
  const providerProjectedHistory = projectOpenAIMultimodalToolResults(
    normalizedHistory,
    requestedModelId,
  );
  const preparedBeforeModality = compactionHint
    ? [systemMessage, ...providerProjectedHistory, compactionHint]
    : [systemMessage, ...providerProjectedHistory];
  const modalitySafe = sanitizeImagesForModel(preparedBeforeModality, requestedModelId);
  // Direct OpenAI accepts system/developer messages in sequence. Moving a new
  // runtime handoff into the leading prompt invalidates the conversation cache.
  // Keep instruction authority and chronology; retain the compatibility fold
  // for routes whose handling of later system messages is not qualified here.
  const systemSafeMessages = projectSystemMessagesForProvider(modalitySafe.messages, requestedModelId);
  // Layer 3 — final safety net. Catches any duplicate
  // ToolMessage produced by mid-pipeline transforms
  // (normalize-for-provider, sanitize-images, or future
  // additions) that Layer 1 / Layer 2 can't see. Layer 3 in
  // history-manager already runs validation; this is the
  // belt-and-suspenders pass that runs AFTER the final
  // post-validation transforms too.
  //
  // Note: we call `validateMessageHistory` directly (not the
  // `finalSafetyNetPass` sugar wrapper) so we can log any repairs
  // it makes. In production the helper warns silently and continues,
  // but knowing WHICH downstream transform produced a duplicate is
  // essential observability for diagnosing future regressions in
  // this exact bug class. Without this log line, L3 silently
  // repairs the same bug class was filed against — with no
  // audit trail showing the safety net fired.
  const finalSafetyNetResult = validateMessageHistory(systemSafeMessages.messages);
  const preparedMessages = finalSafetyNetResult.messages;
  researchOrigins?.bind(preparedMessages);
  if (systemSafeMessages.collapsed > 0) {
    log(
      `[nautilo/pre_model] Collapsed ${systemSafeMessages.collapsed} non-leading SystemMessage(s) into the leading system prompt`,
    );
  }
  if (finalSafetyNetResult.repairs.length > 0) {
    log(
      `[nautilo/pre_model] final safety-net repairs (${finalSafetyNetResult.repairs.length}): ${finalSafetyNetResult.repairs.join("; ")}`,
    );
  }
  assertMessageInvariants(preparedMessages, "pre_model.before_llm");

  // the corrective instruction was already appended to the
  // system prompt above (before `systemMessage` was built). No further
  // message-level injection is needed.
  const modelTokenBudget = Math.floor((await resolveModelExecutionLimits(requestedModelId)).contextTokens * config.nautilo_token_budget_fraction);
  const maxPreparedMessageTokens = modelTokenBudget - estimateBoundToolTokens(tools);
  const consolidationMessageTokens = modelTokenBudget - estimateBoundToolTokens(projectSecurityResearchConsolidationTools(availableTools, true));
  const researchContext = researchContinuity && state.currentTaskId && state.currentTaskRunId
    ? budgetResearchContext(state, preparedMessages, maxPreparedMessageTokens, consolidationMessageTokens)
    : null;
  let finalResearchContext = researchContext;
  let finalTools = tools;
  let finalStableSystemPrefix = stableSystemPrefix;
  let finalMessageTokens = maxPreparedMessageTokens;
  const nextConsolidating = researchContext && isResearchPreEvictionConsolidating({ ...state, researchContextRecovery: researchContext.recovery });
  if (researchContext && consolidating !== nextConsolidating) {
    finalTools = projectSecurityResearchConsolidationTools(availableTools, nextConsolidating === true);
    finalStableSystemPrefix = buildSystemPrompt({ assistantName: state.assistantName || "Genie", tools: finalTools, isGuest, explicitlySelected: state.explicitlySelected })
      + activeComputerUseModelGuidanceForBoundTools(finalTools);
    finalMessageTokens = modelTokenBudget - estimateBoundToolTokens(finalTools);
    // Rebuild only the stable tool prefix without repeating preparation or
    // external reads. Resolved authority, protected volatile context (including
    // any one-shot payload) and normalized source history stay intact.
    const leading = preparedMessages[0];
    if (!leading || !SystemMessage.isInstance(leading)) throw new Error("Research preparation requires its leading system prompt");
    const firstBlock = Array.isArray(leading.content) ? leading.content[0] : undefined;
    const priorPrefix = typeof leading.content === "string" ? leading.content
      : firstBlock && typeof firstBlock === "object" && firstBlock.type === "text" && typeof firstBlock["text"] === "string" ? firstBlock["text"] : null;
    if (priorPrefix === null || !priorPrefix.startsWith(stableSystemPrefix)) throw new Error("Research preparation lost its known stable prefix");
    const replacement = finalStableSystemPrefix + priorPrefix.slice(stableSystemPrefix.length);
    const content = typeof leading.content === "string" ? replacement
      : leading.content.map((part, index) => index === 0 && typeof part === "object" && part.type === "text"
        ? { ...part, text: replacement } : part);
    const nextPrepared = [new SystemMessage({ ...leading, content }), ...preparedMessages.slice(1)];
    // Entry removes inapplicable tools/guidance and increases free workspace.
    // Exit carries nonempty exact recovery, so it cannot re-enter this phase.
    finalResearchContext = budgetResearchContext({ ...state, researchContextRecovery: researchContext.recovery }, nextPrepared, finalMessageTokens);
  }
  const finalPreparedMessages = finalResearchContext?.messages ?? preparedMessages;
  assertMessageInvariants(finalPreparedMessages, "pre_model.research_context");

  if (config.nautilo_log_tool_calls) {
    logProgressiveToolExposure(
      "pre_model",
      progressiveToolExposure,
      config.nautilo_tool_exposure_mode,
    );
    log(`[nautilo/pre_model] Prepared ${finalPreparedMessages.length} messages (original: ${state.messages.length})`);
    log(`[nautilo/pre_model] Message types: ${finalPreparedMessages.map((m) => m.constructor.name).join(", ")}`);
    if (processedHistory.validation.repairs.length > 0) {
      log(`[nautilo/pre_model] Validation repairs: ${processedHistory.validation.repairs.join("; ")}`);
    }
    if (processedHistory.windowing.removedCount > 0) {
      log(`[nautilo/pre_model] Windowing removed: ${processedHistory.windowing.removedCount}`);
    }
    if (modalitySafe.stripped > 0) {
      log(`[nautilo/pre_model] Stripped ${modalitySafe.stripped} historical image part(s) for ${requestedModelId}`);
    }
  }

  return {
    // Research compaction is a provider projection only. The state reducer
    // replaces this array, so returning the projected history here would erase
    // canonical notes/final pages needed for continuation and the report appendix.
    messages: researchContinuity ? state.messages : (processedHistory.canonicalMessages ?? processedHistory.messages),
    preparedMessages: finalPreparedMessages,
    taskReadPageBytes: taskReadResponseByteBudget(historyConfig, finalMessageTokens, finalPreparedMessages),
    taskReadPendingPages: pendingTaskReadPages(processedHistory.canonicalMessages ?? processedHistory.messages, finalPreparedMessages, state.taskReadPendingPages ?? []),
    researchContextRecovery: finalResearchContext?.recovery ?? null,
    researchContextPageBytes: finalResearchContext?.pageBytes ?? null,
    preparedStableSystemPrefixLength: finalStableSystemPrefix.length,
    promptTimeReference,
    toolNames: finalTools.map((t) => t.name),
    connectedAppProviderIds: [...connectedAppProviderIds],
    // consume the pending correction flag so the corrective
    // instruction is injected exactly once. Cleared on this turn; a later
    // identical failure (count = limit + 1) is what maps to `no_progress`.
    noProgressPendingCorrection: null,
    // Preserve the checkpointed streak state across the pre_model step (the
    // tools node owns writes; pre_model only reads + clears the pending flag).
    noProgressStreaks: state.noProgressStreaks ?? new Map<string, NoProgressStreakEntry>(),
    // Guests never persist automatic intent activation. Owner state is
    // replaced even without an intent pack so stale/unauthorized names cannot
    // survive for a later actor on this checkpoint.
    ...(!isGuest ? {
      activatedToolNames,
      activatedToolLeases: leaseTransition?.leases ?? normalizeActivatedToolLeases(state.activatedToolLeases),
      activationLeasesAgedForTurnId:
        leaseTransition?.agedForTurnId ?? state.activationLeasesAgedForTurnId ?? "",
      activationLeasesInitialized:
        leaseTransition?.initialized ?? state.activationLeasesInitialized === true,
      activationIntentAppliedForTurnId:
        hasForegroundTurnId ? turnId : state.activationIntentAppliedForTurnId ?? "",
    } : {}),
  };
}
