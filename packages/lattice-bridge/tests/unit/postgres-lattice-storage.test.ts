import { describe, expect, test } from "bun:test";
import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  objectId,
  participantDigest,
  unixTimestamp,
} from "@nautilo/lattice-crypto";
import {
  encodeAgentRuntimeSignerPublicationV1,
  encodeEncryptedPayloadV2,
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  HUMAN_RECOVERY_FORMAT_VERSION_V2,
  recoveryKeyGenerationV2,
  serializeGrantV2,
  serializeHumanRecoveryArchiveV2,
} from "@nautilo/lattice-crypto/wire";
import {
  LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
} from "@nautilo/db/schema";
import {
  AgentRuntimeSignerHistoryUnavailableError,
  LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES,
  POSTGRES_LATTICE_STORAGE_OPERATION_MAP,
  PostgresLatticeStorage,
  createPostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";

type Query = Readonly<{
  statement: string;
  parameters: readonly unknown[];
}>;

class ScriptedCryptoHandle implements CryptoPostgresConnection {
  readonly queries: Query[] = [];
  transactionCount = 0;
  readonly #results: unknown[][];
  commitError: Error | null = null;
  queryError: Error | null = null;

  constructor(results: unknown[][] = []) {
    this.#results = [...results];
  }

  query<Row>(
    statement: string,
    parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.queries.push({ statement, parameters });
    if (this.queryError !== null) return Promise.reject(this.queryError);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }

  async transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    this.transactionCount += 1;
    const result = await callback(this);
    if (this.commitError !== null) throw this.commitError;
    return result;
  }
}

const verifiedRoleRow = {
  current_user: "nautilo_crypto",
  session_user: "nautilo_crypto",
};

async function storageWithResults(results: unknown[][] = []): Promise<{
  readonly connection: ScriptedCryptoHandle;
  readonly storage: PostgresLatticeStorage;
}> {
  const connection = new ScriptedCryptoHandle([[verifiedRoleRow], ...results]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    storage: new PostgresLatticeStorage(handle),
  };
}

const domain = {
  id: cryptoDomainId("domain-fixture"),
  participants: ["human-alice"],
  participantDigest: participantDigest([humanId("human-alice")]),
  epoch: domainEpoch(0),
  authorizationRevision: authorizationRevision(0),
  rosterBytes: new Uint8Array([1, 2, 3]),
};

const domainRow = {
  id: domain.id,
  participant_digest: domain.participantDigest,
  participants: [...domain.participants],
  epoch: domain.epoch,
  authorization_revision: domain.authorizationRevision,
  roster_bytes: domain.rosterBytes,
};

const signerPublication = {
  formatVersion: 1 as const,
  transitionKind: "initialization" as const,
  operationId: "operation-runtime-initialization",
  agentId: agentId("agent-runtime-signer"),
  authorizationRevision: authorizationRevision(0),
  runtimeGeneration: agentRuntimeGeneration(0),
  signerKeyId: `agent_runtime_signer_${"0".repeat(64)}`,
  signerPublicKey: new Uint8Array(32).fill(0x51),
  transitionCommitment: new Uint8Array(32).fill(0x52),
  managerHumanId: humanId("human-runtime-manager"),
  managerAuthorizationRevision: authorizationRevision(0),
  managerDeviceId: cryptoDeviceId("device-runtime-manager"),
  managerSigningPublicKeyHash: new Uint8Array(32).fill(0x53),
  signature: new Uint8Array(64).fill(0x54),
};

const signerPublicationRow = {
  agent_id: signerPublication.agentId,
  runtime_generation: signerPublication.runtimeGeneration,
  authorization_revision: signerPublication.authorizationRevision,
  transition_kind: signerPublication.transitionKind,
  operation_id: signerPublication.operationId,
  signer_key_id: signerPublication.signerKeyId,
  signer_public_key: signerPublication.signerPublicKey,
  publication_bytes:
    encodeAgentRuntimeSignerPublicationV1(signerPublication),
};

function canonicalObjectPayload(id: string): Uint8Array {
  return encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId(id),
      keyClass: "human",
      objectType: "test-record",
      createdAt: unixTimestamp(1),
    },
    ciphertext: new Uint8Array(40).fill(0x41),
  });
}

function canonicalGrantWire(id: string): Uint8Array {
  return serializeGrantV2({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId(id),
    issuingDeviceId: cryptoDeviceId("device-grant-issuer"),
    recipientAgentId: agentId("agent-grant-recipient"),
    recipientKeyId: "invocation-key",
    scope: [humanId("human-alice")],
    operations: ["decrypt"],
    issuedAt: 1,
    expiresAt: 2,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-grant"),
      domainEpoch: domainEpoch(1),
      agentAuthorizationRevision: authorizationRevision(1),
    }],
    encryptedSecret: new Uint8Array(40).fill(0x42),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(64).fill(0x43),
    singleUse: true,
    consumed: false,
  });
}

function canonicalRecoveryArchive(
  owner: string,
  generation: number,
): Uint8Array {
  return serializeHumanRecoveryArchiveV2({
    formatVersion: HUMAN_RECOVERY_FORMAT_VERSION_V2,
    humanId: humanId(owner),
    recoveryKeyId: `recovery-key-${String(generation)}`,
    recoveryGeneration: recoveryKeyGenerationV2(generation),
    recoveryPublicKeyDigest: new Uint8Array(32).fill(0x61),
    issuerDeviceId: cryptoDeviceId("device-recovery-issuer"),
    createdAt: unixTimestamp(1),
    packages: [],
    signature: new Uint8Array(64).fill(0x62),
  });
}

describe("Postgres lattice storage boundary", () => {
  test("requires a factory-verified role handle instead of trusting a role label", async () => {
    expect(() =>
      createPostgresLatticeStorage({
        role: "nautilo",
        query: async () => [],
        transaction: async () => undefined,
      } as never)
    ).toThrow("verified nautilo_crypto handle");

    const forged = new ScriptedCryptoHandle() as unknown as CryptoPostgresHandle;
    expect(() => createPostgresLatticeStorage(forged)).toThrow(
      "verified nautilo_crypto handle",
    );

    for (const role of ["nautilo", "nautilo_agent"]) {
      const connection = new ScriptedCryptoHandle([[
        { current_user: role, session_user: role },
      ]]);
      expect(verifyCryptoPostgresHandle(connection)).rejects.toThrow(
        "must authenticate directly as nautilo_crypto",
      );
    }
    const setRoleConnection = new ScriptedCryptoHandle([[
      { current_user: "nautilo_crypto", session_user: "nautilo" },
    ]]);
    expect(verifyCryptoPostgresHandle(setRoleConnection)).rejects.toThrow(
      "must authenticate directly as nautilo_crypto",
    );

    const connection = new ScriptedCryptoHandle([[verifiedRoleRow]]);
    const verified = await verifyCryptoPostgresHandle(connection);
    expect(() => createPostgresLatticeStorage(verified)).not.toThrow();
  });

  test("replays a transaction after a transient serialization failure", async () => {
    let transactionAttempts = 0;
    const connection: CryptoPostgresConnection = {
      query: async <Row>() =>
        [verifiedRoleRow] as unknown as readonly Row[],
      transaction: async (callback) => {
        transactionAttempts += 1;
        const result = await callback({
          query: async <Row>() => [] as readonly Row[],
        });
        if (transactionAttempts === 1) {
          throw Object.assign(new Error("serialization retry"), {
            code: "40001",
          });
        }
        return result;
      },
    };
    const verified = await verifyCryptoPostgresHandle(connection);

    expect(await verified.transaction(async () => "committed"))
      .toBe("committed");
    expect(transactionAttempts).toBe(2);
  });

  test("offers an explicit non-retrying transaction for one-shot authority", async () => {
    let transactionAttempts = 0;
    const expected = Object.assign(new Error("serialization abort"), {
      code: "40001",
    });
    const connection: CryptoPostgresConnection = {
      query: async <Row>() =>
        [verifiedRoleRow] as unknown as readonly Row[],
      transaction: async (callback) => {
        transactionAttempts += 1;
        await callback({
          query: async <Row>() => [] as readonly Row[],
        });
        throw expected;
      },
    };
    const verified = await verifyCryptoPostgresHandle(connection);

    const rejection = await verified.transactionOnce(
      async () => "not committed",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(expected);
    expect(transactionAttempts).toBe(1);
  });

  test("does not replay a transaction after a non-serialization failure", async () => {
    let transactionAttempts = 0;
    const expected = new Error("non-retryable");
    const connection: CryptoPostgresConnection = {
      query: async <Row>() =>
        [verifiedRoleRow] as unknown as readonly Row[],
      transaction: async () => {
        transactionAttempts += 1;
        throw expected;
      },
    };
    const verified = await verifyCryptoPostgresHandle(connection);

    const rejection = await verified.transaction(
      async () => "not committed",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(expected);
    expect(transactionAttempts).toBe(1);
  });

  test("stops after three consecutive serialization failures", async () => {
    let transactionAttempts = 0;
    const expected = Object.assign(new Error("serialization retry exhausted"), {
      code: "40001",
    });
    const connection: CryptoPostgresConnection = {
      query: async <Row>() =>
        [verifiedRoleRow] as unknown as readonly Row[],
      transaction: async () => {
        transactionAttempts += 1;
        throw expected;
      },
    };
    const verified = await verifyCryptoPostgresHandle(connection);

    const rejection = await verified.transaction(
      async () => "not committed",
    ).then(
      () => null,
      (error: unknown) => error,
    );
    expect(rejection).toBe(expected);
    expect(transactionAttempts).toBe(3);
  });

  test("consumes only authentic core write capabilities before opening a transaction", async () => {
    const { connection: handle, storage } = await storageWithResults();
    const attempts = [
      () => storage.compareAndSwapDomainProviderHead({} as never),
      () => storage.compareAndSwapNamespaceBindingAndHead({} as never),
      () => storage.compareAndSwapObjectAccessState({} as never),
      () => storage.putAgentRuntimeAtomicStateIfAbsent({} as never),
      () =>
        storage.compareAndSwapAgentRuntimeChallengeReservations({} as never),
      () => storage.compareAndSwapAgentRuntimeRotation({} as never),
    ];
    for (const attempt of attempts) {
      try {
        await attempt();
        throw new Error("expected forged capability rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toContain("authorized");
      }
    }
    expect(handle.transactionCount).toBe(0);
    expect(handle.queries).toHaveLength(1);
  });

  test("maps every storage operation to its exact durable tables", () => {
    expect(Object.keys(POSTGRES_LATTICE_STORAGE_OPERATION_MAP).sort()).toEqual([
      "compareAndSwapAgentRuntimeAuthorizationTransition",
      "compareAndSwapAgentRuntimeChallengeReservations",
      "compareAndSwapAgentRuntimeRotation",
      "compareAndSwapDomainProviderHead",
      "compareAndSwapNamespaceBindingAndHead",
      "compareAndSwapObjectAccessState",
      "compareAndSwapRecoveryArchive",
      "consumeGrant",
      "createDomainIfAbsent",
      "findDomain",
      "getAgentRuntimeAtomicState",
      "getAgentRuntimeSignerPublication",
      "getBinding",
      "getDomainProviderHead",
      "getGrant",
      "getNamespaceHead",
      "getObject",
      "getObjectAccessState",
      "getRecoveryArchive",
      "putAgentRuntimeAtomicStateIfAbsent",
      "putDomainProviderHeadIfAbsent",
      "putGrant",
      "putObject",
    ]);
    const declaredTables = new Set(
      Object.values(POSTGRES_LATTICE_STORAGE_OPERATION_MAP)
        .flatMap((operation) => operation.tables),
    );
    expect([...declaredTables].sort()).toEqual(
      [
        ...LATTICE_STORAGE_ADAPTER_TABLE_NAMES,
        ...LATTICE_STORAGE_NATIVE_V2_TABLE_NAMES,
      ].sort(),
    );
  });

  test("uses digest plus exact participant equality and validates read rows", async () => {
    const { connection: handle, storage } = await storageWithResults([[domainRow]]);

    expect(
      await storage.findDomain(
        domain.participantDigest,
        domain.participants,
      ),
    ).toEqual(domain);
    expect(handle.queries).toHaveLength(2);
    const lookupSql = handle.queries[1]!.statement.replaceAll('"', "")
      .toLowerCase();
    expect(lookupSql).toContain("participant_digest = $1");
    expect(lookupSql).toContain("participants = $2");
    expect(lookupSql).toContain("limit $3");
    expect(handle.queries[1]!.parameters).toEqual([
      domain.participantDigest,
      '{"human-alice"}',
      2,
    ]);
  });

  test("rejects corrupt durable rows after reading them", async () => {
    const { storage } = await storageWithResults([[
      { ...domainRow, participant_digest: new Uint8Array(31) },
    ]]);

    expect(
      storage.findDomain(domain.participantDigest, domain.participants),
    ).rejects.toThrow("participant digest");
  });

  test("reads exact signer history and fails closed when history is unavailable", async () => {
    const { connection, storage } = await storageWithResults([[
      signerPublicationRow,
    ]]);
    expect(
      await storage.getAgentRuntimeSignerPublication(
        signerPublication.agentId,
        signerPublication.runtimeGeneration,
      ),
    ).toEqual(signerPublication);
    expect(connection.queries[1]!.statement).not.toContain("FOR SHARE");

    const { storage: missingStorage } = await storageWithResults([[]]);
    expect(
      await missingStorage.getAgentRuntimeSignerPublication(
        signerPublication.agentId,
        signerPublication.runtimeGeneration,
      ),
    ).toBeNull();

    const { storage: corruptStorage } = await storageWithResults([[
      {
        ...signerPublicationRow,
        signer_public_key: new Uint8Array(32).fill(0xff),
      },
    ]]);
    const corruptError = await corruptStorage
      .getAgentRuntimeSignerPublication(
        signerPublication.agentId,
        signerPublication.runtimeGeneration,
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    expect(corruptError).toBeInstanceOf(
      AgentRuntimeSignerHistoryUnavailableError,
    );
    expect(corruptError).toHaveProperty(
      "code",
      "agent_runtime_signer_history_unavailable",
    );

    const {
      connection: failingConnection,
      storage: failingStorage,
    } = await storageWithResults();
    failingConnection.queryError = new Error("database unavailable");
    expect(
      failingStorage.getAgentRuntimeSignerPublication(
        signerPublication.agentId,
        signerPublication.runtimeGeneration,
      ),
    ).rejects.toBeInstanceOf(AgentRuntimeSignerHistoryUnavailableError);
  });

  test("normalizes postgres int8 strings and bigint only inside safe bounds", async () => {
    const { storage: stringStorage } = await storageWithResults([[
      {
        ...domainRow,
        epoch: "0",
        authorization_revision: "0",
      },
    ]]);
    expect(
      await stringStorage.findDomain(
        domain.participantDigest,
        domain.participants,
      ),
    ).toEqual(domain);

    const { storage: bigintStorage } = await storageWithResults([[
      {
        ...domainRow,
        epoch: 0n,
        authorization_revision: 0n,
      },
    ]]);
    expect(
      await bigintStorage.findDomain(
        domain.participantDigest,
        domain.participants,
      ),
    ).toEqual(domain);

    for (const invalid of [
      "-1",
      "01",
      "1.5",
      BigInt(Number.MAX_SAFE_INTEGER) + 1n,
    ]) {
      const { storage } = await storageWithResults([[
        { ...domainRow, epoch: invalid },
      ]]);
      try {
        await storage.findDomain(
          domain.participantDigest,
          domain.participants,
        );
        throw new Error("expected corrupt counter rejection");
      } catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect((error as Error).message).toContain("safe counter");
      }
    }
  });

  test("serializes exact-set creation with a transaction advisory lock", async () => {
    const { connection: handle, storage } = await storageWithResults([
      [],
      [],
      [],
      [],
    ]);

    expect(await storage.createDomainIfAbsent(domain)).toEqual({
      status: "created",
      domain,
    });
    expect(handle.transactionCount).toBe(1);
    expect(handle.queries[1]!.statement).toContain(
      "pg_advisory_xact_lock",
    );
    expect(
      handle.queries.at(-1)!.statement.replaceAll('"', "").toLowerCase(),
    ).toContain("insert into crypto_domains");
  });

  test("returns the canonical existing exact-set row, not the caller candidate", async () => {
    const existing = {
      ...domainRow,
      id: cryptoDomainId("domain-existing"),
    };
    const { connection: handle, storage } = await storageWithResults([
      [],
      [],
      [existing],
    ]);

    expect(await storage.createDomainIfAbsent(domain)).toEqual({
      status: "existing",
      domain: { ...domain, id: existing.id },
    });
    expect(
      handle.queries.some((query) =>
        query.statement.replaceAll('"', "").toLowerCase().includes(
          "insert into crypto_domains",
        )
      ),
    ).toBe(false);
  });

  test("does not retry or translate an unknown commit outcome into success", async () => {
    const unknown = new Error("driver lost the COMMIT acknowledgement");
    const { connection: handle, storage } = await storageWithResults([
      [],
      [],
      [],
      [],
    ]);
    handle.commitError = unknown;

    expect(storage.createDomainIfAbsent(domain)).rejects.toBe(unknown);
    expect(handle.transactionCount).toBe(1);
    expect(
      handle.queries.filter((query) =>
        query.statement.replaceAll('"', "").toLowerCase().includes(
          "insert into crypto_domains",
        )
      ),
    ).toHaveLength(1);
  });

  test("consumes a grant with one atomic conditional UPDATE", async () => {
    const { connection: handle, storage } = await storageWithResults([[]]);

    expect(await storage.consumeGrant("grant-missing")).toBeNull();
    expect(handle.transactionCount).toBe(0);
    expect(handle.queries).toHaveLength(2);
    const consumeSql = handle.queries[1]!.statement.replaceAll('"', "")
      .toLowerCase();
    expect(consumeSql).toContain("grant_id = $2");
    expect(consumeSql).toContain("consumed = $3");
    expect(consumeSql).toContain("returning");
  });

  test("reads multi-table object and Runtime states inside one stable transaction", async () => {
    const {
      connection: objectHandle,
      storage: objectStorage,
    } = await storageWithResults([[]]);
    expect(await objectStorage.getObjectAccessState("object-missing")).toBeNull();
    expect(objectHandle.transactionCount).toBe(1);
    expect(
      objectHandle.queries[1]!.statement.replaceAll('"', "").toLowerCase(),
    ).toContain("for update of object_crypto_access_heads");

    const {
      connection: runtimeHandle,
      storage: runtimeStorage,
    } = await storageWithResults([[]]);
    expect(
      await runtimeStorage.getAgentRuntimeAtomicState("agent-missing"),
    ).toBeNull();
    expect(runtimeHandle.transactionCount).toBe(1);
    expect(runtimeHandle.queries[1]!.statement.toLowerCase()).toContain(
      "for update",
    );
  });

  test("rejects more than one row from unique lookups", async () => {
    const { storage } = await storageWithResults([[domainRow, domainRow]]);
    expect(
      storage.findDomain(domain.participantDigest, domain.participants),
    ).rejects.toThrow("more than one durable row");
  });

  test("serializes immutable object creation without requiring UPDATE privilege", async () => {
    const payloadBytes = canonicalObjectPayload("object-advisory");
    const { connection, storage } = await storageWithResults([[], [], []]);

    await storage.putObject({
      objectId: objectId("object-advisory"),
      payloadBytes,
    } as never);

    const operationQueries = connection.queries.slice(1);
    expect(operationQueries[0]!.statement).toContain("pg_advisory_xact_lock");
    expect(
      operationQueries[1]!.statement.replaceAll('"', "").toLowerCase(),
    ).toContain("from crypto_objects");
    expect(operationQueries[1]!.statement).not.toContain("FOR SHARE");
  });

  test("rejects a durable object whose stored payload hash does not match its bytes", async () => {
    const payloadBytes = canonicalObjectPayload("object-corrupt-hash");
    const { storage } = await storageWithResults([[
      {
        object_id: "object-corrupt-hash",
        payload_hash: new Uint8Array(32).fill(0xff),
        payload_bytes: payloadBytes,
      },
    ]]);

    expect(storage.getObject("object-corrupt-hash")).rejects.toThrow(
      "payload hash",
    );
  });

  test("serializes first Grant insertion before checking for an existing row", async () => {
    const grantBytes = canonicalGrantWire("grant-advisory");
    const { connection, storage } = await storageWithResults([[], [], []]);

    await storage.putGrant({
      grantId: "grant-advisory",
      grantBytes,
      consumed: false,
    } as never);

    const operationQueries = connection.queries.slice(1);
    expect(operationQueries[0]!.statement).toContain("pg_advisory_xact_lock");
    expect(
      operationQueries[1]!.statement.replaceAll('"', "").toLowerCase(),
    ).toContain("from crypto_grants");
  });

  test("rejects a durable recovery archive whose stored hash is corrupt", async () => {
    const archiveBytes = canonicalRecoveryArchive("human-recovery", 2);
    const { storage } = await storageWithResults([[
      {
        human_id: "human-recovery",
        recovery_key_generation: 2,
        archive_hash: new Uint8Array(32).fill(0xff),
        archive_bytes: archiveBytes,
      },
    ]]);

    expect(storage.getRecoveryArchive("human-recovery")).rejects.toThrow(
      "durable hash",
    );
  });

  test("rejects provider rows that drift from duplicated Domain state", async () => {
    const { storage } = await storageWithResults([[
      {
        domain_id: "domain-provider",
        provider_id: "provider-v2",
        epoch: 1,
        state_hash: new Uint8Array(32).fill(0x71),
        roster_bytes: new Uint8Array([1, 2, 3]),
        domain_epoch: 2,
        domain_roster_bytes: new Uint8Array([1, 2, 3]),
      },
    ]]);

    expect(storage.getDomainProviderHead("domain-provider")).rejects.toThrow(
      "does not match its Domain public state",
    );
  });
});
