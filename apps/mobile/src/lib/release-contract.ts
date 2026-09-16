/**
 * Source-owned, human-visible Mobile release contract.
 *
 * EAS owns the independent iOS build number and Android version code. This
 * contract owns the semantic release identity and the server modes this
 * packaged Mobile cycle is qualified to enter.
 */
export const MOBILE_RELEASE_CONTRACT = {
  version: "0.2.1",
  supportedServerModes: ["plaintext_only"],
  unsupportedProtectedModeBehavior: "unavailable",
} as const;
