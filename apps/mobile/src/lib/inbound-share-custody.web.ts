/** Browser boundary: native Share extension file receipts do not exist on Web. */
export type InboundShareScope = { readonly serverId: string; readonly viewerId: string };
export type InboundFileReceipt = {
  readonly id: string;
  readonly nativeReceiptId: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly createdAt: string;
};
export type InboundShareCustodyStore = {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string, options?: { keychainAccessible?: number }): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
};
export type NativeInboundFileReceiptStore = {
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
};

export const INBOUND_SHARE_CUSTODY_DEVICE_KEY = null;
export const INBOUND_SHARE_MAX_AGE_MS = 10 * 60 * 1000;
export const INBOUND_SHARE_MAX_BYTES = 100 * 1024 * 1024;

const unavailable = () => new Error("Native Share receipt custody requires the installed Mobile app.");

export function saveInboundShareReceipt(
  _receipt: InboundFileReceipt,
  _scope: InboundShareScope | null,
  _store?: InboundShareCustodyStore,
  _now?: number,
): Promise<never> {
  return Promise.reject(unavailable());
}

export function claimInboundShareReceipt(
  _scope: InboundShareScope,
  _store?: InboundShareCustodyStore,
  _now?: number,
): Promise<null> {
  return Promise.resolve(null);
}

export function clearInboundShareReceipt(_store?: InboundShareCustodyStore): Promise<void> {
  return Promise.resolve();
}

export function clearInboundShareReceiptForScope(
  _scope: InboundShareScope,
  _store?: InboundShareCustodyStore,
  _now?: number,
): Promise<void> {
  return Promise.resolve();
}

export function clearInboundShareReceiptForServer(
  _serverId: string,
  _store?: InboundShareCustodyStore,
  _now?: number,
): Promise<void> {
  return Promise.resolve();
}

export function stageNativeInboundFileReceipt(
  _save: (receipt: InboundFileReceipt) => Promise<void>,
  _now?: number,
  _native?: NativeInboundFileReceiptStore,
): Promise<null> {
  return Promise.resolve(null);
}
