import { expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  actors, agents, externalRoomExecutionClaims, bolterConnections, bolterInboxReceipts, bolterOutbox, bolterRoomBindings,
  channelIdentities, credentials, eq, getSharedDirectAgentDb, getSharedDirectDb, groupMembers,
  inArray, jobs, namespaces, profiles, rooms, sessionMessages, sessions, users, workAcceptances,
  createBolterConnectionWith, createFreshBolterBindingWith, getJobById, listBolterOutboxWith,
  type BolterBindingContext,
} from "@nautilo/db";
import { resolveInstance, resolveNautiloRootDir } from "@nautilo/config";
import { buildServerDaemonEnv } from "../../../../bin/nautilo-dev/src/commands/server-start";
import { bootstrapTestDbInstance } from "@nautilo/db/testing";
import {
  createAcceptedInvocationAuthority, initPolicyResolver, PersonalPolicyResolver,
} from "@nautilo/trust";
import { insertPrivateRoomBundleTx } from "../../../trust/src/queries";
import { __setStubModelForTests, closeCheckpointSaver, createCheckpointSaver, initToolCatalog,
  registerAllTools, setupCheckpointSaver, ToolCatalog } from "@nautilo/agent";
import { eventBus, jobManager, TaskObserver } from "@nautilo/runtime";
import type { ServerEvent } from "@nautilo/types";
import { createStubProvider } from "../../../runtime/tests/integration/helpers/stub-provider";
import { seatPeerUser, setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";

test("real service and LangGraph produce source-bound pending replies for one shared Genie in isolated rooms", async () => {
  if (bootstrapTestDbInstance() !== "test-cruft") throw new Error("External-room acceptance requires the disposable test instance");
  process.env["NAUTILO_TEST_DB_AUTOHEAL"] = "0";
  const saved = new Map(["NAUTILO_TEST_MODE", "NAUTILO_MODEL", "OPENAI_API_KEY", "DB_CRYPTO_CONNECTION_STRING"].map(key => [key, process.env[key]]));
  const daemonEnv = buildServerDaemonEnv({ rootDir: resolveNautiloRootDir(), inst: resolveInstance(),
    instanceId: "test-cruft", parentEnv: process.env });
  if (!daemonEnv["DB_CRYPTO_CONNECTION_STRING"]) throw new Error("Disposable crypto role connection is unavailable");
  process.env["DB_CRYPTO_CONNECTION_STRING"] = daemonEnv["DB_CRYPTO_CONNECTION_STRING"];
  process.env["NAUTILO_TEST_MODE"] = "stub";
  process.env["NAUTILO_MODEL"] = "openai:gpt-5.5-2026-04-23";
  process.env["OPENAI_API_KEY"] = "synthetic-local-model-fixture";
  let fixture: AppFixture | undefined;
  let peer: Awaited<ReturnType<typeof seatPeerUser>> | undefined;
  const roomIds: string[] = [];
  const namespaceIds: string[] = [];
  const acceptanceIds: string[] = [];
  const jobIds: string[] = [];
  const threads: string[] = [];
  const cleanupFailures: unknown[] = [];
  let primaryFailure: unknown;
  let observedMessages = 0;
  const failingMessageObserver = (event: ServerEvent) => {
    if (event.type === "message.new" && roomIds.some(id => event.laneKey === `room:${id}`)) {
      observedMessages += 1;
      throw new Error("Synthetic message subscriber failure");
    }
  };
  eventBus.on(failingMessageObserver);
  const taskObserverStart = spyOn(TaskObserver.prototype, "start").mockResolvedValue(undefined);
  const model = createStubProvider({ responses: [
    { type: "text", content: "Final reply A" }, { type: "text", content: "Final reply B" },
  ] });
  __setStubModelForTests(model.asChatModel());
  try {
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    await setupCheckpointSaver();
    fixture = await setupOwnerAppFixture({ suiteName: "externalroundtrip", withDefaultAgentGraph: true });
    await fixture.app.ready();
    peer = await seatPeerUser(fixture.db, { suiteName: "externalsponsor", groupType: "owners" });
    const sponsor = peer;
    const genieId = fixture.defaultAgentId!;
    initPolicyResolver(new PersonalPolicyResolver(sponsor.userId, genieId));
    const [genieActor] = await fixture.db.select({ id: actors.id }).from(actors).where(eq(actors.agentId, genieId));
    if (!genieActor) throw new Error("Shared Genie fixture missing");
    const agentDb = getSharedDirectAgentDb();
    const connection = await createBolterConnectionWith(agentDb, { userId: sponsor.userId }, {
      relayId: randomUUID(), desktopSessionId: randomUUID(), pairingGenerationRef: randomUUID(),
      homeHandle: randomUUID(), origin: "https://bolter.chat", providerAgentId: "synthetic-provider-agent",
      identityFingerprint: "a".repeat(64),
    });
    const receiver = { userId: sponsor.userId, connectionId: connection.id, connectionGeneration: connection.generation,
      relayId: connection.relayId, desktopSessionId: connection.desktopSessionId, pairingGenerationRef: connection.pairingGenerationRef };
    const bindings: BolterBindingContext[] = [];
    for (const chatId of ["synthetic-chat-a", "synthetic-chat-b"]) {
      const roomId = randomUUID();
      roomIds.push(roomId);
      const threadId = `room:${roomId}:bot:${genieId}`;
      threads.push(threadId);
      const binding = await createFreshBolterBindingWith(getSharedDirectDb(), receiver, async tx => {
        const created = await insertPrivateRoomBundleTx(tx, { roomId, ownerUserId: sponsor.userId, label: "Synthetic external room",
          graphThreadId: threadId, humanActorIds: [sponsor.actorId], createdByActorId: sponsor.actorId,
          memberRows: [{ actorId: sponsor.actorId, roomRole: "admin" }, { actorId: genieActor.id, roomRole: "member" }],
          externalContext: true, discoverable: false });
        namespaceIds.push(created.namespaceId);
        return { roomId, namespaceId: created.namespaceId, agentId: genieId, chatId, threadId: "", modelSponsorshipAccepted: true };
      });
      bindings.push({ ...receiver, bindingId: binding.id, bindingRevision: binding.revision });
    }
    for (let index = 0; index < bindings.length; index += 1) {
      const binding = bindings[index]!;
      const roomId = roomIds[index]!;
      const raw = { type: "message", messageId: `synthetic-input-${index}`, chatId: index === 0 ? "synthetic-chat-a" : "synthetic-chat-b",
        threadRootId: null, senderId: "synthetic-external-person", senderType: "user", senderLabel: "External visitor",
        content: index === 0 ? "/literal-command ROOM_A_CANARY" : "ROOM_B_ONLY", createdAt: new Date().toISOString(),
        addressed: false, truncated: false, redelivered: false };
      const enqueueFault = index === 0
        ? spyOn(jobManager, "adoptExternalRoomJob").mockRejectedValueOnce(new Error("Synthetic enqueue interruption"))
        : undefined;
      let admitted;
      try {
        admitted = await fixture.app.externalRoomExecution.accept({ receiver: binding,
          invocationAuthority: createAcceptedInvocationAuthority(sponsor.userId, { originRoomId: roomId }) }, raw);
      } finally { enqueueFault?.mockRestore(); }
      expect(admitted.ok).toBe(true);
      if (!admitted.ok || admitted.acceptance.status !== "accepted") throw new Error("External fixture was not accepted");
      const receipt = admitted.acceptance.receipt;
      expect(receipt.jobId).not.toBeNull();
      if (!receipt.jobId) throw new Error("Accepted receipt lacks its durable Job");
      jobIds.push(receipt.jobId);
      if (index === 0) {
        expect(admitted.dispatch).toBe("pending-recovery");
        expect((await getJobById(receipt.jobId, sponsor.userId))?.status).toBe("queued");
        const recovered = await fixture.app.externalRoomExecution.recoverOwner(sponsor.userId);
        expect(recovered).toContainEqual({ jobId: receipt.jobId, outcome: "adopted" });
      }
      const deadline = Date.now() + 30_000;
      let job = await getJobById(receipt.jobId, sponsor.userId);
      while (job && ["queued", "running"].includes(job.status) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        job = await getJobById(receipt.jobId, sponsor.userId);
      }
      expect(job?.status).toBe("completed");
      if (typeof job?.input?.["acceptanceId"] === "string") acceptanceIds.push(job.input["acceptanceId"]);
      expect(job?.input).not.toHaveProperty("message");
      expect(job?.input).not.toHaveProperty("externalOrigin");
      const outbox = await listBolterOutboxWith(agentDb, { userId: sponsor.userId }, binding.bindingId);
      expect(outbox).toHaveLength(1);
      expect(outbox[0]).toMatchObject({ sourceInboxId: receipt.id, state: "pending" });
      const [final] = await fixture.db.select().from(sessionMessages).where(eq(sessionMessages.id, outbox[0]!.sessionMessageId));
      expect(final?.replyToMessageId).toBe(receipt.sessionMessageId);
      expect(final?.role).toBe("assistant");
      const duplicate = await fixture.app.externalRoomExecution.accept({ receiver: binding,
        invocationAuthority: createAcceptedInvocationAuthority(sponsor.userId, { originRoomId: roomId }) }, { ...raw, redelivered: true });
      expect(duplicate.ok && duplicate.acceptance.status).toBe("duplicate");
    }
    expect(observedMessages).toBe(4);
    expect(model.invocations).toHaveLength(2);
    expect(JSON.stringify(model.invocations[0]?.messages)).toContain("ROOM_A_CANARY");
    expect(JSON.stringify(model.invocations[1]?.messages)).not.toContain("ROOM_A_CANARY");
    for (const invocation of model.invocations) {
      const prompt = JSON.stringify(invocation.messages);
      expect(prompt).toContain("External visitor");
      expect(prompt).not.toContain(connection.id);
      expect(prompt).not.toContain(bindings[0]!.bindingId);
    }
  } catch (error) {
    primaryFailure = error;
  } finally {
    const cleanup = async (run: () => Promise<unknown>) => {
      try { await run(); } catch (error) { cleanupFailures.push(error); }
    };
    for (const roomId of roomIds) await cleanup(() => jobManager.stopRoom(roomId));
    let quiesced = false;
    await cleanup(async () => {
      if (fixture && peer) {
        const retained = await fixture.db.select({ id: jobs.id }).from(jobs).where(eq(jobs.ownerId, peer.userId));
        jobIds.push(...retained.map(row => row.id));
      }
      const deadline = Date.now() + 30_000;
      while (jobIds.some(id => jobManager.hasLocalExternalRoomWork(id)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (jobIds.some(id => jobManager.hasLocalExternalRoomWork(id))) throw new Error("Fixture executor did not quiesce; retained its rows and checkpoints");
      expect(await jobManager.retryQuiescentExternalRoomClaims()).toBe(0);
      if (roomIds.length) expect(await getSharedDirectDb().select({ roomId: externalRoomExecutionClaims.roomId })
        .from(externalRoomExecutionClaims).where(inArray(externalRoomExecutionClaims.roomId, roomIds))).toHaveLength(0);
      quiesced = true;
    });
    if (quiesced) for (const thread of threads) await cleanup(async () => {
      const saver = createCheckpointSaver();
      await saver.deleteThread(thread);
      expect(await saver.getTuple({ configurable: { thread_id: thread } })).toBeUndefined();
    });
    if (quiesced) await cleanup(() => closeCheckpointSaver());
    __setStubModelForTests(null);
    if (quiesced && fixture && peer) {
      const db = fixture.db;
      await cleanup(() => db.transaction(async tx => {
        await tx.delete(bolterOutbox).where(eq(bolterOutbox.userId, peer!.userId));
        await tx.delete(bolterInboxReceipts).where(eq(bolterInboxReceipts.userId, peer!.userId));
        await tx.delete(bolterRoomBindings).where(eq(bolterRoomBindings.userId, peer!.userId));
        await tx.delete(bolterConnections).where(eq(bolterConnections.userId, peer!.userId));
        const ownedSessions = await tx.select({ id: sessions.id }).from(sessions).where(eq(sessions.ownerId, peer!.userId));
        if (ownedSessions.length) await tx.delete(sessionMessages).where(inArray(sessionMessages.sessionId, ownedSessions.map(row => row.id)));
        await tx.delete(sessions).where(eq(sessions.ownerId, peer!.userId));
        const ownedJobs = await tx.select({ input: jobs.input }).from(jobs).where(eq(jobs.ownerId, peer!.userId));
        const allAcceptanceIds = [...new Set([...acceptanceIds, ...ownedJobs.flatMap(row =>
          typeof row.input?.["acceptanceId"] === "string" ? [row.input["acceptanceId"]] : [])])];
        acceptanceIds.push(...allAcceptanceIds);
        if (allAcceptanceIds.length) await tx.delete(workAcceptances).where(inArray(workAcceptances.id, allAcceptanceIds));
        await tx.delete(jobs).where(eq(jobs.ownerId, peer!.userId));
        if (roomIds.length) await tx.delete(rooms).where(inArray(rooms.id, roomIds));
        if (namespaceIds.length) await tx.delete(namespaces).where(inArray(namespaces.id, namespaceIds));
        await tx.delete(profiles).where(eq(profiles.userId, peer!.userId));
        await tx.delete(groupMembers).where(eq(groupMembers.userId, peer!.userId));
        await tx.delete(channelIdentities).where(eq(channelIdentities.userId, peer!.userId));
        await tx.delete(credentials).where(eq(credentials.userId, peer!.userId));
        await tx.delete(actors).where(eq(actors.ownerId, peer!.userId));
        await tx.delete(agents).where(eq(agents.id, peer!.agentId));
        await tx.delete(users).where(eq(users.id, peer!.userId));
      }));
      await cleanup(async () => {
        expect(await db.select({ id: users.id }).from(users).where(eq(users.id, peer!.userId))).toHaveLength(0);
        expect(await db.select({ id: rooms.id }).from(rooms).where(inArray(rooms.id, roomIds))).toHaveLength(0);
      });
    }
    if (fixture && quiesced) {
      const ownerId = fixture.ownerId;
      await cleanup(() => fixture!.cleanup());
      await cleanup(async () => {
        const db = getSharedDirectDb();
        expect(await db.select({ id: users.id }).from(users).where(eq(users.id, ownerId))).toHaveLength(0);
        if (roomIds.length) expect(await db.select({ roomId: externalRoomExecutionClaims.roomId }).from(externalRoomExecutionClaims)
          .where(inArray(externalRoomExecutionClaims.roomId, roomIds))).toHaveLength(0);
        if (jobIds.length) expect(await db.select({ id: jobs.id }).from(jobs).where(inArray(jobs.id, jobIds))).toHaveLength(0);
        if (acceptanceIds.length) expect(await db.select({ id: workAcceptances.id }).from(workAcceptances).where(inArray(workAcceptances.id, acceptanceIds))).toHaveLength(0);
      });
    } else if (fixture) await cleanup(() => fixture!.app.close());
    eventBus.off(failingMessageObserver);
    taskObserverStart.mockRestore();
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (primaryFailure !== undefined || cleanupFailures.length) {
    throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures], "External-room acceptance or cleanup failed");
  }
}, 90_000);
