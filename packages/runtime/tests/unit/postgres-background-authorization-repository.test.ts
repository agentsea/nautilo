import { createHash } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "@nautilo/lattice-bridge/server";
import type {
  VerifiedProcessorBackgroundAuthorizationDeviceResponse,
} from "@nautilo/lattice-bridge";
import {
  encodeBackgroundWorkDescriptorV2,
  type BackgroundReflectionWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";
import {
  attachBackgroundAuthorizationRecipient,
  createBackgroundAuthorizationRequest,
  createBackgroundAuthorizationRequestV2,
  cancelBackgroundAuthorizationRequest,
} from "../../src/protected-execution/background-authorization/lifecycle";
import { PostgresBackgroundAuthorizationRepository } from "../../src/protected-execution/background-authorization/postgres-repository";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BackgroundAuthorizationRepositoryConflictError,
  InMemoryBackgroundAuthorizationRepository,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationAgentRecordV2,
  type ProcessorSignerAuthorizationEvidence,
} from "../../src/protected-execution/background-authorization/repository";

const START = 1_700_000_000_000;
const PUBLIC_KEY_BYTES = new Uint8Array(65).fill(0x42);

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: unknown[][] = [];
  transactions = 0;
  transactionFailures = 0;
  readonly #results: unknown[][];

  constructor(results: readonly unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    this.parameters.push([...parameters]);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactions += 1;
    try {
      return await callback(this);
    } catch (error) {
      this.transactionFailures += 1;
      throw error;
    }
  }
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedSql(statement: string | undefined): string {
  return (statement ?? "").replaceAll('"', "").replace(/\s+/g, " ")
    .trim().toUpperCase();
}

function initial(): BackgroundAuthorizationRecord {
  return {
    snapshot: createBackgroundAuthorizationRequest({
      requestId: "request_1",
      workId: "work_1",
      namespaceId: "namespace_1",
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
        authorizationRevision: 2,
      },
      now: START,
    }),
    workIdentityHash: new Uint8Array(32).fill(1),
    idempotencyKey: "idempotency_1",
    workKind: "stenographer.extraction",
    purpose: "journal.extract",
    domainId: "domain_1",
    processorAuthorizationRevision: 2,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    descriptorBytes: null,
    acceptedMaterial: null,
    finishedAt: null,
  };
}

function initialV2(): BackgroundAuthorizationAgentRecordV2 {
  return {
    ...initial(),
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: "request_v2",
      workId: "work_v2",
      namespaceId: "namespace_a",
      credentialSubject: {
        kind: "agent",
        agentId: "agent_genie",
        runtimeGeneration: 4,
        authorizationRevision: 8,
      },
      now: START,
    }),
    workIdentityHash: new Uint8Array(32).fill(2),
    idempotencyKey: "idempotency_v2",
    workKind: "memory.review",
    purpose: "memory.review",
    domainId: "domain_ab",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: 3,
    expectedNamespaceAccessRevision: 4,
    expectedPolicyRevision: 5,
    authoritySet: {
      namespaceRequirements: [
        {
          ordinal: 0,
          namespaceId: "namespace_a",
          domainId: "domain_ab",
          operations: ["decrypt"],
          expectedAccessRevision: 4,
          expectedPolicyRevision: 5,
        },
        {
          ordinal: 1,
          namespaceId: "namespace_b",
          domainId: "domain_bc",
          operations: ["decrypt", "encrypt"],
          expectedAccessRevision: 6,
          expectedPolicyRevision: 7,
        },
      ],
      domainRequirements: [
        {
          ordinal: 0,
          domainId: "domain_ab",
          expectedEpoch: 3,
          expectedAgentAuthorizationRevision: 9,
        },
        {
          ordinal: 1,
          domainId: "domain_bc",
          expectedEpoch: 10,
          expectedAgentAuthorizationRevision: 11,
        },
      ],
    },
  };
}

function initialProcessorV2(): BackgroundAuthorizationRecord {
  return {
    ...initial(),
    snapshot: createBackgroundAuthorizationRequestV2({
      requestId: "request_processor_v2",
      workId: "work_processor_v2",
      namespaceId: "namespace_1",
      credentialSubject: {
        kind: "processor",
        processorKind: "stenographer",
        processorVersion: 1,
      },
      now: START,
    }),
    workIdentityHash: new Uint8Array(32).fill(3),
    idempotencyKey: "idempotency_processor_v2",
    processorAuthorizationRevision: null,
    expectedDomainEpoch: null,
  };
}

function reflectionDescriptor(
  requestId = "reflection_request",
  workId = "reflection-work",
  outputId = `${workId}:record`,
): BackgroundReflectionWorkDescriptorV2 {
  const authority = {
    serverId: "server_1",
    roomId: "room_1",
    namespaceId: "namespace_1",
    namespaceAccessRevision: 4,
    namespaceKeyGeneration: 5,
    namespaceHeadDigest: new Uint8Array(32).fill(6),
    domainId: "domain_1",
    domainKeyGeneration: 7,
    domainAuthorizationRevision: 8,
    domainHeadDigest: new Uint8Array(32).fill(9),
    bundleRevision: 10,
    bundleDigest: new Uint8Array(32).fill(11),
  };
  return {
    formatVersion: 2,
    requestId,
    recipientGeneration: 1,
    workKind: "reflection.authority_reproject",
    workId,
    anchorNamespaceId: authority.namespaceId,
    anchorDomainId: authority.domainId,
    subject: {
      kind: "processor",
      processorKind: "reflection",
      processorVersion: 1,
    },
    operations: ["decrypt", "encrypt"],
    purpose: "record.reproject",
    source: {
      kind: "reflection_authority",
      recordRef: "record_1",
      sourceChangeGeneration: 1,
      projectionGeneration: 2,
      expectedRepresentationGeneration: 3,
      targetRepresentationGeneration: 4,
      fingerprint: new Uint8Array(32).fill(12),
    },
    namespaceRequirements: [{
      authority,
      operations: ["decrypt", "encrypt"],
    }],
    policyRevision: 13,
    inputBindings: [{
      objectId: "previous_record_object",
      namespaceId: authority.namespaceId,
    }],
    outputSlots: [{
      objectId: outputId,
      objectType: "nautilo.reflection.record.v1",
      createdAt: START,
      namespaceIds: [authority.namespaceId],
    }],
    maximumPlaintextBytes: 1_024,
    maximumCiphertextBytes: 4_096,
    recipientKeyId: "recipient_1",
    recipientPublicKey: PUBLIC_KEY_BYTES,
    issuedAt: START,
    notBefore: START,
    expiresAt: START + 300_000,
    idempotencyId: "reflection_attempt_1",
  };
}

function pruneCandidate(input: Readonly<{
  requestId?: string;
  workId?: string;
  finishedAt?: Date;
  state?: string;
  descriptorBytes?: Uint8Array | null;
  transformCommittedAt?: Date | null;
  processorKind?: string;
  workKind?: string;
}> = {}) {
  return {
    request_id: input.requestId ?? "reflection_request",
    format_version: 2,
    state: input.state ?? "terminal_failure",
    work_id: input.workId ?? "reflection-work",
    work_kind: input.workKind ?? "reflection.authority_reproject",
    processor_kind: input.processorKind ?? "reflection",
    descriptor_bytes: Object.hasOwn(input, "descriptorBytes")
      ? input.descriptorBytes
      : encodeBackgroundWorkDescriptorV2(reflectionDescriptor()),
    transform_committed_at: input.transformCommittedAt
      ?? new Date(START + 1),
    finished_at: input.finishedAt ?? new Date(START + 2),
  };
}

function domainRows(record: BackgroundAuthorizationAgentRecordV2) {
  return record.authoritySet.domainRequirements.map((requirement) => ({
    request_id: record.snapshot.requestId,
    domain_id: requirement.domainId,
    ordinal: requirement.ordinal,
    expected_epoch: requirement.expectedEpoch,
    expected_agent_authorization_revision:
      requirement.expectedAgentAuthorizationRevision,
  }));
}

function namespaceRows(record: BackgroundAuthorizationAgentRecordV2) {
  return record.authoritySet.namespaceRequirements.map((requirement) => ({
    request_id: record.snapshot.requestId,
    namespace_id: requirement.namespaceId,
    domain_id: requirement.domainId,
    ordinal: requirement.ordinal,
    operation_mask: requirement.operations.length === 2
      ? 3
      : requirement.operations[0] === "decrypt" ? 1 : 2,
    expected_access_revision: requirement.expectedAccessRevision,
    expected_policy_revision: requirement.expectedPolicyRevision,
  }));
}

function withRecipient(
  record: BackgroundAuthorizationRecord,
): BackgroundAuthorizationRecord {
  const descriptorBytes = new Uint8Array([1, 2, 3]);
  return {
    ...record,
    snapshot: attachBackgroundAuthorizationRecipient(record.snapshot, {
      descriptorDigest: digest(descriptorBytes),
      recipientKeyId: "recipient_1",
      recipientPublicKey: Buffer.from(PUBLIC_KEY_BYTES).toString("base64url"),
      expiresAt: START + 300_000,
      now: START + 1,
    }),
    descriptorBytes,
  };
}

function recordRow(record: BackgroundAuthorizationRecord) {
  const { snapshot } = record;
  const subject = snapshot.credentialSubject;
  const response = snapshot.acceptedResponse;
  const material = record.acceptedMaterial;
  return {
    request_id: snapshot.requestId,
    format_version: snapshot.formatVersion,
    work_identity_hash: record.workIdentityHash,
    idempotency_key: record.idempotencyKey,
    work_id: snapshot.workId,
    work_kind: record.workKind,
    purpose: record.purpose,
    namespace_id: snapshot.namespaceId,
    domain_id: record.domainId,
    credential_subject_kind: subject.kind,
    processor_kind: subject.kind === "processor" ? subject.processorKind : null,
    processor_version: subject.kind === "processor"
      ? subject.processorVersion
      : null,
    processor_authorization_revision: record.processorAuthorizationRevision,
    agent_id: subject.kind === "agent" ? subject.agentId : null,
    agent_runtime_generation: subject.kind === "agent"
      ? subject.runtimeGeneration
      : null,
    agent_authorization_revision: subject.kind === "agent"
      ? subject.authorizationRevision
      : null,
    expected_domain_epoch: record.expectedDomainEpoch,
    expected_namespace_access_revision: record.expectedNamespaceAccessRevision,
    expected_policy_revision: record.expectedPolicyRevision,
    recipient_generation: snapshot.recipientGeneration,
    descriptor_hash: snapshot.descriptorDigest === null
      ? null
      : Uint8Array.from(Buffer.from(snapshot.descriptorDigest, "hex")),
    descriptor_bytes: record.descriptorBytes,
    recipient_key_id: snapshot.recipient?.recipientKeyId ?? null,
    recipient_public_key: snapshot.recipient === null
      ? null
      : Uint8Array.from(
        Buffer.from(snapshot.recipient.recipientPublicKey, "base64url"),
      ),
    recipient_expires_at_ms: snapshot.recipient?.expiresAt ?? null,
    accepted_response_kind: response?.kind ?? null,
    accepted_response_hash: response === null
      ? null
      : Uint8Array.from(Buffer.from(response.responseDigest, "hex")),
    accepted_response_bytes: material?.responseBytes ?? null,
    credential_id: material?.credentialId ?? null,
    credential_hash: response === null
      ? null
      : Uint8Array.from(Buffer.from(response.credentialDigest, "hex")),
    issuing_human_id: response?.issuingHumanId ?? null,
    issuing_device_id: response?.issuingDeviceId ?? null,
    issuing_device_authorization_revision:
      material?.issuingDeviceAuthorizationRevision ?? null,
    issuer_signing_public_key_hash:
      material?.issuerSigningPublicKeyHash ?? null,
    accepted_at_ms: response?.acceptedAt ?? null,
    authorization_expires_at_ms: material?.authorizationExpiresAt ?? null,
    request_revision: snapshot.requestRevision,
    state: snapshot.state,
    claim_id: snapshot.claimId,
    claim_expires_at_ms: snapshot.claimExpiresAt,
    retry_count: snapshot.retryCount,
    maximum_attempts: 8,
    last_retry_reason: snapshot.lastRetryReason,
    next_attempt_at_ms: snapshot.nextAttemptAt,
    terminal_reason: snapshot.terminalReason,
    finished_at_ms: record.finishedAt,
    created_at_ms: snapshot.createdAt,
    updated_at_ms: snapshot.updatedAt,
    transform_commit_claim_id: null, transform_commit_descriptor_hash: null,
    transform_commit_recipient_generation: null, transform_commit_output_count: null, transform_committed_at: null,
  };
}

function verifiedResponse(
  record: BackgroundAuthorizationRecord,
  device = "device_1",
): VerifiedProcessorBackgroundAuthorizationDeviceResponse {
  const responseBytes = new Uint8Array([9, 8, 7]);
  const credentialHash = new Uint8Array(32).fill(4);
  return {
    kind: "processor",
    requestId: record.snapshot.requestId,
    recipientGeneration: record.snapshot.recipientGeneration,
    recipientKeyId: record.snapshot.recipient!.recipientKeyId,
    recipientPublicKey: PUBLIC_KEY_BYTES,
    descriptorHash: Uint8Array.from(
      Buffer.from(record.snapshot.descriptorDigest!, "hex"),
    ),
    workId: record.snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: record.processorAuthorizationRevision!,
    },
    responseHash: Uint8Array.from(Buffer.from(digest(responseBytes), "hex")),
    responseBytes,
    credentialId: "credential_1",
    credentialHash,
    issuingHumanId: "human_1",
    issuingDeviceId: device,
    issuingDeviceAuthorizationRevision: 6,
    issuerSigningPublicKeyHash: new Uint8Array(32).fill(1),
    namespaceId: record.snapshot.namespaceId,
    domainId: record.domainId,
    domainEpoch: record.expectedDomainEpoch!,
    namespaceAccessRevision: record.expectedNamespaceAccessRevision,
    policyRevision: record.expectedPolicyRevision,
    issuedAt: START,
    notBefore: START,
    expiresAt: record.snapshot.recipient!.expiresAt,
    signerAuthorization: {
      authorizationId: "authorization_1",
      processorKind: "stenographer",
      processorVersion: 1,
      workId: record.snapshot.workId,
      namespaceId: record.snapshot.namespaceId,
      domainId: record.domainId,
      domainEpoch: record.expectedDomainEpoch!,
      namespaceAccessRevision: record.expectedNamespaceAccessRevision,
      policyRevision: record.expectedPolicyRevision,
      processorAuthorizationRevision: record.processorAuthorizationRevision!,
      issuingHumanId: "human_1",
      issuingDeviceId: device,
      issuingDeviceAuthorizationRevision: 6,
      issuerSigningPublicKeyHash: new Uint8Array(32).fill(1),
      signerKeyId: "signer_1",
      signerPublicKey: new Uint8Array(32).fill(2),
      authorizationHash: new Uint8Array(32).fill(3),
      credentialHash,
      authorizationBytes: new Uint8Array([5]),
      issuedAt: START,
      expiresAt: record.snapshot.recipient!.expiresAt,
    },
  };
}

function evidenceFromResponse(
  response: VerifiedProcessorBackgroundAuthorizationDeviceResponse,
  createdAt: number,
  workDescriptorBytes: Uint8Array,
): ProcessorSignerAuthorizationEvidence {
  return {
    ...response.signerAuthorization,
    requestId: response.requestId,
    recipientGeneration: response.recipientGeneration,
    workDescriptorHash: response.descriptorHash,
    workDescriptorBytes,
    createdAt,
  };
}

function evidenceRow(evidence: ProcessorSignerAuthorizationEvidence) {
  return {
    authorization_id: evidence.authorizationId,
    format_version: evidence.formatVersion ?? 1,
    request_id: evidence.requestId,
    recipient_generation: evidence.recipientGeneration,
    work_id: evidence.workId,
    namespace_id: evidence.namespaceId,
    domain_id: evidence.domainId,
    domain_epoch: evidence.domainEpoch,
    namespace_access_revision: evidence.namespaceAccessRevision,
    policy_revision: evidence.policyRevision,
    processor_authorization_revision: evidence.processorAuthorizationRevision,
    issuing_human_id: evidence.issuingHumanId,
    issuing_device_id: evidence.issuingDeviceId,
    issuing_device_authorization_revision:
      evidence.issuingDeviceAuthorizationRevision,
    issuer_signing_public_key_hash: evidence.issuerSigningPublicKeyHash,
    signer_key_id: evidence.signerKeyId,
    signer_public_key: evidence.signerPublicKey,
    work_descriptor_hash: evidence.workDescriptorHash,
    work_descriptor_bytes: evidence.workDescriptorBytes,
    authorization_hash: evidence.authorizationHash,
    credential_hash: evidence.credentialHash,
    authorization_bytes: evidence.authorizationBytes,
    issued_at_ms: evidence.issuedAt,
    expires_at_ms: evidence.expiresAt,
    created_at_ms: evidence.createdAt,
  };
}

async function setup(results: readonly unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresBackgroundAuthorizationRepository(handle),
  };
}

describe("Postgres background authorization repository", () => {
  test("round-trips current processor rows with null legacy authority", async () => {
    const record = initialProcessorV2();
    const created = await setup([[recordRow(record)]]);
    expect(await created.repository.create(record)).toEqual({
      status: "created",
      record,
    });
    expect(created.connection.transactions).toBe(0);

    const loaded = await setup([[recordRow(record)]]);
    expect(await loaded.repository.get(record.snapshot.requestId)).toEqual(
      record,
    );
  });

  test("v2 prepare and load preserve one exact authority set transactionally", async () => {
    const record = initialV2();
    const created = await setup([[recordRow(record)], [], []]);

    expect(await created.repository.create(record)).toEqual({
      status: "created",
      record,
    });
    expect(created.connection.transactions).toBe(1);
    const domainInsert = created.connection.statements.findIndex((statement) =>
      normalizedSql(statement).startsWith(
        "INSERT INTO BACKGROUND_CRYPTO_AUTHORIZATION_DOMAIN_REQUIREMENTS",
      )
    );
    const namespaceInsert = created.connection.statements.findIndex(
      (statement) => normalizedSql(statement).startsWith(
        "INSERT INTO BACKGROUND_CRYPTO_AUTHORIZATION_NAMESPACE_REQUIREMENTS",
      ),
    );
    expect(domainInsert).toBeGreaterThan(0);
    expect(namespaceInsert).toBeGreaterThan(domainInsert);

    const loaded = await setup([
      [recordRow(record)],
      domainRows(record).reverse(),
      namespaceRows(record).reverse(),
    ]);
    expect(await loaded.repository.get(record.snapshot.requestId)).toEqual(
      record,
    );
    expect(loaded.connection.statements.at(-2)).toContain(
      "ORDER BY request_id, ordinal",
    );
    expect(loaded.connection.statements.at(-1)).toContain(
      "ORDER BY request_id, ordinal",
    );

    const corrupt = await setup([
      [recordRow(record)],
      domainRows(record).slice(0, 1),
      namespaceRows(record),
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(corrupt.repository.get(record.snapshot.requestId)).rejects
      .toThrow("exactly cover Namespace Domains");
  });

  test("create has the same exact-idempotency result as the in-memory port", async () => {
    const record = initial();
    const memory = new InMemoryBackgroundAuthorizationRepository();
    const postgres = await setup([[recordRow(record)]]);

    expect((await memory.create(record)).status).toBe("created");
    expect((await postgres.repository.create(record)).status).toBe("created");
    expect(normalizedSql(postgres.connection.statements.at(-1))).toContain(
      "ON CONFLICT DO NOTHING",
    );
    expect(postgres.connection.parameters.at(-1)).toHaveLength(48);

    const replay = await setup([[], [recordRow(record)]]);
    expect((await replay.repository.create(record)).status).toBe("existing");

    const conflict = await setup([[], [recordRow({
      ...record,
      expectedPolicyRevision: 99,
    })]]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(conflict.repository.create(record)).rejects.toThrow(
      "create_conflict",
    );
  });

  test("CAS reads durable current state then updates the exact revision", async () => {
    const current = initial();
    const next = withRecipient(current);
    const postgres = await setup([
      [recordRow(current)],
      [recordRow(next)],
    ]);

    expect(await postgres.repository.compareAndSwap({
      expectedRequestRevision: 0,
      next,
    })).toMatchObject({
      status: "updated",
      record: { snapshot: { requestRevision: 1 } },
    });
    expect(normalizedSql(postgres.connection.statements.at(-1))).toContain(
      "REQUEST_REVISION = $30",
    );
    expect(postgres.connection.parameters.at(-1)).toHaveLength(30);
  });

  test("stale CAS returns restart-readable state and performs no update", async () => {
    const current = withRecipient(initial());
    const postgres = await setup([[recordRow(current)]]);

    expect(await postgres.repository.compareAndSwap({
      expectedRequestRevision: 0,
      next: current,
    })).toMatchObject({
      status: "stale",
      current: { snapshot: { requestRevision: 1 } },
    });
    expect(postgres.connection.statements).toHaveLength(2);
  });

  test("eligible listing and terminal pruning use bounded deterministic SQL", async () => {
    const record = initial();
    const eligible = await setup([[recordRow(record)]]);
    expect(await eligible.repository.listEligible({
      now: START,
      limit: 32,
    })).toHaveLength(1);
    expect(normalizedSql(eligible.connection.statements.at(-1))).toContain(
      "ORDER BY BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.UPDATED_AT ASC, "
        + "BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.REQUEST_ID ASC",
    );
    expect(eligible.connection.parameters.at(-1)?.slice(0, 2)).toEqual([1, 2]);

    const prune = await setup([
      [pruneCandidate({
        state: "completed",
        processorKind: "stenographer",
        workKind: "stenographer.extraction",
        transformCommittedAt: null,
      })],
      [],
      [],
      [{ request_id: "reflection_request" }],
    ]);
    expect(await prune.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
      limit: 1,
    })).toBe(1);
    expect(prune.connection.transactions).toBe(1);
    expect(normalizedSql(prune.connection.statements[1])).toContain(
      "ORDER BY BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.FINISHED_AT ASC, "
        + "BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.REQUEST_ID ASC",
    );
    expect(normalizedSql(prune.connection.statements[1])).toContain(
      "FOR UPDATE SKIP LOCKED",
    );
    expect(normalizedSql(prune.connection.statements[1])).toContain(
      "NOT EXISTS",
    );
    expect(normalizedSql(prune.connection.statements[1])).toContain(
      "WORK_ID || ':RECORD'",
    );
    expect(prune.connection.statements[2]).toContain(
      "DELETE FROM background_crypto_authorization_namespace_requirements",
    );
    expect(prune.connection.statements[3]).toContain(
      "DELETE FROM background_crypto_authorization_domain_requirements",
    );
    expect(prune.connection.statements[4]).toContain(
      "DELETE FROM background_crypto_authorization_requests",
    );

    const empty = await setup([[]]);
    expect(await empty.repository.pruneTerminal({ now: START })).toBe(0);
    expect(empty.connection.transactions).toBe(1);
    expect(empty.connection.statements).toHaveLength(2);

    const lostParent = await setup([
      [pruneCandidate({
        state: "completed",
        processorKind: "stenographer",
        workKind: "stenographer.extraction",
        transformCommittedAt: null,
      })],
      [],
      [],
      [],
    ]);
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(lostParent.repository.pruneTerminal({ now: START }))
      .rejects.toEqual(
        new BackgroundAuthorizationRepositoryConflictError("prune_conflict"),
      );
    expect(lostParent.connection.transactionFailures).toBe(1);
  });

  test("retains terminal Reflection A after ciphertext commit while its current envelopes exist", async () => {
    const retained = await setup([
      [pruneCandidate()],
      [{descriptor_bytes: encodeBackgroundWorkDescriptorV2(reflectionDescriptor())}],
      [{
        object_id: "reflection-work:record",
        namespace_id: "namespace_1",
      }],
    ]);

    expect(await retained.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
      limit: 1,
    })).toBe(0);
    expect(retained.connection.statements).toHaveLength(4);
    expect(normalizedSql(retained.connection.statements[1]).split(" FROM ")[0]).not.toContain("DESCRIPTOR_BYTES");
    expect(normalizedSql(retained.connection.statements[3])).toContain(
      "OBJECT_CRYPTO_ACCESS_HEADS",
    );
    expect(retained.connection.statements.some((statement) =>
      normalizedSql(statement).startsWith("DELETE")
    )).toBe(false);
  });

  test("prunes completed Reflection A even when its transform marker remains", async () => {
    const completed = await setup([
      [pruneCandidate({ state: "completed" })],
      [],
      [],
      [{ request_id: "reflection_request" }],
    ]);

    expect(await completed.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
    })).toBe(1);
    expect(completed.connection.statements).toHaveLength(5);
  });

  test("prunes terminal Reflection A after its exact output envelopes retire", async () => {
    const retired = await setup([
      [pruneCandidate()],
      [{descriptor_bytes: encodeBackgroundWorkDescriptorV2(reflectionDescriptor())}],
      [{ object_id: "reflection-work:record", namespace_id: null }],
      [],
      [],
      [{ request_id: "reflection_request" }],
    ]);

    expect(await retired.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
    })).toBe(1);
    expect(retired.connection.parameters[3]).toEqual([
      "reflection-work:record",
      1,
    ]);
  });

  test("retains committed Reflection A when its exact output head is absent", async () => {
    const missing = await setup([
      [pruneCandidate()],
      [{descriptor_bytes: encodeBackgroundWorkDescriptorV2(reflectionDescriptor())}],
      [],
    ]);

    expect(await missing.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
    })).toBe(0);
    expect(missing.connection.statements.some((statement) =>
      normalizedSql(statement).startsWith("DELETE")
    )).toBe(false);
  });

  test("keeps legacy Stenographer terminal pruning unchanged", async () => {
    const stenographer = await setup([
      [pruneCandidate({
        processorKind: "stenographer",
        workKind: "stenographer.extraction",
      })],
      [],
      [],
      [{ request_id: "reflection_request" }],
    ]);

    expect(await stenographer.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
    })).toBe(1);
    expect(stenographer.connection.statements).toHaveLength(5);
  });

  test.each([null, new Uint8Array([1, 2, 3])])(
    "retains committed Reflection A when canonical descriptor proof is %p",
    async (descriptorBytes) => {
      const malformed = await setup([[
        pruneCandidate({ descriptorBytes }),
      ], [{descriptor_bytes: descriptorBytes}]]);
      expect(await malformed.repository.pruneTerminal({
        now: START + 31 * 24 * 60 * 60 * 1_000,
      })).toBe(0);
      expect(malformed.connection.statements.some((statement) =>
        normalizedSql(statement).startsWith("DELETE")
      )).toBe(false);
    },
  );

  test("advances past more than one retained page to prune later safe rows", async () => {
    const retained = Array.from(
      { length: BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH + 1 },
      (_, index) => pruneCandidate({
        requestId: `reflection_retained_${String(index).padStart(3, "0")}`,
        workId: `reflection-retained-${String(index).padStart(3, "0")}`,
        descriptorBytes: new Uint8Array([1, 2, 3]),
        finishedAt: new Date(START + 2),
      }),
    );
    const firstPage = retained.slice(
      0,
      BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
    );
    const laterSafe = pruneCandidate({
      requestId: "reflection_safe_later",
      workId: "reflection-safe-later",
      state: "completed",
      finishedAt: new Date(START + 3),
    });
    const scriptedResults = [
      firstPage,
      ...firstPage.map(() => [{ descriptor_bytes: new Uint8Array([1, 2, 3]) }]),
      [retained.at(-1), laterSafe],
      [{ descriptor_bytes: new Uint8Array([1, 2, 3]) }],
      [],
      [],
      [{ request_id: "reflection_safe_later" }],
    ] as unknown[][];
    const repository = await setup(scriptedResults);

    expect(await repository.repository.pruneTerminal({
      now: START + 31 * 24 * 60 * 60 * 1_000,
      limit: 1,
    })).toBe(1);
    const candidateQueries = repository.connection.statements.filter((statement) =>
      normalizedSql(statement).includes("FOR UPDATE SKIP LOCKED")
    );
    expect(candidateQueries).toHaveLength(2);
    expect(normalizedSql(candidateQueries[1])).toContain("FINISHED_AT >");
    expect(normalizedSql(candidateQueries[1])).toContain("FINISHED_AT =");
    expect(normalizedSql(candidateQueries[1])).toContain("REQUEST_ID >");
    expect(repository.connection.parameters.at(-1)).toEqual([
      ["reflection_safe_later"],
    ]);
  });

  test("awaiting-device discovery maps a stable metadata keyset page", async () => {
    const firstRecord = withRecipient(initial());
    const secondBase = initial();
    const secondRecord = withRecipient({
      ...secondBase,
      snapshot: {
        ...secondBase.snapshot,
        requestId: "request_2",
        workId: "work_2",
      },
      idempotencyKey: "idempotency_2",
      workIdentityHash: new Uint8Array(32).fill(2),
    });
    const page = await setup([[
      recordRow(firstRecord),
      recordRow(secondRecord),
    ]]);
    const result = await page.repository.listAwaitingDevicePage({
      now: START,
      throughUpdatedAt: START + 10,
      after: { updatedAt: START, requestId: "request_0" },
      limit: 2,
    });
    expect(result.records.map((record) => record.snapshot.requestId)).toEqual([
      "request_1",
      "request_2",
    ]);
    expect(result.continuation).toEqual({
      updatedAt: START + 1,
      requestId: "request_2",
    });
    const statement = normalizedSql(page.connection.statements.at(-1));
    expect(page.connection.parameters.at(-1)?.slice(0, 2)).toEqual([1, 2]);
    expect(statement).toContain("STATE = $3");
    expect(statement).toContain("DESCRIPTOR_HASH IS NOT NULL");
    expect(statement).toContain("DESCRIPTOR_BYTES IS NOT NULL");
    expect(statement).toContain("RECIPIENT_KEY_ID IS NOT NULL");
    expect(statement).toContain("RECIPIENT_PUBLIC_KEY IS NOT NULL");
    expect(statement).toContain("RECIPIENT_EXPIRES_AT >");
    expect(statement).toContain("UPDATED_AT <=");
    expect(statement).toContain("UPDATED_AT >");
    expect(statement).toContain("REQUEST_ID >");
    expect(statement).toContain("OCTET_LENGTH(DESCRIPTOR_BYTES)");
    expect(statement).toContain(
      "SUM(DESCRIPTOR_SIZE) OVER",
    );
    expect(statement).toContain("ROWS UNBOUNDED PRECEDING");
    expect(statement).toContain(
      "CUMULATIVE_BYTES <=",
    );
    expect(statement).toContain(
      "ORDER BY BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.UPDATED_AT ASC, "
        + "BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.REQUEST_ID ASC",
    );

    const byteBoundPrefix = await setup([[recordRow(firstRecord)]]);
    expect(await byteBoundPrefix.repository.listAwaitingDevicePage({
      now: START,
      throughUpdatedAt: START + 10,
      limit: 2,
    })).toMatchObject({
      records: [{ snapshot: { requestId: "request_1" } }],
      continuation: { updatedAt: START + 1, requestId: "request_1" },
    });

    const empty = await setup([[]]);
    expect(await empty.repository.listAwaitingDevicePage({
      now: START,
      throughUpdatedAt: START,
      limit: 1,
    })).toEqual({ records: [], continuation: null });
    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(empty.repository.listAwaitingDevicePage({
      now: START,
      throughUpdatedAt: START,
      limit: 257,
    })).rejects.toThrow("must be bounded");
  });

  test("signer evidence has no standalone repository write operation", async () => {
    const postgres = await setup([]);
    expect("appendProcessorSignerEvidence" in postgres.repository).toBeFalse();
  });

  test("processor response CAS and signer evidence append share one transaction", async () => {
    const current = withRecipient(initial());
    const response = verifiedResponse(current);
    const memory = new InMemoryBackgroundAuthorizationRepository();
    await memory.create(initial());
    await memory.compareAndSwap({
      expectedRequestRevision: 0,
      next: current,
    });
    const accepted = await memory.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    const signer = evidenceFromResponse(
      response,
      START + 2,
      current.descriptorBytes!,
    );
    const postgres = await setup([
      [recordRow(current)],
      [recordRow(current)],
      [recordRow(accepted.record)],
      [evidenceRow(signer)],
    ]);

    expect(await postgres.repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).toMatchObject({ status: "accepted" });
    expect(postgres.connection.transactions).toBe(1);
    const updateIndex = postgres.connection.statements.findIndex((statement) =>
      normalizedSql(statement).startsWith("UPDATE BACKGROUND_CRYPTO")
    );
    const evidenceIndex = postgres.connection.statements.findIndex(
      (statement) =>
        normalizedSql(statement).startsWith("INSERT INTO PROCESSOR_CRYPTO_SIGNER"),
    );
    expect(updateIndex).toBeGreaterThan(0);
    expect(evidenceIndex).toBeGreaterThan(updateIndex);
  });

  test("an exact response losing the Postgres CAS is classified as duplicate", async () => {
    const current = withRecipient(initial());
    const response = verifiedResponse(current);
    const memory = new InMemoryBackgroundAuthorizationRepository();
    await memory.create(initial());
    await memory.compareAndSwap({
      expectedRequestRevision: 0,
      next: current,
    });
    const accepted = await memory.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    const postgres = await setup([
      [recordRow(current)],
      [recordRow(current)],
      [],
      [recordRow(accepted.record)],
    ]);

    expect(await postgres.repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).toMatchObject({
      status: "duplicate",
      current: { snapshot: { requestRevision: 2, state: "grant_ready" } },
    });
  });

  test("signer conflict aborts the transaction after CAS instead of leaving partial authority", async () => {
    const current = withRecipient(initial());
    const response = verifiedResponse(current);
    const memory = new InMemoryBackgroundAuthorizationRepository();
    await memory.create(initial());
    await memory.compareAndSwap({
      expectedRequestRevision: 0,
      next: current,
    });
    const accepted = await memory.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    });
    if (accepted.status !== "accepted") throw new Error("expected acceptance");
    const conflicting = {
      ...evidenceFromResponse(
        response,
        START + 2,
        current.descriptorBytes!,
      ),
      authorizationId: "authorization_conflict",
    };
    const postgres = await setup([
      [recordRow(current)],
      [recordRow(current)],
      [recordRow(accepted.record)],
      [],
      [evidenceRow(conflicting)],
    ]);

    // eslint-disable-next-line @typescript-eslint/await-thenable -- bun expect().rejects
    await expect(postgres.repository.acceptVerifiedResponse({
      response,
      acceptedAt: START + 2,
    })).rejects.toThrow("signer_evidence_conflict");
    expect(postgres.connection.transactionFailures).toBe(1);
  });
});


describe("unconsumed processor fallback cancellation", () => {
  test("locks the exact request before cancelling and preserves the work identity", async () => {
    const current = initialProcessorV2();
    const next = {...current, snapshot: cancelBackgroundAuthorizationRequest(current.snapshot, "cancelled", START + 1), finishedAt: START + 1};
    const f = await setup([[recordRow(current)], [recordRow(current)], [], [recordRow(current)], [recordRow(next)]]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected: current, now: START + 1})).toBe(true);
    const statements = f.connection.statements.map(normalizedSql);
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements.findIndex((sql) => sql.includes("PROCESSOR_CRYPTO_SIGNER_AUTHORIZATIONS")))
      .toBeLessThan(statements.findIndex((sql) => sql.startsWith("UPDATE")));
    expect(statements.filter((sql) => sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(current.snapshot.state).toBe("awaiting_recipient");
  });
  test("retries a cancellation committed before the outer product transaction failed", async () => {
    const expected = initialProcessorV2();
    const cancelled = {...expected, snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, "cancelled", START + 1), finishedAt: START + 1};
    for (const observed of [expected, cancelled]) {
      const f = await setup([[recordRow(cancelled)], [recordRow(cancelled)], []]);
      expect(await f.repository.cancelUnconsumedProcessorRequest({expected: observed, now: START + 2})).toBe(true);
      expect(f.connection.statements.some((sql) => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
      expect(f.connection.statements.some((sql) => normalizedSql(sql).includes("PROCESSOR_CRYPTO_SIGNER_AUTHORIZATIONS"))).toBe(true);
    }
  });
  test.each(["accepted_history", "commit_marker", "different_identity", "superseded"])("cancelled replay refuses %s", async (scenario) => {
    const initial = initialProcessorV2();
    const cancelled = {...initial, snapshot: cancelBackgroundAuthorizationRequest(initial.snapshot,
      scenario === "superseded" ? "superseded" : "cancelled", START + 1), finishedAt: START + 1};
    const expected = scenario === "different_identity" ? {...cancelled, workIdentityHash: new Uint8Array(32).fill(99)} : cancelled;
    const row = {...recordRow(cancelled), ...(scenario === "commit_marker" ? {transform_committed_at: new Date(START + 1)} : {})};
    const f = await setup([[row], [recordRow(cancelled)], ...(scenario === "accepted_history" ? [[{authorization_id: "old-grant"}]] : [])]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected, now: START + 2})).toBe(false);
    expect(f.connection.statements.some((sql) => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
  });
  test("finds the retained exact idempotency key without recreating its terminal row", async () => {
    const initial = initialProcessorV2();
    const cancelled = {...initial, snapshot: cancelBackgroundAuthorizationRequest(initial.snapshot, "cancelled", START + 1), finishedAt: START + 1};
    const f = await setup([[recordRow(cancelled)]]);
    expect(await f.repository.getByIdempotencyKey(cancelled.idempotencyKey)).toEqual(cancelled);
    expect(normalizedSql(f.connection.statements.at(-1))).toContain("WHERE BACKGROUND_CRYPTO_AUTHORIZATION_REQUESTS.IDEMPOTENCY_KEY =");
    const memory = new InMemoryBackgroundAuthorizationRepository(); await memory.create(cancelled);
    expect(await memory.getByIdempotencyKey(cancelled.idempotencyKey)).toEqual(cancelled);
    expect(await memory.getByIdempotencyKey("missing-key")).toBeNull();
  });
  test.each(["changed_revision", "prior_acceptance", "crypto_commit"])("refuses %s without a cancellation write", async (scenario) => {
    const current = initialProcessorV2();
    const different = scenario === "changed_revision" ? {...current, workIdentityHash: new Uint8Array(32).fill(99)} : current;
    const locked = {...recordRow(current), ...(scenario === "crypto_commit" ? {transform_commit_output_count: 0} : {})};
    const f = await setup([[locked], [recordRow(different)], ...(scenario === "prior_acceptance" ? [[{authorization_id: "retained-earlier-grant"}]] : [])]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected: current, now: START + 1})).toBe(false);
    expect(f.connection.statements.some((sql) => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
  });
  test("a response winner changed the queued snapshot before handoff", async () => {
    const current = initialProcessorV2();
    const changed = withRecipient(current);
    const f = await setup([[recordRow(changed)], [recordRow(changed)]]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected: current, now: START + 2})).toBe(false);
    expect(f.connection.statements.some((sql) => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
  });
});


describe("current processor plan supersession", () => {
  function plans() {
    const expected = initialProcessorV2();
    const identity = new Uint8Array(32).fill(77);
    const successor: BackgroundAuthorizationRecord = {...expected, workIdentityHash: identity,
      idempotencyKey: `stenographer-processor-v2:${Buffer.from(identity).toString("hex")}`, expectedPolicyRevision: expected.expectedPolicyRevision + 1,
      snapshot: {...expected.snapshot, requestId: "successor-request", updatedAt: START + 1}};
    const cancelled = {...expected, snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, "superseded", START + 1), finishedAt: START + 1};
    return {expected, successor, cancelled};
  }
  test("one restricted transaction locks old request and atomically cancels then creates", async () => {
    const {expected, successor, cancelled} = plans();
    const f = await setup([[recordRow(expected)], [recordRow(expected)], [recordRow(cancelled)], [recordRow(successor)]]);
    expect(await f.repository.supersedeUnstartedProcessorRequest({expected, successor, now: START + 1})).toEqual({status: "superseded", record: successor});
    const statements = f.connection.statements.map(normalizedSql);
    expect(statements[1]).toContain("FOR UPDATE");
    expect(statements.filter(sql => sql.startsWith("UPDATE"))).toHaveLength(1);
    expect(statements.filter(sql => sql.startsWith("INSERT"))).toHaveLength(1);
    expect(f.connection.transactions).toBe(1);
  });
  test("a retry of the exact old cancellation returns only its existing successor", async () => {
    const {expected, successor, cancelled} = plans();
    const f = await setup([[recordRow(cancelled)], [recordRow(successor)]]);
    expect(await f.repository.supersedeUnstartedProcessorRequest({expected, successor, now: START + 1})).toEqual({status: "existing", record: successor});
    expect(f.connection.statements.some(sql => /^(UPDATE|INSERT)/.test(normalizedSql(sql)))).toBe(false);
  });
  test.each(["transform_commit_claim_id", "transform_commit_output_count", "transform_committed_at"])("retained %s forbids another execution", async column => {
    const {expected, successor} = plans();
    const f = await setup([[{...recordRow(expected), [column]: column === "transform_commit_output_count" ? 0 : "reserved"}]]);
    expect((await f.repository.supersedeUnstartedProcessorRequest({expected, successor, now: START + 1})).status).toBe("stale");
    expect(f.connection.statements.some(sql => /^(UPDATE|INSERT)/.test(normalizedSql(sql)))).toBe(false);
  });
  test("a successor collision fails the whole cancellation transaction", async () => {
    const {expected, successor, cancelled} = plans();
    const f = await setup([[recordRow(expected)], [recordRow(expected)], [recordRow(cancelled)], [], [recordRow({...successor, domainId: "wrong-domain"})]]);
    expect(await f.repository.supersedeUnstartedProcessorRequest({expected, successor, now: START + 1}).catch((cause: unknown) => cause)).toBeInstanceOf(BackgroundAuthorizationRepositoryConflictError);
    expect(f.connection.transactionFailures).toBe(1);
  });
});


describe("obsolete unconsumed processor retirement", () => {
  test("marks superseded under the same exact no-consumption fence and can resume a committed cancellation", async () => {
    const expected = initialProcessorV2();
    const retired = {...expected, snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, "superseded", START + 1), finishedAt: START + 1};
    const f = await setup([[recordRow(expected)], [recordRow(expected)], [], [recordRow(expected)], [recordRow(retired)]]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected, now: START + 1, reason: "superseded"})).toBe(true);
    const retry = await setup([[recordRow(retired)], [recordRow(retired)], []]);
    expect(await retry.repository.cancelUnconsumedProcessorRequest({expected, now: START + 2, reason: "superseded"})).toBe(true);
    expect(retry.connection.statements.some(sql => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
  });
  test("cannot retire a committed transform", async () => {
    const expected = initialProcessorV2();
    const f = await setup([[{...recordRow(expected), transform_commit_output_count: 0}], [recordRow(expected)]]);
    expect(await f.repository.cancelUnconsumedProcessorRequest({expected, now: START + 1, reason: "superseded"})).toBe(false);
    expect(f.connection.statements.some(sql => normalizedSql(sql).startsWith("UPDATE"))).toBe(false);
  });
});


test("obsolete request retirement preserves signer history while fencing its unconsumed grant", async () => {
  const expected = initialProcessorV2();
  const retired = {...expected, snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, "superseded", START + 1), finishedAt: START + 1};
  const f = await setup([[recordRow(expected)], [recordRow(expected)], [{authorization_id: "retained-unused-grant"}],
    [recordRow(expected)], [recordRow(retired)]]);
  expect(await f.repository.cancelUnconsumedProcessorRequest({expected, now: START + 1, reason: "superseded"})).toBe(true);
  expect(f.connection.statements.some(sql => normalizedSql(sql).startsWith("DELETE"))).toBe(false);
});
