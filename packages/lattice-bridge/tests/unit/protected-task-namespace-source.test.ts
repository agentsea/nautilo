import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  createInitialNamespaceKeyrings,
  createNamespaceBinding,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  namespaceBindingHash,
  namespaceId,
  sealNamespaceKeyring,
  type DomainForegroundSecretEntry,
  type LatticeStorage,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  serializeNamespaceBindingV2,
  serializeNamespaceKeyringEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { withProtectedTaskResultNamespaceSource } from
  "../../src/task/protected-task-namespace-source.ts";

const NOW = 1_820_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000001";
const RUN = "20000000-0000-4000-8000-000000000002";
const NAMESPACE = "30000000-0000-4000-8000-000000000003";
const DOMAIN = "40000000-0000-4000-8000-000000000004";
const AGENT = "50000000-0000-4000-8000-000000000005";

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function rng(): Rng {
  let state = 7;
  return {
    bytes(length) {
      const value = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        value[index] = state & 0xff;
      }
      return value;
    },
  };
}

function fixture() {
  const crypto = new LatticeCrypto(rng(), { now: () => NOW });
  const signer = crypto.generateSigningKeyPair();
  const domainRoot = bytes(0x47);
  const id = namespaceId(NAMESPACE);
  const keyrings = createInitialNamespaceKeyrings(crypto, id);
  const metadata = {
    domainId: cryptoDomainId(DOMAIN),
    domainEpoch: domainEpoch(2),
    accessRevision: accessRevision(0),
    previousBindingHash: null,
    committerDeviceId: cryptoDeviceId("task-source-committer"),
  };
  const human = sealNamespaceKeyring({
    crypto,
    domainRoot: bytes(0x21),
    keyring: keyrings.human,
    metadata,
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  const ai = sealNamespaceKeyring({
    crypto,
    domainRoot,
    keyring: keyrings.ai,
    metadata,
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  const binding = createNamespaceBinding({
    crypto,
    humanEnvelope: human,
    aiEnvelope: ai,
    committerSigningPrivateKey: signer.privateKey,
    resolveCurrentCommitter: () => signer.publicKey,
  });
  const hash = namespaceBindingHash(binding);
  const head = {
    namespaceId: NAMESPACE,
    accessRevision: 0,
    bindingHash: hash,
    domainId: DOMAIN,
    domainEpoch: 2,
  };
  const record = {
    namespaceId: NAMESPACE,
    revision: 0,
    bindingHash: hash,
    previousBindingHash: null,
    signedBindingBytes: serializeNamespaceBindingV2(binding),
    humanKeyringEnvelopeBytes: serializeNamespaceKeyringEnvelopeV2(human),
    aiKeyringEnvelopeBytes: serializeNamespaceKeyringEnvelopeV2(ai),
  };
  const storage: Pick<LatticeStorage, "getNamespaceHead" | "getBinding"> = {
    getNamespaceHead: async () => head,
    getBinding: async () => record,
  };
  const domain: DomainForegroundSecretEntry = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai",
    domainKeyGeneration: 2,
    authorizationRevision: authorizationRevision(3),
    headDigest: bytes(0x62),
    domainKey: domainRoot,
  };
  const evidence = {
    requestId: "task-source-request",
    workId: RUN,
    claimId: "task-source-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-source-recipient",
    authorizationDigest: bytes(0x51),
    policyRevision: 4,
    episodeId: "task-source-episode",
    sourceRoomId: "task-source-room",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: {
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 1 as const,
      objectId: "task-result-object",
      signerAgentId: AGENT,
      namespace: {
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["encrypt"] as const,
        expectedAccessRevision: 0,
        expectedPolicyRevision: 4,
      },
    },
    domainRequirements: [{
      domainId: DOMAIN,
      sourceNamespaceId: NAMESPACE,
      participantDigest: bytes(0x61),
      participantCount: 1,
      keyClass: "ai" as const,
      domainKeyGeneration: 2,
      authorizationRevision: authorizationRevision(3),
      headDigest: bytes(0x62),
      activeNamespaceBindingSetDigest: bytes(0x63),
      activeNamespaceBindingCount: 1,
    }],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      operations: ["decrypt", "encrypt"] as const,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 4,
    }],
  } satisfies TaskRuntimeExecutionEvidenceInputV1;
  return {
    crypto,
    signer,
    head,
    record,
    storage,
    domain,
    evidence,
  };
}

describe("protected Task result Namespace source", () => {
  test("opens the exact signed binding and current Domain root inside the live grant", async () => {
    const scenario = fixture();
    let currentChecks = 0;
    const value = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultNamespaceSource({
        crypto: scenario.crypto,
        storage: scenario.storage,
        evidence,
        domains: [scenario.domain],
        signal: new AbortController().signal,
        resolveHistoricalCommitter: () => scenario.signer.publicKey,
        assertCurrentTaskAuthority: async () => { currentChecks += 1; },
        execute: (source) => {
          expect(source.trustedHead.namespaceId).toBe(namespaceId(NAMESPACE));
          expect(source.trustedHead.bindingHash).toEqual(scenario.head.bindingHash);
          expect(source.currentDomainRoot).toBe(scenario.domain.domainKey);
          expect(source.aiKeyringEnvelope.keyClass).toBe("ai");
          return "opened";
        },
      }),
    });
    expect(value).toBe("opened");
    expect(currentChecks).toBe(2);
  });

  test("rejects a substituted current head before lending the root", async () => {
    const scenario = fixture();
    scenario.head.bindingHash = bytes(0x99);
    const failure = await withTaskRuntimeExecutionEvidenceV1({
      evidence: scenario.evidence,
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultNamespaceSource({
        crypto: scenario.crypto,
        storage: scenario.storage,
        evidence,
        domains: [scenario.domain],
        signal: new AbortController().signal,
        resolveHistoricalCommitter: () => scenario.signer.publicKey,
        assertCurrentTaskAuthority: async () => undefined,
        execute: () => "must not execute",
      }).then(() => null, (error: unknown) => error),
    });
    expect(failure).toBeInstanceOf(TypeError);
  });

  test.each(["wrong Domain epoch", "missing binding", "aborted"] as const)(
    "does not lend the root with %s",
    async (reason) => {
      const scenario = fixture();
      const controller = new AbortController();
      const domain = reason === "wrong Domain epoch"
        ? { ...scenario.domain, domainKeyGeneration: 3 }
        : scenario.domain;
      const storage = reason === "missing binding"
        ? { ...scenario.storage, getBinding: async () => null }
        : scenario.storage;
      if (reason === "aborted") controller.abort();
      let executed = false;
      const failure = await withTaskRuntimeExecutionEvidenceV1({
        evidence: scenario.evidence,
        signal: new AbortController().signal,
        now: () => NOW,
        execute: (evidence) => withProtectedTaskResultNamespaceSource({
          crypto: scenario.crypto,
          storage,
          evidence,
          domains: [domain],
          signal: controller.signal,
          resolveHistoricalCommitter: () => scenario.signer.publicKey,
          assertCurrentTaskAuthority: async () => undefined,
          execute: () => {
            executed = true;
          },
        }).then(() => null, (error: unknown) => error),
      });
      expect(failure).toBeInstanceOf(Error);
      expect(executed).toBe(false);
    },
  );
});
