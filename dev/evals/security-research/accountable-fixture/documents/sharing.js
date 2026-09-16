import { invariant } from "../core/errors.js";
import { requireMembership } from "../identity/membership.js";
import { documentInProject, serializeDocument } from "./repository.js";

export function issueShare(ctx, actor, projectId, body) {
  requireMembership(ctx, actor.userId, projectId, "write");
  invariant(Array.isArray(body.documentIds) && body.documentIds.length > 0, 400, "documents_required", "Select documents to share");
  body.documentIds.forEach((id) => documentInProject(ctx, projectId, id));
  return { token: ctx.tokens.issue({ audience: "documents", purpose: "share_read", projectId, documentIds: [...new Set(body.documentIds)], issuedBy: actor.userId, expiresAt: body.expiresAt }) };
}
export function readShared(ctx, token, documentId) {
  const claims = ctx.tokens.verifySignature(token);
  invariant(typeof claims.projectId === "string", 403, "project_required", "Token must identify a project");
  if (Array.isArray(claims.documentIds)) invariant(claims.documentIds.includes(documentId), 403, "share_scope", "Document is not part of this share");
  return serializeDocument(documentInProject(ctx, claims.projectId, documentId));
}
