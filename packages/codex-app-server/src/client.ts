import type { Readable, Writable } from "node:stream";
import {
  JsonlFramer,
  SerializedJsonlWriter,
  type RpcEnvelope,
  type RpcId,
} from "./framing";
import {
  CodexRpcError,
  type ClientRequestParamsMap,
  type ClientResponseMap,
  type DecodedServerNotification,
  type EnabledServerNotificationMethod,
  type EnabledServerRequestMethod,
  type ReviewedClientMethod,
  type RpcRequestOptions,
  type RpcRuntimeDecoder,
  type ServerRequestContext,
  type ServerRequestHandlers,
  type ServerRequestParamsMap,
  type ServerNotificationParamsMap,
  buildServerRequestWireResponse,
} from "./rpc-types";
import { buildClientWireParams } from "./validators";

export type CodexRpcClientState =
  | "new"
  | "initializing"
  | "ready"
  | "closing"
  | "closed"
  | "faulted";

interface PendingRequest {
  readonly method: ReviewedClientMethod;
  readonly resolveResult: (value: unknown, decoder: RpcRuntimeDecoder) => void;
  readonly reject: (error: CodexRpcError) => void;
  readonly cleanup: () => void;
}

interface Tombstone {
  readonly lateAllowed: boolean;
}

export interface CodexRpcClientOptions {
  readonly readable: Readable;
  readonly writable: Writable;
  readonly decoder: RpcRuntimeDecoder;
  readonly serverRequestHandlers?: ServerRequestHandlers;
  readonly onNotification?: (notification: DecodedServerNotification) => void;
  readonly onFault?: (error: CodexRpcError) => void;
  readonly defaultTimeoutMs?: number;
  /** @deprecated Prefer the method-sensitive timeout options below. */
  readonly serverRequestTimeoutMs?: number;
  /** Native command, file, and permissions approvals default to two minutes. */
  readonly approvalRequestTimeoutMs?: number;
  /** Native request_user_input callbacks default to five minutes. */
  readonly userInputRequestTimeoutMs?: number;
  readonly maxTombstones?: number;
  readonly random?: () => number;
  readonly overloadDelayMs?: (attempt: number, random: number) => number;
  readonly delay?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
}

/** Locked by D453 finding 0.4; do not silently reduce human decision time. */
export const DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS = 2 * 60_000;
export const MAX_APPROVAL_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS = 5 * 60_000;

const SERVER_REQUEST_METHODS = new Set<EnabledServerRequestMethod>([
  "applyPatchApproval",
  "execCommandApproval",
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);

const SERVER_NOTIFICATION_METHODS = new Set<EnabledServerNotificationMethod>([
  "account/login/completed",
  "account/rateLimits/updated",
  "account/updated",
  "item/agentMessage/delta",
  "item/commandExecution/outputDelta",
  "item/commandExecution/terminalInteraction",
  "item/completed",
  "item/fileChange/outputDelta",
  "item/fileChange/patchUpdated",
  "item/started",
  "serverRequest/resolved",
  "thread/closed",
  "thread/started",
  "thread/status/changed",
  "thread/tokenUsage/updated",
  "turn/completed",
  "turn/diff/updated",
  "turn/started",
]);

function idKey(id: RpcId): string {
  return `${typeof id === "string" ? "s" : "n"}:${String(id)}`;
}

function boundedTimeout(configured: number | undefined, fallback: number, maximum: number): number {
  if (!Number.isFinite(configured) || configured === undefined || configured <= 0) {
    return fallback;
  }
  return Math.min(Math.floor(configured), maximum);
}

function defaultDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new CodexRpcError("cancelled"));
      return;
    }
    const finish = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CodexRpcError("cancelled"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

export class CodexRpcClient {
  private stateValue: CodexRpcClientState = "new";
  private readonly framer = new JsonlFramer();
  private readonly writer: SerializedJsonlWriter;
  private readonly outbound = new Map<string, PendingRequest>();
  private readonly inbound = new Map<string, AbortController>();
  private readonly outboundRetired = new Map<string, Tombstone>();
  private readonly inboundRetired = new Map<string, Tombstone>();
  private nextId = 1;
  private faultReported = false;
  private closePromise: Promise<void> | undefined;
  private readonly writableErrorHandler = () => {
    if (this.stateValue !== "closing" && this.stateValue !== "closed") {
      this.fault(new CodexRpcError("transport_failed"));
    }
  };

  constructor(private readonly options: CodexRpcClientOptions) {
    this.writer = new SerializedJsonlWriter(options.writable);
    options.writable.on("error", this.writableErrorHandler);
    void this.readLoop();
  }

  get state(): CodexRpcClientState {
    return this.stateValue;
  }

  async initialize(
    params: ClientRequestParamsMap["initialize"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["initialize"]> {
    if (this.stateValue !== "new") throw new CodexRpcError("protocol_violation");
    this.stateValue = "initializing";
    try {
      const response = await this.requestWithRetry("initialize", params, options, true);
      await this.writer.write({ method: "initialized" }, true);
      if (this.stateValue !== "initializing") {
        throw new CodexRpcError("closed");
      }
      this.stateValue = "ready";
      return response;
    } catch (error) {
      const safe = error instanceof CodexRpcError ? error : new CodexRpcError("transport_failed");
      this.fault(safe);
      throw safe;
    }
  }

  startThread(
    params: ClientRequestParamsMap["thread/start"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/start"]> {
    return this.request("thread/start", params, options);
  }

  resumeThread(
    params: ClientRequestParamsMap["thread/resume"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/resume"]> {
    return this.request("thread/resume", params, options);
  }

  readThread(
    params: ClientRequestParamsMap["thread/read"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/read"]> {
    return this.request("thread/read", params, options);
  }

  archiveThread(
    params: ClientRequestParamsMap["thread/archive"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/archive"]> {
    return this.request("thread/archive", params, options);
  }

  listThreads(
    params: ClientRequestParamsMap["thread/list"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/list"]> {
    return this.request("thread/list", params, options);
  }

  unarchiveThread(
    params: ClientRequestParamsMap["thread/unarchive"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["thread/unarchive"]> {
    return this.request("thread/unarchive", params, options);
  }

  startTurn(
    params: ClientRequestParamsMap["turn/start"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["turn/start"]> {
    return this.request("turn/start", params, options);
  }

  interruptTurn(
    params: ClientRequestParamsMap["turn/interrupt"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["turn/interrupt"]> {
    return this.request("turn/interrupt", params, options);
  }

  steerTurn(
    params: ClientRequestParamsMap["turn/steer"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["turn/steer"]> {
    return this.request("turn/steer", params, options);
  }

  listCollaborationModes(
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["collaborationMode/list"]> {
    return this.request("collaborationMode/list", undefined, options);
  }

  listModels(
    params: ClientRequestParamsMap["model/list"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["model/list"]> {
    return this.request("model/list", params, options);
  }

  startLogin(
    params: ClientRequestParamsMap["account/login/start"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/login/start"]> {
    return this.request("account/login/start", params, options);
  }

  cancelLogin(
    params: ClientRequestParamsMap["account/login/cancel"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/login/cancel"]> {
    return this.request("account/login/cancel", params, options);
  }

  logout(
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/logout"]> {
    return this.request("account/logout", undefined, options);
  }

  readAccount(
    params: ClientRequestParamsMap["account/read"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/read"]> {
    return this.request("account/read", params, options);
  }

  readRateLimits(
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/rateLimits/read"]> {
    return this.request("account/rateLimits/read", undefined, options);
  }

  readUsage(
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["account/usage/read"]> {
    return this.request("account/usage/read", undefined, options);
  }

  getAuthStatus(
    params: ClientRequestParamsMap["getAuthStatus"],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap["getAuthStatus"]> {
    return this.request("getAuthStatus", params, options);
  }

  private request<M extends Exclude<ReviewedClientMethod, "initialize">>(
    method: M,
    params: ClientRequestParamsMap[M],
    options?: RpcRequestOptions,
  ): Promise<ClientResponseMap[M]> {
    if (this.stateValue !== "ready") {
      return Promise.reject(new CodexRpcError("protocol_violation"));
    }
    return this.requestWithRetry(method, params, options, false);
  }

  private async requestWithRetry<M extends ReviewedClientMethod>(
    method: M,
    params: ClientRequestParamsMap[M],
    options: RpcRequestOptions | undefined,
    allowInitializing: boolean,
  ): Promise<ClientResponseMap[M]> {
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs ?? 30_000;
    const deadline = Date.now() + timeoutMs;
    const maxAttempts = options?.retryOverload === false ? 1 : 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new CodexRpcError("timeout");
      try {
        return await this.requestAttempt(method, params, remaining, options?.signal, allowInitializing);
      } catch (error) {
        if (
          !(error instanceof CodexRpcError) ||
          error.code !== "overloaded" ||
          attempt === maxAttempts
        ) {
          throw error;
        }
        const random = (this.options.random ?? Math.random)();
        const delayMs = (this.options.overloadDelayMs ?? ((n, value) => 50 * 2 ** (n - 1) + Math.floor(value * 25)))(attempt, random);
        if (delayMs >= deadline - Date.now()) throw new CodexRpcError("timeout");
        await (this.options.delay ?? defaultDelay)(delayMs, options?.signal);
      }
    }
    throw new CodexRpcError("overloaded");
  }

  private requestAttempt<M extends ReviewedClientMethod>(
    method: M,
    params: ClientRequestParamsMap[M],
    timeoutMs: number,
    signal: AbortSignal | undefined,
    allowInitializing: boolean,
  ): Promise<ClientResponseMap[M]> {
    if (
      this.stateValue !== "ready" &&
      !(allowInitializing && this.stateValue === "initializing")
    ) {
      return Promise.reject(new CodexRpcError("closed"));
    }
    if (signal?.aborted) return Promise.reject(new CodexRpcError("cancelled"));
    const id = `c-${this.nextId++}`;
    const key = idKey(id);
    return new Promise<ClientResponseMap[M]>((resolve, reject) => {
      const abort = () => retireAndReject(new CodexRpcError("cancelled"));
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      const retireAndReject = (error: CodexRpcError) => {
        if (!this.outbound.delete(key)) return;
        cleanup();
        this.retire(this.outboundRetired, key, true);
        reject(error);
      };
      const timer = setTimeout(
        () => retireAndReject(new CodexRpcError("timeout")),
        timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      this.outbound.set(key, {
        method,
        resolveResult: (value, decoder) =>
          resolve(decoder.decodeClientResponse(method, value)),
        reject,
        cleanup,
      });
      const handleWriteFailure = (error: unknown) => {
        const safe = error instanceof CodexRpcError ? error : new CodexRpcError("transport_failed");
        retireAndReject(safe);
        if (!new Set(["queue_full", "frame_too_large", "invalid_frame"]).has(safe.code)) {
          this.fault(new CodexRpcError("transport_failed"));
        }
      };
      try {
        void this.writer.write({
          id,
          method,
          params: buildClientWireParams(method, params),
        }).catch(handleWriteFailure);
      } catch (error) {
        handleWriteFailure(error);
      }
    });
  }

  private async readLoop(): Promise<void> {
    try {
      for await (const chunk of this.options.readable) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
        for (const envelope of this.framer.push(bytes)) this.handleEnvelope(envelope);
      }
      this.framer.finish();
      if (this.stateValue !== "closing" && this.stateValue !== "closed") {
        this.fault(new CodexRpcError("eof"));
      }
    } catch (error) {
      if (this.stateValue !== "closing" && this.stateValue !== "closed") {
        this.fault(error instanceof CodexRpcError ? error : new CodexRpcError("transport_failed"));
      }
    }
  }

  private handleEnvelope(envelope: RpcEnvelope): void {
    if (envelope.kind === "success" || envelope.kind === "failure") {
      this.handleResponse(envelope);
    } else if (envelope.kind === "request") {
      void this.handleServerRequest(envelope.id, envelope.method, envelope.params);
    } else {
      this.handleNotification(envelope.method, envelope.params);
    }
  }

  private handleResponse(
    envelope: Extract<RpcEnvelope, { kind: "success" | "failure" }>,
  ): void {
    const key = idKey(envelope.id);
    const pending = this.outbound.get(key);
    if (!pending) {
      const tombstone = this.outboundRetired.get(key);
      if (tombstone?.lateAllowed) return;
      this.fault(new CodexRpcError("protocol_violation"));
      return;
    }
    this.outbound.delete(key);
    pending.cleanup();
    this.retire(this.outboundRetired, key, false);
    if (envelope.kind === "failure") {
      try {
        const error = this.options.decoder.decodeError(envelope.error);
        pending.reject(
          error.code === -32001
            ? new CodexRpcError("overloaded", error.code)
            : new CodexRpcError("remote_error", error.code),
        );
      } catch {
        pending.reject(new CodexRpcError("protocol_violation"));
        this.fault(new CodexRpcError("protocol_violation"));
      }
      return;
    }
    try {
      pending.resolveResult(envelope.result, this.options.decoder);
    } catch {
      pending.reject(new CodexRpcError("protocol_violation"));
      this.fault(new CodexRpcError("protocol_violation"));
    }
  }

  private handleNotification(method: string, params: unknown): void {
    if (!SERVER_NOTIFICATION_METHODS.has(method as EnabledServerNotificationMethod)) return;
    try {
      const enabledMethod = method as EnabledServerNotificationMethod;
      const decoded = this.options.decoder.decodeServerNotification(enabledMethod, params);
      if (enabledMethod === "serverRequest/resolved") {
        // The app-server's JSON-RPC id is authoritative: cleanup may arrive
        // before the human proxy has a response, and must suppress any late write.
        const resolved = decoded as ServerNotificationParamsMap["serverRequest/resolved"];
        this.inbound.get(idKey(resolved.requestId))?.abort(new CodexRpcError("cancelled"));
      }
      this.options.onNotification?.({ method: enabledMethod, params: decoded } as DecodedServerNotification);
    } catch {
      this.fault(new CodexRpcError("protocol_violation"));
    }
  }

  private async handleServerRequest(id: RpcId, method: string, params: unknown): Promise<void> {
    const key = idKey(id);
    if (this.inbound.has(key) || this.inboundRetired.has(key)) {
      this.fault(new CodexRpcError("protocol_violation"));
      return;
    }
    const controller = new AbortController();
    this.inbound.set(key, controller);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      if (this.stateValue !== "ready") {
        this.fault(new CodexRpcError("protocol_violation"));
        return;
      }
      if (!SERVER_REQUEST_METHODS.has(method as EnabledServerRequestMethod)) {
        await this.safeControlWrite({ id, error: { code: -32601, message: "Method not available" } });
        return;
      }
      const enabledMethod = method as EnabledServerRequestMethod;
      let decoded: ReturnType<RpcRuntimeDecoder["decodeServerRequest"]>;
      try {
        decoded = this.options.decoder.decodeServerRequest(enabledMethod, params);
      } catch {
        this.fault(new CodexRpcError("protocol_violation"));
        return;
      }
      const timeoutMs = this.serverRequestTimeoutMs(enabledMethod, decoded);
      const context: ServerRequestContext = {
        signal: controller.signal,
        requestId: id,
        expiresAt: new Date(Date.now() + timeoutMs).toISOString(),
      };
      timeout = setTimeout(
        () => controller.abort(new CodexRpcError("timeout")),
        timeoutMs,
      );
      const handler = this.options.serverRequestHandlers?.[enabledMethod] as
        | ((value: typeof decoded, context: ServerRequestContext) => unknown)
        | undefined;
      if (!handler) {
        await this.safeControlWrite({ id, error: { code: -32601, message: "Method not available" } });
      } else {
        const handlerResult = await Promise.race([
          Promise.resolve(handler(decoded, context)),
          new Promise<never>((_, reject) => {
            controller.signal.addEventListener(
              "abort",
              () => reject(
                controller.signal.reason instanceof CodexRpcError
                  ? controller.signal.reason
                  : new CodexRpcError("cancelled"),
              ),
              { once: true },
            );
          }),
        ]);
        let result: unknown;
        try {
          result = buildServerRequestWireResponse(
            enabledMethod,
            this.options.decoder.decodeServerRequestResponse(
              enabledMethod,
              handlerResult,
            ),
          );
        } catch {
          await this.safeControlWrite({
            id,
            error: { code: -32603, message: "Request failed" },
          });
          this.fault(new CodexRpcError("protocol_violation"));
          return;
        }
        if (controller.signal.aborted) return;
        await this.safeControlWrite({ id, result });
      }
    } catch (error) {
      if (error instanceof CodexRpcError && error.code === "cancelled") return;
      const code = error instanceof CodexRpcError && error.code === "timeout" ? -32000 : -32603;
      await this.safeControlWrite({ id, error: { code, message: "Request failed" } });
    } finally {
      if (timeout) clearTimeout(timeout);
      this.inbound.delete(key);
      this.retire(this.inboundRetired, key, false);
    }
  }

  private serverRequestTimeoutMs(
    method: EnabledServerRequestMethod,
    decoded: ServerRequestParamsMap[EnabledServerRequestMethod],
  ): number {
    const legacyOverride = this.options.serverRequestTimeoutMs;
    if (legacyOverride !== undefined) {
      return boundedTimeout(
        legacyOverride,
        DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
        MAX_APPROVAL_REQUEST_TIMEOUT_MS,
      );
    }
    if (method === "item/tool/requestUserInput") {
      const configured = boundedTimeout(
        this.options.userInputRequestTimeoutMs,
        DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS,
        DEFAULT_USER_INPUT_REQUEST_TIMEOUT_MS,
      );
      const autoResolutionMs = (decoded as ServerRequestParamsMap["item/tool/requestUserInput"])
        .autoResolutionMs;
      return autoResolutionMs === null || autoResolutionMs === undefined
        ? configured
        : Math.min(configured, autoResolutionMs);
    }
    return boundedTimeout(
      this.options.approvalRequestTimeoutMs,
      DEFAULT_APPROVAL_REQUEST_TIMEOUT_MS,
      MAX_APPROVAL_REQUEST_TIMEOUT_MS,
    );
  }

  private async safeControlWrite(value: unknown): Promise<void> {
    try {
      await this.writer.write(value, true);
    } catch {
      if (this.stateValue !== "closing" && this.stateValue !== "closed") {
        this.fault(new CodexRpcError("transport_failed"));
      }
    }
  }

  private retire(map: Map<string, Tombstone>, key: string, lateAllowed: boolean): void {
    map.set(key, { lateAllowed });
    const max = this.options.maxTombstones ?? 1_024;
    while (map.size > max) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }

  private fault(error: CodexRpcError): void {
    if (
      this.stateValue === "faulted" ||
      this.stateValue === "closing" ||
      this.stateValue === "closed"
    ) {
      return;
    }
    this.stateValue = "faulted";
    for (const [key, pending] of this.outbound) {
      pending.cleanup();
      pending.reject(error);
      this.retire(this.outboundRetired, key, true);
    }
    this.outbound.clear();
    for (const controller of this.inbound.values()) controller.abort();
    this.inbound.clear();
    this.writer.abort(error);
    this.options.writable.off("error", this.writableErrorHandler);
    this.options.readable.destroy();
    this.options.writable.destroy();
    if (!this.faultReported) {
      this.faultReported = true;
      this.options.onFault?.(error);
    }
  }

  close(timeoutMs = 1_000): Promise<void> {
    if (this.closePromise) return this.closePromise;
    if (this.stateValue === "closed") return Promise.resolve();
    this.stateValue = "closing";
    this.closePromise = (async () => {
      const deadline = Date.now() + timeoutMs;
      for (const [key, pending] of this.outbound) {
        pending.cleanup();
        pending.reject(new CodexRpcError("closed"));
        this.retire(this.outboundRetired, key, true);
      }
      this.outbound.clear();
      for (const controller of this.inbound.values()) controller.abort();
      await this.writer.close(Math.max(0, deadline - Date.now()));
      const remaining = Math.max(0, deadline - Date.now());
      await Promise.race([
        new Promise<void>((resolve) => this.options.writable.end(resolve)),
        new Promise<void>((resolve) => setTimeout(resolve, remaining)),
      ]);
      this.options.writable.off("error", this.writableErrorHandler);
      this.options.readable.destroy();
      this.options.writable.destroy();
      this.stateValue = "closed";
    })();
    return this.closePromise;
  }
}
