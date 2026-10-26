import { describe, expect, test } from "bun:test";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";

import {
  assertAuthenticTaskRuntimeTerminalMessageEvidenceV1,
  withTaskRuntimeTerminalMessageEvidenceV1,
  type TaskRuntimeTerminalMessageEvidenceV1,
} from "../../src/background/task-runtime-terminal-message-evidence-v1.ts";

const NOW = 1_800_500_000_000;
const TASK_ID = "10000000-0000-4000-8000-000000000001";
const RUN_ID = "20000000-0000-4000-8000-000000000001";
const SESSION_ID = "30000000-0000-4000-8000-000000000001";
const ROOM_ID = "40000000-0000-4000-8000-000000000001";
const NAMESPACE_ID = "terminal-message-namespace";
const DOMAIN_ID = "terminal-message-domain";

type EvidenceInput = Parameters<
  typeof withTaskRuntimeTerminalMessageEvidenceV1
>[0]["evidence"];
type Mutable<Value> = Value extends Uint8Array ? Uint8Array
  : Value extends readonly (infer Item)[] ? Mutable<Item>[]
  : Value extends object ? { -readonly [Key in keyof Value]: Mutable<Value[Key]> }
  : Value;
type MutableInput = Mutable<EvidenceInput>;

function bytes(value: number, length = 32): Uint8Array {
  return new Uint8Array(length).fill(value);
}

function messageObjectId(
  sessionId = SESSION_ID,
  messageId = 1,
  revision = 0,
): string {
  const digest = sha256(new TextEncoder().encode(
    `nautilo/conversation-message-crypto-object/v2\n${sessionId.length}\n${sessionId}\n${messageId}\n${revision}`,
  ));
  try {
    return `message:v2:${bytesToHex(digest)}`;
  } finally {
    digest.fill(0);
  }
}

function fresh(): MutableInput {
  return structuredClone({
    purpose: "task.runtime.terminal_message",
    workKind: "task.deliver_message",
    requestId: `task-run-delivery-message-authorization:${RUN_ID}`,
    workId: RUN_ID,
    claimId: "terminal-message-claim",
    claimExpiresAt: NOW + 20_000,
    recipientExpiresAt: NOW + 30_000,
    expiresAt: NOW + 20_000,
    recipientGeneration: 2,
    recipientKeyId: "terminal-message-recipient",
    authorizationDigest: bytes(0x11),
    policyRevision: 7,
    episodeId: "terminal-message-episode",
    sourceRoomId: ROOM_ID,
    hostAuthorizationRevision: 5,
    recipientAuthorizationRevision: 3,
    operations: ["encrypt"],
    message: {
      taskId: TASK_ID,
      taskRunId: RUN_ID,
      bindingId: `task-run-output:${RUN_ID}`,
      messageOperationId: `task-run-delivery-message:${RUN_ID}`,
      sessionId: SESSION_ID,
      messageId: 1,
      revision: 0,
      objectId: messageObjectId(),
      roomId: ROOM_ID,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      mode: "encrypted_only",
      acceptedPolicyRevision: 6,
      publicationPolicyRevision: 7,
      signerAgentId: "terminal-message-agent",
      payloadDigest: bytes(0x22),
    },
    domainRequirements: [{
      domainId: DOMAIN_ID,
      sourceNamespaceId: NAMESPACE_ID,
      participantDigest: bytes(0x31),
      participantCount: 1,
      keyClass: "ai",
      domainKeyGeneration: 4,
      authorizationRevision: 6,
      headDigest: bytes(0x32),
      activeNamespaceBindingSetDigest: bytes(0x33),
      activeNamespaceBindingCount: 1,
    }],
    namespaceRequirements: [{
      ordinal: 0,
      namespaceId: NAMESPACE_ID,
      domainId: DOMAIN_ID,
      operations: ["encrypt"],
      expectedAccessRevision: 2,
      expectedPolicyRevision: 7,
    }],
  }) as MutableInput;
}

function input(value: MutableInput): EvidenceInput {
  // Negative cases intentionally cross the runtime validation boundary.
  return value as unknown as EvidenceInput;
}

async function rejected(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Terminal Message work accepted invalid evidence");
}

function run(value: MutableInput, options: Readonly<{
  signal?: AbortSignal;
  now?: () => number;
}> = {}) {
  let called = false;
  return {
    called: () => called,
    promise: withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: input(value),
      signal: options.signal ?? new AbortController().signal,
      now: options.now ?? (() => NOW),
      execute: evidence => {
        called = true;
        assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
      },
    }),
  };
}

const invalidCases: Array<readonly [string, (value: MutableInput) => void]> = [
  ["Task ID prefix", value => { value.message.taskId = `x${TASK_ID}`; }],
  ["Task ID suffix", value => { value.message.taskId = `${TASK_ID}x`; }],
  ["Task Run ID suffix", value => { value.message.taskRunId = `${RUN_ID}x`; }],
  ["Session ID prefix", value => { value.message.sessionId = `x${SESSION_ID}`; }],
  ["Room ID suffix", value => { value.message.roomId = `${ROOM_ID}x`; }],
  ["work kind", value => { value.workKind = "task.execute" as "task.deliver_message"; }],
  ["work Run", value => { value.workId = TASK_ID; }],
  ["request family", value => { value.requestId = `task-runtime-authorization:${RUN_ID}`; }],
  ["binding Run", value => { value.message.bindingId = `task-run-output:${TASK_ID}`; }],
  ["operation Run", value => { value.message.messageOperationId = `task-run-delivery-message:${TASK_ID}`; }],
  ["object coordinate", value => { value.message.objectId = `message:v2:${"a".repeat(64)}`; }],
  ["publication mode", value => {
    value.message.mode = "plaintext_only" as "encrypted_only";
  }],
  ["zero accepted policy", value => { value.message.acceptedPolicyRevision = 0; }],
  ["backward publication policy", value => {
    value.message.publicationPolicyRevision = 5;
    value.policyRevision = 5;
    value.namespaceRequirements[0]!.expectedPolicyRevision = 5;
  }],
  ["detached publication policy", value => {
    value.message.publicationPolicyRevision = 8;
    value.namespaceRequirements[0]!.expectedPolicyRevision = 8;
  }],
  ["source Room", value => { value.sourceRoomId = TASK_ID; }],
  ["expiry coordinate", value => { value.expiresAt -= 1; }],
  ["empty grant operations", value => { value.operations = []; }],
  ["decrypt grant operation", value => { value.operations = ["decrypt" as "encrypt"]; }],
  ["duplicate grant operation", value => { value.operations = ["encrypt", "encrypt"]; }],
  ["missing Namespace", value => { value.namespaceRequirements = []; }],
  ["extra Namespace", value => { value.namespaceRequirements.push(structuredClone(value.namespaceRequirements[0]!)); }],
  ["Namespace ordinal", value => {
    value.namespaceRequirements[0]!.ordinal = 1 as 0;
  }],
  ["Namespace identity", value => { value.namespaceRequirements[0]!.namespaceId = "other-namespace"; }],
  ["Namespace Domain", value => { value.namespaceRequirements[0]!.domainId = "other-domain"; }],
  ["empty Namespace operations", value => { value.namespaceRequirements[0]!.operations = []; }],
  ["decrypt Namespace operation", value => { value.namespaceRequirements[0]!.operations = ["decrypt" as "encrypt"]; }],
  ["duplicate Namespace operation", value => { value.namespaceRequirements[0]!.operations = ["encrypt", "encrypt"]; }],
  ["Namespace policy", value => { value.namespaceRequirements[0]!.expectedPolicyRevision = 8; }],
  ["missing Domain", value => { value.domainRequirements = []; }],
  ["extra Domain", value => { value.domainRequirements.push(structuredClone(value.domainRequirements[0]!)); }],
  ["Human Domain", value => { value.domainRequirements[0]!.keyClass = "human" as "ai"; }],
  ["Domain identity", value => { value.domainRequirements[0]!.domainId = "other-domain"; }],
  ["Domain source Namespace", value => { value.domainRequirements[0]!.sourceNamespaceId = "other-namespace"; }],
  ["zero Message ID", value => { value.message.messageId = 0; }],
  ["fractional Message ID", value => { value.message.messageId = 1.5; }],
  ["negative Message revision", value => { value.message.revision = -1; }],
  ["fractional Message revision", value => { value.message.revision = 0.5; }],
];

for (const key of [
  "requestId", "workId", "claimId", "recipientKeyId", "episodeId", "sourceRoomId",
] as const) {
  invalidCases.push([`empty ${key}`, value => { value[key] = ""; }]);
}

for (const key of [
  "claimExpiresAt", "recipientExpiresAt", "expiresAt", "recipientGeneration",
  "policyRevision", "hostAuthorizationRevision", "recipientAuthorizationRevision",
] as const) {
  for (const counter of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    invalidCases.push([`${key} counter ${counter}`, value => { value[key] = counter; }]);
  }
}

for (const key of [
  "messageId", "revision", "acceptedPolicyRevision", "publicationPolicyRevision",
] as const) {
  for (const counter of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    invalidCases.push([`Message ${key} counter ${counter}`, value => {
      value.message[key] = counter;
    }]);
  }
}

for (const key of ["expectedAccessRevision", "expectedPolicyRevision"] as const) {
  for (const counter of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    invalidCases.push([`Namespace ${key} counter ${counter}`, value => {
      value.namespaceRequirements[0]![key] = counter;
    }]);
  }
}

for (const key of [
  "participantCount", "domainKeyGeneration", "authorizationRevision",
  "activeNamespaceBindingCount",
] as const) {
  for (const counter of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN]) {
    invalidCases.push([`Domain ${key} counter ${counter}`, value => {
      value.domainRequirements[0]![key] = counter;
    }]);
  }
}

for (const length of [0, 31, 33]) {
  invalidCases.push(
    [`authorization digest length ${length}`, value => {
      value.authorizationDigest = bytes(0x11, length);
    }],
    [`payload digest length ${length}`, value => {
      value.message.payloadDigest = bytes(0x22, length);
    }],
  );
  for (const key of [
    "participantDigest", "headDigest", "activeNamespaceBindingSetDigest",
  ] as const) {
    invalidCases.push([`Domain ${key} length ${length}`, value => {
      value.domainRequirements[0]![key] = bytes(0x33, length);
    }]);
  }
}

describe("Task Runtime terminal Message evidence", () => {
  test.each(invalidCases)("rejects invalid %s before protected work", async (
    _name,
    mutate,
  ) => {
    const value = fresh();
    mutate(value);
    const result = run(value);
    expect(await rejected(result.promise)).toBeInstanceOf(Error);
    expect(result.called()).toBe(false);
  });

  test("accepts exact lower policy and Message revision boundaries", async () => {
    const value = fresh();
    value.policyRevision = 1;
    value.message.acceptedPolicyRevision = 1;
    value.message.publicationPolicyRevision = 1;
    value.namespaceRequirements[0]!.expectedPolicyRevision = 1;
    const result = run(value);
    await result.promise;
    expect(result.called()).toBe(true);
  });

  test("accepts the exact Shadow publication mode", async () => {
    const value = fresh();
    value.message.mode = "shadow_encryption";
    const result = run(value);
    await result.promise;
    expect(result.called()).toBe(true);
  });

  test("owns an immutable exact snapshot and revokes escaped evidence", async () => {
    const source = fresh();
    const expected = structuredClone(source);
    let escaped: TaskRuntimeTerminalMessageEvidenceV1 | undefined;
    const result = await withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: input(source),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: async evidence => {
        escaped = evidence;
        source.authorizationDigest.fill(0);
        source.message.payloadDigest.fill(0);
        source.domainRequirements[0]!.participantDigest.fill(0);
        source.domainRequirements[0]!.headDigest.fill(0);
        source.domainRequirements[0]!.activeNamespaceBindingSetDigest.fill(0);
        source.operations.pop();
        source.namespaceRequirements[0]!.operations.pop();
        await Promise.resolve();
        assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
        expect<unknown>(evidence).toEqual(expected);
        expect(Object.isFrozen(evidence)).toBe(true);
        expect(Object.isFrozen(evidence.message)).toBe(true);
        expect(Object.isFrozen(evidence.domainRequirements[0])).toBe(true);
        expect(Object.isFrozen(evidence.namespaceRequirements[0])).toBe(true);
        expect(Object.isFrozen(evidence.operations)).toBe(true);
        expect(Object.isFrozen(evidence.namespaceRequirements[0].operations))
          .toBe(true);
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
          { ...evidence },
        )).toThrow();
        return "published";
      },
    });
    expect(result).toBe("published");
    expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(escaped!))
      .toThrow();
  });

  test.each([
    "authorizationDigest", "payloadDigest", "participantDigest", "headDigest",
    "activeNamespaceBindingSetDigest",
  ] as const)("permanently revokes after %s mutation", async key => {
    await withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: input(fresh()),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: evidence => {
        const target = key === "authorizationDigest"
          ? evidence.authorizationDigest
          : key === "payloadDigest"
            ? evidence.message.payloadDigest
            : evidence.domainRequirements[0][key];
        const original = target[0]!;
        target[0] = original ^ 1;
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
          evidence,
        )).toThrow();
        target[0] = original;
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
          evidence,
        )).toThrow();
      },
    });
  });

  test.each(["claim", "recipient"] as const)(
    "expires exactly at the %s deadline and cannot be revived",
    async first => {
      const value = fresh();
      value.claimExpiresAt = NOW + (first === "claim" ? 10 : 20);
      value.recipientExpiresAt = NOW + (first === "recipient" ? 10 : 20);
      value.expiresAt = NOW + 10;
      let current = value.expiresAt - 1;
      await withTaskRuntimeTerminalMessageEvidenceV1({
        evidence: input(value), signal: new AbortController().signal,
        now: () => current,
        execute: evidence => {
          assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
          current += 1;
          expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
            evidence,
          )).toThrow();
          current = NOW;
          expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
            evidence,
          )).toThrow();
        },
      });
    },
  );

  test.each([Number.NaN, Number.POSITIVE_INFINITY, NOW + 0.5])(
    "rejects invalid clock %s without invoking protected work",
    async current => {
      const result = run(fresh(), { now: () => current });
      expect(await rejected(result.promise)).toBeInstanceOf(Error);
      expect(result.called()).toBe(false);
    },
  );

  test("revokes on abort and callback rejection", async () => {
    const controller = new AbortController();
    const failure = new Error("publication failed");
    let escaped: TaskRuntimeTerminalMessageEvidenceV1 | undefined;
    expect(await rejected(withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: input(fresh()), signal: controller.signal, now: () => NOW,
      execute: evidence => {
        escaped = evidence;
        controller.abort();
        expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(
          evidence,
        )).toThrow();
        throw failure;
      },
    }))).toBe(failure);
    expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(escaped!))
      .toThrow();
  });

  test("revokes escaped evidence after callback rejection alone", async () => {
    const failure = new Error("publication failed without abort");
    let escaped: TaskRuntimeTerminalMessageEvidenceV1 | undefined;
    expect(await rejected(withTaskRuntimeTerminalMessageEvidenceV1({
      evidence: input(fresh()),
      signal: new AbortController().signal,
      now: () => NOW,
      execute: evidence => {
        escaped = evidence;
        assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(evidence);
        throw failure;
      },
    }))).toBe(failure);
    expect(() => assertAuthenticTaskRuntimeTerminalMessageEvidenceV1(escaped!))
      .toThrow();
  });

  test("an already-aborted signal never invokes protected work", async () => {
    const controller = new AbortController();
    controller.abort();
    const result = run(fresh(), { signal: controller.signal });
    expect(await rejected(result.promise)).toBeInstanceOf(Error);
    expect(result.called()).toBe(false);
  });
});
