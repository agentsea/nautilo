import type { RoomHistoryHit } from "../conductor/history-search";
import type {
  ActiveConversationRepository,
  ActiveConversationTranscriptMessage,
  AgentTranscriptOpenResult,
  ProtectedConversationProductReadAuthorization,
} from "./active-conversation-repository";
import type {
  ProtectedAgentRuntimeForegroundEntrypointId,
} from "@nautilo/lattice-bridge";
import type {
  ForegroundAuthorizationView,
} from "../protected-execution/foreground-authorization-session";

const PUBLIC_TRANSCRIPT_TEXT_MAX_BYTES = 4_096;
const PUBLIC_TRANSCRIPT_EMOJI_MAX_BYTES = 64;
const PROTECTED_TRANSCRIPT_MAX_MESSAGES = 5_000;
const PROTECTED_TRANSCRIPT_MAX_REACTIONS = 256;
const textEncoder = new TextEncoder();

function assertPublicText(
  label: string,
  value: string,
  maximumBytes: number,
): void {
  if (typeof value !== "string") {
    throw new TypeError(`${label} is malformed`);
  }
  let containsInvalidCodeUnit = false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      containsInvalidCodeUnit = true;
      break;
    }
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) {
        containsInvalidCodeUnit = true;
        break;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      containsInvalidCodeUnit = true;
      break;
    }
  }
  if (
    value.length === 0
    || textEncoder.encode(value).length > maximumBytes
    || containsInvalidCodeUnit
  ) {
    throw new TypeError(`${label} is malformed`);
  }
}

function assertMessage(
  message: ActiveConversationTranscriptMessage,
): void {
  if (!Number.isSafeInteger(message.messageId) || message.messageId < 1) {
    throw new TypeError("protected transcript message ID is malformed");
  }
  if (!Number.isSafeInteger(message.revision) || message.revision < 0) {
    throw new TypeError("protected transcript revision is malformed");
  }
  if (
    !(message.createdAt instanceof Date)
    || !Number.isFinite(message.createdAt.getTime())
  ) {
    throw new TypeError("protected transcript timestamp is malformed");
  }
  assertPublicText(
    "protected transcript author actor ID",
    message.author.actorId,
    PUBLIC_TRANSCRIPT_TEXT_MAX_BYTES,
  );
  assertPublicText(
    "protected transcript author handle",
    message.author.handle,
    PUBLIC_TRANSCRIPT_TEXT_MAX_BYTES,
  );
  assertPublicText(
    "protected transcript author display name",
    message.author.displayName,
    PUBLIC_TRANSCRIPT_TEXT_MAX_BYTES,
  );
  if (
    message.payload.role !== "user"
    && message.payload.role !== "assistant"
    && message.payload.role !== "tool"
    && message.payload.role !== "system"
  ) {
    throw new TypeError("protected transcript payload role is malformed");
  }
  if (typeof message.payload.content !== "string") {
    throw new TypeError("protected transcript payload content is malformed");
  }
  const reactions = message.reactions ?? [];
  if (reactions.length > PROTECTED_TRANSCRIPT_MAX_REACTIONS) {
    throw new RangeError("protected transcript reactions are out of bounds");
  }
  const seenReactions = new Set<string>();
  for (const reaction of reactions) {
    assertPublicText(
      "protected transcript reaction emoji",
      reaction.emoji,
      PUBLIC_TRANSCRIPT_EMOJI_MAX_BYTES,
    );
    if (seenReactions.has(reaction.emoji)) {
      throw new TypeError(
        "protected transcript reactions contain a duplicate emoji",
      );
    }
    seenReactions.add(reaction.emoji);
    if (!Number.isSafeInteger(reaction.count) || reaction.count < 1) {
      throw new TypeError("protected transcript reaction count is malformed");
    }
  }
}

/**
 * Converts an already-authorized decrypted transcript into the existing
 * labelled context shape while preserving its reviewed public coordinates.
 *
 * This function deliberately rejects duplicate or reordered rows. Repairing
 * repository order here would make a stale/corrupt protected read look
 * authoritative to the Agent.
 */
export function protectedTranscriptMessagesToHistoryHits(
  messages: readonly ActiveConversationTranscriptMessage[],
): RoomHistoryHit[] {
  const messagesAreArray = Array.isArray(messages as unknown);
  if (
    !messagesAreArray
    || messages.length > PROTECTED_TRANSCRIPT_MAX_MESSAGES
  ) {
    throw new RangeError("protected transcript is out of bounds");
  }
  const hits: RoomHistoryHit[] = [];
  const seenMessageIds = new Set<number>();
  let previous: ActiveConversationTranscriptMessage | null = null;

  for (const message of messages) {
    assertMessage(message);
    if (
      seenMessageIds.has(message.messageId)
      || (
        previous !== null
        && (
          message.createdAt.getTime() < previous.createdAt.getTime()
          || (
            message.createdAt.getTime() === previous.createdAt.getTime()
            && message.messageId <= previous.messageId
          )
        )
      )
    ) {
      throw new Error(
        "protected transcript must be strictly oldest-first",
      );
    }
    seenMessageIds.add(message.messageId);
    previous = message;

    const snippet =
      message.payload.role === "tool"
        ? `${
          message.payload.toolName
            ? `tool:${message.payload.toolName} `
            : "tool: "
        }${message.payload.content}`
        : message.payload.content;
    hits.push({
      messageId: message.messageId,
      ts: new Date(message.createdAt.getTime()),
      role: message.payload.role,
      authorDisplayName: message.author.displayName,
      handle: message.author.handle,
      authorActorId: message.author.actorId,
      snippet,
      ...(message.reactions === undefined
        ? {}
        : {
          reactions: message.reactions.map((reaction) => ({
            emoji: reaction.emoji,
            count: reaction.count,
          })),
        }),
    });
  }
  return hits;
}

/**
 * Keeps decrypted Agent transcript content inside the repository's authorized
 * callback while adapting it to the Runtime's existing labelled-history
 * representation. Typed authorization/content failures pass through intact.
 */
export async function withProtectedAgentTranscriptHistory<Value>(
  repository: Pick<ActiveConversationRepository, "withAgentTranscript">,
  input: Readonly<{
    readonly sessionId: string;
    readonly namespaceId: string;
    readonly upToMessageId?: number;
    readonly limit: number;
    readonly productReadAuthorization:
      ProtectedConversationProductReadAuthorization;
    readonly authorization: ForegroundAuthorizationView;
    readonly entrypointId: ProtectedAgentRuntimeForegroundEntrypointId;
    readonly signal?: AbortSignal;
    readonly execute: (
      messages: readonly RoomHistoryHit[],
    ) => Value | PromiseLike<Value>;
  }>,
): Promise<AgentTranscriptOpenResult<Value>> {
  if (
    !Number.isSafeInteger(input.limit)
    || input.limit < 1
    || input.limit > PROTECTED_TRANSCRIPT_MAX_MESSAGES
  ) {
    throw new RangeError("protected transcript limit is out of bounds");
  }
  return repository.withAgentTranscript({
    sessionId: input.sessionId,
    namespaceId: input.namespaceId,
    ...(input.upToMessageId === undefined
      ? {}
      : { upToMessageId: input.upToMessageId }),
    limit: input.limit,
    productReadAuthorization: input.productReadAuthorization,
    authorization: input.authorization,
    entrypointId: input.entrypointId,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    execute: (messages) => {
      if (messages.length > input.limit) {
        throw new Error(
          "protected transcript repository exceeded the requested limit",
        );
      }
      return input.execute(
        protectedTranscriptMessagesToHistoryHits(messages),
      );
    },
  });
}

export type ProtectedTranscriptSearchUnavailable = Readonly<{
  readonly status: "unavailable";
  readonly reason: "plaintext_fts_unavailable";
}>;

/**
 * Search is an explicit capability result for a protected Namespace. It must
 * never be represented as an empty FTS result because that would falsely tell
 * an Agent or Human that matching encrypted history does not exist.
 */
export function protectedTranscriptSearchUnavailable(
): ProtectedTranscriptSearchUnavailable {
  return Object.freeze({
    status: "unavailable",
    reason: "plaintext_fts_unavailable",
  });
}
