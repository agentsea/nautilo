/**
 * The one native boundary for an invite locator before the ceremony route.
 *
 * Sources parse a locator exactly once with `parseDeepLink`, then hand the
 * tagged result here. The only bearer is written to the bounded SecureStore
 * handoff before this module emits a route. Navigation receives correlation
 * values only — never a bearer or a prepare-state.
 */
import type { ParsedDeepLink } from "@/lib/deep-link";
import { parseDeepLink } from "@/lib/deep-link";
import { normalizeInviteServerOrigin } from "@/lib/server-url";

import {
  clearInviteCallbackLocator,
  clearInviteHandoff,
  saveInviteCallbackLocator,
  saveInviteHandoff,
  type InviteHandoffClearReason,
  type InviteHandoffInput,
} from "./invite-handoff";
import type { CeremonyRef } from "./invite-ceremony";

export type InviteIntakeSource = "deep-link" | "qr" | "manual";

const MAX_INVITE_ROUTE_SERVER_URL_LENGTH = 512;
const MAX_INVITE_ROUTE_SERVER_ID_LENGTH = 600;
const MAX_INVITE_CEREMONY_ID_LENGTH = 128;
const KEY_SAFE_VALUE_RE = /^[A-Za-z0-9._-]+$/;
const MAX_GENERATION_DIGITS = 15;

export type InviteRouteParams = Readonly<{
  serverUrl: string;
  serverId: string;
  generation: string;
  ceremonyId: string;
}>;

export type InviteRoute = Readonly<{
  pathname: "/(onboarding)/invite";
  params: InviteRouteParams;
}>;

export type InviteIntakeResult =
  | Readonly<{ kind: "accepted"; route: InviteRoute }>
  | Readonly<{ kind: "duplicate" }>
  | Readonly<{ kind: "invalid"; message: string }>
  | Readonly<{ kind: "persistence-failed"; message: string }>;

type ActiveCeremony = Readonly<{
  /** Deliberately non-reversible dedupe data, never an invite token. */
  locatorFingerprint: string;
  /** Exact normalized server origin; safe route correlation, never a bearer. */
  serverUrl: string;
  serverId: string;
  generation: number;
  ceremonyId: string;
}>;

/**
 * `null` means this process has no active intake record (for example, a
 * restored navigation state after process death). It is deliberately not
 * reported as owned. `false` means another intake superseded this ceremony
 * synchronously, before its queued custody work or route navigation runs.
 */
export type InviteIntakeOwnership = true | false | null;
export type InviteIntakeSettlement = "cleared" | "retained" | "untracked" | "replaced";

export interface InviteIntakeDependencies {
  parse?: (raw: string) => ParsedDeepLink;
  serverIdForUrl?: (serverUrl: string) => string;
  save?: (input: InviteHandoffInput) => Promise<unknown>;
  clear?: (serverId: string) => Promise<void>;
  saveCallbackLocator?: (locator: Readonly<{ serverId: string; serverUrl: string; generation: string; ceremonyId: string }>) => Promise<void>;
  clearCallbackLocator?: (locator: Readonly<{ serverId: string; serverUrl: string; generation: string; ceremonyId: string }>) => Promise<void>;
  now?: () => number;
  createCeremonyId?: (generation: number, now: number) => string;
}

/**
 * A 32-bit digest is only a process-local duplicate detector. It never grants
 * access, is not persisted, and is intentionally not presented as crypto.
 */
function locatorFingerprint(serverUrl: string, token: string): string {
  const input = `${serverUrl}\u0000${token}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${serverUrl}\u0000${(hash >>> 0).toString(16)}`;
}

function isBoundedRouteValue(value: string, maxLength: number): boolean {
  return value.length > 0 && value.length <= maxLength;
}

export function inviteRouteFromParams(params: {
  serverUrl?: string | string[];
  serverId?: string | string[];
  generation?: string | string[];
  ceremonyId?: string | string[];
}): InviteRouteParams | null {
  const serverUrl = typeof params.serverUrl === "string" ? params.serverUrl : null;
  const serverId = typeof params.serverId === "string" ? params.serverId : null;
  const generation = typeof params.generation === "string" ? params.generation : null;
  const ceremonyId = typeof params.ceremonyId === "string" ? params.ceremonyId : null;
  if (
    !serverUrl ||
    !serverId ||
    !generation ||
    !ceremonyId ||
    !isBoundedRouteValue(serverUrl, MAX_INVITE_ROUTE_SERVER_URL_LENGTH) ||
    !isBoundedRouteValue(serverId, MAX_INVITE_ROUTE_SERVER_ID_LENGTH) ||
    !isBoundedRouteValue(ceremonyId, MAX_INVITE_CEREMONY_ID_LENGTH) ||
    normalizeInviteServerOrigin(serverUrl) !== serverUrl ||
    !KEY_SAFE_VALUE_RE.test(serverId) ||
    !KEY_SAFE_VALUE_RE.test(ceremonyId) ||
    generation.length > MAX_GENERATION_DIGITS ||
    !/^[1-9]\d*$/.test(generation) ||
    !Number.isSafeInteger(Number(generation))
  ) {
    return null;
  }
  return { serverUrl, serverId, generation, ceremonyId };
}

function invalidMessage(parsed: ParsedDeepLink): string {
  if (parsed.kind === "invalid-invite") {
    return "That invite link is incomplete. Enter the full invite link from your invitation.";
  }
  return "Enter the full invite link from your invitation.";
}

/**
 * Serializes credential custody across cold links, warm links, QR, and manual
 * paste. A later intake advances generation immediately; queued older work
 * cannot navigate, and a later replacement erases the prior server handoff
 * before saving its own record.
 */
export class InviteIntake {
  private generation = 0;
  private active: ActiveCeremony | null = null;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly dependencies: InviteIntakeDependencies = {}) {}

  /**
   * Token-free ownership fence for screen async work.  It includes all route
   * correlation values, so an old screen cannot mutate a newer same-server
   * handoff after the newer intake has advanced generation.
   */
  ceremonyOwnership(ref: CeremonyRef): InviteIntakeOwnership {
    if (!this.active) return null;
    return this.active.generation === ref.generation
      && this.active.serverId === ref.serverId
      && this.active.ceremonyId === ref.ceremonyId;
  }

  /**
   * The callback transport route may resume only the ceremony this process
   * already owns.  This deliberately reconstructs route correlation from the
   * active fence rather than reading SecureStore or returning its bearer.
   */
  activeRoute(): InviteRoute | null {
    const active = this.active;
    if (!active) return null;
    return {
      pathname: "/(onboarding)/invite",
      params: {
        serverUrl: active.serverUrl,
        serverId: active.serverId,
        generation: String(active.generation),
        ceremonyId: active.ceremonyId,
      },
    };
  }

  private callbackLocator(active: ActiveCeremony) {
    return {
      serverId: active.serverId,
      serverUrl: active.serverUrl,
      generation: String(active.generation),
      ceremonyId: active.ceremonyId,
    };
  }

  async acceptParsed(
    parsed: ParsedDeepLink,
    _source: InviteIntakeSource,
    navigate: (route: InviteRoute) => void,
  ): Promise<InviteIntakeResult> {
    if (parsed.kind !== "invite") return { kind: "invalid", message: invalidMessage(parsed) };

    let serverId: string;
    try {
      serverId = await this.serverIdForUrl(parsed.serverUrl);
    } catch {
      return { kind: "persistence-failed", message: "We couldn’t safely save this invite. Try again." };
    }
    if (
      !isBoundedRouteValue(parsed.serverUrl, MAX_INVITE_ROUTE_SERVER_URL_LENGTH) ||
      !isBoundedRouteValue(serverId, MAX_INVITE_ROUTE_SERVER_ID_LENGTH)
    ) {
      return { kind: "invalid", message: "That invite link is not supported. Enter the full invite link again." };
    }

    const fingerprint = locatorFingerprint(parsed.serverUrl, parsed.token);
    if (this.active?.locatorFingerprint === fingerprint) return { kind: "duplicate" };

    const now = (this.dependencies.now ?? Date.now)();
    const generation = this.generation + 1;
    this.generation = generation;
    const ceremonyId = (this.dependencies.createCeremonyId ?? defaultCeremonyId)(generation, now);
    if (!isBoundedRouteValue(ceremonyId, MAX_INVITE_CEREMONY_ID_LENGTH)) {
      return { kind: "persistence-failed", message: "We couldn’t safely save this invite. Try again." };
    }

    const previous = this.active;
    const active: ActiveCeremony = {
      locatorFingerprint: fingerprint,
      serverUrl: parsed.serverUrl,
      serverId,
      generation,
      ceremonyId,
    };
    this.active = active;
    const route: InviteRoute = {
      pathname: "/(onboarding)/invite",
      params: { serverUrl: parsed.serverUrl, serverId, generation: String(generation), ceremonyId },
    };

    let resolveResult!: (result: InviteIntakeResult) => void;
    const result = new Promise<InviteIntakeResult>((resolve) => {
      resolveResult = resolve;
    });
    this.writes = this.writes.then(async () => {
      // An intake that was superseded before it reached custody must not write
      // its bearer at all.
      if (this.active !== active) {
        resolveResult({ kind: "duplicate" });
        return;
      }
      try {
        if (previous) {
          await (this.dependencies.clear ?? clearInviteHandoff)(previous.serverId);
          await (this.dependencies.clearCallbackLocator ?? clearInviteCallbackLocator)(this.callbackLocator(previous));
        }
        await (this.dependencies.save ?? saveInviteHandoff)({
          serverId,
          serverUrl: parsed.serverUrl,
          inviteToken: parsed.token,
          prepareState: null,
          handle: null,
          stage: "preview",
          startedAt: now,
          inviteExpiresAt: null,
        });
        try {
          await (this.dependencies.saveCallbackLocator ?? saveInviteCallbackLocator)(this.callbackLocator(active));
        } catch (error) {
          await (this.dependencies.clear ?? clearInviteHandoff)(active.serverId);
          throw error;
        }
        if (this.active !== active) {
          // The queued replacement owns the same key ordering and will clear
          // this record before it saves its own token.
          resolveResult({ kind: "duplicate" });
          return;
        }
        navigate(route);
        resolveResult({ kind: "accepted", route });
      } catch {
        if (this.active === active) this.active = null;
        resolveResult({ kind: "persistence-failed", message: "We couldn’t safely save this invite. Try again." });
      }
    });
    await this.writes.catch(() => undefined);
    return result;
  }

  acceptRaw(
    raw: string,
    source: InviteIntakeSource,
    navigate: (route: InviteRoute) => void,
  ): Promise<InviteIntakeResult> {
    return this.acceptParsed((this.dependencies.parse ?? parseDeepLink)(raw), source, navigate);
  }

  private async serverIdForUrl(serverUrl: string): Promise<string> {
    if (this.dependencies.serverIdForUrl) return this.dependencies.serverIdForUrl(serverUrl);
    // Keep React Native storage modules out of pure Bun tests. This uses the
    // canonical registry identity in native builds rather than duplicating it.
    const { serverIdFromUrl } = await import("@/lib/server-store");
    return serverIdFromUrl(serverUrl);
  }

  /**
   * Apply handoff retention/erasure through the active intake coordinator.
   * A newer intake wins immediately;
   * its queued write remains behind this cleanup so the same SecureStore key
   * cannot be cleared after the newer bearer has been saved. Retryable work
   * retains both handoff bytes and ownership. Storage errors intentionally
   * propagate so the caller can remain on a safe error card.
   */
  async settle(ref: CeremonyRef, reason: InviteHandoffClearReason): Promise<InviteIntakeSettlement> {
    const active = this.active;
    if (!active) return "untracked";
    if (this.ceremonyOwnership(ref) !== true) return "replaced";
    if (reason === "retryable-network") return "retained";
    const cleanup = this.writes.then(async () => {
      if (this.active !== active) return "replaced" as const;
      await (this.dependencies.clear ?? clearInviteHandoff)(active.serverId);
      await (this.dependencies.clearCallbackLocator ?? clearInviteCallbackLocator)(this.callbackLocator(active));
      if (this.active === active) {
        this.active = null;
        return "cleared" as const;
      }
      return "replaced" as const;
    });
    // A failed cleanup must not poison later fresh intake writes, but the
    // initiating screen still receives the rejection and stays put.
    this.writes = cleanup.then(() => undefined, () => undefined);
    return cleanup;
  }

  /** Convenience name for the user-directed cancellation path. */
  cancel(ref: CeremonyRef): Promise<InviteIntakeSettlement> {
    return this.settle(ref, "cancelled");
  }
}

function defaultCeremonyId(generation: number, now: number): string {
  return `invite-${generation.toString(36)}-${now.toString(36)}`;
}

const sharedInviteIntake = new InviteIntake();

/** Shared process intake keeps cold/warm/QR/manual replacement fencing coherent. */
export function getInviteIntake(): InviteIntake {
  return sharedInviteIntake;
}
