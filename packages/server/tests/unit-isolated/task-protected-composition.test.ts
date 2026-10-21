import { describe, expect, spyOn, test } from "bun:test";
import type {
  DirectDatabase,
  PostgresJsBridgeConnection,
  PostgresJsBridgeExecutor,
  PostgresJsBridgeIsolationLevel,
  PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
  deriveTaskContentCryptoObjectIdV1,
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  namespaceGeneration,
  namespaceId,
  type HumanTaskPublicationRequest,
} from "@nautilo/lattice-crypto";
import {
  PostgresDomainKeyAuthorityRepository,
  PostgresNamespaceProductAuthority,
  type NamespaceProductAuthoritySnapshot,
} from "@nautilo/lattice-bridge/server";

import {
  ProtectedTaskRouteError,
  createProtectedTaskPrivateReadAuthorityResolver,
  createProtectedTaskForegroundSignerTransport,
  createProductionProtectedTaskComposition,
  projectVerifiedProtectedTaskRunResultAgentSignerEvidence,
  withCurrentProtectedTaskPublicationDeviceAuthority,
} from
  "../../src/routes/task-protected-composition";

const ROUTE_AUTHORITY = Object.freeze({
  userId: "10000000-0000-4000-8000-000000000001",
  subjectHumanId: "human-1",
  actorId: "10000000-0000-4000-8000-000000000002",
  agentId: "10000000-0000-4000-8000-000000000003",
  deviceId: "device-1",
  deviceGeneration: 4,
});

type CurrentPrivateRoomInput<Value> = Readonly<{
  subjectUserId: string;
  subjectHumanId: string;
  roomId: string;
  namespaceId: string;
  use: (snapshot: NamespaceProductAuthoritySnapshot) => Promise<Value>;
}>;

function publicationRequest(
  overrides: Partial<HumanTaskPublicationRequest> = {},
): HumanTaskPublicationRequest {
  return {
    formatVersion: 1,
    purpose: "task.publish",
    operation: "create",
    operationId: "operation-1",
    taskId: "10000000-0000-4000-8000-000000000004",
    cryptoObjectId: "task-definition:v1:fixture",
    expectedContentRevision: 0,
    nextContentRevision: 1,
    expectedCryptoAccessRevision: 0,
    resultCryptoAccessRevision: 0,
    planDigest: new Uint8Array(32),
    operationalFieldsDigest: new Uint8Array(32),
    subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
    committerDeviceId: ROUTE_AUTHORITY.deviceId,
    hostAuthorizationRevision: 7,
    namespaceId: "10000000-0000-4000-8000-000000000005",
    domainId: "domain-1",
    expectedNamespaceAccessRevision: 2,
    expectedPolicyRevision: 3,
    bindingHash: new Uint8Array(32),
    keyGeneration: 1,
    payloadHash: new Uint8Array(32),
    manifestHash: new Uint8Array(32),
    envelopeHash: new Uint8Array(32),
    issuedAt: 1,
    deadlineAt: 2,
    signature: new Uint8Array(64),
    ...overrides,
  };
}

function productDatabaseWithoutQueries(): DirectDatabase {
  const client = Object.assign(function postgresClient() {}, {
    unsafe: () => Promise.reject(new Error("Product DB must remain idle")),
    begin: () => Promise.reject(new Error("Product DB must remain idle")),
  });
  return { $client: client } as unknown as DirectDatabase;
}

function productDatabaseWithReadRows(
  rowSets: readonly (readonly Record<string, unknown>[])[],
  selections: string[][],
): DirectDatabase {
  let index = 0;
  const client = Object.assign(function postgresClient() {}, {
    unsafe: () => Promise.reject(new Error("Product DB client must remain idle")),
    begin: () => Promise.reject(new Error("Product DB client must remain idle")),
  });
  return {
    $client: client,
    select(selection?: Record<string, unknown>) {
      selections.push(selection === undefined ? [] : Object.keys(selection));
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return Promise.resolve(rowSets[index++] ?? []);
                },
              };
            },
          };
        },
      };
    },
  } as unknown as DirectDatabase;
}

function productDatabaseWithProtectedPolicy(): DirectDatabase {
  const client = Object.assign(function postgresClient() {}, {
    unsafe: () => Promise.reject(new Error("Product DB client must remain idle")),
    begin: () => Promise.reject(new Error("Product DB client must remain idle")),
  });
  return {
    $client: client,
    select() {
      return {
        from() {
          return {
            where() {
              return Promise.resolve([{
                revision: 3,
                mode: "shadow_encryption",
              }]);
            },
          };
        },
      };
    },
  } as unknown as DirectDatabase;
}

function observedRestrictedConnection(counter: { queries: number }):
PostgresJsBridgeConnection {
  const connection: PostgresJsBridgeConnection = {
    query: () => {
      counter.queries += 1;
      return Promise.reject(new Error("Crypto DB must remain idle"));
    },
    transaction: <Result>(
      callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      _options?: Readonly<{ isolationLevel: PostgresJsBridgeIsolationLevel }>,
    ) => callback(connection),
    transactionOnce: <Result>(
      callback: (transaction: PostgresJsBridgeExecutor) => Promise<Result>,
      _options?: Readonly<{ isolationLevel: PostgresJsBridgeIsolationLevel }>,
    ) => callback(connection),
  };
  return connection;
}

describe("production protected Task composition", () => {
  test("exports current and exact historical authority from the canonical private Room", async () => {
    const roomId = "10000000-0000-4000-8000-000000000006";
    const expectedNamespaceId = "10000000-0000-4000-8000-000000000005";
    const requested = { generation: 3, accessRevision: 2 };
    const inspected: Parameters<
      PostgresDomainKeyAuthorityRepository[
        "inspectNamespaceGenerationAuthorityMetadata"
      ]
    >[0][] = [];
    const productInputs: Readonly<{
      subjectUserId: string;
      subjectHumanId: string;
      roomId: string;
      namespaceId: string;
    }>[] = [];
    const digestBytes = Array.from(
      { length: 8 },
      (_, index) => new Uint8Array(32).fill(index + 1),
    );
    const productAuthority: Pick<
      PostgresNamespaceProductAuthority,
      "withCurrentPrivateRoom"
    > = {
      async withCurrentPrivateRoom<Value>(
        input: CurrentPrivateRoomInput<Value>,
      ) {
        productInputs.push({
          subjectUserId: input.subjectUserId,
          subjectHumanId: input.subjectHumanId,
          roomId: input.roomId,
          namespaceId: input.namespaceId,
        });
        return input.use(Object.freeze({}) as never);
      },
    };
    const domainKeys: Pick<
      PostgresDomainKeyAuthorityRepository,
      "inspectNamespaceGenerationAuthorityMetadata"
    > = {
      async inspectNamespaceGenerationAuthorityMetadata(input) {
        inspected.push(input);
        return Object.freeze({
          status: "ready" as const,
          namespaceId: namespaceId(input.namespaceId),
          currentGeneration: namespaceGeneration(8),
          retainedGenerations: Object.freeze([
            Object.freeze({
              generation: namespaceGeneration(3),
              accessRevision: accessRevision(2),
              headDigest: digestBytes[0]!,
              publicationDigest: digestBytes[1]!,
              publicationSetDigest: digestBytes[2]!,
              audienceFingerprint: digestBytes[3]!,
            }),
            Object.freeze({
              generation: namespaceGeneration(8),
              accessRevision: accessRevision(5),
              headDigest: digestBytes[4]!,
              publicationDigest: digestBytes[5]!,
              publicationSetDigest: digestBytes[6]!,
              audienceFingerprint: digestBytes[7]!,
            }),
          ]),
        });
      },
    };
    const resolve = createProtectedTaskPrivateReadAuthorityResolver({
      resolveRequesterPrivateRoom: async (userId, agent, namespace) => {
        expect([userId, agent, namespace]).toEqual([
          ROUTE_AUTHORITY.userId,
          ROUTE_AUTHORITY.agentId,
          expectedNamespaceId,
        ]);
        return { roomId, namespaceId: expectedNamespaceId };
      },
      productAuthority,
      domainKeys,
    });

    expect(await resolve(
      ROUTE_AUTHORITY,
      expectedNamespaceId,
      requested,
    )).toEqual({
      sourceRoomId: roomId,
      namespaceId: expectedNamespaceId,
      currentGeneration: 8,
      retainedGenerations: [
        {
          generation: 3,
          accessRevision: 2,
          headDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(1),
          ).toString("base64url"),
          publicationDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(2),
          ).toString("base64url"),
          publicationSetDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(3),
          ).toString("base64url"),
          audienceFingerprintBase64url: Buffer.from(
            new Uint8Array(32).fill(4),
          ).toString("base64url"),
        },
        {
          generation: 8,
          accessRevision: 5,
          headDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(5),
          ).toString("base64url"),
          publicationDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(6),
          ).toString("base64url"),
          publicationSetDigestBase64url: Buffer.from(
            new Uint8Array(32).fill(7),
          ).toString("base64url"),
          audienceFingerprintBase64url: Buffer.from(
            new Uint8Array(32).fill(8),
          ).toString("base64url"),
        },
      ],
    });
    expect(productInputs).toEqual([{
      subjectUserId: ROUTE_AUTHORITY.userId,
      subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
      roomId,
      namespaceId: expectedNamespaceId,
    }]);
    expect(inspected).toEqual([{
      namespaceId: expectedNamespaceId,
      keyClass: "ai",
      requested: [requested],
    }]);
    expect(digestBytes.every(bytes => bytes.every(byte => byte === 0)))
      .toBe(true);
  });

  test("fails closed when exact historical Namespace metadata is unavailable", async () => {
    const expectedNamespaceId = "10000000-0000-4000-8000-000000000005";
    const resolve = createProtectedTaskPrivateReadAuthorityResolver({
      resolveRequesterPrivateRoom: async () => ({
        roomId: "10000000-0000-4000-8000-000000000006",
        namespaceId: expectedNamespaceId,
      }),
      productAuthority: {
        async withCurrentPrivateRoom<Value>(
          input: CurrentPrivateRoomInput<Value>,
        ) {
          return input.use(Object.freeze({}) as never);
        },
      },
      domainKeys: {
        async inspectNamespaceGenerationAuthorityMetadata() {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "binding_unavailable",
          });
        },
      },
    });

    expect(await resolve(ROUTE_AUTHORITY, expectedNamespaceId, {
      generation: 3,
      accessRevision: 2,
    })).toBeNull();
  });

  test("rejects a foreign Task owner before resolving private read authority", async () => {
    let authorityCalls = 0;
    const cryptoActivity = { queries: 0 };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        ownerId: "10000000-0000-4000-8000-000000000099",
        requestorId: "10000000-0000-4000-8000-000000000099",
        agentId: ROUTE_AUTHORITY.agentId,
        contentRepresentation: "protected",
        contentNamespaceId: "10000000-0000-4000-8000-000000000005",
        cryptoMappingState: "verified",
      }]], []),
      restricted: observedRestrictedConnection(cryptoActivity),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "encrypted_only", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
      resolveRequesterPrivateRoom: async () => {
        authorityCalls += 1;
        return null;
      },
    });

    const error = await composition.ports.readRunResult({
      authority: ROUTE_AUTHORITY,
      taskId: "10000000-0000-4000-8000-000000000004",
      taskRunId: "10000000-0000-4000-8000-000000000006",
    }).then(() => null, (caught: unknown) => caught);
    expect(error).toBeInstanceOf(ProtectedTaskRouteError);
    expect((error as ProtectedTaskRouteError).statusCode).toBe(404);
    expect(authorityCalls).toBe(0);
    expect(cryptoActivity.queries).toBe(0);
  });

  test("refreshes a definition through its stored executor rather than the active Genie", async () => {
    const executor = "10000000-0000-4000-8000-000000000099";
    const selected: string[] = [];
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        ownerId: ROUTE_AUTHORITY.userId, requestorId: ROUTE_AUTHORITY.userId,
        agentId: executor, contentRepresentation: "dual",
        contentNamespaceId: "10000000-0000-4000-8000-000000000005",
        cryptoObjectId: "task-definition:v1:fixture", contentRevision: 1,
        cryptoAccessRevision: 0, cryptoMappingState: "stale",
      }]], []),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(), serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({
          policy: { mode: "encrypted_only", shadowBehavior: "strict" }, revalidationToken: 1,
        }),
        revalidate: async () => {},
      } }), observer: { kick() {} },
      resolveRequesterPrivateRoom: async (_owner, agent) => { selected.push(agent); return null; },
    });
    const failure = await composition.ports.readDefinition({
      authority: { ...ROUTE_AUTHORITY, admission: {
        deviceId: ROUTE_AUTHORITY.deviceId, deviceGeneration: 4,
        serverInstanceId: "server", lineageGeneration: 1, epoch: 1,
        securityRevision: 1, headDigest: new Uint8Array(32), expiresAt: Date.now() + 30_000,
      } },
      taskId: "10000000-0000-4000-8000-000000000004",
      objectId: "task-definition:v1:fixture", contentRevision: 1, cryptoAccessRevision: 0,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 409, code: "task_content_changed" });
    expect(selected).toEqual([executor]);
  });

  test.each([
    new TypeError("Mapped Task metadata access proof disagrees"),
    new ClassifiedDataOperationError("integrity", "Task proof is invalid"),
    new Error("Authority service unavailable"),
  ])("Full definition metadata refresh classifies validation failures before ciphertext reads: %s", async failure => {
    const selections: string[][] = [];
    const cryptoActivity = { queries: 0 };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        ownerId: ROUTE_AUTHORITY.userId, requestorId: ROUTE_AUTHORITY.userId,
        agentId: ROUTE_AUTHORITY.agentId, contentRepresentation: "dual",
        contentNamespaceId: "10000000-0000-4000-8000-000000000005",
        cryptoObjectId: "task-definition:v1:fixture", contentRevision: 2,
        cryptoAccessRevision: 0, cryptoMappingState: "verified",
      }]], selections),
      restricted: observedRestrictedConnection(cryptoActivity),
      crypto: new LatticeCrypto(), serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({
          policy: { mode: "encrypted_only", shadowBehavior: "strict" },
          revalidationToken: 1,
        }),
        revalidate: async () => {},
      } }), observer: { kick() {} },
      resolveRequesterPrivateRoom: async () => { throw failure; },
    });
    const result = await composition.ports.readDefinition({
      authority: { ...ROUTE_AUTHORITY, admission: {
        deviceId: ROUTE_AUTHORITY.deviceId, deviceGeneration: 4,
        serverInstanceId: "server", lineageGeneration: 1, epoch: 1,
        securityRevision: 1, headDigest: new Uint8Array(32), expiresAt: Date.now() + 30_000,
      } },
      taskId: "10000000-0000-4000-8000-000000000004",
      objectId: "task-definition:v1:fixture", contentRevision: 2, cryptoAccessRevision: 0,
    }).catch((error: unknown) => error);
    if (failure instanceof TypeError || failure instanceof ClassifiedDataOperationError) {
      expect(result).toMatchObject({ statusCode: 409, code: "task_content_integrity_failure" });
    } else expect(result).toBe(failure);
    expect(selections).toHaveLength(1);
    expect(cryptoActivity.queries).toBe(0);
  });

  test("retains only the exact accepted foreground execution proof for the Task Agent", async () => {
    const crypto = new LatticeCrypto();
    const runtime = {
      agentId: agentId(ROUTE_AUTHORITY.agentId),
      keyClass: "runtime" as const,
      generation: agentRuntimeGeneration(4),
      key: new Uint8Array(32).fill(0x31),
    };
    const signer = deriveAgentRuntimeObjectSignerPublic(crypto, runtime);
    const planBytes = Buffer.from([1, 2, 3, 4]);
    const planDigest = Buffer.from(new Uint8Array(32).fill(0x42));
    const signerPublicKey = Buffer.from(signer.publicKey);
    const transport = createProtectedTaskForegroundSignerTransport({
      resolveEvidence: async principal => {
        expect(principal).toEqual(signer.principal);
        return {
          signerPublicKey,
          planBytes,
          planDigest,
          acceptedAuthority: {
            subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
            authorizedNamespaces: [
              { domainId: "domain:task-private", namespaceId: "namespace:task-private" },
              { domainId: "domain:other", namespaceId: "namespace:another" },
            ],
          },
        };
      },
    });

    expect(await transport.resolveSigner(signer.principal)).toEqual(
      signer.publicKey,
    );
    expect(signerPublicKey.every(byte => byte === 0)).toBe(true);
    expect(planBytes.every(byte => byte === 0)).toBe(true);
    expect(planDigest.every(byte => byte === 0)).toBe(true);
    expect(transport.evidenceFor(
      signer.principal,
      ROUTE_AUTHORITY.agentId,
    )).toEqual({
      kind: "foreground_agent_accepted_execution",
      planBytesBase64url: Buffer.from([1, 2, 3, 4]).toString("base64url"),
      planDigestBase64url: Buffer.from(
        new Uint8Array(32).fill(0x42),
      ).toString("base64url"),
    });
    expect(transport.evidenceFor(
      signer.principal,
      "10000000-0000-4000-8000-000000000099",
    )).toBeNull();
    expect(transport.definitionEvidenceFor(signer.principal, {
      taskAgentId: "10000000-0000-4000-8000-000000000099",
      subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
      domainId: "domain:task-private",
      namespaceId: "namespace:task-private",
    })).toEqual({
      kind: "foreground_agent_accepted_execution",
      planBytesBase64url: Buffer.from([1, 2, 3, 4]).toString("base64url"),
      planDigestBase64url: Buffer.from(
        new Uint8Array(32).fill(0x42),
      ).toString("base64url"),
    });
    for (const expected of [
      { taskAgentId: "10000000-0000-4000-8000-000000000099",
        subjectHumanId: "other-human", domainId: "domain:task-private",
        namespaceId: "namespace:task-private" },
      { taskAgentId: "10000000-0000-4000-8000-000000000099",
        subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
        domainId: "domain:other", namespaceId: "namespace:task-private" },
      { taskAgentId: "10000000-0000-4000-8000-000000000099",
        subjectHumanId: ROUTE_AUTHORITY.subjectHumanId,
        domainId: "domain:task-private", namespaceId: "namespace:another" },
    ]) {
      expect(transport.definitionEvidenceFor(signer.principal, expected))
        .toBeNull();
    }

    transport.destroy();
    expect(transport.evidenceFor(
      signer.principal,
      ROUTE_AUTHORITY.agentId,
    )).toBeNull();
    runtime.key.fill(0);
  });

  test("transports exactly one verified durable Task result signer proof", () => {
    const certificateBytes = new Uint8Array([1, 2, 3, 4]);
    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [{
        kind: "task_runtime_signer_certificate",
        evidenceBytes: certificateBytes,
      }],
      foregroundEvidence: null,
    })).toEqual([{
      kind: "task_runtime_signer_certificate",
      evidenceBytesBase64url: Buffer.from(certificateBytes).toString("base64url"),
    }]);

    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [{
        kind: "agent_runtime_publication",
        evidenceBytes: new Uint8Array([5, 6]),
      }],
      foregroundEvidence: null,
    })).toEqual([{
      kind: "agent_runtime_publication",
      evidenceBytesBase64url: Buffer.from([5, 6]).toString("base64url"),
    }]);

    const foregroundEvidence = Object.freeze({
      kind: "foreground_agent_accepted_execution" as const,
      planBytesBase64url: Buffer.from([7]).toString("base64url"),
      planDigestBase64url: Buffer.from(new Uint8Array(32).fill(8))
        .toString("base64url"),
    });
    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [],
      foregroundEvidence,
    })).toEqual([foregroundEvidence]);

    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [{
        kind: "processor_authorization",
        evidenceBytes: new Uint8Array([9]),
      }],
      foregroundEvidence: null,
    })).toBeNull();
    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [
        {
          kind: "task_runtime_signer_certificate",
          evidenceBytes: certificateBytes,
        },
        {
          kind: "agent_runtime_publication",
          evidenceBytes: new Uint8Array([5, 6]),
        },
      ],
      foregroundEvidence: null,
    })).toBeNull();
    expect(projectVerifiedProtectedTaskRunResultAgentSignerEvidence({
      verifiedSignerEvidence: [{
        kind: "task_runtime_signer_certificate",
        evidenceBytes: certificateBytes,
      }],
      foregroundEvidence,
    })).toBeNull();
  });

  test("does not verify or query the crypto database during construction", async () => {
    const cryptoActivity = { queries: 0 };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithoutQueries(),
      restricted: observedRestrictedConnection(cryptoActivity),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "plaintext_only", shadowBehavior: "fallback" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
    });

    await Promise.resolve();
    expect(composition.mode).toBe("protected_task_production");
    expect(cryptoActivity.queries).toBe(0);
  });

  test("uses canonical selection for creation and pins updates to the durable Namespace", async () => {
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    const expectedNamespaces: (string | undefined)[] = [];
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        id: "10000000-0000-4000-8000-000000000004",
        ownerId: ROUTE_AUTHORITY.userId,
        requestorId: ROUTE_AUTHORITY.userId,
        agentId: ROUTE_AUTHORITY.agentId,
        status: "pending",
        fireLockId: null,
        contentRepresentation: "protected",
        contentNamespaceId: namespaceId,
        contentRevision: 3,
        cryptoAccessRevision: 2,
        cryptoMappingState: "verified",
        scheduleKind: "now",
        runAt: null,
        cron: null,
        timezone: "UTC",
        toolsMode: "auto",
        toolsWhitelist: [],
        requestedModelId: null,
        selectionProfile: "balanced",
        selectionSpec: null,
      }]], []),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "encrypted_only", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
      resolveRequesterPrivateRoom: async (_userId, _agentId, expected) => {
        expectedNamespaces.push(expected);
        return null;
      },
    });

    const createFailure = await composition.ports.plan({
      authority: ROUTE_AUTHORITY,
      taskId: null,
      request: {
        requestVersion: 1,
        operation: "create",
        operationId: "operation-create",
        task: { scheduleKind: "now" },
      },
    }).then(() => null, (error: unknown) => error);
    expect(createFailure).toBeInstanceOf(ProtectedTaskRouteError);

    const updateFailure = await composition.ports.plan({
      authority: ROUTE_AUTHORITY,
      taskId: "10000000-0000-4000-8000-000000000004",
      request: {
        requestVersion: 1,
        operation: "update",
        operationId: "operation-update",
        task: {},
      },
    }).then(() => null, (error: unknown) => error);
    expect(updateFailure).toBeInstanceOf(ProtectedTaskRouteError);
    expect(expectedNamespaces).toEqual([undefined, namespaceId]);
  });

  test("keeps Plain definition reads on the original non-versioned full-row query", async () => {
    const selections: string[][] = [];
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        id: "10000000-0000-4000-8000-000000000004",
        ownerId: ROUTE_AUTHORITY.userId,
        requestorId: ROUTE_AUTHORITY.userId,
        agentId: ROUTE_AUTHORITY.agentId,
        contentRepresentation: "ordinary",
        contentNamespaceId: null,
        cryptoMappingState: "unmapped",
      }]], selections),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({ policy: {
        resolve: async () => ({
          policy: { mode: "plaintext_only", shadowBehavior: "strict" },
          revalidationToken: 1,
        }),
        revalidate: async () => {},
      } }),
      observer: { kick() {} },
    });

    const failure = await composition.ports.readDefinition({
      authority: ROUTE_AUTHORITY,
      taskId: "10000000-0000-4000-8000-000000000004",
      objectId: "task-definition:v1:fixture",
      contentRevision: 1,
      cryptoAccessRevision: 0,
    }).catch((error: unknown) => error);
    expect(failure).toMatchObject({ statusCode: 409, code: "task_content_changed" });
    expect(selections).toHaveLength(1);
    expect(selections[0]).toContain("prompt");
    expect(selections[0]).toContain("expectedOutput");
    expect(selections[0]).toContain("lastError");
    expect(selections[0]).not.toContain("mutationVersion");
  });

  test("keeps mutable ordinary definitions with historical repair without reclassifying invalid sources", async () => {
    const ordinary = {
      id: "10000000-0000-4000-8000-000000000004",
      ownerId: ROUTE_AUTHORITY.userId,
      requestorId: ROUTE_AUTHORITY.userId,
      agentId: ROUTE_AUTHORITY.agentId,
      status: "paused", fireLockId: null, parentTaskId: null, depth: 0,
      contentRepresentation: "ordinary", contentRevision: 0,
      contentNamespaceId: null, cryptoObjectId: null, cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: null, cryptoMappingState: "unmapped",
      ordinaryFallbackOperationId: null, ordinaryFallbackRequestDigest: null,
      ordinaryFallbackReason: null, ordinaryFallbackPolicyRevision: null,
      ordinaryFallbackCompletedAt: null,
    } as const;
    for (const [overrides, expected] of [
      [{}, { statusCode: 409, code: "task_counterpart_not_ready" }],
      [{ status: "running" }, { statusCode: 409, code: "task_not_mutable" }],
      [{ ordinaryFallbackOperationId: "partial" }, { statusCode: 409, code: "task_not_mutable" }],
      [{ ownerId: "another-human" }, { statusCode: 404, code: "task_not_found" }],
    ] as const) {
      const queries = { queries: 0 };
      const composition = createProductionProtectedTaskComposition({
        db: productDatabaseWithReadRows([[{ ...ordinary, ...overrides }]], []),
        restricted: observedRestrictedConnection(queries),
        crypto: new LatticeCrypto(), serverScope: "https://nautilo.test",
        owner: bindEncryptionDataOperationOwner({ policy: {
          resolve: async () => ({
            policy: { mode: "shadow_encryption", shadowBehavior: "fallback" },
            revalidationToken: 1,
          }),
          revalidate: async () => {},
        } }),
        observer: { kick() {} },
        resolveRequesterPrivateRoom: async () => { throw new Error("Private authority must remain idle"); },
      });
      const failure = await composition.ports.plan({
        authority: ROUTE_AUTHORITY, taskId: ordinary.id,
        request: { requestVersion: 1, operation: "update", operationId: "ordinary-update", task: {} },
      }).catch((error: unknown) => error);
      expect(failure).toMatchObject(expected);
      expect(queries.queries).toBe(0);
    }
  });

  test("admits only a coherent receipt-bound stale dual source for normal update planning", async () => {
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    const staleSource = {
      id: "10000000-0000-4000-8000-000000000004",
      ownerId: ROUTE_AUTHORITY.userId,
      requestorId: ROUTE_AUTHORITY.userId,
      agentId: ROUTE_AUTHORITY.agentId,
      status: "paused",
      fireLockId: null,
      contentRepresentation: "dual",
      contentNamespaceId: namespaceId,
      contentRevision: 1,
      cryptoObjectId: "task-definition:v1:source",
      cryptoAccessRevision: 0,
      cryptoRequiredNamespaceFingerprint: new Uint8Array(32).fill(8),
      cryptoMappingState: "stale",
      ordinaryFallbackOperationId: "task:fallback:source",
      ordinaryFallbackRequestDigest: new Uint8Array(32).fill(9),
      ordinaryFallbackReason: "target_encryption_not_ready",
      ordinaryFallbackPolicyRevision: 3,
      ordinaryFallbackCompletedAt: new Date("2026-10-19T08:00:00.000Z"),
      updatedAt: new Date("2026-10-19T08:00:01.000Z"),
      mutationVersion: "17",
      scheduleKind: "now",
      runAt: null,
      cron: null,
      timezone: "UTC",
      toolsMode: "auto",
      toolsWhitelist: [],
      requestedModelId: null,
      selectionProfile: "balanced",
      selectionSpec: null,
    } as const;
    let authorityCalls = 0;
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[staleSource]], []),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
      resolveRequesterPrivateRoom: async () => {
        authorityCalls += 1;
        return null;
      },
    });

    const admitted = await composition.ports.plan({
      authority: ROUTE_AUTHORITY,
      taskId: staleSource.id,
      request: {
        requestVersion: 1,
        operation: "update",
        operationId: "operation-repair",
        task: {},
      },
    }).then(() => null, (caught: unknown) => caught);
    expect(admitted).toMatchObject({
      statusCode: 403,
      code: "task_authority_unavailable",
    });
    expect(authorityCalls).toBe(1);

    const malformed = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([[{
        ...staleSource,
        ordinaryFallbackRequestDigest: new Uint8Array(31),
      }]], []),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
      resolveRequesterPrivateRoom: async () => {
        authorityCalls += 1;
        return null;
      },
    });
    const rejected = await malformed.ports.plan({
      authority: ROUTE_AUTHORITY,
      taskId: staleSource.id,
      request: {
        requestVersion: 1,
        operation: "update",
        operationId: "operation-repair",
        task: {},
      },
    }).then(() => null, (caught: unknown) => caught);
    expect(rejected).toMatchObject({
      statusCode: 409,
      code: "task_not_mutable",
    });
    expect(authorityCalls).toBe(1);
  });

  test("classifies a missing current Namespace bundle as retryable encryption availability", async () => {
    const productAuthority = spyOn(
      PostgresNamespaceProductAuthority.prototype,
      "withCurrentPrivateRoom",
    ).mockImplementation(async input => input.use(Object.freeze({}) as never));
    const domainAuthority = spyOn(
      PostgresDomainKeyAuthorityRepository.prototype,
      "inspectForegroundNamespaceAuthority",
    ).mockResolvedValue(Object.freeze({
      status: "unavailable" as const,
      reason: "namespace_bundle_unavailable",
    }));
    try {
      const composition = createProductionProtectedTaskComposition({
        db: productDatabaseWithProtectedPolicy(),
        restricted: observedRestrictedConnection({ queries: 0 }),
        crypto: new LatticeCrypto(),
        serverScope: "https://nautilo.test",
        owner: bindEncryptionDataOperationOwner({
          policy: {
            resolve: () => Promise.resolve({
              policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
              revalidationToken: 1,
            }),
            revalidate: () => Promise.resolve(),
          },
        }),
        observer: { kick() {} },
        resolveRequesterPrivateRoom: async () => ({
          roomId: "10000000-0000-4000-8000-000000000006",
          namespaceId: "10000000-0000-4000-8000-000000000005",
        }),
      });

      const error = await composition.ports.plan({
        authority: ROUTE_AUTHORITY,
        taskId: null,
        request: {
          requestVersion: 1,
          operation: "create",
          operationId: "operation-create",
          task: { scheduleKind: "now" },
        },
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProtectedTaskRouteError);
      expect(error).toMatchObject({
        statusCode: 409,
        code: "task_encryption_not_ready",
      });
    } finally {
      domainAuthority.mockRestore();
      productAuthority.mockRestore();
    }
  });

  test("keeps inconsistent current Namespace authority in the denial class", async () => {
    const productAuthority = spyOn(
      PostgresNamespaceProductAuthority.prototype,
      "withCurrentPrivateRoom",
    ).mockImplementation(async input => input.use(Object.freeze({}) as never));
    const domainAuthority = spyOn(
      PostgresDomainKeyAuthorityRepository.prototype,
      "inspectForegroundNamespaceAuthority",
    ).mockResolvedValue(Object.freeze({
      status: "unavailable" as const,
      reason: "authority_inconsistent",
    }));
    try {
      const composition = createProductionProtectedTaskComposition({
        db: productDatabaseWithProtectedPolicy(),
        restricted: observedRestrictedConnection({ queries: 0 }),
        crypto: new LatticeCrypto(),
        serverScope: "https://nautilo.test",
        owner: bindEncryptionDataOperationOwner({
          policy: {
            resolve: () => Promise.resolve({
              policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
              revalidationToken: 1,
            }),
            revalidate: () => Promise.resolve(),
          },
        }),
        observer: { kick() {} },
        resolveRequesterPrivateRoom: async () => ({
          roomId: "10000000-0000-4000-8000-000000000006",
          namespaceId: "10000000-0000-4000-8000-000000000005",
        }),
      });

      const error = await composition.ports.plan({
        authority: ROUTE_AUTHORITY,
        taskId: null,
        request: {
          requestVersion: 1,
          operation: "create",
          operationId: "operation-create",
          task: { scheduleKind: "now" },
        },
      }).then(() => null, (caught: unknown) => caught);

      expect(error).toBeInstanceOf(ProtectedTaskRouteError);
      expect(error).toMatchObject({
        statusCode: 403,
        code: "task_authority_unavailable",
      });
    } finally {
      domainAuthority.mockRestore();
      productAuthority.mockRestore();
    }
  });

  test("holds current device authority until publication mapping completes", async () => {
    const events: string[] = [];
    let transactionActive = false;
    const connection: PostgresJsBridgeConnection = {
      query: <Row extends PostgresJsBridgeRow = PostgresJsBridgeRow>(
        _statement: string,
        parameters?: readonly PostgresJsBridgeScalar[],
      ) => {
        events.push("device:locked");
        expect(transactionActive).toBe(true);
        expect(parameters).toEqual([
          ROUTE_AUTHORITY.subjectHumanId,
          ROUTE_AUTHORITY.userId,
          ROUTE_AUTHORITY.actorId,
          ROUTE_AUTHORITY.deviceId,
          ROUTE_AUTHORITY.deviceGeneration,
          7,
          "active",
          "active",
        ]);
        return Promise.resolve([
          { signing_public_key: new Uint8Array(32).fill(9) },
        ]) as unknown as Promise<readonly Row[]>;
      },
      transaction: async <Result>(callback: (
        transaction: PostgresJsBridgeExecutor,
      ) => Promise<Result>) => callback(connection),
      transactionOnce: async <Result>(callback: (
        transaction: PostgresJsBridgeExecutor,
      ) => Promise<Result>) => {
        transactionActive = true;
        events.push("transaction:started");
        try {
          return await callback(connection);
        } finally {
          events.push("transaction:committed");
          transactionActive = false;
        }
      },
    };

    const result = await withCurrentProtectedTaskPublicationDeviceAuthority(
      connection,
      ROUTE_AUTHORITY,
      publicationRequest(),
      async () => {
        expect(transactionActive).toBe(true);
        events.push("product:mapped");
        return "mapped" as const;
      },
    );

    expect(result).toBe("mapped");
    expect(events).toEqual([
      "transaction:started",
      "device:locked",
      "product:mapped",
      "transaction:committed",
    ]);
  });

  test("rejects publication when the device was revoked after validation", async () => {
    let published = false;
    const connection: PostgresJsBridgeConnection = {
      query: () => Promise.resolve([]),
      transaction: async <Result>(callback: (
        transaction: PostgresJsBridgeExecutor,
      ) => Promise<Result>) => callback(connection),
      transactionOnce: async <Result>(callback: (
        transaction: PostgresJsBridgeExecutor,
      ) => Promise<Result>) => callback(connection),
    };

    try {
      await withCurrentProtectedTaskPublicationDeviceAuthority(
        connection,
        ROUTE_AUTHORITY,
        publicationRequest(),
        async () => {
          published = true;
          return "mapped" as const;
        },
      );
      throw new Error("Expected revoked device publication to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(ProtectedTaskRouteError);
      expect((error as ProtectedTaskRouteError).code).toBe(
        "task_authority_unavailable",
      );
    }
    expect(published).toBe(false);
  });

  test("reports an exact terminal reservation as waiting without reading its ordinary sibling", async () => {
    const taskId = "10000000-0000-4000-8000-000000000004";
    const taskRunId = "10000000-0000-4000-8000-000000000006";
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    const objectId = deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId, taskRunId, contentRevision: 1,
    });
    const selections: string[][] = [];
    const cryptoActivity = { queries: 0 };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([
        [{
          ownerId: ROUTE_AUTHORITY.userId,
          requestorId: ROUTE_AUTHORITY.userId,
          agentId: ROUTE_AUTHORITY.agentId,
          contentRepresentation: "protected",
          contentNamespaceId: namespaceId,
          cryptoMappingState: "verified",
        }],
        [{
          taskId, status: "completed", resultRepresentation: "ordinary",
          resultContentNamespaceId: null, resultRevision: 0,
          resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
          resultCryptoMappingState: "unmapped",
        }],
        [{
          taskId, taskRunId, requesterHumanId: ROUTE_AUTHORITY.subjectHumanId,
          contentNamespaceId: namespaceId, anchorNamespaceId: namespaceId,
          resultRevision: 1, cryptoObjectId: objectId,
          representation: "protected", cryptoAccessRevision: 0,
          completion: "complete", disposition: "active", failureCode: null,
        }],
      ], selections),
      restricted: observedRestrictedConnection(cryptoActivity),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "encrypted_only", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
    });

    expect(await composition.ports.readRunResult({
      authority: ROUTE_AUTHORITY,
      taskId,
      taskRunId,
    })).toEqual({
      readVersion: 1, status: "waiting", taskId, taskRunId, objectId,
      resultRevision: 1, cryptoAccessRevision: 0,
      reason: "result_not_mapped",
    });
    expect(selections).toHaveLength(3);
    expect(selections.flat()).not.toContain("resultText");
    expect(selections.flat()).not.toContain("lastError");
    expect(cryptoActivity.queries).toBe(0);
  });

  test("selects the revision-2 cancellation reservation without reading plaintext", async () => {
    const taskId = "10000000-0000-4000-8000-000000000004";
    const taskRunId = "10000000-0000-4000-8000-000000000006";
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    const objectId = deriveTaskContentCryptoObjectIdV1({
      kind: "run_result", taskId, taskRunId, contentRevision: 2,
    });
    const selections: string[][] = [];
    const cryptoActivity = { queries: 0 };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([
        [{
          ownerId: ROUTE_AUTHORITY.userId,
          requestorId: ROUTE_AUTHORITY.userId,
          agentId: ROUTE_AUTHORITY.agentId,
          contentRepresentation: "protected",
          contentNamespaceId: namespaceId,
          cryptoMappingState: "verified",
        }],
        [{
          taskId, status: "cancelled", resultRepresentation: "ordinary",
          resultContentNamespaceId: null, resultRevision: 0,
          resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
          resultCryptoMappingState: "unmapped",
        }],
        [{
          taskId, taskRunId, requesterHumanId: ROUTE_AUTHORITY.subjectHumanId,
          contentNamespaceId: namespaceId, anchorNamespaceId: namespaceId,
          resultRevision: 2, cryptoObjectId: objectId,
          representation: "protected", cryptoAccessRevision: 0,
          completion: "complete", disposition: "active", failureCode: null,
        }],
      ], selections),
      restricted: observedRestrictedConnection(cryptoActivity),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: {
          resolve: () => Promise.resolve({
            policy: { mode: "encrypted_only", shadowBehavior: "strict" },
            revalidationToken: 1,
          }),
          revalidate: () => Promise.resolve(),
        },
      }),
      observer: { kick() {} },
    });

    expect(await composition.ports.readRunResult({
      authority: ROUTE_AUTHORITY,
      taskId,
      taskRunId,
    })).toEqual({
      readVersion: 1, status: "waiting", taskId, taskRunId, objectId,
      resultRevision: 2, cryptoAccessRevision: 0,
      reason: "result_not_mapped",
    });
    expect(selections).toHaveLength(3);
    expect(selections.flat()).not.toContain("resultText");
    expect(selections.flat()).not.toContain("lastError");
    expect(cryptoActivity.queries).toBe(0);
  });

  test("selects a source-versioned revision-1 cancelled result reservation", async () => {
    const taskId = "10000000-0000-4000-8000-000000000004";
    const taskRunId = "10000000-0000-4000-8000-000000000006";
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    const sourceDigest = new Uint8Array(32).fill(0x41);
    const objectId = deriveTaskHistoricalContentCryptoObjectIdV1({
      coordinate: {
        kind: "run_result", taskId, taskRunId, contentRevision: 1,
      },
      namespaceId,
      sourceDigest,
    });
    const historicalRepair = {
      version: 2 as const,
      claimId: "10000000-0000-4000-8000-000000000007",
      publisherDeviceId: "historical-device.1",
      signedRequestDigest: "11".repeat(32),
      sourceDigest: Buffer.from(sourceDigest).toString("hex"),
      sourcePayloadHash: "22".repeat(32),
      sourceRevision: 0 as const,
      genesisManifestHash: "33".repeat(32),
    };
    const composition = createProductionProtectedTaskComposition({
      db: productDatabaseWithReadRows([
        [{ ownerId: ROUTE_AUTHORITY.userId,
          requestorId: ROUTE_AUTHORITY.userId,
          agentId: ROUTE_AUTHORITY.agentId,
          contentRepresentation: "dual", contentNamespaceId: namespaceId,
          cryptoMappingState: "verified" }],
        [{ taskId, status: "cancelled", resultRepresentation: "ordinary",
          resultContentNamespaceId: null, resultRevision: 0,
          resultCryptoObjectId: null, resultCryptoAccessRevision: 0,
          resultCryptoMappingState: "unmapped" }],
        [{ taskId, taskRunId,
          requesterHumanId: ROUTE_AUTHORITY.subjectHumanId,
          contentNamespaceId: namespaceId, anchorNamespaceId: namespaceId,
          resultRevision: 1, cryptoObjectId: objectId,
          representation: "dual", cryptoAccessRevision: 0,
          completion: "complete", disposition: "active", failureCode: null,
          historicalRepair }],
      ], []),
      restricted: observedRestrictedConnection({ queries: 0 }),
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.test",
      owner: bindEncryptionDataOperationOwner({
        policy: { resolve: () => Promise.resolve({
          policy: { mode: "shadow_encryption", shadowBehavior: "strict" },
          revalidationToken: 1,
        }), revalidate: () => Promise.resolve() },
      }),
      observer: { kick() {} },
    });

    expect(await composition.ports.readRunResult({
      authority: ROUTE_AUTHORITY, taskId, taskRunId,
    })).toEqual({
      readVersion: 1, status: "waiting", taskId, taskRunId, objectId,
      resultRevision: 1, cryptoAccessRevision: 0,
      reason: "result_not_mapped",
    });
  });

  test("rejects mapped result revisions that disagree with terminal status", async () => {
    const taskId = "10000000-0000-4000-8000-000000000004";
    const taskRunId = "10000000-0000-4000-8000-000000000006";
    const namespaceId = "10000000-0000-4000-8000-000000000005";
    for (const mismatch of [
      { status: "cancelled", storedRevision: 1, expectedRevision: 2 },
      { status: "completed", storedRevision: 2, expectedRevision: 1 },
    ] as const) {
      const storedObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "run_result", taskId, taskRunId,
        contentRevision: mismatch.storedRevision,
      });
      const expectedObjectId = deriveTaskContentCryptoObjectIdV1({
        kind: "run_result", taskId, taskRunId,
        contentRevision: mismatch.expectedRevision,
      });
      const cryptoActivity = { queries: 0 };
      const composition = createProductionProtectedTaskComposition({
        db: productDatabaseWithReadRows([
          [{
            ownerId: ROUTE_AUTHORITY.userId,
            requestorId: ROUTE_AUTHORITY.userId,
            agentId: ROUTE_AUTHORITY.agentId,
            contentRepresentation: "protected",
            contentNamespaceId: namespaceId,
            cryptoMappingState: "verified",
          }],
          [{
            taskId, status: mismatch.status,
            resultRepresentation: "protected",
            resultContentNamespaceId: namespaceId,
            resultRevision: mismatch.storedRevision,
            resultCryptoObjectId: storedObjectId,
            resultCryptoAccessRevision: 0,
            resultCryptoMappingState: "verified",
          }],
          [{
            taskId, taskRunId,
            requesterHumanId: ROUTE_AUTHORITY.subjectHumanId,
            contentNamespaceId: namespaceId,
            anchorNamespaceId: namespaceId,
            resultRevision: mismatch.expectedRevision,
            cryptoObjectId: expectedObjectId,
            representation: "protected", cryptoAccessRevision: 0,
            completion: "complete", disposition: "mapped", failureCode: null,
          }],
        ], []),
        restricted: observedRestrictedConnection(cryptoActivity),
        crypto: new LatticeCrypto(),
        serverScope: "https://nautilo.test",
        owner: bindEncryptionDataOperationOwner({
          policy: {
            resolve: () => Promise.resolve({
              policy: { mode: "encrypted_only", shadowBehavior: "strict" },
              revalidationToken: 1,
            }),
            revalidate: () => Promise.resolve(),
          },
        }),
        observer: { kick() {} },
      });

      expect(await composition.ports.readRunResult({
        authority: ROUTE_AUTHORITY,
        taskId,
        taskRunId,
      })).toEqual({
        readVersion: 1, status: "unavailable", taskId, taskRunId,
        objectId: expectedObjectId,
        resultRevision: mismatch.expectedRevision,
        cryptoAccessRevision: 0,
        reason: "integrity_failure",
      });
      expect(cryptoActivity.queries).toBe(0);
    }
  });
});
