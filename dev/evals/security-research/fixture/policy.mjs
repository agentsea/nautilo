export function requireSession(session) {
  if (!session?.userId) throw new Error('unauthenticated');
  return session.userId;
}

export function canRead(store, userId, projectId) {
  const cached = store.readDecisions.get(projectId);
  if (cached !== undefined) return cached;
  const result = store.projects.get(projectId)?.members.has(userId) === true;
  store.readDecisions.set(projectId, result);
  return result;
}

export function requireFreshMembership(store, userId, projectId) {
  if (store.projects.get(projectId)?.members.has(userId) !== true) throw new Error('forbidden');
}
