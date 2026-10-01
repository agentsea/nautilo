import { describe, expect, test } from "bun:test";

import {
  LatticeCrypto,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  persistAgentRuntimeInitialization,
  prepareAgentRuntimeInitialization,
  type DomainForegroundSecretEntry,
  type Rng,
} from "@nautilo/lattice-crypto";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";

import { createFakeLatticeStorage } from
  "../../src/testing/fake-lattice-storage.ts";
import {
  withProtectedTaskResultSigner,
} from "../../src/task/protected-task-result-signer.ts";

const NOW = 1_830_000_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "30000000-0000-4000-8000-000000000001";
const DOMAIN_ID = "40000000-0000-4000-8000-000000000001";
const AGENT_ID = "50000000-0000-4000-8000-000000000001";
const AGENT_AUTHORIZATION_REVISION = 7;
const DOMAIN_AUTHORIZATION_REVISION = 11;
const DOMAIN_EPOCH = 4;

function bytes(value: number): Uint8Array {
  return new Uint8Array(32).fill(value);
}

function seededRng(seed: number): Rng {
  let state = seed >>> 0;
  return {
    bytes(length: number): Uint8Array {
      const result = new Uint8Array(length);
      for (let index = 0; index < length; index += 1) {
        state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
        result[index] = state & 0xff;
      }
      return result;
    },
  };
}

async function fixture() {
  const crypto = new LatticeCrypto(seededRng(0x334_05), { now: () => NOW });
  const committer = crypto.generateSigningKeyPair();
  const manager = crypto.generateSigningKeyPair();
  const domainRoot = bytes(0x41);
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: "task-result-signer-initialization",
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(
      AGENT_AUTHORIZATION_REVISION,
    ),
    configObjects: [{
      objectId: "task-result-agent-config",
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x31),
    }],
    domains: [{
      domainId: cryptoDomainId(DOMAIN_ID),
      domainEpoch: domainEpoch(DOMAIN_EPOCH),
      agentAuthorizationRevision: authorizationRevision(
        AGENT_AUTHORIZATION_REVISION,
      ),
      committerDeviceId: cryptoDeviceId("task-result-committer"),
      domainRoot,
      committerSigningPrivateKey: committer.privateKey,
    }],
    resolveCurrentDomainCommitterAuthority: () => committer.publicKey,
    manager: {
      managerHumanId: humanId("task-result-manager"),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId("task-result-manager-device"),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const { storage } = createFakeLatticeStorage();
  expect(await persistAgentRuntimeInitialization({
    crypto,
    storage,
    prepared: initialized,
    resolveCurrentAuthorization: () => ({
      currentState: {
        agentId: agentId(AGENT_ID),
        authorizationRevision: authorizationRevision(
          AGENT_AUTHORIZATION_REVISION,
        ),
        runtimeGeneration: agentRuntimeGeneration(0),
      },
      currentManager: {
        managerHumanId: humanId("task-result-manager"),
        managerAuthorizationRevision: authorizationRevision(3),
        managerDeviceId: cryptoDeviceId("task-result-manager-device"),
      },
      currentManagerSigningPublicKey: manager.publicKey,
      domains: [{
        domainId: cryptoDomainId(DOMAIN_ID),
        domainEpoch: domainEpoch(DOMAIN_EPOCH),
        agentAuthorizationRevision: authorizationRevision(
          AGENT_AUTHORIZATION_REVISION,
        ),
        committerDeviceId: cryptoDeviceId("task-result-committer"),
        committerSigningPublicKey: committer.publicKey,
      }],
    }),
  })).toBe("inserted");
  initialized.runtime.key.fill(0);

  const domain = Object.freeze({
    domainId: DOMAIN_ID,
    sourceNamespaceId: NAMESPACE_ID,
    participantDigest: bytes(0x51),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: DOMAIN_EPOCH,
    authorizationRevision: authorizationRevision(
      DOMAIN_AUTHORIZATION_REVISION,
    ),
    headDigest: bytes(0x52),
    domainKey: domainRoot.slice(),
  } satisfies DomainForegroundSecretEntry);
  return { crypto, committer, manager, storage, domain };
}

function evidenceFor(
  domain: DomainForegroundSecretEntry,
  input: Readonly<{
    domainId?: string;
    domainEpoch?: number;
    signerAgentId?: string;
  }> = {},
): TaskRuntimeExecutionEvidenceInputV1 {
  const domainId = input.domainId ?? domain.domainId;
  const domainKeyGeneration = input.domainEpoch ?? domain.domainKeyGeneration;
  return Object.freeze({
    requestId: "task-result-signer-request",
    workId: RUN_ID,
    claimId: "task-result-signer-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "task-result-signer-recipient",
    authorizationDigest: bytes(0x61),
    policyRevision: 5,
    episodeId: "task-result-signer-episode",
    sourceRoomId: "task-result-signer-room",
    hostAuthorizationRevision: 2,
    recipientAuthorizationRevision: 0,
    result: Object.freeze({
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      contentRevision: 1 as const,
      objectId: "task-result-signer-object",
      signerAgentId: input.signerAgentId ?? AGENT_ID,
      namespace: Object.freeze({
        namespaceId: NAMESPACE_ID,
        domainId,
        operations: Object.freeze(["encrypt"] as const),
        expectedAccessRevision: 0,
        expectedPolicyRevision: 5,
      }),
    }),
    domainRequirements: Object.freeze([Object.freeze({
      domainId,
      sourceNamespaceId: domain.sourceNamespaceId,
      participantDigest: domain.participantDigest,
      participantCount: domain.participantCount,
      keyClass: "ai" as const,
      domainKeyGeneration,
      authorizationRevision: domain.authorizationRevision,
      headDigest: domain.headDigest,
      activeNamespaceBindingSetDigest: bytes(0x62),
      activeNamespaceBindingCount: 1,
    })]),
    namespaceRequirements: Object.freeze([Object.freeze({
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: 0,
      expectedPolicyRevision: 5,
    })]),
  });
}

describe("protected Task result signer", () => {
  test("lends the current durable signer and wipes its Runtime key", async () => {
    const state = await fixture();
    const controller = new AbortController();
    const capture: { borrowedKey: Uint8Array | null } = {
      borrowedKey: null,
    };
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: controller.signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: (authority) => {
          capture.borrowedKey = authority.runtime.key;
          expect(String(authority.runtime.agentId)).toBe(AGENT_ID);
          expect(String(authority.signerPublication.agentId)).toBe(AGENT_ID);
          expect(authority.agentAuthorizationRevision)
            .toBe(AGENT_AUTHORIZATION_REVISION);
          expect(authority.runtime.key).not.toEqual(new Uint8Array(32));
          return "prepared";
        },
      }),
    });
    expect(result).toEqual({ status: "executed", value: "prepared" });
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });

  test.each([
    ["Domain", { domainId: "different-domain" }],
    ["Domain epoch", { domainEpoch: DOMAIN_EPOCH + 1 }],
    ["Agent", { signerAgentId: "different-agent" }],
  ] as const)("rejects a wrong %s before lending the signer", async (
    _label,
    mismatch,
  ) => {
    const state = await fixture();
    const domain = Object.freeze({
      ...state.domain,
      domainId: "domainId" in mismatch
        ? mismatch.domainId
        : state.domain.domainId,
      domainKeyGeneration:
        "domainEpoch" in mismatch
          ? mismatch.domainEpoch
          : state.domain.domainKeyGeneration,
    });
    let executed = false;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(domain, mismatch),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => {
          executed = true;
        },
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
    expect(executed).toBe(false);
  });

  test("rejects a stale Agent authorization revision", async () => {
    const state = await fixture();
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision:
          AGENT_AUTHORIZATION_REVISION + 1,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => "must-not-run",
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "runtime_unavailable",
    });
  });

  test("rejects a substituted signer publication", async () => {
    const state = await fixture();
    const publication = await state.storage.getAgentRuntimeSignerPublication(
      AGENT_ID,
      0,
    );
    if (publication === null) throw new Error("missing signer publication");
    const signerPublicKey = publication.signerPublicKey.slice();
    signerPublicKey[0] = signerPublicKey[0]! ^ 0xff;
    let executed = false;
    const result = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: {
          getAgentRuntimeAtomicState:
            state.storage.getAgentRuntimeAtomicState.bind(state.storage),
          getAgentRuntimeSignerPublication: async () => Object.freeze({
            ...publication,
            signerPublicKey,
          }),
        },
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: () => {
          executed = true;
        },
      }),
    });
    expect(result).toEqual({
      status: "unavailable",
      reason: "signer_unavailable",
    });
    expect(executed).toBe(false);
  });

  test("wipes the Runtime key when the bounded callback throws", async () => {
    const state = await fixture();
    const capture: { borrowedKey: Uint8Array | null } = {
      borrowedKey: null,
    };
    const failure = await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceFor(state.domain),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: (evidence) => withProtectedTaskResultSigner({
        crypto: state.crypto,
        storage: state.storage,
        evidence,
        domain: state.domain,
        expectedAgentAuthorizationRevision: AGENT_AUTHORIZATION_REVISION,
        resolveHistoricalRuntimeCommitter: () => state.committer.publicKey,
        resolveHistoricalSignerPublicationManager: () =>
          state.manager.publicKey,
        execute: (authority) => {
          capture.borrowedKey = authority.runtime.key;
          throw new Error("synthetic preparation failure");
        },
      }),
    }).then(() => null, (error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toBe("synthetic preparation failure");
    expect(capture.borrowedKey).toEqual(new Uint8Array(32));
  });
});
