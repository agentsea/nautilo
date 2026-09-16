import {
  createDeviceFanoutAdmission,
  decodeNamespaceTransitionSubmission,
  decodeProviderTransitionSubmission,
  verifyAdditionalDeviceApproval,
  verifyDeliveryAcknowledgementProof,
  verifyDeviceJoinPackage,
  nautiloActorId,
  nautiloUserId,
  type AdditionalDeviceApprovalManifest,
  type BeginAdditionalDeviceEnrollment,
  type DeviceFanoutDomainPlan,
  type DeviceJoinPackageEnvelope,
  type PendingAdditionalDeviceEnrollment,
} from "@nautilo/lattice-bridge";
import {
  AdditionalDeviceEnrollmentService,
  PostgresAdditionalDeviceEnrollmentRepository,
  PostgresDeliveryAcknowledgementRepository,
  PostgresDeviceActivationRepository,
  PostgresDeviceDeliveryFetchRepository,
  PostgresDeviceFanoutAdmissionRepository,
  PostgresDeviceJoinPackageRepository,
  PostgresDomainTransitionLeaseRepository,
  PostgresDomainTransitionSubmissionRepository,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  LatticeCrypto,
  cryptoDeviceId,
  humanId,
  verifyNamespaceBindingProof,
  verifyBindingEnvelopePair,
} from "@nautilo/lattice-crypto";
import {
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  parseNamespaceBindingV2,
  parseNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  protectedAdditionalDeviceAcknowledgementRequestV1Schema,
  protectedAdditionalDeviceApprovalRequestV1Schema,
  protectedAdditionalDeviceBeginRequestV1Schema,
  protectedAdditionalDeviceDeliveriesRequestV1Schema,
  protectedAdditionalDeviceJoinPackagesRequestV1Schema,
  protectedAdditionalDeviceTransitionsRequestV1Schema,
  PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
  PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS,
  protectedAdditionalDeviceBeginRequestV2Schema,
  protectedAdditionalDeviceJoinPackagesRequestV2Schema,
  protectedAdditionalDeviceTransitionsRequestV2Schema,
  type ProtectedAdditionalDeviceActivationV1,
  type ProtectedAdditionalDeviceApprovalResponseV1,
  type ProtectedAdditionalDeviceDeliveriesV1,
  type ProtectedAdditionalDeviceEnrollmentV1,
  type ProtectedAdditionalDevicePlanV1,
  type ProtectedAdditionalDeviceTransitionPlanV1,
  type ProtectedAdditionalDevicePlanV2,
  type ProtectedAdditionalDeviceTransitionPlanV2,
} from "@nautilo/api-client";

interface AdditionalDeviceSessionAuthority {
  readonly userId: string;
  readonly humanActorId: string;
}

export interface PostgresAdditionalDeviceComposition {
  begin(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; request: ReturnType<typeof protectedAdditionalDeviceBeginRequestV1Schema.parse> }>): Promise<ProtectedAdditionalDevicePlanV1>;
  pending(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; approverDeviceId: string }>): Promise<readonly ProtectedAdditionalDevicePlanV1[]>;
  publishJoinPackages(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceJoinPackagesRequestV1Schema.parse> }>): Promise<Readonly<{ status: "published" | "duplicate" }>>;
  approve(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceApprovalRequestV1Schema.parse> }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  transitionPlan(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; approverDeviceId: string }>): Promise<ProtectedAdditionalDeviceTransitionPlanV1>;
  submitTransitions(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceTransitionsRequestV1Schema.parse> }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
  deliveries(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceDeliveriesRequestV1Schema.parse> }>): Promise<ProtectedAdditionalDeviceDeliveriesV1>;
  acknowledge(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceAcknowledgementRequestV1Schema.parse> }>): Promise<Readonly<{ status: "acknowledged" | "duplicate" }>>;
  activate(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; deviceId: string }>): Promise<ProtectedAdditionalDeviceActivationV1>;
  beginV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; request: ReturnType<typeof protectedAdditionalDeviceBeginRequestV2Schema.parse> }>): Promise<ProtectedAdditionalDevicePlanV2>;
  planPageV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; deviceId: string; pageStart: number }>): Promise<ProtectedAdditionalDevicePlanV2>;
  pendingV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; approverDeviceId: string }>): Promise<readonly ProtectedAdditionalDevicePlanV2[]>;
  publishJoinPackagesV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceJoinPackagesRequestV2Schema.parse> }>): Promise<Readonly<{ status: "published" | "duplicate" }>>;
  transitionPlanV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; approverDeviceId: string; pageStart: number }>): Promise<ProtectedAdditionalDeviceTransitionPlanV2>;
  submitTransitionsV2(input: Readonly<{ authority: AdditionalDeviceSessionAuthority; operationId: string; request: ReturnType<typeof protectedAdditionalDeviceTransitionsRequestV2Schema.parse> }>): Promise<ProtectedAdditionalDeviceApprovalResponseV1>;
}

type Row = Readonly<Record<string, unknown>>;
type VerifiedNamespaceBindingHead = ReturnType<
  typeof verifyNamespaceBindingProof
>;

interface InventoryNamespace {
  readonly namespaceId: string;
  readonly head: VerifiedNamespaceBindingHead;
  readonly bindingProofBytes: readonly Uint8Array[];
  readonly humanEnvelopeBytes: Uint8Array;
  readonly aiEnvelopeBytes: Uint8Array;
}

interface InventoryDomain {
  readonly domainId: string;
  readonly providerId: string;
  readonly epoch: number;
  readonly stateHash: Uint8Array;
  readonly authorizationRevision: number;
  readonly participantDigest: Uint8Array;
  readonly rosterBytes: Uint8Array;
  readonly committerDeviceId: string;
  readonly committerSigningPublicKey: Uint8Array;
  readonly namespaces: readonly InventoryNamespace[];
}

interface InventorySnapshot {
  readonly domains: readonly InventoryDomain[];
  readonly items: readonly Readonly<{
    authorizedHumanId: ReturnType<typeof humanId>;
    trustedNamespaceHead: VerifiedNamespaceBindingHead;
    keyClass: "human" | "ai";
  }>[];
  readonly count: number;
  readonly digest: Uint8Array;
}

const encoder = new TextEncoder();

export function enrollmentDto(
  value: PendingAdditionalDeviceEnrollment,
): ProtectedAdditionalDeviceEnrollmentV1 {
  if (value.clientKind === "tui" || value.method !== "device_approval") {
    throw new TypeError("Additional-device enrollment is not supported");
  }
  return Object.freeze({
    formatVersion: 1,
    operationId: value.operationId,
    challengeId: value.challengeId,
    userId: value.userId,
    humanActorId: value.humanActorId,
    deviceId: value.deviceId,
    clientKind: value.clientKind,
    installationLineageDigestBase64url: encode(value.installationLineageDigest),
    deviceGeneration: 1,
    signingPublicKeyBase64url: encode(value.signingPublicKey),
    encryptionPublicKeyBase64url: encode(value.encryptionPublicKey),
    method: "device_approval",
    idempotencyKey: value.idempotencyKey,
    authorizationEvidenceDigestBase64url: encode(value.authorizationEvidenceDigest),
    authorizationDigestBase64url: encode(value.authorizationDigest),
    expectedCustodyRevision: value.expectedCustodyRevision,
    expectedRecoveryGeneration: value.expectedRecoveryGeneration,
    inventoryRevision: value.inventoryRevision,
    inventoryCount: value.inventoryCount,
    inventoryDigestBase64url: encode(value.inventoryDigest),
    deviceRevision: 0,
    status: "pending",
    issuedAt: value.issuedAt,
    expiresAt: value.expiresAt,
  });
}

function encode(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decode(value: string): Uint8Array {
  const bytes = Uint8Array.from(Buffer.from(value, "base64url"));
  if (Buffer.from(bytes).toString("base64url") !== value) {
    bytes.fill(0);
    throw new TypeError("Additional-device bytes are not canonical base64url");
  }
  return bytes;
}

function string(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new TypeError(`${name} must be text`);
  return value;
}

function number(row: Row, name: string): number {
  const raw = row[name];
  const value = typeof raw === "bigint" ? Number(raw)
    : typeof raw === "string" ? Number(raw) : raw;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a safe counter`);
  }
  return value;
}

function nullableNumber(row: Row, name: string): number | null {
  return row[name] === null ? null : number(row, name);
}

function bytes(row: Row, name: string): Uint8Array {
  const value = row[name];
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be bytes`);
  return value;
}

function nullableBytes(row: Row, name: string): Uint8Array | null {
  return row[name] === null ? null : bytes(row, name);
}

function milliseconds(row: Row, name: string): number {
  return number(row, name);
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function evidenceDigest(input: Readonly<{
  crypto: LatticeCrypto;
  userId: string;
  humanActorId: string;
  custodyRevision: number;
  recoveryGeneration: number;
  inventoryRevision: number;
  inventoryCount: number;
  inventoryDigest: Uint8Array;
}>): Uint8Array {
  const prefix = encoder.encode(
    `nautilo/additional-device-session/v1\0${input.userId}\0${input.humanActorId}\0${input.custodyRevision}\0${input.recoveryGeneration}\0${input.inventoryRevision}\0${input.inventoryCount}\0`,
  );
  const payload = new Uint8Array(prefix.length + input.inventoryDigest.length);
  payload.set(prefix);
  payload.set(input.inventoryDigest, prefix.length);
  try {
    return input.crypto.hash(payload);
  } finally {
    prefix.fill(0);
    payload.fill(0);
  }
}

async function loadInventory(
  executor: CryptoPostgresExecutor,
  crypto: LatticeCrypto,
  targetHumanId: string,
  committerDeviceId?: string,
  inventoryRevision = 1,
): Promise<InventorySnapshot> {
  const domainRows = await executor.query(
    `SELECT d.id AS domain_id, d.epoch, d.authorization_revision,
            d.participant_digest, d.roster_bytes,
            p.provider_id, p.state_hash,
            member.device_id AS committer_device_id,
            member.signing_public_key AS committer_signing_public_key
       FROM crypto_domains d
       JOIN crypto_domain_provider_heads p ON p.domain_id = d.id
       JOIN LATERAL (
         SELECT dd.device_id, hd.signing_public_key
           FROM crypto_domain_devices dd
           JOIN human_crypto_devices hd ON hd.device_id = dd.device_id
          WHERE dd.domain_id = d.id
            AND dd.human_id = $1
            AND dd.removed_at IS NULL
            AND hd.state = 'active'
            AND ($2::text IS NULL OR dd.device_id = $2)
          ORDER BY dd.device_id
          LIMIT 1
       ) member ON true
      ORDER BY d.id`,
    [targetHumanId, committerDeviceId ?? null],
  );
  if (domainRows.length > PROTECTED_ADDITIONAL_DEVICE_MAX_DOMAINS) {
    throw new Error("additional_device_domain_capacity_exceeded");
  }
  const deviceRows = await executor.query(
    `SELECT d.device_id, d.signing_public_key,
            m.domain_id, m.joined_epoch, m.removed_epoch
       FROM human_crypto_devices d
       JOIN crypto_domain_devices m ON m.device_id = d.device_id
      WHERE m.domain_id = ANY($1::text[])
      ORDER BY m.domain_id, d.device_id`,
    [domainRows.map((row) => string(row, "domain_id"))],
  );
  const historical: Readonly<{
    domainId: string;
    deviceId: string;
    joinedEpoch: number;
    removedEpoch: number | null;
    publicKey: Uint8Array;
  }>[] = deviceRows.map((row) => Object.freeze({
    domainId: string(row, "domain_id"),
    deviceId: string(row, "device_id"),
    joinedEpoch: number(row, "joined_epoch"),
    removedEpoch: nullableNumber(row, "removed_epoch"),
    publicKey: bytes(row, "signing_public_key"),
  }));
  const bindingRows = await executor.query(
    `SELECT b.namespace_id, b.revision, b.binding_hash,
            b.signed_binding_bytes, b.human_keyring_envelope_bytes,
            b.ai_keyring_envelope_bytes, h.domain_id, h.access_revision
       FROM namespace_crypto_bindings b
       JOIN namespace_crypto_heads h ON h.namespace_id = b.namespace_id
      WHERE h.domain_id = ANY($1::text[])
        AND b.revision <= h.access_revision
      ORDER BY b.namespace_id, b.revision`,
    [domainRows.map((row) => string(row, "domain_id"))],
  );
  const byNamespace = new Map<string, Row[]>();
  for (const row of bindingRows) {
    const list = byNamespace.get(string(row, "namespace_id")) ?? [];
    list.push(row);
    byNamespace.set(string(row, "namespace_id"), list);
  }
  const human = humanId(targetHumanId);
  const items: InventorySnapshot["items"][number][] = [];
  const domains: InventoryDomain[] = [];
  for (const row of domainRows) {
    const domainId = string(row, "domain_id");
    const namespaces: InventoryNamespace[] = [];
    for (const [namespaceId, chainRows] of [...byNamespace].sort(([left], [right]) => compare(left, right))) {
      if (string(chainRows[0]!, "domain_id") !== domainId) continue;
      const proof = chainRows.map((candidate) =>
        parseNamespaceBindingV2(bytes(candidate, "signed_binding_bytes"))
      );
      const head = verifyNamespaceBindingProof({
        crypto,
        anchor: null,
        proof,
        resolveHistoricalCommitter: (context) => historical.find((candidate) =>
          candidate.domainId === context.domainId
          && candidate.deviceId === context.committerDeviceId
          && candidate.joinedEpoch <= context.domainEpoch
          && (candidate.removedEpoch === null
            || context.domainEpoch < candidate.removedEpoch)
        )?.publicKey ?? null,
      });
      const current = chainRows.at(-1)!;
      if (
        head.namespaceId !== namespaceId
        || head.accessRevision !== number(current, "access_revision")
        || !equalBytes(head.bindingHash, bytes(current, "binding_hash"))
      ) throw new Error("additional_device_namespace_inventory_stale");
      const humanEnvelopeBytes = bytes(current, "human_keyring_envelope_bytes");
      const aiEnvelopeBytes = bytes(current, "ai_keyring_envelope_bytes");
      if (!verifyBindingEnvelopePair(
        head.binding,
        parseNamespaceKeyringEnvelopeV2(humanEnvelopeBytes),
        parseNamespaceKeyringEnvelopeV2(aiEnvelopeBytes),
      )) throw new Error("additional_device_namespace_inventory_invalid");
      namespaces.push(Object.freeze({
        namespaceId,
        head,
        bindingProofBytes: Object.freeze(chainRows.map((candidate) =>
          bytes(candidate, "signed_binding_bytes").slice()
        )),
        humanEnvelopeBytes: humanEnvelopeBytes.slice(),
        aiEnvelopeBytes: aiEnvelopeBytes.slice(),
      }));
      items.push(Object.freeze({ authorizedHumanId: human, trustedNamespaceHead: head, keyClass: "ai" }));
      items.push(Object.freeze({ authorizedHumanId: human, trustedNamespaceHead: head, keyClass: "human" }));
    }
    domains.push(Object.freeze({
      domainId,
      providerId: string(row, "provider_id"),
      epoch: number(row, "epoch"),
      stateHash: bytes(row, "state_hash").slice(),
      authorizationRevision: number(row, "authorization_revision"),
      participantDigest: bytes(row, "participant_digest").slice(),
      rosterBytes: bytes(row, "roster_bytes").slice(),
      committerDeviceId: string(row, "committer_device_id"),
      committerSigningPublicKey:
        bytes(row, "committer_signing_public_key").slice(),
      namespaces: Object.freeze(namespaces),
    }));
  }
  if (items.length > 4_096) {
    throw new Error("additional_device_keyring_inventory_unavailable");
  }
  const revision = deviceTransferInventoryRevisionV2(inventoryRevision);
  const digest = deviceTransferInventoryDigestV2({
    humanId: human,
    inventoryRevision: revision,
    inventory: items,
  });
  return Object.freeze({
    domains: Object.freeze(domains),
    items: Object.freeze(items),
    count: items.length,
    digest,
  });
}

function destroyInventory(value: InventorySnapshot): void {
  value.digest.fill(0);
  for (const domain of value.domains) {
    domain.stateHash.fill(0);
    domain.participantDigest.fill(0);
    domain.rosterBytes.fill(0);
    domain.committerSigningPublicKey.fill(0);
    for (const namespace of domain.namespaces) {
      namespace.bindingProofBytes.forEach((value) => value.fill(0));
      namespace.humanEnvelopeBytes.fill(0);
      namespace.aiEnvelopeBytes.fill(0);
    }
  }
}

interface EnrollmentAuthorization {
  readonly expectedCustodyRevision: number;
  readonly expectedRecoveryGeneration: number;
  readonly inventoryRevision: number;
  readonly inventoryCount: number;
  readonly inventoryDigest: Uint8Array;
  readonly authorizationEvidenceDigest: Uint8Array;
  readonly activeDeviceCount: number;
  readonly pendingDeviceCount: number;
}

type PersonalAuthorityAnchor = Readonly<{
  roomId: string;
  namespaceId: string;
}>;

export async function prepareEnrollmentAuthorization(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  userId: string;
  humanActorId: string;
  transferScope?: "current_inventory" | "identity_only";
}>): Promise<EnrollmentAuthorization> {
  return input.handle.transaction(async (transaction) => {
    await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    await transaction.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`additional-device/${input.humanActorId}`],
    );
    const rows = await transaction.query(
      `SELECT h.human_id, h.user_id::text AS user_id,
              h.human_actor_id::text AS human_actor_id,
              h.state, h.current_recovery_generation,
              h.current_inventory_revision, h.current_inventory_count,
              h.current_inventory_digest, h.revision,
              (SELECT count(*) FROM human_crypto_devices d
                WHERE d.human_id = h.human_id AND d.state = 'active')::bigint
                AS active_device_count,
              (SELECT count(*) FROM human_crypto_devices d
                WHERE d.human_id = h.human_id AND d.state = 'pending')::bigint
                AS pending_device_count
         FROM human_crypto_custodies h
        WHERE h.human_id = $1
        LIMIT 2
        FOR UPDATE`,
      [input.humanActorId],
    );
    if (rows.length !== 1) throw new Error("additional_device_authorization_rejected");
    const row = rows[0]!;
    if (
      string(row, "user_id") !== input.userId
      || string(row, "human_actor_id") !== input.humanActorId
      || string(row, "state") !== "active"
    ) throw new Error("additional_device_authorization_rejected");
    if (input.transferScope === "identity_only") {
      const inventoryRevision = deviceTransferInventoryRevisionV2(0);
      const inventoryDigest = deviceTransferInventoryDigestV2({
        humanId: humanId(input.humanActorId),
        inventoryRevision,
        inventory: Object.freeze([]),
      });
      const evidence = evidenceDigest({
        crypto: input.crypto,
        userId: input.userId,
        humanActorId: input.humanActorId,
        custodyRevision: number(row, "revision"),
        recoveryGeneration: number(row, "current_recovery_generation"),
        inventoryRevision,
        inventoryCount: 0,
        inventoryDigest,
      });
      return Object.freeze({
        expectedCustodyRevision: number(row, "revision"),
        expectedRecoveryGeneration: number(
          row,
          "current_recovery_generation",
        ),
        inventoryRevision,
        inventoryCount: 0,
        inventoryDigest,
        authorizationEvidenceDigest: evidence,
        activeDeviceCount: number(row, "active_device_count"),
        pendingDeviceCount: number(row, "pending_device_count"),
      });
    }
    const priorRevision = nullableNumber(row, "current_inventory_revision");
    // The custody schema represents a Human with no Crypto-Domain inventory as
    // the coherent all-null triplet. Keep that representation until the first
    // Domain exists; the enrollment manifest still commits to the canonical
    // empty inventory at revision zero.
    const inventoryRevision = priorRevision ?? 0;
    const inventory = await loadInventory(
      transaction,
      input.crypto,
      input.humanActorId,
      undefined,
      inventoryRevision,
    );
    try {
      const priorCount = nullableNumber(row, "current_inventory_count");
      const priorDigest = nullableBytes(row, "current_inventory_digest");
      let custodyRevision = number(row, "revision");
      const coherentEmptyInventory = priorRevision === null
        && priorCount === null
        && priorDigest === null
        && inventory.count === 0;
      if (
        !coherentEmptyInventory
        && (priorRevision === null
        || priorCount !== inventory.count
        || priorDigest === null
        || !equalBytes(priorDigest, inventory.digest))
      ) {
        const nextInventoryRevision = priorRevision === null ? 1 : priorRevision + 1;
        const nextInventory = nextInventoryRevision === inventoryRevision
          ? inventory
          : await loadInventory(
            transaction,
            input.crypto,
            input.humanActorId,
            undefined,
            nextInventoryRevision,
          );
        try {
          custodyRevision += 1;
          const updated = await transaction.query(
            `UPDATE human_crypto_custodies
                SET current_inventory_revision = $2,
                    current_inventory_count = $3,
                    current_inventory_digest = $4,
                    revision = $5
              WHERE human_id = $1
                AND revision = $6
              RETURNING human_id`,
            [
              input.humanActorId,
              nextInventoryRevision,
              nextInventory.count,
              nextInventory.digest,
              custodyRevision,
              number(row, "revision"),
            ],
          );
          if (updated.length !== 1) throw new Error("additional_device_stale_state");
          const evidence = evidenceDigest({
            crypto: input.crypto,
            userId: input.userId,
            humanActorId: input.humanActorId,
            custodyRevision,
            recoveryGeneration: number(row, "current_recovery_generation"),
            inventoryRevision: nextInventoryRevision,
            inventoryCount: nextInventory.count,
            inventoryDigest: nextInventory.digest,
          });
          return Object.freeze({
            expectedCustodyRevision: custodyRevision,
            expectedRecoveryGeneration: number(row, "current_recovery_generation"),
            inventoryRevision: nextInventoryRevision,
            inventoryCount: nextInventory.count,
            inventoryDigest: nextInventory.digest.slice(),
            authorizationEvidenceDigest: evidence,
            activeDeviceCount: number(row, "active_device_count"),
            pendingDeviceCount: number(row, "pending_device_count"),
          });
        } finally {
          if (nextInventory !== inventory) destroyInventory(nextInventory);
        }
      }
      const evidence = evidenceDigest({
        crypto: input.crypto,
        userId: input.userId,
        humanActorId: input.humanActorId,
        custodyRevision,
        recoveryGeneration: number(row, "current_recovery_generation"),
        inventoryRevision,
        inventoryCount: inventory.count,
        inventoryDigest: inventory.digest,
      });
      return Object.freeze({
        expectedCustodyRevision: custodyRevision,
        expectedRecoveryGeneration: number(row, "current_recovery_generation"),
        inventoryRevision,
        inventoryCount: inventory.count,
        inventoryDigest: inventory.digest.slice(),
        authorizationEvidenceDigest: evidence,
        activeDeviceCount: number(row, "active_device_count"),
        pendingDeviceCount: number(row, "pending_device_count"),
      });
    } finally {
      destroyInventory(inventory);
    }
  });
}

export function destroyEnrollmentAuthorization(
  value: EnrollmentAuthorization,
): void {
  value.inventoryDigest.fill(0);
  value.authorizationEvidenceDigest.fill(0);
}

function assertAdditionalDeviceV1DomainCount(count: number): void {
  if (count < 1 || count > PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE) {
    throw new Error("additional_device_v2_required");
  }
}

async function loadPendingEnrollment(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  authority: Readonly<{ userId: string; humanActorId: string }>;
  operationId: string;
}>): Promise<PendingAdditionalDeviceEnrollment> {
  const rows = await input.handle.query(
    `SELECT o.operation_id, o.idempotency_key,
            o.expected_custody_revision, o.expected_recovery_generation,
            c.challenge_id, c.installation_lineage_digest,
            c.authorization_digest,
            floor(extract(epoch from c.issued_at) * 1000)::bigint AS issued_at_ms,
            floor(extract(epoch from c.expires_at) * 1000)::bigint AS expires_at_ms,
            d.user_id::text AS user_id, d.human_actor_id::text AS human_actor_id,
            d.device_id, d.client_kind, d.device_generation,
            d.signing_public_key, d.encryption_public_key,
            e.expected_inventory_revision AS admitted_inventory_revision,
            e.expected_inventory_count AS admitted_inventory_count,
            e.expected_inventory_digest AS admitted_inventory_digest,
            h.current_inventory_revision AS custody_inventory_revision,
            h.current_inventory_count AS custody_inventory_count,
            h.current_inventory_digest AS custody_inventory_digest,
            o.expected_participant_digest AS operation_inventory_digest,
            o.expected_recovery_generation AS current_recovery_generation,
            h.revision AS custody_revision
       FROM crypto_delivery_operations o
       JOIN human_crypto_devices d ON d.device_id = o.target_device_id
       JOIN human_crypto_device_challenges c
         ON c.pending_device_id = d.device_id
        AND c.idempotency_key = o.idempotency_key
       JOIN human_crypto_custodies h ON h.human_id = o.human_id
       LEFT JOIN crypto_device_epoch_operations e
         ON e.operation_id = o.operation_id
      WHERE o.operation_id = $1
        AND o.kind = 'device_add'
        AND o.human_id = $2
        AND d.state IN ('pending', 'active')
      LIMIT 2`,
    [input.operationId, input.authority.humanActorId],
  );
  if (rows.length !== 1) throw new Error("additional_device_operation_unavailable");
  const row = rows[0]!;
  if (
    string(row, "user_id") !== input.authority.userId
    || string(row, "human_actor_id") !== input.authority.humanActorId
  ) throw new Error("additional_device_authorization_rejected");
  const operationInventoryDigest = bytes(
    row,
    "operation_inventory_digest",
  ).slice();
  const emptyInventoryDigest = deviceTransferInventoryDigestV2({
    humanId: humanId(input.authority.humanActorId),
    inventoryRevision: deviceTransferInventoryRevisionV2(0),
    inventory: Object.freeze([]),
  });
  const admittedInventoryRevision = nullableNumber(
    row,
    "admitted_inventory_revision",
  );
  const identityOnly = equalBytes(operationInventoryDigest, emptyInventoryDigest);
  const inventoryRevision = admittedInventoryRevision
    ?? (identityOnly
      ? 0
      : nullableNumber(row, "custody_inventory_revision") ?? 0);
  const inventoryCount = admittedInventoryRevision !== null
    ? number(row, "admitted_inventory_count")
    : identityOnly
    ? 0
    : nullableNumber(row, "custody_inventory_count") ?? 0;
  const inventoryDigest = admittedInventoryRevision !== null
    ? bytes(row, "admitted_inventory_digest").slice()
    : identityOnly
    ? operationInventoryDigest.slice()
    : (nullableBytes(row, "custody_inventory_digest")
      ?? operationInventoryDigest).slice();
  operationInventoryDigest.fill(0);
  emptyInventoryDigest.fill(0);
  const authorizationEvidenceDigest = evidenceDigest({
    crypto: input.crypto,
    userId: input.authority.userId,
    humanActorId: input.authority.humanActorId,
    custodyRevision: number(row, "expected_custody_revision"),
    recoveryGeneration: number(row, "current_recovery_generation"),
    inventoryRevision,
    inventoryCount,
    inventoryDigest,
  });
  return Object.freeze({
    formatVersion: 1,
    operationId: string(row, "operation_id"),
    challengeId: string(row, "challenge_id"),
    userId: input.authority.userId as PendingAdditionalDeviceEnrollment["userId"],
    humanActorId: input.authority.humanActorId as PendingAdditionalDeviceEnrollment["humanActorId"],
    deviceId: string(row, "device_id"),
    clientKind: string(row, "client_kind") as "browser" | "electron",
    installationLineageDigest: bytes(row, "installation_lineage_digest").slice(),
    deviceGeneration: number(row, "device_generation"),
    signingPublicKey: bytes(row, "signing_public_key").slice(),
    encryptionPublicKey: bytes(row, "encryption_public_key").slice(),
    method: "device_approval",
    idempotencyKey: string(row, "idempotency_key"),
    authorizationEvidenceDigest,
    authorizationDigest: bytes(row, "authorization_digest").slice(),
    expectedCustodyRevision: number(row, "expected_custody_revision"),
    expectedRecoveryGeneration: number(row, "expected_recovery_generation"),
    inventoryRevision,
    inventoryCount,
    inventoryDigest,
    deviceRevision: 0,
    status: "pending",
    issuedAt: milliseconds(row, "issued_at_ms"),
    expiresAt: milliseconds(row, "expires_at_ms"),
  });
}

export function destroyPendingAdditionalDeviceEnrollment(
  value: PendingAdditionalDeviceEnrollment,
): void {
  value.installationLineageDigest.fill(0);
  value.signingPublicKey.fill(0);
  value.encryptionPublicKey.fill(0);
  value.authorizationEvidenceDigest.fill(0);
  value.authorizationDigest.fill(0);
  value.inventoryDigest.fill(0);
}

async function loadPlan(input: Readonly<{
  handle: CryptoPostgresHandle;
  crypto: LatticeCrypto;
  authority: Readonly<{ userId: string; humanActorId: string }>;
  operationId: string;
  committerDeviceId?: string;
  resolvePersonalAuthorityAnchor?(
    humanActorId: string,
  ): Promise<PersonalAuthorityAnchor | null>;
}>): Promise<Readonly<{
  enrollment: PendingAdditionalDeviceEnrollment;
  inventory: InventorySnapshot;
  approver: Readonly<{ deviceId: string; signingPublicKey: Uint8Array }>;
  personalAuthority: PersonalAuthorityAnchor | null;
  dto: ProtectedAdditionalDevicePlanV1;
}>> {
  const enrollment = await loadPendingEnrollment(input);
  let inventory: InventorySnapshot | undefined;
  try {
    inventory = enrollment.inventoryRevision === 0
        && enrollment.inventoryCount === 0
      ? Object.freeze({
          domains: Object.freeze([]),
          items: Object.freeze([]),
          count: 0,
          digest: enrollment.inventoryDigest.slice(),
        })
      : await loadInventory(
          input.handle,
          input.crypto,
          input.authority.humanActorId,
          input.committerDeviceId,
          enrollment.inventoryRevision,
        );
    if (
      inventory.count !== enrollment.inventoryCount
      || !equalBytes(inventory.digest, enrollment.inventoryDigest)
    ) throw new Error("additional_device_inventory_stale");
    const approverRows = await input.handle.query(
      `SELECT device_id, signing_public_key
         FROM human_crypto_devices
        WHERE human_id = $1 AND state = 'active'
          AND ($2::text IS NULL OR device_id = $2)
        ORDER BY device_id LIMIT 1`,
      [input.authority.humanActorId, input.committerDeviceId ?? null],
    );
    if (approverRows.length !== 1) {
      throw new Error("additional_device_approver_unavailable");
    }
    const approver = Object.freeze({
      deviceId: string(approverRows[0]!, "device_id"),
      signingPublicKey: bytes(
        approverRows[0]!,
        "signing_public_key",
      ).slice(),
    });
    const personalAuthority = input.resolvePersonalAuthorityAnchor === undefined
      ? null
      : await input.resolvePersonalAuthorityAnchor(
        input.authority.humanActorId,
      );
    const dto: ProtectedAdditionalDevicePlanV1 = {
      formatVersion: 1 as const,
      enrollment: enrollmentDto(enrollment),
      domains: inventory.domains.map((domain) => ({
        domainId: domain.domainId,
        expectedHead: Object.freeze({
          providerId: domain.providerId,
          domainId: domain.domainId,
          epoch: domain.epoch,
          stateHashBase64url: encode(domain.stateHash),
        }),
        authorizationRevision: domain.authorizationRevision,
        participantDigestBase64url: encode(domain.participantDigest),
        rosterBytesBase64url: encode(domain.rosterBytes),
        committerDeviceId: domain.committerDeviceId,
        committerSigningPublicKeyBase64url:
          encode(domain.committerSigningPublicKey),
        namespaces: domain.namespaces.map((namespace) => ({
          namespaceId: namespace.namespaceId,
          accessRevision: namespace.head.accessRevision,
          bindingHashBase64url: encode(namespace.head.bindingHash),
          bindingProofBytesBase64url: namespace.bindingProofBytes.map(encode),
          humanEnvelopeBytesBase64url: encode(namespace.humanEnvelopeBytes),
          aiEnvelopeBytesBase64url: encode(namespace.aiEnvelopeBytes),
        })),
      })),
    };
    return Object.freeze({
      enrollment,
      inventory,
      approver,
      personalAuthority,
      dto,
    });
  } catch (error) {
    destroyPendingAdditionalDeviceEnrollment(enrollment);
    if (inventory) destroyInventory(inventory);
    throw error;
  }
}

type LoadedAdditionalDevicePlan = Awaited<ReturnType<typeof loadPlan>>;

function destroyLoadedPlan(plan: LoadedAdditionalDevicePlan): void {
  destroyPendingAdditionalDeviceEnrollment(plan.enrollment);
  destroyInventory(plan.inventory);
  plan.approver.signingPublicKey.fill(0);
}

function planPageDto(input: Readonly<{
  crypto: LatticeCrypto;
  plan: Awaited<ReturnType<typeof loadPlan>>;
  pageStart: number;
  progress?: "approval_required" | "transfer_ready" | "awaiting_target";
}>): ProtectedAdditionalDevicePlanV2 {
  const domainCount = input.plan.inventory.domains.length;
  if (
    !Number.isSafeInteger(input.pageStart)
    || input.pageStart < 0
    || input.pageStart > domainCount
  ) throw new Error("additional_device_page_unavailable");
  const end = Math.min(
    input.pageStart + PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
    domainCount,
  );
  const domains = input.plan.dto.domains.slice(input.pageStart, end);
  const approver = Object.freeze({
    deviceId: input.plan.approver.deviceId,
    signingPublicKeyBase64url: encode(
      input.plan.approver.signingPublicKey,
    ),
  });
  const pageBinding = encoder.encode(JSON.stringify({
    operationId: input.plan.enrollment.operationId,
    targetDeviceId: input.plan.enrollment.deviceId,
    inventoryRevision: input.plan.enrollment.inventoryRevision,
    inventoryCount: input.plan.enrollment.inventoryCount,
    inventoryDigestBase64url:
      encode(input.plan.enrollment.inventoryDigest),
    domainCount,
    approver,
    personalAuthority: input.plan.personalAuthority,
    start: input.pageStart,
    end,
    domains,
  }));
  try {
    return Object.freeze({
      formatVersion: 2 as const,
      ...(input.progress === undefined ? {} : { progress: input.progress }),
      enrollment: input.plan.dto.enrollment,
      approver,
      personalAuthority: input.plan.personalAuthority,
      domainCount,
      page: Object.freeze({
        start: input.pageStart,
        end,
        nextStart: end === domainCount ? null : end,
        pageDigestBase64url: encode(input.crypto.hash(pageBinding)),
      }),
      domains,
    });
  } finally {
    pageBinding.fill(0);
  }
}

function domainFanoutPlan(
  domain: InventoryDomain,
): DeviceFanoutDomainPlan {
  return Object.freeze({
    domainId: domain.domainId,
    expectedEpoch: domain.epoch,
    targetEpoch: domain.epoch + 1,
    expectedAuthorizationRevision: domain.authorizationRevision,
    expectedParticipantDigest: domain.participantDigest.slice(),
    committerDeviceId: domain.committerDeviceId,
    namespaces: Object.freeze(domain.namespaces.map((namespace) => Object.freeze({
      namespaceId: namespace.namespaceId,
      expectedAccessRevision: namespace.head.accessRevision,
      expectedBindingHash: namespace.head.bindingHash.slice(),
    }))),
  });
}

function manifestFromDto(
  value: ReturnType<
    typeof import("@nautilo/api-client").protectedAdditionalDeviceApprovalRequestV1Schema.parse
  >["manifest"],
): AdditionalDeviceApprovalManifest {
  return Object.freeze({
    formatVersion: 1,
    operationId: value.operationId,
    humanId: value.humanId,
    targetDeviceId: value.targetDeviceId,
    issuerDeviceId: value.issuerDeviceId,
    expectedDeviceRevision: 0,
    expectedCustodyRevision: value.expectedCustodyRevision,
    expectedRecoveryGeneration: value.expectedRecoveryGeneration,
    inventoryRevision: value.inventoryRevision,
    inventoryCount: value.inventoryCount,
    inventoryDigest: decode(value.inventoryDigestBase64url),
    approvalHash: decode(value.approvalHashBase64url),
    signature: decode(value.signatureBase64url),
  });
}

function destroyManifest(value: AdditionalDeviceApprovalManifest): void {
  value.inventoryDigest.fill(0);
  value.approvalHash.fill(0);
  value.signature.fill(0);
}

type AdditionalDeviceSyncReason = "current_domain_sync_required";

export async function currentEnrollmentSyncReason(
  db: CryptoPostgresExecutor,
  targetDeviceId: string,
): Promise<AdditionalDeviceSyncReason | null> {
  const rows = await db.query(
    `WITH target AS (
       SELECT device_id, device_generation, human_id
         FROM human_crypto_devices
        WHERE device_id = $1 AND state = 'active'
     ), required_domains AS (
       SELECT DISTINCT member.domain_id
         FROM target
         JOIN crypto_domain_devices member
           ON member.human_id = target.human_id
          AND member.removed_at IS NULL
         JOIN human_crypto_devices source
           ON source.device_id = member.device_id
          AND source.state = 'active'
     ), target_domains AS (
       SELECT DISTINCT member.domain_id
         FROM target
         JOIN crypto_domain_devices member
           ON member.device_id = target.device_id
          AND member.removed_at IS NULL
     )
     SELECT (SELECT count(*) FROM target)::bigint AS target_count,
            (SELECT count(*) FROM required_domains)::bigint
              AS required_domains,
            (SELECT count(*) FROM target_domains)::bigint
              AS covered_domains`,
    [targetDeviceId],
  );
  if (rows.length !== 1
    || number(rows[0]!, "target_count") !== 1
    || number(rows[0]!, "required_domains")
      !== number(rows[0]!, "covered_domains")) {
    return "current_domain_sync_required";
  }
  return null;
}

export function additionalDevicePendingProgress(input: Readonly<{
  operationState: string;
  transitionStepCount: number;
  joinPackageCount: number;
  admissionPresent: boolean;
}>): "approval_required" | "transfer_ready" | "awaiting_target" {
  if (input.transitionStepCount === 0) {
    return input.admissionPresent
      ? "transfer_ready"
      : "approval_required";
  }
  return input.operationState === "awaiting_delivery"
      || input.joinPackageCount < input.transitionStepCount
    ? "awaiting_target"
    : "transfer_ready";
}

export function createPostgresAdditionalDeviceComposition(input: Readonly<{
  getHandle: () => Promise<CryptoPostgresHandle>;
  resolvePersonalAuthorityAnchor?(
    humanActorId: string,
  ): Promise<PersonalAuthorityAnchor | null>;
  crypto?: LatticeCrypto;
}>): PostgresAdditionalDeviceComposition {
  const crypto = input.crypto ?? new LatticeCrypto();
  const handle = input.getHandle;
  const loadCurrentPlan = (
    value: Omit<Parameters<typeof loadPlan>[0], "resolvePersonalAuthorityAnchor">,
  ) => loadPlan({
    ...value,
    ...(input.resolvePersonalAuthorityAnchor === undefined ? {} : {
      resolvePersonalAuthorityAnchor: input.resolvePersonalAuthorityAnchor,
    }),
  });

  const composition: PostgresAdditionalDeviceComposition = {
    async begin(input) {
      const user = nautiloUserId(input.authority.userId);
      const actor = nautiloActorId(input.authority.humanActorId);
      if (!user.ok || !actor.ok) throw new Error("additional_device_authorization_rejected");
      const detached = [
        decode(input.request.installationLineageDigestBase64url),
        decode(input.request.signingPublicKeyBase64url),
        decode(input.request.encryptionPublicKeyBase64url),
      ];
      const authorization = await prepareEnrollmentAuthorization({
        handle: await handle(),
        crypto,
        ...input.authority,
      });
      try {
        assertAdditionalDeviceV1DomainCount(authorization.inventoryCount);
        const request: BeginAdditionalDeviceEnrollment = Object.freeze({
          userId: user.value,
          humanActorId: actor.value,
          deviceId: cryptoDeviceId(input.request.deviceId),
          clientKind: input.request.clientKind,
          installationLineageDigest: detached[0]!,
          deviceGeneration: 1,
          signingPublicKey: detached[1]!,
          encryptionPublicKey: detached[2]!,
          method: "device_approval",
          idempotencyKey: input.request.idempotencyKey,
        });
        const repository = new PostgresAdditionalDeviceEnrollmentRepository(
          await handle(),
        );
        const service = new AdditionalDeviceEnrollmentService({
          crypto,
          repository,
          authorize: (candidate) => candidate.userId === user.value
              && candidate.humanActorId === actor.value
            ? Object.freeze({
              authorized: true as const,
              authorizationEvidenceDigest:
                authorization.authorizationEvidenceDigest.slice(),
              installationLineageDigest:
                candidate.installationLineageDigest.slice(),
              expectedCustodyRevision:
                authorization.expectedCustodyRevision,
              expectedRecoveryGeneration:
                authorization.expectedRecoveryGeneration,
              inventoryRevision: authorization.inventoryRevision,
              inventoryCount: authorization.inventoryCount,
              inventoryDigest: authorization.inventoryDigest.slice(),
              activeDeviceCount: authorization.activeDeviceCount,
              pendingDeviceCount: authorization.pendingDeviceCount,
            })
            : Object.freeze({ authorized: false as const }),
        });
        const pending = await service.begin(request);
        try {
          const plan = await loadCurrentPlan({
            handle: await handle(),
            crypto,
            authority: input.authority,
            operationId: pending.operationId,
          });
          try {
            return plan.dto;
          } finally {
            destroyLoadedPlan(plan);
          }
        } finally {
          destroyPendingAdditionalDeviceEnrollment(pending);
        }
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyEnrollmentAuthorization(authorization);
      }
    },

    async beginV2(input) {
      const user = nautiloUserId(input.authority.userId);
      const actor = nautiloActorId(input.authority.humanActorId);
      if (!user.ok || !actor.ok) throw new Error("additional_device_authorization_rejected");
      const detached = [
        decode(input.request.installationLineageDigestBase64url),
        decode(input.request.signingPublicKeyBase64url),
        decode(input.request.encryptionPublicKeyBase64url),
      ];
      const authorization = await prepareEnrollmentAuthorization({
        handle: await handle(),
        crypto,
        ...input.authority,
        transferScope: "identity_only",
      });
      try {
        const request: BeginAdditionalDeviceEnrollment = Object.freeze({
          userId: user.value,
          humanActorId: actor.value,
          deviceId: cryptoDeviceId(input.request.deviceId),
          clientKind: input.request.clientKind,
          installationLineageDigest: detached[0]!,
          deviceGeneration: 1,
          signingPublicKey: detached[1]!,
          encryptionPublicKey: detached[2]!,
          method: "device_approval",
          idempotencyKey: input.request.idempotencyKey,
        });
        const service = new AdditionalDeviceEnrollmentService({
          crypto,
          repository: new PostgresAdditionalDeviceEnrollmentRepository(
            await handle(),
          ),
          authorize: (candidate) => candidate.userId === user.value
              && candidate.humanActorId === actor.value
            ? Object.freeze({
              authorized: true as const,
              authorizationEvidenceDigest:
                authorization.authorizationEvidenceDigest.slice(),
              installationLineageDigest:
                candidate.installationLineageDigest.slice(),
              expectedCustodyRevision:
                authorization.expectedCustodyRevision,
              expectedRecoveryGeneration:
                authorization.expectedRecoveryGeneration,
              inventoryRevision: authorization.inventoryRevision,
              inventoryCount: authorization.inventoryCount,
              inventoryDigest: authorization.inventoryDigest.slice(),
              activeDeviceCount: authorization.activeDeviceCount,
              pendingDeviceCount: authorization.pendingDeviceCount,
            })
            : Object.freeze({ authorized: false as const }),
        });
        const pending = await service.begin(request);
        try {
          const plan = await loadCurrentPlan({
            handle: await handle(),
            crypto,
            authority: input.authority,
            operationId: pending.operationId,
          });
          try {
            return planPageDto({
              crypto,
              plan,
              pageStart: input.request.pageStart,
            });
          } finally {
            destroyLoadedPlan(plan);
          }
        } finally {
          destroyPendingAdditionalDeviceEnrollment(pending);
        }
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyEnrollmentAuthorization(authorization);
      }
    },

    async planPageV2(input) {
      const pending = await loadPendingEnrollment({
        handle: await handle(),
        crypto,
        authority: input.authority,
        operationId: input.operationId,
      });
      const target = pending.deviceId === input.deviceId;
      destroyPendingAdditionalDeviceEnrollment(pending);
      const plan = await loadCurrentPlan({
        handle: await handle(),
        crypto,
        authority: input.authority,
        operationId: input.operationId,
        ...(target ? {} : { committerDeviceId: input.deviceId }),
      });
      try {
        return planPageDto({ crypto, plan, pageStart: input.pageStart });
      } finally {
        destroyLoadedPlan(plan);
      }
    },

    async pending(input) {
      const db = await handle();
      const deviceRows = await db.query(
        `SELECT device_id FROM human_crypto_devices
          WHERE device_id = $1 AND human_id = $2 AND state = 'active'
          LIMIT 2`,
        [input.approverDeviceId, input.authority.humanActorId],
      );
      if (deviceRows.length !== 1) throw new Error("additional_device_authorization_rejected");
      const rows = await db.query(
        `SELECT o.operation_id, o.state AS operation_state,
                EXISTS (
                  SELECT 1 FROM crypto_device_epoch_operations e
                   WHERE e.operation_id = o.operation_id
                ) AS admission_present,
                (SELECT count(*) FROM crypto_domain_transition_steps s
                  WHERE s.operation_id = o.operation_id)::bigint
                  AS transition_step_count,
                (SELECT count(*)
                   FROM crypto_domain_transition_steps pending_step
                   JOIN human_crypto_device_key_packages j
                     ON j.device_id = o.target_device_id
                    AND j.domain_id = pending_step.domain_id
                    AND j.generation = 1
                  WHERE pending_step.operation_id = o.operation_id)::bigint
                  AS join_package_count
           FROM crypto_delivery_operations o
          JOIN human_crypto_device_challenges c
            ON c.human_id = o.human_id
           AND c.pending_device_id = o.target_device_id
           AND c.idempotency_key = o.idempotency_key
         WHERE o.human_id = $1 AND o.kind = 'device_add'
           AND o.state NOT IN ('active', 'failed', 'cancelled')
           AND c.invalidated_at IS NULL
           AND (
             (c.consumed_at IS NULL AND c.expires_at > now())
             OR EXISTS (
               SELECT 1 FROM crypto_device_epoch_operations e
                WHERE e.operation_id = o.operation_id
             )
             OR EXISTS (
               SELECT 1
                 FROM crypto_domain_transition_steps s
                WHERE s.operation_id = o.operation_id
             )
           )
          ORDER BY o.created_at
          LIMIT 4`,
        [input.authority.humanActorId],
      );
      const result: ProtectedAdditionalDevicePlanV1[] = [];
      for (const row of rows) {
        const plan = await loadCurrentPlan({
          handle: db,
          crypto,
          authority: input.authority,
          operationId: string(row, "operation_id"),
          committerDeviceId: input.approverDeviceId,
        });
        try {
          assertAdditionalDeviceV1DomainCount(plan.inventory.domains.length);
          const transitionStarted = number(row, "transition_step_count") > 0;
          result.push(Object.freeze({
            ...plan.dto,
            progress: additionalDevicePendingProgress({
              operationState: string(row, "operation_state"),
              transitionStepCount: transitionStarted ? 1 : 0,
              joinPackageCount: number(row, "join_package_count"),
              admissionPresent: row["admission_present"] === true,
            }),
          }));
        } finally {
          destroyLoadedPlan(plan);
        }
      }
      return Object.freeze(result);
    },

    async pendingV2(input) {
      const db = await handle();
      const deviceRows = await db.query(
        `SELECT device_id FROM human_crypto_devices
          WHERE device_id = $1 AND human_id = $2 AND state = 'active'
          LIMIT 2`,
        [input.approverDeviceId, input.authority.humanActorId],
      );
      if (deviceRows.length !== 1) throw new Error("additional_device_authorization_rejected");
      const rows = await db.query(
        `SELECT o.operation_id, o.state AS operation_state,
                EXISTS (
                  SELECT 1 FROM crypto_device_epoch_operations e
                   WHERE e.operation_id = o.operation_id
                ) AS admission_present,
                (SELECT count(*) FROM crypto_domain_transition_steps s
                  WHERE s.operation_id = o.operation_id)::bigint
                  AS transition_step_count,
                (SELECT count(*)
                   FROM crypto_domain_transition_steps pending_step
                   JOIN human_crypto_device_key_packages j
                     ON j.device_id = o.target_device_id
                    AND j.domain_id = pending_step.domain_id
                    AND j.generation = 1
                  WHERE pending_step.operation_id = o.operation_id)::bigint
                  AS join_package_count,
                (SELECT count(*) FROM crypto_domain_transition_steps s
                  WHERE s.operation_id = o.operation_id
                    AND s.state IN ('awaiting_delivery', 'ready_to_activate', 'active'))::bigint
                  AS committed_transition_count
           FROM crypto_delivery_operations o
          JOIN human_crypto_device_challenges c
            ON c.human_id = o.human_id
           AND c.pending_device_id = o.target_device_id
           AND c.idempotency_key = o.idempotency_key
         WHERE o.human_id = $1 AND o.kind = 'device_add'
           AND o.state NOT IN ('active', 'failed', 'cancelled')
           AND c.invalidated_at IS NULL
           AND (
             (c.consumed_at IS NULL AND c.expires_at > now())
             OR EXISTS (
               SELECT 1 FROM crypto_device_epoch_operations e
                WHERE e.operation_id = o.operation_id
             )
             OR EXISTS (
               SELECT 1 FROM crypto_domain_transition_steps s
                WHERE s.operation_id = o.operation_id
             )
           )
          ORDER BY o.created_at LIMIT 4`,
        [input.authority.humanActorId],
      );
      const result: ProtectedAdditionalDevicePlanV2[] = [];
      for (const row of rows) {
        // Once any Domain commits, the live inventory is intentionally ahead
        // of the original plan. Only the approving device's sealed campaign
        // can resume that operation byte-for-byte; do not try to rebuild a
        // misleading plan from current heads.
        if (number(row, "committed_transition_count") > 0) continue;
        const plan = await loadCurrentPlan({
          handle: db,
          crypto,
          authority: input.authority,
          operationId: string(row, "operation_id"),
          committerDeviceId: input.approverDeviceId,
        });
        try {
          const transitionStarted = number(row, "transition_step_count") > 0;
          result.push(planPageDto({
            crypto,
            plan,
            pageStart: 0,
            progress: additionalDevicePendingProgress({
              operationState: string(row, "operation_state"),
              transitionStepCount: transitionStarted ? 1 : 0,
              joinPackageCount: number(row, "join_package_count"),
              admissionPresent: row["admission_present"] === true,
            }),
          }));
        } finally {
          destroyLoadedPlan(plan);
        }
      }
      return Object.freeze(result);
    },

    async approve(input) {
      const db = await handle();
      const plan = await loadCurrentPlan({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
        committerDeviceId: input.request.approverDeviceId,
      });
      const approvalBytes = decode(input.request.approvalBytesBase64url);
      const manifest = manifestFromDto(input.request.manifest);
      let approverKey: Uint8Array | undefined;
      try {
        if (
          manifest.operationId !== input.operationId
          || manifest.issuerDeviceId !== input.request.approverDeviceId
        ) throw new Error("additional_device_approval_substituted");
        const approverRows = await db.query(
          `SELECT signing_public_key FROM human_crypto_devices
            WHERE device_id = $1 AND human_id = $2 AND state = 'active'
            LIMIT 2`,
          [input.request.approverDeviceId, input.authority.humanActorId],
        );
        if (approverRows.length !== 1) throw new Error("additional_device_authorization_rejected");
        approverKey = bytes(approverRows[0]!, "signing_public_key").slice();
        const verified = verifyAdditionalDeviceApproval({
          crypto,
          enrollment: plan.enrollment,
          approvalBytes,
          manifest,
          domains: plan.inventory.domains.map(domainFanoutPlan),
          resolveActiveApprovingDevice: (human, device) =>
            human === input.authority.humanActorId
              && device === input.request.approverDeviceId
              ? Object.freeze({ state: "active" as const, signingPublicKey: approverKey! })
              : null,
        });
        const admission = createDeviceFanoutAdmission({
          crypto,
          approval: verified,
          now: Date.now(),
        });
        const result = await new PostgresDeviceFanoutAdmissionRepository(db)
          .admit(admission);
        if (result.status !== "admitted" && result.status !== "duplicate") {
          throw new Error(`additional_device_${result.status}`);
        }
        return Object.freeze({
          formatVersion: 1 as const,
          status: result.status,
          operationId: input.operationId,
          targetDeviceId: plan.enrollment.deviceId,
          completedDomains: 0,
          requiredDomains: plan.inventory.domains.length,
        });
      } finally {
        approverKey?.fill(0);
        approvalBytes.fill(0);
        destroyManifest(manifest);
        destroyLoadedPlan(plan);
      }
    },

    async publishJoinPackages(input) {
      const db = await handle();
      const plan = await loadCurrentPlan({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
      });
      const detached: Uint8Array[] = [];
      try {
        if (input.request.deviceId !== plan.enrollment.deviceId) {
          throw new Error("additional_device_join_substituted");
        }
        const admissionRows = await db.query(
          `SELECT count(*)::bigint AS domain_count
             FROM crypto_domain_transition_steps
            WHERE operation_id = $1`,
          [input.operationId],
        );
        if (
          admissionRows.length !== 1
          || number(admissionRows[0]!, "domain_count")
            !== plan.inventory.domains.length
        ) {
          throw new Error("additional_device_approval_required");
        }
        const heads = new Map(plan.inventory.domains.map((domain) => [
          domain.domainId,
          Object.freeze({
            providerId: domain.providerId,
            domainId: domain.domainId,
            epoch: domain.epoch,
            stateHash: domain.stateHash,
          }),
        ]));
        const verified = input.request.packages.map((value): ReturnType<
          typeof verifyDeviceJoinPackage
        > => {
          const packageHash = decode(value.packageHashBase64url);
          const headHash = decode(value.expectedProviderHeadHashBase64url);
          const keyPackageBytes = decode(value.keyPackageBytesBase64url);
          const signature = decode(value.signatureBase64url);
          detached.push(packageHash, headHash, keyPackageBytes, signature);
          const envelope: DeviceJoinPackageEnvelope = Object.freeze({
            formatVersion: 1,
            providerId: value.providerId,
            domainId: value.domainId,
            humanId: value.humanId,
            deviceId: value.deviceId,
            expectedEpoch: value.expectedEpoch,
            expectedProviderHeadHash: headHash,
            generation: value.generation,
            packageId: value.packageId,
            packageHash,
            keyPackageBytes,
            createdAt: value.createdAt,
            expiresAt: value.expiresAt,
            signature,
          });
          return verifyDeviceJoinPackage({
            crypto,
            envelope,
            now: Date.now(),
            resolveDevice: (deviceId) => deviceId === plan.enrollment.deviceId
              ? Object.freeze({
                humanId: input.authority.humanActorId,
                state: "pending" as const,
                generation: 1,
                signingPublicKey: plan.enrollment.signingPublicKey,
              })
              : null,
            resolveProviderHead: (domainId) => heads.get(domainId) ?? null,
          });
        });
        const result = await new PostgresDeviceJoinPackageRepository(db)
          .publish(verified);
        if (result.status !== "published" && result.status !== "duplicate") {
          throw new Error(`additional_device_${result.status}`);
        }
        return Object.freeze({ status: result.status });
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyLoadedPlan(plan);
      }
    },

    async publishJoinPackagesV2(input) {
      if (input.request.packages.length === 0) {
        const rows = await (await handle()).query(
          `SELECT operation_id FROM crypto_device_epoch_operations
            WHERE operation_id = $1 AND target_device_id = $2
            LIMIT 2`,
          [input.operationId, input.request.deviceId],
        );
        if (rows.length !== 1) {
          throw new Error("additional_device_approval_required");
        }
        return Object.freeze({ status: "duplicate" as const });
      }
      return composition.publishJoinPackages({
        authority: input.authority,
        operationId: input.operationId,
        request: {
          requestVersion: 1,
          deviceId: input.request.deviceId,
          packages: input.request.packages,
        },
      });
    },

    async transitionPlan(input) {
      const db = await handle();
      const plan = await loadCurrentPlan({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
        committerDeviceId: input.approverDeviceId,
      });
      try {
        assertAdditionalDeviceV1DomainCount(plan.inventory.domains.length);
        const repository = new PostgresDeviceJoinPackageRepository(db);
        const leases = new PostgresDomainTransitionLeaseRepository(db);
        const domains = [];
        for (const domain of plan.inventory.domains) {
          const claimedPackage = await repository.claimOrReplay({
            deviceId: plan.enrollment.deviceId,
            domainId: domain.domainId,
            generation: 1,
            operationId: input.operationId,
            now: Date.now(),
          });
          if (claimedPackage.status !== "claimed") {
            throw new Error("additional_device_join_package_unavailable");
          }
          const workerId = `client:${input.approverDeviceId}`;
          const claim = await leases.claimExact({
            operationId: input.operationId,
            domainId: domain.domainId,
            workerId,
            now: Date.now(),
          });
          if (claim === null) throw new Error("additional_device_transition_lease_unavailable");
          domains.push(Object.freeze({
            plan: plan.dto.domains.find((candidate) => candidate.domainId === domain.domainId)!,
            claim: Object.freeze({
              state: claim.state as "awaiting_committer" | "preparing",
              workerId: claim.workerId,
              retryCount: claim.retryCount,
              leaseExpiresAt: claim.leaseExpiresAt,
            }),
            joinPackageBytesBase64url: encode(claimedPackage.package.packageBytes),
          }));
        }
        return {
          formatVersion: 1 as const,
          operationId: input.operationId,
          targetDeviceId: plan.enrollment.deviceId,
          domains,
        };
      } finally {
        destroyLoadedPlan(plan);
      }
    },

    async transitionPlanV2(input) {
      const db = await handle();
      const plan = await loadCurrentPlan({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
        committerDeviceId: input.approverDeviceId,
      });
      try {
        const domainCount = plan.inventory.domains.length;
        if (
          !Number.isSafeInteger(input.pageStart)
          || input.pageStart < 0
          || input.pageStart > domainCount
        ) throw new Error("additional_device_page_unavailable");
        const end = Math.min(
          input.pageStart + PROTECTED_ADDITIONAL_DEVICE_DOMAIN_PAGE_SIZE,
          domainCount,
        );
        const pagePlan = planPageDto({
          crypto,
          plan,
          pageStart: input.pageStart,
        });
        const repository = new PostgresDeviceJoinPackageRepository(db);
        const domains = [];
        for (const domain of plan.inventory.domains.slice(input.pageStart, end)) {
          const claimedPackage = await repository.claimOrReplay({
            deviceId: plan.enrollment.deviceId,
            domainId: domain.domainId,
            generation: 1,
            operationId: input.operationId,
            now: Date.now(),
          });
          if (claimedPackage.status !== "claimed") {
            throw new Error("additional_device_join_package_unavailable");
          }
          domains.push(Object.freeze({
            plan: pagePlan.domains.find((candidate) =>
              candidate.domainId === domain.domainId
            )!,
            joinPackageBytesBase64url: encode(
              claimedPackage.package.packageBytes,
            ),
          }));
        }
        return Object.freeze({
          formatVersion: 2 as const,
          operationId: input.operationId,
          targetDeviceId: plan.enrollment.deviceId,
          domainCount,
          page: pagePlan.page,
          domains,
        });
      } finally {
        destroyLoadedPlan(plan);
      }
    },

    async submitTransitions(input) {
      const db = await handle();
      const plan = await loadCurrentPlan({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
        committerDeviceId: input.request.approverDeviceId,
      });
      const detached: Uint8Array[] = [];
      try {
        assertAdditionalDeviceV1DomainCount(plan.inventory.domains.length);
        if (input.request.transitions.length !== plan.inventory.domains.length) {
          throw new Error("additional_device_transition_inventory_incomplete");
        }
        const repository = new PostgresDomainTransitionSubmissionRepository(db, crypto);
        let completed = 0;
        for (const value of input.request.transitions) {
          const expected = plan.inventory.domains.find((domain) => domain.domainId === value.domainId);
          if (expected === undefined) throw new Error("additional_device_transition_substituted");
          const providerBytes = decode(value.providerSubmissionBytesBase64url);
          const namespaceBytes = decode(value.namespaceSubmissionBytesBase64url);
          detached.push(providerBytes, namespaceBytes);
          const result = await repository.submit({
            claim: Object.freeze({
              operationId: input.operationId,
              domainId: value.domainId,
              state: value.claim.state,
              workerId: value.claim.workerId,
              retryCount: value.claim.retryCount,
              leaseExpiresAt: value.claim.leaseExpiresAt,
            }),
            providerSubmission: decodeProviderTransitionSubmission(providerBytes),
            namespaceSubmission: decodeNamespaceTransitionSubmission(namespaceBytes),
            submittedAt: Date.now(),
          });
          if (result.status !== "submitted" && result.status !== "duplicate") {
            throw new Error(`additional_device_${result.status}`);
          }
          completed += 1;
        }
        return Object.freeze({
          formatVersion: 1 as const,
          status: "syncing" as const,
          operationId: input.operationId,
          targetDeviceId: plan.enrollment.deviceId,
          completedDomains: completed,
          requiredDomains: plan.inventory.domains.length,
        });
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyLoadedPlan(plan);
      }
    },

    async submitTransitionsV2(input) {
      const db = await handle();
      const enrollment = await loadPendingEnrollment({
        handle: db,
        crypto,
        authority: input.authority,
        operationId: input.operationId,
      });
      const detached: Uint8Array[] = [];
      try {
        if (
          input.request.inventoryRevision !== enrollment.inventoryRevision
          || input.request.inventoryCount !== enrollment.inventoryCount
          || input.request.inventoryDigestBase64url
            !== encode(enrollment.inventoryDigest)
        ) throw new Error("additional_device_transition_inventory_stale");
        const stepRows = await db.query(
          `SELECT step.domain_id, step.committer_device_id, step.state
             FROM crypto_domain_transition_steps step
             JOIN crypto_delivery_operations operation
               ON operation.operation_id = step.operation_id
            WHERE step.operation_id = $1
              AND operation.human_id = $2
              AND operation.target_device_id = $3
              AND operation.kind = 'device_add'
            ORDER BY step.domain_id`,
          [
            input.operationId,
            input.authority.humanActorId,
            enrollment.deviceId,
          ],
        );
        if (
          stepRows.length !== input.request.domainCount
          || input.request.transitions.some((value, index) =>
            value.domainId !== string(stepRows[index]!, "domain_id")
            || string(stepRows[index]!, "committer_device_id")
              !== input.request.approverDeviceId
          )
        ) throw new Error("additional_device_transition_inventory_incomplete");
        const approverRows = await db.query(
          `SELECT device_id FROM human_crypto_devices
            WHERE device_id = $1 AND human_id = $2 AND state = 'active'
            LIMIT 2`,
          [input.request.approverDeviceId, input.authority.humanActorId],
        );
        if (approverRows.length !== 1) {
          throw new Error("additional_device_authorization_rejected");
        }
        const repository = new PostgresDomainTransitionSubmissionRepository(
          db,
          crypto,
        );
        const leases = new PostgresDomainTransitionLeaseRepository(db);
        const workerId = `client:${input.request.approverDeviceId}`;
        for (const value of input.request.transitions) {
          const stepState = string(
            stepRows.find((row) => string(row, "domain_id") === value.domainId)!,
            "state",
          );
          const claim = stepState === "awaiting_committer"
            || stepState === "preparing"
            ? await leases.claimExact({
              operationId: input.operationId,
              domainId: value.domainId,
              workerId,
              now: Date.now(),
            })
            : Object.freeze({
              operationId: input.operationId,
              domainId: value.domainId,
              state: "awaiting_committer" as const,
              workerId,
              retryCount: 0,
              leaseExpiresAt: 0,
            });
          if (claim === null) {
            throw new Error("additional_device_transition_lease_unavailable");
          }
          const providerBytes = decode(
            value.providerSubmissionBytesBase64url,
          );
          const namespaceBytes = decode(
            value.namespaceSubmissionBytesBase64url,
          );
          detached.push(providerBytes, namespaceBytes);
          const result = await repository.submit({
            claim,
            providerSubmission: decodeProviderTransitionSubmission(
              providerBytes,
            ),
            namespaceSubmission: decodeNamespaceTransitionSubmission(
              namespaceBytes,
            ),
            submittedAt: Date.now(),
          });
          if (result.status !== "submitted" && result.status !== "duplicate") {
            throw new Error(`additional_device_${result.status}`);
          }
        }
        const completedRows = await db.query(
          `SELECT count(*)::bigint AS completed
             FROM crypto_domain_transition_steps
            WHERE operation_id = $1
              AND state IN ('awaiting_delivery', 'ready_to_activate', 'active')`,
          [input.operationId],
        );
        return Object.freeze({
          formatVersion: 1 as const,
          status: "syncing" as const,
          operationId: input.operationId,
          targetDeviceId: enrollment.deviceId,
          completedDomains: number(completedRows[0]!, "completed"),
          requiredDomains: stepRows.length,
        });
      } finally {
        detached.forEach((value) => value.fill(0));
        destroyPendingAdditionalDeviceEnrollment(enrollment);
      }
    },

    async deliveries(input) {
      if (input.request.humanId !== input.authority.humanActorId) {
        throw new Error("additional_device_authorization_rejected");
      }
      const signature = decode(input.request.signatureBase64url);
      try {
        const result = await new PostgresDeviceDeliveryFetchRepository(
          await handle(),
          crypto,
        ).fetch({
          proof: Object.freeze({
            formatVersion: 1,
            requestId: input.request.requestId,
            humanId: input.request.humanId,
            deviceId: input.request.deviceId,
            expectedDeviceRevision: input.request.expectedDeviceRevision,
            minimumHighWatermark: input.request.minimumHighWatermark,
            maximumMessages: input.request.maximumMessages,
            maximumPayloadBytes: input.request.maximumPayloadBytes,
            issuedAt: input.request.issuedAt,
            expiresAt: input.request.expiresAt,
            signature,
          }),
          now: Date.now(),
        });
        if (result.status !== "messages" && result.status !== "empty") {
          throw new Error(`additional_device_delivery_${result.status}`);
        }
        if (result.status === "messages" && result.messages.some((message) =>
          message.operationId !== input.operationId
          || (message.kind !== "device_transfer" && message.kind !== "public_state")
        )) throw new Error("additional_device_delivery_substituted");
        return {
          formatVersion: 1 as const,
          operationId: input.operationId,
          deviceId: input.request.deviceId,
          highWatermark: result.highWatermark,
          messages: result.status === "messages"
            ? result.messages.map((message) => ({
              messageId: message.messageId,
              operationId: message.operationId,
              domainId: message.domainId,
              recipientSequence: message.recipientSequence,
              kind: message.kind as "device_transfer" | "public_state",
              formatVersion: 1 as const,
              payloadHashBase64url: encode(message.payloadHash),
              payloadBytesBase64url: encode(message.payloadBytes),
              createdAt: message.createdAt,
              expiresAt: message.expiresAt,
            }))
            : [],
        };
      } finally {
        signature.fill(0);
      }
    },

    async acknowledge(input) {
      const db = await handle();
      const payloadHash = decode(input.request.payloadHashBase64url);
      const acknowledgementDigest = decode(input.request.acknowledgementDigestBase64url);
      const signature = decode(input.request.signatureBase64url);
      try {
        const rows = await db.query(
          `SELECT m.message_id, m.operation_id, m.recipient_device_id,
                  m.recipient_sequence, m.payload_hash,
                  d.human_id, d.state, d.revision, d.signing_public_key
             FROM crypto_delivery_messages m
             JOIN human_crypto_devices d ON d.device_id = m.recipient_device_id
            WHERE m.message_id = $1 AND m.operation_id = $2
              AND d.human_id = $3
            LIMIT 2`,
          [input.request.messageId, input.operationId, input.authority.humanActorId],
        );
        if (rows.length !== 1) throw new Error("additional_device_delivery_unavailable");
        const row = rows[0]!;
        const proof = Object.freeze({
          formatVersion: 2 as const,
          messageId: input.request.messageId,
          deviceId: input.request.deviceId,
          recipientSequence: input.request.recipientSequence,
          payloadHash,
          processedRevision: input.request.processedRevision,
          acknowledgedAt: input.request.acknowledgedAt,
          signature,
        });
        const verified = verifyDeliveryAcknowledgementProof({
          crypto,
          proof,
          message: Object.freeze({
            messageId: string(row, "message_id"),
            recipientDeviceId: string(row, "recipient_device_id"),
            recipientSequence: number(row, "recipient_sequence"),
            payloadHash: bytes(row, "payload_hash"),
          }),
          resolveDevice: (deviceId) => deviceId === input.request.deviceId
            ? Object.freeze({
              state: string(row, "state") as "pending" | "active",
              revision: number(row, "revision"),
              signingPublicKey: bytes(row, "signing_public_key"),
            })
            : null,
        });
        if (!equalBytes(verified.acknowledgementDigest, acknowledgementDigest)) {
          throw new Error("additional_device_acknowledgement_substituted");
        }
        const result = await new PostgresDeliveryAcknowledgementRepository(db)
          .acknowledge(verified, Date.now());
        if (result.status !== "acknowledged" && result.status !== "duplicate") {
          throw new Error(`additional_device_${result.status}`);
        }
        return Object.freeze({ status: result.status });
      } finally {
        payloadHash.fill(0);
        acknowledgementDigest.fill(0);
        signature.fill(0);
      }
    },

    async activate(input) {
      const db = await handle();
      const rows = await db.query(
        `SELECT target_device_id FROM crypto_delivery_operations
          WHERE operation_id = $1 AND human_id = $2 AND kind = 'device_add'
          LIMIT 2`,
        [input.operationId, input.authority.humanActorId],
      );
      if (rows.length !== 1 || string(rows[0]!, "target_device_id") !== input.deviceId) {
        throw new Error("additional_device_authorization_rejected");
      }
      const operationRef = Buffer.from(crypto.hash(
        encoder.encode(`nautilo/additional-device-operation/v1\0${input.operationId}`),
      )).toString("hex");
      const result = await new PostgresDeviceActivationRepository(db).activate({
        operationId: input.operationId,
        activatedAt: Date.now(),
        auditRef: `additional-device:${operationRef}`,
        outboxId: `additional-device-active:${operationRef}`,
      });
      if (result.status === "not_ready") {
        const current = await db.query(
          `SELECT d.revision AS device_revision, c.revision AS custody_revision
             FROM human_crypto_devices d
             JOIN human_crypto_custodies c ON c.human_id = d.human_id
            WHERE d.device_id = $1 AND d.human_id = $2
            LIMIT 2`,
          [input.deviceId, input.authority.humanActorId],
        );
        if (current.length !== 1) {
          throw new Error("additional_device_activation_unavailable");
        }
        return Object.freeze({
          formatVersion: 1 as const,
          status: "syncing" as const,
          syncReason: "delivery_pending" as const,
          operationId: input.operationId,
          deviceId: input.deviceId,
          deviceRevision: number(current[0]!, "device_revision"),
          custodyRevision: number(current[0]!, "custody_revision"),
        });
      }
      if (result.status === "stale_state") throw new Error("additional_device_stale_state");
      if (result.status !== "activated" && result.status !== "duplicate") {
        throw new Error("additional_device_activation_unavailable");
      }
      const admitted = await db.query(
        `SELECT expected_inventory_count
           FROM crypto_device_epoch_operations
          WHERE operation_id = $1 AND target_device_id = $2
          LIMIT 2`,
        [input.operationId, input.deviceId],
      );
      if (admitted.length !== 1) {
        throw new Error("additional_device_activation_unavailable");
      }
      const syncReason = number(admitted[0]!, "expected_inventory_count") === 0
        ? null
        : await currentEnrollmentSyncReason(db, input.deviceId);
      if (syncReason !== null) {
        return Object.freeze({
          formatVersion: 1 as const,
          status: "syncing" as const,
          syncReason,
          operationId: input.operationId,
          deviceId: result.deviceId,
          deviceRevision: result.deviceRevision,
          custodyRevision: result.custodyRevision,
        });
      }
      return Object.freeze({
        formatVersion: 1 as const,
        status: "active" as const,
        operationId: input.operationId,
        deviceId: result.deviceId,
        deviceRevision: result.deviceRevision,
        custodyRevision: result.custodyRevision,
      });
    },
  };
  return Object.freeze(composition);
}
