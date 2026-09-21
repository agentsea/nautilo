import { isCloudManagedDeployment } from "@nautilo/config-guard";

export const MANAGED_PROVIDER_CREDENTIAL_ROUTE_DECISIONS = {
  "/api/admin/users/:id/permanent-credentials": "owner-only-member-credential",
  "/api/health/keys": "blocked-provider-key-status",
  "/api/health/keys/validate": "blocked-provider-key-validation",
  "/api/setup/keys": "blocked-provider-key-mutation",
  "/api/setup/nautilo-gateway": "blocked-provider-configuration-mutation",
  "/api/setup/research-provider": "redacted-provider-status",
  "/api/relay/electron-origin-credential": "unrelated-device-credential",
} as const;

export function managedProviderCredentialRouteIsBlocked(
  path: keyof typeof MANAGED_PROVIDER_CREDENTIAL_ROUTE_DECISIONS,
): boolean {
  return isCloudManagedDeployment() &&
    MANAGED_PROVIDER_CREDENTIAL_ROUTE_DECISIONS[path].startsWith("blocked-provider-");
}
