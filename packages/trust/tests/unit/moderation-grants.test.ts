import { describe, expect, test } from "bun:test";
import { computeFingerprint, evaluateOperation, type AccessControlOperation, type EngineGroupRow, type EngineState } from "../../src/rbac-mutation-engine";

const callerId = "caller";
const roomId = "room-a";
const group = (id: string, roomIds: string[], members: string[], caps = ["ban_room_members"]): EngineGroupRow => ({
  id, type: `custom:${id}`, label: id, ownerId: callerId, isSystem: false,
  roleSlugs: ["room-moderator"], capabilities: caps, moderationRoomIds: roomIds,
  members, memberCount: members.length, approvalChallengeCount: 0,
});
const state: EngineState = {
  knownCapabilities: ["manage_groups", "manage_members", "manage_roles", "ban_room_members", "ban_server_members"],
  roles: [{ id: "role", slug: "room-moderator", label: "Moderator", isSystem: false, capabilities: ["ban_room_members"] }],
  groups: [group("authority", [roomId], [callerId]), group("delegated", [roomId], ["member"])],
};
const evaluate = (operation: AccessControlOperation, snapshot = state) => evaluateOperation({
  operation, state: snapshot, actorUserId: callerId, moderationRoomsExist: true,
  actorCapabilities: ["manage_groups", "manage_members", "manage_roles", "ban_room_members"],
  actorHoldsManagement: true, actorHeldManagementCaps: ["manage_groups", "manage_members", "manage_roles"], targetUserExists: true,
});

describe("moderation scope through existing RBAC preview/apply", () => {
  test("scope changes require current scope authority and changing the scope changes the fingerprint", () => {
    expect(evaluate({ kind: "group.set_moderation_scopes", groupId: "delegated", roomIds: [roomId] }).ok).toBe(true);
    expect(evaluate({ kind: "group.set_moderation_scopes", groupId: "delegated", roomIds: ["room-b"] }).failures.some(f => f.code === "insufficient_moderation_scope")).toBe(true);
    expect(computeFingerprint(state)).not.toBe(computeFingerprint({ ...state, groups: state.groups.map(g => g.id === "delegated" ? { ...g, moderationRoomIds: ["room-b"] } : g) }));
  });
  test("membership changes cannot delegate or remove a foreign Room moderator", () => {
    const foreign = { ...state, groups: [state.groups[0]!, group("delegated", ["room-b"], ["member"])] };
    for (const kind of ["membership.add", "membership.remove"] as const) {
      expect(evaluate({ kind, groupId: "delegated", userId: "member" }, foreign).failures.some(f => f.code === "insufficient_moderation_scope")).toBe(true);
    }
  });
  test("editing a shared Role cannot inject a Room capability into a pre-scoped foreign Group", () => {
    const empty = { ...state, roles: [{ ...state.roles[0]!, capabilities: [] }], groups: [state.groups[0]!, group("delegated", ["room-b"], ["member"], [])] };
    expect(evaluate({ kind: "role.set_capabilities", roleId: "role", capabilities: ["ban_room_members"] }, empty).failures.some(f => f.code === "insufficient_moderation_scope")).toBe(true);
  });
  test("a server-wide action grant covers the delegated Room without joining it", () => {
    const server = { ...state, groups: [group("authority", [], [callerId], ["ban_server_members"]), state.groups[1]!] };
    expect(evaluate({ kind: "group.set_moderation_scopes", groupId: "delegated", roomIds: ["room-b"] }, server).ok).toBe(true);
  });
});
