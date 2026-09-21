import type { ThreadMessageLike } from "@assistant-ui/react";
import {
  roomHistoryShadowReadResponseV1Schema,
  type RoomHistoryShadowReadIntentV1,
  type RoomHistoryShadowReadResponseV1,
} from "@nautilo/api-client/browser";
import {
  ClassifiedDataOperationError,
  type CanonicalJsonValue,
  type CanonicalToolCallV2,
  type DataOperationFailureClass,
  type MessagePayloadV2,
} from "@nautilo/lattice-bridge";
import type {
  AdvancedVideoWorkcardContinuation,
  MessageArtifactOpenRef,
  RoomHistoryTerminalExecutionSummary,
} from "@nautilo/types";
import {
  parseSerializedToolArgsForDisplay,
  projectToolArgsForCardDisplay,
  projectToolResultTextForDisplay,
} from "../components/tool-argument-preview";
import { preserveComputerUseResultForCard } from "../components/tool-card/renderers/computer-use";
import { preserveConnectedAppResultForCard } from "../components/tool-card/renderers/connected-app-receipt";
import { isShareRejection } from "./live-shadow-message-projection";
/**
 * Stable Assistant UI metadata key for D424's server-authored open-card
 * pointers. Keep this deliberately distinct from composer `artifactRefs`:
 * these are already authorized, room-scoped pointers received from history
 * or realtime, never a client-side inference from authored prose.
 */
export const MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY = "artifactOpenRefs";
const MESSAGE_TERMINAL_EXECUTIONS_METADATA_KEY = "terminalExecutions";
/**
 * The server relation is unique, but history/event/cache races must never
 * render duplicate document cards. Preserve server ordering while collapsing
 * by the authorization boundary (canonical room + internal artifact id).
 */
export function dedupeMessageArtifactOpenRefs(
  artifacts: readonly MessageArtifactOpenRef[] | undefined,
): MessageArtifactOpenRef[] | undefined {
  if (artifacts === undefined) return undefined;
  const seen = new Set<string>();
  return artifacts.filter((artifact) => {
    const key = `${artifact.roomId}:${artifact.artifactInternalId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Rehydrate outcome. Callers key off `status` so the PIN-at-start
 * gate (D085) can distinguish a 401 (drop token, show gate with
 * "session expired") from an empty session (fresh start, no gate)
 * from a transport failure (soft error, no token action).
 */
export type RehydrateStatus =
  | "ok"
  | "empty"
  | "unauthorized"
  | "not-found"
  | "no-token"
  | "failed";

export interface RehydrateResult {
  status: RehydrateStatus;
  /** Non-null iff status === "ok". */
  restored: ThreadMessageLike[] | null;
  /** Present only when a failed read is retryable by Domain/Namespace convergence. */
  failureClass?: DataOperationFailureClass;
  pageInfo?: {
    hasMoreBefore: boolean;
    oldestCursor: { id: string; createdAt: string } | null;
  };
}

export type RoomHistoryCursor = Readonly<{ id: string; createdAt: string }>;

export interface RoomHistoryShadowReadAdapter {
  createIntent(): RoomHistoryShadowReadIntentV1;
  reconcile(input: Readonly<{
    roomId: string;
    messages: readonly StoredSessionMessageDto[];
    sidecar: RoomHistoryShadowReadResponseV1;
    /** Exact Full recovery must receive verified bytes, never a withheld row. */
    requireVerified?: boolean;
  }>): Promise<readonly StoredSessionMessageDto[]>;
}

export async function reconcileFetchedRoomHistoryPage(
  roomId: string,
  messages: readonly StoredSessionMessageDto[],
  rawSidecar: unknown,
  shadowRead?: RoomHistoryShadowReadAdapter,
  options: Readonly<{ protectedAttempt?: boolean }> = {},
): Promise<readonly StoredSessionMessageDto[]> {
  if (shadowRead === undefined) return messages;
  // An empty structural page selects no confidential rows. The current Room
  // route omits the additive sidecar for this exact case; there is no body to authenticate
  // or ordinary content to leak. A supplied sidecar is still parsed below so
  // contradictory non-empty selection metadata fails closed.
  if (messages.length === 0 && rawSidecar === undefined) return [];
  const sidecar = rawSidecar === undefined
    ? null
    : roomHistoryShadowReadResponseV1Schema.safeParse(rawSidecar);
  if (sidecar?.success === true && sidecar.data.status === "disabled") {
    if (options.protectedAttempt === true) {
      throw new ClassifiedDataOperationError(
        "unknown",
        "Protected Room history disagrees with the current data operation policy",
      );
    }
    return messages;
  }
  if (sidecar?.success === true) {
    try {
      const reconciled = await shadowRead.reconcile({
        roomId,
        messages,
        sidecar: sidecar.data,
      });
      if (sidecar.data.status !== "ready"
        || sidecar.data.terminalExecutions.length === 0) return reconciled;
      const terminalByMessage = new Map<number, RoomHistoryTerminalExecutionSummary[]>();
      for (const terminal of sidecar.data.terminalExecutions) {
        const summaries = terminalByMessage.get(terminal.messageId) ?? [];
        summaries.push(Object.freeze({ ...terminal }));
        terminalByMessage.set(terminal.messageId, summaries);
      }
      return reconciled.map((message) => {
        if (message.role !== "user") return message;
        const messageId = Number(message.id);
        const summaries = Number.isSafeInteger(messageId)
          ? terminalByMessage.get(messageId)
          : undefined;
        return summaries === undefined
          ? message
          : Object.freeze({
            ...message,
            terminalExecutions: Object.freeze([...summaries]),
          });
      });
    } catch (error) {
      if (options.protectedAttempt === true) {
        if (error instanceof ClassifiedDataOperationError) throw error;
        throw new ClassifiedDataOperationError(
          "integrity",
          "Protected Room history verification failed",
          { cause: error },
        );
      }
      throw error;
    }
  }
  if (options.protectedAttempt === true) {
    throw new ClassifiedDataOperationError(
      "integrity",
      "Protected Room history response is missing or malformed",
    );
  }
  return messages;
}

/** Sentinel cursor for "load latest N messages" on GET /api/rooms/:id/messages (D181). */
/**
 * Sentinel "before id" for the "load latest" pagination call.
 *
 * 2147483647 == Postgres int4 max (`session_messages.id` is SERIAL,
 * which is int4-typed). Using `Number.MAX_SAFE_INTEGER` here causes
 * a binding-time OUT_OF_RANGE error from the driver because 2^53-1
 * overflows int4 (D181 smoke 2026-05-18 — first attempt failed
 * silently at the drizzle-orm wrapper layer with "Failed query"
 * and the underlying PG error was hidden).
 */
export const LATEST_SENTINEL_BEFORE_ID = 2147483647;
/** Sentinel cursor for "load latest N messages" on GET /api/rooms/:id/messages (D181). */
/**
 * Sentinel "before" timestamp for the "load latest" pagination call.
 *
 * 2099-12-31 chosen so that timezone shifts (Postgres receives the
 * date in the server's local TZ, may add up to ~14h offset) cannot
 * roll the year over a SQL TIMESTAMP boundary. The earlier sentinel
 * `9999-12-31T23:59:59.999Z` rolled to year 10000 in CET (+1h) and
 * Postgres rejected the query with no out-of-range diagnostic
 * (D181 smoke 2026-05-18). 2099 is still ~70 years past any real
 * workbench message; refresh in 2090 if anyone still cares.
 */
export const LATEST_SENTINEL_BEFORE_AT = "2099-12-31T00:00:00.000Z";

interface StoredToolCall {
  id?: string;
  name?: string;
  args?: Record<string, unknown>;
}

const MAX_PERSISTED_TOOL_CALLS_PER_ROW = 64;
const MAX_PENDING_TOOL_CALLS_PER_PAGE = 128;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringField(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * Tool-call args in persisted history are display data only. Project them at
 * hydration through the same fail-closed boundary as live tool events, before
 * they enter Assistant UI's transcript model. Tool execution already happened
 * server-side, so retaining credential values here serves no runtime purpose.
 */
function parseDisplayArgs(raw: unknown): Record<string, unknown> | undefined {
  if (isRecord(raw)) {
    return projectToolArgsForCardDisplay(raw);
  }
  if (typeof raw !== "string") return undefined;
  return projectToolArgsForCardDisplay(parseSerializedToolArgsForDisplay(raw));
}

/**
 * Normalizes the canonical LangChain record and the legacy OpenAI provider
 * wrapper (`{ id, type: "function", function: { name, arguments } }`).
 * Unknown shapes are intentionally ignored: a made-up call would shift FIFO
 * correlation and could assign a command to an unrelated tool result.
 */
function normalizeStoredToolCall(raw: unknown): StoredToolCall | null {
  if (!isRecord(raw)) return null;
  const providerFunction = isRecord(raw["function"]) ? raw["function"] : undefined;
  const id = stringField(raw, "id") ?? stringField(raw, "call_id");
  const name = stringField(raw, "name") ??
    (providerFunction ? stringField(providerFunction, "name") : undefined);
  const args = parseDisplayArgs(raw["args"]) ??
    parseDisplayArgs(raw["arguments"]) ??
    (providerFunction ? parseDisplayArgs(providerFunction["arguments"]) : undefined);

  if (!id && !name) return null;
  return {
    ...(id ? { id } : {}),
    ...(name ? { name } : {}),
    ...(args ? { args } : {}),
  };
}

function storedToolCallEntries(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (!isRecord(parsed)) return [];
  if (Array.isArray(parsed["tool_calls"])) return parsed["tool_calls"];
  if (Array.isArray(parsed["toolCalls"])) return parsed["toolCalls"];
  const additional = parsed["additional_kwargs"];
  return isRecord(additional) && Array.isArray(additional["tool_calls"])
    ? additional["tool_calls"]
    : [];
}

export interface StoredSessionMessageDto {
  id: string;
  logicalMessageKey?: string;
  role: string;
  content: string;
  toolCalls?: string | null;
  toolName?: string | null;
  displayContent?: string;
  createdAt?: string;
  editedAt?: string | null;
  editRevision?: number;
  /** Local projection marker set only when trusted history reconciliation
   * withholds this exact row. Never inferred from user-authored content. */
  historyUnavailable?: true;
  /** Ephemeral local reason for a withheld projection. Never accepted from HTTP. */
  historyUnavailableReason?: DataOperationFailureClass;
  /** Local presentation fact set only from an authenticated opened tool
   * payload. `unspecified` permits the exact projection-rejection envelope
   * fallback while preserving an explicit protected status as authoritative. */
  authenticatedToolStatus?: "unspecified" | "success" | "error";
  /** Exact local-only correlation recovered from an authenticated protected
   * tool payload. Never accepted as authority from the ordinary sibling. */
  authenticatedToolCallId?: string;
  replyToMessageId?: number | null;
  /** D124 — persisted human author (`sessions.owner_id`) for room fan-in. */
  sourceUserId?: string;
  /** D300 — authoring agent (`sessions.agent_id`) for assistant/tool rows. */
  authorAgentId?: string;
  /** External harness that authored this Task result; `authorAgentId` is its delegator. */
  authorHarnessId?: string;
  /**
   * D426 — authoritative denormalized child-reply summary on a parent-room
   * anchor row. They join author provenance in Assistant UI's supported
   * `metadata.custom` shape so HTTP hydration and live WS snapshots converge.
   */
  replyCount?: number;
  lastReplyAt?: string | null;
  summaryRevision?: number;
  /**
   * D212 / M121 — aggregated emoji reactions inlined by
   * `GET /api/rooms/:id/messages` (omitted when empty). Carried into
   * `metadata.custom.reactions` so the bubble can render a reaction strip.
   */
  reactions?: { emoji: string; count: number }[];
  /**
   * D424/D570 — server-authorized Workspace document pointers. Normally a
   * human-authored focus send; also present on the trusted ask_peer assistant
   * question that carries documents into the exact peer DM.
   */
  artifacts?: MessageArtifactOpenRef[];
  workcardContinuation?: AdvancedVideoWorkcardContinuation;
  /** Protected-history-only terminal outcomes mapped to this Human input. */
  terminalExecutions?: readonly RoomHistoryTerminalExecutionSummary[];
}

/** Project one already-authenticated protected payload onto its ordinary
 * structural row. This is the sole producer of local protected tool status
 * and call correlation used by history hydration. */
export function projectAuthenticatedRoomHistoryPayload(
  row: StoredSessionMessageDto,
  payload: MessagePayloadV2,
): StoredSessionMessageDto {
  if (payload.role !== row.role) {
    throw new TypeError("Room history authenticated a different role");
  }
  const {
    historyUnavailable: _historyUnavailable,
    historyUnavailableReason: _historyUnavailableReason,
    authenticatedToolStatus: _authenticatedToolStatus,
    authenticatedToolCallId: _authenticatedToolCallId,
    ...availableRow
  } = row;
  if (payload.role === "assistant") return Object.freeze({
    ...availableRow,
    content: payload.content,
    toolCalls: JSON.stringify(payload.toolCalls ?? []),
  });
  if (payload.role === "tool") {
    const explicitStatus = payload.sensitiveMetadata?.["toolStatus"];
    const authenticatedToolCallId = payload.sensitiveMetadata?.["toolCallId"];
    return Object.freeze({
      ...availableRow,
      content: payload.content,
      toolName: payload.toolName,
      ...(typeof authenticatedToolCallId === "string" && authenticatedToolCallId.length > 0
        ? { authenticatedToolCallId }
        : {}),
      authenticatedToolStatus:
        explicitStatus === "success" || explicitStatus === "error"
          ? explicitStatus
          : "unspecified",
    });
  }
  return Object.freeze({ ...availableRow, content: payload.content });
}

export function advancedVideoWorkcardSummary(
  continuation: AdvancedVideoWorkcardContinuation,
): string {
  return `Advanced video workcard · Requested exact quote with ${continuation.referenceCount} reference${continuation.referenceCount === 1 ? "" : "s"}.`;
}

function parseToolCalls(raw: string | null | undefined): StoredToolCall[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return storedToolCallEntries(parsed)
      .slice(0, MAX_PERSISTED_TOOL_CALLS_PER_ROW)
      .map(normalizeStoredToolCall)
      .filter((call): call is StoredToolCall => call !== null);
  } catch {
    return [];
  }
}

function consumePendingToolCall(
  pending: StoredToolCall[],
  authenticatedToolCallId?: string,
): StoredToolCall | undefined {
  if (authenticatedToolCallId === undefined) return pending.shift();
  const firstMatch = pending.findIndex((call) => call.id === authenticatedToolCallId);
  if (firstMatch < 0) return undefined;
  const matched = pending[firstMatch];
  // A resumed graph can persist the same logical call more than once before
  // its one result. Retire every copy so later reuse of that id cannot consume
  // a stale redacted checkpoint projection.
  for (let index = pending.length - 1; index >= 0; index -= 1) {
    if (pending[index]?.id === authenticatedToolCallId) pending.splice(index, 1);
  }
  return matched;
}

function parseCanonicalArgs(raw: unknown): Readonly<
  Record<string, CanonicalJsonValue>
> | null {
  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch {
      return null;
    }
  }
  return isRecord(parsed)
    ? parsed as Readonly<Record<string, CanonicalJsonValue>>
    : null;
}

function parseCanonicalToolCalls(
  raw: string | null | undefined,
): readonly CanonicalToolCallV2[] | null {
  if (!raw) return Object.freeze([]);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  const calls: CanonicalToolCallV2[] = [];
  for (const candidate of storedToolCallEntries(parsed)) {
    if (!isRecord(candidate)) return null;
    const providerFunction = isRecord(candidate["function"])
      ? candidate["function"]
      : undefined;
    const id = stringField(candidate, "id")
      ?? stringField(candidate, "call_id");
    const name = stringField(candidate, "name")
      ?? (providerFunction ? stringField(providerFunction, "name") : undefined);
    const args = parseCanonicalArgs(candidate["args"])
      ?? parseCanonicalArgs(candidate["arguments"])
      ?? (providerFunction
        ? parseCanonicalArgs(providerFunction["arguments"])
        : null);
    if (name === undefined || args === null) return null;
    calls.push(Object.freeze({
      ...(id === undefined ? {} : { id }),
      name,
      args,
    }));
  }
  return Object.freeze(calls);
}

export interface RoomHistoryShadowOrdinarySibling {
  readonly logicalMessageKey?: string;
  readonly payload: MessagePayloadV2;
}

/**
 * Derive parity input from the actual ordinary response row, independently of
 * the additive Shadow sidecar. This prevents server-supplied parity bytes from
 * concealing a substituted row that would otherwise reach the renderer.
 */
export function roomHistoryShadowOrdinarySibling(
  message: StoredSessionMessageDto,
): RoomHistoryShadowOrdinarySibling | null {
  let payload: MessagePayloadV2;
  if (message.role === "user") {
    payload = Object.freeze({ role: "user", content: message.content });
  } else if (message.role === "assistant") {
    const toolCalls = parseCanonicalToolCalls(message.toolCalls);
    if (toolCalls === null) return null;
    payload = Object.freeze({
      role: "assistant",
      content: message.content,
      ...(toolCalls.length === 0 ? {} : { toolCalls }),
    });
  } else if (message.role === "tool") {
    const toolName = message.toolName
      ?? toolNameFromSessionsDisplayLine(message.displayContent);
    if (toolName === undefined) return null;
    payload = Object.freeze({
      role: "tool",
      content: message.content,
      toolName,
    });
  } else if (message.role === "system") {
    payload = Object.freeze({ role: "system", content: message.content });
  } else {
    return null;
  }
  return Object.freeze({
    ...(message.logicalMessageKey === undefined
      ? {}
      : { logicalMessageKey: message.logicalMessageKey }),
    payload,
  });
}

export type RoomHistoryShadowPayloadResult =
  | Readonly<{
    messageId: string;
    editRevision: number;
    status: "verified";
    payload: MessagePayloadV2;
  }>
  | Readonly<{
    messageId: string;
    editRevision: number;
    status: "fallback";
  }>;

/**
 * Apply only locally verified content/tool payloads to ordinary rows. Callers
 * then invoke `restoreSessionMessages` once over this result, preserving all
 * ordinary metadata and avoiding a plaintext-then-protected render pass.
 */
export function reconcileRoomHistoryShadowPayloads(
  messages: readonly StoredSessionMessageDto[],
  results: readonly RoomHistoryShadowPayloadResult[],
  options: Readonly<{ strict?: boolean; requireVerified?: boolean }> = {},
): readonly StoredSessionMessageDto[] {
  const resultsByCoordinate = new Map<string, RoomHistoryShadowPayloadResult[]>();
  for (const result of results) {
    const key = `${result.messageId}\u0000${String(result.editRevision)}`;
    const existing = resultsByCoordinate.get(key);
    if (existing === undefined) resultsByCoordinate.set(key, [result]);
    else existing.push(result);
  }
  const hasExactlyOneVerifiedResult = (message: StoredSessionMessageDto) => {
    const key = `${message.id}\u0000${String(message.editRevision ?? 0)}`;
    const matches = resultsByCoordinate.get(key);
    return matches?.length === 1
      && matches[0]?.status === "verified"
      && matches[0].payload.role === message.role;
  };
  if (options.requireVerified && (
    results.length !== messages.length
    || messages.some(message => !hasExactlyOneVerifiedResult(message))
  )) {
    throw new Error("Protected history verification unavailable");
  }
  const verified = new Map<string, MessagePayloadV2>();
  const withheld = new Set<string>();
  for (const message of messages) {
    const key = `${message.id}\u0000${String(message.editRevision ?? 0)}`;
    const matches = resultsByCoordinate.get(key);
    if (matches?.length === 1
      && matches[0]?.status === "verified"
      && matches[0].payload.role === message.role) {
      verified.set(key, matches[0].payload);
    } else if (options.strict === true) {
      withheld.add(key);
    }
  }
  return messages.map((message) => {
    const key = `${message.id}\u0000${String(message.editRevision ?? 0)}`;
    if (withheld.has(key)) {
      return Object.freeze({
        ...message,
        content: "Encrypted history is unavailable on this device.",
        historyUnavailable: true,
        toolCalls: message.role === "assistant" ? "[]" : message.toolCalls,
      });
    }
    const payload = verified.get(key);
    if (payload === undefined || payload.role !== message.role) return message;
    return projectAuthenticatedRoomHistoryPayload(message, payload);
  });
}

/**
 * Replace every selected ordinary payload with a content-free unavailable
 * projection. Strict Shadow uses this when page-level protected projection or
 * client verification cannot safely identify a verified sibling.
 */
export function withholdRoomHistoryShadowPayloads(
  messages: readonly StoredSessionMessageDto[],
): readonly StoredSessionMessageDto[] {
  return messages.map((message) => Object.freeze({
    ...message,
    content: "Encrypted history is unavailable on this device.",
    historyUnavailable: true,
    ...(message.role === "assistant" ? { toolCalls: "[]" } : {}),
  }));
}

function restoreToolResultContent(content: string, toolName: string): string {
  return preserveComputerUseResultForCard(toolName, content)
    ?? preserveConnectedAppResultForCard(toolName, content)
    ?? projectToolResultTextForDisplay(content)
    ?? "";
}

/** Keep in sync with `packages/server/src/lib/session-messages-display.ts` `toolDisplayNameFromDisplayContent`. */
function toolNameFromSessionsDisplayLine(display: string | null | undefined): string | undefined {
  if (!display?.startsWith("⚙ ")) return undefined;
  const match = display.match(/^⚙\s+(.+?)\s+\[(success|error)(?:\s+\d+ms)?\]/);
  const name = match?.[1]?.trim();
  return name || undefined;
}

type HydratableStoredSessionMessageDto = Omit<StoredSessionMessageDto, "content"> &
  Readonly<{
    /** Null is a protected-only structural row awaiting local authenticated open. */
    content: string | null;
  }>;

export function restoreSessionMessages(
  messages: readonly HydratableStoredSessionMessageDto[],
): ThreadMessageLike[] {
  const restored: ThreadMessageLike[] = [];
  // Rehydration is page-local: an orphan tool row at the start of a page must
  // not consume a later assistant call, and calls at the end do not carry into
  // the next page. The cap also bounds malformed assistant-only history.
  const pendingToolCalls: StoredToolCall[] = [];
  for (const m of messages) {
    if (m.workcardContinuation?.kind === "advanced_video") {
      restored.push({
        id: m.id,
        role: "system",
        content: [{ type: "text", text: advancedVideoWorkcardSummary(m.workcardContinuation) }],
        metadata: { custom: { workcardContinuation: m.workcardContinuation } },
      });
    } else if (typeof m.content !== "string") {
      // Full history may arrive structurally before device custody is ready on
      // reconnect. Withhold that row entirely: an empty/placeholder text part
      // would both misrepresent availability and violate assistant-ui's text
      // primitive contract. Preserve page-local tool-call pairing boundaries.
      if (m.role === "user") pendingToolCalls.length = 0;
      else if (m.role === "tool") {
        consumePendingToolCall(pendingToolCalls, m.authenticatedToolCallId);
      }
      continue;
    } else if (m.role === "user") {
      // A tool result cannot cross a subsequent Human turn boundary. Stop or
      // transport loss can leave an assistant tool-call row without a durable
      // result; carrying that orphan forward would attach a later result to
      // the wrong command and can falsely render an unknown outcome as a
      // success after restart.
      pendingToolCalls.length = 0;
      const replyTo =
        typeof m.replyToMessageId === "number" && Number.isInteger(m.replyToMessageId)
          ? m.replyToMessageId
          : null;
      const custom: Record<string, unknown> = { ...(m.createdAt ? { sentAt: m.createdAt } : {}) };
      if (typeof m.logicalMessageKey === "string") {
        custom.logicalMessageKey = m.logicalMessageKey;
      }
      if (typeof m.editedAt === "string" || m.editedAt === null) {
        custom.editedAt = m.editedAt;
      }
      if (typeof m.editRevision === "number") {
        custom.editRevision = m.editRevision;
      }
      if (m.historyUnavailable === true) {
        custom.historyUnavailable = true;
        if (m.historyUnavailableReason !== undefined) {
          custom.historyUnavailableReason = m.historyUnavailableReason;
        }
      }
      if (replyTo !== null) custom.replyToMessageId = replyTo;
      if (typeof m.sourceUserId === "string" && m.sourceUserId.length > 0) {
        custom.sourceUserId = m.sourceUserId;
      }
      if (m.reactions && m.reactions.length > 0) custom.reactions = m.reactions;
      const artifacts = dedupeMessageArtifactOpenRefs(m.artifacts);
      if (artifacts !== undefined) {
        custom[MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY] = artifacts;
      }
      if (typeof m.replyCount === "number" && Number.isFinite(m.replyCount)) {
        custom.replyCount = m.replyCount;
      }
      if (typeof m.lastReplyAt === "string" || m.lastReplyAt === null) {
        custom.lastReplyAt = m.lastReplyAt;
      }
      if (typeof m.summaryRevision === "number" && Number.isFinite(m.summaryRevision)) {
        custom.summaryRevision = m.summaryRevision;
      }
      if (m.terminalExecutions && m.terminalExecutions.length > 0) {
        custom[MESSAGE_TERMINAL_EXECUTIONS_METADATA_KEY] = m.terminalExecutions;
      }
      restored.push({
        id: m.id,
        role: "user",
        content: [{ type: "text", text: m.content }],
        ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
      });
    } else if (m.role === "assistant") {
      const availablePendingSlots = MAX_PENDING_TOOL_CALLS_PER_PAGE - pendingToolCalls.length;
      if (availablePendingSlots > 0) {
        pendingToolCalls.push(...parseToolCalls(m.toolCalls).slice(0, availablePendingSlots));
      }
      if (m.content.trim()) {
        const custom: Record<string, unknown> = { ...(m.createdAt ? { sentAt: m.createdAt } : {}) };
        if (typeof m.authorAgentId === "string" && m.authorAgentId.length > 0) {
          custom.authorAgentId = m.authorAgentId;
        }
        if (typeof m.authorHarnessId === "string" && m.authorHarnessId.length > 0) {
          custom.authorHarnessId = m.authorHarnessId;
        }
        if (typeof m.editRevision === "number") custom.editRevision = m.editRevision;
        if (m.historyUnavailable === true) {
          custom.historyUnavailable = true;
          if (m.historyUnavailableReason !== undefined) {
            custom.historyUnavailableReason = m.historyUnavailableReason;
          }
        }
        const artifacts = dedupeMessageArtifactOpenRefs(m.artifacts);
        if (artifacts !== undefined) {
          custom[MESSAGE_ARTIFACT_OPEN_REFS_METADATA_KEY] = artifacts;
        }
        if (m.reactions && m.reactions.length > 0) custom.reactions = m.reactions;
        if (typeof m.replyCount === "number" && Number.isFinite(m.replyCount)) {
          custom.replyCount = m.replyCount;
        }
        if (typeof m.lastReplyAt === "string" || m.lastReplyAt === null) {
          custom.lastReplyAt = m.lastReplyAt;
        }
        if (typeof m.summaryRevision === "number" && Number.isFinite(m.summaryRevision)) {
          custom.summaryRevision = m.summaryRevision;
        }
        restored.push({
          id: m.id,
          role: "assistant",
          content: [{ type: "text", text: m.content }],
          ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
        });
      }
    } else if (m.role === "system" && m.content.trim()) {
      const custom: Record<string, unknown> = {};
      if (typeof m.editRevision === "number") custom.editRevision = m.editRevision;
      if (m.historyUnavailable === true) {
        custom.historyUnavailable = true;
        if (m.historyUnavailableReason !== undefined) {
          custom.historyUnavailableReason = m.historyUnavailableReason;
        }
      }
      restored.push({
        id: m.id,
        role: "system",
        content: [{ type: "text", text: m.content }],
        ...(Object.keys(custom).length > 0 ? { metadata: { custom } } : {}),
      });
    } else if (m.role === "tool") {
      // Consume before every skip so empty/react results cannot leave a stale
      // call behind. Protected rows use their locally authenticated exact id;
      // legacy ordinary rows retain the prior FIFO behavior.
      const call = consumePendingToolCall(
        pendingToolCalls,
        m.authenticatedToolCallId,
      );
      if (!m.content.trim()) continue;
      const toolName =
        (typeof m.toolName === "string" && m.toolName.trim().length > 0
          ? m.toolName.trim()
          : undefined) ??
        toolNameFromSessionsDisplayLine(m.displayContent) ??
        call?.name ??
        "tool result";
      // D212 P0 — reactions render as a strip on the target message, not
      // as a restored tool card. Consume the pairing (above) then skip.
      if (toolName === "react") continue;
      const custom: Record<string, unknown> = { ...(m.createdAt ? { sentAt: m.createdAt } : {}) };
      if (typeof m.authorAgentId === "string" && m.authorAgentId.length > 0) {
        custom.authorAgentId = m.authorAgentId;
      }
      if (typeof m.editRevision === "number") custom.editRevision = m.editRevision;
      if (m.historyUnavailable === true) {
        custom.historyUnavailable = true;
        if (m.historyUnavailableReason !== undefined) {
          custom.historyUnavailableReason = m.historyUnavailableReason;
        }
      }
      const isError = m.authenticatedToolStatus === "error"
        || (m.authenticatedToolStatus === "unspecified"
          && toolName === "share_memory"
          && isShareRejection(m.content))
        || (m.authenticatedToolStatus === undefined
          && m.displayContent?.includes("[error]") === true);
      restored.push({
        id: m.id,
        role: "assistant",
        content: [
          {
            type: "tool-call" as const,
            toolCallId: m.authenticatedToolCallId ?? call?.id ?? `restored-${m.id}`,
            toolName,
            args: (call?.args ?? {}) as Record<string, never>,
            result: restoreToolResultContent(m.content, toolName),
            ...(isError ? { isError: true } : {}),
          },
        ],
        ...(Object.keys(custom).length > 0 ? { metadata: { custom: custom } } : {}),
      });
    }
  }
  return restored;
}


export function compareRoomHistoryCursors(
  left: RoomHistoryCursor,
  right: RoomHistoryCursor,
): number | null {
  const leftTime = Date.parse(left.createdAt);
  const rightTime = Date.parse(right.createdAt);
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
  if (leftTime !== rightTime) return leftTime < rightTime ? -1 : 1;
  try {
    const leftId = BigInt(left.id);
    const rightId = BigInt(right.id);
    return leftId === rightId ? 0 : leftId < rightId ? -1 : 1;
  } catch {
    return null;
  }
}

export function isRoomHistoryCursor(value: unknown): value is RoomHistoryCursor {
  if (!isRecord(value)) return false;
  return typeof value["id"] === "string"
    && value["id"].length > 0
    && typeof value["createdAt"] === "string"
    && value["createdAt"].length > 0;
}
