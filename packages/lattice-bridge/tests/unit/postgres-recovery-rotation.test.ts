import { describe, expect, test } from "bun:test";
import {
  recoveryRotationSubmissionSigningBytes,
} from "../../src/index.ts";
import {
  PostgresRecoveryRotationRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";
import {
  createRecoveryRotationFixture,
} from "../fixtures/recovery-rotation-fixture.ts";

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
    repository: new PostgresRecoveryRotationRepository(handle),
  };
}

function lockedState(input: {
  readonly archiveHash: Uint8Array;
  readonly currentPublicKey: Uint8Array;
  readonly currentPublicKeyDigest: Uint8Array;
  readonly issuerSigningPublicKey: Uint8Array;
}) {
  return {
    human_id: "human_alice",
    custody_state: "active",
    custody_revision: 7,
    current_recovery_generation: 1,
    custody_recovery_public_key_digest: input.currentPublicKeyDigest,
    current_inventory_revision: null,
    current_inventory_count: null,
    current_inventory_digest: null,
    recovery_key_id: "recovery_key_old",
    recovery_key_format_version: 1,
    recovery_public_key: input.currentPublicKey,
    recovery_public_key_digest: input.currentPublicKeyDigest,
    recovery_archive_hash: input.archiveHash,
    recovery_key_state: "current",
    recovery_key_revision: 1,
    archive_generation: 1,
    archive_hash: input.archiveHash,
    archive_bytes: new Uint8Array([0xa1]),
    issuer_device_state: "active",
    issuer_device_human_id: "human_alice",
    issuer_device_revision: 4,
    issuer_signing_public_key: input.issuerSigningPublicKey,
  };
}

function hex(bytes: Uint8Array): string {
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function submissionHash(
  fixture: Awaited<ReturnType<typeof createRecoveryRotationFixture>>,
): Uint8Array {
  const { signature, ...unsigned } = fixture.submission;
  const signingBytes = recoveryRotationSubmissionSigningBytes(
    fixture.crypto,
    unsigned,
  );
  const bytes = new Uint8Array(signingBytes.length + signature.length);
  bytes.set(signingBytes);
  bytes.set(signature, signingBytes.length);
  return fixture.crypto.hash(bytes);
}

describe("Postgres recovery-kit rotation", () => {
  test("retires the old key and atomically publishes the next key and archive", async () => {
    const fixture = await createRecoveryRotationFixture();
    const currentPublicKey = (await fixture.crypto.createRecoveryKit())
      .publicKey;
    const currentDigest = fixture.crypto.hash(currentPublicKey);
    const currentArchiveHash = fixture.crypto.hash(new Uint8Array([0xa1]));
    const setup = await repository([
      [],
      [],
      [],
      [lockedState({
        archiveHash: currentArchiveHash,
        currentPublicKey,
        currentPublicKeyDigest: currentDigest,
        issuerSigningPublicKey: fixture.issuer.publicKey,
      })],
      [],
      [],
      [{ human_id: fixture.human }],
      [{ human_id: fixture.human }],
      [{ human_id: fixture.human }],
      [{ human_id: fixture.human }],
      [{ operation_id: "operation" }],
      [{ outbox_id: "outbox" }],
    ]);

    expect(await setup.repository.rotate({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).toMatchObject({
      status: "rotated",
      humanId: fixture.human,
      recoveryGeneration: 2,
      custodyRevision: 8,
    });

    const sql = setup.connection.statements.join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("FROM human_crypto_custodies");
    expect(sql).toContain("FOR UPDATE");
    expect(sql).toContain("UPDATE human_crypto_recovery_keys");
    expect(sql).toContain("INSERT INTO human_crypto_recovery_keys");
    expect(sql).toContain("UPDATE human_crypto_recovery_archives");
    expect(sql).toContain("UPDATE human_crypto_custodies");
    expect(sql).toContain("INSERT INTO crypto_delivery_operations");
    expect(sql).toContain("INSERT INTO crypto_operation_outbox");
    expect(setup.connection.parameters.some((parameters) =>
      parameters[0]
        === `crypto-human-operation-capacity/${fixture.human}`
    )).toBe(true);
    const outboxIndex = setup.connection.statements.findIndex((statement) =>
      statement.includes("INSERT INTO crypto_operation_outbox")
    );
    const outboxPayload = setup.connection.parameters[outboxIndex]?.[2];
    expect(outboxPayload).toBeInstanceOf(Uint8Array);
    const publicEvent: unknown = JSON.parse(
      new TextDecoder().decode(outboxPayload as Uint8Array),
    ) as unknown;
    expect(typeof publicEvent).toBe("object");
    expect(publicEvent).not.toBeNull();
    const publicEventRecord = publicEvent as Record<string, unknown>;
    expect(publicEvent).toEqual({
      formatVersion: 1,
      eventType: "recovery_rotated",
      humanId: fixture.human,
      recoveryGeneration: 2,
      auditRef: publicEventRecord["auditRef"],
    });
    expect(typeof publicEventRecord["auditRef"]).toBe("string");
    expect(JSON.stringify(publicEvent)).not.toContain("archive");
    expect(JSON.stringify(publicEvent)).not.toContain("publicKey");
  });

  test("rejects a stale generation before any persistent mutation", async () => {
    const fixture = await createRecoveryRotationFixture();
    const currentPublicKey = (await fixture.crypto.createRecoveryKit())
      .publicKey;
    const currentDigest = fixture.crypto.hash(currentPublicKey);
    const setup = await repository([
      [],
      [],
      [],
      [lockedState({
        archiveHash: fixture.crypto.hash(new Uint8Array([0xa1])),
        currentPublicKey,
        currentPublicKeyDigest: currentDigest,
        issuerSigningPublicKey: fixture.issuer.publicKey,
      })],
    ]);
    expect(setup.repository.rotate({
      crypto: fixture.crypto,
      submission: {
        ...fixture.submission,
        expectedRecoveryGeneration: 0,
      },
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).rejects.toThrow("stale");
    expect(
      setup.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });

  test("returns an exact replay without rewriting key material", async () => {
    const fixture = await createRecoveryRotationFixture();
    const digest = fixture.crypto.hash(fixture.recovery.publicKey);
    const archiveHash = fixture.crypto.hash(fixture.archive.archiveBytes);
    const exactSubmissionHash = submissionHash(fixture);
    const token = hex(exactSubmissionHash);
    const setup = await repository([
      [],
      [],
      [{
        operation_id: `operation_recovery_rotate_${token}`,
        operation_state: "active",
        human_id: fixture.human,
        target_device_id: fixture.issuerDeviceId,
        expected_custody_revision: 7,
        expected_recovery_generation: 1,
        expected_device_revision: 4,
        expected_participant_digest: exactSubmissionHash,
        aggregate_payload_bytes: fixture.archive.archiveBytes.length,
        fanout_row_count: 0,
        audit_ref: `audit_recovery_rotate_${token}`,
      }],
      [{
        recovery_key_id: fixture.recovery.keyId,
        recovery_key_format_version: 1,
        recovery_public_key: fixture.recovery.publicKey,
        recovery_public_key_digest: digest,
        recovery_archive_hash: archiveHash,
        issuer_device_id: fixture.issuerDeviceId,
        recovery_key_state: "current",
      }],
    ]);
    expect(await setup.repository.rotate({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).toMatchObject({
      status: "duplicate",
      recoveryGeneration: 2,
      custodyRevision: 8,
    });
    expect(
      setup.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });

  test("rejects a live device-roster operation before rotating keys", async () => {
    const fixture = await createRecoveryRotationFixture();
    const currentPublicKey = (await fixture.crypto.createRecoveryKit())
      .publicKey;
    const setup = await repository([
      [],
      [],
      [],
      [lockedState({
        archiveHash: fixture.crypto.hash(new Uint8Array([0xa1])),
        currentPublicKey,
        currentPublicKeyDigest: fixture.crypto.hash(currentPublicKey),
        issuerSigningPublicKey: fixture.issuer.publicKey,
      })],
      [{ operation_id: "operation_device_recovery" }],
    ]);
    expect(setup.repository.rotate({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).rejects.toThrow("live device-roster");
    expect(
      setup.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });

  test("rejects reused recovery key material before retiring the old key", async () => {
    const fixture = await createRecoveryRotationFixture();
    const currentPublicKey = (await fixture.crypto.createRecoveryKit())
      .publicKey;
    const setup = await repository([
      [],
      [],
      [],
      [lockedState({
        archiveHash: fixture.crypto.hash(new Uint8Array([0xa1])),
        currentPublicKey,
        currentPublicKeyDigest: fixture.crypto.hash(currentPublicKey),
        issuerSigningPublicKey: fixture.issuer.publicKey,
      })],
      [],
      [{ human_id: fixture.human, generation: 0 }],
    ]);
    expect(setup.repository.rotate({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).rejects.toThrow("already used");
    expect(
      setup.connection.statements.some((statement) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(statement.trimStart())
      ),
    ).toBe(false);
  });

  test("treats a lost compare-and-swap as an atomic transaction failure", async () => {
    const fixture = await createRecoveryRotationFixture();
    const currentPublicKey = (await fixture.crypto.createRecoveryKit())
      .publicKey;
    const currentDigest = fixture.crypto.hash(currentPublicKey);
    const setup = await repository([
      [],
      [],
      [],
      [lockedState({
        archiveHash: fixture.crypto.hash(new Uint8Array([0xa1])),
        currentPublicKey,
        currentPublicKeyDigest: currentDigest,
        issuerSigningPublicKey: fixture.issuer.publicKey,
      })],
      [],
      [],
      [],
    ]);
    expect(setup.repository.rotate({
      crypto: fixture.crypto,
      submission: fixture.submission,
      expectedHumanId: fixture.human,
      rotatedAt: 50_000,
    })).rejects.toThrow("compare-and-swap");
  });
});
