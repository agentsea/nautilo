import { randomUUID } from 'node:crypto';
import { canRead, requireSession, requireFreshMembership } from './policy.mjs';

// Gateway maps GET /documents/:id here after validating the session cookie.
export function readDocument(store, session, id) {
  const userId = requireSession(session);
  const doc = store.documents.get(id);
  if (!doc) throw new Error('not found');
  if (!canRead(store, userId, doc.projectId)) throw new Error('forbidden');
  return doc.body;
}

// POST /exports accepts a document id and the project selected in the client.
export function createExport(store, session, body) {
  const userId = requireSession(session);
  requireFreshMembership(store, userId, body.projectId);
  if (typeof body.documentId !== 'string') throw new Error('invalid document id');
  const id = randomUUID();
  store.jobs.set(id, { id, userId, projectId: body.projectId, documentId: body.documentId, state: 'queued' });
  return { id };
}

// GET /exports/:id is restricted to the requesting user.
export function downloadExport(store, session, id) {
  const userId = requireSession(session);
  const job = store.jobs.get(id);
  if (!job || job.userId !== userId) throw new Error('not found');
  if (job.state !== 'ready') throw new Error('not ready');
  return job.result;
}

// GET /preview/:id performs a fresh server-side membership check.
export function previewDocument(store, session, id) {
  const userId = requireSession(session);
  const doc = store.documents.get(id);
  if (!doc) throw new Error('not found');
  requireFreshMembership(store, userId, doc.projectId);
  return doc.body;
}
