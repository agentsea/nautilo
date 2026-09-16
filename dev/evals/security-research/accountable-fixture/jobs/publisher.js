import { invariant, requiredString } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";
import { documentInProject } from "../documents/repository.js";
import { recordActivity } from "../events/activity.js";

export function requestPublication(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "write");
  documentInProject(ctx, projectId, body.documentId);
  const publication = ctx.store.publications.put({ id: ctx.store.id("publication"), ownerId: actor.userId,
    projectId, documentId: body.documentId, title: requiredString(body.title, "title"), state: "queued" });
  return { publicationId: publication.id };
}
export function runPublication(ctx, publicationId) {
  const publication = ctx.store.publications.get(publicationId);
  invariant(publication, 404, "publication_missing", "Publication was not found");
  if (publication.state !== "queued") return { state: publication.state };
  try {
    requireMembership(ctx, publication.ownerId, publication.projectId, "write");
    const document = documentInProject(ctx, publication.projectId, publication.documentId);
    ctx.store.documents.update(document.id, { title: publication.title, revision: document.revision + 1 });
    ctx.store.publications.update(publication.id, { state: "completed" });
    recordActivity(ctx, publication.projectId, "document_updated", publication.ownerId);
    return { state: "completed" };
  } catch (error) {
    ctx.store.publications.update(publication.id, { state: "failed", errorCode: error.code ?? "publication_failed" });
    return { state: "failed" };
  }
}
