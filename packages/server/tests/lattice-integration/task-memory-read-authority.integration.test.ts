import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, test } from "bun:test";
import {
  __resetSharedDirectAgentDbForTests,
  __resetSharedDirectDbForTests,
  agentScopes,
  agents,
  createDirectDb,
  cryptoObjects,
  eq,
  getSharedDirectAgentDb,
  getSharedDirectDb,
  inArray,
  memories,
  memoryNamespaces,
  memoryScopes,
  namespaces,
  rooms,
  tasks,
  users,
  withTrustContext,
} from "@nautilo/db";
import {
  deriveMemoryCryptoObjectIdV1,
  fingerprintRequiredMemoryNamespaces,
  type ProtectedMemoryAuthority,
} from "@nautilo/lattice-bridge";
import { PostgresTaskMemoryReadPort, type TaskMemoryReadBoundary } from
  "@nautilo/lattice-bridge/server";

import { createForegroundProductTransactionContext } from
  "../../src/routes/foreground-message-product-store.ts";

afterAll(async () => {
  await Promise.all([
    __resetSharedDirectAgentDbForTests(),
    __resetSharedDirectDbForTests(),
  ]);
});

describe.serial("Task Memory read authority", () => {
  test("retains an audience edge hidden by Agent RLS and rejects stale Scope authority", async () => {
    const admin = createDirectDb(3);
    const requesterUserId = randomUUID();
    const foreignUserId = randomUUID();
    const agentId = randomUUID();
    const roomId = randomUUID();
    const namespaceIds = [randomUUID(), randomUUID()].sort();
    const [originNamespaceId, foreignNamespaceId] = namespaceIds;
    const taskId = randomUUID();
    const scopeId = randomUUID();
    const foreignScopeId = randomUUID();
    const seedMemoryId = randomUUID();
    const authoredMemoryId = randomUUID();
    const foreignOriginMemoryId = randomUUID();
    const memoryIds = [seedMemoryId, authoredMemoryId, foreignOriginMemoryId];
    const objectIds = memoryIds.map(memoryId => deriveMemoryCryptoObjectIdV1({
      memoryId,
      contentRevision: 1,
    }));
    const fingerprint = fingerprintRequiredMemoryNamespaces(namespaceIds);
    let bodyError: unknown;
    try {
      await Promise.all([
        __resetSharedDirectAgentDbForTests(),
        __resetSharedDirectDbForTests(),
      ]);
      await admin.transaction(async transaction => {
        await transaction.insert(users).values([
          { id: requesterUserId, name: "Task Memory requester" },
          { id: foreignUserId, name: "Task Memory foreign audience" },
        ]);
        await transaction.insert(agents).values({
          id: agentId,
          handle: `task-memory-reader-${agentId}`,
        });
        await transaction.insert(namespaces).values(namespaceIds.map(
          (id, index) => ({
            id,
            scope: "room",
            label: `Task Memory read Namespace ${index}`,
          }),
        ));
        await transaction.insert(rooms).values({
          id: roomId,
          ownerId: requesterUserId,
          type: "private",
          label: "Task Memory read Room",
          graphThreadId: `task-memory-reader:${roomId}`,
          namespaceId: originNamespaceId!,
          humanActorIds: [],
          kind: "private",
        });
        await transaction.insert(agentScopes).values([
          {
            id: scopeId,
            parentAgentId: agentId,
            speakerUserId: requesterUserId,
            name: `task-memory-read-${scopeId}`,
          },
          {
            id: foreignScopeId,
            parentAgentId: agentId,
            speakerUserId: foreignUserId,
            name: `task-memory-read-foreign-${foreignScopeId}`,
          },
        ]);
        await transaction.insert(tasks).values({
          id: taskId,
          ownerId: requesterUserId,
          requestorId: requesterUserId,
          agentId,
          prompt: "Task Memory read authority fixture",
          callingRoomId: roomId,
          targetRoomId: roomId,
          useScope: true,
          scopeId,
        });
        await transaction.insert(cryptoObjects).values(objectIds.map(
          (objectId, index) => ({
            objectId,
            payloadHash: new Uint8Array(32).fill(0x40 + index),
            payloadBytes: new Uint8Array([0x01, index]),
          }),
        ));
        const createdAt = new Date("2042-05-03T10:00:00.000Z");
        await transaction.insert(memories).values([
          {
            id: seedMemoryId,
            type: "fact",
            content: "Seed Memory shared with ordinary A and B.",
            importance: 0.7,
            tier: 1,
            contentRevision: 1,
            cryptoAccessRevision: 2,
            createdAt,
          },
          {
            id: authoredMemoryId,
            type: "preference",
            content: "Scope-authored Memory shared with ordinary B.",
            importance: 0.6,
            tier: 1,
            contentRevision: 1,
            cryptoAccessRevision: 2,
            scopeOriginNamespaceId: originNamespaceId,
            createdAt,
          },
          {
            id: foreignOriginMemoryId,
            type: "context",
            content: "Seed Memory retaining a foreign Scope origin audience.",
            importance: 0.5,
            tier: 1,
            contentRevision: 1,
            cryptoAccessRevision: 2,
            scopeOriginNamespaceId: foreignNamespaceId,
            createdAt,
          },
        ]);
        await transaction.insert(memoryNamespaces).values([
          { memoryId: seedMemoryId, namespaceId: originNamespaceId! },
          { memoryId: seedMemoryId, namespaceId: foreignNamespaceId! },
          { memoryId: authoredMemoryId, namespaceId: foreignNamespaceId! },
          { memoryId: foreignOriginMemoryId, namespaceId: originNamespaceId! },
        ]);
        await transaction.insert(memoryScopes).values([
          { memoryId: seedMemoryId, scopeId, origin: "seed" },
          { memoryId: authoredMemoryId, scopeId, origin: "scope" },
          { memoryId: foreignOriginMemoryId, scopeId, origin: "seed" },
          {
            memoryId: foreignOriginMemoryId,
            scopeId: foreignScopeId,
            origin: "scope",
          },
        ]);
        for (let index = 0; index < memoryIds.length; index += 1) {
          await transaction.update(memories).set({
            cryptoObjectId: objectIds[index]!,
            cryptoRequiredNamespaceFingerprint: fingerprint,
            cryptoMappingState: "verified",
          }).where(eq(memories.id, memoryIds[index]!));
        }
      });
      fingerprint.fill(0);

      const trust = Object.freeze({
        userId: requesterUserId,
        agentId,
      });
      const agentVisibleEdges = await withTrustContext(
        trust,
        transaction => transaction.select({
          scopeId: memoryScopes.scopeId,
          origin: memoryScopes.origin,
        }).from(memoryScopes).where(eq(
          memoryScopes.memoryId,
          foreignOriginMemoryId,
        )),
        getSharedDirectAgentDb(),
      );
      expect(agentVisibleEdges).toEqual([{ scopeId, origin: "seed" }]);

      const product = await createForegroundProductTransactionContext(
        trust,
        getSharedDirectDb(),
      );
      const coordinates = Object.freeze({
        taskId,
        requesterUserId,
        agentId,
        scopeId,
        memoryRoomId: roomId,
        originWritableNamespaceId: originNamespaceId!,
      });
      const authority: Extract<ProtectedMemoryAuthority, { mode: "scope" }> =
        Object.freeze({
          mode: "scope",
          subjectUserId: requesterUserId,
          agentId,
          scopeId,
          originWritableNamespaceId: originNamespaceId!,
        });
      const boundary: TaskMemoryReadBoundary = Object.freeze({
        withCurrentRead: ({ use }) => use(),
      });
      const portInput = Object.freeze({
        handle: product.handle,
        canonicalRunner: product.canonicalRunner,
        binding: Object.freeze({
          mode: "scope" as const,
          authority,
          coordinates,
          readableNamespaceIds: Object.freeze(namespaceIds),
        }),
        boundary,
      });
      const port = new PostgresTaskMemoryReadPort(portInput);

      const agentProduct = await createForegroundProductTransactionContext(
        trust,
      );
      expect(() => new PostgresTaskMemoryReadPort({
        ...portInput,
        handle: agentProduct.handle,
        canonicalRunner: agentProduct.canonicalRunner,
      })).toThrow("requires a direct nautilo handle");

      const exact = await port.loadExactProtectedSources({
        authority,
        memoryIds: [...memoryIds].sort(),
      });
      if (exact.status === "unavailable") {
        throw new Error(`Task Memory source unavailable: ${exact.reason}`);
      }
      expect(exact.value).toHaveLength(3);
      for (const source of exact.value) {
        expect(source).toMatchObject({
          readNamespaceId: originNamespaceId,
          requiredNamespaceIds: namespaceIds,
        });
      }

      const ordinary = await port.loadExactOrdinary({
        authority,
        candidates: exact.value.map(candidate => Object.freeze({
          ...candidate,
          representation: "dual" as const,
        })),
      });
      if (ordinary.status !== "success") {
        throw new Error(`Task Memory ordinary body unavailable: ${ordinary.reason}`);
      }
      expect(new Map(ordinary.value.map(value => [value.memoryId, value.content])))
        .toEqual(new Map([
          [seedMemoryId, "Seed Memory shared with ordinary A and B."],
          [authoredMemoryId, "Scope-authored Memory shared with ordinary B."],
          [foreignOriginMemoryId,
            "Seed Memory retaining a foreign Scope origin audience."],
        ]));

      const wrongAuthority = Object.freeze({
        ...authority,
        originWritableNamespaceId: foreignNamespaceId!,
      });
      const wrongOriginPort = new PostgresTaskMemoryReadPort({
        ...portInput,
        binding: Object.freeze({
          mode: "scope" as const,
          authority: wrongAuthority,
          coordinates: Object.freeze({
            ...coordinates,
            originWritableNamespaceId: foreignNamespaceId!,
          }),
          readableNamespaceIds: Object.freeze([foreignNamespaceId!]),
        }),
      });
      expect(await wrongOriginPort.loadExactProtectedSources({
        authority: wrongAuthority,
        memoryIds: [seedMemoryId],
      })).toEqual({
        status: "unavailable",
        reason: "authorization_required",
      });

      await admin.update(agentScopes).set({
        lifecycleState: "closing",
        closeOperationId: `scope-close:${scopeId}`,
        revision: 1,
      }).where(eq(agentScopes.id, scopeId));
      expect(await port.loadExactProtectedSources({
        authority,
        memoryIds: [seedMemoryId],
      })).toEqual({
        status: "unavailable",
        reason: "authorization_required",
      });
    } catch (error) {
      bodyError = error;
    } finally {
      fingerprint.fill(0);
    }

    let cleanupError: unknown;
    try {
      await admin.transaction(async transaction => {
        await transaction.delete(tasks).where(eq(tasks.id, taskId));
        await transaction.delete(memoryScopes).where(inArray(
          memoryScopes.memoryId,
          memoryIds,
        ));
        await transaction.delete(memoryNamespaces).where(inArray(
          memoryNamespaces.memoryId,
          memoryIds,
        ));
        await transaction.delete(memories).where(inArray(memories.id, memoryIds));
        await transaction.delete(cryptoObjects).where(inArray(
          cryptoObjects.objectId,
          objectIds,
        ));
        await transaction.delete(agentScopes).where(inArray(
          agentScopes.id,
          [scopeId, foreignScopeId],
        ));
        await transaction.delete(rooms).where(eq(rooms.id, roomId));
        await transaction.delete(namespaces).where(inArray(
          namespaces.id,
          namespaceIds,
        ));
        await transaction.delete(agents).where(eq(agents.id, agentId));
        await transaction.delete(users).where(inArray(
          users.id,
          [requesterUserId, foreignUserId],
        ));
      });
      expect(await admin.select({ id: tasks.id }).from(tasks)
        .where(eq(tasks.id, taskId))).toEqual([]);
      expect(await admin.select({ id: memories.id }).from(memories)
        .where(inArray(memories.id, memoryIds))).toEqual([]);
    } catch (error) {
      cleanupError = error;
    } finally {
      await Promise.all([
        admin.end({ timeout: 1 }),
        __resetSharedDirectAgentDbForTests(),
        __resetSharedDirectDbForTests(),
      ]);
    }
    if (bodyError !== undefined && cleanupError !== undefined) {
      throw new AggregateError(
        [bodyError, cleanupError],
        "Task Memory reader test and cleanup both failed",
      );
    }
    if (bodyError !== undefined) {
      throw bodyError instanceof Error
        ? bodyError
        : new Error("Task Memory reader test failed", { cause: bodyError });
    }
    if (cleanupError !== undefined) {
      throw cleanupError instanceof Error
        ? cleanupError
        : new Error("Task Memory reader cleanup failed", {
            cause: cleanupError,
          });
    }
  }, 120_000);
});
