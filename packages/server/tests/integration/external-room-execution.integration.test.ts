import * as firstPartySeeding from "../../src/apps/seed-first-party-apps";
import { createBolterController } from "../../src/messaging/bolter-controller";
import { expect, test, spyOn } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  actors, agents, externalRoomExecutionClaims, bolterConnections, bolterExplicitShares, bolterInboxReceipts, bolterOutbox, bolterRoomBindings,
  channelIdentities, credentials, eq, getSharedDirectAgentDb, getSharedDirectDb, groupMembers,
  inArray, jobs, namespaces, profiles, rooms, sessionMessages, sessions, users, workAcceptances,
  createBolterConnectionWith, createFreshBolterBindingWith, getBolterBindingWith, getJobById, listBolterOutboxWith,
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
import { createDatabaseBolterPublicationService } from "../../src/messaging/bolter-publication";

test("real service and LangGraph publish source-bound replies through a fixed test transport in isolated rooms", async () => {
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
  let controller: ReturnType<typeof createBolterController> | undefined;
  let observedMessages = 0;
  const failingMessageObserver = (event: ServerEvent) => {
    if (event.type === "message.new" && roomIds.some(id => event.laneKey === `room:${id}`)) {
      observedMessages += 1;
      throw new Error("Synthetic message subscriber failure");
    }
  };
  eventBus.on(failingMessageObserver);
  const taskObserverStart = spyOn(TaskObserver.prototype, "start").mockResolvedValue(undefined);
  // App bundle installation is independent of this real messaging/funding path.
  const seedApps = spyOn(firstPartySeeding, "seedFirstPartyApps").mockResolvedValue({ seeded: [] });
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
    const publications: { chatId: string; content: string }[] = [];
    const publisher = createDatabaseBolterPublicationService(agentDb, {
      isCurrent: current => current.connectionId === connection.id && current.desktopSessionId === connection.desktopSessionId,
      async send(request) {
        const authorized = await request.authorize();
        if (!authorized) return { status: "unavailable" };
        publications.push({ chatId: authorized.chatId, content: authorized.content });
        return { status: "sent", receipt: { messageId: `synthetic-reply-${publications.length}`,
          chatId: authorized.chatId, threadRootId: authorized.threadRootId } };
      },
    });
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
      const [final] = await fixture.db.select().from(sessionMessages).where(eq(sessionMessages.id, outbox[0]!.sessionMessageId!));
      expect(final?.replyToMessageId).toBe(receipt.sessionMessageId);
      expect(final?.role).toBe("assistant");
      expect(await publisher.publish(binding, outbox[0]!.id)).toEqual({ status: "published", providerMessageId: `synthetic-reply-${index + 1}` });
      expect(await publisher.publish(binding, outbox[0]!.id)).toEqual({ status: "unavailable" });
      expect((await listBolterOutboxWith(agentDb, { userId: sponsor.userId }, binding.bindingId))[0]?.state).toBe("published");
      const duplicate = await fixture.app.externalRoomExecution.accept({ receiver: binding,
        invocationAuthority: createAcceptedInvocationAuthority(sponsor.userId, { originRoomId: roomId }) }, { ...raw, redelivered: true });
      expect(duplicate.ok && duplicate.acceptance.status).toBe("duplicate");
    }
    expect(observedMessages).toBe(4);
    expect(model.invocations).toHaveLength(2);
    expect(publications).toEqual([{ chatId: "synthetic-chat-a", content: "Final reply A" },
      { chatId: "synthetic-chat-b", content: "Final reply B" }]);
    expect(JSON.stringify(model.invocations[0]?.messages)).toContain("ROOM_A_CANARY");
    expect(JSON.stringify(model.invocations[1]?.messages)).not.toContain("ROOM_A_CANARY");
    for (const invocation of model.invocations) {
      const prompt = JSON.stringify(invocation.messages);
      expect(prompt).toContain("External visitor");
      expect(prompt).not.toContain(connection.id);
      expect(prompt).not.toContain(bindings[0]!.bindingId);
    }

    // The real controller and database publisher consume a finite synthetic Relay
    // port. This proves local composition, not a qualified provider deployment.
    type RelayPort = Parameters<typeof createBolterController>[0]["relay"];
    const scope = { relayId: connection.relayId, userId: sponsor.userId, relaySessionId: randomUUID(),
      desktopSessionId: connection.desktopSessionId, pairingGenerationRef: connection.pairingGenerationRef,
      selectedProtocolVersion: 30, capabilityRevision: 1 };
    let relayCurrent = true;
    let receiverStarts = 0;
    let contextListener: Parameters<RelayPort["onBolterContext"]>[0] | undefined;
    let observationListener: Parameters<RelayPort["onBolterObservation"]>[0] | undefined;
    const nativeSends: { chatId: string; content: string }[] = [];
    const observation = { runtime: "qualified" as const, authentication: "confirmed" as const,
      identity: { providerAgentId: connection.providerAgentId, identityFingerprint: connection.identityFingerprint, label: "Synthetic identity" },
      receiver: "listening" as const };
    const relay: RelayPort = {
      getBolterSession: (relayId, userId) => relayCurrent && relayId === scope.relayId && userId === scope.userId ? scope : null,
      listBolterSessions: userId => relayCurrent && userId === scope.userId ? [scope] : [],
      onBolterObservation: listener => { observationListener = listener; return () => { observationListener = undefined; }; },
      onBolterBatch: () => () => undefined,
      onBolterContext: listener => { contextListener = listener; return () => { contextListener = undefined; }; },
      async requestBolterCommand(input) {
        if (!relayCurrent || input.signal.aborted) return { kind: "unavailable", reason: "desktop_offline" };
        if (input.command.action === "connect") {
          const { userId: _userId, ...wireScope } = scope;
          observationListener?.({ userId: scope.userId, message: { type: "relay:bolter-observation", version: 30,
            scope: wireScope, connectionId: input.command.connectionId, generation: 1, observation } });
          return { kind: "observation", observation };
        }
        if (input.command.action === "list_conversations") return { kind: "conversations", conversations: [{ label: "Synthetic chat C", chatId: "synthetic-chat-c", threadRootId: null }] };
        if (input.command.action === "send") {
          expect(input.command).not.toHaveProperty("content");
          const authorized = await input.authorize?.();
          if (!authorized) return { kind: "unavailable", reason: "authority_changed" };
          nativeSends.push({ chatId: authorized.chatId, content: authorized.content });
          return { kind: "sent", receipt: { messageId: `synthetic-reviewed-${nativeSends.length}`, chatId: authorized.chatId, threadRootId: authorized.threadRootId } };
        }
        if (input.command.action === "start_receiver") receiverStarts++;
        return { kind: "observation", observation: { ...observation, receiver: input.command.action === "start_receiver" ? "listening" : "stopped" } };
      },
    };
    controller = createBolterController({ relay, execution: fixture.app.externalRoomExecution });
    expect((await controller.connections(sponsor.userId)).availability.state).toBe("available");
    expect(await controller.check(sponsor.userId, connection.id)).toMatchObject({ canCreateRoom: true, receiver: "listening" });
    expect(receiverStarts).toBe(1);
    const conversations = await controller.conversations(sponsor.userId, connection.id);
    expect(conversations.status).toBe("available");
    const choice = conversations.conversations[0];
    if (!choice) throw new Error("Synthetic observed choice unavailable");
    const created = await controller.createRoom(sponsor.userId, connection.id, { choiceId: choice.id,
      agentId: genieId, name: "Synthetic reviewed Room", modelSponsorshipAccepted: true });
    roomIds.push(created.roomId);
    const createdBinding = await getBolterBindingWith(agentDb, { userId: sponsor.userId }, created.link.id);
    if (!createdBinding) throw new Error("Synthetic fresh binding unavailable");
    namespaceIds.push(createdBinding.namespaceId);
    expect(created.link.chatId).toBe("synthetic-chat-c");
    expect(created.link.receiver).toBe("listening");
    expect((await controller.connectionRooms(sponsor.userId, connection.id)).links).toHaveLength(3);
    const reviewed = { expectedRevision: created.link.revision, requestId: randomUUID(), content: "Exact Human-reviewed text \n" };
    const shared = await controller.sendReviewed(sponsor.userId, created.link.id, reviewed);
    const shareCtx = { ...receiver, bindingId: created.link.id, bindingRevision: created.link.revision };
    await controller.publishPending(shareCtx);
    const deliveries = (await controller.deliveries(sponsor.userId, created.link.id)).deliveries;
    expect(deliveries[0]).toMatchObject({ messageId: shared.messageId, outboxId: shared.outboxId,
      state: "published", requestId: reviewed.requestId });
    expect(typeof deliveries[0]?.createdAt).toBe("string");
    const retry = await controller.sendReviewed(sponsor.userId, created.link.id, reviewed);
    expect(retry.outboxId).toBe(shared.outboxId);
    await controller.publishPending(shareCtx);
    expect(nativeSends).toEqual([{ chatId: "synthetic-chat-c", content: reviewed.content }]);
    expect(model.invocations).toHaveLength(2);
    const [humanMessage] = await fixture.db.select().from(sessionMessages).where(eq(sessionMessages.id, shared.messageId!));
    expect(humanMessage).toMatchObject({ role: "user", externalAuthorship: false, content: reviewed.content });
    const paused = await controller.updateBinding(sponsor.userId, created.link.id, created.link.revision, "paused");
    expect(paused.canSend).toBe(false);
    await Promise.resolve(expect(controller.sendReviewed(sponsor.userId, created.link.id, { ...reviewed, requestId: randomUUID() })).rejects.toThrow());
    expect((await controller.updateBinding(sponsor.userId, created.link.id, paused.revision, "active")).receiver).toBe("listening");
    const startsBeforeReconnect = receiverStarts;
    relayCurrent = false;
    contextListener?.(scope.relayId, scope.userId, null);
    expect((await controller.connections(sponsor.userId)).connections.every(item => !item.canCreateRoom)).toBe(true);
    relayCurrent = true;
    contextListener?.(scope.relayId, scope.userId, scope);
    const reconnectDeadline = Date.now() + 30_000;
    while (receiverStarts === startsBeforeReconnect && Date.now() < reconnectDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(receiverStarts).toBe(startsBeforeReconnect + 1);
    expect((await controller.connections(sponsor.userId)).connections[0]?.canCreateRoom).toBe(true);
    const connectOperation = await controller.connect(sponsor.userId, scope.relayId);
    const connectDeadline = Date.now() + 30_000;
    while (controller.operation(sponsor.userId, connectOperation.operationId).status === "pending" && Date.now() < connectDeadline) await new Promise(resolve => setTimeout(resolve, 25));
    expect(controller.operation(sponsor.userId, connectOperation.operationId).status).toBe("completed");
    expect((await controller.connections(sponsor.userId)).connections).toHaveLength(2);
  } catch (error) {
    primaryFailure = error;
  } finally {
    if (controller) await controller.close();
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
        await tx.delete(bolterExplicitShares).where(eq(bolterExplicitShares.userId, peer!.userId));
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
        expect(await db.select({ id: bolterExplicitShares.id }).from(bolterExplicitShares).where(eq(bolterExplicitShares.userId, peer!.userId))).toHaveLength(0);
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
    seedApps.mockRestore();
    for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
  if (primaryFailure !== undefined || cleanupFailures.length) {
    throw new AggregateError([...(primaryFailure === undefined ? [] : [primaryFailure]), ...cleanupFailures], "External-room acceptance or cleanup failed");
  }
}, 90_000);
