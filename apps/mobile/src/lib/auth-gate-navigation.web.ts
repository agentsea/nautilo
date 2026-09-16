import {
  validatedMobileWebSignInReturnPath,
  webAuthGateNavigationTarget,
  type MobileAuthGateDestination,
  type MobileAuthGateNavigationTarget,
} from "./auth-gate-navigation-contract";

export {
  failedMobileWebSignInPath,
  mobileWebRouterDestination,
  validatedMobileWebSignInReturnPath,
  webAuthGateNavigationTarget,
  type MobileAuthGateDestination,
  type MobileAuthGateNavigationTarget,
} from "./auth-gate-navigation-contract";

export function authGateNavigationTarget(
  destination: MobileAuthGateDestination,
): MobileAuthGateNavigationTarget {
  if (typeof window === "undefined") return destination;
  return webAuthGateNavigationTarget(destination, window.location.href, window.location.origin);
}

export function currentSignInReturnPath(
  value: string | readonly string[] | undefined,
): string | null {
  if (typeof window === "undefined") return null;
  return validatedMobileWebSignInReturnPath(value, window.location.origin);
}
