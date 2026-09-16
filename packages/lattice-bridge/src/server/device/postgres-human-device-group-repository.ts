import {
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  and,
  arrayContains,
  asc,
  count,
  cryptoDomains,
  domainKeyEnvelopeAcknowledgements,
  domainKeyHeads,
  domainKeyRecipientEnvelopes,
  cryptoDeliveryMessages,
  cryptoDeliveryOperations,
  desc,
  eq,
  gt,
  humanCryptoCustodies,
  humanCryptoDeviceChallenges,
  humanCryptoDeviceGroupAcknowledgements,
  humanCryptoDeviceGroupCommits,
  humanCryptoDeviceGroupHeads,
  humanCryptoDeviceGroupJoinRequests,
  humanCryptoDeviceGroupWelcomes,
  humanCryptoDeviceAdmissions,
  humanCryptoDevices,
  humanCryptoRecoveryKeys,
  inArray,
  isNull,
  lte,
  nautiloInstanceIdentity,
  ne,
  sql,
} from "@nautilo/db";
import {
  LatticeCrypto,
  cryptoDeviceId,
  decodeHumanDeviceGroupHead,
  decodeHumanDeviceGroupJoinRequest,
  decodeHumanDeviceGroupTransition,
  decodeHumanDeviceRoster,
  deriveHumanDeviceGroupId,
  encodeHumanDeviceGroupHead,
  encodeHumanDeviceGroupJoinRequest,
  encodeHumanDeviceGroupTransition,
  humanDeviceGroupHeadDigest,
  humanId,
  unixTimestamp,
  verifyRecoveryDevicePossessionProof,
  type HumanDeviceGroupHead,
  type HumanDeviceGroupTransition,
} from "@nautilo/lattice-crypto";
import {
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";

import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  type CryptoPostgresHandle,
  type CryptoPostgresTransaction,
} from "../storage/postgres-lattice-storage.ts";

const COMMIT_PAGE_SIZE =
  CRYPTO_DELIVERY_COLLECTION_LIMITS.humanDeviceGroupCommitPage;

async function lockHumanDeviceGroupTransaction(
  transaction: CryptoPostgresTransaction,
  humanId: string,
): Promise<void> {
  // Transaction isolation and advisory locking are PostgreSQL session/control
  // primitives rather than table-shaped queries that Drizzle can express.
  await transaction.query("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
  await transaction.query(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`human-device-group/${humanId}`],
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function milliseconds(value: unknown): number {
  const decoded = value instanceof Date
    ? value.getTime()
    : typeof value === "string"
    ? Date.parse(value)
    : Number.NaN;
  if (!Number.isSafeInteger(decoded) || decoded < 0) {
    throw new Error("human_device_invalid_timestamp");
  }
  return decoded;
}

function counter(value: unknown, label: string): number {
  const decoded = typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
    ? Number(value)
    : value;
  if (typeof decoded !== "number" || !Number.isSafeInteger(decoded)
    || decoded < 0) {
    throw new Error(`human_device_invalid_counter:${label}`);
  }
  return decoded;
}

function optionalCounter(value: unknown, label: string): number | null {
  return value === null || value === undefined ? null : counter(value, label);
}

export type HumanDeviceMembershipState =
  | "absent"
  | "unbound"
  | "pending"
  | "welcome_pending"
  | "catching_up"
  | "current"
  | "stale"
  | "removed";

export interface HumanDeviceGroupStatus {
  readonly serverInstanceId: string;
  readonly humanId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly deviceRevision: number;
  readonly membershipState: HumanDeviceMembershipState;
  readonly head: Readonly<{
    headBytes: Uint8Array;
    sequence: number;
  }> | null;
  readonly welcome: Readonly<{
    operationId: string;
    sequence: number;
    transitionBytes: Uint8Array;
    welcomeBytes: Uint8Array;
  }> | null;
  readonly commits: readonly Readonly<{
    sequence: number;
    transitionBytes: Uint8Array;
  }>[];
  readonly nextSequence: number | null;
}

export interface TargetHumanDeviceJoin {
  readonly operationId: string;
  readonly requestBytes: Uint8Array;
}

export interface PendingHumanDeviceJoin {
  readonly operationId: string;
  readonly targetDeviceId: string;
  readonly targetClientKind: "browser" | "electron";
  readonly targetDeviceGeneration: number;
  readonly targetSigningPublicKey: Uint8Array;
  readonly requestBytes: Uint8Array;
  readonly createdAt: number;
}

export interface HumanDeviceRosterStatus {
  readonly currentDeviceId: string;
  readonly currentMemberCount: number;
  readonly devices: readonly Readonly<{
    deviceId: string;
    clientKind: "browser" | "electron" | "tui";
    deviceGeneration: number;
    deviceRevision: number;
    membershipState: Exclude<HumanDeviceMembershipState, "absent" | "unbound">;
    isCurrentDevice: boolean;
    canRemove: boolean;
    publicFingerprintBase64url: string;
    membershipEvidence: Readonly<{
      lineageGeneration: number;
      epoch: number;
      securityRevision: number;
      acknowledgedSequence: number;
      headDigestBase64url: string;
    }> | null;
    admissionEvidence: Readonly<{
      lastProvedAt: number;
      expiresAt: number;
    }> | null;
    domainKeyCoverage: Readonly<{
      acknowledged: number;
      required: number;
    }>;
    deliveryEvidence: Readonly<{
      acknowledgedSequence: number;
      highWatermark: number;
      blocked: Readonly<{
        sequence: number;
        operationId: string;
        at: number;
        reason: string;
      }> | null;
    }>;
    createdAt: number;
    lastSeenAt: number | null;
    revokedAt: number | null;
  }>[];
}

function base64url(value: Uint8Array): string {
  return Buffer.from(value).toString("base64url");
}

/**
 * Durable public/opaque ordering for one Human's MLS device group. The server
 * validates exact coordinates and CAS order but never receives usable provider
 * state or an MLS exporter secret.
 */
export class PostgresHumanDeviceGroupRepository {
  constructor(
    private readonly handle: CryptoPostgresHandle,
    private readonly crypto = new LatticeCrypto(),
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  async targetJoin(input: Readonly<{
    userId: string;
    humanId: string;
    deviceId: string;
  }>): Promise<TargetHumanDeviceJoin | null> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        operationId: humanCryptoDeviceGroupJoinRequests.operationId,
        requestBytes: humanCryptoDeviceGroupJoinRequests.requestBytes,
        userId: humanCryptoDevices.userId,
      }).from(humanCryptoDeviceGroupJoinRequests).innerJoin(
        humanCryptoDevices,
        eq(
          humanCryptoDevices.deviceId,
          humanCryptoDeviceGroupJoinRequests.targetDeviceId,
        ),
      ).where(and(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, input.humanId),
        eq(humanCryptoDeviceGroupJoinRequests.targetDeviceId, input.deviceId),
        inArray(humanCryptoDeviceGroupJoinRequests.state, ["pending", "consumed"]),
      )).orderBy(asc(humanCryptoDeviceGroupJoinRequests.createdAt)),
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1 || rows[0]!.user_id !== input.userId) {
      throw new Error("human_device_target_join_conflict");
    }
    return Object.freeze({
      operationId: rows[0]!.operation_id,
      requestBytes: rows[0]!.request_bytes.slice(),
    });
  }

  async status(input: Readonly<{
    userId: string;
    humanId: string;
    deviceId: string;
    afterSequence?: number;
  }>): Promise<HumanDeviceGroupStatus> {
    const afterSequence = input.afterSequence ?? -1;
    if (!Number.isSafeInteger(afterSequence) || afterSequence < -1) {
      throw new RangeError("Human-device commit cursor is invalid");
    }
    const identities = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      }).from(nautiloInstanceIdentity).where(
        eq(nautiloInstanceIdentity.id, "self"),
      ),
    );
    if (identities.length !== 1) {
      throw new Error("human_device_server_identity_unavailable");
    }
    const devices = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        deviceId: humanCryptoDevices.deviceId,
        humanId: humanCryptoDevices.humanId,
        userId: humanCryptoDevices.userId,
        deviceGeneration: humanCryptoDevices.deviceGeneration,
        deviceRevision: humanCryptoDevices.revision,
        state: humanCryptoDevices.state,
        membershipState: humanCryptoDevices.membershipState,
        acknowledgedSequence:
          humanCryptoDevices.membershipAcknowledgedSequence,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, input.deviceId),
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.userId, input.userId),
      )),
    );
    if (devices.length > 1 || devices[0]?.state === "rejected") {
      throw new Error("human_device_membership_unauthorized");
    }
    const device = devices[0] ?? null;
    const heads = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        headBytes: humanCryptoDeviceGroupHeads.headBytes,
        commitSequence: humanCryptoDeviceGroupHeads.commitSequence,
        lineageGeneration:
          humanCryptoDeviceGroupHeads.lineageGeneration,
      }).from(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
      ),
    );
    const head = heads[0] ?? null;
    const welcomeRows = device?.membership_state === "welcome_pending"
      ? await executeTypedCryptoQuery(
        this.handle,
        cryptoTypedDb.select({
          operationId: humanCryptoDeviceGroupWelcomes.operationId,
          sequence: humanCryptoDeviceGroupWelcomes.sequence,
          welcomeBytes: humanCryptoDeviceGroupWelcomes.welcomeBytes,
          transitionBytes: humanCryptoDeviceGroupCommits.publicTransitionBytes,
        }).from(humanCryptoDeviceGroupWelcomes).innerJoin(
          humanCryptoDeviceGroupCommits,
          eq(
            humanCryptoDeviceGroupCommits.operationId,
            humanCryptoDeviceGroupWelcomes.operationId,
          ),
        ).where(and(
          eq(humanCryptoDeviceGroupWelcomes.targetDeviceId, input.deviceId),
          inArray(humanCryptoDeviceGroupWelcomes.state, ["pending", "delivered"]),
        )),
      )
      : [];
    if (welcomeRows.length > 1) {
      throw new Error("human_device_welcome_conflict");
    }
    if (welcomeRows[0] !== undefined) {
      await executeTypedCryptoQuery(
        this.handle,
        cryptoTypedDb.update(humanCryptoDeviceGroupWelcomes).set({
          state: "delivered",
          deliveredAt: sql`coalesce(
            ${humanCryptoDeviceGroupWelcomes.deliveredAt},
            greatest(${humanCryptoDeviceGroupWelcomes.createdAt}, now())
          )`,
        }).where(and(
          eq(
            humanCryptoDeviceGroupWelcomes.operationId,
            welcomeRows[0].operation_id,
          ),
          eq(humanCryptoDeviceGroupWelcomes.targetDeviceId, input.deviceId),
          eq(humanCryptoDeviceGroupWelcomes.state, "pending"),
        )),
      );
    }
    const acknowledgedSequence = optionalCounter(
      device?.membership_acknowledged_sequence,
      "device_acknowledged_sequence",
    );
    const headSequence = head === null
      ? null
      : counter(head.commit_sequence, "head_commit_sequence");
    const headLineage = head === null
      ? null
      : counter(head.lineage_generation, "head_lineage_generation");
    const cursor = Math.max(
      afterSequence,
      acknowledgedSequence ?? 0,
    );
    const commitRows = head === null || device === null
      || device.membership_state === "pending"
      || device.membership_state === "welcome_pending"
      || device.state === "revoked"
      || cursor >= headSequence!
      ? []
      : await executeTypedCryptoQuery(
        this.handle,
        cryptoTypedDb.select({
          sequence: humanCryptoDeviceGroupCommits.sequence,
          transitionBytes:
            humanCryptoDeviceGroupCommits.publicTransitionBytes,
        }).from(humanCryptoDeviceGroupCommits).where(and(
          eq(humanCryptoDeviceGroupCommits.humanId, input.humanId),
          eq(
            humanCryptoDeviceGroupCommits.lineageGeneration,
            headLineage!,
          ),
          gt(humanCryptoDeviceGroupCommits.sequence, cursor),
        )).orderBy(asc(humanCryptoDeviceGroupCommits.sequence))
          .limit(COMMIT_PAGE_SIZE),
      );
    const last = commitRows.at(-1) === undefined
      ? cursor
      : counter(commitRows.at(-1)!.sequence, "commit_sequence");
    return Object.freeze({
      serverInstanceId: identities[0]!.server_instance_id,
      humanId: input.humanId,
      deviceId: input.deviceId,
      deviceGeneration: device === null
        ? 1
        : counter(device.device_generation, "device_generation"),
      deviceRevision: device === null
        ? 0
        : counter(device.revision, "device_revision"),
      membershipState: device === null
        ? "absent"
        : device.state === "revoked"
        ? "removed"
        : device.membership_state as HumanDeviceMembershipState,
      head: head === null ? null : Object.freeze({
        headBytes: head.head_bytes.slice(),
        sequence: headSequence!,
      }),
      welcome: welcomeRows[0] === undefined ? null : Object.freeze({
        operationId: welcomeRows[0].operation_id,
        sequence: counter(welcomeRows[0].sequence, "welcome_sequence"),
        transitionBytes: welcomeRows[0].public_transition_bytes.slice(),
        welcomeBytes: welcomeRows[0].welcome_bytes.slice(),
      }),
      commits: Object.freeze(commitRows.map((row) => Object.freeze({
        sequence: counter(row.sequence, "commit_sequence"),
        transitionBytes: row.public_transition_bytes.slice(),
      }))),
      nextSequence: headSequence !== null && last < headSequence ? last : null,
    });
  }

  async roster(input: Readonly<{
    userId: string;
    humanId: string;
    currentDeviceId: string;
  }>): Promise<HumanDeviceRosterStatus> {
    const heads = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        rosterBytes: humanCryptoDeviceGroupHeads.rosterBytes,
        headDigest: humanCryptoDeviceGroupHeads.headDigest,
      }).from(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
      ),
    );
    if (heads.length !== 1) throw new Error("human_device_group_unavailable");
    const caller = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        userId: humanCryptoDevices.userId,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, input.currentDeviceId),
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.membershipState, "current"),
        eq(humanCryptoDevices.membershipHeadDigest, heads[0]!.head_digest),
      )),
    );
    if (caller.length !== 1 || caller[0]!.user_id !== input.userId) {
      throw new Error("human_device_roster_unauthorized");
    }
    const roster = decodeHumanDeviceRoster(heads[0]!.roster_bytes);
    const currentIds = new Set<string>(roster.map((entry) => entry.deviceId));
    const selectDeviceHealth = {
      deviceId: humanCryptoDevices.deviceId,
      clientKind: humanCryptoDevices.clientKind,
      deviceGeneration: humanCryptoDevices.deviceGeneration,
      deviceRevision: humanCryptoDevices.revision,
      state: humanCryptoDevices.state,
      membershipState: humanCryptoDevices.membershipState,
      publicFingerprint: humanCryptoDevices.publicFingerprint,
      membershipLineageGeneration:
        humanCryptoDevices.membershipLineageGeneration,
      membershipEpoch: humanCryptoDevices.membershipEpoch,
      membershipSecurityRevision:
        humanCryptoDevices.membershipSecurityRevision,
      membershipAcknowledgedSequence:
        humanCryptoDevices.membershipAcknowledgedSequence,
      membershipHeadDigest: humanCryptoDevices.membershipHeadDigest,
      deliveryAcknowledgedSequence:
        humanCryptoDevices.deliveryAcknowledgedSequence,
      deliverySequenceHighWatermark:
        humanCryptoDevices.deliverySequenceHighWatermark,
      deliveryBlockedSequence: humanCryptoDevices.deliveryBlockedSequence,
      deliveryBlockedOperationId:
        humanCryptoDevices.deliveryBlockedOperationId,
      deliveryBlockedAt: humanCryptoDevices.deliveryBlockedAt,
      deliveryBlockedReason: humanCryptoDevices.deliveryBlockedReason,
      createdAt: humanCryptoDevices.createdAt,
      lastSeenAt: humanCryptoDevices.lastSeenAt,
      revokedAt: humanCryptoDevices.revokedAt,
    } as const;
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select(selectDeviceHealth).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.userId, input.userId),
      )).orderBy(asc(humanCryptoDevices.createdAt)),
    );
    const admissionRows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.selectDistinctOn(
        [humanCryptoDeviceAdmissions.deviceId],
        {
          device_id: humanCryptoDeviceAdmissions.deviceId,
          admitted_at: humanCryptoDeviceAdmissions.admittedAt,
          expires_at: humanCryptoDeviceAdmissions.expiresAt,
        },
      ).from(humanCryptoDeviceAdmissions).innerJoin(
        humanCryptoDevices,
        and(
          eq(
            humanCryptoDevices.deviceId,
            humanCryptoDeviceAdmissions.deviceId,
          ),
          eq(
            humanCryptoDevices.deviceGeneration,
            humanCryptoDeviceAdmissions.deviceGeneration,
          ),
          eq(
            humanCryptoDevices.membershipServerInstanceId,
            humanCryptoDeviceAdmissions.serverInstanceId,
          ),
          eq(
            humanCryptoDevices.membershipLineageGeneration,
            humanCryptoDeviceAdmissions.lineageGeneration,
          ),
          eq(
            humanCryptoDevices.membershipEpoch,
            humanCryptoDeviceAdmissions.epoch,
          ),
          eq(
            humanCryptoDevices.membershipSecurityRevision,
            humanCryptoDeviceAdmissions.securityRevision,
          ),
          eq(
            humanCryptoDevices.membershipHeadDigest,
            humanCryptoDeviceAdmissions.headDigest,
          ),
        ),
      ).where(and(
        eq(humanCryptoDeviceAdmissions.userId, input.userId),
        eq(humanCryptoDeviceAdmissions.humanActorId, input.humanId),
        gt(humanCryptoDeviceAdmissions.expiresAt, new Date()),
      )).orderBy(
        humanCryptoDeviceAdmissions.deviceId,
        desc(humanCryptoDeviceAdmissions.admittedAt),
      ),
    );
    const admissionByDevice = new Map(admissionRows.map((row) => [
      row.device_id,
      Object.freeze({
        lastProvedAt: milliseconds(row.admitted_at),
        expiresAt: milliseconds(row.expires_at),
      }),
    ]));
    const requiredCoverageRows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        required: count().as("required"),
      }).from(domainKeyHeads).innerJoin(
        cryptoDomains,
        eq(cryptoDomains.id, domainKeyHeads.domainId),
      ).where(arrayContains(cryptoDomains.participants, [input.humanId])),
    );
    const requiredCoverage = counter(
      requiredCoverageRows[0]?.required ?? 0,
      "required_domain_key_coverage",
    );
    const coveredRows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        deviceId: domainKeyRecipientEnvelopes.recipientKeyId,
        deviceGeneration: domainKeyRecipientEnvelopes.recipientKeyGeneration,
        acknowledged: sql<number>`count(distinct (${domainKeyHeads.domainId}, ${domainKeyHeads.keyClass}))::int`
          .as("acknowledged"),
      }).from(domainKeyRecipientEnvelopes).innerJoin(
        domainKeyHeads,
        and(
          eq(domainKeyHeads.domainId, domainKeyRecipientEnvelopes.domainId),
          eq(domainKeyHeads.keyClass, domainKeyRecipientEnvelopes.keyClass),
          eq(
            domainKeyHeads.domainKeyGeneration,
            domainKeyRecipientEnvelopes.domainKeyGeneration,
          ),
          eq(
            domainKeyHeads.authorizationRevision,
            domainKeyRecipientEnvelopes.authorizationRevision,
          ),
          eq(domainKeyHeads.headDigest, domainKeyRecipientEnvelopes.headDigest),
        ),
      ).innerJoin(
        cryptoDomains,
        eq(cryptoDomains.id, domainKeyHeads.domainId),
      ).innerJoin(
        domainKeyEnvelopeAcknowledgements,
        and(
          eq(
            domainKeyEnvelopeAcknowledgements.envelopeDigest,
            domainKeyRecipientEnvelopes.envelopeDigest,
          ),
          eq(
            domainKeyEnvelopeAcknowledgements.recipientDeviceId,
            domainKeyRecipientEnvelopes.recipientKeyId,
          ),
        ),
      ).where(and(
        eq(domainKeyRecipientEnvelopes.recipientHumanId, input.humanId),
        eq(domainKeyRecipientEnvelopes.recipientKind, "device"),
        inArray(
          domainKeyRecipientEnvelopes.recipientKeyId,
          rows.map((row) => row.device_id),
        ),
        arrayContains(cryptoDomains.participants, [input.humanId]),
      )).groupBy(
        domainKeyRecipientEnvelopes.recipientKeyId,
        domainKeyRecipientEnvelopes.recipientKeyGeneration,
      ),
    );
    const coveredByDevice = new Map(coveredRows.map((row) => [
      `${row.recipient_key_id}:${counter(row.recipient_key_generation, "coverage_device_generation")}`,
      counter(row.acknowledged, "acknowledged_domain_key_coverage"),
    ]));
    const currentMemberCount = roster.length;
    return Object.freeze({
      currentDeviceId: input.currentDeviceId,
      currentMemberCount,
      devices: Object.freeze(rows.filter((row) =>
        currentIds.has(row.device_id) || row.state === "revoked"
      ).map((row) => {
        const state = row.state === "revoked"
          ? "removed" as const
          : row.membership_state as Exclude<
              HumanDeviceMembershipState,
              "absent" | "unbound"
            >;
        const generation = counter(row.device_generation, "device_generation");
        const membershipEvidence = row.membership_lineage_generation === null
            || row.membership_epoch === null
            || row.membership_security_revision === null
            || row.membership_acknowledged_sequence === null
            || row.membership_head_digest === null
          ? null
          : Object.freeze({
              lineageGeneration: counter(
                row.membership_lineage_generation,
                "membership_lineage_generation",
              ),
              epoch: counter(row.membership_epoch, "membership_epoch"),
              securityRevision: counter(
                row.membership_security_revision,
                "membership_security_revision",
              ),
              acknowledgedSequence: counter(
                row.membership_acknowledged_sequence,
                "membership_acknowledged_sequence",
              ),
              headDigestBase64url: base64url(row.membership_head_digest),
            });
        const blocked = row.delivery_blocked_sequence === null
            || row.delivery_blocked_operation_id === null
            || row.delivery_blocked_at === null
            || row.delivery_blocked_reason === null
          ? null
          : Object.freeze({
              sequence: counter(
                row.delivery_blocked_sequence,
                "delivery_blocked_sequence",
              ),
              operationId: row.delivery_blocked_operation_id,
              at: milliseconds(row.delivery_blocked_at),
              reason: row.delivery_blocked_reason,
            });
        return Object.freeze({
          deviceId: row.device_id,
          clientKind: row.client_kind as "browser" | "electron" | "tui",
          deviceGeneration: generation,
          deviceRevision: counter(row.revision, "device_revision"),
          membershipState: state,
          isCurrentDevice: row.device_id === input.currentDeviceId,
          canRemove: currentMemberCount > 1
            && currentIds.has(row.device_id)
            && row.device_id !== input.currentDeviceId,
          publicFingerprintBase64url: base64url(row.public_fingerprint),
          membershipEvidence,
          admissionEvidence: admissionByDevice.get(row.device_id) ?? null,
          domainKeyCoverage: Object.freeze({
            acknowledged: coveredByDevice.get(
              `${row.device_id}:${generation}`,
            ) ?? 0,
            required: requiredCoverage,
          }),
          deliveryEvidence: Object.freeze({
            acknowledgedSequence: counter(
              row.delivery_acknowledged_sequence,
              "delivery_acknowledged_sequence",
            ),
            highWatermark: counter(
              row.delivery_sequence_high_watermark,
              "delivery_sequence_high_watermark",
            ),
            blocked,
          }),
          createdAt: milliseconds(row.created_at),
          lastSeenAt: row.last_seen_at === null
            ? null
            : milliseconds(row.last_seen_at),
          revokedAt: row.revoked_at === null
            ? null
            : milliseconds(row.revoked_at),
        });
      })),
    });
  }

  establishInitial(input: Readonly<{
    userId: string;
    humanId: string;
    deviceId: string;
    headBytes: Uint8Array;
    rosterBytes: Uint8Array;
    now: number;
  }>): Promise<"created" | "duplicate"> {
    const head = decodeHumanDeviceGroupHead(input.headBytes);
    const roster = decodeHumanDeviceRoster(input.rosterBytes);
    const canonicalHead = encodeHumanDeviceGroupHead(head);
    const headDigest = humanDeviceGroupHeadDigest(this.crypto, head);
    if (!sameBytes(canonicalHead, input.headBytes)
      || !sameBytes(this.crypto.hash(input.rosterBytes), head.rosterDigest)
      || head.humanId !== input.humanId
      || head.groupId !== deriveHumanDeviceGroupId(this.crypto, {
        serverInstanceId: head.serverInstanceId,
        humanId: head.humanId,
        lineageGeneration: head.lineageGeneration,
      })
      || head.lineageGeneration !== 1
      || head.epoch !== 0
      || head.securityRevision !== 1
      || head.previousHeadDigest !== null
      || roster.length !== 1
      || roster[0]!.humanId !== input.humanId
      || roster[0]!.deviceId !== input.deviceId) {
      throw new Error("human_device_initial_group_invalid");
    }
    return this.handle.transaction((transaction) => this.withInitialLock(
      transaction,
      input,
      head,
      headDigest,
      roster[0]!.leafIndex,
      roster[0]!.deviceKeyGeneration,
      roster[0]!.installationLineageDigest,
    ));
  }

  private async withInitialLock(
    transaction: CryptoPostgresTransaction,
    input: Readonly<{
      userId: string;
      humanId: string;
      deviceId: string;
      headBytes: Uint8Array;
      rosterBytes: Uint8Array;
      now: number;
    }>,
    head: HumanDeviceGroupHead,
    headDigest: Uint8Array,
    leafIndex: number,
    deviceKeyGeneration: number,
    installationLineageDigest: Uint8Array,
  ): Promise<"created" | "duplicate"> {
    await lockHumanDeviceGroupTransaction(transaction, input.humanId);
    const identities = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      }).from(nautiloInstanceIdentity).where(
        eq(nautiloInstanceIdentity.id, "self"),
      ),
    );
    if (identities.length !== 1
      || identities[0]!.server_instance_id !== head.serverInstanceId) {
      throw new Error("human_device_server_identity_mismatch");
    }
    const existing = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        headDigest: humanCryptoDeviceGroupHeads.headDigest,
      }).from(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
      ),
    );
    if (existing.length === 1) {
      if (!sameBytes(existing[0]!.head_digest, headDigest)) {
        throw new Error("human_device_group_already_exists");
      }
      return "duplicate";
    }
    const devices = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        generation: humanCryptoDevices.deviceGeneration,
        installationLineageDigest:
          humanCryptoDevices.installationLineageDigest,
        state: humanCryptoDevices.state,
        membershipState: humanCryptoDevices.membershipState,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, input.deviceId),
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.userId, input.userId),
      )),
    );
    const deviceGeneration = devices.length === 1
      ? counter(devices[0]!.device_generation, "device_generation")
      : null;
    if (devices.length !== 1 || devices[0]!.state !== "active"
      || devices[0]!.membership_state !== "unbound"
      || deviceGeneration !== deviceKeyGeneration
      || !sameBytes(
        devices[0]!.installation_lineage_digest,
        installationLineageDigest,
      )) {
      throw new Error("human_device_initial_authority_unavailable");
    }
    const now = new Date(input.now);
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(humanCryptoDeviceGroupHeads).values({
        humanId: input.humanId,
        serverInstanceId: head.serverInstanceId,
        lineageGeneration: head.lineageGeneration,
        providerId: head.providerId,
        groupId: head.groupId,
        epoch: head.epoch,
        stateHash: head.stateHash,
        rosterDigest: head.rosterDigest,
        rosterBytes: input.rosterBytes,
        previousHeadDigest: null,
        headDigest,
        headBytes: input.headBytes,
        securityRevision: head.securityRevision,
        commitSequence: 0,
        committingDeviceId: input.deviceId,
        committingDeviceGeneration: deviceGeneration,
        createdAt: now,
        updatedAt: now,
      }),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(humanCryptoDeviceGroupAcknowledgements).values({
        humanId: input.humanId,
        lineageGeneration: head.lineageGeneration,
        deviceId: input.deviceId,
        deviceGeneration,
        acknowledgedSequence: 0,
        acknowledgedHeadDigest: headDigest,
        acknowledgedAt: now,
        revision: 1,
      }),
    );
    const updated = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        membershipState: "current",
        membershipServerInstanceId: head.serverInstanceId,
        membershipLineageGeneration: head.lineageGeneration,
        membershipEpoch: head.epoch,
        membershipSecurityRevision: head.securityRevision,
        membershipLeafIndex: leafIndex,
        membershipHeadDigest: headDigest,
        membershipAcknowledgedSequence: 0,
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.deviceId, input.deviceId),
        eq(humanCryptoDevices.membershipState, "unbound"),
      )).returning({ deviceId: humanCryptoDevices.deviceId }),
    );
    if (updated.length !== 1) throw new Error("human_device_projection_cas");
    return "created";
  }

  async rebootstrapWithRecovery(input: Readonly<{
    userId: string;
    humanId: string;
    operationId: string;
    deviceId: string;
    challengeHash: Uint8Array;
    response: Uint8Array;
    headBytes: Uint8Array;
    rosterBytes: Uint8Array;
    now: number;
  }>): Promise<"created" | "duplicate"> {
    const nextHead = decodeHumanDeviceGroupHead(input.headBytes);
    const roster = decodeHumanDeviceRoster(input.rosterBytes);
    const nextDigest = humanDeviceGroupHeadDigest(this.crypto, nextHead);
    if (!sameBytes(encodeHumanDeviceGroupHead(nextHead), input.headBytes)
      || !sameBytes(this.crypto.hash(input.rosterBytes), nextHead.rosterDigest)
      || nextHead.humanId !== input.humanId
      || nextHead.groupId !== deriveHumanDeviceGroupId(this.crypto, {
        serverInstanceId: nextHead.serverInstanceId,
        humanId: nextHead.humanId,
        lineageGeneration: nextHead.lineageGeneration,
      })
      || nextHead.epoch !== 0
      || nextHead.securityRevision !== 1
      || nextHead.previousHeadDigest !== null
      || roster.length !== 1
      || roster[0]!.humanId !== input.humanId
      || roster[0]!.deviceId !== input.deviceId) {
      throw new Error("human_device_recovery_head_invalid");
    }
    return this.handle.transaction(async (transaction) => {
      await lockHumanDeviceGroupTransaction(transaction, input.humanId);
      const identities = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
        }).from(nautiloInstanceIdentity).where(
          eq(nautiloInstanceIdentity.id, "self"),
        ),
      );
      const heads = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          lineageGeneration: humanCryptoDeviceGroupHeads.lineageGeneration,
          headDigest: humanCryptoDeviceGroupHeads.headDigest,
        }).from(humanCryptoDeviceGroupHeads).where(
          eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
        ),
      );
      const challenges = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          challengeId: humanCryptoDeviceChallenges.challengeId,
          challengeHash: humanCryptoDeviceChallenges.challengeHash,
          expectedResponseDigest:
            humanCryptoDeviceChallenges.expectedResponseDigest,
          expiresAt: humanCryptoDeviceChallenges.expiresAt,
          consumedAt: humanCryptoDeviceChallenges.consumedAt,
          invalidatedAt: humanCryptoDeviceChallenges.invalidatedAt,
          terminalResultCode:
            humanCryptoDeviceChallenges.terminalResultCode,
          state: cryptoDeliveryOperations.state,
          challengeBytes: cryptoDeliveryMessages.payloadBytes,
        }).from(humanCryptoDeviceChallenges).innerJoin(
          cryptoDeliveryOperations,
          and(
            eq(
              cryptoDeliveryOperations.idempotencyKey,
              humanCryptoDeviceChallenges.idempotencyKey,
            ),
            eq(
              cryptoDeliveryOperations.targetDeviceId,
              humanCryptoDeviceChallenges.pendingDeviceId,
            ),
          ),
        ).innerJoin(
          cryptoDeliveryMessages,
          and(
            eq(
              cryptoDeliveryMessages.operationId,
              cryptoDeliveryOperations.operationId,
            ),
            eq(cryptoDeliveryMessages.kind, "recovery_challenge"),
          ),
        ).where(and(
          eq(cryptoDeliveryOperations.operationId, input.operationId),
          eq(cryptoDeliveryOperations.kind, "device_recovery"),
          eq(humanCryptoDeviceChallenges.kind, "device_recovery"),
          eq(humanCryptoDeviceChallenges.humanId, input.humanId),
          eq(humanCryptoDeviceChallenges.pendingDeviceId, input.deviceId),
        )),
      );
      const devices = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          humanId: humanCryptoDevices.humanId,
          userId: humanCryptoDevices.userId,
          state: humanCryptoDevices.state,
          membershipState: humanCryptoDevices.membershipState,
          deviceGeneration: humanCryptoDevices.deviceGeneration,
          revision: humanCryptoDevices.revision,
          installationLineageDigest:
            humanCryptoDevices.installationLineageDigest,
          signingPublicKey: humanCryptoDevices.signingPublicKey,
          encryptionPublicKey: humanCryptoDevices.encryptionPublicKey,
          recoveryGeneration: humanCryptoDevices.recoveryGeneration,
          membershipLineageGeneration:
            humanCryptoDevices.membershipLineageGeneration,
          membershipHeadDigest: humanCryptoDevices.membershipHeadDigest,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          eq(humanCryptoDevices.humanId, input.humanId),
        )),
      );
      const recovery = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          currentRecoveryGeneration:
            humanCryptoCustodies.currentRecoveryGeneration,
          currentRecoveryPublicKeyDigest:
            humanCryptoCustodies.currentRecoveryPublicKeyDigest,
          recoveryKeyId: humanCryptoRecoveryKeys.recoveryKeyId,
          publicKeyDigest: humanCryptoRecoveryKeys.publicKeyDigest,
        }).from(humanCryptoCustodies).innerJoin(
          humanCryptoRecoveryKeys,
          and(
            eq(
              humanCryptoRecoveryKeys.humanId,
              humanCryptoCustodies.humanId,
            ),
            eq(
              humanCryptoRecoveryKeys.generation,
              humanCryptoCustodies.currentRecoveryGeneration,
            ),
            eq(humanCryptoRecoveryKeys.state, "current"),
          ),
        ).where(and(
          eq(humanCryptoCustodies.humanId, input.humanId),
          eq(humanCryptoCustodies.userId, input.userId),
        )),
      );
      if (identities.length !== 1 || heads.length !== 1
        || challenges.length !== 1 || devices.length !== 1
        || recovery.length !== 1) {
        throw new Error("human_device_recovery_unavailable");
      }
      const identity = identities[0]!;
      const oldHead = heads[0]!;
      const challenge = challenges[0]!;
      const device = devices[0]!;
      const currentRecovery = recovery[0]!;
      if (sameBytes(oldHead.head_digest, nextDigest)
        && counter(oldHead.lineage_generation, "current_lineage")
          === nextHead.lineageGeneration
        && device.state === "active"
        && device.membership_state === "current"
        && device.membership_lineage_generation !== null
        && counter(
          device.membership_lineage_generation,
          "device_membership_lineage",
        ) === nextHead.lineageGeneration
        && device.membership_head_digest !== null
        && sameBytes(device.membership_head_digest, nextDigest)
        && challenge.consumed_at !== null
        && challenge.invalidated_at === null
        && challenge.terminal_result_code === "active"
        && challenge.state === "active"
        && sameBytes(challenge.challenge_hash, input.challengeHash)) {
        return "duplicate" as const;
      }
      if (sameBytes(oldHead.head_digest, nextDigest)) {
        throw new Error("human_device_recovery_duplicate_conflict");
      }
      const oldLineage = counter(
        oldHead.lineage_generation,
        "old_lineage",
      );
      if (nextHead.serverInstanceId !== identity.server_instance_id) {
        throw new Error("human_device_recovery_instance_stale");
      }
      if (nextHead.lineageGeneration !== oldLineage + 1) {
        throw new Error("human_device_recovery_head_stale");
      }
      if (device.human_id !== input.humanId
        || device.user_id !== input.userId
        || device.state !== "pending"
        || device.membership_state !== "unbound") {
        throw new Error("human_device_recovery_device_stale");
      }
      if (challenge.consumed_at !== null
        || challenge.invalidated_at !== null
        || challenge.expected_response_digest === null
        || milliseconds(challenge.expires_at) <= input.now
        || !sameBytes(challenge.challenge_hash, input.challengeHash)) {
        throw new Error("human_device_recovery_challenge_stale");
      }
      if (currentRecovery.current_recovery_generation === null
        || device.recovery_generation === null
        || counter(device.recovery_generation, "device_recovery_generation")
          !== counter(
            currentRecovery.current_recovery_generation,
            "custody_recovery_generation",
          )
        || !sameBytes(
          currentRecovery.current_recovery_public_key_digest!,
          currentRecovery.public_key_digest,
        )) {
        throw new Error("human_device_recovery_key_stale");
      }
      if (!sameBytes(
          roster[0]!.installationLineageDigest,
          device.installation_lineage_digest,
        )
        || roster[0]!.deviceKeyGeneration
          !== counter(device.device_generation, "device_generation")) {
        throw new Error("human_device_recovery_roster_stale");
      }
      verifyRecoveryDevicePossessionProof({
        challengeBytes: challenge.payload_bytes,
        proof: {
          formatVersion: 2,
          challengeHash: input.challengeHash,
          response: input.response,
        },
        resolveTrustedChallenge: (challengeId) =>
          challengeId === challenge.challenge_id
            ? {
                challengeId,
                challengeHash: challenge.challenge_hash,
                expectedResponseDigest: challenge.expected_response_digest!,
                expectedStatus: "pending",
              }
            : null,
        pendingDevice: {
          humanId: humanId(input.humanId),
          deviceId: cryptoDeviceId(input.deviceId),
          pendingDeviceRevision: pendingDeviceRevisionV2(
            counter(device.revision, "device_revision"),
          ),
          encryptionPublicKey: device.encryption_public_key,
          signingPublicKey: device.signing_public_key,
        },
        resolveTrustedPendingDevice: (candidateHuman, candidateDevice) =>
          candidateHuman === input.humanId && candidateDevice === input.deviceId
            ? {
                humanId: humanId(input.humanId),
                deviceId: cryptoDeviceId(input.deviceId),
                pendingDeviceRevision: pendingDeviceRevisionV2(
                  counter(device.revision, "device_revision"),
                ),
                encryptionPublicKeyDigest: this.crypto.hash(
                  device.encryption_public_key,
                ),
                signingPublicKeyDigest: this.crypto.hash(
                  device.signing_public_key,
                ),
                status: "pending",
              }
            : null,
        resolveTrustedCurrentRecoveryKey: (candidateHuman) =>
          candidateHuman === input.humanId
            ? {
                humanId: humanId(input.humanId),
                recoveryKeyId: currentRecovery.recovery_key_id,
                recoveryGeneration: recoveryKeyGenerationV2(
                  counter(
                    currentRecovery.current_recovery_generation,
                    "custody_recovery_generation",
                  ),
                ),
                publicKeyDigest: currentRecovery.public_key_digest,
              }
            : null,
        currentTime: unixTimestamp(input.now),
      });
      const now = new Date(input.now);
      const generation = counter(device.device_generation, "device_generation");
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          state: "revoked",
          membershipState: "stale",
          revokedAt: now,
          revision: sql`${humanCryptoDevices.revision} + 1`,
        }).where(and(
          eq(humanCryptoDevices.humanId, input.humanId),
          ne(humanCryptoDevices.deviceId, input.deviceId),
          inArray(humanCryptoDevices.state, ["pending", "active"]),
          inArray(humanCryptoDevices.membershipState, [
            "catching_up",
            "current",
            "stale",
          ]),
        )),
      );
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          state: "revoked",
          membershipState: "unbound",
          membershipServerInstanceId: null,
          membershipLineageGeneration: null,
          membershipEpoch: null,
          membershipSecurityRevision: null,
          membershipLeafIndex: null,
          membershipHeadDigest: null,
          membershipAcknowledgedSequence: null,
          revokedAt: now,
          revision: sql`${humanCryptoDevices.revision} + 1`,
        }).where(and(
          eq(humanCryptoDevices.humanId, input.humanId),
          ne(humanCryptoDevices.deviceId, input.deviceId),
          inArray(humanCryptoDevices.state, ["pending", "active"]),
        )),
      );
      const headUpdated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceGroupHeads).set({
          serverInstanceId: nextHead.serverInstanceId,
          lineageGeneration: nextHead.lineageGeneration,
          providerId: nextHead.providerId,
          groupId: nextHead.groupId,
          epoch: nextHead.epoch,
          stateHash: nextHead.stateHash,
          rosterDigest: nextHead.rosterDigest,
          rosterBytes: input.rosterBytes,
          previousHeadDigest: null,
          headDigest: nextDigest,
          headBytes: input.headBytes,
          securityRevision: nextHead.securityRevision,
          commitSequence: 0,
          committingDeviceId: input.deviceId,
          committingDeviceGeneration: generation,
          createdAt: now,
          updatedAt: now,
        }).where(and(
          eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
          eq(humanCryptoDeviceGroupHeads.headDigest, oldHead.head_digest),
        )).returning({ humanId: humanCryptoDeviceGroupHeads.humanId }),
      );
      if (headUpdated.length !== 1) {
        throw new Error("human_device_recovery_head_cas");
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceGroupAcknowledgements).values({
          humanId: input.humanId,
          lineageGeneration: nextHead.lineageGeneration,
          deviceId: input.deviceId,
          deviceGeneration: generation,
          acknowledgedSequence: 0,
          acknowledgedHeadDigest: nextDigest,
          acknowledgedAt: now,
          revision: 1,
        }),
      );
      const targetUpdated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          state: "active",
          membershipState: "current",
          membershipServerInstanceId: nextHead.serverInstanceId,
          membershipLineageGeneration: nextHead.lineageGeneration,
          membershipEpoch: 0,
          membershipSecurityRevision: 1,
          membershipLeafIndex: roster[0]!.leafIndex,
          membershipHeadDigest: nextDigest,
          membershipAcknowledgedSequence: 0,
          activatedAt: now,
          lastSeenAt: now,
          revision: sql`${humanCryptoDevices.revision} + 1`,
        }).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          eq(humanCryptoDevices.state, "pending"),
          eq(humanCryptoDevices.revision, device.revision),
        )).returning({ deviceId: humanCryptoDevices.deviceId }),
      );
      if (targetUpdated.length !== 1) {
        throw new Error("human_device_recovery_device_cas");
      }
      const custodyUpdated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoCustodies).set({
          state: "active",
          revision: sql`${humanCryptoCustodies.revision} + 1`,
          lastTransitionAuditRef:
            `human-device-recovery:${input.operationId}`,
          updatedAt: now,
        }).where(and(
          eq(humanCryptoCustodies.humanId, input.humanId),
          eq(humanCryptoCustodies.userId, input.userId),
          eq(
            humanCryptoCustodies.currentRecoveryGeneration,
            currentRecovery.current_recovery_generation,
          ),
          eq(
            humanCryptoCustodies.currentRecoveryPublicKeyDigest,
            currentRecovery.public_key_digest,
          ),
        )).returning({ humanId: humanCryptoCustodies.humanId }),
      );
      if (custodyUpdated.length !== 1) {
        throw new Error("human_device_recovery_custody_cas");
      }
      const challengeUpdated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceChallenges).set({
          consumedAt: now,
          terminalResultCode: "active",
          receiptAuditRef: `human-device-recovery:${input.operationId}`,
          revision: sql`${humanCryptoDeviceChallenges.revision} + 1`,
        }).where(and(
          eq(
            humanCryptoDeviceChallenges.challengeId,
            challenge.challenge_id,
          ),
          isNull(humanCryptoDeviceChallenges.consumedAt),
          isNull(humanCryptoDeviceChallenges.invalidatedAt),
          eq(
            humanCryptoDeviceChallenges.challengeHash,
            challenge.challenge_hash,
          ),
          eq(humanCryptoDeviceChallenges.revision, 1),
        )).returning({
          challengeId: humanCryptoDeviceChallenges.challengeId,
        }),
      );
      if (challengeUpdated.length !== 1) {
        throw new Error("human_device_recovery_challenge_cas");
      }
      const operationUpdated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDeliveryOperations).set({
          state: "active",
          terminalAt: now,
          updatedAt: now,
        }).where(and(
          eq(cryptoDeliveryOperations.operationId, input.operationId),
          eq(cryptoDeliveryOperations.kind, "device_recovery"),
          eq(cryptoDeliveryOperations.state, "awaiting_committer"),
        )).returning({ operationId: cryptoDeliveryOperations.operationId }),
      );
      if (operationUpdated.length !== 1) {
        throw new Error("human_device_recovery_operation_cas");
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(cryptoDeliveryOperations).set({
          state: "cancelled",
          terminalAt: now,
          updatedAt: now,
          failureCode: "superseded_by_recovery",
        }).where(and(
          eq(cryptoDeliveryOperations.humanId, input.humanId),
          ne(cryptoDeliveryOperations.operationId, input.operationId),
          inArray(cryptoDeliveryOperations.kind, [
            "device_add",
            "device_recovery",
            "device_revoke",
          ]),
          inArray(cryptoDeliveryOperations.state, [
            "awaiting_target_device",
            "awaiting_committer",
            "preparing_domain",
            "awaiting_delivery",
            "ready_to_activate",
          ]),
        )),
      );
      return "created" as const;
    });
  }

  async bindPendingAndPublishJoin(input: Readonly<{
    userId: string;
    humanId: string;
    operationId: string;
    targetDeviceId: string;
    requestBytes: Uint8Array;
    now: number;
  }>): Promise<"published" | "duplicate"> {
    const request = decodeHumanDeviceGroupJoinRequest(input.requestBytes);
    const canonical = encodeHumanDeviceGroupJoinRequest(request);
    if (!sameBytes(canonical, input.requestBytes)
      || request.credential.humanId !== input.humanId
      || request.credential.deviceId !== input.targetDeviceId) {
      throw new Error("human_device_join_invalid");
    }
    return this.handle.transaction(async (transaction) => {
      await lockHumanDeviceGroupTransaction(transaction, input.humanId);
      const heads = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          headDigest: humanCryptoDeviceGroupHeads.headDigest,
          headBytes: humanCryptoDeviceGroupHeads.headBytes,
          lineageGeneration:
            humanCryptoDeviceGroupHeads.lineageGeneration,
          epoch: humanCryptoDeviceGroupHeads.epoch,
          securityRevision: humanCryptoDeviceGroupHeads.securityRevision,
          serverInstanceId: humanCryptoDeviceGroupHeads.serverInstanceId,
          sequence: humanCryptoDeviceGroupHeads.commitSequence,
        }).from(humanCryptoDeviceGroupHeads).where(
          eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
        ),
      );
      const head = heads[0];
      if (head === undefined || !sameBytes(head.head_bytes,
        encodeHumanDeviceGroupHead(request.expectedHead))) {
        throw new Error("human_device_join_stale_head");
      }
      const headLineage = counter(
        head.lineage_generation,
        "head_lineage_generation",
      );
      const headEpoch = counter(head.epoch, "head_epoch");
      const headSecurityRevision = counter(
        head.security_revision,
        "head_security_revision",
      );
      const headSequence = counter(
        head.commit_sequence,
        "head_commit_sequence",
      );
      const devices = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          generation: humanCryptoDevices.deviceGeneration,
          userId: humanCryptoDevices.userId,
          state: humanCryptoDevices.state,
          lineage: humanCryptoDevices.installationLineageDigest,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, input.targetDeviceId),
          eq(humanCryptoDevices.humanId, input.humanId),
        )),
      );
      const deviceGeneration = devices.length === 1
        ? counter(devices[0]!.device_generation, "device_generation")
        : null;
      if (devices.length !== 1 || devices[0]!.user_id !== input.userId
        || devices[0]!.state !== "pending"
        || deviceGeneration !== request.credential.deviceKeyGeneration
        || !sameBytes(devices[0]!.installation_lineage_digest,
          request.credential.installationLineageDigest)) {
        throw new Error("human_device_pending_target_invalid");
      }
      const existing = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          requestBytes: humanCryptoDeviceGroupJoinRequests.requestBytes,
          state: humanCryptoDeviceGroupJoinRequests.state,
        }).from(humanCryptoDeviceGroupJoinRequests).where(
          eq(humanCryptoDeviceGroupJoinRequests.operationId, input.operationId),
        ),
      );
      const now = new Date(input.now);
      if (existing.length === 1) {
        if (sameBytes(existing[0]!.request_bytes, input.requestBytes)) {
          return "duplicate";
        }
        if (existing[0]!.state !== "pending") {
          throw new Error("human_device_join_idempotency_conflict");
        }
        const rebased = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(humanCryptoDeviceGroupJoinRequests).set({
            lineageGeneration: headLineage,
            expectedHeadDigest: head.head_digest,
            requestBytes: input.requestBytes,
            createdAt: now,
          }).where(and(
            eq(
              humanCryptoDeviceGroupJoinRequests.operationId,
              input.operationId,
            ),
            eq(humanCryptoDeviceGroupJoinRequests.state, "pending"),
          )).returning({
            operationId: humanCryptoDeviceGroupJoinRequests.operationId,
          }),
        );
        if (rebased.length !== 1) throw new Error("human_device_join_rebase_cas");
        const projected = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(humanCryptoDevices).set({
            membershipServerInstanceId: head.server_instance_id,
            membershipLineageGeneration: headLineage,
            membershipEpoch: headEpoch,
            membershipSecurityRevision: headSecurityRevision,
            membershipHeadDigest: head.head_digest,
            membershipAcknowledgedSequence: headSequence,
            revision: sql`${humanCryptoDevices.revision} + 1`,
          }).where(and(
            eq(humanCryptoDevices.deviceId, input.targetDeviceId),
            eq(humanCryptoDevices.state, "pending"),
            eq(humanCryptoDevices.membershipState, "pending"),
          )).returning({ deviceId: humanCryptoDevices.deviceId }),
        );
        if (projected.length !== 1) {
          throw new Error("human_device_join_rebase_projection_cas");
        }
        return "published";
      }
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceGroupJoinRequests).values({
          operationId: input.operationId,
          humanId: input.humanId,
          lineageGeneration: headLineage,
          targetDeviceId: input.targetDeviceId,
          targetDeviceGeneration: deviceGeneration,
          expectedHeadDigest: head.head_digest,
          requestBytes: input.requestBytes,
          state: "pending",
          createdAt: now,
          consumedAt: null,
        }),
      );
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          membershipState: "pending",
          membershipServerInstanceId: head.server_instance_id,
          membershipLineageGeneration: headLineage,
          membershipEpoch: headEpoch,
          membershipSecurityRevision: headSecurityRevision,
          membershipLeafIndex: null,
          membershipHeadDigest: head.head_digest,
          membershipAcknowledgedSequence: headSequence,
          revision: sql`${humanCryptoDevices.revision} + 1`,
        }).where(and(
          eq(humanCryptoDevices.deviceId, input.targetDeviceId),
          eq(humanCryptoDevices.state, "pending"),
          eq(humanCryptoDevices.membershipState, "unbound"),
        )).returning({ deviceId: humanCryptoDevices.deviceId }),
      );
      if (updated.length !== 1) throw new Error("human_device_pending_cas");
      return "published";
    });
  }

  async listPending(input: Readonly<{
    userId: string;
    humanId: string;
    approverDeviceId: string;
    afterOperationId?: string;
  }>): Promise<readonly PendingHumanDeviceJoin[]> {
    const approvers = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({ deviceId: humanCryptoDevices.deviceId })
        .from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, input.approverDeviceId),
          eq(humanCryptoDevices.humanId, input.humanId),
          eq(humanCryptoDevices.userId, input.userId),
          eq(humanCryptoDevices.state, "active"),
          eq(humanCryptoDevices.membershipState, "current"),
        )),
    );
    if (approvers.length !== 1) {
      throw new Error("human_device_approver_unavailable");
    }
    const where = input.afterOperationId === undefined
      ? and(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, input.humanId),
        eq(humanCryptoDeviceGroupJoinRequests.state, "pending"),
      )
      : and(
        eq(humanCryptoDeviceGroupJoinRequests.humanId, input.humanId),
        eq(humanCryptoDeviceGroupJoinRequests.state, "pending"),
        gt(
          humanCryptoDeviceGroupJoinRequests.operationId,
          input.afterOperationId,
        ),
      );
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        operationId: humanCryptoDeviceGroupJoinRequests.operationId,
        targetDeviceId: humanCryptoDeviceGroupJoinRequests.targetDeviceId,
        targetDeviceGeneration:
          humanCryptoDeviceGroupJoinRequests.targetDeviceGeneration,
        requestBytes: humanCryptoDeviceGroupJoinRequests.requestBytes,
        createdAt: humanCryptoDeviceGroupJoinRequests.createdAt,
        clientKind: humanCryptoDevices.clientKind,
        signingPublicKey: humanCryptoDevices.signingPublicKey,
      }).from(humanCryptoDeviceGroupJoinRequests).innerJoin(
        humanCryptoDevices,
        eq(
          humanCryptoDevices.deviceId,
          humanCryptoDeviceGroupJoinRequests.targetDeviceId,
        ),
      ).where(where).orderBy(
        asc(humanCryptoDeviceGroupJoinRequests.operationId),
      ).limit(COMMIT_PAGE_SIZE),
    );
    return Object.freeze(rows.map((row) => Object.freeze({
      operationId: row.operation_id,
      targetDeviceId: row.target_device_id,
      targetClientKind: row.client_kind as "browser" | "electron",
      targetDeviceGeneration: counter(
        row.target_device_generation,
        "target_device_generation",
      ),
      targetSigningPublicKey: row.signing_public_key.slice(),
      requestBytes: row.request_bytes.slice(),
      createdAt: milliseconds(row.created_at),
    })));
  }

  publishAdd(input: Readonly<{
    userId: string;
    humanId: string;
    operationId: string;
    committerDeviceId: string;
    transitionBytes: Uint8Array;
    welcomeBytes: Uint8Array;
    now: number;
  }>): Promise<"published" | "duplicate"> {
    const transition = decodeHumanDeviceGroupTransition(
      this.crypto,
      input.transitionBytes,
    );
    const canonical = encodeHumanDeviceGroupTransition(transition);
    if (!sameBytes(canonical, input.transitionBytes)
      || transition.operation !== "add"
      || transition.coordinates.humanId !== input.humanId
      || transition.committerCredential.deviceId !== input.committerDeviceId
      || !sameBytes(this.crypto.hash(input.welcomeBytes),
        transition.welcomeHash)) {
      throw new Error("human_device_add_invalid");
    }
    return this.handle.transaction((transaction) => this.withAddLock(
      transaction,
      input,
      transition,
    ));
  }

  publishRemove(input: Readonly<{
    userId: string;
    humanId: string;
    operationId: string;
    committerDeviceId: string;
    transitionBytes: Uint8Array;
    now: number;
  }>): Promise<"published" | "duplicate"> {
    const transition = decodeHumanDeviceGroupTransition(
      this.crypto,
      input.transitionBytes,
    );
    const canonical = encodeHumanDeviceGroupTransition(transition);
    if (!sameBytes(canonical, input.transitionBytes)
      || transition.operation !== "remove"
      || transition.coordinates.humanId !== input.humanId
      || transition.committerCredential.deviceId !== input.committerDeviceId
      || transition.targetCredential.deviceId === input.committerDeviceId
      || transition.welcomeBytes.length !== 0) {
      throw new Error("human_device_remove_invalid");
    }
    return this.handle.transaction((transaction) => this.withRemoveLock(
      transaction,
      input,
      transition,
    ));
  }

  private async withRemoveLock(
    transaction: CryptoPostgresTransaction,
    input: Readonly<{
      userId: string;
      humanId: string;
      operationId: string;
      committerDeviceId: string;
      transitionBytes: Uint8Array;
      now: number;
    }>,
    transition: HumanDeviceGroupTransition,
  ): Promise<"published" | "duplicate"> {
    await lockHumanDeviceGroupTransaction(transaction, input.humanId);
    const duplicate = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        transitionBytes: humanCryptoDeviceGroupCommits.publicTransitionBytes,
      }).from(humanCryptoDeviceGroupCommits).where(
        eq(humanCryptoDeviceGroupCommits.operationId, input.operationId),
      ),
    );
    if (duplicate.length === 1) {
      if (!sameBytes(
        duplicate[0]!.public_transition_bytes,
        input.transitionBytes,
      )) throw new Error("human_device_remove_idempotency_conflict");
      return "duplicate";
    }
    const heads = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        headDigest: humanCryptoDeviceGroupHeads.headDigest,
        sequence: humanCryptoDeviceGroupHeads.commitSequence,
        headBytes: humanCryptoDeviceGroupHeads.headBytes,
        rosterBytes: humanCryptoDeviceGroupHeads.rosterBytes,
      }).from(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
      ),
    );
    const head = heads[0];
    const expectedDigest = humanDeviceGroupHeadDigest(
      this.crypto,
      transition.expectedHead,
    );
    if (head === undefined || !sameBytes(head.head_digest, expectedDigest)
      || !sameBytes(
        head.head_bytes,
        encodeHumanDeviceGroupHead(transition.expectedHead),
      )) throw new Error("human_device_remove_stale_head");
    const currentRoster = decodeHumanDeviceRoster(head.roster_bytes);
    const nextRoster = decodeHumanDeviceRoster(transition.rosterBytes);
    const exactTarget = currentRoster.find((entry) =>
      entry.deviceId === transition.targetCredential.deviceId
      && entry.deviceKeyGeneration
        === transition.targetCredential.deviceKeyGeneration
      && sameBytes(
        entry.installationLineageDigest,
        transition.targetCredential.installationLineageDigest,
      )
    );
    if (currentRoster.length < 2) {
      throw new Error("human_device_final_device_removal_forbidden");
    }
    if (exactTarget === undefined
      || nextRoster.length !== currentRoster.length - 1
      || nextRoster.some((entry) =>
        entry.deviceId === transition.targetCredential.deviceId
      )) throw new Error("human_device_remove_roster_mismatch");
    const devices = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        deviceId: humanCryptoDevices.deviceId,
        generation: humanCryptoDevices.deviceGeneration,
        revision: humanCryptoDevices.revision,
        userId: humanCryptoDevices.userId,
        state: humanCryptoDevices.state,
        membershipState: humanCryptoDevices.membershipState,
        headDigest: humanCryptoDevices.membershipHeadDigest,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.humanId, input.humanId),
        inArray(humanCryptoDevices.deviceId, [
          input.committerDeviceId,
          transition.targetCredential.deviceId,
        ]),
      )),
    );
    const committer = devices.find((entry) =>
      entry.device_id === input.committerDeviceId
    );
    const target = devices.find((entry) =>
      entry.device_id === transition.targetCredential.deviceId
    );
    if (committer === undefined || target === undefined
      || committer.user_id !== input.userId || target.user_id !== input.userId
      || committer.state !== "active"
      || !["active", "pending"].includes(target.state)
      || committer.membership_state !== "current"
      || !["current", "catching_up", "welcome_pending"].includes(
        target.membership_state,
      )
      || committer.membership_head_digest === null
      || !sameBytes(committer.membership_head_digest, head.head_digest)
      || counter(committer.device_generation, "committer_device_generation")
        !== transition.committerCredential.deviceKeyGeneration
      || counter(target.device_generation, "target_device_generation")
        !== transition.targetCredential.deviceKeyGeneration) {
      throw new Error("human_device_remove_unauthorized");
    }
    const headSequence = counter(
      head.commit_sequence,
      "head_commit_sequence",
    );
    const nextSequence = headSequence + 1;
    const nextDigest = humanDeviceGroupHeadDigest(
      this.crypto,
      transition.nextHead,
    );
    const committerGeneration = counter(
      committer.device_generation,
      "committer_device_generation",
    );
    const targetGeneration = counter(
      target.device_generation,
      "target_device_generation",
    );
    const targetRevision = counter(target.revision, "target_device_revision");
    const now = new Date(input.now);
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(humanCryptoDeviceGroupCommits).values({
        humanId: input.humanId,
        serverInstanceId: transition.coordinates.serverInstanceId,
        lineageGeneration: transition.coordinates.lineageGeneration,
        sequence: nextSequence,
        operationId: input.operationId,
        operation: "remove",
        expectedHeadDigest: expectedDigest,
        nextHeadDigest: nextDigest,
        nextEpoch: transition.nextHead.epoch,
        nextSecurityRevision: transition.nextHead.securityRevision,
        committerDeviceId: input.committerDeviceId,
        committerDeviceGeneration: committerGeneration,
        targetDeviceId: transition.targetCredential.deviceId,
        targetDeviceGeneration: targetGeneration,
        publicTransitionBytes: input.transitionBytes,
        commitBytes: transition.commitBytes,
        welcomeDigest: null,
        rosterDigest: transition.nextHead.rosterDigest,
        rosterBytes: transition.rosterBytes,
        createdAt: now,
      }),
    );
    const headUpdated = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDeviceGroupHeads).set({
        epoch: transition.nextHead.epoch,
        stateHash: transition.nextHead.stateHash,
        rosterDigest: transition.nextHead.rosterDigest,
        rosterBytes: transition.rosterBytes,
        previousHeadDigest: expectedDigest,
        headDigest: nextDigest,
        headBytes: encodeHumanDeviceGroupHead(transition.nextHead),
        securityRevision: transition.nextHead.securityRevision,
        commitSequence: nextSequence,
        committingDeviceId: input.committerDeviceId,
        committingDeviceGeneration: committerGeneration,
        updatedAt: now,
      }).where(and(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
        eq(humanCryptoDeviceGroupHeads.headDigest, expectedDigest),
      )).returning({ humanId: humanCryptoDeviceGroupHeads.humanId }),
    );
    if (headUpdated.length !== 1) throw new Error("human_device_head_cas");
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        membershipState: "catching_up",
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.membershipState, "current"),
        sql`${humanCryptoDevices.deviceId} <> ${
          transition.targetCredential.deviceId
        }`,
      )),
    );
    const revoked = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        state: "revoked",
        membershipState: "stale",
        revokedAt: now,
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.deviceId, transition.targetCredential.deviceId),
        eq(humanCryptoDevices.deviceGeneration, targetGeneration),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.revision, targetRevision),
      )).returning({ deviceId: humanCryptoDevices.deviceId }),
    );
    if (revoked.length !== 1) throw new Error("human_device_remove_target_cas");
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(cryptoDeliveryOperations).values({
        operationId: input.operationId,
        idempotencyKey: input.operationId,
        kind: "device_revoke",
        state: "active",
        humanId: input.humanId,
        targetHumanId: input.humanId,
        targetDeviceId: transition.targetCredential.deviceId,
        expectedCustodyRevision: null,
        expectedRecoveryGeneration: null,
        expectedDeviceRevision: targetRevision,
        expectedParticipantDigest: null,
        aggregatePayloadBytes: input.transitionBytes.length,
        fanoutRowCount: 0,
        leaseOwner: null,
        leaseExpiresAt: null,
        retryCount: 0,
        maximumAttempts: CRYPTO_DELIVERY_COLLECTION_LIMITS.maximumAttempts,
        failureCode: null,
        auditRef: `human-device-group:${input.operationId}`,
        createdAt: now,
        updatedAt: now,
        deadlineAt: new Date(input.now + 5 * 60_000),
        terminalAt: now,
      }),
    );
    return "published";
  }

  private async withAddLock(
    transaction: CryptoPostgresTransaction,
    input: Readonly<{
      userId: string;
      humanId: string;
      operationId: string;
      committerDeviceId: string;
      transitionBytes: Uint8Array;
      welcomeBytes: Uint8Array;
      now: number;
    }>,
    transition: HumanDeviceGroupTransition,
  ): Promise<"published" | "duplicate"> {
    await lockHumanDeviceGroupTransaction(transaction, input.humanId);
    const duplicate = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        transitionBytes: humanCryptoDeviceGroupCommits.publicTransitionBytes,
      }).from(humanCryptoDeviceGroupCommits).where(
        eq(humanCryptoDeviceGroupCommits.operationId, input.operationId),
      ),
    );
    if (duplicate.length === 1) {
      if (!sameBytes(duplicate[0]!.public_transition_bytes, input.transitionBytes)) {
        throw new Error("human_device_add_idempotency_conflict");
      }
      return "duplicate";
    }
    const heads = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        headDigest: humanCryptoDeviceGroupHeads.headDigest,
        sequence: humanCryptoDeviceGroupHeads.commitSequence,
        headBytes: humanCryptoDeviceGroupHeads.headBytes,
      }).from(humanCryptoDeviceGroupHeads).where(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
      ),
    );
    const head = heads[0];
    const expectedDigest = humanDeviceGroupHeadDigest(
      this.crypto,
      transition.expectedHead,
    );
    if (head === undefined || !sameBytes(head.head_digest, expectedDigest)
      || !sameBytes(head.head_bytes,
        encodeHumanDeviceGroupHead(transition.expectedHead))) {
      throw new Error("human_device_add_stale_head");
    }
    const headSequence = counter(
      head.commit_sequence,
      "head_commit_sequence",
    );
    const joins = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        requestBytes: humanCryptoDeviceGroupJoinRequests.requestBytes,
        state: humanCryptoDeviceGroupJoinRequests.state,
        targetDeviceId: humanCryptoDeviceGroupJoinRequests.targetDeviceId,
        targetGeneration:
          humanCryptoDeviceGroupJoinRequests.targetDeviceGeneration,
      }).from(humanCryptoDeviceGroupJoinRequests).where(
        eq(humanCryptoDeviceGroupJoinRequests.operationId, input.operationId),
      ),
    );
    const join = joins[0];
    if (join === undefined || join.state !== "pending"
      || join.target_device_id !== transition.targetCredential.deviceId) {
      throw new Error("human_device_join_unavailable");
    }
    const targetDeviceGeneration = counter(
      join.target_device_generation,
      "target_device_generation",
    );
    const joinRequest = decodeHumanDeviceGroupJoinRequest(join.request_bytes);
    if (!sameBytes(this.crypto.hash(join.request_bytes),
      transition.joinRequestHash)
      || joinRequest.credential.deviceId
        !== transition.targetCredential.deviceId
      || joinRequest.credential.deviceKeyGeneration
        !== transition.targetCredential.deviceKeyGeneration) {
      throw new Error("human_device_add_target_substituted");
    }
    const committerRows = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        generation: humanCryptoDevices.deviceGeneration,
        userId: humanCryptoDevices.userId,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.deviceId, input.committerDeviceId),
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.membershipState, "current"),
        eq(humanCryptoDevices.membershipHeadDigest, head.head_digest),
      )),
    );
    const committerDeviceGeneration = committerRows.length === 1
      ? counter(
        committerRows[0]!.device_generation,
        "committer_device_generation",
      )
      : null;
    if (committerRows.length !== 1
      || committerRows[0]!.user_id !== input.userId
      || committerDeviceGeneration
        !== transition.committerCredential.deviceKeyGeneration) {
      throw new Error("human_device_committer_unavailable");
    }
    const roster = decodeHumanDeviceRoster(transition.rosterBytes);
    const targetLeaf = roster.find((entry) =>
      entry.deviceId === transition.targetCredential.deviceId
      && entry.deviceKeyGeneration
        === transition.targetCredential.deviceKeyGeneration
    );
    if (targetLeaf === undefined) throw new Error("human_device_target_missing");
    const nextDigest = humanDeviceGroupHeadDigest(
      this.crypto,
      transition.nextHead,
    );
    const nextSequence = headSequence + 1;
    const now = new Date(input.now);
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(humanCryptoDeviceGroupCommits).values({
        humanId: input.humanId,
        serverInstanceId: transition.coordinates.serverInstanceId,
        lineageGeneration: transition.coordinates.lineageGeneration,
        sequence: nextSequence,
        operationId: input.operationId,
        operation: "add",
        expectedHeadDigest: expectedDigest,
        nextHeadDigest: nextDigest,
        nextEpoch: transition.nextHead.epoch,
        nextSecurityRevision: transition.nextHead.securityRevision,
        committerDeviceId: input.committerDeviceId,
        committerDeviceGeneration,
        targetDeviceId: transition.targetCredential.deviceId,
        targetDeviceGeneration,
        publicTransitionBytes: input.transitionBytes,
        commitBytes: transition.commitBytes,
        welcomeDigest: transition.welcomeHash,
        rosterDigest: transition.nextHead.rosterDigest,
        rosterBytes: transition.rosterBytes,
        createdAt: now,
      }),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.insert(humanCryptoDeviceGroupWelcomes).values({
        operationId: input.operationId,
        humanId: input.humanId,
        lineageGeneration: transition.coordinates.lineageGeneration,
        sequence: nextSequence,
        targetDeviceId: transition.targetCredential.deviceId,
        targetDeviceGeneration,
        welcomeDigest: transition.welcomeHash,
        welcomeBytes: input.welcomeBytes,
        state: "pending",
        createdAt: now,
        deliveredAt: null,
        acknowledgedAt: null,
      }),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDeviceGroupJoinRequests).set({
        state: "consumed",
        consumedAt: now,
      }).where(and(
        eq(humanCryptoDeviceGroupJoinRequests.operationId, input.operationId),
        eq(humanCryptoDeviceGroupJoinRequests.state, "pending"),
      )),
    );
    const headUpdated = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDeviceGroupHeads).set({
        epoch: transition.nextHead.epoch,
        stateHash: transition.nextHead.stateHash,
        rosterDigest: transition.nextHead.rosterDigest,
        rosterBytes: transition.rosterBytes,
        previousHeadDigest: expectedDigest,
        headDigest: nextDigest,
        headBytes: encodeHumanDeviceGroupHead(transition.nextHead),
        securityRevision: transition.nextHead.securityRevision,
        commitSequence: nextSequence,
        committingDeviceId: input.committerDeviceId,
        committingDeviceGeneration: committerDeviceGeneration,
        updatedAt: now,
      }).where(and(
        eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
        eq(humanCryptoDeviceGroupHeads.headDigest, expectedDigest),
      )).returning({ humanId: humanCryptoDeviceGroupHeads.humanId }),
    );
    if (headUpdated.length !== 1) throw new Error("human_device_head_cas");
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        membershipState: "catching_up",
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.humanId, input.humanId),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.membershipState, "current"),
      )),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.update(humanCryptoDevices).set({
        membershipState: "welcome_pending",
        membershipEpoch: transition.nextHead.epoch,
        membershipSecurityRevision: transition.nextHead.securityRevision,
        membershipHeadDigest: nextDigest,
        membershipAcknowledgedSequence: headSequence,
        revision: sql`${humanCryptoDevices.revision} + 1`,
      }).where(and(
        eq(humanCryptoDevices.deviceId, transition.targetCredential.deviceId),
        eq(humanCryptoDevices.state, "pending"),
        eq(humanCryptoDevices.membershipState, "pending"),
      )),
    );
    return "published";
  }

  async acknowledge(input: Readonly<{
    userId: string;
    humanId: string;
    deviceId: string;
    sequence: number;
    headDigest: Uint8Array;
    leafIndex: number;
    now: number;
  }>): Promise<"acknowledged" | "duplicate"> {
    if (!Number.isSafeInteger(input.sequence) || input.sequence < 0
      || !Number.isSafeInteger(input.leafIndex) || input.leafIndex < 0) {
      throw new RangeError("Human-device acknowledgement is invalid");
    }
    return this.handle.transaction(async (transaction) => {
      await lockHumanDeviceGroupTransaction(transaction, input.humanId);
      const heads = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          headDigest: humanCryptoDeviceGroupHeads.headDigest,
          headBytes: humanCryptoDeviceGroupHeads.headBytes,
          sequence: humanCryptoDeviceGroupHeads.commitSequence,
          lineage: humanCryptoDeviceGroupHeads.lineageGeneration,
          server: humanCryptoDeviceGroupHeads.serverInstanceId,
          epoch: humanCryptoDeviceGroupHeads.epoch,
          security: humanCryptoDeviceGroupHeads.securityRevision,
          rosterBytes: humanCryptoDeviceGroupHeads.rosterBytes,
        }).from(humanCryptoDeviceGroupHeads).where(
          eq(humanCryptoDeviceGroupHeads.humanId, input.humanId),
        ),
      );
      const head = heads[0];
      const headSequence = head === undefined
        ? null
        : counter(head.commit_sequence, "head_commit_sequence");
      if (head === undefined || headSequence !== input.sequence
        || !sameBytes(head.head_digest, input.headDigest)) {
        throw new Error("human_device_ack_stale_head");
      }
      const devices = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          generation: humanCryptoDevices.deviceGeneration,
          userId: humanCryptoDevices.userId,
          state: humanCryptoDevices.state,
          membershipState: humanCryptoDevices.membershipState,
          acknowledged: humanCryptoDevices.membershipAcknowledgedSequence,
        }).from(humanCryptoDevices).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          eq(humanCryptoDevices.humanId, input.humanId),
        )),
      );
      const device = devices[0];
      const deviceGeneration = device === undefined
        ? null
        : counter(device.device_generation, "device_generation");
      const acknowledgedSequence = device === undefined
        ? null
        : optionalCounter(
          device.membership_acknowledged_sequence,
          "device_acknowledged_sequence",
        );
      if (device === undefined || device.user_id !== input.userId
        || !["pending", "active"].includes(device.state)
        || !["welcome_pending", "catching_up", "current"].includes(
          device.membership_state,
        )) throw new Error("human_device_ack_unauthorized");
      if (deviceGeneration === null) {
        throw new Error("human_device_ack_unauthorized");
      }
      if (device.membership_state === "current"
        && acknowledgedSequence === input.sequence) return "duplicate";
      const roster = decodeHumanDeviceRoster(head.roster_bytes);
      const member = roster.find((entry) => entry.deviceId === input.deviceId
        && entry.deviceKeyGeneration === deviceGeneration);
      if (member === undefined || member.leafIndex !== input.leafIndex) {
        throw new Error("human_device_ack_roster_mismatch");
      }
      const now = new Date(input.now);
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceGroupAcknowledgements).values({
          humanId: input.humanId,
          lineageGeneration: counter(
            head.lineage_generation,
            "head_lineage_generation",
          ),
          deviceId: input.deviceId,
          deviceGeneration,
          acknowledgedSequence: input.sequence,
          acknowledgedHeadDigest: input.headDigest,
          acknowledgedAt: now,
          revision: 1,
        }).onConflictDoUpdate({
          target: [
            humanCryptoDeviceGroupAcknowledgements.humanId,
            humanCryptoDeviceGroupAcknowledgements.lineageGeneration,
            humanCryptoDeviceGroupAcknowledgements.deviceId,
            humanCryptoDeviceGroupAcknowledgements.deviceGeneration,
          ],
          set: {
            acknowledgedSequence: input.sequence,
            acknowledgedHeadDigest: input.headDigest,
            acknowledgedAt: now,
            revision:
              sql`${humanCryptoDeviceGroupAcknowledgements.revision} + 1`,
          },
        }),
      );
      const updated = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDevices).set({
          state: "active",
          membershipState: "current",
          membershipServerInstanceId: head.server_instance_id,
          membershipLineageGeneration: counter(
            head.lineage_generation,
            "head_lineage_generation",
          ),
          membershipEpoch: counter(head.epoch, "head_epoch"),
          membershipSecurityRevision: counter(
            head.security_revision,
            "head_security_revision",
          ),
          membershipLeafIndex: input.leafIndex,
          membershipHeadDigest: input.headDigest,
          membershipAcknowledgedSequence: input.sequence,
          activatedAt: sql`coalesce(${humanCryptoDevices.activatedAt}, ${now})`,
          revision: sql`${humanCryptoDevices.revision} + 1`,
        }).where(and(
          eq(humanCryptoDevices.deviceId, input.deviceId),
          inArray(humanCryptoDevices.state, ["pending", "active"]),
        )).returning({ deviceId: humanCryptoDevices.deviceId }),
      );
      if (updated.length !== 1) throw new Error("human_device_ack_cas");
      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceGroupWelcomes).set({
          state: "acknowledged",
          deliveredAt: sql`coalesce(
            ${humanCryptoDeviceGroupWelcomes.deliveredAt},
            greatest(${humanCryptoDeviceGroupWelcomes.createdAt}, ${now})
          )`,
          acknowledgedAt: sql`greatest(
            ${now},
            coalesce(
              ${humanCryptoDeviceGroupWelcomes.deliveredAt},
              ${humanCryptoDeviceGroupWelcomes.createdAt}
            )
          )`,
        }).where(and(
          eq(humanCryptoDeviceGroupWelcomes.targetDeviceId, input.deviceId),
          eq(humanCryptoDeviceGroupWelcomes.sequence, input.sequence),
          inArray(humanCryptoDeviceGroupWelcomes.state, ["pending", "delivered"]),
        )),
      );
      const welcomed = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          operationId: humanCryptoDeviceGroupWelcomes.operationId,
        }).from(humanCryptoDeviceGroupWelcomes).where(and(
          eq(humanCryptoDeviceGroupWelcomes.targetDeviceId, input.deviceId),
          eq(humanCryptoDeviceGroupWelcomes.sequence, input.sequence),
        )),
      );
      if (welcomed.length > 1) throw new Error("human_device_welcome_conflict");
      if (welcomed[0] !== undefined) {
        const operationId = welcomed[0].operation_id;
        await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(cryptoDeliveryOperations).set({
            state: "active",
            terminalAt: now,
          }).where(and(
            eq(
              cryptoDeliveryOperations.operationId,
              operationId,
            ),
            eq(cryptoDeliveryOperations.targetDeviceId, input.deviceId),
            eq(cryptoDeliveryOperations.kind, "device_add"),
          )),
        );
        const consumed = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.update(humanCryptoDeviceChallenges).set({
            consumedAt: now,
            terminalResultCode: "active",
            receiptAuditRef: `human-device-group:${operationId}`,
            revision: sql`${humanCryptoDeviceChallenges.revision} + 1`,
          }).where(and(
            eq(humanCryptoDeviceChallenges.pendingDeviceId, input.deviceId),
            eq(humanCryptoDeviceChallenges.kind, "device_approval"),
            isNull(humanCryptoDeviceChallenges.consumedAt),
            isNull(humanCryptoDeviceChallenges.invalidatedAt),
          )).returning({
            challengeId: humanCryptoDeviceChallenges.challengeId,
          }),
        );
        if (consumed.length !== 1) {
          throw new Error("human_device_challenge_cas");
        }
      }
      await this.pruneAcknowledgedCommitPrefix(transaction, {
        humanId: input.humanId,
        lineageGeneration: counter(
          head.lineage_generation,
          "head_lineage_generation",
        ),
        roster,
      });
      return "acknowledged";
    });
  }

  private async pruneAcknowledgedCommitPrefix(
    transaction: CryptoPostgresTransaction,
    input: Readonly<{
      humanId: string;
      lineageGeneration: number;
      roster: ReturnType<typeof decodeHumanDeviceRoster>;
    }>,
  ): Promise<void> {
    if (input.roster.length === 0) return;
    const deviceIds = input.roster.map((member) => member.deviceId);
    const devices = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        deviceId: humanCryptoDevices.deviceId,
        generation: humanCryptoDevices.deviceGeneration,
        state: humanCryptoDevices.state,
        membershipState: humanCryptoDevices.membershipState,
        acknowledged: humanCryptoDevices.membershipAcknowledgedSequence,
      }).from(humanCryptoDevices).where(and(
        eq(humanCryptoDevices.humanId, input.humanId),
        inArray(humanCryptoDevices.deviceId, deviceIds),
      )),
    );
    const acknowledgements: number[] = [];
    for (const member of input.roster) {
      const device = devices.find((candidate) =>
        candidate.device_id === member.deviceId
        && counter(candidate.device_generation, "device_generation")
          === member.deviceKeyGeneration
      );
      if (device === undefined || device.state !== "active"
        || device.membership_state !== "current") return;
      const acknowledged = optionalCounter(
        device.membership_acknowledged_sequence,
        "device_acknowledged_sequence",
      );
      if (acknowledged === null) return;
      acknowledgements.push(acknowledged);
    }
    const floor = Math.min(...acknowledgements);
    if (floor < 1) return;
    const prunable = await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.select({
        operationId: humanCryptoDeviceGroupCommits.operationId,
      }).from(humanCryptoDeviceGroupCommits).where(and(
        eq(humanCryptoDeviceGroupCommits.humanId, input.humanId),
        eq(
          humanCryptoDeviceGroupCommits.lineageGeneration,
          input.lineageGeneration,
        ),
        lte(humanCryptoDeviceGroupCommits.sequence, floor),
      )),
    );
    const operationIds = prunable.map((entry) => entry.operation_id);
    if (operationIds.length === 0) return;
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(humanCryptoDeviceGroupWelcomes).where(
        inArray(humanCryptoDeviceGroupWelcomes.operationId, operationIds),
      ),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(humanCryptoDeviceGroupJoinRequests).where(and(
        inArray(humanCryptoDeviceGroupJoinRequests.operationId, operationIds),
        eq(humanCryptoDeviceGroupJoinRequests.state, "consumed"),
      )),
    );
    await executeTypedCryptoQuery(
      transaction,
      cryptoTypedDb.delete(humanCryptoDeviceGroupCommits).where(and(
        eq(humanCryptoDeviceGroupCommits.humanId, input.humanId),
        eq(
          humanCryptoDeviceGroupCommits.lineageGeneration,
          input.lineageGeneration,
        ),
        lte(humanCryptoDeviceGroupCommits.sequence, floor),
      )),
    );
  }
}
