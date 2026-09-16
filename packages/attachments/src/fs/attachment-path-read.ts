import { open } from "node:fs/promises";

export type BoundedPrefixRead = { ok: true; bytes: Uint8Array } | { ok: false };

/**
 * Bounded prefix read for magic sniffing. Never throws — missing/unreadable files → `{ ok: false }`.
 * Uses a single open/read sequence on one handle.
 */
export async function readAttachmentHeadPrefix(
  filePath: string,
  maxBytes: number,
): Promise<BoundedPrefixRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch {
    return { ok: false };
  }
  try {
    const buf = new Uint8Array(maxBytes);
    const { bytesRead } = await handle.read(buf, 0, maxBytes, 0);
    return { ok: true, bytes: buf.subarray(0, bytesRead) };
  } catch {
    return { ok: false };
  } finally {
    await handle.close().catch(() => {});
  }
}

export type VerifiedAttachmentRead =
  | { ok: true; bytes: Buffer; size: number }
  | {
      ok: false;
      code: "open_failed" | "size_mismatch" | "short_read" | "read_failed";
      message: string;
    };

/**
 * Single-handle read: open → fstat → enforce size matches expected → read.
 * Never throws — maps fs failures to `{ ok: false, ... }`.
 */
export async function readAttachmentBytesVerifiedSize(
  filePath: string,
  expectedSize: number,
): Promise<VerifiedAttachmentRead> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(filePath, "r");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, code: "open_failed", message: msg };
  }

  try {
    let st;
    try {
      st = await handle.stat();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "read_failed", message: msg };
    }
    if (st.size !== expectedSize) {
      return {
        ok: false,
        code: "size_mismatch",
        message: "Attachment size changed before server read",
      };
    }
    const buf = Buffer.allocUnsafe(expectedSize);
    let bytesRead: number;
    try {
      const r = await handle.read(buf, 0, expectedSize, 0);
      bytesRead = r.bytesRead;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, code: "read_failed", message: msg };
    }
    if (bytesRead !== expectedSize) {
      return {
        ok: false,
        code: "short_read",
        message: "Attachment read ended before expected byte count",
      };
    }
    return { ok: true, bytes: buf, size: expectedSize };
  } finally {
    await handle.close().catch(() => {});
  }
}
