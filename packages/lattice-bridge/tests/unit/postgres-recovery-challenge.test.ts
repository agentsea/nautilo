import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeRecoveryDeviceActivationChallengeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  PostgresRecoveryChallengeRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly parameters: readonly unknown[][] = [];
  readonly #results: unknown[][];

  constructor(results: unknown[][]) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    (this.parameters as unknown[][]).push([...parameters]);
    if (
      statement.includes(
        "SELECT d.device_id, d.state, d.delivery_sequence_high_watermark",
      )
    ) {
      return Promise.resolve(
        (parameters[0] as string[]).map((deviceId) => ({
          device_id: deviceId,
          state: "pending",
          delivery_sequence_high_watermark: 0,
          delivery_acknowledged_sequence: 0,
          delivery_blocked_sequence: null,
          delivery_blocked_operation_id: null,
          delivery_blocked_at: null,
          delivery_blocked_reason: null,
          first_unresolved_expires_at_ms: null,
        })) as Row[],
      );
    }
    if (
      statement.includes(
        "SET delivery_sequence_high_watermark = $2",
      )
    ) {
      return Promise.resolve([{ device_id: parameters[0] }] as Row[]);
    }
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresRecoveryChallengeRepository({
      handle,
      crypto: new LatticeCrypto(),
    }),
  };
}

async function pendingState(overrides: Record<string, unknown> = {}) {
  const crypto = new LatticeCrypto();
  const pendingSigning = crypto.generateSigningKeyPair();
  const pendingEncryption = await crypto.generateEncryptionKeyPair();
  const recovery = await crypto.createRecoveryKit();
  const inventoryDigest = crypto.hash(
    new TextEncoder().encode("inventory"),
  );
  const archiveBytes = new TextEncoder().encode("opaque recovery archive");
  const archiveHash = crypto.hash(archiveBytes);
  return {
    row: {
      operation_id: "device_operation_recovery",
      operation_kind: "device_recovery",
      operation_state: "awaiting_target_device",
      operation_human_id: "human_alice",
      target_device_id: "device_alice_recovered",
      operation_expected_custody_revision: 7,
      operation_expected_recovery_generation: 2,
      operation_expected_device_revision: 0,
      operation_participant_digest: inventoryDigest,
      operation_fanout_row_count: 0,
      operation_aggregate_payload_bytes: 0,
      challenge_id: "device_challenge_recovery",
      challenge_kind: "device_recovery",
      challenge_hash: crypto.hash(
        new TextEncoder().encode("device_challenge_recovery"),
      ),
      challenge_expected_response_digest: null,
      challenge_expected_custody_revision: 7,
      challenge_expected_recovery_generation: 2,
      challenge_consumed_at: null,
      challenge_invalidated_at: null,
      challenge_revision: 0,
      challenge_issued_at_ms: 10_000,
      challenge_expires_at_ms: 310_000,
      device_human_id: "human_alice",
      device_state: "pending",
      device_revision: 0,
      device_signing_public_key: pendingSigning.publicKey,
      device_encryption_public_key: pendingEncryption.publicKey,
      challenge_signing_public_key_digest: crypto.hash(
        pendingSigning.publicKey,
      ),
      challenge_encryption_public_key_digest: crypto.hash(
        pendingEncryption.publicKey,
      ),
      custody_state: "active",
      custody_revision: 7,
      custody_recovery_generation: 2,
      custody_recovery_public_key_digest: crypto.hash(recovery.publicKey),
      custody_inventory_revision: 8,
      custody_inventory_count: 1,
      custody_inventory_digest: inventoryDigest,
      recovery_key_id: recovery.keyId,
      recovery_key_generation: 2,
      recovery_public_key: recovery.publicKey,
      recovery_public_key_digest: crypto.hash(recovery.publicKey),
      recovery_key_archive_hash: archiveHash,
      recovery_key_state: "current",
      archive_generation: 2,
      archive_hash: archiveHash,
      archive_bytes: archiveBytes,
      ...overrides,
    },
  };
}

describe("Postgres recovery-device challenge publication", () => {
  test("publishes one encrypted core challenge and verifier atomically", async () => {
    const state = await pendingState();
    const setup = await repository([
      [],
      [],
      [state.row],
      [{ challenge_id: "device_challenge_recovery" }],
      [{ message_id: "message" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ outbox_id: "outbox" }],
    ]);
    const result = await setup.repository.publish({
      operationId: "device_operation_recovery",
      publishedAt: 20_000,
    });
    expect(result.status).toBe("published");
    expect(result.operationId).toBe("device_operation_recovery");
    const challenge = decodeRecoveryDeviceActivationChallengeV2(
      result.challengeBytes,
    );
    expect(challenge.challengeId).toBe("device_challenge_recovery");
    expect(String(challenge.humanId)).toBe("human_alice");
    expect(String(challenge.targetDeviceId)).toBe("device_alice_recovered");
    expect(Number(challenge.recoveryGeneration)).toBe(2);
    expect(Number(challenge.inventoryRevision)).toBe(8);
    expect(challenge.inventoryCount).toBe(1);

    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("UPDATE human_crypto_device_challenges");
    expect(sql).toContain("expected_response_digest");
    expect(sql).toContain("INSERT INTO crypto_delivery_messages");
    expect(sql).toContain("'recovery_challenge'");
    expect(sql).toContain("UPDATE crypto_delivery_operations");
    expect(sql).toContain("INSERT INTO crypto_operation_outbox");
    const messageInsert = setup.connection.statements.findIndex(
      (statement) =>
        statement.trim().startsWith("INSERT INTO crypto_delivery_messages"),
    );
    expect(setup.connection.parameters[messageInsert]?.[2]).toBe(1);
    expect(setup.connection.parameters[messageInsert]?.[3]).toBe(
      "device_alice_recovered",
    );

    const challengeUpdate = setup.connection.statements.findIndex(
      (statement) =>
        statement.includes("UPDATE human_crypto_device_challenges"),
    );
    const challengeHash = setup.connection.parameters[challengeUpdate]?.[1];
    const responseDigest = setup.connection.parameters[challengeUpdate]?.[2];
    expect(challengeHash).toBeInstanceOf(Uint8Array);
    expect(responseDigest).toBeInstanceOf(Uint8Array);
    const replayState = {
      ...state.row,
      operation_state: "awaiting_committer",
      operation_fanout_row_count: 1,
      operation_aggregate_payload_bytes: result.challengeBytes.length,
      challenge_hash: challengeHash,
      challenge_expected_response_digest: responseDigest,
      challenge_revision: 1,
    };
    const replay = await repository([
      [],
      [],
      [replayState],
      [{
        message_id: "message",
        payload_hash: challengeHash,
        payload_bytes: result.challengeBytes,
        expires_at_ms: 310_000,
      }],
    ]);
    expect(await replay.repository.publish({
      operationId: "device_operation_recovery",
      publishedAt: 20_000,
    })).toEqual({
      status: "duplicate",
      operationId: "device_operation_recovery",
      challengeId: "device_challenge_recovery",
      challengeBytes: result.challengeBytes,
      expiresAt: 310_000,
    });
    expect(
      replay.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });

  test("publishes while irreversibly initialized custody requires recovery", async () => {
    const state = await pendingState({ custody_state: "recovery_required" });
    const setup = await repository([
      [],
      [],
      [state.row],
      [{ challenge_id: "device_challenge_recovery" }],
      [{ message_id: "message" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await setup.repository.publish({
      operationId: "device_operation_recovery",
      publishedAt: 20_000,
    })).toMatchObject({ status: "published" });
  });

  test("rejects an expired challenge before any persistent mutation", async () => {
    const state = await pendingState();
    const setup = await repository([
      [],
      [],
      [state.row],
    ]);
    expect(setup.repository.publish({
      operationId: "device_operation_recovery",
      publishedAt: 310_000,
    })).rejects.toThrow("expired");
    expect(
      setup.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });
});
