import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { ToolCall } from "@langchain/core/messages/tool";
import type {
  ProtectedAgentMemoryAccessPort,
} from "@nautilo/lattice-bridge";

import type { NautiloState } from "../../src/agent/state";
import { interruptToolEntry } from "../../src/nodes/post-model";
import * as shareApprovalPreview from
  "../../src/post-model/share-approval-preview";
import {
  bindDeniedProtectedMemoryAccessSnapshot,
  findProtectedMemoryAccessSnapshot,
  preflightProtectedMemoryAccessShareCalls,
  protectedMemoryAccessApprovalPreview,
  restoreProtectedMemoryAccessSnapshot,
} from "../../src/tools/memory/protected-task-access-sharing";
import { protectedMemoryToolOperationId } from
  "../../src/tools/memory/protected-memory-ports";
import { createShareMemoryTool } from
  "../../src/tools/memory/share-memory";

const TOOL_CALL: ToolCall = {
  id: "share-call",
  name: "share_memory",
  args: {
    memory_id: "private-memory",
    target_handle: "@recipient",
    sensitivity: "sensitive",
  },
};

function state(): NautiloState {
  return {
    taskRun: true,
    subagentRun: true,
    trustedExecutionEntrypoint: "background.task",
    currentTaskId: "task-1",
    currentTaskRunId: "run-1",
    currentThreadId: "thread-1",
    langgraphThreadId: "thread-1",
    userId: "task-owner",
    causalHumanUserId: "requester-user",
    agentId: "agent-1",
    memoryAccessEnvelope: {
      ownerId: "requester-user",
      actorId: "requester-actor",
      agentId: "agent-1",
      roomId: "room-1",
      readableNamespaces: ["source-namespace"],
      mutableNamespaces: ["source-namespace"],
      writableNamespaces: ["source-namespace"],
      toolPolicy: {},
    },
    messages: [],
  } as unknown as NautiloState;
}

function reference() {
  return Object.freeze({
    referenceVersion: 1 as const,
    referenceId: "access-reference",
    toolCallId: TOOL_CALL.id!,
    requesterUserId: "requester-user",
    agentId: "agent-1",
    taskContinuation: Object.freeze({
      kind: "protected_task_v1" as const,
      requesterActorId: "requester-actor",
      createdAt: 1,
      sealedPreparation: "opaque-ciphertext",
    }),
  });
}

function port(
  overrides: Partial<ProtectedAgentMemoryAccessPort> = {},
): ProtectedAgentMemoryAccessPort {
  return {
    prepareApproval: async () => ({
      status: "success",
      value: {
        reference: reference(),
        preview: { type: "protected-note", content: "private preview text" },
      },
    }),
    restoreApproval: async () => ({
      status: "success",
      value: { type: "protected-note", content: "private preview text" },
    }),
    change: async () => ({
      status: "success",
      value: { status: "updated", memoryId: "private-memory" },
    }),
    ...overrides,
  };
}

describe("protected Task Memory access preflight", () => {
  const restores: Array<() => void> = [];

  afterEach(() => {
    while (restores.length) restores.pop()!();
  });

  function stubTargetPreview(): void {
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue({
      userId: "recipient-user",
      actorId: "recipient-actor",
      displayName: "Recipient",
    });
    const room = spyOn(
      shareApprovalPreview,
      "resolveShareApprovalTargetRoomPreview",
    ).mockResolvedValue({
      targetDisplayName: "Recipient",
      roomLabel: "Requester & Recipient",
      wouldCreate: true,
    });
    restores.push(() => target.mockRestore(), () => room.mockRestore());
  }

  test("checkpoints only a sealed exact reference and uses the final effect id", async () => {
    stubTargetPreview();
    const requests: unknown[] = [];
    const accessPort = port({
      prepareApproval: async request => {
        requests.push(request);
        return {
          status: "success",
          value: {
            reference: reference(),
            preview: {
              type: "protected-note",
              content: "private preview text",
            },
          },
        };
      },
    });
    const result = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [TOOL_CALL],
      accessPort,
    );

    expect(result.rejectedToolCallIds).toEqual([]);
    expect(result.snapshots).toHaveLength(1);
    expect(requests).toEqual([expect.objectContaining({
      operationId: protectedMemoryToolOperationId({
        requestId: TOOL_CALL.id!,
        action: "grant_user",
        subjectId: "private-memory",
      }),
      toolCallId: TOOL_CALL.id,
      memoryId: "private-memory",
      action: { kind: "grant_user", userHandle: "recipient" },
    })]);
    const serialized = JSON.stringify(result.snapshots[0]);
    expect(serialized).not.toContain("private preview text");
    expect(serialized).not.toContain("recipient");
    expect(serialized).toContain("opaque-ciphertext");
    const reloadedSnapshot = structuredClone(result.snapshots[0]!);
    expect(protectedMemoryAccessApprovalPreview(reloadedSnapshot, accessPort))
      .toMatchObject({
        protectedApprovalDigest: "access-reference",
        memoryContentSnippet: "private preview text",
        targetHandle: "recipient",
      });
    expect(protectedMemoryAccessApprovalPreview({
      ...reloadedSnapshot,
      reference: {
        ...reloadedSnapshot.reference,
        taskContinuation: {
          ...reloadedSnapshot.reference.taskContinuation!,
          sealedPreparation: "substituted-ciphertext",
        },
      },
    }, accessPort)).toBeNull();
    const approval = await interruptToolEntry(TOOL_CALL, {
      ...state(),
      protectedMemoryAccessSnapshots: [reloadedSnapshot],
    } as NautiloState, accessPort);
    expect(approval.shareMemoryPreview).toMatchObject({
      protectedApprovalDigest: "access-reference",
      memoryContentSnippet: "private preview text",
    });
    expect(JSON.stringify(approval)).not.toContain("opaque-ciphertext");
    expect(JSON.stringify(approval)).not.toContain("taskContinuation");
    const substituted = await interruptToolEntry({
      ...TOOL_CALL,
      args: { ...TOOL_CALL.args, memory_id: "substituted-memory" },
    }, {
      ...state(),
      protectedMemoryAccessSnapshots: [reloadedSnapshot],
    } as NautiloState, accessPort).then(() => null, (error: unknown) => error);
    expect(substituted).toBeInstanceOf(Error);
    expect((substituted as Error).message).toContain(
      "Memory changed while this operation was running",
    );
    await preflightProtectedMemoryAccessShareCalls(state(), [], accessPort);
    expect(protectedMemoryAccessApprovalPreview(
      reloadedSnapshot,
      accessPort,
    )).toBeNull();
  });

  test("rejects a partial ordinary reference from a restore-capable Task port", async () => {
    const result = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [TOOL_CALL],
      port({
        prepareApproval: async () => ({
          status: "success",
          value: {
            reference: {
              referenceVersion: 1,
              referenceId: "ordinary-reference",
              toolCallId: TOOL_CALL.id!,
              requesterUserId: "requester-user",
              agentId: "agent-1",
            },
            preview: { type: "note", content: "must not escape" },
          },
        }),
      }),
    );
    expect(result.snapshots).toEqual([]);
    expect(result.rejectedToolCallIds).toEqual([TOOL_CALL.id!]);
    expect(JSON.stringify(result)).not.toContain("must not escape");
  });

  test("rejects duplicate protected access call IDs before preparation", async () => {
    let prepares = 0;
    const result = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [
        TOOL_CALL,
        {
          ...TOOL_CALL,
          args: { ...TOOL_CALL.args, target_handle: "@other-recipient" },
        },
      ],
      port({
        prepareApproval: async () => {
          prepares += 1;
          throw new Error("ambiguous calls must not be prepared");
        },
      }),
    );

    expect(prepares).toBe(0);
    expect(result.snapshots).toEqual([]);
    expect(result.rejectedToolCallIds).toEqual([TOOL_CALL.id!]);
    expect(result.messages).toHaveLength(1);
    expect(result.messages[0]?.toolCallId).toBe(TOOL_CALL.id);
    expect(result.messages[0]?.content).toContain(
      "tool-call identity is ambiguous",
    );
  });

  test("rejects a protected access ID colliding with any non-access sibling", async () => {
    let prepares = 0;
    const result = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [
        TOOL_CALL,
        {
          id: "share-call",
          name: "run_shell",
          args: { command: "true" },
        },
      ],
      port({
        prepareApproval: async () => {
          prepares += 1;
          throw new Error("colliding calls must not be prepared");
        },
      }),
    );

    expect(prepares).toBe(0);
    expect(result.snapshots).toEqual([]);
    expect(result.rejectedToolCallIds).toEqual([TOOL_CALL.id!]);
    expect(result.messages).toHaveLength(1);
  });

  test("restores a cloned checkpoint preview under fresh custody", async () => {
    stubTargetPreview();
    const first = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [TOOL_CALL],
      port(),
    );
    const cloned = structuredClone(first.snapshots[0]!);
    let restoresSeen = 0;
    const resumedPort = port({
      restoreApproval: async restored => {
        restoresSeen += 1;
        expect(restored).toMatchObject({
          reference: cloned.reference,
          memoryId: "private-memory",
          action: { kind: "grant_user", userHandle: "recipient" },
        });
        return {
          status: "success",
          value: { type: "protected-note", content: "restored preview" },
        };
      },
    });
    expect(protectedMemoryAccessApprovalPreview(cloned, resumedPort)).toBeNull();
    await restoreProtectedMemoryAccessSnapshot(
      state(),
      TOOL_CALL,
      cloned,
      resumedPort,
    );
    expect(restoresSeen).toBe(1);
    expect(findProtectedMemoryAccessSnapshot({
      protectedMemoryAccessSnapshots: [cloned],
    } as NautiloState, TOOL_CALL)).toBe(cloned);
    const graphReloadedSnapshot = structuredClone(cloned);
    expect(protectedMemoryAccessApprovalPreview(
      graphReloadedSnapshot,
      resumedPort,
    ))
      .toMatchObject({ memoryContentSnippet: "restored preview" });
  });

  test("a denial binds only its exact checkpoint preview across graph reloads", async () => {
    stubTargetPreview();
    const accessPort = port();
    const prepared = await preflightProtectedMemoryAccessShareCalls(
      state(),
      [TOOL_CALL],
      accessPort,
    );
    const checkpointSnapshot = structuredClone(prepared.snapshots[0]!);
    const deniedPreview = protectedMemoryAccessApprovalPreview(
      checkpointSnapshot,
      accessPort,
    )!;
    const resumedPort = port({
      restoreApproval: async () => {
        throw new Error("denial must not reopen Memory");
      },
    });
    bindDeniedProtectedMemoryAccessSnapshot(
      state(),
      TOOL_CALL,
      checkpointSnapshot,
      structuredClone(deniedPreview),
      resumedPort,
    );

    expect(protectedMemoryAccessApprovalPreview(
      structuredClone(checkpointSnapshot),
      resumedPort,
    )).toEqual(deniedPreview);
  });

  test("executes with the exact checkpoint reference and the same final effect id", async () => {
    const changes: unknown[] = [];
    const exactReference = reference();
    const tool = createShareMemoryTool({
      userId: "requester-user",
      memoryAccessEnvelope: state().memoryAccessEnvelope,
      protectedMemoryAccessApprovalReference: exactReference,
      protectedMemoryAccessPort: port({
        change: async request => {
          changes.push(request);
          return {
            status: "success",
            value: { status: "unchanged", memoryId: "private-memory" },
          };
        },
      }),
    });
    const result = await tool.invoke({
      mode: "attach",
      memory_id: "private-memory",
      target_handle: "@recipient",
      sensitivity: "sensitive",
    }, {
      configurable: { memoryToolMutationRequestId: TOOL_CALL.id },
    });
    expect(result).toBe("Memory is already shared with that person.");
    expect(changes).toEqual([expect.objectContaining({
      operationId: protectedMemoryToolOperationId({
        requestId: TOOL_CALL.id!,
        action: "grant_user",
        subjectId: "private-memory",
      }),
      memoryId: "private-memory",
      approvalReference: exactReference,
    })]);
  });
});
