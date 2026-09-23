import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import { decodeAnyBackgroundProcessorWorkDescriptorV2, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2 } from "@nautilo/lattice-crypto/background";
import {
  and,
  asc,
  backgroundCryptoAuthorizationDomainRequirements,
  backgroundCryptoAuthorizationNamespaceRequirements,
  backgroundCryptoAuthorizationRequests,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  isNotNull,
  lte,
  notExists,
  objectCryptoAccessHeads,
  objectCryptoNamespaceEnvelopes,
  or,
  processorCryptoSignerAuthorizations,
  sql,
} from "@nautilo/db";
import {
  BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES,
  BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
  BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS,
  parseBackgroundAuthorizationRequestSnapshot,
  cancelBackgroundAuthorizationRequest,
} from "./lifecycle";
import {
  BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH,
  BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS,
  BackgroundAuthorizationRepositoryConflictError,
  assertBackgroundAuthorizationCasSuccessor,
  assertUnstartedProcessorSupersession,
  isExactProcessorSupersessionCancellation,
  sameProcessorSupersessionPlan,
  type BackgroundAuthorizationSupersedeResult,
  backgroundAuthorizationVerifiedResponseRequestId,
  buildAcceptedBackgroundAuthorizationResponse,
  isBackgroundAuthorizationResponseReplay,
  parseBackgroundAuthorizationRecord,
  parseProcessorSignerAuthorizationEvidence,
  sameBackgroundAuthorizationRecord,
  sameProcessorSignerAuthorizationEvidence,
  type BackgroundAuthorizationAcceptedMaterial,
  type BackgroundAuthorizationAcceptResponseResult,
  type BackgroundAuthorizationAuthoritySetV2,
  type BackgroundAuthorizationAuthoritySetV3,
  type BackgroundAuthorizationCasResult,
  type BackgroundAuthorizationCreateResult,
  type BackgroundAuthorizationRecord,
  type BackgroundAuthorizationRepository,
  type BackgroundAuthorizationAwaitingDeviceCursor,
  type BackgroundAuthorizationAwaitingDevicePage,
  type BackgroundAuthorizationVerifiedDeviceResponse,
  type ProcessorSignerAuthorizationEvidence,
  type ProcessorSignerEvidenceAppendResult,
} from "./repository";

type Row = Readonly<Record<string, unknown>>;

function requiredString(row: Row, field: string): string {
  const value = row[field];
  if (typeof value !== "string") {
    throw new TypeError(`Background authorization column ${field} must be text`);
  }
  return value;
}

function nullableString(row: Row, field: string): string | null {
  return row[field] === null ? null : requiredString(row, field);
}

function requiredCounter(row: Row, field: string): number {
  const value = row[field];
  const normalized = typeof value === "bigint" || typeof value === "string"
    ? Number(value)
    : value;
  if (
    typeof normalized !== "number"
    || !Number.isSafeInteger(normalized)
    || normalized < 0
  ) {
    throw new TypeError(
      `Background authorization column ${field} must be a safe counter`,
    );
  }
  return normalized;
}

function nullableCounter(row: Row, field: string): number | null {
  return row[field] === null ? null : requiredCounter(row, field);
}

function nullableTimestamp(row: Row, field: string): number | null {
  const sourceField = row[field] === undefined ? `${field}_ms` : field;
  const value = row[sourceField];
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "string") {
    const milliseconds = Date.parse(value);
    if (Number.isSafeInteger(milliseconds) && milliseconds >= 0) {
      return milliseconds;
    }
  }
  return requiredCounter(row, sourceField);
}

function requiredTimestamp(row: Row, field: string): number {
  const value = nullableTimestamp(row, field);
  if (value === null) throw new TypeError(`${field} must be a timestamp`);
  return value;
}

function requiredBytes(row: Row, field: string): Uint8Array {
  const value = row[field];
  if (!(value instanceof Uint8Array)) {
    throw new TypeError(
      `Background authorization column ${field} must be bytea`,
    );
  }
  return Uint8Array.from(value);
}

function nullableBytes(row: Row, field: string): Uint8Array | null {
  return row[field] === null ? null : requiredBytes(row, field);
}

function hex(value: Uint8Array): string {
  return Buffer.from(value).toString("hex");
}

function bytes(hexDigest: string | null): Uint8Array | null {
  return hexDigest === null ? null : Uint8Array.from(Buffer.from(hexDigest, "hex"));
}

function rowToRecord(
  row: Row,
  authoritySet?:
    | BackgroundAuthorizationAuthoritySetV2
    | BackgroundAuthorizationAuthoritySetV3,
): BackgroundAuthorizationRecord {
  const formatVersion = requiredCounter(row, "format_version");
  const subjectKind = requiredString(row, "credential_subject_kind");
  const acceptedKind = nullableString(row, "accepted_response_kind");
  const descriptorHash = nullableBytes(row, "descriptor_hash");
  const recipientPublicKey = nullableBytes(row, "recipient_public_key");
  const responseHash = nullableBytes(row, "accepted_response_hash");
  const credentialHash = nullableBytes(row, "credential_hash");
  const acceptedAt = nullableTimestamp(row, "accepted_at");
  const acceptedMaterial: BackgroundAuthorizationAcceptedMaterial | null =
    acceptedKind === null
      ? null
      : {
        responseBytes: requiredBytes(row, "accepted_response_bytes"),
        credentialId: requiredString(row, "credential_id"),
        issuingDeviceAuthorizationRevision: requiredCounter(
          row,
          "issuing_device_authorization_revision",
        ),
        issuerSigningPublicKeyHash: requiredBytes(
          row,
          "issuer_signing_public_key_hash",
        ),
        authorizationExpiresAt: requiredTimestamp(
          row,
          "authorization_expires_at",
        ),
      };
  const snapshot = parseBackgroundAuthorizationRequestSnapshot({
    formatVersion,
    requestId: requiredString(row, "request_id"),
    workId: requiredString(row, "work_id"),
    namespaceId: requiredString(row, "namespace_id"),
    descriptorDigest: descriptorHash === null ? null : hex(descriptorHash),
    credentialSubject: subjectKind === "processor"
      ? formatVersion !== 1
        ? {
          kind: "processor",
          processorKind: requiredString(row, "processor_kind"),
          processorVersion: requiredCounter(row, "processor_version"),
        }
        : {
        kind: "processor",
        processorKind: requiredString(row, "processor_kind"),
        processorVersion: requiredCounter(row, "processor_version"),
        authorizationRevision: requiredCounter(
          row,
          "processor_authorization_revision",
        ),
        }
      : subjectKind === "runtime"
        ? {
          kind: "runtime",
          runtimeKind: requiredString(row, "runtime_kind"),
          runtimeVersion: requiredCounter(row, "runtime_version"),
        }
      : {
        kind: "agent",
        agentId: requiredString(row, "agent_id"),
        runtimeGeneration: requiredCounter(row, "agent_runtime_generation"),
        authorizationRevision: requiredCounter(
          row,
          "agent_authorization_revision",
        ),
      },
    recipientGeneration: requiredCounter(row, "recipient_generation"),
    recipient: recipientPublicKey === null
      ? null
      : {
        recipientKeyId: requiredString(row, "recipient_key_id"),
        recipientPublicKey: Buffer.from(recipientPublicKey).toString(
          "base64url",
        ),
        expiresAt: requiredTimestamp(row, "recipient_expires_at"),
      },
    acceptedResponse: acceptedKind === null
      ? null
      : {
        kind: acceptedKind,
        responseDigest: hex(responseHash!),
        credentialDigest: hex(credentialHash!),
        issuingHumanId: requiredString(row, "issuing_human_id"),
        issuingDeviceId: requiredString(row, "issuing_device_id"),
        recipientGeneration: requiredCounter(row, "recipient_generation"),
        acceptedAt: acceptedAt!,
      },
    state: requiredString(row, "state"),
    claimId: nullableString(row, "claim_id"),
    claimExpiresAt: nullableTimestamp(row, "claim_expires_at"),
    requestRevision: requiredCounter(row, "request_revision"),
    createdAt: requiredTimestamp(row, "created_at"),
    updatedAt: requiredTimestamp(row, "updated_at"),
    retryCount: requiredCounter(row, "retry_count"),
    lastRetryReason: nullableString(row, "last_retry_reason"),
    nextAttemptAt: nullableTimestamp(row, "next_attempt_at"),
    terminalReason: nullableString(row, "terminal_reason"),
  });
  if (
    requiredCounter(row, "maximum_attempts")
    !== BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT
  ) {
    throw new TypeError("Background authorization maximum attempts drifted");
  }
  const record = {
    snapshot,
    workIdentityHash: requiredBytes(row, "work_identity_hash"),
    idempotencyKey: requiredString(row, "idempotency_key"),
    workKind: requiredString(row, "work_kind") as never,
    purpose: requiredString(row, "purpose") as never,
    domainId: requiredString(row, "domain_id"),
    processorAuthorizationRevision: nullableCounter(
      row,
      "processor_authorization_revision",
    ),
    expectedDomainEpoch: nullableCounter(row, "expected_domain_epoch"),
    expectedNamespaceAccessRevision: requiredCounter(
      row,
      "expected_namespace_access_revision",
    ),
    expectedPolicyRevision: requiredCounter(row, "expected_policy_revision"),
    descriptorBytes: nullableBytes(row, "descriptor_bytes"),
    acceptedMaterial,
    finishedAt: nullableTimestamp(row, "finished_at"),
  };
  if (
    (snapshot.formatVersion === 2
      && snapshot.credentialSubject.kind === "agent")
    || (snapshot.formatVersion === 3
      && snapshot.credentialSubject.kind === "runtime")
  ) {
    if (authoritySet === undefined) {
      throw new TypeError("Background v2 authority rows are missing");
    }
    return parseBackgroundAuthorizationRecord({ ...record, authoritySet });
  }
  return parseBackgroundAuthorizationRecord(record);
}

function operationMask(
  operations: readonly ("decrypt" | "encrypt")[],
): number {
  return operations.reduce(
    (mask, operation) => mask | (operation === "decrypt" ? 1 : 2),
    0,
  );
}

function operationsFromMask(row: Row): readonly ("decrypt" | "encrypt")[] {
  const mask = requiredCounter(row, "operation_mask");
  if (mask < 1 || mask > 3) {
    throw new TypeError("Background Namespace operation mask is invalid");
  }
  return Object.freeze([
    ...(mask & 1 ? ["decrypt" as const] : []),
    ...(mask & 2 ? ["encrypt" as const] : []),
  ]);
}

function rowsToAuthoritySet(
  requestId: string,
  domainRows: readonly Row[],
  namespaceRows: readonly Row[],
  subjectKind: "agent" | "runtime",
): BackgroundAuthorizationAuthoritySetV2 | BackgroundAuthorizationAuthoritySetV3 {
  const domains = [...domainRows].sort(
    (left, right) => requiredCounter(left, "ordinal")
      - requiredCounter(right, "ordinal"),
  );
  const namespaces = [...namespaceRows].sort(
    (left, right) => requiredCounter(left, "ordinal")
      - requiredCounter(right, "ordinal"),
  );
  const domainRequirements = domains.map((row) => {
      if (requiredString(row, "request_id") !== requestId) {
        throw new TypeError("Background Domain requirement request mismatch");
      }
      const common = {
        ordinal: requiredCounter(row, "ordinal"),
        domainId: requiredString(row, "domain_id"),
        expectedEpoch: requiredCounter(row, "expected_epoch"),
      };
      return subjectKind === "runtime"
        ? {
          ...common,
          expectedAuthorizationRevision: requiredCounter(
            row,
            "expected_authorization_revision",
          ),
        }
        : {
          ...common,
          expectedAgentAuthorizationRevision: requiredCounter(
            row,
            "expected_agent_authorization_revision",
          ),
        };
    });
  const namespaceRequirements = namespaces.map((row) => {
      if (requiredString(row, "request_id") !== requestId) {
        throw new TypeError(
          "Background Namespace requirement request mismatch",
        );
      }
      return {
        ordinal: requiredCounter(row, "ordinal"),
        namespaceId: requiredString(row, "namespace_id"),
        domainId: requiredString(row, "domain_id"),
        operations: operationsFromMask(row),
        expectedAccessRevision: requiredCounter(
          row,
          "expected_access_revision",
        ),
        expectedPolicyRevision: requiredCounter(
          row,
          "expected_policy_revision",
        ),
      };
    });
  return subjectKind === "runtime"
    ? { domainRequirements: domainRequirements as BackgroundAuthorizationAuthoritySetV3["domainRequirements"], namespaceRequirements }
    : { domainRequirements: domainRequirements as BackgroundAuthorizationAuthoritySetV2["domainRequirements"], namespaceRequirements };
}

function requestValues(
  record: BackgroundAuthorizationRecord,
): typeof backgroundCryptoAuthorizationRequests.$inferInsert {
  const { snapshot } = record;
  const response = snapshot.acceptedResponse;
  const accepted = record.acceptedMaterial;
  const date = (milliseconds: number | null | undefined): Date | null =>
    milliseconds == null ? null : new Date(milliseconds);
  return {
    requestId: snapshot.requestId,
    formatVersion: snapshot.formatVersion,
    workIdentityHash: record.workIdentityHash,
    idempotencyKey: record.idempotencyKey,
    workId: snapshot.workId,
    workKind: record.workKind,
    purpose: record.purpose,
    namespaceId: snapshot.namespaceId,
    domainId: record.domainId,
    credentialSubjectKind: snapshot.credentialSubject.kind,
    processorKind: snapshot.credentialSubject.kind === "processor"
      ? snapshot.credentialSubject.processorKind : null,
    processorVersion: snapshot.credentialSubject.kind === "processor"
      ? snapshot.credentialSubject.processorVersion : null,
    processorAuthorizationRevision: record.processorAuthorizationRevision,
    agentId: snapshot.credentialSubject.kind === "agent"
      ? snapshot.credentialSubject.agentId : null,
    agentRuntimeGeneration: snapshot.credentialSubject.kind === "agent"
      ? snapshot.credentialSubject.runtimeGeneration : null,
    agentAuthorizationRevision: snapshot.credentialSubject.kind === "agent"
      ? snapshot.credentialSubject.authorizationRevision : null,
    runtimeKind: snapshot.credentialSubject.kind === "runtime"
      ? snapshot.credentialSubject.runtimeKind : null,
    runtimeVersion: snapshot.credentialSubject.kind === "runtime"
      ? snapshot.credentialSubject.runtimeVersion : null,
    expectedDomainEpoch: record.expectedDomainEpoch,
    expectedNamespaceAccessRevision: record.expectedNamespaceAccessRevision,
    expectedPolicyRevision: record.expectedPolicyRevision,
    recipientGeneration: snapshot.recipientGeneration,
    descriptorHash: bytes(snapshot.descriptorDigest),
    descriptorBytes: record.descriptorBytes,
    recipientKeyId: snapshot.recipient?.recipientKeyId ?? null,
    recipientPublicKey: snapshot.recipient === null ? null : Uint8Array.from(
      Buffer.from(snapshot.recipient.recipientPublicKey, "base64url"),
    ),
    recipientExpiresAt: date(snapshot.recipient?.expiresAt),
    acceptedResponseKind: response?.kind ?? null,
    acceptedResponseHash: bytes(response?.responseDigest ?? null),
    acceptedResponseBytes: accepted?.responseBytes ?? null,
    credentialId: accepted?.credentialId ?? null,
    credentialHash: bytes(response?.credentialDigest ?? null),
    issuingHumanId: response?.issuingHumanId ?? null,
    issuingDeviceId: response?.issuingDeviceId ?? null,
    issuingDeviceAuthorizationRevision:
      accepted?.issuingDeviceAuthorizationRevision ?? null,
    issuerSigningPublicKeyHash: accepted?.issuerSigningPublicKeyHash ?? null,
    acceptedAt: date(response?.acceptedAt),
    authorizationExpiresAt: date(accepted?.authorizationExpiresAt),
    requestRevision: snapshot.requestRevision,
    state: snapshot.state,
    claimId: snapshot.claimId,
    claimExpiresAt: date(snapshot.claimExpiresAt),
    retryCount: snapshot.retryCount,
    maximumAttempts: BACKGROUND_AUTHORIZATION_MAX_RETRY_COUNT,
    lastRetryReason: snapshot.lastRetryReason,
    nextAttemptAt: date(snapshot.nextAttemptAt),
    terminalReason: snapshot.terminalReason,
    finishedAt: date(record.finishedAt),
    createdAt: date(snapshot.createdAt)!,
    updatedAt: date(snapshot.updatedAt)!,
  };
}

function rowToEvidence(row: Row): ProcessorSignerAuthorizationEvidence {
  const formatVersion = requiredCounter(row, "format_version");
  const common = {
    authorizationId: requiredString(row, "authorization_id"),
    requestId: requiredString(row, "request_id"),
    recipientGeneration: requiredCounter(row, "recipient_generation"),
    workId: requiredString(row, "work_id"),
    namespaceId: requiredString(row, "namespace_id"),
    domainId: requiredString(row, "domain_id"),
    domainEpoch: nullableCounter(row, "domain_epoch"),
    namespaceAccessRevision: requiredCounter(
      row,
      "namespace_access_revision",
    ),
    policyRevision: requiredCounter(row, "policy_revision"),
    processorAuthorizationRevision: nullableCounter(
      row,
      "processor_authorization_revision",
    ),
    issuingHumanId: requiredString(row, "issuing_human_id"),
    issuingDeviceId: requiredString(row, "issuing_device_id"),
    issuingDeviceAuthorizationRevision: requiredCounter(
      row,
      "issuing_device_authorization_revision",
    ),
    issuerSigningPublicKeyHash: requiredBytes(
      row,
      "issuer_signing_public_key_hash",
    ),
    signerKeyId: requiredString(row, "signer_key_id"),
    signerPublicKey: requiredBytes(row, "signer_public_key"),
    workDescriptorHash: requiredBytes(row, "work_descriptor_hash"),
    workDescriptorBytes: requiredBytes(row, "work_descriptor_bytes"),
    authorizationHash: requiredBytes(row, "authorization_hash"),
    credentialHash: requiredBytes(row, "credential_hash"),
    authorizationBytes: requiredBytes(row, "authorization_bytes"),
    issuedAt: requiredTimestamp(row, "issued_at"),
    expiresAt: requiredTimestamp(row, "expires_at"),
    createdAt: requiredTimestamp(row, "created_at"),
  };
  if (formatVersion === 2) {
    return parseProcessorSignerAuthorizationEvidence({
      ...common,
      formatVersion: 2,
      domainEpoch: null,
      processorAuthorizationRevision: null,
    });
  }
  if (
    formatVersion !== 1
    || common.domainEpoch === null
    || common.processorAuthorizationRevision === null
  ) {
    throw new TypeError("Processor signer evidence format is invalid");
  }
  return parseProcessorSignerAuthorizationEvidence({
    ...common,
    domainEpoch: common.domainEpoch,
    processorAuthorizationRevision: common.processorAuthorizationRevision,
  });
}

export class PostgresBackgroundAuthorizationRepository
  implements BackgroundAuthorizationRepository {
  constructor(private readonly handle: CryptoPostgresHandle) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  async create(
    input: BackgroundAuthorizationRecord,
  ): Promise<BackgroundAuthorizationCreateResult> {
    const record = parseBackgroundAuthorizationRecord(input);
    if (
      (record.snapshot.formatVersion === 2
        && record.snapshot.credentialSubject.kind === "agent")
      || (record.snapshot.formatVersion === 3
        && record.snapshot.credentialSubject.kind === "runtime")
    ) {
      return withVerifiedCryptoPostgresTransaction(
        this.handle,
        async (transactionHandle) =>
          new PostgresBackgroundAuthorizationRepository(transactionHandle)
            .#createParsed(record),
      );
    }
    return this.#createParsed(record);
  }

  async #createParsed(
    record: BackgroundAuthorizationRecord,
  ): Promise<BackgroundAuthorizationCreateResult> {
    if (
      record.snapshot.requestRevision !== 0
      || record.snapshot.state !== "awaiting_recipient"
    ) {
      throw new TypeError("Background authorization creation must be initial");
    }
    const inserted = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.insert(backgroundCryptoAuthorizationRequests)
        .values(requestValues(record)).onConflictDoNothing().returning(),
    );
    if (inserted.length === 1) {
      if (
        (record.snapshot.formatVersion === 2
          && record.snapshot.credentialSubject.kind === "agent")
        || (record.snapshot.formatVersion === 3
          && record.snapshot.credentialSubject.kind === "runtime")
      ) {
        await this.#insertAuthoritySet(record);
      }
      return {
        status: "created",
        record: rowToRecord(inserted[0] as Row, record.authoritySet),
      };
    }
    const collisions = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select().from(backgroundCryptoAuthorizationRequests)
        .where(or(
          eq(
            backgroundCryptoAuthorizationRequests.requestId,
            record.snapshot.requestId,
          ),
          eq(
            backgroundCryptoAuthorizationRequests.workIdentityHash,
            record.workIdentityHash,
          ),
          eq(
            backgroundCryptoAuthorizationRequests.idempotencyKey,
            record.idempotencyKey,
          ),
        )).limit(3),
    );
    if (collisions.length === 1) {
      const existing = await this.#recordFromRow(collisions[0] as Row);
      if (sameBackgroundAuthorizationRecord(existing, record)) {
        return { status: "existing", record: existing };
      }
    }
    throw new BackgroundAuthorizationRepositoryConflictError("create_conflict");
  }

  async #insertAuthoritySet(record: BackgroundAuthorizationRecord): Promise<void> {
    if (
      !(
        (record.snapshot.formatVersion === 2
          && record.snapshot.credentialSubject.kind === "agent")
        || (record.snapshot.formatVersion === 3
          && record.snapshot.credentialSubject.kind === "runtime")
      )
      || record.authoritySet === undefined) {
      throw new TypeError("Background protected authority set is missing");
    }
    const domains = record.authoritySet.domainRequirements;
    await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.insert(backgroundCryptoAuthorizationDomainRequirements)
        .values(domains.map((requirement) => ({
          requestId: record.snapshot.requestId,
          domainId: requirement.domainId,
          ordinal: requirement.ordinal,
          expectedEpoch: requirement.expectedEpoch,
          expectedAgentAuthorizationRevision:
            "expectedAgentAuthorizationRevision" in requirement
              ? requirement.expectedAgentAuthorizationRevision
              : null,
          expectedAuthorizationRevision:
            "expectedAuthorizationRevision" in requirement
              ? requirement.expectedAuthorizationRevision
              : null,
        }))),
    );

    const namespaces = record.authoritySet.namespaceRequirements;
    await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.insert(backgroundCryptoAuthorizationNamespaceRequirements)
        .values(namespaces.map((requirement) => ({
          requestId: record.snapshot.requestId,
          namespaceId: requirement.namespaceId,
          ordinal: requirement.ordinal,
          domainId: requirement.domainId,
          operationMask: operationMask(requirement.operations),
          expectedAccessRevision: requirement.expectedAccessRevision,
          expectedPolicyRevision: requirement.expectedPolicyRevision,
        }))),
    );
  }

  async #recordsFromRows(
    rows: readonly Row[],
  ): Promise<readonly BackgroundAuthorizationRecord[]> {
    const protectedRequestIds = rows
      .filter((row) => (
        requiredCounter(row, "format_version") === 2
          && requiredString(row, "credential_subject_kind") === "agent"
      ) || (
        requiredCounter(row, "format_version") === 3
          && requiredString(row, "credential_subject_kind") === "runtime"
      ))
      .map((row) => requiredString(row, "request_id"));
    if (protectedRequestIds.length === 0) {
      return rows.map((row) => rowToRecord(row));
    }
    const domains = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        request_id: backgroundCryptoAuthorizationDomainRequirements.requestId,
        domain_id: backgroundCryptoAuthorizationDomainRequirements.domainId,
        ordinal: backgroundCryptoAuthorizationDomainRequirements.ordinal,
        expected_epoch:
          backgroundCryptoAuthorizationDomainRequirements.expectedEpoch,
        expected_agent_authorization_revision:
          backgroundCryptoAuthorizationDomainRequirements
            .expectedAgentAuthorizationRevision,
        expected_authorization_revision:
          backgroundCryptoAuthorizationDomainRequirements
            .expectedAuthorizationRevision,
      })
        .from(backgroundCryptoAuthorizationDomainRequirements)
        .where(inArray(
          backgroundCryptoAuthorizationDomainRequirements.requestId,
          protectedRequestIds,
        ))
        .orderBy(
          backgroundCryptoAuthorizationDomainRequirements.requestId,
          backgroundCryptoAuthorizationDomainRequirements.ordinal,
        ),
    );
    const namespaces = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        request_id:
          backgroundCryptoAuthorizationNamespaceRequirements.requestId,
        namespace_id:
          backgroundCryptoAuthorizationNamespaceRequirements.namespaceId,
        ordinal: backgroundCryptoAuthorizationNamespaceRequirements.ordinal,
        domain_id:
          backgroundCryptoAuthorizationNamespaceRequirements.domainId,
        operation_mask:
          backgroundCryptoAuthorizationNamespaceRequirements.operationMask,
        expected_access_revision:
          backgroundCryptoAuthorizationNamespaceRequirements
            .expectedAccessRevision,
        expected_policy_revision:
          backgroundCryptoAuthorizationNamespaceRequirements
            .expectedPolicyRevision,
      })
        .from(backgroundCryptoAuthorizationNamespaceRequirements)
        .where(inArray(
          backgroundCryptoAuthorizationNamespaceRequirements.requestId,
          protectedRequestIds,
        ))
        .orderBy(
          backgroundCryptoAuthorizationNamespaceRequirements.requestId,
          backgroundCryptoAuthorizationNamespaceRequirements.ordinal,
        ),
    );
    return rows.map((row) => {
      const formatVersion = requiredCounter(row, "format_version");
      const subjectKind = requiredString(row, "credential_subject_kind");
      if (!(
        (formatVersion === 2 && subjectKind === "agent")
        || (formatVersion === 3 && subjectKind === "runtime")
      )) {
        return rowToRecord(row);
      }
      const requestId = requiredString(row, "request_id");
      return rowToRecord(row, rowsToAuthoritySet(
        requestId,
        (domains as readonly Row[]).filter(
          (entry) => requiredString(entry, "request_id") === requestId,
        ),
        (namespaces as readonly Row[]).filter(
          (entry) => requiredString(entry, "request_id") === requestId,
        ),
        subjectKind,
      ));
    });
  }

  async #recordFromRow(row: Row): Promise<BackgroundAuthorizationRecord> {
    return (await this.#recordsFromRows([row]))[0]!;
  }

  async get(requestId: string): Promise<BackgroundAuthorizationRecord | null> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select().from(backgroundCryptoAuthorizationRequests)
        .where(eq(backgroundCryptoAuthorizationRequests.requestId, requestId))
        .limit(2),
    );
    if (rows.length > 1) throw new Error("Duplicate background request id");
    return rows.length === 0 ? null : this.#recordFromRow(rows[0] as Row);
  }

  async getByIdempotencyKey(idempotencyKey: string): Promise<BackgroundAuthorizationRecord | null> {
    if (typeof idempotencyKey !== "string" || idempotencyKey.length < 1
      || new TextEncoder().encode(idempotencyKey).length > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
      || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(idempotencyKey)) {
      throw new TypeError("Invalid background idempotency key");
    }
    const rows = await executeTypedCryptoQuery(this.handle, cryptoTypedDb.select()
      .from(backgroundCryptoAuthorizationRequests)
      .where(eq(backgroundCryptoAuthorizationRequests.idempotencyKey, idempotencyKey)).limit(2));
    if (rows.length > 1) throw new BackgroundAuthorizationRepositoryConflictError("create_conflict");
    return rows[0] === undefined ? null : this.#recordFromRow(rows[0] as Row);
  }

  /** Called only while the exact product claim and fallback policy are locked.
   * The request row lock orders this handoff against device acceptance. */
  cancelUnconsumedProcessorRequest(input: Readonly<{
    expected: BackgroundAuthorizationRecord;
    now: number;
    reason?: "superseded";
  }>): Promise<boolean> {
    const expected = parseBackgroundAuthorizationRecord(input.expected);
    const reason = input.reason ?? "cancelled";
    const allowedStates = input.reason === "superseded"
      ? ["awaiting_recipient", "awaiting_device", "grant_ready", "claimed",
        ...(expected.workKind === "stenographer.output_repair" ? ["publication_reconciliation"] : [])]
      : ["awaiting_recipient", "awaiting_device"];
    return withVerifiedCryptoPostgresTransaction(this.handle, async (handle) => {
      const table = backgroundCryptoAuthorizationRequests;
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(table)
        .where(eq(table.requestId, expected.snapshot.requestId)).limit(2).for("update"));
      const row = rows[0];
      if (rows.length !== 1 || row === undefined) return false;
      const repository = new PostgresBackgroundAuthorizationRepository(handle);
      const current = await repository.get(expected.snapshot.requestId);
      if (current === null) return false;
      // A restricted commit can survive a failed outer product commit. Accept
      // only the exact canonical cancellation successor, never a changed attempt.
      let matches = sameBackgroundAuthorizationRecord(current, expected);
      if (!matches && current.snapshot.state === "cancelled"
        && current.snapshot.terminalReason === reason
        && allowedStates.includes(expected.snapshot.state)) {
        const successor: BackgroundAuthorizationRecord = {...expected,
          snapshot: cancelBackgroundAuthorizationRequest(expected.snapshot, reason, current.snapshot.updatedAt),
          finishedAt: current.snapshot.updatedAt};
        matches = sameBackgroundAuthorizationRecord(current, successor);
      }
      if (!matches
        || current.snapshot.formatVersion !== 2 || current.snapshot.credentialSubject.kind !== "processor"
        || ![...allowedStates, "cancelled"].includes(current.snapshot.state)
        || (current.snapshot.state === "cancelled" && current.snapshot.terminalReason !== reason)
        || (reason === "cancelled" && (current.acceptedMaterial !== null || current.snapshot.claimId !== null))
        || row.transform_commit_claim_id !== null || row.transform_commit_descriptor_hash !== null
        || row.transform_commit_recipient_generation !== null || row.transform_commit_output_count !== null
        || row.transform_committed_at !== null) return false;
      const history = await executeTypedCryptoQuery(handle, cryptoTypedDb.select({id: processorCryptoSignerAuthorizations.authorizationId})
        .from(processorCryptoSignerAuthorizations).where(eq(processorCryptoSignerAuthorizations.requestId, current.snapshot.requestId)).limit(1));
      // A retained accepted certificate is not a consumed transform. Obsolete
      // request retirement uses the same row/commit fence as supersession;
      // ordinary fallback retains its stricter no-grant handoff contract.
      if (history.length !== 0 && reason === "cancelled") return false;
      if (current.snapshot.state === "cancelled") return true;
      const next: BackgroundAuthorizationRecord = {...current,
        snapshot: cancelBackgroundAuthorizationRequest(current.snapshot, reason, input.now) as typeof current.snapshot,
        finishedAt: input.now};
      return (await repository.compareAndSwap({expectedRequestRevision: current.snapshot.requestRevision, next})).status === "updated";
    });
  }

  async supersedeUnstartedProcessorRequest(input: Readonly<{
    expected: BackgroundAuthorizationRecord; successor: BackgroundAuthorizationRecord; now: number;
  }>): Promise<BackgroundAuthorizationSupersedeResult> {
    const expected = parseBackgroundAuthorizationRecord(input.expected);
    const successor = parseBackgroundAuthorizationRecord(input.successor);
    assertUnstartedProcessorSupersession({...input, expected, successor});
    return withVerifiedCryptoPostgresTransaction(this.handle, async handle => {
      const table = backgroundCryptoAuthorizationRequests;
      const rows = await executeTypedCryptoQuery(handle, cryptoTypedDb.select().from(table)
        .where(eq(table.requestId, expected.snapshot.requestId)).limit(2).for("update"));
      const row = rows[0];
      const repository = new PostgresBackgroundAuthorizationRepository(handle);
      const current = row === undefined ? null : await repository.#recordFromRow(row as Row);
      if (rows.length !== 1 || current === null) return {status: "stale", current};
      if (row!.transform_commit_claim_id !== null || row!.transform_commit_descriptor_hash !== null
        || row!.transform_commit_recipient_generation !== null || row!.transform_commit_output_count !== null
        || row!.transform_committed_at !== null) return {status: "stale", current};
      if (isExactProcessorSupersessionCancellation(current, expected)) {
        const existing = await repository.getByIdempotencyKey(successor.idempotencyKey);
        return existing !== null && sameProcessorSupersessionPlan(existing, successor)
          ? {status: "existing", record: existing} : {status: "stale", current};
      }
      if (!sameBackgroundAuthorizationRecord(current, expected)
        || !["awaiting_recipient", "awaiting_device", "grant_ready", "claimed"].includes(current.snapshot.state)) {
        return {status: "stale", current};
      }
      const next: BackgroundAuthorizationRecord = {...current,
        snapshot: cancelBackgroundAuthorizationRequest(current.snapshot, "superseded", input.now), finishedAt: input.now};
      const cancelled = await repository.compareAndSwap({expectedRequestRevision: current.snapshot.requestRevision, next});
      if (cancelled.status !== "updated") return {status: "stale", current: cancelled.current};
      // A collision throws and rolls back the cancellation in this same restricted transaction.
      const created = await repository.#createParsed(successor);
      return {status: created.status === "created" ? "superseded" : "existing", record: created.record};
    });
  }

  async compareAndSwap(input: Readonly<{
    readonly expectedRequestRevision: number;
    readonly next: BackgroundAuthorizationRecord;
  }>): Promise<BackgroundAuthorizationCasResult> {
    return this.compareAndSwapInternal(input, false);
  }

  private async compareAndSwapInternal(
    input: Readonly<{
      readonly expectedRequestRevision: number;
      readonly next: BackgroundAuthorizationRecord;
    }>,
    allowResponseAcceptance: boolean,
  ): Promise<BackgroundAuthorizationCasResult> {
    const next = parseBackgroundAuthorizationRecord(input.next);
    const current = await this.get(next.snapshot.requestId);
    if (
      current === null
      || current.snapshot.requestRevision !== input.expectedRequestRevision
    ) {
      return { status: "stale", current };
    }
    assertBackgroundAuthorizationCasSuccessor(
      current,
      input.expectedRequestRevision,
      next,
      { allowResponseAcceptance },
    );
    const values = requestValues(next);
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.update(backgroundCryptoAuthorizationRequests).set({
        recipientGeneration: values.recipientGeneration,
        descriptorHash: values.descriptorHash,
        descriptorBytes: values.descriptorBytes,
        recipientKeyId: values.recipientKeyId,
        recipientPublicKey: values.recipientPublicKey,
        recipientExpiresAt: values.recipientExpiresAt,
        acceptedResponseKind: values.acceptedResponseKind,
        acceptedResponseHash: values.acceptedResponseHash,
        acceptedResponseBytes: values.acceptedResponseBytes,
        credentialId: values.credentialId,
        credentialHash: values.credentialHash,
        issuingHumanId: values.issuingHumanId,
        issuingDeviceId: values.issuingDeviceId,
        issuingDeviceAuthorizationRevision:
          values.issuingDeviceAuthorizationRevision,
        issuerSigningPublicKeyHash: values.issuerSigningPublicKeyHash,
        acceptedAt: values.acceptedAt,
        authorizationExpiresAt: values.authorizationExpiresAt,
        requestRevision: values.requestRevision,
        state: values.state,
        claimId: values.claimId,
        claimExpiresAt: values.claimExpiresAt,
        retryCount: values.retryCount,
        maximumAttempts: values.maximumAttempts,
        lastRetryReason: values.lastRetryReason,
        nextAttemptAt: values.nextAttemptAt,
        terminalReason: values.terminalReason,
        finishedAt: values.finishedAt,
        updatedAt: values.updatedAt,
      }).where(and(
        eq(
          backgroundCryptoAuthorizationRequests.requestId,
          next.snapshot.requestId,
        ),
        eq(
          backgroundCryptoAuthorizationRequests.requestRevision,
          input.expectedRequestRevision,
        ),
      )).returning(),
    );
    if (rows.length === 1) {
      return {
        status: "updated",
        record: rowToRecord(rows[0] as Row, next.authoritySet),
      };
    }
    return { status: "stale", current: await this.get(next.snapshot.requestId) };
  }

  acceptVerifiedResponse(input: Readonly<{
    readonly response: BackgroundAuthorizationVerifiedDeviceResponse;
    readonly acceptedAt: number;
  }>): Promise<BackgroundAuthorizationAcceptResponseResult> {
    return withVerifiedCryptoPostgresTransaction(
      this.handle,
      async (transactionHandle) => {
        const repository = new PostgresBackgroundAuthorizationRepository(
          transactionHandle,
        );
        const current = await repository.get(
          backgroundAuthorizationVerifiedResponseRequestId(input.response),
        );
        if (current === null) return { status: "lost", current: null };
        if (current.snapshot.state !== "awaiting_device") {
          return {
            status: isBackgroundAuthorizationResponseReplay(
              current,
              input.response,
            )
              ? "duplicate"
              : "lost",
            current,
          };
        }
        const accepted = buildAcceptedBackgroundAuthorizationResponse(
          current,
          input.response,
          input.acceptedAt,
        );
        const cas = await repository.compareAndSwapInternal(
          {
            expectedRequestRevision: current.snapshot.requestRevision,
            next: accepted.next,
          },
          true,
        );
        if (cas.status === "stale") {
          return {
            status: cas.current !== null
                && isBackgroundAuthorizationResponseReplay(
                  cas.current,
                  input.response,
                )
              ? "duplicate"
              : "lost",
            current: cas.current,
          };
        }
        if (accepted.signerEvidence !== null) {
          await repository.#appendProcessorSignerEvidence(
            accepted.signerEvidence,
          );
        }
        return { status: "accepted", record: cas.record };
      },
    );
  }

  async listEligible(input: Readonly<{
    readonly now: number;
    readonly limit: number;
  }>): Promise<readonly BackgroundAuthorizationRecord[]> {
    if (
      !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH
    ) {
      throw new TypeError("Eligible-list limit must be bounded");
    }
    const now = new Date(input.now);
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select().from(backgroundCryptoAuthorizationRequests)
        .where(and(
          inArray(backgroundCryptoAuthorizationRequests.formatVersion, [1, 2, 3]),
          or(
          and(
            eq(backgroundCryptoAuthorizationRequests.state, "awaiting_recipient"),
            or(
              isNull(backgroundCryptoAuthorizationRequests.nextAttemptAt),
              lte(backgroundCryptoAuthorizationRequests.nextAttemptAt, now),
            ),
          ),
          and(
            eq(backgroundCryptoAuthorizationRequests.state, "awaiting_device"),
            lte(backgroundCryptoAuthorizationRequests.recipientExpiresAt, now),
          ),
          eq(backgroundCryptoAuthorizationRequests.state, "grant_ready"),
          and(
            inArray(
              backgroundCryptoAuthorizationRequests.state,
              ["claimed", "running"],
            ),
            lte(backgroundCryptoAuthorizationRequests.claimExpiresAt, now),
          ),
          and(
            eq(
              backgroundCryptoAuthorizationRequests.state,
              "publication_reconciliation",
            ),
            or(
              isNull(backgroundCryptoAuthorizationRequests.nextAttemptAt),
              lte(backgroundCryptoAuthorizationRequests.nextAttemptAt, now),
            ),
          ),
          ),
        )).orderBy(
          asc(backgroundCryptoAuthorizationRequests.updatedAt),
          asc(backgroundCryptoAuthorizationRequests.requestId),
        ).limit(input.limit),
    );
    return this.#recordsFromRows(rows as readonly Row[]);
  }

  async listAwaitingDevicePage(input: Readonly<{
    readonly now: number;
    readonly throughUpdatedAt: number;
    readonly after?: BackgroundAuthorizationAwaitingDeviceCursor;
    readonly limit: number;
  }>): Promise<BackgroundAuthorizationAwaitingDevicePage> {
    if (
      !Number.isSafeInteger(input.now)
      || input.now < 0
      || input.now > BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS
      || !Number.isSafeInteger(input.throughUpdatedAt)
      || input.throughUpdatedAt < 0
      || input.throughUpdatedAt > BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS
      || !Number.isSafeInteger(input.limit)
      || input.limit < 1
      || input.limit > BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH
      || (input.after !== undefined && (
        !Number.isSafeInteger(input.after.updatedAt)
        || input.after.updatedAt < 0
        || input.after.updatedAt > BACKGROUND_AUTHORIZATION_MAX_TIMESTAMP_MS
        || input.after.updatedAt > input.throughUpdatedAt
        || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/u.test(input.after.requestId)
        || new TextEncoder().encode(input.after.requestId).length
          > BACKGROUND_AUTHORIZATION_MAX_IDENTIFIER_BYTES
      ))
    ) throw new TypeError("Awaiting-device page input must be bounded");
    const now = new Date(input.now);
    const through = new Date(input.throughUpdatedAt);
    const after = input.after;
    // Bound descriptor bytes in PostgreSQL before transferring rows. A count
    // bound alone could load 256 maximum Reflection carriers into one process.
    const table = backgroundCryptoAuthorizationRequests;
    const candidates = cryptoTypedDb.select({
      requestId: table.requestId, updatedAt: table.updatedAt,
      descriptorSize: sql<number>`octet_length(${table.descriptorBytes})`.as("descriptor_size"),
    }).from(table)
        .where(and(
          inArray(backgroundCryptoAuthorizationRequests.formatVersion, [1, 2, 3]),
          eq(backgroundCryptoAuthorizationRequests.state, "awaiting_device"),
          isNotNull(backgroundCryptoAuthorizationRequests.descriptorHash),
          isNotNull(backgroundCryptoAuthorizationRequests.descriptorBytes),
          isNotNull(backgroundCryptoAuthorizationRequests.recipientKeyId),
          isNotNull(backgroundCryptoAuthorizationRequests.recipientPublicKey),
          isNotNull(backgroundCryptoAuthorizationRequests.recipientExpiresAt),
          gt(backgroundCryptoAuthorizationRequests.recipientExpiresAt, now),
          lte(backgroundCryptoAuthorizationRequests.updatedAt, through),
          ...(after === undefined ? [] : [or(
            gt(
              backgroundCryptoAuthorizationRequests.updatedAt,
              new Date(after.updatedAt),
            ),
            and(
              eq(
                backgroundCryptoAuthorizationRequests.updatedAt,
                new Date(after.updatedAt),
              ),
              gt(
                backgroundCryptoAuthorizationRequests.requestId,
                after.requestId,
              ),
            ),
          )]),
        )).orderBy(
          asc(backgroundCryptoAuthorizationRequests.updatedAt),
          asc(backgroundCryptoAuthorizationRequests.requestId),
        ).limit(input.limit).as("background_device_candidates");
    const sized = cryptoTypedDb.select({
      requestId: candidates.requestId,
      cumulativeBytes: sql<number>`sum(${candidates.descriptorSize}) over (
        order by ${candidates.updatedAt}, ${candidates.requestId}
        rows unbounded preceding
      )`.as("cumulative_bytes"),
    }).from(candidates).as("background_device_sized");
    const selected = cryptoTypedDb.select({requestId: sized.requestId}).from(sized)
      .where(lte(sized.cumulativeBytes, MAX_ANY_BACKGROUND_PROCESSOR_WORK_DESCRIPTOR_WIRE_BYTES_V2));
    const rows = await executeTypedCryptoQuery(this.handle,
      cryptoTypedDb.select().from(table).where(inArray(table.requestId, selected))
        .orderBy(asc(table.updatedAt), asc(table.requestId)));
    const records = await this.#recordsFromRows(rows as readonly Row[]);
    const complete = records.filter((record) =>
      record.descriptorBytes !== null
      && record.snapshot.descriptorDigest !== null
      && record.snapshot.recipient !== null
    );
    const lastRow = rows.at(-1) as Row | undefined;
    return Object.freeze({
      records: Object.freeze(complete),
      // A final empty page is preferable to loading another large descriptor
      // merely to establish whether this byte-bounded page was the last.
      continuation: lastRow !== undefined
        ? Object.freeze({
          updatedAt: requiredTimestamp(lastRow, "updated_at"),
          requestId: requiredString(lastRow, "request_id"),
        })
        : null,
    });
  }

  async pruneTerminal(input: Readonly<{
    readonly now: number;
    readonly limit?: number;
  }>): Promise<number> {
    const limit = input.limit ?? BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH;
    if (
      !Number.isSafeInteger(limit)
      || limit < 1
      || limit > BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH
    ) {
      throw new TypeError("Terminal-prune limit must be bounded");
    }
    const cutoff = input.now - BACKGROUND_AUTHORIZATION_TERMINAL_RETENTION_MS;
    return withVerifiedCryptoPostgresTransaction(
      this.handle,
      async (transactionHandle) => {
        const requests = backgroundCryptoAuthorizationRequests;
        const heads = objectCryptoAccessHeads;
        const envelopes = objectCryptoNamespaceEnvelopes;
        // Reflection reprojection output IDs are deterministically derived by
        // the producer. Excluding live derived outputs here keeps retained
        // crash-recovery rows from permanently occupying the bounded page.
        // The canonical descriptor is still decoded below before deletion.
        const hasCurrentDerivedOutputEnvelope = cryptoTypedDb.select({
          objectId: heads.objectId,
        }).from(heads).innerJoin(envelopes, and(
          eq(envelopes.objectId, heads.objectId),
          eq(envelopes.accessRevision, heads.accessRevision),
        )).where(eq(
          heads.objectId,
          sql`${requests.workId} || ':record'`,
        ));
        const hasDerivedOutputHead = cryptoTypedDb.select({
          objectId: heads.objectId,
        }).from(heads).where(eq(
          heads.objectId,
          sql`${requests.workId} || ':record'`,
        ));
        const requestIds: string[] = [];
        let after: Readonly<{ finishedAt: number; requestId: string }> | undefined;
        while (requestIds.length < limit) {
        const candidates = await executeTypedCryptoQuery(
          transactionHandle,
          cryptoTypedDb.select({
            request_id: requests.requestId,
            format_version: requests.formatVersion,
            state: requests.state,
            work_id: requests.workId,
            work_kind: requests.workKind,
            processor_kind: requests.processorKind,
            transform_committed_at: requests.transformCommittedAt,
            finished_at: requests.finishedAt,
          }).from(requests).where(and(
            lte(requests.finishedAt, new Date(cutoff)),
            ...(after === undefined ? [] : [or(
              gt(requests.finishedAt, new Date(after.finishedAt)),
              and(
                eq(requests.finishedAt, new Date(after.finishedAt)),
                gt(requests.requestId, after.requestId),
              ),
            )]),
            or(
              eq(requests.state, "completed"),
              isNull(requests.transformCommittedAt),
              sql<boolean>`not (
                ${requests.formatVersion} = 2
                and ${requests.processorKind} = 'reflection'
                and ${requests.workKind} = 'reflection.authority_reproject'
              )`,
              and(
                isNotNull(requests.descriptorBytes),
                exists(hasDerivedOutputHead),
                notExists(hasCurrentDerivedOutputEnvelope),
              ),
            ),
          )).orderBy(
            asc(requests.finishedAt),
            asc(requests.requestId),
          ).limit(BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH)
            .for("update", { skipLocked: true }),
        );
        for (const candidate of candidates as readonly Row[]) {
          const requestId = requiredString(candidate, "request_id");
          after = {
            finishedAt: requiredTimestamp(candidate, "finished_at"),
            requestId,
          };
          const committed = candidate["transform_committed_at"] !== null;
          const reflectionReprojection = requiredCounter(
            candidate,
            "format_version",
          ) === 2
            && nullableString(candidate, "processor_kind") === "reflection"
            && requiredString(candidate, "work_kind")
              === "reflection.authority_reproject";
          if (
            requiredString(candidate, "state") === "completed"
            || !committed
            || !reflectionReprojection
          ) {
            requestIds.push(requestId);
            if (requestIds.length === limit) break;
            continue;
          }

          // A committed terminal Reflection A is recovery authority until B
          // completes. Only canonical ciphertext metadata proving its exact
          // output has no current Namespace envelope permits earlier pruning.
          // Transfer one bounded descriptor only when retirement proof needs it;
          // terminal page discovery never materializes a batch of large carriers.
          const descriptorRows = await executeTypedCryptoQuery(transactionHandle,
            cryptoTypedDb.select({descriptor_bytes: requests.descriptorBytes}).from(requests)
              .where(eq(requests.requestId, requestId)).limit(1));
          const descriptorBytes = descriptorRows[0]?.descriptor_bytes;
          if (!(descriptorBytes instanceof Uint8Array)) continue;
          try {
            const descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(
              descriptorBytes,
            );
            if (
              descriptor.subject.processorKind !== "reflection"
              || descriptor.workKind !== "reflection.authority_reproject"
              || descriptor.requestId !== requestId
              || descriptor.workId !== requiredString(candidate, "work_id")
              || descriptor.outputSlots.length !== 1
            ) continue;
            const outputId = descriptor.outputSlots[0]!.objectId;
            const current = await executeTypedCryptoQuery(
              transactionHandle,
              cryptoTypedDb.select({
                object_id: heads.objectId,
                namespace_id: envelopes.namespaceId,
              }).from(heads).leftJoin(envelopes, and(
                  eq(envelopes.objectId, heads.objectId),
                  eq(envelopes.accessRevision, heads.accessRevision),
                )).where(eq(heads.objectId, outputId)).limit(1),
            );
            if (
              current.length === 1
              && requiredString(current[0] as Row, "object_id") === outputId
              && (current[0] as Row)["namespace_id"] === null
            ) requestIds.push(requestId);
          } catch {
            // Missing, malformed, or noncanonical proof retains authority.
          } finally {descriptorBytes.fill(0);}
          if (requestIds.length === limit) break;
        }
        if (
          requestIds.length === limit
          || candidates.length < BACKGROUND_AUTHORIZATION_REPOSITORY_MAX_BATCH
        ) break;
        }
        if (requestIds.length === 0) return 0;

        await transactionHandle.query(
          `DELETE FROM background_crypto_authorization_namespace_requirements
            WHERE request_id = ANY($1::text[])`,
          [requestIds] as never,
        );
        await transactionHandle.query(
          `DELETE FROM background_crypto_authorization_domain_requirements
            WHERE request_id = ANY($1::text[])`,
          [requestIds] as never,
        );
        const deletedParents = await transactionHandle.query(
          `DELETE FROM background_crypto_authorization_requests
            WHERE request_id = ANY($1::text[])
          RETURNING request_id`,
          [requestIds] as never,
        );
        const deletedIds = new Set(
          deletedParents.map((row) => requiredString(row, "request_id")),
        );
        if (
          deletedIds.size !== requestIds.length
          || requestIds.some((requestId) => !deletedIds.has(requestId))
        ) {
          throw new BackgroundAuthorizationRepositoryConflictError(
            "prune_conflict",
          );
        }
        return deletedIds.size;
      },
    );
  }

  async #appendProcessorSignerEvidence(
    input: ProcessorSignerAuthorizationEvidence,
  ): Promise<ProcessorSignerEvidenceAppendResult> {
    const evidence = parseProcessorSignerAuthorizationEvidence(input);
    const inserted = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.insert(processorCryptoSignerAuthorizations).values({
        authorizationId: evidence.authorizationId,
        formatVersion: evidence.formatVersion ?? 1,
        requestId: evidence.requestId,
        recipientGeneration: evidence.recipientGeneration,
        processorKind: evidence.formatVersion === 2
          ? decodeAnyBackgroundProcessorWorkDescriptorV2(evidence.workDescriptorBytes).subject.processorKind
          : "stenographer",
        processorVersion: 1,
        workId: evidence.workId,
        namespaceId: evidence.namespaceId,
        domainId: evidence.domainId,
        domainEpoch: evidence.domainEpoch,
        namespaceAccessRevision: evidence.namespaceAccessRevision,
        policyRevision: evidence.policyRevision,
        processorAuthorizationRevision: evidence.processorAuthorizationRevision,
        issuingHumanId: evidence.issuingHumanId,
        issuingDeviceId: evidence.issuingDeviceId,
        issuingDeviceAuthorizationRevision:
          evidence.issuingDeviceAuthorizationRevision,
        issuerSigningPublicKeyHash: evidence.issuerSigningPublicKeyHash,
        signerKeyId: evidence.signerKeyId,
        signerPublicKey: evidence.signerPublicKey,
        workDescriptorHash: evidence.workDescriptorHash,
        workDescriptorBytes: evidence.workDescriptorBytes,
        authorizationHash: evidence.authorizationHash,
        credentialHash: evidence.credentialHash,
        authorizationBytes: evidence.authorizationBytes,
        issuedAt: new Date(evidence.issuedAt),
        expiresAt: new Date(evidence.expiresAt),
        createdAt: new Date(evidence.createdAt),
      }).onConflictDoNothing().returning(),
    );
    if (inserted.length === 1) {
      return { status: "appended", evidence: rowToEvidence(inserted[0] as Row) };
    }
    const collisions = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select().from(processorCryptoSignerAuthorizations).where(
        or(
          eq(
            processorCryptoSignerAuthorizations.authorizationId,
            evidence.authorizationId,
          ),
          and(
            eq(processorCryptoSignerAuthorizations.requestId, evidence.requestId),
            eq(
              processorCryptoSignerAuthorizations.recipientGeneration,
              evidence.recipientGeneration,
            ),
          ),
          eq(
            processorCryptoSignerAuthorizations.signerKeyId,
            evidence.signerKeyId,
          ),
          eq(
            processorCryptoSignerAuthorizations.authorizationHash,
            evidence.authorizationHash,
          ),
          eq(
            processorCryptoSignerAuthorizations.credentialHash,
            evidence.credentialHash,
          ),
        ),
      ).limit(5),
    );
    if (collisions.length === 1) {
      const existing = rowToEvidence(collisions[0] as Row);
      if (sameProcessorSignerAuthorizationEvidence(existing, evidence)) {
        return { status: "existing", evidence: existing };
      }
    }
    throw new BackgroundAuthorizationRepositoryConflictError(
      "signer_evidence_conflict",
    );
  }
}
