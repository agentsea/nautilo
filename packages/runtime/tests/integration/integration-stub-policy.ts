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

function emptyEnvelope(
  ownerId: string,
  actorId: string,
  agentId: string,
): NamespaceMemoryEnvelope {
  return {
    memoryMode: "namespace",
    ownerId,
    actorId,
    agentId,
    roomId: "",
    readableNamespaces: [],
    mutableNamespaces: [],
    writableNamespaces: [],
    toolPolicy: {},
  };
}

function stubContext(
  ownerId: string,
  actorId: string,
  agentId: string,
): RuntimePolicyContext {
  const memoryAccess = emptyEnvelope(ownerId, actorId, agentId);
  return {
    laneKey: "app:default",
    actorId,
    agentId,
    roomId: "",
    roomType: "",
    graphThreadId: "app:default",
    actorLabel: "integration-test",
    actorFederatedId: "",
    agentFederatedId: "",
    speakerTrust: "verified",
    laneScope: "private",
    actorRole: "owner",
    memoryAccess,
  };
}

/**
 * Minimal {@link PolicyResolver} for `langgraphExecutor` integration tests.
 * Production boots `PersonalPolicyResolver` + full trust seed; these tests
 * only need `post_model` to approve tool calls without a Postgres trust graph.
 */
export function createIntegrationStubPolicyResolver(ownerId: string): PolicyResolver {
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
      _tool: ToolCall,
      _envelope?: MemoryAccessEnvelope | null,
    ): Promise<ToolAccessDecision> {
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
