import { randomUUID } from "node:crypto";
import type {
  HarnessExecution,
  HarnessExecutionAdmission,
  HarnessExecutionOutput,
  HarnessEvent,
  HarnessRequestResponse,
  HarnessTurnReference,
} from "@nautilo/runtime";
import type { RelayCodexEventMessage, RelayCodexRequestMessage } from "@nautilo/relay";
import { CodexTurnProjector } from "./turn-projector";
import { CodexRequestProjector } from "./request-projector";
import {
  assertCodexExecutionAdmission,
  type CodexExecutionAdmission,
} from "./execution-admission";
import {
  type CodexRelayTurnScope,
  type CodexTurnEventSubscription,
} from "./turn-event-broker";
import {
  codexRequestScopePartitionIdentity,
  type CodexRequestScopeLease,
  type CodexRequestScopePartitionIdentity,
  type CodexRequestSubscription,
} from "./request-broker";
import type { AcceptedInvocationAuthority } from "@nautilo/trust";

/** Opaque binding/session authority supplied by the later persistence adapter. */
export interface CodexBoundSession {
  readonly id: string;
}

export interface CodexStartedTurn {
  /** Exact host-confirmed upstream turn and relay correlation identity. */
  readonly scope: CodexRelayTurnScope;
}

/**
 * Codex-specific binding orchestration stays server-private. Implementations
 * own persistence/open/resume/rebind semantics; this execution adapter only
 * consumes the already-admitted result and never manufactures a binding row.
 */
export interface CodexBindingSessionPort {
  openOrResume(admission: CodexExecutionAdmission): Promise<CodexBoundSession>;
  startTurn(input: {
    readonly session: CodexBoundSession;
    readonly admission: CodexExecutionAdmission;
  }): Promise<CodexStartedTurn>;
  interruptTurn(input: {
    readonly session: CodexBoundSession;
    readonly turn: CodexStartedTurn;
  }): Promise<void>;
  steerTurn(input: {
    readonly session: CodexBoundSession;
    readonly turn: CodexStartedTurn;
    readonly text: string;
    readonly actorRef: string;
  }): Promise<void>;
}

export interface CodexHarnessExecutionOptions {
  readonly sessions: CodexBindingSessionPort;
  readonly events: CodexTurnEventSubscriptionPort;
  readonly requests: CodexRequestSubscriptionPort;
  readonly mintActorRef?: () => string;
  /** Optional exact scope owner used by the ordinary production broker partition. */
  readonly requestScopes?: Readonly<{
    claim(identity: CodexRequestScopePartitionIdentity): CodexRequestScopeLease;
  }>;
  /**
   * Protected executions release grant custody when authorization ends. The
   * provider operation remains owned until it settles; this only bounds the
   * local consumer wait and never claims upstream containment.
   */
  readonly abortStreamOnCancellation?: true;
}

/** Narrow execution dependency: the shared broker is one implementation. */
export interface CodexTurnEventSubscriptionPort {
  subscribe(scope: CodexRelayTurnScope, signal?: AbortSignal): CodexTurnEventSubscription;
}

/** The shared native-request broker is the concrete implementation. */
export interface CodexRequestSubscriptionPort {
  subscribe(
    scope: CodexRelayTurnScope,
    ownerId: string,
    signal?: AbortSignal,
  ): CodexRequestSubscription;
  respond(
    response: HarnessRequestResponse,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): void;
}

/** Concrete Execution facet composed into the thin CodexHarnessDriver later. */
export class CodexHarnessExecution implements HarnessExecution {
  private readonly activeByTask = new Map<string, ActiveCodexTurn>();
  private readonly activeByReference = new Map<string, ActiveCodexTurn>();

  constructor(private readonly options: CodexHarnessExecutionOptions) {}

  respond(
    response: HarnessRequestResponse,
    invocationAuthority?: AcceptedInvocationAuthority,
  ): Promise<void> {
    if (!invocationAuthority) {
      return Promise.reject(new TypeError("Codex response requires accepted invocation authority"));
    }
    this.options.requests.respond(response, invocationAuthority);
    return Promise.resolve();
  }

  /** Resolve only the exact owner/Room-scoped turn currently owned by this process. */
  activeTurnForTask(input: {
    readonly taskId: string;
    readonly ownerId: string;
    readonly roomId: string;
  }): HarnessTurnReference | null {
    const active = this.activeByTask.get(input.taskId);
    if (
      !active
      || active.ownerId !== input.ownerId
      || active.roomId !== input.roomId
      || !active.steerSupported
    ) {
      return null;
    }
    return active.reference;
  }

  async steer(input: HarnessTurnReference & { readonly text: string }): Promise<void> {
    if (!boundedSteerText(input.text)) throw new TypeError("Invalid Codex steer text");
    const active = this.activeByReference.get(turnReferenceKey(input));
    if (!active || !active.steerSupported) {
      throw new TypeError("Codex active turn is unavailable for steering");
    }
    await this.options.sessions.steerTurn({
      session: active.session,
      turn: active.turn,
      text: input.text,
      actorRef: (this.options.mintActorRef ?? randomUUID)(),
    });
  }

  /**
   * User-Stop preparation for the exact process-local turn. The Task route
   * awaits this before committing `cancelled`; false means this execution does
   * not own the Task and the ordinary lifecycle remains applicable.
   */
  stopActiveTask(taskId: string): Promise<boolean> {
    const active = this.activeByTask.get(taskId);
    if (!active) return Promise.resolve(false);
    if (!active.stop) {
      active.stop = this.options.sessions.interruptTurn({
        session: active.session,
        turn: active.turn,
      });
    }
    // User Stop owns Nautilo's durable cancellation even when the exact
    // upstream turn has already disappeared. Start containment once, but do
    // not gate the route's Task/TaskRun/Job cancellation on its result. The
    // execution path still awaits the original promise and therefore never
    // fabricates a successful containment receipt.
    void active.stop.catch(() => undefined);
    return Promise.resolve(true);
  }

  async *start(
    admission: HarnessExecutionAdmission,
  ): AsyncIterable<HarnessExecutionOutput> {
    assertCodexExecutionAdmission(admission);
    const codexAdmission = admission;
    if (!codexAdmission.roomId) {
      throw new TypeError("Codex Task execution requires an admitted Room");
    }
    if (this.activeByTask.has(codexAdmission.taskId)) {
      throw new TypeError("Codex task already has an active turn");
    }
    const boundedByAuthorization = this.options.abortStreamOnCancellation === true;
    const requestScope = this.options.requestScopes?.claim(codexRequestScopePartitionIdentity({
      relayId: codexAdmission.codex.scope.relayId,
      bindingId: codexAdmission.binding.id,
      bindingGeneration: codexAdmission.binding.generation,
      taskId: codexAdmission.taskId,
      jobId: codexAdmission.jobId,
    })) ?? null;
    try {
      yield* this.startOwned(codexAdmission, codexAdmission.roomId, boundedByAuthorization);
    } finally {
      requestScope?.close();
    }
  }

  private async *startOwned(
    codexAdmission: CodexExecutionAdmission,
    roomId: string,
    boundedByAuthorization: boolean,
  ): AsyncIterable<HarnessExecutionOutput> {
    if (boundedByAuthorization && codexAdmission.abortSignal.aborted) return;
    const openAttempt = this.options.sessions.openOrResume(codexAdmission);
    const opened = boundedByAuthorization
      ? await settleBeforeAbort(openAttempt, codexAdmission.abortSignal)
      : { kind: "settled" as const, value: await openAttempt };
    if (opened.kind === "aborted") return;
    const session = opened.value;
    if (codexAdmission.abortSignal.aborted) return;
    const startAttempt = this.options.sessions.startTurn({ session, admission: codexAdmission });
    const started = boundedByAuthorization
      ? await settleBeforeAbort(startAttempt, codexAdmission.abortSignal)
      : { kind: "settled" as const, value: await startAttempt };
    if (started.kind === "aborted") {
      // The provider may still create the turn after local authorization has
      // ended. Contain that exact late-known turn once without keeping grant
      // custody open or pretending the transport acknowledged containment.
      void startAttempt.then(
        (lateTurn) => this.options.sessions.interruptTurn({ session, turn: lateTurn }),
        () => undefined,
      ).catch(() => undefined);
      return;
    }
    const turn = started.value;
    if (boundedByAuthorization && codexAdmission.abortSignal.aborted) {
      void this.options.sessions.interruptTurn({ session, turn }).catch(() => undefined);
      return;
    }
    const active = activeCodexTurn(codexAdmission, roomId, session, turn);
    const projector = new CodexTurnProjector({
      bindingId: codexAdmission.binding.id,
      bindingGeneration: codexAdmission.binding.generation,
      taskId: codexAdmission.taskId,
      roomId: codexAdmission.roomId,
    });
    const events = this.options.events.subscribe(turn.scope, codexAdmission.abortSignal);
    const requests = this.options.requests.subscribe(
      turn.scope,
      codexAdmission.ownerId,
      codexAdmission.abortSignal,
    );
    const requestProjector = new CodexRequestProjector({
      bindingId: codexAdmission.binding.id,
      bindingGeneration: codexAdmission.binding.generation,
      taskId: codexAdmission.taskId,
      roomId: codexAdmission.roomId,
      ownerId: codexAdmission.ownerId,
    });
    this.activeByTask.set(codexAdmission.taskId, active);
    this.activeByReference.set(turnReferenceKey(active.reference), active);
    let terminalSeen = false;
    const interruptOnce = (): Promise<void> => {
      if (!active.stop) {
        active.stop = this.options.sessions.interruptTurn({ session, turn });
      }
      return active.stop;
    };
    const onAbort = () => {
      // A terminal relay event already received by the exact broker wins over
      // a concurrent/later local Stop.  The broker retains that one event so
      // the canonical Task lifecycle can complete; do not send a redundant
      // upstream interrupt after the turn has already ended.
      if (!events.terminalReceived && !terminalSeen) {
        // The terminal edge below awaits this same promise and owns failure.
        // This catch only prevents the event-listener fire-and-forget call
        // from becoming an unhandled rejection in the meantime.
        void interruptOnce().catch(() => undefined);
      }
    };
    codexAdmission.abortSignal.addEventListener("abort", onAbort, { once: true });

    try {
      for await (const input of multiplex(
        events,
        requests,
        boundedByAuthorization ? codexAdmission.abortSignal : undefined,
      )) {
        if (input.type === "relay:codex-request") {
          const request = requestProjector.project(input);
          if (request) yield request;
          continue;
        }
        const projected = projector.project(input);
        // `turn_completed` can project an authoritative assistant item before
        // its terminal event.  Record the terminal receipt before yielding
        // either output so an Abort fired by that first projection cannot
        // relabel an already-authoritative completion as a user Stop.
        if (projected.some((output) => output.kind === "terminal")) terminalSeen = true;
        for (const output of projected) {
          yield output;
        }
        if (terminalSeen) break;
      }
    } finally {
      if (boundedByAuthorization && !terminalSeen && !events.terminalReceived) {
        // Consumer cancellation (iterator.return()) and a throw from the
        // for-await body both skip the post-loop containment below. Start the
        // same exact-once provider interrupt before releasing local ownership,
        // but never await it or claim an authoritative terminal.
        void interruptOnce().catch(() => undefined);
      }
      codexAdmission.abortSignal.removeEventListener("abort", onAbort);
      events.close();
      requests.close();
      if (this.activeByTask.get(codexAdmission.taskId) === active) {
        this.activeByTask.delete(codexAdmission.taskId);
      }
      if (this.activeByReference.get(turnReferenceKey(active.reference)) === active) {
        this.activeByReference.delete(turnReferenceKey(active.reference));
      }
    }

    if (codexAdmission.abortSignal.aborted && !terminalSeen) {
      if (boundedByAuthorization) {
        // The interrupt transport can outlive the grant. Keep its exact
        // provider promise owned, but do not retain private execution custody
        // or relabel an uncertain upstream turn as successfully interrupted.
        void interruptOnce().catch(() => undefined);
        yield lostRelayTerminal(codexAdmission, turn.scope);
      } else {
        await interruptOnce();
        yield interruptedTerminal(codexAdmission, turn.scope);
      }
    } else if (!terminalSeen) {
      // A silent but still-connected app-server is not live execution. Make
      // one bounded containment attempt before canonical failed report-back;
      // failure here must not recreate the endless wait this lease prevents.
      if (events.inactivityExpired) {
        const containment = interruptOnce();
        if (boundedByAuthorization) {
          await settleBeforeAbort(containment, codexAdmission.abortSignal).catch(() => undefined);
        } else {
          await containment.catch(() => undefined);
        }
      }
      yield lostRelayTerminal(codexAdmission, turn.scope);
    }
  }
}

type ActiveCodexTurn = {
  readonly ownerId: string;
  readonly roomId: string;
  readonly steerSupported: boolean;
  readonly session: CodexBoundSession;
  readonly turn: CodexStartedTurn;
  readonly reference: HarnessTurnReference;
  stop: Promise<void> | null;
};

function activeCodexTurn(
  admission: CodexExecutionAdmission,
  roomId: string,
  session: CodexBoundSession,
  turn: CodexStartedTurn,
): ActiveCodexTurn {
  return {
    ownerId: admission.ownerId,
    roomId,
    steerSupported: admission.codex.scope.explicitSteer,
    session,
    turn,
    reference: Object.freeze({
      bindingId: admission.binding.id,
      bindingGeneration: admission.binding.generation,
      vendorSessionId: turn.scope.threadId,
      vendorTurnId: turn.scope.turnId,
    }),
    stop: null,
  };
}

function turnReferenceKey(turn: HarnessTurnReference): string {
  return JSON.stringify([
    turn.bindingId,
    turn.bindingGeneration,
    turn.vendorSessionId,
    turn.vendorTurnId,
  ]);
}

function boundedSteerText(value: string): boolean {
  return value.trim().length > 0 && new TextEncoder().encode(value).byteLength <= 64 * 1024;
}

async function* multiplex(
  events: CodexTurnEventSubscription,
  requests: CodexRequestSubscription,
  authorizationSignal?: AbortSignal,
): AsyncIterable<RelayCodexEventMessage | RelayCodexRequestMessage> {
  const eventIterator = events[Symbol.asyncIterator]();
  const requestIterator = requests[Symbol.asyncIterator]();
  let eventNext = eventIterator.next().then((result) => ({ source: "event" as const, result }));
  let requestNext = requestIterator.next().then((result) => ({ source: "request" as const, result }));
  let requestsOpen = true;
  while (true) {
    const contenders: Promise<{
      readonly source: "event" | "request";
      readonly result: IteratorResult<RelayCodexEventMessage | RelayCodexRequestMessage>;
    }>[] = [];
    contenders.push(eventNext);
    if (requestsOpen) contenders.push(requestNext);
    const nextAttempt = Promise.race(contenders);
    const authorizedNext = authorizationSignal
      ? await settleBeforeAbort(nextAttempt, authorizationSignal)
      : { kind: "settled" as const, value: await nextAttempt };
    if (authorizedNext.kind === "aborted") return;
    const next = authorizedNext.value;
    if (next.source === "event") {
      if (next.result.done) {
        // The turn event stream is authoritative for execution liveness. A
        // request cannot outlive a closed/failed turn, so let the caller's
        // finally block close its pending request broker state immediately.
        return;
      } else {
        eventNext = eventIterator.next().then((result) => ({ source: "event" as const, result }));
        yield next.result.value;
      }
    } else if (next.result.done) {
      requestsOpen = false;
    } else {
      requestNext = requestIterator.next().then((result) => ({ source: "request" as const, result }));
      yield next.result.value;
    }
  }
}

async function settleBeforeAbort<Value>(
  operation: Promise<Value>,
  signal: AbortSignal,
): Promise<
  | Readonly<{ kind: "settled"; value: Value }>
  | Readonly<{ kind: "aborted" }>
> {
  if (signal.aborted) return { kind: "aborted" };
  let onAbort: (() => void) | null = null;
  const aborted = new Promise<Readonly<{ kind: "aborted" }>>((resolve) => {
    onAbort = () => resolve({ kind: "aborted" });
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      operation.then((value) => ({ kind: "settled" as const, value })),
      aborted,
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

function lostRelayTerminal(
  admission: HarnessExecutionAdmission,
  scope: CodexRelayTurnScope,
): HarnessEvent {
  return {
    kind: "terminal",
    attribution: {
      bindingId: admission.binding.id,
      bindingGeneration: admission.binding.generation,
      taskId: admission.taskId,
      roomId: admission.roomId,
      vendorSessionId: scope.threadId,
      vendorTurnId: scope.turnId,
      vendorItemId: null,
    },
    status: "failed",
    code: "process_lost",
  };
}

function interruptedTerminal(
  admission: HarnessExecutionAdmission,
  scope: CodexRelayTurnScope,
): HarnessEvent {
  return {
    kind: "terminal",
    attribution: {
      bindingId: admission.binding.id,
      bindingGeneration: admission.binding.generation,
      taskId: admission.taskId,
      roomId: admission.roomId,
      vendorSessionId: scope.threadId,
      vendorTurnId: scope.turnId,
      vendorItemId: null,
    },
    status: "interrupted",
    code: "user_stop",
  };
}
