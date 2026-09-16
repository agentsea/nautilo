import type { AcpProcessScope } from "./semantic-relay.js";

type SettlementState = "open" | "stopping" | "settled";

/** One exact turn's synchronous terminal linearization authority. */
export class AcpTurnSettlementGate {
  #state: SettlementState = "open";

  constructor(readonly process: AcpProcessScope) {}

  matches(scope: AcpProcessScope): boolean {
    return sameProcessScope(this.process, scope);
  }

  beginStop(scope: AcpProcessScope): boolean {
    if (!this.matches(scope) || this.#state !== "open") return false;
    this.#state = "stopping";
    return true;
  }

  settleCancellation(scope: AcpProcessScope): boolean {
    if (!this.matches(scope) || this.#state !== "stopping") return false;
    this.#state = "settled";
    return true;
  }

  settleCompletion(scope: AcpProcessScope): boolean {
    if (!this.matches(scope) || this.#state !== "open") return false;
    this.#state = "settled";
    return true;
  }

  /** Faults may preempt a pending Stop until cancellation becomes authoritative. */
  settleFault(scope: AcpProcessScope): boolean {
    if (!this.matches(scope) || this.#state === "settled") return false;
    this.#state = "settled";
    return true;
  }
}

function sameProcessScope(left: AcpProcessScope, right: AcpProcessScope): boolean {
  return left.connectionId === right.connectionId &&
    left.processGeneration === right.processGeneration &&
    left.acpSessionId === right.acpSessionId &&
    left.turnGeneration === right.turnGeneration &&
    left.turnRef === right.turnRef;
}
