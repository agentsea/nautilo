/**
 * @nautilo/types - Realtime Event Types
 *
 * Types for WebSocket/Ably events published during graph execution.
 * Used by server (publisher), realtime-client (consumer), and all apps.
 *
 * See architecture-overall-v4.md Section 10.3 for the full event catalog.
 */

import type { DocumentPatchEvent } from "./document-patches";
import type { DocumentMutationCommittedEvent } from "./document-mutations";
import type {
  AdvancedVideoWorkcardContinuation,
  MaintenanceState,
  MessageAttachmentRef,
  MessageArtifactOpenRef,
} from "./api";
import type {
  CodexRequestEvent as CodexNativeRequestEvent,
  CodexRequestResolvedEvent as CodexNativeRequestResolvedEvent,
} from "./codex";
import type { ProtectedMessageRealtimeEventV2 } from "./protected-message-realtime";
import type {
  FullEncryptionMessageRealtimeContentEventV2,
  LiveShadowMessageRealtimeEventV1,
} from "./live-shadow-message-realtime";
import type { MediaGenerationApproval } from "./media-generation-approval";
import type {
  ClientSessionEventV1,
  UiActionEventV1,
} from "./genie-application-bridge";

/** Socket-local control frames bypass the ServerEvent broadcast contract. */
export type RealtimeControlEvent = ClientSessionEventV1 | UiActionEventV1;

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

export interface MessageTokensEvent {
  type: "message.tokens";
  laneKey: string;
  content: string;
  chunkSequence: number;
  done: boolean;
  tokenUsage?: TokenUsage;
  /**
   * stable assistant author id for multi-agent rooms. Present on
   * assistant streaming chunks when the runtime knows `agentId`; clients
   * resolve display labels from the room roster. Never set on human/user
   * traffic.
   */
  authorAgentId?: string;
  /**
   * correlates the chunk to the in-flight assistant turn; lets clients
   * keep concurrent streams in distinct bubbles. Optional for older servers.
   */
  turnId?: string;
  /** server-authored identity for one visible assistant message. */
  assistantMessageKey?: string;
}

export interface MessageNewEvent {
  /** Persisted sent time; never a socket receipt or edit time. */
  createdAt?: string;
  type: "message.new";
  laneKey: string;
  messageId: string;
  /** present for persisted Human rows so live projections are editable immediately. */
  logicalMessageKey?: string;
  /** initial/current edit revision for the persisted Human row. */
  editRevision?: number;
  /** `user` = persisted human row; `human` kept for back-compat. */
  role: "ai" | "human" | "system" | "user";
  content: string;
  /** `sessions.owner_id` for `role === "user"` / `human` rows. */
  sourceUserId?: string;
  /**
   *  B3 — human author id; WS layer skips `markDelivered` for sockets
   * whose `userId` matches (author already has optimistic UI).
   */
  senderUserId?: string;
  /**
   * stable assistant author id for `role === "ai"` rows. Present when
   * the runtime knows `agentId`; clients resolve display labels from the room
   * roster. Never set on human/user/system rows.
   */
  authorAgentId?: string;
  /**
   * External harness that authored this assistant text. When present,
   * `authorAgentId` identifies the delegating Nautilo agent rather than the
   * prose author. Clients should render the harness as the speaker and the
   * agent as a "via" attribution.
   */
  authorHarnessId?: string;
  /** matches this durable row to its streamed assistant bubble. */
  assistantMessageKey?: string;
  /**
   * id of the message this reply quotes (inline quote-reply). Optional:
   * absence means "no reply." Populated by the human/DM `message.new` emit
   * sites (`peer-broadcast.ts`, `agent-mediated.ts`) from the same send
   * request / persisted row that supplies `messageId` / `sourceUserId`, so
   * live peers can render a quote-reply chip without re-fetching history.
   * Other `message.new` emitters (event-bridge, langgraph-executor,
   * persist-messages, report-back) intentionally leave it unset.
   */
  replyToMessageId?: number;
  /** Retained attachment descriptors for this persisted Human message. */
  attachments?: MessageAttachmentRef[];
  /**
   * Server-authored ArtifactOpenCard refs. Present on an ordinary
   * focused user send or on the assistant question in a trusted ask_peer
   * Artifact handoff. Never inferred from prose/tool output. Hydrated from
   * `session_message_artifacts` at emit time; pointer-only.
   */
  artifacts?: MessageArtifactOpenRef[];
  /** Server-validated neutral presentation for a card-owned continuation. */
  workcardContinuation?: AdvancedVideoWorkcardContinuation;
}

/** complete viewer-private own-Room and aggregate notification delta. */
export interface RoomNotificationChangedEvent {
  type: "room.notification.changed";
  userId: string;
  roomId: string;
  topLevelRoomId: string;
  roomOwnUnreadCount: number;
  roomOwnImportantUnreadCount: number;
  topLevelUnreadCount: number;
  topLevelImportantUnreadCount: number;
}

/**
 * content-free hint that the authenticated Human's durable event feed
 * changed. Delivery authority is supplied out of band by the server publisher;
 * the wire payload deliberately contains no user, event, recipient, or content
 * identifiers.
 */
export interface EventFeedChangedEvent {
  type: "event_feed.changed";
}

/**
 * non-replayed arrival signal. Deliberately contains labels and durable
 * identifiers only; message content and arbitrary navigation targets are not
 * part of this contract.
 */
export interface ImportantMessageArrivedEvent {
  type: "notification.message.important";
  userId: string;
  messageId: string;
  roomId: string;
  topLevelRoomId: string;
  senderActorId: string;
  senderDisplayName: string;
  roomLabel: string;
  parentRoomLabel?: string;
  occurredAt: string;
}

/** wire shape for active room silence windows. */
export type ActiveRoomSilenceDto = {
  id: string;
  kind: "mute" | "deaf";
  botActorId: string | null;
  botDisplayName: string | null;
  setByDisplayName: string;
  expiresAt: string;
};

/**
 * room-scoped silence state delta. Published on set, clear,
 * and precise expiry so clients can drop the 30s poll backstop. Audience =
 * room members (mirrors `room_members_changed`).
 */
export interface RoomSilenceChangedEvent {
  type: "room.silence.changed";
  roomId: string;
  laneKey: string;
  silence: ActiveRoomSilenceDto | null;
}

/** b — room-scoped smart-routing policy delta. */
export interface RoomConductorModeChangedEvent {
  type: "room.conductor_mode.changed";
  roomId: string;
  laneKey: string;
  conductorMode: "advanced" | "standard";
}

export interface ReactionAddedEvent {
  type: "reaction.added";
  laneKey: string;
  messageId: number;
  actorId: string;
  emoji: string;
  createdAt: string;
}

export interface ReactionRemovedEvent {
  type: "reaction.removed";
  laneKey: string;
  messageId: number;
  actorId: string;
  emoji: string;
}

/**
 * a room message was hard-deleted. Zero-content (id + lane only),
 * safe to broadcast room-scoped exactly like reaction events. Clients remove
 * the message from the active room's store on receipt.
 */
export interface MessageDeletedEvent {
  type: "message.deleted";
  laneKey: string; // `room:<roomId>`
  messageId: number;
}

/** authoritative replacement text for one logical Human turn. */
export interface MessageUpdatedEvent {
  type: "message.updated";
  laneKey: string; // `room:<roomId>`
  logicalMessageKey: string;
  content: string;
  editedAt: string;
  editRevision: number;
}

/**
 * authoritative, revisioned summary for a Subthread anchor shown in
 * its parent Room. This is a snapshot, never an increment/decrement delta:
 * receivers discard it unless `summaryRevision` is newer than their current
 * anchor metadata.
 *
 * The event is deliberately parent-lane scoped (`room:<parentRoomId>`), so
 * every parent member can converge on the same anchor summary. It contains no
 * child transcript content, requester-private state, unread state, or job
 * provenance.
 */
export interface ThreadSummaryChangedEvent {
  type: "thread.summary.changed";
  laneKey: string;
  anchorMessageId: number;
  replyCount: number;
  lastReplyAt: string | null;
  summaryRevision: number;
}

export interface JobStatusEvent {
  type: "job.status";
  jobId: string;
  status: "queued" | "running" | "completed" | "failed" | "timed_out" | "cancelled";
  /** Exact server-authored turn identity for lifecycle reconciliation. */
  turnId?: string | undefined;
  /** Exact server-authored Agent identity for lifecycle reconciliation. */
  authorAgentId?: string | undefined;
  /**
   * Friendly user-visible sentence on `status: "failed"`. One of the
   * seven friendly-error sentences (translated at the runtime
   * job-loop chokepoint). Contains zero echoed prompt content or
   * upstream model output, so it is safe to broadcast room-scoped
   * along with this event's normal lane routing.
   */
  message?: string | undefined;
  /**
   * stable category tag for a failed event. One of
   * `timeout` | `rate_limit` | `auth` | `bad_request` |
   * `context_exceeded` | `provider_unavailable` | `unknown`. Stable
   * enum (zero user content) — safe to broadcast on the room-scoped
   * `job.status` channel. Lets the workbench style / iconize the
   * failed bubble per category without re-classifying client-side.
   * Only present on `status: "failed"`.
   *
   * NOTE — the raw upstream-provider detail string deliberately does
   * NOT live on this event. `job.status` is routed by `laneKey:
   * "room:<uuid>"`, so every member of a multi-user room receives
   * the event; the upstream `error.message` field can echo prompt
   * content or model output (`providers/errors.ts` SECURITY note),
   * which would leak across users. Raw details land in `server.log`
   * via the existing `formatProviderError` line at
   * `chat-model-invocation.ts:219` and the `[nautilo/job]` line at
   * `runtime/src/job.ts`. A future user-scoped error-details event
   *  can carry the raw blob to the request
   * originator only.
   */
  errorCategory?:
    | "timeout"
    | "rate_limit"
    | "auth"
    | "bad_request"
    | "context_exceeded"
    | "provider_unavailable"
    | "unknown"
    | undefined;
  /** room-scoped WS routing when present. */
  laneKey?: string | undefined;
}

export interface JobProgressEvent {
  type: "job.progress";
  /** Narrow UI discriminator; absent preserves every existing background job. */
  kind?: "deep-research" | "foreground-context" | undefined;
  jobId: string;
  phase: string;
  detail?: string | undefined;
  laneKey?: string | undefined;
}

export interface ToolStartEvent {
  type: "tool.start";
  /** Room/lane provenance for routing tool activity in multi-room clients. */
  laneKey?: string | undefined;
  toolCallId: string;
  toolName: string;
  argsSummary?: string | undefined;
  /**
   * Stable authoring-agent id for multi-agent rooms. Present when the runtime
   * knows the turn's `agentId`; clients resolve the avatar/name from the room
   * roster (mirrors `message.tokens` / `message.new`). Absent on
   * non-agent-turn tool dispatches (e.g. user-initiated direct file ops).
   */
  authorAgentId?: string | undefined;
  /**
   * correlates the tool lifecycle event to the in-flight assistant turn.
   * Optional for older servers.
   */
  turnId?: string | undefined;
}

export interface ToolEndEvent {
  type: "tool.end";
  /** Room/lane provenance for routing tool activity in multi-room clients. */
  laneKey?: string | undefined;
  toolCallId: string;
  toolName: string;
  duration: number;
  status: "success" | "error";
  error?: string | undefined;
  /**
   * actual tool output, string-serialized. Populated
   * from the ToolMessage's `content` on success, and (for error
   * paths that set `error`) repeated here as a convenience for UI
   * renderers. Capped at ~10KB server-side so the WS never blocks
   * on a `run_shell` that spits out a huge log file; when truncated
   * the `resultTruncated` flag is set and the ui can render a
   * "…[X more bytes truncated]" affordance.
   *
   * Optional so older clients + pre-PR-C callers that pre-date this
   * field still parse the event. Missing result means "fall back to
   * the prior 'Done (Xms)' synthetic placeholder" in the UI.
   */
  result?: string | undefined;
  resultTruncated?: boolean | undefined;
  /**
   * emitted only for an exact `run_shell` request that crossed relay
   * dispatch but lost its canonical result. Optional/additive for older
   * clients; absent means an ordinary completed tool outcome.
   */
  runShellOutcome?: "unknown" | undefined;
  /**
   * Stable authoring-agent id for multi-agent rooms. Present when the runtime
   * knows the turn's `agentId`; clients resolve the avatar/name from the room
   * roster (mirrors `message.tokens` / `message.new`). Absent on
   * non-agent-turn tool dispatches (e.g. user-initiated direct file ops).
   */
  authorAgentId?: string | undefined;
  /**
   * correlates the tool lifecycle event to the in-flight assistant turn.
   * Optional for older servers.
   */
  turnId?: string | undefined;
}

/**  v1 — provisional, bounded Desktop `run_shell` output observation. */
export interface ToolRunShellProgressEvent {
  type: "tool.run_shell.progress";
  /** Room/lane provenance, identical to the corresponding tool lifecycle. */
  laneKey?: string | undefined;
  authorAgentId?: string | undefined;
  turnId?: string | undefined;
  toolCallId: string;
  version: 1;
  /** Monotonic per process, across both streams. */
  sequence: number;
  stream: "stdout" | "stderr";
  offsetBytes: number;
  endOffsetBytes: number;
  text: string;
  droppedBytes?: number | undefined;
  elapsedMs: number;
  phase: "running";
}

/**
 *  v1 — provisional, secret-free observation for one structured SSH
 * operation. It deliberately has no destination, identity, command, local
 * path, approval, binding, or retry state; the final tool result is canonical.
 */
export type ToolStructuredSshProgressEvent =
  | {
      type: "tool.structured_ssh.progress";
      laneKey?: string | undefined;
      authorAgentId?: string | undefined;
      turnId?: string | undefined;
      toolCallId: string;
      version: 1;
      sequence: number;
      operation: "exec";
      kind: "exec-output";
      stream: "stdout" | "stderr";
      offsetBytes: number;
      endOffsetBytes: number;
      text: string;
      droppedBytes?: number | undefined;
      elapsedMs: number;
      phase: "running";
    }
  | {
      type: "tool.structured_ssh.progress";
      laneKey?: string | undefined;
      authorAgentId?: string | undefined;
      turnId?: string | undefined;
      toolCallId: string;
      version: 1;
      sequence: number;
      operation: "copy-upload" | "copy-download";
      kind: "transfer";
      phase: "starting" | "transferring";
      transferredBytes: number;
      totalBytes?: number | undefined;
      elapsedMs: number;
    };

export interface WorkspaceArtifactChangedEvent {
  type: "workspace.artifact.changed";
  id: string;
  artifactId: string;
  path: string;
  clientMutationId?: string | undefined;
  /** broad/unrepresentable write; consumers should full-resync, not patch catch-up. */
  reloadRequired?: boolean | undefined;
}

export interface WorkspaceArtifactRenamedEvent {
  type: "workspace.artifact.renamed";
  id: string;
  artifactId: string;
  oldPath: string;
  newPath: string;
}

export interface WorkspaceArtifactDeletedEvent {
  type: "workspace.artifact.deleted";
  id: string;
  artifactId: string;
  /** Snapshot of namespace ids at delete time, for SSE filtering without DB hit. */
  namespaceIds: string[];
}

/** document patch applied (Artifact SSE lane + HTTP catch-up). */
export type { DocumentPatchEvent } from "./document-patches";

/**
 * server-side cap on tool result size before wire
 * emission. Prevents `run_shell` that dumps `ls -R /` (megabytes
 * of stdout) from blocking the WS for every connected client.
 * 10KB is the same cap used for the expanded card
 * view, so truncation here means nothing is lost visually either.
 *
 * override via `NAUTILO_TOOL_RESULT_MAX_BYTES` (positive
 * integer); resolved once at module load.
 */
const DEFAULT_TOOL_RESULT_MAX_BYTES = 10_000;

/**
 * Resolve the cap from `NAUTILO_TOOL_RESULT_MAX_BYTES` (falls back to the
 * default for unset/empty/non-positive/non-numeric). Exported so it can be
 * unit-tested deterministically — `TOOL_RESULT_MAX_BYTES` itself is resolved
 * once at module load and so can't be re-tested by mutating env post-import.
 */
function readEnv(name: string): string | undefined {
  // Read via globalThis so this browser-shared types module never names the
  // `process` global directly (UI packages typecheck without @types/node).
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env;
  return env?.[name];
}

export function resolveToolResultMaxBytes(
  raw: string | undefined = readEnv("NAUTILO_TOOL_RESULT_MAX_BYTES"),
): number {
  if (raw === undefined || raw === "") return DEFAULT_TOOL_RESULT_MAX_BYTES;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_TOOL_RESULT_MAX_BYTES;
  return parsed;
}

export const TOOL_RESULT_MAX_BYTES = resolveToolResultMaxBytes();

/**
 * a `file` staged-patch result is NOT a display dump like a
 * `run_shell` log; it is a structured JSON control payload (a
 * `StagedResultEnvelope`, `{"staged":true,...}`) that the workbench must
 * `JSON.parse` to render the DiffView + Accept/Reject controls.
 * Truncating it at `TOOL_RESULT_MAX_BYTES` corrupts the JSON, so
 * `parseStagedEnvelope` returns null and the review UI silently
 * disappears — any staged file larger than ~10KB (i.e. any real HTML
 * artifact) loses its Accept/Reject buttons. These payloads therefore
 * bypass the display cap.
 *
 * Detection is a deterministic prefix match: `encodeStagedResult`
 * always serializes `staged` first (`{"staged":true,...}`), so a
 * `run_shell` dump that merely contains the substring downstream
 * cannot masquerade as a control payload.
 */
export function isStagedToolResult(result: string): boolean {
  return result.startsWith('{"staged":true');
}

export type ToolResultEventProjection = {
  result: string;
  truncated: boolean;
};

const DESKTOP_SHELL_RESULT_MAX_STREAM_BYTES = 64 * 1024;
const DESKTOP_SHELL_RESULT_MAX_TOTAL_BYTES = 132 * 1024;
const DESKTOP_SHELL_RESULT_KEYS = new Set([
  "version", "execution", "exitCode", "signal", "timedOut", "cancelled",
  "durationMs", "stdout", "stderr", "stdoutTruncated", "stderrTruncated",
  "sideEffectsMayHaveStarted", "profileRevision",
]);
const DESKTOP_SHELL_OUTPUT_ARTIFACT_KEY = "outputArtifact";
const DESKTOP_SHELL_OUTPUT_ARTIFACT_KEYS = new Set([
  "version", "reference", "expiresAt", "capturedBytes", "totalBytes", "truncated",
]);
const DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_KEYS = new Set([
  "version", "reference", "stdout", "stderr", "offsetBytes", "nextOffsetBytes",
  "capturedBytes", "totalBytes", "truncated", "expiresAt", "deleted",
]);
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_KEYS = new Set([
  "version", "operation", "reference", "matches", "totalMatches", "matchesTruncated",
  "capturedBytes", "totalBytes", "truncated", "expiresAt",
]);
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MATCH_KEYS = new Set([
  "stream", "matchOffsetBytes", "artifactOffsetBytes", "matchBytes", "contextOffsetBytes", "context",
]);
const DESKTOP_SHELL_OUTPUT_ARTIFACT_MAX_BYTES = 1024 * 1024;
const DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_MAX_BYTES = 16 * 1024;
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_MATCHES = 20;
// 1024 bytes on either side plus a <=1024-byte query, with up to three UTF-8
// continuation bytes included at each context edge to avoid splitting text.
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_CONTEXT_BYTES = (3 * 1024) + 6;
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_TOTAL_CONTEXT_BYTES = 16 * 1024;
const DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_RESULT_BYTES = 16 * 1024;
// JSON escaping can expand a 16KiB page of control characters to ~96KiB.
// Keep the cap safely above that strict decoded-page limit, never unlimited.
const DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_MAX_RESULT_BYTES = 128 * 1024;

function isOpaqueDesktopShellArtifactReference(value: unknown): value is string {
  // Electron mints exactly base64url(randomBytes(32)): a 43-character opaque
  // reference. The event projector must not turn this into a general string.
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isBoundedIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 64) return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isBoundedDesktopShellOutputArtifact(value: unknown): boolean {
  const artifact = record(value);
  if (artifact === null || Object.keys(artifact).length !== DESKTOP_SHELL_OUTPUT_ARTIFACT_KEYS.size) return false;
  if (!Object.keys(artifact).every((key) => DESKTOP_SHELL_OUTPUT_ARTIFACT_KEYS.has(key))) return false;
  const capturedBytes = artifact["capturedBytes"];
  const totalBytes = artifact["totalBytes"];
  return artifact["version"] === 1 &&
    isOpaqueDesktopShellArtifactReference(artifact["reference"]) &&
    isBoundedIsoTimestamp(artifact["expiresAt"]) &&
    Number.isSafeInteger(capturedBytes) && (capturedBytes as number) >= 0 &&
    (capturedBytes as number) <= DESKTOP_SHELL_OUTPUT_ARTIFACT_MAX_BYTES &&
    Number.isSafeInteger(totalBytes) && (totalBytes as number) >= (capturedBytes as number) &&
    typeof artifact["truncated"] === "boolean";
}

function isBoundedDesktopShellResult(result: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return false;
  }
  const shell = record(value);
  if (shell === null) return false;
  const keys = Object.keys(shell);
  const hasArtifact = Object.hasOwn(shell, DESKTOP_SHELL_OUTPUT_ARTIFACT_KEY);
  if (keys.length !== DESKTOP_SHELL_RESULT_KEYS.size + Number(hasArtifact)) return false;
  if (!keys.every((key) => DESKTOP_SHELL_RESULT_KEYS.has(key) || key === DESKTOP_SHELL_OUTPUT_ARTIFACT_KEY)) return false;
  const exitCode = shell["exitCode"];
  const signal = shell["signal"];
  const profileRevision = shell["profileRevision"];
  return shell["version"] === 1 &&
    (shell["execution"] === "sandboxed" || shell["execution"] === "workstation") &&
    (exitCode === null || (Number.isSafeInteger(exitCode) && (exitCode as number) >= 0)) &&
    (signal === null || typeof signal === "string") &&
    typeof shell["timedOut"] === "boolean" &&
    typeof shell["cancelled"] === "boolean" &&
    Number.isSafeInteger(shell["durationMs"]) && (shell["durationMs"] as number) >= 0 &&
    typeof shell["stdout"] === "string" &&
    typeof shell["stderr"] === "string" &&
    resultByteLength(shell["stdout"]) <= DESKTOP_SHELL_RESULT_MAX_STREAM_BYTES &&
    resultByteLength(shell["stderr"]) <= DESKTOP_SHELL_RESULT_MAX_STREAM_BYTES &&
    typeof shell["stdoutTruncated"] === "boolean" &&
    typeof shell["stderrTruncated"] === "boolean" &&
    shell["sideEffectsMayHaveStarted"] === true &&
    (profileRevision === null ||
      (Number.isSafeInteger(profileRevision) && (profileRevision as number) >= 1)) &&
    (!hasArtifact || isBoundedDesktopShellOutputArtifact(shell[DESKTOP_SHELL_OUTPUT_ARTIFACT_KEY])) &&
    resultByteLength(result) <= DESKTOP_SHELL_RESULT_MAX_TOTAL_BYTES;
}

/** Strict bounded continuation page; avoids corrupting a 16KiB JSON page at the generic 10KiB cap. */
function isBoundedDesktopShellOutputArtifactPage(result: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return false;
  }
  const page = record(value);
  if (page === null || Object.keys(page).length !== DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_KEYS.size) return false;
  if (!Object.keys(page).every((key) => DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_KEYS.has(key))) return false;
  const capturedBytes = page["capturedBytes"];
  const totalBytes = page["totalBytes"];
  const offsetBytes = page["offsetBytes"];
  const nextOffsetBytes = page["nextOffsetBytes"];
  const pageBytes =
    typeof page["stdout"] === "string" && typeof page["stderr"] === "string"
      ? resultByteLength(page["stdout"]) + resultByteLength(page["stderr"])
      : Number.POSITIVE_INFINITY;
  return page["version"] === 1 &&
    isOpaqueDesktopShellArtifactReference(page["reference"]) &&
    typeof page["stdout"] === "string" &&
    typeof page["stderr"] === "string" &&
    pageBytes <= DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_MAX_BYTES &&
    Number.isSafeInteger(offsetBytes) && (offsetBytes as number) >= 0 &&
    Number.isSafeInteger(capturedBytes) && (capturedBytes as number) >= 0 &&
    (capturedBytes as number) <= DESKTOP_SHELL_OUTPUT_ARTIFACT_MAX_BYTES &&
    Number.isSafeInteger(totalBytes) && (totalBytes as number) >= (capturedBytes as number) &&
    (offsetBytes as number) <= (capturedBytes as number) &&
    (nextOffsetBytes === null ||
      (Number.isSafeInteger(nextOffsetBytes) &&
        (nextOffsetBytes as number) > (offsetBytes as number) &&
        (nextOffsetBytes as number) <= (capturedBytes as number))) &&
    typeof page["truncated"] === "boolean" &&
    isBoundedIsoTimestamp(page["expiresAt"]) &&
    typeof page["deleted"] === "boolean" &&
    !(page["deleted"] === true && nextOffsetBytes !== null) &&
    resultByteLength(result) <= DESKTOP_SHELL_OUTPUT_ARTIFACT_PAGE_MAX_RESULT_BYTES;
}

/** Strict bounded literal-search result for a retained Desktop shell artifact. */
function isBoundedDesktopShellOutputArtifactSearch(result: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(result);
  } catch {
    return false;
  }
  const search = record(value);
  if (search === null || Object.keys(search).length !== DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_KEYS.size) return false;
  if (!Object.keys(search).every((key) => DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_KEYS.has(key))) return false;
  const capturedBytes = search["capturedBytes"];
  const totalBytes = search["totalBytes"];
  const totalMatches = search["totalMatches"];
  const matches = search["matches"];
  if (
    search["version"] !== 1 || search["operation"] !== "search" ||
    !isOpaqueDesktopShellArtifactReference(search["reference"]) ||
    !Number.isSafeInteger(capturedBytes) || (capturedBytes as number) < 0 ||
    (capturedBytes as number) > DESKTOP_SHELL_OUTPUT_ARTIFACT_MAX_BYTES ||
    !Number.isSafeInteger(totalBytes) || (totalBytes as number) < (capturedBytes as number) ||
    typeof search["truncated"] !== "boolean" ||
    search["truncated"] !== ((capturedBytes as number) < (totalBytes as number)) ||
    !isBoundedIsoTimestamp(search["expiresAt"]) ||
    !Number.isSafeInteger(totalMatches) || (totalMatches as number) < 0 ||
    (totalMatches as number) > (capturedBytes as number) ||
    typeof search["matchesTruncated"] !== "boolean" || !Array.isArray(matches) ||
    matches.length > DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_MATCHES ||
    (totalMatches as number) < matches.length ||
    search["matchesTruncated"] !== ((totalMatches as number) > matches.length)
  ) return false;

  let contextBytes = 0;
  let seenStderr = false;
  let stderrArtifactBase: number | null = null;
  const lastMatchEnd: Record<"stdout" | "stderr", number> = { stdout: 0, stderr: 0 };
  for (const value of matches) {
    const match = record(value);
    if (match === null || Object.keys(match).length !== DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MATCH_KEYS.size) return false;
    if (!Object.keys(match).every((key) => DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MATCH_KEYS.has(key))) return false;
    const matchOffsetBytes = match["matchOffsetBytes"];
    const artifactOffsetBytes = match["artifactOffsetBytes"];
    const matchBytes = match["matchBytes"];
    const contextOffsetBytes = match["contextOffsetBytes"];
    const context = match["context"];
    if (
      (match["stream"] !== "stdout" && match["stream"] !== "stderr") ||
      !Number.isSafeInteger(matchOffsetBytes) || (matchOffsetBytes as number) < 0 ||
      !Number.isSafeInteger(artifactOffsetBytes) || (artifactOffsetBytes as number) < 0 ||
      !Number.isSafeInteger(matchBytes) || (matchBytes as number) < 1 ||
      (matchBytes as number) > 1024 ||
      !Number.isSafeInteger(contextOffsetBytes) || (contextOffsetBytes as number) < 0 ||
      typeof context !== "string"
    ) return false;
    const stream = match["stream"];
    const matchEnd = (matchOffsetBytes as number) + (matchBytes as number);
    const contextEnd = (contextOffsetBytes as number) + resultByteLength(context);
    if (
      !Number.isSafeInteger(matchEnd) || matchEnd > (capturedBytes as number) ||
      (artifactOffsetBytes as number) + (matchBytes as number) > (capturedBytes as number) ||
      !Number.isSafeInteger(contextEnd) || contextEnd > (capturedBytes as number) ||
      (matchOffsetBytes as number) < (contextOffsetBytes as number) || matchEnd > contextEnd ||
      resultByteLength(context) > DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_CONTEXT_BYTES
    ) return false;
    if (stream === "stdout") {
      if (seenStderr || artifactOffsetBytes !== matchOffsetBytes) return false;
    } else {
      seenStderr = true;
      const base = (artifactOffsetBytes as number) - (matchOffsetBytes as number);
      if (base < 0 || (stderrArtifactBase !== null && stderrArtifactBase !== base)) return false;
      stderrArtifactBase = base;
    }
    if ((matchOffsetBytes as number) < lastMatchEnd[stream]) return false;
    lastMatchEnd[stream] = matchEnd;
    contextBytes += resultByteLength(context);
    if (contextBytes > DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_TOTAL_CONTEXT_BYTES) return false;
  }
  return resultByteLength(result) <= DESKTOP_SHELL_OUTPUT_ARTIFACT_SEARCH_MAX_RESULT_BYTES;
}

type ApplyPatchEventProjection = Record<string, unknown> & {
  eventProjection: {
    kind: "apply_patch";
    totalPaths: number;
    shownPaths: number;
    totalChangedFiles: number;
    shownChangedFiles: number;
    totalDiffChars: number;
    shownDiffChars: number;
    totalErrorMessageChars: number;
    shownErrorMessageChars: number;
    scalarFieldsTruncated: boolean;
    truncated: boolean;
  };
};

type BrowserReadPageEventProjection = Record<string, unknown> & {
  eventProjection: {
    kind: "browser_read_page";
    totalContentCharacters: number;
    shownContentCharacters: number;
    totalBlocks: number;
    shownBlocks: number;
    contentTruncated: boolean;
    blocksTruncated: boolean;
    truncated: boolean;
  };
};

function resultByteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function eventResultFits(value: string): boolean {
  return resultByteLength(value) <= TOOL_RESULT_MAX_BYTES;
}

function splitUnifiedDiffSections(value: string): string[] {
  if (value === "") return [];
  const starts = [...value.matchAll(/^(?=diff --git |\*\*\* (?:Add|Update|Delete|Move) File:)/gm)]
    .map((match) => match.index ?? 0);
  if (starts.length === 0 || starts[0] !== 0) return [value];
  return starts.map((start, index) => value.slice(start, starts[index + 1]));
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function publicOperationCounts(value: unknown): Record<"add" | "update" | "move" | "delete", number> | undefined {
  const counts = record(value);
  if (counts === null) return undefined;
  const names = ["add", "update", "move", "delete"] as const;
  if (!names.every((name) => typeof counts[name] === "number")) return undefined;
  return {
    add: counts["add"] as number,
    update: counts["update"] as number,
    move: counts["move"] as number,
    delete: counts["delete"] as number,
  };
}

/**
 * Build a bounded UI-event view of an apply_patch result without changing the
 * complete ToolMessage result that is scanned and returned to the model.
 * Each kept path and diff item is whole and in source order, so the event is
 * always valid JSON rather than a sliced control payload.
 */
function projectApplyPatchResultForEvent(result: string): ToolResultEventProjection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const source = record(parsed);
  if (source === null) return null;

  const pathResults = Array.isArray(source["pathResults"]) ? source["pathResults"] : [];
  const changedFiles = Array.isArray(source["changedFiles"]) ? source["changedFiles"] : [];
  const unifiedDiff = typeof source["unifiedDiff"] === "string" ? source["unifiedDiff"] : "";
  const sourceError = record(source["error"]);
  const operationCounts = publicOperationCounts(source["operationCounts"]);
  const errorMessage = typeof sourceError?.["message"] === "string" ? sourceError["message"] : "";
  const projectedError: Record<string, unknown> | undefined = sourceError === null
    ? undefined
    : {
        ...(typeof sourceError["code"] === "string" ? { code: sourceError["code"] } : {}),
        ...(typeof sourceError["retryable"] === "boolean" ? { retryable: sourceError["retryable"] } : {}),
      };
  const base: Record<string, unknown> = {
    ...(typeof source["ok"] === "boolean" ? { ok: source["ok"] } : {}),
    ...(typeof source["status"] === "string" ? { status: source["status"] } : {}),
    ...(typeof source["partial"] === "boolean" ? { partial: source["partial"] } : {}),
    ...(typeof source["runtimeVersion"] === "string" ? { runtimeVersion: source["runtimeVersion"] } : {}),
    ...(typeof source["turnId"] === "string" ? { turnId: source["turnId"] } : {}),
    ...(operationCounts === undefined ? {} : { operationCounts }),
    ...(projectedError === undefined ? {} : { error: projectedError }),
    pathResults: [],
    changedFiles: [],
    revisionIds: [],
    unifiedDiff: "",
  };
  const projection: ApplyPatchEventProjection = {
    ...base,
    eventProjection: {
      kind: "apply_patch",
      totalPaths: pathResults.length,
      shownPaths: 0,
      totalChangedFiles: changedFiles.length,
      shownChangedFiles: 0,
      totalDiffChars: unifiedDiff.length,
      shownDiffChars: 0,
      totalErrorMessageChars: errorMessage.length,
      shownErrorMessageChars: 0,
      scalarFieldsTruncated: false,
      // Start pessimistically so toggling this metadata after packing can
      // only shrink the serialized event, never overflow the shared budget.
      truncated: true,
    },
  };

  const stringify = (): string => JSON.stringify(projection);
  if (!eventResultFits(stringify())) {
    // Defensive last resort for a malformed producer with an absurdly long
    // required-looking scalar. Contract results keep these values intact; this
    // branch only shortens a string enough to retain every field/count/total
    // in valid JSON under the existing global event budget.
    for (const key of ["runtimeVersion", "turnId"] as const) {
      const value = projection[key];
      if (typeof value !== "string") continue;
      let shortened = value;
      while (!eventResultFits(stringify()) && shortened.length > 0) {
        shortened = shortened.slice(0, Math.floor(shortened.length / 2));
        projection[key] = shortened;
        projection.eventProjection.scalarFieldsTruncated = true;
      }
    }
    return {
      result: stringify(),
      truncated: true,
    };
  }

  if (projectedError !== undefined && errorMessage !== "") {
    projectedError["message"] = errorMessage;
    if (eventResultFits(stringify())) {
      projection.eventProjection.shownErrorMessageChars = errorMessage.length;
    } else {
      delete projectedError["message"];
    }
  }

  const append = (key: "pathResults" | "changedFiles" | "revisionIds", value: unknown): boolean => {
    const values = projection[key] as unknown[];
    values.push(value);
    if (eventResultFits(stringify())) return true;
    values.pop();
    return false;
  };
  for (const pathResult of pathResults) {
    if (!append("pathResults", pathResult)) break;
    projection.eventProjection.shownPaths += 1;
  }
  for (const changedFile of changedFiles) {
    if (!append("changedFiles", changedFile)) break;
    projection.eventProjection.shownChangedFiles += 1;
  }
  const revisionIds = Array.isArray(source["revisionIds"]) ? source["revisionIds"] : [];
  for (const revisionId of revisionIds) {
    if (!append("revisionIds", revisionId)) break;
  }

  for (const section of splitUnifiedDiffSections(unifiedDiff)) {
    const prior = projection["unifiedDiff"] as string;
    projection["unifiedDiff"] = `${prior}${section}`;
    if (eventResultFits(stringify())) {
      projection.eventProjection.shownDiffChars += section.length;
      continue;
    }
    projection["unifiedDiff"] = prior;
    break;
  }
  const truncated =
    projection.eventProjection.shownPaths !== pathResults.length ||
    projection.eventProjection.shownChangedFiles !== changedFiles.length ||
    projection.eventProjection.shownDiffChars !== unifiedDiff.length ||
    projection.eventProjection.shownErrorMessageChars !== errorMessage.length ||
    (projection["revisionIds"] as unknown[]).length !== revisionIds.length;
  projection.eventProjection.truncated = truncated;
  return { result: stringify(), truncated };
}

/**
 * Preserve browser_read_page's metadata and continuation receipt when its
 * authoritative model result is larger than the shared ToolCard event budget.
 * The event gets a valid JSON preview; the complete ToolMessage is unchanged.
 */
function projectBrowserReadPageResultForEvent(result: string): ToolResultEventProjection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const source = record(parsed);
  if (source === null || typeof source["content"] !== "string" || !Array.isArray(source["blocks"]) ||
    (source["targetRole"] !== "interactive" && source["targetRole"] !== "research") ||
    typeof source["finalUrl"] !== "string" || typeof source["title"] !== "string" ||
    typeof source["returnedCharacters"] !== "number" ||
    source["returnedCharacters"] !== source["content"].length) {
    return null;
  }

  const content = source["content"];
  const blocks = source["blocks"];
  const projection: BrowserReadPageEventProjection = {
    ...source,
    content: "",
    blocks: [],
    eventProjection: {
      kind: "browser_read_page",
      totalContentCharacters: content.length,
      shownContentCharacters: 0,
      totalBlocks: blocks.length,
      shownBlocks: 0,
      contentTruncated: content.length > 0,
      blocksTruncated: blocks.length > 0,
      truncated: true,
    },
  };
  const stringify = (): string => JSON.stringify(projection);
  if (!eventResultFits(stringify())) return null;

  let low = 0;
  let high = content.length;
  while (low < high) {
    const candidateEnd = Math.ceil((low + high) / 2);
    let safeEnd = candidateEnd;
    const finalCodeUnit = content.charCodeAt(safeEnd - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) safeEnd -= 1;
    projection["content"] = content.slice(0, safeEnd);
    projection.eventProjection.shownContentCharacters = safeEnd;
    if (eventResultFits(stringify())) low = candidateEnd;
    else high = candidateEnd - 1;
  }
  let safeEnd = low;
  const finalCodeUnit = content.charCodeAt(safeEnd - 1);
  if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) safeEnd -= 1;
  projection["content"] = content.slice(0, safeEnd);
  projection.eventProjection.shownContentCharacters = safeEnd;
  projection.eventProjection.contentTruncated = safeEnd !== content.length;
  projection.eventProjection.truncated = projection.eventProjection.contentTruncated || blocks.length > 0;
  return { result: stringify(), truncated: projection.eventProjection.truncated };
}

function projectComputerResultForEvent(result: string): ToolResultEventProjection | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    return null;
  }
  const root = record(parsed);
  const presentation = record(root?.["presentation"]);
  const settlement = root?.["settlement"];
  const settlements = new Set([
    "completed", "not_completed", "unknown_completion", "cancelled",
    "revoked", "stale", "fenced", "failed",
  ]);
  if (root?.["version"] !== 1
    || typeof root?.["ok"] !== "boolean"
    || typeof settlement !== "string"
    || !settlements.has(settlement)
    || root["ok"] !== (settlement === "completed")
    || presentation === null
    || Object.keys(presentation).length !== 2
    || typeof presentation["label"] !== "string"
    || typeof presentation["summary"] !== "string"
  ) {
    return null;
  }
  // The Workbench Computer Use renderer consumes only this sealed DTO. The
  // detailed semantic result remains intact in model state and durable
  // history; live event projection discloses that it was omitted without
  // duplicating any versioned Computer Use operation grammar here.
  const projected = JSON.stringify({
    version: 1,
    ok: root["ok"],
    settlement,
    presentation,
    eventProjection: { kind: "computer_use", resultOmitted: true },
  });
  return eventResultFits(projected) ? { result: projected, truncated: true } : null;
}

/**
 * Shared tool-end event projection. Ordinary results retain the historical
 * display cap behavior. apply_patch instead receives a JSON-safe presentation
 * view so the authoritative scanned ToolMessage/model result is never sliced.
 */
export function projectToolResultForEvent(
  toolName: string,
  result: string,
): ToolResultEventProjection {
  if (toolName === "apply_patch") {
    const projected = projectApplyPatchResultForEvent(result);
    if (projected !== null) return projected;
  }
  if (toolName === "browser_read_page" && !eventResultFits(result)) {
    const projected = projectBrowserReadPageResultForEvent(result);
    if (projected !== null) return projected;
  }
  if (toolName.startsWith("computer_")
    && !eventResultFits(result)) {
    // AgentToolCallTracker has already converted Computer Use output to the
    // closed semantic envelope. Preserve valid JSON for the sealed renderer:
    // byte-slicing an oversized observation corrupts that envelope and makes
    // a successful desktop read appear to fail in the live card.
    const projected = projectComputerResultForEvent(result);
    if (projected !== null) return projected;
  }
  // retain only a strict, independently bounded DesktopShellResult.
  // Prefix matching here would let a compromised relay bypass WS limits.
  if (toolName === "run_shell" && isBoundedDesktopShellResult(result)) {
    return { result, truncated: false };
  }
  if (toolName === "run_shell" && isBoundedDesktopShellOutputArtifactPage(result)) {
    return { result, truncated: false };
  }
  if (toolName === "run_shell" && isBoundedDesktopShellOutputArtifactSearch(result)) {
    return { result, truncated: false };
  }
  if (result.length <= TOOL_RESULT_MAX_BYTES || isStagedToolResult(result)) {
    return { result, truncated: false };
  }
  const keep = TOOL_RESULT_MAX_BYTES;
  const truncatedBytes = result.length - keep;
  return {
    result: `${result.slice(0, keep)}\n…[${truncatedBytes} bytes truncated]`,
    truncated: true,
  };
}

/**
 * server-enriched context for `share_memory` ask / prove_it UIs.
 * The LLM marks `sensitivity`; the server does not run a content classifier.
 *
 * -P3: `targetHandle`, `targetDisplayName`, `roomLabel`, `wouldCreate`,
 * and `sensitivity` are computed in lockstep with {@link ShareArtifactApprovalPreview}
 * via `resolveShareApprovalTargetRoomPreview` in `@nautilo/agent` — do not drift.
 */
export interface ShareMemoryApprovalPreview {
  /** Content-free exact-plan binding; never a key or mutation capability. */
  protectedApprovalDigest?: string;
  memoryContentSnippet: string;
  memoryType: string | null;
  targetHandle: string;
  targetDisplayName: string;
  roomLabel: string | null;
  wouldCreate: boolean;
  sensitivity: "normal" | "sensitive";
  /** projection previews contain only destination-safe text. */
  projection?: {
    mode: "project";
    /** Existing exact prepared-preview deadline; not a new client-side TTL. */
    expiresAt?: number;
    content: string;
    roomLabel: string;
    roomKind: "private" | "group" | "multi_agent" | "subthread" | "open" | "task" | "access";
    memberCount: number;
    audienceWarning: string;
  } | undefined;
}

/** M088A — server-enriched context for `share_artifact` ask / prove_it UIs.
 *
 * -P3: parallel fields to {@link ShareMemoryApprovalPreview} (`targetHandle` …
 * `sensitivity`) must stay aligned in the agent preview helpers.
 */
export interface ShareArtifactApprovalPreview {
  artifactPathSnippet: string;
  mimeType: string;
  size: number;
  targetHandle: string;
  targetDisplayName: string;
  roomLabel: string | null;
  wouldCreate: boolean;
  sensitivity: "normal" | "sensitive";
}

export interface ProveItToolInfo {
  name: string;
  args: Record<string, unknown>;
  id?: string | undefined;
  /** exact long-wait intent for an approved run_shell call. This is
   * rendered separately from the compact generic argument preview. */
  runShellTimeout?: {
    readonly timeoutSeconds: number;
    /** Model-provided execution intent, untruncated after credential redaction. */
    readonly reason: string;
  } | undefined;
  /** present when `name === "share_memory"`. */
  shareMemoryPreview?: ShareMemoryApprovalPreview | undefined;
  /** M088A — present when `name === "share_artifact"`. */
  shareArtifactPreview?: ShareArtifactApprovalPreview | undefined;
}

/** Public, secret-free exact effect for one  local MCP install ask. */
export interface LocalMcpInstallApproval {
  readonly version: "local-mcp-install-v1";
  readonly digest: string;
  readonly preview: import("./local-mcp-install").LocalMcpInstallApprovalPreview;
}

/** Secret-free exact Human review for one Electron-prepared structured SSH call. */
export interface StructuredSshApproval {
  readonly version: "structured-ssh-v1";
  readonly toolCallId: string;
  readonly approvedRequestDigest: string;
  readonly preparationId: string;
  readonly operation: "auth" | "exec" | "copy-upload" | "copy-download";
  readonly host: string;
  readonly port: number;
  readonly remoteUser: string;
  readonly hostKeyFingerprint: string;
  readonly hostTrust: "trusted" | "unknown" | "changed";
  readonly previousHostKeyFingerprint?: string | undefined;
  /** Present only for the bounded exec request; never a shell command string. */
  readonly program?: string | undefined;
  readonly argv?: readonly string[] | undefined;
  /** Present only for bounded SCP operations; local authority remains Electron-local. */
  readonly localPath?: string | undefined;
  /** Literal remote SCP path, never a shell command. */
  readonly remotePath?: string | undefined;
  /** Exact finite foreground-operation budget included in the approved digest. */
  readonly timeoutSeconds?: number | undefined;
  readonly timeoutReason?: string | undefined;
}

export interface ProveItChallengeEvent {
  type: "prove_it.challenge";
  /** Exact checkpoint interrupt; optional for frozen/legacy clients. */
  challengeId?: string;
  threadId: string;
  laneKey: string;
  tools: ProveItToolInfo[];
  /** human who must receive this challenge over WS (user-scoped delivery). */
  userId?: string | undefined;
  /** present when this challenge originated from a Task/subagent run. */
  taskId?: string;
  /** the `task_runs.id` for the parked run. */
  taskRunId?: string;
  /** `"task"` marks a Task/subagent-originated approval so the workbench
   *  bypasses active-room filtering. Absent for main-thread approvals. */
  origin?: "task";
}

/**
 * The reason the approval dialog is firing. Maps to the severity-resolver
 * verb and the specific signal that selected it. Clients render a short
 * explanation in the dialog's "why this is gated" line.
 */
export type ApprovalAskReason =
  | "command-scanner-medium"
  | "command-scanner-high"
  | "external-binary"
  | "destructive-tool"
  | "network-egress-denied"
  | "tier-bump"; // security-level shifted the tier map (e.g. cautious)

/**
 * one slot of a generalized command signature. A tool call is
 * abstracted to `toolName` + an ordered list of slots; `room`/`always`
 * standing-approval rules persist + match on the canonical serialization
 * of this structure (`signatureKey`).
 *
 * Wire-safe (no server-only deps) so the dock (browser), `@nautilo/db`,
 * and `@nautilo/trust` can all reference it.
 *
 * - `literal` — structural token (verb, command, subcommand). Equality.
 * - `directory` — a path/dir generalized to its parent dir. Prefix.
 * - `path` — any path (reserved; rare).
 * - `arg` — a generalized opaque operand (shell tokenizer output).
 * - `exact` — pinned exact value for an opaque-kind param. Equality.
 */
export type CommandSignatureSlot =
  | { kind: "literal"; token: string }
  | { kind: "directory"; parent: string }
  | { kind: "path" }
  | { kind: "arg" }
  | { kind: "exact"; arg: string; value: string };

export interface CommandSignature {
  toolName: string;
  slots: CommandSignatureSlot[];
}

export interface ApprovalAskNetworkContext {
  readonly host: string;
  readonly port: number;
  readonly reason: string;
  readonly suggestedRule: {
    readonly type: "domain" | "wildcard" | "cidr";
    readonly host?: string;
    readonly suffix?: string;
    readonly cidr?: string;
    readonly ports?: readonly number[];
  };
}

/**
 *  `ask`-verb challenge. Sibling of `ProveItChallengeEvent`.
 *
 * Fires when `resolveApproval(...)` returns `verb === "ask"` in
 * `post-model.ts`. The client presents a four-button dialog (see
 * `ApprovalReplyVerb`). PIN is NOT required for this flow — ask is the
 * light-approval tier, distinct from prove_it's proof-of-human gate.
 *
 * The client replies via `POST /api/auth/approval-reply` with a
 * `ApprovalReplyVerb`. The graph resumes accordingly.
 */
export interface ApprovalAskEvent {
  type: "approval.ask";
  approvalId: string;
  threadId: string;
  laneKey: string;
  tools: ProveItToolInfo[];
  /** keys pending network audit context per authenticated user. */
  userId?: string | undefined;
  /** Human-readable "why this is gated" line for the dialog. */
  reason: string;
  /** Machine-readable reason code for client-side theming / analytics. */
  reasonCode: ApprovalAskReason;
  /** Optional  network destination context. URL path/query/body/headers are intentionally absent. */
  network?: ApprovalAskNetworkContext;
  /** Subset of reply verbs the client may offer. Currently always the
   *  full four; a future config option might restrict e.g. hide "always"
   *  in strict modes or when no matcher is available. */
  allowedVerbs: ApprovalReplyVerb[];
  /**
   * per-tool, server-classified display + generalization grain so
   * the client renders exactly what each scope grants without
   * re-classifying. Index-aligned with `tools`. Optional on the wire so
   * older clients degrade gracefully (they just won't show the grain line).
   */
  scopeInfo?: ApprovalScopeInfo[];
  /** exact local MCP launch requiring one explicit, non-standing approval. */
  localMcpInstall?: LocalMcpInstallApproval | undefined;
  /** exact paid media quote requiring one explicit, non-standing approval. */
  mediaGeneration?: MediaGenerationApproval | undefined;
  /** exact Electron-local SSH target selected after the first approval. */
  structuredSsh?: StructuredSshApproval | undefined;
  /** When true clients must not auto-resolve or offer room/always scope. */
  requiresExplicitReview?: boolean | undefined;
  /** present when this challenge originated from a Task/subagent run. */
  taskId?: string;
  /** the `task_runs.id` for the parked run. */
  taskRunId?: string;
  /** `"task"` marks a Task/subagent-originated approval so the workbench
   *  bypasses active-room filtering. Absent for main-thread approvals. */
  origin?: "task";
}

/** pre-approval choice among currently eligible paired computers. */
export interface HostChoiceEvent {
  type: "host.choice";
  choiceId: string;
  threadId: string;
  laneKey: string;
  toolCallId: string;
  toolName: string;
  options: Array<{ selector: string; label: string }>;
  /** Requester-private WebSocket routing key. */
  userId?: string;
}

/** Owner-private prompt to complete a connected website sign-in journey. */
export interface ConnectedWebAccountActionAttentionEvent {
  type: "connected_web.action_attention";
  threadId: string;
  laneKey: string;
  /** The exact LangGraph action tool call and durable delivery identity. */
  toolCallId: string;
  /** Requester-private WebSocket routing key; route authorization rechecks it. */
  userId: string;
  intervention:
    | { kind: "authentication_required"; mode: "connect"; reason: "not_connected"; target: { selector: string } }
    | { kind: "authentication_required"; mode: "reconnect"; reason: "reconnect" | "sign_in" | "mfa" | "captcha"; account: { id: string; label: string; service: string; origin: string } };
}

/** Requester-private recovery UI truth when resume and safe cancellation fail. */
export interface ConnectedWebAccountActionResumeFailedEvent {
  type: "connected_web.action_resume_failed";
  threadId: string;
  laneKey: string;
  toolCallId: string;
  userId: string;
  /** Whether durable protected-execution truth admits exact Cancel recovery. */
  cancelRecovery: "available" | "unavailable";
}

/**
 * authoritative approval terminal event.
 *
 * The Workbench approval lifecycle reducer
 * (`apps/workbench/src/approval/approval-lifecycle.ts`) keys every
 * approval by `approvalId`. A lost `POST /api/auth/approval-reply`
 * HTTP acknowledgement must NOT be inferred from unrelated
 * `tool.end` / `job.status` events; the dock must reconcile on
 * authoritative terminal evidence. This event is that evidence.
 *
 * The server's approval-reply path
 * (`packages/server/src/routes/auth.ts` → `POST
 * /api/auth/approval-reply`) emits this event after the canonical
 * main-thread or Task resume settles. Production is requester-private
 * (`userId`) and idempotent per requester/approval id.
 *
 * `resolution` carries the terminal disposition. `verb` echoes the
 * reply verb when the resolution followed an HTTP reply (absent for
 * server-side cancellation / expiry). Idempotent: a second
 * `approval.resolved` for an already-terminal id is a no-op in the
 * reducer.
 */
export interface ApprovalResolvedEvent {
  type: "approval.resolved";
  approvalId: string;
  threadId: string;
  /**
   * Requester-private WS routing key. Required and fail-closed: approval
   * terminal state must never room-fan-out to other room members.
   */
  userId: string;
  laneKey?: string | undefined;
  resolution: "approved" | "denied" | "cancelled" | "expired";
  /** Echoes the reply verb when the resolution followed an HTTP reply. */
  verb?: ApprovalReplyVerb | undefined;
  /** present when this approval originated from a Task/subagent run. */
  taskId?: string;
  taskRunId?: string;
  origin?: "task";
}

/**
 * Auto-Approve session-mode boundary predicate.
 *
 * The single, named, testable home for the security boundary of the
 * ephemeral Auto-Approve mode, shared by every client (desktop workbench
 * and mobile). It decides whether an incoming ask-tier `approval.ask`
 * should be auto-resolved (verb `"once"`) WITHOUT surfacing the approval
 * dock/card.
 *
 * The rule maps ONLY `ask → auto`, and deliberately carves out
 * network-egress asks so egress stays gated even in Auto-Approve mode
 * (derive `hasNetworkContext` from `ApprovalAskEvent.network != null`).
 * `prove_it` / `identity` challenges never reach this predicate — they are
 * separate WS event cases on each client and remain PIN-gated by
 * construction. Critical-block / capability-forbidden / sandbox
 * containment / run_shell hard-timeout are all enforced server-side and
 * are unaffected by this client-side auto-reply (which routes through the
 * same `approvalReply` endpoint the manual dock uses, so the server
 * re-validates every reply).
 *
 * Pure (no React, no WS binding) so the boundary is unit-testable in
 * isolation and greppable by name across clients.
 */
export interface AutoResolveAskInput {
  /** Session Auto-Approve mode enabled? */
  enabled: boolean;
  /**
   * Does this ask carry a network-egress destination context? When true
   * the ask must still surface (network egress stays gated), so we do NOT
   * auto-resolve.
   */
  hasNetworkContext: boolean;
  /** Exact-effect approvals (e.g. local MCP install) must always render. */
  requiresExplicitReview?: boolean;
  /**
   * A prepared structured-SSH operation may use session Auto-Approve only
   * after the destination host key is already trusted. First-use and changed
   * host keys remain visible trust-establishment decisions.
   */
  structuredSshHostTrust?: StructuredSshApproval["hostTrust"] | undefined;
}

/**
 * True iff an ask-tier approval should be auto-resolved with `"once"`
 * without showing the dock/card. Auto-resolve only when the mode is on AND
 * the ask is not a network-egress ask.
 */
export function shouldAutoResolveAsk({
  enabled,
  hasNetworkContext,
  requiresExplicitReview = false,
  structuredSshHostTrust,
}: AutoResolveAskInput): boolean {
  const exactReviewAllowsSessionAutoApprove = !requiresExplicitReview ||
    structuredSshHostTrust === "trusted";
  return enabled && !hasNetworkContext && exactReviewAllowsSessionAutoApprove;
}

/**
 * the generalization grain for one pending tool call, computed
 * server-side by the command-approval classifier. Index-aligned with
 * {@link ApprovalAskEvent.tools}.
 */
export interface ApprovalScopeInfo {
  /** Literal command rendering, for the "Once" verb. */
  onceDisplay: string;
  /** Generalized signature rendering, for the "This room" / "Always" verbs. */
  generalizedDisplay: string;
  /** True when nothing generalizes (opaque tool) — room/always persist an exact match. */
  sameAsOnce: boolean;
  /**
   *  capability substrate — when present, `room`/`always` persist a
   * capability-scoped standing approval instead of an exact command signature.
   * Absent or `"tool"` keeps the legacy exact-command grain.
   */
  approvalKind?: "tool" | "capability";
  /** Populated when `approvalKind === "capability"` — the slug room/always grants. */
  capabilitySlug?: string;
}

/**
 * The user's response to an `approval.ask` dialog.
 *
 *  replaced the in-memory, lane-scoped `session` verb with a durable,
 * DB-backed `room` scope. The four verbs are now:
 *
 * - `once` — approve this single invocation only (no persistence)
 * - `room` — write a standing-approval rule scoped to the current room
 *              (DB; matches a generalized signature for this user in this room)
 * - `always` — write a server-wide standing-approval rule for this user (DB)
 * - `deny` — reject this invocation
 *
 * Both `room` and `always` persist via the command-approval engine
 * (`packages/trust/src/command-approvals.ts`) and short-circuit the `ask`
 * verb only — never `prove_it` / `block`.
 */
export type ApprovalReplyVerb = "once" | "room" | "always" | "deny";

export interface WorkerCompleteEvent {
  type: "worker.complete";
  jobId: string;
  result: "success" | "failed" | "timed_out";
}

export interface VoiceStatusEvent {
  type: "voice.status";
  voice: "on" | "off";
  speaking: boolean;
}

export interface VoiceSentenceEvent {
  type: "voice.sentence";
  /** Immutable execution identity; never derived from a sentence index. */
  turnId?: string | undefined;
  text: string;
  index: number;
  final: boolean;
  /** Room that produced the speech; clients use it for local foreground gating. */
  roomId?: string | undefined;
  userId?: string | undefined;
  /** speaking agent; `TtsService` resolves its `voices` map. */
  agentId?: string | undefined;
  /**
   * BCP-47 from a `<voice lang="…">` span the detector parsed and
   * stripped. Absent = untagged → resolver uses `voices.default`. The
   * detector emits language only; voiceId resolution lives in `TtsService`.
   */
  lang?: string | undefined;
}

/**
 * emitted when the agent spoke a `<voice lang="xx">` span but the
 * profile has no `voices[xx]` (resolution fell back to `voices.default`).
 * Clients show a one-time, per-(agent,language) debounced "assign a voice?"
 * prompt. Server debounces so one turn emits at most one per language.
 */
export interface VoiceSuggestionEvent {
  type: "voice.suggestion";
  language: string;
  userId?: string | undefined;
  agentId?: string | undefined;
}

export interface VoiceAudioEvent {
  type: "voice.audio";
  turnId?: string | undefined;
  data: string;
  chunkIndex: number;
  sentenceIndex: number;
  final: boolean;
  /** Origin Room copied from `voice.sentence` for client-local playback gating. */
  roomId?: string | undefined;
  userId?: string | undefined;
}

export interface VoiceStopEvent {
  type: "voice.stop";
  turnId?: string | undefined;
}

/** Runtime-only terminal speech fence; never a Room broadcast. */
export interface VoiceTurnEndEvent {
  type: "voice.turn.end";
  userId: string;
  agentId: string;
  turnId: string;
  outcome: "completed" | "aborted";
}

/** Emitted after `PUT /api/profile` so clients can re-fetch full profile. */
export interface ProfileUpdatedEvent {
  type: "profile.updated";
  profileId: string;
  name: string;
  onboardingCompleted: boolean;
  /** user-scoped WS delivery. */
  userId?: string | undefined;
}

/**
 * flavor of identity challenge.
 *
 *  - `verify` — the user is signed in but the server wants a fresh
 *                  PIN proof for a sensitive operation (existing
 *                  flow, default for back-compat). Legacy
 *                  `POST /api/auth/verify-and-resume` was removed
 *                  post- (404) — use
 *                  `POST /api/auth/identity-verify-resume` instead.
 *  - `enrollPin` — the user is Logto-authenticated but doesn't yet
 *                  have a PIN, and a `prove_it` is pending (or they
 *                  proactively asked to set one). Submit goes to
 *                  `POST /api/auth/pin` with just `{ pin }`. After
 *                  successful enrollment the server re-emits the
 *                  original `prove_it.challenge`.
 */
export type IdentityChallengeMode = "verify" | "enrollPin";

export interface IdentityChallengeEvent {
  type: "identity.challenge";
  laneKey: string;
  challengeId: string;
  expiresAt: string;
  threadId: string;
  /** human scoped delivery for WS filtering. */
  userId?: string | undefined;
  /**
   * Optional for back-compat — older servers omit it; clients treat
   * absence as `"verify"`.
   */
  mode?: IdentityChallengeMode;
  /** present when this challenge originated from a Task/subagent run. */
  taskId?: string;
  /** the `task_runs.id` for the parked run. */
  taskRunId?: string;
  /** `"task"` marks a Task/subagent-originated approval so the workbench
   *  bypasses active-room filtering. Absent for main-thread approvals. */
  origin?: "task";
}

/**
 * Emitted after `PUT /api/security/posture` successfully mutates the
 * server posture.
 *
 * Live clients listen for this and re-read `GET /api/security/posture`
 * so their UI (Settings modal, status bar badge) reflects the new
 * state without a manual refresh. Sandbox profile takes effect on
 * the next tool-call turn when the Policy Resolver reads posture
 * at envelope-construction time (G5.4).
 *
 * Payload excludes the PIN + raw actor IP: those go into the JSONL
 * audit log (server-side only), not over the wire to every client.
 */
export interface PostureChangedEvent {
  type: "policy.changed";
  deploymentMode: "server" | "desktop-permissive" | "desktop-locked";
  securityLevel: "yolo" | "permissive" | "standard" | "cautious" | "paranoid";
  networkPolicy:
    | { mode: "host" }
    | { mode: "isolated" }
    | {
        mode: "proxy-allowlist";
        allow: readonly (
          | { type: "domain"; host: string; ports?: readonly number[] | undefined }
          | { type: "wildcard"; suffix: string; ports?: readonly number[] | undefined }
          | { type: "cidr"; cidr: string; ports?: readonly number[] | undefined }
        )[];
        defaultPort?: 443 | undefined;
      };
  /** ISO-8601 timestamp of the mutation. */
  at: string;
}

/**
 * Content-free invalidation hint emitted after the canonical encryption
 * transition policy commits. Clients must re-read policy and admission;
 * this event is never authorization authority.
 */
export interface EncryptionPolicyChangedEvent {
  type: "encryption.policy.changed";
  policyRevision: number;
}

/**
 * reactive revision-state signal.
 *
 * Emitted whenever the revision store for a given path changes:
 *   - After a successful `recordRevision` insert (agent applied a
 *     file mutation; now there's at least one revision to walk
 *     back to).
 *   - After a GC sweep evicts rows (the revision count for that
 *     path just dropped; if it went to 0 the UI's undo affordances
 *     should disable).
 *
 * The workbench's `useRevisionState(path?)` hook subscribes to this
 * event, filters by path, and derives `{ canUndo, canRedo,
 * latestSummary }` for the undo/redo bar + context menu.
 *
 * `latest` is null when the event is an eviction that dropped the
 * last revision for the path. Clients treat `availableRevisions=0
 * && latest=null` as "undo affordance off."
 */
export interface RevisionsStateChangedEvent {
  type: "revisions.state_changed";
  agentId: string;
  path: string;
  availableRevisions: number;
  latest: {
    revisionId: string;
    turnId: string;
    createdAt: string;
    operation: string;
    summary: string;
    pinned: boolean;
    /** True when this revision is itself the acceptance of a prior
     *  undo (restore_from_revision_id is non-null). Lets the UI
     *  distinguish "forward" vs "redo-eligible" history at a glance. */
    redoEligible: boolean;
  } | null;
}

/** transcript append failed after `appendTranscriptMessages` threw. */
export interface SessionPersistenceFailedEvent {
  type: "session.persistence_failed";
  threadId: string;
  sessionId: string | null;
  errorCode: string;
  droppedCount: number;
}

/** coalesced chat send buffered (no DB row yet for this id). */
export interface JobCoalescedEvent {
  type: "job.coalesced";
  virtualJobId: string;
  laneKey: string;
}

/** merged/coalesced work mapped to a persisted foreground job id. */
export interface JobDispatchedEvent {
  type: "job.dispatched";
  virtualJobIds: string[];
  jobId: string;
  laneKey: string;
}

/** foreground job ran on a fork checkpoint thread (busy lane). */
export interface JobForkedEvent {
  type: "job.forked";
  laneKey: string;
  jobId: string;
  virtualJobIds: string[];
  parentThreadId: string;
  forkThreadId: string;
  parentJobId?: string;
  syntheticNoteCount: number;
  sequence: number;
}

/** fork output merged into canonical parent graph checkpoint in order. */
export interface ForkSplicedEvent {
  type: "fork.spliced";
  laneKey: string;
  jobId: string;
  parentThreadId: string;
  forkThreadId: string;
  sequence: number;
  splicedMessageCount: number;
}

/** membership change; client invalidates room roster + rehydrates active transcript. */
export type RoomMembershipSystemEventPayload = {
  kind: "member_added" | "member_removed";
  actorId: string;
  actorKind: "user" | "agent";
  displayName: string;
};

export interface RoomMembersChangedEvent {
  type: "room_members_changed";
  roomId: string;
  event: RoomMembershipSystemEventPayload;
  /**
   * server-authored, content-free wake-up for an eligible protected
   * Room while Shadow or Full encryption is active. Clients must still re-plan and
   * the protected authority route revalidates the exact current roster.
   */
  recipientSyncNamespaceId?: string;
}

/**
 * A viewer-private hint that the authoritative Room list changed.
 *
 * The frame deliberately carries no Room or user identifier. Recipients must
 * refetch their authorized catalogue; the server selects the user-scoped WS
 * audience separately from the wire payload.
 */
export interface RoomCatalogChangedEvent {
  type: "room.catalog.changed";
}

/**
 * Stack-3 Phase 6b — typing indicator ping (ephemeral, fire-and-forget).
 *
 * Clients emit `typing.ping` over WS at most every {@link TYPING_PING_INTERVAL_MS}
 * while the user is actively composing. The server relays each ping to
 * room peers (excluding the sender). Receivers keep an in-memory map of
 * `userId → lastPingAt` and render `displayName` as "typing…" while
 * `now - lastPingAt < TYPING_DECAY_MS`. No persistence, no per-room
 * server-side state, no auto-stop timer — when the user stops typing,
 * the pings simply stop and the indicator decays naturally.
 */
export interface TypingPingEvent {
  type: "typing.ping";
  roomId: string;
  userId: string;
  displayName: string;
}

/** How often the client emits while the user is actively typing. */
export const TYPING_PING_INTERVAL_MS = 3000;

/** How long after the last received ping the indicator stays visible. */
export const TYPING_DECAY_MS = 5000;

/**
 * fallback hop notification.
 *
 * Emitted ONCE per fallback attempt inside `invokeChatModelWithFallback`,
 * BEFORE the next model is invoked. Lets the workbench render a
 * "<from> failed — trying <to>" status notice while the chain walks.
 *
 * Privacy posture (mirrors JobStatusEvent failed):
 *   - Room-scoped via `laneKey: "room:<uuid>"`. Every member of a
 *     multi-user room receives the event — same scope as job.status.
 *   - Carries ONLY zero-content metadata: catalog model IDs (public
 *     identifiers) + the 7-bucket `reason` enum (no prompt content,
 *     no model output). The raw provider blob stays in `server.log`
 *     via `formatProviderError`, identical to LD-8.
 *   - No `details` / `error.message` / similar fields. Forward-compat
 *     guard: anyone adding fields here must justify against the LD-8
 *     contract first.
 *
 * Emitter side: `packages/agent/src/utils/chat-model-invocation.ts`
 * via `emitAgentEvent` (`runtime-hooks.ts` sink). The runtime layer
 * wires the sink to `eventBus.emit` at server startup.
 *
 * Consumer side: `apps/workbench/src/adapters/nautilo-runtime.tsx`
 * extends its ServerEvent switch with a `"model.fallback"` case that
 * sets `modelFallbackStatus` (status UI only — never assistant prose
 * or TTS). It renders as a detached `ModelFallbackStatusNotice` pill
 * with a turn-scoped auto-expiry + manual dismiss, NOT attached
 * to the assistant bubble.
 *
 *
 */
/**
 * periodic "agent is working" heartbeat during model + post-model
 * latency, when no visible token has flowed recently. Drives an in-thread
 * "working…" affordance so a long gap between streamed text and a tool reads
 * as "still working," not "hung." Room-scoped via `laneKey` (routed like
 * `message.tokens`). Privacy parity with `job.status` / `model.fallback`:
 * carries ONLY zero-content metadata (no prompt content, no model output).
 */
export interface AgentProgressEvent {
  type: "agent.progress";
  /** "room:<uuid>" — room-scoped routing identical to message.tokens. */
  laneKey: string;
  /** Correlates the heartbeat to the in-flight assistant turn. */
  turnId: string;
  /** Stable assistant author id for multi-agent rooms (mirrors message.tokens). */
  authorAgentId?: string;
  /** Coarse phase so the UI can label the wait. No content ever. */
  phase: "thinking" | "preparing_tool" | "post_model";
}

export interface ModelFallbackEvent {
  type: "model.fallback";
  /** "room:<uuid>" — room-scoped routing identical to job.status. */
  laneKey: string;
  /** Correlates the hop to the in-flight assistant turn. */
  turnId: string;
  /** Catalog model ID that just failed (e.g. "anthropic:claude-sonnet-4-6"). */
  from: string;
  /** Catalog model ID about to be tried (e.g. "openai:gpt-5.5-2026-04-23"). */
  to: string;
  /**
   * 7-bucket category of the failure that triggered the hop. Same
   * enum as `JobStatusEvent.errorCategory`; mirror the union here
   * because @nautilo/types is the canonical wire-protocol home and
   * `FriendlyErrorCategory` lives in @nautilo/agent (no upward dep).
   */
  reason:
    | "timeout"
    | "rate_limit"
    | "auth"
    | "bad_request"
    | "context_exceeded"
    | "provider_unavailable"
    | "unknown";
}

/**
 *  (D-C) — the Room Conductor's Floor Manager chose `ask_user`: routing
 * was ambiguous and the user should disambiguate which assistant responds.
 * Server-side end-to-end in ; the workbench single-select picker is a
 * follow-up. NO bot is woken when this fires. Requester-private via `userId`;
 * `laneKey` and `roomId` are correlation aids only.
 *
 * `options[].botActorId` is an actor id the client echoes back as
 * `uiSelectedBotActorId` on the user's choice (same input path as
 * UI-selection). This is NOT the "LLM never sees IDs" surface — that contract
 * governs the Floor Manager prompt only; clients legitimately use actor ids.
 */
export interface ConductorAskUserEvent {
  type: "conductor.ask_user";
  /** "room:<uuid>" — kept for client room correlation; delivery is requester-private via `userId`. */
  laneKey: string;
  roomId: string;
  /** Requester's user id — drives requester-private WS delivery. */
  userId: string;
  /** Actor id of the user who sent the ambiguous message. */
  userActorId: string;
  /** Persisted human-message id (null when not synchronously known). */
  messageId: string | null;
  /**
   *  R13 — turn fingerprint of the already-persisted human message. The
   * client echoes it back as `resumeTurnId` on the disambiguation pick so the
   * woken bot's turn reuses the same fingerprint and the read-time collapse
   * dedupes the re-sent human row (no double-post). Null on legacy emitters.
   */
  humanTurnId?: string | null;
  options: { botActorId: string; handle: string }[];
  reason: string;
}

/**
 *  follow-up — the requester's Conversational Focus set changed
 * server-side (a Floor Manager / Conductor wake opened or extended focus, or a
 * focus lapsed/cleared). Focus is viewer-private, so although this is delivered
 * room-scoped via `laneKey`, the client only acts on it when `userActorId`
 * matches the viewer; it then re-fetches `GET /api/rooms/:id/focus`. Carries
 * `source`/`reason` so the focus ring can show WHY a bot lit up (e.g. a
 * vocative or history-intent wake) without an extra round-trip.
 */
export interface ConductorFocusChangedEvent {
  type: "conductor.focus_changed";
  /** "room:<uuid>" — room-scoped routing (same as conductor.ask_user). */
  laneKey: string;
  roomId: string;
  /** Actor id of the user whose focus set changed (focus is viewer-private). */
  userActorId: string;
  change: "opened" | "extended" | "cleared";
  botActorId: string;
  /** focus_events.source on opened/extended; null on cleared. */
  source: "mention" | "reply" | "ui" | "inferred" | null;
  /** Human-readable routing reason on opened/extended; null on cleared. */
  reason: string | null;
}

/**
 *  follow-up — transient Conductor routing-lifecycle signal for a single
 * user's inbound message in a group room. `deciding` brackets the
 * `routeRoomMessage` pass (including any Floor Manager LLM call); `settled`
 * fires once the decision resolves. Powers the transient "Routing… / Deciding
 * who replies…" chrome status. Room-scoped via `laneKey`; viewer-gated on
 * `userActorId` like `conductor.focus_changed`.
 */
export interface ConductorRoutingEvent {
  type: "conductor.routing";
  /** "room:<uuid>" — room-scoped routing. */
  laneKey: string;
  roomId: string;
  /** Actor id of the user whose message is being routed. */
  userActorId: string;
  state: "deciding" | "settled";
}

/**
 * Stack-162 — stable, controlled reason code for a `conductor.decision`
 * receipt. Derived from the Conductor's controlled decision reasons (the
 * deterministic router's exact reason strings + the Floor Manager's
 * fixed failure suffixes), NEVER from model-generated reason text. A
 * `*_router` code is the generic fallback: it tells the client "the
 * router decided" without forwarding any model-produced semantic detail,
 * which is the data-leak boundary this event exists to enforce.
 */
export type ConductorDecisionReasonCode =
  | "wake_mention"
  | "wake_reply"
  | "wake_ui"
  | "wake_active_focus"
  | "wake_vocative"
  | "wake_history"
  | "wake_router"
  | "silent_human_addressed"
  | "silent_no_route"
  | "silent_not_addressed"
  | "silent_no_wakeable"
  | "silent_router_unresolved"
  | "silent_router"
  | "ask_ambiguous_direct"
  | "ask_ambiguous_history"
  | "ask_router"
  | "routing_error"
  //  (3.2.1) — controlled redirect accepted/rejected codes for the
  // requester-private `conductor.decision` receipt. Phase 4's redirect producer
  // passes a controlled `RedirectOutcomeCode` to the server-side classifier,
  // which maps it to one of these wire codes. The receipt carries ONLY the
  // code + a server-authored display sentence + (for accepted) the target's
  // public roster handle — never the raw model/tool reason, trace, or ids.
  // Use the shared closed vocabulary below.
  | "redirected"
  | "redirect_rejected_explicitly_selected"
  | "redirect_rejected_visible_output"
  | "redirect_rejected_duplicate"
  | "redirect_rejected_no_target"
  | "redirect_rejected_ineligible_target"
  | "redirect_rejected_same_source"
  | "redirect_rejected_enqueue_failed";

/**
 * Stack-162 — a requester-private "settled routing decision" receipt.
 *
 * Distinct from the generic `conductor.routing` lifecycle event (which only
 * carries `deciding|settled` and is room-scoped): this event carries a
 * privacy-safe explanation of the Conductor's terminal decision for the user
 * who sent the message, so they understand why an agent did or did not reply
 * (e.g. "Jeannie selected — active focus" or "No reply — message not
 * agent-addressed").
 *
 * Privacy boundary (server-enforced, not merely client-hidden):
 *   - Delivered ONLY to the requester. `inferDeliveryScope` routes this by
 *     `userId` to `{ kind: "user", userId }` — no other room member receives
 *     it, even on the room lane. This is the load-bearing difference from
 *     `conductor.routing` / `conductor.focus_changed` / `conductor.ask_user`,
 *     which are room-scoped and rely on client-side viewer-gating.
 *   - Payload carries ONLY safe, controlled fields:
 *       * `roomId` / `laneKey` for client correlation (already exposed on
 *         every room-scoped conductor event),
 *       * `userActorId` (already exposed on every conductor event),
 *       * `messageId` / `humanTurnId` (already exposed on
 *         `conductor.ask_user`),
 *       * `outcome` (a 4-value enum),
 *       * `reasonCode` (stable, controlled — see
 *         {@link ConductorDecisionReasonCode}),
 *       * `displayReason` (a concise safe sentence produced by the server's
 *         classifier, never the raw model reason),
 *       * `selectedHandles` (agent `@handle`s, only for `wake`, only when
 *         resolvable — handles are already exposed via the room roster and
 *         `conductor.ask_user` options),
 *       * `options` (the picker options, only for `ask_user` — same shape
 *         `conductor.ask_user` already broadcasts).
 *   - It deliberately does NOT include: user message content, transcript /
 *     history snippets, the raw routing trace, raw Floor Manager model
 *     output, or any internal id beyond those already exposed on existing
 *     room-scoped conductor WS events. The `reasonCode`/`displayReason` are
 *     produced by a server-side sanitizer that recognizes the known
 *     deterministic / floor-manager prefixes and otherwise emits the generic
 *     `*_router` code — model-generated semantic detail cannot leak through.
 */
export interface ConductorDecisionReceiptEvent {
  type: "conductor.decision";
  /** "room:<uuid>" — kept for client room correlation; delivery is requester-private via `userId`. */
  laneKey: string;
  roomId: string;
  /** Requester's user id — drives requester-private WS delivery (`inferDeliveryScope`). */
  userId: string;
  /** Actor id of the user whose message was routed (mirrors `conductor.routing`). */
  userActorId: string;
  /** Persisted human-message id (null when not synchronously known). Mirrors `conductor.ask_user`. */
  messageId: string | null;
  /** Turn fingerprint of the persisted human message (mirrors `conductor.ask_user`). */
  humanTurnId?: string | null;
  outcome: "wake" | "silent" | "ask_user" | "error";
  /** Stable, controlled reason code (never raw model output). */
  reasonCode: ConductorDecisionReasonCode;
  /** Concise safe display reason for the requester's UI (server-produced, never the raw model reason). */
  displayReason: string;
  /** Present only for `outcome === "wake"`: selected agent `@handle`s, when resolvable. */
  selectedHandles?: string[];
  /** Present only for `outcome === "ask_user"`: the picker options (mirrors `conductor.ask_user`). */
  options?: { botActorId: string; handle: string }[];
}

/**
 *  (Task primitive Phase 2b) — task lifecycle events. All three carry
 * `ownerId` because `inferDeliveryScope` routes `task.*` to the owner's WS
 * clients only (`{ kind: "user", userId: ownerId }`, owner-only). The
 * result *message* a run posts into a shared calling room still emits the
 * normal room-scoped `message.new`; these events are the owner-private
 * lifecycle signal, never broadcast room-wide.
 */
export interface TaskFiredEvent {
  type: "task.fired";
  taskId: string;
  taskRunId: string;
  /** The task-only lane the run dispatched on (`task:<taskId>`). */
  laneKey: string;
  ownerId: string;
}

export interface TaskCompletedEvent {
  type: "task.completed";
  taskId: string;
  taskRunId: string;
  /** Terminal task status after the run completed (`completed` or, for cron, `pending`). */
  status: string;
  ownerId: string;
}

export interface TaskErroredEvent {
  type: "task.errored";
  taskId: string;
  taskRunId: string;
  status: string;
  ownerId: string;
}

/**
 *  (R9) — task lifecycle transition (pause / unpause / stop). Owner-scoped
 *: `inferDeliveryScope` routes `task.*` to the owner's WS clients only.
 * `status` is the task's new `tasks.status` (`paused` | `pending` |
 * `cancelled`). A stopped JOB still emits its own room-scoped
 * `job.status:cancelled`; this event is the owner-private task-level signal.
 */
export interface TaskStatusEvent {
  type: "task.status";
  taskId: string;
  status: string;
  ownerId: string;
}

/**
 *  (Task Phase 7a) — a task run parked on a human reply (`await_human_reply`
 * interrupt). Owner-scoped: `inferDeliveryScope` routes `task.*` to the
 * owner's WS clients only. The peer sees the agent's question via the normal
 * room-scoped `message.new`; this lifecycle signal is owner-private.
 */
export interface TaskAwaitingReplyEvent {
  type: "task.awaiting_reply";
  taskId?: string;
  taskRunId?: string;
  /** The room a human reply must land in to resume the run. */
  targetRoomId: string;
  /** The user ids whose reply resumes the parked run. */
  awaitingFromUserIds: string[];
  ownerId: string;
  threadId?: string;
  laneKey?: string;
}

export interface TaskHarnessActivity {
  /** Stable within one Task run; repeated frames update the same rendered card. */
  id: string;
  kind: "command" | "file_change" | "tool" | "status";
  name: string;
  status: "running" | "completed" | "failed" | "waiting";
  /** Bounded safe semantic input prepared by the server, never a provider envelope. */
  args: Record<string, unknown>;
  /** Bounded output/result text suitable for the shared ToolCard body. */
  result?: string;
  /** Append this result chunk to the existing activity rather than replacing it. */
  appendResult?: boolean;
  /** Separator inserted before an appended chunk. Defaults to a newline. */
  appendResultSeparator?: "" | "\n";
  startedAt: number;
  endedAt?: number;
}

/** /owner-scoped mid-run progress for subagent activity cards. */
export interface TaskPreparationProgress {
  stage: "preparing_model" | "waiting_model" | "model_responding" | "using_tools" | "preparing_scanners" | "scanner_started" | "scanner_finished" | "recording_evidence" | "research_ready" | "inventory_progress";
  probe?: "gitleaks" | "osv_scanner" | "trivy" | "semgrep";
  filesObserved?: number;
  directoriesObserved?: number;
  /** Observed operation only; never raw tool arguments, findings, or hidden reasoning. */
  activity?: "reading_source" | "searching_source" | "mapping_repository" | "loading_research"
    | "saving_research" | "checkpoint_saved" | "review_saved" | "hypothesis_saved"
    | "evidence_saved" | "finding_saved" | "coverage_saved" | "validating_report" | "recovering_context";
  /** Content-free runtime recovery state, never historical references or source. */
  contextRecovery?: { pendingInputs: number; phase?: "inactive" | "reading" | "consolidation_required";
    recoveredInputBytes?: number; retainedUnconsolidatedPages?: number };
  contextPage?: { startByte: number; endByte: number; totalBytes: number };
  /** Counts from an accepted scan status receipt, not model-estimated percentages. */
  research?: { unitsTotal: number; unitsCompleted: number; unitsPending: number;
    filesTotal: number; filesAssigned: number };
  /** Accepted role transition. Subject is the saved model-authored assignment
   * summary for owner display, never hidden reasoning or source/tool buffers. */
  researchWork?: { role: "coordinator" | "investigator" | "reviewer";
    subject?: string; reviewDecision?: "accepted" | "follow_up" };
}

export interface TaskProgressEvent {
  type: "task.progress";
  taskId: string;
  taskRunId: string;
  /** e.g. `run_shell: rg "retry"` */
  detail: string;
  /** Preparation facts and an optional accepted, model-authored work subject. */
  preparation?: TaskPreparationProgress;
  /** optional rich provider-neutral projection for assistant-ui cards. */
  activity?: TaskHarnessActivity;
  ownerId: string;
}

/**
 *  (Wave 3 task 3.2.1) — typed, payload-free global maintenance-status
 * realtime event. Published through the WS broadcaster whenever the durable
 * `server_maintenance` state changes (enter draining, applying, successful
 * completion/cancel, lease renewal, and expiry recovery), and sent as a
 * snapshot to a client on authenticated WS connect so a client that missed
 * a live event starts truthful (R12).
 *
 * Privacy contract (mirrors `policy.changed`):
 *   - Global fan-out (`WS_GLOBAL_FANOUT_EVENT_TYPES`): maintenance is a
 *     server-wide property, so every authenticated socket receives it —
 *     same audience as `policy.changed` / `worker.complete`.
 *   - Carries ONLY the durable lease fields: maintenance state, owning
 *     operation id, and the soft/hard expiry timestamps (ISO strings, null
 *     when idle). It deliberately does NOT include work counts, job ids,
 *     prompts, room/lane/user payload, or any operator-only aggregate. The
 *     operator-facing `MaintenanceOperatorStatus.work` counts stay on the
 *     HTTP status response; the realtime event is the payload-free public
 *     signal every client renders into a maintenance bar.
 *   - `operationId` is the durable lease owner token; it is already exposed
 *     on the operator HTTP status response and is not a user/room secret.
 *     Clients use it only to detect "same lease continued" vs "new lease."
 */
export interface MaintenanceStatusEvent {
  type: "maintenance.status";
  state: MaintenanceState;
  operationId: string | null;
  /** ISO-8601 soft-lease expiry; null when `state === "normal"`. */
  leaseExpiresAt: string | null;
  /** ISO-8601 hard-recovery expiry; null when `state === "normal"`. */
  hardExpiresAt: string | null;
}

/** owner-private, ephemeral native Codex request lifecycle events. */
type CodexRequestEvent = CodexNativeRequestEvent;
type CodexRequestResolvedEvent = CodexNativeRequestResolvedEvent;

/**
 *  Wave 7 — display-safe remote-host projection shared by the socket
 * contract. This must remain intentionally less expressive than a relay
 * registry: no user ids, relay ids, paths, workspace roots, capability maps,
 * session ids, pairing generations, or tokens cross this boundary.
 */
export type RemoteHostReadiness =
  | "compatible_online"
  | "incompatible_online"
  | "stale"
  | "unknown"
  | "offline"
  | "identity_conflict";

export interface RemoteHostProjection {
  /** Opaque, server-owned controller-binding id; never a relay selector. */
  remoteHostId: string;
  label: string | null;
  /** Exact live transport truth, not a historical inference. */
  connected: boolean;
  readiness: RemoteHostReadiness;
  lastSeenAt: string | null;
}

/** Reconnect cursor. `sequence` is monotonic only within its `streamId`. */
export interface RemoteHostResumeCursor {
  streamId: string;
  sequence: number;
  snapshotRevision: number;
}

/** Direct owner-scoped convergence frame after a resume gap or stream change. */
export interface RemoteHostSnapshotEvent {
  type: "remote.host.snapshot";
  hosts: RemoteHostProjection[];
  cursor: RemoteHostResumeCursor;
}

interface RemoteHostPresenceEventBase extends RemoteHostResumeCursor {
  /** Event id enables idempotent application in addition to sequence ordering. */
  eventId: string;
  remoteHostId: string;
}

export interface RemoteHostConnectedEvent extends RemoteHostPresenceEventBase {
  type: "remote.host.connected";
  host: RemoteHostProjection;
}

export interface RemoteHostUpdatedEvent extends RemoteHostPresenceEventBase {
  type: "remote.host.updated";
  host: RemoteHostProjection;
}

/** Controlled terminal state only; it never carries user/relay/session data. */
export type RemoteHostTerminalReason = "offline" | "identity_conflict" | "revoked";

export interface RemoteHostDisconnectedEvent extends RemoteHostPresenceEventBase {
  type: "remote.host.disconnected";
  terminalReason: "offline" | "identity_conflict";
}

export interface RemoteHostRevokedEvent extends RemoteHostPresenceEventBase {
  type: "remote.host.revoked";
  terminalReason: "revoked";
}

/** Content-free hint that qualified Room devices may fulfil V2 key delivery. */
export interface DomainKeyCatchUpRequestedEvent {
  type:
    | "crypto.domain_key_catch_up_requested"
    | "crypto.domain_key_catch_up_delivered";
  roomId: string;
  laneKey: string;
  namespaceId: string;
  keyClass: "human" | "ai";
}

/** User-scoped, payload-free hint to rediscover durable authorization work. */
export interface BackgroundAuthorizationRequestedEvent {
  type: "crypto.background_authorization_requested";
}

export type ServerEvent =
  | MessageTokensEvent
  | MessageNewEvent
  | ProtectedMessageRealtimeEventV2
  | LiveShadowMessageRealtimeEventV1
  | FullEncryptionMessageRealtimeContentEventV2
  | DomainKeyCatchUpRequestedEvent
  | BackgroundAuthorizationRequestedEvent
  | RoomNotificationChangedEvent
  | EventFeedChangedEvent
  | ImportantMessageArrivedEvent
  | RoomSilenceChangedEvent
  | ReactionAddedEvent
  | ReactionRemovedEvent
  | MessageDeletedEvent
  | MessageUpdatedEvent
  | ThreadSummaryChangedEvent
  | JobStatusEvent
  | JobProgressEvent
  | ToolStartEvent
  | ToolEndEvent
  | ToolRunShellProgressEvent
  | ToolStructuredSshProgressEvent
  | WorkspaceArtifactChangedEvent
  | WorkspaceArtifactRenamedEvent
  | WorkspaceArtifactDeletedEvent
  | DocumentPatchEvent
  /**
   * durable, coordinator-authored document truth. Workspace delivery
   * is intentionally scoped by the artifact SSE route, not global WS fanout.
   */
  | DocumentMutationCommittedEvent
  | ProveItChallengeEvent
  | HostChoiceEvent
  | ConnectedWebAccountActionAttentionEvent
  | ConnectedWebAccountActionResumeFailedEvent
  | ApprovalAskEvent
  | ApprovalResolvedEvent
  | WorkerCompleteEvent
  | VoiceStatusEvent
  | VoiceSentenceEvent
  | VoiceSuggestionEvent
  | VoiceAudioEvent
  | VoiceStopEvent
  | VoiceTurnEndEvent
  | ProfileUpdatedEvent
  | IdentityChallengeEvent
  | PostureChangedEvent
  | EncryptionPolicyChangedEvent
  | RevisionsStateChangedEvent
  | SessionPersistenceFailedEvent
  | JobCoalescedEvent
  | JobDispatchedEvent
  | JobForkedEvent
  | ForkSplicedEvent
  | RoomCatalogChangedEvent
  | RoomMembersChangedEvent
  | RoomConductorModeChangedEvent
  | TypingPingEvent
  | ConductorAskUserEvent
  | ConductorFocusChangedEvent
  | ConductorRoutingEvent
  | ConductorDecisionReceiptEvent
  | TaskFiredEvent
  | TaskCompletedEvent
  | TaskErroredEvent
  | TaskStatusEvent
  | TaskAwaitingReplyEvent
  | TaskProgressEvent
  | AgentProgressEvent
  | ModelFallbackEvent
  | MaintenanceStatusEvent
  | CodexRequestEvent
  | CodexRequestResolvedEvent
  | RemoteHostConnectedEvent
  | RemoteHostUpdatedEvent
  | RemoteHostDisconnectedEvent
  | RemoteHostRevokedEvent
  | RemoteHostSnapshotEvent;

/** Realtime-client boundary only; the control half is never publisher-routed. */
export type RealtimeInboundEvent = ServerEvent | RealtimeControlEvent;

/** Distinguishes content-free protected message frames from legacy events. */
export function isProtectedMessageRealtimeEventV2(
  event: ServerEvent,
): event is ProtectedMessageRealtimeEventV2 {
  return "protection" in event && event.protection === "protected";
}

/**
 * Bus→WS events that historically fan out process-wide. Under
 * `audience=auto`, `inferDeliveryScope` drops them unless the emitter
 * passes `{ kind: "all", acknowledgedGlobalLeak: true }` .
 * The production `event-bridge` maps these automatically via
 * `audienceForBridgedServerEvent`.
 */
export const WS_GLOBAL_FANOUT_EVENT_TYPES = [
  "policy.changed",
  "encryption.policy.changed",
  "worker.complete",
  "session.persistence_failed",
  "revisions.state_changed",
  "maintenance.status",
] as const satisfies readonly ServerEvent["type"][];

export type WsGlobalFanoutEventType = (typeof WS_GLOBAL_FANOUT_EVENT_TYPES)[number];

/**
 * Voice control signals without `laneKey` / per-socket `userId`; same
 * explicit-global semantics as {@link WS_GLOBAL_FANOUT_EVENT_TYPES}
 * .
 */
export const WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES = [
  "voice.status",
  "voice.stop",
] as const satisfies readonly ServerEvent["type"][];

export type WsVoiceControlGlobalEventType = (typeof WS_VOICE_CONTROL_GLOBAL_EVENT_TYPES)[number];
