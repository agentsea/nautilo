import { expect, test } from "bun:test";
import {
  LatticeCrypto,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
  objectId,
  prepareAgentRuntimeInitialization,
} from "@nautilo/lattice-crypto";
import {
  verifyCryptoPostgresHandle,
  type CryptoPostgresConnection,
} from "@nautilo/lattice-bridge/server";

import {
  createPostgresProtectedRecordPublicationPort,
  prepareProtectedRecordPublication,
} from "../../src/server";

function seededBytes(seed: number): (length: number) => Uint8Array {
  let state = seed >>> 0;
  return (length) => {
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
      bytes[index] = state & 0xff;
    }
    return bytes;
  };
}

test("protected publication rejects a prepared capability for different payload bytes", async () => {
  const crypto = new LatticeCrypto(
    { bytes: seededBytes(0x257_04) },
    { now: () => 1_800_000_000_000 },
  );
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "operation-reflection-record-runtime",
    agentId: agentId("agent-reflection-writer"),
    authorizationRevision: authorizationRevision(8),
    configObjects: [{
      objectId: objectId("config-reflection-writer"),
      configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(0x82),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId("human-reflection-manager"),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId("device-reflection-manager"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const resolveCurrentAuthorization = (context: Parameters<
    Parameters<typeof prepareProtectedRecordPublication>[0][
      "resolveCurrentAuthorization"
    ]
  >[0]) => ({
    context,
    grantAuthorized: true,
    namespaceAuthorized: true,
    domainAuthorized: true,
    agentAuthorized: true,
    hostAllowsOperation: true,
    currentRuntime: {
      agentId: initialized.runtime.agentId,
      authorizationRevision: authorizationRevision(8),
      runtimeGeneration: initialized.runtime.generation,
    },
    signerPublication: initialized.signerPublication,
    currentManagerSigningPublicKey: manager.publicKey,
  });
  const prepared = prepareProtectedRecordPublication({
    crypto,
    recordId: "record-prepared-payload",
    representationGeneration: 1,
    payloadBytes: new Uint8Array([1, 2, 3]),
    createdAt: 1_800_000_000_000,
    namespace: {
      namespaceId: "namespace-reflection-record",
      accessRevision: 4,
      bindingHash: new Uint8Array(32).fill(0x84),
      domainId: "domain-reflection-record",
      domainEpoch: 2,
      keyGeneration: 3,
      aiKey: new Uint8Array(32).fill(0x83),
    },
    grant: {
      grantId: "grant-reflection-record",
      grantHash: new Uint8Array(32).fill(0x85),
      useStatus: "reusable",
    },
    runtime: initialized.runtime,
    signerPublication: initialized.signerPublication,
    resolveCurrentAuthorization,
  });

  let transactionCalls = 0;
  const connection: CryptoPostgresConnection = {
    query: <Row>() => Promise.resolve([{
      current_user: "nautilo_crypto",
      session_user: "nautilo_crypto",
    }] as unknown as readonly Row[]),
    transaction: async (callback) => {
      transactionCalls += 1;
      return callback({
        query: () => Promise.reject(new Error("unexpected crypto query")),
      });
    },
  };
  const handle = await verifyCryptoPostgresHandle(connection);
  const port = createPostgresProtectedRecordPublicationPort({
    handle,
    crypto,
    resolvePrepared: () => prepared,
    authenticateCommitted: () => Promise.resolve(true),
    openPayload: () => Promise.resolve({ status: "unavailable", reason: "not_found" }),
    retireObject: () => Promise.resolve(),
  });

  expect(await port.publish({
    recordId: prepared.recordId,
    representationGeneration: prepared.representationGeneration,
    payloadBytes: new Uint8Array([9, 9, 9]),
    publicationBindingRef: "binding-reflection-record",
  })).toEqual({ status: "unavailable", reason: "authorization_unavailable" });
  expect(transactionCalls).toBe(0);
});
