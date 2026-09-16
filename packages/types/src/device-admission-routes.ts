/** Canonical content-free routes reachable before crypto-device admission. */
export type PreAdmissionRouteKind =
  | "identity"
  | "account_recovery"
  | "device_setup"
  | "admission"
  | "encryption_rollback";

const PRE_ADMISSION_ROUTES = new Map<string, PreAdmissionRouteKind>([
  ["GET /api/setup/status", "identity"],
  ["GET /api/auth/whoami", "identity"],
  ["GET /api/auth/pin-enrollment", "account_recovery"],
  ["POST /api/auth/pin-enrollment", "account_recovery"],
  ["GET /api/auth/recovery-codes/status", "account_recovery"],
  ["POST /api/auth/recovery-codes/regenerate", "account_recovery"],
  ["POST /api/auth/recover", "account_recovery"],
  ["GET /api/account/security", "account_recovery"],
  ["POST /api/account/password/change", "account_recovery"],
  ["POST /api/account/password/recover-with-code", "account_recovery"],
  ["GET /api/account/password/recovery-relay/:sessionId", "account_recovery"],
  ["POST /api/account/password/recovery-completed", "account_recovery"],
  ["POST /api/bind-logto-user", "identity"],
  ["POST /api/invites/:token/complete-profile", "identity"],
  ["POST /api/owner-claim/complete-profile", "identity"],
  ["GET /api/encryption-transition/policy", "encryption_rollback"],
  ["GET /api/admin/encryption-transition", "encryption_rollback"],
  ["POST /api/admin/encryption-transition", "encryption_rollback"],
  ["GET /api/crypto-device-admission/status", "admission"],
  ["POST /api/crypto-device-admission/challenge", "admission"],
  ["POST /api/crypto-device-admission/proof", "admission"],
  ["POST /api/protected/devices/initial-bootstrap/begin", "device_setup"],
  ["POST /api/protected/devices/initial-bootstrap/complete", "device_setup"],
  ["POST /api/protected/devices/initial-bootstrap/receipt", "device_setup"],
  ["POST /api/protected/devices/initial-domain/plan", "device_setup"],
  ["POST /api/protected/devices/initial-domain", "device_setup"],
  ["POST /api/protected/devices/membership/status", "device_setup"],
  ["POST /api/protected/devices/membership/initial", "device_setup"],
  ["POST /api/protected/devices/membership/begin", "device_setup"],
  ["POST /api/protected/devices/membership/pending", "device_setup"],
  ["POST /api/protected/devices/membership/roster", "device_setup"],
  ["POST /api/protected/devices/membership/recovery/begin", "device_setup"],
  ["POST /api/protected/devices/membership/acknowledge", "device_setup"],
  ["POST /api/protected/devices/membership/:operationId/join", "device_setup"],
  ["POST /api/protected/devices/membership/:operationId/add", "device_setup"],
  ["POST /api/protected/devices/membership/:operationId/remove", "device_setup"],
  ["POST /api/protected/devices/membership/:operationId/recovery", "device_setup"],
  ["POST /api/protected/devices/additional/begin", "device_setup"],
  ["POST /api/protected/devices/additional/pending", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/plan-page", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/join-packages", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/approve", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/transition-plan", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/transitions", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/deliveries", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/ack", "device_setup"],
  ["POST /api/protected/devices/additional/:operationId/activate", "device_setup"],
]);

export const PRE_ADMISSION_ROUTE_INVENTORY = Object.freeze(
  [...PRE_ADMISSION_ROUTES.entries()].map(([route, kind]) =>
    Object.freeze({ route, kind })
  ),
);

export function preAdmissionRouteKind(
  method: string,
  routeTemplate: string | undefined,
): PreAdmissionRouteKind | null {
  if (routeTemplate === undefined) return null;
  return PRE_ADMISSION_ROUTES.get(
    `${method.toUpperCase()} ${routeTemplate}`,
  ) ?? null;
}

/** Match a concrete browser URL against the same exact route inventory used
 * by server admission. This is a client availability guard, never authority. */
export function isPreAdmissionRequest(method: string, pathname: string): boolean {
  const segments = pathname.split("/");
  return PRE_ADMISSION_ROUTE_INVENTORY.some(({ route }) => {
    const [routeMethod, template] = route.split(" ");
    if (method.toUpperCase() !== routeMethod || template === undefined) return false;
    const expected = template.split("/");
    return expected.length === segments.length && expected.every((part, index) =>
      part.startsWith(":")
        ? segments[index] !== undefined && segments[index] !== ""
        : part === segments[index]
    );
  });
}
