import {
  browserLocalStorage,
  createBrowserScopedStore,
  type BrowserScopedStore,
} from "@/platform/browser-storage.web";
import { currentServingOrigin } from "./browser-entry.web";

export interface ServerRecord {
  id: string;
  serverUrl: string;
  displayName: string;
  lastActive: number;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  userId?: string;
}

interface RegistryShape {
  servers: ServerRecord[];
  activeId: string | null;
}

export interface ServerRegistrationSnapshot {
  readonly server: ServerRecord;
  readonly lifecycleRevision: number;
}

export interface TokenSnapshot {
  tokens: TokenBundle | null;
  revision: number;
}

let registryStore: BrowserScopedStore<RegistryShape> | null | undefined;

export function serverIdFromUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/+$/, "").toLowerCase();
  return "srv_" + normalized.replace(/[^a-z0-9._-]/g, "_");
}

function currentOrigin(): string | null {
  return typeof location === "undefined" ? null : currentServingOrigin(location);
}

function isServerRecord(value: unknown): value is ServerRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ServerRecord>;
  return typeof record.id === "string"
    && typeof record.serverUrl === "string"
    && typeof record.displayName === "string"
    && typeof record.lastActive === "number"
    && Number.isFinite(record.lastActive);
}

function isRegistry(value: unknown): value is RegistryShape {
  if (!value || typeof value !== "object") return false;
  const registry = value as Partial<RegistryShape>;
  return Array.isArray(registry.servers)
    && registry.servers.every(isServerRecord)
    && (registry.activeId === null || typeof registry.activeId === "string");
}

function getRegistryStore(): BrowserScopedStore<RegistryShape> | null {
  if (registryStore !== undefined) return registryStore;
  const origin = currentOrigin();
  registryStore = origin
    ? createBrowserScopedStore({
        namespace: "server-registry",
        scope: { origin, humanId: null },
        storage: browserLocalStorage(),
        validate: isRegistry,
      })
    : null;
  return registryStore;
}

function exactCurrentOriginRecord(record: ServerRecord): boolean {
  const origin = currentOrigin();
  if (!origin) return false;
  return record.serverUrl === origin && record.id === serverIdFromUrl(origin);
}

async function mutateRegistry(
  mutation: (current: RegistryShape) => RegistryShape,
): Promise<RegistryShape> {
  const store = getRegistryStore();
  if (!store) return { servers: [], activeId: null };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const snapshot = await store.read();
    const current = snapshot.value ?? { servers: [], activeId: null };
    const next = mutation(current);
    if (await store.replace(next, snapshot.revision)) return next;
  }
  return { servers: [], activeId: null };
}

export async function loadRegistry(): Promise<RegistryShape> {
  const snapshot = await getRegistryStore()?.read();
  if (!snapshot?.value) return { servers: [], activeId: null };
  const servers = snapshot.value.servers.filter(exactCurrentOriginRecord);
  const activeId = servers.some((server) => server.id === snapshot.value!.activeId)
    ? snapshot.value.activeId
    : null;
  return { servers, activeId };
}

export async function upsertServer(input: {
  serverUrl: string;
  displayName: string;
}): Promise<ServerRecord> {
  const origin = currentOrigin();
  let candidate: URL;
  try {
    candidate = new URL(input.serverUrl);
  } catch {
    throw new Error("Mobile Web can register only its current serving origin.");
  }
  if (
    !origin
    || candidate.origin !== origin
    || candidate.username
    || candidate.password
    || candidate.pathname !== "/"
    || candidate.search
    || candidate.hash
  ) {
    throw new Error("Mobile Web can register only its current serving origin.");
  }
  const record: ServerRecord = {
    id: serverIdFromUrl(origin),
    serverUrl: origin,
    displayName: input.displayName,
    lastActive: Date.now(),
  };
  await mutateRegistry(() => ({ servers: [record], activeId: record.id }));
  return record;
}

export async function setActiveServer(id: string): Promise<void> {
  await mutateRegistry((current) => {
    const record = current.servers.find((server) => server.id === id && exactCurrentOriginRecord(server));
    if (!record) return current;
    const next = { ...record, lastActive: Date.now() };
    return { servers: [next], activeId: next.id };
  });
}

export async function removeServer(id: string): Promise<void> {
  await mutateRegistry((current) => current.servers.some((server) => server.id === id)
    ? { servers: [], activeId: null }
    : current);
}

export async function loadServerRegistrationSnapshot(
  id: string,
): Promise<ServerRegistrationSnapshot | null> {
  const server = (await loadRegistry()).servers.find((candidate) => candidate.id === id);
  return server ? { server, lifecycleRevision: 0 } : null;
}

export async function isServerRegistrationCurrent(
  snapshot: ServerRegistrationSnapshot,
): Promise<boolean> {
  const current = await loadServerRegistrationSnapshot(snapshot.server.id);
  return current?.server.serverUrl === snapshot.server.serverUrl;
}

// Task 1.3 owns browser OIDC/session custody. These fail-closed exports keep
// shared callers type-compatible without presenting localStorage as SecureStore.
export function beginServerIdentityTransition(_id: string): void {}
export function loadTokens(_id: string): Promise<TokenBundle | null> { return Promise.resolve(null); }
export function loadTokenSnapshot(_id: string): Promise<TokenSnapshot> {
  return Promise.resolve({ tokens: null, revision: 0 });
}
export function clearTokens(_id: string): Promise<void> { return Promise.resolve(); }
export function clearTokensIfRevision(_id: string, _revision: number): Promise<boolean> {
  return Promise.resolve(false);
}
export function saveTokens(_id: string, _tokens: TokenBundle): Promise<void> {
  return Promise.reject(new Error("Browser session custody is unavailable until Task 1.3."));
}
export function saveTokensIfRevision(
  _id: string,
  _tokens: TokenBundle,
  _revision: number,
): Promise<boolean> {
  return Promise.resolve(false);
}

export interface VerifiedTokenOwnerConfirmerDeps {
  readonly loadSnapshot: (id: string) => Promise<TokenSnapshot>;
  readonly saveIfRevision: (
    id: string,
    tokens: TokenBundle,
    expectedRevision: number,
  ) => Promise<boolean>;
}

export interface VerifiedTokenOwnerConfirmer {
  confirm(id: string, accessToken: string, userId: string): Promise<boolean>;
}

export function createVerifiedTokenOwnerConfirmer(
  _deps: VerifiedTokenOwnerConfirmerDeps,
): VerifiedTokenOwnerConfirmer {
  return { confirm: () => Promise.resolve(false) };
}

export function confirmVerifiedTokenOwner(
  _id: string,
  _accessToken: string,
  _userId: string,
): Promise<boolean> {
  return Promise.resolve(false);
}
