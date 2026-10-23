import type { FastifyInstance } from "fastify";
import {
  protectedTaskTranscriptReadRequestV1Schema,
  protectedTaskTranscriptReadResponseV1Schema,
  type ProtectedTaskTranscriptReadResponseV1,
  type RoomHistoryShadowReadReadyResponseV1,
} from "@nautilo/api-client";
import {
  readProtectedTaskRunTranscriptIndex,
  type DirectDatabase,
  type ProtectedTaskRunTranscriptIndexRow,
} from "@nautilo/db";
import {
  HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1,
} from "@nautilo/lattice-crypto/wire";

import type {
  RoomHistoryShadowReadComposition,
} from "./room-history-shadow-read-composition";
import {
  createProtectedTaskRequesterPrivateRoomResolver,
  type ProtectedTaskRequesterPrivateRoomResolver,
} from "./protected-task-requester-private-room";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

type ReadIndex = typeof readProtectedTaskRunTranscriptIndex;

export type ProtectedTaskTranscriptReadInput = Readonly<{
  taskId: string;
  taskRunId: string;
  agentId: string;
  viewerUserId: string;
  viewerActorId: string;
  cursor?: string;
  limit?: number;
  historyRead: Readonly<{
    requestVersion: 1;
    clientRequestKey: string;
    readerDeviceId?: string;
  }>;
}>;

export interface ProtectedTaskTranscriptReadService {
  read(input: ProtectedTaskTranscriptReadInput): Promise<
    ProtectedTaskTranscriptReadResponseV1 | null
  >;
}

type Cursor = Readonly<{
  taskId: string;
  taskRunId: string;
  agentId: string;
  afterMessageId: number;
}>;

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify([
    1,
    cursor.taskId,
    cursor.taskRunId,
    cursor.agentId,
    cursor.afterMessageId,
  ])).toString("base64url");
}

function decodeCursor(value: string, expected: Omit<Cursor, "afterMessageId">): Cursor {
  let parsed: unknown;
  let bytes: Buffer<ArrayBuffer> | undefined;
  try {
    bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) throw new TypeError();
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("Protected Task transcript cursor is invalid");
  } finally {
    bytes?.fill(0);
  }
  if (!Array.isArray(parsed)
    || parsed.length !== 5
    || parsed[0] !== 1
    || parsed[1] !== expected.taskId
    || parsed[2] !== expected.taskRunId
    || parsed[3] !== expected.agentId
    || !Number.isSafeInteger(parsed[4])
    || (parsed[4] as number) < 1) {
    throw new TypeError("Protected Task transcript cursor is invalid");
  }
  return Object.freeze({
    ...expected,
    afterMessageId: parsed[4] as number,
  });
}

function coordinate(row: ProtectedTaskRunTranscriptIndexRow) {
  return Object.freeze({
    sessionId: row.sessionId,
    messageId: row.messageId,
    editRevision: row.editRevision,
    role: row.role,
    logicalMessageKey: `row:${row.messageId}`,
  });
}

function sameCoordinates(
  history: RoomHistoryShadowReadReadyResponseV1,
  rows: readonly ProtectedTaskRunTranscriptIndexRow[],
  roomId: string,
): boolean {
  const expected = rows.map(coordinate);
  if (history.selectedCount !== expected.length
    || history.eligibleCount !== expected.length
    || history.selectedCoordinates.length !== expected.length
    || history.records.length !== expected.length
    || history.authority.roomId !== roomId
    || history.authorities?.some((authority) => authority.roomId !== roomId)) {
    return false;
  }
  return expected.every((value, index) => {
    const selected = history.selectedCoordinates[index];
    const record = history.records[index];
    return selected !== undefined
      && selected.sessionId === value.sessionId
      && selected.messageId === value.messageId
      && selected.editRevision === value.editRevision
      && selected.role === value.role
      && selected.logicalMessageKey === value.logicalMessageKey
      && record !== undefined
      && record.coordinate.sessionId === value.sessionId
      && record.coordinate.messageId === value.messageId
      && record.coordinate.editRevision === value.editRevision
      && record.coordinate.role === value.role
      && record.coordinate.logicalMessageKey === value.logicalMessageKey;
  });
}

function sameIndex(
  before: Extract<Awaited<ReturnType<ReadIndex>>, { status: "ready" }>,
  after: Awaited<ReturnType<ReadIndex>>,
): boolean {
  if (after.status !== "ready"
    || before.source.kind !== after.source.kind
    || before.source.roomId !== after.source.roomId
    || before.nextAfterMessageId !== after.nextAfterMessageId
    || before.rows.length !== after.rows.length) return false;
  if (before.source.kind === "requester_private") {
    if (after.source.kind !== "requester_private"
      || before.source.requesterUserId !== after.source.requesterUserId
      || before.source.namespaceId !== after.source.namespaceId) return false;
  }
  return before.rows.every((row, index) => {
    const current = after.rows[index];
    return current !== undefined
      && row.sessionId === current.sessionId
      && row.roomId === current.roomId
      && row.messageId === current.messageId
      && row.editRevision === current.editRevision
      && row.role === current.role
      && row.createdAt.getTime() === current.createdAt.getTime();
  });
}

function unavailableReason(
  history: Awaited<ReturnType<RoomHistoryShadowReadComposition["project"]>>,
): Extract<ProtectedTaskTranscriptReadResponseV1, {
  status: "unavailable";
}>["reason"] {
  if (history.status === "disabled") return "transcript_not_protected";
  if (history.status === "ineligible") return "integrity_failure";
  if (history.status === "unavailable") {
    if (history.reason === "client_crypto_unavailable") {
      return "device_not_ready";
    }
    if (history.reason === "projection_corrupt") return "integrity_failure";
  }
  return "authority_changed";
}

export function createProtectedTaskTranscriptReadService(input: Readonly<{
  db: DirectDatabase;
  history: RoomHistoryShadowReadComposition;
}>, overrides: Partial<Readonly<{
  readIndex: ReadIndex;
  resolveRequesterPrivateRoom: ProtectedTaskRequesterPrivateRoomResolver;
  now(): number;
}>> = {}): ProtectedTaskTranscriptReadService {
  const readIndex = overrides.readIndex ?? readProtectedTaskRunTranscriptIndex;
  const resolveRequesterPrivateRoom = overrides.resolveRequesterPrivateRoom
    ?? createProtectedTaskRequesterPrivateRoomResolver(input.db);
  const now = overrides.now ?? Date.now;

  return Object.freeze({
    async read(request: ProtectedTaskTranscriptReadInput) {
      const limit = request.limit
        ?? HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1;
      if (!Number.isSafeInteger(limit)
        || limit < 1
        || limit > HUMAN_HISTORY_READ_ACKNOWLEDGEMENT_MAX_RESULTS_V1) {
        throw new TypeError("Protected Task transcript limit is invalid");
      }
      const identity = Object.freeze({
        readVersion: 1 as const,
        taskId: request.taskId,
        taskRunId: request.taskRunId,
        agentId: request.agentId,
      });
      const cursor = request.cursor === undefined
        ? undefined
        : decodeCursor(request.cursor, {
            taskId: request.taskId,
            taskRunId: request.taskRunId,
            agentId: request.agentId,
          });
      const index = await readIndex(input.db, {
        taskId: request.taskId,
        taskRunId: request.taskRunId,
        agentId: request.agentId,
        viewerUserId: request.viewerUserId,
        viewerActorId: request.viewerActorId,
        ...(cursor === undefined
          ? {}
          : { afterMessageId: cursor.afterMessageId }),
        limit,
      });
      if (index.status === "not_found") return null;
      if (index.status !== "ready") {
        return Object.freeze({ ...identity, ...index });
      }
      if (index.source.kind === "requester_private") {
        const current = await resolveRequesterPrivateRoom(
          index.source.requesterUserId,
          request.agentId,
          index.source.namespaceId,
        );
        if (current === null
          || current.roomId !== index.source.roomId
          || current.namespaceId !== index.source.namespaceId) {
          return Object.freeze({
            ...identity,
            status: "unavailable" as const,
            reason: "authority_changed" as const,
          });
        }
      }
      const selectedCoordinates = index.rows.map(coordinate);
      const history = await input.history.project({
        authority: {
          userId: request.viewerUserId,
          humanActorId: request.viewerActorId,
        },
        roomId: index.source.roomId,
        readerDeviceId: request.historyRead.readerDeviceId ?? null,
        clientRequestKey: request.historyRead.clientRequestKey,
        selectedCoordinates,
        now: now(),
      });
      if (history.status !== "ready") {
        return Object.freeze({
          ...identity,
          status: "unavailable" as const,
          reason: unavailableReason(history),
        });
      }
      if (!sameCoordinates(history, index.rows, index.source.roomId)
        || history.clientRequestKey !== request.historyRead.clientRequestKey) {
        return Object.freeze({
          ...identity,
          status: "unavailable" as const,
          reason: "integrity_failure" as const,
        });
      }
      const current = await readIndex(input.db, {
        taskId: request.taskId,
        taskRunId: request.taskRunId,
        agentId: request.agentId,
        viewerUserId: request.viewerUserId,
        viewerActorId: request.viewerActorId,
        ...(cursor === undefined
          ? {}
          : { afterMessageId: cursor.afterMessageId }),
        limit,
      });
      if (!sameIndex(index, current)) {
        return Object.freeze({
          ...identity,
          status: "unavailable" as const,
          reason: "authority_changed" as const,
        });
      }
      return Object.freeze({
        ...identity,
        status: "ready" as const,
        sourceRoomId: index.source.roomId,
        entries: index.rows.map((row) => ({
          sessionId: row.sessionId,
          messageId: String(row.messageId),
          editRevision: row.editRevision,
          role: row.role,
          createdAt: row.createdAt.toISOString(),
        })),
        nextCursor: index.nextAfterMessageId === null
          ? null
          : encodeCursor({
              taskId: request.taskId,
              taskRunId: request.taskRunId,
              agentId: request.agentId,
              afterMessageId: index.nextAfterMessageId,
            }),
        history,
      });
    },
  });
}

/** Owner-and-audience checked content-v1 transcript transport. */
export function protectedTaskTranscriptReadRoutes(
  app: FastifyInstance,
  service: ProtectedTaskTranscriptReadService,
): void {
  app.post<{
    Params: { taskId: string; taskRunId: string };
    Body: unknown;
  }>(
    "/api/tasks/:taskId/runs/:taskRunId/transcript-v1",
    async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      reply.header("Vary", "Authorization");
      const viewerUserId = request.sessionUserId;
      const viewerActorId = request.sessionActorId;
      if (!viewerUserId || !viewerActorId) {
        return reply.code(401).send({ error: "Authentication required" });
      }
      if (!UUID.test(request.params.taskId)
        || !UUID.test(request.params.taskRunId)) {
        return reply.code(404).send({ error: "Task not found" });
      }
      const parsed = protectedTaskTranscriptReadRequestV1Schema
        .safeParse(request.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Invalid Task transcript read" });
      }
      try {
        const result = await service.read({
          taskId: request.params.taskId,
          taskRunId: request.params.taskRunId,
          agentId: parsed.data.agentId,
          viewerUserId,
          viewerActorId,
          ...(parsed.data.cursor === undefined
            ? {}
            : { cursor: parsed.data.cursor }),
          ...(parsed.data.limit === undefined
            ? {}
            : { limit: parsed.data.limit }),
          historyRead: {
            requestVersion: parsed.data.historyRead.requestVersion,
            clientRequestKey: parsed.data.historyRead.clientRequestKey,
            ...(parsed.data.historyRead.readerDeviceId === undefined
              ? {}
              : { readerDeviceId: parsed.data.historyRead.readerDeviceId }),
          },
        });
        if (result === null) {
          return reply.code(404).send({ error: "Task not found" });
        }
        return reply.send(
          protectedTaskTranscriptReadResponseV1Schema.parse(result),
        );
      } catch (error) {
        if (error instanceof TypeError
          && error.message === "Protected Task transcript cursor is invalid") {
          return reply.code(400).send({
            error: "Invalid Task transcript cursor",
          });
        }
        throw error;
      }
    },
  );
}
