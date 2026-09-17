import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import postgres from "postgres";
import {
  LatticeCrypto,
  DeviceProviderStateVault,
  HumanDeviceOpenMlsGroup,
  cryptoDeviceId,
  encodeHumanDeviceGroupHead,
  humanId,
  publishHumanRecoveryArchive,
  unixTimestamp,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  recoveryKeyGenerationV2,
} from "@nautilo/lattice-crypto/wire";
import {
  createDeviceAdmissionProof,
  createInitialDeviceBootstrapProof,
  nautiloActorId,
  nautiloUserId,
  prepareInitialDeviceBootstrapRequest,
  type TranslationResult,
} from "@nautilo/lattice-bridge";
import {
  InitialDeviceBootstrapService,
  PostgresDeviceAdmissionRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresInitialDeviceBootstrapRepository,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
} from "@nautilo/lattice-bridge/server";
import {
  createSyntheticInitialDeviceAuthorizer,
} from "@nautilo/lattice-bridge/testing";
import {
  resetDisposablePostgresDatabase,
} from "../../scripts/disposable-postgres-reset.ts";

type SqlClient = postgres.Sql;
type SqlExecutor = Pick<SqlClient, "unsafe">;

const adminUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_ADMIN_DATABASE_URL",
);
const cryptoUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_DATABASE_URL");
const appUrl = requiredEnvironment("LATTICE_BRIDGE_TEST_APP_DATABASE_URL");
const agentUrl = requiredEnvironment(
  "LATTICE_BRIDGE_TEST_AGENT_DATABASE_URL",
);

let admin: SqlClient;

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`${name} is required for the Postgres integration suite`);
  }
  return value;
}

async function resetDisposableDatabase(): Promise<void> {
  await admin.end({ timeout: 1 });
  resetDisposablePostgresDatabase({
    admin: adminUrl,
    app: appUrl,
    agent: agentUrl,
    crypto: cryptoUrl,
  });
  admin = postgres(adminUrl, { max: 1, prepare: false });
}

function executor(client: SqlExecutor): CryptoPostgresExecutor {
  return {
    async query<Row>(
      statement: string,
      parameters = [],
    ): Promise<readonly Row[]> {
      const result = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return result as unknown as readonly Row[];
    },
  };
}

function connection(client: SqlClient): CryptoPostgresConnection {
  return {
    ...executor(client),
    transaction: (callback) =>
      client.begin((transaction) => callback(executor(transaction))) as Promise<
        ReturnType<typeof callback> extends Promise<infer Result>
          ? Result
          : never
      >,
  };
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0 || 0x9e3779b9;
  return {
    bytes(length: number): Uint8Array {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state ^= state << 13;
        state ^= state >>> 17;
        state ^= state << 5;
        state >>>= 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function bootstrapDevice(input: Readonly<{
  crypto: LatticeCrypto;
  repository: PostgresInitialDeviceBootstrapRepository;
  groupRepository: PostgresHumanDeviceGroupRepository;
  userId: string;
  actorId: string;
  deviceId: string;
  serverInstanceId: string;
}>) {
  const signing = input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const lineage = new Uint8Array(32).fill(0x41);
  const prepared = await prepareInitialDeviceBootstrapRequest({
    crypto: input.crypto,
    request: {
      userId: valueOf(nautiloUserId(input.userId)),
      humanActorId: valueOf(nautiloActorId(input.actorId)),
      deviceId: cryptoDeviceId(input.deviceId),
      clientKind: "browser",
      installationLineageDigest: lineage,
      signingPublicKey: signing.publicKey,
      encryptionPublicKey: encryption.publicKey,
      context: {
        kind: "preparation",
        authorityId: "preparation_device_admission",
      },
      idempotencyKey: "bootstrap_device_admission",
    },
    presentRecoveryKit() {
      return {
        status: "confirmed" as const,
      };
    },
  });
  const archive = await publishHumanRecoveryArchive({
    crypto: input.crypto,
    humanId: humanId(input.actorId),
    recoveryKeyId: prepared.recoveryKeyId,
    recoveryGeneration: recoveryKeyGenerationV2(1),
    recoveryPublicKey: prepared.recoveryPublicKey,
    resolveTrustedCurrentRecoveryKey: () => ({
      humanId: humanId(input.actorId),
      recoveryKeyId: prepared.recoveryKeyId,
      recoveryGeneration: recoveryKeyGenerationV2(1),
      publicKeyDigest: input.crypto.hash(prepared.recoveryPublicKey),
    }),
    issuerDeviceId: cryptoDeviceId(input.deviceId),
    createdAt: unixTimestamp(10_000),
    sources: [],
    issuerSigningPrivateKey: signing.privateKey,
    resolveIssuerDevice: () => signing.publicKey,
  });
  const service = new InitialDeviceBootstrapService({
    crypto: input.crypto,
    repository: input.repository,
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: valueOf(nautiloUserId(input.userId)),
      expectedHumanActorId: valueOf(nautiloActorId(input.actorId)),
      expectedInstallationLineageDigest: lineage,
      authorizationDigest: new Uint8Array(32).fill(0x42),
      allowedContext: {
        kind: "preparation",
        authorityId: "preparation_device_admission",
      },
    }),
    authorizeReceiptLookup: () => true,
  });
  const challenge = await service.begin(prepared);
  await service.complete(createInitialDeviceBootstrapProof({
    crypto: input.crypto,
    challenge,
    recoveryArchiveBytes: archive.archiveBytes,
    signingPrivateKey: signing.privateKey,
  }));
  const coordinates = Object.freeze({
    serverInstanceId: input.serverInstanceId,
    humanId: humanId(input.actorId),
    lineageGeneration: 1,
  });
  const group = new HumanDeviceOpenMlsGroup(
    input.crypto,
    DeviceProviderStateVault.fromKey(
      input.crypto,
      cryptoDeviceId(input.deviceId),
      new Uint8Array(32).fill(0x43),
    ),
    {
      coordinates,
      ownCredential: Object.freeze({
        formatVersion: 1 as const,
        ...coordinates,
        deviceId: cryptoDeviceId(input.deviceId),
        installationLineageDigest: lineage,
        deviceKeyGeneration: 1,
      }),
    },
  );
  await group.initialize();
  const founded = await group.createInitialState();
  expect(await input.groupRepository.establishInitial({
    userId: input.userId,
    humanId: input.actorId,
    deviceId: input.deviceId,
    headBytes: encodeHumanDeviceGroupHead(founded.head),
    rosterBytes: founded.rosterBytes,
    now: 10_001,
  })).toBe("created");
  return signing;
}

beforeAll(() => {
  admin = postgres(adminUrl, { max: 1, prepare: false });
});

beforeEach(async () => {
  await resetDisposableDatabase();
});

afterAll(async () => {
  await admin.end();
});

describe.serial("Postgres crypto-device admission", () => {
  test("survives restart, retries exact proofs, and follows current device authority", async () => {
    const userId = "30000000-0000-4000-8000-000000000303";
    const actorId = "30000000-0000-4000-8000-000000000304";
    const deviceId = "crypto:browser:m303-device-admission";
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'M303 admission fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES ($1, $2, 'M303 admission fixture', 'verified', 'user')`,
      [actorId, userId],
    );
    const serverInstanceId = "30000000-0000-4000-8000-000000000305";
    await admin.unsafe(
      `INSERT INTO nautilo_instance_identity (
         id, instance_id, server_instance_id, server_binding_generation
       ) VALUES ('self', 'm303-test', $1, 1)
       ON CONFLICT (id) DO NOTHING`,
      [serverInstanceId],
    );
    const [identity] = await admin.unsafe<{ server_instance_id: string }[]>(
      `SELECT server_instance_id
         FROM nautilo_instance_identity
        WHERE id = 'self'`,
    );
    if (identity === undefined) throw new Error("Server identity is unavailable");

    const client = postgres(cryptoUrl, { max: 4, prepare: false });
    let clientOpen = true;
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const crypto = new LatticeCrypto(seededRng(303));
      const signing = await bootstrapDevice({
        crypto,
        repository: new PostgresInitialDeviceBootstrapRepository(handle),
        groupRepository: new PostgresHumanDeviceGroupRepository(handle, crypto),
        userId,
        actorId,
        deviceId,
        serverInstanceId: identity.server_instance_id,
      });
      const repository = new PostgresDeviceAdmissionRepository(handle, crypto);
      const credentialDigest = new Uint8Array(32).fill(0x51);
      const issuedAt = 20_000;
      const credentialExpiresAt = 3_620_000;
      const challenge = await repository.issueChallenge({
        credentialDigest,
        credentialExpiresAt,
        userId,
        humanActorId: actorId,
        deviceId,
        now: issuedAt,
      });
      if (challenge === null) throw new Error("Admission challenge unavailable");
      const proof = createDeviceAdmissionProof({
        crypto,
        challenge,
        signingPrivateKey: signing.privateKey,
      });

      expect(await repository.admit({
        credentialDigest,
        credentialExpiresAt,
        userId,
        humanActorId: actorId,
        proof,
        now: issuedAt + 1,
      })).toBe("admitted");
      expect(await repository.admit({
        credentialDigest,
        credentialExpiresAt,
        userId,
        humanActorId: actorId,
        proof,
        now: issuedAt + 2,
      })).toBe("admitted");
      expect(await repository.status({
        credentialDigest,
        userId,
        humanActorId: actorId,
        now: issuedAt + 3,
      })).toMatchObject({ status: "admitted", deviceId });

      for (let round = 0; round < 8; round += 1) {
        const concurrentDigest = new Uint8Array(32).fill(0x52 + round);
        const concurrentChallenge = await repository.issueChallenge({
          credentialDigest: concurrentDigest,
          credentialExpiresAt,
          userId,
          humanActorId: actorId,
          deviceId,
          now: issuedAt + 4 + round * 2,
        });
        if (concurrentChallenge === null) {
          throw new Error("Concurrent admission challenge unavailable");
        }
        const concurrentProof = createDeviceAdmissionProof({
          crypto,
          challenge: concurrentChallenge,
          signingPrivateKey: signing.privateKey,
        });
        expect(await Promise.all([1, 2].map((offset) => repository.admit({
          credentialDigest: concurrentDigest,
          credentialExpiresAt,
          userId,
          humanActorId: actorId,
          proof: concurrentProof,
          now: issuedAt + 4 + round * 2 + offset,
        })))).toEqual(["admitted", "admitted"]);
      }

      await client.end();
      clientOpen = false;
      const restarted = postgres(cryptoUrl, { max: 1, prepare: false });
      try {
        const restartedHandle = await verifyCryptoPostgresHandle(
          connection(restarted),
        );
        const restartedRepository = new PostgresDeviceAdmissionRepository(
          restartedHandle,
          crypto,
        );
        expect(await restartedRepository.status({
          credentialDigest,
          userId,
          humanActorId: actorId,
          now: issuedAt + 4,
        })).toMatchObject({ status: "admitted", deviceId });

        await admin.unsafe(
          `UPDATE human_crypto_devices
              SET membership_state = 'stale', revision = revision + 1
            WHERE device_id = $1`,
          [deviceId],
        );
        expect(await restartedRepository.status({
          credentialDigest,
          userId,
          humanActorId: actorId,
          now: issuedAt + 5,
        })).toEqual({
          status: "required",
          reason: "device_removed_or_stale",
        });
        expect(await restartedRepository.reconcileExpired({
          now: credentialExpiresAt + 1,
          limit: 256,
        })).toEqual({ challenges: 9, admissions: 9 });
        expect(restartedRepository.reconcileExpired({
          now: credentialExpiresAt + 1,
          limit: 1_025,
        })).rejects.toThrow("invalid_reconciliation_limit");
      } finally {
        await restarted.end();
      }
    } finally {
      if (clientOpen) await client.end();
      await resetDisposableDatabase();
    }
  }, 60_000);
});
