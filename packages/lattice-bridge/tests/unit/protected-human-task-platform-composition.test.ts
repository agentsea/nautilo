import { describe, expect, test } from "bun:test";
import type { NautiloApiClient } from "@nautilo/api-client/browser";
import type { TaskContentSummaryV1 } from "@nautilo/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserHumanTaskClient } from
  "../../src/client/browser/index.ts";
import { createElectronHumanTaskClient } from
  "../../src/client/electron/index.ts";
import {
  bindEncryptionDataOperationOwner,
  ClassifiedDataOperationError,
} from
  "../../src/transition/encryption-data-operation-owner.ts";

const summary = {
  id: "30000000-0000-4000-8000-000000000248",
  content: {
    dtoVersion: 1,
    status: "protected",
    objectId: "task-definition:1",
    contentRevision: 1,
    cryptoAccessRevision: 0,
  },
} as TaskContentSummaryV1;

function owner(
  mode: "encrypted_only" | "shadow_encryption" = "encrypted_only",
  shadowBehavior: "strict" | "fallback" = "strict",
) {
  return bindEncryptionDataOperationOwner({
    policy: {
      resolve: () => Promise.resolve({
        policy: { mode, shadowBehavior },
        revalidationToken: 7,
      }),
      revalidate: (token) => {
        expect(token).toBe(7);
        return Promise.resolve();
      },
    },
  });
}

function input(
  api: NautiloApiClient,
  dataOperationOwner = owner(),
) {
  return {
    dataOperationOwner,
    api,
    serverScope: "https://nautilo.test",
    userId: "10000000-0000-4000-8000-000000000248",
    humanActorId: "20000000-0000-4000-8000-000000000248",
    installationId: "installation.task-test",
    resolveDeviceAdmissionStatus: () => Promise.resolve({
      responseVersion: 1 as const,
      required: true as const,
      status: "admitted" as const,
      deviceId: "unused-by-list",
      deviceGeneration: 1,
      expiresAt: Date.now() + 30_000,
    }),
  };
}

function protectedListApi(calls: string[]): NautiloApiClient {
  return {
    listProtectedTaskContentV1: async () => {
      calls.push("protected-list");
      return [summary];
    },
    listTaskContentV1: async () => {
      calls.push("ordinary-list");
      throw new Error("Protected composition must not call the Plain route");
    },
  } as unknown as NautiloApiClient;
}

describe("protected Human Task platform composition", () => {
  test("Browser selects the additive protected list transport", async () => {
    const calls: string[] = [];
    const result = await createBrowserHumanTaskClient(
      input(protectedListApi(calls)),
    ).list();
    expect(result).toEqual([summary]);
    expect(calls).toEqual(["protected-list"]);
  });

  test("development Electron selects the same protected list transport", async () => {
    const directory = await mkdtemp(join(tmpdir(), "nautilo-task-composition-"));
    try {
      const calls: string[] = [];
      const result = await createElectronHumanTaskClient({
        ...input(protectedListApi(calls)),
        directory,
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(value, "utf8"),
          decryptString: (value) => value.toString("utf8"),
        },
      }).list();
      expect(result).toEqual([summary]);
      expect(calls).toEqual(["protected-list"]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Browser maps a recoverable pre-send Shadow failure to the legacy ordinary API", async () => {
    const calls: unknown[] = [];
    const api = {
      planProtectedTaskCreateV1: async () => {
        throw new ClassifiedDataOperationError("key_waiting", "device key unavailable");
      },
      planProtectedTaskUpdateV1: async () => {
        throw new ClassifiedDataOperationError("key_waiting", "device key unavailable");
      },
      createOrdinaryTaskV1: async (body: unknown) => {
        calls.push(["ordinary-create", body]);
        return { taskId: summary.id, status: "pending", nextFireAt: null };
      },
      updateOrdinaryTaskV1: async (_taskId: string, body: unknown) => {
        calls.push(["ordinary-update", body]);
        return {
          id: summary.id,
          parentTaskId: null,
          depth: 0,
          status: "paused",
          preset: "task",
          prompt: "updated private prompt",
          lastError: null,
          scheduleKind: "now",
          nextFireAt: null,
          callingRoomId: null,
        };
      },
    } as unknown as NautiloApiClient;
    const taskClient = createBrowserHumanTaskClient(input(
      api,
      owner("shadow_encryption", "fallback"),
    ));
    const created = await taskClient.create({
      payload: {
        formatVersion: 1,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task: { scheduleKind: "now" },
    });
    const updated = await taskClient.update(summary, {
      payload: {
        formatVersion: 1,
        prompt: "updated private prompt",
        expectedOutput: "answer",
        protectedMetadata: {},
      },
      task: { timezone: "UTC" },
    });
    expect(created.taskId).toBe(summary.id);
    expect(updated.content).toEqual({
      dtoVersion: 1,
      status: "ordinary",
      promptPreview: "updated private prompt",
      lastError: null,
    });
    expect(calls).toEqual([
      ["ordinary-create", {
        scheduleKind: "now",
        prompt: "private prompt",
        expectedOutput: null,
      }],
      ["ordinary-update", {
        timezone: "UTC",
        prompt: "updated private prompt",
        expectedOutput: "answer",
      }],
    ]);
  });
});
