/** Runtime-owned, invocation-local source revalidation. Never checkpoint this
 * port or accept it from model arguments; it creates no terminal consent. */
export interface HumanTerminalAdmissionPolicy {
  readonly mode: string;
  readonly revision: number;
}

export interface HumanTerminalAdmissionScope {
  readonly roomId: string;
  readonly graphThreadId: string;
  readonly agentActorId: string;
}

/** Transaction-bound readers supplied only by the trusted Task creation owner. */
export interface BorrowedHumanTerminalAdmission {
  readPolicy(): Promise<HumanTerminalAdmissionPolicy>;
  readScope(): Promise<HumanTerminalAdmissionScope | null>;
  validateProtected(policy: HumanTerminalAdmissionPolicy): Promise<void>;
}

export interface HumanTerminalAdmissionPort {
  withAdmission<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
  withBorrowedAdmission?<T>(
    admission: BorrowedHumanTerminalAdmission,
    work: (signal: AbortSignal) => Promise<T>,
  ): Promise<T>;
}
