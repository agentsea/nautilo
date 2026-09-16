export class HumanMemoryCryptoServiceUnavailableError extends Error {
  constructor(options?: ErrorOptions) {
    super("Human Memory crypto service is unavailable", options);
    this.name = "HumanMemoryCryptoServiceUnavailableError";
  }
}

export function isHumanMemoryCryptoServiceUnavailable(
  error: unknown,
): error is HumanMemoryCryptoServiceUnavailableError {
  return error instanceof HumanMemoryCryptoServiceUnavailableError;
}
