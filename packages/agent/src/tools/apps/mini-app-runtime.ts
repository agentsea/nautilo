/**
 * M189 — dependency-injection seam for the `mini_app` tool.
 *
 * Authoring helpers live in `@nautilo/server` (apps root, manifest validation,
 * source writes). `@nautilo/agent` cannot import `@nautilo/server` because
 * server already depends on agent. Server wiring publishes a
 * {@link MiniAppToolRuntime} here; the tool reads it at invoke time.
 *
 * Tests inject a stub runtime via {@link setMiniAppToolRuntime}.
 */

export interface MiniAppSourceFile {
  path: string;
  content: string;
}

export interface MiniAppSourceWrite {
  path: string;
  content: string;
  baseSha256?: string | undefined;
}

export interface MiniAppToolActorContext {
  userId: string;
}

export interface MiniAppListAppsResult {
  ok: boolean;
  apps?: Array<{
    id: string;
    status?: string;
    sourceHash?: string;
    /** D343 — false when the app is disabled: keep it as a build REFERENCE
     *  (inspect/read_source), but never deploy or offer it for user tasks. */
    enabled?: boolean;
  }>;
  error?: string;
}

export interface MiniAppInspectAppResult {
  ok: boolean;
  appId?: string;
  status?: string;
  sourceHash?: string;
  /** D343 — see MiniAppListAppsResult: disabled = reference-only. */
  enabled?: boolean;
  manifest?: Record<string, unknown>;
  tree?: string[];
  error?: string;
}

export interface MiniAppReadSourceResult {
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
}

export interface MiniAppMutationResult {
  ok: boolean;
  command?: string;
  appId?: string;
  status?: string;
  sourceHash?: string;
  filesWritten?: string[];
  agentTools?: {
    declared?: boolean;
    registered?: string[];
  };
  validation?: Record<string, unknown>;
  error?: string;
}

export interface MiniAppToolRuntime {
  listApps(ctx: MiniAppToolActorContext): Promise<MiniAppListAppsResult>;
  inspectApp(
    ctx: MiniAppToolActorContext,
    input: { appId: string; includeTree?: boolean | undefined; includeManifest?: boolean | undefined },
  ): Promise<MiniAppInspectAppResult>;
  readSource(
    ctx: MiniAppToolActorContext,
    input: {
      appId: string;
      path: string;
      offsetBytes?: number | undefined;
      lengthBytes?: number | undefined;
      expectedSha256?: string | undefined;
    },
  ): Promise<MiniAppReadSourceResult>;
  createApp(
    ctx: MiniAppToolActorContext,
    input: { appId: string; files: MiniAppSourceFile[]; expectedSourceHash?: string | undefined },
  ): Promise<MiniAppMutationResult>;
  applySourceBatch(
    ctx: MiniAppToolActorContext,
    input: {
      appId: string;
      writes: MiniAppSourceWrite[];
      expectedSourceHash?: string | undefined;
      validateAfter?: boolean | undefined;
    },
  ): Promise<MiniAppMutationResult>;
  validateApp(
    ctx: MiniAppToolActorContext,
    input: { appId: string; buildRuntime?: boolean | undefined; buildAgentTools?: boolean | undefined },
  ): Promise<MiniAppMutationResult>;
}

let _miniAppToolRuntime: MiniAppToolRuntime | null = null;

export function setMiniAppToolRuntime(runtime: MiniAppToolRuntime | null): void {
  _miniAppToolRuntime = runtime;
}

export function getMiniAppToolRuntime(): MiniAppToolRuntime {
  if (!_miniAppToolRuntime) {
    throw new Error(
      "mini-app tool runtime not set — call setMiniAppToolRuntime() (server wiring / test setup) before the mini_app tool runs",
    );
  }
  return _miniAppToolRuntime;
}

export function resetMiniAppToolRuntimeForTests(): void {
  _miniAppToolRuntime = null;
}
