export type DormantCryptoServerOperation =
  | "first_device_bootstrap"
  | "additional_device_approval"
  | "device_recovery"
  | "recovery_rotation"
  | "device_revocation"
  | "human_membership_transition"
  | "background_authorization"
  | "stenographer_protected_transform";

export type DormantCryptoServerBoundaryErrorCode =
  | "activation_disabled"
  | "activation_invalid";

export class DormantCryptoServerBoundaryError extends Error {
  override readonly name = "DormantCryptoServerBoundaryError";

  constructor(
    readonly code: DormantCryptoServerBoundaryErrorCode,
    readonly operation: DormantCryptoServerOperation | null = null,
  ) {
    super(
      operation === null
        ? `Dormant crypto server boundary rejected (${code})`
        : `Dormant crypto server boundary rejected ${operation} (${code})`,
    );
  }
}

export interface DormantCryptoServerBoundary<Connection> {
  execute<Result>(input: {
    readonly operation: DormantCryptoServerOperation;
    readonly run: (connection: Connection) => Result | Promise<Result>;
  }): Promise<Result>;
}

function isExactDisabledActivation(
  value: unknown,
): value is { readonly stage: "disabled" } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 1 && record["stage"] === "disabled";
}

/**
 * Defines the server-side activation choke point without registering a
 * production route. Later dormant encryption waves extend the closed operation
 * vocabulary, while the only accepted state continues to reject before the
 * connection factory can be called.
 */
export function createDormantCryptoServerBoundary<Connection>(input: {
  readonly activation: unknown;
  readonly openCryptoConnection: () => Connection | Promise<Connection>;
}): DormantCryptoServerBoundary<Connection> {
  if (!isExactDisabledActivation(input.activation)) {
    throw new DormantCryptoServerBoundaryError("activation_invalid");
  }

  const openCryptoConnection = input.openCryptoConnection;
  return Object.freeze({
    execute<Result>(request: {
      readonly operation: DormantCryptoServerOperation;
      readonly run: (connection: Connection) => Result | Promise<Result>;
    }): Promise<Result> {
      void openCryptoConnection;
      void request.run;
      return Promise.reject(
        new DormantCryptoServerBoundaryError(
          "activation_disabled",
          request.operation,
        ),
      );
    },
  });
}
