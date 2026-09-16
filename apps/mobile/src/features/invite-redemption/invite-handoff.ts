/**
 * Bounded custody for the native invite ceremony's unavoidable bearer data.
 *
 * This is intentionally not the server-token store and never falls back to
 * AsyncStorage.  The record exists only to bridge the external Logto hop and
 * is keyed to one exact server identity.  Access/refresh tokens, PINs,
 * display names, recovery codes, and navigation state must not enter it.
 */
import { HANDLE_RE, normalizeHandle } from "@nautilo/types";

import type { ResumableCeremonyStage } from "./invite-ceremony";
import { normalizeInviteServerOrigin } from "@/lib/server-url";

export const INVITE_HANDOFF_VERSION = 1 as const;
export const MAX_INVITE_HANDOFF_TTL_MS = 30 * 60 * 1000;

const HANDOFF_KEY_PREFIX = "nautilo.invite-handoff.v1.";
const CALLBACK_LOCATOR_KEY = "nautilo.invite-callback-locator.v1";
const KEY_SAFE_SERVER_ID_RE = /^[A-Za-z0-9._-]+$/;
const KEY_SAFE_CEREMONY_ID_RE = /^[A-Za-z0-9._-]+$/;
const MAX_CALLBACK_SERVER_ID_LENGTH = 600;
const MAX_CALLBACK_SERVER_URL_LENGTH = 512;
const MAX_CALLBACK_CEREMONY_ID_LENGTH = 128;
const MAX_CALLBACK_GENERATION_DIGITS = 15;
const INVITE_TOKEN_RE = /^inv_[A-Za-z0-9_-]+$/;
const OPAQUE_VALUE_MAX_LENGTH = 1_400;
const MAX_SERIALIZED_HANDOFF_LENGTH = 1_900;
const RESUMABLE_STAGES: readonly ResumableCeremonyStage[] = [
  "preview",
  "external-auth",
  "binding",
  "profile",
];

export interface InviteHandoffStorage {
  setItemAsync(key: string, value: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface InviteHandoffServer {
  serverId: string;
  /** Must already be an exact normalized HTTP(S) origin. */
  serverUrl: string;
}

/**
 * Persisted only to resume a cold OAuth callback. It is deliberately route
 * correlation, not a credential: the invite bearer remains in its per-server
 * handoff record and never crosses this API.
 */
export interface InviteCallbackLocator extends InviteHandoffServer {
  generation: string;
  ceremonyId: string;
}

/**
 * The only values permitted to cross the native external-auth boundary.
 * `prepareState` is dropped as soon as the bind has succeeded (the profile
 * stage needs the invite token and authenticated session, not this state).
 */
export interface InviteHandoffInput extends InviteHandoffServer {
  inviteToken: string;
  prepareState: string | null;
  /** Canonical lower-case handle, or null before choosing one. */
  handle: string | null;
  stage: ResumableCeremonyStage;
  startedAt: number;
  /** Absolute server-advertised invite expiry, when the preview gave one. */
  inviteExpiresAt: number | null;
}

export interface InviteHandoffRecord extends InviteHandoffServer {
  version: typeof INVITE_HANDOFF_VERSION;
  inviteToken: string;
  prepareState: string | null;
  handle: string | null;
  stage: ResumableCeremonyStage;
  startedAt: number;
  expiresAt: number;
}

export type InviteHandoffClearReason =
  | "success"
  | "terminal-failure"
  | "server-mismatch"
  | "expiry"
  | "cancelled"
  | "retryable-network";

export class InviteHandoffError extends Error {
  constructor(message = "Invite handoff could not be secured.") {
    super(message);
    this.name = "InviteHandoffError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isFiniteEpoch(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0;
}

function isResumableStage(value: unknown): value is ResumableCeremonyStage {
  return typeof value === "string" && RESUMABLE_STAGES.includes(value as ResumableCeremonyStage);
}

function validServer(server: InviteHandoffServer): boolean {
  return (
    typeof server.serverId === "string" &&
    KEY_SAFE_SERVER_ID_RE.test(server.serverId) &&
    typeof server.serverUrl === "string" &&
    normalizeInviteServerOrigin(server.serverUrl) === server.serverUrl
  );
}

function validCallbackLocator(locator: InviteCallbackLocator): boolean {
  return validServer(locator)
    && locator.serverId.length <= MAX_CALLBACK_SERVER_ID_LENGTH
    && locator.serverUrl.length <= MAX_CALLBACK_SERVER_URL_LENGTH
    && typeof locator.generation === "string"
    && locator.generation.length <= MAX_CALLBACK_GENERATION_DIGITS
    && /^[1-9]\d*$/.test(locator.generation)
    && Number.isSafeInteger(Number(locator.generation))
    && typeof locator.ceremonyId === "string"
    && locator.ceremonyId.length > 0
    && locator.ceremonyId.length <= MAX_CALLBACK_CEREMONY_ID_LENGTH
    && KEY_SAFE_CEREMONY_ID_RE.test(locator.ceremonyId);
}

function validHandle(value: unknown): value is string {
  return typeof value === "string" && normalizeHandle(value) === value && HANDLE_RE.test(value);
}

function validOpaqueValue(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= OPAQUE_VALUE_MAX_LENGTH;
}

function validStageFields(
  stage: ResumableCeremonyStage,
  prepareState: unknown,
  handle: unknown,
): boolean {
  switch (stage) {
    case "preview":
      return prepareState === null && handle === null;
    case "external-auth":
    case "binding":
      return validOpaqueValue(prepareState) && validHandle(handle);
    case "profile":
      return prepareState === null && validHandle(handle);
  }
}

function sameRecord(left: InviteHandoffRecord, right: InviteHandoffRecord): boolean {
  return (
    left.version === right.version &&
    left.serverId === right.serverId &&
    left.serverUrl === right.serverUrl &&
    left.inviteToken === right.inviteToken &&
    left.prepareState === right.prepareState &&
    left.handle === right.handle &&
    left.stage === right.stage &&
    left.startedAt === right.startedAt &&
    left.expiresAt === right.expiresAt
  );
}

/** Returns null rather than manufacturing a SecureStore key from unsafe input. */
export function inviteHandoffKey(serverId: string): string | null {
  return typeof serverId === "string" && KEY_SAFE_SERVER_ID_RE.test(serverId)
    ? `${HANDOFF_KEY_PREFIX}${serverId}`
    : null;
}

/** Only retryable transport failure retains a record; all other exits erase it. */
function shouldClearInviteHandoff(reason: InviteHandoffClearReason): boolean {
  return reason !== "retryable-network";
}

/**
 * Produce the schema-owned record and lifetime.  The caller must pass a
 * server preview expiry as an epoch timestamp, never an arbitrary string.
 */
export function createInviteHandoffRecord(
  input: InviteHandoffInput,
  now = Date.now(),
): InviteHandoffRecord {
  if (!validServer(input) || !inviteHandoffKey(input.serverId)) {
    throw new InviteHandoffError("Invite handoff has an invalid server identity.");
  }
  if (typeof input.inviteToken !== "string" || !INVITE_TOKEN_RE.test(input.inviteToken)) {
    throw new InviteHandoffError("Invite handoff has an invalid invite locator.");
  }
  if (!isResumableStage(input.stage) || !validStageFields(input.stage, input.prepareState, input.handle)) {
    throw new InviteHandoffError("Invite handoff has an invalid ceremony stage.");
  }
  if (!isFiniteEpoch(input.startedAt) || !isFiniteEpoch(now) || input.startedAt > now) {
    throw new InviteHandoffError("Invite handoff has an invalid start time.");
  }
  if (input.inviteExpiresAt !== null && !isFiniteEpoch(input.inviteExpiresAt)) {
    throw new InviteHandoffError("Invite handoff has an invalid invite expiry.");
  }

  const expiresAt = Math.min(
    input.startedAt + MAX_INVITE_HANDOFF_TTL_MS,
    input.inviteExpiresAt ?? Number.POSITIVE_INFINITY,
  );
  if (!Number.isFinite(expiresAt) || expiresAt <= now) {
    throw new InviteHandoffError("Invite handoff is already expired.");
  }

  return {
    version: INVITE_HANDOFF_VERSION,
    serverId: input.serverId,
    serverUrl: input.serverUrl,
    inviteToken: input.inviteToken,
    prepareState: input.prepareState,
    handle: input.handle,
    stage: input.stage,
    startedAt: input.startedAt,
    expiresAt,
  };
}

/**
 * Pure serializer.  It constructs the exact allow-listed schema rather than
 * spreading caller input, so accidental credentials or UI state cannot ride
 * along with the handoff.
 */
export function serializeInviteHandoff(record: InviteHandoffRecord): string {
  const verified = createInviteHandoffRecord(
    {
      serverId: record.serverId,
      serverUrl: record.serverUrl,
      inviteToken: record.inviteToken,
      prepareState: record.prepareState,
      handle: record.handle,
      stage: record.stage,
      startedAt: record.startedAt,
      inviteExpiresAt: record.expiresAt,
    },
    record.startedAt,
  );
  if (verified.version !== record.version || verified.expiresAt !== record.expiresAt) {
    throw new InviteHandoffError("Invite handoff has an invalid lifetime.");
  }
  const serialized = JSON.stringify({
    version: verified.version,
    serverId: verified.serverId,
    serverUrl: verified.serverUrl,
    inviteToken: verified.inviteToken,
    prepareState: verified.prepareState,
    handle: verified.handle,
    stage: verified.stage,
    startedAt: verified.startedAt,
    expiresAt: verified.expiresAt,
  });
  if (serialized.length > MAX_SERIALIZED_HANDOFF_LENGTH) {
    throw new InviteHandoffError("Invite handoff exceeds secure storage bounds.");
  }
  return serialized;
}

/**
 * Pure, fail-closed parser.  `expectedServer` binds both key identity and
 * normalized origin before secret fields can be returned to the ceremony.
 */
export function parseInviteHandoff(
  raw: string,
  expectedServer: InviteHandoffServer,
  now = Date.now(),
): InviteHandoffRecord | null {
  if (!validServer(expectedServer) || raw.length > MAX_SERIALIZED_HANDOFF_LENGTH) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const expectedKeys = [
    "expiresAt",
    "handle",
    "inviteToken",
    "prepareState",
    "serverId",
    "serverUrl",
    "stage",
    "startedAt",
    "version",
  ];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  if (parsed.version !== INVITE_HANDOFF_VERSION) return null;
  if (parsed.serverId !== expectedServer.serverId || parsed.serverUrl !== expectedServer.serverUrl) return null;
  if (typeof parsed.inviteToken !== "string" || !INVITE_TOKEN_RE.test(parsed.inviteToken)) return null;
  if (!isResumableStage(parsed.stage) || !validStageFields(parsed.stage, parsed.prepareState, parsed.handle)) return null;
  if (!isFiniteEpoch(parsed.startedAt) || !isFiniteEpoch(parsed.expiresAt)) return null;
  if (parsed.startedAt > now || parsed.expiresAt <= now) return null;
  if (parsed.expiresAt > parsed.startedAt + MAX_INVITE_HANDOFF_TTL_MS) return null;

  return {
    version: INVITE_HANDOFF_VERSION,
    serverId: parsed.serverId,
    serverUrl: parsed.serverUrl,
    inviteToken: parsed.inviteToken,
    prepareState: parsed.prepareState as string | null,
    handle: parsed.handle as string | null,
    stage: parsed.stage,
    startedAt: parsed.startedAt,
    expiresAt: parsed.expiresAt,
  };
}

async function defaultInviteHandoffStorage(): Promise<InviteHandoffStorage> {
  // Keep native-module loading out of Bun's pure tests. In app builds this is
  // Expo SecureStore, the only production persistence backend for this data.
  const SecureStore = await import("expo-secure-store");
  return SecureStore;
}

async function deleteQuietly(storage: InviteHandoffStorage, key: string): Promise<void> {
  try {
    await storage.deleteItemAsync(key);
  } catch {
    // A failed cleanup must not disclose or replace the original custody error.
  }
}

function parseInviteCallbackLocator(raw: string): InviteCallbackLocator | null {
  if (raw.length > 1_400) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const keys = Object.keys(parsed).sort();
  const expectedKeys = ["ceremonyId", "generation", "serverId", "serverUrl"];
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) return null;
  const locator: InviteCallbackLocator = {
    serverId: parsed.serverId as string,
    serverUrl: parsed.serverUrl as string,
    generation: parsed.generation as string,
    ceremonyId: parsed.ceremonyId as string,
  };
  return validCallbackLocator(locator) ? locator : null;
}

function sameCallbackLocator(left: InviteCallbackLocator, right: InviteCallbackLocator): boolean {
  return left.serverId === right.serverId
    && left.serverUrl === right.serverUrl
    && left.generation === right.generation
    && left.ceremonyId === right.ceremonyId;
}

export async function saveInviteCallbackLocator(
  locator: InviteCallbackLocator,
  storage?: InviteHandoffStorage,
): Promise<void> {
  if (!validCallbackLocator(locator)) throw new InviteHandoffError("Invite callback has invalid route correlation.");
  const resolvedStorage = storage ?? await defaultInviteHandoffStorage();
  const serialized = JSON.stringify({
    serverId: locator.serverId,
    serverUrl: locator.serverUrl,
    generation: locator.generation,
    ceremonyId: locator.ceremonyId,
  });
  try {
    await resolvedStorage.setItemAsync(CALLBACK_LOCATOR_KEY, serialized);
    const persisted = await resolvedStorage.getItemAsync(CALLBACK_LOCATOR_KEY);
    if (!persisted || !sameCallbackLocator(locator, parseInviteCallbackLocator(persisted) ?? ({} as InviteCallbackLocator))) {
      throw new InviteHandoffError("Invite callback verification failed.");
    }
  } catch (error) {
    await deleteQuietly(resolvedStorage, CALLBACK_LOCATOR_KEY);
    if (error instanceof InviteHandoffError) throw error;
    throw new InviteHandoffError("Invite callback could not be secured.");
  }
}

/** Invalid callback correlation is erased rather than guessed after a cold return. */
export async function loadInviteCallbackLocator(
  storage?: InviteHandoffStorage,
): Promise<InviteCallbackLocator | null> {
  const resolvedStorage = storage ?? await defaultInviteHandoffStorage();
  let raw: string | null;
  try {
    raw = await resolvedStorage.getItemAsync(CALLBACK_LOCATOR_KEY);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const locator = parseInviteCallbackLocator(raw);
  if (locator) return locator;
  await deleteQuietly(resolvedStorage, CALLBACK_LOCATOR_KEY);
  return null;
}

/** Never clear a newer callback's correlation during an older settlement. */
export async function clearInviteCallbackLocator(
  expected: InviteCallbackLocator | null = null,
  storage?: InviteHandoffStorage,
): Promise<void> {
  const resolvedStorage = storage ?? await defaultInviteHandoffStorage();
  if (!expected) {
    await resolvedStorage.deleteItemAsync(CALLBACK_LOCATOR_KEY);
    return;
  }
  const current = await loadInviteCallbackLocator(resolvedStorage);
  if (current && sameCallbackLocator(current, expected)) {
    await resolvedStorage.deleteItemAsync(CALLBACK_LOCATOR_KEY);
  }
}

export async function saveInviteHandoff(
  input: InviteHandoffInput,
  options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<InviteHandoffRecord> {
  const now = options.now ?? Date.now();
  const record = createInviteHandoffRecord(input, now);
  const key = inviteHandoffKey(record.serverId);
  if (!key) throw new InviteHandoffError("Invite handoff has an invalid server identity.");
  const storage = options.storage ?? await defaultInviteHandoffStorage();
  try {
    const serialized = serializeInviteHandoff(record);
    await storage.setItemAsync(key, serialized);
    const persisted = await storage.getItemAsync(key);
    const verified = persisted === null ? null : parseInviteHandoff(persisted, record, now);
    if (!verified || !sameRecord(record, verified)) {
      throw new InviteHandoffError("Invite handoff verification failed.");
    }
    return verified;
  } catch (error) {
    await deleteQuietly(storage, key);
    if (error instanceof InviteHandoffError) throw error;
    throw new InviteHandoffError();
  }
}

/** Invalid, expired, version-mismatched, or cross-server bytes are erased. */
export async function loadInviteHandoff(
  expectedServer: InviteHandoffServer,
  options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<InviteHandoffRecord | null> {
  const key = inviteHandoffKey(expectedServer.serverId);
  if (!key || !validServer(expectedServer)) return null;
  const storage = options.storage ?? await defaultInviteHandoffStorage();
  let raw: string | null;
  try {
    raw = await storage.getItemAsync(key);
  } catch {
    return null;
  }
  if (raw === null) return null;
  const handoff = parseInviteHandoff(raw, expectedServer, options.now ?? Date.now());
  if (handoff) return handoff;
  await deleteQuietly(storage, key);
  return null;
}

/**
 * Callback recovery may observe only the persisted ceremony phase.  It never
 * returns the invite bearer, preparation state, or profile values that the
 * full ceremony loader keeps inside its narrow async closure.
 */
export async function peekInviteHandoffStage(
  expectedServer: InviteHandoffServer,
  options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<ResumableCeremonyStage | null> {
  const handoff = await loadInviteHandoff(expectedServer, options);
  return handoff?.stage ?? null;
}

export async function clearInviteHandoff(
  serverId: string,
  storage?: InviteHandoffStorage,
): Promise<void> {
  const key = inviteHandoffKey(serverId);
  if (!key) return;
  const resolvedStorage = storage ?? await defaultInviteHandoffStorage();
  await resolvedStorage.deleteItemAsync(key);
}

/** Applies the ceremony's retention policy at every terminal/retry boundary. */
export async function settleInviteHandoff(
  serverId: string,
  reason: InviteHandoffClearReason,
  storage?: InviteHandoffStorage,
): Promise<"retained" | "cleared"> {
  if (!shouldClearInviteHandoff(reason)) return "retained";
  await clearInviteHandoff(serverId, storage);
  return "cleared";
}
