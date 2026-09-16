import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptObjectPayload,
  humanId,
  namespaceGeneration,
  namespaceId,
  objectId,
  unixTimestamp,
  wrapObjectDekForNamespace,
} from "@nautilo/lattice-crypto";
import {
  PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
  createCurrentProcessorObjectAccessManifestV4,
  createProcessorObjectAccessManifestV4,
  createProcessorObjectSignerPublicV1,
  createProcessorSignerAuthorizationV1,
  encodeBackgroundWorkDescriptorV1,
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  encodeObjectAccessManifestV4,
  objectAccessManifestSigningBytesV4,
  signProcessorObjectBytesV1,
  type BackgroundWorkDescriptorV1,
  type ObjectAccessManifestUnsignedV4,
} from "@nautilo/lattice-crypto/wire";
import {
  createBackgroundAuthorizationResponseV2,
  decodeBackgroundAuthorizationResponseV2,
  encodeBackgroundWorkDescriptorV2,
  verifyProcessorSignerAuthorizationV2,
  withOpenedBackgroundAuthorizationV2,
  type BackgroundAuthorizationIssuerV2,
  type BackgroundProcessorWorkDescriptorV2,
} from "@nautilo/lattice-crypto/background";

import {
  PostgresProtectedJournalProcessorObjectVerifier,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/gu, " ").trim()
    .toLowerCase();
}

class ScriptedConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters: [...parameters] });
    if (
      statement.includes(
        "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY",
      )
    ) return Promise.resolve([]);
    const result = this.#results.shift();
    if (result === undefined) throw new Error(`Unexpected SQL: ${statement}`);
    return Promise.resolve(result as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

const NOW = 1_800_000_000_000;
const OBJECT_ID = "journal:event:protected-1";
const OTHER_OUTPUT_ID = "journal:event:protected-2";
const NAMESPACE_ID = "namespace-protected-journal";
const DOMAIN_ID = "domain-protected-journal";
const WORK_ID = "stenographer-work-1";
const REQUEST_ID = "background-request-1";
const AUTHORIZATION_ID = "processor-signer-auth-1";
const HUMAN_ID = "human-alice";
const DEVICE_ID = "device-alice";

function seededRng(seed: number) {
  let state = seed >>> 0;
  return (length: number): Uint8Array => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

function fixture() {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x241_10) },
    { now: () => NOW },
  );
  const issuer = crypto.generateSigningKeyPair();
  const processorSigner = crypto.generateSigningKeyPair();
  const descriptor: BackgroundWorkDescriptorV1 = {
    formatVersion: 1,
    requestId: REQUEST_ID,
    recipientGeneration: 2,
    workKind: "stenographer.extraction",
    workId: WORK_ID,
    namespaceId: namespaceId(NAMESPACE_ID),
    domainId: cryptoDomainId(DOMAIN_ID),
    subject: {
      kind: "processor",
      processorKind: "stenographer",
      processorVersion: 1,
      authorizationRevision: authorizationRevision(11),
    },
    purpose: "journal.extract",
    operations: ["decrypt", "encrypt"],
    source: {
      kind: "journal_range",
      startSequence: 40,
      endSequence: 44,
      rebuildGeneration: 7,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputObjectIds: [objectId("message:protected:40")],
    outputObjectIds: [objectId(OBJECT_ID), objectId(OTHER_OUTPUT_ID)],
    outputObjectMetadata: [{
      objectId: objectId(OBJECT_ID),
      objectType: "nautilo-room-event-v1",
      createdAt: unixTimestamp(NOW),
    }, {
      objectId: objectId(OTHER_OUTPUT_ID),
      objectType: "nautilo-room-event-v1",
      createdAt: unixTimestamp(NOW + 1),
    }],
    maximumInputObjectCount: 1,
    maximumOutputObjectCount: 2,
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    expectedDomainEpoch: domainEpoch(4),
    expectedNamespaceAccessRevision: accessRevision(8),
    expectedPolicyRevision: authorizationRevision(9),
    recipientKeyId: "recipient-key-2",
    recipientPublicKey: new Uint8Array(65).fill(0x51),
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 300_000,
    idempotencyId: "stenographer-attempt-1",
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV1(descriptor);
  const descriptorHash = crypto.hash(descriptorBytes);
  const processorPrincipal = createProcessorObjectSignerPublicV1(crypto, {
    processorKind: "stenographer",
    processorVersion: 1,
    signerAuthorizationId: AUTHORIZATION_ID,
    workDescriptorHash: descriptorHash,
    signerPrivateKey: processorSigner.privateKey,
  }).principal;
  const credentialHash = new Uint8Array(32).fill(0x61);
  const signerAuthorization = createProcessorSignerAuthorizationV1(
    crypto,
    {
      formatVersion:
        PROCESSOR_SIGNER_AUTHORIZATION_FORMAT_VERSION_V1,
      id: AUTHORIZATION_ID,
      processorKind: "stenographer",
      processorVersion: 1,
      workId: WORK_ID,
      namespaceId: namespaceId(NAMESPACE_ID),
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(4),
      namespaceAccessRevision: accessRevision(8),
      policyRevision: authorizationRevision(9),
      processorAuthorizationRevision: authorizationRevision(11),
      issuingHumanId: humanId(HUMAN_ID),
      issuingDeviceId: cryptoDeviceId(DEVICE_ID),
      issuingDeviceAuthorizationRevision: authorizationRevision(6),
      issuerSigningPublicKeyHash: crypto.hash(issuer.publicKey),
      signer: processorPrincipal,
      signerPublicKey: processorSigner.publicKey,
      workDescriptorHash: descriptorHash,
      credentialHash,
      outputObjectIds: [objectId(OBJECT_ID), objectId(OTHER_OUTPUT_ID)],
      maxOutputObjects: 2,
      maxOutputPlaintextBytes: 64 * 1_024,
      maxOutputCiphertextBytes: 96 * 1_024,
      issuedAt: NOW,
      expiresAt: NOW + 300_000,
    },
    issuer.privateKey,
  );
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(OBJECT_ID),
      keyClass: "ai",
      objectType: "nautilo-room-event-v1",
      createdAt: unixTimestamp(NOW),
    },
    new TextEncoder().encode("protected journal payload"),
  );
  const envelope = wrapObjectDekForNamespace(
    crypto,
    new Uint8Array(32).fill(0x71),
    {
      objectId: objectId(OBJECT_ID),
      namespaceId: namespaceId(NAMESPACE_ID),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(3),
      bindingRevisionAtWrap: accessRevision(8),
    },
    encrypted.dek,
  );
  encrypted.dek.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const payloadHash = crypto.hash(payloadBytes);
  const envelopeHash = crypto.hash(envelopeBytes);
  const manifest = createProcessorObjectAccessManifestV4(
    crypto,
    {
      objectId: objectId(OBJECT_ID),
      payloadHash,
      accessRevision: accessRevision(0),
      previousManifestHash: null,
      envelopeHashes: [envelopeHash],
      signer: processorPrincipal,
      signerAuthorizationHash: signerAuthorization.hash,
      hostAuthorizationRevision: authorizationRevision(11),
    },
    {
      signerPrivateKey: processorSigner.privateKey,
      signerAuthorizationBytes: signerAuthorization.bytes,
      now: NOW,
      resolveCurrentIssuingDevicePublicKey: () => issuer.publicKey,
    },
  );

  const objectRow = {
    object_id: OBJECT_ID,
    object_payload_hash: payloadHash,
    payload_bytes: payloadBytes,
    head_access_revision: 0,
    head_manifest_hash: manifest.hash,
    manifest_object_id: OBJECT_ID,
    manifest_access_revision: 0,
    manifest_hash: manifest.hash,
    previous_manifest_hash: null,
    manifest_payload_hash: payloadHash,
    manifest_bytes: manifest.bytes,
  };
  const authorizationRow = {
    authorization_id: AUTHORIZATION_ID,
    request_id: REQUEST_ID,
    recipient_generation: 2,
    processor_kind: "stenographer",
    processor_version: 1,
    work_id: WORK_ID,
    namespace_id: NAMESPACE_ID,
    domain_id: DOMAIN_ID,
    domain_epoch: 4,
    namespace_access_revision: 8,
    policy_revision: 9,
    processor_authorization_revision: 11,
    issuing_human_id: HUMAN_ID,
    issuing_device_id: DEVICE_ID,
    issuing_device_authorization_revision: 6,
    issuer_signing_public_key_hash: crypto.hash(issuer.publicKey),
    signer_key_id: processorPrincipal.signerKeyId,
    signer_public_key: processorSigner.publicKey,
    work_descriptor_hash: descriptorHash,
    work_descriptor_bytes: descriptorBytes,
    authorization_hash: signerAuthorization.hash,
    credential_hash: credentialHash,
    authorization_bytes: signerAuthorization.bytes,
    issued_at_ms: NOW,
    expires_at_ms: NOW + 300_000,
  };
  const requestRow = {
    request_id: REQUEST_ID,
    work_id: WORK_ID,
    work_kind: "stenographer.extraction",
    purpose: "journal.extract",
    namespace_id: NAMESPACE_ID,
    domain_id: DOMAIN_ID,
    credential_subject_kind: "processor",
    processor_kind: "stenographer",
    processor_version: 1,
    processor_authorization_revision: 11,
    expected_domain_epoch: 4,
    expected_namespace_access_revision: 8,
    expected_policy_revision: 9,
    recipient_generation: 2,
    descriptor_hash: descriptorHash,
    descriptor_bytes: descriptorBytes,
    accepted_response_kind: "processor",
    credential_hash: credentialHash,
    issuing_human_id: HUMAN_ID,
    issuing_device_id: DEVICE_ID,
    issuing_device_authorization_revision: 6,
    issuer_signing_public_key_hash: crypto.hash(issuer.publicKey),
    state: "completed",
  };
  const deviceRow = {
    device_id: DEVICE_ID,
    human_id: HUMAN_ID,
    signing_public_key: issuer.publicKey,
    revision: 8,
  };
  const envelopeRow = {
    object_id: OBJECT_ID,
    access_revision: 0,
    namespace_id: NAMESPACE_ID,
    ordinal: 0,
    envelope_hash: envelopeHash,
    envelope_bytes: envelopeBytes,
  };
  return {
    crypto,
    payloadBytes,
    envelopeBytes,
    rows: [
      [objectRow],
      [authorizationRow],
      [deviceRow],
      [requestRow],
      [envelopeRow],
    ] as unknown[][],
  };
}

type CurrentFixtureVariant = Readonly<{
  payloadObjectId?: string;
  envelopeNamespaceId?: string;
  unauthorizedOutput?: boolean;
}>;

async function currentFixture(variant: CurrentFixtureVariant = {}) {
  const crypto = new LatticeCrypto(
    { bytes: seededRng(0x317_40) },
    { now: () => NOW },
  );
  const issuerKey = crypto.generateSigningKeyPair();
  const recipient = await crypto.generateEncryptionKeyPair();
  const descriptor: BackgroundProcessorWorkDescriptorV2 = {
    formatVersion: 2,
    requestId: "background-request-current-1",
    recipientGeneration: 4,
    workKind: "stenographer.historical",
    workId: "stenographer-current-work-1",
    anchorNamespaceId: NAMESPACE_ID,
    anchorDomainId: DOMAIN_ID,
    subject: {kind: "processor", processorKind: "stenographer", processorVersion: 1},
    operations: ["decrypt", "encrypt"],
    purpose: "journal.extract",
    authority: {
      serverId: "server-current-1",
      roomId: "room-current-1",
      namespaceId: NAMESPACE_ID,
      namespaceAccessRevision: 8,
      namespaceKeyGeneration: 3,
      namespaceHeadDigest: new Uint8Array(32).fill(0x21),
      domainId: DOMAIN_ID,
      domainKeyGeneration: 4,
      domainAuthorizationRevision: 12,
      domainHeadDigest: new Uint8Array(32).fill(0x22),
      bundleRevision: 13,
      bundleDigest: new Uint8Array(32).fill(0x23),
    },
    policyRevision: 9,
    source: {
      kind: "stenographer_work",
      startSequence: 40,
      endSequence: 44,
      rebuildGeneration: 7,
      fingerprint: new Uint8Array(32).fill(0x41),
    },
    inputBindings: [{objectId: "message:protected:40", namespaceId: NAMESPACE_ID}],
    outputSlots: [...(variant.unauthorizedOutput ? [] : [{
      objectId: OBJECT_ID,
      objectType: "nautilo.reflection.record.v1" as const,
      createdAt: NOW,
      namespaceIds: [NAMESPACE_ID],
    }]), {
      objectId: OTHER_OUTPUT_ID,
      objectType: "nautilo.reflection.record.v1" as const,
      createdAt: NOW + 1,
      namespaceIds: [NAMESPACE_ID],
    }],
    maximumPlaintextBytes: 64 * 1_024,
    maximumCiphertextBytes: 96 * 1_024,
    recipientKeyId: "recipient-key-current-4",
    recipientPublicKey: recipient.publicKey,
    issuedAt: NOW,
    notBefore: NOW,
    expiresAt: NOW + 300_000,
    idempotencyId: "stenographer-current-attempt-1",
  };
  const issuer: BackgroundAuthorizationIssuerV2 = {
    humanId: HUMAN_ID,
    deviceId: DEVICE_ID,
    deviceGeneration: 5,
    serverInstanceId: "server-instance-current-1",
    lineageGeneration: 6,
    epoch: 7,
    securityRevision: 11,
    headDigest: new Uint8Array(32).fill(0x31),
    signingPublicKeyHash: crypto.hash(issuerKey.publicKey),
  };
  const descriptorBytes = encodeBackgroundWorkDescriptorV2(descriptor);
  const responseBytes = await createBackgroundAuthorizationResponseV2(crypto, {
    credentialId: "processor-signer-auth-current-1",
    descriptorBytes,
    issuer,
    issuerSigningPrivateKey: issuerKey.privateKey,
    domainKey: new Uint8Array(32).fill(0x51),
  });
  const { credentialBytes, signerAuthorizationBytes } =
    decodeBackgroundAuthorizationResponseV2(responseBytes);
  const encrypted = encryptObjectPayload(
    crypto,
    {
      objectId: objectId(variant.payloadObjectId ?? OBJECT_ID),
      keyClass: "ai",
      objectType: "nautilo.reflection.record.v1",
      createdAt: unixTimestamp(NOW),
    },
    new TextEncoder().encode("current protected journal payload"),
  );
  const envelope = wrapObjectDekForNamespace(
    crypto,
    new Uint8Array(32).fill(0x71),
    {
      objectId: objectId(OBJECT_ID),
      namespaceId: namespaceId(
        variant.envelopeNamespaceId ?? NAMESPACE_ID,
      ),
      keyClass: "ai",
      keyGeneration: namespaceGeneration(3),
      bindingRevisionAtWrap: accessRevision(8),
    },
    encrypted.dek,
  );
  encrypted.dek.fill(0);
  const payloadBytes = encodeEncryptedPayloadV2(encrypted.payload);
  const envelopeBytes = encodeNamespaceObjectEnvelopeV2(envelope);
  const payloadHash = crypto.hash(payloadBytes);
  const envelopeHash = crypto.hash(envelopeBytes);
  const manifest = await withOpenedBackgroundAuthorizationV2(crypto, {
    responseBytes,
    recipientPrivateKey: recipient.privateKey,
    now: () => NOW + 1,
    resolveCurrentIssuer: () => issuerKey.publicKey,
    use: ({ verified, signerPrivateKey }) => {
      const unsigned: ObjectAccessManifestUnsignedV4 = {
          objectId: objectId(OBJECT_ID),
          payloadHash,
          accessRevision: accessRevision(0),
          previousManifestHash: null,
          envelopeHashes: [envelopeHash],
          signer: verified.signer,
          signerAuthorizationHash: verified.signerAuthorizationHash,
          hostAuthorizationRevision: authorizationRevision(
            issuer.securityRevision,
          ),
      };
      if (variant.unauthorizedOutput) {
        const signingBytes = objectAccessManifestSigningBytesV4(unsigned);
        const signature = signProcessorObjectBytesV1(crypto, {
          principal: verified.signer,
          signerPrivateKey,
          message: signingBytes,
        });
        signingBytes.fill(0);
        const bytes = encodeObjectAccessManifestV4({
          ...unsigned,
          formatVersion: 4,
          signature,
        });
        return { bytes, hash: crypto.hash(bytes) };
      }
      return createCurrentProcessorObjectAccessManifestV4(
        crypto,
        unsigned,
        { signerPrivateKey, signerAuthorizationBytes,
          issuerSigningPublicKey: issuerKey.publicKey, now: NOW + 1 },
      );
    },
  });
  const authorizationHash = crypto.hash(signerAuthorizationBytes);
  const descriptorHash = crypto.hash(descriptorBytes);
  const certificate = verifyProcessorSignerAuthorizationV2(crypto, {
    authorizationBytes: signerAuthorizationBytes,
    issuerSigningPublicKey: issuerKey.publicKey,
  });
  const authorizationRow = {
    authorization_id: "processor-signer-auth-current-1",
    format_version: 2,
    request_id: descriptor.requestId,
    recipient_generation: descriptor.recipientGeneration,
    processor_kind: descriptor.subject.processorKind,
    processor_version: descriptor.subject.processorVersion,
    work_id: descriptor.workId,
    namespace_id: descriptor.authority.namespaceId,
    domain_id: descriptor.authority.domainId,
    domain_epoch: null,
    namespace_access_revision: descriptor.authority.namespaceAccessRevision,
    policy_revision: descriptor.policyRevision,
    processor_authorization_revision: null,
    issuing_human_id: issuer.humanId,
    issuing_device_id: issuer.deviceId,
    issuing_device_authorization_revision: issuer.securityRevision,
    issuer_signing_public_key_hash: issuer.signingPublicKeyHash,
    signer_key_id: certificate.signer.signerKeyId,
    signer_public_key: certificate.signerPublicKey,
    work_descriptor_hash: descriptorHash,
    work_descriptor_bytes: descriptorBytes,
    authorization_hash: authorizationHash,
    credential_hash: crypto.hash(credentialBytes),
    authorization_bytes: signerAuthorizationBytes,
    issued_at_ms: NOW,
    expires_at_ms: NOW + 300_000,
    issued_at: new Date(NOW),
    expires_at: new Date(NOW + 300_000),
    created_at: new Date(NOW + 1),
  };
  const objectRow = {
    object_id: OBJECT_ID,
    object_payload_hash: payloadHash,
    payload_bytes: payloadBytes,
    head_access_revision: 0,
    head_manifest_hash: manifest.hash,
    manifest_object_id: OBJECT_ID,
    manifest_access_revision: 0,
    manifest_hash: manifest.hash,
    previous_manifest_hash: null,
    manifest_payload_hash: payloadHash,
    manifest_bytes: manifest.bytes,
  };
  const deviceRow = {
    device_id: DEVICE_ID,
    human_id: HUMAN_ID,
    device_generation: issuer.deviceGeneration,
    signing_public_key: issuerKey.publicKey,
    state: "revoked",
  };
  const envelopeRow = {
    object_id: OBJECT_ID,
    access_revision: 0,
    namespace_id: NAMESPACE_ID,
    ordinal: 0,
    envelope_hash: envelopeHash,
    envelope_bytes: envelopeBytes,
  };
  return {
    crypto,
    descriptor,
    payloadBytes,
    envelopeBytes,
    rows: [
      [objectRow],
      [authorizationRow],
      [authorizationRow],
      [deviceRow],
      [envelopeRow],
    ] as unknown[][],
  };
}

async function currentSubject(state: Awaited<ReturnType<typeof currentFixture>>) {
  const connection = new ScriptedConnection([
    [{
      current_user: "nautilo_crypto",
      session_user: "nautilo_crypto",
    }],
    ...state.rows,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    verifier: new PostgresProtectedJournalProcessorObjectVerifier(
      state.crypto,
      handle,
    ),
  };
}

async function subject(state: ReturnType<typeof fixture>) {
  const connection = new ScriptedConnection([
    [{
      current_user: "nautilo_crypto",
      session_user: "nautilo_crypto",
    }],
    ...state.rows,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    verifier: new PostgresProtectedJournalProcessorObjectVerifier(
      state.crypto,
      handle,
    ),
  };
}

function mutateRow(
  state: ReturnType<typeof fixture>,
  resultIndex: number,
  changes: Record<string, unknown>,
): void {
  state.rows[resultIndex] = [{
    ...(state.rows[resultIndex]![0] as Record<string, unknown>),
    ...changes,
  }];
}

describe("Postgres protected journal processor object verifier", () => {
  test("requires a verified nautilo_crypto database handle", () => {
    const state = fixture();
    const forged = new ScriptedConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() =>
      new PostgresProtectedJournalProcessorObjectVerifier(
        state.crypto,
        forged,
      )
    ).toThrow("verified nautilo_crypto handle");
  });

  test("returns null only when the canonical crypto object is absent", async () => {
    const state = fixture();
    state.rows[0] = [];
    const { verifier } = await subject(state);
    expect(await verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    })).toBeNull();
  });

  test("preserves partial-object detection and rejects non-portable ids before SQL", async () => {
    const state = fixture();
    const { connection, verifier } = await subject(state);
    await verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    });
    expect(connection.queries[1]?.statement).toContain(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE READ ONLY",
    );
    expect(normalizedSql(connection.queries[2]?.statement ?? "")).toContain(
      "left join object_crypto_access_heads",
    );
    const before = connection.queries.length;
    expect(verifier.verify({
      objectId: "",
      signal: new AbortController().signal,
    })).rejects.toThrow();
    expect(connection.queries).toHaveLength(before);
  });

  test("authenticates the complete stored processor-object provenance and transfers owned bytes", async () => {
    const state = fixture();
    const { connection, verifier } = await subject(state);
    const verified = await verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    });

    expect(verified).toEqual({
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      workId: WORK_ID,
      rebuildGeneration: 7,
      outputOrdinal: 0,
      authorizedOutputObjectIds: [OBJECT_ID, OTHER_OUTPUT_ID],
      publisherNamespaceAccessRevision: 8,
      payloadBytes: state.payloadBytes,
      namespaceEnvelopeBytes: state.envelopeBytes,
    });
    expect(verified?.payloadBytes).not.toBe(state.payloadBytes);
    expect(verified?.namespaceEnvelopeBytes).not.toBe(state.envelopeBytes);
    expect(connection.queries.slice(2).every(
      ({ statement }) => normalizedSql(statement).includes("limit"),
    )).toBe(true);
  });

  test.each([
    ["payload hash substitution", 0, {
      object_payload_hash: new Uint8Array(32).fill(0x01),
    }],
    ["head manifest substitution", 0, {
      head_manifest_hash: new Uint8Array(32).fill(0x02),
    }],
    ["manifest access substitution", 0, {
      manifest_access_revision: 1,
    }],
    ["manifest payload substitution", 0, {
      manifest_payload_hash: new Uint8Array(32).fill(0x21),
    }],
    ["signer authorization hash substitution", 1, {
      authorization_hash: new Uint8Array(32).fill(0x03),
    }],
    ["signer authorization bytes substitution", 1, {
      authorization_bytes: new Uint8Array([1, 2, 3]),
    }],
    ["signer authorization work substitution", 1, {
      work_id: "other-work",
    }],
    ["signer authorization Namespace substitution", 1, {
      namespace_id: "other-namespace",
    }],
    ["signer authorization access substitution", 1, {
      namespace_access_revision: 99,
    }],
    ["durable descriptor request-link substitution", 1, {
      request_id: "other-request",
    }],
    ["durable descriptor generation-link substitution", 1, {
      recipient_generation: 3,
    }],
    ["durable descriptor hash substitution", 1, {
      work_descriptor_hash: new Uint8Array(32).fill(0x31),
    }],
    ["durable descriptor bytes substitution", 1, {
      work_descriptor_bytes: new Uint8Array([1, 2, 3]),
    }],
    ["accepted request descriptor substitution", 3, {
      descriptor_hash: new Uint8Array(32).fill(0x04),
    }],
    ["accepted request descriptor bytes substitution", 3, {
      descriptor_bytes: new Uint8Array([1, 2, 3]),
    }],
    ["accepted request state substitution", 3, {
      state: "cancelled",
    }],
    ["pre-execution request state substitution", 3, {
      state: "grant_ready",
    }],
    ["historical issuing device substitution", 2, {
      human_id: "human-mallory",
    }],
    ["historical issuing key substitution", 2, {
      signing_public_key: new Uint8Array(32).fill(0x05),
    }],
    ["historical issuing revision rollback", 2, {
      revision: 5,
    }],
    ["Namespace envelope substitution", 4, {
      namespace_id: "other-namespace",
    }],
    ["Namespace envelope hash substitution", 4, {
      envelope_hash: new Uint8Array(32).fill(0x06),
    }],
  ])("fails closed on %s", async (
    _label,
    resultIndex,
    changes,
  ) => {
    const state = fixture();
    mutateRow(state, resultIndex, changes);
    const { verifier } = await subject(state);
    expect(verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  test("throws rather than treating missing provenance as a missing object", async () => {
    for (const resultIndex of [1, 2, 4]) {
      const state = fixture();
      state.rows[resultIndex] = [];
      const { verifier } = await subject(state);
      expect(verifier.verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      })).rejects.toThrow();
    }
  });

  test("continues historical verification after the request audit row is pruned", async () => {
    const state = fixture();
    state.rows[3] = [];
    const { verifier } = await subject(state);
    expect((await verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    }))?.workId).toBe(WORK_ID);
  });

  test("keeps the durable descriptor linked after the request audit row is pruned", async () => {
    const state = fixture();
    mutateRow(state, 1, { request_id: "other-request" });
    state.rows[3] = [];
    const { verifier } = await subject(state);
    expect(verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    })).rejects.toThrow("descriptor request coordinates");
  });

  test("reads a current V2 Journal object from retained evidence after request pruning and device revocation", async () => {
    const state = await currentFixture();
    const { connection, verifier } = await currentSubject(state);

    const verified = await verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    });

    expect(verified).toEqual({
      objectId: OBJECT_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      workId: state.descriptor.workId,
      rebuildGeneration: 7,
      outputOrdinal: 0,
      authorizedOutputObjectIds: [OBJECT_ID, OTHER_OUTPUT_ID],
      publisherNamespaceAccessRevision: 8,
      payloadBytes: state.payloadBytes,
      namespaceEnvelopeBytes: state.envelopeBytes,
    });
    expect(connection.queries.some(({ statement }) =>
      normalizedSql(statement).includes(
        "from background_crypto_authorization_requests",
      )
    )).toBe(false);
    expect(connection.queries.some(({ statement }) =>
      normalizedSql(statement).includes("from human_crypto_devices")
    )).toBe(true);
  });

  test.each([
    ["output slot", { unauthorizedOutput: true }],
    ["payload binding", { payloadObjectId: OTHER_OUTPUT_ID }],
    ["envelope binding", { envelopeNamespaceId: "other-namespace" }],
  ] as const)("rejects a current V2 Journal %s substitution", async (
    _label,
    variant,
  ) => {
    const state = await currentFixture(variant);
    const { verifier } = await currentSubject(state);
    expect(verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    })).rejects.toThrow();
  });

  test("rejects substituted current V2 durable scope", async () => {
    const state = await currentFixture();
    state.rows[2] = [{
      ...(state.rows[2]![0] as Record<string, unknown>),
      namespace_id: "other-namespace",
    }];
    const { verifier } = await currentSubject(state);
    expect(verifier.verify({
      objectId: OBJECT_ID,
      signal: new AbortController().signal,
    })).rejects.toThrow("durable anchors");
  });

  test("rejects ambiguous duplicate provenance rows", async () => {
    for (const resultIndex of [0, 1, 2, 3]) {
      const state = fixture();
      state.rows[resultIndex] = [
        state.rows[resultIndex]![0]!,
        state.rows[resultIndex]![0]!,
      ];
      const { verifier } = await subject(state);
      expect(verifier.verify({
        objectId: OBJECT_ID,
        signal: new AbortController().signal,
      })).rejects.toThrow();
    }
  });
});
