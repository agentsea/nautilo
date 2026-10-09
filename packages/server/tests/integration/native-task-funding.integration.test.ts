import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import { HumanMessage } from "@langchain/core/messages";
import { ChatOpenAICompletions } from "@langchain/openai";
import {
  and,
  actors,
  eq,
  getServerProviderPolicy,
  getTaskById,
  getTaskRunForTask,
  getTaskRuns,
  insertTaskRun,
  llmUsageEvents,
  markTaskRunStatus,
  tasks,
  users,
  rooms,
  roomMembers,
  namespaces,
  updateTask,
  upsertServerProviderPolicy,
} from "@nautilo/db";
import { invokeChatModelWithFallback, runWithUsageContext, registerAllTools } from "@nautilo/agent";
import { taskFundingFailureCode, createHumanApiTaskCreationProvenance, resolveTargetRoom } from "@nautilo/runtime";
import { ToolCatalog, clearToolCatalog, getToolCatalog, initToolCatalog } from "@nautilo/catalog";
import { initPolicyResolver, getPolicyResolver, PersonalPolicyResolver, createRoomFromMembers } from "@nautilo/trust";
import { nativeTaskFundingPort } from "../../src/lib/native-task-funding";
import { setupOwnerAppFixture, type AppFixture } from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const MODEL_ID = "openrouter:moonshotai/kimi-k3";
const WAKE_MODEL_ID = "openai:gpt-5.6-luna";

async function waitForUsage(
  fx: AppFixture,
  marker: string,
): Promise<typeof llmUsageEvents.$inferSelect> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const rows = await fx.db.select().from(llmUsageEvents).where(and(
      eq(llmUsageEvents.userId, fx.ownerId),
      eq(llmUsageEvents.model, MODEL_ID),
    ));
    const found = rows.find((row) => row.metadata?.["testMarker"] === marker);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for Task usage provenance");
}

describe.serial("native Task funding", () => {
  test("an owned text Task keeps its real personal credential and usage provenance inside the attempt boundary", async () => {
    const priorOpenRouterKey = process.env["OPENROUTER_API_KEY"];
    const personalKey = `synthetic-personal-task-${randomUUID()}`;
    const replacementKey = `synthetic-personal-task-replacement-${randomUUID()}`;
    const wakeKey = `synthetic-personal-task-wake-${randomUUID()}`;
    const marker = randomUUID();
    const serverMarker = randomUUID();
    const serverKey = `synthetic-server-task-${randomUUID()}`;
    const providerRequests: Array<{
      authorization: string | null;
      body: string;
      url: string;
    }> = [];
    const priorFetch = globalThis.fetch;
    let fx: AppFixture | undefined;
    const priorResolver = getPolicyResolver();
    const priorCatalog = getToolCatalog();
    const catalog = new ToolCatalog();
    registerAllTools(catalog);
    initToolCatalog(catalog);
    let priorPolicy: Awaited<ReturnType<typeof getServerProviderPolicy>> | undefined;
    let bearer = "";
    let credentialRevision: number | undefined;
    let wakeCredentialRevision: number | undefined;
    let taskId: string | undefined;
    const usageIds: string[] = [];
    let legacyTaskId: string | undefined;
    let executionTaskId: string | undefined;
    let peerUserId: string | undefined;
    let sharedRoomId: string | undefined;
    let sharedNamespaceId: string | undefined;

    delete process.env["OPENROUTER_API_KEY"];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url;
      if (url !== "https://openrouter.ai/api/v1/chat/completions") {
        throw new Error(`Unexpected outbound request in native Task funding test: ${url}`);
      }
      const request = input instanceof Request ? input : undefined;
      const headers = new Headers(init?.headers ?? request?.headers);
      const body = typeof init?.body === "string"
        ? init.body
        : request
          ? await request.clone().text()
          : "{}";
      providerRequests.push({ authorization: headers.get("authorization"), body, url });
      const providerResponseId = `chatcmpl-native-task-${providerRequests.length}`;
      const payload = JSON.parse(body) as { stream?: boolean };
      if (payload.stream) {
        const chunks = [
          {
            id: providerResponseId, object: "chat.completion.chunk", created: 1,
            model: "moonshotai/kimi-k3",
            choices: [{ index: 0, delta: { role: "assistant", content: "Synthetic Task response." }, finish_reason: null }],
          },
          {
            id: providerResponseId, object: "chat.completion.chunk", created: 1,
            model: "moonshotai/kimi-k3",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
          },
        ];
        return new Response(
          `${chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")}data: [DONE]\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      return Response.json({
        id: providerResponseId,
        object: "chat.completion",
        created: 1,
        model: "moonshotai/kimi-k3",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "Synthetic Task response." },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 },
      });
    }) as typeof fetch;
    try {
      fx = await setupOwnerAppFixture({
        suiteName: "nativetaskfunding",
        withDefaultAgentGraph: true,
      });
      if (!fx.defaultRoomId || !fx.defaultAgentId) {
        throw new Error("owner Task funding fixture is incomplete");
      }
      initPolicyResolver(new PersonalPolicyResolver(fx.ownerId, fx.defaultAgentId));
      const activeFx = fx;
      const defaultAgentId = fx.defaultAgentId;
      bearer = await fx.mintOwnerBearer();
      priorPolicy = await getServerProviderPolicy(fx.db);
      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: true,
        fundingPreference: "personal_first",
      });

      const saved = await authedInject(fx.app, {
        method: "PUT",
        url: "/api/account/provider-credentials/openrouter",
        bearer,
        payload: { apiKey: personalKey },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      expect(saved.body).not.toContain(personalKey);
      credentialRevision = saved.json<{ credential: { revision: number } }>()
        .credential.revision;

      const created = await authedInject(fx.app, {
        method: "POST",
        url: "/api/tasks",
        bearer,
        payload: {
          prompt: "Summarize the supplied text without tools.",
          scheduleKind: "one_shot",
          runAt: "2035-01-01T00:00:00.000Z",
          targetChat: "last_in_namespace",
          resultDelivery: "raw",
          tools: [],
          requestedModelId: MODEL_ID,
        },
      });
      expect(created.statusCode, created.body).toBe(201);
      taskId = created.json<{ taskId: string }>().taskId;
      const task = await getTaskById(fx.db, taskId);
      if (!task) throw new Error("Task reload failed");
      expect(task).toMatchObject({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: fx.defaultAgentId,
        callingRoomId: fx.defaultRoomId,
        fundingMode: "caller",
        toolsMode: "none",
        toolsWhitelist: [],
      });

      expect(await nativeTaskFundingPort.prepareCreation({ ...task, targetRoomId: fx.defaultRoomId },
        createHumanApiTaskCreationProvenance({ ownerId: fx.ownerId }))).toBe(false);
      expect(await nativeTaskFundingPort.admit({ ...task, targetChat: "orphan",
        targetRoomId: fx.defaultRoomId }).then(() => null,
          (error: unknown) => (error as { code?: unknown }).code)).toBe("unsupported_workload");

      const [peer] = await fx.db.insert(users).values({ name: "Task audience peer",
        handle: `taskaudience${randomUUID().replaceAll("-", "")}`, server: null }).returning();
      if (!peer) throw new Error("Task audience peer missing");
      peerUserId = peer.id;
      await fx.db.insert(actors).values({ ownerId: peer.id, kind: "user",
        displayName: "Task audience peer", trustState: "verified" });
      const sharedRoom = await createRoomFromMembers({ ownerUserId: fx.ownerId,
        ownerActorId: fx.ownerActorId, label: "Newer shared Task destination",
        members: [{ kind: "user", id: fx.ownerId }, { kind: "user", id: peer.id },
          { kind: "agent", id: defaultAgentId }] });
      sharedRoomId = sharedRoom.id;
      if (!sharedRoom.namespaceId) throw new Error("Shared Room Namespace missing");
      sharedNamespaceId = sharedRoom.namespaceId;
      expect(sharedRoom.members.filter((member) => member.kind === "user")).toHaveLength(2);
      expect((await resolveTargetRoom(task, { db: fx.db })).roomId).toBe(fx.defaultRoomId);
      expect(await nativeTaskFundingPort.admit({ ...task, targetRoomId: sharedRoom.id })
        .then(() => null, taskFundingFailureCode)).toBe("unsupported_workload");

      const admitted = await nativeTaskFundingPort.admit(task);
      expect(admitted).toMatchObject({
        modelId: MODEL_ID,
        binding: {
          kind: "personal",
          providerRoute: "openrouter",
          credentialRevision,
        },
      });
      if (admitted.binding.kind !== "personal") {
        throw new Error("Expected personal Task funding");
      }

      const run = await insertTaskRun(fx.db, {
        taskId,
        graphThreadId: `native-task-funding:${randomUUID()}`,
        status: "running",
        modelId: admitted.modelId,
        fundingBinding: admitted.binding,
      });
      const session = await nativeTaskFundingPort.openSession(
        task,
        run,
        admitted.modelId,
        false,
      );
      const result = await runWithUsageContext({
        callType: "chat",
        userId: fx.ownerId,
        metadata: { testMarker: marker },
      }, () => invokeChatModelWithFallback(
        [new HumanMessage("Return the deterministic fixture response.")],
        [],
        admitted.modelId,
        activeFx.ownerId,
        defaultAgentId,
        null,
        undefined,
        {
          fundingHumanUserId: activeFx.ownerId,
          fundingSession: session,
          modelFallbackMode: "none",
          sameModelRetryMode: "none",
        },
      ));
      expect(result.response.content).toBe("Synthetic Task response.");
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.authorization).toBe(`Bearer ${personalKey}`);
      expect(providerRequests[0]?.body).not.toContain(personalKey);

      const usage = await waitForUsage(fx, marker);
      usageIds.push(usage.id);
      expect(usage).toMatchObject({
        userId: fx.ownerId,
        fundingKind: "personal",
        payerHumanId: fx.ownerId,
        providerRoute: "openrouter",
        credentialId: admitted.binding.credentialId,
        credentialRevision,
      });
      expect(JSON.stringify({ task, run, usage })).not.toContain(personalKey);

      // Both worker admission and every retry must reject a changed execution
      // audience; an archived or membership-revoked private destination cannot spend.
      let forbiddenAttempts = 0;
      const forbiddenAttempt = () => session.runAttempt(MODEL_ID, async () => { forbiddenAttempts += 1; })
        .then(() => null, taskFundingFailureCode);
      await updateTask(fx.db, taskId, { targetRoomId: sharedRoom.id });
      expect(await forbiddenAttempt()).toBe("unsupported_workload");
      expect(await nativeTaskFundingPort.openSession({ ...task, targetRoomId: sharedRoom.id }, run,
        MODEL_ID, false).then(() => null, taskFundingFailureCode)).toBe("unsupported_workload");
      await updateTask(fx.db, taskId, { targetRoomId: fx.defaultRoomId });
      await fx.db.update(rooms).set({ archivedAt: new Date() }).where(eq(rooms.id, fx.defaultRoomId));
      try { expect(await forbiddenAttempt()).toBe("unsupported_workload"); }
      finally { await fx.db.update(rooms).set({ archivedAt: null }).where(eq(rooms.id, fx.defaultRoomId)); }
      const [agentMembership] = await fx.db.select().from(roomMembers).innerJoin(actors,
        eq(roomMembers.actorId, actors.id)).where(and(eq(roomMembers.roomId, fx.defaultRoomId),
        eq(actors.agentId, defaultAgentId)));
      if (!agentMembership) throw new Error("Task Genie membership missing");
      await fx.db.delete(roomMembers).where(and(eq(roomMembers.roomId, fx.defaultRoomId),
        eq(roomMembers.actorId, agentMembership.room_members.actorId)));
      try { expect(await forbiddenAttempt()).toBe("unsupported_workload"); }
      finally { await fx.db.insert(roomMembers).values(agentMembership.room_members); }
      expect(forbiddenAttempts).toBe(0);
      expect(providerRequests).toHaveLength(1);

      const immediate = await authedInject(fx.app, {
        method: "POST", url: "/api/tasks", bearer,
        payload: { prompt: "Return the deterministic fixture response without tools.",
          scheduleKind: "now", targetChat: "orphan", resultDelivery: "raw",
          tools: [], requestedModelId: MODEL_ID },
      });
      expect(immediate.statusCode, immediate.body).toBe(201);
      executionTaskId = immediate.json<{ taskId: string }>().taskId;
      const executionDeadline = Date.now() + 15_000;
      let executed = await getTaskById(fx.db, executionTaskId);
      while (executed && !["completed", "errored", "paused", "cancelled"].includes(executed.status)
        && Date.now() < executionDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        executed = await getTaskById(fx.db, executionTaskId);
      }
      expect(executed?.status, executed?.lastError ?? "Task did not finish").toBe("completed");
      const executedRuns = await getTaskRuns(fx.db, executionTaskId);
      expect(executedRuns).toHaveLength(1);
      expect(executedRuns[0]).toMatchObject({ status: "completed", modelId: MODEL_ID,
        fundingBinding: admitted.binding });
      expect(executedRuns[0]?.resultText).toContain("Synthetic Task response.");
      expect(providerRequests).toHaveLength(2);
      expect(providerRequests[1]?.authorization).toBe(`Bearer ${personalKey}`);
      const workerBody = JSON.parse(providerRequests[1]?.body ?? "{}") as { tools?: unknown[] };
      expect(workerBody.tools ?? []).toHaveLength(0);
      const workerUsageDeadline = Date.now() + 5_000;
      let workerUsage: typeof llmUsageEvents.$inferSelect | undefined;
      do {
        const rows = await fx.db.select().from(llmUsageEvents).where(and(
          eq(llmUsageEvents.userId, fx.ownerId), eq(llmUsageEvents.model, MODEL_ID)));
        workerUsage = rows.find((row) => row.id !== usage.id);
        if (!workerUsage) await new Promise((resolve) => setTimeout(resolve, 20));
      } while (!workerUsage && Date.now() < workerUsageDeadline);
      expect(workerUsage).toMatchObject({ userId: fx.ownerId, fundingKind: "personal",
        payerHumanId: fx.ownerId, providerRoute: "openrouter",
        credentialId: admitted.binding.credentialId, credentialRevision });

      expect(JSON.stringify({ executed, executedRuns })).not.toContain(personalKey);


      const replaced = await authedInject(fx.app, {
        method: "PUT",
        url: "/api/account/provider-credentials/openrouter",
        bearer,
        payload: { apiKey: replacementKey, expectedRevision: credentialRevision },
      });
      expect(replaced.statusCode, replaced.body).toBe(200);
      credentialRevision = replaced.json<{ credential: { revision: number } }>()
        .credential.revision;
      expect(await session.recheckAttempt(MODEL_ID).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("personal_credential_stale");
      await markTaskRunStatus(fx.db, run.id, "paused");

      const rejectedUpdate = await authedInject(fx.app, {
        method: "PATCH",
        url: `/api/tasks/${taskId}`,
        bearer,
        payload: { prompt: "must not persist after credential replacement" },
      });
      expect(rejectedUpdate.statusCode, rejectedUpdate.body).toBe(409);
      expect(rejectedUpdate.json<{ error: string }>().error).toBe("personal_credential_stale");
      expect((await getTaskById(fx.db, taskId))?.prompt).toBe(task.prompt);

      const replacementAdmission = await nativeTaskFundingPort.admit(task);
      expect(replacementAdmission.binding).toMatchObject({
        kind: "personal",
        credentialRevision,
      });
      const replacementRun = await insertTaskRun(fx.db, {
        taskId,
        graphThreadId: `native-task-funding:${randomUUID()}`,
        status: "running",
        modelId: replacementAdmission.modelId,
        fundingBinding: replacementAdmission.binding,
      });
      const replacementSession = await nativeTaskFundingPort.openSession(
        task,
        replacementRun,
        replacementAdmission.modelId,
        false,
      );
      const openAITransport = ChatOpenAICompletions.prototype as unknown as {
        completionWithRetry: (...args: unknown[]) => Promise<unknown>;
      };
      const originalCompletionWithRetry = openAITransport.completionWithRetry;
      try {
        for (const failure of [401, 429] as const) {
          openAITransport.completionWithRetry = async () => {
            throw Object.assign(
              new Error(`synthetic provider rejection ${replacementKey}`),
              { status: failure },
            );
          };
          const providerError = await invokeChatModelWithFallback(
            [new HumanMessage("Exercise deterministic provider rejection.")],
            [],
            replacementAdmission.modelId,
            activeFx.ownerId,
            defaultAgentId,
            null,
            undefined,
            {
              fundingHumanUserId: activeFx.ownerId,
              fundingSession: replacementSession,
              modelFallbackMode: "none",
              sameModelRetryMode: "none",
            },
          ).then(() => null, (error: unknown) => error);
          expect(providerError).toBeInstanceOf(Error);
          expect(String((providerError as Error).message)).not.toContain(replacementKey);
          expect(taskFundingFailureCode(providerError)).toBe("personal_provider_unavailable");
        }
      } finally {
        openAITransport.completionWithRetry = originalCompletionWithRetry;
      }
      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      });
      expect(await replacementSession.recheckAttempt(MODEL_ID).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("personal_credentials_disabled");
      const paused = await authedInject(fx.app, {
        method: "POST",
        url: `/api/tasks/${taskId}/pause`,
        bearer,
      });
      expect(paused.statusCode, paused.body).toBe(200);
      const rejectedUnpause = await authedInject(fx.app, {
        method: "POST",
        url: `/api/tasks/${taskId}/unpause`,
        bearer,
      });
      expect(rejectedUnpause.statusCode, rejectedUnpause.body).toBe(409);
      expect(rejectedUnpause.json<{ error: string }>().error).toBe("personal_credentials_disabled");
      expect((await getTaskById(fx.db, taskId))?.status).toBe("paused");

      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: true,
        fundingPreference: "personal_first",
      });
      await markTaskRunStatus(fx.db, replacementRun.id, "completed", {
        completedAt: new Date(),
        resultText: "durable completed Task result",
      });
      const savedWakeCredential = await authedInject(fx.app, {
        method: "PUT",
        url: "/api/account/provider-credentials/openai",
        bearer,
        payload: { apiKey: wakeKey },
      });
      expect(savedWakeCredential.statusCode, savedWakeCredential.body).toBe(200);
      const wakeIdentity = savedWakeCredential.json<{
        credential: { id: string; revision: number };
      }>().credential;
      wakeCredentialRevision = wakeIdentity.revision;
      const completedRun = await getTaskRunForTask(fx.db, taskId, replacementRun.id);
      if (!completedRun) throw new Error("completed TaskRun reload failed");

      const wakeSession = await nativeTaskFundingPort.openSession(
        task,
        completedRun,
        WAKE_MODEL_ID,
        true,
      );
      let capturedWakeKey: string | undefined;
      let capturedWakeFunding: unknown;
      await wakeSession.runAttempt(WAKE_MODEL_ID, async (attempt) => {
        capturedWakeKey = attempt.personalCredential?.apiKey;
        capturedWakeFunding = attempt.usageFunding;
      });
      expect(capturedWakeKey).toBe(wakeKey);
      expect(capturedWakeFunding).toEqual({
        kind: "personal",
        humanUserId: fx.ownerId,
        payerHumanId: fx.ownerId,
        providerRoute: "openai",
        credentialId: wakeIdentity.id,
        credentialRevision: wakeIdentity.revision,
      });

      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      });
      expect(await wakeSession.runAttempt(WAKE_MODEL_ID, async () => undefined).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("personal_credentials_disabled");
      const completedAfterWakeRevocation = await getTaskRunForTask(
        fx.db,
        taskId,
        replacementRun.id,
      );
      expect(completedAfterWakeRevocation).toMatchObject({
        status: "completed",
        resultText: "durable completed Task result",
        lastError: "personal_credentials_disabled",
      });
      expect(await getTaskById(fx.db, taskId)).toMatchObject({
        status: "paused",
        lastError: "personal_credentials_disabled",
      });

      process.env["OPENROUTER_API_KEY"] = serverKey;
      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: true,
        fundingPreference: "server_first",
      });
      const serverAdmission = await nativeTaskFundingPort.admit(task);
      expect(serverAdmission).toMatchObject({
        modelId: MODEL_ID,
        binding: { kind: "server", providerRoute: "openrouter" },
      });
      const serverRun = await insertTaskRun(fx.db, {
        taskId,
        graphThreadId: `native-task-funding:${randomUUID()}`,
        status: "running",
        modelId: serverAdmission.modelId,
        fundingBinding: serverAdmission.binding,
      });
      const serverSession = await nativeTaskFundingPort.openSession(
        task,
        serverRun,
        serverAdmission.modelId,
        false,
      );
      providerRequests.length = 0;
      await runWithUsageContext({
        callType: "chat",
        userId: fx.ownerId,
        metadata: { testMarker: serverMarker },
      }, () => invokeChatModelWithFallback(
        [new HumanMessage("Return the deterministic server-funded response.")],
        [],
        serverAdmission.modelId,
        activeFx.ownerId,
        defaultAgentId,
        null,
        undefined,
        {
          fundingHumanUserId: activeFx.ownerId,
          fundingSession: serverSession,
          modelFallbackMode: "none",
          sameModelRetryMode: "none",
        },
      ));
      expect(providerRequests).toHaveLength(1);
      expect(providerRequests[0]?.authorization).toBe(`Bearer ${serverKey}`);
      expect(providerRequests[0]?.body).not.toContain(serverKey);
      const serverUsage = await waitForUsage(fx, serverMarker);
      usageIds.push(serverUsage.id);
      expect(serverUsage).toMatchObject({
        userId: fx.ownerId,
        fundingKind: "server",
        providerRoute: "openrouter",
        payerHumanId: null,
        credentialId: null,
        credentialRevision: null,
      });

      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: false,
        fundingPreference: "server_first",
      });
      const [legacyTask] = await fx.db.insert(tasks).values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId: fx.defaultAgentId,
        prompt: "legacy server-funded Task",
        status: "paused",
        scheduleKind: "one_shot",
        runAt: new Date("2035-01-02T00:00:00.000Z"),
        nextFireAt: new Date("2035-01-02T00:00:00.000Z"),
      }).returning({ id: tasks.id });
      if (!legacyTask) throw new Error("legacy Task seed failed");
      legacyTaskId = legacyTask.id;
      const legacyUpdate = await authedInject(fx.app, {
        method: "PATCH",
        url: `/api/tasks/${legacyTask.id}`,
        bearer,
        payload: { prompt: "legacy server-funded Task updated" },
      });
      expect(legacyUpdate.statusCode, legacyUpdate.body).toBe(200);
      const legacyUnpause = await authedInject(fx.app, {
        method: "POST",
        url: `/api/tasks/${legacyTask.id}/unpause`,
        bearer,
      });
      expect(legacyUnpause.statusCode, legacyUnpause.body).toBe(200);

      const malformedSnapshot = {
        ...serverRun,
        fundingBinding: { kind: "personal", providerRoute: "openrouter" },
      } as typeof serverRun;
      expect(await nativeTaskFundingPort.openSession(
        task,
        malformedSnapshot,
        serverAdmission.modelId,
        false,
      ).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");

      const conflictingSnapshot = {
        ...serverRun,
        fundingBinding: {
          kind: "personal",
          providerRoute: "openrouter",
          credentialId: admitted.binding.credentialId,
          credentialRevision: admitted.binding.credentialRevision,
        },
      } as typeof serverRun;
      expect(await nativeTaskFundingPort.openSession(
        task,
        conflictingSnapshot,
        serverAdmission.modelId,
        false,
      ).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");

      const invalidPredecessorRun = await insertTaskRun(fx.db, {
        taskId,
        graphThreadId: `native-task-funding:${randomUUID()}`,
        status: "running",
        modelId: serverAdmission.modelId,
        fundingBinding: serverAdmission.binding,
        fundingPredecessorRunId: run.id,
      });
      expect(await nativeTaskFundingPort.openSession(
        task,
        invalidPredecessorRun,
        serverAdmission.modelId,
        false,
      ).then(
        () => null,
        (error: unknown) => (error as { code?: unknown }).code,
      )).toBe("funding_source_changed");
    } finally {
      if (fx) {
        for (const usageId of usageIds) {
          await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.id, usageId));
        }
        if (executionTaskId) await fx.db.delete(tasks).where(eq(tasks.id, executionTaskId));
        await fx.db.delete(llmUsageEvents).where(eq(llmUsageEvents.userId, fx.ownerId));
        if (legacyTaskId) await fx.db.delete(tasks).where(eq(tasks.id, legacyTaskId));
        if (taskId) await fx.db.delete(tasks).where(eq(tasks.id, taskId));
        if (sharedRoomId) {
          await fx.db.delete(roomMembers).where(eq(roomMembers.roomId, sharedRoomId));
          await fx.db.delete(rooms).where(eq(rooms.id, sharedRoomId));
        }
        if (sharedNamespaceId) await fx.db.delete(namespaces).where(eq(namespaces.id, sharedNamespaceId));
        if (peerUserId) {
          await fx.db.delete(actors).where(eq(actors.ownerId, peerUserId));
          await fx.db.delete(users).where(eq(users.id, peerUserId));
        }
        if (bearer && credentialRevision !== undefined) {
          await authedInject(fx.app, {
            method: "DELETE",
            url: "/api/account/provider-credentials/openrouter",
            bearer,
            payload: { expectedRevision: credentialRevision },
          });
        }
        if (bearer && wakeCredentialRevision !== undefined) {
          await authedInject(fx.app, {
            method: "DELETE",
            url: "/api/account/provider-credentials/openai",
            bearer,
            payload: { expectedRevision: wakeCredentialRevision },
          });
        }
        if (priorPolicy) await upsertServerProviderPolicy(fx.db, priorPolicy);
        await fx.cleanup();
      }
      if (priorResolver) initPolicyResolver(priorResolver);
      if (priorCatalog) initToolCatalog(priorCatalog);
      else clearToolCatalog();
      globalThis.fetch = priorFetch;
      if (priorOpenRouterKey === undefined) delete process.env["OPENROUTER_API_KEY"];
      else process.env["OPENROUTER_API_KEY"] = priorOpenRouterKey;
    }
  });
});
