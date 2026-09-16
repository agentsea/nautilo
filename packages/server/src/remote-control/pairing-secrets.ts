/**
 * D458 Wave 7 pairing verifier material.
 *
 * This module is intentionally small and side-effect free: it mints ceremony
 * values for a caller to display once, and derives comparison-safe HMAC
 * digests for persistence. Neither the plaintext nor the digest belongs in a
 * log line, response projection, or telemetry event.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const PEPPER_ENV = "NAUTILO_REMOTE_PAIRING_PEPPER";
const MINIMUM_PEPPER_BYTES = 32;
const QR_BYTES = 32;
const MANUAL_CODE_LENGTH = 12; // 32^12 = 60 bits
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export type PairingVerifierKind = "qr" | "manual";

export interface PairingVerifierSecrets {
  readonly qrSecret: string;
  readonly manualCode: string;
}

export class PairingPepperConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PairingPepperConfigurationError";
  }
}

/**
 * Validates and returns the configured HMAC key. A deployment has to provide
 * a stable, private value; falling back to a process-random value would make
 * active ceremonies unverifiable after a restart and is intentionally refused.
 */
export function requirePairingPepper(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const pepper = env[PEPPER_ENV]?.trim();
  if (!pepper) {
    throw new PairingPepperConfigurationError(
      `${PEPPER_ENV} must be configured before remote pairing is enabled`,
    );
  }
  if (Buffer.byteLength(pepper, "utf8") < MINIMUM_PEPPER_BYTES) {
    throw new PairingPepperConfigurationError(
      `${PEPPER_ENV} must contain at least ${MINIMUM_PEPPER_BYTES} bytes`,
    );
  }
  return pepper;
}

export function mintPairingVerifierSecrets(): PairingVerifierSecrets {
  return {
    qrSecret: randomBytes(QR_BYTES).toString("base64url"),
    manualCode: mintManualCode(),
  };
}

/** A 60-bit Crockford Base32 code suitable for human transcription. */
function mintManualCode(): string {
  const bits = randomBytes(8).readBigUInt64BE() & ((1n << 60n) - 1n);
  let remaining = bits;
  let output = "";
  for (let index = 0; index < MANUAL_CODE_LENGTH; index += 1) {
    output = CROCKFORD[Number(remaining & 31n)] + output;
    remaining >>= 5n;
  }
  return output;
}

/**
 * Normalizes human-entered Crockford Base32 without weakening its shape.
 * Separators are tolerated; ambiguous I/L/O glyphs normalize to 1/0.
 */
export function normalizeManualCode(value: string): string | null {
  const normalized = value
    .trim()
    .toUpperCase()
    .replace(/[\s-]/g, "")
    .replaceAll("O", "0")
    .replace(/[IL]/g, "1");
  if (normalized.length !== MANUAL_CODE_LENGTH) return null;
  if (!/^[0-9ABCDEFGHJKMNPQRSTVWXYZ]+$/.test(normalized)) return null;
  return normalized;
}

/**
 * Returns a domain-separated HMAC digest that is safe to store. `null` means
 * malformed candidate input; callers should return their non-enumerating
 * pairing error rather than revealing why it failed.
 */
export function digestPairingVerifier(
  pepper: string,
  kind: PairingVerifierKind,
  value: string,
): string | null {
  const canonical =
    kind === "manual" ? normalizeManualCode(value) : normalizeQrSecret(value);
  if (!canonical) return null;
  return createHmac("sha256", pepper)
    .update("nautilo.remote-pairing.v1\0")
    .update(kind)
    .update("\0")
    .update(canonical, "utf8")
    .digest("hex");
}

export function pairingVerifierMatches(
  expectedDigest: string,
  candidateDigest: string | null,
): boolean {
  if (!candidateDigest) return false;
  const expected = Buffer.from(expectedDigest, "hex");
  const candidate = Buffer.from(candidateDigest, "hex");
  if (
    expected.length !== candidate.length ||
    expected.length !== 32 ||
    candidate.length !== 32
  ) {
    return false;
  }
  return timingSafeEqual(expected, candidate);
}

function normalizeQrSecret(value: string): string | null {
  // 32 random bytes are base64url-encoded to 43 characters without padding.
  if (!/^[A-Za-z0-9_-]{43}$/.test(value)) return null;
  return value;
}
