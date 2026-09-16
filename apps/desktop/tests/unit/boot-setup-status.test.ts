import { describe, expect, test } from "bun:test";
import type { SetupStatusResponse } from "@nautilo/api-client";
import {
  mapSetupStatusToServerClaimState,
  shouldForceGenieOnboardingFromSetup,
  shouldSkipGenieOnboardingWizard,
} from "../../electron/boot-setup-status";

const base: Pick<
  SetupStatusResponse,
  "instanceId" | "serverUrl" | "deploymentMode" | "claimRequired"
> = {
  instanceId: "i",
  serverUrl: "http://127.0.0.1:3001",
  deploymentMode: "local-self-host",
  claimRequired: false,
};

function stub(partial: Partial<SetupStatusResponse> & Pick<SetupStatusResponse, "setupState">): SetupStatusResponse {
  return {
    ...base,
    recommendedSetupSurface: { kind: "cli", url: null },
    ...partial,
  } as SetupStatusResponse;
}

describe("boot-setup-status (D112 Phase 4)", () => {
  test("mapSetupStatusToServerClaimState — fresh-unclaimed → unclaimed", () => {
    expect(mapSetupStatusToServerClaimState(stub({ setupState: "fresh-unclaimed" }))).toBe(
      "unclaimed",
    );
  });

  test("mapSetupStatusToServerClaimState — claimed-needs-auth → invite-pending", () => {
    expect(
      mapSetupStatusToServerClaimState(
        stub({
          setupState: "claimed-needs-auth",
          recommendedSetupSurface: { kind: "workbench-admin", url: "http://127.0.0.1:3001" },
        }),
      ),
    ).toBe("invite-pending");
  });

  test("mapSetupStatusToServerClaimState — server-needs-keys → invite-pending", () => {
    expect(
      mapSetupStatusToServerClaimState(
        stub({
          setupState: "server-needs-keys",
          viewer: { canManageServerSettings: false, genieCustomized: false, byokConfigured: false },
          providers: { hasLlm: false, managedByCloud: false },
          recommendedSetupSurface: { kind: "ask-admin", url: null },
        }),
      ),
    ).toBe("invite-pending");
  });

  test("mapSetupStatusToServerClaimState — ready without viewer → ready", () => {
    expect(mapSetupStatusToServerClaimState(stub({ setupState: "ready" }))).toBe("ready");
  });

  test("mapSetupStatusToServerClaimState — ready with viewer → authenticated", () => {
    expect(
      mapSetupStatusToServerClaimState(
        stub({
          setupState: "ready",
          viewer: { canManageServerSettings: false, genieCustomized: true, byokConfigured: true },
          providers: { hasLlm: true, managedByCloud: false },
        }),
      ),
    ).toBe("authenticated");
  });

  test("mapSetupStatusToServerClaimState — null → ready (boot-probe-failed fallback)", () => {
    expect(mapSetupStatusToServerClaimState(null)).toBe("ready");
  });

  test("shouldSkipGenieOnboardingWizard — server-needs-keys", () => {
    const st: SetupStatusResponse = {
      ...base,
      setupState: "server-needs-keys",
      viewer: {
        canManageServerSettings: false,
        genieCustomized: false,
        byokConfigured: false,
      },
      providers: { hasLlm: false, managedByCloud: false },
      recommendedSetupSurface: { kind: "ask-admin", url: null },
    };
    expect(shouldSkipGenieOnboardingWizard(st)).toBe(true);
  });

  test("shouldSkipGenieOnboardingWizard — claimed-needs-auth shows sign-in, not wizard", () => {
    const st: SetupStatusResponse = {
      ...base,
      setupState: "claimed-needs-auth",
      recommendedSetupSurface: { kind: "workbench-admin", url: "http://127.0.0.1:3001" },
    };
    expect(shouldSkipGenieOnboardingWizard(st)).toBe(true);
  });

  test("shouldSkipGenieOnboardingWizard — genie already customized", () => {
    const st: SetupStatusResponse = {
      ...base,
      setupState: "ready",
      viewer: {
        canManageServerSettings: true,
        genieCustomized: true,
        byokConfigured: false,
      },
      providers: { hasLlm: true, managedByCloud: false },
      recommendedSetupSurface: { kind: "cli", url: null },
    };
    expect(shouldSkipGenieOnboardingWizard(st)).toBe(true);
  });

  test("shouldForceGenieOnboardingFromSetup", () => {
    const st: SetupStatusResponse = {
      ...base,
      setupState: "ready",
      viewer: {
        canManageServerSettings: true,
        genieCustomized: false,
        byokConfigured: false,
      },
      providers: { hasLlm: true, managedByCloud: false },
      recommendedSetupSurface: { kind: "cli", url: null },
    };
    expect(shouldForceGenieOnboardingFromSetup(st)).toBe(true);
  });

  test("capability-restricted authenticated Human never sees Genie onboarding", () => {
    const st: SetupStatusResponse = {
      ...base,
      setupState: "ready",
      viewer: {
        canManageServerSettings: false,
        canInvokeAgents: false,
        genieCustomized: false,
        byokConfigured: false,
      },
      providers: { hasLlm: true, managedByCloud: false },
      recommendedSetupSurface: { kind: "cli", url: null },
    };
    expect(shouldSkipGenieOnboardingWizard(st)).toBe(true);
    expect(shouldForceGenieOnboardingFromSetup(st)).toBe(false);
  });
});
