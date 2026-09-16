/** Sentinel plaintext — verified before any real encrypted secret is touched (Spacebot-inspired). */
export const VAULT_ENCRYPTION_SENTINEL = "nautilo-vault-sentinel-v1" as const;

/** Current persisted `vault.enc` envelope. */
export const VAULT_DISK_SCHEMA_VERSION = 1 as const;

/**
 * Spacebot-aligned Argon2id cost for vault KDF wrapping (PIN / migration keys).
 * Deviates from `@nautilo/trust/pin-hash` (smaller COST) deliberately — vault KDF workload.
 *
 * MEMORY: KiB (`argon2` package). 65536 KiB === 64 MiB.
 */
export const VAULT_ARGON2_WRAP = Object.freeze({
  memoryCost: 65536 as const,
  timeCost: 3 as const,
  parallelism: 1 as const,
  hashLength: 32 as const,
});
