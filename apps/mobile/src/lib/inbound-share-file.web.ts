import type { InboundFileReceipt } from "@/lib/inbound-share-custody";

/** Browser builds cannot open or discard installed-app protected file receipts. */
export function openInboundShareFile(_receipt: InboundFileReceipt): Promise<never> {
  return Promise.reject(new Error("Native shared files require the installed Mobile app."));
}

export function discardInboundShareFile(_receipt: InboundFileReceipt): Promise<void> {
  return Promise.resolve();
}

export function getNativeInboundShareStore(): Promise<null> {
  return Promise.resolve(null);
}
