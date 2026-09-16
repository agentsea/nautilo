import { describe, expect, test } from "bun:test";
import type {
  ProtectedMemoryPreparedCreateRequestV1,
  ProtectedMemoryPreparedUpdateRequestV1,
} from "@nautilo/api-client";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanMemoryContentEmbeddingRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
  decodeObjectAccessManifestV5,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  encodeMemoryPayloadV1,
} from "../../src/memory/memory-payload-v1.ts";
import {
  humanMemoryRepairPayloadDigestV1,
  prepareHumanMemoryRepairAttestationV1,
} from "../../src/memory/human-memory-repair-attestation.ts";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  MEMORY_OBJECT_TYPE,
} from "../../src/memory/memory-repository.ts";
import {
  authenticatePreparedHumanMemoryCreate,
  authenticatePreparedHumanMemoryUpdate,
  bindPreparedHumanMemoryProductAllocation,
  createHumanMemoryReservedReplayAdmission,
  digestPreparedHumanMemorySignedRequest,
  readPreparedHumanMemoryUpdateSnapshot,
  type HistoricalHumanMemoryDeviceAuthority,
} from "../../src/server/memory/human-memory-prepared-update.ts";
import {
  assertPreparedHumanMemoryCurrentWriteAuthority,
  createPostgresHumanMemoryCryptoCompletion,
  createPostgresHumanMemoryRepresentationRepairCrypto,
} from "../../src/server/memory/postgres-human-memory-crypto-completion.ts";
import {
  createHumanMemoryPreparedCreateRoutePort,
} from "../../src/server/memory/human-memory-prepared-create-composition.ts";
import {
  createHumanMemoryPreparedUpdateRoutePort,
} from "../../src/server/memory/human-memory-prepared-update-composition.ts";
import { HumanMemoryPreparedRouteError } from
  "../../src/server/memory/human-memory-prepared-route-error.ts";
import type {
  HumanMemoryProductCreatePort,
  HumanMemoryProductUpdatePort,
} from "../../src/server/memory/postgres-human-memory-product-update.ts";

const noOrdinaryIntent = {
  lookupOrdinaryFallback: async () => { throw new Error("Unexpected ordinary intent lookup"); },
  admitOrdinaryFallback: async () => { throw new Error("Unexpected ordinary intent admission"); },
  publishOrdinaryFallbackIntent: async () => { throw new Error("Unexpected ordinary intent publication"); },
};
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";

const MEMORY_ID = "81000000-0000-4000-8000-000000000001";
const NAMESPACE_IDS = [
  "81000000-0000-4000-8000-000000000010",
  "81000000-0000-4000-8000-000000000020",
] as const;
const resolveNamespaceAuthority = async ({ namespaceId }: { namespaceId: string }) => ({
  sourceRoomId: "81000000-0000-4000-8000-000000000030", namespaceId,
  currentGeneration: 0,
  retainedGenerations: [{ generation: 0, accessRevision: 0,
    headDigestBase64url: "AA", publicationDigestBase64url: "AA",
    publicationSetDigestBase64url: "AA", audienceFingerprintBase64url: "AA" }],
});

function seededRng(seed: number): { bytes(length: number): Uint8Array } {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let index = 0; index < length; index++) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        bytes[index] = state & 0xff;
      }
      return bytes;
    },
  };
}

function fixture(): Readonly<{
  crypto: LatticeCrypto;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  dto: ProtectedMemoryPreparedUpdateRequestV1;
}>;
function fixture(kind: "create"): Readonly<{
  crypto: LatticeCrypto;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  dto: ProtectedMemoryPreparedCreateRequestV1;
}>;
function fixture(kind: "create" | "update" = "update"): Readonly<{
  crypto: LatticeCrypto;
  signingPrivateKey: Uint8Array;
  signingPublicKey: Uint8Array;
  dto:
    | ProtectedMemoryPreparedCreateRequestV1
    | ProtectedMemoryPreparedUpdateRequestV1;
}> {
  const crypto = new LatticeCrypto(seededRng(0x243_12), {
    now: () => 1_800_000_000_000,
  });
  const cryptoObjectId = deriveMemoryCryptoObjectIdV1({
    memoryId: MEMORY_ID,
    contentRevision: kind === "create" ? 1 : 2,
  });
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(cryptoObjectId),
      keyClass: "ai",
      objectType: MEMORY_OBJECT_TYPE,
      createdAt: unixTimestamp(1_800_000_000_000),
    },
    encodeMemoryPayloadV1({
      formatVersion: 1,
      type: "preference",
      content: "kept client-side",
    }),
  );
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const namespaceEnvelopes = NAMESPACE_IDS.map((id, index) => {
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(
        crypto,
        new Uint8Array(32).fill(30 + index),
        {
          objectId: objectId(cryptoObjectId),
          namespaceId: namespaceId(id),
          keyClass: "ai",
          keyGeneration: namespaceGeneration(index + 2),
          bindingRevisionAtWrap: accessRevision(index + 4),
        },
        encrypted.dek,
      ),
    );
    return { namespaceId: id, envelopeBytes };
  });
  encrypted.dek.fill(0);
  const signing = crypto.generateSigningKeyPair();
  const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
    objectId: objectId(cryptoObjectId),
    payloadHash: crypto.hash(payloadBytes),
    envelopeBytes: namespaceEnvelopes.map((entry) => entry.envelopeBytes),
    sourceAuthorized: true,
    targetAuthorized: true,
    subjectHumanId: humanId("human:1"),
    committerDeviceId: cryptoDeviceId("human-device:1"),
    hostAuthorizationRevision: authorizationRevision(11),
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  const signedRequest = prepareHumanMemoryContentEmbeddingRequest(crypto, {
    subjectHumanId: humanId("human:1"),
    requestId: kind === "create"
      ? "memory-create:op-1"
      : "memory-update:op-1",
    memoryId: MEMORY_ID,
    expectedProductRevision: kind === "create" ? 0 : 1,
    nextProductRevision: kind === "create" ? 1 : 2,
    cryptoObjectId: objectId(cryptoObjectId),
    ciphertextPayloadHash: crypto.hash(payloadBytes),
    genesisManifestHash: crypto.hash(access.manifestBytes),
    namespaceEnvelopes: namespaceEnvelopes.map((entry) => ({
      namespaceId: namespaceId(entry.namespaceId),
      envelopeHash: crypto.hash(entry.envelopeBytes),
    })),
    type: "preference",
    content: "kept client-side",
    requestedProvider: "openai",
    requestedModel: "text-embedding-3-small",
    dimensions: 1536,
    processorContractVersion: 1,
    issuedAt: unixTimestamp(1_800_000_000_000),
    deadlineAt: unixTimestamp(1_800_000_030_000),
    committerDeviceId: cryptoDeviceId("human-device:1"),
    hostAuthorizationRevision: authorizationRevision(11),
    committerSigningPublicKey: signing.publicKey,
    committerSigningPrivateKey: signing.privateKey,
  });
  const signingPrivateKey = signing.privateKey.slice();
  signing.privateKey.fill(0);
  return Object.freeze({
    crypto,
    signingPrivateKey,
    signingPublicKey: signing.publicKey,
    dto: Object.freeze({
      requestVersion: 1,
      ...(kind === "create" ? { memoryId: MEMORY_ID } : {}),
      operationId: kind === "create"
        ? "memory-create:op-1"
        : "memory-update:op-1",
      expectedContentRevision: kind === "create" ? 0 : 1,
      nextContentRevision: kind === "create" ? 1 : 2,
      cryptoObjectId,
      payloadVersion: 1,
      encryptedPayloadBytesBase64url: Buffer.from(payloadBytes)
        .toString("base64url"),
      accessManifestBytesBase64url: Buffer.from(access.manifestBytes)
        .toString("base64url"),
      requiredNamespaceIds: [...NAMESPACE_IDS],
      namespaceEnvelopes: namespaceEnvelopes.map((entry) => ({
        namespaceId: entry.namespaceId,
        envelopeBytesBase64url: Buffer.from(entry.envelopeBytes)
          .toString("base64url"),
      })),
      signedContentEmbeddingRequestBytesBase64url: Buffer.from(
        signedRequest.bytes,
      ).toString("base64url"),
    }) as ProtectedMemoryPreparedCreateRequestV1
      | ProtectedMemoryPreparedUpdateRequestV1,
  });
}

function authorityResolver(
  signingPublicKey: Uint8Array,
  observe?: (authority: HistoricalHumanMemoryDeviceAuthority) => void,
) {
  return async (context: Omit<
    HistoricalHumanMemoryDeviceAuthority,
    "committerSigningPublicKey"
  >): Promise<HistoricalHumanMemoryDeviceAuthority> => {
    const authority = Object.freeze({
      ...context,
      committerSigningPublicKey: signingPublicKey.slice(),
    });
    observe?.(authority);
    return authority;
  };
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (cause) {
    if (cause instanceof Error) return cause;
    throw new Error("Expected rejection was not an Error");
  }
  throw new Error("Expected promise to reject");
}

type StoredState = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
};

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      value instanceof Uint8Array ? value.slice() : value,
    ]),
  )) as DatabaseRow;
}

function cloneState(state: StoredState): StoredState {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map(
      [...state.manifests].map(([revision, row]) => [revision, cloneRow(row)]),
    ),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
  };
}

class HumanMemoryCryptoConnection implements CryptoPostgresConnection {
  state: StoredState = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
  };
  readonly statements: string[] = [];

  constructor(readonly signingPublicKey: Uint8Array) {}

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    if (statement.includes("current_user::text")) {
      const row: DatabaseRow = {
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      };
      return Promise.resolve([row] as Row[]);
    }
    throw new Error("Human Memory crypto queries require a transaction");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const executor: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        this.statements.push(statement);
        const normalized = statement.toLowerCase();
        if (statement.includes("pg_advisory_xact_lock")) return [];
        if (
          statement.includes("FROM crypto_objects")
          || normalized.includes('from "crypto_objects"')
        ) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (statement.includes("JOIN object_crypto_access_manifests")) {
          const revision = working.head?.["access_revision"];
          const row = typeof revision === "number"
            ? working.manifests.get(revision)
            : undefined;
          return (row === undefined ? [] : [cloneRow(row)]) as Row[];
        }
        if (
          (statement.includes("FROM object_crypto_namespace_envelopes e")
            && statement.includes("JOIN object_crypto_access_heads"))
          || (normalized.includes('from "object_crypto_namespace_envelopes"')
            && normalized.includes('join "object_crypto_access_heads"'))
        ) {
          return working.envelopes.filter((row) =>
            row["access_revision"] === working.head?.["access_revision"]
          ).map(cloneRow) as Row[];
        }
        if (statement.includes("FROM object_crypto_access_heads")) {
          return (working.head === null ? [] : [cloneRow(working.head)]) as Row[];
        }
        if (
          normalized.includes("object_crypto_access_manifests")
          && normalized.includes(">= $2")
          && normalized.includes("<= $3")
        ) {
          return Array.from(working.manifests.entries())
            .filter(([revision]) =>
              revision >= Number(parameters[1])
              && revision <= Number(parameters[2])
            )
            .sort(([left], [right]) => left - right)
            .slice(0, Number(parameters[3]))
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (normalized.includes("human_crypto_devices")) {
          return [{
            device_id: "human-device:1",
            human_id: "human:1",
            signing_public_key: this.signingPublicKey.slice(),
            state: "active",
            revision: 1_000,
          }] as unknown as Row[];
        }
        if (
          normalized.includes('from "object_crypto_access_manifests"')
          && normalized.includes('"access_revision" < $2')
        ) {
          return Array.from(working.manifests.entries())
            .filter(([revision]) => revision < Number(parameters[1]))
            .sort(([left], [right]) => left - right)
            .slice(0, Number(parameters[2]))
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (statement.includes("FROM object_crypto_access_manifests")) {
          const revision = statement.includes("access_revision = 0") ? 0 : 1;
          const row = working.manifests.get(revision);
          return (row === undefined ? [] : [cloneRow(row)]) as Row[];
        }
        if (statement.includes("FROM object_crypto_namespace_envelopes")) {
          const revision = parameters[1];
          return working.envelopes.filter((row) =>
            typeof revision !== "number" || row["access_revision"] === revision
          ).map(cloneRow) as Row[];
        }
        if (
          statement.includes("INSERT INTO crypto_objects")
          || normalized.startsWith('insert into "crypto_objects"')
        ) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: (parameters[1] as Uint8Array).slice(),
            payload_bytes: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (normalized.startsWith('insert into "object_crypto_access_manifests"')) {
          working.manifests.set(parameters[1] as number, {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
            previous_manifest_hash: parameters[3] === null
              ? null
              : (parameters[3] as Uint8Array).slice(),
            payload_hash: (parameters[4] as Uint8Array).slice(),
            manifest_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (statement.includes("INSERT INTO object_crypto_access_manifests")) {
          const genesis = statement.includes("VALUES ($1, 0");
          const revision = genesis ? 0 : parameters[1] as number;
          working.manifests.set(revision, {
            object_id: parameters[0] as string,
            access_revision: revision,
            manifest_hash: (parameters[genesis ? 1 : 2] as Uint8Array).slice(),
            previous_manifest_hash: genesis
              ? null
              : (parameters[3] as Uint8Array).slice(),
            payload_hash: (parameters[genesis ? 2 : 4] as Uint8Array).slice(),
            manifest_bytes: (parameters[genesis ? 3 : 5] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.startsWith('insert into "object_crypto_namespace_envelopes"')) {
          working.envelopes.push({
            namespace_id: parameters[2] as string,
            access_revision: parameters[1] as number,
            ordinal: parameters[3] as number,
            envelope_hash: (parameters[4] as Uint8Array).slice(),
            envelope_bytes: (parameters[5] as Uint8Array).slice(),
          });
          return [];
        }
        if (statement.includes("INSERT INTO object_crypto_namespace_envelopes")) {
          working.envelopes.push({
            namespace_id: parameters[1] as string,
            access_revision: 0,
            ordinal: parameters[2] as number,
            envelope_hash: (parameters[3] as Uint8Array).slice(),
            envelope_bytes: (parameters[4] as Uint8Array).slice(),
          });
          return [];
        }
        if (normalized.startsWith('insert into "object_crypto_access_heads"')) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: parameters[1] as number,
            manifest_hash: (parameters[2] as Uint8Array).slice(),
          };
          return [];
        }
        if (statement.includes("INSERT INTO object_crypto_access_heads")) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: 0,
            manifest_hash: (parameters[1] as Uint8Array).slice(),
          };
          return [];
        }
        if (statement.includes("UPDATE object_crypto_access_heads")) {
          const expectedHash = parameters[4] as Uint8Array;
          const head = working.head;
          const currentHash = head?.["manifest_hash"];
          if (
            head !== null
            && head["object_id"] === parameters[0]
            && head["access_revision"] === parameters[3]
            && currentHash instanceof Uint8Array
            && currentHash.every((byte, index) => byte === expectedHash[index])
          ) {
            working.head = {
              object_id: parameters[0] as string,
              access_revision: parameters[1] as number,
              manifest_hash: (parameters[2] as Uint8Array).slice(),
            };
            const row: DatabaseRow = {
              object_id: parameters[0] as string,
            };
            return [row] as Row[];
          }
          return [];
        }
        throw new Error(`Unexpected Human Memory SQL: ${statement}`);
      },
    };
    const result = await callback(executor);
    this.state = working;
    return result;
  }
}

describe("Human prepared Memory update", () => {
  test("admits expired signed bytes only through an exact durable reservation token", async () => {
    const state = fixture();
    const expiredNow = 1_800_000_031_000;
    expect(authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto, expectedHumanId: "human:1", memoryId: MEMORY_ID,
      prepared: state.dto, now: expiredNow,
      resolveHistoricalDeviceAuthority: authorityResolver(state.signingPublicKey),
    })).rejects.toThrow("not currently valid");
    const digest = digestPreparedHumanMemorySignedRequest(state.crypto, state.dto);
    const admission = createHumanMemoryReservedReplayAdmission({
      operationId: state.dto.operationId, memoryId: MEMORY_ID,
      operationRequestDigest: digest,
    });
    const retried = await authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto, expectedHumanId: "human:1", memoryId: MEMORY_ID,
      prepared: state.dto, now: expiredNow, reservedReplayAdmission: admission,
      resolveHistoricalDeviceAuthority: authorityResolver(state.signingPublicKey),
    });
    expect(retried.prepared.operationId).toBe(state.dto.operationId);
    expect(retried.signedRequestValidity).toEqual({
      issuedAt: 1_800_000_000_000, deadlineAt: 1_800_000_030_000,
    });
    expect(retried.embeddingRequest).toMatchObject({
      issuedAt: expiredNow, deadlineAt: expiredNow + 30_000,
      plaintext: "kept client-side",
    });
    const bound = bindPreparedHumanMemoryProductAllocation(retried.prepared, {
      operationId: state.dto.operationId, memoryId: MEMORY_ID,
      expectedContentRevision: 1, nextContentRevision: 2,
      objectId: state.dto.cryptoObjectId, anchorNamespaceId: NAMESPACE_IDS[0],
      requiredNamespaceFingerprint: fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      expectedAccessRevision: 0, operationRequestDigest: retried.operationRequestDigest,
      allocationRequestDigest: state.crypto.hash(new Uint8Array([7, 8, 9])),
    });
    expect(await rejected(assertPreparedHumanMemoryCurrentWriteAuthority({
      crypto: state.crypto, prepared: bound, resolve: async () => null,
    }))).toBeInstanceOf(HumanMemoryPreparedRouteError);
    const resolverFailure = new Error("authority storage cancelled");
    expect(await rejected(assertPreparedHumanMemoryCurrentWriteAuthority({
      crypto: state.crypto,
      prepared: bound,
      resolve: () => Promise.reject(resolverFailure),
    }))).toBe(resolverFailure);
    await assertPreparedHumanMemoryCurrentWriteAuthority({
      crypto: state.crypto, prepared: bound, resolve: async (context) => ({
        ...context, sourceAuthorized: true, targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
    });
    const changed = { ...state.dto, operationId: "memory-update:changed" };
    expect(authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto, expectedHumanId: "human:1", memoryId: MEMORY_ID,
      prepared: changed, now: expiredNow, reservedReplayAdmission: admission,
      resolveHistoricalDeviceAuthority: authorityResolver(state.signingPublicKey),
    })).rejects.toThrow();
    expect(authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto, expectedHumanId: "human:1", memoryId: MEMORY_ID,
      prepared: state.dto, now: expiredNow, reservedReplayAdmission: admission,
      resolveHistoricalDeviceAuthority: async () => null,
    })).rejects.toThrow("historical device authority");
    digest.fill(0);
  });
  test("authenticates exact Human/device and multi-Namespace common-v5 coordinates", async () => {
    const state = fixture();
    let resolved: HistoricalHumanMemoryDeviceAuthority | undefined;
    const authenticated = await authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      memoryId: MEMORY_ID,
      prepared: state.dto,
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority: authorityResolver(
        state.signingPublicKey,
        (value) => {
          resolved = value;
        },
      ),
    });

    expect(authenticated.prepared).toEqual({
      expectedHumanId: "human:1",
      operationId: "memory-update:op-1",
      memoryId: MEMORY_ID,
      contentRevision: 2,
      expectedContentRevision: 1,
      nextContentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      objectType: MEMORY_OBJECT_TYPE,
      payloadVersion: 1,
      requiredNamespaceIds: NAMESPACE_IDS,
    });
    expect(resolved?.committerDeviceId).toBe("human-device:1");
    expect(resolved?.hostAuthorizationRevision).toBe(11);
    expect(resolved?.envelopes.map((entry) => entry.namespaceId))
      .toEqual([...NAMESPACE_IDS]);
    expect(authenticated.embeddingRequest).toMatchObject({
      subjectId: "human:1",
      requestId: "memory-update:op-1",
      plaintext: "kept client-side",
      publication: {
        objectId: state.dto.cryptoObjectId,
        expectedProductRevision: 1,
        idempotencyId: "memory-update:op-1",
      },
    });
    const snapshot = readPreparedHumanMemoryUpdateSnapshot(
      authenticated.prepared,
    );
    expect(snapshot.envelopes).toHaveLength(2);
    expect(snapshot.operationRequestDigest).toEqual(
      authenticated.operationRequestDigest,
    );
    expect(JSON.stringify(snapshot)).not.toContain("kept client-side");
    expect(JSON.stringify(snapshot)).not.toContain(
      state.dto.signedContentEmbeddingRequestBytesBase64url,
    );
    const payloadFirst = snapshot.payloadBytes[0];
    const authorityHashFirst = snapshot.authority.payloadHash[0];
    const envelopeFirst = snapshot.envelopes[0]!.envelopeBytes[0];
    snapshot.payloadBytes.fill(0);
    snapshot.authority.payloadHash.fill(0);
    snapshot.envelopes[0]!.envelopeBytes.fill(0);
    snapshot.operationRequestDigest.fill(0);
    const reread = readPreparedHumanMemoryUpdateSnapshot(
      authenticated.prepared,
    );
    expect(reread.payloadBytes[0]).toBe(payloadFirst);
    expect(reread.authority.payloadHash[0]).toBe(authorityHashFirst);
    expect(reread.envelopes[0]!.envelopeBytes[0]).toBe(envelopeFirst);
    expect(reread.operationRequestDigest).toEqual(
      authenticated.operationRequestDigest,
    );
    expect(() => readPreparedHumanMemoryUpdateSnapshot({
      ...authenticated.prepared,
    }))
      .toThrow("not authenticated by the bridge");
  });

  test("fails closed for wrong Human, stale resolver, and substituted bytes", async () => {
    const state = fixture();
    const authenticate = (
      dto: ProtectedMemoryPreparedUpdateRequestV1,
      mutateAuthority?: (
        authority: HistoricalHumanMemoryDeviceAuthority,
      ) => HistoricalHumanMemoryDeviceAuthority,
    ) => authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      memoryId: MEMORY_ID,
      prepared: dto,
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority: async (context) => {
        const exact = await authorityResolver(state.signingPublicKey)(context);
        return mutateAuthority?.(exact) ?? exact;
      },
    });

    expect((await rejected(authenticate(state.dto, (authority) => ({
      ...authority,
      expectedHumanId: "human:2",
    })))).message).toContain("historical device authority is unavailable");
    expect((await rejected(authenticate(state.dto, (authority) => ({
      ...authority,
      hostAuthorizationRevision: authority.hostAuthorizationRevision + 1,
    })))).message).toContain("historical device authority is unavailable");
    expect((await rejected(authenticate({
      ...state.dto,
      operationId: "memory-update:substituted",
    }, (authority) => ({
      ...authority,
      operationId: "memory-update:op-1",
    })))).message).toContain("historical device authority is unavailable");
    expect((await rejected(authenticate({
      ...state.dto,
      namespaceEnvelopes: [
        {
          ...state.dto.namespaceEnvelopes[0]!,
          namespaceId: NAMESPACE_IDS[1],
        },
        state.dto.namespaceEnvelopes[1]!,
      ],
    }))).message).toContain("Namespace envelope disagrees");
    const corrupt = Buffer.from(state.dto.accessManifestBytesBase64url, "base64url");
    corrupt[corrupt.length - 1] = corrupt[corrupt.length - 1]! ^ 1;
    expect((await rejected(authenticate({
      ...state.dto,
      accessManifestBytesBase64url: corrupt.toString("base64url"),
    }))).message).toContain("Signed Human Memory request coordinates disagree");
  });

  test("persists only the current manifest atomically, replays, and verifies", async () => {
    const state = fixture();
    const authenticated = await authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      memoryId: MEMORY_ID,
      prepared: state.dto,
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority: authorityResolver(state.signingPublicKey),
    });
    const connection = new HumanMemoryCryptoConnection(
      state.signingPublicKey,
    );
    const handle = await verifyCryptoPostgresHandle(connection);
    let currentAllowed = true;
    let currentCalls = 0;
    let storedHumanId = "human:1";
    const completion = createPostgresHumanMemoryCryptoCompletion({
      handle,
      crypto: state.crypto,
      resolveCurrentWriteAuthorization: async (context) => {
        currentCalls += 1;
        return currentAllowed
          ? {
            ...context,
            sourceAuthorized: true,
            targetAuthorized: true,
            currentHostAuthorizationRevision:
              context.hostAuthorizationRevision,
            committerSigningPublicKey: state.signingPublicKey.slice(),
          }
          : null;
      },
      resolveStoredSignerAuthority: async (context) => ({
        ...context,
        humanId: storedHumanId,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
    });
    const reference = Object.freeze({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      expectedAccessRevision: 0,
      expectedActiveNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
    });

    const prepared = bindPreparedHumanMemoryProductAllocation(
      authenticated.prepared,
      {
        operationId: authenticated.prepared.operationId,
        memoryId: authenticated.prepared.memoryId,
        expectedContentRevision:
          authenticated.prepared.expectedContentRevision,
        nextContentRevision: authenticated.prepared.nextContentRevision,
        objectId: authenticated.prepared.objectId,
        anchorNamespaceId: NAMESPACE_IDS[0],
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
        expectedAccessRevision: 0,
        operationRequestDigest: authenticated.operationRequestDigest,
        allocationRequestDigest: state.crypto.hash(new Uint8Array([1, 2, 3])),
      },
    );
    expect((await rejected(completion.complete(authenticated.prepared))).message)
      .toContain("missing its product allocation");
    expect((await rejected(completion.complete({ ...prepared }))).message)
      .toContain("not authenticated by the bridge");
    expect(connection.state.object).toBeNull();
    expect(await completion.complete(prepared)).toBe("created");
    expect(currentCalls).toBe(1);
    expect(connection.state.manifests.size).toBe(1);
    expect(connection.state.envelopes).toHaveLength(2);
    const signedManifest = decodeObjectAccessManifestV5(
      Buffer.from(state.dto.accessManifestBytesBase64url, "base64url"),
    );
    expect(connection.state.envelopes.map((row) => row["envelope_hash"]))
      .toEqual([...signedManifest.envelopeHashes]);
    expect(connection.state.head?.["access_revision"]).toBe(0);

    currentAllowed = false;
    expect(await completion.complete(prepared)).toBe("duplicate");
    expect(currentCalls).toBe(1);
    // A stored ordinal need not be Namespace order (Agent manifests use hash
    // order). Exercise that distinction deterministically, not by UUID luck.
    connection.state.envelopes = [...connection.state.envelopes]
      .sort((left, right) => String(left["namespace_id"]) > String(right["namespace_id"]) ? -1 : 1)
      .map((row, ordinal) => ({ ...row, ordinal }));
    expect(await completion.complete(prepared)).toBe("duplicate");
    storedHumanId = "human:2";
    expect((await rejected(completion.complete(prepared))).message).toContain(
      "common v5 Human device signer history is unavailable",
    );
    storedHumanId = "human:1";
    expect(await completion.verify(reference)).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      requiredNamespaceIds: [...NAMESPACE_IDS],
    });
    const readable = await completion.read(reference);
    expect(readable).toMatchObject({
      memoryId: MEMORY_ID,
      contentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      accessRevision: 0,
      requiredNamespaceIds: [...NAMESPACE_IDS],
    });
    expect(readable?.payloadBytes).toEqual(
      Buffer.from(state.dto.encryptedPayloadBytesBase64url, "base64url"),
    );
    expect(readable?.accessManifestBytes).toEqual(
      Buffer.from(state.dto.accessManifestBytesBase64url, "base64url"),
    );
    expect(readable?.namespaceEnvelopes.map((entry) => entry.namespaceId))
      .toEqual([...NAMESPACE_IDS]);
    readable?.payloadBytes.fill(0);
    readable?.accessManifestBytes.fill(0);
    for (const envelope of readable?.namespaceEnvelopes ?? []) {
      envelope.envelopeBytes.fill(0);
    }
    state.signingPrivateKey.fill(0);
    expect(connection.statements.some((statement) =>
      statement.includes("memories") || statement.includes("memory_revisions")
    )).toBeFalse();
  });

  test("rejects stale current Human authority before writing any crypto row", async () => {
    const state = fixture();
    const authenticated = await authenticatePreparedHumanMemoryUpdate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      memoryId: MEMORY_ID,
      prepared: state.dto,
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority: authorityResolver(state.signingPublicKey),
    });
    const connection = new HumanMemoryCryptoConnection(
      state.signingPublicKey,
    );
    const handle = await verifyCryptoPostgresHandle(connection);
    const completion = createPostgresHumanMemoryCryptoCompletion({
      handle,
      crypto: state.crypto,
      resolveCurrentWriteAuthorization: async (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision + 1,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
      resolveStoredSignerAuthority: async (context) => ({
        ...context,
        humanId: "human:1",
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
    });

    const prepared = bindPreparedHumanMemoryProductAllocation(
      authenticated.prepared,
      {
        operationId: authenticated.prepared.operationId,
        memoryId: authenticated.prepared.memoryId,
        expectedContentRevision:
          authenticated.prepared.expectedContentRevision,
        nextContentRevision: authenticated.prepared.nextContentRevision,
        objectId: authenticated.prepared.objectId,
        anchorNamespaceId: NAMESPACE_IDS[0],
        requiredNamespaceFingerprint:
          fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
        expectedAccessRevision: 0,
        operationRequestDigest: authenticated.operationRequestDigest,
        allocationRequestDigest: state.crypto.hash(new Uint8Array([1, 2, 3])),
      },
    );
    expect((await rejected(completion.complete(prepared))).message).toContain(
      "Current Human Memory write authority is unavailable or stale",
    );
    expect(connection.state.object).toBeNull();
    expect(connection.state.manifests.size).toBe(0);
    expect(connection.state.envelopes).toHaveLength(0);
    expect(connection.state.head).toBeNull();
  });

  test("processes signed plaintext once and publishes only actual provider output", async () => {
    const state = fixture();
    let processorCalls = 0;
    let completionCalls = 0;
    let productEmbedding: readonly number[] | undefined;
    let completionFailure: Error | undefined;
    let failPublication = false;
    const actualVector = Object.freeze(new Array<number>(1536).fill(0.75));
    const allocation = Object.freeze({
      operationId: state.dto.operationId,
      memoryId: MEMORY_ID,
      expectedContentRevision: 1,
      nextContentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      anchorNamespaceId: NAMESPACE_IDS[0],
      requiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      expectedAccessRevision: 0,
      operationRequestDigest: state.crypto.hash(Buffer.from(
        state.dto.signedContentEmbeddingRequestBytesBase64url,
        "base64url",
      )),
      allocationRequestDigest: state.crypto.hash(new Uint8Array([7, 8, 9])),
    });
    const product: HumanMemoryProductUpdatePort = {
      ...noOrdinaryIntent,
      lookupReservation: async () => null,
      inspect: async () => ({ kind: "new", expectedAccessRevision: 0 }),
      allocate: async (input) => {
        expect(JSON.stringify(input)).not.toContain("kept client-side");
        expect(JSON.stringify(input)).not.toContain(
          state.dto.signedContentEmbeddingRequestBytesBase64url,
        );
        return allocation;
      },
      authorizeCurrent: async (_authority, candidate) =>
        candidate.operationId === allocation.operationId
        && candidate.allocationRequestDigest.every((value, index) =>
          value === allocation.allocationRequestDigest[index]
        ),
      publishOrdinaryFallback: async () => { throw new Error("Unexpected fallback"); },
      publish: async (input) => {
        if (failPublication) {
          throw new HumanMemoryPreparedRouteError(
            "authorization_required",
            "Human Memory publication authority changed",
          );
        }
        productEmbedding = input.embedding.vector;
        return ({
        memoryId: MEMORY_ID,
        contentRevision: 2,
        cryptoAccessRevision: 0,
        importance: 0.5,
        tier: 1,
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        updatedAt: new Date("2026-08-10T00:00:01.000Z"),
        namespaceIds: [...NAMESPACE_IDS],
        requiredNamespaceIds: [...NAMESPACE_IDS],
        scopeOrigin: "seed",
        });
      },
    };
    const route = createHumanMemoryPreparedUpdateRoutePort({
      crypto: state.crypto,
      now: () => 1_800_000_000_000,
      resolveHumanId: async () => "human:1",
      resolveNamespaceAuthority,
      resolveHistoricalDeviceAuthority:
        authorityResolver(state.signingPublicKey),
      resolveHistoricalOrdinaryDeviceAuthority: async () => null,
      resolveCurrentWriteAuthorization: async (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
      foregroundEmbeddingProcessor: {
        embed: async ({ request, authenticatedSubjectId }) => {
          processorCalls += 1;
          expect(authenticatedSubjectId).toBe("human:1");
          expect(request.plaintext).toBe("kept client-side");
          return {
            status: "embedded",
            embedding: {
              provider: "openai",
              canonicalModel: "text-embedding-3-small",
              dimensions: 1536,
              vector: actualVector,
              processorContractVersion: 1,
            },
          };
        },
      },
      product,
      createCryptoCompletion: (resolveCurrent) => ({
        complete: async (prepared) => {
          completionCalls += 1;
          if (completionFailure !== undefined) throw completionFailure;
          const snapshot = readPreparedHumanMemoryUpdateSnapshot(prepared);
          expect(snapshot.productAllocation).not.toBeNull();
          expect(await resolveCurrent({
            ...snapshot.authority,
            purpose: "authorize-current-human-memory-update-persistence",
            productAllocation: snapshot.productAllocation!,
          })).not.toBeNull();
          return "created";
        },
        verify: async () => null,
      }),
    });

    const response = await route.updatePrepared({
      authority: {
        userId: "user:1",
        actorId: "actor:1",
        agentId: null,
        sourceRoomId: null,
        memoryMode: "namespace",
        mutableNamespaceIds: [...NAMESPACE_IDS],
        writableNamespaceIds: [...NAMESPACE_IDS],
      },
      memoryId: MEMORY_ID,
      prepared: state.dto,
    });
    expect(response.status).toBe("published");
    if (response.status !== "published") throw new Error("Expected publication");
    expect(response.memory.protectedPayload).toMatchObject({
      accessSignerEvidence: [{
        kind: "human_device",
        subjectHumanId: "human:1",
        committerDeviceId: "human-device:1",
        hostAuthorizationRevision: 11,
        signingPublicKeyBase64url: Buffer.from(state.signingPublicKey)
          .toString("base64url"),
      }],
    });
    expect(processorCalls).toBe(1);
    expect(completionCalls).toBe(1);
    expect(productEmbedding).toBe(actualVector);

    completionFailure = new HumanMemoryPreparedRouteError(
      "stale_revision",
      "Human Memory publication allocation is stale",
    );
    expect(await route.updatePrepared({ authority: {
      userId: "user:1", actorId: "actor:1", agentId: null, sourceRoomId: null,
      memoryMode: "namespace", mutableNamespaceIds: [...NAMESPACE_IDS],
      writableNamespaceIds: [...NAMESPACE_IDS],
    }, memoryId: MEMORY_ID, prepared: state.dto })).toEqual({
      dtoVersion: 1, status: "unavailable", reason: "stale_revision",
    });
    completionFailure = new Error("opaque crypto failure");
    expect(route.updatePrepared({ authority: {
      userId: "user:1", actorId: "actor:1", agentId: null, sourceRoomId: null,
      memoryMode: "namespace", mutableNamespaceIds: [...NAMESPACE_IDS],
      writableNamespaceIds: [...NAMESPACE_IDS],
    }, memoryId: MEMORY_ID, prepared: state.dto })).rejects.toThrow(
      "opaque crypto failure",
    );
    completionFailure = undefined;
    failPublication = true;
    expect(await route.updatePrepared({ authority: {
      userId: "user:1", actorId: "actor:1", agentId: null, sourceRoomId: null,
      memoryMode: "namespace", mutableNamespaceIds: [...NAMESPACE_IDS],
      writableNamespaceIds: [...NAMESPACE_IDS],
    }, memoryId: MEMORY_ID, prepared: state.dto })).toEqual({
      dtoVersion: 1, status: "unavailable", reason: "authorization_required",
    });
  });

  test("terminal ordinary fallback replay skips crypto and embedding", async () => {
    const state = fixture();
    const operationRequestDigest = state.crypto.hash(Buffer.from(
      state.dto.signedContentEmbeddingRequestBytesBase64url,
      "base64url",
    ));
    const allocation = Object.freeze({
      operationId: state.dto.operationId,
      memoryId: MEMORY_ID,
      expectedContentRevision: 1,
      nextContentRevision: 2,
      objectId: state.dto.cryptoObjectId,
      anchorNamespaceId: NAMESPACE_IDS[0],
      requiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      expectedAccessRevision: 0,
      operationRequestDigest,
      allocationRequestDigest: state.crypto.hash(new Uint8Array([5])),
    });
    let completionCreations = 0;
    const route = createHumanMemoryPreparedUpdateRoutePort({
      crypto: state.crypto,
      now: () => 1_800_000_000_000,
      resolveHumanId: async () => "human:1",
      resolveNamespaceAuthority,
      resolveHistoricalDeviceAuthority:
        authorityResolver(state.signingPublicKey),
      resolveHistoricalOrdinaryDeviceAuthority: async () => null,
      resolveCurrentWriteAuthorization: async (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
      foregroundEmbeddingProcessor: {
        embed: () => {
          throw new Error("replay must not call provider");
        },
      },
      product: {
        ...noOrdinaryIntent,
        lookupReservation: async () => null,
        inspect: async () => ({
          kind: "replay",
          certificate: allocation,
          embedding: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1536,
            vector: new Array<number>(1536).fill(0.75),
            processorContractVersion: 1,
          },
          alreadyPublished: true,
          ordinaryFallbackReason: "encryption_pending",
          projection: {
            memoryId: MEMORY_ID, contentRevision: 2, cryptoAccessRevision: 0,
            importance: 0.5, tier: 1,
            createdAt: new Date("2026-08-10T00:00:00.000Z"),
            updatedAt: new Date("2026-08-10T00:00:01.000Z"),
            namespaceIds: [...NAMESPACE_IDS], requiredNamespaceIds: [...NAMESPACE_IDS],
            scopeOrigin: "seed" as const,
          },
        }),
        allocate: () => {
          throw new Error("replay must not allocate");
        },
        authorizeCurrent: async () => true,
        publishOrdinaryFallback: async () => { throw new Error("Unexpected fallback"); },
        publish: async () => ({
          memoryId: MEMORY_ID,
          contentRevision: 2,
          cryptoAccessRevision: 0,
          importance: 0.5,
          tier: 1,
          createdAt: new Date("2026-08-10T00:00:00.000Z"),
          updatedAt: new Date("2026-08-10T00:00:01.000Z"),
          namespaceIds: [...NAMESPACE_IDS],
          requiredNamespaceIds: [...NAMESPACE_IDS],
          scopeOrigin: "seed",
        }),
      },
      createCryptoCompletion: () => {
        completionCreations += 1;
        throw new Error("terminal fallback replay must not create crypto completion");
      },
    });
    const response = await route.updatePrepared({
      authority: {
        userId: "user:1",
        actorId: "actor:1",
        agentId: null,
        sourceRoomId: null,
        memoryMode: "namespace",
        mutableNamespaceIds: [...NAMESPACE_IDS],
        writableNamespaceIds: [...NAMESPACE_IDS],
      },
      memoryId: MEMORY_ID,
      prepared: state.dto,
    });
    expect(response.status).toBe("ordinary_fallback");
    expect(completionCreations).toBe(0);
  });

  test("maps expected protected failures to canonical unavailable responses", async () => {
    const state = fixture();
    const authority = {
      userId: "user:1",
      actorId: "actor:1",
      agentId: null,
      sourceRoomId: null,
      memoryMode: "namespace" as const,
      mutableNamespaceIds: [...NAMESPACE_IDS],
      writableNamespaceIds: [...NAMESPACE_IDS],
    };
    const routeFor = (productFailure: Error) =>
      createHumanMemoryPreparedUpdateRoutePort({
        crypto: state.crypto,
        now: () => 1_800_000_000_000,
        resolveHumanId: async () => "human:1",
        resolveNamespaceAuthority,
        resolveHistoricalDeviceAuthority:
          authorityResolver(state.signingPublicKey),
        resolveHistoricalOrdinaryDeviceAuthority: async () => null,
        resolveCurrentWriteAuthorization: async () => null,
        foregroundEmbeddingProcessor: {
          embed: () => {
            throw new Error("provider must not run after failed inspection");
          },
        },
        product: {
          ...noOrdinaryIntent,
          lookupReservation: async () => null,
          inspect: () => {
            throw productFailure;
          },
          allocate: () => {
            throw new Error("allocation must not run after failed inspection");
          },
          authorizeCurrent: async () => false,
          publishOrdinaryFallback: async () => { throw new Error("Unexpected fallback"); },
          publish: () => {
            throw new Error("publication must not run after failed inspection");
          },
        },
        createCryptoCompletion: () => {
          throw new Error("completion must not run after failed inspection");
        },
      });

    expect(await routeFor(new HumanMemoryPreparedRouteError(
      "stale_revision", "Human Memory product is unavailable",
    )).updatePrepared({
      authority,
      memoryId: MEMORY_ID,
      prepared: state.dto,
    })).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "stale_revision",
    });
    expect(await routeFor(new HumanMemoryPreparedRouteError(
      "integrity_failure", "Human Memory replay allocation is missing",
    )).updatePrepared({
      authority,
      memoryId: MEMORY_ID,
      prepared: state.dto,
    })).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "integrity_failure",
    });
    expect(await routeFor(new HumanMemoryPreparedRouteError(
      "authorization_required", "Human Memory transaction authority changed",
    )).updatePrepared({
      authority,
      memoryId: MEMORY_ID,
      prepared: state.dto,
    })).toEqual({
      dtoVersion: 1,
      status: "unavailable",
      reason: "authorization_required",
    });
    expect(routeFor(new Error("authority record is missing")).updatePrepared({
      authority,
      memoryId: MEMORY_ID,
      prepared: state.dto,
    })).rejects.toThrow("authority record is missing");
  });
});

describe("Human Memory representation repair crypto persistence", () => {
  test("persists exact raw V5 repair bytes, replays, and verifies readback", async () => {
    const state = fixture("create");
    const payloadBytes = Buffer.from(
      state.dto.encryptedPayloadBytesBase64url,
      "base64url",
    );
    const manifestBytes = Buffer.from(
      state.dto.accessManifestBytesBase64url,
      "base64url",
    );
    const namespaceEnvelopes = state.dto.namespaceEnvelopes.map((entry) => ({
      namespaceId: entry.namespaceId,
      envelopeBytes: Buffer.from(entry.envelopeBytesBase64url, "base64url"),
    }));
    const namespaces = namespaceEnvelopes.map((entry, index) => {
      const decoded = decodeNamespaceObjectEnvelopeV2(
        Uint8Array.from(entry.envelopeBytes),
      );
      try {
        return Object.freeze({
          namespaceId: entry.namespaceId,
          namespaceAccessRevision: decoded.context.bindingRevisionAtWrap,
          namespaceKeyGeneration: decoded.context.keyGeneration,
          headDigest: new Uint8Array(32).fill(index + 1),
          publicationDigest: new Uint8Array(32).fill(index + 3),
          publicationSetDigest: new Uint8Array(32).fill(index + 5),
          audienceFingerprint: new Uint8Array(32).fill(index + 7),
          envelopeHash: state.crypto.hash(entry.envelopeBytes),
        });
      } finally {
        decoded.wrappedDek.fill(0);
      }
    });
    const authored = Object.freeze({
      formatVersion: 1 as const,
      type: "preference",
      content: "kept client-side",
    });
    const attestation = prepareHumanMemoryRepairAttestationV1(state.crypto, {
      version: 1,
      purpose: "human_memory_representation_repair",
      direction: "ordinary_to_protected",
      operationId: "memory-repair:op-1",
      policyRevision: 3,
      subjectHumanId: "human:1",
      deviceId: "human-device:1",
      deviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: 11,
      memoryId: MEMORY_ID,
      expectedContentRevision: 1,
      targetContentRevision: 1,
      expectedCryptoAccessRevision: 0,
      cryptoObjectId: state.dto.cryptoObjectId,
      requiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      currentAuthorityEntries: namespaces.map((entry) => Object.freeze({
        namespaceId: namespaceId(entry.namespaceId),
        namespaceAccessRevision: entry.namespaceAccessRevision + 1,
        keyGeneration: entry.namespaceKeyGeneration + 1,
        headDigest: new Uint8Array(32).fill(21),
        publicationDigest: new Uint8Array(32).fill(22),
        publicationSetDigest: new Uint8Array(32).fill(23),
        audienceFingerprint: new Uint8Array(32).fill(24),
      })),
      namespaces,
      payloadHash: state.crypto.hash(payloadBytes),
      accessManifestHash: state.crypto.hash(manifestBytes),
      authoredPayloadDigest: humanMemoryRepairPayloadDigestV1(authored),
      issuedAt: 1_800_000_000_000,
      deadlineAt: 1_800_000_030_000,
      signingPrivateKey: state.signingPrivateKey,
      signingPublicKey: state.signingPublicKey,
    });
    const connection = new HumanMemoryCryptoConnection(state.signingPublicKey);
    const completion = createPostgresHumanMemoryRepresentationRepairCrypto({
      handle: await verifyCryptoPostgresHandle(connection),
      crypto: state.crypto,
      resolveStoredSignerAuthority: async (context) => Object.freeze({
        ...context,
        humanId: "human:1",
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
    });
    const publication = {
      attestation,
      payloadBytes,
      accessManifestBytes: manifestBytes,
      namespaceEnvelopes,
      committerSigningPublicKey: state.signingPublicKey,
    };
    expect(decodeEncryptedPayloadV2(payloadBytes).context.objectId)
      .toBe(objectId(state.dto.cryptoObjectId));
    expect(await completion.complete(publication)).toBe("created");
    expect(decodeEncryptedPayloadV2(payloadBytes).context.objectId)
      .toBe(objectId(state.dto.cryptoObjectId));
    expect(await completion.complete(publication)).toBe("duplicate");
    expect(await completion.verify(Object.freeze({
        ...attestation,
        direction: "protected_to_ordinary" as const,
      }))).toBe(true);
    expect(connection.state.object).not.toBeNull();
    payloadBytes.fill(0);
    manifestBytes.fill(0);
    namespaceEnvelopes.forEach((entry) => entry.envelopeBytes.fill(0));
    state.signingPrivateKey.fill(0);
  });
});

describe("Human prepared Memory create", () => {
  test("authenticates exact signed zero-to-one coordinates and rejects outer substitution", async () => {
    const state = fixture("create");
    const authenticated = await authenticatePreparedHumanMemoryCreate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      prepared: state.dto,
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority:
        authorityResolver(state.signingPublicKey),
    });
    expect(authenticated.prepared).toMatchObject({
      memoryId: MEMORY_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      contentRevision: 1,
    });
    expect(authenticated.embeddingRequest.publication).toEqual({
      objectId: state.dto.cryptoObjectId,
      expectedProductRevision: 0,
      idempotencyId: "memory-create:op-1",
    });
    expect((await rejected(authenticatePreparedHumanMemoryCreate({
      crypto: state.crypto,
      expectedHumanId: "human:1",
      prepared: { ...state.dto, operationId: "memory-create:other" },
      now: 1_800_000_000_000,
      resolveHistoricalDeviceAuthority:
        authorityResolver(state.signingPublicKey),
    }))).message).toContain("request coordinates disagree");
  });

  test("processes plaintext once, completes recoverably, and skips provider on exact replay", async () => {
    const state = fixture("create");
    let inspection: "new" | "replay" = "new";
    let planDeadlineAt = 1_800_000_030_000;
    let processorCalls = 0;
    let completionCalls = 0;
    let fallbackReplay = false;
    let completionFailure: Error | undefined;
    const allocation = Object.freeze({
      operationId: state.dto.operationId,
      memoryId: MEMORY_ID,
      expectedContentRevision: 0,
      nextContentRevision: 1,
      objectId: state.dto.cryptoObjectId,
      anchorNamespaceId: NAMESPACE_IDS[0],
      requiredNamespaceFingerprint:
        fingerprintRequiredMemoryNamespaces(NAMESPACE_IDS),
      expectedAccessRevision: 0,
      operationRequestDigest: state.crypto.hash(Buffer.from(
        state.dto.signedContentEmbeddingRequestBytesBase64url,
        "base64url",
      )),
      allocationRequestDigest: state.crypto.hash(new Uint8Array([4, 2])),
    });
    const product: HumanMemoryProductCreatePort = {
      ...noOrdinaryIntent,
      lookupReservation: async () => null,
      reserveCreatePlan: async () => ({
        dtoVersion: 1,
        memoryId: MEMORY_ID,
        operationId: state.dto.operationId,
        expectedContentRevision: 0,
        nextContentRevision: 1,
        productAuthority: { mode: "namespace" },
        requiredNamespaceIds: [...NAMESPACE_IDS],
        deadlineAt: 1_800_000_030_000,
      }),
      inspectCreate: async () => inspection === "new"
        ? {
          kind: "new",
          expectedAccessRevision: 0,
          planIssuedAt: 1_800_000_000_000,
          planDeadlineAt,
        }
        : {
          kind: "replay",
          certificate: allocation,
          embedding: {
            provider: "openai",
            canonicalModel: "text-embedding-3-small",
            dimensions: 1536,
            vector: new Array<number>(1536).fill(0.25),
            processorContractVersion: 1,
          },
          alreadyPublished: true,
          ...(fallbackReplay
            ? { ordinaryFallbackReason: "encryption_pending" as const }
            : {}),
          projection: {
            memoryId: MEMORY_ID, contentRevision: 1, cryptoAccessRevision: 0,
            importance: 0.5, tier: 1,
            createdAt: new Date("2026-08-10T00:00:00.000Z"),
            updatedAt: new Date("2026-08-10T00:00:01.000Z"),
            namespaceIds: [...NAMESPACE_IDS], requiredNamespaceIds: [...NAMESPACE_IDS],
            scopeOrigin: undefined,
          },
          planIssuedAt: 1_800_000_000_000,
          planDeadlineAt,
        },
      allocateCreate: async () => allocation,
      authorizeCurrent: async () => true,
      publishOrdinaryFallback: async () => { throw new Error("Unexpected fallback"); },
      publish: async () => ({
        memoryId: MEMORY_ID,
        contentRevision: 1,
        cryptoAccessRevision: 0,
        importance: 0.5,
        tier: 1,
        createdAt: new Date("2026-08-10T00:00:00.000Z"),
        updatedAt: new Date("2026-08-10T00:00:01.000Z"),
        namespaceIds: [...NAMESPACE_IDS],
        requiredNamespaceIds: [...NAMESPACE_IDS],
        scopeOrigin: undefined,
      }),
    };
    const route = createHumanMemoryPreparedCreateRoutePort({
      crypto: state.crypto,
      now: () => 1_800_000_000_000,
      resolveHumanId: async () => "human:1",
      resolveNamespaceAuthority,
      resolveHistoricalDeviceAuthority:
        authorityResolver(state.signingPublicKey),
      resolveHistoricalOrdinaryDeviceAuthority: async () => null,
      resolveCurrentWriteAuthorization: async (context) => ({
        ...context,
        sourceAuthorized: true,
        targetAuthorized: true,
        currentHostAuthorizationRevision: context.hostAuthorizationRevision,
        committerSigningPublicKey: state.signingPublicKey.slice(),
      }),
      foregroundEmbeddingProcessor: {
        embed: async ({ request }) => {
          processorCalls += 1;
          expect(request.plaintext).toBe("kept client-side");
          return {
            status: "embedded",
            embedding: {
              provider: "openai",
              canonicalModel: "text-embedding-3-small",
              dimensions: 1536,
              vector: new Array<number>(1536).fill(0.25),
              processorContractVersion: 1,
            },
          };
        },
      },
      product,
      createCryptoCompletion: (resolveCurrent) => ({
        complete: async (prepared) => {
          completionCalls += 1;
          if (completionFailure !== undefined) throw completionFailure;
          const snapshot = readPreparedHumanMemoryUpdateSnapshot(prepared);
          expect(await resolveCurrent({
            ...snapshot.authority,
            purpose: "authorize-current-human-memory-create-persistence",
            productAllocation: snapshot.productAllocation!,
          })).not.toBeNull();
          return completionCalls === 1 ? "created" : "duplicate";
        },
        verify: async () => null,
      }),
    });
    const authority = {
      userId: "user:1",
      actorId: "actor:1",
      agentId: null,
      memoryMode: "namespace" as const,
      scopeId: null,
      originWritableNamespaceId: null,
      sourceRoomId: null,
      mutableNamespaceIds: [...NAMESPACE_IDS],
      writableNamespaceIds: [...NAMESPACE_IDS],
    };
    expect((await route.createPrepared({ authority, prepared: state.dto })).status)
      .toBe("published");
    inspection = "replay";
    expect((await route.createPrepared({ authority, prepared: state.dto })).status)
      .toBe("replayed");
    expect(processorCalls).toBe(1);
    expect(completionCalls).toBe(1);
    fallbackReplay = true;
    expect((await route.createPrepared({ authority, prepared: state.dto })).status)
      .toBe("ordinary_fallback");
    expect(processorCalls).toBe(1);
    expect(completionCalls).toBe(1);
    fallbackReplay = false;
    inspection = "new";
    completionFailure = new HumanMemoryPreparedRouteError(
      "stale_revision",
      "Human Memory publication allocation is stale",
    );
    expect(await route.createPrepared({ authority, prepared: state.dto })).toEqual({
      dtoVersion: 1, status: "unavailable", reason: "stale_revision",
    });
    completionFailure = new Error("opaque create crypto failure");
    expect(route.createPrepared({ authority, prepared: state.dto })).rejects.toThrow(
      "opaque create crypto failure",
    );
    completionFailure = undefined;
    inspection = "replay";
    planDeadlineAt += 1;
    expect(await route.createPrepared({ authority, prepared: state.dto }))
      .toEqual({
        dtoVersion: 1,
        status: "unavailable",
        reason: "integrity_failure",
      });
    expect(processorCalls).toBe(1);
    expect(completionCalls).toBe(3);
  });
});
