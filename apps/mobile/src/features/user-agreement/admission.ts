export type MobileUserAgreementStatus =
  | "loading"
  | "required"
  | "accepted"
  | "unsupported"
  | "unavailable";

export type MobileAgreementViewerState = "loading" | "cached" | "verified" | "stale" | "none";

/** Same-scope revalidation must not turn settled product admission into boot UI. */
export function mobileAgreementStatusDuringRefresh(
  current: MobileUserAgreementStatus,
  sameSettledScope: boolean,
): MobileUserAgreementStatus {
  return sameSettledScope && current === "accepted" ? "accepted" : "loading";
}

/**
 * Pure recovery seam: a stale viewer still has a durably confirmed token
 * owner, so the authenticated Server remains authoritative for agreement state.
 */
export function canQueryMobileUserAgreement(input: {
  platform: "native" | "web";
  authStatus: "loading" | "signed-in" | "signed-out";
  viewerState: MobileAgreementViewerState;
  viewerUserId: string | null;
}): boolean {
  return input.platform === "native" &&
    input.authStatus === "signed-in" &&
    (input.viewerState === "verified" || input.viewerState === "stale") &&
    input.viewerUserId !== null;
}

const ACCOUNT_DELETION_PATH = "/settings/account-deletion";

export function isAgreementRecoveryPath(pathname: string): boolean {
  return pathname === ACCOUNT_DELETION_PATH;
}

export function mobileUserAgreementDestination(input: {
  authStatus: "loading" | "signed-in" | "signed-out";
  agreementStatus: MobileUserAgreementStatus;
  rootSegment: string | undefined;
  pathname: string;
}): "/agreement" | "/(drawer)/(tabs)" | null {
  if (input.authStatus !== "signed-in" || input.agreementStatus === "loading") return null;
  if (input.agreementStatus === "accepted") {
    return input.rootSegment === "agreement" ? "/(drawer)/(tabs)" : null;
  }
  if (input.rootSegment === "agreement" || isAgreementRecoveryPath(input.pathname)) return null;
  return "/agreement";
}
