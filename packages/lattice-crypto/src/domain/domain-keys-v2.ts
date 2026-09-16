import type { LatticeCrypto } from "../crypto/index.ts";
import { copyOwnedBytesV2 } from "../v2-types/opaque.ts";

export const DOMAIN_KEY_BYTES_V2 = 32;

export type DomainKeyClassV2 = "human" | "ai";

export function domainKeyClassV2(value: unknown): DomainKeyClassV2 {
  if (value !== "human" && value !== "ai") {
    throw new TypeError("Domain key class is unsupported");
  }
  return value;
}

export function generateDomainKeyV2(
  crypto: Pick<LatticeCrypto, "randomBytes">,
): Uint8Array {
  const key = crypto.randomBytes(DOMAIN_KEY_BYTES_V2);
  if (key.length !== DOMAIN_KEY_BYTES_V2) {
    key.fill(0);
    throw new RangeError(
      `Domain key must be exactly ${DOMAIN_KEY_BYTES_V2} bytes`,
    );
  }
  return key;
}

/**
 * Exposes a short-lived owned copy and destroys it immediately after use.
 * Persistent vaults retain custody of their original buffer.
 */
export async function withDomainKeyV2<Value>(
  key: Uint8Array,
  use: (openedKey: Uint8Array) => Promise<Value> | Value,
): Promise<Value> {
  if (!(key instanceof Uint8Array) || key.length !== DOMAIN_KEY_BYTES_V2) {
    throw new RangeError(
      `Domain key must be exactly ${DOMAIN_KEY_BYTES_V2} bytes`,
    );
  }
  const opened = copyOwnedBytesV2(key);
  try {
    return await use(opened);
  } finally {
    opened.fill(0);
  }
}

export function destroyDomainKeyV2(key: Uint8Array): void {
  key.fill(0);
}
