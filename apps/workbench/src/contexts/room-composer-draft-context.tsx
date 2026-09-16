import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  restoreFocusedResources,
  type ComposerFocusedResource,
} from "../adapters/composer-focused-resources-ref";

export const ROOM_COMPOSER_DRAFTS_SESSION_KEY = "nautilo:room-composer-drafts:v1";
const MAX_STORED_DRAFTS = 100;
const MAX_STORED_TEXT_LENGTH = 100_000;
const MAX_STORED_IDENTIFIER_LENGTH = 4_096;

export type PendingRoomReply = {
  targetId: number;
  senderName: string;
  snippet: string;
};

export type RoomComposerDraft = {
  text: string;
  focusedResources: readonly ComposerFocusedResource[];
  pendingReply: PendingRoomReply | null;
};

type Listener = () => void;

type StoredDraftEnvelope = {
  version: 1;
  drafts: Array<{ roomId: string; draft: RoomComposerDraft }>;
};

export type RoomComposerDraftStore = {
  get(roomId: string): RoomComposerDraft | undefined;
  saveComposition(
    roomId: string,
    composition: Pick<RoomComposerDraft, "text" | "focusedResources">,
  ): void;
  setPendingReply(roomId: string, pendingReply: PendingRoomReply | null): void;
  clear(roomId: string): void;
  prepareForRendererReload(options?: Readonly<{
    plaintextPersistence: "allowed" | "forbidden";
  }>): boolean;
  beginSend(roomId: string): number | null;
  finishSend(roomId: string, attemptId: number): void;
  subscribe(listener: Listener): () => void;
  getSnapshot(): number;
  getReplySnapshot(roomId: string | null): number;
};

function sameRef(
  left: ComposerFocusedResource["ref"],
  right: ComposerFocusedResource["ref"],
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "workspace-artifact" && right.kind === "workspace-artifact") {
    return left.artifactId === right.artifactId;
  }
  if (left.kind === "local-file" && right.kind === "local-file") {
    return (
      left.relayId === right.relayId &&
      left.path === right.path &&
      left.rootPath === right.rootPath &&
      left.name === right.name
    );
  }
  return false;
}

function sameResources(
  left: readonly ComposerFocusedResource[],
  right: readonly ComposerFocusedResource[],
): boolean {
  return (
    left.length === right.length &&
    left.every((item, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        item.entryId === other.entryId &&
        item.label === other.label &&
        sameRef(item.ref, other.ref)
      );
    })
  );
}

function isBoundedString(value: unknown, maxLength: number): value is string {
  // eslint-disable-next-line no-control-regex -- persisted identifiers must be printable
  return typeof value === "string" && value.length <= maxLength && !/[\u0000-\u001f\u007f]/.test(value);
}

function isBoundedText(value: unknown, maxLength: number): value is string {
  return typeof value === "string" && value.length <= maxLength;
}

function isFocusedResource(value: unknown): value is ComposerFocusedResource {
  if (!value || typeof value !== "object") return false;
  const item = value as {
    entryId?: unknown;
    label?: unknown;
    ref?: { kind?: unknown; artifactId?: unknown; path?: unknown; rootPath?: unknown; name?: unknown; relayId?: unknown };
  };
  if (
    typeof item.entryId !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(item.entryId) ||
    !isBoundedString(item.label, 160) ||
    !item.ref
  ) {
    return false;
  }
  if (item.ref.kind === "workspace-artifact") {
    return isBoundedString(item.ref.artifactId, MAX_STORED_IDENTIFIER_LENGTH);
  }
  return item.ref.kind === "local-file" &&
    isBoundedString(item.ref.path, MAX_STORED_IDENTIFIER_LENGTH) &&
    isBoundedString(item.ref.rootPath, MAX_STORED_IDENTIFIER_LENGTH) &&
    isBoundedString(item.ref.name, 512) &&
    isBoundedString(item.ref.relayId, MAX_STORED_IDENTIFIER_LENGTH);
}

function isPendingReply(value: unknown): value is PendingRoomReply | null {
  if (value === null) return true;
  if (!value || typeof value !== "object") return false;
  const reply = value as { targetId?: unknown; senderName?: unknown; snippet?: unknown };
  return Number.isSafeInteger(reply.targetId) &&
    Number(reply.targetId) > 0 &&
    isBoundedString(reply.senderName, 512) &&
    isBoundedText(reply.snippet, MAX_STORED_TEXT_LENGTH);
}

function isRoomComposerDraft(value: unknown): value is RoomComposerDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as { text?: unknown; focusedResources?: unknown; pendingReply?: unknown };
  return isBoundedText(draft.text, MAX_STORED_TEXT_LENGTH) &&
    Array.isArray(draft.focusedResources) &&
    draft.focusedResources.length <= 30 &&
    draft.focusedResources.every(isFocusedResource) &&
    isPendingReply(draft.pendingReply);
}

function readPersistedDrafts(): Map<string, RoomComposerDraft> {
  try {
    const raw = sessionStorage.getItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY);
    if (!raw) return new Map();
    const envelope = JSON.parse(raw) as Partial<StoredDraftEnvelope>;
    if (
      envelope.version !== 1 ||
      !Array.isArray(envelope.drafts) ||
      envelope.drafts.length > MAX_STORED_DRAFTS ||
      !envelope.drafts.every((entry) =>
        entry &&
        isBoundedString(entry.roomId, MAX_STORED_IDENTIFIER_LENGTH) &&
        isRoomComposerDraft(entry.draft),
      )
    ) {
      throw new Error("Invalid persisted composer draft envelope");
    }
    const drafts = new Map<string, RoomComposerDraft>();
    for (const entry of envelope.drafts) {
      if (drafts.has(entry.roomId)) throw new Error("Duplicate persisted composer draft room");
      drafts.set(entry.roomId, {
        text: entry.draft.text,
        focusedResources: [...entry.draft.focusedResources],
        pendingReply: entry.draft.pendingReply,
      });
    }
    // This is a one-reload handoff, not general draft-at-rest storage. Once a
    // renderer has recovered the envelope, keep the live provider authoritative
    // until another guarded maintenance reload is about to begin.
    sessionStorage.removeItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY);
    return drafts;
  } catch {
    // Never hydrate partially parsed/untrusted state into the composer. A
    // corrupt or incompatible envelope is discarded as one unit.
    try {
      sessionStorage.removeItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY);
    } catch {
      // Storage may be unavailable in private or embedded contexts.
    }
    return new Map();
  }
}

function persistDrafts(drafts: ReadonlyMap<string, RoomComposerDraft>): boolean {
  try {
    if (drafts.size === 0) {
      sessionStorage.removeItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY);
      return true;
    }
    if (drafts.size > MAX_STORED_DRAFTS) return false;
    const envelope: StoredDraftEnvelope = {
      version: 1,
      drafts: [...drafts].map(([roomId, draft]) => ({
        roomId,
        draft: {
          text: draft.text,
          focusedResources: [...draft.focusedResources],
          pendingReply: draft.pendingReply,
        },
      })),
    };
    sessionStorage.setItem(ROOM_COMPOSER_DRAFTS_SESSION_KEY, JSON.stringify(envelope));
    return true;
  } catch {
    return false;
  }
}

/**
 * A deliberately provider-owned store: it is not a module singleton, so its
 * lifetime is the authenticated runtime subtree. The external-store shape
 * keeps a single draft envelope stable across the center and reader-rail
 * Conversation mounts without making every keystroke rerender AppShell.
 */
export function createRoomComposerDraftStore(): RoomComposerDraftStore {
  let drafts = readPersistedDrafts();
  let version = 0;
  const replyVersions = new Map<string, number>();
  const activeSendAttempts = new Map<string, number>();
  let nextSendAttemptId = 0;
  const listeners = new Set<Listener>();

  const publish = (): void => {
    version += 1;
    for (const listener of listeners) listener();
  };

  return {
    get: (roomId) => drafts.get(roomId),
    saveComposition: (roomId, composition) => {
      const current = drafts.get(roomId);
      const focusedResources = [...composition.focusedResources];
      if (
        current?.text === composition.text &&
        sameResources(current.focusedResources, focusedResources)
      ) {
        return;
      }
      const next = new Map(drafts);
      next.set(roomId, {
        text: composition.text,
        focusedResources,
        pendingReply: current?.pendingReply ?? null,
      });
      drafts = next;
      publish();
    },
    setPendingReply: (roomId, pendingReply) => {
      const current = drafts.get(roomId);
      if (current?.pendingReply === pendingReply) return;
      const next = new Map(drafts);
      next.set(roomId, {
        text: current?.text ?? "",
        focusedResources: current?.focusedResources ?? [],
        pendingReply,
      });
      drafts = next;
      replyVersions.set(roomId, (replyVersions.get(roomId) ?? 0) + 1);
      publish();
    },
    clear: (roomId) => {
      const current = drafts.get(roomId);
      if (!current) return;
      const next = new Map(drafts);
      next.delete(roomId);
      drafts = next;
      if (current.pendingReply !== null) {
        replyVersions.set(roomId, (replyVersions.get(roomId) ?? 0) + 1);
      }
      publish();
    },
    prepareForRendererReload: (options) =>
      options?.plaintextPersistence === "forbidden"
        ? drafts.size === 0
        : persistDrafts(drafts),
    beginSend: (roomId) => {
      if (activeSendAttempts.has(roomId)) return null;
      const attemptId = ++nextSendAttemptId;
      activeSendAttempts.set(roomId, attemptId);
      return attemptId;
    },
    finishSend: (roomId, attemptId) => {
      if (activeSendAttempts.get(roomId) === attemptId) {
        activeSendAttempts.delete(roomId);
      }
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => version,
    getReplySnapshot: (roomId) => roomId ? replyVersions.get(roomId) ?? 0 : 0,
  };
}

const RoomComposerDraftContext = createContext<RoomComposerDraftStore | null>(null);

export function RoomComposerDraftProvider({ children }: { children: ReactNode }) {
  const storeRef = useRef<RoomComposerDraftStore | null>(null);
  if (!storeRef.current) storeRef.current = createRoomComposerDraftStore();
  useEffect(
    () => () => {
      // The focused-resource adapter is intentionally module-global so the
      // runtime can read it on send. Do not let it outlive this authenticated
      // provider subtree.
      restoreFocusedResources([]);
    },
    [],
  );
  return (
    <RoomComposerDraftContext.Provider value={storeRef.current}>
      {children}
    </RoomComposerDraftContext.Provider>
  );
}

export function useRoomComposerDraftStore(): RoomComposerDraftStore {
  const store = useContext(RoomComposerDraftContext);
  if (!store) {
    throw new Error("useRoomComposerDraftStore must be used within RoomComposerDraftProvider");
  }
  return store;
}

/** Subscribe only to reply changes; composition writes happen on every key. */
export function useRoomPendingReply(roomId: string | null): PendingRoomReply | null {
  const store = useRoomComposerDraftStore();
  useSyncExternalStore(
    (listener) => store.subscribe(listener),
    () => store.getReplySnapshot(roomId),
    () => store.getReplySnapshot(roomId),
  );
  return roomId ? store.get(roomId)?.pendingReply ?? null : null;
}
