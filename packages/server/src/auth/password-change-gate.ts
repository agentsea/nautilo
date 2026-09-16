const RESTRICTED_ACCOUNT_ROUTES = new Set([
  "GET /api/auth/whoami",
  "GET /api/account/security",
  "POST /api/account/password/change",
]);

export function restrictedPasswordChangeRouteAllowed(method: string, routePath: string): boolean {
  return RESTRICTED_ACCOUNT_ROUTES.has(`${method.toUpperCase()} ${routePath}`);
}

export function passwordChangeRequiredError(): Error & {
  statusCode: number;
  code: string;
  publicError: string;
} {
  return Object.assign(new Error("Password change required."), {
    statusCode: 403,
    code: "password_change_required",
    publicError: "Password change required",
  });
}
