import { expect, test } from "bun:test";
import {
  LatticeCrypto, TaskRuntimeRecipientRegistry,
} from "@nautilo/lattice-crypto";
import { taskRuntimeStableRoutingDigest } from "@nautilo/runtime";
import type { ParkedProtectedTaskAdditionalAuthority, ProtectedTaskRunOutputBinding } from "@nautilo/db";
import type { ParkedTaskRuntimeCurrentRoutingFacts } from "@nautilo/lattice-bridge/server";
import type { ParkedProtectedTaskRuntimeMemoryPlan } from "../../src/routes/protected-task-runtime-parked-memory-plan";
import { createProtectedTaskRuntimeParkedPreparation } from "../../src/routes/protected-task-runtime-parked-preparation";

const USER = "10000000-0000-4000-8000-000000000001";
const HUMAN = "20000000-0000-4000-8000-000000000002";
const AGENT = "30000000-0000-4000-8000-000000000003";
const TASK = "40000000-0000-4000-8000-000000000004";
const RUN = "50000000-0000-4000-8000-000000000005";
const JOB = "60000000-0000-4000-8000-000000000006";
const CONTENT = "70000000-0000-4000-8000-000000000007";
const BASE = "80000000-0000-4000-8000-000000000008";
const ADDED = "90000000-0000-4000-8000-000000000009";
const SOURCE = "a0000000-0000-4000-8000-00000000000a";
const TARGET = "b0000000-0000-4000-8000-00000000000b";
const DOMAIN = "c0000000-0000-4000-8000-00000000000c";
const NOW = 1_700_000_000_000;
const INPUT = `task-definition:v1:${"a".repeat(64)}`;
const RESULT = `task-run-result:v1:${"b".repeat(64)}`;

type Overrides = NonNullable<Parameters<typeof createProtectedTaskRuntimeParkedPreparation>[1]>;

function fixture() {
  const facts: ParkedTaskRuntimeCurrentRoutingFacts = {
    taskId: TASK, taskRunId: RUN, ownerId: USER, requestorId: USER,
    agentId: AGENT, callingRoomId: SOURCE, scheduleKind: "now", graphThreadId: "task-thread",
    startedAt: new Date(NOW), sourceRoomId: SOURCE, targetRoomId: TARGET,
    targetUserIds: [USER], memoryMode: "namespace", wideBringBack: true, scopeId: null,
    contentRepresentation: "dual", contentNamespaceId: CONTENT, contentRevision: 1,
    contentObjectId: INPUT, contentAccessRevision: 0,
    requiredNamespaceFingerprint: new Uint8Array(32).fill(1),
  };
  const expected = {
    occurrence: {
      task: { id: TASK, ownerId: USER, requestorId: USER, agentId: AGENT,
        callingRoomId: SOURCE, scheduleKind: "now", status: "awaiting",
        contentRepresentation: "dual", contentNamespaceId: CONTENT, contentRevision: 1,
        cryptoObjectId: INPUT, cryptoAccessRevision: 0,
        cryptoRequiredNamespaceFingerprint: facts.requiredNamespaceFingerprint },
      run: { id: RUN, taskId: TASK, jobId: JOB, graphThreadId: facts.graphThreadId,
        status: "awaiting", startedAt: new Date(NOW) },
    },
    priorJob: { reference: { resultObjectId: RESULT } },
    proof: { continuation: {
      stableRoutingDigest: taskRuntimeStableRoutingDigest({
        ...facts, startedAt: NOW,
        requiredNamespaceFingerprint: Buffer.from(facts.requiredNamespaceFingerprint).toString("base64url"),
        outputRoomId: SOURCE, outputNamespaceId: CONTENT, widePrimaryWriteNamespaceId: null,
      }),
      semanticAuthorityRequirements: [{ namespaceId: ADDED, operations: ["encrypt"] }],
    } },
    authorizationRequestId: "task-run-authorization:v2:parked-fixture",
    continuationFingerprint: Buffer.alloc(32, 2).toString("base64url"), nextExecutionSegment: 2,
  } as unknown as ParkedProtectedTaskAdditionalAuthority;
  const output = {
    taskRunId: RUN, bindingId: `task-run-output:${RUN}`, resultOperationId: `task-run-result:${RUN}`,
    resultObjectId: RESULT, destinationRoomId: SOURCE, destinationNamespaceId: CONTENT,
    deliveryMode: "raw", acceptedPolicyRevision: 7,
  } as ProtectedTaskRunOutputBinding;
  const plan: ParkedProtectedTaskRuntimeMemoryPlan = {
    expectedNamespaceParticipants: [{ namespaceId: BASE, participantHumanIds: [HUMAN], match: "exact" }],
    routing: { taskId: TASK, taskRunId: RUN, requesterUserId: USER, requesterHumanId: HUMAN,
      agentId: AGENT, sourceRoomId: SOURCE, sourceNamespaceId: CONTENT, targetRoomId: TARGET,
      targetUserIds: [USER], memoryMode: "namespace", scopeId: null, targetChat: "new_in_namespace",
      wideBringBack: true, widePrivateNamespaceId: null, outputRoomId: SOURCE, outputNamespaceId: CONTENT },
    resolution: { mode: "namespace", authorityStatus: "exact", provenance: "target_users_namespace",
      envelope: { memoryMode: "namespace", ownerId: USER, actorId: HUMAN, agentId: AGENT,
        roomId: TARGET, readableNamespaces: [CONTENT, BASE], mutableNamespaces: [BASE],
        writableNamespaces: [BASE], toolPolicy: {} } },
  };
  const recipients = new TaskRuntimeRecipientRegistry(new LatticeCrypto());
  let held = false;
  const events: string[] = [];
  let captured: Parameters<NonNullable<Overrides["prepare"]>>[0] | undefined;
  const overrides: Overrides = {
    db: {} as NonNullable<Overrides["db"]>, now: () => NOW,
    discover: async () => expected, readOutput: async () => output,
    readPolicy: async () => ({ mode: "shadow_encryption", shadowBehavior: "strict", revision: 7 }),
    resolveMemory: async () => plan,
    productContext: async () => ({ canonicalRunner: {} }) as Awaited<ReturnType<NonNullable<Overrides["productContext"]>>>,
    restricted: () => ({}) as ReturnType<NonNullable<Overrides["restricted"]>>,
    withAuthority: async input => {
      expect(input.expectedNamespaceParticipants).toEqual(plan.expectedNamespaceParticipants);
      expect(input.expectedNamespaceParticipants).not.toBe(plan.expectedNamespaceParticipants);
      events.push("validate");
      if (!await input.validateCurrentRouting(facts)) return null;
      held = true;
      try {
        return await input.use({ sourceRoomId: SOURCE, sourceNamespaceId: CONTENT,
          facts: input.namespaceIds.map(namespaceId => ({ namespaceId, domainId: DOMAIN,
            expectedAccessRevision: 1, expectedPolicyRevision: 7,
            expectedDomainEpoch: 1, expectedAuthorizationRevision: 1 })) }, {} as Parameters<typeof input.use>[1]);
      } finally { held = false; events.push("released"); }
    },
    repository: async () => {
      expect(held).toBe(true); events.push("repository");
      return {} as Awaited<ReturnType<NonNullable<Overrides["repository"]>>>;
    },
    prepare: async input => {
      expect(held).toBe(true); events.push("prepare"); captured = input;
      return { status: "created" };
    },
    wake: async () => { expect(held).toBe(false); events.push("wake"); },
  };
  const run = (patch: Overrides = {}) => createProtectedTaskRuntimeParkedPreparation({
    resolver: {} as Parameters<typeof createProtectedTaskRuntimeParkedPreparation>[0]["resolver"], recipients,
  }, { ...overrides, ...patch })(expected.occurrence);
  return { expected, output, plan, facts, events, run, overrides, captured: () => captured, recipients };
}

test("prepares current base plus exact semantic operations only inside held authority", async () => {
  const f = fixture();
  try {
    expect(await f.run()).toEqual({ status: "created" });
    expect(f.events).toEqual(["validate", "repository", "prepare", "released"]);
    const request = f.captured()!;
    expect(request.stableIdentity.executionSegment).toBe(2);
    expect(request.stableIdentity.resumeContinuationFingerprint).toBe(f.expected.continuationFingerprint);
    expect(request.initialRecord.snapshot.requestId).toBe(f.expected.authorizationRequestId);
    expect(request.initialRecord.authoritySet.namespaceRequirements.map(value => [value.namespaceId, value.operations]))
      .toEqual([[CONTENT, ["decrypt", "encrypt"]], [BASE, ["decrypt", "encrypt"]], [ADDED, ["encrypt"]]]);
    expect(request.initialRecord.descriptorBytes).toBeNull();
    expect(request.initialRecord.acceptedMaterial).toBeNull();
  } finally { f.recipients.close(); }
});

test("never prepares fresh occurrences or Plain policy", async () => {
  const f = fixture();
  try {
    expect(await f.run({ readPolicy: async () => ({ mode: "plaintext_only", shadowBehavior: "fallback", revision: 8 }),
      resolveMemory: async () => { throw new Error("unexpected Memory read"); } })).toEqual({ status: "inactive" });
    const prepare = createProtectedTaskRuntimeParkedPreparation({
      resolver: {} as Parameters<typeof createProtectedTaskRuntimeParkedPreparation>[0]["resolver"], recipients: f.recipients,
    }, { ...f.overrides, discover: async () => { throw new Error("unexpected discovery"); } });
    expect(await prepare({ ...f.expected.occurrence, run: { ...f.expected.occurrence.run, jobId: null } }))
      .toEqual({ status: "inactive" });
    expect(f.events).toEqual([]);
  } finally { f.recipients.close(); }
});

test("changed routing or output cannot create a request or trigger a readiness wake", async () => {
  const f = fixture();
  try {
    Reflect.set(f.facts, "targetUserIds", [HUMAN]);
    expect(await f.run()).toEqual({ status: "inactive" });
    expect(f.events).toEqual(["validate"]);
    const failure = await f.run({ readOutput: async () => ({ ...f.output, destinationRoomId: TARGET }) })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(String(failure)).toContain("original routing evidence is unavailable");
    expect(f.captured()).toBeUndefined();
  } finally { f.recipients.close(); }
});

test("key readiness wakes only after held authority has unwound", async () => {
  const f = fixture();
  try {
    expect(await f.run({ withAuthority: async input => {
      expect(await input.validateCurrentRouting(f.facts)).toBe(true);
      input.onNamespaceReadinessUnavailable?.(ADDED);
      f.events.push("released"); return null;
    } })).toEqual({ status: "awaiting_readiness" });
    expect(f.events).toEqual(["released", "wake"]);
    expect(f.captured()).toBeUndefined();
  } finally { f.recipients.close(); }
});

test("other post-routing authority failures remain inactive without a key wake", async () => {
  const f = fixture();
  try {
    expect(await f.run({ withAuthority: async input => {
      expect(await input.validateCurrentRouting(f.facts)).toBe(true);
      return null;
    } })).toEqual({ status: "inactive" });
    expect(f.events).toEqual([]);
  } finally { f.recipients.close(); }
});

test("held repository failure unwinds without publishing a readiness event", async () => {
  const f = fixture();
  try {
    const failure = await f.run({ prepare: async () => { throw new Error("rollback"); } })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("rollback");
    expect(f.events).toEqual(["validate", "repository", "released"]);
  } finally { f.recipients.close(); }
});
