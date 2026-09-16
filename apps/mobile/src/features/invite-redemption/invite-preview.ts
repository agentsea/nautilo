/**
 * Safe presentation and recovery decisions for the native invite preview.
 *
 * The API preview and SecureStore handoff are deliberately kept outside the
 * renderer.  This module turns their *allow-listed* fields into bounded text
 * and turns failures into the reducer's small recovery vocabulary.  It never
 * accepts or returns an invite token, opaque preparation state, or raw error.
 */
import type { InvitePreview as ApiInvitePreview } from "@nautilo/api-client/browser";

import type {
  CeremonyFailure,
  FailureCode,
  InviteCeremonyState,
  InvitePreview,
  RecoveryAction,
} from "./invite-ceremony";

export const MAX_INVITE_ADVISORY_LENGTH = 96;
const MAX_INVITE_HANDLE_LENGTH = 64;

export type InviteAdvisory = Readonly<{
  label: "Room" | "Agent" | "Role";
  value: string;
}>;

type InvitePreviewDisplayInput = Readonly<{
  inviterHandle?: string | null;
  targetRoomLabel?: string | null;
  targetAgentDisplayName?: string | null;
  targetRoleLabel?: string | null;
}>;

/** The complete, bounded shape the React Native screen is allowed to render. */
export type InvitePreviewPresentation = Readonly<{
  inviterLine: string | null;
  advisories: readonly InviteAdvisory[];
}>;

export type InviteScreenView =
  | Readonly<{ kind: "manual"; title: string; body: string }>
  | Readonly<{ kind: "loading"; title: string; body: string; serverDomain: string | null }>
  | Readonly<{ kind: "confirm-server"; title: string; body: string; serverDomain: string }>
  | Readonly<{
      kind: "preview";
      title: string;
      body: string;
      serverDomain: string;
      inviterLine: string | null;
      advisories: readonly InviteAdvisory[];
    }>
  | Readonly<{
      kind: "signed-in-boundary";
      title: string;
      body: string;
      serverDomain: string;
      inviterLine: string | null;
      advisories: readonly InviteAdvisory[];
      viewerLine: string | null;
    }>
  | Readonly<{
      kind: "profile";
      title: string;
      body: string;
      serverDomain: string;
    }>
  | Readonly<{
      kind: "recovery";
      title: string;
      body: string;
      serverDomain: string;
    }>
  | Readonly<{
      kind: "failure";
      title: string;
      body: string;
      primaryLabel: string;
      recovery: RecoveryAction;
      primaryDisabled: boolean;
      serverDomain: string | null;
    }>;

function boundedText(value: unknown, maxLength = MAX_INVITE_ADVISORY_LENGTH): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length <= maxLength ? trimmed : `${trimmed.slice(0, Math.max(1, maxLength - 1))}…`;
}

function exactServerDomain(serverUrl: string | null | undefined): string | null {
  if (!serverUrl) return null;
  try {
    return new URL(serverUrl).host;
  } catch {
    return null;
  }
}

function inviterLine(value: unknown): string | null {
  const handle = boundedText(value, MAX_INVITE_HANDLE_LENGTH);
  if (!handle || handle.toLocaleLowerCase() === "unknown") return null;
  return `${handle.startsWith("@") ? handle : `@${handle}`} invited you`;
}

/**
 * Drops all unrecognised API fields and makes every permitted display value
 * finite. Room, agent, and role labels are advisory only: this type carries no
 * origin, server id, membership, or authorization data.
 */
export function presentInvitePreview(preview: InvitePreviewDisplayInput): InvitePreviewPresentation {
  const advisories: InviteAdvisory[] = [];
  const room = boundedText(preview.targetRoomLabel);
  const agent = boundedText(preview.targetAgentDisplayName);
  const role = boundedText(preview.targetRoleLabel);
  if (room) advisories.push({ label: "Room", value: room });
  if (agent) advisories.push({ label: "Agent", value: agent });
  if (role) advisories.push({ label: "Role", value: role });
  return { inviterLine: inviterLine(preview.inviterHandle), advisories };
}

/** The reducer receives only its existing safe subset of the API preview. */
export function previewForCeremony(preview: ApiInvitePreview): InvitePreview {
  return {
    inviterHandle: boundedText(preview.inviterHandle, MAX_INVITE_HANDLE_LENGTH),
    targetRoomLabel: boundedText(preview.targetRoomLabel),
    expiresAt: validPreviewExpiry(preview.expiresAt) ? preview.expiresAt : null,
  };
}

/** A server expiry is useful only when it is a future, valid absolute date. */
export function previewExpiryEpoch(expiresAt: string | null | undefined, now = Date.now()): number | null {
  if (typeof expiresAt !== "string") return null;
  const parsed = Date.parse(expiresAt);
  return Number.isFinite(parsed) && parsed > now ? parsed : null;
}

function validPreviewExpiry(expiresAt: string | null | undefined): expiresAt is string {
  return typeof expiresAt === "string" && Number.isFinite(Date.parse(expiresAt));
}

/** Map transport/API failures without carrying a raw message into UI state. */
export function previewFailureFromError(error: unknown): CeremonyFailure {
  if (typeof error === "object" && error !== null && "status" in error) {
    const status = (error as { status?: unknown }).status;
    if (typeof status === "number" && Number.isInteger(status)) return { status };
  }
  if (error instanceof TypeError) return "offline";
  return "server-unavailable";
}

export type PreviewFailureDecision = Readonly<{
  failure: CeremonyFailure;
  code: FailureCode;
  settlement: ReturnType<typeof handoffSettlementForFailure>;
}>;

/** Fixed fail-closed view when SecureStore deletion could not be confirmed. */
export function inviteCustodyFailureView(serverUrl: string | null): Extract<InviteScreenView, { kind: "failure" }> {
  return {
    kind: "failure",
    title: "Couldn't clear this invitation safely",
    body: "Keep this screen open and try again. Nautilo won't continue with this invitation until it is cleared.",
    primaryLabel: "Try again",
    recovery: "retry",
    primaryDisabled: false,
    serverDomain: exactServerDomain(serverUrl),
  };
}

/**
 * Preserve the reducer's canonical HTTP mapping for both the displayed
 * recovery and SecureStore settlement. The screen must not make a second,
 * lossy status switch while deciding whether custody can be retained.
 */
export function previewFailureDecision(error: unknown): PreviewFailureDecision {
  const failure = previewFailureFromError(error);
  let code: FailureCode;
  if (typeof failure === "string") {
    code = failure;
  } else {
    switch (failure.status) {
      case 400:
        code = "invalid-request";
        break;
      case 401:
        code = "authentication-required";
        break;
      case 404:
        code = "invite-not-found";
        break;
      case 409:
        code = "invite-already-redeemed";
        break;
      case 410:
        code = "invite-expired";
        break;
      case 422:
        code = "invalid-ceremony";
        break;
      case 429:
        code = "rate-limited";
        break;
      default:
        code = "server-unavailable";
        break;
    }
  }
  return { failure, code, settlement: handoffSettlementForFailure(code) };
}

/** The bounded handoff is retained only for retryable network/server work. */
export function handoffSettlementForFailure(code: FailureCode): "retryable-network" | "terminal-failure" | "server-mismatch" | "expiry" {
  switch (code) {
    case "offline":
    case "server-unreachable":
    case "server-unavailable":
    case "rate-limited":
      return "retryable-network";
    case "server-mismatch":
      return "server-mismatch";
    case "invite-expired":
      return "expiry";
    default:
      return "terminal-failure";
  }
}

function failureView(code: FailureCode, recovery: RecoveryAction, serverUrl: string | null): Extract<InviteScreenView, { kind: "failure" }> {
  const serverDomain = exactServerDomain(serverUrl);
  switch (code) {
    case "invalid-locator":
      return { kind: "failure", title: "This invite link isn't valid", body: "Paste or scan the complete invite URL to continue safely.", primaryLabel: "Paste full invite URL", recovery, primaryDisabled: false, serverDomain };
    case "server-unreachable":
      return { kind: "failure", title: "Can't reach this server", body: "Check the server address and your connection, then try again.", primaryLabel: "Try again", recovery, primaryDisabled: false, serverDomain };
    case "server-mismatch":
      return { kind: "failure", title: "Start with a new invite", body: "Nautilo couldn't verify this invitation safely. Paste the complete invite URL again.", primaryLabel: "Paste full invite URL", recovery, primaryDisabled: false, serverDomain };
    case "invite-not-found":
    case "invite-already-redeemed":
    case "invite-expired":
      return { kind: "failure", title: "This invite is no longer available", body: "Ask the person who invited you for a new invite.", primaryLabel: "Ask for a new invite", recovery, primaryDisabled: false, serverDomain };
    case "rate-limited":
      return { kind: "failure", title: "Too many attempts", body: "Wait a moment before trying this invite again.", primaryLabel: "Try again later", recovery, primaryDisabled: true, serverDomain };
    case "offline":
      return { kind: "failure", title: "You're offline", body: "Reconnect to the internet, then try again.", primaryLabel: "Try again", recovery, primaryDisabled: false, serverDomain };
    case "authentication-required":
      return { kind: "failure", title: "Sign-in session expired", body: "Start the secure sign-up again to continue joining.", primaryLabel: "Start sign-up again", recovery, primaryDisabled: false, serverDomain };
    case "auth-cancelled":
      return { kind: "failure", title: "Sign-up was cancelled", body: "Continue when you're ready to open the secure sign-up service.", primaryLabel: "Continue sign-up", recovery, primaryDisabled: false, serverDomain };
    case "interrupted":
      return { kind: "failure", title: "Start with a new invite", body: "Nautilo couldn't safely continue this invitation. Paste the full invite URL again.", primaryLabel: "Paste full invite URL", recovery, primaryDisabled: false, serverDomain };
    case "invalid-request":
    case "invalid-ceremony":
      return { kind: "failure", title: "This invite can't be completed", body: "Start again with the complete invite URL, or ask for a new invite.", primaryLabel: "Start over", recovery, primaryDisabled: false, serverDomain };
    case "server-unavailable":
      return { kind: "failure", title: "Nautilo is temporarily unavailable", body: "Try again in a moment.", primaryLabel: "Try again", recovery, primaryDisabled: false, serverDomain };
  }
}

function presentationForState(state: Extract<InviteCeremonyState, { kind: "preview" | "signed-in-boundary" }>, supplied: InvitePreviewPresentation | null): InvitePreviewPresentation {
  return supplied ?? presentInvitePreview(state.preview);
}

/**
 * The only model consumed by the screen. It contains presentation-safe text
 * and explicit actions, never an API error, SecureStore record, token, or
 * opaque state.
 */
export function inviteScreenView(
  state: InviteCeremonyState,
  suppliedPreview: InvitePreviewPresentation | null,
  viewerHandle: string | null,
): InviteScreenView {
  switch (state.kind) {
    case "awaiting-locator":
    case "invalid-locator":
      return { kind: "manual", title: "Enter an invite link", body: "Paste the complete invite link from Nautilo. It includes both the server and your one-time invitation." };
    case "probing-server":
      return { kind: "loading", title: "Checking your invitation", body: "Nautilo is verifying the server named in this invite.", serverDomain: exactServerDomain(state.serverUrl) };
    case "activating-server":
      return { kind: "loading", title: "Connecting to server", body: "Nautilo is connecting only to the server named in this invite.", serverDomain: exactServerDomain(state.serverUrl) };
    case "previewing":
      return { kind: "loading", title: "Checking your invitation", body: "Nautilo is opening your invitation securely.", serverDomain: exactServerDomain(state.serverUrl) };
    case "confirm-server":
      return { kind: "confirm-server", title: "Connect to this server?", body: "Nautilo will verify this server before opening the invitation.", serverDomain: exactServerDomain(state.serverUrl) ?? "Nautilo server" };
    case "preview": {
      const preview = presentationForState(state, suppliedPreview);
      return { kind: "preview", title: "You've been invited", body: "Your invitation is ready. Account creation continues in the next step.", serverDomain: exactServerDomain(state.serverUrl) ?? "Nautilo server", ...preview };
    }
    case "signed-in-boundary": {
      const preview = presentationForState(state, suppliedPreview);
      const handle = boundedText(viewerHandle, MAX_INVITE_HANDLE_LENGTH);
      return {
        kind: "signed-in-boundary",
        title: "Switch account to continue",
        body: "This invitation creates a new account. Keeping the current account cancels this invitation without changing your session.",
        serverDomain: exactServerDomain(state.serverUrl) ?? "Nautilo server",
        viewerLine: handle ? `You're signed in as ${handle.startsWith("@") ? handle : `@${handle}`}.` : "You're already signed in on this server.",
        ...preview,
      };
    }
    case "profile":
      return {
        kind: "profile",
        title: "Finish setting up your account",
        body: "Choose the name and PIN you’ll use with this Nautilo server.",
        serverDomain: exactServerDomain(state.serverUrl) ?? "Nautilo server",
      };
    case "recovery-acknowledgement":
      return {
        kind: "recovery",
        title: "Save your recovery codes",
        body: "Keep these codes somewhere secure. You’ll need one if you ever need to reset your PIN.",
        serverDomain: exactServerDomain(state.serverUrl) ?? "Nautilo server",
      };
    case "failure":
      return failureView(state.code, state.recovery, state.serverUrl);
    case "cancelled":
      return { kind: "loading", title: "Cancelling invitation", body: "Nautilo is clearing this invitation safely.", serverDomain: exactServerDomain(state.serverUrl) };
    default:
      return { kind: "loading", title: "Preparing invitation", body: "Nautilo is preparing your invitation securely.", serverDomain: "serverUrl" in state ? exactServerDomain(state.serverUrl) : null };
  }
}
