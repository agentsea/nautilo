import { classifyProtectedTaskMetadataV1 } from "@nautilo/types";
import { createPostgresTaskContentCryptoCompletion } from "../../src/server/task/postgres-task-content-crypto-completion.ts";
import { PostgresTaskContentProductStore } from "../../src/server/task/postgres-task-content-product-store.ts";
import { verifyConversationProductPostgresHandle, type ConversationProductPostgresConnection,
  type ConversationProductDatabaseRow, type ConversationProductPostgresScalar } from "../../src/server/message/postgres-conversation-product-store.ts";
import { preparedTaskHistoricalRepairProvenanceV1 } from "../../src/task/task-historical-repair-provenance.ts";
import { fingerprintTaskContentNamespaceV1,
  type TaskContentRevisionStateV1, type TaskContentProductStorePort } from "../../src/task/task-content-repository.ts";
import { createDormantTaskContentShadowRepository } from "../../src/task/task-content-shadow-saga.ts";
import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  createCommonHumanObjectAccessManifest,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  prepareHumanExistingTaskRepresentationPublicationRequest,
  prepareHumanObjectAccessManifestGenesisSet,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import {
  inspectStagedHistoricalTaskContentPublication,
  readInspectedHistoricalTaskContentAccessRevision,
  stageHistoricalTaskContentPublication,
} from "../../src/server/task/postgres-task-historical-content-staging.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";
import type { TaskContentAuthorityV1 } from
  "../../src/task/task-content-authority-v1.ts";
import { deriveTaskHistoricalContentCryptoObjectIdV1 } from
  "../../src/task/task-historical-content-identity.ts";
import {
  authenticatePreparedHistoricalTaskContentCryptoRevisionV1,
  readPreparedHistoricalTaskContentRequestV1,
} from "../../src/task/task-content-prepared-revision.ts";
import { encodeTaskRunResultPayloadV1, encodeTaskPayloadV1 } from "../../src/task/task-payload-v1.ts";

async function expectRejected(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let rejection: unknown;
  try {
    await promise;
  } catch (error) {
    rejection = error;
  }
  expect(rejection).toBeInstanceOf(Error);
  expect((rejection as Error).message).toContain(message);
}

const NOW = 1_900_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000101";
const HUMAN = "20000000-0000-4000-8000-000000000102";
const NAMESPACE = "30000000-0000-4000-8000-000000000103";
const DOMAIN = "40000000-0000-4000-8000-000000000104";
const CLAIM = "50000000-0000-4000-8000-000000000105";
const DEVICE = "historical-device.1";
const OPERATION = "task-historical-definition-publication";
const sourceDigest = new Uint8Array(32).fill(0x11);
const authority = Object.freeze({
  authorityVersion: 1,
  kind: "requester_private_namespace",
  keyClass: "ai",
  requesterHumanId: HUMAN,
  namespaceId: NAMESPACE,
  domainId: DOMAIN,
  expectedAccessRevision: 2,
  expectedPolicyRevision: 7,
} satisfies TaskContentAuthorityV1);

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function cloneRow(row: DatabaseRow): DatabaseRow {
  return Object.freeze(Object.fromEntries(Object.entries(row).map(
    ([key, value]) => [key, value instanceof Uint8Array
      ? Uint8Array.from(value) : value],
  ))) as DatabaseRow;
}

type State = {
  object: DatabaseRow | null;
  manifests: Map<number, DatabaseRow>;
  envelopes: DatabaseRow[];
  head: DatabaseRow | null;
  receipt: DatabaseRow | null;
};

function cloneState(state: State): State {
  return {
    object: state.object === null ? null : cloneRow(state.object),
    manifests: new Map([...state.manifests].map(
      ([revision, row]) => [revision, cloneRow(row)],
    )),
    envelopes: state.envelopes.map(cloneRow),
    head: state.head === null ? null : cloneRow(state.head),
    receipt: state.receipt === null ? null : cloneRow(state.receipt),
  };
}

class HistoricalCryptoConnection implements CryptoPostgresConnection {
  state: State = {
    object: null,
    manifests: new Map(),
    envelopes: [],
    head: null,
    receipt: null,
  };
  failReceipt = false;
  receiptInserts = 0;

  query<Row extends DatabaseRow = DatabaseRow>(
    statement: string,
    _parameters: readonly DatabaseScalar[] = [],
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as unknown as Row[]);
    }
    throw new Error("Historical crypto queries require a transaction");
  }

  async transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    const working = cloneState(this.state);
    const transaction: CryptoPostgresExecutor = {
      query: async <Row extends DatabaseRow = DatabaseRow>(
        statement: string,
        parameters: readonly DatabaseScalar[] = [],
      ): Promise<readonly Row[]> => {
        const normalized = statement.replaceAll('"', "").toLowerCase();
        if (normalized.includes("pg_advisory_xact_lock")) return [];
        if (normalized.includes("from task_historical_content_crypto_staging_receipts")) {
          if (working.receipt === null) return [];
          const objectId = parameters[0];
          const operationId = parameters[1];
          return (working.receipt["crypto_object_id"] === objectId
              || working.receipt["operation_id"] === operationId
            ? [cloneRow(working.receipt)] : []) as Row[];
        }
        if (normalized.includes("insert into task_historical_content_crypto_staging_receipts")) {
          this.receiptInserts += 1;
          if (this.failReceipt) throw new Error("receipt failed");
          working.receipt = {
            crypto_object_id: parameters[0] as string,
            operation_id: parameters[1] as string,
            signed_publication_request_bytes:
              Uint8Array.from(parameters[2] as Uint8Array),
            signed_request_digest: Uint8Array.from(parameters[3] as Uint8Array),
            authority_fingerprint: Uint8Array.from(parameters[4] as Uint8Array),
            genesis_manifest_hash: Uint8Array.from(parameters[5] as Uint8Array),
          };
          return [];
        }
        if (normalized.includes("from crypto_objects")) {
          return (working.object === null ? [] : [cloneRow(working.object)]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_heads")) {
          if (working.head === null) return [];
          const revision = working.head["access_revision"] as number;
          const manifest = working.manifests.get(revision);
          return (manifest === undefined ? [] : [{
            ...cloneRow(working.head),
            ...cloneRow(manifest),
          }]) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")
          && normalized.includes("access_revision >=")) {
          const minimum = Number(parameters[1]);
          const maximum = Number(parameters[2]);
          return [...working.manifests]
            .filter(([revision]) => revision >= minimum && revision <= maximum)
            .sort(([left], [right]) => left - right)
            .map(([, row]) => cloneRow(row)) as Row[];
        }
        if (normalized.includes("from object_crypto_access_manifests")) {
          const manifest = working.manifests.get(Number(parameters[1]));
          return (manifest === undefined ? [] : [cloneRow(manifest)]) as Row[];
        }
        if (normalized.includes("from object_crypto_namespace_envelopes")) {
          return working.envelopes.filter(row =>
            row["object_id"] === parameters[0]
              && row["access_revision"] === Number(parameters[1]))
            .map(cloneRow) as Row[];
        }
        if (normalized.includes("insert into crypto_objects")) {
          working.object = {
            object_id: parameters[0] as string,
            payload_hash: Uint8Array.from(parameters[1] as Uint8Array),
            payload_bytes: Uint8Array.from(parameters[2] as Uint8Array),
          };
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_manifests")) {
          working.manifests.set(Number(parameters[1]), {
            object_id: parameters[0] as string,
            access_revision: Number(parameters[1]),
            manifest_hash: Uint8Array.from(parameters[2] as Uint8Array),
            previous_manifest_hash: parameters[3] === null ? null
              : Uint8Array.from(parameters[3] as Uint8Array),
            payload_hash: Uint8Array.from(parameters[4] as Uint8Array),
            manifest_bytes: Uint8Array.from(parameters[5] as Uint8Array),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_namespace_envelopes")) {
          working.envelopes.push({
            object_id: parameters[0] as string,
            access_revision: Number(parameters[1]),
            namespace_id: parameters[2] as string,
            ordinal: Number(parameters[3]),
            envelope_hash: Uint8Array.from(parameters[4] as Uint8Array),
            envelope_bytes: Uint8Array.from(parameters[5] as Uint8Array),
          });
          return [];
        }
        if (normalized.includes("insert into object_crypto_access_heads")) {
          working.head = {
            object_id: parameters[0] as string,
            access_revision: Number(parameters[1]),
            manifest_hash: Uint8Array.from(parameters[2] as Uint8Array),
          };
          return [];
        }
        throw new Error(`Unexpected historical crypto SQL: ${statement.trim()}`);
      },
    };
    const result = await callback(transaction);
    this.state = working;
    return result;
  }
}

type Environment = Awaited<ReturnType<typeof environment>>;

async function environment(kind: "definition" | "run_result" = "definition") {
  const coordinate = kind === "definition" ? { kind, taskId: TASK, contentRevision: 1 } as const
    : { kind, taskId: TASK, taskRunId: "10000000-0000-4000-8000-000000000106", contentRevision: 1 } as const;
  let objectDek = new Uint8Array();
  const crypto = new LatticeCrypto(seededRng(31), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const sourcePayloadHash = new Uint8Array(32).fill(0x22);
  const planDigest = new Uint8Array(32).fill(0x33);
  const operationalFieldsDigest = new Uint8Array(32).fill(0x44);
  const objectIdentity = deriveTaskHistoricalContentCryptoObjectIdV1({
    coordinate,
    sourceDigest,
    namespaceId: NAMESPACE,
  });
  async function prepare() {
    const plaintext = kind === "run_result" ? encodeTaskRunResultPayloadV1({ formatVersion: 1,
      resultText: "Historical result", lastError: null }) : encodeTaskPayloadV1({
      formatVersion: 1,
      prompt: "Historical private Task",
      expectedOutput: null,
      protectedMetadata: {},
    });
    const encrypted = encryptObjectPayload(crypto, {
      objectId: objectId(objectIdentity),
      keyClass: "ai",
      objectType: kind === "definition" ? "nautilo-task-definition-v1" : "nautilo-task-run-result-v1",
      createdAt: unixTimestamp(NOW),
    }, plaintext);
    plaintext.fill(0);
    const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
    const envelopeBytes = encodeNamespaceObjectEnvelopeV2(
      wrapObjectDekForNamespace(crypto, new Uint8Array(32).fill(0x51), {
        objectId: objectId(objectIdentity),
        namespaceId: namespaceId(NAMESPACE),
        keyClass: "ai",
        keyGeneration: namespaceGeneration(4),
        bindingRevisionAtWrap: accessRevision(authority.expectedAccessRevision),
      }, encrypted.dek),
    );
    objectDek = Uint8Array.from(encrypted.dek);
    encrypted.dek.fill(0);
    const access = prepareHumanObjectAccessManifestGenesisSet(crypto, {
      objectId: objectIdentity,
      payloadHash: crypto.hash(payloadBytes),
      envelopeBytes: [envelopeBytes],
      sourceAuthorized: true,
      targetAuthorized: true,
      subjectHumanId: HUMAN,
      committerDeviceId: DEVICE,
      hostAuthorizationRevision: 3,
      committerSigningPublicKey: signer.publicKey,
      committerSigningPrivateKey: signer.privateKey,
    });
    const signed = prepareHumanExistingTaskRepresentationPublicationRequest(
      crypto,
      {
        kind,
        entityId: coordinate.kind === "definition" ? TASK : coordinate.taskRunId,
        taskId: TASK,
        claimId: CLAIM,
        operationId: OPERATION,
        cryptoObjectId: objectIdentity,
        sourceDigest,
        sourcePayloadHash,
        planDigest,
        operationalFieldsDigest,
        expectedContentRevision: 0,
        nextContentRevision: 1,
        expectedCryptoAccessRevision: 0,
        resultCryptoAccessRevision: 0,
        subjectHumanId: HUMAN,
        committerDeviceId: DEVICE,
        hostAuthorizationRevision: 3,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        expectedNamespaceAccessRevision: authority.expectedAccessRevision,
        expectedPolicyRevision: authority.expectedPolicyRevision,
        bindingHash: new Uint8Array(32).fill(0x55),
        keyGeneration: 4,
        payloadHash: crypto.hash(payloadBytes),
        manifestHash: crypto.hash(access.manifestBytes),
        envelopeHash: crypto.hash(envelopeBytes),
        issuedAt: NOW,
        deadlineAt: NOW + 30_000,
        committerSigningPublicKey: signer.publicKey,
        committerSigningPrivateKey: signer.privateKey,
      },
    );
    return authenticatePreparedHistoricalTaskContentCryptoRevisionV1({
      crypto,
      now: NOW,
      operationId: OPERATION,
      claimId: CLAIM,
      coordinate,
      authority,
      sourceDigest,
      sourcePayloadHash,
      planDigest,
      operationalFieldsDigest,
      payloadBytes,
      manifestBytes: access.manifestBytes,
      envelopeBytes,
      signedPublicationRequestBytes: signed.bytes,
      resolveCurrentAuthority: async () => signer.publicKey,
    });
  }
  const connection = new HistoricalCryptoConnection();
  const handle = await verifyCryptoPostgresHandle(connection);
  const history = {
    resolveHistoricalHumanDeviceSigningPublicKey: async () => signer.publicKey,
    resolveHistoricalAgentSignerAuthority: async () => null,
  };
  return {
    crypto,
    coordinate,
    rewrap(nextNamespaceRevision: number) {
      const previous = connection.state.manifests.get(0)!;
      const envelopeBytes = encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(crypto,
        new Uint8Array(32).fill(0x52), { objectId: objectId(objectIdentity), namespaceId: namespaceId(NAMESPACE),
          keyClass: "ai", keyGeneration: namespaceGeneration(5),
          bindingRevisionAtWrap: accessRevision(nextNamespaceRevision) }, objectDek));
      const manifest = createCommonHumanObjectAccessManifest(crypto, {
        objectId: objectId(objectIdentity), payloadHash: previous["payload_hash"] as Uint8Array,
        accessRevision: accessRevision(1), previousManifestHash: previous["manifest_hash"] as Uint8Array,
        envelopeHashes: [crypto.hash(envelopeBytes)], signer: { kind: "human_device", subjectHumanId: humanId(HUMAN),
          committerDeviceId: cryptoDeviceId(DEVICE) }, signerAuthorizationHash: null,
        hostAuthorizationRevision: authorizationRevision(3),
      }, signer.privateKey);
      connection.state.manifests.set(1, { object_id: objectIdentity, access_revision: 1,
        manifest_hash: manifest.hash, previous_manifest_hash: previous["manifest_hash"]!,
        payload_hash: previous["payload_hash"]!, manifest_bytes: manifest.bytes });
      connection.state.envelopes = connection.state.envelopes.filter(row => row["access_revision"] !== 1);
      connection.state.envelopes.push({ object_id: objectIdentity, access_revision: 1, namespace_id: NAMESPACE,
        ordinal: 0, envelope_hash: crypto.hash(envelopeBytes), envelope_bytes: envelopeBytes });
      connection.state.head = { object_id: objectIdentity, access_revision: 1, manifest_hash: manifest.hash };
    },
    prepare,
    connection,
    handle,
    history,
    objectIdentity,
    sourcePayloadHash,
    operationalFieldsDigest,
    historicalSignerPublicKey: Uint8Array.from(signer.publicKey),
  };
}

function expected(environment: Environment) {
  return {
    objectId: environment.objectIdentity,
    expected: {
      coordinate: environment.coordinate,
      operationId: OPERATION,
      sourceDigest,
      sourcePayloadHash: environment.sourcePayloadHash,
      operationalFieldsDigest: environment.operationalFieldsDigest,
      requesterHumanId: HUMAN,
      namespaceId: NAMESPACE,
    },
  };
}

describe("historical Task content staging", () => {
  test("atomically stages authentic crypto and reconstructs retained prepared custody", async () => {
    const f = await environment();
    const prepared = await f.prepare();
    let assertions = 0;
    expect(await stageHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      prepared,
      currentAuthority: authority,
      assertCurrent: () => { assertions += 1; },
    })).toBe("staged");
    expect(f.connection.state.object).not.toBeNull();
    expect(f.connection.state.receipt).not.toBeNull();
    expect(assertions).toBeGreaterThanOrEqual(3);

    const historicalDevices: string[] = [];
    const staged = await inspectStagedHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: new LatticeCrypto(seededRng(77), {
        now: () => NOW + 120_000,
      }),
      ...expected(f),
      currentAuthority: { ...authority, expectedPolicyRevision: 8 },
      assertCurrent: () => { assertions += 1; },
      resolveHistoricalHumanDeviceSigningPublicKey: async candidate => {
        historicalDevices.push(candidate.committerDeviceId);
        return candidate.committerDeviceId === DEVICE
          ? Uint8Array.from(f.historicalSignerPublicKey)
          : null;
      },
    });
    expect(staged).not.toBeNull();
    if (staged === null) throw new Error("Expected staged publication");
    expect(readPreparedHistoricalTaskContentRequestV1(staged.prepared))
      .toMatchObject({ operationId: OPERATION, cryptoObjectId: f.objectIdentity });
    expect(staged.originalAuthority).toEqual(authority);
    expect(historicalDevices).toContain(DEVICE);
    staged.signedRequestDigest.fill(0);
    expect(readPreparedHistoricalTaskContentRequestV1(staged.prepared).sourceDigest)
      .toEqual(sourceDigest);
  });

  test("replays exact preparation but refuses different randomized bytes", async () => {
    const f = await environment();
    const prepared = await f.prepare();
    const input = {
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      currentAuthority: authority,
      assertCurrent: () => undefined,
    };
    expect(await stageHistoricalTaskContentPublication({ ...input, prepared }))
      .toBe("staged");
    expect(await stageHistoricalTaskContentPublication({ ...input, prepared }))
      .toBe("already_staged");
    const different = await f.prepare();
    await expectRejected(stageHistoricalTaskContentPublication({
      ...input,
      prepared: different,
    }), "different prepared bytes");
  });

  test("rolls back crypto when the append-only receipt cannot commit", async () => {
    const f = await environment();
    f.connection.failReceipt = true;
    await expectRejected(stageHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      prepared: await f.prepare(),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    }), "receipt failed");
    expect(f.connection.state.object).toBeNull();
    expect(f.connection.state.receipt).toBeNull();
  });

  test("rolls back an inserted receipt when the current source fence closes", async () => {
    const f = await environment();
    await expectRejected(stageHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      prepared: await f.prepare(),
      currentAuthority: authority,
      assertCurrent: () => {
        if (f.connection.receiptInserts !== 0) {
          throw new Error("source claim closed");
        }
      },
    }), "source claim closed");
    expect(f.connection.receiptInserts).toBe(1);
    expect(f.connection.state.object).toBeNull();
    expect(f.connection.state.receipt).toBeNull();
  });

  test("classifies a valid staged object awaiting a newer Namespace wrap", async () => {
    const f = await environment();
    await stageHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      prepared: await f.prepare(),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    });
    const error = await inspectStagedHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      ...expected(f),
      currentAuthority: {
        ...authority,
        expectedAccessRevision: authority.expectedAccessRevision + 1,
        expectedPolicyRevision: authority.expectedPolicyRevision + 1,
      },
      assertCurrent: () => undefined,
    }).catch((reason: unknown) => reason);
    expect(error).toMatchObject({
      name: "ClassifiedDataOperationError",
      failureClass: "key_waiting",
    });
  });

  test("binds the receipt to all independently classified source commitments", async () => {
    for (const changed of ["payload", "operational", "operation"] as const) {
      const f = await environment();
      await stageHistoricalTaskContentPublication({
        ...f.history,
        handle: f.handle,
        crypto: f.crypto,
        prepared: await f.prepare(),
        currentAuthority: authority,
        assertCurrent: () => undefined,
      });
      const baseline = expected(f);
      await expectRejected(inspectStagedHistoricalTaskContentPublication({
        ...f.history,
        handle: f.handle,
        crypto: f.crypto,
        objectId: baseline.objectId,
        expected: {
          ...baseline.expected,
          ...(changed === "payload" ? {
            sourcePayloadHash: new Uint8Array(32).fill(0x61),
          } : changed === "operational" ? {
            operationalFieldsDigest: new Uint8Array(32).fill(0x62),
          } : { operationId: "another-historical-operation" }),
        },
        currentAuthority: authority,
        assertCurrent: () => undefined,
      }), changed === "operation"
        ? "receipt coordinates conflict"
        : "signed source conflicts");
    }
  });

  test("rejects substituted receipt genesis and durable object bytes", async () => {
    const genesis = await environment();
    await stageHistoricalTaskContentPublication({
      ...genesis.history,
      handle: genesis.handle,
      crypto: genesis.crypto,
      prepared: await genesis.prepare(),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    });
    genesis.connection.state.receipt = {
      ...genesis.connection.state.receipt!,
      genesis_manifest_hash: new Uint8Array(32).fill(0x71),
    };
    await expectRejected(inspectStagedHistoricalTaskContentPublication({
      ...genesis.history,
      handle: genesis.handle,
      crypto: genesis.crypto,
      ...expected(genesis),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    }), "durable publication conflicts");

    const object = await environment();
    await stageHistoricalTaskContentPublication({
      ...object.history,
      handle: object.handle,
      crypto: object.crypto,
      prepared: await object.prepare(),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    });
    const stored = object.connection.state.object!;
    object.connection.state.object = {
      ...stored,
      payload_bytes: new Uint8Array([0x01]),
    };
    await expectRejected(inspectStagedHistoricalTaskContentPublication({
      ...object.history,
      handle: object.handle,
      crypto: object.crypto,
      ...expected(object),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    }), "substituted bytes");
  });

  test("fails closed for a bare object, changed source, or backwards authority", async () => {
    const f = await environment();
    f.connection.state.object = {
      object_id: f.objectIdentity,
      payload_hash: new Uint8Array(32),
      payload_bytes: new Uint8Array([1]),
    };
    await expectRejected(inspectStagedHistoricalTaskContentPublication({
      ...f.history,
      handle: f.handle,
      crypto: f.crypto,
      ...expected(f),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    }), "no staging receipt");

    const clean = await environment();
    expect(await inspectStagedHistoricalTaskContentPublication({
      ...clean.history,
      handle: clean.handle,
      crypto: clean.crypto,
      ...expected(clean),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    })).toBeNull();
    await expectRejected(inspectStagedHistoricalTaskContentPublication({
      ...clean.history,
      handle: clean.handle,
      crypto: clean.crypto,
      objectId: clean.objectIdentity,
      expected: { ...expected(clean).expected,
        sourceDigest: new Uint8Array(32).fill(0x77) },
      currentAuthority: authority,
      assertCurrent: () => undefined,
    }), "expected source");

    const staged = await environment();
    await stageHistoricalTaskContentPublication({
      ...staged.history,
      handle: staged.handle,
      crypto: staged.crypto,
      prepared: await staged.prepare(),
      currentAuthority: authority,
      assertCurrent: () => undefined,
    });
    await expectRejected(inspectStagedHistoricalTaskContentPublication({
      ...staged.history,
      handle: staged.handle,
      crypto: staged.crypto,
      ...expected(staged),
      currentAuthority: { ...authority, expectedPolicyRevision: 6 },
      assertCurrent: () => undefined,
    }), "signed source conflicts");
  });
});

for (const kind of ["definition", "run_result"] as const) {
  test(`${kind}: stage survives product loss and maps the authenticated rewrapped head under a new claim`, async () => {
    const f = await environment(kind);
    const originalPrepared = await f.prepare();
    await stageHistoricalTaskContentPublication({ ...f.history, handle: f.handle, crypto: f.crypto,
      prepared: originalPrepared, currentAuthority: authority, assertCurrent: () => undefined });
    // No product reservation survived. A canonical signed rewrap retains the
    // original payload/genesis and advances only the access chain.
    const originalPayload = Uint8Array.from(f.connection.state.object!["payload_bytes"] as Uint8Array);
    f.rewrap(3);
    const current = { ...authority, expectedAccessRevision: 3, expectedPolicyRevision: 8 };
    const staged = await inspectStagedHistoricalTaskContentPublication({ ...f.history, handle: f.handle,
      crypto: f.crypto, ...expected(f), currentAuthority: current, assertCurrent: () => undefined });
    if (staged === null) throw new Error("Missing staged fixture");
    const provenance = preparedTaskHistoricalRepairProvenanceV1(staged.prepared);
    const proofCoordinates = { coordinate: f.coordinate, objectId: f.objectIdentity,
      currentAuthority: current, provenance };
    expect(readInspectedHistoricalTaskContentAccessRevision(staged.prepared, proofCoordinates)).toBe(1);
    expect(() => readInspectedHistoricalTaskContentAccessRevision({ ...staged.prepared }, proofCoordinates)).toThrow();
    for (const changed of [
      { ...current, domainId: `${DOMAIN}.other` },
      { ...current, expectedAccessRevision: 4 },
      { ...current, expectedPolicyRevision: 9 },
    ]) expect(() => readInspectedHistoricalTaskContentAccessRevision(staged.prepared,
      { ...proofCoordinates, currentAuthority: changed })).toThrow();
    expect(() => readInspectedHistoricalTaskContentAccessRevision(staged.prepared,
      { ...proofCoordinates, provenance: { ...provenance, sourceDigest: "00".repeat(32) } })).toThrow();

    const metadata = classifyProtectedTaskMetadataV1({});
    if (metadata.status !== "supported") throw new Error("Invalid fixture metadata");
    const state: TaskContentRevisionStateV1 = { product: null, authority: current, lifecycle: {
      sequence: 1, coordinate: f.coordinate, operationId: OPERATION,
      requestDigest: staged.signedRequestDigest, requesterHumanId: HUMAN, namespaceId: NAMESPACE,
      cryptoObjectId: f.objectIdentity, objectType: staged.prepared.objectType, payloadVersion: 1,
      representation: "dual", authorityFingerprint: staged.authorityFingerprint,
      requiredNamespaceFingerprint: fingerprintTaskContentNamespaceV1(NAMESPACE),
      operationalMetadata: kind === "definition" ? metadata.operational : null, historicalRepair: provenance,
      completion: "complete", disposition: "active", attemptCount: 0, nextAttemptAt: null,
      leaseToken: null, leaseExpiresAt: null, failureCode: null, cryptoCompletedAt: new Date(NOW),
    } };
    const row = { sequence: 1, task_id: TASK,
      ...(kind === "definition" ? { content_revision: 1 } : { task_run_id: f.coordinate.kind === "run_result" ? f.coordinate.taskRunId : "", result_revision: 1 }),
      operation_id: OPERATION, request_digest: staged.signedRequestDigest,
      authority_fingerprint: staged.authorityFingerprint, requester_human_id: HUMAN,
      content_namespace_id: NAMESPACE, crypto_object_id: f.objectIdentity, payload_version: 1,
      representation: "dual", required_namespace_fingerprint: state.lifecycle.requiredNamespaceFingerprint,
      operational_metadata: "{}", historical_repair: provenance, completion: "complete", disposition: "active",
      attempt_count: 0, next_attempt_at: null, lease_token: null, lease_expires_at: null,
      failure_code: null, crypto_completed_at: new Date(NOW), lease_is_live: true,
    } as unknown as ConversationProductDatabaseRow;
    const owner = "requester-owner";
    const mappedRevisions: number[] = [];
    let sourceCurrent = true;
    const query = async <Row extends ConversationProductDatabaseRow>(statement: string,
      parameters: readonly ConversationProductPostgresScalar[] = []): Promise<readonly Row[]> => {
      let rows: readonly ConversationProductDatabaseRow[];
      if (statement.includes("current_user")) rows = [{ current_user: "nautilo", session_user: "nautilo" }];
      else if (statement.includes('from "encryption_transition_policy"')) rows = [{ mode: "shadow_encryption", revision: 8 }];
      else if (statement.includes('from "actors"')) rows = [{ owner_id: owner }];
      else if (statement.includes('from "task_definition_crypto_revisions"') || statement.includes('from "task_run_result_crypto_revisions"')) rows = [row];
      else if (statement.includes('from "tasks"')) rows = [{ task_id: TASK, owner_id: owner, requestor_id: owner,
        task_status: "completed", namespace_id: NAMESPACE, content_revision: 0, content_namespace_id: null,
        content_representation: "ordinary", crypto_object_id: null, crypto_access_revision: 0,
        crypto_required_namespace_fingerprint: null, crypto_mapping_state: "unmapped" }];
      else if (statement.includes('from "task_runs"')) rows = [{ task_id: TASK, run_status: "completed",
        result_revision: 0, result_content_namespace_id: null, result_representation: "ordinary",
        crypto_object_id: null, crypto_access_revision: 0, crypto_mapping_state: "unmapped" }];
      else if (statement.startsWith('update "tasks"') || statement.startsWith('update "task_runs"')) {
        const field = kind === "definition" ? "crypto_access_revision" : "result_crypto_access_revision";
        const match = new RegExp(`"${field}" = \\$(\\d+)`).exec(statement);
        if (match === null) throw new Error("Missing mapped access revision assignment");
        mappedRevisions.push(Number(parameters[Number(match[1]) - 1]));
        rows = [{ task_id: TASK, task_run_id: TASK }];
      } else if (statement.startsWith('update "task_definition_crypto_revisions"') || statement.startsWith('update "task_run_result_crypto_revisions"')) rows = [{ ...row, disposition: "mapped" }];
      else throw new Error(`Unexpected product query: ${statement}`);
      return rows as readonly Row[];
    };
    const connection: ConversationProductPostgresConnection = { query,
      transaction: use => use({ query }) };
    const store = new PostgresTaskContentProductStore(await verifyConversationProductPostgresHandle(connection),
      () => current, undefined, undefined, async (_tx, proof) => {
        // The new claim's source fence validates immutable original provenance;
        // its own fresh claim identifier does not rewrite the signed receipt.
        expect(proof.provenance).toEqual(provenance);
        return sourceCurrent;
      });
    let observedState = state;
    const unexpected = async (): Promise<never> => { throw new Error("Unexpected product mutation"); };
    const product: TaskContentProductStorePort = {
      reserveRevision: unexpected, getRevisionByOperation: unexpected,
      quarantineRevision: unexpected, markAuthorityStale: unexpected,
      claimReconciliationCandidates: unexpected, failReconciliationClaim: unexpected,
      getRevision: async () => observedState, markCryptoComplete: async () => "duplicate" as const,
      compareAndSwapCryptoMapping: store.compareAndSwapCryptoMapping.bind(store) };
    const crypto = createPostgresTaskContentCryptoCompletion({ ...f.history, handle: f.handle,
      crypto: f.crypto, resolveCurrentAuthority: async () => current });
    const repository = createDormantTaskContentShadowRepository({ product, crypto });
    await expectRejected(repository.completeRevision({ coordinate: f.coordinate, prepared: originalPrepared }), "verification is unavailable");
    expect(mappedRevisions).toEqual([]);
    sourceCurrent = false;
    await expectRejected(repository.completeRevision({ coordinate: f.coordinate, prepared: staged.prepared }), "source authority");
    expect(mappedRevisions).toEqual([]);
    sourceCurrent = true;
    f.rewrap(4);
    await expectRejected(repository.completeRevision({ coordinate: f.coordinate, prepared: staged.prepared }), "durable bytes");
    expect(mappedRevisions).toEqual([]);
    f.rewrap(3);
    expect((await repository.completeRevision({ coordinate: f.coordinate, prepared: staged.prepared })).status).toBe("mapped");
    expect(mappedRevisions).toEqual([1]);
    expect(f.connection.state.object!["payload_bytes"]).toEqual(originalPayload);
    expect(f.connection.receiptInserts).toBe(1);
    observedState = { ...state, lifecycle: { ...state.lifecycle, disposition: "mapped" },
      product: { coordinate: f.coordinate, namespaceId: NAMESPACE, representation: "dual",
        cryptoObjectId: f.objectIdentity, cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: state.lifecycle.requiredNamespaceFingerprint, cryptoMappingState: "verified" } };
    await expectRejected(repository.completeRevision({ coordinate: f.coordinate, prepared: staged.prepared }), "verification is unavailable");
    observedState = { ...observedState, product: { ...observedState.product!, cryptoAccessRevision: 1 } };
    expect((await repository.completeRevision({ coordinate: f.coordinate, prepared: staged.prepared })).status).toBe("replayed");
    expect(mappedRevisions).toEqual([1]);
    staged.prepared.authorityFingerprint[0] = staged.prepared.authorityFingerprint[0]! ^ 1;
    expect(() => readInspectedHistoricalTaskContentAccessRevision(staged.prepared, proofCoordinates)).toThrow();
  });
}
