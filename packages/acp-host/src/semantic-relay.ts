import type {
  AcpAdapterEvent,
  AcpPermissionRequest,
  AcpPermissionSelection,
  AcpTurnResult,
} from "./stable-v1-adapter.js";
import {
  isValidatedAcpCapabilityTruth,
  type AcpCapabilityTruth,
} from "./capability-truth.js";

export const ACP_RELAY_MAX_FRAME_BYTES = 256 * 1024;
export const ACP_PERMISSION_LIFETIME_MS = 5 * 60 * 1000;
const MAX_IDENTIFIER_BYTES = 512;
const MAX_TEXT_BYTES = 64 * 1024;
const MAX_TOOL_ENTRIES = 100;
const MAX_PENDING_PERMISSIONS = 16;
const MAX_PENDING_PERMISSION_BYTES = 1024 * 1024;
const MAX_SEMANTIC_QUEUE_COUNT = 128;
const MAX_SEMANTIC_QUEUE_BYTES = 1024 * 1024;
const encoder = new TextEncoder();

/** Server-minted admission facts. No local path or process detail belongs here. */
export type AcpHostScope = Readonly<{
  relayId: string;
  relaySessionId: string;
  desktopSessionId: string;
  pairingGenerationRef: string;
  selectedProtocolVersion: number;
  capabilityRevision: number;
  bindingId: string;
  bindingGeneration: string;
  ownerId: string;
  taskId: string;
  taskRunId: string;
  jobId: string;
  workspaceReceiptId: string;
  workspaceRevision: string;
  workspaceFingerprint: string;
  workspaceExpiresAt: string;
  profileId: string;
  profileGeneration: string;
  postureId: string;
  postureGeneration: string;
}>;

/** Electron-local correlation. `turnRef` is never represented as an ACP turn ID. */
export type AcpProcessScope = Readonly<{
  connectionId: string;
  processGeneration: number;
  acpSessionId: string;
  turnGeneration: number;
  turnRef: string;
}>;

export type { AcpCapabilityTruth } from "./capability-truth.js";

export type AcpRelayAttribution = Readonly<{
  bindingId: string;
  bindingGeneration: string;
  taskId: string;
  roomId: string | null;
  vendorSessionId: string;
  vendorTurnId: null;
  vendorItemId: string | null;
}>;

export type AcpRelaySemantic =
  | Readonly<{ kind: "output_delta"; attribution: AcpRelayAttribution; text: string }>
  | Readonly<{ kind: "assistant_completed"; attribution: AcpRelayAttribution; text: string }>
  | Readonly<{
      kind: "command_summary";
      attribution: AcpRelayAttribution;
      commands: readonly Readonly<{
        summary: string;
        status: "completed" | "failed" | "running";
      }>[];
    }>
  | Readonly<{
      kind: "terminal";
      attribution: AcpRelayAttribution;
      status: "completed" | "failed" | "interrupted";
      code?: "invalid_request" | "process_lost" | "upstream_failure" | "user_stop";
      message?: "The external agent could not complete this task.";
    }>;

export type AcpRelayPermissionRequest = Readonly<{
  kind: "permission_selection_required";
  requestId: string;
  vendorRequestId: string | null;
  attribution: AcpRelayAttribution;
  ownerId: string;
  expiresAt: string;
  options: readonly Readonly<{ id: string; label: string; semanticHint: string | null }>[];
  tool: Readonly<{ title: string | null; kind: string | null }>;
}>;

export type AcpRelayFrame = Readonly<{
  scope: AcpHostScope;
  process: AcpProcessScope;
  capabilities: AcpCapabilityTruth;
  payload: AcpRelaySemantic | AcpRelayPermissionRequest;
}>;

export type AcpRelayPermissionResponse = Readonly<{
  scope: AcpHostScope;
  process: AcpProcessScope;
  requestId: string;
  ownerId: string;
  outcome:
    | Readonly<{ kind: "selected"; optionId: string }>
    | Readonly<{ kind: "cancelled" }>;
}>;

export type AcpRelayClock = Readonly<{
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): unknown;
  clearTimeout(handle: unknown): void;
}>;

/**
 * Closed, host-local evidence for a terminal prompt result that cannot be
 * promoted to a completed assistant message. It deliberately excludes all
 * provider, session, and prompt data.
 */
export type AcpTerminalFailureReason =
  | "end_turn_without_candidate"
  | "max_tokens"
  | "max_turn_requests"
  | "refusal"
  | "unowned_cancelled";

export class AcpSemanticRelayError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "stale_scope"
      | "wrong_owner"
      | "request_expired"
      | "already_settled"
      | "relay_overflow",
    message: string,
  ) {
    super(message);
    this.name = "AcpSemanticRelayError";
  }
}

type PendingPermission = {
  readonly request: AcpRelayPermissionRequest;
  readonly bytes: number;
  readonly resolve: (selection: AcpPermissionSelection) => void;
  readonly expiry: unknown;
};

export type AcpSemanticRelayOptions = Readonly<{
  scope: AcpHostScope;
  process: AcpProcessScope;
  roomId: string | null;
  capabilities: AcpCapabilityTruth;
  emit(frame: AcpRelayFrame): Promise<void> | void;
  mintRequestId(): string;
  /** Advisory closed-enum evidence immediately before an upstream failure terminal. */
  onTerminalFailure?: (reason: AcpTerminalFailureReason) => void;
  clock?: AcpRelayClock;
  permissionLifetimeMs?: number;
}>;

export type AcpRelayDecodeExpectation = Readonly<{
  scope: AcpHostScope;
  process: AcpProcessScope;
  capabilities: AcpCapabilityTruth;
  roomId: string | null;
  now: number;
}>;

/**
 * Pure server-side ingress gate. It rejects bytes before parse, checks every
 * authority identity, and returns a freshly canonicalized semantic payload.
 */
export function decodeAcpRelayFrame(
  bytes: Uint8Array,
  expected: AcpRelayDecodeExpectation,
): AcpRelaySemantic | AcpRelayPermissionRequest {
  if (bytes.byteLength === 0 || bytes.byteLength > ACP_RELAY_MAX_FRAME_BYTES) {
    throw new AcpSemanticRelayError("relay_overflow", "ACP relay frame exceeds its bound");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  } catch {
    throw new AcpSemanticRelayError("invalid_request", "ACP relay frame is malformed");
  }
  const frame = asRecord(parsed, "ACP relay frame");
  const scope = parseHostScope(frame["scope"]);
  const process = parseProcessScope(frame["process"]);
  if (!sameHostScope(expected.scope, scope) || !sameProcessScope(expected.process, process)) {
    throw new AcpSemanticRelayError("stale_scope", "ACP relay frame scope is stale");
  }
  validateHostScope(scope, expected.now);
  validateProcessScope(process);
  const capabilities = parseCapabilities(frame["capabilities"]);
  if (!sameCapabilities(expected.capabilities, capabilities)) {
    throw new AcpSemanticRelayError("stale_scope", "ACP relay capability revision is stale");
  }
  const payload = asRecord(frame["payload"], "ACP relay payload");
  const attribution = parseAttribution(payload["attribution"], expected);
  const kind = payload["kind"];
  if (kind === "output_delta" || kind === "assistant_completed") {
    const text = payload["text"];
    assertText(text, "ACP relay text");
    return Object.freeze({ kind, attribution, text });
  }
  if (kind === "command_summary") {
    if (!Array.isArray(payload["commands"]) || payload["commands"].length > MAX_TOOL_ENTRIES) {
      throw new TypeError("ACP command summary exceeds its bound");
    }
    const commands = payload["commands"].map((item) => {
      const command = asRecord(item, "ACP command summary");
      const summary = command["summary"];
      const status = command["status"];
      assertText(summary, "ACP command summary text");
      if (status !== "completed" && status !== "failed" && status !== "running") {
        throw new TypeError("ACP command summary status is invalid");
      }
      return Object.freeze({ summary, status });
    });
    return Object.freeze({ kind, attribution, commands: Object.freeze(commands) });
  }
  if (kind === "terminal") {
    const status = payload["status"];
    const code = payload["code"];
    const message = payload["message"];
    if (status !== "completed" && status !== "failed" && status !== "interrupted") {
      throw new TypeError("ACP terminal status is invalid");
    }
    if (
      code !== undefined && code !== "invalid_request" && code !== "process_lost" &&
      code !== "upstream_failure" && code !== "user_stop"
    ) throw new TypeError("ACP terminal code is invalid");
    if (message !== undefined && message !== "The external agent could not complete this task.") {
      throw new TypeError("ACP terminal diagnostic is not sanitized");
    }
    if (status === "completed" && (code !== undefined || message !== undefined)) {
      throw new TypeError("completed ACP terminal cannot carry a failure diagnostic");
    }
    if (status === "interrupted" && code !== "user_stop") {
      throw new TypeError("interrupted ACP terminal lacks Stop authority");
    }
    if (status === "interrupted" && message !== undefined) {
      throw new TypeError("interrupted ACP terminal cannot carry a failure diagnostic");
    }
    if (status === "failed" && code !== "invalid_request" && code !== "process_lost" && code !== "upstream_failure") {
      throw new TypeError("failed ACP terminal lacks a stable failure code");
    }
    return Object.freeze({ kind, attribution, status, ...(code === undefined ? {} : { code }), ...(message === undefined ? {} : { message }) });
  }
  if (kind === "permission_selection_required") {
    const requestId = payload["requestId"];
    const vendorRequestId = payload["vendorRequestId"];
    const ownerId = payload["ownerId"];
    const expiresAt = payload["expiresAt"];
    assertIdentifier(requestId, "request ID");
    if (vendorRequestId !== null) assertIdentifier(vendorRequestId, "vendor request ID");
    assertIdentifier(ownerId, "owner ID");
    if (ownerId !== expected.scope.ownerId) throw new AcpSemanticRelayError("wrong_owner", "ACP request owner is wrong");
    const expiresAtMs = typeof expiresAt === "string" ? Date.parse(expiresAt) : Number.NaN;
    if (
      !Number.isFinite(expiresAtMs) || expiresAtMs <= expected.now ||
      expiresAtMs > expected.now + ACP_PERMISSION_LIFETIME_MS ||
      expiresAtMs > Date.parse(expected.scope.workspaceExpiresAt)
    ) {
      throw new AcpSemanticRelayError("request_expired", "ACP request has expired");
    }
    if (typeof expiresAt !== "string") throw new TypeError("ACP request expiry is invalid");
    if (!Array.isArray(payload["options"]) || payload["options"].length > 20) {
      throw new TypeError("ACP permission options exceed their bound");
    }
    const options = payload["options"].map((item) => {
      const option = asRecord(item, "ACP permission option");
      const id = option["id"];
      const label = option["label"];
      const semanticHint = option["semanticHint"];
      assertIdentifier(id, "ACP permission option ID");
      assertText(label, "ACP permission option label");
      if (semanticHint !== null) assertIdentifier(semanticHint, "ACP permission semantic hint");
      return Object.freeze({ id, label, semanticHint });
    });
    if (new Set(options.map((option) => option.id)).size !== options.length) {
      throw new TypeError("ACP permission option IDs must be unique");
    }
    const toolValue = asRecord(payload["tool"], "ACP permission tool");
    const title = toolValue["title"];
    const toolKind = toolValue["kind"];
    if (title !== null) assertText(title, "ACP permission tool title");
    if (toolKind !== null) assertIdentifier(toolKind, "ACP permission tool kind");
    return Object.freeze({
      kind,
      requestId,
      vendorRequestId,
      attribution,
      ownerId,
      expiresAt,
      options: Object.freeze(options),
      tool: Object.freeze({ title, kind: toolKind }),
    });
  }
  throw new TypeError("ACP relay payload kind is not admitted");
}

/**
 * One exact admitted prompt's semantic projector and permission broker.
 * It has no method accepting JSON-RPC, provider extensions, paths, or diagnostics.
 */
export class AcpSemanticRelay {
  readonly #scope: AcpHostScope;
  readonly #process: AcpProcessScope;
  readonly #roomId: string | null;
  readonly #capabilities: AcpCapabilityTruth;
  readonly #emitFrame: AcpSemanticRelayOptions["emit"];
  readonly #mintRequestId: () => string;
  readonly #onTerminalFailure: ((reason: AcpTerminalFailureReason) => void) | undefined;
  readonly #clock: AcpRelayClock;
  readonly #permissionLifetimeMs: number;
  readonly #pending = new Map<string, PendingPermission>();
  readonly #settled = new Set<string>();
  readonly #tools = new Map<string, { summary: string; status: "completed" | "failed" | "running" }>();
  #pendingBytes = 0;
  #candidate = "";
  #candidateItemId: string | null = null;
  #closed = false;
  #stoppingGeneration: number | null = null;
  #emitQueueCount = 0;
  #emitQueueBytes = 0;
  #emitChain: Promise<void> = Promise.resolve();
  #emitFault: AcpSemanticRelayError | null = null;

  constructor(options: AcpSemanticRelayOptions) {
    this.#clock = options.clock ?? systemClock;
    validateHostScope(options.scope, this.#clock.now());
    validateProcessScope(options.process);
    if (options.roomId !== null) assertIdentifier(options.roomId, "room ID");
    if (!isValidatedAcpCapabilityTruth(options.capabilities)) {
      throw new TypeError("ACP capability truth must come from validated initialization");
    }
    this.#scope = Object.freeze({ ...options.scope });
    this.#process = Object.freeze({ ...options.process });
    this.#roomId = options.roomId;
    this.#capabilities = Object.freeze({ ...options.capabilities });
    this.#emitFrame = options.emit;
    this.#mintRequestId = options.mintRequestId;
    this.#onTerminalFailure = options.onTerminalFailure;
    const lifetime = options.permissionLifetimeMs ?? ACP_PERMISSION_LIFETIME_MS;
    if (!Number.isSafeInteger(lifetime) || lifetime <= 0 || lifetime > ACP_PERMISSION_LIFETIME_MS) {
      throw new TypeError("permission lifetime exceeds the D452 bound");
    }
    this.#permissionLifetimeMs = lifetime;
  }

  async project(event: AcpAdapterEvent): Promise<void> {
    this.#requireOpen();
    this.#requireReceiptLive();
    this.#requireSession(event.sessionId);
    if (event.kind === "agent_text_chunk") {
      const next = `${this.#candidate}${event.text}`;
      if (utf8Bytes(next) > MAX_TEXT_BYTES) {
        throw new AcpSemanticRelayError("relay_overflow", "ACP text candidate exceeds its semantic bound");
      }
      this.#candidate = next;
      this.#candidateItemId = event.messageId;
      await this.#emit({
        kind: "output_delta",
        attribution: this.#attribution(event.messageId),
        text: event.text,
      });
      return;
    }
    const prior = this.#tools.get(event.toolCallId);
    const status = event.status === "completed"
      ? "completed"
      : event.status === "failed"
        ? "failed"
        : event.status === null && prior
          ? prior.status
          : "running";
    if (!this.#tools.has(event.toolCallId) && this.#tools.size >= MAX_TOOL_ENTRIES) {
      throw new AcpSemanticRelayError("relay_overflow", "ACP tool summary count exceeds its semantic bound");
    }
    const summary = event.title || prior?.summary;
    if (!summary) return;
    this.#tools.set(event.toolCallId, { summary, status });
    await this.#emit({
      kind: "command_summary",
      attribution: this.#attribution(event.toolCallId),
      commands: [{ summary, status }],
    });
  }

  async permission(request: AcpPermissionRequest): Promise<AcpPermissionSelection> {
    this.#requireOpen();
    this.#requireReceiptLive();
    this.#requireSession(request.sessionId);
    if (this.#stoppingGeneration === this.#process.turnGeneration) {
      return { outcome: "cancelled" };
    }
    if (this.#capabilities.requests !== "supported") {
      throw new AcpSemanticRelayError("invalid_request", "ACP permissions were not negotiated");
    }
    if (this.#pending.size >= MAX_PENDING_PERMISSIONS) {
      throw new AcpSemanticRelayError("relay_overflow", "too many pending ACP permissions");
    }
    const requestId = this.#mintRequestId();
    assertIdentifier(requestId, "request ID");
    if (this.#pending.has(requestId) || this.#settled.has(requestId)) {
      throw new AcpSemanticRelayError("invalid_request", "request ID is not unique");
    }
    const now = this.#clock.now();
    const expiresAt = Math.min(now + this.#permissionLifetimeMs, Date.parse(this.#scope.workspaceExpiresAt));
    const projected: AcpRelayPermissionRequest = Object.freeze({
      kind: "permission_selection_required",
      requestId,
      vendorRequestId: null,
      attribution: this.#attribution(request.toolCallId),
      ownerId: this.#scope.ownerId,
      expiresAt: new Date(expiresAt).toISOString(),
      options: Object.freeze(request.options.map((option) => Object.freeze({
        id: option.optionId,
        label: option.name,
        semanticHint: option.kind,
      }))),
      tool: Object.freeze({ ...request.tool }),
    });
    const bytes = serializedBytes(projected);
    if (this.#pendingBytes + bytes > MAX_PENDING_PERMISSION_BYTES) {
      throw new AcpSemanticRelayError("relay_overflow", "pending ACP permissions exceed their byte bound");
    }
    const selection = new Promise<AcpPermissionSelection>((resolve) => {
      const expiry = this.#clock.setTimeout(() => {
        const pending = this.#pending.get(requestId);
        if (!pending) return;
        this.#removePending(requestId, pending);
        this.#settled.add(requestId);
        resolve({ outcome: "cancelled" });
      }, expiresAt - now);
      this.#pending.set(requestId, { request: projected, bytes, resolve, expiry });
      this.#pendingBytes += bytes;
    });
    try {
      await this.#emit(projected);
    } catch {
      const pending = this.#pending.get(requestId);
      if (pending) {
        this.#removePending(requestId, pending);
        this.#settled.add(requestId);
        pending.resolve({ outcome: "cancelled" });
      }
      throw new AcpSemanticRelayError("relay_overflow", "ACP permission relay is unavailable");
    }
    return selection;
  }

  respond(input: unknown): void {
    const response = parsePermissionResponse(input);
    if (!sameHostScope(this.#scope, response.scope) || !sameProcessScope(this.#process, response.process)) {
      throw new AcpSemanticRelayError("stale_scope", "ACP response scope is stale");
    }
    validateHostScope(response.scope, this.#clock.now());
    validateProcessScope(response.process);
    assertIdentifier(response.requestId, "request ID");
    assertIdentifier(response.ownerId, "owner ID");
    if (response.ownerId !== this.#scope.ownerId) {
      throw new AcpSemanticRelayError("wrong_owner", "ACP response owner is wrong");
    }
    const pending = this.#pending.get(response.requestId);
    if (!pending) {
      throw new AcpSemanticRelayError(
        this.#settled.has(response.requestId) ? "already_settled" : "request_expired",
        "ACP permission is no longer pending",
      );
    }
    if (Date.parse(pending.request.expiresAt) <= this.#clock.now()) {
      this.#removePending(response.requestId, pending);
      this.#settled.add(response.requestId);
      pending.resolve({ outcome: "cancelled" });
      throw new AcpSemanticRelayError("request_expired", "ACP permission has expired");
    }
    let selection: AcpPermissionSelection;
    if (response.outcome.kind === "cancelled") {
      selection = { outcome: "cancelled" };
    } else {
      const optionId = response.outcome.optionId;
      assertIdentifier(optionId, "permission option ID");
      if (!pending.request.options.some((option) => option.id === optionId)) {
        throw new AcpSemanticRelayError("invalid_request", "ACP permission option was not offered");
      }
      selection = { outcome: "selected", optionId };
    }
    this.#removePending(response.requestId, pending);
    this.#settled.add(response.requestId);
    pending.resolve(selection);
  }

  async complete(result: AcpTurnResult): Promise<void> {
    this.#requireOpen();
    this.#requireReceiptLive();
    this.#requireSession(result.sessionId);
    this.#closed = true;
    this.#cancelPending();
    if (result.stopReason === "end_turn" && this.#candidate.length > 0) {
      await this.#emit({
        kind: "assistant_completed",
        attribution: this.#attribution(this.#candidateItemId),
        text: this.#candidate,
      });
      await this.#emit({
        kind: "terminal",
        attribution: this.#attribution(this.#candidateItemId),
        status: "completed",
      });
      return;
    }
    if (result.stopReason === "cancelled" && this.#stoppingGeneration === this.#process.turnGeneration) {
      await this.#emit({
        kind: "terminal",
        attribution: this.#attribution(null),
        status: "interrupted",
        code: "user_stop",
      });
      return;
    }
    this.#reportTerminalFailure(terminalFailureReason(result.stopReason));
    await this.#emit({
      kind: "terminal",
      attribution: this.#attribution(null),
      status: "failed",
      code: "upstream_failure",
      message: "The external agent could not complete this task.",
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#cancelPending();
  }

  /** Marks the exact live prompt stopping before the caller sends session/cancel. */
  beginStop(scope: AcpProcessScope): void {
    this.#requireOpen();
    this.#requireReceiptLive();
    validateProcessScope(scope);
    if (!sameProcessScope(this.#process, scope)) {
      throw new AcpSemanticRelayError("stale_scope", "ACP Stop scope is stale");
    }
    if (this.#stoppingGeneration === null) this.#stoppingGeneration = scope.turnGeneration;
    this.#cancelPending();
  }

  /** Emits one sanitized failure terminal for non-prompt/process failure paths. */
  async fail(code: "invalid_request" | "process_lost" | "upstream_failure"): Promise<void> {
    this.#requireOpen();
    this.#closed = true;
    this.#cancelPending();
    await this.#emit({
      kind: "terminal",
      attribution: this.#attribution(null),
      status: "failed",
      code,
      message: "The external agent could not complete this task.",
    });
  }

  #cancelPending(): void {
    for (const [requestId, pending] of [...this.#pending]) {
      this.#removePending(requestId, pending);
      this.#settled.add(requestId);
      pending.resolve({ outcome: "cancelled" });
    }
  }

  #reportTerminalFailure(reason: AcpTerminalFailureReason): void {
    try {
      this.#onTerminalFailure?.(reason);
    } catch {
      // Diagnostics are advisory. They cannot alter the existing terminal truth.
    }
  }

  #removePending(requestId: string, pending: PendingPermission): void {
    this.#clock.clearTimeout(pending.expiry);
    this.#pending.delete(requestId);
    this.#pendingBytes -= pending.bytes;
  }

  async #emit(payload: AcpRelayFrame["payload"]): Promise<void> {
    const frame = Object.freeze({
      scope: this.#scope,
      process: this.#process,
      capabilities: this.#capabilities,
      payload,
    });
    const bytes = serializedBytes(frame);
    if (bytes > ACP_RELAY_MAX_FRAME_BYTES) {
      throw new AcpSemanticRelayError("relay_overflow", "ACP semantic frame exceeds its relay bound");
    }
    if (this.#emitFault) throw this.#emitFault;
    if (
      this.#emitQueueCount + 1 > MAX_SEMANTIC_QUEUE_COUNT ||
      this.#emitQueueBytes + bytes > MAX_SEMANTIC_QUEUE_BYTES
    ) {
      this.#emitFault = new AcpSemanticRelayError("relay_overflow", "ACP semantic relay queue is over capacity");
      this.#closed = true;
      this.#cancelPending();
      throw this.#emitFault;
    }
    this.#emitQueueCount += 1;
    this.#emitQueueBytes += bytes;
    const scheduled = this.#emitChain.then(async () => {
      if (this.#emitFault) throw this.#emitFault;
      try {
        await this.#emitFrame(frame);
        const faultAfterSend = this.#currentEmitFault();
        if (faultAfterSend) throw faultAfterSend;
      } catch {
        this.#emitFault = new AcpSemanticRelayError("relay_overflow", "ACP semantic relay is unavailable");
        this.#closed = true;
        this.#cancelPending();
        throw this.#emitFault;
      }
    });
    this.#emitChain = scheduled.catch(() => undefined);
    try {
      await scheduled;
    } catch {
      throw this.#emitFault ?? new AcpSemanticRelayError("relay_overflow", "ACP semantic relay is unavailable");
    } finally {
      this.#emitQueueCount -= 1;
      this.#emitQueueBytes -= bytes;
    }
  }

  #attribution(vendorItemId: string | null): AcpRelayAttribution {
    return Object.freeze({
      bindingId: this.#scope.bindingId,
      bindingGeneration: this.#scope.bindingGeneration,
      taskId: this.#scope.taskId,
      roomId: this.#roomId,
      vendorSessionId: this.#process.acpSessionId,
      vendorTurnId: null,
      vendorItemId,
    });
  }

  #requireSession(sessionId: string): void {
    assertIdentifier(sessionId, "ACP session ID");
    if (sessionId !== this.#process.acpSessionId) {
      throw new AcpSemanticRelayError("stale_scope", "ACP message belongs to another session");
    }
  }

  #requireOpen(): void {
    if (this.#closed) throw new AcpSemanticRelayError("stale_scope", "ACP turn is closed");
  }

  #currentEmitFault(): AcpSemanticRelayError | null {
    return this.#emitFault;
  }

  #requireReceiptLive(): void {
    if (Date.parse(this.#scope.workspaceExpiresAt) <= this.#clock.now()) {
      throw new AcpSemanticRelayError("stale_scope", "ACP workspace receipt is expired");
    }
  }
}

const HOST_SCOPE_IDENTIFIERS: readonly (keyof AcpHostScope)[] = [
  "relayId", "relaySessionId", "desktopSessionId", "pairingGenerationRef",
  "bindingId", "bindingGeneration", "ownerId", "taskId", "taskRunId", "jobId",
  "workspaceReceiptId", "workspaceRevision", "workspaceFingerprint", "workspaceExpiresAt",
  "profileId", "profileGeneration", "postureId", "postureGeneration",
];

function validateHostScope(scope: AcpHostScope, now?: number): void {
  for (const key of HOST_SCOPE_IDENTIFIERS) assertIdentifier(scope[key], key);
  assertRevision(scope.selectedProtocolVersion, "protocol version");
  assertRevision(scope.capabilityRevision, "capability revision");
  const expiry = Date.parse(scope.workspaceExpiresAt);
  if (!Number.isFinite(expiry) || (now !== undefined && expiry <= now)) {
    throw new TypeError("workspace expiry must be a future ISO timestamp");
  }
}

function validateProcessScope(scope: AcpProcessScope): void {
  assertIdentifier(scope.connectionId, "connection ID");
  assertIdentifier(scope.acpSessionId, "ACP session ID");
  assertIdentifier(scope.turnRef, "turn reference");
  assertRevision(scope.processGeneration, "process generation");
  assertRevision(scope.turnGeneration, "turn generation");
}

function parseHostScope(value: unknown): AcpHostScope {
  const input = asRecord(value, "ACP host scope");
  const output: Record<string, string | number> = {};
  for (const key of HOST_SCOPE_IDENTIFIERS) {
    const member = input[key];
    assertIdentifier(member, key);
    output[key] = member;
  }
  const selectedProtocolVersion = input["selectedProtocolVersion"];
  const capabilityRevision = input["capabilityRevision"];
  assertRevision(selectedProtocolVersion, "protocol version");
  assertRevision(capabilityRevision, "capability revision");
  output["selectedProtocolVersion"] = selectedProtocolVersion;
  output["capabilityRevision"] = capabilityRevision;
  return Object.freeze(output) as AcpHostScope;
}

function parseProcessScope(value: unknown): AcpProcessScope {
  const input = asRecord(value, "ACP process scope");
  const connectionId = input["connectionId"];
  const acpSessionId = input["acpSessionId"];
  const turnRef = input["turnRef"];
  const processGeneration = input["processGeneration"];
  const turnGeneration = input["turnGeneration"];
  assertIdentifier(connectionId, "connection ID");
  assertIdentifier(acpSessionId, "ACP session ID");
  assertIdentifier(turnRef, "turn reference");
  assertRevision(processGeneration, "process generation");
  assertRevision(turnGeneration, "turn generation");
  return Object.freeze({ connectionId, processGeneration, acpSessionId, turnGeneration, turnRef });
}

function parseCapabilities(value: unknown): AcpCapabilityTruth {
  const input = asRecord(value, "ACP capabilities");
  if (
    input["execution"] !== "supported" || input["requests"] !== "supported" ||
    input["stop"] !== "unknown" || input["resume"] !== "unsupported" ||
    input["steer"] !== "unsupported"
  ) throw new TypeError("ACP capability truth is invalid");
  return {
    execution: "supported", requests: "supported", stop: "unknown",
    resume: "unsupported", steer: "unsupported",
  };
}

function parseAttribution(
  value: unknown,
  expected: AcpRelayDecodeExpectation,
): AcpRelayAttribution {
  const input = asRecord(value, "ACP attribution");
  const bindingId = input["bindingId"];
  const bindingGeneration = input["bindingGeneration"];
  const taskId = input["taskId"];
  const roomId = input["roomId"];
  const vendorSessionId = input["vendorSessionId"];
  const vendorTurnId = input["vendorTurnId"];
  const vendorItemId = input["vendorItemId"];
  assertIdentifier(bindingId, "binding ID");
  assertIdentifier(bindingGeneration, "binding generation");
  assertIdentifier(taskId, "task ID");
  if (roomId !== null) assertIdentifier(roomId, "room ID");
  assertIdentifier(vendorSessionId, "vendor session ID");
  if (vendorTurnId !== null) throw new TypeError("ACP vendor turn ID must remain null");
  if (vendorItemId !== null) assertIdentifier(vendorItemId, "vendor item ID");
  if (
    bindingId !== expected.scope.bindingId || bindingGeneration !== expected.scope.bindingGeneration ||
    taskId !== expected.scope.taskId || roomId !== expected.roomId ||
    vendorSessionId !== expected.process.acpSessionId
  ) throw new AcpSemanticRelayError("stale_scope", "ACP attribution is stale");
  return Object.freeze({
    bindingId, bindingGeneration, taskId, roomId,
    vendorSessionId, vendorTurnId: null, vendorItemId,
  });
}

function sameHostScope(left: AcpHostScope, right: AcpHostScope): boolean {
  return HOST_SCOPE_IDENTIFIERS.every((key) => left[key] === right[key]) &&
    left.selectedProtocolVersion === right.selectedProtocolVersion &&
    left.capabilityRevision === right.capabilityRevision;
}

function sameProcessScope(left: AcpProcessScope, right: AcpProcessScope): boolean {
  return left.connectionId === right.connectionId &&
    left.processGeneration === right.processGeneration &&
    left.acpSessionId === right.acpSessionId &&
    left.turnGeneration === right.turnGeneration &&
    left.turnRef === right.turnRef;
}

function sameCapabilities(left: AcpCapabilityTruth, right: AcpCapabilityTruth): boolean {
  return left.execution === right.execution && left.requests === right.requests &&
    left.stop === right.stop && left.resume === right.resume && left.steer === right.steer;
}

function terminalFailureReason(
  stopReason: AcpTurnResult["stopReason"],
): AcpTerminalFailureReason {
  switch (stopReason) {
    case "end_turn": return "end_turn_without_candidate";
    case "max_tokens": return "max_tokens";
    case "max_turn_requests": return "max_turn_requests";
    case "refusal": return "refusal";
    case "cancelled": return "unowned_cancelled";
  }
}

function assertIdentifier(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || utf8Bytes(value) > MAX_IDENTIFIER_BYTES) {
    throw new TypeError(`${label} must be a bounded opaque identifier`);
  }
}

function assertText(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || utf8Bytes(value) > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} must be bounded text`);
  }
}

function assertRevision(value: unknown, label: string): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label} must be a nonnegative safe integer`);
  }
}

function parsePermissionResponse(value: unknown): AcpRelayPermissionResponse {
  const response = asRecord(value, "permission response");
  const scope = asRecord(response["scope"], "permission response scope") as AcpHostScope;
  const process = asRecord(response["process"], "permission process scope") as AcpProcessScope;
  const requestId = response["requestId"];
  const ownerId = response["ownerId"];
  assertIdentifier(requestId, "request ID");
  assertIdentifier(ownerId, "owner ID");
  const outcome = asRecord(response["outcome"], "permission outcome");
  if (outcome["kind"] === "cancelled") {
    return { scope, process, requestId, ownerId, outcome: { kind: "cancelled" } };
  }
  if (outcome["kind"] === "selected") {
    const optionId = outcome["optionId"];
    assertIdentifier(optionId, "permission option ID");
    return { scope, process, requestId, ownerId, outcome: { kind: "selected", optionId } };
  }
  throw new TypeError("permission outcome is invalid");
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function serializedBytes(value: unknown): number {
  return utf8Bytes(JSON.stringify(value));
}

function utf8Bytes(value: string): number {
  return encoder.encode(value).byteLength;
}

const systemClock: AcpRelayClock = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
