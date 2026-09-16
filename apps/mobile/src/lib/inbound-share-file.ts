import { File } from "expo-file-system";

import type { InboundFileReceipt } from "@/lib/inbound-share-custody";

type NativeInboundFileModule = {
  peekInboundFileAsync(): Promise<unknown>;
  ackInboundFileAsync(id: string): Promise<boolean>;
  discardInboundFileAsync(nativeReceiptId: string): Promise<boolean>;
  openInboundFileAsync(nativeReceiptId: string): Promise<unknown>;
};

function validOpaqueId(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9-]{8,80}$/.test(value);
}

async function nativeModule(): Promise<NativeInboundFileModule> {
  const module = (await import("../../modules/nautilo-share-handoff")).default as unknown as NativeInboundFileModule;
  if (
    typeof module.peekInboundFileAsync !== "function"
    || typeof module.ackInboundFileAsync !== "function"
    || typeof module.discardInboundFileAsync !== "function"
    || typeof module.openInboundFileAsync !== "function"
  ) throw new Error("This build does not support file sharing yet");
  return module;
}

/**
 * Opens the native, app-private receipt only at explicit upload time. The
 * content URI remains transient in memory and never enters SecureStore/drafts.
 */
export async function openInboundShareFile(receipt: InboundFileReceipt): Promise<Blob> {
  const opened = await (await nativeModule()).openInboundFileAsync(receipt.nativeReceiptId);
  if (!opened || typeof opened !== "object" || typeof (opened as { contentUri?: unknown }).contentUri !== "string") {
    throw new Error("The shared file is no longer available");
  }
  const contentUri = (opened as { contentUri: string }).contentUri;
  if (!contentUri.startsWith("content://") && !contentUri.startsWith("file://")) {
    throw new Error("The shared file handle was invalid");
  }
  // Expo File preserves a content:// URI as a read-only native stream. This
  // cast matches the API client's Blob-shaped multipart boundary; no bytes are
  // materialized as JS strings or persisted here.
  return new File(contentUri) as unknown as Blob;
}

export async function discardInboundShareFile(receipt: InboundFileReceipt): Promise<void> {
  if (!validOpaqueId(receipt.nativeReceiptId)) return;
  await (await nativeModule()).discardInboundFileAsync(receipt.nativeReceiptId);
}

/** Adapter used by the inbound provider's generic metadata-custody seam. */
export async function getNativeInboundShareStore(): Promise<{
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
} | null> {
  let native: NativeInboundFileModule;
  try { native = await nativeModule(); } catch { return null; }
  let lastPeek: unknown;
  return {
    peekAsync: async () => {
      lastPeek = await native.peekInboundFileAsync();
      return lastPeek;
    },
    ackAsync: (id) => native.ackInboundFileAsync(id),
    clearAsync: async () => {
      // Invalid native metadata is not a valid payload. If it exposes a
      // syntactically safe opaque receipt id, discard its protected bytes;
      // otherwise native expiry remains the conservative terminal cleanup.
      const nativeReceiptId = lastPeek && typeof lastPeek === "object"
        ? (lastPeek as { nativeReceiptId?: unknown }).nativeReceiptId
        : undefined;
      if (validOpaqueId(nativeReceiptId)) await native.discardInboundFileAsync(nativeReceiptId);
    },
  };
}
