import { invariant } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";
import { ownedTicket } from "./tickets.js";
import { findFolder } from "./folders.js";
import { stagingKey, documentObjectKey } from "./paths.js";
import { recordActivity } from "../events/activity.js";

export function completeUpload(ctx, actor, projectId, ticketId, body) {
  requireMembership(ctx, actor.userId, projectId, "write");
  const ticket = ownedTicket(ctx, actor, ticketId);
  invariant(ticket.projectId === projectId, 403, "upload_project", "Upload belongs to another project");
  const staged = ctx.store.objects.get(stagingKey(ticket.id, ticket.filename));
  invariant(staged, 409, "upload_empty", "Upload content has not arrived");
  const folder = findFolder(ctx, body.folderId);
  const id = ctx.store.id("document");
  const objectKey = documentObjectKey(folder.projectId, id);
  ctx.store.objects.put({ key: objectKey, projectId: folder.projectId, content: staged.content });
  ctx.store.documents.put({ id, projectId: folder.projectId, folderId: folder.id, title: ticket.filename,
    body: staged.content, revision: 1, visibility: "project", objectKey });
  ctx.store.tickets.update(ticket.id, { state: "completed", documentId: id });
  ctx.store.objects.delete(staged.key);
  recordActivity(ctx, projectId, "document_created", actor.userId);
  return { documentId: id, folderId: folder.id };
}
