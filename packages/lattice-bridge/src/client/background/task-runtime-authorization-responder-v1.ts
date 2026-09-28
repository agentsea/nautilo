import {
  mintDomainForegroundAuthorization,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  decodeTaskRuntimeBackgroundAuthorizationRequestV1,
  destroyTaskRuntimeBackgroundAuthorizationRequestV1,
} from "@nautilo/lattice-crypto/background";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
  type DomainForegroundAuthorizationPlanV2,
} from "@nautilo/lattice-crypto/wire";

import type { DomainForegroundAuthorityClientV2 } from
  "../message/domain-foreground-authority-client.ts";
import type {
  DeviceAuthorizationResponderResultV2,
  WithCurrentBackgroundAuthorizationSigningAuthorityV2,
} from "./device-authorization-responder-v2.ts";

export type TaskRuntimeAuthorizationResponderAttemptV1 =
  | DeviceAuthorizationResponderResultV2
  | Readonly<{ status: "not_task_runtime" }>;

export interface TaskRuntimeAuthorizationResponderV1Input {
  readonly requestBytes: Uint8Array;
  readonly signal?: AbortSignal;
  readonly domainForegroundAuthority: DomainForegroundAuthorityClientV2;
  readonly crypto: LatticeCrypto;
  readonly now: () => number;
  readonly withCurrentSigningAuthority:
    WithCurrentBackgroundAuthorizationSigningAuthorityV2;
}

type NonReadyResult = Exclude<
  DeviceAuthorizationResponderResultV2,
  { status: "ready" }
>;

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string"
    ? signal.reason
    : "Task Runtime authorization cancelled");
  error.name = "AbortError";
  throw error;
}

function currentWindow(
  input: Pick<TaskRuntimeAuthorizationResponderV1Input, "now" | "signal">,
  issuedAt: number,
  deadlineAt: number,
): NonReadyResult | null {
  throwIfAborted(input.signal);
  let now: number;
  try {
    now = input.now();
  } catch {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "invalid_clock" as const,
    });
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "invalid_clock" as const,
    });
  }
  if (now < issuedAt) {
    return Object.freeze({
      status: "stale" as const,
      reason: "not_yet_valid" as const,
    });
  }
  if (now >= deadlineAt) {
    return Object.freeze({
      status: "stale" as const,
      reason: "expired" as const,
    });
  }
  return null;
}

function currentAuthorityMatches(
  plan: DomainForegroundAuthorizationPlanV2,
  authority: Parameters<
    Parameters<
      TaskRuntimeAuthorizationResponderV1Input[
        "withCurrentSigningAuthority"
      ]
    >[0]
  >[0],
): "current" | "policy_changed" | "device_authority_changed" {
  if (authority.policyRevision !== plan.policyRevision) {
    return "policy_changed";
  }
  return authority.issuer.humanId === plan.subjectHumanId
    && authority.issuer.deviceId === plan.committerDeviceId
    && authority.issuer.deviceGeneration
      === plan.committerDeviceSigningGeneration
    && authority.hostAuthorizationRevision === plan.hostAuthorizationRevision
    ? "current"
    : "device_authority_changed";
}

/**
 * Attempts the canonical Task Runtime carrier before the fixed-processor
 * responder. A non-Task carrier is returned untouched to the caller so the
 * existing processor response path keeps its exact behavior and bytes.
 */
export async function tryRespondToCurrentTaskRuntimeAuthorizationV1(
  input: TaskRuntimeAuthorizationResponderV1Input,
): Promise<TaskRuntimeAuthorizationResponderAttemptV1> {
  throwIfAborted(input.signal);
  if (!(input.requestBytes instanceof Uint8Array)) {
    return Object.freeze({ status: "not_task_runtime" as const });
  }
  const requestBytes = Uint8Array.from(input.requestBytes);
  const request = decodeTaskRuntimeBackgroundAuthorizationRequestV1(
    requestBytes,
  );
  if (request === null) {
    requestBytes.fill(0);
    return Object.freeze({ status: "not_task_runtime" as const });
  }

  let plan: DomainForegroundAuthorizationPlanV2 | null = null;
  let candidateResponse: Uint8Array | undefined;
  try {
    let window = currentWindow(input, request.issuedAt, request.deadlineAt);
    if (window !== null) return window;
    plan = parseDomainForegroundAuthorizationPlanV2(
      request.authorizationPlanBytes,
    );
    if (plan === null) {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "invalid_descriptor" as const,
      });
    }

    let opened;
    try {
      opened = await input.domainForegroundAuthority
        .withOpenedAuthorizationDomains({
          sourceRoomId: request.sourceRoomId,
          domains: plan.domains,
        }, async (domains: readonly DomainForegroundSecretEntry[]) => {
          let callbackWindow = currentWindow(
            input,
            request.issuedAt,
            request.deadlineAt,
          );
          if (callbackWindow !== null) return callbackWindow;
          let signingCallbackInvoked = false;
          let signed: DeviceAuthorizationResponderResultV2 | null;
          try {
            signed = await input.withCurrentSigningAuthority(
              async (authority): Promise<
                DeviceAuthorizationResponderResultV2
              > => {
                if (signingCallbackInvoked) {
                  return Object.freeze({
                    status: "unavailable" as const,
                    reason: "signing_authority_unavailable" as const,
                  });
                }
                signingCallbackInvoked = true;
                const signingWindow = currentWindow(
                  input,
                  request.issuedAt,
                  request.deadlineAt,
                );
                if (signingWindow !== null) return signingWindow;
                const authorityState = currentAuthorityMatches(plan!, authority);
                if (authorityState !== "current") {
                  return Object.freeze({
                    status: "stale" as const,
                    reason: authorityState,
                  });
                }
                try {
                  const authorization = await mintDomainForegroundAuthorization(
                    input.crypto,
                    {
                      plan: plan!,
                      domains,
                      committerDeviceSigningPrivateKey:
                        authority.signingPrivateKey,
                      recipientEncryptionPublicKey:
                        request.recipientPublicKey,
                    },
                  );
                  try {
                    candidateResponse =
                      serializeDomainForegroundAuthorizationV2(authorization);
                  } finally {
                    destroyDomainForegroundAuthorizationV2(authorization);
                  }
                } catch {
                  throwIfAborted(input.signal);
                  return Object.freeze({
                    status: "unavailable" as const,
                    reason: "response_creation_failed" as const,
                  });
                }
                const createdWindow = currentWindow(
                  input,
                  request.issuedAt,
                  request.deadlineAt,
                );
                if (createdWindow !== null) {
                  candidateResponse.fill(0);
                  candidateResponse = undefined;
                  return createdWindow;
                }
                return Object.freeze({
                  status: "ready" as const,
                  requestId: request.requestId,
                  recipientGeneration: request.recipientGeneration,
                  expiresAt: request.deadlineAt,
                  responseBytes: candidateResponse,
                });
              },
            );
          } catch {
            throwIfAborted(input.signal);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "signing_authority_unavailable" as const,
            });
          }
          callbackWindow = currentWindow(
            input,
            request.issuedAt,
            request.deadlineAt,
          );
          if (callbackWindow !== null) return callbackWindow;
          return signed ?? Object.freeze({
            status: "unavailable" as const,
            reason: "signing_authority_unavailable" as const,
          });
        });
    } catch {
      throwIfAborted(input.signal);
      return Object.freeze({
        status: "unavailable" as const,
        reason: "domain_authority_unavailable" as const,
      });
    }
    window = currentWindow(input, request.issuedAt, request.deadlineAt);
    if (window !== null) return window;
    if (opened.status !== "opened") {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "domain_authority_unavailable" as const,
      });
    }
    if (opened.value.status === "ready") candidateResponse = undefined;
    return opened.value;
  } finally {
    candidateResponse?.fill(0);
    if (plan !== null) destroyDomainForegroundAuthorizationPlanV2(plan);
    destroyTaskRuntimeBackgroundAuthorizationRequestV1(request);
    requestBytes.fill(0);
  }
}
