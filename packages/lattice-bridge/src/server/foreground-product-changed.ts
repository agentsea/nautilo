export class ForegroundProductChangedError extends Error {}
export class ForegroundAuthorityConvergingError extends Error {}

export function isForegroundProductChangedError(
  error: unknown,
): error is ForegroundProductChangedError {
  return error instanceof ForegroundProductChangedError;
}

export function isForegroundAuthorityConvergingError(
  error: unknown,
): error is ForegroundAuthorityConvergingError {
  return error instanceof ForegroundAuthorityConvergingError;
}
