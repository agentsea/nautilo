/**
 * upload a composer attachment's bytes and patch the chip with the
 * resulting server `attachmentId`. Shared by every attach entry point
 * (paperclip now; drag-drop next) so there is ONE ingestion path.
 */
import { apiClient } from "./api";
import { updateAttachment } from "../adapters/composer-attachments-ref";

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

async function uploadBlob(
  id: string,
  blob: Blob,
  filename: string,
  opts?: { roomId?: string | null },
): Promise<void> {
  try {
    const res = await apiClient.uploadMessageAttachment(blob, filename, {
      ...(opts?.roomId ? { roomId: opts.roomId } : {}),
    });
    updateAttachment(id, { status: "queued", errorReason: null, attachmentId: res.attachmentId });
  } catch (err) {
    const msg = err instanceof Error ? err.message : "Attachment upload failed";
    updateAttachment(id, { status: "error", errorReason: msg });
  }
}

/** Upload an OS/browser File or Blob for chip `id`. */
export async function uploadComposerBlob(
  id: string,
  blob: Blob,
  filename: string,
  opts?: { roomId?: string | null },
): Promise<void> {
  await uploadBlob(id, blob, filename, opts);
}

/**
 * Upload base64 bytes for chip `id`. Used by the Electron native picker and
 * internal tree drags where the renderer reads via the desktop bridge.
 */
export async function uploadComposerAttachment(
  id: string,
  file: { name: string; base64: string },
  opts?: { roomId?: string | null },
): Promise<void> {
  try {
    const result = await uploadPickedAttachment(file, opts);
    updateAttachment(id, { status: "queued", errorReason: null, attachmentId: result.attachmentId });
  } catch (error) {
    updateAttachment(id, { status: "error", errorReason: error instanceof Error ? error.message : "Attachment upload failed" });
  }
}

/** Shared native-picker ingestion; each composer retains its own Room-bound queue. */
export function uploadPickedAttachment(file: { name: string; base64: string }, opts?: { roomId?: string | null }) {
  const bytes = base64ToBytes(file.base64);
  return apiClient.uploadMessageAttachment(new Blob([bytes.buffer as ArrayBuffer]), file.name, {
    ...(opts?.roomId ? { roomId: opts.roomId } : {}),
  });
}
