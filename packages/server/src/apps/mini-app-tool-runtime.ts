import { scanInstalledApps } from "./app-registry";
import {
  AppSourceRangeError,
  AppSourceStaleSourceError,
  listAppSourceTree,
  readAppSourceFileRange,
} from "./app-source-store";
import {
  applyMiniAppSourceBatch,
  createMiniAppSource,
  validateMiniAppSource,
  type MiniAppAuthoringResult,
  type MiniAppAuthoringRegistration,
} from "./app-authoring-store";

type MiniAppMutationCommand = "create_app" | "apply_source_batch" | "validate_app";

type ServerMiniAppMutationResult = {
  ok: boolean;
  command?: MiniAppMutationCommand;
  appId?: string;
  status?: string;
  sourceHash?: string;
  filesWritten?: string[];
  agentTools?: { registered?: string[] };
  validation?: Record<string, unknown>;
  error?: string;
};

export type ServerMiniAppToolRuntime = {
  listApps(): Promise<{
    ok: boolean;
    apps?: Array<{ id: string; status?: string; sourceHash?: string; enabled?: boolean }>;
    error?: string;
  }>;
  inspectApp(
    ctx: { userId: string },
    input: { appId: string; includeTree?: boolean; includeManifest?: boolean },
  ): Promise<{
    ok: boolean;
    appId?: string;
    status?: string;
    sourceHash?: string;
    enabled?: boolean;
    manifest?: Record<string, unknown>;
    tree?: string[];
    error?: string;
  }>;
  readSource(
    ctx: { userId: string },
    input: {
      appId: string;
      path: string;
      offsetBytes?: number;
      lengthBytes?: number;
      expectedSha256?: string;
    },
  ): Promise<{
    ok: boolean;
    appId?: string;
    path?: string;
    content?: string;
    sha256?: string;
    totalBytes?: number;
    offsetBytes?: number;
    returnedBytes?: number;
    nextOffsetBytes?: number;
    complete?: boolean;
    expectedSha256?: string;
    currentSha256?: string;
    minimumBytes?: number;
    message?: string;
    error?: string;
  }>;
  createApp(
    ctx: { userId: string },
    input: { appId: string; files: Array<{ path: string; content: string }>; expectedSourceHash?: string },
  ): Promise<ServerMiniAppMutationResult>;
  applySourceBatch(
    ctx: { userId: string },
    input: {
      appId: string;
      writes: Array<{ path: string; content: string; baseSha256?: string }>;
      expectedSourceHash?: string;
    },
  ): Promise<ServerMiniAppMutationResult>;
  validateApp(
    ctx: { userId: string },
    input: { appId: string; buildRuntime?: boolean; buildAgentTools?: boolean },
  ): Promise<ServerMiniAppMutationResult>;
};

function registrationToolNames(registration: MiniAppAuthoringRegistration | undefined): string[] {
  if (!registration || registration.status !== "registered") return [];
  return registration.toolNames;
}

function mutationResult(
  command: MiniAppMutationCommand,
  result: MiniAppAuthoringResult,
): ServerMiniAppMutationResult {
  return {
    ok: true,
    command,
    appId: result.appId,
    status: result.status,
    sourceHash: result.sourceHash,
    filesWritten: result.filesWritten,
    agentTools: {
      registered: registrationToolNames(result.registration),
    },
    validation: {
      registration: result.registration,
    },
  };
}

function errorResult(error: unknown, command?: MiniAppMutationCommand): ServerMiniAppMutationResult {
  return {
    ok: false,
    ...(command ? { command } : {}),
    error: error instanceof Error ? error.message : String(error),
  };
}

export function createMiniAppToolRuntime(resolveAppsRoot: () => string): ServerMiniAppToolRuntime {
  return {
    async listApps() {
      try {
        const apps = await scanInstalledApps(resolveAppsRoot());
        return {
          ok: true,
          apps: apps.map((app) => ({
            id: app.id,
            status: app.status,
            enabled: app.enabled,
            ...(app.sourceHash ? { sourceHash: app.sourceHash } : {}),
          })),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async inspectApp(_ctx, input) {
      try {
        const appsRoot = resolveAppsRoot();
        const apps = await scanInstalledApps(appsRoot);
        const app = apps.find((entry) => entry.id === input.appId);
        if (!app) return { ok: false, error: "app not found" };

        return {
          ok: true,
          appId: app.id,
          status: app.status,
          enabled: app.enabled,
          ...(app.sourceHash ? { sourceHash: app.sourceHash } : {}),
          ...(input.includeManifest && app.manifest
            ? { manifest: app.manifest as unknown as Record<string, unknown> }
            : {}),
          ...(input.includeTree
            ? { tree: (await listAppSourceTree(appsRoot, app.id)).map((entry) => entry.path) }
            : {}),
        };
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async readSource(_ctx, input) {
      try {
        const file = await readAppSourceFileRange(resolveAppsRoot(), input.appId, input.path, {
          ...(input.offsetBytes === undefined ? {} : { offsetBytes: input.offsetBytes }),
          ...(input.lengthBytes === undefined ? {} : { lengthBytes: input.lengthBytes }),
          ...(input.expectedSha256 === undefined ? {} : { expectedSha256: input.expectedSha256 }),
        });
        return {
          ok: true,
          appId: input.appId,
          path: file.path,
          content: file.content,
          sha256: file.sha256,
          totalBytes: file.totalBytes,
          offsetBytes: file.offsetBytes,
          returnedBytes: file.returnedBytes,
          nextOffsetBytes: file.nextOffsetBytes,
          complete: file.complete,
        };
      } catch (err) {
        if (err instanceof AppSourceStaleSourceError) {
          return {
            ok: false,
            error: err.code,
            expectedSha256: err.expectedSha256,
            currentSha256: err.currentSha256,
          };
        }
        if (err instanceof AppSourceRangeError) {
          return {
            ok: false,
            error: err.code,
            message: err.message,
            ...(err.minimumBytes === undefined ? {} : { minimumBytes: err.minimumBytes }),
          };
        }
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },

    async createApp(_ctx, input) {
      try {
        const createInput: Parameters<typeof createMiniAppSource>[1] = {
          appId: input.appId,
          files: input.files,
        };
        if (input.expectedSourceHash !== undefined) {
          createInput.expectedSourceHash = input.expectedSourceHash;
        }
        return mutationResult(
          "create_app",
          await createMiniAppSource(resolveAppsRoot(), createInput),
        );
      } catch (err) {
        return errorResult(err, "create_app");
      }
    },

    async applySourceBatch(_ctx, input) {
      try {
        const batchInput: Parameters<typeof applyMiniAppSourceBatch>[1] = {
          appId: input.appId,
          writes: input.writes,
        };
        if (input.expectedSourceHash !== undefined) {
          batchInput.expectedSourceHash = input.expectedSourceHash;
        }
        return mutationResult(
          "apply_source_batch",
          await applyMiniAppSourceBatch(resolveAppsRoot(), batchInput),
        );
      } catch (err) {
        return errorResult(err, "apply_source_batch");
      }
    },

    async validateApp(_ctx, input) {
      try {
        const validateOpts: NonNullable<Parameters<typeof validateMiniAppSource>[2]> = {};
        if (input.buildRuntime !== undefined) {
          validateOpts.buildRuntime = input.buildRuntime;
        }
        if (input.buildAgentTools !== undefined) {
          validateOpts.buildAgentTools = input.buildAgentTools;
        }
        const validation = await validateMiniAppSource(
          resolveAppsRoot(),
          input.appId,
          validateOpts,
        );
        return {
          ok: validation.ok,
          command: "validate_app",
          appId: validation.appId,
          status: validation.status,
          ...(validation.sourceHash ? { sourceHash: validation.sourceHash } : {}),
          agentTools: {
            registered: registrationToolNames(validation.registration),
          },
          validation: {
            manifestError: validation.manifestError,
            runtimeBuild: validation.runtimeBuild,
            registration: validation.registration,
          },
          ...(!validation.ok ? { error: validation.manifestError ?? "mini-app validation failed" } : {}),
        };
      } catch (err) {
        return errorResult(err, "validate_app");
      }
    },
  };
}
