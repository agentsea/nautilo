import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import postgres from "postgres";
import {
  type PostgresJsBridgeConnection,
  type PostgresJsBridgeExecutor,
} from "@nautilo/db";
import { withCurrentHumanDeviceSigningAuthority } from
  "../../src/server/device/postgres-current-human-device-signing-authority.ts";

const adminUrl = required("LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL");
const cryptoUrl = required("LATTICE_BRIDGE_TEST_DATABASE_URL");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function bridge(client: postgres.Sql): PostgresJsBridgeConnection {
  const executor = (sql: postgres.Sql): PostgresJsBridgeExecutor => ({
    query: async (statement, parameters = []) =>
      await sql.unsafe(statement, [...parameters] as postgres.ParameterOrJSON<never>[]),
  });
  return {
    ...executor(client),
    transaction: async (callback) => (await client.begin(async (tx) =>
      [await callback(executor(tx))]))[0] as Awaited<ReturnType<typeof callback>>,
    transactionOnce: async (callback) => (await client.begin(async (tx) =>
      [await callback(executor(tx))]))[0] as Awaited<ReturnType<typeof callback>>,
  };
}

test("crypto role holds current Human device and custody authority through publication", async () => {
  const admin = postgres(adminUrl, { max: 2, prepare: false });
  const restricted = postgres(cryptoUrl, { max: 1, prepare: false });
  const suffix = randomUUID();
  const userId = randomUUID();
  const humanActorId = randomUUID();
  const humanId = `m318-authority-human-${suffix}`;
  const deviceId = `m318-authority-device-${suffix}`;
  const now = new Date();
  try {
    await admin.begin(async (tx) => {
      await tx.unsafe("INSERT INTO users (id, name) VALUES ($1, 'M318 authority fixture')", [userId]);
      await tx.unsafe(
        `INSERT INTO actors (
           id, owner_id, display_name, trust_state, kind, agent_id
         ) VALUES ($1, $2, 'M318 authority Human', 'verified', 'user', NULL)`,
        [humanActorId, userId],
      );
      await tx.unsafe(
        `INSERT INTO human_crypto_custodies (
           human_id, user_id, human_actor_id,
           initial_installation_lineage_digest, state, ever_initialized_at,
           first_device_id, current_recovery_generation,
           current_recovery_public_key_digest, revision, created_at, updated_at
         ) VALUES ($1, $2, $3, $4, 'active', $5, $6, 1, $7, 1, $5, $5)`,
        [humanId, userId, humanActorId, new Uint8Array(32).fill(0x31), now,
          deviceId, new Uint8Array(32).fill(0x32)],
      );
      await tx.unsafe(
        `INSERT INTO human_crypto_devices (
           device_id, human_id, user_id, human_actor_id, client_kind,
           installation_lineage_digest, device_generation,
           signing_public_key, encryption_public_key, public_fingerprint,
           state, authorization_kind, recovery_generation,
           authorization_evidence_digest, key_package_generation,
           key_package_count, revision, created_at, activated_at
         ) VALUES ($1, $2, $3, $4, 'browser', $5, 1, $6, $7, $8,
           'active', 'first_bootstrap', 1, $9, 1, 0, 1, $10, $10)`,
        [deviceId, humanId, userId, humanActorId,
          new Uint8Array(32).fill(0x33), new Uint8Array(32).fill(0x34),
          new Uint8Array(65).fill(0x35), new Uint8Array(32).fill(0x36),
          new Uint8Array(32).fill(0x37), now],
      );
    });
    let mutationSettled = false;
    let mutationOutcome: string | undefined;
    let mutation: Promise<string> | undefined;
    const result = await withCurrentHumanDeviceSigningAuthority(
      bridge(restricted),
      {
        subjectUserId: userId,
        subjectHumanId: humanId,
        humanActorId,
        deviceId,
        deviceSigningKeyGeneration: 1,
        hostAuthorizationRevision: 1,
      },
      async () => {
        mutation = admin.begin(async (tx) => {
          await tx.unsafe("SET LOCAL lock_timeout = '5s'");
          await tx.unsafe(
            "UPDATE human_crypto_devices SET revision = 2 WHERE device_id = $1",
            [deviceId],
          );
          throw new Error("rollback-authority-probe");
        }).then(() => "unexpected-commit", (error: unknown) =>
          error instanceof Error ? error.message : "unknown-error")
          .then((outcome) => {
            mutationOutcome = outcome;
            return outcome;
          }).finally(() => { mutationSettled = true; });
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect({ mutationSettled, mutationOutcome }).toEqual({
          mutationSettled: false,
          mutationOutcome: undefined,
        });
        return "published" as const;
      },
    );
    expect(result).toBe("published");
    if (mutation === undefined) throw new Error("authority mutation did not start");
    expect(await mutation).toBe("rollback-authority-probe");
  } finally {
    await admin.unsafe("DELETE FROM human_crypto_devices WHERE device_id = $1", [deviceId]);
    await admin.unsafe("DELETE FROM human_crypto_custodies WHERE human_id = $1", [humanId]);
    await admin.unsafe("DELETE FROM actors WHERE id = $1", [humanActorId]);
    await admin.unsafe("DELETE FROM users WHERE id = $1", [userId]);
    await restricted.end();
    await admin.end();
  }
});
