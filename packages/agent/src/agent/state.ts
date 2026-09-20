import type { ForegroundModelControlSnapshot } from "../config/foreground-model-controls";
import { Annotation } from "@langchain/langgraph";
import type { BaseMessage } from "@langchain/core/messages";
import type { ToolCall } from "@langchain/core/messages/tool";
import type { MemoryAccessEnvelope, RoomParticipant } from "@nautilo/trust";
import {
  parseDesktopAutomationProvenance,
  parseDesktopAutomationRouteBinding,
  type DesktopAutomationProvenance,
  type DesktopAutomationRouteBinding,
} from "@nautilo/types";
import type {
  ActiveMiniAppRequestContext,
  ChatArtifactRef,
  ResolvedFocusedResource,
  VerifiedOrdinaryOrigin,
} from "@nautilo/types";
import type { SkillBody } from "../skills/select-skills-for-turn";
import {
  normalizeActivatedToolLeases,
  normalizeActivatedToolNames,
} from "../tools/meta/activated-tools-handle";
import type { ActivatedToolLease } from "../tools/meta/activated-tools-handle";
import type { ModelFallbackMode } from "../utils/chat-model-invocation";
import type { ProjectionRoomChoice, ProjectionSnapshot } from "../tools/memory/projection-sharing";
import type { OrdinaryContentAccessBinding } from "../runtime/ordinary-content-access";
import {
  parseComputerUseInvocationBindings,
  type ComputerUseInvocationBinding,
} from "../runtime/computer-use-admission";

/** server ceiling for nested `task` depth chains */
export const MAX_SUBAGENT_DEPTH = 5;

/**
 * Server-stamped execution provenance for authority that is intentionally
 * narrower than ordinary relay/workstation access. Missing or invalid state
 * is null, never an implicit foreground-main fallback.
 */
export type TrustedExecutionEntrypoint =
  | "foreground.main"
  | "foreground.fork"
  | "foreground.task_report_back"
  | "background.task"
  | "foreground.subagent";

function parseTrustedExecutionEntrypoint(
  value: unknown,
): TrustedExecutionEntrypoint | null {
  switch (value) {
    case "foreground.main":
    case "foreground.fork":
    case "foreground.task_report_back":
    case "background.task":
    case "foreground.subagent":
      return value;
    default:
      return null;
  }
}

/** state updates replace the persisted activation snapshot. */
export function replaceActivatedToolNames(_: string[], update: string[]): string[] {
  return normalizeActivatedToolNames(update);
}

/** state updates replace the bounded cross-turn lease snapshot. */
export function replaceActivatedToolLeases(
  _: ActivatedToolLease[],
  update: ActivatedToolLease[],
): ActivatedToolLease[] {
  return normalizeActivatedToolLeases(update);
}

function normalizeConnectedAppProviderIds(update: readonly string[]): string[] {
  return [...new Set(update.filter((providerId) =>
    /^[a-z][a-z0-9_-]*$/u.test(providerId)))].sort();
}

export const NautiloStateAnnotation = Annotation.Root({
  messages: Annotation<BaseMessage[]>({
    reducer: (_current, update) => update,
    default: () => [],
  }),

  threadId: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0,
  }),

  langgraphThreadId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /** Checkpointed delivery lane used to bind exact approval replies. */
  approvalLaneKey: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /** Frozen once by fresh foreground ingress, retained across tool/approval resumes. */
  foregroundModelControlSnapshot: Annotation<ForegroundModelControlSnapshot | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  model: Annotation<string | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  userId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  personaId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "owner",
  }),

  voiceMode: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  source: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "tui",
  }),

  assistantName: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "Genie",
  }),

  soulFile: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * enabled skill bodies for `(agentId, speaker userId)`, loaded at
   * executor ingress beside `soulFile`. Empty for guests. Injected in
   * `pre-model` via `selectSkillsForTurn` (prompt text only — ).
   */
  skills: Annotation<SkillBody[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /**
   * pulled-and-not-ejected skill names for this thread.
   * `view_skill` adds; `eject` removes; `pre-model` re-injects bodies.
   * Thread-scoped graph state (S1/ durable focus deferred).
   */
  engagedSkillNames: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  memoryBrief: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  memoryDelta: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  currentThreadId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  // --- 4-node phase graph fields ---

  preparedMessages: Annotation<BaseMessage[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /**
   * content-free boundary into `preparedMessages[0]`. The provider
   * attempt uses it to place or remove cache metadata after room controls and
   * model fallback have resolved the model that will actually run.
   */
  preparedStableSystemPrefixLength: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0,
  }),

  /** Owner prompt time captured once per identified foreground turn. */
  promptTimeReference: Annotation<{ turnId: string; nowMs: number } | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  toolNames: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  approvedToolCalls: Annotation<ToolCall[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** Server-only exact ordinary grants, checkpointed before approval. */
  ordinaryContentAccessBindings: Annotation<Readonly<Record<string, OrdinaryContentAccessBinding>>>({
    reducer: (_, update) => update,
    default: () => ({}),
  }),
  ordinaryContentAccessRejectedToolCallIds: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** exact server-admitted binding for each queued semantic computer call. */
  computerUseInvocationBindings: Annotation<Readonly<Record<string, ComputerUseInvocationBinding>>>({
    reducer: (_, update) => parseComputerUseInvocationBindings(update),
    default: () => Object.freeze({}),
  }),

  /** Server-resolved exact Relay for host-scoped calls in approvedToolCalls. */
  requiredHostRelays: Annotation<Record<string, string>>({
    reducer: (_, update) => update,
    default: () => ({}),
  }),

  pendingApproval: Annotation<ToolCall[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** Exact tool batch whose conditional enrollPin interrupt must retain its
   * LangGraph replay position until the following prove-it completes. */
  identityEnrollmentToolCallIds: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** private, short-lived server snapshot that binds a project-mode
   * share to its exact content, readable evidence and resolved audience. */
  projectionSnapshots: Annotation<ProjectionSnapshot[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** checkpoint-owned opaque disambiguation mappings; never client state. */
  projectionRoomChoices: Annotation<ProjectionRoomChoice[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** projection calls answered by preflight must not reach approval/execution. */
  projectionRejectedToolCallIds: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** The last prose ending did not satisfy this Task's research prerequisites. */
  researchContinuationRequired: Annotation<boolean>({ reducer: (_, update) => update, default: () => false }),

  /** Malformed provider calls answered locally; never eligible for execution. */
  modelRejectedToolCallIds: Annotation<string[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  memoryAccessEnvelope: Annotation<MemoryAccessEnvelope | null>({
    reducer: (_, next) => next ?? null,
    default: () => null,
  }),

  actorRole: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "owner",
  }),

  /**
   * Ephemeral Human-selected posture for this foreground turn. This is never
   * durable authority: individual tools still enforce the shared
   * Auto-Approve boundary, and fresh turns explicitly reset it.
   */
  autoApprove: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * identifies which agent is running this turn. Today always
   * the seeded default (NAUTILO_DEFAULT_AGENT_ID); Iteration 3 will
   * resolve per-room.
   */
  agentId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * which room this turn runs in. Today always the owner's
   * default private room. Iteration 2+ resolves per-user / shared
   * rooms. Empty string for guest turns (no room).
   */
  roomId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Canonical foreground Room that originated a background Task. Unlike
   * `roomId`, this remains populated for an orphan Task transcript so a
   * nested external-harness Task can revalidate the exact originating Room.
   */
  callingRoomId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Exact durable Task currently executing this graph. Only Task-run ingress
   * supplies this server-authored identity; foreground turns remain empty.
   * The task tool uses it to derive nested Task lineage without inferring from
   * Room, lane, thread, prompt, or progress state.
   */
  currentTaskId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Exact durable TaskRun currently executing this graph. Like
   * `currentTaskId`, only Task-run ingress supplies this server-authored
   * identity; foreground turns and ordinary subagents remain empty.
   */
  currentTaskRunId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /** Current prepared-model workspace for recoverable task.read receipts. */
  taskReadPageBytes: Annotation<number | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  /** Recoverable task.read ranges; no transcript bytes or access authority. */
  taskReadPendingPages: Annotation<import("../tools/tasks/read-projection").TaskReadPendingPage[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  /** Server-derived workspace for one exact historical-context page. */
  researchContextPageBytes: Annotation<number | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  /** Fresh audit Tasks use focused role contexts; legacy checkpoints opt out. */
  researchWorkEnabled: Annotation<boolean>({ reducer: (_, update) => update, default: () => false }),

  /** Content-free receipt of the actual successful provider input, never its System/body. */
  researchContextPresentation: Annotation<{
    taskRunId: string;
    throughIndex: number;
    indexRef: string;
    roleStartIndex: number;
    messageRefs: string[];
  } | null>({ reducer: (_, update) => update, default: () => null }),

  /** Same-Task semantic rollover; canonical messages and ledger remain intact. */
  researchContextRecovery: Annotation<{
    taskRunId: string;
    throughIndex: number;
    indexRef: string;
    pendingRefs: string[];
    /** Pages omitted before consolidation must be reread from their original range. */
    unpresentedReadIndices?: number[];
    /** Actual prepared workspace cannot admit another page before consolidation. */
    consolidationRequired?: boolean;
    /** Consolidate an already presented workspace before admitting the withheld batch. */
    preEviction?: { throughIndex: number; retainedRefs: string[]; withheldRefs: string[] };
  } | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  /**
   * room participant roster snapshot for this turn. Populated
   * once at job ingress (loadRoomRoster on the resolved roomId), read
   * by pre_model for the "Room participants" prompt block. Stale
   * within a turn is fine; roster changes trigger a new job. Empty
   * array for guest turns.
   *
   * NOTE: `state.langgraphThreadId` / `state.currentThreadId` now
   * hold `graphThreadId` (the opaque LangGraph saver key), not the
   * laneKey. They diverge for the seeded default room
   * (`graphThreadId = "app:default"`, laneKey = "room:<uuid>") and
   * coincide for rooms created after .
   */
  roomRoster: Annotation<RoomParticipant[]>({
    reducer: (_, update) => update,
    default: () => [],
  }),

  approvalDenied: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * PR B — per-turn correlation id. Populated once at executor
   * ingress with the UUID generated by the chat route (see
   * `packages/server/src/routes/chat.ts`). Persists in the
   * checkpoint so resume paths (`/api/auth/approval-reply`,
   * `/api/auth/identity-challenge`, `/api/auth/prove-and-resume`)
   * can re-bind the same turnId via `runWithTurn(...)` — a single
   * grep `turn=<id>` then reconstructs the full multi-request flow
   * of one user turn in chronological order.
   *
   * Empty default means "no turnId bound yet"; logger's
   * AsyncLocalStorage prefix degrades to no prefix rather than
   * emitting `[turn=]`.
   */
  turnId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),
  /** Routine browser plan and fresh evidence, owned by this turn. */
  browserDecision: Annotation<import("../graph/browser-decision").BrowserDecisionState | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  nativeDecision: Annotation<import("../graph/native-decision").NativeDecisionState | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),
  /**
   * explicit authenticated Human who initiated this foreground turn.
   * Checkpointed with turnId so post-interrupt assistant persistence retains
   * causal provenance without borrowing the session or Agent owner.
   */
  causalHumanUserId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * two-path API.
   *
   * Absolute path of the user's currently-opened folder (Surface B:
   * the task-scoped folder; e.g. a codebase, a Figma export).
   * Empty string = no folder open (valid state post-the current implementation).
   * Populated from `SendMessageRequest.currentFolder` at executor
   * ingress; read by `pre-model` to inject the two-path prompt block.
   *
   * Stays stable across resume boundaries (approval-reply, identity-
   * challenge, prove-and-resume) via the checkpoint channel — same
   * pattern as turnId (see H-023).
   */
  currentFolder: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /** Server-validated owner-paired Desktop identity for Current Folder. */
  currentFolderRelayId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * two-path API.
   *
   * Absolute path of the Agent's persistent workspace (Surface A:
   * `~/Documents/Nautilo/` after the current implementation). Empty string during
   * rollout-only window (workspace IPC not yet wired) or on
   * guest sessions. Populated from `SendMessageRequest.workspacePath`.
   */
  workspacePath: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * compact active mini-app context for the current turn.
   * Null when no mini-app is open or ingress dropped the payload.
   */
  activeMiniApp: Annotation<ActiveMiniAppRequestContext | null>({
    reducer: (_, update) => update ?? null,
    default: () => null,
  }),

  /** Server-validated live-review authority; never derived from activeMiniApp. */
  liveMiniAppSession: Annotation<import("@nautilo/types").TrustedLiveMiniAppSessionContext | null>({
    reducer: (_, update) => update ?? null,
    default: () => null,
  }),

  /**
   * in-focus artifact references for the current turn ("focus on
   * these"). Metadata only (external `artifactId`/path/mime/size); resolved +
   * validated against the caller's readable namespaces server-side. Empty
   * when no artifact chips were queued. Injected as a `## Referenced
   * artifacts` system-prompt block by `pre_model`.
   */
  artifactRefs: Annotation<ChatArtifactRef[]>({
    reducer: (_, update) => update ?? [],
    default: () => [],
  }),

  /**
   * server-resolved focused-resource manifest for the current
   * turn: workspace artifacts, local files, and message attachments
   * normalized into ONE authoritative `ResolvedFocusedResource[]`. pre-model
   * renders a single `## Focused resources` block from the PUBLIC fields
   * (displayName / mimeType / size / location / lifetime / capabilities /
   * toolTarget). The private `locator` (absolute paths, relay IDs, internal
   * row ids) is server-only run metadata under the same posture as
   * `currentFolder` — it is NEVER serialized into prompt prose, room-visible
   * messages, receipts, or public audit summaries. Empty when no focus refs
   * were queued. When non-empty, the unified block replaces the legacy
   * `## Referenced artifacts` block; `artifactRefs` remains as a fallback for
   * legacy checkpoints / direct-executor paths that pre-date this substrate.
   */
  focusedResources: Annotation<ResolvedFocusedResource[]>({
    reducer: (_, update) => update ?? [],
    default: () => [],
  }),

  /**
   * IANA timezone of the requesting user for this turn. Resolved at
   * chat ingress from `SendMessageRequest.userTimezone` ?? `users.timezone`
   * ?? "UTC". Always a valid IANA name; never the empty string. Read by
   * `pre-model` to format the `## Current time` block AND by the
   * `get_current_time` tool to format its return value. Observer-originated
   * turns (Task Primitive) pass the task owner's persisted `users.timezone`,
   * falling back to UTC.
   */
  userTimezone: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "UTC",
  }),

  /**
   * ISO-8601 UTC timestamp of the previous user message in the SAME
   * room, or `null` if this is the first message in the room (or the lookup
   * failed). Resolved at chat ingress BEFORE the new user message is
   * persisted; `pre-model` renders the elapsed-time line from this value.
   */
  previousUserMessageAt: Annotation<string | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  /**
   * HTTP client metadata for `security-audit.log` rows emitted
   * from Connection vault tools. Populated at executor ingress from
   * the chat route; null for background jobs / resume-only paths that
   * omit it (audit sink falls back to empty ip).
   */
  securityAuditClientMeta: Annotation<{
    readonly ip: string;
    readonly userAgent?: string | undefined;
  } | null>({
    reducer: (prev, update) => (update === undefined ? prev : update ?? null),
    default: () => null,
  }),

  /**
   * when `undefined`, the full tier-filtered catalog is bound.
   * When set (including `[]`), only listed tool names are bound.
   */
  toolWhitelist: Annotation<string[] | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),

  /**
   * server-refreshed connected-app eligibility for the exact
   * Human×Namespace on this model step. This is not a client claim or a
   * capability grant; execution rechecks the durable profile before dispatch.
   */
  connectedAppProviderIds: Annotation<string[]>({
    reducer: (_, update) => normalizeConnectedAppProviderIds(update),
    default: () => [],
  }),

  /**
   * current-graph-turn deferred schema projection. This is separate
   * from `activatedToolLeases`, because intent selections may be visible for
   * one graph turn without becoming cross-turn residency.
   */
  activatedToolNames: Annotation<string[]>({
    reducer: replaceActivatedToolNames,
    default: () => [],
  }),

  /**
   * bounded cross-turn deferred-schema residency. These records are
   * selection hints only; catalog eligibility and execution policy remain
   * authoritative at their existing call sites.
   */
  activatedToolLeases: Annotation<ActivatedToolLease[]>({
    reducer: replaceActivatedToolLeases,
    default: () => [],
  }),

  /** foreground turn which last aged the lease snapshot. */
  activationLeasesAgedForTurnId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * distinguishes a legacy checkpoint (no lease metadata yet) from an
   * explicitly emptied lease array after LangGraph applies channel defaults.
   */
  activationLeasesInitialized: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * graph turn which has already merged automatic intent-pack names.
   * This is deliberately independent from lease aging: a tools → pre_model
   * loop may mutate the current projection (notably deactivate_tools), but it
   * must not re-apply the same turn's automatic intent selection.
   */
  activationIntentAppliedForTurnId: Annotation<string>({
    reducer: (_, update) => update,
    default: () => "",
  }),

  /**
   * Layer 1 — flat capability-token dict consumed by the tool-catalog
   * filter. Populated at runtime entry (`langgraph-executor.ts`) by
   * `buildRuntimeCapabilityTokens(getRelayRegistry, ownerId)`. Passed
   * to `catalog.getFiltered` / `catalog.getToolsForActor` at every
   * binding/validation site so relay-executor tools are visible to the
   * LLM only when a relay can actually dispatch them.
   *
   * `undefined` means "no relay connected" — the catalog correctly
   * excludes relay-executor tools.
   */
  relayCapabilities: Annotation<Readonly<Record<string, boolean>> | undefined>({
    reducer: (_, update) => update,
    default: () => undefined,
  }),

  /**
   * verified provenance for an ordinary request from a paired phone.
   * It deliberately identifies no host; the first host-scoped Tool resolves
   * current eligible bindings. Missing means this work has no paired-mobile
   * host authority.
   */
  verifiedOrdinaryOrigin: Annotation<VerifiedOrdinaryOrigin | null>({
    reducer: (_, update) => update ?? null,
    default: () => null,
  }),

  /** explicit server-stamped provenance; null fails future SSH admission closed. */
  trustedExecutionEntrypoint: Annotation<TrustedExecutionEntrypoint | null>({
    reducer: (_, update) => parseTrustedExecutionEntrypoint(update),
    default: () => null,
  }),

  /** server-authored, revalidated live return decision for this wake. */
  taskReportBackContinuation: Annotation<import("../runtime/task-report-back-continuation").TaskReportBackContinuation | null>({
    reducer: (_, update) => update,
    default: () => null,
  }),

  /**
   * exact authority inherited only from an already-admitted desktop
   * run. Missing, malformed, or widened checkpoint state is no authority.
   */
  desktopAutomationProvenance: Annotation<DesktopAutomationProvenance | null>({
    reducer: (_, update) => parseDesktopAutomationProvenance(update),
    default: () => null,
  }),

  /** immutable executable provider route, distinct from run lineage. */
  desktopAutomationRouteBinding: Annotation<DesktopAutomationRouteBinding | null>({
    reducer: (_, update) => parseDesktopAutomationRouteBinding(update),
    default: () => null,
  }),

  /** nested delegate depth for the running graph (0 = main agent). */
  subagentDepth: Annotation<number>({
    reducer: (_, update) => update,
    default: () => 0,
  }),

  /**
   * inclusive cap for `subagentDepth` on this branch
   * (`Math.min` of server max and per-delegate `max_depth` inputs).
   */
  subagentMaxDepth: Annotation<number>({
    reducer: (_, update) => update,
    default: () => MAX_SUBAGENT_DEPTH,
  }),

  /** hide tool.start/end from WS when running a scope subagent */
  suppressToolLifecycleEvents: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /** skip session-notification drain + use scope memory prompts */
  subagentRun: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * this run is a background/async Task run (set by
   * `task-run-executor.ts`). Unlike an in-chat scope run, there is no
   * present human to relay a "connect your relay" tool message to. When a
   * relay-executor tool can't reach a relay mid-run (the relay vanished after
   * being live at run start), the dispatch seam throws `RelayUnavailableError`
   * instead of returning a tool message, so the run finalizes as a clean
   * `relay_unavailable` error via `reportBackTaskError` rather than the agent
   * silently continuing cloud-only. Foreground/scope runs (`false`) keep the
   * existing tool-message behavior.
   */
  taskRun: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * await-response (Task ). When `awaitResponse` is true the
   * `await_reply` step parks the run on `await_human_reply` after the agent
   * emits a final (no-tool-call) message, instead of letting the run complete.
   * Cleared on resume so the post-reply turn reaches real `END`.
   */
  awaitResponse: Annotation<boolean>({
    reducer: (_p, n) => n ?? false,
    default: () => false,
  }),

  /** the room the run posted into; a human reply HERE satisfies the wait. */
  awaitRoomId: Annotation<string>({
    reducer: (_p, n) => n ?? "",
    default: () => "",
  }),

  /** the user ids whose reply resumes the parked run (peer + requester). */
  awaitFromUserIds: Annotation<string[]>({
    reducer: (_p, n) => n ?? [],
    default: () => [],
  }),

  /** task identifiers threaded into the interrupt payload so the
   * `task.awaiting_reply` WS event is self-describing (owner-scoped, ). */
  awaitTaskId: Annotation<string>({
    reducer: (_p, n) => n ?? "",
    default: () => "",
  }),

  awaitTaskRunId: Annotation<string>({
    reducer: (_p, n) => n ?? "",
    default: () => "",
  }),

  awaitOwnerId: Annotation<string>({
    reducer: (_p, n) => n ?? "",
    default: () => "",
  }),

  /**
   * checkpointed no-progress breaker state. A map from the
   * serialized `{toolName, operationDiscriminator, normalizedError}` key
   * (see `graph/no-progress.ts` `serializeNoProgressKey`) to a streak entry
   * `{count, correctiveTurnIssued}`. Persisted in the checkpoint so a resumed
   * run inherits the streak rather than silently restarting it.
   *
   * The key carries NO raw tool args or unnormalized tool output ( / spec) —
   * only a coarse allowlisted operation label and the required normalized,
   * length-capped error token. The error token is checkpoint-only and must
   * never be logged because normalization does not remove sensitive content.
   *
   * Reducer: last-write-wins (the tools→pre_model seam computes the next
   * state from the prior state + the just-executed tool results and writes
   * the whole map back).
   */
  noProgressStreaks: Annotation<ReadonlyMap<string, import("../graph/no-progress").NoProgressStreakEntry>>({
    reducer: (_, update) => update ?? new Map(),
    default: () => new Map(),
  }),

  /**
   * set by the tools node when a failure streak hits the
   * repeated-failure limit, consumed + cleared by the next pre_model node so
   * exactly ONE corrective model turn is injected with a clear internal
   * instruction. `null` means "no corrective turn pending". Persisted in the
   * checkpoint so the corrective turn survives a resume boundary.
   */
  noProgressPendingCorrection: Annotation<{
    readonly toolName: string;
    readonly operationDiscriminator: string;
    readonly normalizedError: string;
  } | null>({
    reducer: (_p, n) => n ?? null,
    default: () => null,
  }),

  /** Persist the terminal tool receipt before the next pre-model node raises the breaker. */
  noProgressPendingStop: Annotation<import("../graph/no-progress").NoProgressKey | null>({
    reducer: (_previous, next) => next ?? null,
    default: () => null,
  }),

  /**
   * user explicitly selected this agent from an `ask_user`
   * disambiguation picker. When true, the `skip` tool is withheld and a
   * steering prompt is injected for this turn only.
   */
  explicitlySelected: Annotation<boolean>({
    reducer: (_, update) => update,
    default: () => false,
  }),

  /**
   * server-owned redirect authority (Requirement B). `true`
   * ONLY for a single inferred wake (`decision.kind=wake`, exactly one
   * target, `source="inferred"`); never explicit mention/reply/UI or explicit
   * multi-wake. Threaded from the dispatch wake path into graph state so the
   * server's redirect completion revalidation and the runtime redirect request
   * share one server-authored authority signal. Missing / `false` fails closed
   * at server completion: target-bearing `skip` cannot wake a peer or transfer
   * focus. Default `false` keeps legacy / background / DM callers inert.
   */
  redirectAllowed: Annotation<boolean>({
    reducer: (_, update) => update ?? false,
    default: () => false,
  }),

  /**
   * explicit fallback mode for this run, threaded from the
   * Task dispatch seam's `exactModelSelection` flag (via `taskRunExecutor` →
   * `runScopeSubagentUntilPause` → cold-start graph state → `agentNode` →
   * `invokeChatModelWithFallback`). `"agent_chain"` (default) preserves the
   * existing per-user/per-agent fallback chain for foreground chat and
   * non-exact Tasks; `"none"` is strict / no-chain mode for an exact Task
   * `model_id` pin and suppresses every cross-model hop.
   *
   * Persisted in the checkpoint channel so a resume reads the mode from the
   * checkpoint rather than re-deriving it — a strict run cannot widen back
   * into chain behavior across resume. The `?? "agent_chain"` reducer
   * default keeps pre-Phase-4 checkpoints (and callers that omit the field)
   * on the existing fallback chain.
   */
  modelFallbackMode: Annotation<ModelFallbackMode>({
    reducer: (_, update) => update ?? "agent_chain",
    default: () => "agent_chain",
  }),

});

/**
 * Public node/test inputs retain back-compat with checkpoints created before
 * trusted live-review state existed; the graph channel defaults it to null.
 *
 * `focusedResources` is also re-declared optional so existing test
 * fixtures (which pre-date the generic substrate) keep compiling without
 * having to set it; the graph channel still defaults to `[]`.
 */
export type NautiloState = Omit<
  typeof NautiloStateAnnotation.State,
  | "foregroundModelControlSnapshot"
  | "liveMiniAppSession"
  | "focusedResources"
  | "modelFallbackMode"
  | "causalHumanUserId"
  | "redirectAllowed"
  | "verifiedOrdinaryOrigin"
  | "trustedExecutionEntrypoint"
  | "taskReportBackContinuation"
  | "desktopAutomationProvenance"
  | "desktopAutomationRouteBinding"
  | "computerUseInvocationBindings"
  | "ordinaryContentAccessBindings" | "ordinaryContentAccessRejectedToolCallIds"
  | "autoApprove"
  | "requiredHostRelays"
  | "activatedToolLeases"
  | "activationLeasesAgedForTurnId"
  | "activationLeasesInitialized"
  | "activationIntentAppliedForTurnId"
  | "browserDecision"
  | "nativeDecision"
  | "noProgressStreaks" | "noProgressPendingCorrection" | "noProgressPendingStop"
  | "projectionSnapshots" | "projectionRoomChoices" | "projectionRejectedToolCallIds" | "modelRejectedToolCallIds" | "researchContinuationRequired"
  | "identityEnrollmentToolCallIds"
  | "approvalLaneKey"
  | "callingRoomId"
  | "currentTaskId"
  | "currentTaskRunId"
  | "researchContextPageBytes" | "researchContextRecovery" | "researchContextPresentation" | "researchWorkEnabled" | "taskReadPageBytes" | "taskReadPendingPages"
  | "preparedStableSystemPrefixLength"
  | "promptTimeReference"
  | "connectedAppProviderIds"
> & {
  /** Legacy checkpoints resolve preferences when next invoked. */
  foregroundModelControlSnapshot?: ForegroundModelControlSnapshot | null;
  /** Empty only for legacy checkpoints; new ingress always checkpoints the exact reply lane. */
  approvalLaneKey?: string;
  /** Empty for foreground/legacy checkpoints; Task ingress supplies the origin Room. */
  callingRoomId?: string;
  /** Empty for foreground/legacy checkpoints; Task ingress supplies its durable Task id. */
  currentTaskId?: string;
  /** Empty for foreground/legacy checkpoints; Task ingress supplies its durable TaskRun id. */
  currentTaskRunId?: string;
  taskReadPageBytes?: number | null;
  taskReadPendingPages?: import("../tools/tasks/read-projection").TaskReadPendingPage[];
  researchContextPageBytes?: number | null;
  researchContextPresentation?: typeof NautiloStateAnnotation.State.researchContextPresentation;
  researchContextRecovery?: typeof NautiloStateAnnotation.State.researchContextRecovery;
  researchWorkEnabled?: boolean;
  /** omitted by legacy checkpoints and ordinary node-test fixtures. */
  preparedStableSystemPrefixLength?: number;
  /** Missing on guests, unidentified turns, and legacy checkpoints. */
  promptTimeReference?: { turnId: string; nowMs: number } | null;
  /** Missing legacy state is fail-closed (no connected-app provider eligible). */
  connectedAppProviderIds?: string[];
  /** Missing on legacy checkpoints and empty outside an enrollPin replay. */
  identityEnrollmentToolCallIds?: string[];
  liveMiniAppSession?: import("@nautilo/types").TrustedLiveMiniAppSessionContext | null;
  focusedResources?: ResolvedFocusedResource[];
  verifiedOrdinaryOrigin?: VerifiedOrdinaryOrigin | null;
  /** omitted legacy checkpoints and invalid values remain fail-closed. */
  trustedExecutionEntrypoint?: TrustedExecutionEntrypoint | null;
  /** absent on every non-report-back and legacy checkpoint. */
  taskReportBackContinuation?: import("../runtime/task-report-back-continuation").TaskReportBackContinuation | null;
  /** absent on legacy checkpoints and ordinary node-test fixtures. */
  desktopAutomationProvenance?: DesktopAutomationProvenance | null;
  /** absent/malformed graph route state cannot use Computer use. */
  desktopAutomationRouteBinding?: DesktopAutomationRouteBinding | null;
  /** per-call admission metadata; an absent/malformed map is empty. */
  computerUseInvocationBindings?: Readonly<Record<string, ComputerUseInvocationBinding>>;
  ordinaryContentAccessBindings?: Readonly<Record<string, OrdinaryContentAccessBinding>>;
  ordinaryContentAccessRejectedToolCallIds?: string[];
  /** Omitted legacy checkpoints and fixtures default to Auto-Approve off. */
  autoApprove?: boolean;
  /** optional only for pre-feature checkpoints/test fixtures; graph channel defaults empty. */
  requiredHostRelays?: Record<string, string>;
  /**
   * optional on the public node/test input type so existing
   * fixtures that build a full `NautiloState` object literal keep compiling
   * without having to set it. The graph channel still defaults it to
   * `"agent_chain"`, and `agentNode` re-defaults to `"agent_chain"` on read.
   */
  modelFallbackMode?: ModelFallbackMode;
  /**
   * optional on the public node/test input type so existing
   * fixtures keep compiling. The graph channel defaults it to `false`
   * (fail-closed); `agentNode` / `preModelNode` / `toolsNode` re-default to
   * `false` on read via `state.redirectAllowed === true`.
   */
  redirectAllowed?: boolean;
  /** absent on legacy checkpoints and ordinary node-test fixtures. */
  causalHumanUserId?: string;
  /**
   * optional on public node/test inputs to distinguish a legacy
   * name-only checkpoint (`undefined`) from a deliberately emptied lease set.
   * The graph channel itself still defaults to `[]`.
   */
  activatedToolLeases?: ActivatedToolLease[];
  /** graph channel defaults this missing legacy marker to the empty id. */
  activationLeasesAgedForTurnId?: string;
  /**
   * unset only for legacy name-only checkpoints; `true` means an empty
   * lease snapshot is deliberate and must not be migrated again.
   */
  activationLeasesInitialized?: boolean;
  /** graph channel defaults an absent intent marker to the empty id. */
  activationIntentAppliedForTurnId?: string;
  /** Absent in legacy checkpoints; defaults to no delegated browser control. */
  browserDecision?: import("../graph/browser-decision").BrowserDecisionState | null;
  nativeDecision?: import("../graph/native-decision").NativeDecisionState | null;
  /** optional on the public input type; the graph channel defaults both. */
  noProgressStreaks?: ReadonlyMap<string, import("../graph/no-progress").NoProgressStreakEntry>;
  /** optional on the public input type; the graph channel defaults to null. */
  noProgressPendingCorrection?: {
    readonly toolName: string;
    readonly operationDiscriminator: string;
    readonly normalizedError: string;
  } | null;
  noProgressPendingStop?: import("../graph/no-progress").NoProgressKey | null;
  /** optional for pre-feature checkpoint fixtures; graph channels default these safely. */
  projectionSnapshots?: ProjectionSnapshot[];
  projectionRoomChoices?: ProjectionRoomChoice[];
  projectionRejectedToolCallIds?: string[];
  modelRejectedToolCallIds?: string[];
  researchContinuationRequired?: boolean;
};
