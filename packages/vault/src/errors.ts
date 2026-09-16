/** No secret material in message strings. */
class VaultError extends Error {}

/** Malformed envelope or unreadable metadata only — never ciphertext or keys. */
export class VaultSchemaError extends VaultError {
  readonly reason?: string | undefined;

  constructor(message: string, reason?: string  ) {
    super(message);
    this.reason = reason;
  }
}

export class VaultScopeError extends VaultError {}

export class VaultLockedError extends VaultError {}

export class VaultCryptoError extends VaultError {}
