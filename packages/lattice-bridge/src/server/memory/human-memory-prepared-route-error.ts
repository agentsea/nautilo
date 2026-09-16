import type { ProtectedMemoryUnavailableResponseV1 } from "@nautilo/api-client";

export class HumanMemoryPreparedRouteError extends Error {
  readonly reason: ProtectedMemoryUnavailableResponseV1["reason"];

  constructor(
    reason: ProtectedMemoryUnavailableResponseV1["reason"],
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "HumanMemoryPreparedRouteError";
    this.reason = reason;
  }
}

export function humanMemoryPreparedIntegrityError(
  message: string,
  cause?: unknown,
): HumanMemoryPreparedRouteError {
  return new HumanMemoryPreparedRouteError(
    "integrity_failure",
    message,
    cause === undefined ? undefined : { cause },
  );
}

export function humanMemoryPreparedAuthorizationError(
  message: string,
): HumanMemoryPreparedRouteError {
  return new HumanMemoryPreparedRouteError("authorization_required", message);
}
