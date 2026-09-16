/**
 * D468 — per-server Mobile push binding material and proof-only revocation.
 *
 * Every secret in this module lives in SecureStore.  AsyncStorage only knows
 * the ordinary server registry; it must never receive a push token, revoke
 * proof, or binding acknowledgement state.
 */
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";

import type { PushPermission } from "./push-installation";

const BINDING_PREFIX = "nautilo.push.binding.v1.";
const TOMBSTONES_KEY = "nautilo.push.revoke-tombstones.v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SERVER_ID = /^[A-Za-z0-9._-]{1,180}$/;
const REVOKE_PROOF = /^[a-f0-9]{64}$/;

/** Keep abandoned offline cleanup bounded without ever retaining a bearer. */
export const MAX_PUSH_REVOKE_TOMBSTONES = 32;
const MAX_PUSH_REVOKE_TOMBSTONE_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export interface PushBindingAcknowledgement {
  readonly tokenGeneration: number;
  readonly permission: PushPermission;
}

export interface PushBinding {
  readonly version: 1;
  /**
   * The verified Human who owns this server-local binding.  A SecureStore
   * entry can never be reused merely because a different Human later signs in
   * to the same Nautilo server on this phone.
   */
  readonly ownerUserId: string;
  readonly bindingId: string;
  /** Random revoke-only capability. It is never returned from API responses. */
  readonly revokeProof: string;
  readonly lastAcknowledged: PushBindingAcknowledgement | null;
}

export interface PushRevokeTombstone {
  readonly version: 1;
  readonly serverUrl: string;
  readonly bindingId: string;
  readonly revokeProof: string;
  readonly createdAt: string;
}

interface PushBindingStoreDeps {
  readonly secureStore: Pick<
    typeof SecureStore,
    "getItemAsync" | "setItemAsync" | "deleteItemAsync"
  >;
  readonly randomBytes: (byteCount: number) => Promise<Uint8Array>;
  readonly randomUuid: () => string;
  readonly now: () => Date;
}

const defaultDeps: PushBindingStoreDeps = {
  secureStore: SecureStore,
  randomBytes: Crypto.getRandomBytesAsync,
  randomUuid: Crypto.randomUUID,
  now: () => new Date(),
};

export interface PushBindingStore {
  loadBinding(serverId: string): Promise<PushBinding | null>;
  loadOrCreateBinding(serverId: string, ownerUserId: string): Promise<PushBinding>;
  acknowledgeBinding(input: {
    serverId: string;
    ownerUserId: string;
    bindingId: string;
    acknowledgement: PushBindingAcknowledgement;
  }): Promise<boolean>;
  /** Clear one exact local binding after authenticated server-side revocation. */
  clearBinding(input: {
    serverId: string;
    bindingId: string;
  }): Promise<boolean>;
  /** Persist proof cleanup before discarding one local binding. */
  queueRevokeAndClearBinding(input: {
    serverId: string;
    serverUrl: string;
    /** Refuse to delete a newer binding that superseded this operation. */
    expectedBindingId?: string;
  }): Promise<boolean>;
  listRevokeTombstones(): Promise<readonly PushRevokeTombstone[]>;
  drainRevokeTombstones(
    attempt: (tombstone: PushRevokeTombstone) => Promise<"success" | "terminal" | "retry">,
  ): Promise<{ attempted: number; cleared: number; retained: number }>;
}

function bindingKey(serverId: string): string {
  if (!SERVER_ID.test(serverId)) throw new Error("invalid Mobile push server id");
  return BINDING_PREFIX + serverId;
}

function isPermission(value: unknown): value is PushPermission {
  return value === "granted" || value === "denied" || value === "undetermined";
}

function isGeneration(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOwnerUserId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 180;
}

function parseBinding(value: string | null): PushBinding | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<PushBinding>;
    const acknowledgement = parsed.lastAcknowledged;
    if (
      parsed.version !== 1
      || !isOwnerUserId(parsed.ownerUserId)
      || typeof parsed.bindingId !== "string"
      || !UUID.test(parsed.bindingId)
      || typeof parsed.revokeProof !== "string"
      || !REVOKE_PROOF.test(parsed.revokeProof)
      || (acknowledgement !== null && acknowledgement !== undefined && (
        typeof acknowledgement !== "object"
        || !isGeneration(acknowledgement.tokenGeneration)
        || !isPermission(acknowledgement.permission)
      ))
    ) {
      return null;
    }
    return {
      version: 1,
      ownerUserId: parsed.ownerUserId,
      bindingId: parsed.bindingId,
      revokeProof: parsed.revokeProof,
      lastAcknowledged: acknowledgement == null
        ? null
        : {
          tokenGeneration: acknowledgement.tokenGeneration,
          permission: acknowledgement.permission,
        },
    };
  } catch {
    return null;
  }
}

function parseTombstone(value: unknown): PushRevokeTombstone | null {
  if (!value || typeof value !== "object") return null;
  const parsed = value as Partial<PushRevokeTombstone>;
  if (
    parsed.version !== 1
    || typeof parsed.serverUrl !== "string"
    || !isHttpUrl(parsed.serverUrl)
    || typeof parsed.bindingId !== "string"
    || !UUID.test(parsed.bindingId)
    || typeof parsed.revokeProof !== "string"
    || !REVOKE_PROOF.test(parsed.revokeProof)
    || typeof parsed.createdAt !== "string"
    || !isFiniteIsoDate(parsed.createdAt)
  ) {
    return null;
  }
  return {
    version: 1,
    serverUrl: parsed.serverUrl,
    bindingId: parsed.bindingId,
    revokeProof: parsed.revokeProof,
    createdAt: parsed.createdAt,
  };
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && url.toString().length <= 2_048;
  } catch {
    return false;
  }
}

function isFiniteIsoDate(value: string): boolean {
  return Number.isFinite(Date.parse(value));
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function normalizeTombstones(
  values: readonly PushRevokeTombstone[],
  now: Date,
): PushRevokeTombstone[] {
  const cutoff = now.getTime() - MAX_PUSH_REVOKE_TOMBSTONE_AGE_MS;
  const byBinding = new Map<string, PushRevokeTombstone>();
  for (const value of values) {
    if (Date.parse(value.createdAt) < cutoff) continue;
    const key = `${value.serverUrl}\u0000${value.bindingId}`;
    const existing = byBinding.get(key);
    if (!existing || Date.parse(value.createdAt) > Date.parse(existing.createdAt)) {
      byBinding.set(key, value);
    }
  }
  return [...byBinding.values()]
    .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt))
    .slice(-MAX_PUSH_REVOKE_TOMBSTONES);
}

function parseTombstoneList(value: string | null, now: Date): PushRevokeTombstone[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as { version?: unknown; tombstones?: unknown };
    if (parsed.version !== 1 || !Array.isArray(parsed.tombstones)) return [];
    return normalizeTombstones(
      parsed.tombstones.flatMap((entry) => {
        const tombstone = parseTombstone(entry);
        return tombstone ? [tombstone] : [];
      }),
      now,
    );
  } catch {
    return [];
  }
}

function sameTombstone(left: PushRevokeTombstone, right: PushRevokeTombstone): boolean {
  return left.serverUrl === right.serverUrl
    && left.bindingId === right.bindingId
    && left.revokeProof === right.revokeProof
    && left.createdAt === right.createdAt;
}

export function createPushBindingStore(
  supplied: Partial<PushBindingStoreDeps> = {},
): PushBindingStore {
  const deps: PushBindingStoreDeps = { ...defaultDeps, ...supplied };
  let mutationTail: Promise<void> = Promise.resolve();
  const bindingInitializations = new Map<string, Promise<PushBinding>>();

  function serialize<T>(mutation: () => Promise<T>): Promise<T> {
    const result = mutationTail.catch(() => {}).then(mutation);
    mutationTail = result.then(() => {}, () => {});
    return result;
  }

  async function writeTombstones(values: readonly PushRevokeTombstone[]): Promise<void> {
    await deps.secureStore.setItemAsync(
      TOMBSTONES_KEY,
      JSON.stringify({ version: 1, tombstones: values }),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
  }

  async function readTombstones(): Promise<PushRevokeTombstone[]> {
    return parseTombstoneList(
      await deps.secureStore.getItemAsync(TOMBSTONES_KEY),
      deps.now(),
    );
  }

  async function createBinding(serverId: string, ownerUserId: string): Promise<PushBinding> {
    if (!isOwnerUserId(ownerUserId)) throw new Error("invalid Mobile push binding owner");
    const bytes = await deps.randomBytes(32);
    if (bytes.length !== 32) throw new Error("Mobile push revoke proof has invalid length");
    const bindingId = deps.randomUuid().toLowerCase();
    if (!UUID.test(bindingId)) throw new Error("Mobile push binding UUID is invalid");
    const binding: PushBinding = {
      version: 1,
      ownerUserId,
      bindingId,
      revokeProof: hex(bytes),
      lastAcknowledged: null,
    };
    await deps.secureStore.setItemAsync(
      bindingKey(serverId),
      JSON.stringify(binding),
      { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
    );
    return binding;
  }

  return {
    async loadBinding(serverId): Promise<PushBinding | null> {
      const raw = await deps.secureStore.getItemAsync(bindingKey(serverId));
      const binding = parseBinding(raw);
      // Ownerless records predate the D468 authority contract. Treating one
      // as absent would let logout/delete erase its only revoke proof, while
      // treating it as current would cross a Human boundary. Pre-release
      // state therefore requires an explicit operator reset.
      if (raw !== null && !binding) {
        throw new Error("Mobile push binding requires explicit reset before reuse");
      }
      return binding;
    },

    loadOrCreateBinding(serverId, ownerUserId): Promise<PushBinding> {
      bindingKey(serverId);
      if (!isOwnerUserId(ownerUserId)) return Promise.reject(new Error("invalid Mobile push binding owner"));
      const initializationKey = `${serverId}\u0000${ownerUserId}`;
      const existing = bindingInitializations.get(initializationKey);
      if (existing) return existing;
      const pending = serialize(async () => {
        const raw = await deps.secureStore.getItemAsync(bindingKey(serverId));
        const stored = parseBinding(raw);
        // This is pre-release state.  An ownerless/corrupt record cannot be
        // silently overwritten because that would discard its revoke proof.
        if (raw !== null && !stored) {
          throw new Error("Mobile push binding requires explicit reset before reuse");
        }
        if (stored && stored.ownerUserId !== ownerUserId) {
          throw new Error("Mobile push binding belongs to a different Human");
        }
        return stored ?? createBinding(serverId, ownerUserId);
      });
      bindingInitializations.set(initializationKey, pending);
      void pending.finally(() => {
        if (bindingInitializations.get(initializationKey) === pending) {
          bindingInitializations.delete(initializationKey);
        }
      }).catch(() => {});
      return pending;
    },

    acknowledgeBinding(input): Promise<boolean> {
      return serialize(async () => {
        const key = bindingKey(input.serverId);
        const current = parseBinding(await deps.secureStore.getItemAsync(key));
        if (
          !current
          || current.ownerUserId !== input.ownerUserId
          || current.bindingId !== input.bindingId
        ) return false;
        if (!isGeneration(input.acknowledgement.tokenGeneration) || !isPermission(input.acknowledgement.permission)) {
          throw new Error("invalid Mobile push binding acknowledgement");
        }
        const prior = current.lastAcknowledged;
        if (prior && prior.tokenGeneration > input.acknowledgement.tokenGeneration) return false;
        const next: PushBinding = {
          ...current,
          lastAcknowledged: {
            tokenGeneration: input.acknowledgement.tokenGeneration,
            permission: input.acknowledgement.permission,
          },
        };
        await deps.secureStore.setItemAsync(
          key,
          JSON.stringify(next),
          { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY },
        );
        return true;
      });
    },

    clearBinding(input): Promise<boolean> {
      return serialize(async () => {
        const key = bindingKey(input.serverId);
        const current = parseBinding(await deps.secureStore.getItemAsync(key));
        if (!current || current.bindingId !== input.bindingId) return false;
        await deps.secureStore.deleteItemAsync(key);
        return true;
      });
    },

    queueRevokeAndClearBinding(input): Promise<boolean> {
      return serialize(async () => {
        const key = bindingKey(input.serverId);
        const raw = await deps.secureStore.getItemAsync(key);
        const binding = parseBinding(raw);
        if (raw !== null && !binding) {
          throw new Error("Mobile push binding requires explicit reset before reuse");
        }
        if (!binding) return false;
        if (input.expectedBindingId && binding.bindingId !== input.expectedBindingId) return false;
        if (!isHttpUrl(input.serverUrl)) throw new Error("invalid Mobile push revoke server URL");
        const tombstone: PushRevokeTombstone = {
          version: 1,
          serverUrl: input.serverUrl.replace(/\/+$/, ""),
          bindingId: binding.bindingId,
          revokeProof: binding.revokeProof,
          createdAt: deps.now().toISOString(),
        };
        const existing = await readTombstones();
        const next = normalizeTombstones([...existing, tombstone], deps.now());
        // This write intentionally precedes local binding deletion. A process
        // crash may leave a duplicate cleanup capability, never lose one.
        await writeTombstones(next);
        await deps.secureStore.deleteItemAsync(key);
        return true;
      });
    },

    listRevokeTombstones(): Promise<readonly PushRevokeTombstone[]> {
      return serialize(async () => {
        const tombstones = await readTombstones();
        // Persist pruning so expired/invalid records do not occupy capacity forever.
        await writeTombstones(tombstones);
        return tombstones;
      });
    },

    drainRevokeTombstones(attempt) {
      return serialize(async () => {
        let tombstones = await readTombstones();
        let attempted = 0;
        let cleared = 0;
        for (const tombstone of [...tombstones]) {
          attempted += 1;
          const result = await attempt(tombstone);
          if (result === "retry") continue;
          tombstones = tombstones.filter((candidate) => !sameTombstone(candidate, tombstone));
          cleared += 1;
        }
        tombstones = normalizeTombstones(tombstones, deps.now());
        await writeTombstones(tombstones);
        return { attempted, cleared, retained: tombstones.length };
      });
    },
  };
}

const defaultStore = createPushBindingStore();

export const loadPushBinding = defaultStore.loadBinding.bind(defaultStore);
export const loadOrCreatePushBinding = defaultStore.loadOrCreateBinding.bind(defaultStore);
export const acknowledgePushBinding = defaultStore.acknowledgeBinding.bind(defaultStore);
export const clearPushBinding = defaultStore.clearBinding.bind(defaultStore);
export const queuePushBindingRevokeAndClear = defaultStore.queueRevokeAndClearBinding.bind(defaultStore);
export const listPushRevokeTombstones = defaultStore.listRevokeTombstones.bind(defaultStore);
export const drainPushRevokeTombstones = defaultStore.drainRevokeTombstones.bind(defaultStore);
