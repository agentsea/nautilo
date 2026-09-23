import { describe, expect, mock, test } from "bun:test";
import type { FastifyRequest } from "fastify";
import {
  createMaintenanceAcceptanceAuthority,
} from "@nautilo/runtime";
import { executeAgentMediatedRoomMessage } from "../../src/messaging/agent-mediated";
import type { ChatRoutesDeps } from "../../src/routes/chat";
import { createAcceptedInvocationAuthority } from "@nautilo/trust";

describe("D420 group-conductor continuation authority", () => {
  test("forwards accepted-work authority to the foreground Job admission seam", async () => {
    const authority = createMaintenanceAcceptanceAuthority();
    const invocationAuthority = createAcceptedInvocationAuthority("test-user");
    const createForegroundJob = mock(async () => ({
      id: "virtual-job",
      virtualJobId: "virtual-job",
    }));
    const deps = {
      createForegroundJob,
      loadRoomRoster: async () => [],
      assertInvocation: async () => {},
    } as unknown as ChatRoutesDeps;
    const request = {
      sessionUserId: "test-user",
      sessionActorId: "",
      memoryEnvelope: null,
      policyContext: null,
      ip: "127.0.0.1",
      headers: {},
      body: {},
    } as FastifyRequest;

    await executeAgentMediatedRoomMessage({
      request,
      deps,
      content: "accepted group turn",
      voiceMode: false,
      currentFolder: null,
      workspacePath: null,
      activeMiniApp: null,
      attachmentRefs: [],
      artifactRefs: [],
      canonicalRoomId: "room-id",
      canonicalAgentId: "agent-id",
      canonicalGraphThreadId: "room:room-id:bot:agent-id",
      canonicalRoomRoster: [],
      canonicalLaneKey: "room:room-id:user:user-id:bot:agent-id",
      acceptanceAuthority: authority,
      invocationAuthority,
    });

    const call = createForegroundJob.mock.calls[0] as unknown[];
    expect(call[5]).toBe(authority);
    expect(call[6]).toMatchObject({
      coalescing: "coalesce",
      coalescingBoundary: "exact-client",
      contention: "fork",
    });
    expect(call[7]).toBe(invocationAuthority);
  });

  test("keeps foreground-session authority out of Job JSON and selects one separate fork-capable turn", async () => {
    const humanTurnId = "human-turn-live";
    const operationId = "operation-live";
    const authorizationDigest = new Uint8Array([1, 2, 3]);
    const authoritySetDigest = new Uint8Array([4, 5, 6]);
    const capability = Object.freeze({
      kind: "foreground_session" as const,
      sessionReference: "session-reference",
      authorizationDigest,
      scope: Object.freeze({
        subjectHumanId: "human-id",
        issuingDeviceId: "device-id",
        recipientAgentId: "agent-id",
        sessionId: "session-id",
        roomId: "room-id",
        policyRevision: 1,
        hostAuthorizationRevision: 1,
        agentAuthorizationRevision: 1,
        namespaceIds: Object.freeze(["namespace-id"]),
        grantDomainIds: Object.freeze(["domain-id"]),
        domainAuthoritySetDigest: authoritySetDigest,
      }),
    });
    const createForegroundJob = mock(async () => ({
      id: "virtual-live",
      virtualJobId: "virtual-live",
    }));
    const request = {
      sessionUserId: "test-user",
      sessionActorId: "human-id",
      memoryEnvelope: null,
      policyContext: null,
      ip: "127.0.0.1",
      headers: {},
      body: {},
    } as FastifyRequest;

    await executeAgentMediatedRoomMessage({
      request,
      deps: { createForegroundJob, loadRoomRoster: async () => [], assertInvocation: async () => {} } as unknown as ChatRoutesDeps,
      content: "opened protected text",
      voiceMode: false,
      currentFolder: null,
      workspacePath: null,
      activeMiniApp: null,
      attachmentRefs: [],
      artifactRefs: [],
      canonicalRoomId: "room-id",
      canonicalAgentId: "agent-id",
      canonicalGraphThreadId: "room:room-id:bot:agent-id",
      canonicalRoomRoster: [],
      canonicalLaneKey: "room:room-id:user:test-user:bot:agent-id",
      sharedTurnId: humanTurnId,
      liveShadowOperationId: operationId,
      humanAlreadyPersisted: true,
      currentMessageId: 42,
      liveShadowCapability: capability,
      liveShadowDataOperationPolicy: {
        resolve: async () => ({
          policy: { mode: "shadow_encryption" as const, shadowBehavior: "fallback" as const },
          revalidationToken: 1,
        }),
        revalidate: async () => {},
      },
      invocationAuthority: createAcceptedInvocationAuthority("test-user"),
    });

    const call = createForegroundJob.mock.calls[0] as unknown[];
    expect(call[3]).toMatchObject({
      message: "opened protected text",
      turnId: humanTurnId,
      humanAlreadyPersisted: true,
      currentMessageId: 42,
    });
    expect(JSON.stringify(call[3])).not.toContain("session-reference");
    expect(call[6]).toMatchObject({
      coalescing: "separate",
      contention: "fork",
    });
    expect(call[6]).toHaveProperty("executor");
    const candidate = call[8] as {
      onMainTurn(turnId: string): void;
      onIneligible(): void;
    };
    candidate.onMainTurn(humanTurnId);
    candidate.onIneligible();
    expect([...authorizationDigest]).toEqual([0, 0, 0]);
    expect([...authoritySetDigest]).toEqual([0, 0, 0]);
  });
});
