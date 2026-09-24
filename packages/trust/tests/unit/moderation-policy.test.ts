import { describe, expect, test } from "bun:test";
import { assertModerationTarget, holdsModerationPermission, moderationIdentityDigest, moderationRequestDigest,
  normalizeModerationCommand, type ModerationAuthority } from "../../src/moderation-policy";

const actorId = "10000000-0000-4000-8000-000000000001";
const targetId = "10000000-0000-4000-8000-000000000002";
const roomId = "20000000-0000-4000-8000-000000000001";
const otherRoomId = "20000000-0000-4000-8000-000000000002";
const operationId = "30000000-0000-4000-8000-000000000001";
const revision = "a".repeat(64);
const authority = (userId: string, caps: string[], roomIds: string[] = []): ModerationAuthority => ({
  userId, owner: false, disabled: false, grants: [{ groupId: "staff", capabilities: caps, roomIds }],
});
const target = authority(targetId, []);
const moderator = authority(actorId, ["ban_room_members"], [roomId]);
const command = { operationId, targetUserId: targetId, roomId, action: "ban", reason: "Repeated unwanted messages",
  targetRevision: revision, expiresAt: null, privateNote: null, restrictionId: null, restrictionRevision: null };

describe("moderation delegation and target protection", () => {
  test("Room capability and scope must originate in the same Group", () => {
    expect(holdsModerationPermission(moderator, "ban", roomId)).toBe(true);
    const split: ModerationAuthority = { ...moderator, grants: [
      { groupId: "cap", capabilities: ["ban_room_members"], roomIds: [] },
      { groupId: "scope", capabilities: [], roomIds: [roomId] },
    ] };
    expect(holdsModerationPermission(split, "ban", roomId)).toBe(false);
    expect(holdsModerationPermission(moderator, "ban", otherRoomId)).toBe(false);
    expect(holdsModerationPermission(moderator, "ban", null)).toBe(false);
  });
  test("ordinary admin and Room management are not implicit moderation grants", () => {
    for (const cap of ["manage_members", "manage_rooms", "moderate_content_reports", "view_audit_log"]) {
      expect(holdsModerationPermission(authority(actorId, [cap], [roomId]), "ban", roomId)).toBe(false);
    }
    expect(holdsModerationPermission(authority(actorId, ["ban_server_members"]), "ban", roomId)).toBe(true);
  });
  test("self, Server Owner and Room-owner removal remain protected", () => {
    const caller = { ...authority(actorId, ["ban_server_members"]), owner: true };
    for (const [victim, targetOwnsRoom] of [[caller, false], [{ ...target, owner: true }, false], [target, true]] as const) {
      expect(() => assertModerationTarget({ caller, target: victim, roomId, permission: "ban", removesAccess: true, targetOwnsRoom })).toThrow("protected_target");
    }
  });
  test("equal and incomparable authority cannot be moderated; owner can act on an Admin", () => {
    const check = (caller: ModerationAuthority, victim: ModerationAuthority) => assertModerationTarget({
      caller, target: victim, roomId, permission: "ban", removesAccess: true, targetOwnsRoom: false,
    });
    check(moderator, target);
    expect(() => check(moderator, authority(targetId, ["ban_room_members"], [roomId]))).toThrow("protected_target");
    expect(() => check(moderator, authority(targetId, ["kick_room_members"], [roomId]))).toThrow("protected_target");
    expect(() => check(moderator, { ...authority(targetId, ["ban_room_members"], [roomId]), disabled: true })).toThrow("protected_target");
    check({ ...moderator, owner: true }, authority(targetId, ["ban_server_members", "kick_server_members"]));
    expect(() => check({ ...moderator, disabled: true }, target)).toThrow("forbidden_scope");
  });
});

describe("exact moderation request identity", () => {
  test("normalizes property order and whitespace but binds every semantic field", () => {
    const normalized = normalizeModerationCommand(command);
    const reordered = normalizeModerationCommand({ ...Object.fromEntries(Object.entries(command).reverse()), reason: ` ${command.reason} ` });
    expect(moderationRequestDigest(normalized)).toBe(moderationRequestDigest(reordered));
    for (const patch of [{ roomId: null }, { action: "kick" }, { targetUserId: actorId },
      { privateNote: "Private evidence" }, { reason: "Different reason" }, { targetRevision: "b".repeat(64) },
      { expiresAt: "2030-01-01T00:00:00Z" }]) {
      expect(moderationRequestDigest(normalizeModerationCommand({ ...command, ...patch }))).not.toBe(moderationRequestDigest(normalized));
    }
  });
  test("rejects ambiguous action/scope, empty reasons and inconsistent duration/revision", () => {
    for (const patch of [{ roomId: undefined }, { roomId: "general" }, { reason: " " }, { action: "disable" },
      { action: "timeout" }, { action: "mute", expiresAt: "2030-01-01T00:00:00Z" },
      { expiresAt: "invalid" }, { action: "lift" }, { privateNote: {} }, { targetRevision: "old" },
      { restrictionId: operationId }, { action: "lift", restrictionId: operationId, restrictionRevision: 0 }]) {
      expect(() => normalizeModerationCommand({ ...command, ...patch })).toThrow("invalid_request");
    }
  });
  test("expired timestamps remain parseable for exact historical replay", () => {
    const historical = normalizeModerationCommand({ ...command, expiresAt: "2000-01-01T00:00:00Z" });
    expect(historical.expiresAt).toBe("2000-01-01T00:00:00.000Z");
    expect(normalizeModerationCommand({ ...command, action: "lift", restrictionId: operationId, restrictionRevision: 2 }).restrictionRevision).toBe(2);
  });
  test("identity matching separates issuers and does not concatenate ambiguous strings", () => {
    expect(moderationIdentityDigest("https://identity.example", "subject")).not.toBe(moderationIdentityDigest("https://other.example", "subject"));
    expect(moderationIdentityDigest("ab", "c")).not.toBe(moderationIdentityDigest("a", "bc"));
    expect(() => moderationIdentityDigest("", "subject")).toThrow("unsupported_identity");
  });
});
