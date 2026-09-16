import { describe, expect, test } from "bun:test";
import {
  inviteAuthorityFromCapabilities,
  inviteRevocationAllowed,
  inviteRoleAllowed,
  inviteRoomAllowed,
} from "../../src/lib/invite-authority";

describe("self-service invitation authority", () => {
  const selfService = inviteAuthorityFromCapabilities(["create_invites"]);
  const admin = inviteAuthorityFromCapabilities(["manage_members", "manage_rooms"]);
  const denied = inviteAuthorityFromCapabilities([]);

  test("permits bounded target roles only", () => {
    expect(inviteRoleAllowed(selfService, "member")).toBeTrue();
    expect(inviteRoleAllowed(selfService, "contributor")).toBeTrue();
    expect(inviteRoleAllowed(selfService, "guest")).toBeTrue();
    expect(inviteRoleAllowed(selfService, "superuser")).toBeFalse();
    expect(inviteRoleAllowed(selfService, "admin")).toBeFalse();
    expect(inviteRoleAllowed(selfService, "owner")).toBeFalse();
    expect(inviteRoleAllowed(admin, "owner")).toBeTrue();
  });

  test("permits only caller-owned rooms unless manage_rooms is held", () => {
    expect(inviteRoomAllowed(selfService, "user-a", "user-a")).toBeTrue();
    expect(inviteRoomAllowed(selfService, "user-a", "user-b")).toBeFalse();
    expect(inviteRoomAllowed(selfService, "user-a", null)).toBeFalse();
    expect(inviteRoomAllowed(admin, "user-a", "user-b")).toBeTrue();
  });

  test("permits creator revocation while preserving global admin revocation", () => {
    expect(inviteRevocationAllowed(selfService, "user-a", "user-a")).toBeTrue();
    expect(inviteRevocationAllowed(selfService, "user-a", "user-b")).toBeFalse();
    expect(inviteRevocationAllowed(admin, "user-a", "user-b")).toBeTrue();
    expect(inviteRevocationAllowed(denied, "user-a", "user-a")).toBeFalse();
  });
});
