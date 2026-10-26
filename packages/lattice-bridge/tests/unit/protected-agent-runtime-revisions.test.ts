import { expect, test } from "bun:test";
import {
  LatticeCrypto, accessRevision, agentId, agentRuntimeGeneration,
  authorizationRevision, cryptoDeviceId, cryptoDomainId, domainEpoch,
  grantId, humanId, namespaceId, objectId, persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
} from "@nautilo/lattice-crypto";
import {
  withProtectedAgentRuntimeConfiguration,
  withProtectedAgentRuntimeGeneration,
} from "../../src/invocation/protected-agent-runtime";
import { createFakeLatticeStorage } from "../../src/testing/fake-lattice-storage";

async function fixture() {
  const crypto = new LatticeCrypto();
  const signing = crypto.generateSigningKeyPair();
  const domains = [11, 13].map((revision, index) => ({
    domainId: cryptoDomainId(`runtime-domain-${index}`),
    domainEpoch: domainEpoch(4),
    agentAuthorizationRevision: authorizationRevision(revision),
    committerDeviceId: cryptoDeviceId("runtime-device"),
    domainRoot: new Uint8Array(32).fill(index + 1),
    committerSigningPrivateKey: signing.privateKey,
  }));
  const manager = {
    managerHumanId: humanId("runtime-human"),
    managerAuthorizationRevision: authorizationRevision(3),
    managerDeviceId: cryptoDeviceId("runtime-device"),
  };
  const prepared = await prepareAgentRuntimeInitialization({
    crypto, operationId: "runtime-independent-revisions", agentId: agentId("runtime-agent"),
    authorizationRevision: authorizationRevision(17),
    configObjects: [{ objectId: objectId("runtime-config"),
      configRevision: authorizationRevision(1), plaintextDek: new Uint8Array(32).fill(3) }],
    domains, manager, managerSigningPrivateKey: signing.privateKey,
    resolveCurrentDomainCommitterAuthority: () => signing.publicKey,
    resolveCurrentManagerAuthority: () => signing.publicKey,
  });
  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto, storage, prepared,
    resolveCurrentAuthorization: () => ({
      currentState: { agentId: agentId("runtime-agent"),
        authorizationRevision: authorizationRevision(17), runtimeGeneration: agentRuntimeGeneration(0) },
      currentManager: manager, currentManagerSigningPublicKey: signing.publicKey,
      domains: domains.map(domain => ({ domainId: domain.domainId, domainEpoch: domain.domainEpoch,
        agentAuthorizationRevision: domain.agentAuthorizationRevision,
        committerDeviceId: domain.committerDeviceId, committerSigningPublicKey: signing.publicKey })),
    }),
  })).toBe("inserted");
  const expectedKey = prepared.runtime.key.slice();
  prepared.runtime.key.fill(0);
  signing.privateKey.fill(0);
  const request = (index = 0) => ({
    crypto, storage, agentId: agentId("runtime-agent"),
    expectedRuntimeAuthorizationRevision: 17,
    opened: {
      grantId: grantId("runtime-grant"), namespaceId: namespaceId("runtime-namespace"),
      namespaceAccessRevision: accessRevision(0),
      domainId: domains[index]!.domainId, domainEpoch: domains[index]!.domainEpoch,
      agentAuthorizationRevision: domains[index]!.agentAuthorizationRevision,
      aiRoot: domains[index]!.domainRoot,
    },
    resolveHistoricalCommitter: () => signing.publicKey,
  });
  return { crypto, storage, request, expectedKey };
}

test("opens one Runtime through independently authorized Domain revisions and wipes borrowed keys", async () => {
  const state = await fixture();
  for (const index of [0, 1]) {
    let borrowed: Uint8Array | undefined;
    expect(await withProtectedAgentRuntimeGeneration({
      ...state.request(index), execute: runtime => {
        borrowed = runtime.key;
        expect(runtime.key).toEqual(state.expectedKey);
        return "opened";
      },
    })).toEqual({ status: "executed", value: "opened" });
    expect(borrowed?.every(byte => byte === 0)).toBe(true);
  }
});

test("rejects stale or invalid global Runtime expectations before lending a key", async () => {
  const state = await fixture();
  for (const revision of [16, 18, -1, 17.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
    let invoked = false;
    expect(await withProtectedAgentRuntimeGeneration({
      ...state.request(), expectedRuntimeAuthorizationRevision: revision,
      execute: () => { invoked = true; },
    })).toEqual({ status: "unavailable", reason: "runtime_unavailable" });
    expect(invoked).toBe(false);
  }
});

test("retains exact Domain revision and epoch checks independently of global freshness", async () => {
  const state = await fixture();
  for (const opened of [
    { ...state.request().opened, agentAuthorizationRevision: authorizationRevision(12) },
    { ...state.request().opened, domainEpoch: domainEpoch(5) },
  ]) {
    let invoked = false;
    expect(await withProtectedAgentRuntimeGeneration({
      ...state.request(), opened, execute: () => { invoked = true; },
    })).toEqual({ status: "unavailable", reason: "runtime_unavailable" });
    expect(invoked).toBe(false);
  }
});

test("rejects duplicate, corrupted, and wrong-generation Runtime envelopes", async () => {
  const state = await fixture();
  const stored = (await state.storage.getAgentRuntimeAtomicState(agentId("runtime-agent")))!;
  const record = stored.domainEnvelopes.find(entry => entry.domainId === state.request().opened.domainId)!;
  const alteredBytes = record.envelopeBytes.slice();
  alteredBytes[alteredBytes.length - 1] = alteredBytes[alteredBytes.length - 1]! ^ 1;
  for (const domainEnvelopes of [
    [...stored.domainEnvelopes, record],
    stored.domainEnvelopes.map(entry => entry === record
      ? { ...entry, runtimeGeneration: agentRuntimeGeneration(1) } : entry),
    stored.domainEnvelopes.map(entry => entry === record
      ? { ...entry, envelopeHash: new Uint8Array(32) } : entry),
    stored.domainEnvelopes.map(entry => entry === record
      ? { ...entry, envelopeBytes: alteredBytes, envelopeHash: state.crypto.hash(alteredBytes) } : entry),
  ]) {
    let invoked = false;
    expect(await withProtectedAgentRuntimeGeneration({
      ...state.request(), storage: { getAgentRuntimeAtomicState: async () => ({ ...stored, domainEnvelopes }) },
      execute: () => { invoked = true; },
    })).toEqual({ status: "unavailable", reason: "runtime_unavailable" });
    expect(invoked).toBe(false);
  }
});

test("wipes a borrowed Runtime key when its callback throws", async () => {
  const state = await fixture();
  let borrowed: Uint8Array | undefined;
  const failure = new Error("runtime callback failed");
  const result = await withProtectedAgentRuntimeGeneration({
    ...state.request(), execute: runtime => { borrowed = runtime.key; throw failure; },
  }).catch((error: unknown) => error);
  expect(result).toBe(failure);
  expect(borrowed?.every(byte => byte === 0)).toBe(true);
});

test("preserves the legacy single-Domain configuration equality contract", async () => {
  const state = await fixture();
  let invoked = false;
  expect(await withProtectedAgentRuntimeConfiguration({
    ...state.request(), objectId: objectId("runtime-config"), expectedObjectType: "runtime-config",
    execute: () => { invoked = true; },
  })).toEqual({ status: "unavailable", reason: "runtime_unavailable" });
  expect(invoked).toBe(false);
});
