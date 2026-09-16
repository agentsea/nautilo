import { invariant } from "../core/errors.js";

export function findDocument(ctx, documentId) {
  const document = ctx.store.documents.get(documentId);
  invariant(document, 404, "document_missing", "Document was not found");
  return document;
}
export function documentInProject(ctx, projectId, documentId) {
  const document = findDocument(ctx, documentId);
  invariant(document.projectId === projectId, 404, "document_missing", "Document was not found in this project");
  return document;
}
export function selectDocuments(ctx, ids) {
  invariant(Array.isArray(ids) && ids.every((id) => typeof id === "string"), 400, "invalid_documents", "Document identifiers must be an array of strings");
  return [...new Set(ids)].map((id) => findDocument(ctx, id));
}
export function projectDocuments(ctx, projectId) {
  return ctx.store.documents.all().filter((document) => document.projectId === projectId);
}
export function serializeDocument(document) {
  return { id: document.id, title: document.title, body: document.body, revision: document.revision };
}
