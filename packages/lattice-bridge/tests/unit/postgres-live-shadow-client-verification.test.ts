import { describe, expect, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeRow,
} from "@nautilo/db";
import {
  LatticeCrypto,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  prepareHumanLiveShadowClientVerification,
  unixTimestamp,
  type LatticeStorage,
} from "@nautilo/lattice-crypto";
import { seededRng } from "@nautilo/lattice-crypto/testing";
import {
  encodeProtectedMessageDtoV2,
  parseProtectedMessageDtoV2,
} from "@nautilo/types";

import { encodeMessagePayloadV2 } from
  "../../src/message/message-payload-v2.ts";
import { liveShadowDurableEventDigestV1 } from
  "../../src/message/live-shadow-realtime-evidence.ts";
import {
  createLiveShadowToolResultCallIdResolver,
  resolveRoomHistoryReaderSigningPublicKey,
  resolveLiveShadowToolResultCallIds,
  verifyAndRecordLiveShadowClientVerification,
} from
  "../../src/server/message/postgres-live-shadow-client-verification.ts";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ROOM_ID = "22222222-2222-4222-8222-222222222222";
const NAMESPACE_ID = "33333333-3333-4333-8333-333333333333";
const AGENT_ID = "44444444-4444-4444-8444-444444444444";
const USER_ID = "55555555-5555-4555-8555-555555555555";
const HUMAN_ID = "66666666-6666-4666-8666-666666666666";
const OPERATION_ID = "operation-live-verification";
const DEVICE_ID = "device-live-verification";
const NOW = 1_800_000_000_000;

describe("durable tool result correlation", () => {
  const call = (args: object = {}) => ({
    role: "assistant", session_id: "session-A",
    tool_calls: JSON.stringify([{ id: "call-1", name: "search", args }]),
  });
  const result = { role: "tool", session_id: "session-A", tool_name: "search" };

  test("deduplicates only identical pending calls and permits ID reuse after consumption", () => {
    expect([...resolveLiveShadowToolResultCallIds([
      call(), call(), result, call(), result,
    ])]).toEqual([[3, "call-1"], [5, "call-1"]]);
  });

  test("rejects contradictory pending call IDs", () => {
    expect(() => resolveLiveShadowToolResultCallIds([
      call({ query: "one" }), call({ query: "two" }), result,
    ])).toThrow("pending tool call conflicts");
  });

  test("correlates exact projection checkpoint redaction only in verified resume context", () => {
    const projection = (args: object) => ({ ...call(), tool_calls: JSON.stringify([
      { id: "call-1", name: "share_memory", args },
    ]) });
    const original = projection({ mode: "project", proposed_content: "synthetic proposal" });
    const redacted = projection({ mode: "project" });
    const toolResult = { ...result, tool_name: "share_memory" };
    const resolver = createLiveShadowToolResultCallIdResolver();
    resolver.consume([original]);
    expect([...resolver.consume([redacted], {
      allowProjectionCheckpointRedaction: true,
    })]).toEqual([]);
    expect([...resolver.consume([redacted, toolResult], {
      allowProjectionCheckpointRedaction: true,
    })]).toEqual([[4, "call-1"]]);
    expect([...resolver.consume([original, toolResult])]).toEqual([[6, "call-1"]]);
    expect(() => resolveLiveShadowToolResultCallIds([original, redacted, toolResult]))
      .toThrow("pending tool call conflicts");
  });

  test.each(["changed_proposal", "extra_field", "different_tool", "top_level_field", "attach", "reverse"] as const)(
    "rejects a non-redaction projection repeat in verified resume context: %s", (scenario) => {
      const projection = (args: object, name = "share_memory") => ({ ...call(), tool_calls: JSON.stringify([
        { id: "call-1", name, args },
      ]) });
      const originalArgs = scenario === "attach" ? { mode: "attach" }
        : scenario === "reverse" ? { mode: "project" }
        : { mode: "project", proposed_content: "original" };
      const repeatedArgs = scenario === "changed_proposal" || scenario === "reverse"
        ? { mode: "project", proposed_content: "different" }
        : scenario === "extra_field" ? { mode: "project", extra: true }
        : { mode: "project" };
      const resolver = createLiveShadowToolResultCallIdResolver();
      resolver.consume([projection(originalArgs)]);
      const repeated = scenario === "top_level_field"
        ? { ...call(), tool_calls: JSON.stringify([
            { id: "call-1", name: "share_memory", args: repeatedArgs, type: "changed" },
          ]) }
        : projection(repeatedArgs, scenario === "different_tool" ? "other_tool" : "share_memory");
      expect(() => resolver.consume([
        repeated,
      ], { allowProjectionCheckpointRedaction: true })).toThrow("pending tool call conflicts");
    },
  );

  test("does not pair a result with another Session's call or invent a clipped call ID", () => {
    expect(() => resolveLiveShadowToolResultCallIds([
      call(), { ...result, session_id: "session-B" },
    ])).toThrow("tool result is unpaired");
    expect(() => resolveLiveShadowToolResultCallIds([result]))
      .toThrow("tool result is unpaired");
  });

  test("retains FIFO correlation across bounded pages and returns global ordinals", () => {
    const resolver = createLiveShadowToolResultCallIdResolver();
    expect([...resolver.consume([{
      role: "assistant", session_id: "session-A",
      tool_calls: JSON.stringify([
        { id: "call-1", name: "search", args: { query: "one" } },
        { id: "call-2", name: "search", args: { query: "two" } },
      ]),
    }])]).toEqual([]);
    expect([...resolver.consume([result, result])]).toEqual([
      [2, "call-1"],
      [3, "call-2"],
    ]);
  });

  test("deduplicates a pending call repeated on another page", () => {
    const resolver = createLiveShadowToolResultCallIdResolver();
    expect([...resolver.consume([call()])]).toEqual([]);
    expect([...resolver.consume([call()])]).toEqual([]);
    expect([...resolver.consume([result])]).toEqual([[3, "call-1"]]);
  });

  test("rejects a conflicting pending call repeated on another page", () => {
    const resolver = createLiveShadowToolResultCallIdResolver();
    expect([...resolver.consume([call({ query: "one" })])]).toEqual([]);
    expect(() => resolver.consume([call({ query: "two" })]))
      .toThrow("pending tool call conflicts");
  });

  test("keeps sessions independent across pages", () => {
    const resolver = createLiveShadowToolResultCallIdResolver();
    const sessionBCall = {
      role: "assistant", session_id: "session-B",
      tool_calls: JSON.stringify([{
        id: "call-B", name: "search", args: { query: "other" },
      }]),
    };
    expect([...resolver.consume([call(), sessionBCall])]).toEqual([]);
    expect([...resolver.consume([
      { ...result, session_id: "session-B" }, result,
    ])]).toEqual([
      [3, "call-B"],
      [4, "call-1"],
    ]);
  });

  test("uses global ordinals when an opaque boundary clears pending correlation", () => {
    const unpaired: number[] = [];
    const resolver = createLiveShadowToolResultCallIdResolver({
      opaqueBodylessRows: true,
      onUnpairedToolResult: (ordinal) => unpaired.push(ordinal),
    });
    expect([...resolver.consume([{ ...call(), content: "" }])]).toEqual([]);
    expect([...resolver.consume([{
      role: "assistant", session_id: "session-A", content: null,
      tool_calls: null,
    }])]).toEqual([]);
    expect([...resolver.consume([{ ...result, content: "tool result" }])])
      .toEqual([]);
    expect(unpaired).toEqual([3]);
  });
});

class ProductConnection implements PostgresJsBridgeConnection {
  state = "completed";
  verificationDigest: Uint8Array | null = null;
  terminalStage: string | null = null;
  terminalReason: string | null = null;

  constructor(
    readonly turn: PostgresJsBridgeRow,
    readonly transcript: readonly PostgresJsBridgeRow[],
  ) {}

  query<Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("m282_live_shadow_client_verification_turn")) {
      return Promise.resolve([{
        ...this.turn,
        state: this.state,
        client_verification_digest: this.verificationDigest,
      }] as unknown as Row[]);
    }
    if (statement.includes("m282_live_shadow_client_verification_transcript")) {
      return Promise.resolve(this.transcript as readonly Row[]);
    }
    if (statement.includes("m282_live_shadow_client_verification_commit")) {
      if (this.state !== "completed" || this.verificationDigest !== null) {
        return Promise.resolve([]);
      }
      this.state = "client_verified";
      this.verificationDigest = (parameters[1] as Uint8Array).slice();
      return Promise.resolve(
        [{ operation_id: OPERATION_ID }] as unknown as Row[],
      );
    }
    if (statement.includes("m282_live_shadow_client_verification_failed")) {
      if (
        !["human_verified", "running", "completed"]
          .includes(this.state)
        || this.verificationDigest !== null
      ) return Promise.resolve([]);
      this.state = "failed";
      this.verificationDigest = (parameters[1] as Uint8Array).slice();
      this.terminalStage = parameters[2] as string;
      this.terminalReason = parameters[3] as string;
      return Promise.resolve(
        [{ operation_id: OPERATION_ID }] as unknown as Row[],
      );
    }
    throw new Error(`Unexpected product query: ${statement}`);
  }

  transaction<Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }

  transactionOnce<Result>(
    callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function protectedDto(input: Readonly<{
  messageId: number;
  role: "user" | "assistant" | "tool";
  createdAt: Date;
  cryptoObjectId: string;
  payloadBytes: Uint8Array;
  manifestBytes: Uint8Array;
  envelopeBytes: Uint8Array;
}>) {
  return parseProtectedMessageDtoV2({
    dtoVersion: 2,
    projection: {
      messageId: String(input.messageId),
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      role: input.role,
      createdAt: input.createdAt.toISOString(),
      editRevision: 0,
      ...(input.role === "user" ? {} : { authorAgentId: AGENT_ID }),
    },
    protectedPayload: {
      status: "encrypted",
      cryptoObjectId: input.cryptoObjectId,
      payloadVersion: 2,
      keyClass: "ai",
      encryptedPayloadBytesBase64url:
        Buffer.from(input.payloadBytes).toString("base64url"),
      accessManifestBytesBase64url:
        Buffer.from(input.manifestBytes).toString("base64url"),
      namespaceEnvelopeBytesBase64url:
        Buffer.from(input.envelopeBytes).toString("base64url"),
    },
  });
}

describe("Postgres live Shadow client verification", () => {
  test("closes one exact streamed turn and replays only the same signed receipt", async () => {
    const crypto = new LatticeCrypto(seededRng(282_901));
    const signing = crypto.generateSigningKeyPair();
    const createdAt = new Date(NOW - 1_000);
    const streamStartDigest = new Uint8Array(32).fill(0x31);
    const terminalFrameDigest = new Uint8Array(32).fill(0x32);
    const streamedTextDigest = new Uint8Array(32).fill(0x33);
    const records: Array<{
      messageId: number;
      role: "user" | "assistant" | "tool";
      content: string;
      cryptoObjectId: string;
      payloadBytes: Uint8Array;
      manifestBytes: Uint8Array;
      envelopeBytes: Uint8Array;
      toolCalls?: readonly [{
        id: string;
        name: string;
        args: Readonly<Record<string, string>>;
      }];
      toolName?: string;
      toolCallId?: string;
    }> = [
      {
        messageId: 91,
        role: "user" as const,
        content: "hello",
        cryptoObjectId: "message:live-shadow:v1:human",
        payloadBytes: new Uint8Array([1, 2, 3]),
        manifestBytes: new Uint8Array([4, 5, 6]),
        envelopeBytes: new Uint8Array([7, 8, 9]),
      },
      {
        messageId: 92,
        role: "assistant" as const,
        content: "",
        toolCalls: [{
          id: "call-live-verification",
          name: "get_current_time",
          args: { timezone: "UTC" },
        }],
        cryptoObjectId: "message:live-shadow:v1:tool-call",
        payloadBytes: new Uint8Array([11, 12, 13]),
        manifestBytes: new Uint8Array([14, 15, 16]),
        envelopeBytes: new Uint8Array([17, 18, 19]),
      },
      {
        messageId: 93,
        role: "tool" as const,
        content: "12:00 UTC",
        toolName: "get_current_time",
        toolCallId: "call-live-verification",
        cryptoObjectId: "message:live-shadow:v1:tool-result",
        payloadBytes: new Uint8Array([21, 22, 23]),
        manifestBytes: new Uint8Array([24, 25, 26]),
        envelopeBytes: new Uint8Array([27, 28, 29]),
      },
      {
        messageId: 94,
        role: "assistant" as const,
        content: "hi there",
        cryptoObjectId: "message:live-shadow:v1:assistant",
        payloadBytes: new Uint8Array([31, 32, 33]),
        manifestBytes: new Uint8Array([34, 35, 36]),
        envelopeBytes: new Uint8Array([37, 38, 39]),
      },
    ];
    const ordinaryBytes = records.map((record) => encodeMessagePayloadV2({
      role: record.role,
      content: record.content,
      ...(record.toolCalls === undefined ? {} : { toolCalls: record.toolCalls }),
      ...(record.toolName === undefined ? {} : { toolName: record.toolName }),
      ...(record.toolCallId === undefined
        ? {}
        : { sensitiveMetadata: { toolCallId: record.toolCallId } }),
    }));
    const protectedDtos = records.map((record) => protectedDto({
      ...record,
      createdAt,
    }));
    const protectedBytes = protectedDtos.map((dto) =>
      new TextEncoder().encode(encodeProtectedMessageDtoV2(dto))
    );
    const durableEventDigests = records.map((_, index) => index === 0
      ? null
      : liveShadowDurableEventDigestV1(crypto, {
        operationId: OPERATION_ID,
        policyRevision: 7,
        transcriptOrdinal: index + 1,
        ordinaryPayloadBytes: ordinaryBytes[index]!,
        protectedMessage: protectedDtos[index]!,
      }));
    const finalEventDigest = durableEventDigests.at(-1)!;
    const transcript: PostgresJsBridgeRow[] = records.map((record, index) => ({
      message_id: record.messageId,
      edit_revision: 0,
      crypto_object_id: record.cryptoObjectId,
      shadow_transcript_ordinal: index + 1,
      shadow_stream_id: index === records.length - 1
        ? "stream-live-verification"
        : null,
      shadow_stream_start_digest: index === records.length - 1
        ? streamStartDigest
        : null,
      shadow_stream_terminal_digest: index === records.length - 1
        ? terminalFrameDigest
        : null,
      shadow_streamed_text_digest: index === records.length - 1
        ? streamedTextDigest
        : null,
      shadow_durable_event_digest: index === 0
        ? null
        : durableEventDigests[index]!,
      completion: "complete",
      disposition: "mapped",
      parity_status: index === 0 ? "client_verified" : "server_verified",
      representation_mode: "shadow_encryption",
      publication_policy_revision: null,
      author_role: record.role,
      role: record.role,
      content: record.content,
      tool_calls: record.toolCalls === undefined
        ? null
        : JSON.stringify(record.toolCalls),
      tool_name: record.toolName ?? null,
      // postgres-js direct connections expose timestamptz as ISO text in
      // production even though several unit executors use Date instances.
      created_at: createdAt.toISOString(),
      mapped_object_id: record.cryptoObjectId,
    }));
    const turn: PostgresJsBridgeRow = {
      operation_id: OPERATION_ID,
      policy_revision: 7,
      current_policy_revision: 7,
      mode: "shadow_encryption",
      session_id: SESSION_ID,
      room_id: ROOM_ID,
      namespace_id: NAMESPACE_ID,
      agent_id: AGENT_ID,
      owner_id: USER_ID,
      human_actor_id: HUMAN_ID,
      subject_human_id: HUMAN_ID,
      committer_device_id: DEVICE_ID,
      host_authorization_revision: 3,
      final_causal_event_digest: finalEventDigest,
      client_verification_digest: null,
      state: "completed",
    };
    const product = new ProductConnection(turn, transcript);
    const restricted: PostgresJsBridgeConnection = {
      query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>() =>
        Promise.resolve([{
          human_id: HUMAN_ID,
          device_revision: 3,
          signing_public_key: signing.publicKey,
          device_state: "active",
          custody_state: "active",
        }] as unknown as Row[]),
      transaction: (callback) => callback(restricted),
      transactionOnce: (callback) => callback(restricted),
    };
    const byObject = new Map(records.map((record) => [
      record.cryptoObjectId,
      record,
    ]));
    const storage = {
      getObject: (id: string) => {
        const record = byObject.get(id);
        return Promise.resolve(record === undefined ? null : {
          objectId: id,
          payloadBytes: record.payloadBytes.slice(),
        });
      },
      getObjectAccessState: (id: string) => {
        const record = byObject.get(id);
        return Promise.resolve(record === undefined ? null : {
          head: {
            objectId: id,
            accessRevision: 0,
            manifestHash: crypto.hash(record.manifestBytes),
            manifestBytes: record.manifestBytes.slice(),
          },
          namespaceEnvelopes: [{
            namespaceId: NAMESPACE_ID,
            envelopeHash: crypto.hash(record.envelopeBytes),
            envelopeBytes: record.envelopeBytes.slice(),
          }],
        });
      },
    } satisfies Pick<LatticeStorage, "getObject" | "getObjectAccessState">;
    const prepared = prepareHumanLiveShadowClientVerification(crypto, {
      subjectHumanId: humanId(HUMAN_ID),
      operationId: OPERATION_ID,
      policyRevision: 7,
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      status: "matched",
      transcript: records.map((record, index) => ({
        transcriptOrdinal: index + 1,
        messageId: record.messageId,
        revision: 0 as const,
        authorRole: record.role === "user" ? "human" as const : record.role,
        cryptoObjectId: objectId(record.cryptoObjectId),
        ordinaryPayloadDigest: crypto.hash(ordinaryBytes[index]!),
        protectedDtoDigest: crypto.hash(protectedBytes[index]!),
      })),
      streamTerminals: [{
        transcriptOrdinal: records.length,
        streamId: "stream-live-verification",
        streamStartDigest,
        terminalFrameDigest,
        streamedTextDigest,
        finalPayloadDigest: crypto.hash(ordinaryBytes.at(-1)!),
      }],
      closedStage: "browser_open",
      reason: "none",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
      hostAuthorizationRevision: authorizationRevision(3),
      committerSigningPublicKey: signing.publicKey,
      committerSigningPrivateKey: signing.privateKey,
    });
    const dependencies = { product, restricted, storage, crypto };
    const input = {
      authority: { userId: USER_ID, humanActorId: HUMAN_ID },
      roomId: ROOM_ID,
      operationId: OPERATION_ID,
      verificationBytes: prepared.bytes,
      now: NOW + 1,
    };

    expect(await verifyAndRecordLiveShadowClientVerification(
      dependencies,
      input,
    )).toEqual({ status: "verified", operationId: OPERATION_ID });
    expect(await verifyAndRecordLiveShadowClientVerification(
      dependencies,
      input,
    )).toEqual({ status: "replayed", operationId: OPERATION_ID });

    const changed = prepared.bytes.slice();
    changed[changed.length - 1] = (changed[changed.length - 1] ?? 0) ^ 1;
    expect(await verifyAndRecordLiveShadowClientVerification(dependencies, {
      ...input,
      verificationBytes: changed,
    })).toEqual({ status: "conflict" });

    const failedProduct = new ProductConnection(turn, transcript);
    const failedReceipt = prepareHumanLiveShadowClientVerification(crypto, {
      subjectHumanId: humanId(HUMAN_ID),
      operationId: OPERATION_ID,
      policyRevision: 7,
      sessionId: SESSION_ID,
      roomId: ROOM_ID,
      status: "failed",
      transcript: [{
        transcriptOrdinal: 1,
        messageId: records[0]!.messageId,
        revision: 0,
        authorRole: "human",
        cryptoObjectId: objectId(records[0]!.cryptoObjectId),
        ordinaryPayloadDigest: crypto.hash(ordinaryBytes[0]!),
        protectedDtoDigest: crypto.hash(protectedBytes[0]!),
      }],
      streamTerminals: [],
      closedStage: "assistant_stream",
      reason: "parity_mismatch",
      issuedAt: unixTimestamp(NOW),
      deadlineAt: unixTimestamp(NOW + 30_000),
      committerDeviceId: cryptoDeviceId(DEVICE_ID),
      hostAuthorizationRevision: authorizationRevision(3),
      committerSigningPublicKey: signing.publicKey,
      committerSigningPrivateKey: signing.privateKey,
    });
    const failedInput = {
      ...input,
      verificationBytes: failedReceipt.bytes,
    };
    expect(await verifyAndRecordLiveShadowClientVerification({
      ...dependencies,
      product: failedProduct,
    }, failedInput)).toEqual({ status: "verified", operationId: OPERATION_ID });
    expect(await verifyAndRecordLiveShadowClientVerification({
      ...dependencies,
      product: failedProduct,
    }, failedInput)).toEqual({ status: "replayed", operationId: OPERATION_ID });
    expect({
      state: failedProduct.state,
      stage: failedProduct.terminalStage,
      reason: failedProduct.terminalReason,
    }).toEqual({
      state: "failed",
      stage: "assistant_stream",
      reason: "parity_mismatch",
    });

    prepared.bytes.fill(0);
    prepared.verificationDigest.fill(0);
    prepared.verification.signature.fill(0);
    failedReceipt.bytes.fill(0);
    failedReceipt.verificationDigest.fill(0);
    failedReceipt.verification.transcript.forEach((entry) => {
      entry.ordinaryPayloadDigest.fill(0);
      entry.protectedDtoDigest.fill(0);
    });
    failedReceipt.verification.signature.fill(0);
    signing.publicKey.fill(0);
    signing.privateKey.fill(0);
    ordinaryBytes.forEach((value) => value.fill(0));
    protectedBytes.forEach((value) => value.fill(0));
    finalEventDigest.fill(0);
  });
});

describe("Room history reader signing authority", () => {
  test("returns an owned key only for the exact active device and custody", async () => {
    const stored = new Uint8Array(32).fill(7);
    let statement = "";
    let parameters: readonly unknown[] = [];
    const restricted: PostgresJsBridgeConnection = {
      query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
        sql: string,
        values: readonly unknown[] = [],
      ) => {
        statement = sql;
        parameters = values;
        return Promise.resolve([{
          signing_public_key: stored,
        }] as unknown as readonly Row[]);
      },
      transaction: (work) => work(restricted),
      transactionOnce: (work) => work(restricted),
    };

    const resolved = await resolveRoomHistoryReaderSigningPublicKey(
      restricted,
      {
        subjectUserId: USER_ID,
        subjectHumanId: HUMAN_ID,
        readerDeviceId: DEVICE_ID,
        readerDeviceSigningKeyGeneration: 2,
        hostAuthorizationRevision: 3,
      },
    );

    expect(statement).toContain("device.state = 'active'");
    expect(statement).toContain("custody.state = 'active'");
    expect(parameters).toEqual([
      HUMAN_ID,
      USER_ID,
      HUMAN_ID,
      DEVICE_ID,
      2,
      3,
    ]);
    expect(resolved).toEqual(stored);
    expect(resolved).not.toBe(stored);
    resolved?.fill(0);
    expect(stored).toEqual(new Uint8Array(32).fill(7));
  });

  test("rejects ambiguous device rows", async () => {
    const restricted: PostgresJsBridgeConnection = {
      query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>() =>
        Promise.resolve([
          { signing_public_key: new Uint8Array(32) },
          { signing_public_key: new Uint8Array(32) },
        ] as unknown as readonly Row[]),
      transaction: (work) => work(restricted),
      transactionOnce: (work) => work(restricted),
    };
    expect(await resolveRoomHistoryReaderSigningPublicKey(restricted, {
      subjectUserId: USER_ID,
      subjectHumanId: HUMAN_ID,
      readerDeviceId: DEVICE_ID,
      readerDeviceSigningKeyGeneration: 2,
      hostAuthorizationRevision: 3,
    })).toBeNull();
  });
});
