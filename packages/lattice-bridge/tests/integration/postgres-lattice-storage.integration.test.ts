import {
  randomUUID,
} from "node:crypto";
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
  CRYPTO_DELIVERY_COLLECTION_LIMITS,
  CRYPTO_STORAGE_BYTE_LIMITS,
  CRYPTO_STORAGE_TABLE_NAMES,
  DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
} from "@nautilo/db/schema";
import { CRYPTO_TABLE_PRIVILEGES } from "@nautilo/db";
import {
  AgentRuntimeInitializationOutcomeUnknown,
  answerRecoveryDevicePossessionChallenge,
  LatticeCrypto,
  DeviceProviderStateVault,
  deriveAgentRuntimeObjectSignerPublic,
  HumanDeviceOpenMlsGroup,
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  encryptedObjectWriteRecord,
  grantId,
  grantWriteRecord,
  humanId,
  decodeHumanDeviceGroupTransition,
  decodeHumanDeviceRoster,
  encodeHumanDeviceGroupHead,
  encodeHumanDeviceGroupJoinRequest,
  encodeHumanDeviceGroupTransition,
  humanDeviceGroupHeadDigest,
  namespaceGeneration,
  namespaceId,
  objectId,
  openHumanRecoveryArchive,
  openNamespaceKeyring,
  participantDigest,
  persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet,
  persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  persistAgentRuntimeInitialization,
  prepareDeviceWrappedAgentObjectAccessManifestGenesisSet,
  prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis,
  prepareAgentRuntimeInitialization,
  persistNamespaceBinding,
  publishHumanRecoveryArchive,
  unixTimestamp,
  wrapObjectDekForNamespace,
  type AgentRuntimeAuthorizationPlan,
  type AgentRuntimeAuthorizationTransitionPersistenceAuthorization,
  type AgentRuntimeAuthorizationTransitionPlan,
  type AgentRuntimeAuthorizationDomain,
  type AgentRuntimeRotationPersistenceAuthorization,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  encodeEncryptedPayloadV2,
  encodeNamespaceObjectEnvelopeV2,
  ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
  GRANT_V2_FORMAT_VERSION,
  GRANT_V2_SCHEME,
  deviceTransferApprovalSigningBytesV2,
  deviceTransferInventoryDigestV2,
  deviceTransferInventoryRevisionV2,
  pendingDeviceRevisionV2,
  recoveryKeyGenerationV2,
  serializeDeviceTransferApprovalV2,
  serializeGrantV2,
  parseNamespaceKeyringEnvelopeV2,
  type AgentRuntimeConfigObjectV2,
  type DeviceTransferApprovalV2,
  type ProviderPublicHeadV2,
} from "@nautilo/lattice-crypto/wire";
import {
  authorizeAgentRuntimeInitializationWriteForTesting,
  authorizeProviderHeadWriteForTesting,
} from "@nautilo/lattice-crypto/testing";
import {
  createAdditionalDeviceApprovalManifest,
  createDeliveryAcknowledgementProof,
  createDeviceDeliveryFetchProof,
  createDeviceFanoutAdmission,
  createDeviceJoinPackage,
  decodeHumanMembershipRebindSubmission,
  decodeHumanMembershipTargetDomainDeliveryArtifact,
  decodeOpaqueDeliveryArtifactChunk,
  createInitialDeviceBootstrapProof,
  deriveRecoveryCredentialFromMnemonic,
  coordinateProtectedAgentRuntimeAuthorizationTransition,
  coordinateProtectedAgentRuntimeRotation,
  createProtectedAgentRuntimeAuthorizationTransitionSourcePort,
  createProtectedAgentRuntimeRotationSourcePort,
  createProtectedAgentRuntimeRotationTargetPort,
  deliveryRetryAtMs,
  nautiloActorId,
  nautiloUserId,
  prepareInitialDeviceBootstrapRequest,
  type TranslationResult,
  verifyAdditionalDeviceApproval,
  reassembleOpaqueDeliveryArtifact,
  verifyDeliveryAcknowledgementProof,
  verifyDeviceJoinPackage,
} from "@nautilo/lattice-bridge";
import {
  AdditionalDeviceEnrollmentService,
  InitialDeviceBootstrapService,
  PostgresAdditionalDeviceEnrollmentRepository,
  PostgresCryptoOutboxRepository,
  PostgresDeviceFanoutAdmissionRepository,
  PostgresDeviceActivationRepository,
  PostgresDeviceJoinPackageRepository,
  PostgresDeliveryAcknowledgementRepository,
  PostgresDeliveryMaintenanceRepository,
  PostgresDeviceDeliveryFetchRepository,
  PostgresDomainTransitionLeaseRepository,
  PostgresHumanMembershipActivationRepository,
  PostgresHumanMembershipAdmissionRepository,
  PostgresHumanMembershipRebindRepository,
  PostgresHumanMembershipTargetDomainRepository,
  PostgresHumanDeviceGroupRepository,
  PostgresInitialDeviceBootstrapRepository,
  PostgresRecoveryRotationRepository,
  PostgresRecoveryChallengeRepository,
  createPostgresLatticeStorage,
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
  type CryptoPostgresExecutor,
  type CryptoPostgresHandle,
} from "@nautilo/lattice-bridge/server";
import {
  LATTICE_STORAGE_METHODS,
  createSyntheticAdditionalDeviceAuthorizer,
  createSyntheticInitialDeviceAuthorizer,
  runLatticeStorageContract,
  runSyntheticSharedDomainScenario,
} from "@nautilo/lattice-bridge/testing";
import {
  COLD_ALICE_ACTOR,
  COLD_ALICE_DEVICE,
  COLD_CHARLIE_ACTOR,
  COLD_CHARLIE_DEVICE,
  COLD_NAMESPACE,
  COLD_OPERATION,
  COLD_SOURCE_DOMAIN,
  COLD_TARGET_DOMAIN,
  createColdHumanAddFixture,
} from "../fixtures/cold-human-add-fixture.ts";
import {
  createRecoveryRotationFixture,
} from "../fixtures/recovery-rotation-fixture.ts";

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

function sqlClient(url: string, maximumConnections = 4): SqlClient {
  return postgres(url, {
    max: maximumConnections,
    prepare: false,
    onnotice: () => undefined,
  });
}

function executor(
  client: SqlExecutor,
  beforeQuery?: (statement: string) => void,
): CryptoPostgresExecutor {
  return {
    async query<Row>(
      statement: string,
      parameters = [],
    ): Promise<readonly Row[]> {
      beforeQuery?.(statement);
      const result = await client.unsafe(
        statement,
        [...parameters] as postgres.ParameterOrJSON<never>[],
      );
      return result as unknown as readonly Row[];
    },
  };
}

function connection(
  client: SqlClient,
  beforeQuery?: (statement: string) => void,
): CryptoPostgresConnection {
  return {
    ...executor(client, beforeQuery),
    transaction: (callback) =>
      client.begin((transaction) =>
        callback(executor(transaction, beforeQuery))
      ) as Promise<ReturnType<typeof callback> extends Promise<infer Result>
        ? Result
        : never>,
  };
}

async function cryptoStorage(
  beforeQuery?: (statement: string) => void,
): Promise<Readonly<{
  client: SqlClient;
  storage: ReturnType<typeof createPostgresLatticeStorage>;
}>> {
  const client = sqlClient(cryptoUrl);
  try {
    const handle = await verifyCryptoPostgresHandle(
      connection(client, beforeQuery),
    );
    return Object.freeze({
      client,
      storage: createPostgresLatticeStorage(handle),
    });
  } catch (error) {
    await client.end();
    throw error;
  }
}

async function truncateCryptoStorage(): Promise<void> {
  await admin.unsafe(
    `TRUNCATE TABLE ${CRYPTO_STORAGE_TABLE_NAMES.join(", ")} CASCADE`,
  );
}

function canonicalObjectPayload(id: string): Uint8Array {
  return encodeEncryptedPayloadV2({
    formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
    context: {
      objectId: objectId(id),
      keyClass: "human",
      objectType: "integration-record",
      createdAt: unixTimestamp(1),
    },
    ciphertext: new Uint8Array(40).fill(0x41),
  });
}

function canonicalGrantWire(id: string): Uint8Array {
  return serializeGrantV2({
    formatVersion: GRANT_V2_FORMAT_VERSION,
    id: grantId(id),
    issuingDeviceId: cryptoDeviceId("device-integration-issuer"),
    recipientAgentId: agentId("agent-integration-recipient"),
    recipientKeyId: "invocation-key",
    scope: [humanId("human-integration-alice")],
    operations: ["decrypt"],
    issuedAt: 1,
    expiresAt: 2,
    coveredDomains: [{
      domainId: cryptoDomainId("domain-integration"),
      domainEpoch: domainEpoch(0),
      agentAuthorizationRevision: authorizationRevision(0),
    }],
    encryptedSecret: new Uint8Array(40).fill(0x42),
    scheme: GRANT_V2_SCHEME,
    signature: new Uint8Array(64).fill(0x43),
    singleUse: true,
    consumed: false,
  });
}

function providerHead(epoch: number, marker: number): ProviderPublicHeadV2 {
  return {
    providerId: "provider-integration",
    domainId: cryptoDomainId("domain-concurrency"),
    epoch: domainEpoch(epoch),
    stateHash: new Uint8Array(32).fill(marker),
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

async function bootstrapSyntheticHuman(input: {
  readonly crypto: LatticeCrypto;
  readonly handle: CryptoPostgresHandle;
  readonly userId: string;
  readonly actorId: string;
  readonly deviceId: string;
  readonly clientKind: "browser" | "electron" | "tui";
  readonly context:
    | { readonly kind: "preparation"; readonly authorityId: string }
    | {
      readonly kind: "pending_encrypted_invite";
      readonly authorityId: string;
    };
  readonly lineageMarker: number;
  readonly signing?: {
    readonly publicKey: Uint8Array;
    readonly privateKey: Uint8Array;
  };
}) {
  let recoveryMnemonic = "";
  const signing = input.signing ?? input.crypto.generateSigningKeyPair();
  const encryption = await input.crypto.generateEncryptionKeyPair();
  const lineage = new Uint8Array(32).fill(input.lineageMarker);
  const preparedRequest = await prepareInitialDeviceBootstrapRequest({
    crypto: input.crypto,
    request: {
      userId: valueOf(nautiloUserId(input.userId)),
      humanActorId: valueOf(nautiloActorId(input.actorId)),
      deviceId: cryptoDeviceId(input.deviceId),
      clientKind: input.clientKind,
      installationLineageDigest: lineage,
      signingPublicKey: signing.publicKey,
      encryptionPublicKey: encryption.publicKey,
      context: input.context,
      idempotencyKey: `bootstrap_${input.deviceId}`,
    },
    presentRecoveryKit(presentation) {
      recoveryMnemonic = presentation.revealMnemonic();
      return {
        status: "confirmed",
      };
    },
  });
  const recovery = {
    keyId: preparedRequest.recoveryKeyId,
    publicKey: preparedRequest.recoveryPublicKey,
  };
  const archive = await publishHumanRecoveryArchive({
    crypto: input.crypto,
    humanId: humanId(input.actorId),
    recoveryKeyId: recovery.keyId,
    recoveryGeneration: recoveryKeyGenerationV2(1),
    recoveryPublicKey: recovery.publicKey,
    resolveTrustedCurrentRecoveryKey: () => ({
      humanId: humanId(input.actorId),
      recoveryKeyId: recovery.keyId,
      recoveryGeneration: recoveryKeyGenerationV2(1),
      publicKeyDigest: input.crypto.hash(recovery.publicKey),
    }),
    issuerDeviceId: cryptoDeviceId(input.deviceId),
    createdAt: unixTimestamp(10_000),
    sources: [],
    issuerSigningPrivateKey: signing.privateKey,
    resolveIssuerDevice: () => signing.publicKey,
  });
  const service = new InitialDeviceBootstrapService({
    crypto: input.crypto,
    repository: new PostgresInitialDeviceBootstrapRepository(input.handle),
    authorize: createSyntheticInitialDeviceAuthorizer({
      expectedUserId: valueOf(nautiloUserId(input.userId)),
      expectedHumanActorId: valueOf(nautiloActorId(input.actorId)),
      expectedInstallationLineageDigest: lineage,
      authorizationDigest: new Uint8Array(32).fill(
        input.lineageMarker + 1,
      ),
      allowedContext: input.context,
    }),
    authorizeReceiptLookup: () => true,
  });
  const challenge = await service.begin(preparedRequest);
  const receipt = await service.complete(createInitialDeviceBootstrapProof({
    crypto: input.crypto,
    challenge,
    recoveryArchiveBytes: archive.archiveBytes,
    signingPrivateKey: signing.privateKey,
  }));
  return { signing, receipt, recoveryMnemonic };
}

function authorizeProvider(
  expected: ProviderPublicHeadV2,
  next: ProviderPublicHeadV2,
) {
  return authorizeProviderHeadWriteForTesting({
    expected,
    next,
    nextRosterBytes: new Uint8Array([0x41, 0x42, next.epoch]),
    authorization: {
      providerId: expected.providerId,
      domainId: expected.domainId,
      authorizationRevision: authorizationRevision(0),
      actorDeviceId: cryptoDeviceId("device-integration-provider"),
      operation: "update",
      targetHumanId: humanId("human-integration-alice"),
      targetDeviceId: cryptoDeviceId("device-integration-target"),
      currentHead: expected,
      nextHead: next,
      candidateId: "candidate-integration",
      publicTransitionDigest: new Uint8Array(32).fill(0x44),
    },
  });
}

function byteRepresentations(value: unknown): readonly string[] {
  if (value instanceof Uint8Array) {
    return [
      new TextDecoder().decode(value),
      Buffer.from(value).toString("hex"),
      Buffer.from(value).toString("base64"),
    ];
  }
  if (Array.isArray(value)) {
    return value.flatMap(byteRepresentations);
  }
  if (value !== null && typeof value === "object") {
    return Object.values(value).flatMap(byteRepresentations);
  }
  return [String(value)];
}

async function rejectedError(operation: Promise<unknown>): Promise<Error> {
  try {
    await operation;
  } catch (error) {
    return error instanceof Error ? error : new Error(String(error));
  }
  throw new Error("Expected operation to reject");
}

beforeAll(() => {
  admin = sqlClient(adminUrl, 2);
});

beforeEach(async () => {
  await truncateCryptoStorage();
});

afterAll(async () => {
  await admin.end();
});

describe.serial("Postgres lattice storage integration", () => {
  test("reconciles the exact role, policy, and table privilege boundary", async () => {
    const roles = await admin.unsafe<{
      rolname: string;
      rolsuper: boolean;
      rolinherit: boolean;
      rolcreaterole: boolean;
      rolcreatedb: boolean;
      rolcanlogin: boolean;
      rolreplication: boolean;
      rolbypassrls: boolean;
    }[]>(`
      SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb,
             rolcanlogin, rolreplication, rolbypassrls
        FROM pg_roles
       WHERE rolname = 'nautilo_crypto'
    `);
    expect([...roles]).toEqual([{
      rolname: "nautilo_crypto",
      rolsuper: false,
      rolinherit: false,
      rolcreaterole: false,
      rolcreatedb: false,
      rolcanlogin: true,
      rolreplication: false,
      rolbypassrls: false,
    }]);

    const memberships = await admin.unsafe<{ role_name: string }[]>(`
      SELECT role.rolname AS role_name
        FROM pg_auth_members membership
        JOIN pg_roles role ON role.oid = membership.roleid
       WHERE membership.member = (
         SELECT oid FROM pg_roles WHERE rolname = 'nautilo_crypto'
       )
    `);
    expect([...memberships]).toEqual([]);

    const tables = await admin.unsafe<{
      table_name: string;
      row_security: boolean;
      force_row_security: boolean;
    }[]>(`
      SELECT relname AS table_name,
             relrowsecurity AS row_security,
             relforcerowsecurity AS force_row_security
        FROM pg_class
       WHERE relnamespace = 'public'::regnamespace
         AND relname = ANY($1::text[])
       ORDER BY relname
    `, [[
      ...CRYPTO_STORAGE_TABLE_NAMES,
      ...DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
    ]]);
    expect(tables.map((table) => table.table_name)).toEqual(
      [
        ...CRYPTO_STORAGE_TABLE_NAMES,
        ...DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
      ].sort(),
    );
    expect(
      tables.every((table) =>
        table.row_security && table.force_row_security
      ),
    ).toBe(true);

    const policies = await admin.unsafe<{
      table_name: string;
      roles: string[];
    }[]>(`
      SELECT tablename AS table_name, roles
        FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename = ANY($1::text[])
    `, [[
      ...CRYPTO_STORAGE_TABLE_NAMES,
      ...DOMAIN_KEY_AUTHORITY_TABLE_NAMES,
    ]]);
    expect(policies.length).toBeGreaterThanOrEqual(
      (
        CRYPTO_STORAGE_TABLE_NAMES.length
        + DOMAIN_KEY_AUTHORITY_TABLE_NAMES.length
      ) * 2,
    );
    expect(
      policies.every((policy) =>
        policy.roles.length === 1
        && policy.roles[0] === "nautilo_crypto"
      ),
    ).toBe(true);

    const grants = await admin.unsafe<{
      table_name: string;
      privilege_type: string;
    }[]>(`
      SELECT table_name, privilege_type
        FROM information_schema.role_table_grants
       WHERE table_schema = 'public'
         AND grantee = 'nautilo_crypto'
       ORDER BY table_name, privilege_type
    `);
    const expectedGrants = Object.entries(
      CRYPTO_TABLE_PRIVILEGES,
    ).flatMap(([tableName, privileges]) =>
      privileges.map((privilege) => ({
        table_name: tableName,
        privilege_type: privilege,
      }))
    ).sort((left, right) =>
      `${left.table_name}:${left.privilege_type}`.localeCompare(
        `${right.table_name}:${right.privilege_type}`,
      )
    );
    expect([...grants]).toEqual(expectedGrants);

    const identityColumnGrants = await admin.unsafe<{
      table_name: string;
      column_name: string;
      privilege_type: string;
    }[]>(`
      SELECT table_name, column_name, privilege_type
        FROM information_schema.role_column_grants
       WHERE table_schema = 'public'
         AND grantee = 'nautilo_crypto'
         AND table_name IN ('users', 'actors')
       ORDER BY table_name, column_name, privilege_type
    `);
    expect([...identityColumnGrants]).toEqual([
      {
        table_name: "actors",
        column_name: "id",
        privilege_type: "SELECT",
      },
      {
        table_name: "actors",
        column_name: "kind",
        privilege_type: "SELECT",
      },
      {
        table_name: "actors",
        column_name: "owner_id",
        privilege_type: "SELECT",
      },
      {
        table_name: "users",
        column_name: "id",
        privilege_type: "SELECT",
      },
    ]);
  });

  test("accepts only a direct crypto login and denies product-role access", async () => {
    for (const url of [adminUrl, appUrl, agentUrl]) {
      const client = sqlClient(url, 1);
      try {
        expect(
          (await rejectedError(
            verifyCryptoPostgresHandle(connection(client)),
          )).message,
        ).toContain("must authenticate directly as nautilo_crypto");
      } finally {
        await client.end();
      }
    }

    const setRoleAdmin = sqlClient(adminUrl, 1);
    try {
      await setRoleAdmin.unsafe("SET ROLE nautilo_crypto");
      expect(
        (await rejectedError(
          verifyCryptoPostgresHandle(connection(setRoleAdmin)),
        )).message,
      ).toContain("must authenticate directly as nautilo_crypto");
    } finally {
      await setRoleAdmin.end();
    }

    const agent = sqlClient(agentUrl, 1);
    try {
      await rejectedError(agent.unsafe("SELECT * FROM crypto_domains"));
    } finally {
      await agent.end();
    }

    const app = sqlClient(appUrl, 1);
    try {
      const rows = await app.unsafe<{ count: string }[]>(
        "SELECT count(*)::text AS count FROM crypto_domains",
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await app.end();
    }

    const intruderRows = await admin.begin(async (transaction) => {
      await transaction.unsafe("SET LOCAL ROLE lattice_intruder");
      return transaction.unsafe<{ count: string }[]>(
        "SELECT count(*)::text AS count FROM crypto_domains",
      );
    });
    expect(intruderRows[0]?.count).toBe("0");
  });

  test("passes the complete shared adapter contract and product scenario", async () => {
    const live = await cryptoStorage();
    try {
      const report = await runLatticeStorageContract(live.storage);
      expect(report.calledMethods).toEqual(LATTICE_STORAGE_METHODS);
      expect(report.statuses).toEqual({
        domainCreate: "created",
        domainReplay: "existing",
        providerCreate: "inserted",
        providerReplay: "existing",
        providerAdvance: "applied",
        providerDuplicate: "duplicate",
        providerStale: "stale",
        namespaceDuplicate: "duplicate",
        namespaceStale: "stale",
        objectDuplicate: "duplicate",
        objectStale: "stale",
        runtimeCreate: "inserted",
        runtimeReplay: "existing",
        challengeReserve: "applied",
        challengeDuplicate: "duplicate",
        challengeStale: "stale",
        runtimeRotate: "applied",
        runtimeRotateDuplicate: "duplicate",
        runtimeRotateStale: "stale",
        runtimeAuthorizationTransition: "applied",
        runtimeAuthorizationTransitionDuplicate: "duplicate",
        runtimeAuthorizationTransitionStale: "stale",
        recoveryCreate: "applied",
        recoveryReplay: "duplicate",
      });
      expect(report.grant).toEqual({
        beforeConsume: false,
        firstConsume: true,
        secondConsumeMissing: true,
      });
    } finally {
      await live.client.end();
    }
  });

  test("rolls back Runtime state when atomic signer publication insertion fails", async () => {
    const injectedFailure =
      new Error("injected signer publication insert failure");
    const live = await cryptoStorage((statement) => {
      if (/insert into "?agent_crypto_runtime_signers"?/i.test(statement)) {
        throw injectedFailure;
      }
    });
    try {
      const crypto = new LatticeCrypto(seededRng(0x237_61));
      const managerSigning = crypto.generateSigningKeyPair();
      const currentManager = {
        managerHumanId: humanId("human-pg-rollback-manager"),
        managerAuthorizationRevision: authorizationRevision(3),
        managerDeviceId: cryptoDeviceId("device-pg-rollback-manager"),
      } as const;
      const prepared = await prepareAgentRuntimeInitialization({
        crypto,
        operationId: "operation-pg-runtime-rollback",
        agentId: agentId("agent-pg-runtime-rollback"),
        authorizationRevision: authorizationRevision(3),
        configObjects: [{
          objectId: objectId("config-pg-runtime-rollback"),
          configRevision: authorizationRevision(1),
          plaintextDek: new Uint8Array(32).fill(0x61),
        }],
        domains: [],
        resolveCurrentDomainCommitterAuthority: () => null,
        manager: currentManager,
        managerSigningPrivateKey: managerSigning.privateKey,
        resolveCurrentManagerAuthority: () => managerSigning.publicKey,
      });

      const error = await persistAgentRuntimeInitialization({
        crypto,
        storage: live.storage,
        prepared,
        resolveCurrentAuthorization: () => ({
          currentState: prepared.intended.runtime,
          currentManager,
          currentManagerSigningPublicKey: managerSigning.publicKey,
          domains: [],
        }),
      }).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(
        AgentRuntimeInitializationOutcomeUnknown,
      );
      expect((error as Error).cause).toBe(injectedFailure);

      const rows = await admin.unsafe<{
        runtime_count: number;
        signer_count: number;
      }[]>(`
        SELECT
          (SELECT count(*)::int
             FROM agent_crypto_runtime_states
            WHERE agent_id = 'agent-pg-runtime-rollback') AS runtime_count,
          (SELECT count(*)::int
             FROM agent_crypto_runtime_signers
            WHERE agent_id = 'agent-pg-runtime-rollback') AS signer_count
      `);
      expect([...rows]).toEqual([{
        runtime_count: 0,
        signer_count: 0,
      }]);
    } finally {
      await live.client.end();
    }
  });

  test("preserves one exact signer through replay and authorization-only transition", async () => {
    const live = await cryptoStorage();
    try {
      const crypto = new LatticeCrypto(
        seededRng(0x237_62),
        { now: () => 7_237_620 },
      );
      const managerSigning = crypto.generateSigningKeyPair();
      const domainSigning = crypto.generateSigningKeyPair();
      const currentManager = {
        managerHumanId: humanId("human-pg-signer-manager"),
        managerAuthorizationRevision: authorizationRevision(6),
        managerDeviceId: cryptoDeviceId("device-pg-signer-manager"),
      } as const;
      const currentDomain = {
        domainId: cryptoDomainId("domain-pg-signer-current"),
        domainEpoch: domainEpoch(2),
        agentAuthorizationRevision: authorizationRevision(10),
        committerDeviceId: cryptoDeviceId("device-pg-signer-domain"),
      } as const;
      const prepared = await prepareAgentRuntimeInitialization({
        crypto,
        operationId: "operation-pg-signer-initialization",
        agentId: agentId("agent-pg-signer-history"),
        authorizationRevision: authorizationRevision(10),
        configObjects: [{
          objectId: objectId("config-pg-signer-history"),
          configRevision: authorizationRevision(1),
          plaintextDek: new Uint8Array(32).fill(0x62),
        }],
        domains: [{
          ...currentDomain,
          domainRoot: new Uint8Array(32).fill(0x63),
          committerSigningPrivateKey: domainSigning.privateKey,
        }],
        resolveCurrentDomainCommitterAuthority: () =>
          domainSigning.publicKey,
        manager: currentManager,
        managerSigningPrivateKey: managerSigning.privateKey,
        resolveCurrentManagerAuthority: () => managerSigning.publicKey,
      });
      const initializationAuthorization = () => ({
        currentState: prepared.intended.runtime,
        currentManager,
        currentManagerSigningPublicKey: managerSigning.publicKey,
        domains: [{
          ...currentDomain,
          committerSigningPublicKey: domainSigning.publicKey,
        }],
      });
      expect(await persistAgentRuntimeInitialization({
        crypto,
        storage: live.storage,
        prepared,
        resolveCurrentAuthorization: initializationAuthorization,
      })).toBe("inserted");
      expect(await persistAgentRuntimeInitialization({
        crypto,
        storage: live.storage,
        prepared,
        resolveCurrentAuthorization: initializationAuthorization,
      })).toBe("duplicate");

      const signerBefore =
        await live.storage.getAgentRuntimeSignerPublication(
          prepared.runtime.agentId,
          prepared.runtime.generation,
        );
      expect(signerBefore).toEqual(prepared.signerPublication);

      const conflictingPublication = {
        ...prepared.signerPublication,
        operationId: "operation-pg-signer-conflict",
      };
      expect(
        (await rejectedError(
          live.storage.putAgentRuntimeAtomicStateIfAbsent(
          authorizeAgentRuntimeInitializationWriteForTesting({
            state: prepared.intended,
            authorization: {
              context: {
                purpose: "persist-agent-runtime-initialization",
                operationId: conflictingPublication.operationId,
                expectedState: prepared.intended.runtime,
                expectedManager: currentManager,
                configInventory: prepared.intended.configInventory,
                expectedDomains: [currentDomain],
              },
              currentManager,
              currentManagerSigningPublicKey: managerSigning.publicKey,
              authorizedDomains: [{
                ...currentDomain,
                committerSigningPublicKey: domainSigning.publicKey,
              }],
            },
            signerPublication: conflictingPublication,
          }),
        ))).message,
      ).toContain(
        "signer publication history does not match initialized state",
      );

      const plan: AgentRuntimeAuthorizationTransitionPlan = {
        operationId: "operation-pg-signer-authorization-transition",
        agentId: prepared.runtime.agentId,
        oldAuthorizationRevision: authorizationRevision(10),
        newAuthorizationRevision: authorizationRevision(11),
        currentRuntimeGeneration: prepared.runtime.generation,
        currentManager,
        activeConfigInventory: prepared.intended.configInventory,
        currentDomains: [currentDomain],
        remainingDomains: [],
        refreshedDomainIds: [],
      };
      const source =
        createProtectedAgentRuntimeAuthorizationTransitionSourcePort({
          crypto,
          currentState: prepared.intended.runtime,
          currentRuntime: prepared.runtime,
          plan,
          resolveCurrentManagerAuthority: () =>
            managerSigning.publicKey,
          resolveCurrentHandoffManagerAuthority: () =>
            managerSigning.publicKey,
          resolveCurrentTargetCommitter: () =>
            domainSigning.publicKey,
          managerSigningPrivateKey: managerSigning.privateKey,
        });
      const currentState = () =>
        live.storage.getAgentRuntimeAtomicState(
          prepared.runtime.agentId,
        );
      const challengeAuthorization =
        async (context: Readonly<{
          readonly remainingDomains:
            readonly AgentRuntimeAuthorizationDomain[];
        }>): Promise<AgentRuntimeRotationPersistenceAuthorization | null> => {
          const current = await currentState();
          return current === null
            ? null
            : {
              currentState: current.runtime,
              currentManager,
              currentManagerSigningPublicKey: managerSigning.publicKey,
              remainingDomains: context.remainingDomains.map((domain) => ({
                ...domain,
                committerSigningPublicKey: domainSigning.publicKey,
              })),
            };
        };
      const transitionAuthorization =
        async (): Promise<
          AgentRuntimeAuthorizationTransitionPersistenceAuthorization | null
        > => {
          const current = await currentState();
          return current === null
            ? null
            : {
              currentState: current.runtime,
              currentManager,
              managerSigningPublicKey: managerSigning.publicKey,
              currentDomains: [{
                ...currentDomain,
                committerSigningPublicKey: domainSigning.publicKey,
              }],
              remainingDomains: [],
            };
        };
      expect(await coordinateProtectedAgentRuntimeAuthorizationTransition({
        crypto,
        storage: live.storage,
        source,
        targets: [],
        resolveChallengeReservationAuthorization:
          challengeAuthorization,
        resolveTransitionPersistenceAuthorization:
          transitionAuthorization,
      })).toEqual({
        status: "completed",
        persistence: "applied",
      });

      const signerAfter =
        await live.storage.getAgentRuntimeSignerPublication(
          prepared.runtime.agentId,
          prepared.runtime.generation,
        );
      expect(signerAfter).toEqual(signerBefore);
      const signerRows = await admin.unsafe<{ count: number }[]>(`
        SELECT count(*)::int AS count
          FROM agent_crypto_runtime_signers
         WHERE agent_id = 'agent-pg-signer-history'
      `);
      expect([...signerRows]).toEqual([{ count: 1 }]);
      expect(
        (await rejectedError(live.client.unsafe(
          `UPDATE agent_crypto_runtime_signers
              SET operation_id = 'forbidden'
            WHERE agent_id = 'agent-pg-signer-history'`,
        ))).message,
      ).toMatch(/permission denied|row-level security/i);
      expect(
        (await rejectedError(live.client.unsafe(
          `DELETE FROM agent_crypto_runtime_signers
            WHERE agent_id = 'agent-pg-signer-history'`,
        ))).message,
      ).toMatch(/permission denied|row-level security/i);
      expect(
        await live.storage.getAgentRuntimeSignerPublication(
          prepared.runtime.agentId,
          prepared.runtime.generation,
        ),
      ).toEqual(signerBefore);
    } finally {
      await live.client.end();
    }
  });

  test("persists protected Agent Runtime rotation atomically without client custody canaries", async () => {
    const live = await cryptoStorage();
    let liveClosed = false;
    let reconnected: Awaited<ReturnType<typeof cryptoStorage>> | null =
      null;
    try {
      const now = 7_000_000;
      const crypto = new LatticeCrypto(
        seededRng(0x235_70),
        { now: () => now },
      );
      const managerSigning = crypto.generateSigningKeyPair();
      const targetSigningA = crypto.generateSigningKeyPair();
      const targetSigningB = crypto.generateSigningKeyPair();
      const initialRoot = new Uint8Array(32).fill(0x31);
      const targetRootA = new Uint8Array(32).fill(0x41);
      const targetRootB = new Uint8Array(32).fill(0x42);
      const configDek = new Uint8Array(32).fill(0xc1);
      const currentManager = {
        managerHumanId: humanId("human-pg-alice"),
        managerAuthorizationRevision: authorizationRevision(9),
        managerDeviceId: cryptoDeviceId("manager-pg-device"),
      } as const;
      const prepared = await prepareAgentRuntimeInitialization({
        crypto,
        operationId: "operation-pg-runtime-initialization",
        agentId: agentId("agent-pg-wave-8"),
        authorizationRevision: authorizationRevision(20),
        configObjects: [{
          objectId: objectId("config-pg-wave-8"),
          configRevision: authorizationRevision(2),
          plaintextDek: configDek,
        }],
        domains: [{
          domainId: cryptoDomainId("domain-pg-old"),
          domainEpoch: domainEpoch(2),
          agentAuthorizationRevision: authorizationRevision(20),
          committerDeviceId: cryptoDeviceId("manager-pg-device"),
          domainRoot: initialRoot,
          committerSigningPrivateKey: managerSigning.privateKey,
        }],
        resolveCurrentDomainCommitterAuthority: () =>
          managerSigning.publicKey,
        manager: currentManager,
        managerSigningPrivateKey: managerSigning.privateKey,
        resolveCurrentManagerAuthority: () =>
          managerSigning.publicKey,
      });
      expect(await persistAgentRuntimeInitialization({
        crypto,
        storage: live.storage,
        prepared,
        resolveCurrentAuthorization: () => ({
          currentState: prepared.intended.runtime,
          currentManager,
          currentManagerSigningPublicKey: managerSigning.publicKey,
          domains: [{
            domainId: cryptoDomainId("domain-pg-old"),
            domainEpoch: domainEpoch(2),
            agentAuthorizationRevision: authorizationRevision(20),
            committerDeviceId:
              cryptoDeviceId("manager-pg-device"),
            committerSigningPublicKey: managerSigning.publicKey,
          }],
        }),
      })).toBe("inserted");
      const generationZeroSigner =
        await live.storage.getAgentRuntimeSignerPublication(
          prepared.runtime.agentId,
          prepared.runtime.generation,
        );
      expect(generationZeroSigner).toEqual(prepared.signerPublication);

      const activeConfigObjects:
        readonly AgentRuntimeConfigObjectV2[] =
          prepared.intended.configObjects.map((record) =>
            Object.freeze({
              agentId: agentId(record.agentId),
              objectId: objectId(record.objectId),
              configRevision:
                authorizationRevision(record.configRevision),
              runtimeGeneration:
                agentRuntimeGeneration(record.runtimeGeneration),
              wrappedDek: record.wrappedDek.ciphertext.slice(),
            })
          );
      const remainingDomains = [{
        domainId: cryptoDomainId("domain-pg-a"),
        domainEpoch: domainEpoch(4),
        agentAuthorizationRevision: authorizationRevision(21),
        committerDeviceId: cryptoDeviceId("device-pg-a"),
      }, {
        domainId: cryptoDomainId("domain-pg-b"),
        domainEpoch: domainEpoch(5),
        agentAuthorizationRevision: authorizationRevision(21),
        committerDeviceId: cryptoDeviceId("device-pg-b"),
      }] as const;
      const plan: AgentRuntimeAuthorizationPlan = {
        operationId: "operation-pg-global-rotation",
        agentId: agentId("agent-pg-wave-8"),
        oldAuthorizationRevision: authorizationRevision(20),
        newAuthorizationRevision: authorizationRevision(21),
        currentRuntimeGeneration: agentRuntimeGeneration(0),
        runtimeRotationRequired: true,
        currentManager,
        activeConfigInventory: prepared.intended.configInventory,
        remainingDomains,
      };
      const targetAuthority = ({ target }: {
        readonly target: { readonly committerDeviceId: string };
      }) =>
        target.committerDeviceId === "device-pg-a"
          ? targetSigningA.publicKey
          : targetSigningB.publicKey;
      const currentAuthorization:
        AgentRuntimeRotationPersistenceAuthorization = {
          currentState: prepared.intended.runtime,
          currentManager,
          currentManagerSigningPublicKey: managerSigning.publicKey,
          remainingDomains: remainingDomains.map((domain) => ({
            ...domain,
            committerSigningPublicKey:
              domain.committerDeviceId === "device-pg-a"
                ? targetSigningA.publicKey
                : targetSigningB.publicKey,
          })),
        };
      const source = createProtectedAgentRuntimeRotationSourcePort({
        crypto,
        currentState: prepared.intended.runtime,
        currentRuntime: prepared.runtime,
        plan,
        activeConfigObjects,
        resolveCurrentManagerAuthority: () =>
          managerSigning.publicKey,
        resolveCurrentHandoffManagerAuthority: () =>
          managerSigning.publicKey,
        resolveCurrentTargetCommitter: targetAuthority,
        managerSigningPrivateKey: managerSigning.privateKey,
      });
      const targets = await Promise.all([
        createProtectedAgentRuntimeRotationTargetPort({
          crypto,
          domainId: "domain-pg-a",
          targetDomainRoot: targetRootA,
          targetCommitterSigningPrivateKey: targetSigningA.privateKey,
          resolveCurrentManagerAuthority: () =>
            managerSigning.publicKey,
          resolveCurrentTargetCommitter: targetAuthority,
          ttlMs: 60_000,
        }),
        createProtectedAgentRuntimeRotationTargetPort({
          crypto,
          domainId: "domain-pg-b",
          targetDomainRoot: targetRootB,
          targetCommitterSigningPrivateKey: targetSigningB.privateKey,
          resolveCurrentManagerAuthority: () =>
            managerSigning.publicKey,
          resolveCurrentTargetCommitter: targetAuthority,
          ttlMs: 60_000,
        }),
      ]);
      expect(await coordinateProtectedAgentRuntimeRotation({
        crypto,
        storage: live.storage,
        source,
        targets,
        resolveChallengeReservationAuthorization: () =>
          currentAuthorization,
        resolveRotationPersistenceAuthorization: async () => {
          const current =
            await live.storage.getAgentRuntimeAtomicState(
              "agent-pg-wave-8",
            );
          return current === null
            ? null
            : { ...currentAuthorization, currentState: current.runtime };
        },
        resolveCurrentRotationManagerAuthority: () =>
          managerSigning.publicKey,
        resolveCurrentTargetCommitter: targetAuthority,
      })).toEqual({
        status: "completed",
        persistence: "applied",
      });

      const stored =
        await live.storage.getAgentRuntimeAtomicState(
          "agent-pg-wave-8",
        );
      expect(stored?.runtime).toEqual({
        agentId: agentId("agent-pg-wave-8"),
        authorizationRevision: authorizationRevision(21),
        runtimeGeneration: agentRuntimeGeneration(1),
      });
      expect(
        stored?.domainEnvelopes.map((record) => record.domainId),
      ).toEqual(["domain-pg-a", "domain-pg-b"]);
      expect(stored?.configObjects).toHaveLength(1);
      const generationOneSigner =
        await live.storage.getAgentRuntimeSignerPublication(
          "agent-pg-wave-8",
          1,
        );
      expect(generationOneSigner?.transitionKind).toBe("rotation");
      expect(
        await live.storage.getAgentRuntimeSignerPublication(
          prepared.runtime.agentId,
          prepared.runtime.generation,
        ),
      ).toEqual(generationZeroSigner);

      const runtimeRows = await Promise.all([
        admin.unsafe("SELECT * FROM agent_crypto_runtime_states"),
        admin.unsafe(
          "SELECT * FROM agent_crypto_runtime_config_objects",
        ),
        admin.unsafe(
          "SELECT * FROM agent_crypto_runtime_domain_envelopes",
        ),
        admin.unsafe(
          "SELECT * FROM agent_crypto_runtime_challenges",
        ),
        admin.unsafe(
          "SELECT * FROM agent_crypto_runtime_signers ORDER BY runtime_generation",
        ),
      ]);
      const serverSnapshot = byteRepresentations(runtimeRows).join("\n");
      for (const secret of [
        prepared.runtime.key,
        configDek,
        initialRoot,
        targetRootA,
        targetRootB,
        managerSigning.privateKey,
        targetSigningA.privateKey,
        targetSigningB.privateKey,
      ]) {
        expect(serverSnapshot).not.toContain(
          Buffer.from(secret).toString("hex"),
        );
        expect(serverSnapshot).not.toContain(
          Buffer.from(secret).toString("base64"),
        );
      }

      await live.client.end();
      liveClosed = true;
      reconnected = await cryptoStorage();
      expect(
        await reconnected.storage.getAgentRuntimeAtomicState(
          "agent-pg-wave-8",
        ),
      ).toEqual(stored);
    } finally {
      if (reconnected !== null) await reconnected.client.end();
      if (!liveClosed) await live.client.end();
    }
  });

  test("preserves shared-domain bytes and namespace separation after reconnect", async () => {
    const first = await cryptoStorage();
    const report = await runSyntheticSharedDomainScenario(first.storage);
    const objectBefore = await first.storage.getObject(
      "synthetic-object-one",
    );
    await first.client.end();

    const second = await cryptoStorage();
    try {
      const objectAfter = await second.storage.getObject(
        "synthetic-object-one",
      );
      expect(objectAfter).toEqual(objectBefore);
      expect(report.domain.firstId).toBe(report.domain.secondId);
      expect(report.crossNamespaceRejected).toBe(true);
      expect(
        (await second.storage.getNamespaceHead(report.namespaces[0]))
          ?.domainId,
      ).toBe(report.domain.firstId);
      expect(
        (await second.storage.getNamespaceHead(report.namespaces[1]))
          ?.domainId,
      ).toBe(report.domain.firstId);
    } finally {
      await second.client.end();
    }
  });

  test("serializes concurrent creation, CAS, and single-use consumption", async () => {
    const live = await cryptoStorage();
    try {
      const participants = [humanId("human-concurrency-alice")];
      const domain = {
        id: cryptoDomainId("domain-concurrency"),
        participants,
        participantDigest: participantDigest(participants),
        epoch: domainEpoch(0),
        authorizationRevision: authorizationRevision(0),
        rosterBytes: new Uint8Array([0x41]),
      };
      const creates = await Promise.all(
        Array.from(
          { length: 8 },
          () => live.storage.createDomainIfAbsent(domain),
        ),
      );
      expect(
        creates.filter((result) => result.status === "created"),
      ).toHaveLength(1);
      expect(
        creates.filter((result) => result.status === "existing"),
      ).toHaveLength(7);

      const object = encryptedObjectWriteRecord(
        canonicalObjectPayload("object-concurrency"),
      );
      await Promise.all(
        Array.from({ length: 8 }, () => live.storage.putObject(object)),
      );
      const objectCount = await admin.unsafe<{ count: string }[]>(
        "SELECT count(*)::text AS count FROM crypto_objects",
      );
      expect(objectCount[0]?.count).toBe("1");

      const initialHead = providerHead(0, 0x51);
      const nextHead = providerHead(1, 0x52);
      expect(
        await live.storage.putDomainProviderHeadIfAbsent(
          initialHead,
          new Uint8Array([0x41]),
        ),
      ).toBe("inserted");
      const casResults = await Promise.all(
        Array.from(
          { length: 8 },
          () =>
            live.storage.compareAndSwapDomainProviderHead(
              authorizeProvider(initialHead, nextHead),
            ),
        ),
      );
      expect(casResults.filter((status) => status === "applied")).toHaveLength(
        1,
      );
      expect(
        casResults.filter((status) => status === "duplicate"),
      ).toHaveLength(7);

      const grant = grantWriteRecord(
        canonicalGrantWire("grant-concurrency"),
      );
      await Promise.all(
        Array.from({ length: 8 }, () => live.storage.putGrant(grant)),
      );
      const consumed = await Promise.all(
        Array.from(
          { length: 8 },
          () => live.storage.consumeGrant("grant-concurrency"),
        ),
      );
      expect(consumed.filter((record) => record !== null)).toHaveLength(1);
      expect(consumed.filter((record) => record === null)).toHaveLength(7);
    } finally {
      await live.client.end();
    }
  });

  test("accepts ephemeral foreground admission and rejects Namespace heads changed before CAS", async () => {
    const live = await cryptoStorage();
    const crypto = new LatticeCrypto(seededRng(0x311_99));
    const now = Date.now();
    const suffix = randomUUID();
    const domainIdValue = cryptoDomainId(`domain-agent-set-${suffix}`);
    const agentIdValue = agentId(`agent-agent-set-${suffix}`);
    const managerHumanId = humanId(`human-agent-set-${suffix}`);
    const managerDeviceId = cryptoDeviceId(`device-agent-set-${suffix}`);
    const manager = crypto.generateSigningKeyPair();
    const namespaceIds = [randomUUID(), randomUUID()].sort();
    const namespaceKeys = [
      new Uint8Array(32).fill(0x71),
      new Uint8Array(32).fill(0x72),
    ];
    const domainHeadDigest = crypto.hash(
      new TextEncoder().encode(`domain-head-${suffix}`),
    );
    const domainGeneration = domainEpoch(3);
    const domainAuthorization = authorizationRevision(7);
    try {
      // Foreground runtime keys and reusable Grant admission are ephemeral.
      // No crypto_grants or legacy Agent runtime/signer rows are published.
      const runtime = {
        agentId: agentIdValue,
        keyClass: "runtime" as const,
        generation: agentRuntimeGeneration(0),
        key: new Uint8Array(32).fill(0x70),
      };
      const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
      const initialized = {
        runtime,
        signerPublication: {
          signerKeyId: signer.principal.signerKeyId,
          signerPublicKey: signer.publicKey,
        },
      };
      const grantIdValue = grantId(`grant-agent-set-${suffix}`);
      const recipientKeyId = `recipient-agent-set-${suffix}`;
      const grantHash = crypto.hash(new Uint8Array([0x74]));
      async function advanceNamespaceHead(namespaceIdValue: string) {
        const operationId = `binding-race-${randomUUID()}`;
        await admin.begin(async (transaction) => {
          await transaction.unsafe(
            `INSERT INTO namespace_domain_key_bindings (
               operation_id, idempotency_key, namespace_id, domain_id,
               key_class, domain_key_generation, domain_authorization_revision,
               domain_head_digest, namespace_access_revision,
               namespace_current_generation, bundle_revision,
               retained_generation_count, retained_authority_set_digest,
               previous_binding_digest, binding_digest, plaintext_digest,
               ciphertext_digest, binding_bytes, issuer_human_id,
               issuer_device_id, issuer_device_signing_generation, state,
               created_at, updated_at, deadline_at, activated_at
             ) SELECT $2, $2, binding.namespace_id, binding.domain_id,
               binding.key_class, binding.domain_key_generation,
               binding.domain_authorization_revision, binding.domain_head_digest,
               binding.namespace_access_revision + 1,
               binding.namespace_current_generation + 1,
               binding.bundle_revision + 1, binding.retained_generation_count,
               binding.retained_authority_set_digest, binding.binding_digest,
               $3, binding.plaintext_digest, binding.ciphertext_digest,
               binding.binding_bytes, binding.issuer_human_id,
               binding.issuer_device_id, binding.issuer_device_signing_generation,
               'active', NOW(), NOW(), NOW() + INTERVAL '1 hour', NOW()
             FROM namespace_domain_key_bindings AS binding
             JOIN namespace_domain_key_heads AS head
               ON head.binding_operation_id = binding.operation_id
             WHERE head.namespace_id = $1 AND head.key_class = 'ai'`,
            [namespaceIdValue, operationId, crypto.hash(new TextEncoder().encode(operationId))],
          );
          await transaction.unsafe(
            `UPDATE namespace_domain_key_heads AS head SET
               namespace_access_revision = binding.namespace_access_revision,
               namespace_current_generation = binding.namespace_current_generation,
               bundle_revision = binding.bundle_revision,
               binding_digest = binding.binding_digest,
               binding_operation_id = binding.operation_id,
               activated_at = binding.activated_at
             FROM namespace_domain_key_bindings AS binding
             WHERE head.namespace_id = $1 AND head.key_class = 'ai'
               AND binding.operation_id = $2`,
            [namespaceIdValue, operationId],
          );
        });
      }

      const retainedDigests = namespaceIds.map((id) =>
        crypto.hash(new TextEncoder().encode(`namespace-head-${id}`))
      );
      for (const [index, namespaceIdValue] of namespaceIds.entries()) {
        const bindingDigest = crypto.hash(
          new TextEncoder().encode(`binding-${namespaceIdValue}`),
        );
        const operationId = `binding-agent-set-${index}-${suffix}`;
        await admin.unsafe(
          `INSERT INTO namespace_domain_key_bindings (
             operation_id, idempotency_key, namespace_id, domain_id,
             key_class, domain_key_generation,
             domain_authorization_revision, domain_head_digest,
             namespace_access_revision, namespace_current_generation,
             bundle_revision, retained_generation_count,
             retained_authority_set_digest, previous_binding_digest,
             binding_digest, plaintext_digest, ciphertext_digest,
             binding_bytes, issuer_human_id, issuer_device_id,
             issuer_device_signing_generation, state,
             created_at, updated_at, deadline_at, activated_at
           ) VALUES (
             $1, $2, $3, $4, 'ai', $5, $6, $7,
             4, 5, 1, 1, $8, NULL, $9, $10, $11, $12,
             $13, $14, 1, 'active', NOW(), NOW(), NOW() + INTERVAL '1 hour', NOW()
           )`,
          [
            operationId,
            `idempotency-agent-set-${index}-${suffix}`,
            namespaceIdValue,
            domainIdValue,
            domainGeneration,
            domainAuthorization,
            domainHeadDigest,
            retainedDigests[index]!,
            bindingDigest,
            crypto.hash(new Uint8Array([0x80 + index])),
            crypto.hash(new Uint8Array([0x82 + index])),
            new Uint8Array([0x84 + index]),
            managerHumanId,
            managerDeviceId,
          ],
        );
        await admin.unsafe(
          `INSERT INTO namespace_domain_key_heads (
             namespace_id, key_class, domain_id, domain_key_generation,
             domain_authorization_revision, domain_head_digest,
             namespace_access_revision, namespace_current_generation,
             bundle_revision, retained_generation_count,
             retained_authority_set_digest, binding_digest,
             binding_operation_id, activated_at
           ) VALUES ($1, 'ai', $2, $3, $4, $5, 4, 5, 1, 1, $6, $7, $8, NOW())`,
          [
            namespaceIdValue,
            domainIdValue,
            domainGeneration,
            domainAuthorization,
            domainHeadDigest,
            retainedDigests[index]!,
            bindingDigest,
            operationId,
          ],
        );
      }

      const objectIdValue = objectId(`object-agent-set-${suffix}`);
      const payloadBytes = encodeEncryptedPayloadV2({
        formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
        context: {
          objectId: objectIdValue,
          keyClass: "ai",
          objectType: "memory",
          createdAt: unixTimestamp(now),
        },
        ciphertext: new Uint8Array(48).fill(0x76),
      });
      await live.storage.putObject(encryptedObjectWriteRecord(payloadBytes));
      const prepared =
        prepareDeviceWrappedAgentObjectAccessManifestGenesisSet(crypto, {
          objectId: objectIdValue,
          payloadHash: crypto.hash(payloadBytes),
          envelopeBytes: namespaceIds.map((namespaceIdValue, index) =>
            encodeNamespaceObjectEnvelopeV2(wrapObjectDekForNamespace(
              crypto,
              namespaceKeys[index]!,
              {
                objectId: objectIdValue,
                namespaceId: namespaceId(namespaceIdValue),
                keyClass: "ai",
                keyGeneration: namespaceGeneration(5),
                bindingRevisionAtWrap: accessRevision(4),
              },
              new Uint8Array(32).fill(0x77),
            ))
          ),
          operationId: `publish-agent-set-${suffix}`,
          grant: {
            grantId: grantIdValue,
            grantHash,
            recipientKeyId,
          },
          namespaces: namespaceIds.map((namespaceIdValue, index) => ({
            namespaceId: namespaceIdValue,
            accessRevision: 4,
            keyGeneration: 5,
            domainId: domainIdValue,
            domainKeyGeneration: domainGeneration,
            domainAuthorizationRevision: domainAuthorization,
            domainHeadDigest,
            headDigest: retainedDigests[index]!,
            publicationDigest: retainedDigests[index]!,
            publicationSetDigest: retainedDigests[index]!,
            audienceFingerprint: retainedDigests[index]!,
          })),
          agentAuthorizationRevision: 9,
          runtime: initialized.runtime,
          signerKeyId: initialized.signerPublication.signerKeyId,
          signerPublicKey: initialized.signerPublication.signerPublicKey,
        });
      const resolveSetAdmission = (context: typeof prepared.authority) => ({
        context,
        grantAuthorized: true,
        namespacesAuthorized: true,
        agentAuthorized: true,
        hostAllowsOperation: true,
        currentRuntime: {
          agentId: agentIdValue,
          authorizationRevision: authorizationRevision(9),
          runtimeGeneration: initialized.runtime.generation,
        },
        signerPublicKey: initialized.signerPublication.signerPublicKey,
      });
      for (const expected of ["applied", "duplicate"] as const) {
        expect(await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet({
          crypto,
          storage: live.storage,
          prepared,
          resolveCurrentAuthorization: resolveSetAdmission,
        })).toBe(expected);
      }
      const originalSetState = await live.storage.getObjectAccessState(objectIdValue);
      expect(await persistPreparedDeviceWrappedAgentObjectAccessManifestGenesisSet({
        crypto,
        storage: live.storage,
        prepared,
        resolveCurrentAuthorization: async (context) => {
          await advanceNamespaceHead(namespaceIds[1]!);
          return resolveSetAdmission(context);
        },
      })).toBe("stale");
      expect(await live.storage.getObjectAccessState(objectIdValue)).toEqual(originalSetState);

      const messageGrantId = grantId(`grant-agent-message-${suffix}`);
      const messageObjectId = objectId(`object-agent-message-${suffix}`);
      const messagePayloadBytes = encodeEncryptedPayloadV2({
        formatVersion: ENCRYPTED_PAYLOAD_FORMAT_VERSION_V2,
        context: {
          objectId: messageObjectId,
          keyClass: "ai",
          objectType: "message",
          createdAt: unixTimestamp(now),
        },
        ciphertext: new Uint8Array(48).fill(0x7a),
      });
      await live.storage.putObject(
        encryptedObjectWriteRecord(messagePayloadBytes),
      );
      const messageEnvelopeBytes = encodeNamespaceObjectEnvelopeV2(
        wrapObjectDekForNamespace(
          crypto,
          namespaceKeys[0]!,
          {
            objectId: messageObjectId,
            namespaceId: namespaceId(namespaceIds[0]!),
            keyClass: "ai",
            keyGeneration: namespaceGeneration(5),
            bindingRevisionAtWrap: accessRevision(4),
          },
          new Uint8Array(32).fill(0x7b),
        ),
      );
      const messagePrepared =
        prepareDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(
          crypto,
          {
            objectId: messageObjectId,
            payloadHash: crypto.hash(messagePayloadBytes),
            envelopeBytes: [messageEnvelopeBytes],
            operationId: `publish-agent-message-${suffix}`,
            grant: {
              grantId: messageGrantId,
              grantHash,
              recipientKeyId,
            },
            namespace: {
              namespaceId: namespaceIds[0]!,
              accessRevision: 4,
              keyGeneration: 5,
              headDigest: retainedDigests[0]!,
              publicationDigest: retainedDigests[0]!,
              publicationSetDigest: retainedDigests[0]!,
              audienceFingerprint: retainedDigests[0]!,
            },
            agentAuthorizationRevision: 9,
            runtime: initialized.runtime,
            signerKeyId: initialized.signerPublication.signerKeyId,
            signerPublicKey: initialized.signerPublication.signerPublicKey,
          },
        );
      expect(
        await persistPreparedDeviceWrappedLiveShadowAgentObjectAccessManifestGenesis(
          {
            crypto,
            storage: live.storage,
            prepared: messagePrepared,
            resolveCurrentAuthorization: async (context) => {
              await advanceNamespaceHead(namespaceIds[0]!);
              return Object.freeze({
                context,
                grantAuthorized: true,
                namespaceAuthorized: true,
                agentAuthorized: true,
                hostAllowsOperation: true,
                currentRuntime: Object.freeze({
                  agentId: agentIdValue,
                  authorizationRevision: authorizationRevision(9),
                  runtimeGeneration: initialized.runtime.generation,
                }),
                signerPublicKey: initialized.signerPublication.signerPublicKey,
              });
            },
          },
        ),
      ).toBe("stale");
      expect(await live.storage.getObjectAccessState(messageObjectId)).toBeNull();
      messageEnvelopeBytes.fill(0);
      initialized.runtime.key.fill(0);
    } finally {
      namespaceKeys.forEach((key) => key.fill(0));
      manager.privateKey.fill(0);
      manager.publicKey.fill(0);
      domainHeadDigest.fill(0);
      await live.client.end();
    }
  });

  test("rolls back a partially written multi-table family", async () => {
    const live = await cryptoStorage((statement) => {
      if (/insert into "?namespace_crypto_heads"?/i.test(statement)) {
        throw new Error("injected integration rollback");
      }
    });
    try {
      expect(
        (await rejectedError(
          runSyntheticSharedDomainScenario(live.storage),
        )).message,
      ).toContain("outcome is ambiguous");
      const rows = await admin.unsafe<{
        bindings: string;
        heads: string;
      }[]>(`
        SELECT
          (SELECT count(*) FROM namespace_crypto_bindings)::text AS bindings,
          (SELECT count(*) FROM namespace_crypto_heads)::text AS heads
      `);
      expect([...rows]).toEqual([{ bindings: "0", heads: "0" }]);
    } finally {
      await live.client.end();
    }
  });

  test("fails closed on corruption and rejects oversized records before persistence", async () => {
    const live = await cryptoStorage();
    try {
      await runSyntheticSharedDomainScenario(live.storage);
      await admin.unsafe(
        `UPDATE crypto_objects
            SET payload_bytes = $1
          WHERE object_id = 'synthetic-object-one'`,
        [new Uint8Array([0])],
      );
      await rejectedError(live.storage.getObject("synthetic-object-one"));

      const oversized = {
        objectId: "object-oversized",
        payloadBytes: new Uint8Array(
          CRYPTO_STORAGE_BYTE_LIMITS.encryptedObject + 1,
        ),
      } as unknown as Parameters<typeof live.storage.putObject>[0];
      await rejectedError(live.storage.putObject(oversized));
      const rows = await admin.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count
           FROM crypto_objects
          WHERE object_id = 'object-oversized'`,
      );
      expect(rows[0]?.count).toBe("0");
    } finally {
      await live.client.end();
    }
  });

  test("keeps history append-only and stores no plaintext or raw key markers", async () => {
    const live = await cryptoStorage();
    try {
      await runSyntheticSharedDomainScenario(live.storage);
      await rejectedError(
        live.storage.putObject({
          objectId: "object-marker-oversized",
          payloadBytes: new Uint8Array(
            CRYPTO_STORAGE_BYTE_LIMITS.encryptedObject + 1,
          ),
        } as unknown as Parameters<typeof live.storage.putObject>[0]),
      );

      await rejectedError(
        live.client.unsafe(
          `UPDATE crypto_objects
              SET payload_bytes = payload_bytes
            WHERE object_id = 'synthetic-object-one'`,
        ),
      );
      await rejectedError(
        live.client.unsafe(
          `DELETE FROM crypto_objects
            WHERE object_id = 'synthetic-object-one'`,
        ),
      );

      const representations: string[] = [];
      for (const table of CRYPTO_STORAGE_TABLE_NAMES) {
        const rows = await admin.unsafe(`SELECT * FROM ${table}`);
        representations.push(...byteRepresentations(rows));
      }
      const durableDump = representations.join("\n");
      expect(durableDump).not.toContain("synthetic namespace one");
      expect(durableDump).not.toContain("synthetic namespace two");
      expect(durableDump).not.toContain("51".repeat(32));
      expect(durableDump).not.toContain("61".repeat(32));
    } finally {
      await live.client.end();
    }
  });

  test("retires an expired first-device attempt before allowing retry", async () => {
    const userId = valueOf(
      nautiloUserId("00000000-0000-4000-8000-0000000000da"),
    );
    const actorId = valueOf(
      nautiloActorId("00000000-0000-4000-8000-0000000000db"),
    );
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'Crypto retry fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES ($1, $2, 'Crypto retry fixture', 'verified', 'user')`,
      [actorId, userId],
    );

    const client = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const repository = new PostgresInitialDeviceBootstrapRepository(handle);
      const common = {
        userId,
        humanActorId: actorId,
        clientKind: "browser" as const,
        installationLineageDigest: new Uint8Array(32).fill(0x11),
        recoveryKeyId: "recovery_retry_fixture",
        recoveryPublicKey: new Uint8Array(65).fill(0x21),
        context: {
          kind: "preparation" as const,
          authorityId: "preparation_retry_fixture",
        },
      };
      const firstChallengeId = `bootstrap_${"31".repeat(32)}`;
      const first = await repository.begin({
        request: {
          ...common,
          deviceId: "device_pg_expired",
          signingPublicKey: new Uint8Array(32).fill(0x31),
          encryptionPublicKey: new Uint8Array(65).fill(0x41),
          idempotencyKey: "bootstrap_pg_expired",
        },
        authorizationDigest: new Uint8Array(32).fill(0x51),
        challengeId: firstChallengeId,
        challengeHash: new Uint8Array(32).fill(0x61),
        publicFingerprint: new Uint8Array(32).fill(0x71),
        signingPublicKeyDigest: new Uint8Array(32).fill(0x81),
        encryptionPublicKeyDigest: new Uint8Array(32).fill(0x91),
        recoveryPublicKeyDigest: new Uint8Array(32).fill(0xa1),
        issuedAt: 10_000,
        expiresAt: 310_000,
      });
      expect(first.status).toBe("created");

      const retryChallengeId = `bootstrap_${"32".repeat(32)}`;
      const retry = await repository.begin({
        request: {
          ...common,
          deviceId: "device_pg_retry",
          signingPublicKey: new Uint8Array(32).fill(0x32),
          encryptionPublicKey: new Uint8Array(65).fill(0x42),
          idempotencyKey: "bootstrap_pg_retry",
        },
        authorizationDigest: new Uint8Array(32).fill(0x52),
        challengeId: retryChallengeId,
        challengeHash: new Uint8Array(32).fill(0x62),
        publicFingerprint: new Uint8Array(32).fill(0x72),
        signingPublicKeyDigest: new Uint8Array(32).fill(0x82),
        encryptionPublicKeyDigest: new Uint8Array(32).fill(0x92),
        recoveryPublicKeyDigest: new Uint8Array(32).fill(0xa1),
        issuedAt: 310_000,
        expiresAt: 610_000,
      });
      expect(retry.status).toBe("created");

      const states = await admin.unsafe<{
        challenge_id: string;
        challenge_result: string | null;
        device_state: string;
        operation_state: string;
      }[]>(`
        SELECT c.challenge_id,
               c.terminal_result_code AS challenge_result,
               d.state AS device_state,
               o.state AS operation_state
          FROM human_crypto_device_challenges c
          JOIN human_crypto_devices d
            ON d.device_id = c.pending_device_id
          JOIN crypto_delivery_operations o
            ON o.operation_id = ('operation_' || c.challenge_id)
         WHERE c.human_id = $1
         ORDER BY c.issued_at
      `, [actorId]);
      expect([...states]).toEqual([
        {
          challenge_id: firstChallengeId,
          challenge_result: "challenge_expired",
          device_state: "rejected",
          operation_state: "failed",
        },
        {
          challenge_id: retryChallengeId,
          challenge_result: null,
          device_state: "pending",
          operation_state: "awaiting_target_device",
        },
      ]);
    } finally {
      await client.end();
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("serializes two concurrent first-device enrollments for one Human", async () => {
    const userId = valueOf(
      nautiloUserId("00000000-0000-4000-8000-0000000000ea"),
    );
    const actorId = valueOf(
      nautiloActorId("00000000-0000-4000-8000-0000000000eb"),
    );
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'Crypto race fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES ($1, $2, 'Crypto race fixture', 'verified', 'user')`,
      [actorId, userId],
    );

    const firstClient = sqlClient(cryptoUrl, 1);
    const secondClient = sqlClient(cryptoUrl, 1);
    try {
      const [firstHandle, secondHandle] = await Promise.all([
        verifyCryptoPostgresHandle(connection(firstClient)),
        verifyCryptoPostgresHandle(connection(secondClient)),
      ]);
      const firstRepository =
        new PostgresInitialDeviceBootstrapRepository(firstHandle);
      const secondRepository =
        new PostgresInitialDeviceBootstrapRepository(secondHandle);
      const candidate = (
        suffix: "first" | "second",
        marker: number,
      ): Parameters<
        PostgresInitialDeviceBootstrapRepository["begin"]
      >[0] => ({
        request: {
          userId,
          humanActorId: actorId,
          deviceId: `device_pg_race_${suffix}`,
          clientKind: "browser",
          installationLineageDigest: new Uint8Array(32).fill(marker),
          signingPublicKey: new Uint8Array(32).fill(marker + 1),
          encryptionPublicKey: new Uint8Array(65).fill(marker + 2),
          recoveryKeyId: `recovery_pg_race_${suffix}`,
          recoveryPublicKey: new Uint8Array(65).fill(marker + 3),
          context: {
            kind: "preparation",
            authorityId: "preparation_pg_race",
          },
          idempotencyKey: `bootstrap_pg_race_${suffix}`,
        },
        authorizationDigest: new Uint8Array(32).fill(marker + 4),
        challengeId: `bootstrap_${marker.toString(16).padStart(2, "0").repeat(32)}`,
        challengeHash: new Uint8Array(32).fill(marker + 5),
        publicFingerprint: new Uint8Array(32).fill(marker + 6),
        signingPublicKeyDigest: new Uint8Array(32).fill(marker + 7),
        encryptionPublicKeyDigest: new Uint8Array(32).fill(marker + 8),
        recoveryPublicKeyDigest: new Uint8Array(32).fill(marker + 9),
        issuedAt: 10_000,
        expiresAt: 310_000,
      });

      const results = await Promise.all([
        firstRepository.begin(candidate("first", 0x11)),
        secondRepository.begin(candidate("second", 0x31)),
      ]);
      expect(results.map(({ status }) => status).sort()).toEqual([
        "created",
        "stale_state",
      ]);

      const durable = await admin.unsafe<{
        custody_state: string;
        ever_initialized: boolean;
        devices: string;
        challenges: string;
        operations: string;
      }[]>(`
        SELECT custody.state AS custody_state,
               custody.ever_initialized_at IS NOT NULL AS ever_initialized,
               (
                 SELECT count(*) FROM human_crypto_devices device
                  WHERE device.human_id = custody.human_id
               )::text AS devices,
               (
                 SELECT count(*) FROM human_crypto_device_challenges challenge
                  WHERE challenge.human_id = custody.human_id
               )::text AS challenges,
               (
                 SELECT count(*) FROM crypto_delivery_operations operation
                  WHERE operation.human_id = custody.human_id
               )::text AS operations
          FROM human_crypto_custodies custody
         WHERE custody.human_id = $1
      `, [actorId]);
      expect([...durable]).toEqual([{
        custody_state: "initializing",
        ever_initialized: false,
        devices: "1",
        challenges: "1",
        operations: "1",
      }]);
    } finally {
      await Promise.all([firstClient.end(), secondClient.end()]);
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("never reopens first bootstrap after every device is lost", async () => {
    const userId = "00000000-0000-4000-8000-0000000000da";
    const actorId = "00000000-0000-4000-8000-0000000000db";
    await admin.unsafe(
      `INSERT INTO users (id, name)
       VALUES ($1, 'Permanent-loss bootstrap fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES (
         $1, $2, 'Permanent-loss bootstrap fixture', 'verified', 'user'
       )`,
      [actorId, userId],
    );

    const client = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const crypto = deterministicBootstrapCrypto();
      await bootstrapSyntheticHuman({
        crypto,
        handle,
        userId,
        actorId,
        deviceId: "device_permanent_loss_original",
        clientKind: "browser",
        context: {
          kind: "preparation",
          authorityId: "preparation_permanent_loss_original",
        },
        lineageMarker: 0x61,
      });
      await admin.unsafe(
        `UPDATE human_crypto_devices
            SET state = 'revoked',
                revoked_at = '2026-01-01T00:00:00.000Z',
                revision = revision + 1
          WHERE human_id = $1`,
        [actorId],
      );
      await admin.unsafe(
        `UPDATE human_crypto_custodies
            SET state = 'recovery_required',
                revision = revision + 1
          WHERE human_id = $1`,
        [actorId],
      );

      expect(
        (await rejectedError(bootstrapSyntheticHuman({
          crypto,
          handle,
          userId,
          actorId,
          deviceId: "device_permanent_loss_rebootstrap",
          clientKind: "electron",
          context: {
            kind: "preparation",
            authorityId: "preparation_permanent_loss_rebootstrap",
          },
          lineageMarker: 0x62,
        }))).message,
      ).toContain("already_initialized");

      const durable = await admin.unsafe<{
        state: string;
        ever_initialized: boolean;
        device_count: string;
        operation_count: string;
      }[]>(
        `SELECT custody.state,
                custody.ever_initialized_at IS NOT NULL AS ever_initialized,
                (
                  SELECT count(*) FROM human_crypto_devices device
                   WHERE device.human_id = custody.human_id
                )::text AS device_count,
                (
                  SELECT count(*) FROM crypto_delivery_operations operation
                   WHERE operation.human_id = custody.human_id
                )::text AS operation_count
           FROM human_crypto_custodies custody
          WHERE custody.human_id = $1`,
        [actorId],
      );
      expect([...durable]).toEqual([{
        state: "recovery_required",
        ever_initialized: true,
        device_count: "1",
        operation_count: "1",
      }]);
    } finally {
      await client.end();
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("prunes terminal delivery state in bounded deterministic batches", async () => {
    const totalOperations =
      CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch + 1;
    await admin.unsafe(
      `INSERT INTO crypto_delivery_operations (
         operation_id, idempotency_key, kind, state,
         aggregate_payload_bytes, fanout_row_count,
         retry_count, maximum_attempts, failure_code,
         created_at, updated_at, deadline_at, terminal_at
       )
       SELECT
         'prune_operation_' || ordinal::text,
         'prune/idempotency/' || ordinal::text,
         'domain_rebootstrap',
         'failed',
         0,
         0,
         8,
         8,
         'prune_fixture',
         '2025-01-01T00:00:00.000Z',
         '2025-01-02T00:00:00.000Z',
         '2025-01-03T00:00:00.000Z',
         '2025-01-02T00:00:00.000Z'
       FROM generate_series(1, $1::integer) AS ordinal`,
      [totalOperations],
    );
    const client = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const repository = new PostgresDeliveryMaintenanceRepository(handle);
      expect(await repository.pruneRetainedState({
        now: Date.parse("2026-01-01T00:00:00.000Z"),
      })).toMatchObject({
        operations: CRYPTO_DELIVERY_COLLECTION_LIMITS.pruningBatch,
      });
      const remaining = await admin.unsafe<{ count: string }[]>(
        `SELECT count(*)::text AS count
           FROM crypto_delivery_operations
          WHERE operation_id LIKE 'prune_operation_%'`,
      );
      expect(remaining[0]?.count).toBe("1");
      expect(await repository.pruneRetainedState({
        now: Date.parse("2026-01-01T00:00:00.000Z"),
      })).toMatchObject({ operations: 1 });
    } finally {
      await client.end();
    }
  });

  test("persists approved additional-device activation after challenge expiry", async () => {
    const userId = valueOf(
      nautiloUserId("00000000-0000-4000-8000-0000000000ca"),
    );
    const actorId = valueOf(
      nautiloActorId("00000000-0000-4000-8000-0000000000cb"),
    );
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'Crypto bootstrap fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES ($1, $2, 'Crypto bootstrap fixture', 'verified', 'user')`,
      [actorId, userId],
    );

    const client = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const crypto = deterministicBootstrapCrypto();
      const repository = new PostgresInitialDeviceBootstrapRepository(handle);
      const lineage = new Uint8Array(32).fill(0x31);
      const authorizationEvidence = new Uint8Array(32).fill(0x41);
      const context = {
        kind: "preparation" as const,
        authorityId: "preparation_pg_1",
      };
      const service = new InitialDeviceBootstrapService({
        crypto,
        repository,
        authorize: createSyntheticInitialDeviceAuthorizer({
          expectedUserId: userId,
          expectedHumanActorId: actorId,
          expectedInstallationLineageDigest: lineage,
          authorizationDigest: authorizationEvidence,
          allowedContext: context,
        }),
        authorizeReceiptLookup: () => true,
      });
      const signing = crypto.generateSigningKeyPair();
      const encryption = await crypto.generateEncryptionKeyPair();
      let recoveryMnemonic = "";
      const preparedRequest = await prepareInitialDeviceBootstrapRequest({
        crypto,
        request: {
          userId,
          humanActorId: actorId,
          deviceId: cryptoDeviceId("device_pg_initial"),
          clientKind: "browser",
          installationLineageDigest: lineage,
          signingPublicKey: signing.publicKey,
          encryptionPublicKey: encryption.publicKey,
          context,
          idempotencyKey: "bootstrap_pg_initial",
        },
        presentRecoveryKit(presentation) {
          recoveryMnemonic = presentation.revealMnemonic();
          return {
            status: "confirmed",
          };
        },
      });
      const recovery = {
        keyId: preparedRequest.recoveryKeyId,
        publicKey: preparedRequest.recoveryPublicKey,
      };
      const recoveryDigest = crypto.hash(recovery.publicKey);
      const deviceId = cryptoDeviceId(preparedRequest.deviceId);
      const archive = await publishHumanRecoveryArchive({
        crypto,
        humanId: humanId(actorId),
        recoveryKeyId: recovery.keyId,
        recoveryGeneration: recoveryKeyGenerationV2(1),
        recoveryPublicKey: recovery.publicKey,
        resolveTrustedCurrentRecoveryKey: () => ({
          humanId: humanId(actorId),
          recoveryKeyId: recovery.keyId,
          recoveryGeneration: recoveryKeyGenerationV2(1),
          publicKeyDigest: recoveryDigest,
        }),
        issuerDeviceId: deviceId,
        createdAt: unixTimestamp(10_000),
        sources: [],
        issuerSigningPrivateKey: signing.privateKey,
        resolveIssuerDevice: () => signing.publicKey,
      });
      const challenge = await service.begin(preparedRequest);
      const completion = createInitialDeviceBootstrapProof({
        crypto,
        challenge,
        recoveryArchiveBytes: archive.archiveBytes,
        signingPrivateKey: signing.privateKey,
      });
      const receipt = await service.complete(completion);
      expect(await service.complete(completion)).toEqual(receipt);

      const state = await admin.unsafe<{
        custody_state: string;
        device_state: string;
        recovery_state: string;
        challenge_result: string;
        operation_state: string;
        archive_bytes: Uint8Array;
      }[]>(`
        SELECT h.state AS custody_state,
               d.state AS device_state,
               r.state AS recovery_state,
               c.terminal_result_code AS challenge_result,
               o.state AS operation_state,
               a.archive_bytes
          FROM human_crypto_custodies h
          JOIN human_crypto_devices d ON d.human_id = h.human_id
          JOIN human_crypto_recovery_keys r ON r.human_id = h.human_id
          JOIN human_crypto_device_challenges c
            ON c.human_id = h.human_id
          JOIN crypto_delivery_operations o
            ON o.operation_id = ('operation_' || c.challenge_id)
          JOIN human_crypto_recovery_archives a
            ON a.human_id = h.human_id
         WHERE h.human_id = $1
      `, [actorId]);
      expect(state).toHaveLength(1);
      expect(state[0]).toMatchObject({
        custody_state: "active",
        device_state: "active",
        recovery_state: "current",
        challenge_result: "active",
        operation_state: "active",
      });
      expect(state[0]?.archive_bytes).toEqual(archive.archiveBytes);
      const outbox = await admin.unsafe<{ count: string }[]>(`
        SELECT count(*)::text AS count
          FROM crypto_operation_outbox
         WHERE event_type = 'first_device_activated'
      `);
      expect(outbox[0]?.count).toBe("1");

      const outboxRepository = new PostgresCryptoOutboxRepository(handle);
      const crashedWorkerClaim = await outboxRepository.claim({
        workerId: "worker_bootstrap_crashed",
        now: receipt.committedAt + 1,
      });
      expect(crashedWorkerClaim).not.toBeNull();
      if (crashedWorkerClaim === null) {
        throw new Error("Bootstrap outbox event was not claimable");
      }
      expect(await outboxRepository.claim({
        workerId: "worker_bootstrap_early",
        now: crashedWorkerClaim.leaseExpiresAt - 1,
      })).toBeNull();
      const rescuingWorkerClaim = await outboxRepository.claim({
        workerId: "worker_bootstrap_rescue",
        now: crashedWorkerClaim.leaseExpiresAt,
      });
      expect(rescuingWorkerClaim).toMatchObject({
        outboxId: crashedWorkerClaim.outboxId,
        operationId: crashedWorkerClaim.operationId,
        sequence: crashedWorkerClaim.sequence,
        workerId: "worker_bootstrap_rescue",
        attempts: crashedWorkerClaim.attempts,
      });
      if (rescuingWorkerClaim === null) {
        throw new Error("Expired bootstrap outbox lease was not reclaimed");
      }
      expect(await outboxRepository.delivered({
        claim: crashedWorkerClaim,
        now: crashedWorkerClaim.leaseExpiresAt + 1,
      })).toBe("lost_lease");
      expect(await outboxRepository.delivered({
        claim: rescuingWorkerClaim,
        now: crashedWorkerClaim.leaseExpiresAt + 1,
      })).toBe("delivered");

      const snapshotRepresentations: string[] = [];
      for (const table of CRYPTO_STORAGE_TABLE_NAMES) {
        const rows = await admin.unsafe(`SELECT * FROM ${table}`);
        snapshotRepresentations.push(...byteRepresentations(rows));
      }
      const serverSnapshot = snapshotRepresentations.join("\n");
      expect(serverSnapshot).toContain(
        Buffer.from(archive.archiveBytes).toString("hex"),
      );
      for (const clientOnlySecret of [
        recoveryMnemonic,
        Buffer.from(signing.privateKey).toString("hex"),
        Buffer.from(encryption.privateKey).toString("hex"),
      ]) {
        expect(serverSnapshot).not.toContain(clientOnlySecret);
      }
      for (const recoveryWord of new Set(recoveryMnemonic.split(" "))) {
        expect(serverSnapshot).not.toContain(recoveryWord);
        expect(serverSnapshot).not.toContain(
          Buffer.from(recoveryWord).toString("hex"),
        );
        expect(serverSnapshot).not.toContain(
          Buffer.from(recoveryWord).toString("base64"),
        );
      }
      await rejectedError(openHumanRecoveryArchive({
          crypto,
          archiveBytes: archive.archiveBytes,
          humanId: humanId(actorId),
          currentRecoveryKeyId: recovery.keyId,
          currentRecoveryGeneration: recoveryKeyGenerationV2(1),
          recoveryPrivateKey: recovery.publicKey,
          resolveTrustedCurrentRecoveryKey: () => ({
            humanId: humanId(actorId),
            recoveryKeyId: recovery.keyId,
            recoveryGeneration: recoveryKeyGenerationV2(1),
            publicKeyDigest: recoveryDigest,
          }),
          expectedInventory: [],
          resolveIssuerDevice: () => signing.publicKey,
        }));

      const additionalSigning = crypto.generateSigningKeyPair();
      const additionalEncryption = await crypto.generateEncryptionKeyPair();
      const additionalLineage = new Uint8Array(32).fill(0x32);
      const additionalInventoryDigest = new Uint8Array(32).fill(0x43);
      const additionalInventoryCount = 2;
      await admin.unsafe(
        `UPDATE human_crypto_custodies
            SET current_inventory_revision = 1,
                current_inventory_count = $3,
                current_inventory_digest = $2
          WHERE human_id = $1`,
        [actorId, additionalInventoryDigest, additionalInventoryCount],
      );
      const additionalRepository =
        new PostgresAdditionalDeviceEnrollmentRepository(handle);
      const additionalService = new AdditionalDeviceEnrollmentService({
        crypto,
        repository: additionalRepository,
        authorize: createSyntheticAdditionalDeviceAuthorizer({
          expectedUserId: userId,
          expectedHumanActorId: actorId,
          expectedInstallationLineageDigest: additionalLineage,
          authorizationEvidenceDigest: new Uint8Array(32).fill(0x42),
          expectedCustodyRevision: 1,
          expectedRecoveryGeneration: 1,
          inventoryRevision: 1,
          inventoryCount: additionalInventoryCount,
          inventoryDigest: additionalInventoryDigest,
          activeDeviceCount: 1,
          pendingDeviceCount: 0,
        }),
      });
      const additionalRequest = {
        userId,
        humanActorId: actorId,
        deviceId: cryptoDeviceId("device_pg_additional"),
        clientKind: "electron" as const,
        installationLineageDigest: additionalLineage,
        deviceGeneration: 1,
        signingPublicKey: additionalSigning.publicKey,
        encryptionPublicKey: additionalEncryption.publicKey,
        method: "device_approval" as const,
        idempotencyKey: "additional_pg_device",
      };
      const pending = await additionalService.begin(additionalRequest);
      expect(pending.status).toBe("pending");
      expect((await additionalService.begin(additionalRequest)).operationId)
        .toBe(pending.operationId);

      const pendingState = await admin.unsafe<{
        device_state: string;
        challenge_kind: string;
        operation_kind: string;
        operation_state: string;
        device_revision: string;
      }[]>(`
        SELECT d.state AS device_state,
               c.kind AS challenge_kind,
               o.kind AS operation_kind,
               o.state AS operation_state,
               d.revision::text AS device_revision
          FROM human_crypto_devices d
          JOIN human_crypto_device_challenges c
            ON c.pending_device_id = d.device_id
          JOIN crypto_delivery_operations o
            ON o.target_device_id = d.device_id
         WHERE d.device_id = $1
      `, [additionalRequest.deviceId]);
      expect([...pendingState]).toEqual([{
        device_state: "pending",
        challenge_kind: "device_approval",
        operation_kind: "device_add",
        operation_state: "awaiting_committer",
        device_revision: "0",
      }]);

      const storage = createPostgresLatticeStorage(handle);
      const sharedDomain = await runSyntheticSharedDomainScenario(storage);
      const domainRows = await client.unsafe<{
        id: string;
        epoch: string;
        authorization_revision: string;
        participant_digest: Uint8Array;
        roster_bytes: Uint8Array;
      }[]>(
        `SELECT id, epoch::text, authorization_revision::text,
                participant_digest, roster_bytes
           FROM crypto_domains
          WHERE id = $1`,
        [sharedDomain.domain.firstId],
      );
      const domain = domainRows[0];
      const namespaceHeads = await Promise.all(
        sharedDomain.namespaces.map((namespaceId) =>
          storage.getNamespaceHead(namespaceId)
        ),
      );
      if (
        domain === undefined
        || namespaceHeads.some((head) => head === null)
      ) {
        throw new Error("Fanout integration inventory was not created");
      }
      const pendingCryptoDeviceId = cryptoDeviceId(pending.deviceId);
      const transferPackages = sharedDomain.namespaces.map(
        (sharedNamespaceId, index) => {
          const head = namespaceHeads[index]!;
          return {
            formatVersion: 2 as const,
            humanId: humanId(actorId),
            targetDeviceId: pendingCryptoDeviceId,
            pendingDeviceRevision:
              pendingDeviceRevisionV2(pending.deviceRevision),
            encryptionPublicKeyDigest:
              crypto.hash(additionalEncryption.publicKey),
            signingPublicKeyDigest: crypto.hash(additionalSigning.publicKey),
            namespaceId: namespaceId(sharedNamespaceId),
            keyClass: "human" as const,
            domainId: cryptoDomainId(domain.id),
            domainEpoch: domainEpoch(Number(domain.epoch)),
            accessRevision: accessRevision(head.accessRevision),
            currentGeneration: namespaceGeneration(1),
            bindingHash: head.bindingHash,
            issuerDeviceId: deviceId,
            createdAt: unixTimestamp(20_000),
            ciphertext: new Uint8Array(105).fill(0x71 + index),
          };
        },
      );
      const unsignedApproval: DeviceTransferApprovalV2 = {
        formatVersion: 2,
        humanId: humanId(actorId),
        targetDeviceId: pendingCryptoDeviceId,
        pendingDeviceRevision:
          pendingDeviceRevisionV2(pending.deviceRevision),
        encryptionPublicKeyDigest:
          crypto.hash(additionalEncryption.publicKey),
        signingPublicKeyDigest: crypto.hash(additionalSigning.publicKey),
        issuerDeviceId: deviceId,
        createdAt: unixTimestamp(20_000),
        inventoryRevision: deviceTransferInventoryRevisionV2(1),
        inventoryCount: additionalInventoryCount,
        inventoryDigest: additionalInventoryDigest,
        packages: transferPackages,
        joinIntents: [{
          formatVersion: 2,
          humanId: humanId(actorId),
          targetDeviceId: pendingCryptoDeviceId,
          pendingDeviceRevision:
            pendingDeviceRevisionV2(pending.deviceRevision),
          domainId: cryptoDomainId(domain.id),
          domainEpoch: domainEpoch(Number(domain.epoch)),
          committerDeviceId: deviceId,
        }],
        signature: new Uint8Array(64),
      };
      const approvalBytes = serializeDeviceTransferApprovalV2({
        ...unsignedApproval,
        signature: crypto.sign(
          signing.privateKey,
          deviceTransferApprovalSigningBytesV2(unsignedApproval),
        ),
      });
      const approvalManifest = createAdditionalDeviceApprovalManifest({
        crypto,
        enrollment: pending,
        approvalBytes,
        issuerDeviceId: deviceId,
        issuerSigningPrivateKey: signing.privateKey,
      });
      const approval = verifyAdditionalDeviceApproval({
        crypto,
        enrollment: pending,
        approvalBytes,
        manifest: approvalManifest,
        domains: [{
          domainId: domain.id,
          expectedEpoch: Number(domain.epoch),
          targetEpoch: Number(domain.epoch) + 1,
          expectedAuthorizationRevision:
            Number(domain.authorization_revision),
          expectedParticipantDigest: domain.participant_digest,
          committerDeviceId: deviceId,
          namespaces: sharedDomain.namespaces.map(
            (sharedNamespaceId, index) => {
              const head = namespaceHeads[index]!;
              return {
                namespaceId: sharedNamespaceId,
                expectedAccessRevision: head.accessRevision,
                expectedBindingHash: head.bindingHash,
              };
            },
          ),
        }],
        resolveActiveApprovingDevice: () => ({
          state: "active",
          signingPublicKey: signing.publicKey,
        }),
      });
      const admission = createDeviceFanoutAdmission({
        crypto,
        approval,
        now: 20_000,
      });
      const fanoutRepository =
        new PostgresDeviceFanoutAdmissionRepository(handle);
      expect(await fanoutRepository.admit(admission)).toEqual({
        status: "admitted",
      });
      expect(await fanoutRepository.admit(admission)).toEqual({
        status: "duplicate",
      });
      const admitted = await admin.unsafe<{
        operation_state: string;
        device_state: string;
        gate_count: string;
        domain_step_count: string;
        namespace_step_count: string;
        message_count: string;
        outbox_count: string;
      }[]>(`
        SELECT o.state AS operation_state,
               d.state AS device_state,
               (
                 SELECT count(*) FROM crypto_device_epoch_operations e
                  WHERE e.operation_id = o.operation_id
               )::text AS gate_count,
               (
                 SELECT count(*) FROM crypto_domain_transition_steps s
                  WHERE s.operation_id = o.operation_id
               )::text AS domain_step_count,
               (
                 SELECT count(*) FROM crypto_domain_transition_namespaces n
                  WHERE n.operation_id = o.operation_id
               )::text AS namespace_step_count,
               (
                 SELECT count(*) FROM crypto_delivery_messages m
                  WHERE m.operation_id = o.operation_id
               )::text AS message_count,
               (
                 SELECT count(*) FROM crypto_operation_outbox x
                  WHERE x.operation_id = o.operation_id
                    AND x.event_type = 'device_fanout_admitted'
               )::text AS outbox_count
          FROM crypto_delivery_operations o
          JOIN human_crypto_devices d ON d.device_id = o.target_device_id
         WHERE o.operation_id = $1
      `, [pending.operationId]);
      expect([...admitted]).toEqual([{
        operation_state: "awaiting_committer",
        device_state: "pending",
        gate_count: "1",
        domain_step_count: "1",
        namespace_step_count: String(sharedDomain.namespaces.length),
        message_count: "1",
        outbox_count: "1",
      }]);

      const joinProviderHead: ProviderPublicHeadV2 = {
        providerId: "provider-pg-device-fanout",
        domainId: cryptoDomainId(domain.id),
        epoch: domainEpoch(Number(domain.epoch)),
        stateHash: new Uint8Array(32).fill(0x81),
      };
      expect(
        await storage.putDomainProviderHeadIfAbsent(
          joinProviderHead,
          domain.roster_bytes,
        ),
      ).toBe("inserted");
      const providerHeadRows = await client.unsafe<{
        provider_id: string;
        epoch: string;
        state_hash: Uint8Array;
      }[]>(
        `SELECT provider_id, epoch::text, state_hash
           FROM crypto_domain_provider_heads
          WHERE domain_id = $1`,
        [domain.id],
      );
      const providerHeadRow = providerHeadRows[0];
      if (providerHeadRow === undefined) {
        throw new Error("Fanout provider head was not created");
      }
      const joinPackageBytes = new Uint8Array([0x81, 0x82, 0x83]);
      const joinPackageEnvelope = createDeviceJoinPackage({
        crypto,
        request: {
          formatVersion: 2,
          providerId: providerHeadRow.provider_id,
          domainId: domain.id,
          humanId: actorId,
          deviceId: pending.deviceId,
          expectedHead: {
            providerId: providerHeadRow.provider_id,
            domainId: domain.id,
            epoch: Number(providerHeadRow.epoch),
            stateHash: providerHeadRow.state_hash,
          },
          keyPackageBytes: joinPackageBytes,
        },
        generation: 1,
        packageId: "join_package_pg_1",
        createdAt: 21_000,
        expiresAt: 31_000,
        signingPrivateKey: additionalSigning.privateKey,
      });
      const joinPackage = verifyDeviceJoinPackage({
        crypto,
        envelope: joinPackageEnvelope,
        now: 21_001,
        resolveDevice: () => ({
          humanId: actorId,
          state: "pending",
          generation: 1,
          signingPublicKey: additionalSigning.publicKey,
        }),
        resolveProviderHead: () => ({
          providerId: providerHeadRow.provider_id,
          domainId: domain.id,
          epoch: Number(providerHeadRow.epoch),
          stateHash: providerHeadRow.state_hash,
        }),
      });
      const joinPackageRepository =
        new PostgresDeviceJoinPackageRepository(handle);
      expect(await joinPackageRepository.publish([joinPackage])).toEqual({
        status: "published",
        publishedCount: 1,
      });
      expect(await joinPackageRepository.publish([joinPackage])).toEqual({
        status: "duplicate",
        publishedCount: 1,
      });
      expect(await joinPackageRepository.claim({
        deviceId: pending.deviceId,
        domainId: domain.id,
        generation: 1,
        operationId: pending.operationId,
        now: 22_000,
      })).toMatchObject({
        status: "claimed",
        package: {
          packageId: "join_package_pg_1",
          packageBytes: joinPackageBytes,
        },
      });
      expect(await joinPackageRepository.claim({
        deviceId: pending.deviceId,
        domainId: domain.id,
        generation: 1,
        operationId: pending.operationId,
        now: 22_001,
      })).toEqual({ status: "missing" });

      const acknowledgementMessage = {
        messageId: admission.messages[0]!.messageId,
        recipientDeviceId: pending.deviceId,
        recipientSequence: 1,
        payloadHash: admission.messages[0]!.payloadHash,
      };
      const acknowledgementProof = createDeliveryAcknowledgementProof({
        crypto,
        message: acknowledgementMessage,
        processedRevision: 3,
        acknowledgedAt: 23_000,
        signingPrivateKey: additionalSigning.privateKey,
      });
      const deliveryAcknowledgement =
        verifyDeliveryAcknowledgementProof({
          crypto,
          proof: acknowledgementProof,
          message: acknowledgementMessage,
          resolveDevice: () => ({
            state: "pending",
            revision: 2,
            signingPublicKey: additionalSigning.publicKey,
          }),
        });
      const acknowledgementRepository =
        new PostgresDeliveryAcknowledgementRepository(handle);
      expect(
        await acknowledgementRepository.acknowledge(
          deliveryAcknowledgement,
          23_000,
        ),
      ).toEqual({ status: "acknowledged" });
      expect(
        await acknowledgementRepository.acknowledge(
          deliveryAcknowledgement,
          23_000,
        ),
      ).toEqual({ status: "duplicate" });

      const transitionLeaseRepository =
        new PostgresDomainTransitionLeaseRepository(handle);
      const firstLease = await transitionLeaseRepository.claim({
        workerId: "worker_pg_a",
        now: 24_000,
      });
      expect(firstLease).not.toBeNull();
      if (firstLease === null) {
        throw new Error("Domain transition lease was not claimed");
      }
      expect(await transitionLeaseRepository.fail({
        claim: firstLease,
        now: 25_000,
        failureCode: "provider_temporarily_unavailable",
        transient: true,
      })).toEqual({
        status: "retry_scheduled",
        retryCount: 1,
      });
      const retryAt = deliveryRetryAtMs(
        `${firstLease.operationId}/${firstLease.domainId}`,
        1,
        25_000,
      );
      expect(await transitionLeaseRepository.claim({
        workerId: "worker_pg_b",
        now: retryAt - 1,
      })).toBeNull();
      expect(await transitionLeaseRepository.claim({
        workerId: "worker_pg_b",
        now: retryAt,
      })).toMatchObject({
        operationId: firstLease.operationId,
        domainId: firstLease.domainId,
        workerId: "worker_pg_b",
        retryCount: 1,
      });
      await admin.unsafe(
        `UPDATE crypto_domain_transition_namespaces
            SET state = 'prepared',
                candidate_binding_hash = decode(repeat('a1', 32), 'hex'),
                candidate_signed_binding_bytes = decode('a2', 'hex'),
                candidate_human_keyring_envelope_bytes =
                  decode('a3', 'hex'),
                candidate_ai_keyring_envelope_bytes =
                  decode('a4', 'hex'),
                updated_at = $2::timestamptz
          WHERE operation_id = $1`,
        [pending.operationId, new Date(retryAt + 1).toISOString()],
      );
      await admin.unsafe(
        `UPDATE crypto_domain_transition_steps step
            SET state = 'ready_to_activate',
                expected_provider_state_hash = provider.state_hash,
                candidate_provider_id = provider.provider_id,
                candidate_provider_state_hash =
                  decode(repeat('b1', 32), 'hex'),
                candidate_roster_bytes =
                  provider.roster_bytes || decode('b2', 'hex'),
                candidate_transition_digest =
                  decode(repeat('b3', 32), 'hex'),
                candidate_target_leaf_index = 0,
                lease_owner = NULL,
                lease_expires_at = NULL, failure_code = NULL,
                updated_at = $2::timestamptz
           FROM crypto_domain_provider_heads provider
          WHERE step.operation_id = $1
            AND provider.domain_id = step.domain_id`,
        [pending.operationId, new Date(retryAt + 1).toISOString()],
      );
      await admin.unsafe(
        `UPDATE crypto_delivery_operations
            SET state = 'ready_to_activate',
                updated_at = $2::timestamptz
          WHERE operation_id = $1`,
        [pending.operationId, new Date(retryAt + 1).toISOString()],
      );
      await admin.unsafe(
        `UPDATE human_crypto_device_challenges
            SET expires_at = $2::timestamptz
          WHERE pending_device_id = $1`,
        [pending.deviceId, new Date(retryAt + 1).toISOString()],
      );
      const activationRepository =
        new PostgresDeviceActivationRepository(handle);
      const activationInput = {
        operationId: pending.operationId,
        activatedAt: retryAt + 2,
        auditRef: "audit_pg_device_activation",
        outboxId: "outbox_pg_device_activation",
      };
      expect(await activationRepository.activate(activationInput)).toEqual({
        status: "activated",
        deviceId: pending.deviceId,
        deviceRevision: 4,
        custodyRevision: 2,
      });
      expect(await activationRepository.activate(activationInput)).toEqual({
        status: "duplicate",
        deviceId: pending.deviceId,
        deviceRevision: 4,
        custodyRevision: 2,
      });
    } finally {
      await client.end();
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("orders Human-device Add, target Welcome, and exact current projection", async () => {
    const userId = "00000000-0000-4000-8000-0000000000ca";
    const actorId = "00000000-0000-4000-8000-0000000000cb";
    const firstDeviceId = "device_m304_browser";
    const targetDeviceId = "device_m304_desktop";
    const existingIdentity = await admin.unsafe<{
      server_instance_id: string;
    }[]>(`
      SELECT server_instance_id::text
        FROM nautilo_instance_identity
       WHERE id = 'self'
    `);
    const serverInstanceId = existingIdentity[0]?.server_instance_id
      ?? "018f3df1-8d42-7c59-a112-17d92f9aa304";
    const createdIdentity = existingIdentity.length === 0;
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES ($1, 'M304 fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES ($1, $2, 'M304 fixture', 'verified', 'user')`,
      [actorId, userId],
    );
    if (createdIdentity) {
      await admin.unsafe(
        `INSERT INTO nautilo_instance_identity (
           id, instance_id, server_instance_id, server_binding_generation
         ) VALUES ('self', 'm304-test', $1, 1)`,
        [serverInstanceId],
      );
    }

    const client = sqlClient(cryptoUrl, 1);
    const firstCrypto = new LatticeCrypto(seededRng(3_041));
    const targetCrypto = new LatticeCrypto(seededRng(3_042));
    const firstVault = DeviceProviderStateVault.fromKey(
      firstCrypto,
      cryptoDeviceId(firstDeviceId),
      new Uint8Array(32).fill(0x41),
    );
    const targetVault = DeviceProviderStateVault.fromKey(
      targetCrypto,
      cryptoDeviceId(targetDeviceId),
      new Uint8Array(32).fill(0x42),
    );
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const bootstrap = await bootstrapSyntheticHuman({
        crypto: firstCrypto,
        handle,
        userId,
        actorId,
        deviceId: firstDeviceId,
        clientKind: "browser",
        context: {
          kind: "preparation",
          authorityId: "preparation_m304_browser",
        },
        lineageMarker: 0x51,
      });
      const custodyRows = await admin.unsafe<{
        custody_revision: string;
        recovery_generation: string;
        inventory_revision: string | null;
        inventory_count: number | null;
        inventory_digest: Uint8Array | null;
        active_device_count: string;
        pending_device_count: string;
      }[]>(`
        SELECT custody.revision::text AS custody_revision,
               custody.current_recovery_generation::text
                 AS recovery_generation,
               custody.current_inventory_revision::text
                 AS inventory_revision,
               custody.current_inventory_count AS inventory_count,
               custody.current_inventory_digest AS inventory_digest,
               (
                 SELECT count(*)::text
                   FROM human_crypto_devices device
                  WHERE device.human_id = custody.human_id
                    AND device.state = 'active'
               ) AS active_device_count,
               (
                 SELECT count(*)::text
                   FROM human_crypto_devices device
                  WHERE device.human_id = custody.human_id
                    AND device.state = 'pending'
               ) AS pending_device_count
          FROM human_crypto_custodies custody
         WHERE custody.human_id = $1
      `, [actorId]);
      const custody = custodyRows[0];
      if (custody === undefined) throw new Error("M304 custody is unavailable");
      const inventoryRevision = custody.inventory_revision === null
        ? deviceTransferInventoryRevisionV2(0)
        : deviceTransferInventoryRevisionV2(
          Number(custody.inventory_revision),
        );
      const inventoryCount = custody.inventory_count ?? 0;
      const inventoryDigest = custody.inventory_digest
        ?? deviceTransferInventoryDigestV2({
          humanId: humanId(actorId),
          inventoryRevision,
          inventory: Object.freeze([]),
        });
      const coordinates = Object.freeze({
        serverInstanceId,
        humanId: humanId(actorId),
        lineageGeneration: 1,
      });
      const firstCredential = Object.freeze({
        formatVersion: 1 as const,
        ...coordinates,
        deviceId: cryptoDeviceId(firstDeviceId),
        installationLineageDigest: new Uint8Array(32).fill(0x51),
        deviceKeyGeneration: 1,
      });
      const targetCredential = Object.freeze({
        formatVersion: 1 as const,
        ...coordinates,
        deviceId: cryptoDeviceId(targetDeviceId),
        installationLineageDigest: new Uint8Array(32).fill(0x52),
        deviceKeyGeneration: 1,
      });
      const firstGroup = new HumanDeviceOpenMlsGroup(
        firstCrypto,
        firstVault,
        { coordinates, ownCredential: firstCredential },
      );
      const targetGroup = new HumanDeviceOpenMlsGroup(
        targetCrypto,
        targetVault,
        { coordinates, ownCredential: targetCredential },
      );
      await Promise.all([firstGroup.initialize(), targetGroup.initialize()]);
      const founded = await firstGroup.createInitialState();
      const [initialMember] = decodeHumanDeviceRoster(founded.rosterBytes);
      const [storedDevice] = await client.unsafe<{
        device_generation: string;
        installation_lineage_digest: Uint8Array;
        state: string;
        membership_state: string;
      }[]>(`
        SELECT device_generation::text, installation_lineage_digest,
               state, membership_state
          FROM human_crypto_devices
         WHERE device_id = $1
      `, [firstDeviceId]);
      expect(storedDevice).toMatchObject({
        device_generation: String(initialMember?.deviceKeyGeneration),
        state: "active",
        membership_state: "unbound",
      });
      expect(storedDevice?.installation_lineage_digest).toEqual(
        initialMember?.installationLineageDigest,
      );
      const repository = new PostgresHumanDeviceGroupRepository(
        handle,
        firstCrypto,
      );
      expect(await repository.establishInitial({
        userId,
        humanId: actorId,
        deviceId: firstDeviceId,
        headBytes: encodeHumanDeviceGroupHead(founded.head),
        rosterBytes: founded.rosterBytes,
        now: Date.now(),
      })).toBe("created");

      const targetSigning = targetCrypto.generateSigningKeyPair();
      const targetEncryption = await targetCrypto.generateEncryptionKeyPair();
      const enrollment = await new AdditionalDeviceEnrollmentService({
        crypto: targetCrypto,
        repository: new PostgresAdditionalDeviceEnrollmentRepository(
          handle,
          false,
        ),
        enforceLegacyFleetBounds: false,
        authorize: createSyntheticAdditionalDeviceAuthorizer({
          expectedUserId: valueOf(nautiloUserId(userId)),
          expectedHumanActorId: valueOf(nautiloActorId(actorId)),
          expectedInstallationLineageDigest:
            targetCredential.installationLineageDigest,
          authorizationEvidenceDigest: new Uint8Array(32).fill(0x61),
          expectedCustodyRevision: Number(custody.custody_revision),
          expectedRecoveryGeneration: Number(custody.recovery_generation),
          inventoryRevision,
          inventoryCount,
          inventoryDigest,
          activeDeviceCount: Number(custody.active_device_count),
          pendingDeviceCount: Number(custody.pending_device_count),
        }),
      }).begin({
        userId: valueOf(nautiloUserId(userId)),
        humanActorId: valueOf(nautiloActorId(actorId)),
        deviceId: cryptoDeviceId(targetDeviceId),
        clientKind: "electron",
        installationLineageDigest:
          targetCredential.installationLineageDigest,
        deviceGeneration: 1,
        signingPublicKey: targetSigning.publicKey,
        encryptionPublicKey: targetEncryption.publicKey,
        method: "device_approval",
        idempotencyKey: "m304_add_desktop",
      });
      const join = await targetGroup.createJoinRequest(founded.head);
      expect(await repository.bindPendingAndPublishJoin({
        userId,
        humanId: actorId,
        operationId: enrollment.operationId,
        targetDeviceId,
        requestBytes: encodeHumanDeviceGroupJoinRequest(join.publicResult),
        now: enrollment.issuedAt + 1,
      })).toBe("published");
      const [pendingJoin] = await repository.listPending({
        userId,
        humanId: actorId,
        approverDeviceId: firstDeviceId,
      });
      expect(pendingJoin).toMatchObject({
        operationId: enrollment.operationId,
        targetDeviceId,
        targetClientKind: "electron",
        targetDeviceGeneration: 1,
        createdAt: enrollment.issuedAt + 1,
      });
      const add = await firstGroup.prepareAdd({
        active: founded.active,
        currentHead: founded.head,
        joinRequest: join.publicResult,
      });
      expect(await repository.publishAdd({
        userId,
        humanId: actorId,
        operationId: enrollment.operationId,
        committerDeviceId: firstDeviceId,
        transitionBytes: encodeHumanDeviceGroupTransition(add.publicResult),
        welcomeBytes: add.publicResult.welcomeBytes,
        now: enrollment.issuedAt + 2,
      })).toBe("published");

      const firstPending = await repository.status({
        userId,
        humanId: actorId,
        deviceId: firstDeviceId,
      });
      expect(firstPending).toMatchObject({
        membershipState: "catching_up",
        nextSequence: null,
      });
      expect(firstPending.commits).toHaveLength(1);
      const firstApplied = firstGroup.applyCandidate({
        active: founded.active,
        candidate: add.localCandidate,
      });
      if (firstApplied.status === "aborted") throw new Error("first Add aborted");
      const firstLeaf = decodeHumanDeviceRoster(add.publicResult.rosterBytes)
        .find((entry) => entry.deviceId === firstDeviceId)!;
      await repository.acknowledge({
        userId,
        humanId: actorId,
        deviceId: firstDeviceId,
        sequence: 1,
        headDigest: humanDeviceGroupHeadDigest(firstCrypto, add.publicResult.nextHead),
        leafIndex: firstLeaf.leafIndex,
        now: enrollment.issuedAt + 3,
      });

      const targetPending = await repository.status({
        userId,
        humanId: actorId,
        deviceId: targetDeviceId,
      });
      expect(targetPending.welcome).not.toBeNull();
      const targetCandidate = await targetGroup.prepareWelcome({
        joinState: join.localState,
        joinRequest: join.publicResult,
        transition: decodeHumanDeviceGroupTransition(
          targetCrypto,
          targetPending.welcome!.transitionBytes,
        ),
        welcomeBytes: targetPending.welcome!.welcomeBytes,
      });
      const targetApplied = targetGroup.activateWelcome({
        candidate: targetCandidate,
        joinState: join.localState,
      });
      if (targetApplied.status === "aborted") throw new Error("Welcome aborted");
      const targetLeaf = targetGroup.publicRoster(targetApplied.active)
        .find((entry) => entry.deviceId === targetDeviceId)!;
      await repository.acknowledge({
        userId,
        humanId: actorId,
        deviceId: targetDeviceId,
        sequence: 1,
        headDigest: humanDeviceGroupHeadDigest(
          targetCrypto,
          add.publicResult.nextHead,
        ),
        leafIndex: targetLeaf.leafIndex,
        now: enrollment.issuedAt + 4,
      });
      const [consumedChallenge] = await admin.unsafe<{
        terminal_result_code: string | null;
        receipt_audit_ref: string | null;
        consumed: boolean;
        revision: string;
      }[]>(`
        SELECT terminal_result_code, receipt_audit_ref,
               consumed_at IS NOT NULL AS consumed, revision::text
          FROM human_crypto_device_challenges
         WHERE pending_device_id = $1 AND kind = 'device_approval'
      `, [targetDeviceId]);
      expect(consumedChallenge).toEqual({
        terminal_result_code: "active",
        receipt_audit_ref: `human-device-group:${enrollment.operationId}`,
        consumed: true,
        revision: "1",
      });
      expect((await Promise.all([firstDeviceId, targetDeviceId].map(
        (deviceId) => repository.status({ userId, humanId: actorId, deviceId }),
      ))).map((status) => status.membershipState)).toEqual([
        "current",
        "current",
      ]);

      const remove = await firstGroup.prepareRemove({
        active: firstApplied.active,
        currentHead: add.publicResult.nextHead,
        removedCredential: targetCredential,
      });
      const removeOperationId = "m304_remove_desktop";
      expect(await repository.publishRemove({
        userId,
        humanId: actorId,
        operationId: removeOperationId,
        committerDeviceId: firstDeviceId,
        transitionBytes: encodeHumanDeviceGroupTransition(
          remove.publicResult,
        ),
        now: enrollment.issuedAt + 5,
      })).toBe("published");
      expect(await repository.publishRemove({
        userId,
        humanId: actorId,
        operationId: removeOperationId,
        committerDeviceId: firstDeviceId,
        transitionBytes: encodeHumanDeviceGroupTransition(
          remove.publicResult,
        ),
        now: enrollment.issuedAt + 6,
      })).toBe("duplicate");
      const firstAfterRemove = firstGroup.applyCandidate({
        active: firstApplied.active,
        candidate: remove.localCandidate,
      });
      if (firstAfterRemove.status === "aborted") {
        throw new Error("first Remove aborted");
      }
      const remainingLeaf = firstGroup.publicRoster(firstAfterRemove.active)
        .find((entry) => entry.deviceId === firstDeviceId)!;
      await repository.acknowledge({
        userId,
        humanId: actorId,
        deviceId: firstDeviceId,
        sequence: 2,
        headDigest: humanDeviceGroupHeadDigest(
          firstCrypto,
          remove.publicResult.nextHead,
        ),
        leafIndex: remainingLeaf.leafIndex,
        now: enrollment.issuedAt + 7,
      });
      expect((await repository.status({
        userId,
        humanId: actorId,
        deviceId: targetDeviceId,
      })).membershipState).toBe("removed");
      const roster = await repository.roster({
        userId,
        humanId: actorId,
        currentDeviceId: firstDeviceId,
      });
      expect(roster.currentMemberCount).toBe(1);
      const retainedDevice = roster.devices.find((entry) =>
        entry.deviceId === firstDeviceId
      );
      expect(retainedDevice).toMatchObject({
        admissionEvidence: null,
        domainKeyCoverage: { acknowledged: 0, required: 0 },
        deliveryEvidence: {
          acknowledgedSequence: 0,
          highWatermark: 0,
          blocked: null,
        },
      });
      expect(retainedDevice?.publicFingerprintBase64url).toHaveLength(43);
      expect(retainedDevice?.membershipEvidence).toMatchObject({
        lineageGeneration: 1,
        epoch: 2,
        securityRevision: 3,
        acknowledgedSequence: 2,
      });
      expect(retainedDevice?.membershipEvidence?.headDigestBase64url)
        .toHaveLength(43);
      expect(roster.devices.map((entry) => ({
        deviceId: entry.deviceId,
        state: entry.membershipState,
        canRemove: entry.canRemove,
      }))).toEqual([
        { deviceId: firstDeviceId, state: "current", canRemove: false },
        { deviceId: targetDeviceId, state: "removed", canRemove: false },
      ]);
      const [retained] = await admin.unsafe<{ count: string }[]>(`
        SELECT count(*)::text AS count
          FROM human_crypto_device_group_commits
         WHERE human_id = $1
      `, [actorId]);
      expect(retained?.count).toBe("0");

      const recoveryDeviceId = "device_m304_recovered";
      const recoveryCrypto = new LatticeCrypto(seededRng(3_043));
      const recoverySigning = recoveryCrypto.generateSigningKeyPair();
      const recoveryEncryption = await recoveryCrypto.generateEncryptionKeyPair();
      const recoveryLineage = new Uint8Array(32).fill(0x53);
      const currentCustody = (await admin.unsafe<{
        custody_revision: string;
        recovery_generation: string;
        inventory_revision: string | null;
        inventory_count: number | null;
        inventory_digest: Uint8Array | null;
        active_device_count: string;
        pending_device_count: string;
      }[]>(`
        SELECT custody.revision::text AS custody_revision,
               custody.current_recovery_generation::text AS recovery_generation,
               custody.current_inventory_revision::text AS inventory_revision,
               custody.current_inventory_count AS inventory_count,
               custody.current_inventory_digest AS inventory_digest,
               (SELECT count(*)::text FROM human_crypto_devices d
                 WHERE d.human_id = custody.human_id AND d.state = 'active')
                 AS active_device_count,
               (SELECT count(*)::text FROM human_crypto_devices d
                 WHERE d.human_id = custody.human_id AND d.state = 'pending')
                 AS pending_device_count
          FROM human_crypto_custodies custody
         WHERE custody.human_id = $1
      `, [actorId]))[0]!;
      const currentInventoryRevision = currentCustody.inventory_revision === null
        ? deviceTransferInventoryRevisionV2(0)
        : deviceTransferInventoryRevisionV2(
          Number(currentCustody.inventory_revision),
        );
      const currentInventoryCount = currentCustody.inventory_count ?? 0;
      const currentInventoryDigest = currentCustody.inventory_digest
        ?? deviceTransferInventoryDigestV2({
          humanId: humanId(actorId),
          inventoryRevision: currentInventoryRevision,
          inventory: Object.freeze([]),
        });
      const recoveryEnrollment = await new AdditionalDeviceEnrollmentService({
        crypto: recoveryCrypto,
        repository: new PostgresAdditionalDeviceEnrollmentRepository(
          handle,
          false,
        ),
        enforceLegacyFleetBounds: false,
        authorize: createSyntheticAdditionalDeviceAuthorizer({
          expectedUserId: valueOf(nautiloUserId(userId)),
          expectedHumanActorId: valueOf(nautiloActorId(actorId)),
          expectedInstallationLineageDigest: recoveryLineage,
          authorizationEvidenceDigest: new Uint8Array(32).fill(0x71),
          expectedCustodyRevision: Number(currentCustody.custody_revision),
          expectedRecoveryGeneration:
            Number(currentCustody.recovery_generation),
          inventoryRevision: currentInventoryRevision,
          inventoryCount: currentInventoryCount,
          inventoryDigest: currentInventoryDigest,
          activeDeviceCount: Number(currentCustody.active_device_count),
          pendingDeviceCount: Number(currentCustody.pending_device_count),
        }),
      }).begin({
        userId: valueOf(nautiloUserId(userId)),
        humanActorId: valueOf(nautiloActorId(actorId)),
        deviceId: cryptoDeviceId(recoveryDeviceId),
        clientKind: "browser",
        installationLineageDigest: recoveryLineage,
        deviceGeneration: 1,
        signingPublicKey: recoverySigning.publicKey,
        encryptionPublicKey: recoveryEncryption.publicKey,
        method: "recovery",
        idempotencyKey: "m304_recovery_rebootstrap",
      });
      const challenge = await new PostgresRecoveryChallengeRepository({
        handle,
        crypto: recoveryCrypto,
        purpose: "mls_rebootstrap_possession",
      }).publish({
        operationId: recoveryEnrollment.operationId,
        publishedAt: recoveryEnrollment.issuedAt + 1,
      });
      const recoveryCredential = await deriveRecoveryCredentialFromMnemonic(
        bootstrap.recoveryMnemonic,
        recoveryCrypto,
      );
      const proof = await answerRecoveryDevicePossessionChallenge({
        crypto: recoveryCrypto,
        challengeBytes: challenge.challengeBytes,
        pendingDevice: {
          humanId: humanId(actorId),
          deviceId: cryptoDeviceId(recoveryDeviceId),
          pendingDeviceRevision: pendingDeviceRevisionV2(0),
          encryptionPublicKey: recoveryEncryption.publicKey,
          signingPublicKey: recoverySigning.publicKey,
        },
        resolveTrustedPendingDevice: () => ({
          humanId: humanId(actorId),
          deviceId: cryptoDeviceId(recoveryDeviceId),
          pendingDeviceRevision: pendingDeviceRevisionV2(0),
          encryptionPublicKeyDigest: recoveryCrypto.hash(
            recoveryEncryption.publicKey,
          ),
          signingPublicKeyDigest: recoveryCrypto.hash(
            recoverySigning.publicKey,
          ),
          status: "pending",
        }),
        recoveryPublicKey: recoveryCredential.publicKey,
        recoveryPrivateKey: recoveryCredential.privateKey,
        resolveTrustedCurrentRecoveryKey: () => ({
          humanId: humanId(actorId),
          recoveryKeyId: recoveryCredential.keyId,
          recoveryGeneration: recoveryKeyGenerationV2(
            Number(currentCustody.recovery_generation),
          ),
          publicKeyDigest: recoveryCrypto.hash(recoveryCredential.publicKey),
        }),
        currentTime: unixTimestamp(recoveryEnrollment.issuedAt + 2),
      });
      const recoveryVault = DeviceProviderStateVault.fromKey(
        recoveryCrypto,
        cryptoDeviceId(recoveryDeviceId),
        new Uint8Array(32).fill(0x43),
      );
      try {
        const recoveryCoordinates = Object.freeze({
          serverInstanceId,
          humanId: humanId(actorId),
          lineageGeneration: 2,
        });
        const recoveryGroup = new HumanDeviceOpenMlsGroup(
          recoveryCrypto,
          recoveryVault,
          {
            coordinates: recoveryCoordinates,
            ownCredential: {
              formatVersion: 1,
              ...recoveryCoordinates,
              deviceId: cryptoDeviceId(recoveryDeviceId),
              installationLineageDigest: recoveryLineage,
              deviceKeyGeneration: 1,
            },
          },
        );
        await recoveryGroup.initialize();
        const recovered = await recoveryGroup.createInitialState();
        expect(await repository.rebootstrapWithRecovery({
          userId,
          humanId: actorId,
          operationId: recoveryEnrollment.operationId,
          deviceId: recoveryDeviceId,
          challengeHash: proof.challengeHash,
          response: proof.response,
          headBytes: encodeHumanDeviceGroupHead(recovered.head),
          rosterBytes: recovered.rosterBytes,
          now: recoveryEnrollment.issuedAt + 3,
        })).toBe("created");
        expect(await repository.rebootstrapWithRecovery({
          userId,
          humanId: actorId,
          operationId: recoveryEnrollment.operationId,
          deviceId: recoveryDeviceId,
          challengeHash: proof.challengeHash,
          response: proof.response,
          headBytes: encodeHumanDeviceGroupHead(recovered.head),
          rosterBytes: recovered.rosterBytes,
          now: recoveryEnrollment.issuedAt + 4,
        })).toBe("duplicate");
        expect((await repository.status({
          userId,
          humanId: actorId,
          deviceId: recoveryDeviceId,
        })).membershipState).toBe("current");
        expect((await repository.roster({
          userId,
          humanId: actorId,
          currentDeviceId: recoveryDeviceId,
        })).devices.map((entry) => [entry.deviceId, entry.membershipState]))
          .toEqual([
            [firstDeviceId, "removed"],
            [targetDeviceId, "removed"],
            [recoveryDeviceId, "current"],
          ]);
      } finally {
        recoveryVault.destroy();
        recoveryCredential.privateKey.fill(0);
      }
    } finally {
      firstVault.destroy();
      targetVault.destroy();
      await client.end();
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
      if (createdIdentity) {
        await admin.unsafe(
          `DELETE FROM nautilo_instance_identity WHERE id = 'self'`,
        );
      }
    }
  }, 120_000);

  test("rotates recovery custody atomically and replays idempotently", async () => {
    const userId = "00000000-0000-4000-8000-0000000000aa";
    const actorId = "00000000-0000-4000-8000-0000000000ab";
    const deviceId = "device_pg_recovery_rotation";
    await admin.unsafe(
      `INSERT INTO users (id, name)
       VALUES ($1, 'Recovery rotation fixture')`,
      [userId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES (
         $1, $2, 'Recovery rotation fixture', 'verified', 'user'
       )`,
      [actorId, userId],
    );

    const client = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(client));
      const fixture = await createRecoveryRotationFixture({
        humanId: actorId,
        issuerDeviceId: deviceId,
        expectedCustodyRevision: 1,
        expectedIssuerDeviceRevision: 1,
      });
      await bootstrapSyntheticHuman({
        crypto: fixture.crypto,
        handle,
        userId,
        actorId,
        deviceId,
        clientKind: "browser",
        context: {
          kind: "preparation",
          authorityId: "preparation_pg_recovery_rotation",
        },
        lineageMarker: 0x51,
        signing: fixture.issuer,
      });

      const repository = new PostgresRecoveryRotationRepository(handle);
      const result = await repository.rotate({
        crypto: fixture.crypto,
        submission: fixture.submission,
        expectedHumanId: actorId,
        rotatedAt: 50_000,
      });
      expect(result).toMatchObject({
        status: "rotated",
        humanId: actorId,
        recoveryGeneration: 2,
        custodyRevision: 2,
      });
      expect(await repository.rotate({
        crypto: fixture.crypto,
        submission: fixture.submission,
        expectedHumanId: actorId,
        rotatedAt: 50_000,
      })).toEqual({
        ...result,
        status: "duplicate",
      });

      const durable = await admin.unsafe<{
        custody_revision: string;
        current_recovery_generation: string;
        current_recovery_public_key_digest: Uint8Array;
        generation: string;
        recovery_key_id: string;
        public_key: Uint8Array;
        public_key_digest: Uint8Array;
        archive_hash: Uint8Array;
        state: string;
        retired_at: Date | null;
        archive_generation: string;
        archive_bytes: Uint8Array;
        operation_state: string;
        outbox_count: string;
      }[]>(`
        SELECT custody.revision::text AS custody_revision,
               custody.current_recovery_generation::text
                 AS current_recovery_generation,
               custody.current_recovery_public_key_digest,
               recovery.generation::text AS generation,
               recovery.recovery_key_id,
               recovery.public_key,
               recovery.public_key_digest,
               recovery.archive_hash,
               recovery.state,
               recovery.retired_at,
               archive.recovery_key_generation::text AS archive_generation,
               archive.archive_bytes,
               operation.state AS operation_state,
               (
                 SELECT count(*)::text
                   FROM crypto_operation_outbox candidate
                  WHERE candidate.operation_id = operation.operation_id
               ) AS outbox_count
          FROM human_crypto_custodies custody
          JOIN human_crypto_recovery_keys recovery
            ON recovery.human_id = custody.human_id
          JOIN human_crypto_recovery_archives archive
            ON archive.human_id = custody.human_id
          JOIN crypto_delivery_operations operation
            ON operation.human_id = custody.human_id
           AND operation.kind = 'recovery_rotate'
         WHERE custody.human_id = $1
         ORDER BY recovery.generation
      `, [actorId]);
      expect(durable).toHaveLength(2);
      expect(durable[0]).toMatchObject({
        custody_revision: "2",
        current_recovery_generation: "2",
        generation: "1",
        state: "retired",
        operation_state: "active",
        outbox_count: "1",
      });
      expect(durable[0]?.retired_at).not.toBeNull();
      expect(durable[1]).toMatchObject({
        custody_revision: "2",
        current_recovery_generation: "2",
        generation: "2",
        recovery_key_id: fixture.recovery.keyId,
        state: "current",
        retired_at: null,
        archive_generation: "2",
        operation_state: "active",
        outbox_count: "1",
      });
      expect(durable[1]?.public_key).toEqual(fixture.recovery.publicKey);
      expect(durable[1]?.public_key_digest).toEqual(
        fixture.crypto.hash(fixture.recovery.publicKey),
      );
      expect(durable[1]?.current_recovery_public_key_digest).toEqual(
        durable[1]?.public_key_digest,
      );
      expect(durable[1]?.archive_hash).toEqual(
        fixture.crypto.hash(fixture.archive.archiveBytes),
      );
      expect(durable[1]?.archive_bytes).toEqual(
        fixture.archive.archiveBytes,
      );
    } finally {
      await client.end();
      await truncateCryptoStorage();
      await admin.unsafe(`DELETE FROM users WHERE id = $1`, [userId]);
    }
  });

  test("cold invited Human reaches active membership with retained history after reconnect", async () => {
    const aliceUserId = "71000000-0000-4000-8000-000000000011";
    const charlieUserId = "71000000-0000-4000-8000-000000000012";
    await admin.unsafe(
      `INSERT INTO users (id, name) VALUES
         ($1, 'Cold crypto Alice'),
         ($2, 'Cold crypto Charlie')`,
      [aliceUserId, charlieUserId],
    );
    await admin.unsafe(
      `INSERT INTO actors (
         id, owner_id, display_name, trust_state, kind
       ) VALUES
         ($1, $2, 'Cold crypto Alice', 'verified', 'user'),
         ($3, $4, 'Cold crypto Charlie', 'verified', 'user')`,
      [
        COLD_ALICE_ACTOR,
        aliceUserId,
        COLD_CHARLIE_ACTOR,
        charlieUserId,
      ],
    );

    const crypto = deterministicBootstrapCrypto();
    let client = sqlClient(cryptoUrl, 1);
    let retainedHighWatermark = 0;
    let finalCharlieRevision = 1;
    let charlieSigning!: ReturnType<
      LatticeCrypto["generateSigningKeyPair"]
    >;
    let cold!: Awaited<ReturnType<typeof createColdHumanAddFixture>>;
    let rebind!: ReturnType<typeof cold.createRebind>;
    try {
      let handle = await verifyCryptoPostgresHandle(connection(client));
      const alice = await bootstrapSyntheticHuman({
        crypto,
        handle,
        userId: aliceUserId,
        actorId: COLD_ALICE_ACTOR,
        deviceId: COLD_ALICE_DEVICE,
        clientKind: "browser",
        context: {
          kind: "preparation",
          authorityId: "preparation_cold_alice",
        },
        lineageMarker: 0x31,
      });
      charlieSigning = crypto.generateSigningKeyPair();
      cold = await createColdHumanAddFixture({
        crypto,
        aliceSigning: alice.signing,
        charlieSigning,
      });
      let storage = createPostgresLatticeStorage(handle);
      expect(await storage.createDomainIfAbsent({
        id: cryptoDomainId(COLD_SOURCE_DOMAIN),
        participantDigest: cold.membership.oldParticipantDigest,
        participants: [humanId(COLD_ALICE_ACTOR)],
        epoch: cold.source.head.epoch,
        authorizationRevision: authorizationRevision(0),
        rosterBytes: cold.source.rosterBytes,
      })).toMatchObject({ status: "created" });
      expect(await storage.putDomainProviderHeadIfAbsent(
        cold.source.head,
        cold.source.rosterBytes,
      )).toBe("inserted");
      expect(await persistNamespaceBinding({
        crypto,
        storage,
        prepared: cold.source.prepared,
        resolveCurrentCommitter: () => alice.signing.publicKey,
      })).toBe("applied");
      await admin.unsafe(
        `INSERT INTO crypto_domain_devices (
           domain_id, device_id, human_id, leaf_index, joined_epoch,
           removed_epoch, removed_at
         ) VALUES ($1, $2, $3, 0, 0, NULL, NULL)`,
        [COLD_SOURCE_DOMAIN, COLD_ALICE_DEVICE, COLD_ALICE_ACTOR],
      );

      const admission =
        new PostgresHumanMembershipAdmissionRepository(handle);
      expect(await admission.admit(cold.membership, 10_000)).toEqual({
        status: "admitted",
        state: "awaiting_target_device",
      });
      expect(await admission.admit(cold.membership, 10_001)).toEqual({
        status: "duplicate",
        state: "awaiting_target_device",
      });

      const charlie = await bootstrapSyntheticHuman({
        crypto,
        handle,
        userId: charlieUserId,
        actorId: COLD_CHARLIE_ACTOR,
        deviceId: COLD_CHARLIE_DEVICE,
        clientKind: "browser",
        context: {
          kind: "pending_encrypted_invite",
          authorityId: COLD_OPERATION,
        },
        lineageMarker: 0x41,
        signing: charlieSigning,
      });
      const preparing = await admin.unsafe<{
        state: string;
        bootstrap_device_id: string | null;
        target_human_id: string | null;
      }[]>(`
        SELECT o.state, h.bootstrap_device_id, o.target_human_id
          FROM crypto_delivery_operations o
          JOIN crypto_human_membership_transitions h
            ON h.operation_id = o.operation_id
         WHERE o.operation_id = $1
      `, [COLD_OPERATION]);
      expect([...preparing]).toEqual([{
        state: "preparing_domain",
        bootstrap_device_id: COLD_CHARLIE_DEVICE,
        target_human_id: COLD_CHARLIE_ACTOR,
      }]);

      const targetRepository =
        new PostgresHumanMembershipTargetDomainRepository({
          handle,
          crypto,
        });
      expect(await targetRepository.create({
        submission: cold.target.submission,
        preparedAt: 20_000,
      })).toMatchObject({
        status: "created",
        targetDomainId: COLD_TARGET_DOMAIN,
        targetEpoch: 1,
        recipientCount: 2,
      });

      const aliceTarget = await cold.target.activateAlice();
      rebind = cold.createRebind(aliceTarget.roots);
      const rebindRepository =
        new PostgresHumanMembershipRebindRepository({
          handle,
          crypto,
        });
      expect(await rebindRepository.stage({
        submission: rebind.submission,
        submittedAt: 21_000,
      })).toMatchObject({
        status: "staged",
        requiredAcknowledgementDeviceId: COLD_CHARLIE_DEVICE,
      });
      expect(await storage.getNamespaceHead(COLD_NAMESPACE)).toMatchObject({
        accessRevision: 0,
        domainId: COLD_SOURCE_DOMAIN,
      });

      const fetchRepository =
        new PostgresDeviceDeliveryFetchRepository(handle, crypto);
      const fetched = await fetchRepository.fetch({
        proof: createDeviceDeliveryFetchProof({
          crypto,
          requestId: "fetch_cold_charlie_before_activation",
          humanId: COLD_CHARLIE_ACTOR,
          deviceId: COLD_CHARLIE_DEVICE,
          expectedDeviceRevision: charlie.receipt.deviceRevision,
          minimumHighWatermark: 0,
          maximumMessages: 64,
          maximumPayloadBytes: 8_388_608,
          issuedAt: 22_000,
          expiresAt: 322_000,
          signingPrivateKey: charlieSigning.privateKey,
        }),
        now: 22_001,
      });
      expect(fetched.status).toBe("messages");
      if (fetched.status !== "messages") {
        throw new Error(`Cold delivery fetch failed: ${fetched.status}`);
      }
      expect(fetched.messages.length).toBeGreaterThanOrEqual(2);
      expect(fetched.messages.every(({ operationId }) =>
        operationId === COLD_OPERATION
      )).toBe(true);
      retainedHighWatermark = fetched.highWatermark;

      const chunks = fetched.messages.map((message) => ({
        message,
        chunk: decodeOpaqueDeliveryArtifactChunk(
          message.payloadBytes,
          crypto,
        ),
      }));
      const targetArtifact =
        decodeHumanMembershipTargetDomainDeliveryArtifact(
          reassembleOpaqueDeliveryArtifact({
            crypto,
            chunks: chunks
              .filter(({ chunk }) =>
                chunk.kind === "target_domain_bootstrap"
              )
              .map(({ chunk }) => chunk),
          }),
        );
      const charlieTarget = await cold.target.activateCharlie(
        targetArtifact.providerSubmission.transition,
      );
      expect(charlieTarget.roots.human).toEqual(aliceTarget.roots.human);
      expect(charlieTarget.roots.ai).toEqual(aliceTarget.roots.ai);

      const deliveredRebind = decodeHumanMembershipRebindSubmission(
        reassembleOpaqueDeliveryArtifact({
          crypto,
          chunks: chunks
            .filter(({ chunk }) => chunk.kind === "membership_rebind")
            .map(({ chunk }) => chunk),
        }),
      );
      const retained = openNamespaceKeyring({
        crypto,
        domainRoot: charlieTarget.roots.human,
        envelope: parseNamespaceKeyringEnvelopeV2(
          deliveredRebind.candidate.binding.humanKeyringEnvelopeBytes,
        ),
        resolveHistoricalCommitter: () => alice.signing.publicKey,
      });
      expect(retained.generations).toHaveLength(2);
      expect(retained.generations[0]).toEqual(
        cold.source.keyrings.human.generations[0],
      );

      const acknowledgementRepository =
        new PostgresDeliveryAcknowledgementRepository(handle);
      for (const [index, message] of fetched.messages.entries()) {
        const processedRevision = charlie.receipt.deviceRevision + index + 1;
        const proof = createDeliveryAcknowledgementProof({
          crypto,
          message: {
            messageId: message.messageId,
            recipientDeviceId: COLD_CHARLIE_DEVICE,
            recipientSequence: message.recipientSequence,
            payloadHash: message.payloadHash,
          },
          processedRevision,
          acknowledgedAt: 23_000 + index,
          signingPrivateKey: charlieSigning.privateKey,
        });
        const acknowledgement = verifyDeliveryAcknowledgementProof({
          crypto,
          proof,
          message: {
            messageId: message.messageId,
            recipientDeviceId: COLD_CHARLIE_DEVICE,
            recipientSequence: message.recipientSequence,
            payloadHash: message.payloadHash,
          },
          resolveDevice: () => ({
            state: "active",
            revision: processedRevision - 1,
            signingPublicKey: charlieSigning.publicKey,
          }),
        });
        expect(await acknowledgementRepository.acknowledge(
          acknowledgement,
          30_000,
        )).toEqual({ status: "acknowledged" });
        finalCharlieRevision = processedRevision;
      }

      await client.end();
      client = sqlClient(cryptoUrl, 1);
      let injectedActivationFailure = false;
      handle = await verifyCryptoPostgresHandle(connection(
        client,
        (statement) => {
          if (
            !injectedActivationFailure
            && statement.includes("UPDATE namespace_crypto_heads")
          ) {
            injectedActivationFailure = true;
            throw new Error("injected membership activation crash");
          }
        },
      ));
      const interruptedActivation =
        new PostgresHumanMembershipActivationRepository({
          handle,
          crypto,
        });
      expect(
        (await rejectedError(interruptedActivation.activate({
          operationId: COLD_OPERATION,
          activatedAt: 30_000,
          auditRef: "audit_cold_membership_activation",
          outboxId: "outbox_cold_membership_activation",
        }))).message,
      ).toContain("injected membership activation crash");
      const interrupted = await admin.unsafe<{
        access_revision: string;
        operation_state: string;
        revision_one_bindings: string;
        committed_outbox: string;
      }[]>(`
        SELECT head.access_revision::text,
               operation.state AS operation_state,
               (
                 SELECT count(*) FROM namespace_crypto_bindings binding
                  WHERE binding.namespace_id = head.namespace_id
                    AND binding.revision = 1
               )::text AS revision_one_bindings,
               (
                 SELECT count(*) FROM crypto_operation_outbox outbox
                  WHERE outbox.operation_id = $2
                    AND outbox.event_type =
                      'crypto_human_membership_committed'
               )::text AS committed_outbox
          FROM namespace_crypto_heads head
          JOIN crypto_delivery_operations operation
            ON operation.operation_id = $2
         WHERE head.namespace_id = $1
      `, [COLD_NAMESPACE, COLD_OPERATION]);
      expect([...interrupted]).toEqual([{
        access_revision: "0",
        operation_state: "ready_to_activate",
        revision_one_bindings: "0",
        committed_outbox: "0",
      }]);

      await client.end();
      client = sqlClient(cryptoUrl, 1);
      handle = await verifyCryptoPostgresHandle(connection(client));
      storage = createPostgresLatticeStorage(handle);
      const activation =
        new PostgresHumanMembershipActivationRepository({
          handle,
          crypto,
        });
      expect(await activation.activate({
        operationId: COLD_OPERATION,
        activatedAt: 30_000,
        auditRef: "audit_cold_membership_activation",
        outboxId: "outbox_cold_membership_activation",
      })).toEqual({
        status: "activated",
        kind: "human_add",
        namespaceId: COLD_NAMESPACE,
        accessRevision: 1,
      });
      expect(await storage.getNamespaceHead(COLD_NAMESPACE)).toMatchObject({
        accessRevision: 1,
        domainId: COLD_TARGET_DOMAIN,
        domainEpoch: 1,
      });
      const durable = await admin.unsafe<{
        state: string;
        candidate_submitted: boolean;
        activated: boolean;
        released: boolean;
        message_count: string;
        aggregate_payload_bytes: string;
        durable_payload_bytes: string;
      }[]>(`
        SELECT o.state,
               h.candidate_submitted_at IS NOT NULL AS candidate_submitted,
               h.activated_at IS NOT NULL AS activated,
               h.released_at IS NOT NULL AS released,
               o.fanout_row_count::text AS message_count,
               o.aggregate_payload_bytes::text,
               (
                 SELECT coalesce(sum(octet_length(m.payload_bytes)), 0)
                   FROM crypto_delivery_messages m
                  WHERE m.operation_id = o.operation_id
               )::text AS durable_payload_bytes
          FROM crypto_delivery_operations o
          JOIN crypto_human_membership_transitions h
            ON h.operation_id = o.operation_id
         WHERE o.operation_id = $1
      `, [COLD_OPERATION]);
      expect(durable).toHaveLength(1);
      expect(durable[0]).toMatchObject({
        state: "active",
        candidate_submitted: true,
        activated: true,
        released: true,
      });
      expect(durable[0]?.message_count).toBe(
        String(fetched.messages.length * 2),
      );
      expect(durable[0]?.aggregate_payload_bytes).toBe(
        durable[0]?.durable_payload_bytes,
      );
    } finally {
      await client.end();
    }

    const restarted = sqlClient(cryptoUrl, 1);
    try {
      const handle = await verifyCryptoPostgresHandle(connection(restarted));
      expect(await new PostgresHumanMembershipAdmissionRepository(handle)
        .admit(cold.membership, 40_000)).toEqual({
        status: "duplicate",
        state: "active",
      });
      expect(await new PostgresHumanMembershipTargetDomainRepository({
        handle,
        crypto,
      }).create({
        submission: cold.target.submission,
        preparedAt: 400_000,
      })).toMatchObject({
        status: "duplicate",
        targetDomainId: COLD_TARGET_DOMAIN,
      });
      expect(await new PostgresHumanMembershipRebindRepository({
        handle,
        crypto,
      }).stage({
        submission: rebind.submission,
        submittedAt: 400_000,
      })).toMatchObject({ status: "duplicate" });
      expect(await new PostgresHumanMembershipActivationRepository({
        handle,
        crypto,
      }).activate({
        operationId: COLD_OPERATION,
        activatedAt: 30_000,
        auditRef: "audit_cold_membership_activation",
        outboxId: "outbox_cold_membership_activation",
      })).toMatchObject({ status: "duplicate" });
      expect(await new PostgresDeviceDeliveryFetchRepository(
        handle,
        crypto,
      ).fetch({
        proof: createDeviceDeliveryFetchProof({
          crypto,
          requestId: "fetch_cold_charlie_after_restart",
          humanId: COLD_CHARLIE_ACTOR,
          deviceId: COLD_CHARLIE_DEVICE,
          expectedDeviceRevision: finalCharlieRevision,
          minimumHighWatermark: retainedHighWatermark,
          maximumMessages: 64,
          maximumPayloadBytes: 8_388_608,
          issuedAt: 40_000,
          expiresAt: 340_000,
          signingPrivateKey: charlieSigning.privateKey,
        }),
        now: 40_001,
      })).toEqual({
        status: "empty",
        acknowledgedThrough: retainedHighWatermark,
        highWatermark: retainedHighWatermark,
      });
    } finally {
      await restarted.end();
      await truncateCryptoStorage();
      await admin.unsafe(
        `DELETE FROM users WHERE id IN ($1, $2)`,
        [aliceUserId, charlieUserId],
      );
    }
  }, 120_000);
});

function valueOf<T>(result: TranslationResult<T>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

function deterministicBootstrapCrypto(): LatticeCrypto {
  let counter = 1;
  return new LatticeCrypto(
    {
      bytes(length) {
        return new Uint8Array(length).fill(counter++);
      },
    },
    { now: () => 10_000 },
  );
}
