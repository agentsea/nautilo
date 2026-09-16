import { requireMembership } from "../identity/membership.js";
import { documentInProject, serializeDocument } from "./repository.js";

export function preview(ctx, actor, projectId, documentId) {
  requireMembership(ctx, actor.userId, projectId, "read");
  return serializeDocument(documentInProject(ctx, projectId, documentId));
}
export function previewMany(ctx, actor, projectId, documentIds) {
  requireMembership(ctx, actor.userId, projectId, "read");
  return documentIds.map((documentId) => serializeDocument(documentInProject(ctx, projectId, documentId)));
}
