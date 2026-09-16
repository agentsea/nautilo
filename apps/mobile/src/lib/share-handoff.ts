/** Main-app boundary for the bounded iOS App Group record; no auth or network. */
export type SharedTextIntent = { readonly id: string; readonly kind: "text" | "url"; readonly value: string; readonly createdAt: string };
export type SharedRecordStore = { get(): Promise<unknown>; clear(): Promise<void> };
export type NativeSharedRecordStore = {
  peekAsync(): Promise<unknown>;
  ackAsync(id: string): Promise<boolean>;
  clearAsync(): Promise<void>;
};
/**
 * The one intake size bound: pending custody and the ordinary recoverable
 * composer draft must agree. Do not accept a native record which the only
 * review/send path cannot preserve.
 */
export const SHARED_TEXT_INTENT_MAX_BYTES = 1024;
const MAX_AGE_MS = 10 * 60 * 1000;
let tail = Promise.resolve();

/**
 * Consume-clear is serialized before validation. A malformed, expired, or
 * duplicate extension handoff cannot be replayed after app restart.
 */
export function consumeSharedTextIntent(store: SharedRecordStore, now = Date.now()): Promise<SharedTextIntent | null> {
  const work = tail.then(async (): Promise<SharedTextIntent | null> => {
    const raw = await store.get();
    await store.clear();
    return parseSharedTextIntent(raw, now);
  });
  tail = work.then(() => {}, () => {});
  return work;
}

export function parseSharedTextIntent(raw: unknown, now = Date.now()): SharedTextIntent | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.version !== 1 || typeof record.id !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(record.id) ||
    (record.kind !== "text" && record.kind !== "url") || typeof record.value !== "string" ||
    new TextEncoder().encode(record.value).byteLength > SHARED_TEXT_INTENT_MAX_BYTES || typeof record.createdAt !== "string") return null;
  const createdAt = Date.parse(record.createdAt);
  if (!Number.isFinite(createdAt) || createdAt > now + 60_000 || now - createdAt > MAX_AGE_MS) return null;
  return { id: record.id, kind: record.kind, value: record.value, createdAt: record.createdAt };
}

/**
 * Native custody is acknowledged only after encrypted JS custody commits.
 * A crash or SecureStore failure therefore leaves the native record available
 * for the next launch instead of silently losing the user's share.
 */
export async function stageNativeSharedTextIntent(
  save: (intent: SharedTextIntent) => Promise<void>,
  now = Date.now(),
  injectedNative?: NativeSharedRecordStore,
): Promise<SharedTextIntent | null> {
  const NautiloShareHandoff = injectedNative
    ?? (await import("../../modules/nautilo-share-handoff")).default;
  const raw = await NautiloShareHandoff.peekAsync();
  const intent = parseSharedTextIntent(raw, now);
  if (!intent) {
    if (raw !== null && raw !== undefined) await NautiloShareHandoff.clearAsync();
    return null;
  }
  await save(intent);
  // Returning a staged item when its native receipt was not actually
  // acknowledged would let a later lifecycle tick restage a payload after
  // the user had discarded/reviewed it. Keep both copies instead and make
  // the handoff retryable; no payload is shown or sent from this attempt.
  if (!await NautiloShareHandoff.ackAsync(intent.id)) {
    throw new Error("Native share handoff acknowledgement did not commit");
  }
  return intent;
}

export type VerifiedShareOwner = {
  readonly serverId: string;
  readonly viewerId: string;
};

/**
 * A device-only native intake has no authenticated owner yet. It becomes an
 * actionable Room draft only after this exact current server/viewer pair has
 * freshly loaded an authorized Room. Keep this pure so every server-switch
 * race has one deterministic admission rule.
 */
export function canOpenSharedTextDraft(input: {
  readonly pending: SharedTextIntent | null;
  readonly owner: VerifiedShareOwner | null;
  readonly currentServerId: string | null;
  readonly currentViewerId: string | null;
  readonly roomId: string | null;
  readonly authorizedRoomIds: ReadonlySet<string>;
  readonly switchingServer: boolean;
}): boolean {
  return input.pending !== null
    && input.owner !== null
    && input.owner.serverId === input.currentServerId
    && input.owner.viewerId === input.currentViewerId
    && input.roomId !== null
    && input.authorizedRoomIds.has(input.roomId)
    && !input.switchingServer;
}
