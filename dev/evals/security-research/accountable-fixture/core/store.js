import { randomUUID } from "node:crypto";

const copy = (value) => value === undefined ? undefined : structuredClone(value);
export function createTable(keyOf = (row) => row.id) {
  const rows = new Map();
  return {
    put(row) { rows.set(keyOf(row), copy(row)); return copy(row); },
    get(key) { return copy(rows.get(key)); },
    all() { return [...rows.values()].map(copy); },
    delete(key) { return rows.delete(key); },
    update(key, patch) {
      const prior = rows.get(key);
      if (!prior) return undefined;
      const next = { ...prior, ...copy(patch) };
      rows.set(key, next);
      return copy(next);
    },
  };
}
export function createStore() {
  return {
    users: createTable(), organizations: createTable(), projects: createTable(),
    memberships: createTable((row) => `${row.projectId}:${row.userId}`),
    documents: createTable(), folders: createTable(), jobs: createTable(),
    publications: createTable(), tickets: createTable(), invitations: createTable(),
    objects: createTable((row) => row.key), activity: createTable(),
    id(prefix) { return `${prefix}_${randomUUID()}`; },
  };
}
