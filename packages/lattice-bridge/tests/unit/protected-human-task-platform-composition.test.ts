import { describe, expect, test } from "bun:test";
import { ApiError, type NautiloApiClient } from "@nautilo/api-client/browser";
import type { TaskContentSummaryV1 } from "@nautilo/types";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserHumanTaskClient } from
  "../../src/client/browser/index.ts";
import { createBrowserHumanTaskRunResultReader } from
  "../../src/client/browser/index.ts";
import { createElectronHumanTaskClient } from
  "../../src/client/electron/index.ts";
import { createElectronHumanTaskRunResultReader } from
  "../../src/client/electron/index.ts";
import { deriveTaskContentCryptoObjectIdV1 } from
  "../../src/task/task-content-repository.ts";
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
  mode: "plaintext_only" | "encrypted_only" | "shadow_encryption" =
    "encrypted_only",
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
  test("Browser and Desktop result readers use only the exact protected endpoint", async () => {
    const taskId = "30000000-0000-4000-8000-000000000248";
    const taskRunId = "30000000-0000-4000-8000-000000000249";
    const calls: string[] = [];
    const resultApi = {
      getProtectedTaskRunResultEnvelopeV1: async (
        requestedTaskId: string,
        requestedRunId: string,
      ) => {
        calls.push(`${requestedTaskId}:${requestedRunId}`);
        return {
          readVersion: 1 as const,
          status: "waiting" as const,
          taskId,
          taskRunId,
          objectId: deriveTaskContentCryptoObjectIdV1({
            kind: "run_result", taskId, taskRunId, contentRevision: 1,
          }),
          resultRevision: 1 as const,
          cryptoAccessRevision: 0 as const,
          reason: "result_not_mapped" as const,
        };
      },
    } as unknown as NautiloApiClient;
    const revalidations: number[] = [];
    const dataOperationOwner = bindEncryptionDataOperationOwner({ policy: {
      resolve: () => Promise.resolve({
        policy: { mode: "encrypted_only" as const, shadowBehavior: "strict" as const },
        revalidationToken: 17,
      }),
      revalidate: (token) => {
        revalidations.push(token);
        return Promise.resolve();
      },
    } });
    const common = {
      ...input(resultApi, dataOperationOwner),
      resolveTrustedIssuingDevicePublicKey: () => Promise.resolve(null),
    };
    const request = {
      taskId,
      taskRunId,
      agentId: "30000000-0000-4000-8000-000000000250",
    };
    expect(await createBrowserHumanTaskRunResultReader(common).read(request))
      .toEqual({ status: "waiting", reason: "result_not_mapped" });
    const directory = await mkdtemp(join(tmpdir(), "nautilo-task-result-"));
    try {
      expect(await createElectronHumanTaskRunResultReader({
        ...common,
        directory,
        safeStorage: {
          isEncryptionAvailable: () => true,
          encryptString: (value) => Buffer.from(value, "utf8"),
          decryptString: (value) => value.toString("utf8"),
        },
      }).read(request)).toEqual({
        status: "waiting", reason: "result_not_mapped",
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
    expect(calls).toEqual([
      `${taskId}:${taskRunId}`,
      `${taskId}:${taskRunId}`,
    ]);
    expect(revalidations).toEqual([17, 17, 17, 17, 17, 17]);
  });

  test("Plain result reads reject before protected API or device custody", async () => {
    const taskId = "30000000-0000-4000-8000-000000000248";
    const taskRunId = "30000000-0000-4000-8000-000000000249";
    const effects: string[] = [];
    const api = {
      getProtectedTaskRunResultEnvelopeV1: async () => {
        effects.push("protected-api");
        throw new Error("Plain must not reach the protected result API");
      },
    } as unknown as NautiloApiClient;
    const directory = await mkdtemp(join(tmpdir(), "nautilo-task-result-plain-"));
    try {
      const reader = createElectronHumanTaskRunResultReader({
        ...input(api, owner("plaintext_only", "fallback")),
        directory,
        safeStorage: {
          isEncryptionAvailable: () => {
            effects.push("safe-storage-availability");
            return true;
          },
          encryptString: (value) => {
            effects.push("safe-storage-encrypt");
            return Buffer.from(value, "utf8");
          },
          decryptString: (value) => {
            effects.push("safe-storage-decrypt");
            return value.toString("utf8");
          },
        },
        resolveDeviceAdmissionStatus: () => {
          effects.push("device-admission");
          return Promise.reject(new Error("Plain must not inspect device admission"));
        },
        resolveTrustedIssuingDevicePublicKey: () => {
          effects.push("issuer-key");
          return Promise.resolve(null);
        },
      });
      let failure: unknown;
      try {
        await reader.read({
          taskId,
          taskRunId,
          agentId: "30000000-0000-4000-8000-000000000250",
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(ClassifiedDataOperationError);
      expect((failure as ClassifiedDataOperationError).failureClass)
        .toBe("unsupported");
      expect(effects).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("Shadow result failures never fall back to an ordinary read", async () => {
    const taskId = "30000000-0000-4000-8000-000000000248";
    const taskRunId = "30000000-0000-4000-8000-000000000249";
    const failure = new ClassifiedDataOperationError(
      "key_waiting", "protected result key is unavailable",
    );
    const reader = createBrowserHumanTaskRunResultReader({
      ...input({
        getProtectedTaskRunResultEnvelopeV1: () => Promise.reject(failure),
      } as unknown as NautiloApiClient, owner("shadow_encryption", "fallback")),
      resolveTrustedIssuingDevicePublicKey: () => Promise.resolve(null),
    });
    let received: unknown;
    try {
      await reader.read({
        taskId,
        taskRunId,
        agentId: "30000000-0000-4000-8000-000000000250",
      });
    } catch (error) {
      received = error;
    }
    expect(received).toBe(failure);
  });

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

  test("Browser cannot downgrade a Shadow failure through the legacy Plain endpoints", async () => {
    const calls: unknown[] = [];
    let protectedDefinitionReads = 0;
    const api = {
      getProtectedTaskDefinitionEnvelopeV1: async () => {
        protectedDefinitionReads += 1;
        throw new ClassifiedDataOperationError("key_waiting", "device key unavailable");
      },
      planProtectedTaskCreateV1: async () => {
        throw new ClassifiedDataOperationError("key_waiting", "device key unavailable");
      },
      planProtectedTaskUpdateV1: async () => {
        throw new ClassifiedDataOperationError("key_waiting", "device key unavailable");
      },
      planTaskOrdinaryFallbackCreateV1: async () => {
        calls.push("signed-fallback-plan");
        throw new ClassifiedDataOperationError("key_waiting", "Device fallback authority unavailable");
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
    expect(taskClient.create({
      payload: {
        formatVersion: 1,
        prompt: "private prompt",
        expectedOutput: null,
        protectedMetadata: {},
      },
      task: { scheduleKind: "now" },
    })).rejects.toThrow("Device fallback authority unavailable");
    expect(taskClient.update(summary, {
      payload: {
        formatVersion: 1,
        prompt: "updated private prompt",
        expectedOutput: "answer",
        protectedMetadata: {},
      },
      task: { timezone: "UTC" },
    })).rejects.toThrow("source content is unavailable");
    expect(protectedDefinitionReads).toBe(1);
    expect(calls).toEqual(["signed-fallback-plan"]);
  });

  test("Browser classifies only the exact server encryption-availability plan failure", async () => {
    for (const [status, code, expectedFallback] of [
      [409, "task_encryption_not_ready", true],
      [403, "task_encryption_not_ready", false],
      [403, "task_authority_unavailable", false],
      [409, "task_changed", false],
    ] as const) {
      let plans = 0;
      const initial = new ApiError(status, code);
      const missingDevice = new Error("signed fallback Device unavailable");
      const client = createBrowserHumanTaskClient(input({
        planProtectedTaskCreateV1: async () => { throw initial; },
        planTaskOrdinaryFallbackCreateV1: async () => { plans += 1; throw missingDevice; },
        createOrdinaryTaskV1: async () => { throw new Error("Plain route must remain idle"); },
      } as unknown as NautiloApiClient, owner("shadow_encryption", "fallback")));
      expect(client.create({ payload: { formatVersion: 1, prompt: "Task", expectedOutput: null, protectedMetadata: {} },
        task: {} })).rejects.toBe(expectedFallback ? missingDevice : initial);
      expect(plans).toBe(expectedFallback ? 1 : 0);
    }
  });
});
