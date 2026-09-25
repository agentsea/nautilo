import { createHash } from "node:crypto";
import type { ModerationAction, ModerationCommand, ModerationFailureCode } from "@nautilo/types";

export class ModerationError extends Error {
  override readonly name = "ModerationError";
  constructor(readonly code: ModerationFailureCode) { super(code); }
}

export interface ModerationGroupGrant {
  readonly groupId: string;
  readonly capabilities: readonly string[];
  readonly roomIds: readonly string[];
}

export interface ModerationAuthority {
  readonly userId: string;
  readonly owner: boolean;
  readonly disabled: boolean;
  readonly grants: readonly ModerationGroupGrant[];
}

export const MODERATION_PERMISSIONS = ["timeout", "kick", "ban", "view"] as const;
export type ModerationPermission = (typeof MODERATION_PERMISSIONS)[number];

export function moderationCapability(permission: ModerationPermission, scope: "server" | "room"): string {
  return permission === "view" ? `view_${scope}_moderation` : `${permission}_${scope}_members`;
}

export function holdsModerationPermission(authority: ModerationAuthority, permission: ModerationPermission, roomId: string | null): boolean {
  if (authority.disabled) return false;
  return authority.grants.some((group) =>
    group.capabilities.includes(moderationCapability(permission, "server"))
    || (roomId !== null && group.roomIds.includes(roomId)
      && group.capabilities.includes(moderationCapability(permission, "room"))),
  );
}

export function permissionForModerationAction(action: Exclude<ModerationAction, "lift">): ModerationPermission {
  return action === "mute" || action === "timeout" ? "timeout" : action;
}

/** Protect peers/incomparable authority; a role label is never a rank. */
export function assertModerationTarget(input: {
  caller: ModerationAuthority; target: ModerationAuthority; roomId: string | null;
  permission: ModerationPermission; removesAccess: boolean; targetOwnsRoom: boolean;
}): void {
  const { caller, target, roomId, permission } = input;
  if (!holdsModerationPermission(caller, permission, roomId)) throw new ModerationError("forbidden_scope");
  if (caller.userId === target.userId || target.owner || (input.removesAccess && input.targetOwnsRoom)) {
    throw new ModerationError("protected_target");
  }
  if (caller.owner) return;
  // A disabled target retains their authority for hierarchy comparisons.
  const targetAuthority = { ...target, disabled: false };
  const actorSet = MODERATION_PERMISSIONS.filter((p) => holdsModerationPermission(caller, p, roomId));
  const targetSet = MODERATION_PERMISSIONS.filter((p) => holdsModerationPermission(targetAuthority, p, roomId));
  if (targetSet.some((p) => !actorSet.includes(p)) || actorSet.length <= targetSet.length) {
    throw new ModerationError("protected_target");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function normalizeModerationCommand(raw: unknown): ModerationCommand {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new ModerationError("invalid_request");
  const value = raw as Record<string, unknown>;
  const id = (key: string): string => {
    const v = value[key];
    if (typeof v !== "string" || !UUID.test(v)) throw new ModerationError("invalid_request");
    return v.toLowerCase();
  };
  const reason = typeof value["reason"] === "string" ? value["reason"].trim() : "";
  if (!reason || typeof value["targetRevision"] !== "string" || !/^[0-9a-f]{64}$/.test(value["targetRevision"])) throw new ModerationError("invalid_request");
  if (value["privateNote"] !== undefined && value["privateNote"] !== null && typeof value["privateNote"] !== "string") throw new ModerationError("invalid_request");
  if (!["ban", "kick", "timeout", "mute", "lift"].includes(String(value["action"]))) throw new ModerationError("invalid_request");
  const action = value["action"] as ModerationAction;
  if (value["deleteCommunityMessages"] !== undefined && typeof value["deleteCommunityMessages"] !== "boolean") throw new ModerationError("invalid_request");
  if (value["deleteCommunityMessages"] === true && (action !== "ban" || value["roomId"] !== null)) throw new ModerationError("invalid_request");
  let expiresAt: string | null = null;
  if (value["expiresAt"] !== null && value["expiresAt"] !== undefined) {
    if (typeof value["expiresAt"] !== "string" || !Number.isFinite(Date.parse(value["expiresAt"]))) throw new ModerationError("invalid_request");
    expiresAt = new Date(value["expiresAt"]).toISOString();
  }
  if ((action === "timeout" && expiresAt === null) || (!["ban", "timeout"].includes(action) && expiresAt !== null)) throw new ModerationError("invalid_request");
  let restrictionId: string | null = null;
  let restrictionRevision: number | null = null;
  if (action === "lift") {
    restrictionId = id("restrictionId");
    if (!Number.isSafeInteger(value["restrictionRevision"]) || Number(value["restrictionRevision"]) < 1) throw new ModerationError("invalid_request");
    restrictionRevision = Number(value["restrictionRevision"]);
  } else if (value["restrictionId"] != null || value["restrictionRevision"] != null) throw new ModerationError("invalid_request");
  return Object.freeze({
    operationId: id("operationId"), targetUserId: id("targetUserId"), roomId: value["roomId"] === null ? null : id("roomId"),
    action, reason, privateNote: typeof value["privateNote"] === "string" ? value["privateNote"].trim() || null : null,
    expiresAt, targetRevision: value["targetRevision"], restrictionId, restrictionRevision,
    ...(value["deleteCommunityMessages"] === true ? { deleteCommunityMessages: true } : {}),
  });
}

export function moderationRequestDigest(command: ModerationCommand): string {
  return createHash("sha256").update(JSON.stringify(command)).digest("hex");
}

/** Only pass an issuer/subject pair authenticated by the identity owner. */
export function moderationIdentityDigest(issuer: string, subject: string): string {
  if (!issuer || !subject) throw new ModerationError("unsupported_identity");
  return createHash("sha256").update(JSON.stringify([issuer, subject])).digest("hex");
}
