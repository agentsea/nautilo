/**
 * Browser boundary for the installed app's native invite handoff.
 *
 * Mobile Web v1 does not emulate this bearer custody in localStorage or
 * sessionStorage. Ordinary browser OIDC remains available through AuthProvider;
 * native invite restoration fails closed until a separate Web contract exists.
 */
import type { ResumableCeremonyStage } from "./invite-ceremony";

export const INVITE_HANDOFF_VERSION = 1 as const;
export const MAX_INVITE_HANDOFF_TTL_MS = 30 * 60 * 1000;

export interface InviteHandoffStorage {
  setItemAsync(key: string, value: string): Promise<void>;
  getItemAsync(key: string): Promise<string | null>;
  deleteItemAsync(key: string): Promise<void>;
}

export interface InviteHandoffServer {
  serverId: string;
  serverUrl: string;
}

export interface InviteCallbackLocator extends InviteHandoffServer {
  generation: string;
  ceremonyId: string;
}

export interface InviteHandoffInput extends InviteHandoffServer {
  inviteToken: string;
  prepareState: string | null;
  handle: string | null;
  stage: ResumableCeremonyStage;
  startedAt: number;
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
  constructor() {
    super("Invite handoff requires the installed Mobile app.");
    this.name = "InviteHandoffError";
  }
}

export function inviteHandoffKey(_serverId: string): null {
  return null;
}

export function shouldClearInviteHandoff(reason: InviteHandoffClearReason): boolean {
  return reason !== "retryable-network";
}

export function createInviteHandoffRecord(
  _input: InviteHandoffInput,
  _now?: number,
): never {
  throw new InviteHandoffError();
}

export function serializeInviteHandoff(_record: InviteHandoffRecord): never {
  throw new InviteHandoffError();
}

export function parseInviteHandoff(
  _serialized: string,
  _expectedServer: InviteHandoffServer,
  _now?: number,
): null {
  return null;
}

export function saveInviteCallbackLocator(
  _locator: InviteCallbackLocator,
  _storage?: InviteHandoffStorage,
): Promise<never> {
  return Promise.reject(new InviteHandoffError());
}

export function loadInviteCallbackLocator(
  _storage?: InviteHandoffStorage,
): Promise<null> {
  return Promise.resolve(null);
}

export function clearInviteCallbackLocator(
  _expected: InviteCallbackLocator | null = null,
  _storage?: InviteHandoffStorage,
): Promise<void> {
  return Promise.resolve();
}

export function saveInviteHandoff(
  _input: InviteHandoffInput,
  _options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<never> {
  return Promise.reject(new InviteHandoffError());
}

export function loadInviteHandoff(
  _expectedServer: InviteHandoffServer,
  _options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<null> {
  return Promise.resolve(null);
}

export function peekInviteHandoffStage(
  _expectedServer: InviteHandoffServer,
  _options: Readonly<{ storage?: InviteHandoffStorage; now?: number }> = {},
): Promise<null> {
  return Promise.resolve(null);
}

export function clearInviteHandoff(
  _serverId: string,
  _storage?: InviteHandoffStorage,
): Promise<void> {
  return Promise.resolve();
}

export function settleInviteHandoff(
  _serverId: string,
  reason: InviteHandoffClearReason,
  _storage?: InviteHandoffStorage,
): Promise<"retained" | "cleared"> {
  return Promise.resolve(shouldClearInviteHandoff(reason) ? "cleared" : "retained");
}
