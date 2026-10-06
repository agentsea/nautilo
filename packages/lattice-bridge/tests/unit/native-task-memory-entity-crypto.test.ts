import { describe, expect, test } from "bun:test";
import type { PostgresJsBridgeConnection } from "@nautilo/db";
import {
  authorizationRevision,
  LatticeCrypto,
  type DomainForegroundSecretEntry,
  type TaskRuntimeExecutionEvidence,
} from "@nautilo/lattice-crypto";
import {
  type TaskRuntimeExecutionEvidenceInputV1,
  withTaskRuntimeExecutionEvidenceV1,
} from "../../../lattice-crypto/src/background/task-runtime-execution-evidence-v1.ts";

import type {
  AgentEntityCryptoInvocation,
  AgentEntityNamespaceAuthority,
} from "../../src/object/agent-entity-crypto.ts";
import type {
  DomainForegroundNamespaceAuthorityInspectionV2,
} from "../../src/server/delivery/postgres-domain-key-authority.ts";
import {
  withNativeTaskMemoryEntityCrypto,
} from "../../src/server/task/native-task-memory-entity-crypto.ts";

const NOW = 1_920_000_000_000;
const DOMAIN_ID = "task-memory-domain";
const NAMESPACE_A = "task-memory-namespace-a";
const NAMESPACE_B = "task-memory-namespace-b";

const bytes = (value: number): Uint8Array => new Uint8Array(32).fill(value);

const domain: DomainForegroundSecretEntry = Object.freeze({
  domainId: DOMAIN_ID,
  sourceNamespaceId: NAMESPACE_A,
  participantDigest: bytes(1),
  participantCount: 1,
  keyClass: "ai" as const,
  domainKeyGeneration: 4,
  authorizationRevision: authorizationRevision(9),
  headDigest: bytes(2),
  domainKey: bytes(4),
});

const evidenceInput: TaskRuntimeExecutionEvidenceInputV1 = Object.freeze({
  requestId: "task-memory-request",
  workId: "task-memory-run",
  claimId: "task-memory-claim",
  claimExpiresAt: NOW + 60_000,
  recipientExpiresAt: NOW + 60_000,
  expiresAt: NOW + 60_000,
  recipientGeneration: 1,
  recipientKeyId: "task-memory-recipient",
  authorizationDigest: bytes(5),
  policyRevision: 3,
  episodeId: "task-memory-episode",
  sourceRoomId: "task-memory-room",
  hostAuthorizationRevision: 5,
  recipientAuthorizationRevision: 6,
  result: Object.freeze({
    taskId: "task-memory-task",
    taskRunId: "task-memory-run",
    contentRevision: 1 as const,
    objectId: "task-memory-result",
    signerAgentId: "task-memory-agent",
    namespace: Object.freeze({
      namespaceId: NAMESPACE_A,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["encrypt"] as const),
      expectedAccessRevision: 7,
      expectedPolicyRevision: 3,
    }),
  }),
  domainRequirements: Object.freeze([Object.freeze({
    ...domain,
    activeNamespaceBindingSetDigest: bytes(3),
    activeNamespaceBindingCount: 2,
  })]),
  namespaceRequirements: Object.freeze([
    Object.freeze({
      ordinal: 0,
      namespaceId: NAMESPACE_A,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: 7,
      expectedPolicyRevision: 3,
    }),
    Object.freeze({
      ordinal: 1,
      namespaceId: NAMESPACE_B,
      domainId: DOMAIN_ID,
      operations: Object.freeze(["decrypt", "encrypt"] as const),
      expectedAccessRevision: 11,
      expectedPolicyRevision: 3,
    }),
  ]),
});

type NamespaceKeys = NonNullable<
  Parameters<typeof withNativeTaskMemoryEntityCrypto>[1]
>;

type RunOverrides = Readonly<{
  domains?: readonly DomainForegroundSecretEntry[];
  evidence?: TaskRuntimeExecutionEvidenceInputV1;
  assertCurrentTaskAuthority?: () => Promise<void>;
  signal?: AbortSignal;
}>;

function fixture() {
  const controller = new AbortController();
  let now = NOW;
  let domainGeneration = 4;
  let domainAuthorizationRevision = 9;
  let domainHeadDigest = bytes(2);
  let participantDigest = bytes(1);
  let participantCount = 1;
  let taskCurrent = true;
  let opened = 0;
  let taskChecks = 0;
  const keyCopies: Uint8Array[] = [];
  const authorityCopies: DomainForegroundNamespaceAuthorityInspectionV2[] = [];
  const namespaceState = new Map([
    [NAMESPACE_A, {
      available: true,
      accessRevision: 7,
      generation: 2,
      bundleRevision: 1,
      digestSeed: 6,
      domainId: DOMAIN_ID,
    }],
    [NAMESPACE_B, {
      available: true,
      accessRevision: 11,
      generation: 5,
      bundleRevision: 4,
      digestSeed: 16,
      domainId: DOMAIN_ID,
    }],
  ]);

  const restricted: PostgresJsBridgeConnection = {
    query: async (statement) => {
      if (statement.includes("current_user")) {
        return [{
          current_user: "nautilo_crypto",
          session_user: "nautilo_crypto",
        }] as never;
      }
      return [{
        domain_id: DOMAIN_ID,
        domain_key_generation: String(domainGeneration),
        authorization_revision: String(domainAuthorizationRevision),
        head_digest: domainHeadDigest,
        participant_digest: participantDigest,
        participant_count: String(participantCount),
      }] as never;
    },
    transaction: (use) => use(restricted),
    transactionOnce: (use) => use(restricted),
  };

  const namespaceKeys: NamespaceKeys = {
    inspectForegroundNamespaceAuthority: async ({ namespaceId }) => {
      const state = namespaceState.get(namespaceId);
      if (state === undefined || !state.available) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "namespace_bundle_unavailable",
        });
      }
      const authority: DomainForegroundNamespaceAuthorityInspectionV2 =
        Object.freeze({
          status: "ready" as const,
          namespaceId,
          namespaceAccessRevision: state.accessRevision,
          namespaceKeyGeneration: state.generation,
          namespaceHeadDigest: bytes(state.digestSeed),
          namespacePublicationDigest: bytes(state.digestSeed + 1),
          namespacePublicationSetDigest: bytes(state.digestSeed + 2),
          namespaceAudienceFingerprint: bytes(state.digestSeed + 3),
          domainId: state.domainId,
          domainKeyGeneration: domainGeneration,
          domainAuthorizationRevision,
          domainHeadDigest: domainHeadDigest.slice(),
          bundleRevision: state.bundleRevision,
          bundleDigest: bytes(state.digestSeed + 4),
        });
      authorityCopies.push(authority);
      return authority;
    },
    withOpenedForegroundNamespaceKey: async (input) => {
      opened += 1;
      const key = bytes(80 + opened);
      keyCopies.push(key);
      try {
        return await input.use(key);
      } finally {
        key.fill(0);
      }
    },
  };

  const run = <Value>(
    execute: (entities: AgentEntityCryptoInvocation) => Promise<Value>,
    overrides: RunOverrides = {},
  ): Promise<Value> => withTaskRuntimeExecutionEvidenceV1({
    evidence: overrides.evidence ?? evidenceInput,
    signal: overrides.signal ?? controller.signal,
    now: () => now,
    execute: (evidence) => withNativeTaskMemoryEntityCrypto({
      restricted,
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.example",
      evidence,
      domains: overrides.domains ?? [domain],
      signal: overrides.signal ?? controller.signal,
      assertCurrentTaskAuthority:
        overrides.assertCurrentTaskAuthority ?? (async () => {
          taskChecks += 1;
          if (!taskCurrent) throw new TypeError("Task authority changed");
        }),
      execute,
    }, namespaceKeys),
  });

  return {
    controller,
    restricted,
    namespaceKeys,
    run,
    keyCopies,
    authorityCopies,
    get opened() { return opened; },
    get taskChecks() { return taskChecks; },
    expire() { now = evidenceInput.expiresAt; },
    revokeTask() { taskCurrent = false; },
    changeDomain() { domainGeneration = 5; },
    changeDomainAuthorization() { domainAuthorizationRevision = 10; },
    changeDomainDigest() { domainHeadDigest = bytes(42); },
    changeParticipants() {
      participantDigest = bytes(43);
      participantCount = 2;
    },
    changeNamespace(
      namespaceId: string,
      change: Partial<{
        available: boolean;
        accessRevision: number;
        generation: number;
        bundleRevision: number;
        digestSeed: number;
        domainId: string;
      }>,
    ) {
      const current = namespaceState.get(namespaceId);
      if (current === undefined) throw new TypeError("Unknown Namespace");
      namespaceState.set(namespaceId, { ...current, ...change });
    },
  };
}

const currentA = Object.freeze({
  namespaceId: NAMESPACE_A,
  keyGeneration: 2,
  accessRevision: 7,
});

async function failure(operation: Promise<unknown>): Promise<Error> {
  const result = await operation.then(
    () => null,
    (error: unknown) => error,
  );
  expect(result).toBeInstanceOf(Error);
  return result as Error;
}

describe("native Task Memory entity crypto", () => {
  test("requires genuine active execution evidence before database or key use", async () => {
    const forged = fixture();
    await failure(withNativeTaskMemoryEntityCrypto({
      restricted: forged.restricted,
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.example",
      evidence: evidenceInput as unknown as TaskRuntimeExecutionEvidence,
      domains: [domain],
      signal: forged.controller.signal,
      assertCurrentTaskAuthority: async () => {
        throw new Error("must not check");
      },
      execute: async () => "wrong",
    }, forged.namespaceKeys));
    expect(forged.opened).toBe(0);
    expect(forged.taskChecks).toBe(0);

    const inactive = fixture();
    let retained: TaskRuntimeExecutionEvidence | undefined;
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: inactive.controller.signal,
      now: () => NOW,
      execute: (evidence) => {
        retained = evidence;
      },
    });
    await failure(withNativeTaskMemoryEntityCrypto({
      restricted: inactive.restricted,
      crypto: new LatticeCrypto(),
      serverScope: "https://nautilo.example",
      evidence: retained!,
      domains: [domain],
      signal: inactive.controller.signal,
      assertCurrentTaskAuthority: async () => undefined,
      execute: async () => "wrong",
    }, inactive.namespaceKeys));
    expect(inactive.opened).toBe(0);

    const expired = fixture();
    let expiredNow = NOW;
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: evidenceInput,
      signal: expired.controller.signal,
      now: () => expiredNow,
      execute: async (evidence) => {
        expiredNow = evidenceInput.expiresAt;
        await failure(withNativeTaskMemoryEntityCrypto({
          restricted: expired.restricted,
          crypto: new LatticeCrypto(),
          serverScope: "https://nautilo.example",
          evidence,
          domains: [domain],
          signal: expired.controller.signal,
          assertCurrentTaskAuthority: async () => undefined,
          execute: async () => "wrong",
        }, expired.namespaceKeys));
      },
    });
    expect(expired.opened).toBe(0);
  });

  test("requires the exact complete borrowed Domain secret set", async () => {
    const extra: DomainForegroundSecretEntry = Object.freeze({
      ...domain,
      domainId: "extra-domain",
    });
    const substituted: DomainForegroundSecretEntry = Object.freeze({
      ...domain,
      domainKeyGeneration: 5,
    });
    for (const domains of [[], [domain, extra], [substituted]]) {
      const value = fixture();
      await failure(value.run(async () => "wrong", { domains }));
      expect(value.opened).toBe(0);
      expect(value.taskChecks).toBe(0);
    }
  });

  test("rejects missing, stale, and substituted Namespace authority", async () => {
    for (const change of [
      { available: false },
      { accessRevision: 8 },
      { domainId: "substituted-domain" },
    ]) {
      const value = fixture();
      value.changeNamespace(NAMESPACE_A, change);
      let called = false;
      const result = await value.run((entities) => entities.use({
        operations: ["decrypt"],
        entity: currentA,
        execute: () => {
          called = true;
          return "wrong";
        },
      }));
      expect(result).toEqual({
        status: "unavailable",
        reason: "content_unavailable",
      });
      expect(called).toBeFalse();
      expect(value.opened).toBe(0);
    }
  });

  test("never calls a set callback until its complete canonical audience is open", async () => {
    const value = fixture();
    value.changeNamespace(NAMESPACE_B, { available: false });
    let called = false;
    const incomplete = await value.run((entities) => entities.useCurrentSet({
      operations: ["encrypt"],
      namespaceIds: [NAMESPACE_A, NAMESPACE_B],
      execute: () => {
        called = true;
        return "wrong";
      },
    }));
    expect(incomplete).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });
    expect(called).toBeFalse();
    expect(value.opened).toBe(0);

    const duplicate = await fixture().run((entities) =>
      entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: [NAMESPACE_A, NAMESPACE_A],
        execute: () => "wrong",
      }));
    expect(duplicate.status).toBe("unavailable");
  });

  test("reproves Task, full Namespace bundle, and Domain after an await", async () => {
    const drifts: readonly Readonly<{
      outerFailure?: boolean;
      apply(value: ReturnType<typeof fixture>): void;
    }>[] = [
      { outerFailure: true, apply: (value) => value.revokeTask() },
      { apply: (value) =>
        value.changeNamespace(NAMESPACE_A, { digestSeed: 33 }) },
      { apply: (value) =>
        value.changeNamespace(NAMESPACE_A, { bundleRevision: 2 }) },
      { apply: (value) => value.changeDomain() },
      { apply: (value) => value.changeDomainAuthorization() },
      { apply: (value) => value.changeDomainDigest() },
      { apply: (value) => value.changeParticipants() },
    ];
    for (const drift of drifts) {
      const value = fixture();
      const operation = value.run((entities) => entities.use({
        operations: ["decrypt"],
        entity: currentA,
        execute: async () => {
          await Promise.resolve();
          drift.apply(value);
          return "must not commit";
        },
      }));
      if (drift.outerFailure) {
        await failure(operation);
        continue;
      }
      const result = await operation;
      expect(result).toEqual({
        status: "unavailable",
        reason: "authorization_unavailable",
      });
    }
  });

  test("closes, aborts, and drains an escaped key callback before failing outer success", async () => {
    const value = fixture();
    let release: (() => void) | undefined;
    let entered: (() => void) | undefined;
    const enteredPromise = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const releasePromise = new Promise<void>((resolve) => {
      release = resolve;
    });
    let retained: AgentEntityCryptoInvocation | undefined;
    let escaped: Promise<unknown> | undefined;
    const overall = value.run(async (entities) => {
      retained = entities;
      escaped = entities.use({
        operations: ["decrypt"],
        entity: currentA,
        execute: async () => {
          entered?.();
          await releasePromise;
          return "escaped";
        },
      });
      await enteredPromise;
      return "outer-success";
    });
    await enteredPromise;
    expect(retained?.signal.aborted).toBeFalse();
    release?.();
    const outerFailure = await failure(overall);
    expect(outerFailure.message).toBe(
      "Native Task Memory invocation ended with unfinished key use",
    );
    expect(retained?.signal.aborted).toBeTrue();
    expect(await escaped).toEqual({
      status: "unavailable",
      reason: "authorization_unavailable",
    });
    await failure(retained!.use({
      operations: ["decrypt"],
      entity: currentA,
      execute: () => "wrong",
    }));
    expect(value.keyCopies.every((key) =>
      key.every((byte) => byte === 0)
    )).toBeTrue();
  });

  test("preserves the original execute error while draining cancellation", async () => {
    const value = fixture();
    let release: (() => void) | undefined;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = new Error("outer failed");
    const overall = value.run(async (entities) => {
      void entities.use({
        operations: ["decrypt"],
        entity: currentA,
        execute: async () => {
          await wait;
          return "ignored";
        },
      });
      throw original;
    });
    release?.();
    expect(await failure(overall)).toBe(original);

    const cancelled = fixture();
    await failure(cancelled.run(async (entities) => {
      cancelled.controller.abort(new Error("cancelled"));
      return entities.use({
        operations: ["decrypt"],
        entity: currentA,
        execute: () => "wrong",
      });
    }));
    expect(cancelled.opened).toBe(0);
  });

  test("permits retained decrypt and restricts encrypt to the current head", async () => {
    const value = fixture();
    let exposedAuthority: AgentEntityNamespaceAuthority | undefined;
    const results = await value.run(async (entities) => {
      const retained = Object.freeze({
        namespaceId: NAMESPACE_A,
        keyGeneration: 1,
        accessRevision: 6,
      });
      const read = await entities.use({
        operations: ["decrypt"],
        entity: retained,
        execute: ({ namespaceKey, authority }) => {
          exposedAuthority = authority;
          return namespaceKey[0];
        },
      });
      const staleWrite = await entities.use({
        operations: ["encrypt"],
        entity: retained,
        execute: () => "wrong",
      });
      const write = await entities.useCurrentSet({
        operations: ["encrypt"],
        namespaceIds: [NAMESPACE_A, NAMESPACE_B],
        execute: (opened) => opened.map((entry) =>
          entry.authority.namespaceKeyGeneration
        ),
      });
      return { read, staleWrite, write };
    });
    expect(results.read).toEqual({ status: "executed", value: 81 });
    expect(results.staleWrite).toEqual({
      status: "unavailable",
      reason: "content_unavailable",
    });
    expect(results.write).toEqual({ status: "executed", value: [2, 5] });
    expect(value.opened).toBe(3);
    expect(value.taskChecks).toBeGreaterThan(6);
    expect(value.keyCopies.every((key) =>
      key.every((byte) => byte === 0)
    )).toBeTrue();
    expect(value.authorityCopies.every((authority) =>
      authority.bundleDigest.every((byte) => byte === 0)
    )).toBeTrue();
    expect(exposedAuthority?.namespaceHeadDigest.every((byte) => byte === 0))
      .toBeTrue();
    expect(domain.domainKey[0]).toBe(4);
    expect(domain.headDigest[0]).toBe(2);
  });
});
