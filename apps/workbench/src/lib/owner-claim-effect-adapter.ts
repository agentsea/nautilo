/**
 * Browser authority adapter for the D508 owner-claim coordinator.
 *
 * Claim/session storage, hosted-auth state and profile values stay in this
 * closure. The coordinator receives only its deliberately redacted typed
 * outcomes; it never owns browser storage, an API client, or a bearer.
 */
import { ApiError } from "@nautilo/api-client/browser";
import type { AuthSession } from "../hooks/use-auth";
import { apiClient } from "./api";
import {
  clearOwnerClaimHandoff,
  readOwnerClaimHandoff,
  writeOwnerClaimHandoff,
} from "./owner-claim-handoff";
import {
  clearOwnerClaimTerminalMarker,
  writeOwnerClaimTerminalMarker,
} from "./owner-claim-terminal";
import type {
  OwnerClaimEffectAdapter,
  OwnerClaimEffectOutcome,
  OwnerClaimEffectRequest,
} from "./owner-claim-coordinator";

export interface OwnerClaimProfileInput {
  readonly displayName: string;
  readonly pin: string;
}

export interface OwnerClaimBrowserEffectAdapter {
  readonly effects: OwnerClaimEffectAdapter;
  readonly newOwnerHandle: () => string;
  readonly setNewOwnerHandle: (handle: string) => void;
  readonly setProfileInput: (input: OwnerClaimProfileInput) => void;
  readonly recoveryCodes: () => readonly string[];
}

function currentClaim(): ReturnType<typeof readOwnerClaimHandoff> {
  return readOwnerClaimHandoff();
}

/**
 * Browser storage is outside the coordinator's generation fence. Every
 * post-await custody mutation therefore has to prove that its own operation
 * remains live and that no replacement handoff has advanced the checkpoint.
 */
function isCurrentHandoff(
  request: OwnerClaimEffectRequest,
  captured: NonNullable<ReturnType<typeof readOwnerClaimHandoff>>,
): boolean {
  const current = currentClaim();
  return !request.signal.aborted
    && current !== null
    && current.claim === captured.claim
    && current.finish === captured.finish
    && current.state === captured.state
    && current.handle === captured.handle
    && current.stage === captured.stage
    && current.startedAt === captured.startedAt;
}

function ownerClaimErrorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const code = (error as ApiError & { readonly code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

function isAmbiguousWrite(error: unknown): boolean {
  return error instanceof ApiError && error.name === "OwnerClaimAmbiguousWriteError";
}

function isOwnerClaimReservation(error: unknown): boolean {
  // `/api/bind-logto-user` can reject a wrong D508 subject before the
  // reservation transaction with 409 `handle_mismatch`, or inside that
  // transaction with `claim_reserved`. Both are authoritative evidence that
  // this browser subject cannot continue this owner claim, and both require
  // the same explicit original-account recovery. Keep that normalization at
  // this owner-only adapter boundary rather than teaching the machine server
  // implementation details.
  const code = ownerClaimErrorCode(error);
  return code === "claim_reserved" || code === "handle_mismatch";
}

export function createOwnerClaimBrowserEffectAdapter(input: {
  readonly getSession: () => AuthSession;
  readonly navigate: (destination: "/help/server" | "/") => void;
}): OwnerClaimBrowserEffectAdapter {
  const resumableHandoff = currentClaim();
  let newOwnerHandle: string | null = resumableHandoff !== null && resumableHandoff.handle.length > 0
    ? resumableHandoff.handle
    : null;
  let profileInput: OwnerClaimProfileInput | null = null;
  let lastRecoveryCodes: readonly string[] = [];

  const fail = (commandKind: OwnerClaimEffectOutcome["commandKind"]): OwnerClaimEffectOutcome => {
    switch (commandKind) {
      case "preview-claim": return { commandKind, result: "failed" };
      case "prepare-signup":
      case "prepare-resume": return { commandKind, result: "failed" };
      case "launch-logto-signup":
      case "launch-logto-signin": return { commandKind, result: "failed" };
      case "sign-out": return { commandKind, result: "failed" };
      case "bind-subject": return { commandKind, result: "failed" };
      case "reobserve-bind": return { commandKind, result: "failed" };
      case "complete-profile": return { commandKind, result: "failed" };
      case "reobserve-completion": return { commandKind, result: "failed" };
      case "navigate-guide":
      case "navigate-product": return { commandKind, result: "failed" };
      default: return assertNever(commandKind);
    }
  };

  const effects: OwnerClaimEffectAdapter = {
    async execute(request): Promise<OwnerClaimEffectOutcome> {
      switch (request.command.kind) {
        case "preview-claim": {
          const handoff = currentClaim();
          if (handoff === null) return { commandKind: "preview-claim", result: "unavailable" };
          try {
            const preview = await apiClient.previewOwnerClaim({ claim: handoff.claim });
            // `null` is the API client's normalized authoritative 404. Do not
            // let a revoked capability remain available for a future refresh.
            if (preview === null) {
              if (isCurrentHandoff(request, handoff)) clearOwnerClaimHandoff();
              return { commandKind: "preview-claim", result: "unavailable" };
            }
            return { commandKind: "preview-claim", result: "resolved", continuation: preview.continuation };
          } catch (error) {
            if (error instanceof ApiError && (error.status === 404 || error.status === 410)) {
              if (isCurrentHandoff(request, handoff)) clearOwnerClaimHandoff();
              return { commandKind: "preview-claim", result: "unavailable" };
            }
            return fail("preview-claim");
          }
        }

        case "prepare-signup": {
          const handoff = currentClaim();
          if (handoff === null || newOwnerHandle === null) return fail("prepare-signup");
          try {
            const prepared = await apiClient.prepareOwnerClaimAuth({
              claim: handoff.claim,
              handle: newOwnerHandle,
            });
            if (prepared.continuation !== "new-owner" || !isCurrentHandoff(request, handoff) || !writeOwnerClaimHandoff({
              ...handoff,
              state: prepared.state,
              handle: prepared.handle,
              stage: "awaiting-signup",
              startedAt: new Date().toISOString(),
            })) return fail("prepare-signup");
            return { commandKind: "prepare-signup", result: "prepared" };
          } catch {
            return fail("prepare-signup");
          }
        }

        case "prepare-resume": {
          const handoff = currentClaim();
          if (handoff === null) return fail("prepare-resume");
          try {
            const prepared = await apiClient.prepareOwnerClaimAuth({ claim: handoff.claim });
            if (prepared.continuation !== "resume-owner" || !isCurrentHandoff(request, handoff) || !writeOwnerClaimHandoff({
              ...handoff,
              state: prepared.state,
              handle: prepared.handle,
              stage: "awaiting-bind",
              startedAt: new Date().toISOString(),
            })) return fail("prepare-resume");
            return { commandKind: "prepare-resume", result: "prepared" };
          } catch {
            return fail("prepare-resume");
          }
        }

        case "launch-logto-signup": {
          const handoff = currentClaim();
          if (handoff === null || handoff.handle.length === 0) return fail("launch-logto-signup");
          try {
            await input.getSession().signIn({
              extraParams: { first_screen: "register", login_hint: handoff.handle },
            });
            return { commandKind: "launch-logto-signup", result: "launched" };
          } catch {
            return fail("launch-logto-signup");
          }
        }

        case "launch-logto-signin":
          try {
            await input.getSession().signIn();
            return { commandKind: "launch-logto-signin", result: "launched" };
          } catch {
            return fail("launch-logto-signin");
          }

        case "sign-out":
          try {
            await input.getSession().signOut("/claim");
            return { commandKind: "sign-out", result: "completed" };
          } catch {
            return fail("sign-out");
          }

        case "bind-subject": {
          const handoff = currentClaim();
          if (handoff === null || handoff.state.length === 0) return fail("bind-subject");
          try {
            const accessToken = await input.getSession().getAccessToken();
            if (accessToken === null) return fail("bind-subject");
            await apiClient.bindLogtoUser({ state: handoff.state });
            if (!isCurrentHandoff(request, handoff) || !writeOwnerClaimHandoff({ ...handoff, stage: "profile" })) return fail("bind-subject");
            return { commandKind: "bind-subject", result: "resolved" };
          } catch (error) {
            if (isAmbiguousWrite(error)) {
              return { commandKind: "bind-subject", result: "ambiguous" };
            }
            if (isOwnerClaimReservation(error)) {
              return { commandKind: "bind-subject", result: "reserved" };
            }
            return fail("bind-subject");
          }
        }

        case "reobserve-bind": {
          const handoff = currentClaim();
          if (handoff === null || handoff.state.length === 0) return fail("reobserve-bind");
          try {
            await apiClient.bindLogtoUser({ state: handoff.state });
            if (!isCurrentHandoff(request, handoff) || !writeOwnerClaimHandoff({ ...handoff, stage: "profile" })) return fail("reobserve-bind");
            return { commandKind: "reobserve-bind", result: "resolved" };
          } catch (error) {
            if (isOwnerClaimReservation(error)) {
              return { commandKind: "reobserve-bind", result: "reserved" };
            }
            // A second lost response is not allowed to spin a background
            // retry loop. It becomes an explicit same-subject bind retry.
            return fail("reobserve-bind");
          }
        }

        case "complete-profile": {
          const handoff = currentClaim();
          if (handoff === null || profileInput === null) return fail("complete-profile");
          try {
            const result = await apiClient.completeOwnerClaimProfile({
              claim: handoff.claim,
              displayName: profileInput.displayName,
              pin: profileInput.pin,
            });
            if (!isCurrentHandoff(request, handoff)) return fail("complete-profile");
            lastRecoveryCodes = result.recoveryCodes;
            clearOwnerClaimHandoff();
            writeOwnerClaimTerminalMarker({ schemaVersion: 1, finish: handoff.finish });
            return { commandKind: "complete-profile", result: "recovery-ready" };
          } catch (error) {
            if (isAmbiguousWrite(error) || ownerClaimErrorCode(error) === "already_completed") {
              return { commandKind: "complete-profile", result: "ambiguous" };
            }
            return fail("complete-profile");
          }
        }

        case "reobserve-completion": {
          const handoff = currentClaim();
          if (handoff === null) return fail("reobserve-completion");
          try {
            const status = await apiClient.getSetupStatus();
            if (status.setupState === "fresh-unclaimed") {
              return { commandKind: "reobserve-completion", result: "pending" };
            }
            // This is the same authoritative completion point as a direct
            // profile success. The capability is spent; retaining it would
            // let a later refresh reopen stale owner-claim custody.
            if (!isCurrentHandoff(request, handoff)) return fail("reobserve-completion");
            clearOwnerClaimHandoff();
            writeOwnerClaimTerminalMarker({ schemaVersion: 1, finish: handoff.finish });
            return { commandKind: "reobserve-completion", result: "recovery-ready" };
          } catch {
            return fail("reobserve-completion");
          }
        }

        case "navigate-guide":
          try {
            input.navigate("/help/server");
            clearOwnerClaimTerminalMarker();
            return { commandKind: "navigate-guide", result: "completed" };
          } catch {
            return fail("navigate-guide");
          }
        case "navigate-product":
          try {
            input.navigate("/");
            clearOwnerClaimTerminalMarker();
            return { commandKind: "navigate-product", result: "completed" };
          } catch {
            return fail("navigate-product");
          }
        default:
          return assertNever(request.command);
      }
    },
  };

  return {
    effects,
    newOwnerHandle: () => newOwnerHandle ?? "",
    setNewOwnerHandle: (handle) => { newOwnerHandle = handle; },
    setProfileInput: (profile) => { profileInput = profile; },
    recoveryCodes: () => lastRecoveryCodes,
  };
}

function assertNever(value: never): never {
  throw new Error(`Unhandled owner-claim browser adapter value: ${String(value)}`);
}
