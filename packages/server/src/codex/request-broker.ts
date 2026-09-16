import type {
  RelayCodexClientMessage,
  RelayCodexRequestMessage,
  RelayCodexRequestResponseMessage,
  RelayCodexServerMessage,
} from "@nautilo/relay";
import type { HarnessRequestResponse } from "@nautilo/runtime";
import {
  assertAcceptedInvocationAuthoritySubject,
  type AcceptedInvocationAuthority,
} from "@nautilo/trust";
import type { CodexRelayTurnScope } from "./turn-event-broker";

/**
 * The request broker owns only the short-lived native request handshake. It
 * deliberately has no database dependency: an app-server approval or input
 * request cannot be resumed after a server, relay, or execution restart.
 */
export interface CodexRelayRequestSource {
  onCodexMessage(
    listener: (relayId: string, message: RelayCodexClientMessage) => void,
  ): () => void;
  /** Registry lifecycle invalidation for relay disconnect/re-registration. */
  onCodexContextInvalidated(listener: (relayId: string, errorCode: string) => void): () => void;
  sendCodex(relayId: string, message: RelayCodexServerMessage): { readonly ok: boolean };
}

export interface CodexRequestSubscription extends AsyncIterable<RelayCodexRequestMessage> {
  close(): void;
}

export interface CodexRequestBrokerOptions {
  readonly source: CodexRelayRequestSource;
  readonly maxBufferedTurns?: number;
  readonly maxRequestsPerTurn?: number;
  readonly now?: () => number;
}

export type CodexRequestBrokerErrorCode =
  | "consumer_exists"
  | "stale_scope"
  | "wrong_owner"
  | "unsupported";

class CodexRequestBrokerError extends Error {
  constructor(readonly code: CodexRequestBrokerErrorCode) {
    super(code);
    this.name = "CodexRequestBrokerError";
  }
}

type PendingRequest = {
  readonly message: RelayCodexRequestMessage;
  readonly fingerprint: string;
  readonly requestKey: string;
  readonly expiresAt: number;
  expiryTimer: ReturnType<typeof setTimeout> | null;
  delivered: boolean;
};

type Stream = {
  readonly scope: CodexRelayTurnScope;
  readonly requests: PendingRequest[];
  readonly pendingById: Map<string, PendingRequest>;
  consumer: Consumer | null;
};

type Consumer = {
  readonly ownerId: string;
  active: boolean;
  abortCleanup: (() => void) | null;
  resolve: ((result: IteratorResult<RelayCodexRequestMessage>) => void) | null;
};

const DEFAULT_MAX_BUFFERED_TURNS = 32;
const DEFAULT_MAX_REQUESTS_PER_TURN = 16;

/**
 * Always-listening, bounded inbox for native Codex requests. A request is
 * correlated by its whole v8 scope on the response path, while a consumer is
 * admitted once per exact active turn. This preserves request-before-start
 * ordering without allowing one task to answer another task's prompt.
 */
export class CodexRequestBroker {
  private readonly streams = new Map<string, Stream>();
  private readonly tombstones = new Set<string>();
  private readonly maxBufferedTurns: number;
  private readonly maxRequestsPerTurn: number;
  private readonly now: () => number;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeInvalidation: (() => void) | null;

  constructor(private readonly options: CodexRequestBrokerOptions) {
    this.maxBufferedTurns = options.maxBufferedTurns ?? DEFAULT_MAX_BUFFERED_TURNS;
    this.maxRequestsPerTurn = options.maxRequestsPerTurn ?? DEFAULT_MAX_REQUESTS_PER_TURN;
    this.now = options.now ?? Date.now;
    if (!positive(this.maxBufferedTurns) || !positive(this.maxRequestsPerTurn)) {
      throw new Error("Codex request broker bounds must be positive integers");
    }
    this.unsubscribe = options.source.onCodexMessage((relayId, message) => {
      this.accept(relayId, message);
    });
    this.unsubscribeInvalidation = options.source.onCodexContextInvalidated((relayId) => {
      this.closeRelay(relayId);
    });
  }

  subscribe(
    scope: CodexRelayTurnScope,
    ownerId: string,
    signal?: AbortSignal,
  ): CodexRequestSubscription {
    this.pruneExpired();
    const key = turnScopeKey(scope);
    if (this.tombstones.has(key)) throw new CodexRequestBrokerError("stale_scope");
    const stream = this.streamFor(scope);
    if (stream.consumer) throw new CodexRequestBrokerError("consumer_exists");
    const consumer: Consumer = {
      ownerId,
      active: true,
      abortCleanup: null,
      resolve: null,
    };
    stream.consumer = consumer;
    if (signal) {
      const onAbort = () => this.closeStream(stream, true);
      signal.addEventListener("abort", onAbort, { once: true });
      consumer.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) this.closeStream(stream, true);
    }
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.next(stream, consumer) }),
      close: () => this.closeStream(stream, true),
    };
  }

  /** Routes one authenticated owner response to the exact pending relay request. */
  respond(
    response: HarnessRequestResponse,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): void {
    this.pruneExpired();
    const pending = this.findPending(response.requestId);
    if (!pending) throw new CodexRequestBrokerError("stale_scope");
    const stream = this.streams.get(turnScopeKey(scopeFrom(pending.message)));
    const consumer = stream?.consumer;
    if (!stream || !consumer || !consumer.active) throw new CodexRequestBrokerError("stale_scope");
    if (consumer.ownerId !== response.ownerId) throw new CodexRequestBrokerError("wrong_owner");
    if (!invocationAuthority) {
      throw new TypeError("Codex response requires accepted invocation authority");
    }
    assertAcceptedInvocationAuthoritySubject(invocationAuthority, response.ownerId);
    const wire = responseMessage(pending.message, response);
    if (!wire) throw new CodexRequestBrokerError("unsupported");
    const routed = this.options.source.sendCodex(pending.message.scope.relayId, wire);
    if (!routed.ok) throw new CodexRequestBrokerError("stale_scope");
    this.settle(stream, pending, true);
  }

  /**
   * Read-only proof that an exact native request is still pending for this
   * process's active owner stream. Admission checks use this before mutating
   * the broker by responding.
   */
  hasLiveRequest(requestRef: string, ownerId: string): boolean {
    this.pruneExpired();
    const pending = this.findPending(requestRef);
    if (!pending || pending.expiresAt <= this.now()) return false;
    const stream = this.streams.get(turnScopeKey(scopeFrom(pending.message)));
    const consumer = stream?.consumer;
    return Boolean(stream && consumer?.active && consumer.ownerId === ownerId);
  }

  /**
   * Read-only liveness proof for a durable user-input fact.  The fact alone
   * must never make a browser answerable after an app-server, relay, or
   * Electron restart: only this process's still-owned request closure does.
   */
  hasLiveUserInputRequest(requestRef: string, ownerId: string): boolean {
    const pending = this.findPending(requestRef);
    return Boolean(pending && isUserInputRequest(pending.message) &&
      this.hasLiveRequest(requestRef, ownerId));
  }

  /** The app lifecycle calls this on a known relay disconnect. */
  closeRelay(relayId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.scope.relayId === relayId) this.closeStream(stream, true);
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeInvalidation?.();
    for (const stream of [...this.streams.values()]) this.closeStream(stream, true);
    this.streams.clear();
    this.tombstones.clear();
  }

  private accept(relayId: string, message: RelayCodexClientMessage): void {
    if (message.type !== "relay:codex-request" || relayId !== message.scope.relayId) return;
    this.pruneExpired();
    const scope = scopeFrom(message);
    const turnKey = turnScopeKey(scope);
    if (this.tombstones.has(turnKey)) return;
    const requestKey = requestScopeKey(message);
    if (this.tombstones.has(requestKey)) return;
    const fingerprint = JSON.stringify(message);
    const existing = this.findPending(message.scope.requestRef);
    if (existing) {
      if (existing.requestKey === requestKey && existing.fingerprint === fingerprint) return;
      return;
    }
    const expiresAt = Date.parse(message.request.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= this.now()) {
      this.rememberTombstone(requestKey);
      return;
    }
    const stream = this.streamFor(scope);
    if (stream.requests.length >= this.maxRequestsPerTurn) {
      this.closeStream(stream, true);
      return;
    }
    const pending: PendingRequest = {
      message,
      fingerprint,
      requestKey,
      expiresAt,
      expiryTimer: null,
      delivered: false,
    };
    this.scheduleExpiry(stream, pending);
    stream.requests.push(pending);
    stream.pendingById.set(message.scope.requestRef, pending);
    this.resolvePending(stream);
  }

  private streamFor(scope: CodexRelayTurnScope): Stream {
    const key = turnScopeKey(scope);
    const existing = this.streams.get(key);
    if (existing) return existing;
    while (this.streams.size >= this.maxBufferedTurns) {
      const oldest = this.streams.values().next().value;
      if (!oldest) break;
      this.closeStream(oldest, true);
    }
    const stream: Stream = {
      scope,
      requests: [],
      pendingById: new Map(),
      consumer: null,
    };
    this.streams.set(key, stream);
    return stream;
  }

  private next(
    stream: Stream,
    consumer: Consumer,
  ): Promise<IteratorResult<RelayCodexRequestMessage>> {
    this.pruneExpired();
    if (!consumer.active) return Promise.resolve({ done: true, value: undefined });
    const pending = this.nextPending(stream);
    if (pending) return Promise.resolve({ done: false, value: pending.message });
    return new Promise<IteratorResult<RelayCodexRequestMessage>>((resolve) => {
      consumer.resolve = resolve;
    });
  }

  private resolvePending(stream: Stream): void {
    const consumer = stream.consumer;
    if (!consumer?.active || !consumer.resolve) return;
    const pending = this.nextPending(stream);
    if (!pending) return;
    const resolve = consumer.resolve;
    consumer.resolve = null;
    resolve({ done: false, value: pending.message });
  }

  private nextPending(stream: Stream): PendingRequest | null {
    for (const pending of stream.requests) {
      if (!pending.delivered) {
        pending.delivered = true;
        return pending;
      }
    }
    return null;
  }

  private findPending(requestId: string): PendingRequest | null {
    for (const stream of this.streams.values()) {
      const pending = stream.pendingById.get(requestId);
      if (pending) return pending;
    }
    return null;
  }

  private expire(stream: Stream, pending: PendingRequest): void {
    if (!stream.pendingById.has(pending.message.scope.requestRef)) return;
    this.settle(stream, pending, true);
  }

  private scheduleExpiry(stream: Stream, pending: PendingRequest): void {
    const delay = Math.min(Math.max(0, pending.expiresAt - this.now()), 2_147_483_647);
    pending.expiryTimer = setTimeout(() => {
      if (pending.expiresAt <= this.now()) this.expire(stream, pending);
      else this.scheduleExpiry(stream, pending);
    }, delay);
  }

  private settle(stream: Stream, pending: PendingRequest, tombstone: boolean): void {
    if (pending.expiryTimer) clearTimeout(pending.expiryTimer);
    pending.expiryTimer = null;
    stream.pendingById.delete(pending.message.scope.requestRef);
    const index = stream.requests.indexOf(pending);
    if (index >= 0) stream.requests.splice(index, 1);
    if (tombstone) this.rememberTombstone(pending.requestKey);
  }

  private closeStream(stream: Stream, tombstone: boolean): void {
    const consumer = stream.consumer;
    if (consumer) {
      consumer.active = false;
      consumer.abortCleanup?.();
      consumer.abortCleanup = null;
      consumer.resolve?.({ done: true, value: undefined });
      consumer.resolve = null;
      stream.consumer = null;
    }
    for (const pending of [...stream.requests]) this.settle(stream, pending, tombstone);
    const key = turnScopeKey(stream.scope);
    this.streams.delete(key);
    if (tombstone) this.rememberTombstone(key);
  }

  private pruneExpired(): void {
    const now = this.now();
    for (const stream of this.streams.values()) {
      for (const pending of [...stream.requests]) {
        if (pending.expiresAt <= now) this.expire(stream, pending);
      }
    }
  }

  private rememberTombstone(key: string): void {
    if (this.tombstones.size >= this.maxBufferedTurns * this.maxRequestsPerTurn) {
      const oldest = this.tombstones.values().next().value;
      if (typeof oldest === "string") this.tombstones.delete(oldest);
    }
    this.tombstones.add(key);
  }
}

function responseMessage(
  request: RelayCodexRequestMessage,
  response: HarnessRequestResponse,
): RelayCodexRequestResponseMessage | null {
  if (request.scope.requestRef !== response.requestId) return null;
  if (request.request.kind === "command_approval") {
    if (response.kind !== "command_approval_required") return null;
    const decision = approvalDecision(response.decision);
    if (!decision || !request.request.choices.includes(decision)) return null;
    return {
      type: "relay:codex-request-response",
      scope: request.scope,
      response: { kind: "command_approval", decision },
    };
  }
  if (request.request.kind === "network_approval") {
    if (response.kind !== "network_approval_required") return null;
    const decision = approvalDecision(response.decision);
    if (!request.request.choices.includes(decision)) return null;
    return {
      type: "relay:codex-request-response",
      scope: request.scope,
      response: { kind: "network_approval", decision },
    };
  }
  if (request.request.kind === "file_change_approval") {
    if (response.kind !== "file_change_approval_required") return null;
    const decision = approvalDecision(response.decision);
    if (!request.request.choices.includes(decision)) return null;
    return {
      type: "relay:codex-request-response",
      scope: request.scope,
      response: { kind: "file_change_approval", decision },
    };
  }
  if (request.request.kind === "permissions_approval") {
    if (response.kind !== "permissions_approval_required") return null;
    if ((request.request.permissions.network === null && response.grants.network) ||
      (request.request.permissions.fileSystem === null && response.grants.fileSystem)) return null;
    return {
      type: "relay:codex-request-response",
      scope: request.scope,
      response: { kind: "permissions_approval", grants: response.grants, scope: response.scope },
    };
  }
  if (isUserInputRequest(request)) {
    if (response.kind !== "user_input_required" || !answersMatch(request, response)) return null;
    return {
      type: "relay:codex-request-response",
      scope: request.scope,
      response: {
        kind: "user_input",
        answers: Object.fromEntries(
          Object.entries(response.answers).map(([id, answers]) => [id, { answers }]),
        ),
      },
    };
  }
  return null;
}

function approvalDecision(
  decision: "approve" | "approve_for_session" | "deny" | "cancel",
): "accept" | "acceptForSession" | "decline" | "cancel" {
  if (decision === "approve") return "accept";
  if (decision === "approve_for_session") return "acceptForSession";
  if (decision === "deny") return "decline";
  return "cancel";
}

function answersMatch(
  request: Extract<RelayCodexRequestMessage, { readonly request: { readonly kind: "user_input" } }>,
  response: Extract<HarnessRequestResponse, { readonly kind: "user_input_required" }>,
): boolean {
  const questions = new Map(request.request.questions.map((question) => [question.id, question]));
  const answerIds = Object.keys(response.answers);
  if (answerIds.length !== questions.size || answerIds.some((id) => !questions.has(id))) return false;
  return answerIds.every((id) => {
    const question = questions.get(id);
    const answers = response.answers[id];
    if (!question || !answers || answers.length === 0) return false;
    if (question.options === null) return true;
    const offered = new Set(question.options.map((option) => option.id));
    return answers.every((answer) => offered.has(answer) || question.isOther);
  });
}

function isUserInputRequest(
  request: RelayCodexRequestMessage,
): request is Extract<RelayCodexRequestMessage, { readonly request: { readonly kind: "user_input" } }> {
  return request.request.kind === "user_input";
}

function scopeFrom(message: RelayCodexRequestMessage): CodexRelayTurnScope {
  const scope = message.scope;
  return {
    relayId: scope.relayId,
    relaySessionId: scope.relaySessionId,
    desktopSessionId: scope.desktopSessionId,
    pairingGenerationRef: scope.pairingGenerationRef,
    selectedProtocolVersion: scope.selectedProtocolVersion,
    capabilityRevision: scope.capabilityRevision,
    profileHandle: scope.profileHandle,
    profileGeneration: scope.profileGeneration,
    accountGeneration: scope.accountGeneration,
    runtimeGeneration: scope.runtimeGeneration,
    childGeneration: scope.childGeneration,
    workspace: scope.workspace,
    bindingId: scope.bindingId,
    bindingGeneration: scope.bindingGeneration,
    taskId: scope.taskId,
    jobId: scope.jobId,
    threadId: scope.threadId,
    turnId: scope.turnId,
  };
}

function turnScopeKey(scope: CodexRelayTurnScope): string {
  return JSON.stringify([
    scope.relayId, scope.relaySessionId, scope.desktopSessionId, scope.pairingGenerationRef,
    scope.selectedProtocolVersion, scope.capabilityRevision, scope.profileHandle,
    scope.profileGeneration, scope.accountGeneration, scope.runtimeGeneration, scope.childGeneration,
    scope.workspace.workspaceRef, scope.workspace.revision, scope.workspace.fingerprint,
    scope.workspace.issuedAt, scope.workspace.expiresAt, scope.bindingId, scope.bindingGeneration,
    scope.taskId, scope.jobId, scope.threadId, scope.turnId,
  ]);
}

function requestScopeKey(message: RelayCodexRequestMessage): string {
  return JSON.stringify([turnScopeKey(scopeFrom(message)), message.scope.eventId, message.scope.itemId,
    message.scope.requestRef, "callRef" in message.scope ? message.scope.callRef : null]);
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}
