import type { AcpProcessScope } from "./semantic-relay.js";
import { AcpAdapterError, type AcpTurnResult } from "./stable-v1-adapter.js";
import type { AcpTurnSettlementGate } from "./turn-settlement.js";

export type AcpFaultTerminalCode = "process_lost" | "upstream_failure";

export type AcpTurnFaultOwnerOptions = Readonly<{
  process: AcpProcessScope;
  relay: Readonly<{
    complete(result: AcpTurnResult): Promise<void>;
    fail(code: AcpFaultTerminalCode): Promise<void>;
  }>;
  teardown(scope: AcpProcessScope): Promise<void>;
  settlement: AcpTurnSettlementGate;
}>;

/**
 * Owns the one terminal transition for a non-Stop ACP turn. Faults fence the
 * turn synchronously, tear down only its exact process generation, and emit
 * one sanitized failure even when containment itself reports uncertainty.
 */
export class AcpTurnFaultOwner {
  #fault: Promise<boolean> | undefined;

  constructor(readonly options: AcpTurnFaultOwnerOptions) {}

  /** Observes the real adapter operation and owns its sole terminal transition. */
  async observe(scope: AcpProcessScope, operation: Promise<AcpTurnResult>): Promise<boolean> {
    let result: AcpTurnResult;
    try {
      result = await operation;
    } catch (error) {
      return this.adapterFault(scope, error);
    }
    return this.complete(scope, result);
  }

  adapterFault(scope: AcpProcessScope, error: unknown): Promise<boolean> {
    return this.#fail(scope, classifyAdapterFault(error));
  }

  processLost(scope: AcpProcessScope): Promise<boolean> {
    return this.#fail(scope, "process_lost");
  }

  async complete(scope: AcpProcessScope, result: AcpTurnResult): Promise<boolean> {
    if (!sameProcessScope(this.options.process, scope) || result.sessionId !== scope.acpSessionId) return false;
    if (!this.options.settlement.settleCompletion(scope)) return false;
    try {
      await this.options.relay.complete(result);
    } catch {
      try {
        await this.options.teardown(scope);
      } catch {
        // Preserve the settled terminal fence under cleanup uncertainty.
      }
      try {
        await this.options.relay.fail("upstream_failure");
      } catch {
        // Relay expiry/backpressure can make fallback terminal delivery unavailable.
      }
    }
    return true;
  }

  #fail(scope: AcpProcessScope, code: AcpFaultTerminalCode): Promise<boolean> {
    if (!sameProcessScope(this.options.process, scope)) return Promise.resolve(false);
    if (this.#fault) return this.#fault;
    if (!this.options.settlement.settleFault(scope)) return Promise.resolve(false);
    this.#fault = (async () => {
      try {
        await this.options.teardown(scope);
      } catch {
        // Containment uncertainty cannot expose diagnostics or suppress terminal truth.
      }
      try {
        await this.options.relay.fail(code);
      } catch {
        // Exact containment remains authoritative if relay delivery is unavailable.
      }
      return true;
    })();
    return this.#fault;
  }
}

function classifyAdapterFault(error: unknown): AcpFaultTerminalCode {
  if (!(error instanceof AcpAdapterError)) return "upstream_failure";
  return error.code === "line_too_large" || error.code === "update_overflow" || error.code === "closed"
    ? "process_lost"
    : "upstream_failure";
}

function sameProcessScope(left: AcpProcessScope, right: AcpProcessScope): boolean {
  return left.connectionId === right.connectionId &&
    left.processGeneration === right.processGeneration &&
    left.acpSessionId === right.acpSessionId &&
    left.turnGeneration === right.turnGeneration &&
    left.turnRef === right.turnRef;
}
