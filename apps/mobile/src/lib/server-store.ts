// D369 Phase 1 — multi-server registry.
// Split storage (SecureStore has a ~2KB/key limit): registry METADATA lives
// in AsyncStorage (one key); per-server TOKEN bundles live in SecureStore
// (one key each). See D369 §Architecture + gap review.
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as SecureStore from "expo-secure-store";

import { queuePushBindingRevokeAndClear } from "./push-binding-store";

export interface ServerRecord {
  /** Stable, key-safe id derived from the server URL (dedupes same-URL adds). */
  id: string;
  serverUrl: string;
  displayName: string;
  lastActive: number;
}

export interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  /** epoch ms when the access token expires. */
  expiresAt: number;
  /**
   * Verified only after `/whoami` during interactive sign-in.  This is not a
   * bearer credential; it lets headless push registration reject a binding
   * that belongs to a different Human on the same registered server.
   */
  userId?: string;
}

interface RegistryShape {
  servers: ServerRecord[];
  activeId: string | null;
}

const REGISTRY_KEY = "nautilo.servers.v1";
const TOKENS_KEY_PREFIX = "nautilo.tokens.";
let registryMutationTail: Promise<void> = Promise.resolve();
// Unlike storage state, this process-local fence exists to invalidate an
// already-running headless operation before a server is removed/re-added.
// SecureStore token revisions remain the durable credential fence.
const serverLifecycleRevision = new Map<string, number>();

function enqueueRegistryMutation<T>(mutation: () => Promise<T>): Promise<T> {
  const result = registryMutationTail.catch(() => {}).then(mutation);
  registryMutationTail = result.then(() => {}, () => {});
  return result;
}

function advanceServerLifecycleRevision(id: string): number {
  const next = (serverLifecycleRevision.get(id) ?? 0) + 1;
  serverLifecycleRevision.set(id, next);
  return next;
}

/**
 * Fence headless work before an explicit logout or verified account switch.
 * The registry entry and bearer remain present long enough for authenticated
 * exact-binding revocation; only stale reconciler/refresh completions lose
 * the right to commit while that cleanup is in progress.
 */
export function beginServerIdentityTransition(id: string): void {
  advanceServerLifecycleRevision(id);
  advanceTokenRevision(id);
}

// SecureStore mutations are asynchronous. Serialize them per server and fence
// refresh commits by revision so a late refresh can never overwrite a newer
// sign-in or resurrect credentials after sign-out/server removal.
const tokenMutationTail = new Map<string, Promise<void>>();
const tokenRevision = new Map<string, number>();

function currentTokenRevision(id: string): number {
  return tokenRevision.get(id) ?? 0;
}

function advanceTokenRevision(id: string): number {
  const next = currentTokenRevision(id) + 1;
  tokenRevision.set(id, next);
  return next;
}

function enqueueTokenMutation<T>(id: string, mutation: () => Promise<T>): Promise<T> {
  const prior = tokenMutationTail.get(id) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(mutation);
  const tail = result.then(() => {}, () => {});
  tokenMutationTail.set(id, tail);
  void tail.finally(() => {
    if (tokenMutationTail.get(id) === tail) tokenMutationTail.delete(id);
  });
  return result;
}

/** SecureStore keys must be [A-Za-z0-9._-]; derive a deterministic id from URL. */
export function serverIdFromUrl(serverUrl: string): string {
  const normalized = serverUrl.trim().replace(/\/+$/, "").toLowerCase();
  return "srv_" + normalized.replace(/[^a-z0-9._-]/g, "_");
}

// ---- registry metadata (AsyncStorage) ----

async function readRegistry(): Promise<RegistryShape> {
  const raw = await AsyncStorage.getItem(REGISTRY_KEY);
  if (!raw) return { servers: [], activeId: null };
  try {
    const parsed = JSON.parse(raw) as RegistryShape;
    return { servers: parsed.servers ?? [], activeId: parsed.activeId ?? null };
  } catch {
    return { servers: [], activeId: null };
  }
}

export async function loadRegistry(): Promise<RegistryShape> {
  await registryMutationTail.catch(() => {});
  return readRegistry();
}

async function saveRegistry(reg: RegistryShape): Promise<void> {
  await AsyncStorage.setItem(REGISTRY_KEY, JSON.stringify(reg));
}

export async function upsertServer(input: {
  serverUrl: string;
  displayName: string;
}): Promise<ServerRecord> {
  return enqueueRegistryMutation(async () => {
    const reg = await readRegistry();
    const id = serverIdFromUrl(input.serverUrl);
    const record: ServerRecord = {
      id,
      serverUrl: input.serverUrl.replace(/\/+$/, ""),
      displayName: input.displayName,
      lastActive: Date.now(),
    };
    const others = reg.servers.filter((s) => s.id !== id);
    advanceServerLifecycleRevision(id);
    await saveRegistry({ servers: [...others, record], activeId: id });
    return record;
  });
}

export async function removeServer(id: string): Promise<void> {
  await enqueueRegistryMutation(async () => {
    const reg = await readRegistry();
    const record = reg.servers.find((server) => server.id === id);
    if (!record) return;
    // Invalidate an already-running reconciler before it obtains/uses a
    // refresh token. Its later binding acknowledgement will then be rejected.
    advanceServerLifecycleRevision(id);
    // Durable proof-only cleanup has to exist before we make this server
    // unreachable from the ordinary registry or erase its bearer credentials.
    // The tombstone function writes SecureStore first and rejects on failure,
    // so a failed local write leaves this server fully intact for a retry.
    await queuePushBindingRevokeAndClear({
      serverId: id,
      serverUrl: record.serverUrl,
    });
    const servers = reg.servers.filter((s) => s.id !== id);
    const activeId = reg.activeId === id ? (servers[0]?.id ?? null) : reg.activeId;
    await saveRegistry({ servers, activeId });
    // Fence a refresh while the registry mutation remains serialized. Any
    // already-running refresh carries the old token revision and cannot
    // repopulate SecureStore after this clear.
    await clearTokens(id);
  });
}

export interface ServerRegistrationSnapshot {
  readonly server: ServerRecord;
  readonly lifecycleRevision: number;
}

/**
 * Snapshot one currently registered server with a process-local lifecycle
 * revision. Headless workers use this only as a race fence; the stored
 * registry remains the cross-restart source of truth.
 */
export async function loadServerRegistrationSnapshot(
  id: string,
): Promise<ServerRegistrationSnapshot | null> {
  await registryMutationTail.catch(() => {});
  const server = (await readRegistry()).servers.find((candidate) => candidate.id === id);
  if (!server) return null;
  return { server, lifecycleRevision: serverLifecycleRevision.get(id) ?? 0 };
}

/** Reject late work after remove/re-add without consulting the active server. */
export async function isServerRegistrationCurrent(
  snapshot: ServerRegistrationSnapshot,
): Promise<boolean> {
  await registryMutationTail.catch(() => {});
  const current = (await readRegistry()).servers.find((candidate) => candidate.id === snapshot.server.id);
  return current?.serverUrl === snapshot.server.serverUrl
    && (serverLifecycleRevision.get(snapshot.server.id) ?? 0) === snapshot.lifecycleRevision;
}

export async function setActiveServer(id: string): Promise<void> {
  await enqueueRegistryMutation(async () => {
    const reg = await readRegistry();
    if (!reg.servers.some((s) => s.id === id)) return;
    const servers = reg.servers.map((s) =>
      s.id === id ? { ...s, lastActive: Date.now() } : s,
    );
    await saveRegistry({ servers, activeId: id });
  });
}

// ---- token bundles (SecureStore, per server) ----

export async function saveTokens(id: string, tokens: TokenBundle): Promise<void> {
  advanceTokenRevision(id);
  await enqueueTokenMutation(id, () =>
    SecureStore.setItemAsync(TOKENS_KEY_PREFIX + id, JSON.stringify(tokens)),
  );
}

export async function loadTokens(id: string): Promise<TokenBundle | null> {
  return (await loadTokenSnapshot(id)).tokens;
}

export interface TokenSnapshot {
  tokens: TokenBundle | null;
  revision: number;
}

/** Read credentials and their in-process mutation revision consistently. */
export async function loadTokenSnapshot(id: string): Promise<TokenSnapshot> {
  for (;;) {
    await tokenMutationTail.get(id)?.catch(() => {});
    const revision = currentTokenRevision(id);
    const raw = await SecureStore.getItemAsync(TOKENS_KEY_PREFIX + id);
    if (revision !== currentTokenRevision(id)) continue;
    if (!raw) return { tokens: null, revision };
    try {
      return { tokens: JSON.parse(raw) as TokenBundle, revision };
    } catch {
      return { tokens: null, revision };
    }
  }
}

export async function clearTokens(id: string): Promise<void> {
  advanceTokenRevision(id);
  await enqueueTokenMutation(id, () => SecureStore.deleteItemAsync(TOKENS_KEY_PREFIX + id));
}

/** Commit a refresh only if no newer sign-in/sign-out/removal has started. */
export async function saveTokensIfRevision(
  id: string,
  tokens: TokenBundle,
  expectedRevision: number,
): Promise<boolean> {
  return enqueueTokenMutation(id, async () => {
    if (currentTokenRevision(id) !== expectedRevision) return false;
    const committedRevision = advanceTokenRevision(id);
    await SecureStore.setItemAsync(TOKENS_KEY_PREFIX + id, JSON.stringify(tokens));
    return currentTokenRevision(id) === committedRevision;
  });
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

/**
 * Create the ownership confirmation used between authenticated `/whoami` and
 * publishing a verified Mobile viewer. The injectable form makes the
 * compare-and-swap loser/reload branch executable without a timing-based
 * SecureStore test.
 */
export function createVerifiedTokenOwnerConfirmer(
  deps: VerifiedTokenOwnerConfirmerDeps,
): VerifiedTokenOwnerConfirmer {
  return {
    async confirm(id, accessToken, userId) {
      const snapshot = await deps.loadSnapshot(id);
      if (!snapshot.tokens || snapshot.tokens.accessToken !== accessToken) return false;
      if (snapshot.tokens.userId === userId) return true;

      const committed = await deps.saveIfRevision(
        id,
        { ...snapshot.tokens, userId },
        snapshot.revision,
      );
      if (committed) return true;

      const latest = await deps.loadSnapshot(id);
      return latest.tokens?.accessToken === accessToken && latest.tokens.userId === userId;
    },
  };
}

const defaultVerifiedTokenOwnerConfirmer = createVerifiedTokenOwnerConfirmer({
  loadSnapshot: loadTokenSnapshot,
  saveIfRevision: saveTokensIfRevision,
});

/**
 * Persist the verified Human that owns the currently latched bearer.
 *
 * The return value is intentionally a confirmation, rather than merely the
 * result of one compare-and-swap: another refresh may win the storage race.
 * In that case, callers may expose a verified identity only if the durable
 * replacement still pairs this exact bearer with this exact Human. This keeps
 * headless push reconciliation from observing an ownerless or cross-account
 * token bundle after the UI says the session is verified.
 */
export const confirmVerifiedTokenOwner = defaultVerifiedTokenOwnerConfirmer.confirm.bind(
  defaultVerifiedTokenOwnerConfirmer,
);

/** Clear a failed refresh only if it still belongs to the current session. */
export async function clearTokensIfRevision(
  id: string,
  expectedRevision: number,
): Promise<boolean> {
  return enqueueTokenMutation(id, async () => {
    if (currentTokenRevision(id) !== expectedRevision) return false;
    advanceTokenRevision(id);
    await SecureStore.deleteItemAsync(TOKENS_KEY_PREFIX + id);
    return true;
  });
}
