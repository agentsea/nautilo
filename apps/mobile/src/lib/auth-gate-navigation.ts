import type { MobileAuthGateDestination, MobileAuthGateNavigationTarget } from "./auth-gate-navigation-contract";

export type { MobileAuthGateDestination, MobileAuthGateNavigationTarget } from "./auth-gate-navigation-contract";

export function failedMobileWebSignInPath(_returnPath: string | null): "/(onboarding)/sign-in" {
  return "/(onboarding)/sign-in";
}

export function authGateNavigationTarget(
  destination: MobileAuthGateDestination,
): MobileAuthGateNavigationTarget {
  return destination;
}

/** Native AuthSession owns its in-process post-login destination. */
export function currentSignInReturnPath(
  _value?: string | readonly string[],
): string | null {
  return null;
}

export function mobileWebRouterDestination(_returnPath: string): "/(drawer)/(tabs)" {
  return "/(drawer)/(tabs)";
}
