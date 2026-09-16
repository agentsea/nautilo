import AsyncStorage from "@react-native-async-storage/async-storage";

import { isCapabilitySlug, type CapabilitySlug } from "@nautilo/types";

const CACHE_KEY_PREFIX = "nautilo.viewer.v1.";
const viewerMutationTail = new Map<string, Promise<void>>();

function enqueueViewerMutation(serverId: string, mutation: () => Promise<void>): Promise<void> {
  const prior = viewerMutationTail.get(serverId) ?? Promise.resolve();
  const result = prior.catch(() => {}).then(mutation);
  const tail = result.catch(() => {});
  viewerMutationTail.set(serverId, tail);
  void tail.finally(() => {
    if (viewerMutationTail.get(serverId) === tail) viewerMutationTail.delete(serverId);
  });
  return result;
}

export interface CachedViewer {
  userId: string;
  actorId: string;
  handle?: string;
  displayName?: string;
  capabilities: CapabilitySlug[];
}

interface StoredViewer extends CachedViewer {
  v: 1;
}

function cacheKey(serverId: string): string {
  return `${CACHE_KEY_PREFIX}${serverId}`;
}

function parseCachedViewer(raw: string | null): CachedViewer | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return null;
    const candidate = value as Partial<StoredViewer>;
    if (
      candidate.v !== 1 ||
      typeof candidate.userId !== "string" ||
      candidate.userId.length === 0 ||
      typeof candidate.actorId !== "string" ||
      candidate.actorId.length === 0 ||
      (candidate.handle !== undefined && typeof candidate.handle !== "string") ||
      (candidate.displayName !== undefined && typeof candidate.displayName !== "string") ||
      !Array.isArray(candidate.capabilities)
    ) {
      return null;
    }
    return {
      userId: candidate.userId,
      actorId: candidate.actorId,
      ...(candidate.handle ? { handle: candidate.handle } : {}),
      ...(candidate.displayName ? { displayName: candidate.displayName } : {}),
      capabilities: candidate.capabilities.filter(
        (capability): capability is CapabilitySlug =>
          typeof capability === "string" && isCapabilitySlug(capability),
      ),
    };
  } catch {
    return null;
  }
}

/** Best-effort per-server viewer cache; identity only, never credentials. */
export async function readViewerCache(serverId: string): Promise<CachedViewer | null> {
  try {
    await viewerMutationTail.get(serverId);
    return parseCachedViewer(await AsyncStorage.getItem(cacheKey(serverId)));
  } catch {
    return null;
  }
}

/** Replaces the active server's last verified viewer identity. */
export async function writeViewerCache(serverId: string, viewer: CachedViewer): Promise<void> {
  const value: StoredViewer = { v: 1, ...viewer };
  try {
    await enqueueViewerMutation(serverId, () =>
      AsyncStorage.setItem(cacheKey(serverId), JSON.stringify(value)),
    );
  } catch {
    // Cache is advisory; storage failure must not block a signed-in session.
  }
}

/** Clears only one server's cached viewer, never another paired server's. */
export async function clearViewerCache(serverId: string): Promise<void> {
  try {
    await enqueueViewerMutation(serverId, () => AsyncStorage.removeItem(cacheKey(serverId)));
  } catch {
    // Best effort, matching the registry's metadata persistence behavior.
  }
}
