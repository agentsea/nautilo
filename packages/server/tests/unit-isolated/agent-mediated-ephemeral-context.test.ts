import { describe, expect, mock, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import type {
  ActiveMiniAppRequestContext,
  TrustedLiveMiniAppSessionContext,
} from "@nautilo/types";
import { executeAgentMediatedRoomMessage } from "../../src/messaging/agent-mediated";
import type { ChatRoutesDeps } from "../../src/routes/chat";
import {
  createAcceptedInvocationAuthority,
  type AgentInvocationAdmissionInput,
} from "@nautilo/trust";
import {
  ClientActionBindingRegistry,
  installClientActionBindingRegistry,
} from "../../src/realtime/client-action-binding-registry";

function assertExactInvocation(humanUserId: string) {
  return mock(async (input: AgentInvocationAdmissionInput) => {
    expect(input).toEqual({
      humanUserId,
      origin: "room_message",
      agentId: "agent-id",
      roomId: "room-id",
    });
  });
}

describe("agent-mediated ephemeral mini-app context", () => {
  test("clears previous active mini-app and live session when a fresh turn omits them", async () => {
    const jobInputs: Record<string, unknown>[] = [];
    const createForegroundJob = mock(async (...args: unknown[]) => {
      jobInputs.push(args[3] as Record<string, unknown>);
      return {
        id: "virtual-job",
        virtualJobId: "virtual-job",
      };
    });
    const deps = {
      createForegroundJob,
      loadRoomRoster: async () => [],
      assertInvocation: assertExactInvocation("test-user"),
    } as unknown as ChatRoutesDeps;
    const request = {
      sessionUserId: "test-user",
      sessionActorId: "test-actor",
      memoryEnvelope: null,
      policyContext: null,
      ip: "127.0.0.1",
      headers: {},
      body: {},
    } as FastifyRequest;
    const base = {
      request,
      deps,
      voiceMode: false,
      currentFolder: null,
      workspacePath: null,
      attachmentRefs: [],
      artifactRefs: [],
      canonicalRoomId: "room-id",
      canonicalAgentId: "agent-id",
      canonicalGraphThreadId: "room:room-id:bot:agent-id",
      canonicalRoomRoster: [],
      canonicalLaneKey: "room:room-id:user:user-id:bot:agent-id",
      invocationAuthority: createAcceptedInvocationAuthority("test-user"),
    };
    const oldWriterContext: ActiveMiniAppRequestContext = {
      appId: "writer",
      documentPath: "Test_Doc_Nautilo_Writer.html",
      selection: { text: "empty list item near the end" },
      updatedAt: 1,
    };
    const oldWriterSession: TrustedLiveMiniAppSessionContext = {
      sessionToken: "session-token",
      sessionId: "session-id",
      documentVersion: { kind: "artifact_revision", revision: 1 },
      appId: "writer",
      instructions: "Review the current Writer document.",
    };

    await executeAgentMediatedRoomMessage({
      ...base,
      content: "old Writer turn",
      activeMiniApp: oldWriterContext,
      liveMiniAppSession: oldWriterSession,
    });
    await executeAgentMediatedRoomMessage({
      ...base,
      content: "tell me about the focused mobile file",
      activeMiniApp: null,
    });

    const firstJob = jobInputs[0];
    const freshJob = jobInputs[1];
    expect(firstJob).toMatchObject({
      activeMiniApp: oldWriterContext,
      liveMiniAppSession: oldWriterSession,
    });
    expect(freshJob).toMatchObject({
      activeMiniApp: null,
      liveMiniAppSession: null,
      artifactRefs: [],
      focusedResources: [],
    });
  });

  test("threads authenticated Human causality and structured mentions into the job", async () => {
    const jobInputs: Record<string, unknown>[] = [];
    const createForegroundJob = mock(async (...args: unknown[]) => {
      jobInputs.push(args[3] as Record<string, unknown>);
      return { id: "virtual-job", virtualJobId: "virtual-job" };
    });
    const request = {
      sessionUserId: "11111111-1111-4111-8111-111111111111",
      sessionActorId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      memoryEnvelope: null,
      policyContext: null,
      ip: "127.0.0.1",
      headers: {},
      body: {},
    } as FastifyRequest;

    await executeAgentMediatedRoomMessage({
      request,
      deps: {
        createForegroundJob,
        loadRoomRoster: async () => [],
        assertInvocation: assertExactInvocation("11111111-1111-4111-8111-111111111111"),
      } as unknown as ChatRoutesDeps,
      content: "hello @bob",
      voiceMode: false,
      currentFolder: null,
      workspacePath: null,
      activeMiniApp: null,
      attachmentRefs: [],
      artifactRefs: [],
      mentionedHumanUserIds: [
        "22222222-2222-4222-8222-222222222222",
      ],
      canonicalRoomId: "room-id",
      canonicalAgentId: "agent-id",
      canonicalGraphThreadId: "room:room-id:bot:agent-id",
      canonicalRoomRoster: [],
      canonicalLaneKey: "room:room-id:user:user-id:bot:agent-id",
      invocationAuthority: createAcceptedInvocationAuthority(
        "11111111-1111-4111-8111-111111111111",
      ),
    });

    expect(jobInputs[0]).toMatchObject({
      causalHumanUserId: "11111111-1111-4111-8111-111111111111",
      mentionedHumanUserIds: [
        "22222222-2222-4222-8222-222222222222",
      ],
    });
  });

  test("keeps the client session out of Job input and passes only an opaque private candidate", async () => {
    let call: unknown[] | undefined;
    const createForegroundJob = mock(async (...args: unknown[]) => {
      call = args;
      return { id: "virtual-job", virtualJobId: "virtual-job" };
    });
    const registry = new ClientActionBindingRegistry();
    const socket = { on: () => {} };
    const session = "AAAAAAAAAAAAAAAAAAAAAA";
    registry.registerLiveSession({ socket, clientActionSessionId: session, actorId: "actor-a" });
    const uninstall = installClientActionBindingRegistry(registry);
    try {
      await executeAgentMediatedRoomMessage({
        request: {
          sessionUserId: "user-a",
          sessionActorId: "actor-a",
          memoryEnvelope: null,
          policyContext: null,
          ip: "127.0.0.1",
          headers: {},
          body: {},
        } as FastifyRequest,
        deps: {
          createForegroundJob,
          loadRoomRoster: async () => [],
          assertInvocation: assertExactInvocation("user-a"),
        } as unknown as ChatRoutesDeps,
        content: "ordinary direct message",
        voiceMode: false,
        currentFolder: null,
        workspacePath: null,
        activeMiniApp: null,
        attachmentRefs: [],
        artifactRefs: [],
        canonicalRoomId: "room-id",
        canonicalAgentId: "agent-id",
        canonicalGraphThreadId: "thread-id",
        canonicalRoomRoster: [],
        canonicalLaneKey: "lane-id",
        clientActionSessionId: session,
        invocationAuthority: createAcceptedInvocationAuthority("user-a"),
      });
    } finally {
      uninstall();
    }
    expect(call?.[3]).not.toHaveProperty("clientActionSessionId");
    const candidate = call?.[8] as
      | { onMainTurn?: unknown; onIneligible?: unknown }
      | undefined;
    expect(typeof candidate?.onMainTurn).toBe("function");
    expect(typeof candidate?.onIneligible).toBe("function");
  });
});
