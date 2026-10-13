import type {
  CryptoAdmissionNavigationResumeIntent,
  CryptoAdmissionNavigationResumeProps,
} from "./crypto-admission-navigation-resume-contract";

export type { CryptoAdmissionNavigationResumeIntent } from "./crypto-admission-navigation-resume-contract";

/** Native authentication does not use browser return destinations. */
export function captureCryptoAdmissionNavigationResume(
  _admissionKey: string,
): CryptoAdmissionNavigationResumeIntent | null {
  return null;
}

export function CryptoAdmissionNavigationResume(
  _props: CryptoAdmissionNavigationResumeProps,
): null {
  return null;
}
