/**
 * M216 — server-injected exact-open-document mutation gate.
 *
 * The agent package owns the mutation call sites but not live Writer session
 * authority. The server injects a probe at boot; keeping the target shape
 * identity-only avoids an Agent -> Server dependency and keeps paths out of
 * the structured rejection returned to the model.
 */

export const USE_EDIT_OPEN_WRITER = "use_edit_open_writer" as const;
export const USE_EDIT_OPEN_WRITER_MESSAGE =
  "This document has an active mini-app editing session. Use that app’s live editing tools in the tab where it is open, or close that editor before editing the saved file.";

export type LiveReviewWriteGateFailure = {
  ok: false;
  status: typeof USE_EDIT_OPEN_WRITER;
  code: typeof USE_EDIT_OPEN_WRITER;
  message: typeof USE_EDIT_OPEN_WRITER_MESSAGE;
};

export type LiveReviewWriteGuardTarget =
  | {
      surface: "workspace";
      ownerId: string;
      /** Authorized internal artifacts.id, never a logical/model path. */
      artifactId: string;
    }
  | {
      surface: "currentFolder";
      ownerId: string;
      /** Exact relay selected for the mutation before this probe runs. */
      relayId: string;
      /**
       * Absolute lexical candidates. The server resolves each through the
       * pinned relay to the same canonical target identity used at issuance.
       */
      candidatePaths?: readonly string[];
      /**
       * Canonical identities returned by the pinned relay's revision journal.
       * These are already authority-resolved and must not be re-derived from
       * model path arguments.
       */
      canonicalTargetIdentities?: readonly string[];
      /**
       * Lexical directory sources whose canonical identity should match an
       * open binding at that identity or anywhere beneath it.
       */
      directoryCandidatePaths?: readonly string[];
    };

export type LiveReviewWriteGuard = (
  target: LiveReviewWriteGuardTarget,
) => Promise<boolean>;

let liveReviewWriteGuard: LiveReviewWriteGuard | null = null;

/** Preserve the authority's reason without exposing local paths or raw errors. */
export class LiveReviewTargetResolutionError extends Error {
  constructor(readonly code: "local_target_forbidden" | "relay_unavailable") {
    super("Local document target resolution failed.");
    this.name = "LiveReviewTargetResolutionError";
  }
}

export function setLiveReviewWriteGuard(guard: LiveReviewWriteGuard | null): void {
  liveReviewWriteGuard = guard;
}

export function getLiveReviewWriteGuard(): LiveReviewWriteGuard | null {
  return liveReviewWriteGuard;
}

export function liveReviewWriteGateFailure(): LiveReviewWriteGateFailure {
  return {
    ok: false,
    status: USE_EDIT_OPEN_WRITER,
    code: USE_EDIT_OPEN_WRITER,
    message: USE_EDIT_OPEN_WRITER_MESSAGE,
  };
}

export function liveReviewWriteGateFailureJson(): string {
  return JSON.stringify(liveReviewWriteGateFailure());
}

/**
 * Probe the one server-injected Writer-session authority without choosing a
 * model-facing error contract. Different mutation tools retain their own
 * stable rejection vocabulary while sharing this exact open-session fact.
 */
export async function isOpenInWriter(
  target: LiveReviewWriteGuardTarget,
): Promise<boolean | null> {
  const guard = liveReviewWriteGuard;
  return guard === null ? null : await guard(target);
}

export async function rejectIfOpenInWriter(
  target: LiveReviewWriteGuardTarget,
): Promise<string | null> {
  return (await isOpenInWriter(target)) === true ? liveReviewWriteGateFailureJson() : null;
}
