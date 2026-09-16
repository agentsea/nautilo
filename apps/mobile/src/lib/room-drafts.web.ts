import {
  browserLocalStorage,
  createBrowserScopedStore,
  type BrowserScopedStore,
  type BrowserStorageArea,
} from "@/platform/browser-storage.web";

/** Ordinary browser draft state; it is never credential or local-file state. */
export type RoomDraftScope = {
  readonly serverId: string;
  readonly viewerId: string;
  readonly roomId: string;
};
/** Kept as a call-signature placeholder; browser persistence is created only from its serving origin. */
export type RoomDraftStore = unknown;

type RestoredAttachment = {
  readonly kind: "server";
  readonly attachmentId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};

export type RoomDraftAttachment = RestoredAttachment;
export type RoomDraftSnapshot = {
  readonly text: string;
  /** Web never restores attachment metadata; this remains type-compatible with shared callers. */
  readonly attachments: readonly RestoredAttachment[];
};
export type RoomDraftSnapshotInput = {
  readonly text: string;
  readonly attachments: readonly unknown[];
};

type StoredTextDraft = {
  readonly version: 1;
  readonly text: string;
  readonly savedAt: number;
};

type SaveOutcome = "saved" | "discarded" | "too-large";

const PREFIX = "room-draft";
const MAX_BYTES = 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FUTURE_CLOCK_SKEW_MS = 60_000;

function tag(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

/** A diagnostic-only stable identifier; browser persistence also binds the actual serving origin. */
export function roomDraftKey(scope: RoomDraftScope): string {
  return `${PREFIX}.${tag(scope.serverId)}.${tag(scope.viewerId)}.${tag(scope.roomId)}`;
}

function validText(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_BYTES;
}

function validStored(value: unknown): value is StoredTextDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<StoredTextDraft>;
  const keys = Object.keys(draft).sort();
  return keys.length === 3
    && keys[0] === "savedAt"
    && keys[1] === "text"
    && keys[2] === "version"
    && draft.version === 1
    && typeof draft.text === "string"
    && validText(draft.text)
    && typeof draft.savedAt === "number"
    && Number.isFinite(draft.savedAt);
}

function expired(value: StoredTextDraft, now: number): boolean {
  return value.savedAt > now + FUTURE_CLOCK_SKEW_MS || now - value.savedAt > MAX_AGE_MS;
}

function namespace(scope: RoomDraftScope): string {
  return `${PREFIX}.server.${scope.serverId}.room.${scope.roomId}`;
}

export interface BrowserRoomDraftStore {
  consume(scope: RoomDraftScope, now?: number): Promise<string>;
  save(scope: RoomDraftScope, text: string, now?: number): Promise<SaveOutcome>;
  consumeSnapshot(scope: RoomDraftScope, now?: number): Promise<RoomDraftSnapshot>;
  saveSnapshot(scope: RoomDraftScope, snapshot: RoomDraftSnapshotInput, now?: number): Promise<SaveOutcome>;
}

/**
 * Build an origin/Human/Room projection over ordinary browser storage. The
 * platform store serializes local mutations and revision-fences stale cleanup.
 */
export function createBrowserRoomDraftStore(input: {
  readonly origin: string;
  readonly storage: BrowserStorageArea | null;
}): BrowserRoomDraftStore {
  const stores = new Map<string, BrowserScopedStore<StoredTextDraft>>();
  const storeFor = (scope: RoomDraftScope): BrowserScopedStore<StoredTextDraft> => {
    const cacheKey = JSON.stringify([scope.viewerId, scope.serverId, scope.roomId]);
    const existing = stores.get(cacheKey);
    if (existing) return existing;
    const created = createBrowserScopedStore({
      namespace: namespace(scope),
      scope: { origin: input.origin, humanId: scope.viewerId },
      storage: input.storage,
      validate: validStored,
    });
    stores.set(cacheKey, created);
    return created;
  };

  const consume = async (scope: RoomDraftScope, now = Date.now()): Promise<string> => {
    const store = storeFor(scope);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await store.read();
      if (!snapshot.value) return "";
      if (!expired(snapshot.value, now)) return snapshot.value.text;
      // A concurrent keystroke can replace the record between read and clear.
      // Its revision makes this stale cleanup a harmless no-op.
      if (await store.clear(snapshot.revision)) return "";
    }
    return "";
  };

  const save = async (scope: RoomDraftScope, text: string, now = Date.now()): Promise<SaveOutcome> => {
    const store = storeFor(scope);
    if (!text) {
      const snapshot = await store.read();
      if (await store.clear(snapshot.revision)) return "discarded";
      throw new Error("Browser draft storage could not discard the draft.");
    }
    if (!validText(text)) {
      const snapshot = await store.read();
      if (await store.clear(snapshot.revision)) return "too-large";
      throw new Error("Browser draft storage could not clear an oversized draft.");
    }
    const value: StoredTextDraft = { version: 1, text, savedAt: now };
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const snapshot = await store.read();
      if (await store.replace(value, snapshot.revision)) return "saved";
    }
    throw new Error("Browser draft storage could not save the draft.");
  };

  return {
    consume,
    save,
    async consumeSnapshot(scope, now) {
      return { text: await consume(scope, now), attachments: [] };
    },
    async saveSnapshot(scope, snapshot, now) {
      if (!snapshot || typeof snapshot.text !== "string" || !Array.isArray(snapshot.attachments)) {
        return save(scope, "", now).then(() => "too-large" as const);
      }
      const outcome = await save(scope, snapshot.text, now);
      return outcome;
    },
  };
}

function currentOrigin(): string | null {
  if (typeof location === "undefined") return null;
  try {
    const parsed = new URL(location.href);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

function runtimeStore(): BrowserRoomDraftStore | null {
  const origin = currentOrigin();
  return origin ? createBrowserRoomDraftStore({ origin, storage: browserLocalStorage() }) : null;
}

/** Validate and clear expired browser text before it reaches the composer. */
export async function consumeRoomDraft(
  scope: RoomDraftScope,
  _nativeStore?: RoomDraftStore,
  now = Date.now(),
): Promise<string> {
  return runtimeStore()?.consume(scope, now) ?? "";
}

/** Empty text is an explicit durable discard; blocked storage reports an error to the caller. */
export async function saveRoomDraft(
  scope: RoomDraftScope,
  text: string,
  _nativeStore?: RoomDraftStore,
  now = Date.now(),
): Promise<SaveOutcome> {
  const store = runtimeStore();
  if (!store) throw new Error("Browser draft storage is unavailable.");
  return store.save(scope, text, now);
}

/** Web restores text only; attachments are intentionally absent. */
export async function consumeRoomDraftSnapshot(
  scope: RoomDraftScope,
  _nativeStore?: RoomDraftStore,
  now = Date.now(),
): Promise<RoomDraftSnapshot> {
  return runtimeStore()?.consumeSnapshot(scope, now) ?? { text: "", attachments: [] };
}

/** Web saves only text from a shared snapshot and never retains attachment metadata. */
export async function saveRoomDraftSnapshot(
  scope: RoomDraftScope,
  snapshot: RoomDraftSnapshotInput,
  _nativeStore?: RoomDraftStore,
  now = Date.now(),
): Promise<SaveOutcome> {
  const store = runtimeStore();
  if (!store) throw new Error("Browser draft storage is unavailable.");
  return store.saveSnapshot(scope, snapshot, now);
}

export const ROOM_DRAFT_LIMITS = { MAX_BYTES, MAX_AGE_MS };
