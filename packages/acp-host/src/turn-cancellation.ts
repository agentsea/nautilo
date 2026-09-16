import type { AcpProcessScope, AcpRelayClock } from "./semantic-relay.js";
import type { AcpTurnResult } from "./stable-v1-adapter.js";
import type { AcpTurnSettlementGate } from "./turn-settlement.js";

export const ACP_CANCELLATION_TERMINAL_WAIT_MS = 10_000;

export type AcpCancellationResult = "authoritative_cancelled" | "escalated" | "superseded";

export type AcpTurnCancellationOptions = Readonly<{
  relay: Readonly<{
    beginStop(scope: AcpProcessScope): void;
    complete(result: AcpTurnResult): Promise<void>;
    fail(code: "process_lost" | "upstream_failure"): Promise<void>;
  }>;
  adapter: Readonly<{ stop(): Promise<void> }>;
  promptResult: Promise<AcpTurnResult>;
  settlement: AcpTurnSettlementGate;
  escalate(scope: AcpProcessScope): Promise<void>;
  clock?: AcpRelayClock;
  terminalWaitMs?: number;
}>;

/**
 * Orders one Job Stop without inventing terminal truth: close permission
 * admission, write stable session/cancel, wait for the prompt result, then
 * invoke the already-bounded process supervisor only when cancellation was
 * not authoritatively observed.
 */
export class AcpTurnCancellationCoordinator {
  readonly #clock: AcpRelayClock;
  readonly #terminalWaitMs: number;
  #operation: Promise<AcpCancellationResult> | undefined;

  constructor(readonly options: AcpTurnCancellationOptions) {
    this.#clock = options.clock ?? systemClock;
    const wait = options.terminalWaitMs ?? ACP_CANCELLATION_TERMINAL_WAIT_MS;
    if (!Number.isSafeInteger(wait) || wait <= 0 || wait > ACP_CANCELLATION_TERMINAL_WAIT_MS) {
      throw new TypeError("cancellation terminal wait exceeds the D452 bound");
    }
    this.#terminalWaitMs = wait;
  }

  stop(scope: AcpProcessScope): Promise<AcpCancellationResult> {
    if (!this.options.settlement.matches(scope)) {
      return Promise.reject(new TypeError("ACP Stop scope is stale"));
    }
    this.#operation ??= this.#stopOnce(scope);
    return this.#operation;
  }

  async #stopOnce(scope: AcpProcessScope): Promise<AcpCancellationResult> {
    if (!this.options.settlement.beginStop(scope)) return "superseded";
    try {
      this.options.relay.beginStop(scope);
    } catch {
      this.options.settlement.settleFault(scope);
      return this.#containRelayFailure(scope, "upstream_failure");
    }
    let timer: unknown;
    const timedOut = new Promise<"timeout">((resolve) => {
      timer = this.#clock.setTimeout(() => resolve("timeout"), this.#terminalWaitMs);
    });
    const terminal = (async (): Promise<
      Readonly<{ kind: "result"; result: AcpTurnResult }> | Readonly<{ kind: "adapter_failure" }>
    > => {
      try {
        await this.options.adapter.stop();
        return { kind: "result", result: await this.options.promptResult };
      } catch {
        return { kind: "adapter_failure" };
      }
    })();
    try {
      const outcome = await Promise.race([terminal, timedOut]);
      if (
        outcome !== "timeout" && outcome.kind === "result" &&
        outcome.result.sessionId === scope.acpSessionId && outcome.result.stopReason === "cancelled"
      ) {
        if (!this.options.settlement.settleCancellation(scope)) return "superseded";
        try {
          await this.options.relay.complete(outcome.result);
          return "authoritative_cancelled";
        } catch {
          return this.#containRelayFailure(scope, "upstream_failure");
        }
      }
      if (!this.options.settlement.settleFault(scope)) return "superseded";
      await this.#escalate(scope);
      try {
        await this.options.relay.fail(
          outcome !== "timeout" && outcome.kind === "adapter_failure" ? "process_lost" : "upstream_failure",
        );
      } catch {
        // Relay expiry/backpressure may make terminal delivery unavailable after containment.
      }
      return "escalated";
    } finally {
      if (timer !== undefined) this.#clock.clearTimeout(timer);
    }
  }

  async #containRelayFailure(
    scope: AcpProcessScope,
    code: "process_lost" | "upstream_failure",
  ): Promise<AcpCancellationResult> {
    await this.#escalate(scope);
    try {
      await this.options.relay.fail(code);
    } catch {
      // Exact containment remains authoritative when the semantic relay is unavailable.
    }
    return "escalated";
  }

  async #escalate(scope: AcpProcessScope): Promise<void> {
    try {
      await this.options.escalate(scope);
    } catch {
      // Preserve terminal fencing and sanitized failure under cleanup uncertainty.
    }
  }
}

const systemClock: AcpRelayClock = {
  now: Date.now,
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};
