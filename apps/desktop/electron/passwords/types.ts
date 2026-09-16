/**
 * D403 (ISSUE-D403) Phase 0 — IPC contract types for the embedded-browser
 * password save & restore layer.
 *
 * This file only defines the SHAPES that flow guest ⇄ host ⇄ main. No storage,
 * no form heuristics, no UI live here. Later phases fill in the behavior:
 *   - P1 populates the form-detection fields on `DetectedLoginForm`.
 *   - P2 replaces `NoopBackend` with a KDBX-backed `CredentialBackend`
 *     (`kdbxweb` + `@noble/hashes` argon2id; master key sealed by Electron
 *     `safeStorage`), keeping this interface as the pluggable seam.
 *   - P3 adds the React save/autofill UX in the host renderer.
 *
 * SECURITY INVARIANT (R6 — non-negotiable): these credentials are HUMAN-ONLY.
 * Web credentials must NEVER enter agent/LLM context or any agent/tool/CDP-
 * reachable surface. In particular, `PasswordLookupMatch` deliberately omits
 * the password — lookups return only non-secret metadata; the plaintext is
 * released once, on an explicit user gesture, via `getFillValue`.
 */

/**
 * A login form detected by the guest preload's content script.
 *
 * The optional geometry/field fields are populated in P1 (form detection); the
 * shape is fixed now so the guest→host→main protocol is stable for P0.
 */
export interface DetectedLoginForm {
  /** Stable-per-page identifier for the detected form (assigned by the guest). */
  formId: string;
  /** DOM id/ref of the username/identifier field, when present. */
  usernameFieldId?: string;
  /** DOM id/ref of the password field (a login form always has one). */
  passwordFieldId: string;
  /** Exact origin of the frame the form lives in (e.g. `https://example.com`). */
  frameOrigin: string;
  /** Field bounding boxes for overlay placement (P3). Populated in P1. */
  rects?: FieldRect[];
}

/** Bounding box for a detected field, in guest-viewport CSS pixels. */
export interface FieldRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** guest/host → main: persist a credential for an origin. */
export interface PasswordSaveRequest {
  /** Exact registrable origin the credential belongs to. */
  origin: string;
  username: string;
  password: string;
}

/** guest/host → main: look up saved credentials for an origin. */
export interface PasswordLookupRequest {
  /** Exact registrable origin to match (no cross-origin matches, ever). */
  origin: string;
}

/**
 * A single lookup hit. NEVER includes the password — only enough non-secret
 * metadata for the human to pick which credential to fill.
 */
export interface PasswordLookupMatch {
  /** Opaque backend id, later passed to `getFillValue` on a user gesture. */
  id: string;
  username: string;
}

/** main → guest/host: matches for a lookup (no secrets). */
export interface PasswordLookupResult {
  matches: PasswordLookupMatch[];
}

/**
 * guest/host → main: request the one-shot fill value for a previously-returned
 * match id. Main only honors this on an explicit user gesture (enforced in P3).
 */
export interface PasswordFillRequest {
  id: string;
}

/**
 * main → guest: the one-shot fill value. Released only on a user gesture and
 * never persisted anywhere reachable by agent/tool/CDP surfaces.
 */
export interface PasswordFillValue {
  username: string;
  password: string;
}

// ---------------------------------------------------------------------------
// P3 — save/autofill loop message shapes.
//
// SECURITY (R6): the plaintext password flows ONLY guest ⇄ main. It NEVER
// transits the host renderer / React tree. Concretely:
//   - Save:  guest --(StageSaveRequest, has password)--> main stages it by
//            origin, then main --(PendingSaveNotice, NO password)--> host. Host
//            later calls commitSave/dismissSave by origin (no password). Keying
//            by origin lets the offer survive the post-submit navigation.
//   - Fill:  host --(ApplyFillRequest {webContentsId,id}, no secret)--> main
//            resolves the secret and --(ApplyFillCommand, has password)-->
//            guest. The secret is never returned to the host invoker.
// ---------------------------------------------------------------------------

/**
 * guest → main: stage a submitted credential for the guest's origin. Carries
 * the plaintext password, which main holds ONLY in an in-memory staging map
 * keyed by ORIGIN — never persisted until the human confirms via `commitSave`,
 * and never forwarded to the host renderer.
 */
export interface StageSaveRequest {
  /** Exact origin of the frame the form was submitted from. */
  origin: string;
  username: string;
  password: string;
}

/**
 * main → host: a credential has been staged and awaits the human's decision.
 * Deliberately password-free — the host only sees non-secret metadata. Keyed by
 * ORIGIN (not the guest webContents id) so the Save offer survives the
 * post-submit navigation / guest webContents swap.
 */
export interface PendingSaveNotice {
  origin: string;
  username: string;
  /** "new" = no stored match; "update" = same user, different password. */
  kind: "new" | "update";
}

/**
 * Result of comparing a just-submitted credential against the store:
 *  - "absent"           — no entry for this origin+username → offer Save
 *  - "identical"        — same origin+username+password → offer NOTHING
 *  - "password-differs" — same origin+username, new password → offer Update
 */
export type CredentialMatch = "absent" | "identical" | "password-differs";

/**
 * host → main: persist (or drop) a previously-staged credential, addressed by
 * ORIGIN. No secret crosses this boundary — main resolves the plaintext from its
 * own staging map.
 */
export interface CommitSaveRequest {
  origin: string;
}

/** host → main: discard a staged credential without persisting it. */
export interface DismissSaveRequest {
  origin: string;
}

/**
 * host → main: request that main deliver a matched credential's secret directly
 * to a guest. Carries NO secret — only the target guest id and the opaque match
 * id previously returned by `lookup`. Main resolves the secret and sends it to
 * the guest; it is never returned to this (host) invoker.
 */
export interface ApplyFillRequest {
  /** The guest webContents that should receive the fill. */
  webContentsId: number;
  /** Opaque backend match id from a prior `PasswordLookupResult`. */
  id: string;
}

/**
 * main → guest: the one-shot fill value, delivered straight to the guest
 * webContents (never via the host renderer). The guest writes it into the
 * detected fields on the human's Fill gesture.
 */
export interface ApplyFillCommand {
  username: string;
  password: string;
}

/**
 * main → host: a login form was detected in a guest. Forwarded so the host can
 * offer autofill for the matching origin. Carries only field *shapes* (no
 * values) plus the guest webContents id so multiple panels don't cross-wire.
 */
export interface FormDetectedNotice {
  /** The guest webContents the form was detected in. */
  webContentsId: number;
  form: DetectedLoginForm;
}

/**
 * Result of a host→main command that performs a side effect but returns no
 * secret (commit/dismiss/applyFill). `ok:false` means nothing was staged/found.
 */
export interface PasswordActionResult {
  ok: boolean;
}

/**
 * Pluggable credential store (R3). P0 ships only `NoopBackend`; P2 adds a
 * KDBX-backed implementation. A future Bitwarden `bw`-CLI adapter (P5,
 * deferred, not v1) would implement this same interface.
 *
 * All plaintext handling stays in the main process behind this interface; the
 * password never crosses back to the renderer/guest except as a single
 * `PasswordFillValue` on a user gesture.
 */
export interface CredentialBackend {
  lookup(req: PasswordLookupRequest): Promise<PasswordLookupResult>;
  save(req: PasswordSaveRequest): Promise<void>;
  /** Returns the one-shot fill value for a match id, or null if unknown. */
  getFillValue(req: PasswordFillRequest): Promise<PasswordFillValue | null>;
  /**
   * Classify a just-submitted credential against the store so the save prompt
   * is suppressed when nothing changed and says "Update" when the password
   * differs. The comparison happens in main (plaintext never leaves it).
   */
  matchCredential(req: PasswordSaveRequest): Promise<CredentialMatch>;
}
