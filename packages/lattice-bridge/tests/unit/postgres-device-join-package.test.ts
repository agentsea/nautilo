import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "@nautilo/lattice-crypto";
import {
  createDeviceJoinPackage,
  verifyDeviceJoinPackage,
  type VerifiedDeviceJoinPackage,
} from "../../src/index.ts";
import {
  PostgresDeviceJoinPackageRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "../../src/server/index.ts";

class ScriptedConnection implements CryptoPostgresConnection {
  readonly statements: string[] = [];
  readonly #results: unknown[][];
  constructor(results: unknown[][]) {
    this.#results = [...results];
  }
  query<Row>(
    statement: string,
    _parameters: readonly unknown[] = [],
  ): Promise<readonly Row[]> {
    this.statements.push(statement);
    return Promise.resolve((this.#results.shift() ?? []) as Row[]);
  }
  transaction<Result>(
    callback: (transaction: this) => Promise<Result>,
  ): Promise<Result> {
    return callback(this);
  }
}

function verifiedPackage(): VerifiedDeviceJoinPackage {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const head = {
    providerId: "openmls-v2",
    domainId: cryptoDomainId("domain_ab"),
    epoch: domainEpoch(3),
    stateHash: new Uint8Array(32).fill(0x31),
  };
  const envelope = createDeviceJoinPackage({
    crypto,
    request: {
      formatVersion: 2,
      providerId: head.providerId,
      domainId: head.domainId,
      humanId: humanId("human_alice"),
      deviceId: cryptoDeviceId("device_alice_pending"),
      expectedHead: head,
      keyPackageBytes: new Uint8Array([1, 2, 3]),
    },
    generation: 1,
    packageId: "join_package_1",
    createdAt: 10_000,
    expiresAt: 20_000,
    signingPrivateKey: signing.privateKey,
  });
  return verifyDeviceJoinPackage({
    crypto,
    envelope,
    now: 10_001,
    resolveDevice: () => ({
      humanId: "human_alice",
      state: "pending",
      generation: 1,
      signingPublicKey: signing.publicKey,
    }),
    resolveProviderHead: () => head,
  });
}

const packageValue = verifiedPackage();

async function repository(results: unknown[][]) {
  const connection = new ScriptedConnection([
    [{ current_user: "nautilo_crypto", session_user: "nautilo_crypto" }],
    ...results,
  ]);
  const handle = await verifyCryptoPostgresHandle(connection);
  return {
    connection,
    repository: new PostgresDeviceJoinPackageRepository(handle),
  };
}

function normalizedSql(statement: string): string {
  return statement.replaceAll('"', "").replaceAll(/\s+/g, " ").trim()
    .toLowerCase();
}

describe("Postgres device join-package repository", () => {
  test("rejects forged and detached verification look-alikes before opening a transaction", async () => {
    const setup = await repository([]);
    const statementsBefore = setup.connection.statements.length;
    const fakeSignature = {
      ...packageValue,
      signature: new Uint8Array(64).fill(0x51),
    } as VerifiedDeviceJoinPackage;

    expect(
      () => setup.repository.publish([fakeSignature]),
    ).toThrow("not cryptographically verified");
    expect(
      () => setup.repository.publish([structuredClone(packageValue)]),
    ).toThrow("not cryptographically verified");
    expect(setup.connection.statements).toHaveLength(statementsBefore);
  });

  test("rejects mutation after verification before opening a transaction", async () => {
    const setup = await repository([]);
    const mutable = verifiedPackage();
    mutable.keyPackageBytes[0] = mutable.keyPackageBytes[0]! ^ 1;
    const statementsBefore = setup.connection.statements.length;

    expect(
      () => setup.repository.publish([mutable]),
    ).toThrow("not cryptographically verified");
    expect(setup.connection.statements).toHaveLength(statementsBefore);
  });

  test("publishes a bounded batch and advances the public pool generation atomically", async () => {
    const setup = await repository([
      [],
      [],
      [{
        device_id: "device_alice_pending",
        human_id: "human_alice",
        state: "pending",
        key_package_generation: 0,
        key_package_count: 0,
        device_revision: 0,
      }],
      [{
        domain_id: "domain_ab",
        provider_id: "openmls-v2",
        epoch: 3,
        state_hash: packageValue.expectedProviderHeadHash,
      }],
      [],
      [{ unconsumed_count: 0 }],
      [{ package_id: "join_package_1" }],
      [{ device_id: "device_alice_pending" }],
      [{ operation_id: "operation_device_add" }],
    ]);
    expect(await setup.repository.publish([packageValue])).toEqual({
      status: "published",
      publishedCount: 1,
    });
    const sql = normalizedSql(setup.connection.statements.join("\n"));
    expect(sql).toContain("for update");
    expect(sql).toContain('count(*) as unconsumed_count');
    expect(sql).toContain("insert into human_crypto_device_key_packages");
    expect(sql).toContain("update human_crypto_devices");
    expect(sql).not.toContain("signature");
  });

  test("claims one exact package once for one operation", async () => {
    const setup = await repository([
      [],
      [],
      [{
        device_id: "device_alice_pending",
        device_state: "pending",
        device_revision: 1,
        generation: 1,
        package_id: "join_package_1",
        domain_id: "domain_ab",
        expected_provider_head_hash: packageValue.expectedProviderHeadHash,
        package_hash: packageValue.packageHash,
        format_version: 1,
        package_bytes: packageValue.keyPackageBytes,
        expires_at_ms: 20_000,
        consumed_at: null,
        consuming_operation_id: null,
        provider_head_hash: packageValue.expectedProviderHeadHash,
      }],
      [{ package_id: "join_package_1" }],
      [{ device_id: "device_alice_pending" }],
      [{ operation_id: "operation_device_add" }],
    ]);
    expect(await setup.repository.claim({
      deviceId: "device_alice_pending",
      domainId: "domain_ab",
      generation: 1,
      operationId: "operation_device_add",
      now: 10_001,
    })).toMatchObject({
      status: "claimed",
      package: {
        packageId: "join_package_1",
        packageBytes: packageValue.keyPackageBytes,
      },
    });
    expect(normalizedSql(setup.connection.statements.join("\n"))).toContain(
      "consuming_operation_id =",
    );
  });

  test("replays the exact consumed package after an HTTP response is lost", async () => {
    const setup = await repository([[{
      package_id: "join_package_1",
      package_hash: packageValue.packageHash,
      package_bytes: packageValue.keyPackageBytes,
      format_version: 1,
      expected_provider_head_hash: packageValue.expectedProviderHeadHash,
    }]]);
    expect(await setup.repository.claimOrReplay({
      deviceId: "device_alice_pending",
      domainId: "domain_ab",
      generation: 1,
      operationId: "operation_device_add",
      now: 10_002,
    })).toMatchObject({
      status: "claimed",
      package: {
        packageId: "join_package_1",
        packageBytes: packageValue.keyPackageBytes,
      },
    });
    expect(setup.connection.statements.join("\n")).toContain(
      "consuming_operation_id = $4",
    );
    expect(setup.connection.statements.join("\n")).not.toContain(
      "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE",
    );
  });
});
