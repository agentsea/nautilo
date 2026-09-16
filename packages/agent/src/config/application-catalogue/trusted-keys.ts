/**
 * Deliberately reuses the reviewed catalogue public-key bytes, but signatures
 * are domain-separated by `nautilo-application-catalogue-v1`; a model or
 * explainer signature therefore cannot verify an application release.
 */
const KEYS: Readonly<Record<string, string>> = Object.freeze({
  "catalog-2026-07-17": "MCowBQYDK2VwAyEAX9Kq7L0rqQVJJw9Mau3fmr9nbKDC1iTDEWoWNVJZCAo=",
});
export function getTrustedApplicationCataloguePublicKey(id: string): string | undefined { return KEYS[id]; }
