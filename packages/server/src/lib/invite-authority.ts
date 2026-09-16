import { CAP_CREATE_INVITES, type ServerRoleSlug } from "@nautilo/trust";

const SELF_SERVICE_TARGET_ROLES = new Set<ServerRoleSlug>([
  "member",
  "contributor",
  "guest",
]);

export type InviteAuthority = Readonly<{
  canCreateOwn: boolean;
  canManageAll: boolean;
  canManageAnyRoom: boolean;
}>;

export function inviteAuthorityFromCapabilities(
  capabilities: readonly string[],
): InviteAuthority {
  return {
    canCreateOwn: capabilities.includes(CAP_CREATE_INVITES),
    canManageAll: capabilities.includes("manage_members"),
    canManageAnyRoom: capabilities.includes("manage_rooms"),
  };
}

export function inviteRoleAllowed(
  authority: InviteAuthority,
  role: ServerRoleSlug,
): boolean {
  return authority.canManageAll
    || (authority.canCreateOwn && SELF_SERVICE_TARGET_ROLES.has(role));
}

export function inviteRoomAllowed(
  authority: InviteAuthority,
  actorUserId: string,
  roomOwnerId: string | null,
): boolean {
  return authority.canManageAnyRoom || roomOwnerId === actorUserId;
}

export function inviteRevocationAllowed(
  authority: InviteAuthority,
  actorUserId: string,
  createdBy: string | null,
): boolean {
  return authority.canManageAll
    || (authority.canCreateOwn && createdBy === actorUserId);
}
