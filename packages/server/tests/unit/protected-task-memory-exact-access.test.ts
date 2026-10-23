import { describe, expect, test } from "bun:test";
import {
  PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
} from "@nautilo/agent";
import {
  fingerprintRequiredMemoryNamespaces,
  type ForegroundAgentMemoryNativeExactAccessPlan,
  type ProtectedAgentMemoryAccessApprovalReference,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import {
  protectedTaskSemanticAuthorityRequirementsDigest,
} from "@nautilo/db";

import {
  createProtectedTaskMemoryExactAccess,
  type ProtectedTaskMemoryAccessSource,
} from "../../src/routes/protected-task-memory-exact-access";
import type {
  ProtectedTaskMemoryAuthorityInput,
} from "../../src/routes/current-protected-task-memory-authority";

const USER = "11111111-1111-4111-8111-111111111111";
const HUMAN = "22222222-2222-4222-8222-222222222222";
const TARGET_USER = "33333333-3333-4333-8333-333333333333";
const TARGET_ACTOR = "44444444-4444-4444-8444-444444444444";
const AGENT = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const RUN = "77777777-7777-4777-8777-777777777777";
const SOURCE = "88888888-8888-4888-8888-888888888888";
const DESTINATION = "99999999-9999-4999-8999-999999999999";
const ROOM = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const MEMORY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const OBJECT = `memory:v1:${"cc".repeat(32)}`;

const authority = Object.freeze({
  mode: "namespace" as const,
  subjectUserId: USER,
  agentId: AGENT,
  readableNamespaceIds: Object.freeze([SOURCE]),
  mutableNamespaceIds: Object.freeze([SOURCE]),
  writableNamespaceId: SOURCE,
}) satisfies ProtectedMemoryAuthority;

const source = Object.freeze({
  memoryId: MEMORY,
  contentRevision: 2,
  cryptoAccessRevision: 3,
  cryptoObjectId: OBJECT,
  requiredNamespaceIds: Object.freeze([SOURCE]),
  payloadDigest: "ab".repeat(32),
  type: "fact",
  content: "private source",
}) satisfies ProtectedTaskMemoryAccessSource;

function current(includeDestination: boolean): ProtectedTaskMemoryAuthorityInput {
  const requirements = [
    Object.freeze({ ordinal: 0, namespaceId: SOURCE, domainId: "domain-a",
      expectedAccessRevision: 1, expectedPolicyRevision: 7,
      operations: Object.freeze(["decrypt" as const, "encrypt" as const]) }),
    ...(includeDestination ? [Object.freeze({ ordinal: 1,
      namespaceId: DESTINATION, domainId: "domain-b",
      expectedAccessRevision: 1, expectedPolicyRevision: 7,
      operations: Object.freeze(["encrypt" as const]) })] : []),
  ];
  return {
    subject: Object.freeze({ userId: USER, humanActorId: HUMAN,
      deviceId: "device" }),
    occurrence: Object.freeze({
      task: Object.freeze({ id: TASK, requestorId: USER, agentId: AGENT,
        contentNamespaceId: SOURCE, contentRepresentation: "protected" }),
      run: Object.freeze({ id: RUN, graphThreadId: "thread-1" }),
    }),
    evidence: Object.freeze({ policyRevision: 7,
      namespaceRequirements: Object.freeze(requirements),
      result: Object.freeze({ signerAgentId: AGENT }) }),
    signal: new AbortController().signal,
  } as unknown as ProtectedTaskMemoryAuthorityInput;
}

function productPlan(): ForegroundAgentMemoryNativeExactAccessPlan {
  return Object.freeze({
    operationId: "grant-user",
    memoryId: MEMORY,
    cryptoObjectId: OBJECT,
    expectedContentRevision: 2,
    expectedCryptoAccessRevision: 3,
    nextCryptoAccessRevision: 4,
    anchorNamespaceId: SOURCE,
    currentNamespaceIds: Object.freeze([SOURCE]),
    targetNamespaceIds: Object.freeze([SOURCE, DESTINATION].sort()),
    addedNamespaceIds: Object.freeze([DESTINATION]),
    removedNamespaceIds: Object.freeze([]),
    currentRequiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces([SOURCE]),
    targetRequiredNamespaceFingerprint:
      fingerprintRequiredMemoryNamespaces([SOURCE, DESTINATION].sort()),
    productMutation: Object.freeze({ kind: "grant_namespace" as const,
      namespaceId: DESTINATION }),
  });
}

type Recovery = "none" | "pending" | "complete";

function fixture(input: Readonly<{
  includeDestination: boolean;
  sealed?: Map<string, unknown>;
  recovery?: Recovery;
  sourceAvailable?: boolean;
}>) {
  const sealed = input.sealed ?? new Map<string, unknown>();
  const observations = { reserves: 0, finds: 0, inspects: 0, commits: 0,
    opens: 0 };
  const port = createProtectedTaskMemoryExactAccess({
    authority,
    current: current(input.includeDestination),
    now: () => 100,
    createReferenceId: () => "reference-1",
    capsule: Object.freeze({
      seal: async (reference, value) => {
        sealed.set(reference.referenceId, structuredClone(value));
        return "sealed-ciphertext";
      },
      open: async reference => structuredClone(sealed.get(reference.referenceId)),
    }),
    openSource: async () => {
      observations.opens += 1;
      return input.sourceAvailable === false ? null : source;
    },
    resolveTarget: async request => request.normalizedHandle === "bob"
      ? Object.freeze({ userId: TARGET_USER, actorId: TARGET_ACTOR,
          normalizedHandle: "bob" })
      : null,
    reserveDestination: async () => {
      observations.reserves += 1;
      return Object.freeze({ roomId: ROOM, namespaceId: DESTINATION,
        humanActorIds: Object.freeze([HUMAN, TARGET_ACTOR].sort()) });
    },
    findDestination: async () => {
      observations.finds += 1;
      return input.recovery === undefined || input.recovery === "none"
        ? null
        : Object.freeze({ roomId: ROOM, namespaceId: DESTINATION,
            humanActorIds: Object.freeze([HUMAN, TARGET_ACTOR].sort()) });
    },
    planProduct: async () => Object.freeze({ status: "success" as const,
      value: Object.freeze({ status: "prepared" as const,
        plan: productPlan() }) }),
    inspectRecovery: async () => {
      observations.inspects += 1;
      return input.recovery === undefined || input.recovery === "none"
        ? null
        : Object.freeze({ status: "success" as const,
            value: Object.freeze({ status: input.recovery,
              plan: productPlan(), source }) });
    },
    commit: async () => {
      observations.commits += 1;
      return Object.freeze({ status: "success" as const,
        value: Object.freeze({ status: input.recovery === "complete"
          ? "replayed" as const : "updated" as const, memoryId: MEMORY }) });
    },
  });
  return { port, sealed, observations };
}

async function prepare(port: ReturnType<typeof createProtectedTaskMemoryExactAccess>) {
  const result = await port.prepareApproval({
    operationId: "grant-user",
    toolCallId: "tool-1",
    authority,
    memoryId: MEMORY,
    action: { kind: "grant_user", userHandle: "bob" },
  });
  if (result.status !== "success") throw new Error("prepare unavailable");
  return result.value.reference;
}

function change(reference: ProtectedAgentMemoryAccessApprovalReference) {
  return Object.freeze({ operationId: "grant-user", authority,
    memoryId: MEMORY, action: Object.freeze({ kind: "grant_user" as const,
      userHandle: "bob" }), approvalReference: reference });
}

describe("protected Task Memory exact access", () => {
  test("prepares without reserving a Namespace and binds restore to the exact call", async () => {
    const value = fixture({ includeDestination: false });
    const reference = await prepare(value.port);
    expect(value.observations.reserves).toBe(0);
    expect(await value.port.restoreApproval({ authority, reference,
      memoryId: `${MEMORY}-substituted`,
      action: { kind: "grant_user", userHandle: "bob" } })).toEqual({
      status: "unavailable", reason: "authorization_required",
    });
    expect(await value.port.restoreApproval({ authority, reference,
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "alice" } })).toEqual({
      status: "unavailable", reason: "authorization_required",
    });
    expect(value.observations.reserves).toBe(0);
  });

  test("keeps the sealed original decision additional after a fresh grant", async () => {
    const original = fixture({ includeDestination: false });
    const reference = await prepare(original.port);
    const resumed = fixture({ includeDestination: true,
      sealed: original.sealed });
    const planned = await resumed.port.planChange(change(reference));
    expect(planned).toMatchObject({ status: "success",
      value: { kind: "additional_authority_v1" } });
    expect(resumed.observations.commits).toBe(0);
  });

  test("does not recover or mutate for a substituted acknowledgement", async () => {
    const original = fixture({ includeDestination: false });
    const reference = await prepare(original.port);
    const resumed = fixture({ includeDestination: true,
      sealed: original.sealed, recovery: "pending", sourceAvailable: false });
    const planned = await resumed.port.planChange(change(reference));
    if (planned.status !== "success"
      || planned.value.kind !== "additional_authority_v1") {
      throw new Error("additional plan unavailable");
    }
    expect(resumed.observations.inspects).toBe(1);
    expect(resumed.observations.commits).toBe(0);
    const result = await resumed.port.changeAuthorized({
      ...change(reference),
      authorization: Object.freeze({
        kind: "additional_authority_v1" as const,
        plan: planned.value,
        acknowledgement: Object.freeze({
          type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
          authorizationRequestId: planned.value.authorizationRequestId,
          effectDisposition: "not_started_v1" as const,
          operationId: planned.value.operationId,
          requestDigest: planned.value.requestDigest.slice(),
          requiredAuthorityDigest: new Uint8Array(32),
        }),
      }),
    });
    expect(result).toEqual({ status: "unavailable",
      reason: "authorization_required" });
    expect(resumed.observations.commits).toBe(0);
  });

  for (const recovery of ["pending", "complete"] as const) {
    test(`restores and authorizes exact ${recovery} recovery without reading the old head`, async () => {
      const original = fixture({ includeDestination: false });
      const reference = await prepare(original.port);
      const resumed = fixture({ includeDestination: true,
        sealed: original.sealed, recovery, sourceAvailable: false });
      expect(await resumed.port.restoreApproval({ authority, reference,
        memoryId: MEMORY,
        action: { kind: "grant_user", userHandle: "bob" } })).toEqual({
        status: "success", value: { type: "fact", content: "private source" },
      });
      expect(resumed.observations.opens).toBe(0);
      expect(resumed.observations.commits).toBe(0);
      const planned = await resumed.port.planChange(change(reference));
      if (planned.status !== "success"
        || planned.value.kind !== "additional_authority_v1") {
        throw new Error("additional plan unavailable");
      }
      const result = await resumed.port.changeAuthorized({
        ...change(reference),
        authorization: Object.freeze({
          kind: "additional_authority_v1" as const,
          plan: planned.value,
          acknowledgement: Object.freeze({
            type: PROTECTED_TASK_ADDITIONAL_AUTHORITY_GRANTED_V1,
            authorizationRequestId: planned.value.authorizationRequestId,
            effectDisposition: "not_started_v1" as const,
            operationId: planned.value.operationId,
            requestDigest: planned.value.requestDigest.slice(),
            requiredAuthorityDigest:
              protectedTaskSemanticAuthorityRequirementsDigest(
                planned.value.semanticAuthorityRequirements,
              ),
          }),
        }),
      });
      expect(result).toMatchObject({ status: "success", value: {
        status: recovery === "complete" ? "replayed" : "updated",
        memoryId: MEMORY,
      } });
      expect(resumed.observations.commits).toBe(1);
    });
  }

  test("uses current authority without an additional acknowledgement when it already covers the destination", async () => {
    const value = fixture({ includeDestination: true });
    const reference = await prepare(value.port);
    const planned = await value.port.planChange(change(reference));
    if (planned.status !== "success" || planned.value.kind !== "current_v1") {
      throw new Error("current plan unavailable");
    }
    expect(await value.port.changeAuthorized({
      ...change(reference),
      authorization: Object.freeze({ kind: "current_v1" as const,
        plan: planned.value }),
    })).toMatchObject({ status: "success", value: { status: "updated" } });
    expect(value.observations.commits).toBe(1);
  });
});
