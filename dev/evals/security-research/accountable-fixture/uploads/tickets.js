import { invariant } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";
import { cleanFilename, stagingKey } from "./paths.js";

export function createUpload(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "write");
  const filename = cleanFilename(body.filename);
  invariant(Number.isFinite(body.expiresAt) && body.expiresAt > ctx.clock.now(), 400, "invalid_expiry", "Upload expiry must be in the future");
  const ticket = ctx.store.tickets.put({ id: ctx.store.id("upload"), ownerId: actor.userId, projectId,
    filename, expiresAt: body.expiresAt, state: "open" });
  return { ticketId: ticket.id, filename, expiresAt: ticket.expiresAt };
}
export function ownedTicket(ctx, actor, ticketId) {
  const ticket = ctx.store.tickets.get(ticketId);
  invariant(ticket?.ownerId === actor.userId, 404, "upload_missing", "Upload was not found");
  invariant(ticket.state === "open" && !ctx.clock.isExpired(ticket.expiresAt), 409, "upload_closed", "Upload ticket is closed or expired");
  return ticket;
}
export function putUpload(ctx, actor, ticketId, body) {
  const ticket = ownedTicket(ctx, actor, ticketId);
  requireMembership(ctx, actor.userId, ticket.projectId, "write");
  invariant(typeof body.content === "string", 400, "invalid_content", "Upload content must be text");
  const key = stagingKey(ticket.id, ticket.filename);
  ctx.store.objects.put({ key, content: body.content, ownerId: actor.userId, projectId: ticket.projectId });
  return { stored: true, ticketId };
}
