import type {
  RelayCodexClientMessage,
  RelayCodexEventMessage,
  WorkspaceReceipt,
} from "@nautilo/relay";

export interface CodexRelayTurnScope {
  readonly relayId: string;
  readonly relaySessionId: string;
  readonly desktopSessionId: string;
  readonly pairingGenerationRef: string;
  /** Codex message family starts at relay v8 and remains valid in additive successors. */
  readonly selectedProtocolVersion: number;
  readonly capabilityRevision: number;
  readonly profileHandle: string;
  readonly profileGeneration: number;
  readonly accountGeneration: number;
  readonly runtimeGeneration: number;
  readonly childGeneration: number;
  readonly workspace: WorkspaceReceipt;
  readonly bindingId: string;
  readonly bindingGeneration: number;
  readonly taskId: string;
  readonly jobId: string;
  readonly threadId: string;
  readonly turnId: string;
}

export interface CodexRelayTurnSource {
  onCodexMessage(
    listener: (relayId: string, message: RelayCodexClientMessage) => void,
  ): () => void;
  /** Registry lifecycle invalidation for relay disconnect/re-registration. */
  onCodexContextInvalidated(listener: (relayId: string, errorCode: string) => void): () => void;
}

class CodexTurnBrokerError extends Error {
  constructor(readonly code: "queue_full" | "consumer_exists" | "stale_generation") {
    super(code);
    this.name = "CodexTurnBrokerError";
  }
}

export interface CodexTurnEventSubscription extends AsyncIterable<RelayCodexEventMessage> {
  /**
   * True once the exact relay has accepted a terminal frame for this turn.
   * This is intentionally receipt state, not a second terminalization API:
   * it lets the execution adapter preserve an authoritative terminal already
   * in flight when a local Stop arrives on the same event-loop turn.
   */
  readonly terminalReceived: boolean;
  /** True only when the active turn stopped producing accepted relay events. */
  readonly inactivityExpired: boolean;
  close(): void;
}

export interface CodexTurnBrokerTimer {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface CodexTurnEventBrokerOptions {
  readonly source: CodexRelayTurnSource;
  readonly maxBufferedTurns?: number;
  readonly maxEventsPerTurn?: number;
  readonly turnInactivityTimeoutMs?: number;
  readonly timer?: CodexTurnBrokerTimer;
}

type Stream = {
  readonly scope: CodexRelayTurnScope;
  readonly events: RelayCodexEventMessage[];
  consumer: Consumer | null;
  inputClosed: boolean;
  terminalReceived: boolean;
  inactivityExpired: boolean;
  inactivityTimer: unknown;
  failure: CodexTurnBrokerError | null;
};

type Consumer = {
  active: boolean;
  abortCleanup: (() => void) | null;
  resolve: ((result: IteratorResult<RelayCodexEventMessage>) => void) | null;
  reject: ((error: Error) => void) | null;
};

const DEFAULT_MAX_BUFFERED_TURNS = 32;
const DEFAULT_MAX_EVENTS_PER_TURN = 128;
const DEFAULT_CODEX_TURN_INACTIVITY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A bounded, server-private relay event inbox. It is always listening so the
 * Electron host's event-before-start-response ordering cannot lose the first
 * item; a consumer is still admitted only for one fully exact turn scope.
 */
export class CodexTurnEventBroker {
  private readonly streams = new Map<string, Stream>();
  private readonly tombstones = new Set<string>();
  private readonly maxBufferedTurns: number;
  private readonly maxEventsPerTurn: number;
  private readonly turnInactivityTimeoutMs: number;
  private readonly timer: CodexTurnBrokerTimer;
  private readonly unsubscribe: () => void;
  private readonly unsubscribeInvalidation: () => void;

  constructor(options: CodexTurnEventBrokerOptions) {
    this.maxBufferedTurns = options.maxBufferedTurns ?? DEFAULT_MAX_BUFFERED_TURNS;
    this.maxEventsPerTurn = options.maxEventsPerTurn ?? DEFAULT_MAX_EVENTS_PER_TURN;
    this.turnInactivityTimeoutMs = options.turnInactivityTimeoutMs
      ?? DEFAULT_CODEX_TURN_INACTIVITY_TIMEOUT_MS;
    this.timer = options.timer ?? {
      setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
      clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    };
    if (
      !positive(this.maxBufferedTurns)
      || !positive(this.maxEventsPerTurn)
      || !positive(this.turnInactivityTimeoutMs)
    ) {
      throw new Error("Codex turn broker bounds must be positive integers");
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
    signal?: AbortSignal,
  ): CodexTurnEventSubscription {
    const key = scopeKey(scope);
    if (this.tombstones.has(key)) {
      throw new CodexTurnBrokerError("stale_generation");
    }
    const stream = this.streamFor(scope);
    if (stream.consumer) throw new CodexTurnBrokerError("consumer_exists");
    const consumer: Consumer = {
      active: true,
      abortCleanup: null,
      resolve: null,
      reject: null,
    };
    stream.consumer = consumer;
    if (signal) {
      // Stop wins only while the upstream turn is still live.  Once this
      // exact stream has received its authoritative terminal frame, retain it
      // for the execution adapter to project and terminalize canonically.
      const onAbort = () => {
        if (!stream.terminalReceived) this.closeConsumer(stream, consumer, true);
      };
      signal.addEventListener("abort", onAbort, { once: true });
      consumer.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      if (signal.aborted) onAbort();
    }
    this.armInactivity(stream);
    return {
      [Symbol.asyncIterator]: () => ({ next: () => this.next(stream, consumer) }),
      get terminalReceived() { return stream.terminalReceived; },
      get inactivityExpired() { return stream.inactivityExpired; },
      close: () => this.closeConsumer(stream, consumer, true),
    };
  }

  dispose(): void {
    this.unsubscribe();
    this.unsubscribeInvalidation();
    for (const stream of this.streams.values()) {
      if (stream.consumer) this.closeConsumer(stream, stream.consumer, true);
    }
    this.streams.clear();
    this.tombstones.clear();
  }

  private accept(relayId: string, message: RelayCodexClientMessage): void {
    if (message.type === "relay:codex-status") {
      this.acceptStatus(relayId, message);
      return;
    }
    if (message.type !== "relay:codex-event" || relayId !== message.scope.relayId) return;
    const scope = scopeFrom(message);
    if (!scope) return;
    const key = scopeKey(scope);
    if (this.tombstones.has(key)) return;

    const stream = this.streamFor(scope);
    if (stream.inputClosed) return;
    if (stream.events.length >= this.maxEventsPerTurn) {
      this.fail(stream, new CodexTurnBrokerError("queue_full"));
      return;
    }
    stream.events.push(message);
    if (isTerminal(message)) {
      stream.terminalReceived = true;
      stream.inputClosed = true;
      this.clearInactivity(stream);
    } else {
      this.armInactivity(stream);
    }
    this.resolvePending(stream);
  }

  private acceptStatus(
    relayId: string,
    message: Extract<RelayCodexClientMessage, { readonly type: "relay:codex-status" }>,
  ): void {
    if (relayId !== message.socket.relayId) return;
    for (const stream of [...this.streams.values()]) {
      if (!sameStatusSocket(stream.scope, message) || statusRetainsTurn(stream.scope, message)) continue;
      const key = scopeKey(stream.scope);
      if (stream.consumer) this.closeConsumer(stream, stream.consumer, true);
      else {
        this.streams.delete(key);
        this.rememberTombstone(key);
      }
    }
  }

  private streamFor(scope: CodexRelayTurnScope): Stream {
    const key = scopeKey(scope);
    const existing = this.streams.get(key);
    if (existing) return existing;
    while (this.streams.size >= this.maxBufferedTurns) {
      const oldest = this.streams.keys().next().value;
      if (typeof oldest !== "string") break;
      const evicted = this.streams.get(oldest);
      if (evicted?.consumer) {
        this.fail(evicted, new CodexTurnBrokerError("queue_full"));
      } else {
        this.rememberTombstone(oldest);
      }
      this.streams.delete(oldest);
    }
    const stream: Stream = {
      scope,
      events: [],
      consumer: null,
      inputClosed: false,
      terminalReceived: false,
      inactivityExpired: false,
      inactivityTimer: undefined,
      failure: null,
    };
    this.streams.set(key, stream);
    return stream;
  }

  private next(
    stream: Stream,
    consumer: Consumer,
  ): Promise<IteratorResult<RelayCodexEventMessage>> {
    if (!consumer.active) return Promise.resolve({ done: true, value: undefined });
    if (stream.failure) {
      const error = stream.failure;
      this.closeConsumer(stream, consumer, true);
      return Promise.reject(error);
    }
    const event = stream.events.shift();
    if (event) {
      if (isTerminal(event)) this.closeConsumer(stream, consumer, true);
      return Promise.resolve({ done: false, value: event });
    }
    if (stream.inputClosed) {
      this.closeConsumer(stream, consumer, true);
      return Promise.resolve({ done: true, value: undefined });
    }
    return new Promise<IteratorResult<RelayCodexEventMessage>>((resolve, reject) => {
      consumer.resolve = resolve;
      consumer.reject = reject;
    });
  }

  private resolvePending(stream: Stream): void {
    const consumer = stream.consumer;
    if (!consumer?.active || !consumer.resolve) return;
    const resolve = consumer.resolve;
    const reject = consumer.reject;
    consumer.resolve = null;
    consumer.reject = null;
    if (stream.failure) {
      reject?.(stream.failure);
      return;
    }
    const event = stream.events.shift();
    if (!event) {
      if (stream.inputClosed) {
        this.closeConsumer(stream, consumer, true);
        resolve({ done: true, value: undefined });
      }
      return;
    }
    if (isTerminal(event)) this.closeConsumer(stream, consumer, true);
    resolve({ done: false, value: event });
  }

  private fail(stream: Stream, error: CodexTurnBrokerError): void {
    stream.failure = error;
    stream.inputClosed = true;
    const consumer = stream.consumer;
    if (consumer?.reject) {
      const reject = consumer.reject;
      consumer.resolve = null;
      consumer.reject = null;
      this.closeConsumer(stream, consumer, true);
      reject(error);
      return;
    }
    if (!consumer) {
      const key = scopeKey(stream.scope);
      this.streams.delete(key);
      this.rememberTombstone(key);
    }
  }

  private closeConsumer(stream: Stream, consumer: Consumer, tombstone: boolean): void {
    if (!consumer.active) return;
    this.clearInactivity(stream);
    consumer.active = false;
    consumer.abortCleanup?.();
    consumer.abortCleanup = null;
    consumer.resolve?.({ done: true, value: undefined });
    consumer.resolve = null;
    consumer.reject = null;
    if (stream.consumer === consumer) stream.consumer = null;
    const key = scopeKey(stream.scope);
    this.streams.delete(key);
    if (tombstone) this.rememberTombstone(key);
  }

  private closeRelay(relayId: string): void {
    for (const stream of [...this.streams.values()]) {
      if (stream.scope.relayId !== relayId) continue;
      if (stream.consumer) this.closeConsumer(stream, stream.consumer, true);
      else {
        const key = scopeKey(stream.scope);
        this.streams.delete(key);
        this.rememberTombstone(key);
      }
    }
  }

  private armInactivity(stream: Stream): void {
    this.clearInactivity(stream);
    if (!stream.consumer || stream.inputClosed) return;
    stream.inactivityTimer = this.timer.setTimeout(() => {
      stream.inactivityTimer = undefined;
      if (stream.inputClosed || !stream.consumer) return;
      stream.inactivityExpired = true;
      stream.inputClosed = true;
      this.closeConsumer(stream, stream.consumer, true);
    }, this.turnInactivityTimeoutMs);
  }

  private clearInactivity(stream: Stream): void {
    if (stream.inactivityTimer === undefined) return;
    this.timer.clearTimeout(stream.inactivityTimer);
    stream.inactivityTimer = undefined;
  }

  private rememberTombstone(key: string): void {
    if (this.tombstones.size >= this.maxBufferedTurns) {
      const oldest = this.tombstones.values().next().value;
      if (typeof oldest === "string") this.tombstones.delete(oldest);
    }
    this.tombstones.add(key);
  }
}

function scopeFrom(message: RelayCodexEventMessage): CodexRelayTurnScope | null {
  const scope = message.scope;
  if (!("threadId" in scope) || !("turnId" in scope)) return null;
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

function isTerminal(message: RelayCodexEventMessage): boolean {
  return message.event.kind === "turn_completed";
}

function scopeKey(scope: CodexRelayTurnScope): string {
  // Native relay frames are admitted only for the exact server-authored v8
  // authority scope. A different workspace or generation is a different
  // stream, never adjacent metadata on the same upstream turn.
  return JSON.stringify([
    scope.relayId,
    scope.relaySessionId,
    scope.desktopSessionId,
    scope.pairingGenerationRef,
    scope.selectedProtocolVersion,
    scope.capabilityRevision,
    scope.profileHandle,
    scope.profileGeneration,
    scope.accountGeneration,
    scope.runtimeGeneration,
    scope.childGeneration,
    scope.workspace.workspaceRef,
    scope.workspace.revision,
    scope.workspace.fingerprint,
    scope.workspace.issuedAt,
    scope.workspace.expiresAt,
    scope.bindingId,
    scope.bindingGeneration,
    scope.taskId,
    scope.jobId,
    scope.threadId,
    scope.turnId,
  ]);
}

function positive(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function sameStatusSocket(
  scope: CodexRelayTurnScope,
  message: Extract<RelayCodexClientMessage, { readonly type: "relay:codex-status" }>,
): boolean {
  return scope.relayId === message.socket.relayId
    && scope.relaySessionId === message.socket.relaySessionId
    && scope.desktopSessionId === message.socket.desktopSessionId
    && scope.pairingGenerationRef === message.socket.pairingGenerationRef
    && scope.selectedProtocolVersion === message.socket.selectedProtocolVersion
    && scope.capabilityRevision === message.capabilityRevision;
}

function statusRetainsTurn(
  scope: CodexRelayTurnScope,
  message: Extract<RelayCodexClientMessage, { readonly type: "relay:codex-status" }>,
): boolean {
  const status = message.status;
  if (
    (status.state !== "ready" && status.state !== "limited")
    || status.runtimeGeneration !== scope.runtimeGeneration
    || status.workspace.state !== "bound"
    || !sameWorkspace(status.workspace.receipt, scope.workspace)
  ) return false;
  return status.profiles?.some((profile) =>
    profile.profileHandle === scope.profileHandle
    && profile.profileGeneration === scope.profileGeneration
    && profile.accountGeneration === scope.accountGeneration
    && profile.childGeneration === scope.childGeneration
  ) === true;
}

function sameWorkspace(left: WorkspaceReceipt, right: WorkspaceReceipt): boolean {
  return left.workspaceRef === right.workspaceRef
    && left.revision === right.revision
    && left.fingerprint === right.fingerprint
    && left.issuedAt === right.issuedAt
    && left.expiresAt === right.expiresAt;
}
