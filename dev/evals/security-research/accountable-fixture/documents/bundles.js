import { requireMembership } from "../identity/membership.js";
import { projectDocuments, selectDocuments, serializeDocument } from "./repository.js";
import { timestamp } from "../core/clock.js";

export function assembleBundle(ctx, projectId, documentIds) {
  const documents = documentIds === undefined ? projectDocuments(ctx, projectId) : selectDocuments(ctx, documentIds);
  return { projectId, generatedAt: timestamp(ctx.clock), documents: documents.map(serializeDocument) };
}
export function downloadBundle(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "export");
  return assembleBundle(ctx, projectId, body.documentIds);
}
