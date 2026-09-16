/**
 * ISSUE-M214 — typed auth transition events and pure generation helpers.
 *
 * AuthProvider is the sole dispatcher; consumers listen via
 * `addAuthTransitionListener` and may ignore credential-only transitions
 * for an unchanged viewer generation.
 */

const NAUTILO_AUTH_CHANGED_EVENT = "nautilo:auth-changed" as const;

export type AuthTransitionReason =
  | "signed-in"
  | "credential-refreshed"
  | "signed-out"
  | "recovered"
  | "user-switched"
  | "instance-switched";

export interface AuthTransitionDetail {
  credentialGeneration: number;
  viewerGeneration: number;
  reason: AuthTransitionReason;
}

export function isAuthTransitionDetail(value: unknown): value is AuthTransitionDetail {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<AuthTransitionDetail>;
  return (
    typeof candidate.credentialGeneration === "number" &&
    typeof candidate.viewerGeneration === "number" &&
    typeof candidate.reason === "string" &&
    (
      candidate.reason === "signed-in" ||
      candidate.reason === "credential-refreshed" ||
      candidate.reason === "signed-out" ||
      candidate.reason === "recovered" ||
      candidate.reason === "user-switched" ||
      candidate.reason === "instance-switched"
    )
  );
}

export function dispatchAuthTransition(detail: AuthTransitionDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new window.CustomEvent<AuthTransitionDetail>(NAUTILO_AUTH_CHANGED_EVENT, {
      detail,
    }),
  );
}

function readAuthTransitionDetail(event: Event): AuthTransitionDetail | null {
  if (event.type !== NAUTILO_AUTH_CHANGED_EVENT) return null;
  const detail = (event as CustomEvent<AuthTransitionDetail>).detail;
  return isAuthTransitionDetail(detail) ? detail : null;
}

export function addAuthTransitionListener(
  handler: (detail: AuthTransitionDetail) => void,
): () => void {
  const onEvent = (event: Event): void => {
    const detail = readAuthTransitionDetail(event);
    if (detail) handler(detail);
  };
  window.addEventListener(NAUTILO_AUTH_CHANGED_EVENT, onEvent);
  return () => window.removeEventListener(NAUTILO_AUTH_CHANGED_EVENT, onEvent);
}

/** Stable viewer identity key for generation comparisons (user + instance). */
export function viewerIdentityKey(input: {
  sessionUserId: string | null | undefined;
  instanceId?: string | null | undefined;
}): string | null {
  const userId = input.sessionUserId ?? null;
  if (!userId) return null;
  const instanceId = input.instanceId ?? null;
  return instanceId ? `${userId}:${instanceId}` : userId;
}

export function shouldIgnoreCredentialOnlyTransition(
  lastProcessedViewerGeneration: number | null,
  detail: AuthTransitionDetail,
): boolean {
  return (
    detail.reason === "credential-refreshed" &&
    lastProcessedViewerGeneration !== null &&
    detail.viewerGeneration === lastProcessedViewerGeneration
  );
}

export function classifyViewerTransitionReason(input: {
  previousKey: string | null;
  nextKey: string | null;
  previousInstanceId: string | null;
  nextInstanceId: string | null;
  signedOut: boolean;
  signedIn: boolean;
}): AuthTransitionReason | null {
  if (input.signedOut || (input.previousKey && !input.nextKey)) {
    return "signed-out";
  }
  if (input.signedIn || (!input.previousKey && input.nextKey)) {
    return "signed-in";
  }
  if (input.previousKey && input.nextKey && input.previousKey !== input.nextKey) {
    const prevUser = input.previousKey.split(":")[0] ?? input.previousKey;
    const nextUser = input.nextKey.split(":")[0] ?? input.nextKey;
    if (prevUser !== nextUser) return "user-switched";
    if (
      input.previousInstanceId &&
      input.nextInstanceId &&
      input.previousInstanceId !== input.nextInstanceId
    ) {
      return "instance-switched";
    }
    return "user-switched";
  }
  return null;
}

export function classifyCredentialTransitionReason(input: {
  hadToken: boolean;
  hasToken: boolean;
  recovered: boolean;
}): AuthTransitionReason | null {
  if (input.recovered && input.hasToken) return "recovered";
  if (!input.hadToken && input.hasToken) return "signed-in";
  if (input.hadToken && !input.hasToken) return "signed-out";
  if (input.hadToken && input.hasToken) return "credential-refreshed";
  return null;
}

export interface CredentialLatchResult {
  token: string | null;
  credentialGeneration: number;
  changed: boolean;
  reason: AuthTransitionReason | null;
}

/**
 * Apply an acquired token through the one AuthProvider-owned latch.
 *
 * The API client owns the authoritative non-secret credential generation;
 * this helper only publishes after that generation has advanced. Keeping this
 * boundary pure through injected callbacks makes silent-refresh behavior
 * testable without mounting the Logto-backed hook.
 */
export function latchCredentialToken(input: {
  acquiredToken: string | null;
  previousToken: string | null;
  recovered: boolean;
  viewerGeneration: number;
  setToken: (token: string | null) => void;
  getCredentialGeneration: () => number;
  publish: (detail: AuthTransitionDetail) => void;
}): CredentialLatchResult {
  const token = input.acquiredToken && input.acquiredToken.length > 0
    ? input.acquiredToken
    : null;
  const previousToken = input.previousToken && input.previousToken.length > 0
    ? input.previousToken
    : null;
  const generationBefore = input.getCredentialGeneration();
  input.setToken(token);
  const credentialGeneration = input.getCredentialGeneration();
  const changed = credentialGeneration !== generationBefore;
  const reason = changed
    ? classifyCredentialTransitionReason({
        hadToken: previousToken !== null,
        hasToken: token !== null,
        recovered: input.recovered,
      })
    : null;

  if (reason) {
    input.publish({
      credentialGeneration,
      viewerGeneration: input.viewerGeneration,
      reason,
    });
  }

  return { token, credentialGeneration, changed, reason };
}
