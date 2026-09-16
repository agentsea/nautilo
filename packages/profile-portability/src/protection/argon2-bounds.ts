/**
 * Argon2id KDF declared bounds. Wave 0 validates that a recovery slot's
 * declared parameters fall within these bounds; it does NOT run Argon2id
 * (derivation is out of Wave 0). Bounds follow OWASP-recommended minimums
 * with a generous ceiling for caller policy.
 */

export type Argon2idParams = {
  readonly memoryCostKiB: number;
  readonly timeCost: number;
  readonly parallelism: number;
  readonly outputLength: number;
};

export const ARGON2ID_BOUNDS = {
  memoryCostKiB: { min: 19456, max: 4_194_304 }, // 19 MiB .. 4 GiB
  timeCost: { min: 2, max: 10 },
  parallelism: { min: 1, max: 16 },
  outputLength: { exactly: 32 },
  saltLength: { exactly: 16 },
} as const;
