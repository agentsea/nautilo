/** Runtime-owned, invocation-local source revalidation. Never checkpoint this
 * port or accept it from model arguments; it creates no terminal consent. */
export interface HumanTerminalAdmissionPort {
  withAdmission<T>(work: (signal: AbortSignal) => Promise<T>): Promise<T>;
}
