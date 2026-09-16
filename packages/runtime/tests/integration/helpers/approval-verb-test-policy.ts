import type { ToolCall } from "@langchain/core/messages/tool";
import type {
  PolicyResolver,
  RuntimePolicyContext,
  MemoryAccessEnvelope,
  NamespaceMemoryEnvelope,
  ToolAccessDecision,
  ApprovalRoute,
  ApprovalRequest,
} from "@nautilo/trust";
import { getBootstrapDefaultAgentId } from "@nautilo/trust";

function emptyEnvelope(ownerId: string, actorId: string, agentId: string): NamespaceMemoryEnvelope {
  return {
    ownerId,
    actorId,
    agentId,
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {
      file: "require_prove_it",
      run_shell: "require_prove_it",
    },
  };
}

function stubContext(ownerId: string, actorId: string, agentId: string): RuntimePolicyContext {
  const memoryAccess = emptyEnvelope(ownerId, actorId, agentId);
  return {
    laneKey: "app:default",
    actorId,
    agentId,
    roomId: "",
    roomType: "",
    graphThreadId: "app:default",
    actorLabel: "m067d-approval-verb",
    actorFederatedId: "",
    agentFederatedId: "",
    speakerTrust: "verified",
    laneScope: "private",
    actorRole: "owner",
    memoryAccess,
  };
}

/**
 * Drives M067D approval-verb integration tests: `discover_tools` is
 * treated as read-only (no interrupt); `file` + `run_shell` require
 * approval and flow through the D061 verb map.
 */
export function createApprovalVerbTestPolicy(ownerId: string): PolicyResolver {
  const fallbackAgentId =
    getBootstrapDefaultAgentId() || "00000000-0000-4000-8000-000000000001";

  return {
    resolveContext(_channel, externalId, agentId) {
      const aid = agentId || fallbackAgentId;
      return Promise.resolve(stubContext(ownerId, externalId, aid));
    },

    buildEnvelope(actorId, _laneKey, agentId) {
      const aid = agentId || fallbackAgentId;
      return Promise.resolve(emptyEnvelope(ownerId, actorId, aid));
    },

    checkToolAccess(
      _actorId: string,
      tool: ToolCall,
      _envelope?: MemoryAccessEnvelope | null,
    ): Promise<ToolAccessDecision> {
      if (tool.name === "discover_tools") {
        return Promise.resolve({ type: "read_only" });
      }
      if (tool.name === "file" || tool.name === "run_shell") {
        return Promise.resolve({
          type: "require_approval",
          route: { type: "prove_it", approvers: [ownerId] },
        });
      }
      return Promise.resolve({ type: "allow" });
    },

    routeApproval(
      _actorId: string,
      _action: string,
      _details: ApprovalRequest,
      _agentId: string,
    ): Promise<ApprovalRoute> {
      return Promise.resolve({ type: "prove_it", approvers: [ownerId] });
    },
  };
}
