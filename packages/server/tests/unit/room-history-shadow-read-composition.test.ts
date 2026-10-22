import { expect, test } from "bun:test";

import {
  createProductionRoomHistoryShadowReadComposition,
  createTaskWakeHistorySignerResolver,
} from "../../src/routes/room-history-shadow-read-composition.ts";

test("plaintext history exits before Shadow projection and observation setup", async () => {
  const composition = createProductionRoomHistoryShadowReadComposition({
    getPolicy: () => Promise.resolve({ mode: "plaintext_only" }),
  });

  const result = await composition.project({
    authority: {
      userId: "10000000-0000-4000-8000-000000000001",
      humanActorId: "10000000-0000-4000-8000-000000000002",
    },
    roomId: "10000000-0000-4000-8000-000000000003",
    readerDeviceId: null,
    clientRequestKey: "history-read:plaintext",
    selectedCoordinates: [],
    now: Date.parse("2026-09-03T12:00:00.000Z"),
  });
  expect(result).toEqual({
    responseVersion: 1,
    status: "disabled",
    mode: "plaintext_only",
  });
});


import { LatticeCrypto, agentId, authorizationRevision, cryptoDeviceId, cryptoDomainId,
  domainEpoch, humanId, prepareAgentRuntimeInitialization } from "@nautilo/lattice-crypto";

test("wake history authenticates retained Runtime publication without Human ingress or an origin Task", async () => {
  const crypto = new LatticeCrypto();
  const manager = crypto.generateSigningKeyPair();
  const prepared = await prepareAgentRuntimeInitialization({ crypto, operationId: "wake-history-initialize",
    agentId: agentId("wake-history-agent"), authorizationRevision: authorizationRevision(7),
    configObjects: [{ objectId: "wake-history-config", configRevision: authorizationRevision(1),
      plaintextDek: new Uint8Array(32).fill(3) }],
    domains: [{ domainId: cryptoDomainId("wake-history-domain"), domainEpoch: domainEpoch(4),
      agentAuthorizationRevision: authorizationRevision(7), committerDeviceId: cryptoDeviceId("wake-history-manager"),
      domainRoot: new Uint8Array(32).fill(4), committerSigningPrivateKey: manager.privateKey }],
    resolveCurrentDomainCommitterAuthority: () => manager.publicKey,
    manager: { managerHumanId: humanId("wake-history-human"), managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId("wake-history-manager") }, managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey });
  prepared.runtime.key.fill(0);
  const publication = prepared.signerPublication;
  const principal = { kind: "agent_runtime" as const, agentId: publication.agentId,
    runtimeGeneration: publication.runtimeGeneration, signerKeyId: publication.signerKeyId };
  let available = true;
  let forged = false;
  let managerAvailable = true;
  const resolve = createTaskWakeHistorySignerResolver({ crypto,
    storage: { getAgentRuntimeSignerPublication: async () => {
      if (!available) return null;
      const copy = structuredClone(publication);
      if (forged) copy.signature[0] = copy.signature[0]! ^ 1;
      return copy;
    } },
    resolveHistoricalManagerAuthority: context => managerAvailable
      ? { ...context, managerSigningPublicKey: manager.publicKey } : null,
  });
  expect(await resolve(principal)).toEqual(publication.signerPublicKey);
  expect(await resolve({ ...principal, agentId: agentId("wrong-agent") })).toBeNull();
  expect(await resolve({ ...principal, signerKeyId: "wrong-key" })).toBeNull();
  available = false;
  expect(await resolve(principal)).toBeNull();
  available = true;
  managerAvailable = false;
  expect(resolve(principal)).rejects.toThrow("historical manager authority");
  managerAvailable = true;
  forged = true;
  expect(resolve(principal)).rejects.toThrow("signature is invalid");
  manager.privateKey.fill(0);
});
