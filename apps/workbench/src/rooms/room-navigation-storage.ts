/**
 * Local persistence for Workbench room navigation UI metadata only.
 * Namespaced by origin + viewer key — never stores message content.
 */

/** Stable key for storage namespacing; null ⇒ in-memory-only metadata this session. */
export function stableViewerKeyForStorage(viewer: {
  sessionUserId: string | null;
  userIdentity: string | null;
}): string | null {
  const id = viewer.sessionUserId ?? viewer.userIdentity;
  if (typeof id === "string" && id.trim().length > 0) return id.trim();
  return null;
}

export const ROOM_NAV_STORAGE_VERSION = 1 as const;

export interface RoomNavStoredRoomMeta {
  pinned?: boolean;
  /** Explicit local workspace tab state. Absent means "not opened yet". */
  tabOpen?: boolean;
  /** Legacy v1 field retained for compatibility with existing localStorage. */
  closedTab?: boolean;
  lastOpenedAt?: number;
  /** Stable user-controlled order for open tabs. */
  tabOrder?: number;
}

export interface RoomNavStoredPayload {
  version: typeof ROOM_NAV_STORAGE_VERSION;
  lastActiveRoomId?: string;
  rooms: Record<string, RoomNavStoredRoomMeta>;
}

export function buildRoomNavStorageKey(origin: string, viewerKey: string): string {
  return `nautilo:room-nav:v1:${origin}|${viewerKey}`;
}

function safeParsePayload(raw: string | null): RoomNavStoredPayload | null {
  if (raw === null || raw === "") return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.version !== ROOM_NAV_STORAGE_VERSION) return null;
    const lastActive =
      typeof obj.lastActiveRoomId === "string" ? obj.lastActiveRoomId : undefined;
    const roomsRaw = obj.rooms;
    const rooms: Record<string, RoomNavStoredRoomMeta> = {};
    if (roomsRaw && typeof roomsRaw === "object" && !Array.isArray(roomsRaw)) {
      for (const [k, v] of Object.entries(roomsRaw)) {
        if (!k || typeof v !== "object" || v === null || Array.isArray(v)) continue;
        const m = v as Record<string, unknown>;
        const meta: RoomNavStoredRoomMeta = {};
        if (typeof m.pinned === "boolean") meta.pinned = m.pinned;
        if (typeof m.tabOpen === "boolean") meta.tabOpen = m.tabOpen;
        if (typeof m.closedTab === "boolean") meta.closedTab = m.closedTab;
        if (typeof m.lastOpenedAt === "number" && Number.isFinite(m.lastOpenedAt)) {
          meta.lastOpenedAt = m.lastOpenedAt;
        }
        if (typeof m.tabOrder === "number" && Number.isFinite(m.tabOrder)) {
          meta.tabOrder = m.tabOrder;
        }
        rooms[k] = meta;
      }
    }
    return {
      version: ROOM_NAV_STORAGE_VERSION,
      ...(lastActive !== undefined ? { lastActiveRoomId: lastActive } : {}),
      rooms,
    };
  } catch {
    return null;
  }
}

export interface RoomNavigationStoragePort {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export function createRoomNavigationStorage(api: {
  storage: RoomNavigationStoragePort | null;
  origin: string;
  viewerKey: string | null;
}) {
  const { storage, origin, viewerKey } = api;
  const persistenceDisabled = !storage || !viewerKey;

  function key(): string | null {
    if (!viewerKey) return null;
    return buildRoomNavStorageKey(origin, viewerKey);
  }

  function load(): RoomNavStoredPayload {
    if (persistenceDisabled) {
      return { version: ROOM_NAV_STORAGE_VERSION, rooms: {} };
    }
    const k = key();
    if (!k) {
      return { version: ROOM_NAV_STORAGE_VERSION, rooms: {} };
    }
    const parsed = safeParsePayload(storage.getItem(k));
    if (parsed === null && storage.getItem(k) !== null) {
      storage.removeItem(k);
      return { version: ROOM_NAV_STORAGE_VERSION, rooms: {} };
    }
    return parsed ?? { version: ROOM_NAV_STORAGE_VERSION, rooms: {} };
  }

  function save(payload: RoomNavStoredPayload): void {
    if (persistenceDisabled) return;
    const k = key();
    if (!k) return;
    try {
      storage.setItem(k, JSON.stringify(payload));
    } catch {
      // Quota or private mode — ignore; in-memory state still works this session.
    }
  }

  return { load, save, persistenceDisabled };
}
