import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import {
  EncryptedCheckpointSaver,
  InlineCheckpointCellSerializer,
} from "../../src/checkpoints/encrypted-checkpoint-saver";
import type { NautiloGraphDeps } from "../../src/agent/graph";
import type {
  ProtectedAgentMemoryProjectionPort,
  ProtectedAgentMemoryRepository,
} from "@nautilo/lattice-bridge";
import { triggerCheckpointCompactionDouble } from "./support/checkpoint-compaction-double";

let capturedCheckpointSaver: unknown;
let capturedGraphDeps: NautiloGraphDeps | undefined;

const attachCheckpoint = {
  values: { turnId: "turn-protected-resume" },
  tasks: [{
    interrupts: [{
      value: {
        type: "approval_ask",
        tools: [{
          id: "share-call",
          name: "share_memory",
          args: { memory_id: "memory-1", target_handle: "@bob" },
          shareMemoryPreview: {
            protectedApprovalDigest: "approval-reference-1",
          },
        }],
      },
    }],
  }],
};
let checkpoint: unknown = attachCheckpoint;
let streamCalls = 0;
let streamedCommand: { resume?: unknown; update?: unknown } | undefined;

async function expectFailure(
  operation: Promise<unknown>,
  message: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(Error);
  expect((caught as Error).message).toContain(message);
}

function projectionCheckpoint(
  sealedPreparation = "sealed-resume-plan",
  expiresAt = Date.now() + 60_000,
): unknown {
  const now = Date.now();
  return {
    values: {
      turnId: "turn-protected-projection-resume",
      userId: "user-1",
      taskRun: false,
      subagentRun: false,
      memoryAccessEnvelope: {
        memoryMode: "namespace",
        ownerId: "user-1",
        actorId: "actor-1",
        agentId: "agent-1",
        roomId: "room-1",
        readableNamespaces: ["namespace-1"],
        mutableNamespaces: ["namespace-1"],
        writableNamespaces: ["namespace-1"],
      },
      projectionSnapshots: [{
        kind: "protected",
        toolCallId: "projection-call",
        requesterUserId: "user-1",
        requesterActorId: "actor-1",
        agentId: "agent-1",
        reference: {
          referenceVersion: 1,
          referenceId: "projection-reference-1",
          toolCallId: "projection-call",
          requesterUserId: "user-1",
          requesterActorId: "actor-1",
          agentId: "agent-1",
          createdAt: now - 1_000,
          expiresAt,
          sealedPreparation,
        },
      }],
    },
    tasks: [{ interrupts: [{ value: {
      type: "approval_ask",
      tools: [{
        id: "projection-call",
        name: "share_memory",
        args: { mode: "project" },
      }],
    } }] }],
  };
}

function encryptedSaver(): EncryptedCheckpointSaver {
  const serializer = new InlineCheckpointCellSerializer();
  return new EncryptedCheckpointSaver({
    operationStoreFactory: {
      serializer,
      schema: "langchain",
      create: () => {
        throw new Error("not used by protected resume wiring test");
      },
      end: () => Promise.resolve(),
    },
    crypto: {} as never,
    scope: {
      logicalThreadId: "room:room-1:bot:agent-1",
      namespaceId: "namespace-test-shadow",
      keyClass: "ai",
      expectedAccessRevision: 1,
      expectedPolicyRevision: 1,
      authorizationSession: Object.freeze({ id: "session-test" }),
    },
  });
}

let resumeGraphWithApproval: typeof import(
  "../../src/graph/resume-approval"
)["resumeGraphWithApproval"];
let resumeGraphWithAskReply: typeof import(
  "../../src/graph/resume-approval-ask"
)["resumeGraphWithAskReply"];
let resumeGraphWithIdentity: typeof import(
  "../../src/graph/resume-identity"
)["resumeGraphWithIdentity"];
let resumeGraphWithConnectedWebAction: typeof import(
  "../../src/graph/resume-connected-web-action"
)["resumeGraphWithConnectedWebAction"];

beforeAll(async () => {
  mock.module("../../src/checkpoints/checkpoint-saver", () => ({
    createCheckpointSaver: () => {
      throw new Error("plaintext checkpoint saver must not be constructed");
    },
    triggerCheckpointCompaction: triggerCheckpointCompactionDouble,
  }));
  mock.module("../../src/agent/post-model-deps", () => ({
    defaultPostModelDeps: {},
  }));
  mock.module("../../src/agent/graph", () => ({
    createNautiloGraph: (
      checkpointSaver: unknown,
      _policyResolver: unknown,
      deps: NautiloGraphDeps | undefined,
    ) => {
      capturedCheckpointSaver = checkpointSaver;
      capturedGraphDeps = deps;
      return {
        streamEvents: async function* (command: { resume?: unknown }) {
          streamCalls += 1;
          streamedCommand = command;
          // The protected resume drains without emitting model events.
          yield* [];
        },
        getState: async () => checkpoint,
      };
    },
  }));
  mock.module("@nautilo/trust", () => ({
    getPolicyResolver: () => null,
    findRoomIdByGraphThreadIdForUser: async () => null,
    isScopeMemoryEnvelope: (envelope: { memoryMode?: string }) =>
      envelope.memoryMode === "scope",
    findActorByOwnerId: async () => null,
    findActorByHandle: async () => null,
    findActorById: async () => null,
    envelopeReadableNamespaces: () => [],
    findAuthorizedRoomNameCandidates: async () => [],
    resolveAuthorizedRoomName: async () => ({ status: "not_found" }),
    userHasCapability: async () => false,
    resolveSpeakerUserId: () => null,
    createSharedRoomForPair: async () => null,
    findOrCreateAccessNamespace: async () => null,
    findShareTargetRoom: async () => null,
    findUserDisplayInfo: async () => null,
  }));

  ({ resumeGraphWithApproval } = await import(
    "../../src/graph/resume-approval"
  ));
  ({ resumeGraphWithAskReply } = await import(
    "../../src/graph/resume-approval-ask"
  ));
  ({ resumeGraphWithIdentity } = await import(
    "../../src/graph/resume-identity"
  ));
  ({ resumeGraphWithConnectedWebAction } = await import(
    "../../src/graph/resume-connected-web-action"
  ));
});

afterAll(() => {
  mock.restore();
});

beforeEach(() => {
  capturedCheckpointSaver = undefined;
  capturedGraphDeps = undefined;
  checkpoint = attachCheckpoint;
  streamCalls = 0;
  streamedCommand = undefined;
});

const processor = Object.freeze({
  process() {},
  flush() {},
});

describe("protected Human resume checkpoint selection", () => {
  test("prove_it rejects an old exact challenge before resume lifecycle mutation", async () => {
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        id: "22222222222222222222222222222222",
        value: { type: "prove_it_challenge", tools: [] },
      }] }],
    };
    const lifecycle = { began: 0, failed: 0 };
    const guardedProcessor = {
      process() {},
      flush() {},
      async beginResume() { lifecycle.began += 1; },
      async failResume() { lifecycle.failed += 1; },
    };

    await expectFailure(resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      guardedProcessor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      "11111111111111111111111111111111",
    ), "challenge");

    expect(lifecycle).toEqual({ began: 0, failed: 0 });
    expect(streamCalls).toBe(0);
  });

  test("prove_it keys the resume to the matching exact challenge", async () => {
    const challengeId = "11111111111111111111111111111111";
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        id: challengeId,
        value: { type: "prove_it_challenge", tools: [] },
      }] }],
    };

    await resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      challengeId,
    );

    expect(streamedCommand?.resume).toEqual({ [challengeId]: { approved: true } });
  });

  test("prove_it revalidates a replaced checkpoint immediately before stream", async () => {
    const challengeId = "11111111111111111111111111111111";
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        id: challengeId,
        value: { type: "prove_it_challenge", tools: [] },
      }] }],
    };
    const lifecycle = { began: 0, failed: 0 };
    const guardedProcessor = {
      process() {},
      flush() {},
      async beginResume() {
        lifecycle.began += 1;
        checkpoint = {
          values: { turnId: "turn-protected-resume" },
          tasks: [{ interrupts: [{
            id: "22222222222222222222222222222222",
            value: { type: "prove_it_challenge", tools: [] },
          }] }],
        };
      },
      async failResume() { lifecycle.failed += 1; },
    };

    await expectFailure(resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      guardedProcessor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      challengeId,
    ), "challenge");

    expect(lifecycle).toEqual({ began: 1, failed: 1 });
    expect(streamCalls).toBe(0);
  });

  test("legacy prove_it caller keeps the unkeyed resume contract", async () => {
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        value: { type: "prove_it_challenge", tools: [] },
      }] }],
    };

    await resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      processor,
      "room:room-1",
      encryptedSaver(),
    );

    expect(streamedCommand?.resume).toEqual({ approved: true });
  });

  test("approval.ask rejects a stale approval id after restart before graph mutation", async () => {
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        id: "33333333333333333333333333333333",
        value: { type: "approval_ask", approvalId: "approval-current", tools: [] },
      }] }],
    };
    const lifecycle = { began: 0, failed: 0 };
    const guardedProcessor = {
      process() {},
      flush() {},
      async beginResume() { lifecycle.began += 1; },
      async failResume() { lifecycle.failed += 1; },
    };

    await expectFailure(resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "once",
      guardedProcessor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval-old",
    ), "approval");

    expect(lifecycle).toEqual({ began: 0, failed: 0 });
    expect(streamCalls).toBe(0);
  });

  test("approval.ask validates its public approval id and keys its graph resume", async () => {
    const interruptId = "33333333333333333333333333333333";
    checkpoint = {
      values: { turnId: "turn-protected-resume" },
      tasks: [{ interrupts: [{
        id: interruptId,
        value: { type: "approval_ask", approvalId: "approval-current", tools: [] },
      }] }],
    };

    await resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "once",
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "approval-current",
    );

    expect(streamedCommand?.resume).toEqual({
      [interruptId]: { approved: true, verb: "once" },
    });
  });

  test("approval resume uses the supplied invocation-bound saver", async () => {
    const invocationCheckpointSaver = encryptedSaver();
    await resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      processor,
      "room:room-1",
      invocationCheckpointSaver,
    );

    expect(capturedCheckpointSaver).toBe(invocationCheckpointSaver);
  });

  test("approval-ask resume uses the supplied invocation-bound saver", async () => {
    const invocationCheckpointSaver = encryptedSaver();
    await resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "once",
      processor,
      "room:room-1",
      invocationCheckpointSaver,
    );

    expect(capturedCheckpointSaver).toBe(invocationCheckpointSaver);
  });

  for (const [name, resume] of [
    ["prove_it", async (deps: NautiloGraphDeps) => resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      deps,
    )],
    ["approval.ask", async (deps: NautiloGraphDeps) => resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "once",
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    )],
  ] as const) {
    test(`${name} resume forwards exact protected Memory graph custody`, async () => {
      const repository = Object.freeze({}) as ProtectedAgentMemoryRepository;
      const projection = Object.freeze({}) as ProtectedAgentMemoryProjectionPort;
      const changed: string[] = [];
      const access = Object.freeze({
        prepareApproval: async () => ({
          status: "success" as const,
          value: {
            reference: {
              referenceVersion: 1 as const,
              referenceId: "approval-reference-1",
              toolCallId: "share-call",
              requesterUserId: "user-1",
              agentId: "agent-1",
            },
            preview: { type: "fact", content: "private" },
          },
        }),
        change: async () => {
          changed.push("changed");
          return {
            status: "success" as const,
            value: { status: "updated" as const, memoryId: "memory-1" },
          };
        },
      });
      const deps = {
        protectedMemoryRepositoryForState: () => repository,
        protectedMemoryAccessPortForState: () => access,
        protectedMemoryProjectionPortForState: () => projection,
        fullEncryptionOnlyForState: () => true,
      } as NautiloGraphDeps;

      await resume(deps);

      const state = {} as never;
      expect(capturedGraphDeps?.protectedMemoryRepositoryForState?.(state))
        .toBe(repository);
      expect(capturedGraphDeps?.protectedMemoryProjectionPortForState?.(state))
        .toBe(projection);
      expect(capturedGraphDeps?.fullEncryptionOnlyForState?.(state)).toBe(true);
      const wrappedAccess = capturedGraphDeps
        ?.protectedMemoryAccessPortForState?.(state);
      expect(wrappedAccess).toBeDefined();
      expect(wrappedAccess).not.toBe(access);
      const prepared = await wrappedAccess!.prepareApproval!({
        toolCallId: "share-call",
        authority: {
          subjectUserId: "user-1",
          agentId: "agent-1",
        },
      } as never);
      expect(prepared).toMatchObject({
        status: "success",
        value: { reference: { referenceId: "approval-reference-1" } },
      });
      await wrappedAccess!.change({
        approvalReference: prepared.status === "success"
          ? prepared.value.reference
          : undefined,
      } as never);
      expect(changed).toEqual(["changed"]);
    });
  }

  for (const [name, checkpointValue, resume] of [
    ["prove_it", projectionCheckpoint(""), async (deps: NautiloGraphDeps) =>
      resumeGraphWithApproval(
        "room:room-1:bot:agent-1",
        false,
        processor,
        "room:room-1",
        encryptedSaver(),
        undefined,
        undefined,
        deps,
      )],
    ["approval.ask", projectionCheckpoint(
      "sealed-expired-plan",
      Date.now() - 1,
    ), async (deps: NautiloGraphDeps) => resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "deny",
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    )],
  ] as const) {
    test(`${name} denial does not require protected projection restoration`, async () => {
      checkpoint = structuredClone(checkpointValue);
      let restoreCalls = 0;
      const projection: ProtectedAgentMemoryProjectionPort = {
        restore: async () => {
          restoreCalls += 1;
          throw new Error("denial must not restore");
        },
        prepare: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
        publish: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
      };

      await resume({
        fullEncryptionOnlyForState: () => true,
        protectedMemoryProjectionPortForState: () => projection,
      });

      expect(restoreCalls).toBe(0);
      expect(streamCalls).toBe(1);
    });
  }

  for (const [name, resume] of [
    ["prove_it", async (deps: NautiloGraphDeps) => resumeGraphWithApproval(
      "room:room-1:bot:agent-1",
      true,
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      deps,
    )],
    ["approval.ask", async (deps: NautiloGraphDeps) => resumeGraphWithAskReply(
      "room:room-1:bot:agent-1",
      "once",
      processor,
      "room:room-1",
      encryptedSaver(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      deps,
    )],
  ] as const) {
    test(`${name} restores a protected projection before graph streaming`, async () => {
      checkpoint = structuredClone(projectionCheckpoint());
      const order: string[] = [];
      const projection: ProtectedAgentMemoryProjectionPort = {
        restore: async () => {
          order.push(`restore-before-stream-${streamCalls}`);
          return { status: "success", value: {
            proposedContent: "approved projection",
            roomLabel: "Destination",
            roomKind: "private",
            memberCount: 2,
          } };
        },
        prepare: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
        publish: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
      };

      await resume({
        protectedMemoryProjectionPortForState: () => projection,
      });

      expect(order).toEqual(["restore-before-stream-0"]);
      expect(streamCalls).toBe(1);
    });

    test(`${name} does not stream when projection restoration fails`, async () => {
      checkpoint = structuredClone(projectionCheckpoint());
      const projection: ProtectedAgentMemoryProjectionPort = {
        restore: async () => ({
          status: "unavailable", reason: "stale_revision",
        }),
        prepare: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
        publish: async () => ({
          status: "unavailable", reason: "authorization_required",
        }),
      };

      await expectFailure(resume({
        protectedMemoryProjectionPortForState: () => projection,
      }), "could not be restored");
      expect(streamCalls).toBe(0);
    });
  }

  test("identity resume uses the supplied invocation-bound saver", async () => {
    const invocationCheckpointSaver = encryptedSaver();
    await resumeGraphWithIdentity(
      "room:room-1:bot:agent-1",
      {
        actorId: "actor-1",
        actorFederatedId: "federated-1",
        memoryAccess: {
          ownerId: "user-1",
        },
      } as never,
      "agent-1",
      processor,
      "room:room-1",
      "workbench",
      invocationCheckpointSaver,
    );

    expect(capturedCheckpointSaver).toBe(invocationCheckpointSaver);
  });

  test("identity enrollment entrypoint restores the exact checkpointed replay marker", async () => {
    checkpoint = structuredClone({
      values: {
        turnId: "turn-identity-enrollment",
        messages: [{ tool_calls: [{
          id: "pending-projection",
          name: "share_memory",
          args: { mode: "project" },
        }] }],
      },
      tasks: [{ interrupts: [{ value: {
        type: "identity_challenge",
        mode: "enrollPin",
        enrollmentToolCallIds: ["pending-projection"],
      } }] }],
    });

    await resumeGraphWithIdentity(
      "room:room-1:bot:agent-1",
      { memoryAccess: { ownerId: "user-1" } } as never,
      "agent-1",
      processor,
      undefined,
      "workbench",
      encryptedSaver(),
    );

    expect(streamedCommand?.update).toEqual({
      identityEnrollmentToolCallIds: ["pending-projection"],
    });
    expect(streamedCommand?.resume).toMatchObject({ verified: true });
  });

  test("connected-web action resume uses the supplied invocation-bound saver", async () => {
    const invocationCheckpointSaver = encryptedSaver();
    await resumeGraphWithConnectedWebAction(
      "room:room-1:bot:agent-1",
      { toolCallId: "tool-call-1", decision: "done" },
      {} as never,
      "user-1",
      processor,
      "room:room-1",
      invocationCheckpointSaver,
    );

    expect(capturedCheckpointSaver).toBe(invocationCheckpointSaver);
  });
});
