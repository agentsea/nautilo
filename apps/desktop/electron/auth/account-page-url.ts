/**
 * M101 Phase 4 — build Logto Account Center URLs for the embedded auth window.
 */

export type AccountPagePath = "/account" | "/account/password";

function trimTrailingSlashes(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

export function buildAccountPageUrl(endpoint: string, path: AccountPagePath): string {
  return `${trimTrailingSlashes(endpoint)}${path}`;
}
