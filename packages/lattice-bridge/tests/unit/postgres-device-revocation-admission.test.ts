import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  createDeviceRevocationManifest,
  type DeviceRevocationManifestUnsigned,
} from "../../src/device/device-revocation.ts";
import {
  PostgresDeviceRevocationAdmissionRepository,
} from "../../src/server/device/postgres-device-revocation-admission-repository.ts";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "../../src/server/index.ts";

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

function concat(left: Uint8Array, right: Uint8Array): Uint8Array {
  const output = new Uint8Array(left.length + right.length);
  output.set(left);
  output.set(right, left.length);
  return output;
}

async function fixture(input: {
  readonly domains?: 0 | 1 | 2;
  readonly absentInventory?: boolean;
  readonly selfRevoke?: boolean;
} = {}) {
  const crypto = new LatticeCrypto();
  const issuerSigning = crypto.generateSigningKeyPair();
  const issuerEncryption = await crypto.generateEncryptionKeyPair();
  const targetSigning = input.selfRevoke
    ? issuerSigning
    : crypto.generateSigningKeyPair();
  const targetEncryption = input.selfRevoke
    ? issuerEncryption
    : await crypto.generateEncryptionKeyPair();
  const human = humanId("00000000-0000-4000-8000-00000000000a");
  const issuerDeviceId = cryptoDeviceId("device_alice_issuer");
  const targetDeviceId = input.selfRevoke
    ? issuerDeviceId
    : cryptoDeviceId("device_alice_target");
  const targetFingerprint = crypto.hash(concat(
    targetSigning.publicKey,
    targetEncryption.publicKey,
  ));
  const allDomains: DeviceRevocationManifestUnsigned["domains"] = [{
    domainId: "domain_alpha",
    expectedEpoch: 3,
    expectedAuthorizationRevision: 5,
    expectedParticipantDigest: new Uint8Array(32).fill(0x31),
    namespaces: [{
      namespaceId: "namespace_alpha",
      expectedAccessRevision: 7,
      expectedBindingHash: new Uint8Array(32).fill(0x41),
    }],
  }, {
    domainId: "domain_beta",
    expectedEpoch: 8,
    expectedAuthorizationRevision: 2,
    expectedParticipantDigest: new Uint8Array(32).fill(0x32),
    namespaces: [{
      namespaceId: "namespace_beta",
      expectedAccessRevision: 9,
      expectedBindingHash: new Uint8Array(32).fill(0x42),
    }],
  }];
  const domainCount = input.domains ?? 1;
  const unsigned: DeviceRevocationManifestUnsigned = {
    formatVersion: 1,
    operationId: "operation_revoke_alice_target",
    idempotencyKey: "revoke_alice_target",
    humanId: human,
    issuerDeviceId,
    targetDeviceId,
    expectedIssuerDeviceRevision: 7,
    expectedTargetDeviceRevision: input.selfRevoke ? 7 : 4,
    targetPublicFingerprint: targetFingerprint,
    targetSigningPublicKeyDigest: crypto.hash(targetSigning.publicKey),
    targetEncryptionPublicKeyDigest: crypto.hash(
      targetEncryption.publicKey,
    ),
    expectedCustodyRevision: 11,
    expectedRecoveryGeneration: 3,
    expectedInventoryRevision: input.absentInventory ? null : 5,
    expectedInventoryCount: input.absentInventory ? null : 2,
    expectedInventoryDigest: input.absentInventory
      ? null
      : new Uint8Array(32).fill(0x21),
    domains: allDomains.slice(0, domainCount),
    issuedAt: 100_000,
  };
  return {
    crypto,
    human,
    issuerDeviceId,
    targetDeviceId,
    issuerSigning,
    issuerEncryption,
    targetSigning,
    targetEncryption,
    unsigned,
    manifest: createDeviceRevocationManifest({
      crypto,
      manifest: unsigned,
      issuerSigningPrivateKey: issuerSigning.privateKey,
    }),
  };
}

function registry(
  setup: Awaited<ReturnType<typeof fixture>>,
  overrides: Record<string, unknown> = {},
) {
  return {
    issuer_device_id: String(setup.issuerDeviceId),
    issuer_human_id: String(setup.human),
    issuer_state: "active",
    issuer_revision: 7,
    issuer_signing_public_key: setup.issuerSigning.publicKey,
    issuer_encryption_public_key: setup.issuerEncryption.publicKey,
    issuer_public_fingerprint: setup.crypto.hash(concat(
      setup.issuerSigning.publicKey,
      setup.issuerEncryption.publicKey,
    )),
    issuer_revoked_at: null,
    target_device_id: String(setup.targetDeviceId),
    target_human_id: String(setup.human),
    target_state: "active",
    target_revision: setup.manifest.expectedTargetDeviceRevision,
    target_signing_public_key: setup.targetSigning.publicKey,
    target_encryption_public_key: setup.targetEncryption.publicKey,
    target_public_fingerprint: setup.manifest.targetPublicFingerprint,
    target_revoked_at: null,
    custody_human_id: String(setup.human),
    custody_state: "active",
    custody_revision: 11,
    current_recovery_generation: 3,
    current_inventory_revision:
      setup.unsigned.expectedInventoryRevision,
    current_inventory_count: setup.unsigned.expectedInventoryCount,
    current_inventory_digest: setup.unsigned.expectedInventoryDigest,
    ...overrides,
  };
}

function domainRow(
  setup: Awaited<ReturnType<typeof fixture>>,
  index: number,
  committerDeviceId: string | null,
) {
  const domain = setup.manifest.domains[index]!;
  return {
    domain_id: domain.domainId,
    epoch: domain.expectedEpoch,
    authorization_revision: domain.expectedAuthorizationRevision,
    participant_digest: domain.expectedParticipantDigest,
    participants: [String(setup.human)],
    writes_paused: false,
    pause_operation_id: null,
    target_mapping_human_id: String(setup.human),
    committer_device_id: committerDeviceId,
  };
}

function namespaceRow(
  setup: Awaited<ReturnType<typeof fixture>>,
  index: number,
) {
  const domain = setup.manifest.domains[index]!;
  const namespace = domain.namespaces[0]!;
  return {
    namespace_id: namespace.namespaceId,
    domain_id: domain.domainId,
    domain_epoch: domain.expectedEpoch,
    access_revision: namespace.expectedAccessRevision,
    binding_hash: namespace.expectedBindingHash,
    writes_paused: false,
    pause_operation_id: null,
  };
}

async function repository(
  setup: Awaited<ReturnType<typeof fixture>>,
  results: unknown[][],
) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeviceRevocationAdmissionRepository({
      handle,
      crypto: setup.crypto,
    }),
  };
}

function mutationSuccesses(count: number): unknown[][] {
  return Array.from({ length: count }, (_, index) => [{
    result: `mutation_${index}`,
  }]);
}

describe("Postgres device revocation admission", () => {
  test("rejects an unverified database handle", async () => {
    const setup = await fixture();
    const forged = new ScriptedConnection(
      [],
    ) as unknown as CryptoPostgresHandle;
    expect(() =>
      new PostgresDeviceRevocationAdmissionRepository({
        handle: forged,
        crypto: setup.crypto,
      })
    ).toThrow("verified nautilo_crypto handle");
  });

  test("verifies exact authoritative state before atomically tombstoning and pausing", async () => {
    const setup = await fixture();
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [domainRow(setup, 0, String(setup.issuerDeviceId))],
      [namespaceRow(setup, 0)],
      [{
        device_id: String(setup.issuerDeviceId),
        human_id: String(setup.human),
        state: "active",
      }],
      [
        { device_id: String(setup.issuerDeviceId) },
        { device_id: String(setup.targetDeviceId) },
      ],
      ...mutationSuccesses(9),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
      auditRef: "audit_revoke_target",
    })).toEqual({
      status: "admitted",
      domainCount: 1,
      blockedDomainCount: 0,
      custodyState: "active",
    });
    expect(prepared.connection.transactionCount).toBe(1);
    const sql = prepared.connection.queries.map((query) =>
      query.statement
    ).join("\n");
    expect(sql).toContain("SET TRANSACTION ISOLATION LEVEL SERIALIZABLE");
    expect(sql).toContain("INSERT INTO crypto_device_epoch_operations");
    expect(sql).toContain("INSERT INTO crypto_domain_transition_steps");
    expect(sql).toContain(
      "INSERT INTO crypto_domain_transition_namespaces",
    );
    expect(sql).toContain("SET state = 'revoked', revision = revision + 1");
    expect(sql).toContain(
      "SET writes_paused = true, pause_operation_id = $2",
    );
    expect(prepared.connection.queries.some(({ statement, parameters }) =>
      statement.includes("pg_advisory_xact_lock")
      && parameters[0]
        === `crypto-human-operation-capacity/${setup.human}`
    )).toBe(true);
    const outbox = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_operation_outbox")
    )!;
    const payload = JSON.parse(
      new TextDecoder().decode(outbox.parameters[2] as Uint8Array),
    ) as Record<string, unknown>;
    expect(payload).toEqual({
      formatVersion: 1,
      eventType: "crypto_device_revoked",
      operationId: setup.manifest.operationId,
      humanId: String(setup.human),
      targetDeviceId: String(setup.targetDeviceId),
      deviceRevision: 5,
      custodyRevision: 12,
    });
    expect(JSON.stringify(payload)).not.toContain("publicKey");
    expect(JSON.stringify(payload)).not.toContain("signature");
  });

  test("rejects an omitted signed Domain before the first persistent mutation", async () => {
    const setup = await fixture({ domains: 0 });
    const authoritative = await fixture({ domains: 1 });
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [domainRow(authoritative, 0, String(setup.issuerDeviceId))],
      [namespaceRow(authoritative, 0)],
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({ status: "stale_state" });
    expect(
      prepared.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);
  });

  test("rejects stale target revisions and substituted target keys before mutation", async () => {
    const setup = await fixture();
    for (const override of [
      { target_revision: 5 },
      {
        target_signing_public_key: setup.crypto
          .generateSigningKeyPair().publicKey,
      },
    ]) {
      const prepared = await repository(setup, [
        [],
        [],
        [],
        [registry(setup, override)],
      ]);
      expect(await prepared.repository.admit({
        manifest: setup.manifest,
        revokedAt: 120_000,
      })).toEqual({ status: "stale_state" });
      expect(
        prepared.connection.queries.some((query) =>
          /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
        ),
      ).toBe(false);
    }
  });

  test("terminalizes an all-blocked revocation but retains all write pauses", async () => {
    const setup = await fixture();
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [domainRow(setup, 0, null)],
      [namespaceRow(setup, 0)],
      [
        { device_id: String(setup.issuerDeviceId) },
        { device_id: String(setup.targetDeviceId) },
      ],
      ...mutationSuccesses(8),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({
      status: "admitted",
      domainCount: 1,
      blockedDomainCount: 1,
      custodyState: "active",
    });
    const operationInsert = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_delivery_operations")
    )!;
    expect(operationInsert.parameters[2]).toBe("failed");
    expect(operationInsert.parameters[10]).toBe(
      "domain_rebootstrap_required",
    );
    const stepInsert = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_domain_transition_steps")
    )!;
    expect(stepInsert.parameters[7]).toBe("failed");
    expect(stepInsert.parameters[8]).toBe(
      "domain_rebootstrap_required",
    );
    expect(
      prepared.connection.queries.some((query) =>
        query.statement.includes(
          "INSERT INTO crypto_domain_transition_namespaces",
        )
      ),
    ).toBe(false);
    expect(
      prepared.connection.queries.filter((query) =>
        query.statement.includes(
          "SET writes_paused = true, pause_operation_id = $2",
        )
      ),
    ).toHaveLength(2);
  });

  test("keeps a mixed operation live while omitting blocked Namespace steps", async () => {
    const setup = await fixture({ domains: 2 });
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [
        domainRow(setup, 0, String(setup.issuerDeviceId)),
        domainRow(setup, 1, null),
      ],
      [namespaceRow(setup, 0), namespaceRow(setup, 1)],
      [{
        device_id: String(setup.issuerDeviceId),
        human_id: String(setup.human),
        state: "active",
      }],
      [
        { device_id: String(setup.issuerDeviceId) },
        { device_id: String(setup.targetDeviceId) },
      ],
      ...mutationSuccesses(12),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({
      status: "admitted",
      domainCount: 2,
      blockedDomainCount: 1,
      custodyState: "active",
    });
    const operationInsert = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_delivery_operations")
    )!;
    expect(operationInsert.parameters[2]).toBe("awaiting_committer");
    expect(
      prepared.connection.queries.filter((query) =>
        query.statement.includes(
          "INSERT INTO crypto_domain_transition_namespaces",
        )
      ),
    ).toHaveLength(1);
  });

  test("moves custody to recovery_required when the last active device is revoked", async () => {
    const setup = await fixture({ domains: 0 });
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [],
      [{ device_id: String(setup.targetDeviceId) }],
      ...mutationSuccesses(5),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({
      status: "admitted",
      domainCount: 0,
      blockedDomainCount: 0,
      custodyState: "recovery_required",
    });
    const custodyUpdate = prepared.connection.queries.find((query) =>
      query.statement.includes("UPDATE human_crypto_custodies")
    )!;
    expect(custodyUpdate.parameters[1]).toBe("recovery_required");
  });

  test("allows an active last device to authorize its own revocation", async () => {
    const setup = await fixture({ domains: 0, selfRevoke: true });
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [],
      [{ device_id: String(setup.targetDeviceId) }],
      ...mutationSuccesses(5),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toMatchObject({
      status: "admitted",
      custodyState: "recovery_required",
    });
  });

  test("maps an absent legacy inventory to a bound non-null epoch sentinel", async () => {
    const setup = await fixture({
      domains: 0,
      absentInventory: true,
    });
    const prepared = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [],
      [
        { device_id: String(setup.issuerDeviceId) },
        { device_id: String(setup.targetDeviceId) },
      ],
      ...mutationSuccesses(5),
    ]);

    expect(await prepared.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toMatchObject({
      status: "admitted",
      domainCount: 0,
    });
    const epochInsert = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_device_epoch_operations")
    )!;
    expect(epochInsert.parameters[5]).toBe(0);
    expect(epochInsert.parameters[6]).toBe(0);
    expect(epochInsert.parameters[7]).toBeInstanceOf(Uint8Array);
    expect(epochInsert.parameters[7]).toHaveLength(32);
    const custodyUpdate = prepared.connection.queries.find((query) =>
      query.statement.includes("UPDATE human_crypto_custodies")
    )!;
    expect(custodyUpdate.statement).toContain(
      "current_inventory_revision IS NOT DISTINCT FROM $7",
    );
    expect(custodyUpdate.parameters.slice(6, 9)).toEqual([
      null,
      null,
      null,
    ]);
    const outboxInsert = prepared.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_operation_outbox")
    )!;
    const replay = await repository(setup, [
      [],
      [],
      [{
        operation_id: setup.manifest.operationId,
        idempotency_key: setup.manifest.idempotencyKey,
        kind: "device_revoke",
        state: "active",
        human_id: String(setup.human),
        target_human_id: String(setup.human),
        target_device_id: String(setup.targetDeviceId),
        expected_custody_revision: 11,
        expected_recovery_generation: 3,
        expected_device_revision: 4,
        fanout_row_count: 0,
        aggregate_payload_bytes: 0,
        failure_code: null,
        owner_human_id: String(setup.human),
        source_device_id: String(setup.issuerDeviceId),
        epoch_device_revision: 4,
        expected_inventory_revision: 0,
        expected_inventory_count: 0,
        expected_inventory_digest: epochInsert.parameters[7],
        authorization_artifact_hash: epochInsert.parameters[8],
      }],
      [registry(setup, {
        target_state: "revoked",
        target_revision: 5,
        target_revoked_at: new Date(120_000).toISOString(),
        custody_revision: 12,
      })],
      [],
      [],
      [],
      [{
        outbox_id: outboxInsert.parameters[0],
        event_type: "crypto_device_revoked",
        payload_bytes: outboxInsert.parameters[2],
        idempotency_key: outboxInsert.parameters[3],
      }],
    ]);
    expect(await replay.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toMatchObject({ status: "duplicate" });
  });

  test("replays exactly after the target tombstone and rejects persisted-plan drift", async () => {
    const setup = await fixture();
    const first = await repository(setup, [
      [],
      [],
      [],
      [registry(setup)],
      [domainRow(setup, 0, String(setup.issuerDeviceId))],
      [namespaceRow(setup, 0)],
      [{
        device_id: String(setup.issuerDeviceId),
        human_id: String(setup.human),
        state: "active",
      }],
      [
        { device_id: String(setup.issuerDeviceId) },
        { device_id: String(setup.targetDeviceId) },
      ],
      ...mutationSuccesses(9),
    ]);
    await first.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    });
    const epochInsert = first.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_device_epoch_operations")
    )!;
    const outboxInsert = first.connection.queries.find((query) =>
      query.statement.includes("INSERT INTO crypto_operation_outbox")
    )!;
    const prior = {
      operation_id: setup.manifest.operationId,
      idempotency_key: setup.manifest.idempotencyKey,
      kind: "device_revoke",
      state: "awaiting_committer",
      human_id: String(setup.human),
      target_human_id: String(setup.human),
      target_device_id: String(setup.targetDeviceId),
      expected_custody_revision: 11,
      expected_recovery_generation: 3,
      expected_device_revision: 4,
      fanout_row_count: 1,
      aggregate_payload_bytes: 3,
      failure_code: null,
      owner_human_id: String(setup.human),
      source_device_id: String(setup.issuerDeviceId),
      epoch_device_revision: 4,
      expected_inventory_revision: 5,
      expected_inventory_count: 2,
      expected_inventory_digest: setup.unsigned.expectedInventoryDigest,
      authorization_artifact_hash: epochInsert.parameters[8],
    };
    const tombstonedRegistry = registry(setup, {
      target_state: "revoked",
      target_revision: 5,
      target_revoked_at: new Date(120_000).toISOString(),
      custody_revision: 12,
    });
    const step = {
      domain_id: setup.manifest.domains[0]!.domainId,
      expected_epoch: 3,
      expected_authorization_revision: 5,
      expected_participant_digest:
        setup.manifest.domains[0]!.expectedParticipantDigest,
      target_epoch: 4,
      committer_device_id: String(setup.issuerDeviceId),
      state: "awaiting_committer",
      failure_code: null,
    };
    const namespace = {
      domain_id: setup.manifest.domains[0]!.domainId,
      namespace_id:
        setup.manifest.domains[0]!.namespaces[0]!.namespaceId,
      expected_access_revision: 7,
      expected_binding_hash:
        setup.manifest.domains[0]!.namespaces[0]!.expectedBindingHash,
    };
    const outbox = {
      outbox_id: outboxInsert.parameters[0],
      event_type: "crypto_device_revoked",
      payload_bytes: outboxInsert.parameters[2],
      idempotency_key: outboxInsert.parameters[3],
    };
    const replay = await repository(setup, [
      [],
      [],
      [prior],
      [tombstonedRegistry],
      [step],
      [namespace],
      [{
        message_id: "message_revocation_progress",
        payload_bytes: new Uint8Array([1, 2, 3]),
      }],
      [outbox],
    ]);
    expect(await replay.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({
      status: "duplicate",
      domainCount: 1,
      blockedDomainCount: 0,
      custodyState: "active",
    });
    expect(
      replay.connection.queries.some((query) =>
        /^(?:INSERT|UPDATE|DELETE)\b/.test(query.statement.trimStart())
      ),
    ).toBe(false);

    const corrupt = await repository(setup, [
      [],
      [],
      [prior],
      [tombstonedRegistry],
      [step],
      [{
        ...namespace,
        expected_binding_hash: new Uint8Array(32).fill(0xff),
      }],
      [{
        message_id: "message_revocation_progress",
        payload_bytes: new Uint8Array([1, 2, 3]),
      }],
    ]);
    expect(await corrupt.repository.admit({
      manifest: setup.manifest,
      revokedAt: 120_000,
    })).toEqual({ status: "conflicting_state" });
  });
});
