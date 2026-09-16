/**
 * Process-local invalidation for the server-authoritative command catalogue.
 * Settings mutations publish only that the catalogue changed; each consumer
 * re-reads through its own active-server and verified-viewer scope.
 */
let revision = 0;
const listeners = new Set<() => void>();

export function commandCatalogueRevision(): number {
  return revision;
}

export function subscribeCommandCatalogue(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function invalidateCommandCatalogue(): void {
  revision += 1;
  for (const listener of listeners) listener();
}
