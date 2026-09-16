import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  namespaceId,
  objectId,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  encodeBackgroundWorkDescriptorV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {
  backgroundWorkDescriptorDigestV1,
  encodeBackgroundWorkDescriptorV1,
  type BackgroundWorkDescriptorV1,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresProcessorTransformCommitVerifier,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";

function crypto() {
  let counter = 0;
  return new LatticeCrypto({
    bytes(length: number) {
      const value = new Uint8Array(length);
      value.fill(counter);
      counter = (counter + 1) & 0xff;
      return value;
    },
  });
}

function descriptor(): BackgroundWorkDescriptorV1 {
  const outputs = [
    objectId("journal-output-1"),
    objectId("journal-output-2"),
  ];
  return {
    formatVersion: 1,
    requestId: "request-transform-commit",
    recipientGeneration: 3,
    workKind: "stenographer.extraction",
    workId: "work-transform-commit",
    namespaceId: namespaceId("namespace-transform-commit"),
    domainId: cryptoDomainId("domain-transform-commit"),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(5),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: 1,
      endSequence: 2,
      rebuildGeneration: 0,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("journal-input-1")],
    outputObjectIds: outputs,
    outputObjectMetadata: outputs.map((id, index) => ({
      objectId: id,
      objectType: "nautilo-journal-event-v1",
      createdAt: unixTimestamp(20_000 + index),
    })),
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 4_096,
    maximumCiphertextBytes: 32_768,
    expectedDomainEpoch: domainEpoch(2),
    expectedNamespaceAccessRevision: accessRevision(4),
    expectedPolicyRevision: authorizationRevision(6),
    recipientKeyId: "recipient-transform-commit",
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    issuedAt: 10_000,
    notBefore: 10_000,
    expiresAt: 40_000,
    idempotencyId: "idempotency-transform-commit",
  };
}

function currentDescriptor(): BackgroundProcessorWorkDescriptorV2 {
  return {
    formatVersion: 2,
    requestId: "request-transform-commit-current",
    recipientGeneration: 4,
    workKind: "stenographer.historical",
    workId: "work-transform-commit-current",
    anchorNamespaceId: "namespace-transform-commit-current",
    anchorDomainId: "domain-transform-commit-current",
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: ["decrypt", "encrypt"],
    purpose: "journal.extract",
    authority: {
      serverId: "server-transform-commit",
      roomId: "room-transform-commit",
      namespaceId: "namespace-transform-commit-current",
      namespaceAccessRevision: 7,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(0x31),
      domainId: "domain-transform-commit-current",
      domainKeyGeneration: 4,
      domainAuthorizationRevision: 8,
      domainHeadDigest: new Uint8Array(32).fill(0x32),
      bundleRevision: 9,
      bundleDigest: new Uint8Array(32).fill(0x33),
    },
    policyRevision: 10,
    source: {
      kind: "stenographer_work",
      startSequence: 10,
      endSequence: 12,
      rebuildGeneration: 2,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputBindings: [{objectId: "journal-input-current-1", namespaceId: "namespace-transform-commit-current"}],
    outputSlots: [{
      objectId: "journal-output-current-1",
      objectType: "nautilo.reflection.record.v1",
      createdAt: 20_000,
      namespaceIds: ["namespace-transform-commit-current"],
    }, {
      objectId: "journal-output-current-2",
      objectType: "nautilo.reflection.record.v1",
      createdAt: 20_001,
      namespaceIds: ["namespace-transform-commit-current"],
    }],
    maximumPlaintextBytes: 4_096,
    maximumCiphertextBytes: 32_768,
    recipientKeyId: "recipient-transform-commit-current",
    recipientPublicKey: new Uint8Array(65).fill(0x42),
    issuedAt: 10_000,
    notBefore: 10_000,
    expiresAt: 40_000,
    idempotencyId: "idempotency-transform-commit-current",
  };
}

class Connection implements CryptoPostgresConnection {
  constructor(readonly row: Record<string, unknown>) {}

  query<Row>(
    statement: string,
  ): Promise<readonly Row[]> {
    if (statement.includes("current_user::text")) {
      return Promise.resolve([{
        current_user: "nautilo_crypto",
        session_user: "nautilo_crypto",
      }] as Row[]);
    }
    if (statement.includes("background_crypto_authorization_requests")) {
      return Promise.resolve([this.row] as Row[]);
    }
    throw new Error(`Unexpected SQL: ${statement}`);
  }

  transaction<Result>(
    callback: (transaction: CryptoPostgresExecutor) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

async function fixture(outputCount = 0) {
  const lattice = crypto();
  const work = descriptor();
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(work);
  const descriptorHash = backgroundWorkDescriptorDigestV1(lattice, work);
  const connection = new Connection({
    request_id: work.requestId,
    format_version: 1,
    work_id: work.workId,
    namespace_id: work.namespaceId,
    descriptor_hash: Buffer.from(descriptorHash),
    descriptor_bytes: Buffer.from(descriptorBytes),
    recipient_generation: work.recipientGeneration,
    state: "publication_reconciliation",
    transform_commit_claim_id: "claim-transform-commit",
    transform_commit_descriptor_hash: Buffer.from(descriptorHash),
    transform_commit_recipient_generation: work.recipientGeneration,
    transform_commit_output_count: outputCount,
    transform_committed_at: new Date(20_000).toISOString(),
  });
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    work,
    descriptorHash,
    connection,
    verifier: new PostgresProcessorTransformCommitVerifier(handle, lattice),
  };
}

async function currentFixture(outputCount = 1) {
  const lattice = crypto();
  const work = currentDescriptor();
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(work);
  const descriptorHash = lattice.hash(descriptorBytes);
  const connection = new Connection({
    request_id: work.requestId,
    format_version: 2,
    work_id: work.workId,
    namespace_id: work.authority.namespaceId,
    descriptor_hash: Buffer.from(descriptorHash),
    descriptor_bytes: Buffer.from(descriptorBytes),
    recipient_generation: work.recipientGeneration,
    state: "publication_reconciliation",
    transform_commit_claim_id: "claim-transform-commit-current",
    transform_commit_descriptor_hash: Buffer.from(descriptorHash),
    transform_commit_recipient_generation: work.recipientGeneration,
    transform_commit_output_count: outputCount,
    transform_committed_at: new Date(20_000).toISOString(),
  });
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    work,
    descriptorHash,
    connection,
    verifier: new PostgresProcessorTransformCommitVerifier(handle, lattice),
  };
}

describe("Postgres processor transform commit verifier", () => {
  test("proves an exact durable zero-output commit after the request is fenced", async () => {
    const value = await fixture(0);

    const proof = await value.verifier.verifyCommit({
      requestId: value.work.requestId,
      workId: value.work.workId,
      namespaceId: value.work.namespaceId,
      descriptorHash: value.descriptorHash,
      recipientGeneration: value.work.recipientGeneration,
      signal: new AbortController().signal,
    });

    expect(proof).toMatchObject({
      claimId: "claim-transform-commit",
      outputObjectCount: 0,
      outputObjectIds: [],
      authorizedOutputObjectIds: value.work.outputObjectIds,
    });
    expect(proof?.descriptorHash).toEqual(value.descriptorHash);
    expect(proof?.descriptorHash.some((byte) => byte !== 0)).toBeTrue();
  });

  test("rejects partial, unfenced, or substituted durable proof", async () => {
    const partial = await fixture();
    partial.connection.row["transform_committed_at"] = null;
    expect(partial.verifier.verifyCommit({
      requestId: partial.work.requestId,
      workId: partial.work.workId,
      namespaceId: partial.work.namespaceId,
      descriptorHash: partial.descriptorHash,
      recipientGeneration: partial.work.recipientGeneration,
      signal: new AbortController().signal,
    })).rejects.toThrow(/partial/);

    const running = await fixture();
    running.connection.row["state"] = "running";
    expect(running.verifier.verifyCommit({
      requestId: running.work.requestId,
      workId: running.work.workId,
      namespaceId: running.work.namespaceId,
      descriptorHash: running.descriptorHash,
      recipientGeneration: running.work.recipientGeneration,
      signal: new AbortController().signal,
    })).rejects.toThrow(/fenced/);

    const substituted = await fixture();
    substituted.connection.row["transform_commit_output_count"] = 3;
    expect(substituted.verifier.verifyCommit({
      requestId: substituted.work.requestId,
      workId: substituted.work.workId,
      namespaceId: substituted.work.namespaceId,
      descriptorHash: substituted.descriptorHash,
      recipientGeneration: substituted.work.recipientGeneration,
      signal: new AbortController().signal,
    })).rejects.toThrow(/prefix/);
  });

  test("proves the exact committed output prefix from a current V2 descriptor", async () => {
    const value = await currentFixture(1);

    const proof = await value.verifier.verifyCommit({
      requestId: value.work.requestId,
      workId: value.work.workId,
      namespaceId: value.work.authority.namespaceId,
      descriptorHash: value.descriptorHash,
      recipientGeneration: value.work.recipientGeneration,
      signal: new AbortController().signal,
    });

    expect(proof).toMatchObject({
      claimId: "claim-transform-commit-current",
      outputObjectCount: 1,
      outputObjectIds: ["journal-output-current-1"],
      authorizedOutputObjectIds: [
        "journal-output-current-1",
        "journal-output-current-2",
      ],
    });
    expect(proof?.descriptorHash).toEqual(value.descriptorHash);
  });

  test("rejects a V2 marker that exceeds or substitutes its exact descriptor", async () => {
    const excessive = await currentFixture(3);
    expect(excessive.verifier.verifyCommit({
      requestId: excessive.work.requestId,
      workId: excessive.work.workId,
      namespaceId: excessive.work.authority.namespaceId,
      descriptorHash: excessive.descriptorHash,
      recipientGeneration: excessive.work.recipientGeneration,
      signal: new AbortController().signal,
    })).rejects.toThrow(/prefix/);

    const substituted = await currentFixture();
    substituted.connection.row["namespace_id"] = "other-namespace";
    expect(substituted.verifier.verifyCommit({
      requestId: substituted.work.requestId,
      workId: substituted.work.workId,
      namespaceId: substituted.work.authority.namespaceId,
      descriptorHash: substituted.descriptorHash,
      recipientGeneration: substituted.work.recipientGeneration,
      signal: new AbortController().signal,
    })).rejects.toThrow(/coordinates/);
  });
});
