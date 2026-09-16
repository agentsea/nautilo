import { describe, expect, test } from "bun:test";
import type {
  NautiloActorId,
  NautiloUserId,
  PendingAdditionalDeviceEnrollment,
} from "../../src/index.ts";
import {
  PostgresAdditionalDeviceEnrollmentRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedCryptoConnection implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  transactionCount = 0;
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (
      parameters.some(
        (value) =>
          typeof value === "string"
          && value.startsWith("crypto-human-operation-capacity/"),
      )
      || statement.includes(
        "LEFT JOIN crypto_human_membership_transitions membership",
      )
    ) {
      return Promise.resolve([]);
    }
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    return callback(this);
  }
}

const USER_ID =
  "00000000-0000-4000-8000-00000000000a" as NautiloUserId;
const ACTOR_ID =
  "00000000-0000-4000-8000-00000000000b" as NautiloActorId;
const LINEAGE = new Uint8Array(32).fill(0x31);
const AUTHORIZATION = new Uint8Array(32).fill(0x41);
const SIGNING_KEY = new Uint8Array(32).fill(0x51);
const ENCRYPTION_KEY = new Uint8Array(65).fill(0x61);
const INVENTORY = new Uint8Array(32).fill(0x71);
const CHALLENGE_HASH = new Uint8Array(32).fill(0x81);
const FINGERPRINT = new Uint8Array(32).fill(0x91);
const SIGNING_DIGEST = new Uint8Array(32).fill(0xa1);
const ENCRYPTION_DIGEST = new Uint8Array(32).fill(0xb1);

const enrollment: PendingAdditionalDeviceEnrollment = {
  formatVersion: 1,
  userId: USER_ID,
  humanActorId: ACTOR_ID,
  deviceId: "device_alice_additional",
  clientKind: "electron",
  installationLineageDigest: LINEAGE,
  deviceGeneration: 1,
  signingPublicKey: SIGNING_KEY,
  encryptionPublicKey: ENCRYPTION_KEY,
  method: "device_approval",
  idempotencyKey: "additional_device_1",
  operationId: `device_operation_${"11".repeat(32)}`,
  challengeId: `device_challenge_${"22".repeat(32)}`,
  authorizationEvidenceDigest: new Uint8Array(32).fill(0x21),
  authorizationDigest: AUTHORIZATION,
  expectedCustodyRevision: 4,
  expectedRecoveryGeneration: 2,
  inventoryRevision: 8,
  inventoryCount: 2,
  inventoryDigest: INVENTORY,
  deviceRevision: 0,
  status: "pending",
  issuedAt: 10_000,
  expiresAt: 310_000,
};

async function repositoryWithResults(results: unknown[][]): Promise<{
  readonly connection: ScriptedCryptoConnection;
  readonly repository: PostgresAdditionalDeviceEnrollmentRepository;
}> {
  const connection = new ScriptedCryptoConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresAdditionalDeviceEnrollmentRepository(handle),
  };
}

describe("Postgres additional-device enrollment repository", () => {
  test("rejects an unverified database handle", () => {
    const forged = new ScriptedCryptoConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() => new PostgresAdditionalDeviceEnrollmentRepository(forged))
      .toThrow("verified nautilo_crypto handle");
  });

  test("creates only pending registry, operation, and challenge rows atomically", async () => {
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "active",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 4,
      }],
      [],
      [{
        active_device_count: 1,
        pending_device_count: 0,
        outstanding_operation_count: 0,
        live_device_roster_operation_count: 0,
      }],
      [{ device_id: enrollment.deviceId }],
      [{ operation_id: enrollment.operationId }],
      [{ challenge_id: enrollment.challengeId }],
    ]);

    expect(await setup.repository.begin({
      enrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).toEqual({
      status: "created",
      operationId: enrollment.operationId,
      challengeId: enrollment.challengeId,
      issuedAt: enrollment.issuedAt,
      expiresAt: enrollment.expiresAt,
    });
    expect(setup.connection.transactionCount).toBe(1);
    const sql = setup.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n");
    const normalizedSql = sql.replaceAll('"', "").toLowerCase();
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(normalizedSql).toContain("from users inner join actors");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("INSERT INTO human_crypto_devices");
    expect(sql).toContain("'pending'");
    expect(sql).not.toContain("'active', $");
    expect(sql).toContain("INSERT INTO crypto_delivery_operations");
    expect(sql).toContain("INSERT INTO human_crypto_device_challenges");
    expect(sql).not.toContain("SELECT *");
    expect(setup.connection.queries.some(({ statement, parameters }) =>
      statement.includes("pg_advisory_xact_lock")
      && parameters[0]
        === `crypto-human-operation-capacity/${ACTOR_ID}`
    )).toBe(true);
  });

  test("rejects stale custody before any insert", async () => {
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "active",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 5,
      }],
    ]);

    expect(await setup.repository.begin({
      enrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).toEqual({ status: "stale_state" });
    expect(
      setup.connection.queries.some((query) =>
        query.statement.includes("INSERT INTO")
      ),
    ).toBe(false);
  });

  test("admits the canonical empty inventory while custody remains uninitialized", async () => {
    const emptyEnrollment: PendingAdditionalDeviceEnrollment = {
      ...enrollment,
      expectedCustodyRevision: 3,
      inventoryRevision: 0,
      inventoryCount: 0,
      inventoryDigest: new Uint8Array(32).fill(0xc1),
    };
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "active",
        current_recovery_generation: 2,
        current_inventory_revision: null,
        current_inventory_count: null,
        current_inventory_digest: null,
        revision: 3,
      }],
      [],
      [{
        active_device_count: 1,
        pending_device_count: 0,
        outstanding_operation_count: 0,
        live_device_roster_operation_count: 0,
      }],
      [{ device_id: emptyEnrollment.deviceId }],
      [{ operation_id: emptyEnrollment.operationId }],
      [{ challenge_id: emptyEnrollment.challengeId }],
    ]);

    expect((await setup.repository.begin({
      enrollment: emptyEnrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).status).toBe("created");
  });

  test("admits identity-only V2 enrollment without matching populated custody inventory", async () => {
    const identityOnlyEnrollment: PendingAdditionalDeviceEnrollment = {
      ...enrollment,
      inventoryRevision: 0,
      inventoryCount: 0,
      inventoryDigest: new Uint8Array(32).fill(0xc2),
    };
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "active",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 4,
      }],
      [],
      [{
        active_device_count: 1,
        pending_device_count: 0,
        outstanding_operation_count: 0,
        live_device_roster_operation_count: 0,
      }],
      [{ device_id: identityOnlyEnrollment.deviceId }],
      [{ operation_id: identityOnlyEnrollment.operationId }],
      [{ challenge_id: identityOnlyEnrollment.challengeId }],
    ]);

    expect((await setup.repository.begin({
      enrollment: identityOnlyEnrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).status).toBe("created");
  });

  test("refreshes only an expired pristine enrollment attempt", async () => {
    const priorOperationId = `device_operation_${"33".repeat(32)}`;
    const priorChallengeId = `device_challenge_${"44".repeat(32)}`;
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [{
        challenge_id: priorChallengeId,
        challenge_hash: new Uint8Array(32).fill(0xc1),
        challenge_kind: "device_approval",
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        installation_lineage_digest: LINEAGE,
        authorization_digest: AUTHORIZATION,
        pending_device_id: enrollment.deviceId,
        signing_public_key_digest: SIGNING_DIGEST,
        encryption_public_key_digest: ENCRYPTION_DIGEST,
        expected_custody_revision: 4,
        expected_recovery_generation: 2,
        idempotency_key: enrollment.idempotencyKey,
        issued_at_ms: 1_000,
        expires_at_ms: 5_000,
        client_kind: "electron",
        device_generation: 1,
        signing_public_key: SIGNING_KEY,
        encryption_public_key: ENCRYPTION_KEY,
        public_fingerprint: FINGERPRINT,
        device_state: "pending",
        device_revision: 0,
        key_package_count: 0,
        operation_id: priorOperationId,
        operation_kind: "device_add",
        operation_state: "awaiting_committer",
        operation_payload_bytes: 0,
        operation_fanout_row_count: 0,
        challenge_consumed_at: null,
        challenge_invalidated_at: null,
      }],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "active",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 4,
      }],
      [{ operation_id: priorOperationId }],
      [{ challenge_id: priorChallengeId }],
    ]);

    expect(await setup.repository.begin({
      enrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).toEqual({
      status: "duplicate",
      operationId: priorOperationId,
      challengeId: priorChallengeId,
      issuedAt: enrollment.issuedAt,
      expiresAt: enrollment.expiresAt,
    });
    const sql = setup.connection.queries.map((query) => query.statement)
      .join("\n");
    expect(sql).toContain("UPDATE crypto_delivery_operations");
    expect(sql).toContain("UPDATE human_crypto_device_challenges");
    expect(sql).not.toContain("INSERT INTO human_crypto_devices");
    expect(sql).not.toContain("INSERT INTO crypto_delivery_operations");
  });

  test("resumes the exact approved enrollment after its comparison challenge expires", async () => {
    const priorOperationId = `device_operation_${"33".repeat(32)}`;
    const priorChallengeId = `device_challenge_${"44".repeat(32)}`;
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [{
        challenge_id: priorChallengeId,
        challenge_hash: new Uint8Array(32).fill(0xc1),
        challenge_kind: "device_approval",
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        installation_lineage_digest: LINEAGE,
        authorization_digest: AUTHORIZATION,
        pending_device_id: enrollment.deviceId,
        signing_public_key_digest: SIGNING_DIGEST,
        encryption_public_key_digest: ENCRYPTION_DIGEST,
        expected_custody_revision: 4,
        expected_recovery_generation: 2,
        idempotency_key: enrollment.idempotencyKey,
        issued_at_ms: 1_000,
        expires_at_ms: 5_000,
        client_kind: "electron",
        device_generation: 1,
        signing_public_key: SIGNING_KEY,
        encryption_public_key: ENCRYPTION_KEY,
        public_fingerprint: FINGERPRINT,
        device_state: "pending",
        device_revision: 2,
        key_package_count: 0,
        operation_id: priorOperationId,
        operation_kind: "device_add",
        operation_state: "awaiting_delivery",
        operation_payload_bytes: 22_507,
        operation_fanout_row_count: 3,
        challenge_consumed_at: null,
        challenge_invalidated_at: null,
      }],
    ]);

    expect(await setup.repository.begin({
      enrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).toEqual({
      status: "duplicate",
      operationId: priorOperationId,
      challengeId: priorChallengeId,
      issuedAt: 1_000,
      expiresAt: 5_000,
    });
    const sql = setup.connection.queries.map((query) => query.statement)
      .join("\n");
    expect(sql).not.toContain("UPDATE crypto_delivery_operations");
    expect(sql).not.toContain("UPDATE human_crypto_device_challenges");
    expect(sql).not.toContain("INSERT INTO human_crypto_devices");
  });

  test("admits recovery from recovery-required custody but not approval", async () => {
    const recovery = { ...enrollment, method: "recovery" as const };
    const setup = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "recovery_required",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 4,
      }],
      [],
      [{
        active_device_count: 0,
        pending_device_count: 0,
        outstanding_operation_count: 0,
        live_device_roster_operation_count: 0,
      }],
      [{ device_id: recovery.deviceId }],
      [{ operation_id: recovery.operationId }],
      [{ challenge_id: recovery.challengeId }],
    ]);
    expect((await setup.repository.begin({
      enrollment: recovery,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).status).toBe("created");

    const approval = await repositoryWithResults([
      [],
      [],
      [{
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        actor_owner_id: USER_ID,
        actor_kind: "user",
      }],
      [],
      [{
        human_id: ACTOR_ID,
        user_id: USER_ID,
        human_actor_id: ACTOR_ID,
        state: "recovery_required",
        current_recovery_generation: 2,
        current_inventory_revision: 8,
        current_inventory_count: 2,
        current_inventory_digest: INVENTORY,
        revision: 4,
      }],
    ]);
    expect((await approval.repository.begin({
      enrollment,
      challengeHash: CHALLENGE_HASH,
      publicFingerprint: FINGERPRINT,
      signingPublicKeyDigest: SIGNING_DIGEST,
      encryptionPublicKeyDigest: ENCRYPTION_DIGEST,
    })).status).toBe("stale_state");
  });
});
