import { describe, expect, test } from "bun:test";
import {
  PostgresRecoveryFanoutAdmissionRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";
import { createRecoveryDeviceProofFixture } from "./recovery-device-proof-fixture.ts";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedConnection implements CryptoPostgresConnection {
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
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    return callback(this);
  }
}

async function setupRepository(
  crypto: Awaited<ReturnType<
    typeof createRecoveryDeviceProofFixture
  >>["crypto"],
  results: unknown[][],
) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresRecoveryFanoutAdmissionRepository({
      handle,
      crypto,
    }),
  };
}

function currentState(
  fixture: Awaited<ReturnType<typeof createRecoveryDeviceProofFixture>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    operation_id: "device_operation_recovery",
    operation_kind: "device_recovery",
    operation_state: "awaiting_committer",
    operation_human_id: String(fixture.targetHumanId),
    target_device_id: String(fixture.targetDeviceId),
    expected_custody_revision: 7,
    expected_recovery_generation: 2,
    expected_device_revision: 0,
    expected_inventory_digest: fixture.inventoryDigest,
    fanout_row_count: 1,
    aggregate_payload_bytes: fixture.challenge.challengeBytes.length,
    challenge_id: "device_challenge_recovery",
    challenge_kind: "device_recovery",
    challenge_hash: fixture.challenge.verifier.challengeHash,
    challenge_expected_response_digest:
      fixture.challenge.verifier.expectedResponseDigest,
    challenge_expected_custody_revision: 7,
    challenge_expected_recovery_generation: 2,
    challenge_consumed_at: null,
    challenge_invalidated_at: null,
    challenge_expires_at_ms: 310_000,
    device_human_id: String(fixture.targetHumanId),
    device_state: "pending",
    device_revision: 0,
    device_encryption_public_key: fixture.pendingEncryption.publicKey,
    device_signing_public_key: fixture.pendingSigning.publicKey,
    challenge_encryption_public_key_digest:
      fixture.crypto.hash(fixture.pendingEncryption.publicKey),
    challenge_signing_public_key_digest:
      fixture.crypto.hash(fixture.pendingSigning.publicKey),
    custody_state: "recovery_required",
    custody_revision: 7,
    custody_recovery_generation: 2,
    custody_recovery_public_key_digest:
      fixture.crypto.hash(fixture.recovery.publicKey),
    custody_inventory_revision: 8,
    custody_inventory_count: fixture.inventoryCount,
    custody_inventory_digest: fixture.inventoryDigest,
    recovery_key_id: fixture.recovery.keyId,
    recovery_key_generation: 2,
    recovery_public_key_digest:
      fixture.crypto.hash(fixture.recovery.publicKey),
    recovery_key_archive_hash: fixture.archiveHash,
    recovery_key_state: "current",
    archive_generation: 2,
    archive_hash: fixture.archiveHash,
    archive_bytes: fixture.archive.archiveBytes,
    challenge_message_id: "recovery_challenge_message",
    challenge_message_hash: fixture.challenge.verifier.challengeHash,
    challenge_message_bytes: fixture.challenge.challengeBytes,
    admitted_operation_id: null,
    admitted_authorization_artifact_hash: null,
    admitted_recovery_readiness_digest: null,
    ...overrides,
  };
}

function recoveryArtifactHash(
  fixture: Awaited<ReturnType<typeof createRecoveryDeviceProofFixture>>,
  participantDigest: Uint8Array,
) {
  const hex = (bytes: Uint8Array) =>
    Array.from(
      bytes,
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");
  return fixture.crypto.hash(new TextEncoder().encode(JSON.stringify({
    formatVersion: 1,
    domain: "nautilo/lattice-bridge/recovery-fanout-admission/v1",
    proofHash: hex(fixture.crypto.hash(fixture.proofBytes)),
    domains: [{
      domainId: String(fixture.targetDomainId),
      expectedEpoch: 3,
      targetEpoch: 4,
      expectedAuthorizationRevision: 5,
      expectedParticipantDigest: hex(participantDigest),
      committerDeviceId: String(fixture.issuerDeviceId),
      namespaces: [{
        namespaceId: String(fixture.targetNamespaceId),
        expectedAccessRevision: Number(fixture.trustedHead.accessRevision),
        expectedBindingHash: hex(fixture.trustedHead.bindingHash),
      }],
    }],
  })));
}

describe("Postgres recovery fanout admission", () => {
  test("rejects an unverified database handle", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const forged = new ScriptedConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() =>
      new PostgresRecoveryFanoutAdmissionRepository({
        handle: forged,
        crypto: fixture.crypto,
      })
    ).toThrow("verified nautilo_crypto handle");
  });

  test("verifies a real core proof and derives every durable transition from authoritative rows", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
      [{
        domain_id: String(fixture.targetDomainId),
        epoch: 3,
        authorization_revision: 5,
        participant_digest: new Uint8Array(32).fill(0x33),
        writes_paused: false,
        current_leaf_count: 1,
        committer_device_id: String(fixture.issuerDeviceId),
        committer_human_id: String(fixture.targetHumanId),
        participants: [String(fixture.targetHumanId)],
      }],
      [{
        device_id: String(fixture.issuerDeviceId),
        human_id: String(fixture.targetHumanId),
        state: "active",
      }],
      [{
        namespace_id: String(fixture.targetNamespaceId),
        domain_id: String(fixture.targetDomainId),
        domain_epoch: 3,
        access_revision: Number(fixture.trustedHead.accessRevision),
        binding_hash: fixture.trustedHead.bindingHash,
        writes_paused: false,
      }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ namespace_id: String(fixture.targetNamespaceId) }],
      [{ operation_id: "device_operation_recovery" }],
      [{ outbox_id: "outbox" }],
    ]);

    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({
      status: "admitted",
      domainCount: 1,
      blockedDomainCount: 0,
    });
    const sql = setup.connection.queries
      .slice(1)
      .map((query) => query.statement)
      .join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("INSERT INTO crypto_device_epoch_operations");
    expect(sql).toContain("$1, $2, $3, NULL, $4, $5, $6, $7, $8, $9");
    expect(sql).toContain("INSERT INTO crypto_domain_transition_steps");
    expect(sql).toContain("INSERT INTO crypto_domain_transition_namespaces");
    expect(sql).not.toContain("INSERT INTO crypto_delivery_messages");
    expect(sql).not.toContain("INSERT INTO crypto_delivery_acknowledgements");
    expect(sql).not.toContain("UPDATE human_crypto_devices");
    expect(setup.connection.transactionCount).toBe(1);
  });

  test("rejects an altered proof before the first persistent mutation", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
    ]);
    const altered = fixture.proofBytes.slice();
    altered[altered.length - 1] = altered[altered.length - 1]! ^ 1;
    expect(setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: altered,
      admittedAt: 20_000,
    })).rejects.toThrow();
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });

  test("rejects a proof from the retired recovery generation", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture, {
        operation_expected_recovery_generation: 3,
        challenge_expected_recovery_generation: 3,
        custody_recovery_generation: 3,
        recovery_key_generation: 3,
        archive_generation: 3,
      })],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({ status: "stale_state" });
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });

  test("fails closed when authoritative Domain state is stale", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
      [{
        domain_id: String(fixture.targetDomainId),
        epoch: 3,
        authorization_revision: 5,
        participant_digest: new Uint8Array(32).fill(0x33),
        writes_paused: true,
        current_leaf_count: 1,
        committer_device_id: String(fixture.issuerDeviceId),
        committer_human_id: String(fixture.targetHumanId),
        participants: [String(fixture.targetHumanId)],
      }],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({ status: "stale_state" });
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });

  test("returns an exact duplicate without persisting proof bytes", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const participantDigest = new Uint8Array(32).fill(0x33);
    const artifactHash = recoveryArtifactHash(fixture, participantDigest);
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture, {
        operation_state: "active",
        challenge_consumed_at: "2026-01-01T00:00:00.000Z",
        challenge_expires_at_ms: 15_000,
        device_state: "active",
        device_revision: 1,
        custody_state: "active",
        custody_revision: 8,
        challenge_message_id: null,
        challenge_message_hash: null,
        challenge_message_bytes: null,
        admitted_operation_id: "device_operation_recovery",
        admitted_target_device_id: String(fixture.targetDeviceId),
        admitted_owner_human_id: String(fixture.targetHumanId),
        admitted_source_device_id: null,
        admitted_device_revision: 0,
        admitted_inventory_revision: 8,
        admitted_inventory_count: fixture.inventoryCount,
        admitted_inventory_digest: fixture.inventoryDigest,
        admitted_authorization_artifact_hash: artifactHash,
        admitted_recovery_readiness_digest: fixture.proof.readinessDigest,
      })],
      [{
        domain_id: String(fixture.targetDomainId),
        expected_epoch: 3,
        expected_authorization_revision: 5,
        expected_participant_digest: participantDigest,
        target_epoch: 4,
        committer_device_id: String(fixture.issuerDeviceId),
        state: "awaiting_committer",
        failure_code: null,
      }],
      [{
        domain_id: String(fixture.targetDomainId),
        namespace_id: String(fixture.targetNamespaceId),
        expected_access_revision: Number(
          fixture.trustedHead.accessRevision,
        ),
        expected_binding_hash: fixture.trustedHead.bindingHash,
      }],
      [],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({
      status: "duplicate",
      domainCount: 1,
      blockedDomainCount: 0,
    });
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
    expect(
      setup.connection.queries.flatMap((query) => query.parameters)
        .some((parameter) => parameter === fixture.proofBytes),
    ).toBe(false);
  });

  test("rejects replay after any persisted fanout coordinate is changed", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const participantDigest = new Uint8Array(32).fill(0x33);
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture, {
        admitted_operation_id: "device_operation_recovery",
        admitted_target_device_id: String(fixture.targetDeviceId),
        admitted_owner_human_id: String(fixture.targetHumanId),
        admitted_source_device_id: null,
        admitted_device_revision: 0,
        admitted_inventory_revision: 8,
        admitted_inventory_count: fixture.inventoryCount,
        admitted_inventory_digest: fixture.inventoryDigest,
        admitted_authorization_artifact_hash:
          recoveryArtifactHash(fixture, participantDigest),
        admitted_recovery_readiness_digest: fixture.proof.readinessDigest,
      })],
      [{
        domain_id: String(fixture.targetDomainId),
        expected_epoch: 3,
        expected_authorization_revision: 6,
        expected_participant_digest: participantDigest,
        target_epoch: 4,
        committer_device_id: String(fixture.issuerDeviceId),
        state: "awaiting_committer",
        failure_code: null,
      }],
      [{
        domain_id: String(fixture.targetDomainId),
        namespace_id: String(fixture.targetNamespaceId),
        expected_access_revision: Number(
          fixture.trustedHead.accessRevision,
        ),
        expected_binding_hash: fixture.trustedHead.bindingHash,
      }],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({ status: "conflicting_state" });
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });

  test("terminalizes an all-blocked recovery without leasing poison work", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
      [{
        domain_id: String(fixture.targetDomainId),
        epoch: 3,
        authorization_revision: 5,
        participant_digest: new Uint8Array(32).fill(0x33),
        writes_paused: false,
        current_leaf_count: 0,
        committer_device_id: null,
        committer_human_id: null,
        participants: [String(fixture.targetHumanId)],
      }],
      [],
      [{
        namespace_id: String(fixture.targetNamespaceId),
        domain_id: String(fixture.targetDomainId),
        domain_epoch: 3,
        access_revision: Number(fixture.trustedHead.accessRevision),
        binding_hash: fixture.trustedHead.bindingHash,
        writes_paused: false,
      }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({
      status: "admitted",
      domainCount: 1,
      blockedDomainCount: 1,
    });
    const statements = setup.connection.queries.map((query) => query.statement);
    const domainInsert = statements.findIndex((statement) =>
      statement.includes("INSERT INTO crypto_domain_transition_steps")
    );
    expect(setup.connection.queries[domainInsert]?.parameters).toContain(
      "domain_rebootstrap_required",
    );
    const operationUpdate = statements.findIndex((statement) =>
      statement.includes("UPDATE crypto_delivery_operations")
    );
    expect(setup.connection.queries[operationUpdate]?.parameters).toContain(
      "failed",
    );
    expect(setup.connection.queries[operationUpdate]?.parameters).toContain(
      "domain_rebootstrap_required",
    );
    expect(
      statements.some((statement) =>
        statement.includes("INSERT INTO crypto_domain_transition_namespaces")
      ),
    ).toBe(false);
  });

  test("terminalizes the whole recovery when only one of multiple Domains lacks a committer", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
      [{
        domain_id: "domain_ab",
        epoch: 3,
        authorization_revision: 5,
        participant_digest: new Uint8Array(32).fill(0x33),
        writes_paused: false,
        current_leaf_count: 1,
        committer_device_id: String(fixture.issuerDeviceId),
        committer_human_id: String(fixture.targetHumanId),
        participants: [String(fixture.targetHumanId)],
      }, {
        domain_id: "domain_ac",
        epoch: 4,
        authorization_revision: 6,
        participant_digest: new Uint8Array(32).fill(0x44),
        writes_paused: false,
        current_leaf_count: 0,
        committer_device_id: null,
        committer_human_id: null,
        participants: [String(fixture.targetHumanId)],
      }],
      [{
        device_id: String(fixture.issuerDeviceId),
        human_id: String(fixture.targetHumanId),
        state: "active",
      }],
      [{
        namespace_id: "namespace_room",
        domain_id: "domain_ab",
        domain_epoch: 3,
        access_revision: 0,
        binding_hash: fixture.trustedHead.bindingHash,
        writes_paused: false,
      }, {
        namespace_id: "namespace_room_two",
        domain_id: "domain_ac",
        domain_epoch: 4,
        access_revision: 0,
        binding_hash: new Uint8Array(32).fill(0x55),
        writes_paused: false,
      }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ operation_id: "device_operation_recovery" }],
      [{ outbox_id: "outbox" }],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({
      status: "admitted",
      domainCount: 2,
      blockedDomainCount: 1,
    });
    const domainInserts = setup.connection.queries.filter((query) =>
      query.statement.includes("INSERT INTO crypto_domain_transition_steps")
    );
    expect(domainInserts).toHaveLength(2);
    expect(domainInserts[0]?.parameters).toContain(
      "recovery_blocked_by_domain",
    );
    expect(domainInserts[1]?.parameters).toContain(
      "domain_rebootstrap_required",
    );
    expect(
      setup.connection.queries.some((query) =>
        query.statement.includes(
          "INSERT INTO crypto_domain_transition_namespaces",
        )
      ),
    ).toBe(false);
  });

  test("rejects a committer whose device owner does not match its Domain leaf", async () => {
    const fixture = await createRecoveryDeviceProofFixture();
    const setup = await setupRepository(fixture.crypto, [
      [],
      [],
      [currentState(fixture)],
      [{
        domain_id: String(fixture.targetDomainId),
        epoch: 3,
        authorization_revision: 5,
        participant_digest: new Uint8Array(32).fill(0x33),
        writes_paused: false,
        current_leaf_count: 1,
        committer_device_id: String(fixture.issuerDeviceId),
        committer_human_id: String(fixture.targetHumanId),
        participants: [String(fixture.targetHumanId)],
      }],
      [{
        device_id: String(fixture.issuerDeviceId),
        human_id: "human_mallory",
        state: "active",
      }],
    ]);
    expect(await setup.repository.admit({
      operationId: "device_operation_recovery",
      proofBytes: fixture.proofBytes,
      admittedAt: 20_000,
    })).toEqual({ status: "stale_state" });
    expect(
      setup.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });
});
