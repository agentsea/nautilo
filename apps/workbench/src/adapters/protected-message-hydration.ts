import {
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
  parseProtectedMessageRealtimeEventV2,
  type ProtectedMessageDtoV2,
  type ProtectedMessagePayloadOutcomeV2,
  type ProtectedMessageRealtimeEventV2,
  type ProtectedMessageUnavailableReasonV2,
} from "@nautilo/types";

const MAX_OPENED_CONTENT_BYTES_V2 = 1_048_576;
export const PROTECTED_WORKBENCH_MAX_HYDRATION_ROWS_V2 = 200;
const textEncoder = new TextEncoder();

type EncryptedPayloadV2 = Extract<
  ProtectedMessagePayloadOutcomeV2,
  { status: "encrypted" }
>;

export type ProtectedEncryptedMessageDtoV2 =
  Omit<ProtectedMessageDtoV2, "protectedPayload"> & {
    readonly protectedPayload: EncryptedPayloadV2;
  };

export type AuthorizedClientMessageOpenResultV2 =
  | Readonly<{
    status: "opened";
    payloadVersion: 2;
    role: ProtectedMessageDtoV2["projection"]["role"];
    content: string;
  }>
  | Readonly<{
    status: "unavailable";
    reason: ProtectedMessageUnavailableReasonV2;
  }>;

/**
 * Browser-owned authorized open boundary. The implementation may use WebCrypto
 * or WASM, but this adapter deliberately imports neither server nor crypto
 * packages. Unknown is intentional: every implementation result is validated
 * again before any text reaches render state.
 */
export interface AuthorizedClientMessageDecryptPortV2 {
  open(
    message: ProtectedEncryptedMessageDtoV2,
  ): unknown;
}

export type ProtectedMessagePlaceholderV2 =
  | "pending"
  | "locked"
  | "unsupported"
  | "corrupt"
  | "lost-key";

export type ProtectedWorkbenchMessageContentV2 =
  | Readonly<{ kind: "opened"; text: string }>
  | Readonly<{
    kind: "placeholder";
    placeholder: ProtectedMessagePlaceholderV2;
    reason: ProtectedMessageUnavailableReasonV2
      | Extract<
        ProtectedMessagePayloadOutcomeV2,
        { status: "pending" }
      >["reason"];
  }>;

export interface ProtectedWorkbenchMessageV2 {
  readonly messageId: string;
  readonly logicalMessageKey?: string;
  readonly sessionId: string;
  readonly roomId: string;
  readonly namespaceId: string;
  readonly role: ProtectedMessageDtoV2["projection"]["role"];
  readonly createdAt: string;
  readonly editedAt?: string | null;
  readonly editRevision: number;
  readonly content: ProtectedWorkbenchMessageContentV2;
  /**
   * Authenticated source DTO retained for deterministic revision comparison.
   * It contains ciphertext and bounded public metadata, never opened text.
   */
  readonly source: ProtectedMessageDtoV2;
}

export interface ProtectedRoomMessageStateV2 {
  readonly roomId: string;
  readonly namespaceId: string;
  readonly messages: readonly ProtectedWorkbenchMessageV2[];
}

export type ProtectedRoomHydrationResultV2 =
  | Readonly<{ status: "ready"; state: ProtectedRoomMessageStateV2 }>
  | Readonly<{ status: "rejected"; reason: "corrupt" }>;

export type ProtectedRoomReconciliationResultV2 =
  | Readonly<{ status: "applied"; state: ProtectedRoomMessageStateV2 }>
  | Readonly<{ status: "ignored"; state: ProtectedRoomMessageStateV2 }>
  | Readonly<{
    status: "rejected";
    reason: "corrupt";
    state: ProtectedRoomMessageStateV2;
  }>;

const UNAVAILABLE_REASONS = new Set<ProtectedMessageUnavailableReasonV2>([
  "missing_grant",
  "stale_grant",
  "unauthorized",
  "removed",
  "unsupported_version",
  "corrupt",
  "lost_key_material",
]);

function exactKeys(
  value: Readonly<Record<string, unknown>>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isOpenResult(
  value: unknown,
  message: ProtectedEncryptedMessageDtoV2,
): value is AuthorizedClientMessageOpenResultV2 {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Readonly<Record<string, unknown>>;
  if (record.status === "opened") {
    return exactKeys(record, ["status", "payloadVersion", "role", "content"])
      && record.payloadVersion === message.protectedPayload.payloadVersion
      && record.role === message.projection.role
      && typeof record.content === "string"
      && textEncoder.encode(record.content).length <= MAX_OPENED_CONTENT_BYTES_V2;
  }
  return record.status === "unavailable"
    && exactKeys(record, ["status", "reason"])
    && typeof record.reason === "string"
    && UNAVAILABLE_REASONS.has(
      record.reason as ProtectedMessageUnavailableReasonV2,
    );
}

function unavailableContent(
  reason: ProtectedMessageUnavailableReasonV2,
): ProtectedWorkbenchMessageContentV2 {
  switch (reason) {
    case "unsupported_version":
      return { kind: "placeholder", placeholder: "unsupported", reason };
    case "corrupt":
      return { kind: "placeholder", placeholder: "corrupt", reason };
    case "lost_key_material":
      return { kind: "placeholder", placeholder: "lost-key", reason };
    case "missing_grant":
    case "stale_grant":
    case "unauthorized":
    case "removed":
      return { kind: "placeholder", placeholder: "locked", reason };
  }
}

async function renderContent(
  message: ProtectedMessageDtoV2,
  decrypt: AuthorizedClientMessageDecryptPortV2,
): Promise<ProtectedWorkbenchMessageContentV2> {
  const protectedPayload = message.protectedPayload;
  if (protectedPayload.status === "pending") {
    return {
      kind: "placeholder",
      placeholder: "pending",
      reason: protectedPayload.reason,
    };
  }
  if (protectedPayload.status === "unavailable") {
    return unavailableContent(protectedPayload.reason);
  }

  const encryptedMessage = message as ProtectedEncryptedMessageDtoV2;
  try {
    const opened: unknown = await decrypt.open(encryptedMessage);
    if (!isOpenResult(opened, encryptedMessage)) {
      return unavailableContent("corrupt");
    }
    if (opened.status === "unavailable") {
      return unavailableContent(opened.reason);
    }
    return { kind: "opened", text: opened.content };
  } catch {
    return unavailableContent("corrupt");
  }
}

function messageIdentity(message: ProtectedMessageDtoV2): string {
  const logical = message.projection.logicalMessageKey;
  return logical ? `logical:${logical}` : `message:${message.projection.messageId}`;
}

function sameImmutableCoordinate(
  left: ProtectedMessageDtoV2,
  right: ProtectedMessageDtoV2,
): boolean {
  const a = left.projection;
  const b = right.projection;
  return a.messageId === b.messageId
    && a.logicalMessageKey === b.logicalMessageKey
    && a.sessionId === b.sessionId
    && a.roomId === b.roomId
    && a.namespaceId === b.namespaceId
    && a.role === b.role
    && a.createdAt === b.createdAt
    && a.replyToMessageId === b.replyToMessageId
    && a.subthreadRoomId === b.subthreadRoomId
    && a.sourceUserId === b.sourceUserId
    && a.authorAgentId === b.authorAgentId;
}

function chooseRevision(
  current: ProtectedMessageDtoV2,
  incoming: ProtectedMessageDtoV2,
): ProtectedMessageDtoV2 | null {
  if (!sameImmutableCoordinate(current, incoming)) return null;
  const currentRevision = current.projection.editRevision;
  const incomingRevision = incoming.projection.editRevision;
  if (incomingRevision < currentRevision) return current;
  if (incomingRevision > currentRevision) return incoming;
  return encodeProtectedMessageDtoV2(current) === encodeProtectedMessageDtoV2(incoming)
    ? current
    : null;
}

function belongsToState(
  message: ProtectedMessageDtoV2,
  roomId: string,
  namespaceId: string,
): boolean {
  const projection = message.projection;
  const editCoordinateIsCoherent = projection.editRevision === 0
    ? projection.editedAt === null || projection.editedAt === undefined
    : typeof projection.editedAt === "string";
  return projection.roomId === roomId
    && projection.namespaceId === namespaceId
    && editCoordinateIsCoherent;
}

async function toWorkbenchMessage(
  message: ProtectedMessageDtoV2,
  decrypt: AuthorizedClientMessageDecryptPortV2,
): Promise<ProtectedWorkbenchMessageV2> {
  const projection = message.projection;
  const content = await renderContent(message, decrypt);
  return {
    messageId: projection.messageId,
    ...(projection.logicalMessageKey
      ? { logicalMessageKey: projection.logicalMessageKey }
      : {}),
    sessionId: projection.sessionId,
    roomId: projection.roomId,
    namespaceId: projection.namespaceId,
    role: projection.role,
    createdAt: projection.createdAt,
    ...(projection.editedAt !== undefined
      ? { editedAt: projection.editedAt }
      : {}),
    editRevision: projection.editRevision,
    content,
    source: message,
  };
}

function compareMessageOrder(
  left: ProtectedMessageDtoV2,
  right: ProtectedMessageDtoV2,
): number {
  const time = left.projection.createdAt.localeCompare(right.projection.createdAt);
  if (time !== 0) return time;
  return Number(left.projection.messageId) - Number(right.projection.messageId);
}

export async function hydrateProtectedRoomMessagesV2(input: Readonly<{
  roomId: string;
  namespaceId: string;
  messages: readonly unknown[];
  decrypt: AuthorizedClientMessageDecryptPortV2;
}>): Promise<ProtectedRoomHydrationResultV2> {
  if (input.messages.length > PROTECTED_WORKBENCH_MAX_HYDRATION_ROWS_V2) {
    return { status: "rejected", reason: "corrupt" };
  }
  const revisions = new Map<string, ProtectedMessageDtoV2>();
  const identitiesByMessageId = new Map<string, string>();
  try {
    for (const candidate of input.messages) {
      const message = parseProtectedMessageDtoV2(candidate);
      if (!belongsToState(message, input.roomId, input.namespaceId)) {
        return { status: "rejected", reason: "corrupt" };
      }
      const identity = messageIdentity(message);
      const physicalIdentity = identitiesByMessageId.get(
        message.projection.messageId,
      );
      if (physicalIdentity !== undefined && physicalIdentity !== identity) {
        return { status: "rejected", reason: "corrupt" };
      }
      identitiesByMessageId.set(message.projection.messageId, identity);
      const current = revisions.get(identity);
      if (!current) {
        revisions.set(identity, message);
        continue;
      }
      const selected = chooseRevision(current, message);
      if (!selected) return { status: "rejected", reason: "corrupt" };
      revisions.set(identity, selected);
    }
  } catch {
    return { status: "rejected", reason: "corrupt" };
  }

  const selected = [...revisions.values()].sort(compareMessageOrder);
  const messages = await Promise.all(
    selected.map((message) => toWorkbenchMessage(message, input.decrypt)),
  );
  return {
    status: "ready",
    state: {
      roomId: input.roomId,
      namespaceId: input.namespaceId,
      messages,
    },
  };
}

function parseEvent(value: unknown): ProtectedMessageRealtimeEventV2 | null {
  try {
    return parseProtectedMessageRealtimeEventV2(value);
  } catch {
    return null;
  }
}

export async function reconcileProtectedRoomEventV2(input: Readonly<{
  state: ProtectedRoomMessageStateV2;
  event: unknown;
  decrypt: AuthorizedClientMessageDecryptPortV2;
}>): Promise<ProtectedRoomReconciliationResultV2> {
  const event = parseEvent(input.event);
  if (!event || event.laneKey !== `room:${input.state.roomId}`) {
    return { status: "rejected", reason: "corrupt", state: input.state };
  }
  if (event.type === "message.tokens") {
    return { status: "ignored", state: input.state };
  }
  if (!belongsToState(
    event.message,
    input.state.roomId,
    input.state.namespaceId,
  )) {
    return { status: "rejected", reason: "corrupt", state: input.state };
  }

  const identity = messageIdentity(event.message);
  const index = input.state.messages.findIndex((message) =>
    messageIdentity(message.source) === identity
  );
  if (index < 0) {
    if (input.state.messages.some((message) =>
      message.messageId === event.message.projection.messageId
    )) {
      return { status: "rejected", reason: "corrupt", state: input.state };
    }
    const appended = await toWorkbenchMessage(event.message, input.decrypt);
    return {
      status: "applied",
      state: {
        ...input.state,
        messages: [...input.state.messages, appended].sort((left, right) =>
          compareMessageOrder(left.source, right.source)
        ),
      },
    };
  }

  const current = input.state.messages[index];
  const selected = chooseRevision(current.source, event.message);
  if (!selected) {
    return { status: "rejected", reason: "corrupt", state: input.state };
  }
  if (selected === current.source) {
    return { status: "ignored", state: input.state };
  }

  const replacement = await toWorkbenchMessage(selected, input.decrypt);
  return {
    status: "applied",
    state: {
      ...input.state,
      messages: input.state.messages.map((message, candidateIndex) =>
        candidateIndex === index ? replacement : message
      ),
    },
  };
}
