/**
 * Full-width management-route predicate (Stack 200 / D406 / D384).
 *
 * Durable management destinations own the center column: both side panels are
 * ineligible on these routes. Temporary work surfaces stay out on purpose.
 */
export function isFullWidthManagementRoute(pathname: string): boolean {
  return (
    pathname === "/settings" ||
    pathname === "/admin" ||
    pathname.startsWith("/admin/access-control") ||
    pathname === "/help" ||
    pathname.startsWith("/help/") ||
    pathname === "/approvals" ||
    pathname.startsWith("/skills") ||
    pathname.startsWith("/commands") ||
    pathname.startsWith("/memory") ||
    pathname.startsWith("/scheduled-tasks") ||
    pathname.startsWith("/connections")
  );
}
