import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptedObjectWriteRecord,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareObjectAccessManifestGenesis,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type ResolveCurrentObjectAccessGenesisAuthorization,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createPreparedConversationCryptoRevision,
  deriveMessageCryptoObjectIdV2,
  encodeMessagePayloadV2,
  readPreparedConversationCryptoRevision,
  type ConversationCryptoRevisionSnapshot,
  type PreparedConversationCryptoRevision,
} from "../../src/index.ts";
import {
  ConversationCryptoCompletionConflictError,
  createPostgresConversationCryptoCompletion,
  type ResolveHistoricalHumanObjectAccessGenesisSigner,
} from "../../src/server/storage/postgres-conversation-crypto-completion.ts";
import {
  PostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../../src/server/storage/postgres-lattice-storage.ts";

const SESSION_ID = "30000000-0000-4000-8000-000000000001";

type StoredObject = Readonly<{
  objectId: string;
  payloadHash: Uint8Array;
  payloadBytes: Uint8Array;
}>;

type StoredAccess = Readonly<{
  objectId: string;
  accessRevision: number;
  manifestHash: Uint8Array;
  previousManifestHash: Uint8Array | null;
  payloadHash: Uint8Array;
  manifestBytes: Uint8Array;
  envelopes: readonly Readonly<{
    namespaceId: string;
    envelopeHash: Uint8Array;
    envelopeBytes: Uint8Array;
  }>[];
}>;

type DurableState = {
  object: StoredObject | null;
  access: StoredAccess | null;
};

function copyBytes(value: Uint8Array): Uint8Array {
  return value.slice();
}

function cloneState(state: DurableState): DurableState {
  return {
    object: state.object === null
      ? null
      : {
        ...state.object,
        payloadHash: copyBytes(state.object.payloadHash),
        payloadBytes: copyBytes(state.object.payloadBytes),
      },
    access: state.access === null
      ? null
      : {
        ...state.access,
        manifestHash: copyBytes(state.access.manifestHash),
        previousManifestHash:
          state.access.previousManifestHash?.slice() ?? null,
        payloadHash: copyBytes(state.access.payloadHash),
        manifestBytes: copyBytes(state.access.manifestBytes),
        envelopes: state.access.envelopes.map((envelope) => ({
          ...envelope,
          envelopeHash: copyBytes(envelope.envelopeHash),
          envelopeBytes: copyBytes(envelope.envelopeBytes),
        })),
      },
  };
}

function sha256(value: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

class StatefulCryptoConnection implements CryptoPostgresConnection {
  state: DurableState = { object: null, access: null };
  readonly statements: string[] = [];
  transactionCount = 0;
  failInsertTable: string | null = null;
  loseInsertResponseTable: string | null = null;
  loseNextCommitResponse = false;

  query<Row>(
    statement: string,
    _parameters: readonly never[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    throw new Error("Queries must run through the transaction executor");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    const working = cloneState(this.state);
    const manifestDraft: {
      row: Omit<StoredAccess, "envelopes"> | null;
      envelopes: StoredAccess["envelopes"];
    } = { row: null, envelopes: [] };
    const transaction: CryptoPostgresExecutor = {
      query: async <Row>(
        statement: string,
        parameters: readonly unknown[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = statement.replaceAll('"', "").toLowerCase();
        for (
          const forbidden of [
            "session_messages",
            "session_message_crypto_revisions",
            "rooms",
            "sessions",
          ]
        ) {
          if (statement.includes(forbidden)) {
            throw new Error(`forbidden product SQL: ${forbidden}`);
          }
        }
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from crypto_objects")) {
          if (working.object === null) return [];
          return [{
            object_id: working.object.objectId,
            payload_hash: copyBytes(working.object.payloadHash),
            payload_bytes: copyBytes(working.object.payloadBytes),
          }] as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          this.#failIfRequested("crypto_objects");
          working.object = {
            objectId: parameters[0] as string,
            payloadHash: copyBytes(parameters[1] as Uint8Array),
            payloadBytes: copyBytes(parameters[2] as Uint8Array),
          };
          this.#loseInsertResponseIfRequested("crypto_objects");
          return [];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          if (working.access === null) return [];
          return [{
            object_id: working.access.objectId,
            access_revision: working.access.accessRevision,
            manifest_hash: copyBytes(working.access.manifestHash),
            previous_manifest_hash:
              working.access.previousManifestHash?.slice() ?? null,
            payload_hash: copyBytes(working.access.payloadHash),
            manifest_bytes: copyBytes(working.access.manifestBytes),
          }] as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          return (working.access?.envelopes ?? []).map((envelope) => ({
            namespace_id: envelope.namespaceId,
            envelope_hash: copyBytes(envelope.envelopeHash),
            envelope_bytes: copyBytes(envelope.envelopeBytes),
          })) as Row[];
        }
        if (normalized.includes(
          "insert into object_crypto_access_manifests",
        )) {
          this.#failIfRequested("object_crypto_access_manifests");
          const manifestBytes = copyBytes(parameters[5] as Uint8Array);
          manifestDraft.row = {
            objectId: parameters[0] as string,
            accessRevision: parameters[1] as number,
            manifestHash: copyBytes(parameters[2] as Uint8Array),
            previousManifestHash:
              (parameters[3] as Uint8Array | null)?.slice() ?? null,
            payloadHash: copyBytes(parameters[4] as Uint8Array),
            manifestBytes,
          };
          this.#loseInsertResponseIfRequested(
            "object_crypto_access_manifests",
          );
          return [];
        }
        if (normalized.includes(
          "insert into object_crypto_namespace_envelopes",
        )) {
          this.#failIfRequested("object_crypto_namespace_envelopes");
          manifestDraft.envelopes = [
            ...manifestDraft.envelopes,
            {
              namespaceId: parameters[2] as string,
              envelopeHash: copyBytes(parameters[4] as Uint8Array),
              envelopeBytes: copyBytes(parameters[5] as Uint8Array),
            },
          ];
          this.#loseInsertResponseIfRequested(
            "object_crypto_namespace_envelopes",
          );
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          this.#failIfRequested("object_crypto_access_heads");
          if (manifestDraft.row === null) {
            throw new Error("access head inserted without manifest");
          }
          working.access = {
            ...manifestDraft.row,
            envelopes: manifestDraft.envelopes,
          };
          this.#loseInsertResponseIfRequested(
            "object_crypto_access_heads",
          );
          return [];
        }
        throw new Error(`Unexpected SQL in crypto completion test: ${
          statement.trim()
        }`);
      },
    };

    const result = await callback(transaction);
    this.state = working;
    if (this.loseNextCommitResponse) {
      this.loseNextCommitResponse = false;
      throw new Error("commit response lost (injected)");
    }
    return result;
  }

  #failIfRequested(table: string): void {
    if (this.failInsertTable === table) {
      this.failInsertTable = null;
      throw new Error(`insert failed for ${table} (injected)`);
    }
  }

  #loseInsertResponseIfRequested(table: string): void {
    if (this.loseInsertResponseTable === table) {
      this.loseInsertResponseTable = null;
      throw new Error(`insert response lost for ${table} (injected)`);
    }
  }
}

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index++) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

function preparedFixture(input: {
  readonly crypto: LatticeCrypto;
  readonly content: string;
  readonly hostRevision?: number;
  readonly registerResolver?: (
    resolver: ResolveCurrentObjectAccessGenesisAuthorization,
  ) => void;
  readonly registerHistoricalSigner?: (
    deviceId: string,
    hostAuthorizationRevision: number,
    publicKey: Uint8Array,
  ) => void;
}): PreparedConversationCryptoRevision {
  const cryptoObjectId = deriveMessageCryptoObjectIdV2({
    sessionId: SESSION_ID,
    messageId: 1,
    revision: 0,
  });
  const encrypted = encryptObjectPayload(
    input.crypto,
    {
      objectId: objectId(cryptoObjectId),
      keyClass: "ai",
      objectType: "nautilo-message-v2",
      createdAt: unixTimestamp(1_800_000_000_000),
    },
    encodeMessagePayloadV2({
      role: "assistant",
      content: input.content,
    }),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelope = wrapObjectDekForNamespace(
    input.crypto,
    new Uint8Array(32).fill(73),
    {
      objectId: objectId(cryptoObjectId),
      namespaceId: namespaceId("namespace-conversation"),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(1),
      bindingRevisionAtWrap: accessRevision(4),
    },
    encrypted.dek,
  );
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const signing = input.crypto.generateSigningKeyPair();
  const hostRevision = input.hostRevision ?? 9;
  const access = prepareObjectAccessManifestGenesis(input.crypto, {
    objectId: objectId(cryptoObjectId),
    payloadHash: input.crypto.hash(payloadBytes),
    envelopeBytes: [envelopeBytes],
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-conversation"),
    hostAuthorizationRevision: authorizationRevision(hostRevision),
    signingPrivateKey: signing.privateKey,
  });
  const resolveCurrentAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorization = (context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision:
        context.hostAuthorizationRevision,
      committerSigningPublicKey: signing.publicKey,
    });
  const snapshot: ConversationCryptoRevisionSnapshot = {
    objectId: cryptoObjectId,
    namespaceId: "namespace-conversation",
    object: encryptedObjectWriteRecord(payloadBytes),
    access,
    resolveCurrentAuthorization,
  };
  input.registerResolver?.(resolveCurrentAuthorization);
  input.registerHistoricalSigner?.(
    "device-conversation",
    hostRevision,
    signing.publicKey,
  );
  return createPreparedConversationCryptoRevision(snapshot);
}

function preparedWithDifferentAccess(
  crypto: LatticeCrypto,
  original: PreparedConversationCryptoRevision,
  registerResolver: (
    resolver: ResolveCurrentObjectAccessGenesisAuthorization,
  ) => void,
): PreparedConversationCryptoRevision {
  const snapshot = readPreparedConversationCryptoRevision(original);
  const signing = crypto.generateSigningKeyPair();
  const access = prepareObjectAccessManifestGenesis(crypto, {
    objectId: objectId(snapshot.objectId),
    payloadHash: crypto.hash(snapshot.object.payloadBytes.ciphertext),
    envelopeBytes: snapshot.access.envelopeBytes,
    sourceAuthorized: true,
    targetAuthorized: true,
    committerDeviceId: cryptoDeviceId("device-conversation"),
    hostAuthorizationRevision: authorizationRevision(10),
    signingPrivateKey: signing.privateKey,
  });
  const resolveCurrentAuthorization:
    ResolveCurrentObjectAccessGenesisAuthorization = (context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision:
        context.hostAuthorizationRevision,
      committerSigningPublicKey: signing.publicKey,
    });
  registerResolver(resolveCurrentAuthorization);
  return createPreparedConversationCryptoRevision({
    ...snapshot,
    access,
    resolveCurrentAuthorization,
  });
}

async function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x237_09) },
    { now: () => 1_800_000_000_000 },
  );
  const connection = new StatefulCryptoConnection();
  const handle = await verifyCryptoPostgresHandle(connection);
  let currentResolver:
    ResolveCurrentObjectAccessGenesisAuthorization | null = null;
  const historicalSigningKeys = new Map<string, Uint8Array>();
  let historicalResolverOverride:
    ResolveHistoricalHumanObjectAccessGenesisSigner | null = null;
  const resolveHistoricalSigner:
    ResolveHistoricalHumanObjectAccessGenesisSigner = (context) => {
      if (historicalResolverOverride !== null) {
        return historicalResolverOverride(context);
      }
      const publicKey = historicalSigningKeys.get(
        `${context.committerDeviceId}:${context.hostAuthorizationRevision}`,
      );
      return publicKey === undefined
        ? null
        : {
          ...context,
          committerSigningPublicKey: publicKey.slice(),
        };
    };
  const adapter = createPostgresConversationCryptoCompletion({
    handle,
    crypto,
    resolveCurrentWriteAuthorization: (context) =>
      currentResolver?.(context) ?? null,
    resolveHistoricalSigner,
  });
  const prepare = (
    input: Omit<
      Parameters<typeof preparedFixture>[0],
      "crypto" | "registerResolver" | "registerHistoricalSigner"
    >,
  ) =>
    preparedFixture({
      ...input,
      crypto,
      registerResolver: (resolver) => {
        currentResolver = resolver;
      },
      registerHistoricalSigner: (
        deviceId,
        hostAuthorizationRevision,
        publicKey,
      ) => {
        historicalSigningKeys.set(
          `${deviceId}:${hostAuthorizationRevision}`,
          publicKey.slice(),
        );
      },
    });
  return {
    crypto,
    connection,
    handle,
    adapter,
    prepare,
    registerResolver: (
      resolver: ResolveCurrentObjectAccessGenesisAuthorization,
    ) => {
      currentResolver = resolver;
    },
    registerHistoricalResolver: (
      resolver: ResolveHistoricalHumanObjectAccessGenesisSigner | null,
    ) => {
      historicalResolverOverride = resolver;
    },
  };
}

describe("Postgres atomic conversation crypto completion", () => {
  test("requires the factory-verified nautilo_crypto handle", async () => {
    const crypto = new LatticeCrypto(
      { bytes: seededRng(1) },
      { now: () => 1_800_000_000_000 },
    );
    expect(() =>
      createPostgresConversationCryptoCompletion({
        handle: new StatefulCryptoConnection() as unknown as
          CryptoPostgresHandle,
        crypto,
        resolveCurrentWriteAuthorization: () => null,
        resolveHistoricalSigner: () => null,
      })
    ).toThrow("verified nautilo_crypto handle");
  });

  test("revokes a retained transaction-scoped handle after the callback", async () => {
    const { handle } = await fixture();
    let retained: CryptoPostgresHandle | null = null;
    await withVerifiedCryptoPostgresTransaction(handle, async (scoped) => {
      retained = scoped;
      expect(() => new PostgresLatticeStorage(scoped)).not.toThrow();
    });

    expect(() =>
      new PostgresLatticeStorage(retained as unknown as CryptoPostgresHandle)
    ).toThrow("verified nautilo_crypto handle");
  });

  test("creates and verifies the complete object/access set atomically", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "created" });

    expect(await adapter.complete(prepared)).toBe("created");
    expect(connection.transactionCount).toBe(1);
    expect(connection.state.object).not.toBeNull();
    expect(connection.state.access).not.toBeNull();
    expect(await adapter.verify(prepared.objectId)).toEqual({
      objectId: prepared.objectId,
      namespaceId: "namespace-conversation",
      objectType: "nautilo-message-v2",
      payloadVersion: 2,
      keyClass: "ai",
    });
    expect(connection.statements.every((statement) =>
      !/session_messages|session_message_crypto_revisions|rooms|sessions/
        .test(statement)
    )).toBe(true);
  });

  test("returns duplicate only after exact durable replay verification", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "duplicate" });
    expect(await adapter.complete(prepared)).toBe("created");
    const writes = connection.statements.filter((statement) =>
      statement.includes("INSERT INTO")
    ).length;

    expect(await adapter.complete(prepared)).toBe("duplicate");
    expect(connection.statements.filter((statement) =>
      statement.includes("INSERT INTO")
    ).length).toBe(writes);
  });

  test("rolls the transaction back at every object/access persistence stage", async () => {
    for (
      const table of [
        "crypto_objects",
        "object_crypto_access_manifests",
        "object_crypto_namespace_envelopes",
        "object_crypto_access_heads",
      ]
    ) {
      const { connection, adapter, prepare } = await fixture();
      const prepared = prepare({
        content: `rollback ${table}`,
      });
      connection.failInsertTable = table;

      expect(adapter.complete(prepared)).rejects.toThrow(
        /insert failed|outcome is ambiguous/i,
      );
      expect(connection.state).toEqual({ object: null, access: null });
      expect(await adapter.complete(prepared)).toBe("created");
    }
  });

  test("replays as duplicate after the transaction committed but its response was lost", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "lost response" });
    connection.loseNextCommitResponse = true;

    expect(adapter.complete(prepared)).rejects.toThrow(/commit response lost/i);
    expect(connection.state.object).not.toBeNull();
    expect(connection.state.access).not.toBeNull();
    expect(await adapter.complete(prepared)).toBe("duplicate");
  });

  test("rolls back when any insert executes but its statement response is lost", async () => {
    for (
      const table of [
        "crypto_objects",
        "object_crypto_access_manifests",
        "object_crypto_namespace_envelopes",
        "object_crypto_access_heads",
      ]
    ) {
      const { connection, adapter, prepare } = await fixture();
      const prepared = prepare({
        content: `statement response loss ${table}`,
      });
      connection.loseInsertResponseTable = table;

      expect(adapter.complete(prepared)).rejects.toThrow(
        /response lost|outcome is ambiguous/i,
      );
      expect(connection.state).toEqual({ object: null, access: null });
      expect(await adapter.complete(prepared)).toBe("created");
    }
  });

  test("rejects a conflicting payload under the same object identity", async () => {
    const { connection, adapter, prepare } = await fixture();
    const original = prepare({ content: "original" });
    expect(await adapter.complete(original)).toBe("created");
    const conflict = prepare({ content: "conflict" });
    const before = cloneState(connection.state);

    expect(adapter.complete(conflict)).rejects.toBeInstanceOf(
      ConversationCryptoCompletionConflictError,
    );
    expect(connection.state).toEqual(before);
  });

  test("returns null for a payload-only partial object instead of blessing it", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "partial" });
    const snapshot = readPreparedConversationCryptoRevision(prepared);
    const payloadBytes = snapshot.object.payloadBytes.ciphertext;
    connection.state = {
      ...connection.state,
      object: {
        objectId: prepared.objectId,
        payloadBytes,
        payloadHash: sha256(payloadBytes),
      },
    };

    expect(await adapter.verify(prepared.objectId)).toBeNull();
  });

  test("fails closed on a corrupt durable complete set", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "corrupt access" });
    expect(await adapter.complete(prepared)).toBe("created");
    const access = connection.state.access!;
    const corruptBytes = new Uint8Array([1, 2, 3]);
    connection.state = {
      ...connection.state,
      access: {
        ...access,
        envelopes: [{
          ...access.envelopes[0]!,
          envelopeHash: sha256(corruptBytes),
          envelopeBytes: corruptBytes,
        }],
      },
    };

    expect(adapter.verify(prepared.objectId)).rejects.toThrow();
  });

  test("keeps existing bytes verifiable and replayable after current authorization advances or disappears", async () => {
    const {
      connection,
      adapter,
      prepare,
      registerResolver,
    } = await fixture();
    const prepared = prepare({ content: "authenticated read" });
    expect(await adapter.complete(prepared)).toBe("created");
    expect(await adapter.verify(prepared.objectId)).not.toBeNull();

    registerResolver((context) => ({
      ...context,
      sourceAuthorized: true,
      targetAuthorized: true,
      currentHostAuthorizationRevision:
        context.hostAuthorizationRevision + 1,
      committerSigningPublicKey: new Uint8Array(32),
    }));
    expect(await adapter.verify(prepared.objectId)).not.toBeNull();
    expect(await adapter.complete(prepared)).toBe("duplicate");

    registerResolver(() => null);
    expect(await adapter.verify(prepared.objectId)).not.toBeNull();
    expect(await adapter.complete(prepared)).toBe("duplicate");
    expect(connection.state.access).not.toBeNull();
  });

  test("returns null when authenticated historical signer authority is absent", async () => {
    const {
      adapter,
      prepare,
      registerHistoricalResolver,
    } = await fixture();
    const prepared = prepare({ content: "missing historical signer" });
    expect(await adapter.complete(prepared)).toBe("created");

    registerHistoricalResolver(() => null);
    expect(await adapter.verify(prepared.objectId)).toBeNull();
  });

  test("propagates historical signer resolver failures", async () => {
    const {
      adapter,
      prepare,
      registerHistoricalResolver,
    } = await fixture();
    const prepared = prepare({ content: "historical resolver failure" });
    expect(await adapter.complete(prepared)).toBe("created");

    registerHistoricalResolver(() => {
      throw new Error("historical authority unavailable");
    });
    expect(adapter.verify(prepared.objectId)).rejects.toThrow(
      "historical authority unavailable",
    );
  });

  test("does not finish a partial old write without current authorization", async () => {
    const {
      connection,
      adapter,
      prepare,
      registerResolver,
    } = await fixture();
    const prepared = prepare({ content: "stale partial" });
    const snapshot = readPreparedConversationCryptoRevision(prepared);
    const payloadBytes = snapshot.object.payloadBytes.ciphertext;
    connection.state = {
      object: {
        objectId: prepared.objectId,
        payloadBytes,
        payloadHash: sha256(payloadBytes),
      },
      access: null,
    };
    const before = cloneState(connection.state);
    registerResolver(() => null);

    expect(adapter.complete(prepared)).rejects.toBeInstanceOf(
      ConversationCryptoCompletionConflictError,
    );
    expect(connection.state).toEqual(before);
    expect(await adapter.verify(prepared.objectId)).toBeNull();
  });

  test("rejects a structurally valid durable manifest with a forged signature", async () => {
    const { connection, adapter, prepare } = await fixture();
    const prepared = prepare({ content: "forged signature" });
    expect(await adapter.complete(prepared)).toBe("created");
    const access = connection.state.access!;
    const forgedManifest = access.manifestBytes.slice();
    const finalIndex = forgedManifest.length - 1;
    forgedManifest[finalIndex] = forgedManifest[finalIndex]! ^ 0x01;
    connection.state = {
      ...connection.state,
      access: {
        ...access,
        manifestBytes: forgedManifest,
        manifestHash: sha256(forgedManifest),
      },
    };

    expect(await adapter.verify(prepared.objectId)).toBeNull();
  });

  test("rejects a structural prepared-revision forgery before opening a transaction", async () => {
    const { connection, adapter } = await fixture();
    const forged = Object.freeze({
      objectId: deriveMessageCryptoObjectIdV2({
        sessionId: SESSION_ID,
        messageId: 1,
        revision: 0,
      }),
      namespaceId: "namespace-conversation",
      objectType: "nautilo-message-v2",
      payloadVersion: 2,
      keyClass: "ai",
    }) as PreparedConversationCryptoRevision;

    expect(adapter.complete(forged)).rejects.toThrow(
      /not prepared by the bridge crypto role/i,
    );
    expect(connection.transactionCount).toBe(0);
  });

  test("does not confuse a valid manifest with different access bytes for a duplicate", async () => {
    const {
      crypto,
      connection,
      adapter,
      prepare,
      registerResolver,
    } = await fixture();
    const original = prepare({
      content: "same logical content",
      hostRevision: 9,
    });
    expect(await adapter.complete(original)).toBe("created");
    const otherAccess = preparedWithDifferentAccess(
      crypto,
      original,
      registerResolver,
    );
    const before = cloneState(connection.state);
    expect(adapter.complete(otherAccess)).rejects.toBeInstanceOf(
      ConversationCryptoCompletionConflictError,
    );
    expect(connection.state).toEqual(before);
  });
});
