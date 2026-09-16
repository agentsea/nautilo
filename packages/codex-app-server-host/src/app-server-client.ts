import { Readable, Writable } from "node:stream";
import {
  CodexRpcClient,
  rpcRuntimeDecoder,
  type DecodedServerNotification,
  type EnabledServerRequestMethod,
  type ServerRequestContext,
  type ServerRequestHandlers,
  type ServerRequestParamsMap,
  type ServerRequestResponseMap,
} from "@nautilo/codex-app-server";
import type {
  AppServerClient,
  AppServerClientFactory,
  AppServerAccountProjection,
  AppServerChatgptLogin,
  AppServerResumeThreadInput,
  AppServerStartThreadInput,
  AppServerUsageProjection,
  AppServerPlanType,
  ChildIdentity,
  ChildStdio,
  ManagedChildProcess,
} from "./contracts";

const DEFAULT_CALLBACK_MAX_BYTES = 64 * 1024;
const MAX_HOST_PROJECTION_BYTES = 64 * 1024;
const MAX_UPSTREAM_LOGIN_ID_BYTES = 1024;
const MAX_AUTH_URL_BYTES = 4096;
const MAX_ACCOUNT_EMAIL_BYTES = 320;
const MAX_USAGE_BUCKETS = 366;
const PLAN_TYPES = new Set<AppServerPlanType>([
  "free", "go", "plus", "pro", "prolite", "team", "business", "enterprise", "edu", "unknown",
  "self_serve_business_usage_based", "enterprise_cbp_usage_based", "ent26",
]);

/**
 * Host-owned delivery seam. The receiver must reject a stale child identity;
 * no unbounded raw app-server frame is ever relayed through this interface.
 */
export interface CodexAppServerCallbacks {
  readonly isCurrent: (child: ChildIdentity) => boolean;
  readonly onTransportFault: (event: { readonly child: ChildIdentity }) => Promise<void> | void;
  readonly onCallbackFault: (event: { readonly child: ChildIdentity; readonly kind: "notification" | "request" }) => Promise<void> | void;
  readonly onNotification?: (event: { readonly child: ChildIdentity; readonly notification: DecodedServerNotification }) => Promise<void> | void;
  readonly onServerRequest?: <M extends EnabledServerRequestMethod>(event: {
    readonly child: ChildIdentity;
    readonly method: M;
    readonly params: ServerRequestParamsMap[M];
    readonly context: ServerRequestContext;
  }) => Promise<ServerRequestResponseMap[M]> | ServerRequestResponseMap[M];
}

export interface NodeCodexAppServerClientFactoryOptions {
  readonly callbacks: CodexAppServerCallbacks;
  /** Compatibility gate supplied by runtime admission; never probed or enabled implicitly. */
  readonly experimentalApi?: boolean | undefined;
  readonly clientName?: string;
  readonly clientTitle?: string;
  readonly clientVersion?: string;
  readonly maxCallbackBytes?: number;
}

/** Real stdio adapter. It is internal because product code receives only AppServerClient. */
export class NodeCodexAppServerClientFactory implements AppServerClientFactory {
  private readonly maxCallbackBytes: number;
  constructor(private readonly options: NodeCodexAppServerClientFactoryOptions) {
    this.maxCallbackBytes = options.maxCallbackBytes ?? DEFAULT_CALLBACK_MAX_BYTES;
    if (!Number.isSafeInteger(this.maxCallbackBytes) || this.maxCallbackBytes <= 0) throw new Error("maxCallbackBytes must be positive");
  }

  connect(child: ManagedChildProcess, identity: ChildIdentity): Promise<AppServerClient> {
    // Codex emits ordered JSONL notifications, but the host callback performs
    // asynchronous binding resolution before projecting them to relay events.
    // Preserve the upstream order through that asynchronous boundary; starting
    // every callback independently can reorder text deltas and terminal state.
    let notificationTail = Promise.resolve();
    const client = new CodexRpcClient({
      readable: readableFrom(child.stdio),
      writable: writableFrom(child.stdio),
      decoder: rpcRuntimeDecoder,
      onNotification: (notification) => {
        notificationTail = notificationTail.then(() =>
          this.deliverNotification(identity, notification),
        );
      },
      onFault: () => { this.reportTransportFault(identity); },
      serverRequestHandlers: this.handlers(identity),
    });
    return Promise.resolve(new TypedCodexAppServerClient(client, this.options));
  }

  private handlers(identity: ChildIdentity): ServerRequestHandlers {
    const methods: readonly EnabledServerRequestMethod[] = [
      "applyPatchApproval", "execCommandApproval", "item/commandExecution/requestApproval",
      "item/fileChange/requestApproval", "item/permissions/requestApproval", "item/tool/requestUserInput",
    ];
    return Object.fromEntries(methods.map((method) => [method, async (params: never, context: ServerRequestContext) => {
      if (!this.current(identity) || !withinLimit(params, this.maxCallbackBytes) || !this.options.callbacks.onServerRequest) {
        throw new Error("Codex callback unavailable");
      }
      try { return await this.options.callbacks.onServerRequest({ child: identity, method, params, context }); }
      catch { this.reportCallbackFault(identity, "request"); throw new Error("Codex callback unavailable"); }
    }])) as ServerRequestHandlers;
  }

  private async deliverNotification(
    identity: ChildIdentity,
    notification: DecodedServerNotification,
  ): Promise<void> {
    if (!this.current(identity) || !withinLimit(notification, this.maxCallbackBytes)) return;
    try {
      await this.options.callbacks.onNotification?.({
        child: identity,
        notification,
      });
    } catch {
      this.reportCallbackFault(identity, "notification");
    }
  }

  private current(identity: ChildIdentity): boolean { return this.options.callbacks.isCurrent(identity); }
  private reportTransportFault(identity: ChildIdentity): void { this.contain(() => this.options.callbacks.onTransportFault({ child: identity })); }
  private reportCallbackFault(identity: ChildIdentity, kind: "notification" | "request"): void { this.contain(() => this.options.callbacks.onCallbackFault({ child: identity, kind })); }
  private contain(work: () => Promise<void> | void): void { void Promise.resolve().then(work).catch(() => undefined); }
}

class TypedCodexAppServerClient implements AppServerClient {
  private readonly threadModels = new Map<string, string>();

  constructor(
    private readonly client: CodexRpcClient,
    private readonly options: NodeCodexAppServerClientFactoryOptions,
  ) {}

  async initialize(): Promise<{ readonly codexHome: string }> {
    const result = await this.client.initialize({
      clientName: this.options.clientName ?? "nautilo",
      clientTitle: this.options.clientTitle ?? "Nautilo",
      clientVersion: this.options.clientVersion ?? "0.1.0",
      experimentalApi: this.options.experimentalApi ?? false,
    });
    return Object.freeze({ codexHome: result.codexHome });
  }

  async startChatgptLogin(): Promise<AppServerChatgptLogin> {
    const response = await this.client.startLogin({ type: "chatgpt" });
    if (response.type !== "chatgpt" || !response.loginId || !response.authUrl) throw new Error("Official ChatGPT login was unavailable");
    boundedText(response.loginId, MAX_UPSTREAM_LOGIN_ID_BYTES, "upstream login identifier");
    boundedText(response.authUrl, MAX_AUTH_URL_BYTES, "authentication URL");
    const result = Object.freeze({ upstreamLoginId: response.loginId, authUrl: response.authUrl });
    assertHostProjectionBound(result);
    return result;
  }

  async cancelLogin(upstreamLoginId: string): Promise<{ readonly cancelled: boolean }> {
    boundedText(upstreamLoginId, MAX_UPSTREAM_LOGIN_ID_BYTES, "host-local login identifier");
    const response = await this.client.cancelLogin({ loginId: upstreamLoginId });
    return Object.freeze({ cancelled: response.status === "canceled" });
  }

  async readAccount(): Promise<AppServerAccountProjection> {
    const response = await this.client.readAccount({ refreshToken: false });
    if (response.account?.type === "chatgpt") {
      if (!PLAN_TYPES.has(response.account.planType)) throw new Error("Unsupported account plan projection");
      if (response.account.email !== null) {
        boundedText(response.account.email, MAX_ACCOUNT_EMAIL_BYTES, "account email");
      }
      const result = Object.freeze({
        state: "signed_in" as const,
        requiresOpenaiAuth: response.requiresOpenaiAuth,
        email: response.account.email,
        planType: response.account.planType,
      });
      assertHostProjectionBound(result);
      return result;
    }
    const result: AppServerAccountProjection = Object.freeze({ state: response.account ? "unsupported" : "signed_out", requiresOpenaiAuth: response.requiresOpenaiAuth });
    assertHostProjectionBound(result);
    return result;
  }

  async readUsage(): Promise<AppServerUsageProjection> {
    const response = await this.client.readUsage();
    const summary = response.summary;
    const buckets = response.dailyUsageBuckets ?? [];
    if (buckets.length > MAX_USAGE_BUCKETS) throw new Error("Usage projection contains too many buckets");
    const result: AppServerUsageProjection = Object.freeze({
      ...(summary.lifetimeTokens === null ? {} : { lifetimeTokens: digits(summary.lifetimeTokens) }),
      ...(summary.peakDailyTokens === null ? {} : { peakDailyTokens: digits(summary.peakDailyTokens) }),
      ...(summary.longestRunningTurnSec === null ? {} : { longestRunningTurnSec: digits(summary.longestRunningTurnSec) }),
      ...(summary.currentStreakDays === null ? {} : { currentStreakDays: digits(summary.currentStreakDays) }),
      ...(summary.longestStreakDays === null ? {} : { longestStreakDays: digits(summary.longestStreakDays) }),
      dailyUsage: Object.freeze(buckets.map((bucket) => Object.freeze({ startDate: canonicalDate(bucket.startDate), tokens: digits(bucket.tokens) }))),
    });
    assertHostProjectionBound(result);
    return result;
  }

  async listModels(): Promise<import("./contracts").AppServerModelCatalog> {
    const models: import("./contracts").AppServerModelCatalogEntry[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const response = await this.client.listModels({
        cursor,
        limit: 100,
        includeHidden: false,
      });
      for (const item of response.data) {
        boundedText(item.id, 512, "model id");
        boundedText(item.model, 512, "model slug");
        boundedText(item.displayName, 256, "model display name");
        if (item.description.length > 4_096) throw new Error("Model description exceeds host projection bound");
        models.push(Object.freeze({
          id: item.id,
          model: item.model,
          displayName: item.displayName,
          description: item.description,
          isDefault: item.isDefault,
        }));
        if (models.length > 1_000) throw new Error("Model catalog exceeds host projection bound");
      }
      cursor = response.nextCursor;
      if (cursor === null) break;
      boundedText(cursor, 512, "model cursor");
      if (page === 9) throw new Error("Model catalog pagination exceeds host projection bound");
    }
    const result = Object.freeze({ models: Object.freeze(models) });
    assertHostProjectionBound(result);
    return result;
  }

  async logout(): Promise<void> { await this.client.logout(); }

  async startThread(input: AppServerStartThreadInput): Promise<{ readonly threadId: string; readonly cwd: string }> {
    const posture = mapPosture(input);
    const response = await this.client.startThread({
      cwd: input.cwd,
      model: input.model,
      ...posture,
    });
    this.threadModels.set(response.thread.id, response.model);
    return Object.freeze({ threadId: response.thread.id, cwd: response.cwd });
  }

  async resumeThread(input: AppServerResumeThreadInput): Promise<{ readonly cwd: string }> {
    const response = await this.client.resumeThread({ threadId: input.threadId, cwd: input.cwd, model: input.model });
    this.threadModels.set(input.threadId, response.model);
    return Object.freeze({ cwd: response.cwd });
  }

  async startTurn(input: {
    readonly threadId: string;
    readonly text: string;
    readonly clientUserMessageId: string;
    readonly collaborationMode: "work" | "plan";
  }): Promise<{ readonly turnId: string }> {
    const selectedThreadModel = this.threadModels.get(input.threadId);
    if (!selectedThreadModel) {
      throw new Error("Codex thread model is unavailable for collaboration mode");
    }
    const presets = await this.client.listCollaborationModes();
    const upstreamMode = input.collaborationMode === "work" ? "default" : "plan";
    const collaborationModePreset = presets.data.find((preset) => preset.mode === upstreamMode);
    if (!collaborationModePreset) {
      throw new Error(`Codex ${input.collaborationMode} mode is unavailable`);
    }
    const response = await this.client.startTurn({
      threadId: input.threadId,
      text: input.text,
      clientUserMessageId: input.clientUserMessageId,
      collaborationMode: input.collaborationMode,
      collaborationModePreset,
      selectedThreadModel,
    });
    return Object.freeze({ turnId: response.turn.id });
  }

  async interruptThread(input: { readonly threadId: string; readonly turnId: string }): Promise<void> {
    await this.client.interruptTurn(input);
  }

  async steerThread(input: {
    readonly threadId: string;
    readonly turnId: string;
    readonly text: string;
    readonly clientUserMessageId: string;
  }): Promise<void> {
    const response = await this.client.steerTurn({
      threadId: input.threadId,
      expectedTurnId: input.turnId,
      text: input.text,
      clientUserMessageId: input.clientUserMessageId,
    });
    if (response.turnId !== input.turnId) {
      throw new Error("Codex steer response did not match the active turn");
    }
  }
  close(): Promise<void> { return this.client.close(); }
}

function mapPosture(input: AppServerStartThreadInput): { readonly sandbox?: "workspace-write" | "danger-full-access"; readonly approvalPolicy?: "on-request" | "never" } {
  switch (input.posture.kind) {
    case "codex_default": return Object.freeze({});
    case "prompted_workspace": return Object.freeze({ sandbox: "workspace-write", approvalPolicy: "on-request" });
    case "full_access_headless": return Object.freeze({ sandbox: "danger-full-access", approvalPolicy: "never" });
  }
}

function readableFrom(stdio: ChildStdio): Readable { return Readable.from(stdio.stdout); }
function writableFrom(stdio: ChildStdio): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, callback) { void stdio.stdin.write(chunk).then(() => callback(), callback); },
    final(callback) { void stdio.stdin.end().then(() => callback(), callback); },
  });
}
function withinLimit(value: unknown, limit: number): boolean {
  try { return Buffer.byteLength(JSON.stringify(value), "utf8") <= limit; } catch { return false; }
}
function boundedText(value: string, maxBytes: number, label: string): void {
  if (!value || value.includes("\0") || Buffer.byteLength(value, "utf8") > maxBytes) throw new Error(`Invalid ${label}`);
}
function digits(value: number | string): string {
  const text = String(value);
  if (!/^\d{1,32}$/.test(text)) throw new Error("Invalid usage value");
  return text;
}
function canonicalDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("Invalid usage date");
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("Invalid usage date");
  return value;
}
/** Internal invariant helper exported only through the host-internal barrel. */
export function assertHostProjectionBound(value: unknown): void {
  if (!withinLimit(value, MAX_HOST_PROJECTION_BYTES)) throw new Error("Host projection exceeded its byte limit");
}
