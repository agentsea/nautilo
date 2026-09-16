import { invariant } from "../core/errors.js";
import { requireMembership } from "./membership.js";
import { invitationRole } from "./roles.js";

export function createInvitation(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "invite");
  const role = invitationRole(body.role);
  const recipient = ctx.store.users.get(body.userId);
  invariant(recipient?.active, 404, "recipient_missing", "Recipient was not found");
  const invitation = ctx.store.invitations.put({ id: ctx.store.id("invitation"), projectId, userId: recipient.id, role, state: "pending" });
  const token = ctx.tokens.issue({ audience: "membership", purpose: "invitation", invitationId: invitation.id, projectId, userId: recipient.id, expiresAt: body.expiresAt });
  return { invitationId: invitation.id, token };
}
export function redeemInvitation(ctx, actor, token) {
  const claims = ctx.tokens.verify(token, { audience: "membership", purpose: "invitation" });
  invariant(claims.userId === actor.userId, 403, "recipient_mismatch", "Invitation belongs to another person");
  const invitation = ctx.store.invitations.get(claims.invitationId);
  invariant(invitation?.state === "pending", 409, "invitation_used", "Invitation is no longer pending");
  invariant(invitation.projectId === claims.projectId, 403, "project_mismatch", "Invitation project does not match");
  ctx.store.memberships.put({ projectId: invitation.projectId, userId: actor.userId, role: invitation.role, state: "active", revision: 1 });
  ctx.store.invitations.update(invitation.id, { state: "accepted" });
  return { accepted: true, projectId: invitation.projectId };
}
