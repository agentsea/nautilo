/**
 * D429 Phase 7.4/8 — checked-in trusted public-key registry for signed
 * explainer catalog release pointers.
 *
 * The official production signing key (`catalog-2026-07-17`) is checked in
 * below. An official pointer that references an unknown `signingKeyId` fails
 * closed to the last-known-good / bundled seed and exposes a non-secret
 * reason. The loader NEVER accepts unsigned or unknown-key content.
 *
 * Keys are stored as canonical base64 DER SPKI Ed25519 public keys — the same
 * format `nautilo-catalogs/scripts/publish-explainer-catalog.mjs` exports
 * (via `catalog-signing.mjs`). The registry maps `signingKeyId` → public key
 * bytes. Tests inject Ed25519 test keys via
 * {@link setTrustedExplainerCatalogKeysForTests}; production never generates
 * or stores private keys here.
 */

/**
 * The checked-in trusted key map. Self-host / test deployments may add their
 * own keys via the runtime seam (see `runtime-catalog.ts`) without mutating
 * this file.
 */
const CHECKED_IN_TRUSTED_KEYS: Readonly<Record<string, string>> = Object.freeze({
  "catalog-2026-07-17":
    "MCowBQYDK2VwAyEAX9Kq7L0rqQVJJw9Mau3fmr9nbKDC1iTDEWoWNVJZCAo=",
});

let injectedKeys: Record<string, string> | null = null;

/**
 * Resolve the active trusted-key map. Test injection wins over the checked-in
 * registry; production (no injection) returns the checked-in map.
 */
function getTrustedExplainerCatalogKeys(): Record<string, string> {
  return injectedKeys ?? CHECKED_IN_TRUSTED_KEYS;
}

/** Resolve a trusted Ed25519 public key (base64 DER SPKI) by signing key id. */
export function getTrustedExplainerCatalogPublicKey(
  signingKeyId: string,
): string | undefined {
  return getTrustedExplainerCatalogKeys()[signingKeyId];
}

/** Test seam: inject a trusted-key map (signingKeyId → base64 DER SPKI). */
export function setTrustedExplainerCatalogKeysForTests(
  keys: Record<string, string> | null,
): void {
  injectedKeys = keys ? { ...keys } : null;
}

/** Test seam: reset to the checked-in registry. */
export function resetTrustedExplainerCatalogKeysForTests(): void {
  injectedKeys = null;
}
