/** Domain separation prevents another catalogue's signature from authorizing this release. */
const KEYS: Readonly<Record<string, string>> = Object.freeze({
  "catalog-2026-07-17": "MCowBQYDK2VwAyEAX9Kq7L0rqQVJJw9Mau3fmr9nbKDC1iTDEWoWNVJZCAo=",
});

export function getTrustedComputerUseContractCataloguePublicKey(id: string): string | undefined {
  return KEYS[id];
}
