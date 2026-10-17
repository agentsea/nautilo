import { describe, expect, test } from "bun:test";
import type { DirectDatabase } from "@nautilo/db";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";
import type { TaskExecutionDeliveryShapeV1 } from "@nautilo/lattice-bridge";
import type { TaskCreateInput } from "../../src/tasks/create-task";
import {
  createAgentTurnTaskCreationProvenance,
  createArtifactEventTaskCreationProvenance,
  createHumanApiTaskCreationProvenance,
  createProtectedTaskCreationAdmissionV1,
  getPlaintextTaskCreationAdmission,
  type ProtectedTaskCreationAuthorityPortsV1,
  type ProtectedTaskCreationResolutionInputV1,
  type TaskCreationAdmissionInput,
  type TaskCreationProvenance,
} from "../../src/tasks/task-creation-admission";

const HUMAN = "11111111-1111-4111-8111-111111111111";
const AGENT = "22222222-2222-4222-8222-222222222222";
const ROOM = "33333333-3333-4333-8333-333333333333";
const TASK = "44444444-4444-4444-8444-444444444444";
const RUN = "55555555-5555-4555-8555-555555555555";
const FOREIGN_OWNER = "66666666-6666-4666-8666-666666666666";
const OTHER_HUMAN = "77777777-7777-4777-8777-777777777777";
const REQUESTER_USER = "88888888-8888-4888-8888-888888888888";
const DB = {} as DirectDatabase;

function candidate(overrides: Partial<TaskCreateInput> = {}): TaskCreateInput {
  return {
    ownerId: HUMAN,
    requestorId: HUMAN,
    agentId: AGENT,
    prompt: "Prepare the private report.",
    scheduleKind: "now",
    timezone: "UTC",
    depth: 0,
    metadata: {},
    ...overrides,
  };
}

function admissionInput(
  value: TaskCreateInput,
  provenance: TaskCreationProvenance =
    createHumanApiTaskCreationProvenance({ ownerId: HUMAN }),
): TaskCreationAdmissionInput {
  return {
    db: DB,
    candidate: value,
    provenance,
    invocationAuthority: createAcceptedInvocationAuthority(HUMAN),
  };
}

function ports(
  shape: TaskExecutionDeliveryShapeV1 = {
    conversation: "private",
    memory: "namespace",
    executor: "native",
  },
): ProtectedTaskCreationAuthorityPortsV1 & {
  calls: { shape: number; namespace: number };
  lastInput: () => ProtectedTaskCreationResolutionInputV1 | null;
} {
  const calls = { shape: 0, namespace: 0 };
  let lastInput: ProtectedTaskCreationResolutionInputV1 | null = null;
  return {
    calls,
    lastInput: () => lastInput,
    resolveExecutionShape: async (input) => {
      calls.shape += 1;
      lastInput = input;
      return { status: "resolved", shape };
    },
    resolveRequesterPrivateNamespace: async (input) => {
      calls.namespace += 1;
      lastInput = input;
      return {
        status: "authorized",
        subjectHumanId: HUMAN,
        namespaceId: "namespace.requester.private",
        domainId: "domain.requester.private",
        accessRevision: 3,
        policyRevision: 7,
      };
    },
  };
}

describe("Task creation admission", () => {
  test("Plain returns the exact ordinary candidate without classification", async () => {
    const ordinary = candidate({
      ownerId: FOREIGN_OWNER,
      metadata: { unknownFutureField: "preserved" },
    });
    const provenance = createHumanApiTaskCreationProvenance({
      ownerId: FOREIGN_OWNER,
    });
    const input = admissionInput(ordinary, provenance);
    const result = await getPlaintextTaskCreationAdmission().admit(input);

    expect(result.kind).toBe("ordinary");
    if (result.kind !== "ordinary") throw new Error("ordinary fixture rejected");
    expect(result.candidate).toBe(ordinary);
    expect(result.candidate.ownerId).toBe(FOREIGN_OWNER);
    expect(result.candidate.metadata).toEqual({ unknownFutureField: "preserved" });
    expect(input.provenance).toBe(provenance);
    expect(input.provenance.ownerId).toBe(FOREIGN_OWNER);
  });

  test("prepares one root authority while separating protected metadata", async () => {
    const dependencies = ports({
      conversation: "public",
      memory: "private_wide",
      executor: "external_harness",
    });
    const admission = createProtectedTaskCreationAdmissionV1(dependencies);
    const result = await admission.admit(admissionInput(candidate({
      expectedOutput: "A reviewed guide.",
      metadata: {
        target: "file:///private/workspace",
        mode: "update",
        publish: "branch",
        instructions: "Keep internal names out of the result.",
      },
    })));

    expect(result).toEqual({
      kind: "protected",
      canonicalTaskIdentity: { ownerId: HUMAN, requestorId: HUMAN, agentId: AGENT },
      prepared: {
        canonicalTaskIdentity: {
          ownerId: HUMAN,
          requestorId: HUMAN,
          agentId: AGENT,
        },
        authority: {
          authorityVersion: 1,
          kind: "requester_private_namespace",
          keyClass: "ai",
          requesterHumanId: HUMAN,
          namespaceId: "namespace.requester.private",
          domainId: "domain.requester.private",
          expectedAccessRevision: 3,
          expectedPolicyRevision: 7,
        },
        shape: {
          conversation: "public",
          memory: "private_wide",
          executor: "external_harness",
        },
        payload: {
          formatVersion: 1,
          prompt: "Prepare the private report.",
          expectedOutput: "A reviewed guide.",
          protectedMetadata: {
            target: "file:///private/workspace",
            instructions: "Keep internal names out of the result.",
          },
        },
        operationalMetadata: { mode: "update", publish: "branch" },
      },
    });
    expect(dependencies.calls).toEqual({ shape: 1, namespace: 1 });
    expect(dependencies.lastInput()).toMatchObject({
      ownerId: HUMAN,
      requestorId: HUMAN,
      agentId: AGENT,
      operationalMetadata: { mode: "update", publish: "branch" },
    });
    expect(dependencies.lastInput()).not.toHaveProperty("prompt");
    expect(dependencies.lastInput()).not.toHaveProperty("expectedOutput");
    expect(dependencies.lastInput()).not.toHaveProperty("metadata");
  });

  test("binds content authority to the resolved Human actor while retaining the requester User identity", async () => {
    const dependencies = ports();
    const original = candidate({ ownerId: REQUESTER_USER, requestorId: REQUESTER_USER });
    const provenance = createHumanApiTaskCreationProvenance({ ownerId: REQUESTER_USER });
    const result = await createProtectedTaskCreationAdmissionV1(dependencies).admit({
      db: DB,
      candidate: original,
      provenance,
      invocationAuthority: createAcceptedInvocationAuthority(REQUESTER_USER),
    });

    expect(result.kind).toBe("protected");
    if (result.kind !== "protected") throw new Error("canonical identity fixture rejected");
    expect(result.prepared.canonicalTaskIdentity).toEqual({
      ownerId: REQUESTER_USER,
      requestorId: REQUESTER_USER,
      agentId: AGENT,
    });
    expect(result.prepared.authority.requesterHumanId).toBe(HUMAN);
    expect(dependencies.lastInput()).toMatchObject({
      ownerId: REQUESTER_USER,
      requestorId: REQUESTER_USER,
    });
  });

  test.each(["foreground.main", "foreground.fork"] as const)(
    "authenticates a foreign-owned Genie %s origin before assigning the protected Task to its requester",
    async (entrypoint) => {
      const dependencies = ports();
      const admission = createProtectedTaskCreationAdmissionV1(dependencies);
      const originalMetadata = {};
      const original = candidate({
        ownerId: FOREIGN_OWNER,
        requestorId: HUMAN,
        agentId: AGENT,
        metadata: originalMetadata,
      });
      const originalSnapshot = {
        ...original,
        metadata: { ...originalMetadata },
      };
      const provenance = createAgentTurnTaskCreationProvenance({
        ownerId: FOREIGN_OWNER,
        invocation: {
          ownerId: FOREIGN_OWNER,
          roomId: ROOM,
          entrypoint,
        },
      });

      const result = await admission.admit({
        ...admissionInput(original, provenance),
        invocationAuthority: createAcceptedInvocationAuthority(HUMAN),
      });

      expect(result.kind).toBe("protected");
      if (result.kind !== "protected") {
        throw new Error("foreign-owned Genie root fixture rejected");
      }
      expect(result.prepared.canonicalTaskIdentity).toEqual({
        ownerId: HUMAN,
        requestorId: HUMAN,
        agentId: AGENT,
      });
      expect(result.prepared.authority).toMatchObject({
        requesterHumanId: HUMAN,
      });
      expect(dependencies.lastInput()).toMatchObject({
        ownerId: HUMAN,
        requestorId: HUMAN,
        agentId: AGENT,
        provenance,
      });
      expect(dependencies.lastInput()?.provenance).toBe(provenance);
      expect(provenance.ownerId).toBe(FOREIGN_OWNER);
      expect(original).toEqual(originalSnapshot);
      expect(original.ownerId).toBe(FOREIGN_OWNER);
      expect(original.requestorId).toBe(HUMAN);
      expect(original.metadata).toBe(originalMetadata);
    },
  );

  test("rejects a requester without matching accepted invocation authority before resolution", async () => {
    const dependencies = ports();
    const original = candidate({ ownerId: FOREIGN_OWNER });
    const provenance = createAgentTurnTaskCreationProvenance({
      ownerId: FOREIGN_OWNER,
      invocation: {
        ownerId: FOREIGN_OWNER,
        roomId: ROOM,
        entrypoint: "foreground.main",
      },
    });

    expect(
      createProtectedTaskCreationAdmissionV1(dependencies).admit({
        ...admissionInput(original, provenance),
        invocationAuthority: createAcceptedInvocationAuthority(OTHER_HUMAN),
      }),
    ).rejects.toThrow("Accepted invocation authority subject mismatch");
    expect(dependencies.calls).toEqual({ shape: 0, namespace: 0 });
    expect(original.ownerId).toBe(FOREIGN_OWNER);
  });

  test("rejects foreign-owner provenance that does not authenticate the original candidate owner", async () => {
    const dependencies = ports();
    const original = candidate({ ownerId: FOREIGN_OWNER });
    const wrongProvenance = createAgentTurnTaskCreationProvenance({
      ownerId: OTHER_HUMAN,
      invocation: {
        ownerId: OTHER_HUMAN,
        roomId: ROOM,
        entrypoint: "foreground.main",
      },
    });

    expect(
      createProtectedTaskCreationAdmissionV1(dependencies).admit(
        admissionInput(original, wrongProvenance),
      ),
    ).rejects.toThrow("Task creation requires server-authored provenance");
    expect(dependencies.calls).toEqual({ shape: 0, namespace: 0 });
    expect(original.ownerId).toBe(FOREIGN_OWNER);
  });

  test("rejects a forged foreign-owner provenance before resolution", async () => {
    const dependencies = ports();
    const original = candidate({ ownerId: FOREIGN_OWNER });
    const forgedProvenance = Object.freeze({
      kind: "agent_turn" as const,
      ownerId: FOREIGN_OWNER,
      roomId: ROOM,
      entrypoint: "foreground.main" as const,
      parentTaskId: null,
      parentTaskRunId: null,
    });

    expect(
      createProtectedTaskCreationAdmissionV1(dependencies).admit({
        ...admissionInput(original),
        provenance: forgedProvenance,
      }),
    ).rejects.toThrow("Task creation requires server-authored provenance");
    expect(dependencies.calls).toEqual({ shape: 0, namespace: 0 });
  });

  test("accepts the ordinary empty metadata shape for protected roots", async () => {
    const admission = createProtectedTaskCreationAdmissionV1(ports());
    const result = await admission.admit(admissionInput(candidate()));

    expect(result.kind).toBe("protected");
    if (result.kind !== "protected") throw new Error("root fixture rejected");
    expect(result.prepared.payload.protectedMetadata).toEqual({});
    expect(result.prepared.operationalMetadata).toEqual({});
  });

  test("rejects unknown metadata before any authority resolution", async () => {
    const dependencies = ports();
    const admission = createProtectedTaskCreationAdmissionV1(dependencies);
    const result = await admission.admit(admissionInput(candidate({
      metadata: { futureField: true },
    })));

    expect(result).toEqual({ kind: "unavailable", reason: "metadata_unsupported" });
    expect(dependencies.calls).toEqual({ shape: 0, namespace: 0 });
  });

  test("keeps Artifact-dependent protected routes gated", async () => {
    const dependencies = ports({
      conversation: "dm",
      memory: "namespace",
      executor: "native",
    });
    const result = await createProtectedTaskCreationAdmissionV1(dependencies)
      .admit(admissionInput(candidate({
        preset: "ask_peer",
        metadata: {
          artifactAwareAskPeer: true,
          artifactRefs: [{ artifactId: "artifact-1", path: "draft.md" }],
          artifactOperationId: "ask-peer-artifacts-v1:peer:artifact-1",
        },
      })));

    expect(result).toEqual({
      kind: "unavailable",
      reason: "task_shape_unsupported",
    });
    expect(dependencies.calls).toEqual({ shape: 0, namespace: 0 });
  });

  test("rejects every protected child signal before any product resolution", async () => {
    const attempts: readonly [string, TaskCreateInput, TaskCreationProvenance][] = [
      [
        "caller lineage",
        candidate({ parentTaskId: TASK, depth: 1 }),
        createHumanApiTaskCreationProvenance({ ownerId: HUMAN }),
      ],
      [
        "invalid negative depth",
        candidate({ depth: -1 }),
        createHumanApiTaskCreationProvenance({ ownerId: HUMAN }),
      ],
      [
        "HTTP parent",
        candidate(),
        createHumanApiTaskCreationProvenance({
          ownerId: HUMAN,
          requestedParentTaskId: TASK,
        }),
      ],
      [
        "background provenance despite reset caller lineage",
        candidate({ parentTaskId: null, depth: 0 }),
        createAgentTurnTaskCreationProvenance({
          ownerId: HUMAN,
          invocation: {
            ownerId: HUMAN,
            roomId: ROOM,
            entrypoint: "background.task",
            taskId: TASK,
            taskRunId: RUN,
          },
        }),
      ],
      [
        "foreground subagent",
        candidate(),
        createAgentTurnTaskCreationProvenance({
          ownerId: HUMAN,
          invocation: {
            ownerId: HUMAN,
            roomId: ROOM,
            entrypoint: "foreground.subagent",
          },
        }),
      ],
      [
        "Task report-back",
        candidate(),
        createAgentTurnTaskCreationProvenance({
          ownerId: HUMAN,
          invocation: {
            ownerId: HUMAN,
            roomId: ROOM,
            entrypoint: "foreground.task_report_back",
          },
        }),
      ],
    ];

    for (const [label, value, provenance] of attempts) {
      const dependencies = ports();
      const result = await createProtectedTaskCreationAdmissionV1(dependencies)
        .admit(admissionInput(value, provenance));
      expect(result, label).toEqual({
        kind: "unavailable",
        reason: "nested_task_unsupported",
      });
      expect(dependencies.calls, label).toEqual({ shape: 0, namespace: 0 });
    }
  });

  test.each(["background.task", "foreground.task_report_back", "foreground.subagent"] as const)(
    "server-authored %s provenance retains its exact parent Task and run",
    (entrypoint) => {
      const provenance = createAgentTurnTaskCreationProvenance({
        ownerId: HUMAN,
        invocation: {
          ownerId: HUMAN,
          roomId: ROOM,
          entrypoint,
          taskId: TASK,
          taskRunId: RUN,
        },
      });
      expect(provenance).toMatchObject({
        kind: "agent_turn",
        parentTaskId: TASK,
        parentTaskRunId: RUN,
      });
    },
  );

  test("rejects missing positive origin and Artifact-dependent creation", async () => {
    const missingOriginPorts = ports();
    const missingOrigin = await createProtectedTaskCreationAdmissionV1(
      missingOriginPorts,
    ).admit(admissionInput(candidate(), createAgentTurnTaskCreationProvenance({
      ownerId: HUMAN,
      invocation: null,
    })));
    expect(missingOrigin).toEqual({
      kind: "unavailable",
      reason: "creation_origin_unavailable",
    });
    expect(missingOriginPorts.calls).toEqual({ shape: 0, namespace: 0 });

    const artifactPorts = ports();
    const artifact = await createProtectedTaskCreationAdmissionV1(artifactPorts)
      .admit(admissionInput(candidate(), createArtifactEventTaskCreationProvenance({
        ownerId: HUMAN,
        artifactId: "artifact-private-source",
        roomId: ROOM,
      })));
    expect(artifact).toEqual({
      kind: "unavailable",
      reason: "task_shape_unsupported",
    });
    expect(artifactPorts.calls).toEqual({ shape: 0, namespace: 0 });
  });

  test("surfaces exact execution and requester-private Namespace failures", async () => {
    const missingExecution: ProtectedTaskCreationAuthorityPortsV1 = {
      resolveExecutionShape: async () => ({
        status: "unavailable",
        reason: "execution_namespace_unavailable",
      }),
      resolveRequesterPrivateNamespace: async () => {
        throw new Error("must not resolve content custody");
      },
    };
    expect(await createProtectedTaskCreationAdmissionV1(missingExecution)
      .admit(admissionInput(candidate()))).toEqual({
      kind: "unavailable",
      reason: "execution_namespace_unavailable",
    });

    const missingNamespace = ports();
    missingNamespace.resolveRequesterPrivateNamespace = async () => ({
      status: "unavailable",
      reason: "requester_private_namespace_unavailable",
    });
    expect(await createProtectedTaskCreationAdmissionV1(missingNamespace)
      .admit(admissionInput(candidate()))).toEqual({
      kind: "unavailable",
      reason: "content_namespace_unavailable",
    });
  });
});
