import { describe, expect, test } from "bun:test";
import {
  LatticeCrypto,
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  decryptObjectThroughNamespace,
  humanId,
  namespaceGeneration,
  prepareAgentRuntimeInitialization,
  type ObjectAccessStateCasStatus,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  decodeEncryptedPayloadV2,
  decodeNamespaceObjectEnvelopeV2,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import {
  consumeAuthorizedObjectAccessWriteV2,
  type AuthorizedObjectAccessWriteV2,
} from "../../../lattice-crypto/src/object/authorized-write.ts";
import { seededRng } from "../../../lattice-crypto/src/crypto/index.ts";

import {
  prepareTaskRuntimeAgentObject,
  readPreparedTaskRuntimeAgentObjectSnapshot,
  type PreparedTaskRuntimeAgentObject,
} from "../../src/object/task-runtime-agent-object-crypto.ts";
import {
  persistTaskRuntimeAgentObject,
  type TaskRuntimeAgentObjectPersistenceAuthority,
} from "../../src/server/object/postgres-task-runtime-agent-object.ts";

const NOW = 2_210_000_000_000;
const AGENT_ID = "task-object-agent";
const TASK_RUN_ID = "task-object-run";
const OBJECT_ID = "task-object-memory";
const NAMESPACE_ID = "task-object-namespace";
const DOMAIN_ID = "task-object-domain";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

class ObservedCrypto extends LatticeCrypto {
  readonly sealedPlaintexts: Uint8Array[] = [];

  override aeadSeal(
    key: Uint8Array,
    plaintext: Uint8Array,
    aad?: Uint8Array,
  ): Uint8Array {
    this.sealedPlaintexts.push(plaintext);
    return super.aeadSeal(key, plaintext, aad);
  }
}

async function fixture(seed = 42_001) {
  const crypto = new LatticeCrypto(seededRng(seed), { now: () => NOW });
  const manager = crypto.generateSigningKeyPair();
  const initialized = await prepareAgentRuntimeInitialization({
    crypto,
    operationId: `task-object-runtime-${seed}`,
    agentId: agentId(AGENT_ID),
    authorizationRevision: authorizationRevision(7),
    configObjects: [{
      objectId: `task-object-config-${seed}`,
      configRevision: authorizationRevision(1),
      plaintextDek: bytes(0x21),
    }],
    domains: [],
    resolveCurrentDomainCommitterAuthority: () => null,
    manager: {
      managerHumanId: humanId(`task-object-manager-${seed}`),
      managerAuthorizationRevision: authorizationRevision(3),
      managerDeviceId: cryptoDeviceId(`task-object-manager-device-${seed}`),
    },
    managerSigningPrivateKey: manager.privateKey,
    resolveCurrentManagerAuthority: () => manager.publicKey,
  });
  const namespaceKey = bytes(0x71);
  const namespace = Object.freeze({
    namespaceId: NAMESPACE_ID,
    accessRevision: accessRevision(5),
    keyGeneration: namespaceGeneration(2),
    domainId: DOMAIN_ID,
    domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(11),
    domainHeadDigest: bytes(0x31),
    headDigest: bytes(0x32),
    publicationDigest: bytes(0x33),
    publicationSetDigest: bytes(0x34),
    audienceFingerprint: bytes(0x35),
    key: namespaceKey,
  });
  const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: `task-object-request-${seed}`,
    workId: TASK_RUN_ID,
    claimId: `task-object-claim-${seed}`,
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 90_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 4,
    recipientKeyId: `task-object-recipient-${seed}`,
    authorizationDigest: bytes(0x41),
    policyRevision: 17,
    episodeId: `task-object-episode-${seed}`,
    sourceRoomId: `task-object-room-${seed}`,
    hostAuthorizationRevision: 19,
    recipientAuthorizationRevision: 23,
    result: {
      taskId: `task-object-task-${seed}`,
      taskRunId: TASK_RUN_ID,
      contentRevision: 1,
      objectId: `task-object-result-${seed}`,
      signerAgentId: AGENT_ID,
      namespace: {
        namespaceId: NAMESPACE_ID,
        domainId: DOMAIN_ID,
        operations: ["encrypt"],
        expectedAccessRevision: namespace.accessRevision,
        expectedPolicyRevision: 17,
      },
    },
    domainRequirements: [{
      domainId: DOMAIN_ID,
      sourceNamespaceId: NAMESPACE_ID,
      participantDigest: bytes(0x51),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: namespace.domainKeyGeneration,
      authorizationRevision: namespace.domainAuthorizationRevision,
      headDigest: namespace.domainHeadDigest,
      activeNamespaceBindingSetDigest: bytes(0x52),
      activeNamespaceBindingCount: 1,
    }],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: ["decrypt", "encrypt"],
      expectedAccessRevision: namespace.accessRevision,
      expectedPolicyRevision: 17,
    }],
  };
  const signal = new AbortController().signal;
  const withEvidence = <Value>(
    execute: (evidence: TaskRuntimeExecutionEvidence) => Value | PromiseLike<Value>,
    input = evidenceInput,
  ) => withTaskRuntimeExecutionEvidenceV1({
    evidence: input,
    signal,
    now: () => NOW,
    execute,
  });
  const prepare = (
    evidence: TaskRuntimeExecutionEvidence,
    preparationCrypto: LatticeCrypto = crypto,
    plaintextBytes = new TextEncoder().encode("protected Task Memory"),
  ) => prepareTaskRuntimeAgentObject({
    crypto: preparationCrypto,
    evidence,
    objectId: OBJECT_ID,
    objectType: "task-memory/v1",
    plaintextBytes,
    createdAt: NOW,
    namespaceSet: [namespace],
    operationId: `task-object-write-${seed}`,
    runtime: initialized.runtime,
    signerPublication: initialized.signerPublication,
    resolveHistoricalSignerPublicationManager: () => manager.publicKey,
    agentAuthorizationRevision: 7,
  });
  const currentAuthorization = (
    storage: TaskRuntimeAgentObjectPersistenceAuthority["storage"],
  ): TaskRuntimeAgentObjectPersistenceAuthority => ({
    storage,
    currentRuntime: {
      agentId: initialized.runtime.agentId,
      authorizationRevision: authorizationRevision(7),
      runtimeGeneration: initialized.runtime.generation,
    },
    signerPublication: structuredClone(initialized.signerPublication),
    currentManagerSigningPublicKey: manager.publicKey.slice(),
  });
  return {
    crypto,
    initialized,
    namespace,
    namespaceKey,
    evidenceInput,
    withEvidence,
    prepare,
    currentAuthorization,
  };
}

function allZero(value: Uint8Array): boolean {
  return value.every((byte) => byte === 0);
}

function fakeStorage(input: Readonly<{
  objectId?: string;
  payloadBytes?: Uint8Array;
  status?: ObjectAccessStateCasStatus;
  stages?: string[];
  held?: () => boolean;
  afterPut?: () => void;
}>): TaskRuntimeAgentObjectPersistenceAuthority["storage"] {
  let durablePayload = input.payloadBytes?.slice() ?? null;
  return {
    putObject: async (object) => {
      expect(input.held?.() ?? true).toBeTrue();
      input.stages?.push("put");
      durablePayload = object.payloadBytes.ciphertext.slice();
      input.afterPut?.();
    },
    getObject: async (objectId) => {
      expect(input.held?.() ?? true).toBeTrue();
      input.stages?.push("get");
      return objectId === (input.objectId ?? OBJECT_ID) && durablePayload !== null
        ? { objectId, payloadBytes: durablePayload.slice() }
        : null;
    },
    compareAndSwapObjectAccessState: async (
      authorized: AuthorizedObjectAccessWriteV2,
    ) => {
      expect(input.held?.() ?? true).toBeTrue();
      input.stages?.push("cas");
      consumeAuthorizedObjectAccessWriteV2(authorized);
      return input.status ?? "applied";
    },
  };
}

async function failure(operation: Promise<unknown>): Promise<Error> {
  const result = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}

describe("Task Runtime Agent object crypto", () => {
  test("round-trips encrypted bytes and destroys preparation-owned plaintext and DEK copies", async () => {
    const value = await fixture();
    const plaintext = new TextEncoder().encode("protected Task Memory");
    const observed = new ObservedCrypto(seededRng(91_001), {
      now: () => NOW,
    });
    await value.withEvidence((evidence) => {
      const prepared = value.prepare(evidence, observed, plaintext);
      const snapshot = readPreparedTaskRuntimeAgentObjectSnapshot(
        prepared,
        evidence,
      );
      const payload = decodeEncryptedPayloadV2(
        snapshot.object.payloadBytes.ciphertext,
      );
      const envelope = decodeNamespaceObjectEnvelopeV2(
        snapshot.access.envelopeBytes[0]!,
      );
      expect(decryptObjectThroughNamespace(
        observed,
        value.namespaceKey,
        envelope,
        payload,
      )).toEqual(plaintext);
      expect(prepared).toEqual({
        objectId: OBJECT_ID,
        objectType: "task-memory/v1",
      });
    });
    expect(plaintext).toEqual(
      new TextEncoder().encode("protected Task Memory"),
    );
    expect(observed.sealedPlaintexts.length).toBeGreaterThanOrEqual(2);
    expect(observed.sealedPlaintexts.every(allZero)).toBeTrue();
  });

  test("binds the prepared handle to its exact active evidence", async () => {
    const value = await fixture();
    let retained: PreparedTaskRuntimeAgentObject | undefined;
    await value.withEvidence(async (evidence) => {
      const prepared = value.prepare(evidence);
      retained = prepared;
      expect(() => readPreparedTaskRuntimeAgentObjectSnapshot(
        { ...prepared },
        evidence,
      )).toThrow();
      expect(() => readPreparedTaskRuntimeAgentObjectSnapshot(
        prepared,
        value.evidenceInput as unknown as TaskRuntimeExecutionEvidence,
      )).toThrow();
      await value.withEvidence((otherEvidence) => {
        expect(() => readPreparedTaskRuntimeAgentObjectSnapshot(
          prepared,
          otherEvidence,
        )).toThrow();
      });
    });
    await value.withEvidence((currentEvidence) => {
      expect(() => readPreparedTaskRuntimeAgentObjectSnapshot(
        retained!,
        currentEvidence,
      )).toThrow();
    });
  });

  test("publishes payload and CAS in one held callback and replays duplicates", async () => {
    const value = await fixture();
    await value.withEvidence(async (evidence) => {
      const prepared = value.prepare(evidence);
      for (const [status, expected] of [
        ["applied", "created"],
        ["duplicate", "duplicate"],
      ] as const) {
        const stages: string[] = [];
        let held = false;
        const storage = fakeStorage({
          status,
          stages,
          held: () => held,
        });
        const result = await persistTaskRuntimeAgentObject({
          crypto: value.crypto,
          prepared,
          evidence,
          withCurrentAuthorization: async (_context, use) => {
            held = true;
            try {
              return await use(value.currentAuthorization(storage));
            } finally {
              held = false;
              stages.push("unwind");
            }
          },
        });
        expect(result).toBe(expected);
        expect(stages).toEqual(["put", "get", "cas", "unwind"]);
      }
    });
  });

  test("converts stale only after the authority owner unwinds for rollback", async () => {
    const value = await fixture();
    await value.withEvidence(async (evidence) => {
      const prepared = value.prepare(evidence);
      const stages: string[] = [];
      let held = false;
      let rejectedWhileHeld = false;
      let ownerUnwound = false;
      const storage = fakeStorage({
        status: "stale",
        stages,
        held: () => held,
      });
      const result = await persistTaskRuntimeAgentObject({
        crypto: value.crypto,
        prepared,
        evidence,
        withCurrentAuthorization: async (_context, use) => {
          held = true;
          try {
            return await use(value.currentAuthorization(storage));
          } catch (error) {
            rejectedWhileHeld = held;
            stages.push("rollback");
            throw error;
          } finally {
            held = false;
            ownerUnwound = true;
            stages.push("unwind");
          }
        },
      });
      expect(result).toBe("stale");
      expect(rejectedWhileHeld).toBeTrue();
      expect(ownerUnwound).toBeTrue();
      expect(stages).toEqual(["put", "get", "cas", "rollback", "unwind"]);
    });
  });

  test("rejects manufactured and escaped provider success", async () => {
    const value = await fixture();
    await value.withEvidence(async (evidence) => {
      const prepared = value.prepare(evidence);
      const noUseStages: string[] = [];
      await failure(persistTaskRuntimeAgentObject({
        crypto: value.crypto,
        prepared,
        evidence,
        withCurrentAuthorization: async () => "applied",
      }));
      expect(noUseStages).toEqual([]);

      const stages: string[] = [];
      let escaped: Promise<unknown> | undefined;
      const storage = fakeStorage({ stages });
      const manufactured = failure(persistTaskRuntimeAgentObject({
        crypto: value.crypto,
        prepared,
        evidence,
        withCurrentAuthorization: async (_context, use) => {
          escaped = use(value.currentAuthorization(storage)).catch(
            (error: unknown) => error,
          );
          return "applied";
        },
      }));
      const ownerError = await manufactured;
      expect(ownerError.message).toContain("manufactured result");
      expect(await escaped).toBeInstanceOf(Error);
      expect(stages).not.toContain("cas");
    });
  });
});
