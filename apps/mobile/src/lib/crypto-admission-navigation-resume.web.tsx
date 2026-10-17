import { router, useRootNavigationState, type Href } from "expo-router";
import { useEffect, useRef } from "react";

import {
  mobileWebRouterDestination,
  validatedMobileWebSignInReturnPath,
} from "./auth-gate-navigation-contract";
import type {
  CryptoAdmissionNavigationResumeIntent,
  CryptoAdmissionNavigationResumeProps,
} from "./crypto-admission-navigation-resume-contract";
import { useCryptoAdmissionNavigationResume } from "./crypto-admission-navigation-resume-context";
import { parseBrowserMobileIntent } from "../platform/browser-intent.web";

export type { CryptoAdmissionNavigationResumeIntent } from "./crypto-admission-navigation-resume-contract";

export function captureWebCryptoAdmissionNavigationResume(
  admissionKey: string,
  href: string,
  origin: string,
): CryptoAdmissionNavigationResumeIntent | null {
  const location = parseBrowserMobileIntent(href, origin);
  if (location.kind !== "route") return null;

  let returnPath: string | null;
  if (location.pathname === "/sign-in") {
    const search = new URLSearchParams(location.search);
    const values = search.getAll("returnTo");
    returnPath = search.size === 1 && values.length === 1
      ? validatedMobileWebSignInReturnPath(values[0], origin)
      : null;
  } else {
    returnPath = validatedMobileWebSignInReturnPath(href, origin);
  }
  if (returnPath === null) return null;
  return {
    admissionKey,
    destination: mobileWebRouterDestination(returnPath),
  };
}

export function captureCryptoAdmissionNavigationResume(
  admissionKey: string,
): CryptoAdmissionNavigationResumeIntent | null {
  if (typeof window === "undefined") return null;
  return captureWebCryptoAdmissionNavigationResume(
    admissionKey,
    window.location.href,
    window.location.origin,
  );
}

export function CryptoAdmissionNavigationResume({
  ready,
}: CryptoAdmissionNavigationResumeProps): null {
  const navigationState = useRootNavigationState();
  const binding = useCryptoAdmissionNavigationResume();
  const consumed = useRef(false);

  useEffect(() => {
    if (
      consumed.current
      || !ready
      || !navigationState?.key
      || binding === null
      || binding.intent.admissionKey !== binding.admissionKey
    ) return;
    consumed.current = true;
    binding.onConsumed(binding.intent);
    router.replace(binding.intent.destination as Href);
  }, [binding, navigationState?.key, ready]);

  return null;
}
