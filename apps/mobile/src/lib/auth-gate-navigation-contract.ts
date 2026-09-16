import { parseBrowserMobileIntent } from "../platform/browser-intent.web";

export type MobileAuthGateDestination =
  | "/(onboarding)/add-server"
  | "/(onboarding)/sign-in";

export type MobileAuthGateNavigationTarget =
  | MobileAuthGateDestination
  | Readonly<{
      pathname: "/(onboarding)/sign-in";
      params: Readonly<{ returnTo: string }>;
    }>;

const MOBILE_WEB_SIGN_IN_PATH = "/mobile/sign-in";
const TASK_ROUTE_RE = /^\/tasks\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function safeProtectedMobileRoute(value: string, currentOrigin: string): string | null {
  // URL normalisation would otherwise turn an encoded traversal segment into a
  // different safe-looking route before the Task locator admission runs.
  if (/%(?:2e|2f|5c)/i.test(value)) return null;
  const intent = parseBrowserMobileIntent(value, currentOrigin);
  if (
    intent.kind !== "route"
    || intent.pathname === "/"
    || intent.pathname === "/sign-in"
    || intent.pathname === "/add-server"
  ) return null;
  // Task detail route parameters are locators, so its browser return path is
  // deliberately as exact as the server's static resolver. Preserve only the
  // exact UUID origin hint needed for no-history return after browser auth.
  if (intent.pathname === "/tasks" || intent.pathname.startsWith("/tasks/")) {
    const query = new URLSearchParams(intent.search);
    const originRoomId = query.get("originRoomId");
    const hasOnlySafeOrigin = query.size === 1 && originRoomId !== null && UUID_RE.test(originRoomId);
    if (!TASK_ROUTE_RE.test(intent.pathname) || (query.size !== 0 && !hasOnlySafeOrigin)) return null;
  }
  return `/mobile${intent.pathname}${intent.search}`;
}

export function failedMobileWebSignInPath(returnPath: string | null): string {
  const query = new URLSearchParams({ verification: "incomplete" });
  const safe = returnPath ? safeProtectedMobileRoute(returnPath, "https://mobile.invalid") : null;
  if (safe) {
    query.set("returnTo", safe);
  }
  return `${MOBILE_WEB_SIGN_IN_PATH}?${query}`;
}

export function webAuthGateNavigationTarget(
  destination: MobileAuthGateDestination,
  currentHref: string,
  currentOrigin: string,
): MobileAuthGateNavigationTarget {
  if (destination !== "/(onboarding)/sign-in") return destination;
  const returnTo = safeProtectedMobileRoute(currentHref, currentOrigin);
  if (!returnTo) return destination;
  return {
    pathname: "/(onboarding)/sign-in",
    params: { returnTo },
  };
}

export function validatedMobileWebSignInReturnPath(
  value: string | readonly string[] | undefined,
  currentOrigin: string,
): string | null {
  if (typeof value !== "string") return null;
  return safeProtectedMobileRoute(value, currentOrigin);
}

export function mobileWebRouterDestination(returnPath: string): string {
  const destination = returnPath.slice("/mobile".length);
  return destination || "/(drawer)/(tabs)";
}
