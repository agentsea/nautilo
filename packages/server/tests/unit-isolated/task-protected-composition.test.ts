import { describe, expect, test } from "bun:test";
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
  deriveTaskContentCryptoObjectIdV1,
  deriveTaskHistoricalContentCryptoObjectIdV1,
} from "@nautilo/lattice-bridge";
import {
  agentId,
  agentRuntimeGeneration,
  deriveAgentRuntimeObjectSignerPublic,
  LatticeCrypto,
  type HumanTaskPublicationRequest,
} from "@nautilo/lattice-crypto";

import {
  ProtectedTaskRouteError,
  createProtectedTaskForegroundSignerTransport,
  createProductionProtectedTaskComposition,
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

    transport.destroy();
    expect(transport.evidenceFor(
      signer.principal,
      ROUTE_AUTHORITY.agentId,
    )).toBeNull();
    runtime.key.fill(0);
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
