import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  encryptObjectPayload,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import { ProcessorReconciliationIntegrityErrorV2 } from "@nautilo/lattice-crypto/background";
import {
  decodeObjectAccessManifestV5,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";

import { createPostgresCurrentProcessorReconciliationObjectVerifier } from "../../src/server/storage/postgres-current-processor-reconciliation-input.ts";
import { ClassifiedDataOperationError } from "../../src/transition/encryption-data-operation-owner.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/storage/postgres-lattice-storage.ts";
import type {
  DatabaseRow,
  DatabaseScalar,
} from "../../src/server/storage/postgres-record-codecs.ts";
import { currentProcessorCertificateFixtureV2 } from "../helpers/current-processor-certificate-v2.ts";

const OBJECT_ID = objectId("journal:current-reconciliation:1");
const PLAINTEXT = new TextEncoder().encode("current reconciliation payload");

function normalizedSql(statement: string): string {
  return statement
    .replaceAll('"', "")
    .replaceAll(/\s+/gu, " ")
    .trim()
    .toLowerCase();
}

function changed(value: Uint8Array): Uint8Array {
  const result = new Uint8Array(value);
  result[result.length - 1]! ^= 1;
  return result;
}

async function rejectsWithIntegrity(work: Promise<unknown>): Promise<void> {
  const error = await rejection(work);
  expect(error).toBeInstanceOf(ProcessorReconciliationIntegrityErrorV2);
}

async function rejection(work: Promise<unknown>): Promise<unknown> {
  return work.then(
    () => null,
    (cause: unknown) => cause,
  );
}

async function fixture(
  input: Readonly<{
    currentVersion?: 4 | 5;
    slotMismatch?: boolean;
    transactionSteps?: readonly (
      "success" | "reject" | "abort" | "serialize"
    )[];
  }> = {},
) {
  const materialCrypto = new LatticeCrypto();
  const createdAt = 1_800_000_000_000;
  const encrypted = encryptObjectPayload(
    materialCrypto,
    {
      objectId: OBJECT_ID,
      keyClass: "ai",
      objectType: "nautilo.reflection.record.v1",
      createdAt: unixTimestamp(input.slotMismatch ? createdAt + 1 : createdAt),
    },
    PLAINTEXT,
  );
  const envelope = wrapObjectDekForNamespace(
    materialCrypto,
    new Uint8Array(32).fill(0x51),
    {
      objectId: OBJECT_ID,
      namespaceId: namespaceId("namespace-current-certificate-v3"),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(3),
      bindingRevisionAtWrap: accessRevision(8),
    },
    encrypted.dek,
  );
  encrypted.dek.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  encrypted.payload.ciphertext.fill(0);
  envelope.wrappedDek.fill(0);
  const current = await currentProcessorCertificateFixtureV2({
    now: createdAt,
    objects: [
      {
        objectId: OBJECT_ID,
        payloadHash: materialCrypto.hash(payloadBytes),
        envelopeHash: materialCrypto.hash(envelopeBytes),
        createdAt,
      },
    ],
  });
  const signed = current.manifests[0]!;
  const genesisBytes =
    input.currentVersion === 5 ? signed.v5Bytes : signed.v4Bytes;
  const genesisRow: Record<string, DatabaseScalar> = {
    object_id: OBJECT_ID,
    payload_hash: current.crypto.hash(payloadBytes),
    payload_bytes: payloadBytes,
    manifest_object_id: OBJECT_ID,
    manifest_access_revision: 0,
    manifest_payload_hash: current.crypto.hash(payloadBytes),
    manifest_hash: current.crypto.hash(genesisBytes),
    previous_manifest_hash: null,
    manifest_bytes: genesisBytes,
  };
  const headBytes =
    input.currentVersion === 5 ? signed.v5Bytes : signed.v4Bytes;
  const currentObjectRow: Record<string, DatabaseScalar> = {
    object_id: OBJECT_ID,
    payload_hash: current.crypto.hash(payloadBytes),
    payload_bytes: payloadBytes,
  };
  const currentHeadRow: Record<string, DatabaseScalar> = {
    object_id: OBJECT_ID,
    access_revision: 0,
    manifest_hash: current.crypto.hash(headBytes),
    previous_manifest_hash: null,
    payload_hash: current.crypto.hash(payloadBytes),
    manifest_bytes: headBytes,
  };
  const currentEnvelopeRow: Record<string, DatabaseScalar> = {
    namespace_id: current.descriptor.authority.namespaceId,
    ordinal: 0,
    envelope_hash: current.crypto.hash(envelopeBytes),
    envelope_bytes: envelopeBytes,
  };
  const queries: {
    statement: string;
    parameters: readonly DatabaseScalar[];
  }[] = [];
  let missingObject = false;
  let missingGenesis = false;
  let queryFailure: Readonly<{ pattern: string; error: Error }> | undefined;
  const controller = new AbortController();
  const transactionError = new Error("injected transaction completion failure");
  const capturedCandidates: Readonly<{
    payloadBytes: Uint8Array;
    namespaceEnvelopeBytes: Uint8Array;
  }>[] = [];
  let transactionAttempt = 0;
  const connection: CryptoPostgresConnection = {
    query: <Row extends DatabaseRow = DatabaseRow>(
      statement: string,
      parameters: readonly DatabaseScalar[] = [],
    ) => {
      queries.push({ statement, parameters: [...parameters] });
      const sql = normalizedSql(statement);
      if (queryFailure !== undefined && sql.includes(queryFailure.pattern)) {
        throw queryFailure.error;
      }
      let rows: readonly DatabaseRow[];
      if (sql.includes("current_user::text")) {
        rows = [
          { current_user: "nautilo_crypto", session_user: "nautilo_crypto" },
        ];
      } else if (sql.includes("set transaction isolation level")) {
        rows = [];
      } else if (
        sql.includes("from crypto_objects") &&
        sql.includes("left join object_crypto_access_manifests")
      ) {
        rows = missingObject
          ? []
          : [
              missingGenesis
                ? {
                    ...genesisRow,
                    manifest_object_id: null,
                    manifest_access_revision: null,
                    manifest_payload_hash: null,
                    manifest_hash: null,
                    previous_manifest_hash: null,
                    manifest_bytes: null,
                  }
                : genesisRow,
            ];
      } else if (sql.includes("from processor_crypto_signer_authorizations")) {
        rows = sql.startsWith("select authorization_bytes")
          ? [{ authorization_bytes: current.authorizationBytes }]
          : [current.authorizationRow];
      } else if (sql.includes("from human_crypto_devices")) {
        rows = [current.deviceRow];
      } else if (sql.includes("from crypto_objects")) {
        rows = [currentObjectRow];
      } else if (sql.includes("from object_crypto_access_heads")) {
        rows = [currentHeadRow];
      } else if (sql.includes("from object_crypto_namespace_envelopes")) {
        rows = [currentEnvelopeRow];
      } else {
        throw new Error(`Unexpected reconciliation SQL: ${statement}`);
      }
      return Promise.resolve(rows as readonly Row[]);
    },
    transaction: async <Result>(
      use: (transaction: CryptoPostgresConnection) => Promise<Result>,
    ) => {
      const result = await use(connection);
      if (
        typeof result === "object" &&
        result !== null &&
        "payloadBytes" in result &&
        result.payloadBytes instanceof Uint8Array &&
        "namespaceEnvelopeBytes" in result &&
        result.namespaceEnvelopeBytes instanceof Uint8Array
      ) {
        capturedCandidates.push(
          result as Readonly<{
            payloadBytes: Uint8Array;
            namespaceEnvelopeBytes: Uint8Array;
          }>,
        );
      }
      const step = input.transactionSteps?.[transactionAttempt++] ?? "success";
      if (step === "abort") controller.abort(transactionError);
      if (step === "reject") throw transactionError;
      if (step === "serialize") {
        const serialization = new Error(
          "injected serialization retry",
        ) as Error & { code: string };
        serialization.code = "40001";
        throw serialization;
      }
      return result;
    },
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  const original = {
    requestId: current.descriptor.requestId,
    recipientGeneration: current.descriptor.recipientGeneration,
    descriptorHash: current.crypto.hash(
      current.authorizationRow.work_descriptor_bytes,
    ),
  };
  return {
    current,
    handle,
    original,
    payloadBytes,
    envelopeBytes,
    genesisRow,
    currentObjectRow,
    currentHeadRow,
    currentEnvelopeRow,
    queries,
    controller,
    transactionError,
    capturedCandidates,
    missingObject: () => {
      missingObject = true;
    },
    missingGenesis: () => {
      missingGenesis = true;
    },
    failQuery: (pattern: string, error: Error) => {
      queryFailure = { pattern, error };
    },
  };
}

function verifier(
  value: Awaited<ReturnType<typeof fixture>>,
  original = value.original,
  verifyV5Input?: Parameters<
    typeof createPostgresCurrentProcessorReconciliationObjectVerifier
  >[0]["verifyV5Input"],
) {
  return createPostgresCurrentProcessorReconciliationObjectVerifier({
    handle: value.handle,
    crypto: value.current.crypto,
    original,
    ...(verifyV5Input === undefined ? {} : { verifyV5Input }),
  });
}

describe("PostgreSQL current processor reconciliation input", () => {
  test("authenticates exact V4 genesis and current payload after issuing-device revocation", async () => {
    const value = await fixture();
    const result = await verifier(value).verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    });
    if (result === null) throw new Error("Expected a verified Journal object");

    expect(result).toEqual({
      objectId: OBJECT_ID,
      namespaceId: value.current.descriptor.authority.namespaceId,
      domainId: value.current.descriptor.authority.domainId,
      workId: value.current.descriptor.workId,
      rebuildGeneration: value.current.descriptor.source.rebuildGeneration,
      outputOrdinal: 0,
      authorizedOutputObjectIds: [OBJECT_ID],
      publisherNamespaceAccessRevision:
        value.current.descriptor.authority.namespaceAccessRevision,
      payloadBytes: value.payloadBytes,
      namespaceEnvelopeBytes: value.envelopeBytes,
    });
    expect(result?.payloadBytes).not.toBe(value.payloadBytes);
    expect(result?.namespaceEnvelopeBytes).not.toBe(value.envelopeBytes);
    expect(value.payloadBytes.some((byte) => byte !== 0)).toBe(true);
    expect(value.envelopeBytes.some((byte) => byte !== 0)).toBe(true);
    expect(value.capturedCandidates).toHaveLength(1);
    expect(value.capturedCandidates[0]).toBe(result);
    expect(value.current.deviceRow.state).toBe("revoked");
    expect(
      value.queries.some(({ statement }) =>
        normalizedSql(statement).includes(
          "background_crypto_authorization_requests",
        ),
      ),
    ).toBe(false);
    const genesisQuery = value.queries.find(({ statement }) =>
      normalizedSql(statement).includes(
        "left join object_crypto_access_manifests",
      ),
    );
    expect(genesisQuery?.parameters).toContain(0);
    expect(genesisQuery?.parameters).toContain(OBJECT_ID);
  });

  test.each(["request", "generation", "descriptor hash"] as const)(
    "rejects substituted original %s binding",
    async (kind) => {
      const value = await fixture();
      const original = {
        requestId:
          kind === "request" ? "other-request" : value.original.requestId,
        recipientGeneration:
          kind === "generation"
            ? value.original.recipientGeneration + 1
            : value.original.recipientGeneration,
        descriptorHash:
          kind === "descriptor hash"
            ? changed(value.original.descriptorHash)
            : value.original.descriptorHash,
      };
      await rejectsWithIntegrity(
        verifier(value, original).verify({
          objectId: OBJECT_ID,
          signal: new AbortController().signal,
        }),
      );
    },
  );

  test("rejects an authenticated object whose payload differs from its descriptor slot", async () => {
    const value = await fixture({ slotMismatch: true });
    await rejectsWithIntegrity(
      verifier(value).verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      }),
    );
  });

  test.each(["genesis", "payload", "current head"] as const)(
    "rejects tampered %s bytes",
    async (kind) => {
      const value = await fixture();
      if (kind === "genesis") {
        const manifest = changed(
          value.genesisRow["manifest_bytes"] as Uint8Array,
        );
        value.genesisRow["manifest_bytes"] = manifest;
        value.genesisRow["manifest_hash"] = value.current.crypto.hash(manifest);
      } else if (kind === "payload") {
        const payload = changed(
          value.genesisRow["payload_bytes"] as Uint8Array,
        );
        value.genesisRow["payload_bytes"] = payload;
        value.currentObjectRow["payload_bytes"] = payload;
      } else {
        const manifest = changed(
          value.currentHeadRow["manifest_bytes"] as Uint8Array,
        );
        value.currentHeadRow["manifest_bytes"] = manifest;
        value.currentHeadRow["manifest_hash"] =
          value.current.crypto.hash(manifest);
      }
      const work = verifier(value).verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      });
      if (kind === "current head") {
        expect(work).rejects.toThrow();
      } else {
        await rejectsWithIntegrity(work);
      }
    },
  );

  test("returns null only for a missing object and rejects a missing genesis", async () => {
    const absent = await fixture();
    absent.missingObject();
    expect(
      await verifier(absent).verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      }),
    ).toBeNull();

    const missingGenesis = await fixture();
    missingGenesis.missingGenesis();
    await rejectsWithIntegrity(
      verifier(missingGenesis).verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      }),
    );
  });

  test("copies the original descriptor hash synchronously", async () => {
    const value = await fixture();
    const suppliedHash = new Uint8Array(value.original.descriptorHash);
    const port = verifier(value, {
      ...value.original,
      descriptorHash: suppliedHash,
    });
    suppliedHash.fill(0);
    expect(
      await port.verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      }),
    ).not.toBeNull();
  });

  test.each(["reject", "abort"] as const)(
    "wipes an unreturned candidate when transaction completion ends with %s",
    async (step) => {
      const value = await fixture({ transactionSteps: [step] });
      const error = await rejection(
        verifier(value).verify({
          objectId: OBJECT_ID,
          signal: value.controller.signal,
        }),
      );

      expect(error).toBe(value.transactionError);
      expect(value.capturedCandidates).toHaveLength(1);
      expect(
        value.capturedCandidates[0]?.payloadBytes.every((byte) => byte === 0),
      ).toBe(true);
      expect(
        value.capturedCandidates[0]?.namespaceEnvelopeBytes.every(
          (byte) => byte === 0,
        ),
      ).toBe(true);
    },
  );

  test("wipes the first transaction candidate before a serialization retry", async () => {
    const value = await fixture({ transactionSteps: ["serialize", "success"] });
    const result = await verifier(value).verify({
      objectId: OBJECT_ID,
      signal: value.controller.signal,
    });
    if (result === null) throw new Error("Expected the retried Journal object");

    expect(value.capturedCandidates).toHaveLength(2);
    expect(
      value.capturedCandidates[0]?.payloadBytes.every((byte) => byte === 0),
    ).toBe(true);
    expect(
      value.capturedCandidates[0]?.namespaceEnvelopeBytes.every(
        (byte) => byte === 0,
      ),
    ).toBe(true);
    expect(value.capturedCandidates[1]).toBe(result);
    expect(result?.payloadBytes.some((byte) => byte !== 0)).toBe(true);
    expect(result?.namespaceEnvelopeBytes.some((byte) => byte !== 0)).toBe(
      true,
    );
  });

  test("classifies durable certificate corruption but propagates a query failure unchanged", async () => {
    const corrupt = await fixture();
    corrupt.current.authorizationRow.work_id = "substituted-work";
    const integrity = await rejection(
      verifier(corrupt).verify({
        objectId: OBJECT_ID,
        signal: corrupt.controller.signal,
      }),
    );
    expect(integrity).toBeInstanceOf(ClassifiedDataOperationError);
    expect((integrity as ClassifiedDataOperationError).failureClass).toBe(
      "integrity",
    );

    const unavailable = await fixture();
    const queryError = new Error("injected historical device query failure");
    unavailable.failQuery("from human_crypto_devices", queryError);
    const propagated = await rejection(
      verifier(unavailable).verify({
        objectId: OBJECT_ID,
        signal: unavailable.controller.signal,
      }),
    );
    expect(propagated).toBe(queryError);
  });

  test("delegates a legitimate current V5 genesis to the existing chain verifier", async () => {
    const value = await fixture({ currentVersion: 5 });
    let calls = 0;
    let lentHead: Uint8Array | undefined;
    const result = await verifier(value, value.original, (input) => {
      calls += 1;
      expect(input.objectId).toBe(OBJECT_ID);
      expect(input.headAccessRevision).toBe(0);
      expect(input.expectedPayloadHash).toEqual(
        value.current.crypto.hash(value.payloadBytes),
      );
      expect(input.expectedHeadManifestHash).toEqual(
        value.current.crypto.hash(value.current.manifests[0]!.v5Bytes),
      );
      lentHead = new Uint8Array(value.current.manifests[0]!.v5Bytes);
      return Promise.resolve({
        objectId: OBJECT_ID,
        payloadHash: value.current.crypto.hash(value.payloadBytes),
        headManifest: decodeObjectAccessManifestV5(
          value.current.manifests[0]!.v5Bytes,
        ),
        headManifestBytes: lentHead,
        headManifestHash: value.current.crypto.hash(
          value.current.manifests[0]!.v5Bytes,
        ),
        genesisHumanId: null,
        headSignerPublicKey: new Uint8Array(32),
        signerEvidence: [],
      });
    }).verify({ objectId: OBJECT_ID, signal: new AbortController().signal });

    expect(result).not.toBeNull();
    expect(calls).toBe(1);
    expect(lentHead?.every((byte) => byte === 0)).toBe(true);
  });
});
