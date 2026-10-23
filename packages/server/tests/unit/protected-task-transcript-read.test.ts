import { describe, expect, test } from "bun:test";
import Fastify from "fastify";
import type {
  RoomHistoryShadowReadReadyResponseV1,
} from "@nautilo/api-client";
import type {
  ProtectedTaskRunTranscriptIndexRead,
} from "@nautilo/db";

import {
  createProtectedTaskTranscriptReadService,
  protectedTaskTranscriptReadRoutes,
} from "../../src/routes/protected-task-transcript-read";

const ids = Object.freeze({
  task: "10000000-0000-4000-8000-000000000001",
  run: "20000000-0000-4000-8000-000000000002",
  agent: "30000000-0000-4000-8000-000000000003",
  owner: "40000000-0000-4000-8000-000000000004",
  requester: "40000000-0000-4000-8000-000000000014",
  actor: "50000000-0000-4000-8000-000000000005",
  room: "60000000-0000-4000-8000-000000000006",
  namespace: "70000000-0000-4000-8000-000000000007",
  session: "80000000-0000-4000-8000-000000000008",
});
const DIGEST = "A".repeat(43);
const createdAt = new Date("2026-10-09T12:00:00.000Z");

function index(
  overrides: Partial<Extract<ProtectedTaskRunTranscriptIndexRead, {
    status: "ready";
  }>> = {},
): Extract<ProtectedTaskRunTranscriptIndexRead, { status: "ready" }> {
  return {
    status: "ready",
    source: { kind: "task_target", roomId: ids.room },
    rows: [{
      sessionId: ids.session,
      roomId: ids.room,
      messageId: 41,
      editRevision: 0,
      role: "assistant",
      createdAt,
    }],
    nextAfterMessageId: null,
    ...overrides,
  };
}

function history(
  messageId = 41,
  roomId: string = ids.room,
): RoomHistoryShadowReadReadyResponseV1 {
  const coordinate = {
    sessionId: ids.session,
    messageId,
    editRevision: 0,
    role: "assistant" as const,
    logicalMessageKey: `row:${messageId}`,
  };
  return {
    responseVersion: 1,
    status: "ready",
    operationId: "task-transcript-read:one",
    clientRequestKey: "task-transcript-page:one",
    selectedCoordinateDigestBase64url: DIGEST,
    selectedCount: 1,
    selectedCoordinates: [coordinate],
    eligibleCount: 1,
    authority: {
      scheme: "domain_key_v2",
      keyClass: "ai",
      subjectHumanId: ids.actor,
      readerDeviceId: "device:one",
      readerDeviceSigningKeyGeneration: 1,
      hostAuthorizationRevision: 0,
      policyRevision: 1,
      roomId,
      namespaceId: ids.namespace,
      namespaceAccessRevision: 0,
      namespaceCurrentGeneration: 1,
      namespaceHeadDigestBase64url: DIGEST,
      domainId: "domain:one",
      domainKeyGeneration: 1,
      domainAuthorizationRevision: 1,
      domainHeadDigestBase64url: DIGEST,
      namespaceBundleRevision: 1,
      namespaceBundleDigestBase64url: DIGEST,
    },
    records: [{
      kind: "existing_representation",
      representationMode: "protected-only",
      coordinate,
      selectedSource: { role: "assistant", authorAgentId: ids.agent },
      protectedMessage: {
        dtoVersion: 2,
        projection: {
          messageId: String(messageId),
          logicalMessageKey: `row:${messageId}`,
          sessionId: ids.session,
          roomId,
          namespaceId: ids.namespace,
          role: "assistant",
          createdAt: createdAt.toISOString(),
          editRevision: 0,
        },
        protectedPayload: {
          status: "pending",
          reason: "shadow_pending",
        },
      },
      repair: {
        identityDigestBase64url: DIGEST,
        allocationDigestBase64url: DIGEST,
        attestationDigestBase64url: DIGEST,
        publisherSignerKeyId: "signer:one",
        publisherSigningPublicKeyBase64url: DIGEST,
      },
    }],
    signerEvidence: [],
    terminalExecutions: [],
    acknowledgement: { status: "already_recorded" },
  };
}

function request(overrides: Partial<Readonly<{
  cursor: string;
  limit: number;
}>> = {}) {
  return {
    taskId: ids.task,
    taskRunId: ids.run,
    agentId: ids.agent,
    viewerUserId: ids.owner,
    viewerActorId: ids.actor,
    historyRead: {
      requestVersion: 1 as const,
      clientRequestKey: "task-transcript-page:one",
      readerDeviceId: "device:one",
    },
    ...overrides,
  };
}

describe("protected Task transcript read service", () => {
  test("projects only the exact bounded TaskRun coordinates", async () => {
    const calls: unknown[] = [];
    const service = createProtectedTaskTranscriptReadService({
      db: {} as never,
      history: {
        project: async input => {
          calls.push(input);
          return history();
        },
        acknowledge: async () => null,
      },
    }, {
      readIndex: async (_db, input) => {
        calls.push(input);
        return index();
      },
      resolveRequesterPrivateRoom: async () => null,
      now: () => createdAt.getTime(),
    });

    const result = await service.read(request());
    expect(result).toMatchObject({
      status: "ready",
      taskId: ids.task,
      taskRunId: ids.run,
      agentId: ids.agent,
      sourceRoomId: ids.room,
      entries: [{ messageId: "41", role: "assistant" }],
      nextCursor: null,
      history: { status: "ready" },
    });
    expect(calls[0]).toMatchObject({
      taskId: ids.task,
      taskRunId: ids.run,
      agentId: ids.agent,
      viewerUserId: ids.owner,
      viewerActorId: ids.actor,
      limit: 50,
    });
    expect(calls[1]).toMatchObject({
      roomId: ids.room,
      selectedCoordinates: [{
        sessionId: ids.session,
        messageId: 41,
        logicalMessageKey: "row:41",
      }],
    });
    await Promise.resolve(expect(service.read(request({ limit: 51 })))
      .rejects.toThrow("limit is invalid"));
  });

  test("rechecks the canonical requester private Room for a roomless Task", async () => {
    let historyReads = 0;
    const privateIndex = index({
      source: {
        kind: "requester_private",
        requesterUserId: ids.requester,
        roomId: ids.room,
        namespaceId: ids.namespace,
      },
    });
    const service = createProtectedTaskTranscriptReadService({
      db: {} as never,
      history: {
        project: async () => {
          historyReads += 1;
          return history();
        },
        acknowledge: async () => null,
      },
    }, {
      readIndex: async () => privateIndex,
      resolveRequesterPrivateRoom: async (userId, agentId, namespaceId) => {
        expect({ userId, agentId, namespaceId }).toEqual({
          userId: ids.requester,
          agentId: ids.agent,
          namespaceId: ids.namespace,
        });
        return { roomId: ids.room, namespaceId: ids.namespace };
      },
    });
    expect(await service.read(request())).toMatchObject({ status: "ready" });
    expect(historyReads).toBe(1);

    const changed = createProtectedTaskTranscriptReadService({
      db: {} as never,
      history: {
        project: async () => {
          throw new Error("must not project changed Room authority");
        },
        acknowledge: async () => null,
      },
    }, {
      readIndex: async () => privateIndex,
      resolveRequesterPrivateRoom: async () => null,
    });
    expect(await changed.read(request())).toMatchObject({
      status: "unavailable",
      reason: "authority_changed",
    });
  });

  test("rejects substituted Room records and never returns unrelated rows", async () => {
    for (const projected of [history(42), history(41,
      "90000000-0000-4000-8000-000000000009")]) {
      const service = createProtectedTaskTranscriptReadService({
        db: {} as never,
        history: {
          project: async () => projected,
          acknowledge: async () => null,
        },
      }, {
        readIndex: async () => index(),
        resolveRequesterPrivateRoom: async () => null,
      });
      expect(await service.read(request())).toMatchObject({
        status: "unavailable",
        reason: "integrity_failure",
      });
    }
  });

  test("fences a Task association change after history projection", async () => {
    let reads = 0;
    const service = createProtectedTaskTranscriptReadService({
      db: {} as never,
      history: {
        project: async () => history(),
        acknowledge: async () => null,
      },
    }, {
      readIndex: async () => {
        reads += 1;
        return reads === 1 ? index() : index({
          rows: [{ ...index().rows[0]!, editRevision: 1 }],
        });
      },
      resolveRequesterPrivateRoom: async () => null,
    });
    expect(await service.read(request())).toMatchObject({
      status: "unavailable",
      reason: "authority_changed",
    });
    expect(reads).toBe(2);
  });

  test("binds cursors to exact Task, run, and Agent coordinates", async () => {
    const after: number[] = [];
    const service = createProtectedTaskTranscriptReadService({
      db: {} as never,
      history: {
        project: async () => history(),
        acknowledge: async () => null,
      },
    }, {
      readIndex: async (_db, input) => {
        after.push(input.afterMessageId ?? 0);
        return index({ nextAfterMessageId: input.afterMessageId === undefined
          ? 41
          : null });
      },
      resolveRequesterPrivateRoom: async () => null,
    });
    const first = await service.read(request());
    expect(first?.status).toBe("ready");
    if (first?.status !== "ready" || first.nextCursor === null) {
      throw new Error("Expected a bounded transcript continuation");
    }
    expect(await service.read(request({ cursor: first.nextCursor })))
      .toMatchObject({ status: "ready", nextCursor: null });
    expect(after).toEqual([0, 0, 41, 41]);

    const decoded = JSON.parse(Buffer.from(
      first.nextCursor,
      "base64url",
    ).toString("utf8")) as unknown[];
    decoded[2] = "20000000-0000-4000-8000-000000000099";
    const substituted = Buffer.from(JSON.stringify(decoded)).toString("base64url");
    await Promise.resolve(expect(service.read(request({ cursor: substituted })))
      .rejects.toThrow("cursor is invalid"));
  });
});

describe("protected Task transcript read route", () => {
  test("keeps cross-user/run/Agent identities indistinguishable", async () => {
    const app = Fastify();
    app.addHook("preHandler", async request => {
      request.sessionUserId = typeof request.headers["x-viewer"] === "string"
        ? request.headers["x-viewer"]
        : ids.owner;
      request.sessionActorId = ids.actor;
    });
    protectedTaskTranscriptReadRoutes(app, {
      read: async input => input.taskRunId === ids.run
          && input.agentId === ids.agent
          && input.viewerUserId === ids.owner
        ? {
            readVersion: 1,
            status: "waiting",
            taskId: input.taskId,
            taskRunId: input.taskRunId,
            agentId: input.agentId,
            reason: "transcript_not_mapped",
          }
        : null,
    });
    const read = async (overrides: Partial<Readonly<{
      run: string;
      agent: string;
      viewer: string;
    }>> = {}) => app.inject({
      method: "POST",
      url: `/api/tasks/${ids.task}/runs/${overrides.run ?? ids.run}/transcript-v1`,
      headers: { "x-viewer": overrides.viewer ?? ids.owner },
      payload: {
        readVersion: 1,
        agentId: overrides.agent ?? ids.agent,
        historyRead: {
          requestVersion: 1,
          clientRequestKey: "task-transcript-page:one",
          readerDeviceId: "device:one",
        },
      },
    });
    expect((await read()).statusCode).toBe(200);
    for (const response of await Promise.all([
      read({ viewer: ids.requester }),
      read({ run: "20000000-0000-4000-8000-000000000022" }),
      read({ agent: "30000000-0000-4000-8000-000000000033" }),
    ])) {
      expect(response.statusCode).toBe(404);
      expect(response.json<{ error: string }>()).toEqual({
        error: "Task not found",
      });
    }
    await app.close();
  });
});
