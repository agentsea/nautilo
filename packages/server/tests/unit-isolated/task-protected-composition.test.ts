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
} from "@nautilo/lattice-bridge";
import {
  LatticeCrypto,
  type HumanTaskPublicationRequest,
} from "@nautilo/lattice-crypto";

import {
  ProtectedTaskRouteError,
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
    select(selection: Record<string, unknown>) {
      selections.push(Object.keys(selection));
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
});
