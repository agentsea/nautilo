import argon2 from "argon2";

/**
 * Hash a PIN using Argon2id.
 * Returns a PHC-format string that embeds algorithm, version, params, salt, and hash.
 */
export async function hashPin(pin: string): Promise<string> {
  return argon2.hash(pin, {
    type: argon2.argon2id,
    memoryCost: 19456, // 19 MiB — OWASP minimum recommendation
    timeCost: 2,
    parallelism: 1,
  });
}

/**
 * Verify a PIN against a stored Argon2id hash.
 * Uses constant-time comparison internally.
 */
export async function verifyPin(pin: string, stored: string): Promise<boolean> {
  try {
    return await argon2.verify(stored, pin);
  } catch {
    return false;
  }
}
