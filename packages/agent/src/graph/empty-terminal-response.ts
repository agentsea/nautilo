/**
 * The provider completed a model invocation without a visible reply or a
 * callable tool request. Treating that as a successful graph terminal leaves
 * the Human with a disappearing typing indicator and no explanation.
 */
export class EmptyTerminalResponseError extends Error {
  override readonly name = "EmptyTerminalResponseError";

  constructor() {
    super("The model completed without a visible response.");
  }
}

export function isEmptyTerminalResponseError(
  error: unknown,
): error is EmptyTerminalResponseError {
  return error instanceof EmptyTerminalResponseError ||
    (error instanceof Error && error.name === "EmptyTerminalResponseError");
}
