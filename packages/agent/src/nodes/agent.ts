import {
  foregroundModelControlPlanFromSnapshot,
  loadForegroundModelControlSnapshot,
} from "../config/foreground-model-controls";
export { buildForegroundModelControlPlan } from "../config/foreground-model-controls";
import { projectSecurityResearchConsolidationTools } from "../tools/security/security-scan";
import { budgetResearchContext, captureResearchContextPresentation, isResearchPreEvictionConsolidating } from "../tools/security/research-context-rollover";
import { taskReadResponseByteBudget, estimateTokenCount } from "../utils/history-manager";
import type { HumanMessage } from "@langchain/core/messages";
import type { RunnableConfig } from "@langchain/core/runnables";
import type { NautiloState } from "../agent/state";
import { causalHumanForExecution } from "../runtime/causal-human-context";
import { fromRuntimeConfig } from "@nautilo/config";
import {
  getCachedServerModelConfigRow,
  kickServerModelConfigRefresh,
} from "@nautilo/db";
import { log } from "@nautilo/logger";
import { getToolCatalog } from "@nautilo/catalog";
import { envelopeReadableNamespaces } from "@nautilo/trust";
import { modelSupportsInput } from "@nautilo/model-capabilities";
import { invokeChatModelWithFallback, resolvePreparedMessageBudget } from "../utils/chat-model-invocation";
import { runWithUsageContext } from "../usage/usage-context";
import { withholdSkipForExplicitSelection } from "./skip-gate";
import {
  logProgressiveToolExposure,
  resolveTurnIntentPack,
  resolveToolsForExposure,
} from "./pre-model";
import { measureProgressiveToolExposure } from "../tools/exposure/telemetry";
import { expandToolFamilies } from "../tools/exposure/manifest";
import { selectedActivatedToolNamesForActor } from "../tools/meta/activated-tools-handle";
import { turnContextKey } from "../runtime/turn-context";
import { buildApplyPatchToolContext } from "../tools/apply-patch/execution-router";
import { ordinaryContentAccessToolContextForState, type OrdinaryContentAccessForState } from "../runtime/ordinary-content-access";
import { getRelayRegistry } from "./tools";
import {
  modelIdForCapabilityProjection,
  resolveModelRole,
} from "../config/model-role-resolution";
import { hasStubModelForTests } from "../providers/stub-model-state";
import { getCurrentInitiatingClientSurface } from "../runtime/initiating-client-surface-context";
import { effectiveLiveMiniAppSessionForState } from "../runtime/live-mini-app-execution-context";
import { deepResearchReturnContextForState } from "../runtime/deep-research-return-context";
import {
  recallRecordsToolContextForState,
  type RecallRecordsPortForState,
} from "../tools/memory/recall-records";

export async function agentNode(
  state: NautiloState,
  invocationConfig?: RunnableConfig,
  recallRecordsPortForState?: RecallRecordsPortForState,
  fullEncryptionOnly = false,
  optionalResearchDraft?: HumanMessage,
  ordinaryContentAccessForState?: OrdinaryContentAccessForState,
): Promise<Partial<NautiloState>> {
  const config = fromRuntimeConfig();
  const configuredModelId = state.model || config.nautilo_model;
  const resolveModelOnlyRequestedModelId = () => hasStubModelForTests()
    ? modelIdForCapabilityProjection("chat", configuredModelId)
    : resolveModelRole("chat", {
        ...(configuredModelId ? { configuredId: configuredModelId } : {}),
      });
  const isForegroundTurn = (state.subagentDepth ?? 0) === 0;
  const foregroundSnapshot = isForegroundTurn && state.agentId
    ? state.foregroundModelControlSnapshot
      ?? await loadForegroundModelControlSnapshot(state.roomId ?? "", state.agentId)
    : undefined;
  const foregroundControls = foregroundSnapshot
    ? foregroundModelControlPlanFromSnapshot(foregroundSnapshot, resolveModelOnlyRequestedModelId)
    : undefined;
  const selectedModelId = foregroundControls?.initialModelId ?? resolveModelOnlyRequestedModelId();
  // Validate only the effective selection: an unavailable lower-priority
  // default must not veto an explicitly selected Room or Agent model.
  const requestedModelId = hasStubModelForTests()
    ? selectedModelId
    : resolveModelRole("chat", { configuredId: selectedModelId });

  const preparedMessages = state.preparedMessages;
  if (!preparedMessages.length) {
    throw new Error("agentNode called without preparedMessages — pre_model must run first");
  }

  const catalog = getToolCatalog();
  if (!catalog) throw new Error("ToolCatalog not initialized — server must call initToolCatalog() at boot");
  const activeModelCapabilities = (["image", "file"] as const).filter(
    (capability) => modelSupportsInput(requestedModelId, capability),
  );
  // The pre-model projection is defensive-normalized before prompt building;
  // repeat the actor boundary here because provider binding is an independent
  // authority site and a guest can share the owner's graph checkpoint.
  const activatedToolNames = selectedActivatedToolNamesForActor(
    state.actorRole,
    state.activatedToolNames,
  );
  const recallRecordsContext = recallRecordsToolContextForState(
    state,
    recallRecordsPortForState?.(state),
  );

  const applyPatchContext = buildApplyPatchToolContext({
    ownerId: state.userId,
    actorRole: state.actorRole,
    agentId: state.agentId,
    turnId: state.turnId,
    roomId: state.roomId,
    memoryAccessEnvelope: state.memoryAccessEnvelope,
    currentFolder: state.currentFolder,
    currentFolderRelayId: state.currentFolderRelayId,
    focusedResources: state.focusedResources ?? [],
  }, { relayRegistry: getRelayRegistry() });
  const toolContext = {
    ...await ordinaryContentAccessToolContextForState(state, ordinaryContentAccessForState),
    ownerId: state.userId,
    causalHumanUserId: causalHumanForExecution(state.causalHumanUserId),
    personaId: state.personaId,
    currentThreadId: state.currentThreadId,
    actorRole: state.actorRole,
    memoryAccessEnvelope: state.memoryAccessEnvelope,
    userId: state.userId,
    liveMiniAppSession: effectiveLiveMiniAppSessionForState(state),
    auditActorId: state.memoryAccessEnvelope?.actorId ?? null,
    securityAuditClientMeta: state.securityAuditClientMeta,
    // see pre-model.ts for rationale. Must match
    // the other two tool-factory sites (pre-model.ts, tools.ts)
    // so the `file` tool's ZoneContext is consistent across the
    // pre-model → agent → tools pipeline within a single turn.
    currentFolder: state.currentFolder,
    workspacePath: state.workspacePath,
    // M087 — userTimezone on the tool-factory context so `get_current_time`
    // formats with the same IANA zone the prompt block uses. Kept in
    // lock-step with the other tool-factory sites (pre-model.ts, tools.ts).
    userTimezone: state.userTimezone,
    // plumbed through so the `file` tool's
    // DispatchContext carries agentId + roomId for the backup
    // subsystem's file_revisions FKs. Must stay in lock-step with
    // pre-model.ts and tools.ts (same three-site coupling as
    // currentFolder / workspacePath above).
    agentId: state.agentId,
    roomId: state.roomId,
    callingRoomId: state.callingRoomId,
    turnId: state.turnId,
    turnContextId: turnContextKey(state.turnId, state.agentId),
    subagentDepth: state.subagentDepth,
    subagentMaxDepth: state.subagentMaxDepth,
    roomRoster: state.roomRoster,
    activeModelId: requestedModelId,
    relayCapabilities: state.relayCapabilities,
    // This is private server-authored run context. Context-aware tools use it
    // to act on the same focused resources described to the model.
    focusedResources: state.focusedResources ?? [],
    connectedAppProviderIds: state.connectedAppProviderIds ?? [],
    activatedToolNames,
    readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
    toolWhitelist: state.toolWhitelist,
    activeModelCapabilities,
    trustedExecutionEntrypoint: state.trustedExecutionEntrypoint,
    deepResearchForegroundAvailable: deepResearchReturnContextForState(state) !== null,
    initiatingClientSurface: getCurrentInitiatingClientSurface(),
    ...recallRecordsContext,
    ...applyPatchContext,
  };
  const progressiveResolution = resolveToolsForExposure(
    catalog,
    config.nautilo_tool_exposure_mode,
    {
    context: toolContext,
    toolPolicy: state.memoryAccessEnvelope?.toolPolicy,
    relayCapabilities: state.relayCapabilities ?? undefined,
    readableNamespaces: envelopeReadableNamespaces(state.memoryAccessEnvelope),
    activeModelCapabilities,
    toolNameWhitelist: state.toolWhitelist,
      activatedToolNames,
      fullEncryptionOnly,
    },
  );
  const rawTools = progressiveResolution.tools;
  const tools = projectSecurityResearchConsolidationTools(withholdSkipForExplicitSelection(rawTools, state.explicitlySelected), isResearchPreEvictionConsolidating(state));
  // Recompute only the stable intent category here for telemetry parity with
  // pre_model; the persisted activation set remains the binding authority.
  const intentPackToolNames = state.actorRole === "guest"
    ? []
    : expandToolFamilies(resolveTurnIntentPack(state.messages).families)
      .filter((name) => activatedToolNames.includes(name));
  const progressiveToolExposure = measureProgressiveToolExposure({
    registeredCatalogTools: catalog.size,
    eligibleEntries: progressiveResolution.eligible.entries,
    exclusionReasons: progressiveResolution.snapshot.exclusions.map(
      (exclusion) => exclusion.reason,
    ),
    activatedToolNames,
    activatedToolLeases: state.actorRole === "guest" ? [] : state.activatedToolLeases ?? [],
    intentPackToolNames,
    tools,
  });

  // derive room-scoped lane key for `model.fallback` event
  // emission. Same shape as `runtime/src/job.ts` derives for `job.status`:
  // `room:<uuid>`. Null when the turn has no room context (rare —
  // background jobs without a roomId; the fallback walk still works,
  // just no WS announcement).
  const fallbackLaneKey = state.roomId ? `room:${state.roomId}` : null;

  // operator per-model reasoning-output override map (default ON).
  // Passed as a map so each fallback hop resolves its own model's setting.
  //
  // Offer the existing Responses transport to every foreground turn. Direct
  // GPT-6 keeps reasoning with tools even when reasoning output is hidden;
  // earlier OpenAI models retain their existing output/headroom policy.
  kickServerModelConfigRefresh();
  const reasoningOverrides = getCachedServerModelConfigRow()?.reasoningOutput ?? {};

  // Costs dashboard: attribute this turn's token usage to the human,
  // room, and call-type. Nested subagent turns (subagentDepth > 0) meter as
  // `subagent`; top-level turns as `chat`. The usage callback attached in
  // createUniversalModel reads this ambient context at completion time.
  const usageCallType = (state.subagentDepth ?? 0) > 0 ? "subagent" : "chat";
  // Nested subagents retain their existing model-only semantics.
  const resolveForegroundControls = foregroundControls?.resolveForegroundControls;
  const researchContinuity = state.subagentRun === true && Boolean(state.currentTaskId && state.currentTaskRunId)
    && state.toolWhitelist?.includes("security_scan") === true;
  // Protected dispatch checkpoints only this node's safe output, not the
  // transient pre_model result. Carry its recovery metadata even when no
  // provider rejection occurs and the callback never runs.
  let recoveredState: Partial<NautiloState> = researchContinuity ? {
    researchContextRecovery: state.researchContextRecovery ?? null,
    researchContextPageBytes: state.researchContextPageBytes ?? null,
  } : {};
  let actualPreparedMessages = preparedMessages;
  if (researchContinuity && optionalResearchDraft) {
    const candidate = [...preparedMessages, optionalResearchDraft];
    const allowance = await resolvePreparedMessageBudget(requestedModelId, tools);
    const candidateTokens = estimateTokenCount(candidate);
    const included = candidateTokens <= allowance;
    if (included) actualPreparedMessages = candidate;
    log(`[research-note-draft] event=${included ? "included" : "omitted_budget"} task=${state.currentTaskId} task_run=${state.currentTaskRunId} model=${requestedModelId} message_tokens=${candidateTokens} allowance_tokens=${allowance}`);
  }
  const { response, modelUsed } = await runWithUsageContext(
    {
      callType: usageCallType,
      userId: causalHumanForExecution(state.causalHumanUserId) || null,
      roomId: state.roomId ?? null,
      metadata: {
        ...(state.agentId ? { agentId: state.agentId } : {}),
        ...(state.turnId ? { turnId: state.turnId } : {}),
      },
    },
    () =>
      invokeChatModelWithFallback(
        actualPreparedMessages,
        tools,
        requestedModelId,
        // thread user + agent so the resolver picks up the
        // right per-agent override (falling back to per-user default).
        state.userId,
        state.agentId ?? null,
        fallbackLaneKey,
        invocationConfig,
        {
          fundingHumanUserId: state.causalHumanUserId ?? "",
          reasoningOverrides,
          useOpenAIResponsesApi: true,
          modelFallbackMode: state.modelFallbackMode ?? "agent_chain",
          preparedStableSystemPrefixLength: state.preparedStableSystemPrefixLength ?? 0,
          providerCacheRoomId: state.roomId ?? null,
          // Apply from the first scoped turn, before security_scan.start can
          // set researchWorkEnabled; the parent and optional helper are separate callers.
          ...(researchContinuity
            ? { firstProgressTimeoutMs: config.nautilo_research_first_progress_timeout_ms } : {}),
          ...(researchContinuity ? { recoverContext: ({ messages, maxMessageTokens, estimatedMessageTokens, modelId }: {
            messages: NautiloState["preparedMessages"]; maxMessageTokens: number; estimatedMessageTokens: number; modelId: string;
          }) => {
            // Optional advice never earns source eviction. Retry the original
            // complete workspace first; canonical history never contained it.
            if (optionalResearchDraft && messages.includes(optionalResearchDraft)) {
              actualPreparedMessages = messages.filter((message) => message !== optionalResearchDraft);
              log(`[research-note-draft] event=retry_removed task=${state.currentTaskId} task_run=${state.currentTaskRunId} model=${modelId}`);
              return actualPreparedMessages;
            }
            const budget = Math.min(maxMessageTokens, estimatedMessageTokens);
            const recovered = budgetResearchContext({ ...state, ...recoveredState }, messages, budget);
            recoveredState = {
              researchContextRecovery: recovered.recovery,
              researchContextPageBytes: recovered.pageBytes,
            };
            actualPreparedMessages = recovered.messages;
            return recovered.messages;
          } } : {}),
          ...(resolveForegroundControls === undefined ? {} : { resolveForegroundControls }),
        },
      ),
  );

  if (config.nautilo_log_tool_calls) {
    logProgressiveToolExposure(
      "agent",
      progressiveToolExposure,
      config.nautilo_tool_exposure_mode,
    );
    if (response.tool_calls?.length) {
      log(`[nautilo/agent] LLM requested ${response.tool_calls.length} tool call(s): ${response.tool_calls.map((tc) => (tc as { name: string }).name).join(", ")}`);
    }
  }

  return {
    messages: [...state.messages, response],
    model: modelUsed,
    ...recoveredState,
    ...(researchContinuity ? { researchContextPresentation: captureResearchContextPresentation(state, actualPreparedMessages) } : {}),
    // Protected dispatch persists this safe output. Use the actual responder's
    // window, including its tool-call response, rather than a larger requested
    // model's allowance after fallback.
    taskReadPageBytes: taskReadResponseByteBudget(await resolvePreparedMessageBudget(modelUsed, tools),
      [...actualPreparedMessages, response]),
    taskReadPendingPages: state.taskReadPendingPages ?? [],
  };
}
