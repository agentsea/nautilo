export type CryptoAdmissionPolicy = Readonly<{
  mode: "plaintext_only" | "shadow_encryption" | "encrypted_only";
  shadowBehavior: "fallback" | "strict";
}>;

export type CryptoAdmissionSnapshot = Readonly<{
  status: "unmanaged" | "checking" | "open" | "paused" | "blocked";
  generation: number;
  identity: string | null;
  policy: CryptoAdmissionPolicy | null;
}>;

type ManagedStatus = Exclude<CryptoAdmissionSnapshot["status"], "unmanaged">;

class CryptoAdmissionPausedError extends Error {
  readonly code = "crypto_admission_paused" as const;

  constructor(readonly snapshot: CryptoAdmissionSnapshot) {
    super(snapshot.status === "blocked"
      ? "Protected workspace access is blocked pending device admission."
      : "Protected workspace access is paused while device admission is checked.");
    this.name = "CryptoAdmissionPausedError";
  }
}

let snapshot: CryptoAdmissionSnapshot = Object.freeze({
  status: "unmanaged",
  generation: 0,
  identity: null,
  policy: null,
});

const listeners = new Set<() => void>();
let owner: ((reason: string) => void) | null = null;
let ownerToken: object | null = null;

function samePolicy(
  left: CryptoAdmissionPolicy | null,
  right: CryptoAdmissionPolicy | null,
): boolean {
  return left === right || (
    left !== null
    && right !== null
    && left.mode === right.mode
    && left.shadowBehavior === right.shadowBehavior
  );
}

function publish(next: CryptoAdmissionSnapshot): void {
  if (
    next.status === snapshot.status
    && next.generation === snapshot.generation
    && next.identity === snapshot.identity
    && samePolicy(next.policy, snapshot.policy)
  ) return;
  snapshot = Object.freeze({
    ...next,
    policy: next.policy === null ? null : Object.freeze({ ...next.policy }),
  });
  for (const listener of [...listeners]) listener();
}

function nextGenerationFor(
  status: CryptoAdmissionSnapshot["status"],
  identity: string | null,
  policy: CryptoAdmissionPolicy | null,
): number {
  const identityChanged = identity !== snapshot.identity;
  const revokedCurrentAccess = snapshot.status === "open" && status !== "open";
  const changedOpenPolicy = snapshot.status === "open"
    && status === "open"
    && !samePolicy(snapshot.policy, policy);
  const enteringManagedGate = snapshot.status === "unmanaged" && status !== "unmanaged";
  const leavingManagedGate = snapshot.status !== "unmanaged" && status === "unmanaged";
  return identityChanged || revokedCurrentAccess || changedOpenPolicy
    || enteringManagedGate || leavingManagedGate
    ? snapshot.generation + 1
    : snapshot.generation;
}

/** Current synchronous operation fence. Safe for use outside React. */
export function getCryptoAdmissionSnapshot(): CryptoAdmissionSnapshot {
  return snapshot;
}

export function subscribeCryptoAdmissionAccess(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * Routine checks do not revoke current admission. Security/transport signals
 * still invalidate synchronously before the single gate owner reconciles.
 * Disconnect pauses without manufacturing a retry.
 */
export function requestCryptoAdmissionRefresh(reason: string): void {
  const routine = reason === "visibility_resume"
    || reason === "online"
    || reason === "credential_changed";
  if (snapshot.status === "open" && !routine) {
    const identity = snapshot.identity;
    if (identity === null) return;
    const blocked = reason === "device_removed_or_stale";
    setCryptoAdmissionAccessState({
      status: blocked ? "blocked" : "paused",
      identity,
      policy: snapshot.policy,
    });
  } else if (reason === "device_removed_or_stale" && snapshot.status !== "unmanaged") {
    const identity = snapshot.identity;
    if (identity === null) return;
    setCryptoAdmissionAccessState({
      status: "blocked",
      identity,
      policy: snapshot.policy,
    });
  }
  owner?.(reason);
}

export function assertCryptoAdmissionAccess(expectedGeneration?: number): void {
  const current = snapshot;
  if (expectedGeneration !== undefined && expectedGeneration !== current.generation) {
    throw new CryptoAdmissionPausedError(current);
  }
  if (current.status === "unmanaged") return;
  if (current.status !== "open") throw new CryptoAdmissionPausedError(current);
}

export function isCryptoAdmissionAllowed(): boolean {
  return snapshot.status === "unmanaged" || snapshot.status === "open";
}

export function isCryptoAdmissionGenerationCurrent(generation: number): boolean {
  return isCryptoAdmissionAllowed() && snapshot.generation === generation;
}

/** Fence a non-HTTP protected operation across its complete async lifetime. */
export async function runWithCryptoAdmission<T>(
  operation: () => Promise<T>,
): Promise<T> {
  assertCryptoAdmissionAccess();
  const generation = snapshot.generation;
  const result = await operation();
  assertCryptoAdmissionAccess(generation);
  return result;
}

/** Gate-owner seam. Only the mounted admission gate may register a reconciler. */
export function registerCryptoAdmissionAccessOwner(
  onRefresh: (reason: string) => void,
): () => void {
  const token = {};
  ownerToken = token;
  owner = onRefresh;
  return () => {
    if (ownerToken !== token) return;
    owner = null;
    ownerToken = null;
    resetCryptoAdmissionAccess();
  };
}

/** Gate-owner seam for synchronous identity and admission state changes. */
export function setCryptoAdmissionAccessState(input: Readonly<{
  status: ManagedStatus;
  identity: string;
  policy: CryptoAdmissionPolicy | null;
}>): void {
  publish(Object.freeze({
    ...input,
    generation: nextGenerationFor(input.status, input.identity, input.policy),
  }));
}

/** Gate-owner cleanup. Unmanaged intentionally permits pre-gate pages/tests. */
export function resetCryptoAdmissionAccess(): void {
  publish(Object.freeze({
    status: "unmanaged",
    generation: nextGenerationFor("unmanaged", null, null),
    identity: null,
    policy: null,
  }));
}
