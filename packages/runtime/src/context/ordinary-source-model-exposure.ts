import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import {
  MODEL_INPUT_EXPOSURE_METADATA_KEY,
  bindModelInputExposureFromAuthorizedPersistedPayload,
  readModelInputExposure,
  type ModelInputExposure,
} from "@nautilo/agent";
import type { DurableModelExposureDependency } from "@nautilo/reflection/durable";
import type { OrdinaryConversationTranscriptExposureRow } from "../conversation/active-conversation-repository";
import { reflectionMessageSourceFingerprint } from "../reflection/canonical-room-sources";

function messageFor(row: OrdinaryConversationTranscriptExposureRow) {
  if (row.role === "user") return new HumanMessage(row.content);
  if (row.role === "assistant") return new AIMessage(row.content);
  if (row.role === "tool") return new ToolMessage({ content: row.content, tool_call_id: String(row.messageId) });
  return new SystemMessage(row.content);
}

/** Build provenance only from rows reopened by the canonical authorized reader. */
export function ordinaryTranscriptModelExposure(
  rows: readonly OrdinaryConversationTranscriptExposureRow[],
): ModelInputExposure {
  const dependencies: DurableModelExposureDependency[] = [];
  for (const row of rows) {
    dependencies.push(Object.freeze({
      kind: "source" as const,
      sourceKind: "message" as const,
      logicalSourceRef: `message:${row.messageId}`,
      observedRevision: String(row.editRevision),
      observedContentFingerprint: reflectionMessageSourceFingerprint({
        id: row.messageId,
        editRevision: row.editRevision,
        content: row.content,
      }),
      terminalAuthorityLeafHandle: row.namespaceId,
    }));
    if (row.role === "user") continue;
    const message = messageFor(row);
    const metadata = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? (row.metadata as Record<string, unknown>)[MODEL_INPUT_EXPOSURE_METADATA_KEY]
      : undefined;
    if (!bindModelInputExposureFromAuthorizedPersistedPayload(message, metadata)) {
      return Object.freeze({ status: "incomplete" });
    }
    const exposure = readModelInputExposure(message);
    if (exposure?.status !== "complete") return Object.freeze({ status: "incomplete" });
    dependencies.push(...exposure.dependencies);
  }
  return Object.freeze({ status: "complete", dependencies: Object.freeze(dependencies) });
}

/**
 * Bind a just-woken ordinary Human only from its exact authorized canonical
 * row. Server-authored projections must be admitted separately; they cannot be
 * disguised as bytes from the Human Message source.
 */
export function currentOrdinaryHumanModelExposure(input: Readonly<{
  messageId: number;
  roomId: string;
  namespaceId: string;
  sourceUserId: string;
  content: string;
  rows: readonly OrdinaryConversationTranscriptExposureRow[];
}>): ModelInputExposure {
  const row = input.rows.length === 1 ? input.rows[0] : undefined;
  if (
    row === undefined
    || row.messageId !== input.messageId
    || row.roomId !== input.roomId
    || row.namespaceId !== input.namespaceId
    || row.sourceUserId !== input.sourceUserId
    || row.role !== "user"
    || row.content !== input.content
    || !Number.isSafeInteger(row.editRevision)
    || row.editRevision < 0
  ) return Object.freeze({ status: "incomplete" });
  return ordinaryTranscriptModelExposure([row]);
}

const CANONICAL_SECOND_UTC =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/u;

function isCanonicalSecondUtc(value: string): boolean {
  if (!CANONICAL_SECOND_UTC.test(value)) return false;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp)
    && new Date(timestamp).toISOString().slice(0, 19) + "Z" === value;
}

/**
 * Preserve canonical Human source proof across the server's bounded neutral
 * clock projection. The timestamp is never represented as Human-authored
 * source content; only this exact process-local formatting transform is known.
 */
export function projectNeutralCurrentHumanMessageExposure(input: Readonly<{
  sourceExposure: ModelInputExposure;
  canonicalBody: string;
  actualModelBody: unknown;
  serverTimePrefixIso?: string;
}>): ModelInputExposure {
  if (input.sourceExposure.status !== "complete") {
    return Object.freeze({ status: "incomplete" });
  }
  const prefix = input.serverTimePrefixIso;
  if (prefix !== undefined && prefix.length > 0 && !isCanonicalSecondUtc(prefix)) {
    return Object.freeze({ status: "incomplete" });
  }
  const expected = prefix === undefined || prefix.length === 0
    ? input.canonicalBody
    : `[${prefix}] ${input.canonicalBody}`;
  return typeof input.actualModelBody === "string" && input.actualModelBody === expected
    ? input.sourceExposure
    : Object.freeze({ status: "incomplete" });
}
