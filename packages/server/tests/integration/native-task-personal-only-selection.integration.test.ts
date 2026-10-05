import { randomUUID } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  actors,
  agents,
  channelIdentities,
  credentials,
  eq,
  getServerProviderPolicy,
  getTaskById,
  getTaskRunForTask,
  groupMembers,
  profiles,
  taskRuns,
  tasks,
  upsertServerProviderPolicy,
  users,
} from "@nautilo/db";
import { dispatchTaskCommand } from "../../../agent/src/tools/tasks/dispatch";
import { isPersonalOnlyNativeTaskSelection } from "../../src/lib/native-task-funding";
import {
  seatPeerUser,
  setupOwnerAppFixture,
  type AppFixture,
} from "./helpers/app-fixture";
import { authedInject } from "./helpers/request-helpers";

const PERSONAL_MODEL = "openrouter:moonshotai/kimi-k3";
const SERVER_DEFAULT_MODEL = "anthropic:claude-sonnet-4-6";
const PROVIDER_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "GOOGLE_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "XAI_API_KEY",
  "FIREWORKS_API_KEY",
  "TOGETHER_API_KEY",
  "VENICE_API_KEY",
  "TYPESAFE_API_KEY",
  "NAUTILO_GATEWAY_API_KEY",
  "NAUTILO_GATEWAY_BASE_URL",
] as const;

function restoreEnv(saved: ReadonlyMap<string, string | undefined>): void {
  for (const [key, value] of saved) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

describe.serial("native Task personal-only selection", () => {
  test("classifies the resolved default, profile, and exact model only for an owned personal route", async () => {
    const savedEnv = new Map(PROVIDER_ENV_KEYS.map((key) => [key, process.env[key]]));
    for (const key of PROVIDER_ENV_KEYS) delete process.env[key];

    let fx: AppFixture | undefined;
    let bearer = "";
    let credentialId: string | undefined;
    let credentialRevision: number | undefined;
    let resumableTaskId: string | undefined;
    let priorPolicy: Awaited<ReturnType<typeof getServerProviderPolicy>> | undefined;
    let peer: Awaited<ReturnType<typeof seatPeerUser>> | undefined;

    try {
      fx = await setupOwnerAppFixture({
        suiteName: "taskpersonalonly",
        withDefaultAgentGraph: true,
      });
      if (!fx.defaultAgentId || !fx.defaultRoomId) {
        throw new Error("owner Task selection fixture is incomplete");
      }
      const agentId = fx.defaultAgentId;
      const callingRoomId = fx.defaultRoomId;
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
        payload: { apiKey: `synthetic-personal-selection-${randomUUID()}` },
      });
      expect(saved.statusCode, saved.body).toBe(200);
      const credential = saved.json<{ credential: { id: string; revision: number } }>()
        .credential;
      credentialId = credential.id;
      credentialRevision = credential.revision;

      await fx.db.update(profiles)
        .set({ defaultModel: PERSONAL_MODEL })
        .where(eq(profiles.agentId, agentId));

      const baseSelection = {
        requestorId: fx.ownerId,
        agentId,
        callingRoomId,
        requestedModelId: null,
        selectionProfile: null,
        selectionSpec: null,
      } as const;

      expect(
        await isPersonalOnlyNativeTaskSelection(baseSelection),
        "the Agent default resolves to the caller's personal-only model",
      ).toBe(true);

      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          requestedModelId: PERSONAL_MODEL,
        }),
        "an exact signed model resolves to the caller's personal-only route",
      ).toBe(true);

      await fx.db.update(profiles)
        .set({ defaultModel: SERVER_DEFAULT_MODEL })
        .where(eq(profiles.agentId, agentId));
      process.env["ANTHROPIC_API_KEY"] = "synthetic-server-selection-anthropic";
      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          selectionProfile: "cheapest",
        }),
        "the cheapest profile resolves from the caller union to personal-only OpenRouter",
      ).toBe(true);
      delete process.env["ANTHROPIC_API_KEY"];

      const [resumableTask] = await fx.db.insert(tasks).values({
        ownerId: fx.ownerId,
        requestorId: fx.ownerId,
        agentId,
        prompt: "preserve this caller-funded Task definition",
        status: "paused",
        scheduleKind: "one_shot",
        runAt: new Date("2035-01-01T00:00:00.000Z"),
        nextFireAt: new Date("2035-01-01T00:00:00.000Z"),
        callingRoomId,
        targetChat: "last_in_namespace",
        targetRoomId: callingRoomId,
        targetUserIds: [fx.ownerId],
        toolsMode: "none",
        toolsWhitelist: [],
        selectionProfile: "balanced",
        requestedModelId: PERSONAL_MODEL,
        fundingMode: "caller",
      }).returning({ id: tasks.id });
      if (!resumableTask || !credentialId || credentialRevision === undefined) {
        throw new Error("resumable Task fixture is incomplete");
      }
      resumableTaskId = resumableTask.id;
      const [pausedRun] = await fx.db.insert(taskRuns).values({
        taskId: resumableTask.id,
        graphThreadId: `task-selection-update:${randomUUID()}`,
        status: "paused",
        modelId: PERSONAL_MODEL,
        fundingBinding: {
          kind: "personal",
          providerRoute: "openrouter",
          credentialId,
          credentialRevision,
        },
      }).returning({ id: taskRuns.id });
      if (!pausedRun) throw new Error("paused TaskRun fixture is incomplete");
      const taskContext = {
        ownerId: fx.ownerId,
        causalHumanUserId: fx.ownerId,
        agentId,
        roomId: callingRoomId,
        personalTaskControls: true,
      } as const;

      const conflictingSelection = await dispatchTaskCommand({
        command: "update",
        taskId: resumableTask.id,
        model_selection_profile: "cheapest",
      }, taskContext);
      expect(conflictingSelection).toContain("Cannot combine an exact model_id");
      expect(await getTaskById(fx.db, resumableTask.id)).toMatchObject({
        prompt: "preserve this caller-funded Task definition",
        requestedModelId: PERSONAL_MODEL,
        selectionProfile: "balanced",
        selectionSpec: null,
        status: "paused",
      });

      const unsatisfiableSelection = await dispatchTaskCommand({
        command: "update",
        taskId: resumableTask.id,
        model_id: null,
        model_selection_spec: {
          objective: "cheap",
          absoluteFloors: { privacy: 9 },
        },
      }, taskContext);
      expect(unsatisfiableSelection).toContain("No configured model can satisfy");
      expect(await getTaskById(fx.db, resumableTask.id)).toMatchObject({
        prompt: "preserve this caller-funded Task definition",
        requestedModelId: PERSONAL_MODEL,
        selectionProfile: "balanced",
        selectionSpec: null,
        status: "paused",
      });

      const validPromptUpdate = await dispatchTaskCommand({
        command: "update",
        taskId: resumableTask.id,
        prompt: "valid prompt edit keeps the paused run pinned",
      }, taskContext);
      expect(JSON.parse(validPromptUpdate)).toMatchObject({
        task: {
          id: resumableTask.id,
          status: "paused",
          prompt: "valid prompt edit keeps the paused run pinned",
        },
      });
      expect(await getTaskById(fx.db, resumableTask.id)).toMatchObject({
        requestedModelId: PERSONAL_MODEL,
        selectionProfile: "balanced",
        selectionSpec: null,
      });
      expect(await getTaskRunForTask(fx.db, resumableTask.id, pausedRun.id)).toMatchObject({
        status: "paused",
        modelId: PERSONAL_MODEL,
        fundingBinding: {
          kind: "personal",
          providerRoute: "openrouter",
          credentialId,
          credentialRevision,
        },
      });

      peer = await seatPeerUser(fx.db, {
        suiteName: "taskpersonalonlyforeign",
        groupType: "members",
      });
      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          requestorId: peer.userId,
          requestedModelId: PERSONAL_MODEL,
        }),
        "the owner's Room is foreign to the peer requestor",
      ).toBe(false);

      process.env["OPENROUTER_API_KEY"] = "synthetic-server-selection-openrouter";
      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          requestedModelId: PERSONAL_MODEL,
        }),
        "an allowed server route makes the selected model non-personal-only",
      ).toBe(false);
      delete process.env["OPENROUTER_API_KEY"];

      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: false,
        fundingPreference: "personal_first",
      });
      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          requestedModelId: PERSONAL_MODEL,
        }),
        "the server personal-provider switch disables the caller route",
      ).toBe(false);

      await upsertServerProviderPolicy(fx.db, {
        allowPersonalProviderKeys: true,
        fundingPreference: "personal_first",
      });
      const removed = await authedInject(fx.app, {
        method: "DELETE",
        url: "/api/account/provider-credentials/openrouter",
        bearer,
        payload: { expectedRevision: credentialRevision },
      });
      expect(removed.statusCode, removed.body).toBe(200);
      credentialRevision = undefined;
      expect(
        await isPersonalOnlyNativeTaskSelection({
          ...baseSelection,
          requestedModelId: PERSONAL_MODEL,
        }),
        "a missing caller credential leaves the selected model unrunnable",
      ).toBe(false);
    } finally {
      if (fx) {
        if (resumableTaskId) {
          await fx.db.delete(taskRuns).where(eq(taskRuns.taskId, resumableTaskId));
          await fx.db.delete(tasks).where(eq(tasks.id, resumableTaskId));
        }
        if (bearer && credentialRevision !== undefined) {
          await upsertServerProviderPolicy(fx.db, {
            allowPersonalProviderKeys: true,
            fundingPreference: priorPolicy?.fundingPreference ?? "personal_first",
          });
          await authedInject(fx.app, {
            method: "DELETE",
            url: "/api/account/provider-credentials/openrouter",
            bearer,
            payload: { expectedRevision: credentialRevision },
          });
        }
        if (peer) {
          await fx.db.delete(profiles).where(eq(profiles.userId, peer.userId));
          await fx.db.delete(actors).where(eq(actors.ownerId, peer.userId));
          await fx.db.delete(actors).where(eq(actors.agentId, peer.agentId));
          await fx.db.delete(agents).where(eq(agents.id, peer.agentId));
          await fx.db.delete(groupMembers).where(eq(groupMembers.userId, peer.userId));
          await fx.db.delete(channelIdentities).where(eq(channelIdentities.userId, peer.userId));
          await fx.db.delete(credentials).where(eq(credentials.userId, peer.userId));
          await fx.db.delete(users).where(eq(users.id, peer.userId));
        }
        if (priorPolicy) await upsertServerProviderPolicy(fx.db, priorPolicy);
        await fx.cleanup();
      }
      restoreEnv(savedEnv);
    }
  });
});
