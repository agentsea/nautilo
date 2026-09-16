/** Browser boundary for native Share extension handoff records. */
export type SharedTextIntent = {
  readonly id: string;
  readonly kind: "text" | "url";
  readonly value: string;
  readonly createdAt: string;
};
export type SharedRecordStore = { get(): Promise<unknown>; clear(): Promise<void> };
export type NativeSharedRecordStore = {
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
};
export type VerifiedShareOwner = { readonly serverId: string; readonly viewerId: string };

export const SHARED_TEXT_INTENT_MAX_BYTES = 1024;

export function consumeSharedTextIntent(_store: SharedRecordStore, _now?: number): Promise<null> {
  return Promise.resolve(null);
}

export function parseSharedTextIntent(_raw: unknown, _now?: number): null {
  return null;
}

export function stageNativeSharedTextIntent(
  _save: (intent: SharedTextIntent) => Promise<void>,
  _now?: number,
  _native?: NativeSharedRecordStore,
): Promise<null> {
  return Promise.resolve(null);
}

export function canOpenSharedTextDraft(_input: {
  readonly pending: SharedTextIntent | null;
  readonly owner: VerifiedShareOwner | null;
  readonly currentServerId: string | null;
  readonly currentViewerId: string | null;
  readonly roomId: string | null;
  readonly authorizedRoomIds: ReadonlySet<string>;
  readonly switchingServer: boolean;
}): false {
  return false;
}
