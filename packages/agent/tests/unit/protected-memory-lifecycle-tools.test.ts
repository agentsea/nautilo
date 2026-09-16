import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { NamespaceMemoryEnvelope } from "@nautilo/trust";

import { createAddMemoryToScopeTool } from "../../src/tools/memory/add-memory-to-scope";
import { createCloseScopeTool } from "../../src/tools/memory/close-scope";
import { createCreateScopeTool } from "../../src/tools/memory/create-scope";
import type {
  ProtectedAgentMemoryAccessPort,
  ProtectedAgentMemoryScopeLifecyclePort,
} from "../../src/tools/memory/protected-memory-ports";
import {
  computeShareMemoryApprovalPreview,
  createShareMemoryTool,
} from "../../src/tools/memory/share-memory";
import * as shareApprovalPreview from "../../src/post-model/share-approval-preview";
import {
  _resetAuthoredMemorySemanticChangeSinkForTests,
  installAuthoredMemorySemanticChangeSink,
  type AuthoredMemorySemanticChange,
} from "../../src/store/authored-memory-semantic-change";

const USER = "11111111-1111-4111-8111-111111111111";
const ACTOR = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const NAMESPACE = "44444444-4444-4444-8444-444444444444";
const MEMORY = "55555555-5555-4555-8555-555555555555";
const SCOPE = "66666666-6666-4666-8666-666666666666";

function envelope(): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId: USER,
    actorId: ACTOR,
    agentId: AGENT,
    roomId: "room-protected",
    readableNamespaces: [NAMESPACE],
    mutableNamespaces: [NAMESPACE],
    writableNamespaces: [NAMESPACE],
    toolPolicy: {},
  };
}

const config = {
  configurable: { memoryToolMutationRequestId: "tool-call-protected" },
};

describe("protected foreground Memory lifecycle tools", () => {
  afterEach(() => {
    _resetAuthoredMemorySemanticChangeSinkForTests();
  });

  test("routes attach sharing through exact access without touching legacy product helpers", async () => {
    const changes: AuthoredMemorySemanticChange[] = [];
    installAuthoredMemorySemanticChangeSink(async (change) => {
      changes.push(change);
    });
    const seen: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0][] = [];
    const access: ProtectedAgentMemoryAccessPort = {
      prepareApproval: async (input) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId: "approval-ref",
          toolCallId: input.toolCallId, requesterUserId: USER, agentId: AGENT },
        preview: { type: "fact", content: "protected payload" },
      } }),
      change: async (input) => {
        seen.push(input);
        return {
          status: "success",
          value: { status: "updated", memoryId: input.memoryId },
        };
      },
    };
    const tool = createShareMemoryTool({
      userId: USER,
      memoryAccessEnvelope: envelope(),
      protectedMemoryAccessPort: access,
    });
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    await computeShareMemoryApprovalPreview({ name: "share_memory", id: "tool-call-protected",
      args: { memory_id: MEMORY, target_handle: "@bob", sensitivity: "sensitive" } }, {
      userId: USER, memoryAccessEnvelope: envelope(), protectedMemoryAccessPort: access,
    });

    expect(String(await tool.invoke({
      mode: "attach",
      memory_id: MEMORY,
      target_handle: "@bob",
      sensitivity: "sensitive",
    }, config))).toContain(`Shared memory ${MEMORY} with @bob`);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      memoryId: MEMORY,
      action: { kind: "grant_user", userHandle: "bob" },
      authority: {
        mode: "namespace", subjectUserId: USER, agentId: AGENT,
        readableNamespaceIds: [NAMESPACE],
        mutableNamespaceIds: [NAMESPACE], writableNamespaceId: NAMESPACE,
      },
    });
    expect(seen[0]!.operationId).toMatch(/^memory:v1:[0-9a-f]{64}$/);
    expect(seen[0]!.approvalReference).toMatchObject({
      referenceId: "approval-ref", requesterUserId: USER, agentId: AGENT,
    });
    expect(changes).toEqual([{
      memoryId: MEMORY,
      changeKind: "scope",
      changeRef: `memory-change:stable:${seen[0]!.operationId}`,
    }]);
    target.mockRestore();
  });

  test("keeps unavailable, replay, and post-commit signaling outcomes truthful", async () => {
    let outcome: "unavailable" | "replayed" = "unavailable";
    const access: ProtectedAgentMemoryAccessPort = {
      prepareApproval: async (input) => ({ status: "success", value: {
        reference: { referenceVersion: 1, referenceId: `approval-${input.toolCallId}`,
          toolCallId: input.toolCallId, requesterUserId: USER, agentId: AGENT },
        preview: { type: "fact", content: "protected payload" },
      } }),
      change: async (input) => outcome === "unavailable"
        ? { status: "unavailable", reason: "stale_revision" }
        : { status: "success", value: {
            status: "replayed", memoryId: input.memoryId,
          } },
    };
    const context = {
      userId: USER,
      memoryAccessEnvelope: envelope(),
      protectedMemoryAccessPort: access,
    };
    const tool = createShareMemoryTool(context);
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const args = {
      mode: "attach" as const,
      memory_id: MEMORY,
      target_handle: "@bob",
      sensitivity: "sensitive" as const,
    };
    const prepare = (toolCallId: string) => computeShareMemoryApprovalPreview({
      name: "share_memory", id: toolCallId, args,
    }, context);
    const invoke = (toolCallId: string) => tool.invoke(args, {
      configurable: { memoryToolMutationRequestId: toolCallId },
    });

    try {
      await prepare("tool-call-unavailable");
      expect(invoke("tool-call-unavailable")).rejects.toMatchObject({
        name: "ProtectedMemoryToolUnavailableError",
        reason: "stale_revision",
      });

      outcome = "replayed";
      installAuthoredMemorySemanticChangeSink(async () => {
        throw new Error("notification delivery failed after commit");
      });
      await prepare("tool-call-replayed");
      expect(String(await invoke("tool-call-replayed"))).toBe(
        `Shared memory ${MEMORY} with @bob (replayed).`,
      );
    } finally {
      target.mockRestore();
    }
  });

  test("keeps same-target approvals isolated by the exact tool call", async () => {
    const preparedCallIds: string[] = [];
    const seen: Parameters<ProtectedAgentMemoryAccessPort["change"]>[0][] = [];
    const access: ProtectedAgentMemoryAccessPort = {
      prepareApproval: async (input) => {
        preparedCallIds.push(input.toolCallId);
        return { status: "success", value: {
          reference: { referenceVersion: 1,
            referenceId: `approval-${input.toolCallId}`,
            toolCallId: input.toolCallId, requesterUserId: USER, agentId: AGENT },
          preview: { type: "fact", content: "protected payload" },
        } };
      },
      change: async (input) => {
        seen.push(input);
        return { status: "success",
          value: { status: "updated", memoryId: input.memoryId } };
      },
    };
    const context = {
      userId: USER,
      memoryAccessEnvelope: envelope(),
      protectedMemoryAccessPort: access,
    };
    const tool = createShareMemoryTool(context);
    const target = spyOn(
      shareApprovalPreview,
      "resolveLocalShareTargetByHandle",
    ).mockResolvedValue(null);
    const toolCall = (id: string) => ({ name: "share_memory", id,
      args: { memory_id: MEMORY, target_handle: "@bob", sensitivity: "sensitive" } });
    const invoke = (toolCallId: string) => tool.invoke({
      mode: "attach",
      memory_id: MEMORY,
      target_handle: "@bob",
      sensitivity: "sensitive",
    }, { configurable: { memoryToolMutationRequestId: toolCallId } });

    try {
      await Promise.all([
        computeShareMemoryApprovalPreview(toolCall("tool-call-a"), context),
        computeShareMemoryApprovalPreview(toolCall("tool-call-b"), context),
      ]);
      expect(preparedCallIds).toEqual(["tool-call-a", "tool-call-b"]);

      expect(invoke("tool-call-wrong")).rejects.toMatchObject({
        reason: "authorization_required",
      });
      expect(seen).toHaveLength(0);

      expect(String(await invoke("tool-call-a"))).toContain(
        `Shared memory ${MEMORY} with @bob`,
      );
      expect(String(await invoke("tool-call-b"))).toContain(
        `Shared memory ${MEMORY} with @bob`,
      );
      expect(seen.map((request) => ({
        toolCallId: request.approvalReference?.toolCallId,
        referenceId: request.approvalReference?.referenceId,
      }))).toEqual([
        { toolCallId: "tool-call-a", referenceId: "approval-tool-call-a" },
        { toolCallId: "tool-call-b", referenceId: "approval-tool-call-b" },
      ]);
    } finally {
      target.mockRestore();
    }
  });

  test("routes create, seed attachment, and close through one explicit scope port", async () => {
    const calls: string[] = [];
    const scope: ProtectedAgentMemoryScopeLifecyclePort = {
      create: async () => {
        calls.push("create");
        return { status: "success", value: { scopeId: SCOPE, name: "research" } };
      },
      attachSeed: async () => {
        calls.push("attachSeed");
        return { status: "success", value: {
          status: "attached", scopeName: "research",
        } };
      },
      close: async () => {
        calls.push("close");
        return { status: "success", value: {
          status: "closing", scopeId: SCOPE, transitionCount: 2,
        } };
      },
    };
    const context = {
      memoryAccessEnvelope: envelope(),
      protectedMemoryScopeLifecyclePort: scope,
    };

    expect(JSON.parse(String(await createCreateScopeTool(context).invoke({
      name: "research", purpose: "bounded",
    }, config)))).toEqual({ scope_id: SCOPE, name: "research" });
    expect(String(await createAddMemoryToScopeTool(context).invoke({
      memory_id: MEMORY, scope_id: SCOPE,
    }, config))).toContain("Attached memory");
    expect(JSON.parse(String(await createCloseScopeTool(context).invoke({
      scope_id: SCOPE,
    }, config)))).toEqual({
      status: "closing", scope_id: SCOPE, transition_count: 2,
    });
    expect(calls).toEqual(["create", "attachSeed", "close"]);
  });

  test("preserves remove as archive and exposes no Agent delete operation", () => {
    const shareSchema = createShareMemoryTool().schema;
    expect(JSON.stringify(shareSchema)).not.toContain("delete");
    const scopePort = {} as ProtectedAgentMemoryScopeLifecyclePort;
    expect(Object.keys(scopePort)).not.toContain("delete");
  });
});
