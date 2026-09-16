import { MAX_CHAT_ATTACHMENTS_PER_MESSAGE } from "@nautilo/types";

/**
 * Composer attachments shim.
 *
 * Attachments are file references the user has queued for the next
 * send — dragged from the Files/Workspace tree today; `@file` mentions
 * / paperclip picker later. The composer shows them as **chips** above
 * the textarea; the runtime reads them at **send time**, reads each
 * file metadata via the central D066 attachment gate on the server. The typed
 * text stays clean and the renderer never inlines raw file contents.
 *
 * Mirrors `file-context-ref.ts` — module-level store + subscribe, not
 * React context. The composer lives **inside** `NautiloRuntimeProvider`
 * in the tree, but we want the runtime's `sendText` to read composer
 * state without restructuring providers. The ref pattern is the
 * established way to cross that gap in this codebase.
 *
 * Persistence scope: in-memory; cleared automatically after every
 * successful send, and not persisted across app restart.
 */

export interface ComposerAttachment {
  /** Stable per-entry id (random). Chips key off this, not the path —
   *  duplicate paths are allowed (rare, but possible if the user
   *  drags the same file twice intentionally). */
  id: string;
  /** Absolute path to the file. */
  path: string;
  /** Tree root the chip was dragged from; scopes the relative label
   *  so the chip reads naturally
   *  ("drafts/foo.md" vs "/Users/…/Documents/Nautilo/drafts/foo.md"). */
  rootPath: string;
  /** Display name (basename of path). Cached so chip rendering
   *  doesn't need to re-parse on every render. */
  name: string;
  /** Size captured by native picker or desktop stat. Avoids guarded renderer stat for outside-root files. */
  sizeBytes?: number;
  /** Stat `mtimeMs` from native picker when available (desktop). */
  mtimeMs?: number;
  /** D271 — server attachmentId after the bytes are uploaded. Set when the
   *  chip's upload completes; the send path references this. */
  attachmentId?: string;
  /** UX state. The server-side D066 gate remains authoritative; this is for
   *  composer feedback only. */
  status?: "pending" | "queued" | "error";
  errorReason?: string;
}

type Listener = () => void;

const state: { items: ComposerAttachment[] } = { items: [] };
const listeners = new Set<Listener>();

function notify(): void {
  for (const l of listeners) l();
}

export function getAttachments(): readonly ComposerAttachment[] {
  return state.items;
}

export function addAttachment(att: ComposerAttachment): boolean {
  if (state.items.length >= MAX_CHAT_ATTACHMENTS_PER_MESSAGE) {
    return false;
  }
  state.items = [...state.items, { ...att, status: att.status ?? "queued" }];
  notify();
  return true;
}

export function updateAttachment(
  id: string,
  patch: { status?: ComposerAttachment["status"]; errorReason?: string | null; attachmentId?: string },
): void {
  let changed = false;
  state.items = state.items.map((att) => {
    if (att.id !== id) return att;
    changed = true;
    const next: ComposerAttachment = {
      ...att,
      ...(patch.status !== undefined ? { status: patch.status } : {}),
      ...(typeof patch.errorReason === "string" ? { errorReason: patch.errorReason } : {}),
      ...(patch.attachmentId !== undefined ? { attachmentId: patch.attachmentId } : {}),
    };
    if (patch.errorReason === null) {
      delete next.errorReason;
    }
    return next;
  });
  if (changed) notify();
}

export function removeAttachment(id: string): void {
  const next = state.items.filter((a) => a.id !== id);
  if (next.length === state.items.length) return;
  state.items = next;
  notify();
}

export function clearAttachments(): void {
  if (state.items.length === 0) return;
  state.items = [];
  notify();
}

/**
 * For `useSyncExternalStore`. Returns the current items array; the
 * array reference changes on every mutation so React sees a new
 * snapshot.
 */
export function subscribeAttachments(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function getAttachmentsSnapshot(): readonly ComposerAttachment[] {
  return state.items;
}

/** Random id utility kept here so call sites don't have to import crypto. */
export function newAttachmentId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `att-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
