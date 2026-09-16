/// <reference types="bun-types" />

import { describe, expect, test } from "bun:test";

import { inviteCallbackFallback, inviteCallbackRecovery } from "./invite-callback-recovery";
import type { InviteRoute } from "./invite-intake";

const route: InviteRoute = {
  pathname: "/(onboarding)/invite",
  params: {
    serverUrl: "https://invites.example.test",
    serverId: "srv_invites_example",
    generation: "4",
    ceremonyId: "ceremony-4",
  },
};

describe("invite callback recovery", () => {
  test("waits through hosted auth and bind, then restores only the profile ceremony", () => {
    expect(inviteCallbackRecovery(route, "external-auth")).toEqual({ kind: "waiting" });
    expect(inviteCallbackRecovery(route, "binding")).toEqual({ kind: "waiting" });
    expect(inviteCallbackRecovery(route, "profile")).toEqual({ kind: "restore", route });
  });

  test("never manufactures a route when this process has no owned ceremony", () => {
    expect(inviteCallbackRecovery(null, "profile")).toEqual({ kind: "unavailable" });
    expect(inviteCallbackFallback(null)).toEqual({ kind: "restart" });
    expect(inviteCallbackFallback(route)).toEqual({ kind: "resume", route });
  });
});
