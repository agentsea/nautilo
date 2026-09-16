import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  unixTimestamp,
  verifyHumanLiveShadowClientVerification,
  type LatticeCrypto,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import {
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
  type LiveShadowMessageRealtimeEventV1,
} from "@nautilo/types";

import { encodeMessagePayloadV2 } from "../../message/message-payload-v2.ts";
import { fullEncryptionDurableEventDigestV2, liveShadowDurableEventDigestV1 } from
  "../../message/live-shadow-realtime-evidence.ts";
import type { PublishedHumanMessageRecoveryResult } from
  "./postgres-published-human-message-recovery.ts";

const MAX_TRANSCRIPT = 256;

export type LiveShadowClientVerificationResult =
  | Readonly<{ status: "verified" | "replayed"; operationId: string }>
  | Readonly<{ status: "conflict" | "unavailable" }>;

export interface LiveShadowClientVerificationInput {
  readonly authority: Readonly<{
    userId: string;
    humanActorId: string;
  }>;
  readonly roomId: string;
  readonly operationId: string;
  readonly verificationBytes: Uint8Array;
  readonly now: number;
}

export interface RoomHistoryReaderSigningAuthorityInput {
  readonly subjectUserId: string;
  readonly subjectHumanId: string;
  readonly readerDeviceId: string;
  readonly readerDeviceSigningKeyGeneration: number;
  readonly hostAuthorizationRevision: number;
}

type ShadowDurableRecoveryEvent = Extract<LiveShadowMessageRealtimeEventV1, {
  type: "message.shadow_durable";
}>;
type FullDurableRecoveryEvent = Omit<ShadowDurableRecoveryEvent,
  "wireVersion" | "ordinaryPayloadBytesBase64url"> & { readonly wireVersion: 2 };

/**
 * Re-resolve the exact active device signing key used by an M275 history-read
 * acknowledgement. The restricted crypto schema stays behind the bridge; HTTP
 * composition receives only an owned public-key copy and must wipe it.
 */
export async function resolveRoomHistoryReaderSigningPublicKey(
  restricted: PostgresJsBridgeConnection,
  input: RoomHistoryReaderSigningAuthorityInput,
): Promise<Uint8Array | null> {
  const rows = await restricted.query(
    `/* m275_history_read_planned_device_key */
     SELECT device.signing_public_key
       FROM human_crypto_devices device
       JOIN human_crypto_custodies custody
         ON custody.human_id = device.human_id
      WHERE device.human_id = $1
        AND device.user_id = $2::uuid
        AND device.human_actor_id = $3::uuid
        AND device.device_id = $4
        AND device.device_generation = $5
        AND device.revision = $6
        AND device.state = 'active'
        AND custody.state = 'active'
      LIMIT 2`,
    [
      input.subjectHumanId,
      input.subjectUserId,
      input.subjectHumanId,
      input.readerDeviceId,
      input.readerDeviceSigningKeyGeneration,
      input.hostAuthorizationRevision,
    ],
  );
  const key = rows[0]?.["signing_public_key"];
  return rows.length === 1 && key instanceof Uint8Array ? key.slice() : null;
}

export type LiveShadowTurnRecoveryResult =
  | PublishedHumanMessageRecoveryResult
  | Readonly<{ status: "absent" }>
  | Readonly<{
      status: "pending";
      state: "planned" | "human_verified" | "running";
      jobId: string | null;
      human?: ReturnType<typeof parseProtectedMessageDtoV2>;
    }>
  | Readonly<{
      status: "completed";
      state: "completed" | "client_verified";
      jobId: string;
      human: ReturnType<typeof parseProtectedMessageDtoV2>;
      durableEvents: readonly (ShadowDurableRecoveryEvent | FullDurableRecoveryEvent)[];
    }>
  | Readonly<{
      status: "fallback";
      state: "fallback" | "failed";
      jobId: string | null;
      reason: string;
      human?: ReturnType<typeof parseProtectedMessageDtoV2>;
    }>;

function one(
  rows: readonly PostgresJsBridgeRow[],
): PostgresJsBridgeRow | null {
  return rows.length === 1 ? rows[0]! : null;
}

function stringValue(row: PostgresJsBridgeRow, key: string): string {
  const value = row[key];
  if (typeof value !== "string") {
    throw new TypeError(`Live Shadow verification ${key} is invalid`);
  }
  return value;
}

function text(row: PostgresJsBridgeRow, key: string): string {
  const value = stringValue(row, key);
  if (value.length === 0) {
    throw new TypeError(`Live Shadow verification ${key} is invalid`);
  }
  return value;
}

function nullableText(row: PostgresJsBridgeRow, key: string): string | null {
  const value = row[key];
  return value === null ? null : text(row, key);
}

function counter(
  row: PostgresJsBridgeRow,
  key: string,
  minimum = 0,
): number {
  const raw = row[key];
  const value = typeof raw === "bigint"
    ? Number(raw)
    : typeof raw === "string" && /^(?:0|[1-9]\d*)$/u.test(raw)
    ? Number(raw)
    : raw;
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new TypeError(`Live Shadow verification ${key} is invalid`);
  }
  return value as number;
}

function date(row: PostgresJsBridgeRow, key: string): Date {
  const value = row[key];
  const parsed = value instanceof Date
    ? value
    : typeof value === "string"
    ? new Date(value)
    : null;
  if (parsed === null || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`Live Shadow verification ${key} is invalid`);
  }
  return parsed;
}

function bytes(row: PostgresJsBridgeRow, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array) || value.length === 0) {
    throw new TypeError(`Live Shadow verification ${key} is invalid`);
  }
  return value.slice();
}

function nullableBytes(
  row: PostgresJsBridgeRow,
  key: string,
): Uint8Array | null {
  return row[key] === null ? null : bytes(row, key);
}

function equal(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function failedStage(stage: string): string {
  switch (stage) {
    case "human_prepare": return "human_admission";
    case "server_admission": return "human_admission";
    case "agent_consume": return "agent_input";
    case "assistant_stream": return "assistant_stream";
    case "tool_call_consume": return "tool_call";
    case "tool_result_consume": return "tool_result";
    case "durable_transcript": return "durable_transcript";
    case "browser_open": return "client_verification";
    default: throw new TypeError("Live Shadow failure stage is unsupported");
  }
}

function failedReason(reason: string): string {
  switch (reason) {
    case "policy_changed":
    case "authority_changed":
    case "deadline_expired":
    case "integrity_failure":
    case "parity_mismatch":
    case "stream_incomplete":
    case "client_unavailable":
    case "unsupported_payload":
    case "storage_failure":
    case "transport_failure":
      return reason;
    default: throw new TypeError("Live Shadow failure reason is unsupported");
  }
}

function encoded(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

function destroyVerification(
  verification: ReturnType<typeof verifyHumanLiveShadowClientVerification>,
): void {
  verification.transcript.forEach((entry) => {
    entry.ordinaryPayloadDigest.fill(0);
    entry.protectedDtoDigest.fill(0);
  });
  verification.streamTerminals.forEach((entry) => {
    entry.streamStartDigest.fill(0);
    entry.terminalFrameDigest.fill(0);
    entry.streamedTextDigest.fill(0);
    entry.finalPayloadDigest.fill(0);
  });
  verification.signature.fill(0);
}

export function encodeLiveShadowOrdinaryPayloadV2(
  row: PostgresJsBridgeRow,
  toolCallId: string | null,
): Uint8Array {
  const role = text(row, "role");
  if (
    role !== "user"
    && role !== "assistant"
    && role !== "tool"
    && role !== "system"
  ) {
    throw new TypeError("Live Shadow verification role is unsupported");
  }
  const rawToolCalls = nullableText(row, "tool_calls");
  let parsedToolCalls: unknown;
  if (rawToolCalls !== null) parsedToolCalls = JSON.parse(rawToolCalls);
  if (role === "assistant" && Array.isArray(parsedToolCalls)) {
    parsedToolCalls = parsedToolCalls.map((call: unknown) => {
      if (typeof call !== "object" || call === null || Array.isArray(call)) return call;
      const record = call as Record<string, unknown>;
      // Normalize the known LangChain transcript marker at the product boundary.
      // Every other field still faces the unchanged strict Message wire codec.
      if (record["type"] !== "tool_call") return call;
      const { type: _type, ...canonical } = record;
      return canonical;
    });
  }
  if (role === "system") {
    return encodeMessagePayloadV2({
      role,
      content: stringValue(row, "content"),
      ...(parsedToolCalls === undefined
        ? {}
        : { sensitiveMetadata: parsedToolCalls as never }),
    });
  }
  return encodeMessagePayloadV2({
    role,
    // An Assistant tool-call Message canonically has empty textual content.
    // Empty is distinct from a missing/non-string product value.
    content: stringValue(row, "content"),
    ...(parsedToolCalls === undefined
      ? {}
      : { toolCalls: parsedToolCalls as never }),
    ...(nullableText(row, "tool_name") === null
      ? {}
      : { toolName: nullableText(row, "tool_name")! }),
    ...(role !== "tool" || toolCallId === null
      ? {}
      : { sensitiveMetadata: { toolCallId } }),
  });
}

/** Retain confidential tool-call correlation across chronological query pages.
 * Each consumed page returns only its own matches, keyed by global row ordinal. */
export function createLiveShadowToolResultCallIdResolver(
  options: Readonly<{
    opaqueBodylessRows?: boolean;
    onUnpairedToolResult?: (oneBasedIndex: number) => void;
  }> = {},
): Readonly<{
  consume(rows: readonly PostgresJsBridgeRow[], context?: Readonly<{
    /** Only after the caller verifies the exact shared resume lineage and parity. */
    allowProjectionCheckpointRedaction: boolean;
  }>): ReadonlyMap<number, string>;
}> {
  const sessions = new Map<string, {
    queuedByName: Map<string, string[]>;
    pending: Map<string, string>;
  }>();
  let consumedRows = 0;
  return Object.freeze({
    consume(rows: readonly PostgresJsBridgeRow[], context?: Readonly<{
      allowProjectionCheckpointRedaction: boolean;
    }>): ReadonlyMap<number, string> {
      const result = new Map<number, string>();
      for (let index = 0; index < rows.length; index += 1) {
        const oneBasedIndex = consumedRows + index + 1;
        const row = rows[index]!;
        const role = text(row, "role");
        const sessionId = typeof row["session_id"] === "string"
          ? row["session_id"] : "";
        let session = sessions.get(sessionId);
        if (session === undefined) {
          session = { queuedByName: new Map(), pending: new Map() };
          sessions.set(sessionId, session);
        }
        if (
          options.opaqueBodylessRows === true
          && row["content"] === null
          && (role === "assistant" || role === "tool")
        ) {
          // Protected payloads carry their own exact tool-call identity. Since
          // this ordinary projection cannot inspect them, reset correlation at
          // the opaque boundary rather than pairing a later ordinary result with
          // a call that may already have been consumed inside protected content.
          session.queuedByName.clear();
          session.pending.clear();
          continue;
        }
        if (role === "assistant") {
          const raw = nullableText(row, "tool_calls");
          if (raw === null) continue;
          const calls: unknown = JSON.parse(raw);
          if (!Array.isArray(calls)) {
            throw new TypeError("Live Shadow verification tool calls are invalid");
          }
          for (const call of calls) {
            if (typeof call !== "object" || call === null) {
              throw new TypeError("Live Shadow verification tool call is invalid");
            }
            const record = call as Record<string, unknown>;
            const id = record["id"];
            const name = record["name"];
            if (typeof id !== "string" || id.length === 0
              || typeof name !== "string" || name.length === 0) {
              throw new TypeError("Live Shadow verification tool call is invalid");
            }
            // Duplicate delivery of a still-pending call feeds one result. A
            // later completed call may reuse the provider's ID in the same Session.
            const identity = JSON.stringify(record);
            const pending = session.pending.get(id);
            if (pending !== undefined) {
              // Projection preflight deliberately checkpoints only mode, keeping
              // the proposal in its protected snapshot. An authenticated resume
              // can repeat that redacted call, not a different proposal. This
              // affects correlation only; each row retains its own parity bytes.
              const checkpointRedaction = context?.allowProjectionCheckpointRedaction === true
                && isProjectionCheckpointRedaction(pending, record);
              if (pending !== identity && !checkpointRedaction) {
                throw new TypeError("Live Shadow verification pending tool call conflicts");
              }
              continue;
            }
            session.pending.set(id, identity);
            const queue = session.queuedByName.get(name) ?? [];
            queue.push(id);
            session.queuedByName.set(name, queue);
          }
          continue;
        }
        if (role !== "tool") continue;
        const name = text(row, "tool_name");
        const queue = session.queuedByName.get(name);
        const id = queue?.shift();
        if (id === undefined) {
          if (options.onUnpairedToolResult !== undefined) {
            options.onUnpairedToolResult(oneBasedIndex);
            continue;
          }
          throw new TypeError("Live Shadow verification tool result is unpaired");
        }
        session.pending.delete(id);
        result.set(oneBasedIndex, id);
      }
      consumedRows += rows.length;
      return result;
    }
  });
}

function isProjectionCheckpointRedaction(
  pendingIdentity: string,
  repeated: Record<string, unknown>,
): boolean {
  if (repeated["name"] !== "share_memory") return false;
  const args = repeated["args"];
  if (typeof args !== "object" || args === null || Array.isArray(args)
    || Object.keys(args).length !== 1
    || (args as Record<string, unknown>)["mode"] !== "project") return false;
  const pending = JSON.parse(pendingIdentity) as Record<string, unknown>;
  const originalArgs = pending["args"];
  if (typeof originalArgs !== "object" || originalArgs === null || Array.isArray(originalArgs)
    || (originalArgs as Record<string, unknown>)["mode"] !== "project") return false;
  return JSON.stringify({ ...pending, args: { mode: "project" } }) === JSON.stringify(repeated);
}

export function resolveLiveShadowToolResultCallIds(
  rows: readonly PostgresJsBridgeRow[],
  options: Readonly<{
    opaqueBodylessRows?: boolean;
    onUnpairedToolResult?: (oneBasedIndex: number) => void;
  }> = {},
): ReadonlyMap<number, string> {
  return createLiveShadowToolResultCallIdResolver(options).consume(rows);
}

async function protectedDto(input: Readonly<{
  storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
  row: PostgresJsBridgeRow;
  sessionId: string;
  roomId: string;
  namespaceId: string;
  agentId: string;
}>): Promise<ReturnType<typeof parseProtectedMessageDtoV2>> {
  const objectId = text(input.row, "crypto_object_id");
  const [object, access] = await Promise.all([
    input.storage.getObject(objectId),
    input.storage.getObjectAccessState(objectId),
  ]);
  if (
    object === null
    || access === null
    || object.objectId !== objectId
    || access.head.objectId !== objectId
  ) throw new TypeError("Live Shadow protected representation is absent");
  const envelopes = access.namespaceEnvelopes.filter(
    (candidate) => candidate.namespaceId === input.namespaceId,
  );
  if (envelopes.length !== 1) {
    throw new TypeError("Live Shadow Namespace envelope is not exact");
  }
  const role = text(input.row, "role");
  if (role !== "user" && role !== "assistant" && role !== "tool") {
    throw new TypeError("Live Shadow protected role is unsupported");
  }
  try {
    return parseProtectedMessageDtoV2({
      dtoVersion: 2,
      projection: {
        messageId: String(counter(input.row, "message_id", 1)),
        sessionId: input.sessionId,
        roomId: input.roomId,
        namespaceId: input.namespaceId,
        role,
        createdAt: date(input.row, "created_at").toISOString(),
        editRevision: 0,
        ...(role === "user" ? {} : { authorAgentId: input.agentId }),
      },
      protectedPayload: {
        status: "encrypted",
        cryptoObjectId: objectId,
        payloadVersion: 2,
        keyClass: "ai",
        encryptedPayloadBytesBase64url: encoded(object.payloadBytes),
        accessManifestBytesBase64url: encoded(access.head.manifestBytes),
        namespaceEnvelopeBytesBase64url: encoded(
          envelopes[0]!.envelopeBytes,
        ),
      },
    });
  } finally {
    object.payloadBytes.fill(0);
    access.head.manifestBytes.fill(0);
    access.namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
  }
}

/**
 * Verify the Browser's signed complete-turn receipt against exact product and
 * restricted crypto facts, then atomically close completed -> client_verified.
 */
export async function verifyAndRecordLiveShadowClientVerification(
  dependencies: Readonly<{
    product: PostgresJsBridgeConnection;
    restricted: PostgresJsBridgeConnection;
    storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
    crypto: LatticeCrypto;
  }>,
  input: LiveShadowClientVerificationInput,
): Promise<LiveShadowClientVerificationResult> {
  if (
    !Number.isSafeInteger(input.now)
    || input.now < 0
    || !(input.verificationBytes instanceof Uint8Array)
  ) return Object.freeze({ status: "conflict" });
  return dependencies.product.transactionOnce(async (transaction) => {
    const turn = one(await transaction.query(
      `/* m282_live_shadow_client_verification_turn */
       SELECT t.*, p.mode, p.revision AS current_policy_revision,
              s.owner_id::text AS owner_id,
              actor.id::text AS human_actor_id
         FROM conversation_shadow_turn_operations t
         JOIN encryption_transition_policy p ON p.id = 'server'
         JOIN sessions s ON s.id = t.session_id
         JOIN actors actor
           ON actor.kind = 'user' AND actor.owner_id = s.owner_id
        WHERE t.operation_id = $1 AND t.room_id = $2::uuid
        FOR UPDATE OF t
        LIMIT 2`,
      [input.operationId, input.roomId],
    ));
    if (
      turn === null
      || text(turn, "owner_id") !== input.authority.userId
      || text(turn, "human_actor_id") !== input.authority.humanActorId
      || !["shadow_encryption", "encrypted_only"].includes(text(turn, "mode"))
      || counter(turn, "current_policy_revision", 1)
        !== counter(turn, "policy_revision", 1)
    ) return Object.freeze({ status: "unavailable" as const });
    const full = text(turn, "mode") === "encrypted_only";

    const signingRow = one(await dependencies.restricted.query(
      `/* m282_live_shadow_client_verification_authority */
       SELECT d.human_id, d.revision AS device_revision,
              d.signing_public_key, d.state AS device_state,
              c.state AS custody_state
         FROM human_crypto_devices d
         JOIN human_crypto_custodies c ON c.human_id = d.human_id
        WHERE d.device_id = $1
        LIMIT 2`,
      [text(turn, "committer_device_id")],
    ));
    if (
      signingRow === null
      || text(signingRow, "human_id") !== text(turn, "subject_human_id")
      || counter(signingRow, "device_revision")
        !== counter(turn, "host_authorization_revision")
      || text(signingRow, "device_state") !== "active"
      || text(signingRow, "custody_state") !== "active"
    ) return Object.freeze({ status: "unavailable" as const });
    const signingPublicKey = bytes(signingRow, "signing_public_key");
    let verification;
    try {
      verification = verifyHumanLiveShadowClientVerification(
        dependencies.crypto,
        {
          verificationBytes: input.verificationBytes,
          now: unixTimestamp(input.now),
          resolveCurrentAuthority: (context) =>
            context.operationId === input.operationId
              && context.subjectHumanId === text(turn, "subject_human_id")
              && context.committerDeviceId
                === text(turn, "committer_device_id")
              && context.hostAuthorizationRevision
                === counter(turn, "host_authorization_revision")
              ? signingPublicKey.slice()
              : null,
        },
      );
    } catch {
      return Object.freeze({ status: "conflict" as const });
    } finally {
      signingPublicKey.fill(0);
    }
    try {
      if (
        verification.operationId !== input.operationId
        || verification.policyRevision !== counter(turn, "policy_revision", 1)
        || verification.sessionId !== text(turn, "session_id")
        || verification.roomId !== input.roomId
        || (verification.status === "matched"
          && (verification.closedStage !== "browser_open"
            || verification.reason !== "none"))
      ) return Object.freeze({ status: "conflict" as const });

      const rows = await transaction.query(
        `/* m282_live_shadow_client_verification_transcript */
         SELECT l.message_id, l.edit_revision, l.crypto_object_id,
                l.shadow_transcript_ordinal, l.shadow_stream_id,
                l.shadow_stream_start_digest,
                l.shadow_stream_terminal_digest,
                l.shadow_streamed_text_digest,
                l.shadow_durable_event_digest, l.completion,
                l.disposition, l.parity_status, l.author_role,
                l.representation_mode, l.publication_policy_revision,
                sm.role, ${full ? "NULL::text AS content, NULL::text AS tool_calls, NULL::text AS tool_name" : "sm.content, sm.tool_calls, sm.tool_name"},
                sm.created_at, sm.crypto_object_id AS mapped_object_id
           FROM session_message_crypto_revisions l
           JOIN session_messages sm
             ON sm.session_id = l.session_id
            AND sm.id = l.message_id
            AND sm.edit_revision = l.edit_revision
          WHERE l.shadow_operation_id = $1
          ORDER BY l.shadow_transcript_ordinal
          FOR UPDATE OF l, sm
          LIMIT ${MAX_TRANSCRIPT + 1}`,
        [input.operationId],
      );
      if (
        rows.length < 1
        || rows.length > MAX_TRANSCRIPT
        || (verification.status === "matched"
          ? rows.length < 2 || rows.length !== verification.transcript.length
          : verification.transcript.length > rows.length)
      ) return Object.freeze({ status: "conflict" as const });

      const expectedTerminals: NonNullable<
        typeof verification.streamTerminals[number]
      >[] = [];
      let finalDigest: Uint8Array | null = null;
      try {
        let callIds: ReadonlyMap<number, string>;
        try {
          callIds = full ? new Map() : resolveLiveShadowToolResultCallIds(rows);
        } catch {
          return Object.freeze({ status: "conflict" as const });
        }
        for (
          let index = 0;
          index < verification.transcript.length;
          index += 1
        ) {
          const row = rows[index]!;
          const ordinal = index + 1;
          const transcript = verification.transcript[index]!;
          const role = text(row, "role");
          const authorRole = role === "user" ? "human" : role;
          if (
            counter(row, "shadow_transcript_ordinal", 1) !== ordinal
            || counter(row, "edit_revision") !== 0
            || text(row, "completion") !== "complete"
            || text(row, "disposition") !== "mapped"
            || text(row, "mapped_object_id") !== text(row, "crypto_object_id")
            || text(row, "author_role") !== role
            || transcript.transcriptOrdinal !== ordinal
            || transcript.messageId !== counter(row, "message_id", 1)
            || transcript.revision !== 0
            || transcript.authorRole !== authorRole
            || transcript.cryptoObjectId !== text(row, "crypto_object_id")
            || text(row, "representation_mode") !== (full ? "full_encryption" : "shadow_encryption")
            || (full && counter(row, "publication_policy_revision", 1) !== verification.policyRevision)
            || text(row, "parity_status") !== (full
              ? (ordinal === 1 ? "client_authenticated" : "server_authenticated")
              : (ordinal === 1 ? "client_verified" : "server_verified"))
          ) return Object.freeze({ status: "conflict" as const });

          const ordinary = full ? null : encodeLiveShadowOrdinaryPayloadV2(
            row, callIds.get(ordinal) ?? null,
          );
          const dto = await protectedDto({
            storage: dependencies.storage,
            row,
            sessionId: text(turn, "session_id"),
            roomId: input.roomId,
            namespaceId: text(turn, "namespace_id"),
            agentId: text(turn, "agent_id"),
          });
          const dtoBytes = new TextEncoder().encode(
            encodeProtectedMessageDtoV2(dto),
          );
          const ordinaryDigest = ordinary === null
            ? transcript.ordinaryPayloadDigest.slice()
            : dependencies.crypto.hash(ordinary);
          const dtoDigest = dependencies.crypto.hash(dtoBytes);
          try {
            if (
              (!full && !equal(transcript.ordinaryPayloadDigest, ordinaryDigest))
              || !equal(transcript.protectedDtoDigest, dtoDigest)
            ) return Object.freeze({ status: "conflict" as const });

            if (ordinal > 1) {
              const eventDigest = full
                ? fullEncryptionDurableEventDigestV2(dependencies.crypto, {
                    operationId: input.operationId,
                    policyRevision: verification.policyRevision,
                    transcriptOrdinal: ordinal,
                    protectedMessage: dto,
                  })
                : liveShadowDurableEventDigestV1(dependencies.crypto, {
                  operationId: input.operationId,
                  policyRevision: verification.policyRevision,
                  transcriptOrdinal: ordinal,
                  ordinaryPayloadBytes: ordinary!,
                  protectedMessage: dto,
                });
              const storedEventDigest = nullableBytes(
                row,
                "shadow_durable_event_digest",
              );
              try {
                if (
                  storedEventDigest === null
                  || !equal(storedEventDigest, eventDigest)
                ) return Object.freeze({ status: "conflict" as const });
                finalDigest?.fill(0);
                finalDigest = eventDigest.slice();
              } finally {
                storedEventDigest?.fill(0);
                eventDigest.fill(0);
              }
            }
            const streamId = nullableText(row, "shadow_stream_id");
            if (streamId !== null) {
              if (role !== "assistant") {
                return Object.freeze({ status: "conflict" as const });
              }
              const startDigest = nullableBytes(
                row,
                "shadow_stream_start_digest",
              );
              const terminalDigest = nullableBytes(
                row,
                "shadow_stream_terminal_digest",
              );
              const streamedTextDigest = nullableBytes(
                row,
                "shadow_streamed_text_digest",
              );
              if (
                startDigest === null
                || terminalDigest === null
                || streamedTextDigest === null
              ) return Object.freeze({ status: "conflict" as const });
              expectedTerminals.push(Object.freeze({
                transcriptOrdinal: ordinal,
                streamId,
                streamStartDigest: startDigest,
                terminalFrameDigest: terminalDigest,
                streamedTextDigest,
                finalPayloadDigest: ordinaryDigest.slice(),
              }));
            }
          } finally {
            ordinary?.fill(0);
            dtoBytes.fill(0);
            ordinaryDigest.fill(0);
            dtoDigest.fill(0);
          }
        }
        if (
          (verification.status === "matched" && expectedTerminals.length < 1)
          || expectedTerminals.length !== verification.streamTerminals.length
        ) {
          return Object.freeze({ status: "conflict" as const });
        }
        for (let index = 0; index < expectedTerminals.length; index += 1) {
          const expected = expectedTerminals[index]!;
          const actual = verification.streamTerminals[index]!;
          if (
            actual.transcriptOrdinal !== expected.transcriptOrdinal
            || actual.streamId !== expected.streamId
            || !equal(actual.streamStartDigest, expected.streamStartDigest)
            || !equal(actual.terminalFrameDigest, expected.terminalFrameDigest)
            || !equal(actual.streamedTextDigest, expected.streamedTextDigest)
            || !equal(actual.finalPayloadDigest, expected.finalPayloadDigest)
          ) return Object.freeze({ status: "conflict" as const });
        }
        if (verification.status === "matched") {
          const storedFinal = bytes(turn, "final_causal_event_digest");
          try {
            if (finalDigest === null || !equal(storedFinal, finalDigest)) {
              return Object.freeze({ status: "conflict" as const });
            }
          } finally {
            storedFinal.fill(0);
          }
        }
      } finally {
        finalDigest?.fill(0);
        expectedTerminals.forEach((entry) => {
          entry.streamStartDigest.fill(0);
          entry.terminalFrameDigest.fill(0);
          entry.streamedTextDigest.fill(0);
          entry.finalPayloadDigest.fill(0);
        });
      }

      const verificationDigest = dependencies.crypto.hash(
        input.verificationBytes,
      );
      try {
        const state = text(turn, "state");
        const existingDigest = nullableBytes(turn, "client_verification_digest");
        try {
          if (state === "client_verified" || state === "failed") {
            return Object.freeze({
              status: existingDigest !== null
                  && equal(existingDigest, verificationDigest)
                ? "replayed" as const
                : "conflict" as const,
              ...(existingDigest !== null
                  && equal(existingDigest, verificationDigest)
                ? { operationId: input.operationId }
                : {}),
            }) as LiveShadowClientVerificationResult;
          }
          if (
            existingDigest !== null
            || (verification.status === "matched"
              ? state !== "completed"
              : !["human_verified", "running", "completed"]
                .includes(state))
          ) {
            return Object.freeze({ status: "conflict" as const });
          }
        } finally {
          existingDigest?.fill(0);
        }
        const updated = verification.status === "matched"
          ? await transaction.query(
            `/* m282_live_shadow_client_verification_commit */
           UPDATE conversation_shadow_turn_operations
              SET state = 'client_verified', client_verification_digest = $2,
                  updated_at = $3
            WHERE operation_id = $1 AND state = 'completed'
              AND client_verification_digest IS NULL
          RETURNING operation_id`,
            [input.operationId, verificationDigest, new Date(input.now)],
          )
          : await transaction.query(
            `/* m282_live_shadow_client_verification_failed */
             UPDATE conversation_shadow_turn_operations
                SET state = 'failed', client_verification_digest = $2,
                    terminal_stage = $3, terminal_reason = $4,
                    terminal_at = $5, updated_at = $5
              WHERE operation_id = $1
                AND state in ('human_verified', 'running', 'completed')
                AND client_verification_digest IS NULL
            RETURNING operation_id`,
            [
              input.operationId,
              verificationDigest,
              failedStage(verification.closedStage),
              failedReason(verification.reason),
              new Date(input.now),
            ],
          );
        return updated.length === 1
          ? Object.freeze({
            status: "verified" as const,
            operationId: input.operationId,
          })
          : Object.freeze({ status: "conflict" as const });
      } finally {
        verificationDigest.fill(0);
      }
    } finally {
      destroyVerification(verification);
    }
  }, { isolationLevel: "read committed" });
}

/** Return durable transcript siblings for Browser reconnect; never stream frames. */
export async function recoverPostgresLiveShadowTurn(
  dependencies: Readonly<{
    product: PostgresJsBridgeConnection;
    storage: Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
  }>,
  input: Readonly<{
    authority: Readonly<{ userId: string; humanActorId: string }>;
    roomId: string;
    operationId: string;
  }>,
): Promise<LiveShadowTurnRecoveryResult> {
  const turn = one(await dependencies.product.query(
    `/* m282_live_shadow_recovery_turn */
     SELECT t.*, p.mode, p.revision AS current_policy_revision,
            s.owner_id::text AS owner_id,
            actor.id::text AS human_actor_id
       FROM conversation_shadow_turn_operations t
       JOIN encryption_transition_policy p ON p.id = 'server'
       JOIN sessions s ON s.id = t.session_id
       JOIN actors actor
         ON actor.kind = 'user' AND actor.owner_id = s.owner_id
      WHERE t.operation_id = $1 AND t.room_id = $2::uuid
      LIMIT 2`,
    [input.operationId, input.roomId],
  ));
  if (turn === null) return Object.freeze({ status: "absent" as const });
  if (
    text(turn, "owner_id") !== input.authority.userId
    || text(turn, "human_actor_id") !== input.authority.humanActorId
  ) return Object.freeze({ status: "absent" as const });
  const full = text(turn, "mode") === "encrypted_only";
  if (
    !["shadow_encryption", "encrypted_only"].includes(text(turn, "mode"))
    || counter(turn, "current_policy_revision", 1) !== counter(turn, "policy_revision", 1)
  ) return Object.freeze({ status: "absent" as const });

  const state = text(turn, "state");
  const jobId = nullableText(turn, "job_id");
  const rows = await dependencies.product.query(
    `/* m282_live_shadow_recovery_transcript */
     SELECT l.message_id, l.edit_revision, l.crypto_object_id,
            l.shadow_transcript_ordinal, l.shadow_durable_event_digest,
            l.completion, l.disposition, l.parity_status, l.author_role,
            l.representation_mode, l.publication_policy_revision,
            sm.role, ${full ? "NULL::text AS content, NULL::text AS tool_calls, NULL::text AS tool_name" : "sm.content, sm.tool_calls, sm.tool_name"}, sm.created_at,
            sm.crypto_object_id AS mapped_object_id
       FROM session_message_crypto_revisions l
       JOIN session_messages sm
         ON sm.session_id = l.session_id
        AND sm.id = l.message_id
        AND sm.edit_revision = l.edit_revision
      WHERE l.shadow_operation_id = $1
      ORDER BY l.shadow_transcript_ordinal
      LIMIT ${MAX_TRANSCRIPT + 1}`,
    [input.operationId],
  );
  if (rows.length > MAX_TRANSCRIPT) {
    return Object.freeze({
      status: "fallback" as const,
      state: "failed" as const,
      jobId,
      reason: "integrity_failure",
    });
  }
  let human: ReturnType<typeof parseProtectedMessageDtoV2> | undefined;
  const durableEvents: Array<ShadowDurableRecoveryEvent | FullDurableRecoveryEvent> = [];
  try {
    const callIds = full ? new Map<number, string>() : resolveLiveShadowToolResultCallIds(rows);
    for (const row of rows) {
      const ordinal = counter(row, "shadow_transcript_ordinal", 1);
      if (
        counter(row, "edit_revision") !== 0
        || text(row, "completion") !== "complete"
        || text(row, "disposition") !== "mapped"
        || text(row, "mapped_object_id") !== text(row, "crypto_object_id")
        || text(row, "representation_mode") !== (full ? "full_encryption" : "shadow_encryption")
        || (full && counter(row, "publication_policy_revision", 1) !== counter(turn, "policy_revision", 1))
        || text(row, "parity_status") !== (full
          ? (ordinal === 1 ? "client_authenticated" : "server_authenticated")
          : (ordinal === 1 ? "client_verified" : "server_verified"))
      ) throw new TypeError("Live Shadow recovery transcript is incomplete");
      const dto = await protectedDto({
        storage: dependencies.storage,
        row,
        sessionId: text(turn, "session_id"),
        roomId: input.roomId,
        namespaceId: text(turn, "namespace_id"),
        agentId: text(turn, "agent_id"),
      });
      if (ordinal === 1) {
        if (text(row, "role") !== "user" || human !== undefined) {
          throw new TypeError("Live Shadow recovery Human row is invalid");
        }
        human = dto;
        continue;
      }
      const ordinary = full ? null : encodeLiveShadowOrdinaryPayloadV2(
        row,
        callIds.get(ordinal) ?? null,
      );
      const eventDigest = bytes(row, "shadow_durable_event_digest");
      try {
        const common = {
          type: "message.shadow_durable" as const,
          laneKey: `room:${input.roomId}`,
          operationId: input.operationId,
          policyRevision: counter(turn, "policy_revision", 1),
          transcriptOrdinal: ordinal,
          protectedMessage: dto,
          durableEventDigestBase64url: encoded(eventDigest),
        };
        durableEvents.push(full
          ? Object.freeze({ ...common, wireVersion: 2 as const })
          : Object.freeze({ ...common, wireVersion: 1 as const,
              ordinaryPayloadBytesBase64url: encoded(ordinary!) }));
      } finally {
        ordinary?.fill(0);
        eventDigest.fill(0);
      }
    }
  } catch {
    return Object.freeze({
      status: "fallback" as const,
      state: "failed" as const,
      jobId,
      reason: "integrity_failure",
    });
  }

  if (state === "planned" || state === "human_verified" || state === "running") {
    return Object.freeze({
      status: "pending" as const,
      state,
      jobId,
      ...(human === undefined ? {} : { human }),
    });
  }
  if (state === "completed" || state === "client_verified") {
    if (jobId === null || human === undefined || durableEvents.length === 0) {
      return Object.freeze({
        status: "fallback" as const,
        state: "failed" as const,
        jobId,
        reason: "integrity_failure",
      });
    }
    return Object.freeze({
      status: "completed" as const,
      state,
      jobId,
      human,
      durableEvents: Object.freeze(durableEvents),
    });
  }
  return Object.freeze({
    status: "fallback" as const,
    state: state === "failed" ? "failed" as const : "fallback" as const,
    jobId,
    reason: nullableText(turn, "terminal_reason") ?? "protected_unavailable",
    ...(human === undefined ? {} : { human }),
  });
}
