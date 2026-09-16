import {
  and,
  eq,
  humanCryptoDeviceAdmissionChallenges,
  humanCryptoDeviceAdmissions,
  humanCryptoDeviceGroupHeads,
  humanCryptoDevices,
  inArray,
  isNull,
  lte,
} from "@nautilo/db";
import { randomUUID } from "node:crypto";
import {
  LatticeCrypto,
  decodeHumanDeviceRoster,
} from "@nautilo/lattice-crypto";
import {
  DEVICE_ADMISSION_CHALLENGE_TTL_MS,
  assertDeviceAdmissionChallenge,
  deviceAdmissionSigningBytes,
  verifyDeviceAdmissionProof,
  type DeviceAdmissionChallenge,
  type DeviceAdmissionProof,
} from "../../device/device-admission.ts";
import {
  assertVerifiedCryptoPostgresHandle,
  cryptoTypedDb,
  executeTypedCryptoQuery,
  withVerifiedCryptoPostgresTransaction,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "../storage/postgres-lattice-storage.ts";

export interface CurrentDeviceAdmissionAuthority {
  readonly userId: string;
  readonly humanActorId: string;
  readonly deviceId: string;
  readonly deviceGeneration: number;
  readonly signingPublicKey: Uint8Array;
  readonly serverInstanceId: string;
  readonly lineageGeneration: number;
  readonly epoch: number;
  readonly securityRevision: number;
  readonly headDigest: Uint8Array;
}

export type DeviceAdmissionStatus =
  | Readonly<{
      status: "admitted";
      deviceId: string;
      deviceGeneration: number;
      serverInstanceId: string;
      lineageGeneration: number;
      epoch: number;
      securityRevision: number;
      headDigest: Uint8Array;
      expiresAt: number;
    }>
  | Readonly<{
      status: "required";
      reason:
        | "device_admission_required"
        | "device_admission_expired"
        | "device_removed_or_stale";
    }>;

function counter(value: unknown, label: string): number {
  const decoded = typeof value === "bigint" || typeof value === "string"
    ? Number(value)
    : value;
  if (
    typeof decoded !== "number"
    || !Number.isSafeInteger(decoded)
    || decoded < 0
  ) {
    throw new Error(`device_admission_invalid_counter:${label}`);
  }
  return decoded;
}

function milliseconds(value: unknown): number {
  const date = value instanceof Date ? value : new Date(String(value));
  const result = date.getTime();
  if (!Number.isSafeInteger(result)) {
    throw new Error("device_admission_invalid_timestamp");
  }
  return result;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function challengeFromRow(row: {
  challenge_id: string;
  credential_digest: Uint8Array;
  user_id: string;
  human_actor_id: string;
  device_id: string;
  device_generation: number | bigint;
  server_instance_id: string;
  lineage_generation: number | bigint;
  epoch: number | bigint;
  security_revision: number | bigint;
  head_digest: Uint8Array;
  nonce: Uint8Array;
  issued_at: Date | string;
  expires_at: Date | string;
}): DeviceAdmissionChallenge {
  const challenge = Object.freeze({
    formatVersion: 1 as const,
    challengeId: row.challenge_id,
    credentialDigest: row.credential_digest.slice(),
    userId: row.user_id,
    humanActorId: row.human_actor_id,
    deviceId: row.device_id,
    deviceGeneration: counter(row.device_generation, "device_generation"),
    serverInstanceId: row.server_instance_id,
    lineageGeneration: counter(row.lineage_generation, "lineage_generation"),
    epoch: counter(row.epoch, "epoch"),
    securityRevision: counter(row.security_revision, "security_revision"),
    headDigest: row.head_digest.slice(),
    nonce: row.nonce.slice(),
    issuedAt: milliseconds(row.issued_at),
    expiresAt: milliseconds(row.expires_at),
  });
  assertDeviceAdmissionChallenge(challenge);
  return challenge;
}

export class PostgresDeviceAdmissionRepository {
  constructor(
    private readonly handle: CryptoPostgresHandle,
    private readonly crypto = new LatticeCrypto(),
  ) {
    assertVerifiedCryptoPostgresHandle(handle);
  }

  private async reconcileExpiredWith(
    executor: CryptoPostgresExecutor,
    input: Readonly<{ now: number; limit: number }>,
  ): Promise<{ challenges: number; admissions: number }> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_024) {
      throw new TypeError("device_admission_invalid_reconciliation_limit");
    }
    const now = new Date(input.now);
    const expiredChallenges = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        challengeId: humanCryptoDeviceAdmissionChallenges.challengeId,
      }).from(humanCryptoDeviceAdmissionChallenges).where(
        lte(humanCryptoDeviceAdmissionChallenges.expiresAt, now),
      ).limit(input.limit),
    );
    if (expiredChallenges.length > 0) {
      await executeTypedCryptoQuery(
        executor,
        cryptoTypedDb.delete(humanCryptoDeviceAdmissionChallenges).where(
          inArray(
            humanCryptoDeviceAdmissionChallenges.challengeId,
            expiredChallenges.map((row) => row.challenge_id),
          ),
        ),
      );
    }
    const expiredAdmissions = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        credentialDigest: humanCryptoDeviceAdmissions.credentialDigest,
      }).from(humanCryptoDeviceAdmissions).where(
        lte(humanCryptoDeviceAdmissions.expiresAt, now),
      ).limit(input.limit),
    );
    if (expiredAdmissions.length > 0) {
      await executeTypedCryptoQuery(
        executor,
        cryptoTypedDb.delete(humanCryptoDeviceAdmissions).where(
          inArray(
            humanCryptoDeviceAdmissions.credentialDigest,
            expiredAdmissions.map((row) => row.credential_digest),
          ),
        ),
      );
    }
    return Object.freeze({
      challenges: expiredChallenges.length,
      admissions: expiredAdmissions.length,
    });
  }

  async reconcileExpired(input: Readonly<{
    now: number;
    limit?: number;
  }>): Promise<{ challenges: number; admissions: number }> {
    return this.reconcileExpiredWith(this.handle, {
      now: input.now,
      limit: input.limit ?? 256,
    });
  }

  private async currentAuthority(
    executor: CryptoPostgresExecutor,
    input: Readonly<{
      userId: string;
      humanActorId: string;
      deviceId: string;
    }>,
  ): Promise<CurrentDeviceAdmissionAuthority | null> {
    const rows = await executeTypedCryptoQuery(
      executor,
      cryptoTypedDb.select({
        userId: humanCryptoDevices.userId,
        humanActorId: humanCryptoDevices.humanActorId,
        deviceId: humanCryptoDevices.deviceId,
        deviceGeneration: humanCryptoDevices.deviceGeneration,
        signingPublicKey: humanCryptoDevices.signingPublicKey,
        installationLineageDigest:
          humanCryptoDevices.installationLineageDigest,
        membershipServerInstanceId:
          humanCryptoDevices.membershipServerInstanceId,
        membershipLineageGeneration:
          humanCryptoDevices.membershipLineageGeneration,
        membershipEpoch: humanCryptoDevices.membershipEpoch,
        membershipSecurityRevision:
          humanCryptoDevices.membershipSecurityRevision,
        membershipHeadDigest: humanCryptoDevices.membershipHeadDigest,
        serverInstanceId: humanCryptoDeviceGroupHeads.serverInstanceId,
        lineageGeneration: humanCryptoDeviceGroupHeads.lineageGeneration,
        epoch: humanCryptoDeviceGroupHeads.epoch,
        securityRevision: humanCryptoDeviceGroupHeads.securityRevision,
        headDigest: humanCryptoDeviceGroupHeads.headDigest,
        rosterBytes: humanCryptoDeviceGroupHeads.rosterBytes,
      }).from(humanCryptoDevices).innerJoin(
        humanCryptoDeviceGroupHeads,
        eq(humanCryptoDeviceGroupHeads.humanId, humanCryptoDevices.humanId),
      ).where(and(
        eq(humanCryptoDevices.userId, input.userId),
        eq(humanCryptoDevices.humanActorId, input.humanActorId),
        eq(humanCryptoDevices.humanId, input.humanActorId),
        eq(humanCryptoDevices.deviceId, input.deviceId),
        eq(humanCryptoDevices.state, "active"),
        eq(humanCryptoDevices.membershipState, "current"),
      )).limit(2),
    );
    if (rows.length !== 1) return null;
    const row = rows[0]!;
    if (
      row.membership_server_instance_id === null
      || row.membership_lineage_generation === null
      || row.membership_epoch === null
      || row.membership_security_revision === null
      || row.membership_head_digest === null
      || row.membership_server_instance_id !== row.server_instance_id
      || counter(row.membership_lineage_generation, "membership_lineage")
        !== counter(row.lineage_generation, "head_lineage")
      || counter(row.membership_epoch, "membership_epoch")
        !== counter(row.epoch, "head_epoch")
      || counter(row.membership_security_revision, "membership_revision")
        !== counter(row.security_revision, "head_revision")
      || !sameBytes(row.membership_head_digest, row.head_digest)
    ) return null;

    const deviceGeneration = counter(row.device_generation, "device_generation");
    const roster = decodeHumanDeviceRoster(row.roster_bytes);
    const member = roster.find((entry) =>
      entry.deviceId === row.device_id
      && entry.deviceKeyGeneration === deviceGeneration
      && entry.serverInstanceId === row.server_instance_id
      && entry.humanId === input.humanActorId
      && entry.lineageGeneration
        === counter(row.lineage_generation, "roster_lineage")
      && sameBytes(
        entry.installationLineageDigest,
        row.installation_lineage_digest,
      )
    );
    if (!member) return null;

    return Object.freeze({
      userId: row.user_id,
      humanActorId: row.human_actor_id,
      deviceId: row.device_id,
      deviceGeneration,
      signingPublicKey: row.signing_public_key.slice(),
      serverInstanceId: row.server_instance_id,
      lineageGeneration: counter(row.lineage_generation, "lineage_generation"),
      epoch: counter(row.epoch, "epoch"),
      securityRevision: counter(row.security_revision, "security_revision"),
      headDigest: row.head_digest.slice(),
    });
  }

  async issueChallenge(input: Readonly<{
    credentialDigest: Uint8Array;
    credentialExpiresAt: number;
    userId: string;
    humanActorId: string;
    deviceId: string;
    now: number;
  }>): Promise<DeviceAdmissionChallenge | null> {
    return withVerifiedCryptoPostgresTransaction(this.handle, async (transaction) => {
      const now = new Date(input.now);
      await this.reconcileExpiredWith(transaction, {
        now: input.now,
        limit: 256,
      });
      const authority = await this.currentAuthority(transaction, input);
      if (!authority) return null;

      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceAdmissionChallenges).set({
          invalidatedAt: now,
        }).where(and(
          eq(
            humanCryptoDeviceAdmissionChallenges.credentialDigest,
            input.credentialDigest,
          ),
          isNull(humanCryptoDeviceAdmissionChallenges.consumedAt),
          isNull(humanCryptoDeviceAdmissionChallenges.invalidatedAt),
        )),
      );

      const expiresAt = Math.min(
        input.credentialExpiresAt,
        input.now + DEVICE_ADMISSION_CHALLENGE_TTL_MS,
      );
      if (expiresAt <= input.now) return null;
      const challenge = Object.freeze({
        formatVersion: 1 as const,
        challengeId: randomUUID(),
        credentialDigest: input.credentialDigest.slice(),
        userId: input.userId,
        humanActorId: input.humanActorId,
        deviceId: input.deviceId,
        deviceGeneration: authority.deviceGeneration,
        serverInstanceId: authority.serverInstanceId,
        lineageGeneration: authority.lineageGeneration,
        epoch: authority.epoch,
        securityRevision: authority.securityRevision,
        headDigest: authority.headDigest.slice(),
        nonce: this.crypto.randomBytes(32),
        issuedAt: input.now,
        expiresAt,
      });
      assertDeviceAdmissionChallenge(challenge);
      const challengeHash = this.crypto.hash(
        deviceAdmissionSigningBytes(challenge),
      );
      const inserted = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceAdmissionChallenges).values({
          challengeId: challenge.challengeId,
          challengeHash,
          credentialDigest: challenge.credentialDigest,
          userId: challenge.userId,
          humanActorId: challenge.humanActorId,
          deviceId: challenge.deviceId,
          deviceGeneration: challenge.deviceGeneration,
          serverInstanceId: challenge.serverInstanceId,
          lineageGeneration: challenge.lineageGeneration,
          epoch: challenge.epoch,
          securityRevision: challenge.securityRevision,
          headDigest: challenge.headDigest,
          nonce: challenge.nonce,
          issuedAt: new Date(challenge.issuedAt),
          expiresAt: new Date(challenge.expiresAt),
        }).onConflictDoNothing().returning({
          challengeId: humanCryptoDeviceAdmissionChallenges.challengeId,
        }),
      );
      if (inserted.length === 1) return challenge;

      // Another request using the same credential may have won the partial
      // unique-index race after our invalidation statement. Return that one
      // live challenge only when it targets the same current device; never
      // manufacture a second challenge or leak a challenge for another device.
      const concurrent = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          challengeId: humanCryptoDeviceAdmissionChallenges.challengeId,
          credentialDigest: humanCryptoDeviceAdmissionChallenges.credentialDigest,
          userId: humanCryptoDeviceAdmissionChallenges.userId,
          humanActorId: humanCryptoDeviceAdmissionChallenges.humanActorId,
          deviceId: humanCryptoDeviceAdmissionChallenges.deviceId,
          deviceGeneration: humanCryptoDeviceAdmissionChallenges.deviceGeneration,
          serverInstanceId: humanCryptoDeviceAdmissionChallenges.serverInstanceId,
          lineageGeneration: humanCryptoDeviceAdmissionChallenges.lineageGeneration,
          epoch: humanCryptoDeviceAdmissionChallenges.epoch,
          securityRevision: humanCryptoDeviceAdmissionChallenges.securityRevision,
          headDigest: humanCryptoDeviceAdmissionChallenges.headDigest,
          nonce: humanCryptoDeviceAdmissionChallenges.nonce,
          issuedAt: humanCryptoDeviceAdmissionChallenges.issuedAt,
          expiresAt: humanCryptoDeviceAdmissionChallenges.expiresAt,
        }).from(humanCryptoDeviceAdmissionChallenges).where(and(
          eq(
            humanCryptoDeviceAdmissionChallenges.credentialDigest,
            input.credentialDigest,
          ),
          eq(humanCryptoDeviceAdmissionChallenges.deviceId, input.deviceId),
          isNull(humanCryptoDeviceAdmissionChallenges.consumedAt),
          isNull(humanCryptoDeviceAdmissionChallenges.invalidatedAt),
        )),
      );
      return concurrent.length === 1 ? challengeFromRow(concurrent[0]!) : null;
    });
  }

  async admit(input: Readonly<{
    credentialDigest: Uint8Array;
    credentialExpiresAt: number;
    userId: string;
    humanActorId: string;
    proof: DeviceAdmissionProof;
    now: number;
  }>): Promise<"admitted" | "invalid"> {
    return withVerifiedCryptoPostgresTransaction(this.handle, async (transaction) => {
      const rows = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.select({
          challengeId: humanCryptoDeviceAdmissionChallenges.challengeId,
          challengeHash: humanCryptoDeviceAdmissionChallenges.challengeHash,
          credentialDigest:
            humanCryptoDeviceAdmissionChallenges.credentialDigest,
          userId: humanCryptoDeviceAdmissionChallenges.userId,
          humanActorId: humanCryptoDeviceAdmissionChallenges.humanActorId,
          deviceId: humanCryptoDeviceAdmissionChallenges.deviceId,
          deviceGeneration:
            humanCryptoDeviceAdmissionChallenges.deviceGeneration,
          serverInstanceId:
            humanCryptoDeviceAdmissionChallenges.serverInstanceId,
          lineageGeneration:
            humanCryptoDeviceAdmissionChallenges.lineageGeneration,
          epoch: humanCryptoDeviceAdmissionChallenges.epoch,
          securityRevision:
            humanCryptoDeviceAdmissionChallenges.securityRevision,
          headDigest: humanCryptoDeviceAdmissionChallenges.headDigest,
          nonce: humanCryptoDeviceAdmissionChallenges.nonce,
          issuedAt: humanCryptoDeviceAdmissionChallenges.issuedAt,
          expiresAt: humanCryptoDeviceAdmissionChallenges.expiresAt,
          consumedAt: humanCryptoDeviceAdmissionChallenges.consumedAt,
          invalidatedAt: humanCryptoDeviceAdmissionChallenges.invalidatedAt,
        }).from(humanCryptoDeviceAdmissionChallenges).where(and(
          eq(
            humanCryptoDeviceAdmissionChallenges.challengeId,
            input.proof.challengeId,
          ),
          eq(
            humanCryptoDeviceAdmissionChallenges.credentialDigest,
            input.credentialDigest,
          ),
          eq(humanCryptoDeviceAdmissionChallenges.userId, input.userId),
          eq(
            humanCryptoDeviceAdmissionChallenges.humanActorId,
            input.humanActorId,
          ),
        )),
      );
      if (rows.length !== 1) return "invalid";
      const row = rows[0]!;
      if (
        row.invalidated_at !== null
        || milliseconds(row.expires_at) <= input.now
        || input.credentialExpiresAt <= input.now
      ) return "invalid";
      const stored = challengeFromRow(row);
      const proofBytes = deviceAdmissionSigningBytes(input.proof);
      const storedBytes = deviceAdmissionSigningBytes(stored);
      if (
        !sameBytes(proofBytes, storedBytes)
        || !sameBytes(this.crypto.hash(proofBytes), row.challenge_hash)
      ) return "invalid";

      const authority = await this.currentAuthority(transaction, {
        userId: input.userId,
        humanActorId: input.humanActorId,
        deviceId: stored.deviceId,
      });
      if (
        !authority
        || authority.deviceGeneration !== stored.deviceGeneration
        || authority.serverInstanceId !== stored.serverInstanceId
        || authority.lineageGeneration !== stored.lineageGeneration
        || authority.epoch !== stored.epoch
        || authority.securityRevision !== stored.securityRevision
        || !sameBytes(authority.headDigest, stored.headDigest)
        || !verifyDeviceAdmissionProof({
          crypto: this.crypto,
          proof: input.proof,
          signingPublicKey: authority.signingPublicKey,
        })
      ) return "invalid";

      const matchesExistingAdmission = async (
        currentAuthority: CurrentDeviceAdmissionAuthority,
      ): Promise<boolean> => {
        const existing = await executeTypedCryptoQuery(
          transaction,
          cryptoTypedDb.select({
            deviceId: humanCryptoDeviceAdmissions.deviceId,
            deviceGeneration: humanCryptoDeviceAdmissions.deviceGeneration,
            serverInstanceId: humanCryptoDeviceAdmissions.serverInstanceId,
            lineageGeneration: humanCryptoDeviceAdmissions.lineageGeneration,
            epoch: humanCryptoDeviceAdmissions.epoch,
            securityRevision: humanCryptoDeviceAdmissions.securityRevision,
            headDigest: humanCryptoDeviceAdmissions.headDigest,
            expiresAt: humanCryptoDeviceAdmissions.expiresAt,
          }).from(humanCryptoDeviceAdmissions).where(and(
            eq(
              humanCryptoDeviceAdmissions.credentialDigest,
              input.credentialDigest,
            ),
            eq(humanCryptoDeviceAdmissions.userId, input.userId),
            eq(
              humanCryptoDeviceAdmissions.humanActorId,
              input.humanActorId,
            ),
          )),
        );
        if (existing.length !== 1) return false;
        const admission = existing[0]!;
        return admission.device_id === currentAuthority.deviceId
          && counter(admission.device_generation, "device_generation")
            === currentAuthority.deviceGeneration
          && admission.server_instance_id === currentAuthority.serverInstanceId
          && counter(admission.lineage_generation, "lineage_generation")
            === currentAuthority.lineageGeneration
          && counter(admission.epoch, "epoch") === currentAuthority.epoch
          && counter(admission.security_revision, "security_revision")
            === currentAuthority.securityRevision
          && sameBytes(admission.head_digest, currentAuthority.headDigest)
          && milliseconds(admission.expires_at) > input.now;
      };

      // A response can be lost after the transaction commits. Re-observing the
      // same valid proof is therefore idempotent, while the challenge remains
      // single-use for creating or changing admission authority.
      if (row.consumed_at !== null) {
        return await matchesExistingAdmission(authority)
          ? "admitted"
          : "invalid";
      }

      const consumed = await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.update(humanCryptoDeviceAdmissionChallenges).set({
          consumedAt: new Date(input.now),
        }).where(and(
          eq(
            humanCryptoDeviceAdmissionChallenges.challengeId,
            stored.challengeId,
          ),
          isNull(humanCryptoDeviceAdmissionChallenges.consumedAt),
          isNull(humanCryptoDeviceAdmissionChallenges.invalidatedAt),
        )).returning({
          challengeId: humanCryptoDeviceAdmissionChallenges.challengeId,
        }),
      );
      if (consumed.length !== 1) {
        // A concurrent replay can observe the challenge before the winner
        // consumes it, then lose this compare-and-set after that winner commits.
        // Re-read both authorities after the row-lock wait instead of reporting
        // the same exact proof as invalid merely because this transaction lost.
        const currentAuthority = await this.currentAuthority(transaction, {
          userId: input.userId,
          humanActorId: input.humanActorId,
          deviceId: stored.deviceId,
        });
        return currentAuthority !== null
            && currentAuthority.deviceId === authority.deviceId
            && currentAuthority.deviceGeneration === authority.deviceGeneration
            && currentAuthority.serverInstanceId === authority.serverInstanceId
            && currentAuthority.lineageGeneration === authority.lineageGeneration
            && currentAuthority.epoch === authority.epoch
            && currentAuthority.securityRevision === authority.securityRevision
            && sameBytes(currentAuthority.headDigest, authority.headDigest)
            && await matchesExistingAdmission(currentAuthority)
          ? "admitted"
          : "invalid";
      }

      await executeTypedCryptoQuery(
        transaction,
        cryptoTypedDb.insert(humanCryptoDeviceAdmissions).values({
          credentialDigest: input.credentialDigest,
          userId: input.userId,
          humanActorId: input.humanActorId,
          deviceId: authority.deviceId,
          deviceGeneration: authority.deviceGeneration,
          serverInstanceId: authority.serverInstanceId,
          lineageGeneration: authority.lineageGeneration,
          epoch: authority.epoch,
          securityRevision: authority.securityRevision,
          headDigest: authority.headDigest,
          admittedAt: new Date(input.now),
          expiresAt: new Date(input.credentialExpiresAt),
        }).onConflictDoUpdate({
          target: humanCryptoDeviceAdmissions.credentialDigest,
          set: {
            userId: input.userId,
            humanActorId: input.humanActorId,
            deviceId: authority.deviceId,
            deviceGeneration: authority.deviceGeneration,
            serverInstanceId: authority.serverInstanceId,
            lineageGeneration: authority.lineageGeneration,
            epoch: authority.epoch,
            securityRevision: authority.securityRevision,
            headDigest: authority.headDigest,
            admittedAt: new Date(input.now),
            expiresAt: new Date(input.credentialExpiresAt),
          },
        }),
      );
      return "admitted";
    });
  }

  async status(input: Readonly<{
    credentialDigest: Uint8Array;
    userId: string;
    humanActorId: string;
    now: number;
  }>): Promise<DeviceAdmissionStatus> {
    const rows = await executeTypedCryptoQuery(
      this.handle,
      cryptoTypedDb.select({
        userId: humanCryptoDeviceAdmissions.userId,
        humanActorId: humanCryptoDeviceAdmissions.humanActorId,
        deviceId: humanCryptoDeviceAdmissions.deviceId,
        deviceGeneration: humanCryptoDeviceAdmissions.deviceGeneration,
        serverInstanceId: humanCryptoDeviceAdmissions.serverInstanceId,
        lineageGeneration: humanCryptoDeviceAdmissions.lineageGeneration,
        epoch: humanCryptoDeviceAdmissions.epoch,
        securityRevision: humanCryptoDeviceAdmissions.securityRevision,
        headDigest: humanCryptoDeviceAdmissions.headDigest,
        expiresAt: humanCryptoDeviceAdmissions.expiresAt,
      }).from(humanCryptoDeviceAdmissions).where(and(
        eq(humanCryptoDeviceAdmissions.credentialDigest, input.credentialDigest),
        eq(humanCryptoDeviceAdmissions.userId, input.userId),
        eq(humanCryptoDeviceAdmissions.humanActorId, input.humanActorId),
      )),
    );
    if (rows.length !== 1) {
      return Object.freeze({
        status: "required",
        reason: "device_admission_required",
      });
    }
    if (milliseconds(rows[0]!.expires_at) <= input.now) {
      await executeTypedCryptoQuery(
        this.handle,
        cryptoTypedDb.delete(humanCryptoDeviceAdmissions).where(
          eq(humanCryptoDeviceAdmissions.credentialDigest, input.credentialDigest),
        ),
      );
      return Object.freeze({
        status: "required",
        reason: "device_admission_expired",
      });
    }
    const row = rows[0]!;
    const authority = await this.currentAuthority(this.handle, {
      userId: input.userId,
      humanActorId: input.humanActorId,
      deviceId: row.device_id,
    });
    if (
      !authority
      || authority.deviceGeneration
        !== counter(row.device_generation, "device_generation")
      || authority.serverInstanceId !== row.server_instance_id
      || authority.lineageGeneration
        !== counter(row.lineage_generation, "lineage_generation")
      || authority.epoch !== counter(row.epoch, "epoch")
      || authority.securityRevision
        !== counter(row.security_revision, "security_revision")
      || !sameBytes(authority.headDigest, row.head_digest)
    ) {
      return Object.freeze({
        status: "required",
        reason: "device_removed_or_stale",
      });
    }
    return Object.freeze({
      status: "admitted",
      deviceId: authority.deviceId,
      deviceGeneration: authority.deviceGeneration,
      serverInstanceId: authority.serverInstanceId,
      lineageGeneration: authority.lineageGeneration,
      epoch: authority.epoch,
      securityRevision: authority.securityRevision,
      headDigest: authority.headDigest.slice(),
      expiresAt: milliseconds(row.expires_at),
    });
  }

  async currentAuthorityForDelegation(input: Readonly<{
    userId: string;
    humanActorId: string;
    deviceId: string;
  }>): Promise<CurrentDeviceAdmissionAuthority | null> {
    return this.currentAuthority(this.handle, input);
  }
}
