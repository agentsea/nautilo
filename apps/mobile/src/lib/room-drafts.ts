import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from "@nautilo/types";

/** Encrypted, bounded draft metadata custody. Raw attachment bytes never enter this store. */
export type RoomDraftScope = { readonly serverId: string; readonly viewerId: string; readonly roomId: string };
export type RoomDraftStore = { getItemAsync(key: string): Promise<string | null>; setItemAsync(key: string, value: string): Promise<void>; deleteItemAsync(key: string): Promise<void> };
type RoomDraftAttachmentBase = {
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
};
export type RoomDraftAttachment = RoomDraftAttachmentBase & ({
  readonly kind: "custody";
  readonly custodyId: string;
} | {
  readonly kind: "server";
  readonly attachmentId: string;
});
export type RoomDraftSnapshot = { readonly text: string; readonly attachments: readonly RoomDraftAttachment[] };

const PREFIX = "nautilo.room-draft.v1";
// SecureStore values have platform-specific practical limits (~2KB on older
// iOS); reserve room for metadata and reject rather than silently truncating.
const MAX_BYTES = 1024;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

function tag(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  return (hash >>> 0).toString(36);
}

export function roomDraftKey(scope: RoomDraftScope): string {
  return `${PREFIX}.${tag(scope.serverId)}.${tag(scope.viewerId)}.${tag(scope.roomId)}`;
}

type StoredTextDraft = { version: 1; server: string; viewer: string; room: string; text: string; savedAt: number };
type StoredSnapshotDraft = { version: 2; server: string; viewer: string; room: string; text: string; attachments: RoomDraftAttachment[]; savedAt: number };
type StoredDraft = StoredTextDraft | StoredSnapshotDraft;

function validText(text: string): boolean {
  return new TextEncoder().encode(text).byteLength <= MAX_BYTES;
}

function validAttachment(value: unknown): value is RoomDraftAttachment {
  if (!value || typeof value !== "object") return false;
  const attachment = value as Record<string, unknown>;
  const id = attachment.kind === "custody" ? attachment.custodyId : attachment.attachmentId;
  return !("uri" in attachment || "path" in attachment || "base64" in attachment || "data" in attachment)
    && (attachment.kind === "custody" || attachment.kind === "server")
    && typeof id === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(id)
    && typeof attachment.filename === "string" && attachment.filename.length > 0 && attachment.filename.length <= 255
    && typeof attachment.mimeType === "string" && /^[a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+$/.test(attachment.mimeType)
    && typeof attachment.sizeBytes === "number" && Number.isSafeInteger(attachment.sizeBytes) && attachment.sizeBytes > 0;
}

function validStored(scope: RoomDraftScope, value: unknown, now: number): value is StoredDraft {
  if (!value || typeof value !== "object") return false;
  const draft = value as StoredDraft;
  if ((draft.version !== 1 && draft.version !== 2) || draft.server !== tag(scope.serverId) || draft.viewer !== tag(scope.viewerId)
    || draft.room !== tag(scope.roomId) || typeof draft.text !== "string" || !validText(draft.text)
    || !Number.isFinite(draft.savedAt) || now - draft.savedAt > MAX_AGE_MS || draft.savedAt > now + 60_000) return false;
  return draft.version === 1 || (
    Array.isArray(draft.attachments)
    && draft.attachments.length <= MAX_CHAT_ATTACHMENTS_PER_MESSAGE
    && draft.attachments.every(validAttachment)
  );
}

function defaultStore(): RoomDraftStore {
  // Keep the pure custody contract testable in Bun; the native module is only
  // resolved when the production app actually persists a draft.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("expo-secure-store") as RoomDraftStore;
}

/** Validate and clear corrupt, expired, or wrong-identity records before exposing text. */
export async function consumeRoomDraft(
  scope: RoomDraftScope,
  store: RoomDraftStore = defaultStore(),
  now = Date.now(),
): Promise<string> {
  const key = roomDraftKey(scope);
  const raw = await store.getItemAsync(key);
  if (!raw) return "";
  try {
    const value = JSON.parse(raw) as StoredDraft;
    if (!validStored(scope, value, now)) {
      await store.deleteItemAsync(key);
      return "";
    }
    return value.text;
  } catch {
    await store.deleteItemAsync(key);
    return "";
  }
}

/** Empty text is an explicit durable discard; successful sends use the same path. */
export async function saveRoomDraft(
  scope: RoomDraftScope,
  text: string,
  store: RoomDraftStore = defaultStore(),
  now = Date.now(),
): Promise<"saved" | "discarded" | "too-large"> {
  const key = roomDraftKey(scope);
  if (!text) { await store.deleteItemAsync(key); return "discarded"; }
  // Clear the last snapshot so a process restart cannot restore misleading
  // old text after the visible draft outgrew encrypted local custody.
  if (!validText(text)) { await store.deleteItemAsync(key); return "too-large"; }
  const value: StoredTextDraft = { version: 1, server: tag(scope.serverId), viewer: tag(scope.viewerId), room: tag(scope.roomId), text, savedAt: now };
  await store.setItemAsync(key, JSON.stringify(value));
  return "saved";
}

/**
 * Future attachment drafts retain only opaque native-custody IDs and display
 * metadata. The Room send UI must upload and replace these IDs before it can
 * commit a message; this function never creates a sendable attachment ID.
 */
export async function saveRoomDraftSnapshot(
  scope: RoomDraftScope,
  snapshot: RoomDraftSnapshot,
  store: RoomDraftStore = defaultStore(),
  now = Date.now(),
): Promise<"saved" | "discarded" | "too-large"> {
  const key = roomDraftKey(scope);
  if (!snapshot.text && snapshot.attachments.length === 0) { await store.deleteItemAsync(key); return "discarded"; }
  if (!validText(snapshot.text) || snapshot.attachments.length > MAX_CHAT_ATTACHMENTS_PER_MESSAGE || !snapshot.attachments.every(validAttachment)) {
    await store.deleteItemAsync(key);
    return "too-large";
  }
  const value: StoredSnapshotDraft = {
    version: 2,
    server: tag(scope.serverId),
    viewer: tag(scope.viewerId),
    room: tag(scope.roomId),
    text: snapshot.text,
    attachments: [...snapshot.attachments],
    savedAt: now,
  };
  await store.setItemAsync(key, JSON.stringify(value));
  return "saved";
}

export async function consumeRoomDraftSnapshot(
  scope: RoomDraftScope,
  store: RoomDraftStore = defaultStore(),
  now = Date.now(),
): Promise<RoomDraftSnapshot> {
  const key = roomDraftKey(scope);
  const raw = await store.getItemAsync(key);
  if (!raw) return { text: "", attachments: [] };
  try {
    const value = JSON.parse(raw) as StoredDraft;
    if (!validStored(scope, value, now)) { await store.deleteItemAsync(key); return { text: "", attachments: [] }; }
    return { text: value.text, attachments: value.version === 2 ? value.attachments : [] };
  } catch {
    await store.deleteItemAsync(key);
    return { text: "", attachments: [] };
  }
}
