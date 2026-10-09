import { beforeAll, describe, expect, test } from "bun:test";

import {
  assertAuthenticTaskRuntimeExecutionEvidenceV1,
  withTaskRuntimeExecutionEvidenceV1,
  type TaskRuntimeExecutionEvidenceInputV1,
  type TaskRuntimeExecutionEvidenceV1,
} from "../../src/background/task-runtime-execution-evidence-v1.ts";
import {
  NOW,
  taskRuntimeAgentObjectSetFixture,
} from "../helpers/task-runtime-agent-object-set-fixture.ts";

type Mutable<Value> = Value extends Uint8Array ? Uint8Array
  : Value extends readonly (infer Item)[] ? Mutable<Item>[]
  : Value extends object ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
  : Value;
type Input = Mutable<TaskRuntimeExecutionEvidenceInputV1>;
let baseline: TaskRuntimeExecutionEvidenceInputV1;
beforeAll(async () => {
  baseline = (await taskRuntimeAgentObjectSetFixture(92_001)).evidence;
});
function fresh(): Input {
  return structuredClone(baseline) as unknown as Input;
}
function typed(input: Input): TaskRuntimeExecutionEvidenceInputV1 {
  // Negative cases intentionally cross the runtime validation boundary.
  return input as unknown as TaskRuntimeExecutionEvidenceInputV1;
}
async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Protected work unexpectedly accepted invalid evidence");
}
function run(input: Input) {
  let called = false;
  return {
    wasCalled: () => called,
    promise: withTaskRuntimeExecutionEvidenceV1({
      evidence: typed(input),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: evidence => {
        called = true;
        assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
      },
    }),
  };
}

const invalid: [string, (input: Input) => void][] = [
  ["missing Domain", input => { input.domainRequirements = []; }],
  ["missing Namespace", input => { input.namespaceRequirements = []; }],
  ["noncontiguous ordinal", input => { input.namespaceRequirements[0]!.ordinal = 1; }],
  ["mismatched Namespace policy", input => { input.namespaceRequirements[0]!.expectedPolicyRevision++; }],
  ["unknown Namespace Domain", input => { input.namespaceRequirements[0]!.domainId = "unknown-domain"; }],
  ["duplicate Namespace", input => { input.namespaceRequirements[1]!.namespaceId = input.namespaceRequirements[0]!.namespaceId; }],
  ["empty operations", input => { input.namespaceRequirements[0]!.operations = []; }],
  ["reversed operations", input => { input.namespaceRequirements[0]!.operations = ["encrypt", "decrypt"]; }],
  ["duplicate operations", input => { input.namespaceRequirements[0]!.operations = ["encrypt", "encrypt"]; }],
  ["unknown operation", input => { input.namespaceRequirements[0]!.operations = ["read" as "decrypt"]; }],
  ["overlong operations", input => { input.namespaceRequirements[0]!.operations = ["decrypt", "encrypt", "encrypt"]; }],
  ["inexact expiry", input => { input.expiresAt--; }],
  ["claim shorter than evidence", input => { input.claimExpiresAt = input.expiresAt - 1; }],
  ["recipient shorter than evidence", input => { input.recipientExpiresAt = input.expiresAt - 1; }],
  ["another result run", input => { input.result.taskRunId = "other-run"; }],
  ["unsupported result revision", input => { input.result.contentRevision = 2 as 1; }],
  ["empty result operations", input => { input.result.namespace.operations = []; }],
  ["decrypt result operation", input => { input.result.namespace.operations = ["decrypt" as "encrypt"]; }],
  ["extra result operation", input => { input.result.namespace.operations = ["encrypt", "encrypt"]; }],
  ["unknown result Namespace", input => { input.result.namespace.namespaceId = "other-namespace"; }],
  ["different result Domain", input => { input.result.namespace.domainId = "other-domain"; }],
  ["different result access revision", input => { input.result.namespace.expectedAccessRevision++; }],
  ["different result policy", input => { input.result.namespace.expectedPolicyRevision++; }],
  ["result without encrypt authority", input => {
    input.namespaceRequirements.find(entry => entry.namespaceId === input.result.namespace.namespaceId)!.operations = ["decrypt"];
  }],
  ["Human Domain class", input => { input.domainRequirements[0]!.keyClass = "human" as "ai"; }],
  ["short authorization digest", input => { input.authorizationDigest = new Uint8Array(31); }],
  ["long authorization digest", input => { input.authorizationDigest = new Uint8Array(33); }],
];

for (const key of ["participantDigest", "headDigest", "activeNamespaceBindingSetDigest"] as const) {
  for (const length of [0, 31, 33]) {
    invalid.push([
      `${key} length ${length}`,
      input => { input.domainRequirements[0]![key] = new Uint8Array(length); },
    ]);
  }
}

const ids = ["requestId", "workId", "claimId", "recipientKeyId", "episodeId", "sourceRoomId"] as const;
const counters = ["recipientGeneration", "policyRevision", "hostAuthorizationRevision", "recipientAuthorizationRevision"] as const;
for (const key of ids) {
  invalid.push([`empty ${key}`, input => { input[key] = ""; }]);
}
for (const key of counters) {
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    invalid.push([`invalid ${key}: ${value}`, input => { input[key] = value; }]);
  }
}

describe("Task Runtime execution evidence", () => {
  test.each(invalid)("rejects %s before invoking protected work", async (_name, mutate) => {
    const input = fresh();
    mutate(input);
    const result = run(input);
    expect(await rejected(result.promise)).toBeInstanceOf(Error);
    expect(result.wasCalled()).toBe(false);
  });

  test("accepts a decrypt-only non-result Namespace", async () => {
    const input = fresh();
    const other = input.namespaceRequirements.find(entry => entry.namespaceId !== input.result.namespace.namespaceId)!;
    other.operations = ["decrypt"];
    const result = run(input);
    await result.promise;
    expect(result.wasCalled()).toBe(true);
  });

  test("reports missing authority at its own validation boundary", async () => {
    const noDomains = fresh();
    noDomains.domainRequirements = [];
    expect(await rejected(run(noDomains).promise)).toEqual(
      new RangeError("Task Runtime execution requires a Domain authority"),
    );
    const noNamespaces = fresh();
    noNamespaces.namespaceRequirements = [];
    expect(await rejected(run(noNamespaces).promise)).toEqual(
      new TypeError("Task Runtime Namespace requirements are invalid"),
    );
  });

  test("requires a real callback, abort signal and clock before minting", async () => {
    const good = {
      evidence: typed(fresh()), signal: new AbortController().signal,
      now: () => NOW, execute: () => undefined,
    };
    expect(await rejected(withTaskRuntimeExecutionEvidenceV1({
      ...good, execute: undefined as unknown as typeof good.execute,
    }))).toEqual(new TypeError("Task Runtime execution evidence callback is required"));
    for (const invalidLiveness of [
      { ...good, signal: { aborted: false } as AbortSignal },
      { ...good, now: undefined as unknown as typeof good.now },
    ]) {
      expect(await rejected(withTaskRuntimeExecutionEvidenceV1(invalidLiveness)))
        .toEqual(new TypeError("Task Runtime execution liveness is required"));
    }
  });

  test("owns its complete snapshot and revokes escaped evidence", async () => {
    const input = fresh();
    let escaped: TaskRuntimeExecutionEvidenceV1 | undefined;
    const value = await withTaskRuntimeExecutionEvidenceV1({
      evidence: typed(input),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        escaped = evidence;
        const expected = structuredClone(input);
        input.authorizationDigest.fill(0);
        input.domainRequirements[0]!.participantDigest.fill(0);
        input.domainRequirements[0]!.headDigest.fill(0);
        input.domainRequirements[0]!.activeNamespaceBindingSetDigest.fill(0);
        input.namespaceRequirements[0]!.operations.pop();
        input.result.namespace.expectedAccessRevision++;
        await Promise.resolve();
        assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
        expect<unknown>(evidence).toEqual({ ...expected, purpose: "task.runtime.execution", operations: ["decrypt", "encrypt"] });
        expect(Object.isFrozen(evidence.result.namespace)).toBe(true);
        expect(Object.isFrozen(evidence.namespaceRequirements[0]!.operations)).toBe(true);
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1({ ...evidence })).toThrow();
        return "finished";
      },
    });
    expect(value).toBe("finished");
    expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(escaped!)).toThrow();
  });

  test.each(["authorizationDigest", "participantDigest", "headDigest", "activeNamespaceBindingSetDigest"] as const)(
    "permanently revokes evidence after %s mutation", async key => {
      await withTaskRuntimeExecutionEvidenceV1({
        evidence: typed(fresh()), signal: new AbortController().signal, now: () => NOW,
        execute: evidence => {
          const bytes = key === "authorizationDigest" ? evidence.authorizationDigest : evidence.domainRequirements[0]![key];
          const previous = bytes[0]!;
          bytes[0] = previous ^ 1;
          expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence)).toThrow();
          bytes[0] = previous;
          expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence)).toThrow();
        },
      });
    },
  );

  test.each(["claim", "recipient"] as const)("expires at exact %s deadline and cannot be revived", async first => {
    const input = fresh();
    input.claimExpiresAt = NOW + (first === "claim" ? 10 : 20);
    input.recipientExpiresAt = NOW + (first === "recipient" ? 10 : 20);
    input.expiresAt = NOW + 10;
    let now = input.expiresAt - 1;
    await withTaskRuntimeExecutionEvidenceV1({
      evidence: typed(input), signal: new AbortController().signal, now: () => now,
      execute: evidence => {
        assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence);
        now++;
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence)).toThrow();
        now = NOW;
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence)).toThrow();
      },
    });
  });

  test.each([Number.NaN, Number.POSITIVE_INFINITY, NOW + 0.5])("rejects invalid clock %s", async now => {
    let called = false;
    expect(await rejected(withTaskRuntimeExecutionEvidenceV1({
      evidence: typed(fresh()), signal: new AbortController().signal, now: () => now,
      execute: () => { called = true; },
    }))).toBeInstanceOf(Error);
    expect(called).toBe(false);
  });

  test("revokes on abort and on callback rejection", async () => {
    const controller = new AbortController();
    let escaped: TaskRuntimeExecutionEvidenceV1 | undefined;
    const failure = new Error("callback failed");
    expect(await rejected(withTaskRuntimeExecutionEvidenceV1({
      evidence: typed(fresh()), signal: controller.signal, now: () => NOW,
      execute: evidence => {
        escaped = evidence;
        controller.abort();
        expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(evidence)).toThrow();
        throw failure;
      },
    }))).toBe(failure);
    expect(() => assertAuthenticTaskRuntimeExecutionEvidenceV1(escaped!)).toThrow();
  });
});
