export const COMPUTER_USE_WORKSTATION_STATE_RESOURCE = "computer-use:workstation-state";

export type ComputerUseResourceClaim = Readonly<{
  key: string;
  mode: "read" | "write";
}>;

export class ComputerUseCoordinationAbortError extends Error {
  constructor() {
    super("computer use operation cancelled while awaiting its private resources");
    this.name = "AbortError";
  }
}

type Pending<T> = {
  readonly claims: readonly ComputerUseResourceClaim[];
  readonly signal: AbortSignal;
  readonly execute: () => Promise<T> | T;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason: unknown) => void;
  readonly onAbort: () => void;
  started: boolean;
};

/**
 * Host-private coordination for resources whose real identity is known only
 * after capability resolution. Conflicting work is FIFO; independent claims
 * may proceed without waiting behind an unrelated resource.
 */
export class ComputerUseResourceCoordinator {
  readonly #active = new Set<readonly ComputerUseResourceClaim[]>();
  readonly #pending: Pending<unknown>[] = [];

  withClaims<T>(
    claims: readonly ComputerUseResourceClaim[],
    signal: AbortSignal,
    execute: () => Promise<T> | T,
  ): Promise<T> {
    const normalized = normalizeClaims(claims);
    if (signal.aborted) return Promise.reject(new ComputerUseCoordinationAbortError());
    return new Promise<T>((resolve, reject) => {
      const pending: Pending<T> = {
        claims: normalized,
        signal,
        execute,
        resolve,
        reject,
        started: false,
        onAbort: () => {
          if (pending.started) return;
          const index = this.#pending.indexOf(pending as Pending<unknown>);
          if (index >= 0) this.#pending.splice(index, 1);
          signal.removeEventListener("abort", pending.onAbort);
          reject(new ComputerUseCoordinationAbortError());
          this.#drain();
        },
      };
      signal.addEventListener("abort", pending.onAbort, { once: true });
      this.#pending.push(pending as Pending<unknown>);
      this.#drain();
    });
  }

  #drain(): void {
    for (let index = 0; index < this.#pending.length;) {
      const pending = this.#pending[index]!;
      const blockedByActive = [...this.#active].some((claims) => conflicts(claims, pending.claims));
      const blockedByEarlier = this.#pending.slice(0, index)
        .some((earlier) => conflicts(earlier.claims, pending.claims));
      if (blockedByActive || blockedByEarlier) {
        index += 1;
        continue;
      }
      this.#pending.splice(index, 1);
      pending.started = true;
      pending.signal.removeEventListener("abort", pending.onAbort);
      this.#active.add(pending.claims);
      void Promise.resolve().then(() => {
        // Abort may land after the queue marks this claim active but before
        // the execution microtask starts. That boundary is still no-dispatch.
        if (pending.signal.aborted) throw new ComputerUseCoordinationAbortError();
        return pending.execute();
      }).then(pending.resolve, pending.reject).finally(() => {
        this.#active.delete(pending.claims);
        this.#drain();
      });
    }
  }
}

function normalizeClaims(claims: readonly ComputerUseResourceClaim[]): readonly ComputerUseResourceClaim[] {
  const modes = new Map<string, "read" | "write">();
  for (const claim of claims) {
    if (claim.key.length === 0) throw new Error("computer use resource keys must be nonempty");
    if (claim.mode !== "read" && claim.mode !== "write") throw new Error("invalid computer use resource claim mode");
    modes.set(claim.key, claim.mode === "write" || modes.get(claim.key) === "write" ? "write" : "read");
  }
  return [...modes].sort(([left], [right]) => left.localeCompare(right))
    .map(([key, mode]) => ({ key, mode }));
}

function conflicts(left: readonly ComputerUseResourceClaim[], right: readonly ComputerUseResourceClaim[]): boolean {
  return left.some((first) => right.some((second) => first.key === second.key
    && (first.mode === "write" || second.mode === "write")));
}
