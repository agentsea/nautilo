import { describe, expect, test } from "bun:test";

import {
  canQueryMobileUserAgreement,
  isAgreementRecoveryPath,
  mobileAgreementStatusDuringRefresh,
  mobileUserAgreementDestination,
} from "./admission";

const providerSource = await Bun.file(new URL("../../providers/user-agreement.tsx", import.meta.url)).text();
const screenSource = await Bun.file(new URL("./agreement-screen.tsx", import.meta.url)).text();
const rootLayoutSource = await Bun.file(new URL("../../app/_layout.tsx", import.meta.url)).text();
const agreementRouteSource = await Bun.file(new URL("../../app/agreement.tsx", import.meta.url)).text();

describe("Mobile user agreement admission", () => {
  test("keeps an accepted same-scope revalidation out of global loading UI", () => {
    expect(mobileAgreementStatusDuringRefresh("accepted", true)).toBe("accepted");
    expect(mobileAgreementStatusDuringRefresh("accepted", false)).toBe("loading");
    expect(mobileAgreementStatusDuringRefresh("required", true)).toBe("loading");
  });

  test("queries agreement state for verified and durably confirmed stale identities", () => {
    for (const viewerState of ["verified", "stale"] as const) {
      expect(canQueryMobileUserAgreement({
        platform: "native",
        authStatus: "signed-in",
        viewerState,
        viewerUserId: "user-1",
      })).toBe(true);
    }
    expect(canQueryMobileUserAgreement({
      platform: "native",
      authStatus: "signed-in",
      viewerState: "cached",
      viewerUserId: "user-1",
    })).toBe(false);
    expect(canQueryMobileUserAgreement({
      platform: "web",
      authStatus: "signed-in",
      viewerState: "stale",
      viewerUserId: "user-1",
    })).toBe(false);
  });

  test("routes every authenticated product root to the agreement until accepted", () => {
    for (const rootSegment of ["(drawer)", "chat", "share", "tasks", undefined]) {
      expect(mobileUserAgreementDestination({
        authStatus: "signed-in",
        agreementStatus: "required",
        rootSegment,
        pathname: "/chat/room-1",
      })).toBe("/agreement");
    }
  });

  test("fails closed for unavailable and unsupported Servers", () => {
    for (const agreementStatus of ["unavailable", "unsupported"] as const) {
      expect(mobileUserAgreementDestination({
        authStatus: "signed-in",
        agreementStatus,
        rootSegment: "(drawer)",
        pathname: "/",
      })).toBe("/agreement");
    }
  });

  test("keeps the gate and account deletion reachable", () => {
    expect(isAgreementRecoveryPath("/settings/account-deletion")).toBe(true);
    expect(mobileUserAgreementDestination({
      authStatus: "signed-in",
      agreementStatus: "required",
      rootSegment: "agreement",
      pathname: "/agreement",
    })).toBeNull();
    expect(mobileUserAgreementDestination({
      authStatus: "signed-in",
      agreementStatus: "required",
      rootSegment: "(drawer)",
      pathname: "/settings/account-deletion",
    })).toBeNull();
  });

  test("leaves the gate after acceptance and waits during hydration", () => {
    expect(mobileUserAgreementDestination({
      authStatus: "signed-in",
      agreementStatus: "accepted",
      rootSegment: "agreement",
      pathname: "/agreement",
    })).toBe("/(drawer)/(tabs)");
    expect(mobileUserAgreementDestination({
      authStatus: "signed-in",
      agreementStatus: "loading",
      rootSegment: "chat",
      pathname: "/chat/room-1",
    })).toBeNull();
  });

  test("refreshes Server state once at identity, recovery, and Server boundaries", () => {
    expect(providerSource).toContain("canQueryMobileUserAgreement({");
    expect(providerSource).toContain("recoveryRevision");
    expect(providerSource).toContain("mobileAgreementStatusDuringRefresh(");
    expect(providerSource).toContain("existing.generation === generationRef.current");
    expect(providerSource).not.toContain("appLifecycle");
    expect(providerSource).toContain("scopeKey");
    expect(rootLayoutSource).toContain("<UserAgreementProvider>");
    expect(rootLayoutSource).toContain("mobileUserAgreementDestination({");
  });

  test("keeps one explicit acceptance and bounded recovery actions on native only", () => {
    expect(screenSource).toContain("Agree and allow processing");
    expect(screenSource).toContain("Not now");
    expect(screenSource).toContain("Privacy Policy");
    expect(screenSource).toContain("Contact Support");
    expect(screenSource).toContain("Delete account");
    expect(screenSource).toContain("Use another Server");
    expect(screenSource).not.toContain("Human-only");
    expect(agreementRouteSource).toContain('platform === "native"');
  });
});
