import { describe, expect, spyOn, test } from "bun:test";
import type {
  PostgresJsBridgeConnection,
  PostgresJsBridgeRow,
  PostgresJsBridgeScalar,
} from "@nautilo/db";
import {
  LatticeCrypto,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainNamespaceRetainedAuthoritySetDigest,
  humanId,
  namespaceGeneration,
  namespaceId,
  prepareDomainNamespaceBundle,
  type DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";
import {
  DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
  DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
} from "@nautilo/lattice-crypto/wire";
import {
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";
import { deriveTaskContentCryptoObjectIdV1 } from "../../src/task/task-content-repository.ts";
import type { TaskRuntimeCheckpointCellCrypto } from "../../src/checkpoint/task-runtime-checkpoint-cell-crypto.ts";
import {
  createNativeTaskRuntimeCheckpointCellCrypto,
  type NativeTaskRuntimeCheckpointCellCryptoInput,
} from "../../src/server/task/native-task-runtime-checkpoint-cell-crypto.ts";

const NOW = 1_920_000_000_000;
const TASK = "10000000-0000-4000-8000-000000000711";
const RUN = "20000000-0000-4000-8000-000000000711";
const HUMAN = "30000000-0000-4000-8000-000000000711";
const NAMESPACE = "40000000-0000-4000-8000-000000000711";
const DOMAIN = "50000000-0000-4000-8000-000000000711";
const AGENT = "60000000-0000-4000-8000-000000000711";
const DEVICE = "task-native-result-device";
const SERVER = "https://nautilo.example";
const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);
type Adjust = (
  stage: string,
  rows: readonly PostgresJsBridgeRow[],
) => readonly PostgresJsBridgeRow[];

function fixture(adjust: Adjust = (_stage, rows) => rows) {
  const crypto = new LatticeCrypto();
  const issuer = crypto.generateSigningKeyPair();
  const domainKey = bytes(0x41);
  const generationKeys = [bytes(0x42), bytes(0x44)];
  let generation = 0;
  const retained = generationKeys.map((generationKey, index) => ({
    generation: namespaceGeneration(index),
    accessRevision: accessRevision(0),
    headDigest: bytes(0x43 + index),
    generationKey,
  }));
  let retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
    crypto,
    retained.slice(0, 1),
  );
  let domainRequirement = {
    domainId: DOMAIN,
    sourceNamespaceId: NAMESPACE,
    participantDigest: bytes(0x61),
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    authorizationRevision: authorizationRevision(9),
    headDigest: bytes(0x62),
    activeNamespaceBindingSetDigest: bytes(0x63),
    activeNamespaceBindingCount: 1,
  };
  let domain: DomainForegroundSecretEntry = { ...domainRequirement, domainKey };
  let current = {
    serverId: SERVER,
    cryptoDomainId: cryptoDomainId(DOMAIN),
    participantDigest: domain.participantDigest,
    participantCount: 1,
    keyClass: "ai" as const,
    domainKeyGeneration: 4,
    domainAuthorizationRevision: authorizationRevision(9),
    domainHeadDigest: domain.headDigest,
    namespaceId: namespaceId(NAMESPACE),
    namespaceAccessRevision: accessRevision(0),
    namespaceCurrentGeneration: namespaceGeneration(0),
    bundleRevision: 1,
    retainedAuthoritySetDigest: retainedDigest,
  };
  let bundleRevision = 1;
  let previousBindingDigest: Uint8Array | null = null;
  const makeBundle = () =>
    prepareDomainNamespaceBundle(crypto, {
      operationId: `native-task-checkpoint-binding-${bundleRevision}`,
      previousBindingDigest,
      bundle: {
        ...current,
        bundleRevision,
        namespaceCurrentGeneration: namespaceGeneration(generation),
        retainedAuthoritySetDigest: retainedDigest,
        formatVersion: DOMAIN_NAMESPACE_BUNDLE_FORMAT_VERSION_V2,
        purpose: DOMAIN_NAMESPACE_BUNDLE_INNER_PURPOSE_V2,
        retainedGenerationCount: generation + 1,
        retainedGenerations: retained.slice(0, generation + 1),
      },
      issuerHumanId: humanId(HUMAN),
      issuerDeviceId: cryptoDeviceId(DEVICE),
      issuerDeviceSigningGeneration: 1,
      issuerSigningPrivateKey: issuer.privateKey,
      issuerSigningPublicKey: issuer.publicKey,
      domainKey,
      issuedAt: NOW,
    });
  let native = makeBundle();
  const coordinate = {
    kind: "run_result" as const,
    taskId: TASK,
    taskRunId: RUN,
    contentRevision: 1 as const,
  };
  let evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = {
    requestId: "native-result-request",
    workId: RUN,
    claimId: "native-result-claim",
    claimExpiresAt: NOW + 60_000,
    recipientExpiresAt: NOW + 60_000,
    expiresAt: NOW + 60_000,
    recipientGeneration: 1,
    recipientKeyId: "native-result-recipient",
    authorizationDigest: bytes(0x51),
    policyRevision: 3,
    episodeId: "native-result-episode",
    sourceRoomId: "native-result-room",
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 6,
    result: {
      taskId: TASK,
      taskRunId: RUN,
      contentRevision: 1,
      objectId: deriveTaskContentCryptoObjectIdV1(coordinate),
      signerAgentId: AGENT,
      namespace: {
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 3,
      },
    },
    domainRequirements: [domainRequirement],
    namespaceRequirements: [
      {
        ordinal: 0,
        namespaceId: NAMESPACE,
        domainId: DOMAIN,
        operations: ["decrypt", "encrypt"],
        expectedAccessRevision: 0,
        expectedPolicyRevision: 3,
      },
    ],
  };
  const stages: string[] = [];
  const restricted: PostgresJsBridgeConnection = {
    query: async <Row extends PostgresJsBridgeRow>(statement: string) => {
      let stage: string;
      let rows: readonly PostgresJsBridgeRow[];
      if (statement.includes("SELECT current_user::text")) {
        stage = "role";
        rows = [
          { current_user: "nautilo_crypto", session_user: "nautilo_crypto" },
        ];
      } else if (
        statement.includes('from "namespace_domain_key_heads"') &&
        statement.includes("inner join")
      ) {
        stage = "native-binding";
        rows = [
          {
            binding_bytes: native.bytes,
            binding_digest: native.bindingDigest,
            signing_public_key: issuer.publicKey,
          },
        ];
      } else if (statement.includes('from "namespace_domain_key_heads"')) {
        stage = "namespace";
        rows = [
          {
            namespace_id: NAMESPACE,
            namespace_access_revision: current.namespaceAccessRevision,
            namespace_current_generation: generation,
            domain_id: DOMAIN,
            domain_key_generation: 4,
            domain_authorization_revision: domain.authorizationRevision,
            domain_head_digest: domain.headDigest,
            bundle_revision: bundleRevision,
            retained_generation_count: generation + 1,
            retained_authority_set_digest: retainedDigest,
            binding_digest: native.bindingDigest,
          },
        ];
      } else if (statement.includes('from "domain_key_heads"')) {
        stage = "domain";
        rows = [
          {
            domain_id: DOMAIN,
            domain_key_generation: "4",
            authorization_revision: String(domain.authorizationRevision),
            head_digest: domain.headDigest,
            participant_digest: domain.participantDigest,
            participant_count: "1",
          },
        ];
      } else throw new Error(`Unexpected native result query: ${statement}`);
      stages.push(stage);
      return adjust(stage, rows) as readonly Row[];
    },
    transaction: async (use) => use(restricted),
    transactionOnce: async (use) => use(restricted),
  };
  let productChecks = 0;
  const base = {
    restricted,
    crypto,
    serverScope: SERVER,
    domains: [domain],
    signal: new AbortController().signal,
    identity: {
      taskId: TASK,
      taskRunId: RUN,
      sourceRoomId: evidenceInput.sourceRoomId,
      graphThreadId: "task-native-graph",
      namespaceId: NAMESPACE,
      domainId: DOMAIN,
      expectedAccessRevision: 0,
      expectedPolicyRevision: 3,
    },
    now: () => NOW,
    assertCurrentTaskAuthority: () => {
      productChecks += 1;
      return Promise.resolve();
    },
  };
  const run = <Value>(
    execute: (cell: TaskRuntimeCheckpointCellCrypto) => Promise<Value>,
    overrides: Partial<NativeTaskRuntimeCheckpointCellCryptoInput> = {},
    customEvidence = evidenceInput,
  ) =>
    withTaskRuntimeExecutionEvidenceV1({
      evidence: customEvidence,
      signal: base.signal,
      now: () => NOW,
      execute: (evidence) =>
        execute(
          createNativeTaskRuntimeCheckpointCellCrypto({
            ...base,
            domains: [domain],
            identity: {
              ...base.identity,
              expectedAccessRevision: current.namespaceAccessRevision,
            },
            evidence,
            ...overrides,
          }),
        ),
    });
  return {
    crypto,
    base,
    evidenceInput,
    run,
    stages,
    checks: () => productChecks,
    rotate(nextAccessRevision = 0) {
      // Device-authority rotation advances the Namespace key without changing
      // product accessRevision (the concrete native replacement plan allows it).
      retained[1] = {
        ...retained[1]!,
        accessRevision: accessRevision(nextAccessRevision),
      };
      generation = 1;
      bundleRevision = 2;
      previousBindingDigest = native.bindingDigest;
      domainRequirement = {
        ...domainRequirement,
        authorizationRevision: authorizationRevision(10),
        headDigest: bytes(0x64),
      };
      domain = { ...domain, ...domainRequirement };
      current = {
        ...current,
        namespaceAccessRevision: accessRevision(nextAccessRevision),
        domainAuthorizationRevision: domain.authorizationRevision,
        domainHeadDigest: domain.headDigest,
      };
      evidenceInput = {
        ...evidenceInput,
        domainRequirements: [domainRequirement],
        namespaceRequirements: evidenceInput.namespaceRequirements.map(
          (entry) => ({ ...entry, expectedAccessRevision: nextAccessRevision }),
        ),
        result: {
          ...evidenceInput.result,
          namespace: {
            ...evidenceInput.result.namespace,
            expectedAccessRevision: nextAccessRevision,
          },
        },
      };
      retainedDigest = domainNamespaceRetainedAuthoritySetDigest(
        crypto,
        retained,
      );
      native = makeBundle();
    },
  };
}

const coordinate = {
  kind: "channel" as const,
  threadId: "physical-task-graph",
  checkpointNs: "root",
  channel: "messages",
  version: "1",
};
const plaintext = new TextEncoder().encode("private native graph state");
function seal(cell: TaskRuntimeCheckpointCellCrypto) {
  return cell.crypto.executeAuthorizedOperation({
    operation: "write",
    scope: cell.scope,
    execute: async (context) => {
      const encrypted = await cell.crypto.seal({
        scope: cell.scope,
        coordinate,
        plaintext,
        signal: context.signal,
      });
      await context.assertCommitAllowed();
      return encrypted;
    },
  });
}
function open(cell: TaskRuntimeCheckpointCellCrypto, ciphertext: Uint8Array) {
  return cell.crypto.executeAuthorizedOperation({
    operation: "read",
    scope: cell.scope,
    execute: (context) =>
      cell.crypto.open({
        scope: cell.scope,
        coordinate,
        ciphertext,
        signal: context.signal,
      }),
  });
}
async function fails(operation: Promise<unknown>): Promise<void> {
  expect(
    await operation.then(
      () => null,
      (error: unknown) => error,
    ),
  ).toBeInstanceOf(Error);
}
function change(
  stage: string,
  field: string,
  value: PostgresJsBridgeScalar,
): Adjust {
  return (current, rows) =>
    current === stage ? rows.map((row) => ({ ...row, [field]: value })) : rows;
}

describe("native Task checkpoint cell crypto", () => {
  test("roundtrips a live cell and opens a retained generation under the current signed bundle", async () => {
    const value = fixture();
    const encrypted = await value.run(seal);
    const afterWrite = value.checks();
    expect(afterWrite).toBeGreaterThan(0);
    expect(encrypted).not.toEqual(plaintext);
    value.rotate();
    const opened = await value.run((cell) => open(cell, encrypted));
    try {
      expect(opened).toEqual(plaintext);
    } finally {
      opened.fill(0);
    }
    const afterRead = value.checks();
    expect(afterRead).toBeGreaterThan(afterWrite);
    const current = await value.run(seal);
    expect(new DataView(current.buffer).getBigUint64(4)).toBe(1n);
    expect(value.checks()).toBeGreaterThan(afterRead);
  });

  test("does not reinterpret old ciphertext under a changed Namespace access revision", async () => {
    const value = fixture();
    const encrypted = await value.run(seal);
    value.rotate(1);
    await fails(value.run((cell) => open(cell, encrypted)));
    const current = await value.run(seal);
    const opened = await value.run((cell) => open(cell, current));
    try {
      expect(opened).toEqual(plaintext);
    } finally {
      opened.fill(0);
    }
  });

  test("expires during an active operation before its commit check", async () => {
    const value = fixture();
    let now = NOW;
    let committed = false;
    await fails(
      withTaskRuntimeExecutionEvidenceV1({
        evidence: value.evidenceInput,
        signal: value.base.signal,
        now: () => now,
        execute: async (evidence) => {
          const cell = createNativeTaskRuntimeCheckpointCellCrypto({
            ...value.base,
            evidence,
            now: () => now,
          });
          return cell.crypto.executeAuthorizedOperation({
            operation: "write",
            scope: cell.scope,
            execute: async (context) => {
              await cell.crypto.seal({
                scope: cell.scope,
                coordinate,
                plaintext,
                signal: context.signal,
              });
              now = evidence.expiresAt;
              await context.assertCommitAllowed();
              committed = true;
            },
          });
        },
      }),
    );
    expect(committed).toBe(false);
  });

  test("binds ciphertext to TaskRun, source Room and graph thread even with valid alternate evidence", async () => {
    const value = fixture();
    const encrypted = await value.run(seal);
    for (const field of [
      "taskRunId",
      "sourceRoomId",
      "graphThreadId",
    ] as const) {
      const identity = {
        ...value.base.identity,
        [field]: "other-native-coordinate",
      };
      const alternate = {
        ...value.evidenceInput,
        workId: identity.taskRunId,
        sourceRoomId: identity.sourceRoomId,
        result: {
          ...value.evidenceInput.result,
          taskRunId: identity.taskRunId,
        },
      };
      await fails(
        value.run((cell) => open(cell, encrypted), { identity }, alternate),
      );
    }
  });

  test("rejects mismatched Task/source/Namespace/access/policy before opening keys", async () => {
    for (const field of [
      "taskId",
      "taskRunId",
      "sourceRoomId",
      "namespaceId",
      "domainId",
      "expectedAccessRevision",
      "expectedPolicyRevision",
    ] as const) {
      const value = fixture();
      const identity = {
        ...value.base.identity,
        [field]:
          typeof value.base.identity[field] === "number" ? 90 : "substituted",
      };
      await fails(value.run(seal, { identity }));
      expect(value.stages).toEqual([]);
    }
  });

  for (const [stage, field, replacement] of [
    ["namespace", "namespace_access_revision", 1],
    ["namespace", "retained_authority_set_digest", bytes(9)],
    ["namespace", "domain_key_generation", 5],
    ["domain", "authorization_revision", 10],
    ["domain", "domain_key_generation", 5],
    ["domain", "participant_digest", bytes(7)],
    ["native-binding", "binding_digest", bytes(8)],
    ["native-binding", "signing_public_key", bytes(9)],
  ] as const) {
    test(`rejects substituted ${stage}.${field}`, async () => {
      const value = fixture(change(stage, field, replacement));
      await fails(value.run(seal));
    });
  }

  test("rechecks Domain, Namespace and Task authority immediately before checkpoint commit", async () => {
    for (const revoke of ["domain", "namespace", "task"]) {
      let revoked = false;
      const value = fixture((stage, rows) =>
        revoked && stage === revoke
          ? rows.map((row) => ({
              ...row,
              ...(revoke === "domain"
                ? { authorization_revision: 10 }
                : { binding_digest: bytes(9) }),
            }))
          : rows,
      );
      let committed = false;
      await fails(
        value.run(
          (cell) =>
            cell.crypto.executeAuthorizedOperation({
              operation: "write",
              scope: cell.scope,
              execute: async (context) => {
                await cell.crypto.seal({
                  scope: cell.scope,
                  coordinate,
                  plaintext,
                  signal: context.signal,
                });
                revoked = true;
                await context.assertCommitAllowed();
                committed = true;
              },
            }),
          {
            assertCurrentTaskAuthority: async () => {
              if (revoked && revoke === "task") throw new Error("Task revoked");
            },
          },
        ),
      );
      expect(committed).toBe(false);
    }
  });

  test("wipes native and derived keys and revokes escaped operation contexts", async () => {
    const value = fixture();
    const captured: Uint8Array[] = [];
    const original = value.crypto.deriveKey.bind(value.crypto);
    const derive = spyOn(value.crypto, "deriveKey").mockImplementation(
      (...args) => {
        const result = original(...args);
        captured.push(args[0], result);
        return result;
      },
    );
    let ended: (() => void) | undefined;
    try {
      await value.run((cell) =>
        cell.crypto.executeAuthorizedOperation({
          operation: "write",
          scope: cell.scope,
          execute: async (context) => {
            ended = context.assertActive;
            await cell.crypto.seal({
              scope: cell.scope,
              coordinate,
              plaintext,
              signal: context.signal,
            });
          },
        }),
      );
      await fails(
        value.run((cell) =>
          cell.crypto.executeAuthorizedOperation({
            operation: "write",
            scope: cell.scope,
            execute: async () => {
              throw new Error("checkpoint write failed");
            },
          }),
        ),
      );
      expect(captured.length).toBeGreaterThan(0);
      for (const bytes of captured)
        expect(bytes.every((byte) => byte === 0)).toBe(true);
      expect(ended).toBeDefined();
      expect(() => ended!()).toThrow();
    } finally {
      derive.mockRestore();
    }
  });

  test("rejects revoked evidence and wrong native server or Domain key", async () => {
    const value = fixture();
    let escaped: TaskRuntimeCheckpointCellCrypto | undefined;
    await value.run(async (cell) => {
      escaped = cell;
    });
    await fails(seal(escaped!));
    await fails(value.run(seal, { serverScope: "https://other.example" }));
    await fails(
      value.run(seal, {
        domains: [{ ...value.base.domains[0]!, domainKey: bytes(9) }],
      }),
    );
  });
});
