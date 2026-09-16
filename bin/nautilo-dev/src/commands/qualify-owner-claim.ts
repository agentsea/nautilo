/**
 * D508 0.4.1 — one explicitly-authorized, disposable, local real-Logto
 * qualification. This is deliberately a parent/worker command: the parent
 * owns exact teardown even when the browser or worker is interrupted.
 *
 * No generated capability or credential is serialized, logged, passed on a
 * command line, or put in an environment variable. The only durable evidence
 * is a redacted lifecycle receipt.
 */
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import type { BrowserContext, Page, Request, Response } from "playwright";
import {
  and, credentials, eq, getSharedDirectDb, groupMembers, groups, inviteRedemptions, invites, recoveryCodes,
  isNull, profiles, users,
} from "@nautilo/db";
import { resolveInstanceUncached, resolveNautiloStorageRoot } from "@nautilo/config";
import { deleteInstance } from "./delete-instance";
import { devStackCmd } from "./dev-stack";
import { dockerComposeDbDevPrefixRaw, dockerComposeNautiloPrefixRaw, NAUTILO_REPO_ROOT } from "../lib/compose-infra";
import { findListenerPid, looksLikeNautiloServer } from "../lib/listener-pid";

const OPT_IN_ENV = "NAUTILO_D508_DISPOSABLE_QUALIFICATION";
const WORKER_ENV = "NAUTILO_D508_QUALIFICATION_WORKER";
/**
 * D508 qualification's complete timing contract. This is deliberately local
 * to the disposable harness: it is not a production timeout framework and is
 * not configurable through argv or environment.
 *
 * - stackReadyMs is the existing dev-stack /health wait contract.
 * - browserStepMs preserves the established bounded Playwright operation wait.
 * - parentRunMs preserves the existing six-minute disposable-run ceiling.
 * - claimTtlMs mirrors the server controller's accepted owner-claim TTL.
 */
export type D508QualificationTimingPolicy = Readonly<{
  stackReadyMs: number;
  browserStepMs: number;
  traceDeliveryMs: number;
  parentRunMs: number;
  claimTtlMs: number;
  claimInstallSkewMs: number;
  childTerminationGraceMs: number;
}>;

export const DEFAULT_D508_QUALIFICATION_TIMING: D508QualificationTimingPolicy = Object.freeze({
  // Matches bin/nautilo-dev/src/commands/dev-stack.ts HEALTH_WAIT_MS.
  stackReadyMs: 60_000,
  // Existing D508 browser-operation bound; it accommodates local Logto cold start.
  browserStepMs: 120_000,
  // A separate bounded wait for asynchronous Node-side trace delivery.
  traceDeliveryMs: 120_000,
  // Existing D508 parent ceiling; it bounds the complete disposable run.
  parentRunMs: 360_000,
  // Mirrors packages/server/src/lib/owner-claim-control.ts OWNER_CLAIM_TTL_MS.
  claimTtlMs: 15 * 60 * 1000,
  // Avoid a controller-install race at the exact server expiry boundary.
  claimInstallSkewMs: 1_000,
  // Existing SIGTERM-to-SIGKILL grace, now explicit and testable.
  childTerminationGraceMs: 5_000,
});

/** Internal seam only; callers must supply a complete, positive policy. */
export function validateD508QualificationTiming(policy: D508QualificationTimingPolicy): D508QualificationTimingPolicy {
  for (const [name, value] of Object.entries(policy)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`invalid D508 qualification timing: ${name}`);
    }
  }
  if (policy.claimInstallSkewMs >= policy.claimTtlMs) {
    throw new Error("invalid D508 qualification timing: claimInstallSkewMs");
  }
  return policy;
}

class D508QualificationAborted extends Error {}

/**
 * Makes browser/trace work stop promptly when its parent has begun teardown.
 * The rejected result is intentionally opaque; callers map it to a typed,
 * redacted D508 failure rather than emitting browser implementation details.
 */
export function awaitD508QualificationWork<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (signal === undefined) return work;
  if (signal.aborted) return Promise.reject(new D508QualificationAborted());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new D508QualificationAborted());
    signal.addEventListener("abort", onAbort, { once: true });
    void work.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      // The caller maps all underlying browser errors to a typed redacted
      // receipt. Keep only Error values here; never relay arbitrary payloads.
      (error) => { signal.removeEventListener("abort", onAbort); reject(error instanceof Error ? error : new D508QualificationAborted()); },
    );
  });
}

export type D508RestartChild = Readonly<{
  exited: Promise<number>;
  kill: (signal: NodeJS.Signals) => void;
}>;

/**
 * A restart child can be interrupted after server-stop but before server-start.
 * Await its terminal exit so parent teardown cannot race a late replacement.
 */
export async function terminateD508RestartChild(
  child: D508RestartChild,
  graceMs: number,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<void> {
  try { child.kill("SIGTERM"); } catch { /* still await the child below */ }
  const exitedDuringGrace = await Promise.race([
    child.exited.then(() => true),
    sleep(graceMs).then(() => false),
  ]);
  if (!exitedDuringGrace) {
    try { child.kill("SIGKILL"); } catch { /* SIGKILL may race a natural exit */ }
    await child.exited;
  }
}

/**
 * Bounds a redacted browser checkpoint that is not itself a Playwright call.
 * This is intentionally powered by the existing browser-step policy, not a
 * second qualification timeout. Its cleanup runs on resolve, failure, abort,
 * and timeout so an abandoned trace latch cannot keep a timer alive.
 */
export function awaitD508BrowserLatch(
  work: Promise<unknown>,
  stage: D508BrowserStage,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback();
    };
    const abort = () => finish(() => reject(new D508QualificationAborted()));
    const timer = setTimeout(() => finish(() => reject(new D508QualificationError("browser-capture", "browser_trace", stage))), timeoutMs);
    if (signal?.aborted) { abort(); return; }
    signal?.addEventListener("abort", abort, { once: true });
    void work.then(
      () => finish(resolve),
      () => finish(() => reject(new D508QualificationError("browser-capture", "browser_trace", stage))),
    );
  });
}

export type D508Bind409ResponseWait = Promise<void> & Readonly<{ dispose: () => void }>;
export type D508BindSuccessResponseWait = Promise<void> & Readonly<{ dispose: () => void }>;
type D508BindResponsePage = {
  on(event: "response", listener: (response: Response) => void): unknown;
  off(event: "response", listener: (response: Response) => void): unknown;
};

/**
 * Pre-arm the wrong-subject server boundary before hosted sign-in. It accepts
 * only the real bind endpoint's POST response with status 409. Bodies, URL
 * details, and account material never leave this closure or enter a receipt.
 */
export function awaitD508ExactBind409Response(
  page: D508BindResponsePage,
  serverUrl: string,
  timeoutMs: number,
  stage: D508BrowserStage,
  signal?: AbortSignal,
): D508Bind409ResponseWait {
  const serverOrigin = new URL(serverUrl).origin;
  let dispose = () => {};
  const wait = new Promise<void>((resolve, reject) => {
    let settled = false;
    const failure = (actual: "no-matching-response" | "non-409") => new D508QualificationError("browser-capture", "browser_contract", stage, [{
      kind: "wrong-account-bind-response", expected: "exact-409", actual,
    }]);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("response", onResponse);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new D508QualificationAborted()));
    const onResponse = (response: Response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== serverOrigin || url.pathname !== "/api/bind-logto-user" || response.request().method() !== "POST") return;
        if (response.status() !== 409) { finish(() => reject(failure("non-409"))); return; }
        finish(resolve);
      } catch { /* unparseable or inaccessible response cannot satisfy this latch */ }
    };
    const timer = setTimeout(() => finish(() => reject(failure("no-matching-response"))), timeoutMs);
    dispose = () => finish(() => undefined);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    page.on("response", onResponse);
  });
  void wait.catch(() => undefined);
  return Object.assign(wait, { dispose });
}

/** Pre-arm the original-owner recovery bind without retaining status values or bodies. */
export function awaitD508ExactBindSuccessResponse(
  page: D508BindResponsePage,
  serverUrl: string,
  timeoutMs: number,
  stage: D508BrowserStage,
  signal?: AbortSignal,
): D508BindSuccessResponseWait {
  const serverOrigin = new URL(serverUrl).origin;
  let dispose = () => {};
  const wait = new Promise<void>((resolve, reject) => {
    let settled = false;
    let saw401 = false;
    const failure = (actual: "no-final-2xx" | "unexpected-response-sequence") => new D508QualificationError("browser-capture", "browser_contract", stage, [{
      kind: "original-owner-bind-response", expected: "2xx-or-401-2xx", actual,
    }]);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("response", onResponse);
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new D508QualificationAborted()));
    const onResponse = (response: Response) => {
      try {
        const url = new URL(response.url());
        if (url.origin !== serverOrigin || url.pathname !== "/api/bind-logto-user" || response.request().method() !== "POST") return;
        const classification = classifyD508BindResponseStatus(response.status());
        if (classification === "2xx" && !saw401) { finish(resolve); return; }
        if (classification === "401" && !saw401) { saw401 = true; return; }
        if (classification === "2xx" && saw401) { finish(resolve); return; }
        finish(() => reject(failure("unexpected-response-sequence")));
      } catch { /* malformed response cannot satisfy this strictly redacted latch */ }
    };
    const timer = setTimeout(() => finish(() => reject(failure("no-final-2xx"))), timeoutMs);
    dispose = () => finish(() => undefined);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
    page.on("response", onResponse);
  });
  void wait.catch(() => undefined);
  return Object.assign(wait, { dispose });
}

export type D508PostLogoutReturnEvidence = Readonly<{
  outcome: "clean-return";
  foreignCommitObserved: boolean;
  foreignRequestFailed: boolean;
}>;
export type D508PostLogoutReturnWait = Promise<D508PostLogoutReturnEvidence> & Readonly<{ dispose: () => void }>;
type D508LogoutPage = Pick<Page, "mainFrame"> & {
  on(event: "request" | "requestfailed", listener: (request: Request) => void): unknown;
  on(event: "framenavigated", listener: (frame: ReturnType<Page["mainFrame"]>) => void): unknown;
  off(event: "request" | "requestfailed", listener: (request: Request) => void): unknown;
  off(event: "framenavigated", listener: (frame: ReturnType<Page["mainFrame"]>) => void): unknown;
};

/**
 * Arm this before a logout click. Unlike `waitForURL`, it cannot be
 * satisfied by the current `/claim` document: it first requires a foreign
 * main-frame navigation request, then one exact return commit. A 302 can
 * return without a foreign document commit, which is still a valid logout.
 * URLs remain inside this helper; failure evidence is semantic only.
 */
export function awaitD508PostLogoutReturn(
  page: D508LogoutPage,
  serverUrl: string,
  timeoutMs: number,
  input: Readonly<{
    flow: "profile" | "account-switch";
    leaveStage: D508BrowserStage;
    returnStage: D508BrowserStage;
    signal?: AbortSignal;
  }>,
): D508PostLogoutReturnWait {
  const serverOrigin = new URL(serverUrl).origin;
  const mainFrame = page.mainFrame();
  let dispose = () => {};
  const wait = new Promise<D508PostLogoutReturnEvidence>((resolve, reject) => {
    let settled = false;
    let foreignRequest = false;
    let foreignCommit = false;
    let foreignRequestFailed = false;
    const actual = (): "no-foreign-request" | "foreign-request-no-return-commit" | "foreign-commit-no-clean-return" =>
      !foreignRequest ? "no-foreign-request" : foreignCommit ? "foreign-commit-no-clean-return" : "foreign-request-no-return-commit";
    const failure = (stage: D508BrowserStage) => new D508QualificationError("browser-capture", "browser_contract", stage, [{
      kind: "signed-out-navigation", flow: input.flow, expected: "clean-return", actual: actual(), foreignRequestFailed,
    }]);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      page.off("request", onRequest);
      page.off("requestfailed", onRequestFailed);
      page.off("framenavigated", onFrame);
      input.signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new D508QualificationAborted()));
    const onRequest = (request: Request) => {
      if (!request.isNavigationRequest() || request.frame() !== mainFrame) return;
      try {
        if (new URL(request.url()).origin !== serverOrigin) foreignRequest = true;
      } catch { finish(() => reject(failure(input.leaveStage))); }
    };
    const onRequestFailed = (request: Request) => {
      if (!request.isNavigationRequest() || request.frame() !== mainFrame) return;
      try { if (new URL(request.url()).origin !== serverOrigin) foreignRequestFailed = true; } catch { /* redacted diagnostic remains false */ }
    };
    const onFrame = (frame: ReturnType<Page["mainFrame"]>) => {
      if (frame !== mainFrame) return;
      let url: URL;
      try { url = new URL(frame.url()); } catch { finish(() => reject(failure(foreignRequest ? input.returnStage : input.leaveStage))); return; }
      if (url.origin !== serverOrigin) {
        if (!foreignRequest) { finish(() => reject(failure(input.leaveStage))); return; }
        foreignCommit = true;
        return;
      }
      if (!foreignRequest) {
        finish(() => reject(failure(input.leaveStage)));
        return;
      }
      if (url.pathname !== "/claim" || url.search !== "" || url.hash !== "") {
        finish(() => reject(failure(input.returnStage)));
        return;
      }
      finish(() => resolve({ outcome: "clean-return", foreignCommitObserved: foreignCommit, foreignRequestFailed }));
    };
    const timer = setTimeout(() => finish(() => reject(failure(foreignRequest ? input.returnStage : input.leaveStage))), timeoutMs);
    dispose = () => finish(() => undefined);
    if (input.signal?.aborted) { onAbort(); return; }
    input.signal?.addEventListener("abort", onAbort, { once: true });
    page.on("request", onRequest);
    page.on("requestfailed", onRequestFailed);
    page.on("framenavigated", onFrame);
  });
  // The click and journey are awaited concurrently by callers, but an early
  // navigation failure must never become an unhandled rejection meanwhile.
  void wait.catch(() => undefined);
  return Object.assign(wait, { dispose });
}

export type D508TraceStartWait = Promise<void> & Readonly<{ dispose: () => void }>;

/** Pre-arm Node-side trace delivery; browser navigation may settle first. */
export function awaitD508SignOutTraceStarted(
  subscribe: (listener: (event: unknown) => void) => () => void,
  timeoutMs: number,
  stage: D508BrowserStage,
  signal?: AbortSignal,
): D508TraceStartWait {
  let dispose = () => {};
  const wait = new Promise<void>((resolve, reject) => {
    let settled = false;
    let unsubscribe = () => {};
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(new D508QualificationAborted()));
    const onEvent = (event: unknown) => {
      if (event && typeof event === "object" && (event as Record<string, unknown>)["commandKind"] === "sign-out" && (event as Record<string, unknown>)["result"] === "started") {
        finish(resolve);
      }
    };
    unsubscribe = subscribe(onEvent);
    const timer = setTimeout(() => finish(() => reject(new D508QualificationError("browser-capture", "browser_trace", stage))), timeoutMs);
    dispose = () => finish(() => undefined);
    if (signal?.aborted) { onAbort(); return; }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
  void wait.catch(() => undefined);
  return Object.assign(wait, { dispose });
}

function assertD508SignedOutProfileCheckpoint(
  checkpoint: "hydrated-copy" | "owner-io" | "session-custody" | "reservation" | "no-owner",
  actual: boolean,
  stage: D508BrowserStage,
): void {
  if (!actual) throw new D508QualificationError("browser-capture", "browser_contract", stage, [{
    kind: "signed-out-profile-checkpoint", checkpoint, expected: true, actual,
  }]);
}

// Validate our fixed policy at module load, so an accidental edit cannot turn a
// bounded disposable qualification into an unbounded process.
validateD508QualificationTiming(DEFAULT_D508_QUALIFICATION_TIMING);
export const D508_QUALIFIED_LOGTO_IMAGE = "ghcr.io/logto-io/logto:1.38.0";

export const D508_QUALIFICATION_PHASES = [
  "preflight", "workbench-build", "stack-start", "controller-install", "browser-capture",
  "hosted-auth", "owner-profile", "guide-refresh", "db-invariants", "teardown",
] as const;
export type D508QualificationPhase = (typeof D508_QUALIFICATION_PHASES)[number];
export type D508QualificationFailureCode =
  | "opt_in_required" | "invalid_arguments" | "browser_runtime" | "workbench_build" | "stack_start" | "controller_install"
  | "browser_contract" | "browser_trace" | "db_invariant" | "teardown" | "parent_timeout";

/**
 * Redacted semantic browser checkpoints. These are deliberately product-flow
 * names, never DOM selectors, hostnames, URLs, credentials, or claim values.
 */
export const D508_BROWSER_STAGES = [
  "claim-entry", "owner-handle", "hosted-identifier", "hosted-password",
  "hosted-browser-back", "browser-back-return", "browser-back-resume",
  "fresh-browser-signed-out", "fresh-browser-hosted-login", "fresh-browser-exact-return",
  "fresh-browser-guide-action", "fresh-browser-admin-route", "fresh-browser-security-section",
  "fresh-browser-posture-button", "fresh-browser-posture-view", "fresh-browser-posture-edit",
  "fresh-browser-posture-controls", "fresh-browser-posture-selection",
  "fresh-browser-target-verification",
  "pin-gated-posture", "pin-gated-posture-response", "pin-gated-posture-refresh",
  "owner-profile", "recovery-codes", "recovery-refresh", "recovery-terminal", "recovery-acknowledgement",
  "refresh-before-bind", "callback-claim-transition", "held-bind-before-release", "pre-reload-bind-blocked", "post-reload-bootstrap", "pre-react-reload", "resumed-bind-evidence", "post-reload-profile-visible", "refresh-after-bind-validation", "two-tab-entry", "two-tab-reservation", "server-restart-after-bind", "post-restart-profile-visible", "tab-loss-recovery", "controller-reissue", "stale-custody-fence", "resume-owner-profile", "wrong-account-provision", "signed-out-profile", "signed-out-profile-signout-started", "signed-out-profile-navigation-away", "signed-out-profile-return", "signed-out-profile-hydrated-copy", "signed-out-profile-owner-io", "signed-out-profile-custody", "signed-out-profile-reservation", "signed-out-profile-no-owner", "wrong-account-hosted-login-entry", "wrong-account-hosted-login-submit", "wrong-account-bind-response", "wrong-account-recovery-ui", "original-owner-retry-action", "original-owner-hosted-login-entry", "original-owner-hosted-login-submit", "original-owner-bind-response", "original-owner-profile-visible", "original-owner-handle-absence", "original-owner-profile-submit", "original-owner-recovery-codes", "original-owner-product-navigation", "account-switch-signout-started", "account-switch-navigation-away", "account-switch-return", "expired-claim-response", "expired-claim-recovery", "replay-response", "replay-recovery", "lost-bind-response", "lost-completion-response", "lost-response-terminal", "guide-navigation", "product-navigation", "guide-refresh", "coordinator-trace", "contract-validation",
] as const;
export type D508BrowserStage = (typeof D508_BROWSER_STAGES)[number];

export type D508QualificationFinish = "guide" | "product";

export const D508_NOT_RUN_MATRIX_CASES = [
  // Product, recovery refresh, and refresh-before-bind cases remain not-run
  // until a real disposable browser receipt passes; attempted qualification
  // is not success evidence.
  "product-finish", "recovery-refresh", "refresh-before-bind", "refresh-after-bind-validation", "strict-mode", "two-tabs", "signed-out-profile", "restart-after-bind",
  "lost-bind", "lost-complete", "tab-loss-reissue", "wrong-subject", "expired-claim",
  "replay", "callback-error-back", "fresh-browser-return",
  "pin-gated-action", "public-https-caddy", "old-new-handoff",
] as const;

export class D508QualificationError extends Error {
  constructor(
    readonly phase: D508QualificationPhase,
    readonly code: D508QualificationFailureCode,
    readonly browserStage: D508BrowserStage | null = null,
    readonly contractDeltas: readonly D508ContractDelta[] = [],
  ) {
    super(`D508 qualification failed during ${phase} (${code})${browserStage === null ? "" : ` at ${browserStage}`}`);
  }
}

/** Stable receipt shape: safe to emit after a failed disposable worker. */
export function redactedD508FailureReceipt(error: unknown): {
  readonly outcome: "failed";
  readonly phase: D508QualificationPhase;
  readonly code: D508QualificationFailureCode;
  readonly browserStage: D508BrowserStage | null;
  readonly contractDeltas?: readonly D508ContractDelta[];
} {
  if (error instanceof D508QualificationError) {
    return {
      outcome: "failed",
      phase: error.phase,
      code: error.code,
      browserStage: error.browserStage,
      ...(error.contractDeltas.length === 0 ? {} : { contractDeltas: error.contractDeltas }),
    };
  }
  return { outcome: "failed", phase: "browser-capture", code: "browser_contract", browserStage: "claim-entry" };
}

function withBrowserStage(error: unknown, stage: D508BrowserStage): D508QualificationError {
  if (error instanceof D508QualificationError) {
    return error.browserStage === null
      ? new D508QualificationError(error.phase, error.code, stage, error.contractDeltas)
      : error;
  }
  // Never allow a Playwright error to surface: it can include a fragment URL.
  return new D508QualificationError("browser-capture", "browser_contract", stage);
}

export type RedactedRequestObservation = { readonly method: string; readonly origin: "server" | "logto" | "other"; readonly pathname: string };
export type RedactedNavigationObservation = { readonly origin: "server" | "logto" | "other"; readonly pathname: string };
export type RedactedCoordinatorEvent = { readonly operationId: number; readonly phase: string; readonly commandKind: string; readonly result: string; readonly navigationIntent: string | null };

/** Redacted evidence specific to refresh-before-bind and signed-in profile validation. */
export type D508BindResponseClassification = "2xx" | "401" | "other";

export type D508RefreshBeforeBindEvidence = Readonly<{
  refreshBeforeBind: Readonly<{
    callbackTransitionObserved: true;
    postReloadBootObserved: true;
    claimUnboundBeforeHeldBindBlock: true;
    heldBindBlockedBeforeReload: true;
    preReloadBlockedBindCount: number;
    postReloadTraceEpochIndex: number;
    responseClassifications: readonly D508BindResponseClassification[];
  }>;
  refreshAfterBindValidation: Readonly<{
    claimReservationUnchanged: true;
    signedInProfileBindValidated: true;
    responseClassifications: readonly D508BindResponseClassification[];
  }>;
}>;

export type D508TwoTabReissueEvidence = Readonly<{
  pageAAndBHaveSessionOnlyCustody: true;
  pageBDidNotMutateDuringAReservation: true;
  pageAClosedAndPageBReportedControllerReissueGuidance: true;
  staleCustodyClearedBeforeSecondRefresh: true;
  controllerReplacementRevokedAAndRetainedReservation: true;
  sameSubjectResumedWithoutHandleOrOidc: true;
  successfulCompletions: 1;
}>;

/** Redacted proof that only the host server was restarted between bind and profile completion. */
export type D508RestartAfterBindEvidence = Readonly<{
  hostServerRestartedWithDifferentPid: true;
  appPostgresLogtoCoreAndLogtoPostgresUnchanged: true;
  reservationUnchanged: true;
  noCompletedOwnerBeforeProfileSubmit: true;
  noOwnerIoOrOidcBeforeReload: true;
  profileBindValidationAfterReload: true;
  rawClaimRemainedSessionOnly: true;
}>;

/** Redacted proof of transport loss only after each authoritative write committed. */
export type D508LostResponsesEvidence = Readonly<{
  bindResponseCommittedBeforeAbort: true;
  bindReobservedWithoutChangingReservation: true;
  completionResponseCommittedBeforeAbort: true;
  completionRecoveryFingerprintUnchanged: true;
  completionReobservedSetupStatusOnce: true;
  truthfulNoCodeTerminalWithSecurityLink: true;
  handoffClearedWithSessionOnlyTerminalMarker: true;
}>;

export type D508SignedOutWrongAccountEvidence = Readonly<{
  wrongAccountCreatedWithoutServerBind: true;
  signedOutProfilePreservedSessionOnlyCustody: true;
  wrongSubjectBind409Observed: true;
  wrongSubjectReceivedOnlyClaimReserved: true;
  wrongSubjectDidNotChangeReservationOrCompleteOwner: true;
  originalSubjectRecoveredWithoutHandleEntry: true;
  originalSubjectCompletedExactlyOnce: true;
}>;

/** Redacted proof that a completed owner can return in a clean browser and act as an administrator. */
export type D508FreshBrowserAdminEvidence = Readonly<{
  freshBrowserStartedSignedOut: true;
  exactServerGuideReturn: true;
  authReturnConsumed: true;
  noOwnerClaimIo: true;
  oneOidcAuthorization: true;
  configureServerLinkReachedAdmin: true;
  pinGatedPostureChangedOnce: true;
  refreshedPostureVisible: true;
}>;

/**
 * Seed-account provisioning must fail before Fastify without looking like a
 * lost write. This is the ordinary documented bind 500 envelope, so the API
 * client constructs OwnerClaimApiError and the coordinator records `failed`,
 * never its ambiguous-write/reobserve branch.
 */
export type D508SeedBindFailureResponse = Readonly<{
  status: 500;
  contentType: "application/json";
  json: Readonly<{ error: "claim_reservation_invariant"; code: "claim_reservation_invariant" }>;
}>;

export const D508_SEED_BIND_FAILURE_RESPONSE: D508SeedBindFailureResponse = Object.freeze({
  status: 500,
  contentType: "application/json",
  json: Object.freeze({ error: "claim_reservation_invariant", code: "claim_reservation_invariant" }),
});

/** Frozen route-500 classification; reject a transport-like or loose envelope. */
export function assertD508SeedBindFailureResponse(value: unknown): D508SeedBindFailureResponse {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 3
    || (value as Record<string, unknown>)["status"] !== 500
    || (value as Record<string, unknown>)["contentType"] !== "application/json"
  ) throw new Error("invalid D508 seed bind response");
  const json = (value as Record<string, unknown>)["json"];
  if (
    !json || typeof json !== "object" || Array.isArray(json)
    || Object.keys(json).length !== 2
    || (json as Record<string, unknown>)["error"] !== "claim_reservation_invariant"
    || (json as Record<string, unknown>)["code"] !== "claim_reservation_invariant"
  ) throw new Error("invalid D508 seed bind response");
  return value as D508SeedBindFailureResponse;
}

const D508_NON_LAUNCH_NEW_OWNER_COMMANDS = [
  "preview-claim", "prepare-signup", "bind-subject", "complete-profile",
] as const;
type D508NonLaunchNewOwnerCommand = (typeof D508_NON_LAUNCH_NEW_OWNER_COMMANDS)[number];
type D508NewOwnerCommand = D508NonLaunchNewOwnerCommand | "launch-logto-signup";
type D508TraceResult = "started" | "succeeded" | "failed" | "aborted" | "stale" | "unsupported";

/**
 * Bounded failure evidence for the disposable browser contract. It includes
 * only code-owned command/result counts and existing redacted observations;
 * no URL query/fragment, DOM detail, Human input, claim, token, or codes.
 */
export type D508ContractDelta =
  | { readonly kind: "trace-unrecognized-command-cardinality"; readonly expected: 0; readonly actual: number }
  | { readonly kind: "trace-result"; readonly commandKind: D508NewOwnerCommand | "navigate-guide" | "navigate-product"; readonly result: D508TraceResult; readonly expected: number; readonly actual: number }
  | { readonly kind: "trace-operation-cardinality"; readonly commandKind: D508NewOwnerCommand | "navigate-guide" | "navigate-product"; readonly expected: number; readonly actual: number }
  | { readonly kind: "pre-reload-bind-interruption"; readonly expected: Readonly<{ bindStarts: 1; reobserveStarts: 1; completeProfileStarts: 0; successful: 0; blockedRoutesEqualMutationStarts: true }>; readonly actual: Readonly<{ bindStarts: number; reobserveStarts: number; completeProfileStarts: number; successful: number; blockedRoutes: number; mutationStarts: number }> }
  | { readonly kind: "bind-response-sequence"; readonly expected: readonly (readonly D508BindResponseClassification[])[]; readonly actual: readonly D508BindResponseClassification[] }
  | { readonly kind: "post-reload-commit-cardinality"; readonly expected: 1; readonly actual: number }
  | { readonly kind: "post-reload-trace-spine"; readonly expected: readonly string[]; readonly actual: readonly string[] }
  | { readonly kind: "browser-back-trace-spine"; readonly expected: readonly string[]; readonly actual: readonly string[] }
  | { readonly kind: "tab-trace-spine"; readonly tab: "A" | "B" | "C"; readonly expected: readonly string[]; readonly actual: readonly string[] }
  | { readonly kind: "lost-response-spine"; readonly expected: readonly string[]; readonly actual: readonly string[] }
  | { readonly kind: "lost-response-latch"; readonly expected: true; readonly actual: boolean }
  | { readonly kind: "signed-out-navigation"; readonly flow: "profile" | "account-switch"; readonly expected: "clean-return"; readonly actual: "no-foreign-request" | "foreign-request-no-return-commit" | "foreign-commit-no-clean-return"; readonly foreignRequestFailed: boolean }
  | { readonly kind: "signed-out-profile-checkpoint"; readonly checkpoint: "hydrated-copy" | "owner-io" | "session-custody" | "reservation" | "no-owner"; readonly expected: true; readonly actual: boolean }
  | { readonly kind: "wrong-account-bind-response"; readonly expected: "exact-409"; readonly actual: "no-matching-response" | "non-409" }
  | { readonly kind: "original-owner-bind-response"; readonly expected: "2xx-or-401-2xx"; readonly actual: "no-final-2xx" | "unexpected-response-sequence" }
  | { readonly kind: "request-cardinality"; readonly method: "POST" | "GET"; readonly origin: "server" | "logto"; readonly pathname: "/api/owner-claim/preview" | "/api/owner-claim/prepare-auth" | "/api/bind-logto-user" | "/api/owner-claim/complete-profile" | "/api/setup/status" | "/oidc/auth"; readonly expected: number; readonly actual: number }
  | { readonly kind: "navigation-cardinality"; readonly origin: "server"; readonly pathname: "/help/server" | "/"; readonly expectedAtLeast: number; readonly actual: number };

/** Exact D508 disposable instance ID: valid under the public CLI's 16-char instance contract. */
export const D508_DISPOSABLE_INSTANCE_ID_RE = /^d508[a-f0-9]{12}$/;

export function createD508QualificationRunId(bytes: Buffer = randomBytes(6)): string {
  if (bytes.length !== 6) throw new Error("D508 disposable instance ID requires exactly 6 random bytes");
  return `d508${bytes.toString("hex")}`;
}

/** Canonical first-owner capability shape consumed by the server lookup. */
export function createCanonicalOwnerClaimCapability(bytes: Buffer = randomBytes(24)): string {
  if (bytes.length !== 24) throw new Error("owner claim capability requires 24 random bytes");
  return `inv_${bytes.toString("base64url")}`;
}

export const D508_QUALIFICATION_SCENARIOS = ["two-tab-reissue", "lost-responses", "signed-out-wrong-account", "expiry-replay", "browser-back", "fresh-browser-admin"] as const;
export type D508QualificationScenario = (typeof D508_QUALIFICATION_SCENARIOS)[number];
export type D508QualificationArgs =
  | Readonly<{ worker: true; runId: string; scenario: D508QualificationScenario }>
  | Readonly<{ worker: false; scenario?: D508QualificationScenario }>;

export function parseD508QualificationArgs(argv: readonly string[]): D508QualificationArgs {
  const worker = argv.includes("--worker");
  const index = argv.indexOf("--run-id");
  const runId = index >= 0 ? argv[index + 1] : undefined;
  const scenarioIndex = argv.indexOf("--scenario");
  const scenario = scenarioIndex >= 0 ? argv[scenarioIndex + 1] : undefined;
  const validScenario = typeof scenario === "string" && (D508_QUALIFICATION_SCENARIOS as readonly string[]).includes(scenario);
  const validWorker = worker && argv.length === 5 && index >= 0 && scenarioIndex >= 0 && typeof runId === "string" && D508_DISPOSABLE_INSTANCE_ID_RE.test(runId) && validScenario;
  const validParent = !worker && (argv.length === 0 || (argv.length === 2 && scenarioIndex === 0 && validScenario));
  const valid = validWorker || validParent;
  if (!valid) throw new D508QualificationError("preflight", "invalid_arguments");
  return worker ? { worker: true, runId: runId!, scenario: scenario as D508QualificationScenario } : scenario === undefined ? { worker: false } : { worker: false, scenario: scenario as D508QualificationScenario };
}

export function allowsD508QualificationWorker(env: NodeJS.ProcessEnv): boolean {
  return env[OPT_IN_ENV] === "1" && env[WORKER_ENV] === "1";
}

export function defaultD508CleanupState(instanceId: string): { readonly ports: number[]; readonly composeProject: string } {
  return { ports: [], composeProject: `nautilo-${instanceId}` };
}

/**
 * Prove the package-pinned Playwright browser can actually launch before an
 * expensive disposable stack is created. Installing the npm package alone is
 * insufficient because Playwright downloads its browser runtime separately.
 */
export async function preflightD508BrowserRuntime(
  launch: (() => Promise<{ close(): Promise<void> }>) | undefined = undefined,
): Promise<void> {
  try {
    const launchBrowser = launch ?? (async () => {
      const { chromium } = await import("playwright");
      return chromium.launch({ headless: true });
    });
    const browser = await launchBrowser();
    await browser.close();
  } catch {
    throw new D508QualificationError("preflight", "browser_runtime");
  }
}

function originFor(value: URL, serverOrigin: string, logtoOrigin: string | null): "server" | "logto" | "other" {
  if (value.origin === serverOrigin) return "server";
  if (logtoOrigin !== null && value.origin === logtoOrigin) return "logto";
  return "other";
}

/** Stores only method/origin class/path. Query, fragment, body and values never escape the browser. */
export function redactRequestObservation(value: string, method: string, serverUrl: string, logtoOrigin: string | null): RedactedRequestObservation {
  const url = new URL(value);
  return { method, origin: originFor(url, new URL(serverUrl).origin, logtoOrigin), pathname: url.pathname };
}

export function redactNavigationObservation(value: string, serverUrl: string, logtoOrigin: string | null): RedactedNavigationObservation {
  const url = new URL(value);
  return { origin: originFor(url, new URL(serverUrl).origin, logtoOrigin), pathname: url.pathname };
}

/** Classify OIDC before navigation events, without retaining its URL. */
export function observeD508Request(
  value: string,
  method: string,
  serverUrl: string,
  knownLogtoOrigin: string | null,
): { readonly observation: RedactedRequestObservation; readonly logtoOrigin: string | null } {
  const url = new URL(value);
  const nextLogtoOrigin =
    knownLogtoOrigin === null &&
    url.origin !== new URL(serverUrl).origin &&
    url.pathname === "/oidc/auth"
      ? url.origin
      : knownLogtoOrigin;
  return {
    observation: redactRequestObservation(value, method, serverUrl, nextLogtoOrigin),
    logtoOrigin: nextLogtoOrigin,
  };
}

export function assertRedactedCoordinatorTrace(value: unknown): RedactedCoordinatorEvent[] {
  if (!Array.isArray(value) || value.length === 0) throw new D508QualificationError("browser-capture", "browser_trace");
  const result: RedactedCoordinatorEvent[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") throw new D508QualificationError("browser-capture", "browser_trace");
    const event = item as Record<string, unknown>;
    if (Object.keys(event).some((key) => !["operationId", "phase", "commandKind", "result", "navigationIntent"].includes(key))) {
      throw new D508QualificationError("browser-capture", "browser_trace");
    }
    const operationId = event["operationId"];
    if (typeof operationId !== "number" || !Number.isSafeInteger(operationId) || typeof event["phase"] !== "string" || typeof event["commandKind"] !== "string" || typeof event["result"] !== "string" || (event["navigationIntent"] !== null && typeof event["navigationIntent"] !== "string")) {
      throw new D508QualificationError("browser-capture", "browser_trace");
    }
    result.push({ operationId, phase: event["phase"], commandKind: event["commandKind"], result: event["result"], navigationIntent: event["navigationIntent"] });
  }
  return result;
}

/** Exact second-document bind proof, independent of the profile renderer. */
export function isD508ResumedBindSuccess(value: unknown): boolean {
  return Boolean(
    value && typeof value === "object"
    && (value as Record<string, unknown>)["commandKind"] === "bind-subject"
    && (value as Record<string, unknown>)["result"] === "succeeded",
  );
}

/** Strictly bounds the qualification-only callback interception. */
export function isD508CallbackClaimTarget(input: Readonly<{
  serverOrigin: string;
  currentOrigin: string;
  currentPathname: string;
  historyTarget: string | null;
}>): boolean {
  if (input.currentOrigin !== input.serverOrigin || input.currentPathname !== "/auth/callback" || input.historyTarget === null) return false;
  try {
    const target = new URL(input.historyTarget, input.serverOrigin);
    return target.origin === input.serverOrigin && target.pathname === "/claim" && target.search === "" && target.hash === "";
  } catch {
    return false;
  }
}

export function classifyD508BindResponseStatus(status: number): D508BindResponseClassification {
  if (status === 401) return "401";
  return status >= 200 && status < 300 ? "2xx" : "other";
}

export function assertD508PostReloadCommitCount(actual: number): void {
  if (actual !== 1) {
    throw new D508QualificationError("browser-capture", "browser_contract", "post-reload-bootstrap", [{
      kind: "post-reload-commit-cardinality", expected: 1, actual,
    }]);
  }
}

/** Route handler evidence is bounded and contains no request values. */
export function assertD508PreReloadBindInterruption(
  input: Readonly<{
    trace: readonly RedactedCoordinatorEvent[];
    blockedRoutes: number;
  }>,
): void {
  const commands = input.trace.filter((event) => event.commandKind === "bind-subject" || event.commandKind === "reobserve-bind");
  const bindStarts = commands.filter((event) => event.commandKind === "bind-subject" && event.result === "started").length;
  const reobserveStarts = commands.filter((event) => event.commandKind === "reobserve-bind" && event.result === "started").length;
  const completeProfileStarts = input.trace.filter((event) => event.commandKind === "complete-profile" && event.result === "started").length;
  const successful = commands.filter((event) => event.result === "succeeded").length;
  const mutationStarts = bindStarts + reobserveStarts;
  if (bindStarts !== 1 || reobserveStarts !== 1 || completeProfileStarts !== 0 || successful !== 0 || input.blockedRoutes !== mutationStarts) {
    throw new D508QualificationError("browser-capture", "browser_contract", "resumed-bind-evidence", [{
      kind: "pre-reload-bind-interruption",
      expected: { bindStarts: 1, reobserveStarts: 1, completeProfileStarts: 0, successful: 0, blockedRoutesEqualMutationStarts: true },
      actual: { bindStarts, reobserveStarts, completeProfileStarts, successful, blockedRoutes: input.blockedRoutes, mutationStarts },
    }]);
  }
}

/** Only a direct success or the canonical unauthenticated replay is accepted. */
export function assertD508BindResponseClassifications(
  actual: readonly D508BindResponseClassification[],
): 1 | 2 {
  const allowed: readonly (readonly D508BindResponseClassification[])[] = [["2xx"], ["401", "2xx"]];
  if (allowed.some((candidate) => candidate.length === actual.length && candidate.every((value, index) => value === actual[index]))) {
    return actual.length as 1 | 2;
  }
  throw new D508QualificationError("browser-capture", "browser_contract", "resumed-bind-evidence", [{
    kind: "bind-response-sequence",
    expected: allowed,
    actual,
  }]);
}

function assertFreshOwnerClaimContract(input: {
  readonly requests: readonly RedactedRequestObservation[];
  readonly navigations: readonly RedactedNavigationObservation[];
  readonly trace: readonly RedactedCoordinatorEvent[];
}, finish: D508QualificationFinish, expectedBindRequestCount: 1 | 2 = 1): void {
  const finalCommand = finish === "guide" ? "navigate-guide" : "navigate-product";
  const destination = finish === "guide" ? "/help/server" : "/";
  const deltas: D508ContractDelta[] = [];

  const oidcActual = input.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
  const expectedCommands = [...D508_NON_LAUNCH_NEW_OWNER_COMMANDS, finalCommand] as const;
  const knownCommands = new Set<string>([...expectedCommands, "launch-logto-signup"]);
  const unrecognizedCommands = input.trace.filter((event) => !knownCommands.has(event.commandKind)).length;
  if (unrecognizedCommands !== 0) {
    deltas.push({ kind: "trace-unrecognized-command-cardinality", expected: 0, actual: unrecognizedCommands });
  }

  for (const commandKind of expectedCommands) {
    const events = input.trace.filter((event) => event.commandKind === commandKind);
    const expectedResults: Readonly<Record<D508TraceResult, number>> = { started: 1, succeeded: 1, failed: 0, aborted: 0, stale: 0, unsupported: 0 };
    for (const result of ["started", "succeeded", "failed", "aborted", "stale", "unsupported"] as const) {
      const actual = events.filter((event) => event.result === result).length;
      const expected = expectedResults[result];
      if (actual !== expected) {
        deltas.push({ kind: "trace-result", commandKind, result, expected, actual });
      }
    }
    const actualOperations = new Set(events.map((event) => event.operationId)).size;
    if (actualOperations !== 1) {
      deltas.push({ kind: "trace-operation-cardinality", commandKind, expected: 1, actual: actualOperations });
    }
  }

  const launch = input.trace.filter((event) => event.commandKind === "launch-logto-signup");
  const launchCounts = (result: D508TraceResult): number => launch.filter((event) => event.result === result).length;
  const launchUsesOneOperation = launch.length > 0 && new Set(launch.map((event) => event.operationId)).size === 1;
  const launchStartedAndSucceeded = launch.length === 2
    && launchCounts("started") === 1
    && launchCounts("succeeded") === 1
    && launchCounts("failed") === 0
    && launchCounts("aborted") === 0
    && launchCounts("stale") === 0
    && launchCounts("unsupported") === 0
    && launchUsesOneOperation;
  const launchStartAt = input.trace.findIndex((event) => event.commandKind === "launch-logto-signup" && event.result === "started");
  const bindStartAt = input.trace.findIndex((event) => event.commandKind === "bind-subject" && event.result === "started");
  const completeStartAt = input.trace.findIndex((event) => event.commandKind === "complete-profile" && event.result === "started");
  // A redirect disposes its original route. The coordinator is allowed to
  // emit only this same-operation started → aborted → stale shape; the OIDC
  // authorization request and later bind/complete commands prove callback
  // continuation, rather than treating disposal itself as a failed signup.
  const launchRedirectedAndContinued = launch.length === 3
    && launchCounts("started") === 1
    && launchCounts("succeeded") === 0
    && launchCounts("failed") === 0
    && launchCounts("aborted") === 1
    && launchCounts("stale") === 1
    && launchCounts("unsupported") === 0
    && launchUsesOneOperation
    && oidcActual === 1
    && launchStartAt >= 0
    && bindStartAt > launchStartAt
    && completeStartAt > bindStartAt;
  if (!launchStartedAndSucceeded && !launchRedirectedAndContinued) {
    const expectedLaunchResults: Readonly<Record<D508TraceResult, number>> = {
      started: 1, succeeded: 1, failed: 0, aborted: 0, stale: 0, unsupported: 0,
    };
    for (const result of ["started", "succeeded", "failed", "aborted", "stale", "unsupported"] as const) {
      const actual = launchCounts(result);
      const expected = expectedLaunchResults[result];
      if (actual !== expected) {
        deltas.push({ kind: "trace-result", commandKind: "launch-logto-signup", result, expected, actual });
      }
    }
    if (launch.length > 0 && !launchUsesOneOperation) {
      deltas.push({ kind: "trace-operation-cardinality", commandKind: "launch-logto-signup", expected: 1, actual: new Set(launch.map((event) => event.operationId)).size });
    }
  }

  const requestCounts = new Map<string, number>();
  for (const request of input.requests) {
    const key = `${request.method} ${request.origin} ${request.pathname}`;
    requestCounts.set(key, (requestCounts.get(key) ?? 0) + 1);
  }
  for (const pathname of ["/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile"] as const) {
    const actual = requestCounts.get(`POST server ${pathname}`) ?? 0;
    const expected = pathname === "/api/bind-logto-user" ? expectedBindRequestCount : 1;
    if (actual !== expected) deltas.push({ kind: "request-cardinality", method: "POST", origin: "server", pathname, expected, actual });
  }
  if (oidcActual !== 1) {
    deltas.push({ kind: "request-cardinality", method: "GET", origin: "logto", pathname: "/oidc/auth", expected: 1, actual: oidcActual });
  }
  const navigationActual = input.navigations.filter((navigation) => navigation.origin === "server" && navigation.pathname === destination).length;
  if (navigationActual < 1) {
    deltas.push({ kind: "navigation-cardinality", origin: "server", pathname: destination, expectedAtLeast: 1, actual: navigationActual });
  }
  if (deltas.length > 0) {
    const traceFailure = deltas.some((delta) => delta.kind === "trace-unrecognized-command-cardinality" || delta.kind === "trace-result" || delta.kind === "trace-operation-cardinality");
    throw new D508QualificationError("browser-capture", traceFailure ? "browser_trace" : "browser_contract", null, deltas);
  }
}

/** Existing guide vertical remains a separately asserted contract. */
export function assertFreshGuideContract(input: {
  readonly requests: readonly RedactedRequestObservation[];
  readonly navigations: readonly RedactedNavigationObservation[];
  readonly trace: readonly RedactedCoordinatorEvent[];
}): void {
  assertFreshOwnerClaimContract(input, "guide");
}

/** Product finish must have the same one-shot mutation spine, ending at `/`. */
export function assertProductRecoveryRefreshContract(input: {
  readonly requests: readonly RedactedRequestObservation[];
  readonly navigations: readonly RedactedNavigationObservation[];
  readonly trace: readonly RedactedCoordinatorEvent[];
}): void {
  assertFreshOwnerClaimContract(input, "product");
}

/** Held one-shot bind then profile-refresh vertical; no ambiguous-write path. */
export function assertHeldBindProductRecoveryRefreshContract(input: {
  readonly requests: readonly RedactedRequestObservation[];
  readonly navigations: readonly RedactedNavigationObservation[];
  readonly trace: readonly RedactedCoordinatorEvent[];
}, expectedBindRequestCount: 1 | 2): void {
  assertFreshOwnerClaimContract(input, "product", expectedBindRequestCount);
}

/**
 * The explicit reload splits the noisy callback interruption from the only
 * success-bearing epoch. This slice must contain one bind and no reobserve.
 */
export function assertD508PostReloadOwnerContract(input: {
  readonly requests: readonly RedactedRequestObservation[];
  readonly navigations: readonly RedactedNavigationObservation[];
  readonly trace: readonly RedactedCoordinatorEvent[];
}, expectedBindRequestCount: number): void {
  const deltas: D508ContractDelta[] = [];
  const expectedSpine = [
    "bind-subject:started", "bind-subject:succeeded",
    "bind-subject:started", "bind-subject:succeeded",
    "complete-profile:started", "complete-profile:succeeded",
    "navigate-product:started", "navigate-product:succeeded",
  ] as const;
  const actualSpine = input.trace.map((event) => `${event.commandKind}:${event.result}`);
  const operationPairs = [input.trace.slice(0, 2), input.trace.slice(2, 4), input.trace.slice(4, 6), input.trace.slice(6, 8)];
  // Operation IDs belong to a coordinator lifetime and legitimately reset on
  // each document remount. The trace does not carry a document ID, so the
  // stable contract is pair-local correlation, not a guessed global sequence.
  const exactOperationPairs = operationPairs.every((pair) => pair.length === 2 && pair[0]?.operationId === pair[1]?.operationId);
  if (actualSpine.join("|") !== expectedSpine.join("|") || !exactOperationPairs) {
    deltas.push({ kind: "post-reload-trace-spine", expected: expectedSpine, actual: actualSpine });
  }
  const expectedCommands = new Set(["bind-subject", "complete-profile", "navigate-product"]);
  const unrecognized = input.trace.filter((event) => !expectedCommands.has(event.commandKind)).length;
  if (unrecognized !== 0) deltas.push({ kind: "trace-unrecognized-command-cardinality", expected: 0, actual: unrecognized });
  for (const commandKind of ["bind-subject", "complete-profile", "navigate-product"] as const) {
    const events = input.trace.filter((event) => event.commandKind === commandKind);
    for (const result of ["started", "succeeded", "failed", "aborted", "stale", "unsupported"] as const) {
      const actual = events.filter((event) => event.result === result).length;
      const expected = result === "started" || result === "succeeded" ? commandKind === "bind-subject" ? 2 : 1 : 0;
      if (actual !== expected) deltas.push({ kind: "trace-result", commandKind, result, expected, actual });
    }
  }
  const requestCount = (pathname: RedactedRequestObservation["pathname"]): number =>
    input.requests.filter((request) => request.method === "POST" && request.origin === "server" && request.pathname === pathname).length;
  for (const [pathname, expected] of [
    ["/api/owner-claim/preview", 0],
    ["/api/owner-claim/prepare-auth", 0],
    ["/api/bind-logto-user", expectedBindRequestCount],
    ["/api/owner-claim/complete-profile", 1],
  ] as const) {
    const actual = requestCount(pathname);
    if (actual !== expected) deltas.push({ kind: "request-cardinality", method: "POST", origin: "server", pathname, expected, actual });
  }
  const navigationActual = input.navigations.filter((navigation) => navigation.origin === "server" && navigation.pathname === "/").length;
  if (navigationActual < 1) deltas.push({ kind: "navigation-cardinality", origin: "server", pathname: "/", expectedAtLeast: 1, actual: navigationActual });
  if (deltas.length > 0) {
    const traceFailure = deltas.some((delta) => delta.kind === "trace-unrecognized-command-cardinality" || delta.kind === "post-reload-trace-spine" || delta.kind === "trace-result" || delta.kind === "trace-operation-cardinality");
    throw new D508QualificationError("browser-capture", traceFailure ? "browser_trace" : "browser_contract", null, deltas);
  }
}

export type D508RequestCounter = Readonly<{
  preview: number;
  prepareAuth: number;
  bind: number;
  completeProfile: number;
}>;

/** A signed-in profile checkpoint validates its existing reservation once. */
export function assertD508ProfileBindValidation(input: Readonly<{
  requestDelta: D508RequestCounter;
  trace: readonly RedactedCoordinatorEvent[];
  oidcDelta: number;
  bindResponses: readonly D508BindResponseClassification[];
}>): true {
  let responseCount: 1 | 2;
  try {
    responseCount = assertD508BindResponseClassifications(input.bindResponses);
  } catch {
    throw new D508QualificationError("browser-capture", "browser_contract", "post-restart-profile-visible");
  }
  const exactTrace = input.trace.length === 2
    && input.trace[0]?.commandKind === "bind-subject" && input.trace[0]?.result === "started"
    && input.trace[1]?.commandKind === "bind-subject" && input.trace[1]?.result === "succeeded"
    && input.trace[0]?.operationId === input.trace[1]?.operationId
    && input.trace.every((event) => event.navigationIntent === null);
  if (
    input.requestDelta.preview !== 0 || input.requestDelta.prepareAuth !== 0
    || input.requestDelta.bind !== responseCount || input.requestDelta.completeProfile !== 0
    || input.oidcDelta !== 0 || !exactTrace
  ) throw new D508QualificationError("browser-capture", "browser_contract", "post-restart-profile-visible");
  return true;
}

function d508RequestCounter(requests: readonly RedactedRequestObservation[]): D508RequestCounter {
  const count = (pathname: RedactedRequestObservation["pathname"]): number =>
    requests.filter((request) => request.method === "POST" && request.origin === "server" && request.pathname === pathname).length;
  return {
    preview: count("/api/owner-claim/preview"),
    prepareAuth: count("/api/owner-claim/prepare-auth"),
    bind: count("/api/bind-logto-user"),
    completeProfile: count("/api/owner-claim/complete-profile"),
  };
}

/** A passive or signed-out checkpoint must not issue owner I/O. */
export function assertD508PassiveProfileCheckpointRequestDelta(
  before: D508RequestCounter,
  after: D508RequestCounter,
): Readonly<{ preview: 0; prepareAuth: 0; bind: 0; completeProfile: 0 }> {
  const requestDelta = {
    preview: after.preview - before.preview,
    prepareAuth: after.prepareAuth - before.prepareAuth,
    bind: after.bind - before.bind,
    completeProfile: after.completeProfile - before.completeProfile,
  } as const;
  if (requestDelta.preview !== 0 || requestDelta.prepareAuth !== 0 || requestDelta.bind !== 0 || requestDelta.completeProfile !== 0) {
    throw new D508QualificationError("browser-capture", "browser_contract");
  }
  // The evidence is a verified invariant, not a sampled counter snapshot.
  return { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 };
}

/**
 * The restart is not a browser command: both before the reload and after its
 * profile checkpoint bootstrap, the host-server replacement must have caused
 * no owner API, OIDC, or coordinator activity. Runtime identities remain
 * private; only these semantic booleans may enter the receipt.
 */
export function assertD508RestartAfterBindContract(input: Readonly<{
  serverPidBefore: number;
  serverPidAfter: number;
  appPostgresUnchanged: boolean;
  logtoCoreUnchanged: boolean;
  logtoPostgresUnchanged: boolean;
  reservationUnchanged: boolean;
  noCompletedOwner: boolean;
  beforeReload: Readonly<{
    requestDelta: D508RequestCounter;
    traceDelta: number;
    oidcDelta: number;
    sessionOnlyCustody: boolean;
  }>;
  afterReload: Readonly<{
    requestDelta: D508RequestCounter;
    trace: readonly RedactedCoordinatorEvent[];
    oidcDelta: number;
    bindResponses: readonly D508BindResponseClassification[];
    sessionOnlyCustody: boolean;
  }>;
}>): D508RestartAfterBindEvidence {
  const zeroOwnerIo = (value: D508RequestCounter): boolean =>
    value.preview === 0 && value.prepareAuth === 0 && value.bind === 0 && value.completeProfile === 0;
  if (
    !Number.isSafeInteger(input.serverPidBefore) || input.serverPidBefore <= 0
    || !Number.isSafeInteger(input.serverPidAfter) || input.serverPidAfter <= 0
    || input.serverPidBefore === input.serverPidAfter
    || !input.appPostgresUnchanged || !input.logtoCoreUnchanged || !input.logtoPostgresUnchanged
    || !input.reservationUnchanged || !input.noCompletedOwner
    || !zeroOwnerIo(input.beforeReload.requestDelta) || input.beforeReload.traceDelta !== 0 || input.beforeReload.oidcDelta !== 0 || !input.beforeReload.sessionOnlyCustody
    || !input.afterReload.sessionOnlyCustody
  ) throw new D508QualificationError("browser-capture", "browser_contract", "server-restart-after-bind");
  assertD508ProfileBindValidation(input.afterReload);
  return {
    hostServerRestartedWithDifferentPid: true,
    appPostgresLogtoCoreAndLogtoPostgresUnchanged: true,
    reservationUnchanged: true,
    noCompletedOwnerBeforeProfileSubmit: true,
    noOwnerIoOrOidcBeforeReload: true,
    profileBindValidationAfterReload: true,
    rawClaimRemainedSessionOnly: true,
  };
}

/** Each tab is checked independently because coordinator operation IDs restart per document. */
export function assertD508TwoTabReissueContract(input: Readonly<{
  pageATrace: readonly RedactedCoordinatorEvent[];
  pageBTrace: readonly RedactedCoordinatorEvent[];
  pageCTrace: readonly RedactedCoordinatorEvent[];
  pageARequests: D508RequestCounter;
  pageBRequests: D508RequestCounter;
  pageCRequests: D508RequestCounter;
  pageBReservationDelta: D508RequestCounter;
  pageBRevokedRefreshDelta: D508RequestCounter;
  pageBRevokedPreview404s: number;
  pageAOidcRequests: number;
  pageBOidcRequests: number;
  pageCOidcRequests: number;
  /** The reload validation may replay once after a 401, but is one coordinator command. */
  pageAReloadBindResponses: readonly D508BindResponseClassification[];
  evidence: Omit<D508TwoTabReissueEvidence, "pageBDidNotMutateDuringAReservation" | "successfulCompletions">;
}>): D508TwoTabReissueEvidence {
  const signature = (trace: readonly RedactedCoordinatorEvent[]): string[] =>
    trace.map((event) => `${event.commandKind}:${event.result}`);
  const matchesSpine = (
    trace: readonly RedactedCoordinatorEvent[],
    expected: readonly string[],
    commandEventLengths: readonly number[],
    epochCommandCounts: readonly number[],
  ): boolean => {
    if (signature(trace).join("|") !== expected.join("|")) return false;
    if (trace.some((event) => event.navigationIntent !== (event.commandKind === "navigate-product" ? "product" : null))) return false;
    let offset = 0;
    const commandOperationIds: number[] = [];
    for (const length of commandEventLengths) {
      const operationId = trace[offset]?.operationId;
      if (operationId === undefined) return false;
      if (trace.slice(offset, offset + length).some((event) => event.operationId !== operationId)) return false;
      commandOperationIds.push(operationId);
      offset += length;
    }
    if (offset !== trace.length || epochCommandCounts.reduce((total, count) => total + count, 0) !== commandOperationIds.length) return false;
    let epochOffset = 0;
    for (const commandCount of epochCommandCounts) {
      const epochOperationIds = commandOperationIds.slice(epochOffset, epochOffset + commandCount);
      // Coordinators allocate `++nextOperation`, so every remounted document
      // epoch is its own contiguous 1…N allocation.
      if (epochOperationIds.some((operationId, index) => operationId !== index + 1)) return false;
      epochOffset += commandCount;
    }
    return true;
  };
  const pageARedirectExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "prepare-signup:started", "prepare-signup:succeeded",
    "launch-logto-signup:started", "launch-logto-signup:aborted", "launch-logto-signup:stale",
    "bind-subject:started", "bind-subject:succeeded",
    "bind-subject:started", "bind-subject:succeeded",
  ] as const;
  // A normal direct completion is healthy too. A real hosted redirect may
  // dispose that originating coordinator, producing this exact same-operation
  // started→aborted→stale alternate; no mixed/retried launch is accepted.
  const pageASuccessExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "prepare-signup:started", "prepare-signup:succeeded",
    "launch-logto-signup:started", "launch-logto-signup:succeeded",
    "bind-subject:started", "bind-subject:succeeded",
    "bind-subject:started", "bind-subject:succeeded",
  ] as const;
  const pageBExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "preview-claim:started", "preview-claim:failed",
  ] as const;
  const pageCExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "prepare-resume:started", "prepare-resume:succeeded",
    "bind-subject:started", "bind-subject:succeeded",
    "complete-profile:started", "complete-profile:succeeded",
    "navigate-product:started", "navigate-product:succeeded",
  ] as const;
  const deltas: D508ContractDelta[] = [];
  // Both hosted callback outcomes remount `/claim`: signup preparation and
  // launch are one epoch, while callback bind and the post-restart reload
  // validation each begin in their own document epoch.
  const pageAExact = matchesSpine(input.pageATrace, pageASuccessExpected, [2, 2, 2, 2, 2], [3, 1, 1])
    || matchesSpine(input.pageATrace, pageARedirectExpected, [2, 2, 3, 2, 2], [3, 1, 1]);
  if (!pageAExact) deltas.push({ kind: "tab-trace-spine", tab: "A", expected: [...pageASuccessExpected, "or", ...pageARedirectExpected], actual: signature(input.pageATrace) });
  if (!matchesSpine(input.pageBTrace, pageBExpected, [2, 2], [1, 1])) deltas.push({ kind: "tab-trace-spine", tab: "B", expected: pageBExpected, actual: signature(input.pageBTrace) });
  if (!matchesSpine(input.pageCTrace, pageCExpected, [2, 2, 2, 2, 2], [4, 1])) deltas.push({ kind: "tab-trace-spine", tab: "C", expected: pageCExpected, actual: signature(input.pageCTrace) });
  const exactRequestCounts = (
    tab: "A" | "B" | "C",
    actual: D508RequestCounter,
    expected: D508RequestCounter,
  ): boolean => {
    if (
      actual.preview !== expected.preview || actual.prepareAuth !== expected.prepareAuth
      || actual.bind !== expected.bind || actual.completeProfile !== expected.completeProfile
    ) {
      deltas.push({ kind: "tab-trace-spine", tab, expected: [`requests:${JSON.stringify(expected)}`], actual: [`requests:${JSON.stringify(actual)}`] });
      return false;
    }
    return true;
  };
  const reloadResponseCount = input.pageAReloadBindResponses.length;
  const reloadResponsesExact = (reloadResponseCount === 1 && input.pageAReloadBindResponses[0] === "2xx")
    || (reloadResponseCount === 2 && input.pageAReloadBindResponses[0] === "401" && input.pageAReloadBindResponses[1] === "2xx");
  const requestSpinesExact =
    exactRequestCounts("A", input.pageARequests, { preview: 1, prepareAuth: 1, bind: 1 + reloadResponseCount, completeProfile: 0 })
    && exactRequestCounts("B", input.pageBRequests, { preview: 2, prepareAuth: 0, bind: 0, completeProfile: 0 })
    && exactRequestCounts("C", input.pageCRequests, { preview: 1, prepareAuth: 1, bind: 1, completeProfile: 1 });
  const noPageBMutation = input.pageBReservationDelta.prepareAuth === 0
    && input.pageBReservationDelta.bind === 0
    && input.pageBReservationDelta.completeProfile === 0;
  const revokedPageBIsOnePreviewOnly = input.pageBRevokedRefreshDelta.preview === 1
    && input.pageBRevokedRefreshDelta.prepareAuth === 0
    && input.pageBRevokedRefreshDelta.bind === 0
    && input.pageBRevokedRefreshDelta.completeProfile === 0
    && input.pageBRevokedPreview404s === 1;
  const pageAReservedOnly = pageAExact && input.pageAOidcRequests === 1;
  const noUnexpectedTabOidc = input.pageBOidcRequests === 0 && input.pageCOidcRequests === 0;
  const pageBDidNotComplete = deltas.every((delta) => delta.kind !== "tab-trace-spine" || delta.tab !== "B");
  const pageCResumedExactlyOnce = deltas.every((delta) => delta.kind !== "tab-trace-spine" || delta.tab !== "C");
  if (
    !noPageBMutation || !revokedPageBIsOnePreviewOnly || !pageAReservedOnly || !reloadResponsesExact || !requestSpinesExact || !noUnexpectedTabOidc || !pageBDidNotComplete || !pageCResumedExactlyOnce
    || !input.evidence.pageAAndBHaveSessionOnlyCustody || !input.evidence.pageAClosedAndPageBReportedControllerReissueGuidance
    || !input.evidence.staleCustodyClearedBeforeSecondRefresh || !input.evidence.controllerReplacementRevokedAAndRetainedReservation
    || !input.evidence.sameSubjectResumedWithoutHandleOrOidc
  ) throw new D508QualificationError("browser-capture", deltas.length === 0 ? "browser_contract" : "browser_trace", "contract-validation", deltas);
  return { ...input.evidence, pageBDidNotMutateDuringAReservation: true, successfulCompletions: 1 };
}

/**
 * A response-loss qualification has two committed HTTP writes, but the browser
 * sees neither response. The trace therefore proves each intentional
 * ambiguity resolves exactly once; the route latches prove the server had
 * already returned 200 before the connection was reset.
 */
export function assertD508LostResponsesContract(input: Readonly<{
  trace: readonly RedactedCoordinatorEvent[];
  requests: readonly RedactedRequestObservation[];
  navigations: readonly RedactedNavigationObservation[];
  oidcRequests: number;
  bindCommitted200: boolean;
  bindAbortedAfterCommit: boolean;
  bindReservationUnchanged: boolean;
  completionCommitted200: boolean;
  completionAbortedAfterCommit: boolean;
  completionRecoveryFingerprintUnchanged: boolean;
  setupStatusDelta: number;
  terminalCustody: boolean;
  noCodesTerminal: boolean;
}>): D508LostResponsesEvidence {
  const redirectExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "prepare-signup:started", "prepare-signup:succeeded",
    "launch-logto-signup:started", "launch-logto-signup:aborted", "launch-logto-signup:stale",
    "bind-subject:started", "bind-subject:failed",
    "reobserve-bind:started", "reobserve-bind:succeeded",
    "complete-profile:started", "complete-profile:failed",
    "reobserve-completion:started", "reobserve-completion:succeeded",
    "navigate-product:started", "navigate-product:succeeded",
  ] as const;
  const directExpected = [
    "preview-claim:started", "preview-claim:succeeded",
    "prepare-signup:started", "prepare-signup:succeeded",
    "launch-logto-signup:started", "launch-logto-signup:succeeded",
    "bind-subject:started", "bind-subject:failed",
    "reobserve-bind:started", "reobserve-bind:succeeded",
    "complete-profile:started", "complete-profile:failed",
    "reobserve-completion:started", "reobserve-completion:succeeded",
    "navigate-product:started", "navigate-product:succeeded",
  ] as const;
  const actual = input.trace.map((event) => `${event.commandKind}:${event.result}`);
  const deltas: D508ContractDelta[] = [];
  const matchesSpine = (expected: readonly string[], commandLengths: readonly number[]): boolean => {
    if (actual.join("|") !== expected.join("|")) return false;
    const expectedIds = [1, 2, 3, 1, 2, 3, 4, 5] as const;
    let offset = 0;
    for (let index = 0; index < commandLengths.length; index += 1) {
      const length = commandLengths[index]!;
      const id = input.trace[offset]?.operationId;
      if (id !== expectedIds[index] || input.trace.slice(offset, offset + length).some((event) => event.operationId !== id)) return false;
      offset += length;
    }
    return offset === input.trace.length;
  };
  // Callback coordinator allocation restarts after signup. Launch itself can
  // settle normally or be retired by the hosted redirect, but nothing else varies.
  const exactSpine = matchesSpine(redirectExpected, [2, 2, 3, 2, 2, 2, 2, 2])
    || matchesSpine(directExpected, [2, 2, 2, 2, 2, 2, 2, 2]);
  if (!exactSpine) deltas.push({ kind: "lost-response-spine", expected: [...directExpected, "or", ...redirectExpected], actual });
  if (input.trace.some((event) => event.navigationIntent !== (event.commandKind === "navigate-product" ? "product" : null))) {
    deltas.push({ kind: "lost-response-spine", expected: redirectExpected, actual });
  }
  const count = (method: "POST" | "GET", origin: "server" | "logto", pathname: RedactedRequestObservation["pathname"]): number =>
    input.requests.filter((request) => request.method === method && request.origin === origin && request.pathname === pathname).length;
  for (const [method, origin, pathname, expectedCount] of [
    ["POST", "server", "/api/owner-claim/preview", 1],
    ["POST", "server", "/api/owner-claim/prepare-auth", 1],
    ["POST", "server", "/api/bind-logto-user", 2],
    ["POST", "server", "/api/owner-claim/complete-profile", 1],
  ] as const) {
    const actualCount = count(method, origin, pathname);
    if (actualCount !== expectedCount) deltas.push({ kind: "request-cardinality", method, origin, pathname, expected: expectedCount, actual: actualCount });
  }
  if (input.setupStatusDelta !== 1) deltas.push({ kind: "request-cardinality", method: "GET", origin: "server", pathname: "/api/setup/status", expected: 1, actual: input.setupStatusDelta });
  if (input.oidcRequests !== 1) deltas.push({ kind: "request-cardinality", method: "GET", origin: "logto", pathname: "/oidc/auth", expected: 1, actual: input.oidcRequests });
  const productNavigations = input.navigations.filter((navigation) => navigation.origin === "server" && navigation.pathname === "/").length;
  if (productNavigations < 1) deltas.push({ kind: "navigation-cardinality", origin: "server", pathname: "/", expectedAtLeast: 1, actual: productNavigations });
  for (const value of [
    input.bindCommitted200, input.bindAbortedAfterCommit, input.bindReservationUnchanged,
    input.completionCommitted200, input.completionAbortedAfterCommit,
    input.completionRecoveryFingerprintUnchanged, input.terminalCustody, input.noCodesTerminal,
  ]) if (!value) deltas.push({ kind: "lost-response-latch", expected: true, actual: value });
  if (deltas.length > 0) throw new D508QualificationError("browser-capture", deltas.some((delta) => delta.kind === "lost-response-spine") ? "browser_trace" : "browser_contract", "contract-validation", deltas);
  return {
    bindResponseCommittedBeforeAbort: true,
    bindReobservedWithoutChangingReservation: true,
    completionResponseCommittedBeforeAbort: true,
    completionRecoveryFingerprintUnchanged: true,
    completionReobservedSetupStatusOnce: true,
    truthfulNoCodeTerminalWithSecurityLink: true,
    handoffClearedWithSessionOnlyTerminalMarker: true,
  };
}

/** A route may reset the browser connection only after Fastify returned and DB proof ran. */
export function assertD508CommittedResponseAbortOrder(events: readonly string[]): void {
  const expected = ["response-200", "db-committed", "connectionreset"] as const;
  if (events.length !== expected.length || events.some((event, index) => event !== expected[index])) {
    throw new D508QualificationError("browser-capture", "browser_contract", "contract-validation", [{
      kind: "lost-response-spine", expected, actual: [...events],
    }]);
  }
}

export function assertD508SignedOutWrongAccountContract(input: Readonly<{
  wrongProvisionTrace: readonly RedactedCoordinatorEvent[];
  ownerTrace: readonly RedactedCoordinatorEvent[];
  wrongProvisionRequests: D508RequestCounter;
  ownerRequests: D508RequestCounter;
  ownerOidcRequests: number;
  wrongBind409s: number;
  wrongBindResponses: readonly D508BindResponseClassification[];
  correctRecoveryBindResponses: readonly D508BindResponseClassification[];
  signedOutProfileOwnerIo: D508RequestCounter;
  evidence: D508SignedOutWrongAccountEvidence;
}>): D508SignedOutWrongAccountEvidence {
  const zero = (value: D508RequestCounter): boolean => value.preview === 0 && value.prepareAuth === 0 && value.bind === 0 && value.completeProfile === 0;
  const sameOperation = (events: readonly RedactedCoordinatorEvent[]): boolean => events.length > 0 && events.every((event) => event.operationId === events[0]?.operationId);
  type Command = readonly [kind: string, results: readonly string[]];
  const matches = (trace: readonly RedactedCoordinatorEvent[], commands: readonly Command[], epochCommandCounts: readonly number[]): boolean => {
    let offset = 0;
    const operationIds: number[] = [];
    for (const [kind, results] of commands) {
      const events = trace.slice(offset, offset + results.length);
      if (events.length !== results.length || events.some((event, index) => event.commandKind !== kind || event.result !== results[index] || event.navigationIntent !== (kind === "navigate-product" ? "product" : null)) || !sameOperation(events)) return false;
      operationIds.push(events[0]!.operationId);
      offset += results.length;
    }
    if (offset !== trace.length || epochCommandCounts.reduce((total, count) => total + count, 0) !== operationIds.length) return false;
    let epochOffset = 0;
    for (const count of epochCommandCounts) {
      if (operationIds.slice(epochOffset, epochOffset + count).some((operationId, index) => operationId !== index + 1)) return false;
      epochOffset += count;
    }
    return true;
  };
  const launchOutcomes: readonly (readonly string[])[] = [["started", "succeeded"], ["started", "aborted", "stale"]];
  // Navigating to Logto may either settle just before the document unloads or
  // be retired by it. Both are one operation; no retry/failure shape is valid.
  const signOutOutcomes: readonly (readonly string[])[] = [["started", "succeeded"], ["started", "aborted", "stale"]];
  const wrongBindResponseExact = input.wrongBindResponses.length === 1 && input.wrongBindResponses[0] === "other";
  const correctRecoveryBindResponseExact = input.correctRecoveryBindResponses.length === 1 && input.correctRecoveryBindResponses[0] === "2xx"
    || input.correctRecoveryBindResponses.length === 2 && input.correctRecoveryBindResponses[0] === "401" && input.correctRecoveryBindResponses[1] === "2xx";
  const wrongTraceExact = launchOutcomes.some((launch) => matches(input.wrongProvisionTrace, [
    ["preview-claim", ["started", "succeeded"]], ["prepare-signup", ["started", "succeeded"]], ["launch-logto-signup", launch], ["bind-subject", ["started", "failed"]],
  ], [3, 1]));
  const ownerTraceExact = launchOutcomes.some((signupLaunch) => launchOutcomes.some((wrongSignInLaunch) => launchOutcomes.some((ownerSignInLaunch) => signOutOutcomes.some((firstSignOut) => signOutOutcomes.some((secondSignOut) => matches(input.ownerTrace, [
    ["preview-claim", ["started", "succeeded"]], ["prepare-signup", ["started", "succeeded"]], ["launch-logto-signup", signupLaunch],
    ["bind-subject", ["started", "succeeded"]], ["sign-out", firstSignOut],
    ["prepare-resume", ["started", "succeeded"]], ["launch-logto-signin", wrongSignInLaunch],
    ["bind-subject", ["started", "failed"]], ["sign-out", secondSignOut],
    ["prepare-resume", ["started", "succeeded"]], ["launch-logto-signin", ownerSignInLaunch],
    ["bind-subject", ["started", "succeeded"]], ["complete-profile", ["started", "succeeded"]], ["navigate-product", ["started", "succeeded"]],
  ], [3, 2, 2, 2, 2, 3]))))));
  if (
    !wrongTraceExact || !ownerTraceExact
    || input.wrongProvisionRequests.preview !== 1 || input.wrongProvisionRequests.prepareAuth !== 1 || input.wrongProvisionRequests.bind !== 1 || input.wrongProvisionRequests.completeProfile !== 0
    || input.ownerRequests.preview !== 1 || input.ownerRequests.prepareAuth !== 3 || input.ownerRequests.bind !== 2 + input.correctRecoveryBindResponses.length || input.ownerRequests.completeProfile !== 1
    || input.ownerOidcRequests !== 3 || input.wrongBind409s !== 1 || !wrongBindResponseExact || !correctRecoveryBindResponseExact || !zero(input.signedOutProfileOwnerIo)
    || !input.evidence.wrongAccountCreatedWithoutServerBind || !input.evidence.signedOutProfilePreservedSessionOnlyCustody || !input.evidence.wrongSubjectBind409Observed
    || !input.evidence.wrongSubjectReceivedOnlyClaimReserved || !input.evidence.wrongSubjectDidNotChangeReservationOrCompleteOwner
    || !input.evidence.originalSubjectRecoveredWithoutHandleEntry || !input.evidence.originalSubjectCompletedExactlyOnce
  ) throw new D508QualificationError("browser-capture", !wrongTraceExact || !ownerTraceExact ? "browser_trace" : "browser_contract", "contract-validation");
  return input.evidence;
}

function generatedCredentials(runId: string): { readonly handle: string; readonly password: string; readonly pin: string; readonly claim: string } {
  // Values remain only in this worker closure. The handle is intentionally non-secret.
  const suffix = runId.slice(-8);
  return {
    handle: `d508_${suffix}`,
    password: `D508-${randomBytes(18).toString("base64url")}`,
    pin: String(100000 + (randomBytes(3).readUIntBE(0, 3) % 900000)),
    // Owner-claim lookup accepts only the canonical v1 invite capability:
    // inv_ + 24 random bytes rendered as 32 base64url characters.
    claim: createCanonicalOwnerClaimCapability(),
  };
}

function instanceState(instanceId: string): { readonly serverUrl: string; readonly ports: number[]; readonly composeProject: string } {
  const root = resolveNautiloStorageRoot(homedir(), instanceId);
  const raw = JSON.parse(readFileSync(join(root, "instance.json"), "utf8")) as {
    server?: { url?: string; port?: number }; workbench?: { port?: number }; compose?: { projectName?: string };
  };
  if (typeof raw.server?.url !== "string" || raw.server.url.length === 0) throw new D508QualificationError("stack-start", "stack_start");
  return { serverUrl: raw.server.url.replace(/\/$/, ""), ports: [raw.server.port, raw.workbench?.port].filter((value): value is number => typeof value === "number"), composeProject: raw.compose?.projectName ?? `nautilo-${instanceId}` };
}

export type D508ContainerRuntimeSnapshot = Readonly<{
  id: string;
  status: "running";
  running: true;
  restartCount: number;
  startedAt: string;
}>;

/** Exact selected-instance PID file, listener, and Nautilo-process agreement. */
export function assertD508SelectedServerIdentity(input: Readonly<{
  pidFile: number;
  listenerPid: number | null;
  isNautiloServer: boolean;
}>): number {
  if (
    !Number.isSafeInteger(input.pidFile) || input.pidFile <= 0
    || input.listenerPid !== input.pidFile || !input.isNautiloServer
  ) throw new D508QualificationError("browser-capture", "browser_contract", "server-restart-after-bind");
  return input.pidFile;
}

function readD508LiveServerPid(instanceId: string, serverPort: number): number {
  try {
    const root = resolveNautiloStorageRoot(homedir(), instanceId);
    const raw = readFileSync(join(root, "server.pid"), "utf8").trim();
    if (!/^[1-9][0-9]*$/.test(raw)) throw new Error("invalid server pid");
    const pid = Number(raw);
    if (!Number.isSafeInteger(pid) || pid <= 0) throw new Error("invalid server pid");
    process.kill(pid, 0);
    return assertD508SelectedServerIdentity({
      pidFile: pid,
      listenerPid: findListenerPid(serverPort),
      isNautiloServer: looksLikeNautiloServer(pid),
    });
  } catch {
    throw new D508QualificationError("browser-capture", "browser_contract", "server-restart-after-bind");
  }
}

function readD508ContainerRuntimeSnapshot(container: string): D508ContainerRuntimeSnapshot {
  try {
    const result = spawnSync(
      "docker",
      ["inspect", "--format", "{{.Id}}|{{.State.Status}}|{{.State.Running}}|{{.RestartCount}}|{{.State.StartedAt}}", container],
      { encoding: "utf8" },
    );
    if (result.error || result.status !== 0) throw new Error("container inspection failed");
    const [id, status, running, restartCountRaw, startedAt, ...extra] = result.stdout.trim().split("|");
    const restartCount = Number(restartCountRaw);
    if (!id || status !== "running" || running !== "true" || !startedAt || extra.length !== 0 || !Number.isSafeInteger(restartCount) || restartCount < 0) {
      throw new Error("container snapshot invalid");
    }
    return { id, status: "running", running: true, restartCount, startedAt };
  } catch {
    throw new D508QualificationError("browser-capture", "browser_contract", "server-restart-after-bind");
  }
}

export function sameD508ContainerRuntime(
  before: D508ContainerRuntimeSnapshot,
  after: D508ContainerRuntimeSnapshot,
): boolean {
  return before.id === after.id
    && before.status === after.status
    && before.running === after.running
    && before.restartCount === after.restartCount
    && before.startedAt === after.startedAt;
}

/** Invoke the public lifecycle command with an explicit selected instance; suppress diagnostics from the receipt. */
async function restartD508HostServer(
  instanceId: string,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
): Promise<void> {
  const command = Bun.spawn(
    ["bun", "src/index.ts", "server-restart", "--require-workbench-dist", "--instance", instanceId],
    {
      cwd: import.meta.dir.replace(/\/src\/commands$/, ""),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      env: { ...process.env, NAUTILO_INSTANCE_ID: instanceId },
    },
  );
  let childExitObserved = false;
  try {
    const code = await awaitD508QualificationWork(command.exited, signal);
    childExitObserved = true;
    if (code !== 0) throw new Error("server restart failed");
  } catch {
    if (!childExitObserved) await terminateD508RestartChild(command, timing.childTerminationGraceMs);
    throw new D508QualificationError("browser-capture", "browser_contract", "server-restart-after-bind");
  }
}

function assertNoBootstrapClaimArtifacts(instanceId: string): void {
  const root = resolveNautiloStorageRoot(homedir(), instanceId);
  if (existsSync(join(root, "claim-invite.txt")) || existsSync(join(root, ".bootstrap", "claim-invite"))) {
    throw new D508QualificationError("stack-start", "stack_start");
  }
}

type D508ProfileReservationSnapshot = Readonly<{
  userId: string;
  reservedAt: number;
}>;

type D508ClaimReservationRow = Readonly<{
  usedCount: number;
  revokedAt: Date | null;
  expiresAt: Date | null;
  boundAt: Date | null;
  redemptionUserId: string | null;
  completedAt: Date | null;
}>;

export function assertD508OneLiveUnboundClaim(
  rows: readonly D508ClaimReservationRow[],
  now = new Date(),
): void {
  const live = rows.filter((row) => row.usedCount === 0 && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now));
  const claim = live[0];
  if (live.length !== 1 || !claim || claim.boundAt !== null || claim.redemptionUserId !== null) {
    throw new Error("live claim is not uniquely unbound");
  }
}

/** Historical revoked claims are retained by the controller and never compete with its live reservation. */
export function selectD508LiveProfileReservation(
  rows: readonly D508ClaimReservationRow[],
  now = new Date(),
): D508ProfileReservationSnapshot {
  const live = rows.filter((row) => row.usedCount === 0 && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > now));
  if (live.length !== 1) throw new Error("live claim cardinality");
  const claim = live[0];
  if (!claim || claim.boundAt === null || claim.redemptionUserId === null || claim.completedAt !== null) throw new Error("profile reservation missing");
  return { userId: claim.redemptionUserId, reservedAt: claim.boundAt.getTime() };
}

/**
 * The first route interception must occur before Fastify's bind mutation. This
 * is deliberately stronger than a client-side aborted response: no claim row
 * may be half-redeemed before the refresh is issued.
 */
async function assertD508ClaimUnboundBeforeRefresh(): Promise<void> {
  try {
    const rows = await getSharedDirectDb()
      .select({ usedCount: invites.usedCount, revokedAt: invites.revokedAt, expiresAt: invites.expiresAt, boundAt: inviteRedemptions.boundAt, redemptionUserId: inviteRedemptions.userId, completedAt: inviteRedemptions.completedAt })
      .from(invites)
      .leftJoin(inviteRedemptions, eq(inviteRedemptions.inviteId, invites.id))
      .where(eq(invites.kind, "claim"));
    assertD508OneLiveUnboundClaim(rows);
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant");
  }
}

/** The successful resumed bind is authoritative only after its half-redemption commits. */
async function readD508ProfileReservation(): Promise<D508ProfileReservationSnapshot> {
  try {
    const rows = await getSharedDirectDb()
      .select({ usedCount: invites.usedCount, revokedAt: invites.revokedAt, expiresAt: invites.expiresAt, boundAt: inviteRedemptions.boundAt, redemptionUserId: inviteRedemptions.userId, completedAt: inviteRedemptions.completedAt })
      .from(invites)
      .leftJoin(inviteRedemptions, eq(inviteRedemptions.inviteId, invites.id))
      .where(and(eq(invites.kind, "claim"), eq(invites.usedCount, 0), isNull(invites.revokedAt)));
    const snapshot = selectD508LiveProfileReservation(rows);
    const [boundUser] = await getSharedDirectDb()
      .select({ externalId: users.externalId })
      .from(users)
      .where(eq(users.id, snapshot.userId))
      .limit(1);
    if (!boundUser || typeof boundUser.externalId !== "string" || boundUser.externalId.length === 0) {
      throw new Error("bound Logto identity missing");
    }
    return snapshot;
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant");
  }
}

async function assertD508ProfileReservationUnchanged(previous: D508ProfileReservationSnapshot): Promise<void> {
  const current = await readD508ProfileReservation();
  if (current.userId !== previous.userId || current.reservedAt !== previous.reservedAt) {
    throw new D508QualificationError("db-invariants", "db_invariant");
  }
}

async function installLoopbackClaim(
  serverUrl: string,
  claim: string,
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
): Promise<void> {
  try {
    const expiresAt = new Date(Date.now() + timing.claimTtlMs - timing.claimInstallSkewMs).toISOString();
    const claimHash = createHash("sha256").update(claim).digest("hex");
    const response = await fetch(`${serverUrl}/api/setup/owner-claim`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ schemaVersion: 1, claimHash, expiresAt }),
    });
    if (!response.ok) throw new Error("controller rejected claim");
    assertD508ControllerInstallResponse(await response.json());
  } catch { throw new D508QualificationError("controller-install", "controller_install"); }
}

/** Force only the selected installed capability past its server-side expiry. */
async function expireD508InstalledClaim(claim: string): Promise<void> {
  try {
    const tokenHash = createHash("sha256").update(claim).digest("hex");
    const expiredAt = new Date(Date.now() - 60_000);
    const rows = await getSharedDirectDb()
      .update(invites)
      .set({ expiresAt: expiredAt })
      .where(and(eq(invites.kind, "claim"), eq(invites.tokenHash, tokenHash)))
      .returning({ usedCount: invites.usedCount, revokedAt: invites.revokedAt, expiresAt: invites.expiresAt });
    const row = rows[0];
    if (
      rows.length !== 1 || !row || row.usedCount !== 0 || row.revokedAt !== null
      || row.expiresAt === null || row.expiresAt.getTime() > Date.now()
    ) throw new Error("claim expiry did not commit");
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant", "expired-claim-response");
  }
}

/** Controller install is a frozen redacted acknowledgement, not a loose 2xx. */
export function assertD508ControllerInstallResponse(value: unknown): void {
  if (
    !value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).length !== 2
    || !Object.prototype.hasOwnProperty.call(value, "schemaVersion")
    || !Object.prototype.hasOwnProperty.call(value, "state")
    || (value as Record<string, unknown>)["schemaVersion"] !== 1
    || (value as Record<string, unknown>)["state"] !== "claim-active"
  ) throw new Error("invalid controller install acknowledgement");
}

async function assertD508NoCompletedOwner(): Promise<void> {
  try {
    const rows = await getSharedDirectDb()
      .select({ id: users.id })
      .from(users)
      .innerJoin(credentials, and(eq(credentials.userId, users.id), eq(credentials.type, "pin")))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .innerJoin(groupMembers, eq(groupMembers.userId, users.id))
      .innerJoin(groups, and(eq(groups.id, groupMembers.groupId), eq(groups.type, "owners")))
      .where(isNull(users.server));
    if (rows.length !== 0) throw new Error("owner unexpectedly completed");
  } catch { throw new D508QualificationError("db-invariants", "db_invariant"); }
}

/** Completion must finalize the subject that owns the earlier half-reservation. */
async function assertD508CompletedOwnerMatches(userId: string, stage: D508BrowserStage = "lost-completion-response"): Promise<void> {
  try {
    const rows = await getSharedDirectDb()
      .select({ id: users.id })
      .from(users)
      .innerJoin(credentials, and(eq(credentials.userId, users.id), eq(credentials.type, "pin")))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .innerJoin(groupMembers, eq(groupMembers.userId, users.id))
      .innerJoin(groups, and(eq(groups.id, groupMembers.groupId), eq(groups.type, "owners")))
      .where(isNull(users.server));
    if (rows.length !== 1 || rows[0]?.id !== userId) throw new Error("completed owner mismatch");
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant", stage);
  }
}

/** Read the production controller replacement result without putting either capability in a receipt. */
async function assertD508ControllerReissue(
  previousClaim: string,
  replacementClaim: string,
  reservation: D508ProfileReservationSnapshot,
): Promise<D508ProfileReservationSnapshot> {
  try {
    const previousHash = createHash("sha256").update(previousClaim).digest("hex");
    const replacementHash = createHash("sha256").update(replacementClaim).digest("hex");
    const rows = await getSharedDirectDb()
      .select({ tokenHash: invites.tokenHash, usedCount: invites.usedCount, revokedAt: invites.revokedAt, redemptionUserId: inviteRedemptions.userId, completedAt: inviteRedemptions.completedAt })
      .from(invites)
      .leftJoin(inviteRedemptions, eq(inviteRedemptions.inviteId, invites.id))
      .where(eq(invites.kind, "claim"));
    const previous = rows.find((row) => row.tokenHash === previousHash);
    const live = rows.filter((row) => row.usedCount === 0 && row.revokedAt === null);
    const replacement = live[0];
    if (
      !previous || previous.usedCount !== 0 || previous.revokedAt === null || previous.redemptionUserId !== reservation.userId || previous.completedAt !== null
      || live.length !== 1 || !replacement || replacement.tokenHash !== replacementHash || replacement.redemptionUserId !== reservation.userId || replacement.completedAt !== null
    ) throw new Error("controller reissue invariant");
    await assertD508NoCompletedOwner();
    const replacementReservation = await readD508ProfileReservation();
    // Controller reissue deliberately refreshes `bound_at`. Only subject
    // identity is stable across capabilities, never the reservation timestamp.
    if (replacementReservation.userId !== reservation.userId) throw new Error("controller reissue subject changed");
    return replacementReservation;
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant");
  }
}

type D508InstrumentedTab = Readonly<{
  requests: RedactedRequestObservation[];
  navigations: RedactedNavigationObservation[];
  trace: unknown[];
  preview404s: { value: number };
  bind409s: { value: number };
  bindResponses: D508BindResponseClassification[];
  subscribeTrace: (listener: (event: unknown) => void) => () => void;
}>;

/** Per-tab channels remain separate: operation IDs are coordinator-local. */
async function instrumentD508Tab(
  page: Page,
  serverUrl: string,
  onTrace?: (event: unknown) => void,
): Promise<D508InstrumentedTab> {
  const requests: RedactedRequestObservation[] = [];
  const navigations: RedactedNavigationObservation[] = [];
  const trace: unknown[] = [];
  const traceSubscribers = new Set<(event: unknown) => void>();
  const preview404s = { value: 0 };
  const bind409s = { value: 0 };
  const bindResponses: D508BindResponseClassification[] = [];
  let logtoOrigin: string | null = null;
  page.on("request", (request) => {
    const observed = observeD508Request(request.url(), request.method(), serverUrl, logtoOrigin);
    logtoOrigin = observed.logtoOrigin;
    requests.push(observed.observation);
  });
  page.on("response", (response) => {
    const observed = redactRequestObservation(response.url(), response.request().method(), serverUrl, logtoOrigin);
    if (observed.origin === "server" && observed.method === "POST" && observed.pathname === "/api/owner-claim/preview" && response.status() === 404) preview404s.value += 1;
    if (observed.origin === "server" && observed.method === "POST" && observed.pathname === "/api/bind-logto-user") {
      bindResponses.push(classifyD508BindResponseStatus(response.status()));
      if (response.status() === 409) bind409s.value += 1;
    }
  });
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    const observed = redactNavigationObservation(frame.url(), serverUrl, logtoOrigin);
    if (observed.origin === "other" && frame.url().startsWith("http")) logtoOrigin = new URL(frame.url()).origin;
    navigations.push(redactNavigationObservation(frame.url(), serverUrl, logtoOrigin));
  });
  await page.exposeFunction("__nautiloD508RecordOwnerClaimEvent", (event: unknown) => {
    trace.push(event);
    onTrace?.(event);
    for (const subscriber of traceSubscribers) subscriber(event);
  });
  await page.addInitScript(() => {
    const target = globalThis as unknown as {
      __NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__?: (event: unknown) => void;
      __nautiloD508RecordOwnerClaimEvent?: (event: unknown) => Promise<void>;
    };
    target.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = (event) => { void target.__nautiloD508RecordOwnerClaimEvent?.(event); };
  });
  return {
    requests, navigations, trace, preview404s, bind409s, bindResponses,
    subscribeTrace: (listener) => { traceSubscribers.add(listener); return () => traceSubscribers.delete(listener); },
  };
}

async function d508ClaimCustody(page: Page): Promise<{ readonly session: boolean; readonly local: boolean }> {
  return page.evaluate((key) => ({ session: sessionStorage.getItem(key) !== null, local: localStorage.getItem(key) !== null }), "nautilo.ownerClaimHandoff.v1");
}

export type D508RejectedClaimReason = "expired" | "used_up";
export type D508RejectedClaimEvidence = Readonly<{
  serverReason: D508RejectedClaimReason;
  exactPreview410: true;
  recoveryVisible: true;
  custodyCleared: true;
  refreshIssuedNoOwnerIo: true;
}>;

/**
 * Expiry and replay are server decisions. A passing browser receipt therefore
 * requires the exact 410 reason, one failed preview operation, cleared
 * session-only custody, and a refresh that cannot replay any owner request.
 */
export function assertD508RejectedClaimContract(input: Readonly<{
  reason: D508RejectedClaimReason;
  responseStatus: number;
  responseReason: string;
  requestsBeforeRefresh: D508RequestCounter;
  requestsAfterRefresh: D508RequestCounter;
  oidcRequests: number;
  trace: readonly RedactedCoordinatorEvent[];
  custody: Readonly<{ session: boolean; local: boolean }>;
  recoveryVisible: boolean;
}>, stage: D508BrowserStage): D508RejectedClaimEvidence {
  const traceExact = input.trace.length === 2
    && input.trace[0]?.operationId === 1 && input.trace[1]?.operationId === 1
    && input.trace[0]?.phase === "previewing" && input.trace[1]?.phase === "previewing"
    && input.trace[0]?.commandKind === "preview-claim" && input.trace[1]?.commandKind === "preview-claim"
    && input.trace[0]?.result === "started" && input.trace[1]?.result === "failed"
    && input.trace[0]?.navigationIntent === null && input.trace[1]?.navigationIntent === null;
  const firstRequestExact = input.requestsBeforeRefresh.preview === 1
    && input.requestsBeforeRefresh.prepareAuth === 0
    && input.requestsBeforeRefresh.bind === 0
    && input.requestsBeforeRefresh.completeProfile === 0;
  const refreshExact = input.requestsAfterRefresh.preview === input.requestsBeforeRefresh.preview
    && input.requestsAfterRefresh.prepareAuth === input.requestsBeforeRefresh.prepareAuth
    && input.requestsAfterRefresh.bind === input.requestsBeforeRefresh.bind
    && input.requestsAfterRefresh.completeProfile === input.requestsBeforeRefresh.completeProfile;
  if (
    input.responseStatus !== 410 || input.responseReason !== input.reason
    || !traceExact || !firstRequestExact || !refreshExact || input.oidcRequests !== 0
    || input.custody.session || input.custody.local || !input.recoveryVisible
  ) throw new D508QualificationError(
    "browser-capture",
    traceExact ? "browser_contract" : "browser_trace",
    stage,
  );
  return {
    serverReason: input.reason,
    exactPreview410: true,
    recoveryVisible: true,
    custodyCleared: true,
    refreshIssuedNoOwnerIo: true,
  };
}

/** Real Workbench/Fastify proof for one server-rejected owner capability. */
async function runD508RejectedClaimQualification(
  input: Readonly<{ serverUrl: string; claim: string; reason: D508RejectedClaimReason }>,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
): Promise<Readonly<{
  requests: readonly RedactedRequestObservation[];
  navigations: readonly RedactedNavigationObservation[];
  trace: readonly RedactedCoordinatorEvent[];
  evidence: D508RejectedClaimEvidence;
}>> {
  let stage: D508BrowserStage = input.reason === "expired" ? "expired-claim-response" : "replay-response";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const tab = await instrumentD508Tab(page, input.serverUrl);
    const serverOrigin = new URL(input.serverUrl).origin;
    const responseWait = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === serverOrigin
        && url.pathname === "/api/owner-claim/preview"
        && response.request().method() === "POST";
    }, { timeout: timing.browserStepMs });
    let observePreviewFailure: (() => void) | undefined;
    const previewFailure = new Promise<void>((resolve) => { observePreviewFailure = resolve; });
    const unsubscribe = tab.subscribeTrace((event) => {
      if (
        event && typeof event === "object"
        && (event as Record<string, unknown>)["commandKind"] === "preview-claim"
        && (event as Record<string, unknown>)["result"] === "failed"
      ) observePreviewFailure?.();
    });
    try {
      await awaitD508QualificationWork(page.goto(
        `${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`,
        { waitUntil: "domcontentloaded", timeout: timing.browserStepMs },
      ), signal);
      const response = await awaitD508QualificationWork(responseWait, signal);
      const responseBody = await response.json() as unknown;
      const responseReason = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
        && Object.keys(responseBody).length === 1 && typeof (responseBody as Record<string, unknown>)["error"] === "string"
        ? (responseBody as Record<string, string>)["error"]!
        : "invalid-response";
      await awaitD508BrowserLatch(previewFailure, stage, timing.traceDeliveryMs, signal);
      stage = input.reason === "expired" ? "expired-claim-recovery" : "replay-recovery";
      const recovery = page.getByText("This setup link is missing, expired, or already used.", { exact: false });
      await awaitD508QualificationWork(recovery.waitFor({ timeout: timing.browserStepMs }), signal);
      const custody = await d508ClaimCustody(page);
      const requestsBeforeRefresh = d508RequestCounter(tab.requests);
      await awaitD508QualificationWork(page.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(recovery.waitFor({ timeout: timing.browserStepMs }), signal);
      const requestsAfterRefresh = d508RequestCounter(tab.requests);
      const trace = assertRedactedCoordinatorTrace(tab.trace);
      if (tab.requests.some((entry) => entry.pathname.includes(input.claim)) || tab.navigations.some((entry) => entry.pathname.includes(input.claim))) {
        throw new D508QualificationError("browser-capture", "browser_contract", stage);
      }
      const evidence = assertD508RejectedClaimContract({
        reason: input.reason,
        responseStatus: response.status(),
        responseReason,
        requestsBeforeRefresh,
        requestsAfterRefresh,
        oidcRequests: tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
        trace,
        custody,
        recoveryVisible: await recovery.isVisible(),
      }, stage);
      return { requests: tab.requests, navigations: tab.navigations, trace, evidence };
    } finally {
      unsubscribe();
    }
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

export type D508BrowserBackEvidence = Readonly<{
  returnedToCleanClaim: true;
  restoredHandleWithoutReentry: true;
  returnIssuedNoOwnerIo: true;
  custodyRemainedSessionOnly: true;
  resumedWithOneExplicitContinue: true;
}>;

/** Browser Back is a pause, not cancellation or an automatic redirect loop. */
export function assertD508BrowserBackContract(input: Readonly<{
  requests: readonly RedactedRequestObservation[];
  navigations: readonly RedactedNavigationObservation[];
  trace: readonly RedactedCoordinatorEvent[];
  bindResponses: readonly D508BindResponseClassification[];
  evidence: D508BrowserBackEvidence;
}>): void {
  const directLaunch = ["launch-logto-signup:started", "launch-logto-signup:succeeded"] as const;
  const redirectLaunch = ["launch-logto-signup:started", "launch-logto-signup:aborted", "launch-logto-signup:stale"] as const;
  const prefix = ["preview-claim:started", "preview-claim:succeeded", "prepare-signup:started", "prepare-signup:succeeded"] as const;
  const suffix = [
    "bind-subject:started", "bind-subject:succeeded",
    "complete-profile:started", "complete-profile:succeeded",
    "navigate-product:started", "navigate-product:succeeded",
  ] as const;
  const signature = input.trace.map((event) => `${event.commandKind}:${event.result}`);
  const matches = (firstLaunch: readonly string[], secondLaunch: readonly string[]): boolean => {
    const expected = [...prefix, ...firstLaunch, "prepare-signup:started", "prepare-signup:succeeded", ...secondLaunch, ...suffix];
    if (signature.join("|") !== expected.join("|")) return false;
    const commandLengths = [2, 2, firstLaunch.length, 2, secondLaunch.length, 2, 2, 2];
    const epochCommandCounts = [3, 2, 3];
    let eventIndex = 0;
    let commandIndex = 0;
    for (const epochCommandCount of epochCommandCounts) {
      for (let epochOperation = 1; epochOperation <= epochCommandCount; epochOperation += 1) {
        const length = commandLengths[commandIndex++];
        if (length === undefined) return false;
        const group = input.trace.slice(eventIndex, eventIndex + length);
        if (group.length !== length || group.some((event) => event.operationId !== epochOperation)) return false;
        eventIndex += length;
      }
    }
    return eventIndex === input.trace.length;
  };
  const traceExact = matches(directLaunch, directLaunch)
    || matches(directLaunch, redirectLaunch)
    || matches(redirectLaunch, directLaunch)
    || matches(redirectLaunch, redirectLaunch);
  const expectedBindRequests = assertD508BindResponseClassifications(input.bindResponses);
  const counts = d508RequestCounter(input.requests);
  const oidc = input.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
  const rootNavigation = input.navigations.some((navigation) => navigation.origin === "server" && navigation.pathname === "/");
  if (
    !traceExact || counts.preview !== 1 || counts.prepareAuth !== 2 || counts.bind !== expectedBindRequests
    || counts.completeProfile !== 1 || oidc !== 2 || !rootNavigation
    || !input.evidence.returnedToCleanClaim || !input.evidence.restoredHandleWithoutReentry
    || !input.evidence.returnIssuedNoOwnerIo || !input.evidence.custodyRemainedSessionOnly
    || !input.evidence.resumedWithOneExplicitContinue
  ) {
    throw new D508QualificationError(
      "browser-capture",
      traceExact ? "browser_contract" : "browser_trace",
      "contract-validation",
      traceExact ? [] : [{ kind: "browser-back-trace-spine", expected: [...prefix, ...directLaunch, "prepare-signup:started", "prepare-signup:succeeded", ...directLaunch, ...suffix], actual: signature }],
    );
  }
}

/**
 * A fresh browser proves ordinary auth-return custody, then performs one real
 * owner-only mutation through the shipped administrator UI. No claim
 * capability exists in this browser, so any owner-claim I/O is a regression.
 */
export function assertD508FreshBrowserAdminContract(input: Readonly<{
  startedSignedOut: boolean;
  returnedToExactGuide: boolean;
  authReturnConsumed: boolean;
  ownerIo: D508RequestCounter;
  oidcAuthorizations: number;
  reachedConfigureServer: boolean;
  initialPosture: Readonly<{ deploymentMode: string; securityLevel: string }>;
  posturePutCount: number;
  postureResponse: Readonly<{ status: number; changed: boolean; deploymentMode: string; securityLevel: string }>;
  refreshedPostureVisible: boolean;
}>): D508FreshBrowserAdminEvidence {
  const noOwnerIo = input.ownerIo.preview === 0 && input.ownerIo.prepareAuth === 0
    && input.ownerIo.bind === 0 && input.ownerIo.completeProfile === 0;
  if (
    !input.startedSignedOut || !input.returnedToExactGuide || !input.authReturnConsumed
    || !noOwnerIo || input.oidcAuthorizations !== 1 || !input.reachedConfigureServer
    || input.initialPosture.deploymentMode !== "server" || input.initialPosture.securityLevel !== "paranoid"
    || input.posturePutCount !== 1 || input.postureResponse.status !== 200
    || !input.postureResponse.changed || input.postureResponse.deploymentMode !== "server"
    || input.postureResponse.securityLevel !== "cautious" || !input.refreshedPostureVisible
  ) throw new D508QualificationError("browser-capture", "browser_contract", "contract-validation");
  return {
    freshBrowserStartedSignedOut: true,
    exactServerGuideReturn: true,
    authReturnConsumed: true,
    noOwnerClaimIo: true,
    oneOidcAuthorization: true,
    configureServerLinkReachedAdmin: true,
    pinGatedPostureChangedOnce: true,
    refreshedPostureVisible: true,
  };
}

/** Real hosted-auth Back → restored-handle → explicit resume → completion. */
async function runD508BrowserBackQualification(
  input: Readonly<{ serverUrl: string; handle: string; password: string; pin: string; claim: string }>,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
): Promise<Readonly<{
  requests: readonly RedactedRequestObservation[];
  navigations: readonly RedactedNavigationObservation[];
  trace: readonly RedactedCoordinatorEvent[];
  evidence: D508BrowserBackEvidence;
}>> {
  let stage: D508BrowserStage = "claim-entry";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const tab = await instrumentD508Tab(page, input.serverUrl);
    await awaitD508QualificationWork(page.goto(
      `${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`,
      { waitUntil: "domcontentloaded", timeout: timing.browserStepMs },
    ), signal);
    stage = "owner-handle";
    await awaitD508QualificationWork(page.locator("#owner-claim-handle").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "hosted-identifier";
    await awaitD508QualificationWork(page.locator('input[name="identifier"]').waitFor({ timeout: timing.browserStepMs }), signal);
    const beforeBack = d508RequestCounter(tab.requests);
    const beforeBackOidc = tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
    stage = "hosted-browser-back";
    await awaitD508QualificationWork(page.goBack({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    stage = "browser-back-return";
    await awaitD508QualificationWork(page.waitForURL((url) => url.origin === new URL(input.serverUrl).origin && url.pathname === "/claim" && url.search === "" && url.hash === "", { timeout: timing.browserStepMs }), signal);
    const handle = page.locator("#owner-claim-handle");
    await awaitD508QualificationWork(handle.waitFor({ timeout: timing.browserStepMs }), signal);
    const afterBack = d508RequestCounter(tab.requests);
    const afterBackOidc = tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
    const custody = await d508ClaimCustody(page);
    const returnIssuedNoOwnerIo = afterBack.preview === beforeBack.preview
      && afterBack.prepareAuth === beforeBack.prepareAuth && afterBack.bind === beforeBack.bind
      && afterBack.completeProfile === beforeBack.completeProfile && afterBackOidc === beforeBackOidc;
    const restoredHandleWithoutReentry = await handle.inputValue() === input.handle;
    stage = "browser-back-resume";
    await awaitD508QualificationWork(page.getByRole("button", { name: "Continue", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator('input[name="identifier"]').fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Create account", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "hosted-password";
    await awaitD508QualificationWork(page.locator('input[name="newPassword"]').fill(input.password, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Save password", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "owner-profile";
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin-confirm").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Complete setup", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "recovery-codes";
    await awaitD508QualificationWork(page.getByText("Save these recovery codes somewhere safe. They’re shown only once.", { exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    let observeTerminal: (() => void) | undefined;
    const terminal = new Promise<void>((resolve) => { observeTerminal = resolve; });
    const unsubscribe = tab.subscribeTrace((event) => {
      if (event && typeof event === "object" && (event as Record<string, unknown>)["commandKind"] === "navigate-product" && (event as Record<string, unknown>)["result"] === "succeeded") observeTerminal?.();
    });
    try {
      await awaitD508QualificationWork(page.getByRole("button", { name: "Open Nautilo", exact: true }).click({ timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(page.waitForURL((url) => url.pathname === "/", { timeout: timing.browserStepMs }), signal);
      await awaitD508BrowserLatch(terminal, "product-navigation", timing.traceDeliveryMs, signal);
    } finally {
      unsubscribe();
    }
    if (!restoredHandleWithoutReentry || !returnIssuedNoOwnerIo || !custody.session || custody.local) {
      throw new D508QualificationError("browser-capture", "browser_contract", "browser-back-return");
    }
    const evidence = {
      returnedToCleanClaim: true,
      restoredHandleWithoutReentry: true,
      returnIssuedNoOwnerIo: true,
      custodyRemainedSessionOnly: true,
      resumedWithOneExplicitContinue: true,
    } satisfies D508BrowserBackEvidence;
    const trace = assertRedactedCoordinatorTrace(tab.trace);
    assertD508BrowserBackContract({ requests: tab.requests, navigations: tab.navigations, trace, bindResponses: tab.bindResponses, evidence });
    return { requests: tab.requests, navigations: tab.navigations, trace, evidence };
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

/**
 * Complete the operator journey from a browser with no Nautilo or Logto
 * custody. The owner signs in from the durable guide destination, returns to
 * that exact route, follows the shipped Configure server link, and performs
 * one real PIN-gated posture mutation. The disposable stack is destroyed by
 * the parent immediately afterward, so the deliberate posture change needs no
 * compensating mutation.
 */
export type D508FreshBrowserAdminQualificationInput = Readonly<{
  serverUrl: string;
  handle: string;
  password: string;
  pin: string;
  /**
   * A caller-owned, non-browser guard evaluated immediately before the PIN
   * modal can be opened. It lets a disposable packaged-target qualifier prove
   * the target instance without copying this real UI flow or its selectors.
   */
  beforePinMutation?: () => Promise<void>;
}>;

export async function runD508FreshBrowserAdminQualification(
  input: D508FreshBrowserAdminQualificationInput,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
): Promise<Readonly<{
  requests: readonly RedactedRequestObservation[];
  navigations: readonly RedactedNavigationObservation[];
  evidence: D508FreshBrowserAdminEvidence;
}>> {
  let stage: D508BrowserStage = "fresh-browser-signed-out";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext();
    const page = await context.newPage();
    const tab = await instrumentD508Tab(page, input.serverUrl);
    await awaitD508QualificationWork(page.goto(`${input.serverUrl}/help/server`, {
      waitUntil: "domcontentloaded",
      timeout: timing.browserStepMs,
    }), signal);
    const signIn = page.getByTestId("sign-in-submit");
    await awaitD508QualificationWork(signIn.waitFor({ timeout: timing.browserStepMs }), signal);
    const startedSignedOut = await page.getByTestId("sign-in-dialog").isVisible();

    stage = "fresh-browser-hosted-login";
    await awaitD508QualificationWork(signIn.click({ timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator('input[name="identifier"]').fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator('input[name="password"]').fill(input.password, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Sign in", exact: true }).click({ timeout: timing.browserStepMs }), signal);

    stage = "fresh-browser-exact-return";
    await awaitD508QualificationWork(page.waitForURL((url) =>
      url.origin === new URL(input.serverUrl).origin
      && url.pathname === "/help/server" && url.search === "" && url.hash === "",
    { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByTestId("server-guide-page").waitFor({ timeout: timing.browserStepMs }), signal);
    const authReturnConsumed = await page.evaluate(() => sessionStorage.getItem("nautilo.authReturn.v1") === null);

    stage = "fresh-browser-guide-action";
    await awaitD508QualificationWork(page.getByRole("link", { name: "Configure server", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "fresh-browser-admin-route";
    await awaitD508QualificationWork(page.waitForURL((url) =>
      url.origin === new URL(input.serverUrl).origin && url.pathname === "/admin" && url.hash === "#server",
    { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByTestId("admin-page").waitFor({ timeout: timing.browserStepMs }), signal);
    stage = "fresh-browser-security-section";
    await awaitD508QualificationWork(page.getByRole("button", { name: "Security ▸", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "fresh-browser-posture-button";
    await awaitD508QualificationWork(page.getByRole("button", { name: "View server posture", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "fresh-browser-posture-view";
    await awaitD508QualificationWork(page.getByRole("heading", { name: "Security posture", exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Change posture", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "fresh-browser-posture-edit";
    await awaitD508QualificationWork(page.getByRole("heading", { name: "Change security posture", exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    // PostureEditModal intentionally nests each select inside its label. Pin
    // the shipped DOM contract directly; Playwright's getByLabel does not
    // resolve this span-wrapped label shape consistently in the production
    // build even though the browser exposes the visible label text.
    const deploymentMode = page.locator("label").filter({ hasText: "Deployment mode" }).locator("select");
    const securityLevel = page.locator("label").filter({ hasText: "Security level" }).locator("select");
    stage = "fresh-browser-posture-controls";
    await awaitD508QualificationWork(deploymentMode.waitFor({ timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(securityLevel.waitFor({ timeout: timing.browserStepMs }), signal);
    const initialPosture = {
      deploymentMode: await deploymentMode.inputValue(),
      securityLevel: await securityLevel.inputValue(),
    };
    stage = "fresh-browser-posture-selection";
    await awaitD508QualificationWork(securityLevel.selectOption("cautious", { timeout: timing.browserStepMs }), signal);

    stage = "fresh-browser-target-verification";
    if (input.beforePinMutation !== undefined) {
      await awaitD508QualificationWork(input.beforePinMutation(), signal);
    }
    stage = "pin-gated-posture";
    await awaitD508QualificationWork(page.getByRole("button", { name: "Confirm with PIN", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    const pinDialog = page.getByRole("heading", { name: "Confirm security change", exact: true }).locator("..").locator("..");
    await awaitD508QualificationWork(pinDialog.locator('input[type="password"]').fill(input.pin, { timeout: timing.browserStepMs }), signal);
    const responseWait = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.origin === new URL(input.serverUrl).origin
        && url.pathname === "/api/security/posture" && response.request().method() === "PUT";
    }, { timeout: timing.browserStepMs });
    await awaitD508QualificationWork(pinDialog.getByRole("button", { name: "Verify", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    const response = await awaitD508QualificationWork(responseWait, signal);
    let responseBody: unknown;
    try { responseBody = await response.json(); } catch { responseBody = null; }
    const body = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
      ? responseBody as Record<string, unknown>
      : {};

    stage = "pin-gated-posture-response";
    if (
      response.status() !== 200
      || body["changed"] !== true
      || body["deploymentMode"] !== "server"
      || body["securityLevel"] !== "cautious"
    ) {
      throw new D508QualificationError("browser-capture", "browser_contract", stage);
    }
    stage = "pin-gated-posture-refresh";
    await awaitD508QualificationWork(page.getByRole("heading", { name: "Security posture", exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    // The still-open posture modal is rendered inside the section and also
    // contains the level. Scope to the section's first direct content row so
    // strict locator semantics prove the inline summary refreshed exactly.
    const securitySectionContent = page.getByTestId("admin-security-section").locator(":scope > div").first();
    const postureSummary = securitySectionContent.locator(":scope > div").first();
    // formatLevel intentionally renders the canonical lowercase posture enum.
    const refreshedPosture = postureSummary.getByText("cautious", { exact: true });
    await awaitD508QualificationWork(refreshedPosture.waitFor({ timeout: timing.browserStepMs }), signal);
    const counts = d508RequestCounter(tab.requests);
    stage = "contract-validation";
    const evidence = assertD508FreshBrowserAdminContract({
      startedSignedOut,
      // The exact origin/path/query/hash predicate above already settled before
      // any guide action was allowed to run.
      returnedToExactGuide: true,
      authReturnConsumed,
      ownerIo: counts,
      oidcAuthorizations: tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      reachedConfigureServer: tab.navigations.some((navigation) => navigation.origin === "server" && navigation.pathname === "/admin"),
      initialPosture,
      posturePutCount: tab.requests.filter((request) => request.origin === "server" && request.method === "PUT" && request.pathname === "/api/security/posture").length,
      postureResponse: {
        status: response.status(),
        changed: body["changed"] === true,
        deploymentMode: typeof body["deploymentMode"] === "string" ? body["deploymentMode"] : "",
        securityLevel: typeof body["securityLevel"] === "string" ? body["securityLevel"] : "",
      },
      refreshedPostureVisible: await refreshedPosture.isVisible(),
    });
    return { requests: tab.requests, navigations: tab.navigations, evidence };
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await context?.close(); } catch { /* context already terminated */ }
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

/** The marker is validated entirely in page scope; only semantic booleans leave it. */
async function d508TerminalCustody(page: Page): Promise<{ readonly handoffCleared: boolean; readonly exactProductMarkerSessionOnly: boolean }> {
  return page.evaluate(({ handoffKey, terminalKey }) => {
    const handoffCleared = sessionStorage.getItem(handoffKey) === null && localStorage.getItem(handoffKey) === null;
    const noLocalMarker = localStorage.getItem(terminalKey) === null;
    let exactProductMarker = false;
    try {
      const raw = sessionStorage.getItem(terminalKey);
      const marker = raw === null ? null : JSON.parse(raw) as unknown;
      if (marker !== null && typeof marker === "object" && !Array.isArray(marker)) {
        const record = marker as Record<string, unknown>;
        exactProductMarker = Object.keys(record).length === 2
          && Object.prototype.hasOwnProperty.call(record, "schemaVersion")
          && Object.prototype.hasOwnProperty.call(record, "finish")
          && record["schemaVersion"] === 1 && record["finish"] === "product";
      }
    } catch { /* semantic false below */ }
    return { handoffCleared, exactProductMarkerSessionOnly: exactProductMarker && noLocalMarker };
  }, { handoffKey: "nautilo.ownerClaimHandoff.v1", terminalKey: "nautilo.ownerClaimTerminal.v1" });
}

type D508RecoveryCodeFingerprint = Readonly<{ fingerprint: string }>;

/** Hash only already-hashed DB rows privately; no recovery material reaches a receipt. */
async function readD508RecoveryCodeFingerprint(userId: string): Promise<D508RecoveryCodeFingerprint> {
  try {
    const rows = await getSharedDirectDb()
      .select({ codeHash: recoveryCodes.codeHash, used: recoveryCodes.used })
      .from(recoveryCodes)
      .where(eq(recoveryCodes.userId, userId));
    if (rows.length === 0 || rows.some((row) => typeof row.codeHash !== "string" || row.codeHash.length === 0 || row.used)) throw new Error("recovery codes missing");
    return { fingerprint: createHash("sha256").update(rows.map((row) => row.codeHash).sort().join("\n")).digest("hex") };
  } catch {
    throw new D508QualificationError("db-invariants", "db_invariant", "lost-completion-response");
  }
}

async function d508StartNewOwnerTab(
  page: Page,
  input: Readonly<{ handle: string; password: string }>,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
): Promise<void> {
  await awaitD508QualificationWork(page.locator("#owner-claim-handle").fill(input.handle, { timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.getByRole("button", { name: "Continue" }).click({ timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.locator('input[name="identifier"]').fill(input.handle, { timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.getByRole("button", { name: "Create account", exact: true }).click({ timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.locator('input[name="newPassword"]').fill(input.password, { timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.getByRole("button", { name: "Save password", exact: true }).click({ timeout: timing.browserStepMs }), signal);
}

async function d508SignInAsExistingAccount(
  page: Page,
  input: Readonly<{ handle: string; password: string }>,
  timing: D508QualificationTimingPolicy,
  signal?: AbortSignal,
  reportStage?: (stage: D508BrowserStage) => void,
  stages?: Readonly<{ entry: D508BrowserStage; submit: D508BrowserStage }>,
): Promise<void> {
  reportStage?.(stages?.entry ?? "original-owner-hosted-login-entry");
  await awaitD508QualificationWork(page.getByRole("button", { name: "Sign in to finish setup", exact: true }).click({ timeout: timing.browserStepMs }), signal);
  // Pinned Logto 1.38 username+password SIE selects PasswordSignInForm.
  await awaitD508QualificationWork(page.locator('input[name="identifier"]').fill(input.handle, { timeout: timing.browserStepMs }), signal);
  await awaitD508QualificationWork(page.locator('input[name="password"]').fill(input.password, { timeout: timing.browserStepMs }), signal);
  reportStage?.(stages?.submit ?? "original-owner-hosted-login-submit");
  await awaitD508QualificationWork(page.getByRole("button", { name: "Sign in", exact: true }).click({ timeout: timing.browserStepMs }), signal);
}

function assertNoOwnedResources(instanceId: string, state: { readonly ports: number[]; readonly composeProject: string }): void {
  const root = resolveNautiloStorageRoot(homedir(), instanceId);
  if (existsSync(root)) throw new D508QualificationError("teardown", "teardown");
  for (const args of [["ps", "-aq", "--filter", `label=com.docker.compose.project=${state.composeProject}`], ["volume", "ls", "-q", "--filter", `label=com.docker.compose.project=${state.composeProject}`], ["network", "ls", "-q", "--filter", `label=com.docker.compose.project=${state.composeProject}`]]) {
    const output = spawnSync("docker", args, { encoding: "utf8" });
    if (output.status !== 0 || output.stdout.trim().length !== 0) throw new D508QualificationError("teardown", "teardown");
  }
  for (const port of state.ports) {
    const output = spawnSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], { encoding: "utf8" });
    // lsof exits 1 for no matching listener; any stdout means teardown leaked a process.
    if (output.error || output.stdout.trim().length !== 0) throw new D508QualificationError("teardown", "teardown");
  }
}

/** Exact generated-project fallback when dev-stack failed before instance.json became valid. */
function teardownGeneratedProjectFallback(projectName: string): boolean {
  const env = { ...process.env, COMPOSE_PROJECT_NAME: projectName };
  const logto = spawnSync("docker", [...dockerComposeNautiloPrefixRaw(projectName), "--profile", "auth", "down", "-v"], { cwd: NAUTILO_REPO_ROOT, env, encoding: "utf8" });
  const legacy = spawnSync("docker", [...dockerComposeDbDevPrefixRaw(projectName), "down", "-v"], { cwd: NAUTILO_REPO_ROOT, env, encoding: "utf8" });
  return logto.status === 0 && legacy.status === 0;
}

/** Dedicated fresh-stack vertical for responses lost only after server commit. */
async function runD508LostResponsesQualification(
  input: Readonly<{
    serverUrl: string;
    handle: string;
    password: string;
    pin: string;
    claim: string;
  }>,
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
  signal?: AbortSignal,
): Promise<{
  readonly requests: RedactedRequestObservation[];
  readonly navigations: RedactedNavigationObservation[];
  readonly trace: RedactedCoordinatorEvent[];
  readonly evidence: D508LostResponsesEvidence;
}> {
  let stage: D508BrowserStage = "claim-entry";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    let observeTerminalTrace: (() => void) | undefined;
    const terminalTrace = new Promise<void>((resolve) => { observeTerminalTrace = resolve; });
    const tab = await instrumentD508Tab(page, input.serverUrl, (event) => {
      if (
        event && typeof event === "object"
        && (event as Record<string, unknown>)["commandKind"] === "navigate-product"
        && (event as Record<string, unknown>)["result"] === "succeeded"
      ) observeTerminalTrace?.();
    });
    const bindOrder: string[] = [];
    const completionOrder: string[] = [];
    let bindForwarded = 0;
    let bindCommitted = false;
    let bindAborted = false;
    let bindReservation: D508ProfileReservationSnapshot | undefined;
    let resolveBindCommitted: (() => void) | undefined;
    const bindCommittedLatch = new Promise<void>((resolve) => { resolveBindCommitted = resolve; });
    await page.route("**/api/bind-logto-user", async (route) => {
      if (bindForwarded !== 0) { await route.continue(); return; }
      bindForwarded += 1;
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        if (response.status() !== 200) throw new Error("bind response not committed");
        bindOrder.push("response-200");
        bindReservation = await readD508ProfileReservation();
        await assertD508NoCompletedOwner();
        bindOrder.push("db-committed");
        bindCommitted = true;
        await route.abort("connectionreset");
        bindOrder.push("connectionreset");
        bindAborted = true;
        resolveBindCommitted?.();
      } catch {
        resolveBindCommitted?.();
        try { await route.abort("connectionreset"); } catch { /* browser may have cancelled it */ }
      }
    });

    stage = "claim-entry";
    await awaitD508QualificationWork(page.goto(`${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    stage = "owner-handle";
    await d508StartNewOwnerTab(page, input, timing, signal);
    stage = "lost-bind-response";
    await awaitD508BrowserLatch(bindCommittedLatch, "lost-bind-response", timing.browserStepMs, signal);
    if (!bindCommitted || !bindAborted || bindReservation === undefined || bindForwarded !== 1) {
      throw new D508QualificationError("browser-capture", "browser_contract", "lost-bind-response");
    }
    assertD508CommittedResponseAbortOrder(bindOrder);
    // The automatic same-subject reobserve uses the ordinary second request;
    // the route is intentionally one-shot and forwards no retry itself.
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    await assertD508ProfileReservationUnchanged(bindReservation);

    let completionForwarded = 0;
    let completionCommitted = false;
    let completionAborted = false;
    let completionFingerprint: D508RecoveryCodeFingerprint | undefined;
    let resolveCompletionCommitted: (() => void) | undefined;
    const completionCommittedLatch = new Promise<void>((resolve) => { resolveCompletionCommitted = resolve; });
    stage = "lost-completion-response";
    await page.route("**/api/owner-claim/complete-profile", async (route) => {
      if (completionForwarded !== 0) { await route.continue(); return; }
      completionForwarded += 1;
      try {
        const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
        if (response.status() !== 200) throw new Error("completion response not committed");
        completionOrder.push("response-200");
        await assertDbTerminalInvariants();
        await assertD508CompletedOwnerMatches(bindReservation!.userId);
        completionFingerprint = await readD508RecoveryCodeFingerprint(bindReservation!.userId);
        completionOrder.push("db-committed");
        completionCommitted = true;
        await route.abort("connectionreset");
        completionOrder.push("connectionreset");
        completionAborted = true;
        resolveCompletionCommitted?.();
      } catch {
        resolveCompletionCommitted?.();
        try { await route.abort("connectionreset"); } catch { /* browser may have cancelled it */ }
      }
    });
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin-confirm").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    const setupStatusBeforeCompletion = tab.requests.filter((request) => request.method === "GET" && request.origin === "server" && request.pathname === "/api/setup/status").length;
    await awaitD508QualificationWork(page.getByRole("button", { name: "Complete setup" }).click({ timeout: timing.browserStepMs }), signal);
    await awaitD508BrowserLatch(completionCommittedLatch, "lost-completion-response", timing.browserStepMs, signal);
    if (!completionCommitted || !completionAborted || completionFingerprint === undefined || completionForwarded !== 1) {
      throw new D508QualificationError("browser-capture", "browser_contract", "lost-completion-response");
    }
    assertD508CommittedResponseAbortOrder(completionOrder);
    stage = "lost-response-terminal";
    await awaitD508QualificationWork(page.getByText("Your server setup is confirmed, but this browser lost the recovery-code response.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
    const setupStatusAfterReobserve = tab.requests.filter((request) => request.method === "GET" && request.origin === "server" && request.pathname === "/api/setup/status").length;
    const setupStatusDelta = setupStatusAfterReobserve - setupStatusBeforeCompletion;
    const terminalCustody = await d508TerminalCustody(page);
    const security = page.getByRole("link", { name: "Security settings", exact: true });
    const noCodesTerminal = await page.locator("pre").count() === 0 && await security.count() === 1 && await security.getAttribute("href") === "/settings#security";
    const fingerprintAfterReobserve = await readD508RecoveryCodeFingerprint(bindReservation.userId);
    const recoveryFingerprintUnchanged = fingerprintAfterReobserve.fingerprint === completionFingerprint.fingerprint;
    // Keep lost-response cardinalities bounded to the terminal recovery
    // decision. App-shell activity after the chosen navigation is unrelated.
    const requestsBeforeProductNavigation = [...tab.requests];
    await awaitD508QualificationWork(page.getByRole("button", { name: "Open Nautilo", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "product-navigation";
    await awaitD508QualificationWork(page.waitForURL((url) => url.pathname === "/", { timeout: timing.browserStepMs }), signal);
    stage = "coordinator-trace";
    await awaitD508BrowserLatch(terminalTrace, "coordinator-trace", timing.traceDeliveryMs, signal);
    const trace = assertRedactedCoordinatorTrace(tab.trace);
    stage = "contract-validation";
    const evidence = assertD508LostResponsesContract({
      trace,
      requests: requestsBeforeProductNavigation,
      navigations: tab.navigations,
      oidcRequests: tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      bindCommitted200: bindCommitted,
      bindAbortedAfterCommit: bindAborted,
      bindReservationUnchanged: true,
      completionCommitted200: completionCommitted,
      completionAbortedAfterCommit: completionAborted,
      completionRecoveryFingerprintUnchanged: recoveryFingerprintUnchanged,
      setupStatusDelta,
      terminalCustody: terminalCustody.handoffCleared && terminalCustody.exactProductMarkerSessionOnly,
      noCodesTerminal,
    });
    return { requests: tab.requests, navigations: tab.navigations, trace, evidence };
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

/** A fresh-stack signed-out-profile and wrong-subject recovery vertical. */
async function runD508SignedOutWrongAccountQualification(
  input: Readonly<{ serverUrl: string; handle: string; password: string; pin: string; claim: string; wrongHandle: string; wrongPassword: string }>,
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
  signal?: AbortSignal,
): Promise<{ readonly requests: RedactedRequestObservation[]; readonly navigations: RedactedNavigationObservation[]; readonly ownerTrace: RedactedCoordinatorEvent[]; readonly wrongProvisionTrace: RedactedCoordinatorEvent[]; readonly evidence: D508SignedOutWrongAccountEvidence }> {
  let stage: D508BrowserStage = "wrong-account-provision";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const wrongContext = await browser.newContext();
    const wrongPage = await wrongContext.newPage();
    let resolveWrongBindFailure: (() => void) | undefined;
    const wrongBindFailure = new Promise<void>((resolve) => { resolveWrongBindFailure = resolve; });
    const wrongTab = await instrumentD508Tab(wrongPage, input.serverUrl, (event) => {
      if (
        event && typeof event === "object"
        && (event as Record<string, unknown>)["commandKind"] === "bind-subject"
        && (event as Record<string, unknown>)["result"] === "failed"
      ) resolveWrongBindFailure?.();
    });
    let wrongBindFulfillments = 0;
    let releaseWrongBind: (() => void) | undefined;
    const wrongBindLatch = new Promise<void>((resolve) => { releaseWrongBind = resolve; });
    await wrongPage.route("**/api/bind-logto-user", async (route) => {
      // Only the provisioning bind receives the deterministic ordinary server
      // failure. A second request is never forwarded or disguised as another
      // ordinary failure: request/trace cardinality below rejects it.
      if (wrongBindFulfillments !== 0) {
        await route.abort("blockedbyclient");
        return;
      }
      const response = assertD508SeedBindFailureResponse(D508_SEED_BIND_FAILURE_RESPONSE);
      await route.fulfill({ status: response.status, contentType: response.contentType, body: JSON.stringify(response.json) });
      wrongBindFulfillments += 1;
      releaseWrongBind?.();
    });
    await awaitD508QualificationWork(wrongPage.goto(`${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await d508StartNewOwnerTab(wrongPage, { handle: input.wrongHandle, password: input.wrongPassword }, timing, signal);
    await awaitD508BrowserLatch(wrongBindLatch, "wrong-account-provision", timing.browserStepMs, signal);
    await awaitD508BrowserLatch(wrongBindFailure, "wrong-account-provision", timing.traceDeliveryMs, signal);
    if (wrongBindFulfillments !== 1) throw new D508QualificationError("browser-capture", "browser_contract", stage);
    await assertD508ClaimUnboundBeforeRefresh();
    await assertD508NoCompletedOwner();
    const wrongProvisionTrace = assertRedactedCoordinatorTrace(wrongTab.trace);
    await wrongContext.close();

    stage = "claim-entry";
    const context = await browser.newContext();
    const page = await context.newPage();
    const tab = await instrumentD508Tab(page, input.serverUrl);
    await awaitD508QualificationWork(page.goto(`${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await d508StartNewOwnerTab(page, input, timing, signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    const reservation = await readD508ProfileReservation();
    await assertD508NoCompletedOwner();

    stage = "signed-out-profile-signout-started";
    const beforeSignOut = d508RequestCounter(tab.requests);
    const beforeSignOutOidc = tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
    const profileSignOutStarted = awaitD508SignOutTraceStarted(tab.subscribeTrace, timing.traceDeliveryMs, "signed-out-profile-signout-started", signal);
    const profileLogoutReturn = awaitD508PostLogoutReturn(page, input.serverUrl, timing.browserStepMs, {
      flow: "profile", leaveStage: "signed-out-profile-navigation-away", returnStage: "signed-out-profile-return", ...(signal === undefined ? {} : { signal }),
    });
    try {
      const click = page.getByRole("button", { name: "Sign out and continue", exact: true }).click({ timeout: timing.browserStepMs, noWaitAfter: true });
      stage = "signed-out-profile-return";
      await awaitD508QualificationWork(Promise.all([click, profileLogoutReturn, profileSignOutStarted]), signal);
    } catch (error) {
      profileLogoutReturn.dispose();
      profileSignOutStarted.dispose();
      throw error;
    }
    stage = "signed-out-profile-hydrated-copy";
    let signedOutProfileCopy = false;
    try {
      await awaitD508QualificationWork(page.getByText("Your setup progress is saved in this browser session.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
      signedOutProfileCopy = true;
    } catch {
      assertD508SignedOutProfileCheckpoint("hydrated-copy", false, stage);
    }
    assertD508SignedOutProfileCheckpoint("hydrated-copy", signedOutProfileCopy, stage);
    stage = "signed-out-profile-owner-io";
    let signedOutProfileOwnerIo: D508RequestCounter;
    try {
      signedOutProfileOwnerIo = assertD508PassiveProfileCheckpointRequestDelta(beforeSignOut, d508RequestCounter(tab.requests));
      const oidcDelta = tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length - beforeSignOutOidc;
      if (oidcDelta !== 0) throw new Error("unexpected OIDC during signed-out profile checkpoint");
    } catch {
      assertD508SignedOutProfileCheckpoint("owner-io", false, stage);
      throw new D508QualificationError("browser-capture", "browser_contract", stage);
    }
    stage = "signed-out-profile-custody";
    const signedOutCustody = await d508ClaimCustody(page);
    assertD508SignedOutProfileCheckpoint("session-custody", signedOutCustody.session && !signedOutCustody.local, stage);
    stage = "signed-out-profile-reservation";
    try { await assertD508ProfileReservationUnchanged(reservation); }
    catch { assertD508SignedOutProfileCheckpoint("reservation", false, stage); }
    stage = "signed-out-profile-no-owner";
    try { await assertD508NoCompletedOwner(); }
    catch { assertD508SignedOutProfileCheckpoint("no-owner", false, stage); }

    stage = "wrong-account-hosted-login-entry";
    const bind409Before = tab.bind409s.value;
    const wrongBindResponsesBefore = tab.bindResponses.length;
    const wrongBind409Response = awaitD508ExactBind409Response(page, input.serverUrl, timing.browserStepMs, "wrong-account-bind-response", signal);
    try {
      await d508SignInAsExistingAccount(
        page,
        { handle: input.wrongHandle, password: input.wrongPassword },
        timing,
        signal,
        (nextStage) => { stage = nextStage; },
        { entry: "wrong-account-hosted-login-entry", submit: "wrong-account-hosted-login-submit" },
      );
      stage = "wrong-account-recovery-ui";
      const recoveryUi = awaitD508QualificationWork(page.getByText("This server was reserved by a different account.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(Promise.all([wrongBind409Response, recoveryUi]), signal);
    } finally {
      wrongBind409Response.dispose();
    }
    const wrongBind409s = tab.bind409s.value - bind409Before;
    const wrongBindResponses = tab.bindResponses.slice(wrongBindResponsesBefore);
    if (wrongBind409s !== 1 || wrongBindResponses.join("|") !== "other") throw new D508QualificationError("browser-capture", "browser_contract", "wrong-account-bind-response");
    await assertD508ProfileReservationUnchanged(reservation);
    await assertD508NoCompletedOwner();

    stage = "original-owner-retry-action";
    await awaitD508QualificationWork(page.getByRole("button", { name: "Sign in to continue", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "account-switch-signout-started";
    const accountSwitchSignOutStarted = awaitD508SignOutTraceStarted(tab.subscribeTrace, timing.traceDeliveryMs, "account-switch-signout-started", signal);
    const accountSwitchLogoutReturn = awaitD508PostLogoutReturn(page, input.serverUrl, timing.browserStepMs, {
      flow: "account-switch", leaveStage: "account-switch-navigation-away", returnStage: "account-switch-return", ...(signal === undefined ? {} : { signal }),
    });
    try {
      const click = page.getByRole("button", { name: "Sign out and continue", exact: true }).click({ timeout: timing.browserStepMs, noWaitAfter: true });
      stage = "account-switch-return";
      await awaitD508QualificationWork(Promise.all([click, accountSwitchLogoutReturn, accountSwitchSignOutStarted]), signal);
    } catch (error) {
      accountSwitchLogoutReturn.dispose();
      accountSwitchSignOutStarted.dispose();
      throw error;
    }
    stage = "original-owner-hosted-login-entry";
    const correctRecoveryBindResponsesBefore = tab.bindResponses.length;
    const correctRecoveryBindResponse = awaitD508ExactBindSuccessResponse(page, input.serverUrl, timing.browserStepMs, "original-owner-bind-response", signal);
    const profileVisible = awaitD508QualificationWork(page.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    void profileVisible.catch(() => undefined);
    try {
      await d508SignInAsExistingAccount(
        page,
        input,
        timing,
        signal,
        (nextStage) => { stage = nextStage; },
        { entry: "original-owner-hosted-login-entry", submit: "original-owner-hosted-login-submit" },
      );
      stage = "original-owner-profile-visible";
      await awaitD508QualificationWork(Promise.all([correctRecoveryBindResponse, profileVisible]), signal);
    } finally {
      correctRecoveryBindResponse.dispose();
    }
    stage = "original-owner-handle-absence";
    if (await page.locator("#owner-claim-handle").count() !== 0) throw new D508QualificationError("browser-capture", "browser_contract", stage);
    const correctRecoveryBindResponses = tab.bindResponses.slice(correctRecoveryBindResponsesBefore);
    assertD508BindResponseClassifications(correctRecoveryBindResponses);
    await assertD508ProfileReservationUnchanged(reservation);
    stage = "original-owner-profile-submit";
    const recoveryCodes = awaitD508QualificationWork(page.getByText("Save these recovery codes somewhere safe. They’re shown only once.", { exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    void recoveryCodes.catch(() => undefined);
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin-confirm").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Complete setup" }).click({ timeout: timing.browserStepMs }), signal);
    stage = "original-owner-recovery-codes";
    await recoveryCodes;
    await assertDbTerminalInvariants();
    await assertD508CompletedOwnerMatches(reservation.userId, stage);
    stage = "original-owner-product-navigation";
    const productNavigation = awaitD508QualificationWork(page.waitForURL((url) => url.pathname === "/", { timeout: timing.browserStepMs }), signal);
    void productNavigation.catch(() => undefined);
    await awaitD508QualificationWork(Promise.all([
      page.getByRole("button", { name: "Open Nautilo", exact: true }).click({ timeout: timing.browserStepMs }),
      productNavigation,
    ]), signal);
    stage = "coordinator-trace";
    const ownerTrace = assertRedactedCoordinatorTrace(tab.trace);
    stage = "contract-validation";
    const evidence = assertD508SignedOutWrongAccountContract({
      wrongProvisionTrace, ownerTrace,
      wrongProvisionRequests: d508RequestCounter(wrongTab.requests), ownerRequests: d508RequestCounter(tab.requests),
      ownerOidcRequests: tab.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      wrongBind409s, wrongBindResponses, correctRecoveryBindResponses, signedOutProfileOwnerIo,
      evidence: {
        wrongAccountCreatedWithoutServerBind: true,
        signedOutProfilePreservedSessionOnlyCustody: true,
        wrongSubjectBind409Observed: true,
        wrongSubjectReceivedOnlyClaimReserved: true,
        wrongSubjectDidNotChangeReservationOrCompleteOwner: true,
        originalSubjectRecoveredWithoutHandleEntry: true,
        originalSubjectCompletedExactlyOnce: true,
      },
    });
    return { requests: [...wrongTab.requests, ...tab.requests], navigations: [...wrongTab.navigations, ...tab.navigations], ownerTrace, wrongProvisionTrace, evidence };
  } catch (error) { throw withBrowserStage(error, stage); }
  finally { try { await browser.close(); } catch { /* closed */ } }
}

/**
 * One BrowserContext gives Page A, B and C their real shared Logto cookies
 * while keeping their claim custody tab-scoped. The controller remains the
 * sole reissue authority; no raw capability is copied out of browser custody.
 */
async function runD508TwoTabReissueQualification(
  input: Readonly<{
    runId: string;
    serverUrl: string;
    handle: string;
    password: string;
    pin: string;
    claim: string;
    replacementClaim: string;
  }>,
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
  signal?: AbortSignal,
): Promise<{
  readonly requests: RedactedRequestObservation[];
  readonly navigations: RedactedNavigationObservation[];
  readonly pageATrace: RedactedCoordinatorEvent[];
  readonly pageBTrace: RedactedCoordinatorEvent[];
  readonly pageCTrace: RedactedCoordinatorEvent[];
  readonly twoTabReissueEvidence: D508TwoTabReissueEvidence;
  readonly restartAfterBindEvidence: D508RestartAfterBindEvidence;
}> {
  let stage: D508BrowserStage = "two-tab-entry";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const pageA = await context.newPage();
    const pageB = await context.newPage();
    const tabA = await instrumentD508Tab(pageA, input.serverUrl);
    const tabB = await instrumentD508Tab(pageB, input.serverUrl);
    const claimAUrl = `${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=product`;
    await Promise.all([
      awaitD508QualificationWork(pageA.goto(claimAUrl, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal),
      awaitD508QualificationWork(pageB.goto(claimAUrl, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal),
    ]);
    await Promise.all([
      awaitD508QualificationWork(pageA.locator("#owner-claim-handle").waitFor({ timeout: timing.browserStepMs }), signal),
      awaitD508QualificationWork(pageB.locator("#owner-claim-handle").waitFor({ timeout: timing.browserStepMs }), signal),
    ]);
    const custodyA = await d508ClaimCustody(pageA);
    const custodyB = await d508ClaimCustody(pageB);
    if (!custodyA.session || custodyA.local || !custodyB.session || custodyB.local) {
      throw new D508QualificationError("browser-capture", "browser_contract", "two-tab-entry");
    }

    stage = "two-tab-reservation";
    const pageBBeforeAReservation = d508RequestCounter(tabB.requests);
    await d508StartNewOwnerTab(pageA, input, timing, signal);
    await awaitD508QualificationWork(pageA.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    const reservation = await readD508ProfileReservation();
    await assertD508NoCompletedOwner();

    // B captured the same capability before authentication, but has received
    // no Human action. Assert its exact owner-I/O delta immediately after A's
    // authoritative reservation rather than waiting on B's renderer timing.
    const pageBReservationDelta = assertD508PassiveProfileCheckpointRequestDelta(pageBBeforeAReservation, d508RequestCounter(tabB.requests));

    // Restart the selected host server only after A has authoritatively bound
    // its Logto subject and before any profile completion. Container identity,
    // state, and restart counts remain private comparison inputs; the receipt
    // contains only the semantic proof below.
    stage = "server-restart-after-bind";
    const pageABeforeRestartRequests = d508RequestCounter(tabA.requests);
    const pageABeforeRestartTraceLength = tabA.trace.length;
    const pageABeforeRestartOidc = tabA.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
    const pageACustodyBeforeRestart = await d508ClaimCustody(pageA);
    const instance = resolveInstanceUncached({ ...process.env, NAUTILO_INSTANCE_ID: input.runId });
    const serverPidBeforeRestart = readD508LiveServerPid(input.runId, instance.server.port);
    const appPostgresBeforeRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.legacyPostgres);
    const logtoCoreBeforeRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.logtoCore);
    const logtoPostgresBeforeRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.logtoPostgres);
    await restartD508HostServer(input.runId, timing, signal);
    const serverPidAfterRestart = readD508LiveServerPid(input.runId, instance.server.port);
    const appPostgresAfterRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.legacyPostgres);
    const logtoCoreAfterRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.logtoCore);
    const logtoPostgresAfterRestart = readD508ContainerRuntimeSnapshot(instance.compose.containers.logtoPostgres);
    await assertD508ProfileReservationUnchanged(reservation);
    await assertD508NoCompletedOwner();
    const pageABeforeReloadRequests = d508RequestCounter(tabA.requests);
    const pageABeforeReloadTraceLength = tabA.trace.length;
    const pageABeforeReloadOidc = tabA.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
    const pageABeforeReloadBindResponses = tabA.bindResponses.length;
    const pageACustodyBeforeReload = await d508ClaimCustody(pageA);

    stage = "post-restart-profile-visible";
    await awaitD508QualificationWork(pageA.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageA.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    await assertD508ProfileReservationUnchanged(reservation);
    await assertD508NoCompletedOwner();
    const pageACustodyAfterReload = await d508ClaimCustody(pageA);
    const restartAfterBindEvidence = assertD508RestartAfterBindContract({
      serverPidBefore: serverPidBeforeRestart,
      serverPidAfter: serverPidAfterRestart,
      appPostgresUnchanged: sameD508ContainerRuntime(appPostgresBeforeRestart, appPostgresAfterRestart),
      logtoCoreUnchanged: sameD508ContainerRuntime(logtoCoreBeforeRestart, logtoCoreAfterRestart),
      logtoPostgresUnchanged: sameD508ContainerRuntime(logtoPostgresBeforeRestart, logtoPostgresAfterRestart),
      reservationUnchanged: true,
      noCompletedOwner: true,
      beforeReload: {
        requestDelta: {
          preview: pageABeforeReloadRequests.preview - pageABeforeRestartRequests.preview,
          prepareAuth: pageABeforeReloadRequests.prepareAuth - pageABeforeRestartRequests.prepareAuth,
          bind: pageABeforeReloadRequests.bind - pageABeforeRestartRequests.bind,
          completeProfile: pageABeforeReloadRequests.completeProfile - pageABeforeRestartRequests.completeProfile,
        },
        traceDelta: pageABeforeReloadTraceLength - pageABeforeRestartTraceLength,
        oidcDelta: pageABeforeReloadOidc - pageABeforeRestartOidc,
        sessionOnlyCustody: pageACustodyBeforeRestart.session && !pageACustodyBeforeRestart.local && pageACustodyBeforeReload.session && !pageACustodyBeforeReload.local,
      },
      afterReload: {
        requestDelta: {
          preview: d508RequestCounter(tabA.requests).preview - pageABeforeReloadRequests.preview,
          prepareAuth: d508RequestCounter(tabA.requests).prepareAuth - pageABeforeReloadRequests.prepareAuth,
          bind: d508RequestCounter(tabA.requests).bind - pageABeforeReloadRequests.bind,
          completeProfile: d508RequestCounter(tabA.requests).completeProfile - pageABeforeReloadRequests.completeProfile,
        },
        trace: assertRedactedCoordinatorTrace(tabA.trace.slice(pageABeforeReloadTraceLength)),
        oidcDelta: tabA.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length - pageABeforeReloadOidc,
        bindResponses: tabA.bindResponses.slice(pageABeforeReloadBindResponses),
        sessionOnlyCustody: pageACustodyAfterReload.session && !pageACustodyAfterReload.local,
      },
    });

    stage = "tab-loss-recovery";
    await pageA.close();
    stage = "controller-reissue";
    await installLoopbackClaim(input.serverUrl, input.replacementClaim, timing);
    const replacementReservation = await assertD508ControllerReissue(input.claim, input.replacementClaim, reservation);

    // B owns the stale session handoff. Its first reload has one authoritative
    // 404 preview and clears custody; a second reload proves it cannot revive
    // that old claim or issue any owner mutation.
    stage = "stale-custody-fence";
    const pageBBeforeRevokedRefresh = d508RequestCounter(tabB.requests);
    const preview404sBefore = tabB.preview404s.value;
    await awaitD508QualificationWork(pageB.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageB.getByText("This setup link is missing, expired, or already used.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
    const pageBRevokedRefreshDelta = {
      preview: d508RequestCounter(tabB.requests).preview - pageBBeforeRevokedRefresh.preview,
      prepareAuth: d508RequestCounter(tabB.requests).prepareAuth - pageBBeforeRevokedRefresh.prepareAuth,
      bind: d508RequestCounter(tabB.requests).bind - pageBBeforeRevokedRefresh.bind,
      completeProfile: d508RequestCounter(tabB.requests).completeProfile - pageBBeforeRevokedRefresh.completeProfile,
    } as const;
    const pageBRevokedPreview404s = tabB.preview404s.value - preview404sBefore;
    const clearedCustody = await d508ClaimCustody(pageB);
    if (clearedCustody.session || clearedCustody.local) throw new D508QualificationError("browser-capture", "browser_contract", "stale-custody-fence");
    const pageBBeforeSecondRefresh = d508RequestCounter(tabB.requests);
    await awaitD508QualificationWork(pageB.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageB.getByText("This setup link is missing, expired, or already used.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
    const pageBSecondRefreshDelta = d508RequestCounter(tabB.requests);
    if (
      pageBSecondRefreshDelta.preview !== pageBBeforeSecondRefresh.preview
      || pageBSecondRefreshDelta.prepareAuth !== pageBBeforeSecondRefresh.prepareAuth
      || pageBSecondRefreshDelta.bind !== pageBBeforeSecondRefresh.bind
      || pageBSecondRefreshDelta.completeProfile !== pageBBeforeSecondRefresh.completeProfile
    ) throw new D508QualificationError("browser-capture", "browser_contract", "stale-custody-fence");

    stage = "resume-owner-profile";
    const pageC = await context.newPage();
    const tabC = await instrumentD508Tab(pageC, input.serverUrl);
    await awaitD508QualificationWork(pageC.goto(`${input.serverUrl}/claim#claim=${encodeURIComponent(input.replacementClaim)}&finish=product`, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageC.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
    if (
      await pageC.locator("#owner-claim-handle").count() !== 0
      || tabC.requests.some((request) => request.origin === "logto" && request.pathname === "/oidc/auth")
    ) throw new D508QualificationError("browser-capture", "browser_contract", "resume-owner-profile");
    await assertD508ProfileReservationUnchanged(replacementReservation);

    // The recovery page is a terminal tail, already proven separately. It is
    // traversed here only to finish this fresh two-tab/reissue vertical.
    stage = "owner-profile";
    await awaitD508QualificationWork(pageC.locator("#owner-claim-display-name").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageC.locator("#owner-claim-pin").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageC.locator("#owner-claim-pin-confirm").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageC.getByRole("button", { name: "Complete setup" }).click({ timeout: timing.browserStepMs }), signal);
    stage = "recovery-codes";
    await awaitD508QualificationWork(pageC.getByText("Save these recovery codes somewhere safe. They’re shown only once.", { exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);
    stage = "recovery-refresh";
    await awaitD508QualificationWork(pageC.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(pageC.getByText("Your server setup is confirmed, but this browser lost the recovery-code response.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
    stage = "recovery-acknowledgement";
    await awaitD508QualificationWork(pageC.getByRole("button", { name: "Open Nautilo", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "product-navigation";
    await awaitD508QualificationWork(pageC.waitForURL((url) => url.pathname === "/", { timeout: timing.browserStepMs }), signal);

    stage = "coordinator-trace";
    const pageATrace = assertRedactedCoordinatorTrace(tabA.trace);
    const pageBTrace = assertRedactedCoordinatorTrace(tabB.trace);
    const pageCTrace = assertRedactedCoordinatorTrace(tabC.trace);
    stage = "contract-validation";
    const twoTabReissueEvidence = assertD508TwoTabReissueContract({
      pageATrace,
      pageBTrace,
      pageCTrace,
      pageARequests: d508RequestCounter(tabA.requests),
      pageBRequests: d508RequestCounter(tabB.requests),
      pageCRequests: d508RequestCounter(tabC.requests),
      pageBReservationDelta,
      pageBRevokedRefreshDelta,
      pageBRevokedPreview404s,
      pageAOidcRequests: tabA.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      pageBOidcRequests: tabB.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      pageCOidcRequests: tabC.requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length,
      pageAReloadBindResponses: tabA.bindResponses.slice(pageABeforeReloadBindResponses),
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    });
    return {
      requests: [...tabA.requests, ...tabB.requests, ...tabC.requests],
      navigations: [...tabA.navigations, ...tabB.navigations, ...tabC.navigations],
      pageATrace,
      pageBTrace,
      pageCTrace,
      twoTabReissueEvidence,
      restartAfterBindEvidence,
    };
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

async function runBrowserQualification(
  input: {
    readonly serverUrl: string;
    readonly handle: string;
    readonly password: string;
    readonly pin: string;
    readonly claim: string;
    readonly finish: D508QualificationFinish;
  },
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
  signal?: AbortSignal,
): Promise<{
  readonly requests: RedactedRequestObservation[];
  readonly navigations: RedactedNavigationObservation[];
  readonly trace: RedactedCoordinatorEvent[];
  readonly refreshBeforeBindEvidence?: D508RefreshBeforeBindEvidence;
}> {
  let stage: D508BrowserStage = "claim-entry";
  const { chromium } = await import("playwright");
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const requests: RedactedRequestObservation[] = [];
    const navigations: RedactedNavigationObservation[] = [];
    const traceEvents: unknown[] = [];
    let callbackClaimTransitionCount = 0;
    let observeCallbackClaimTransition: (() => void) | undefined;
    const callbackClaimTransition = new Promise<void>((resolve) => { observeCallbackClaimTransition = resolve; });
    let expectingPostReload = false;
    let postReloadCommitCount = 0;
    let postReloadTraceEpochIndex: number | undefined;
    let postReloadRequestEpochIndex: number | undefined;
    let postReload = false;
    let observePostReloadCommit: (() => void) | undefined;
    const postReloadCommit = new Promise<void>((resolve) => { observePostReloadCommit = resolve; });
    let heldBindCount = 0;
    let preReloadBlockedBindCount = 0;
    let observeHeldBind: (() => void) | undefined;
    const heldBind = new Promise<void>((resolve) => { observeHeldBind = resolve; });
    let releaseHeldBind: (() => void) | undefined;
    const heldBindRelease = new Promise<void>((resolve) => { releaseHeldBind = resolve; });
    let observePreReloadBindBlocked: (() => void) | undefined;
    const preReloadBindBlocked = new Promise<void>((resolve) => { observePreReloadBindBlocked = resolve; });
    let observeResumedBindSuccess: (() => void) | undefined;
    const resumedBindSuccess = new Promise<void>((resolve) => { observeResumedBindSuccess = resolve; });
    let profileRefreshActive = false;
    let observeProfileRefreshBindSuccess: (() => void) | undefined;
    const profileRefreshBindSuccess = new Promise<void>((resolve) => { observeProfileRefreshBindSuccess = resolve; });
    const bindResponseClassifications: D508BindResponseClassification[] = [];
    let observeTerminalTrace: (() => void) | undefined;
    const terminalTrace = new Promise<void>((resolve) => { observeTerminalTrace = resolve; });
    let logtoOrigin: string | null = null;
    page.on("request", (request) => {
      // Request events arrive before their matching frame navigation. Learn
      // the local Logto origin from the documented OIDC authorization route
      // first, so that route is not incorrectly frozen as `other`.
      const observed = observeD508Request(request.url(), request.method(), input.serverUrl, logtoOrigin);
      logtoOrigin = observed.logtoOrigin;
      requests.push(observed.observation);
    });
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      const frameUrl = new URL(frame.url());
      if (
        expectingPostReload && !postReload
        && frameUrl.origin === new URL(input.serverUrl).origin
        && frameUrl.pathname === "/claim"
        && frameUrl.search === ""
        && frameUrl.hash === ""
      ) {
        // Playwright emits main-frame navigation at document commit, before
        // the newly committed document's scripts and React effects execute.
        // This is the only authority that permits post-reload forwarding.
        postReload = true;
        postReloadCommitCount += 1;
        postReloadTraceEpochIndex = traceEvents.length;
        postReloadRequestEpochIndex = requests.length;
        observePostReloadCommit?.();
      }
      const observed = redactNavigationObservation(frame.url(), input.serverUrl, logtoOrigin);
      if (observed.origin === "other" && frame.url().startsWith("http")) logtoOrigin = new URL(frame.url()).origin;
      navigations.push(redactNavigationObservation(frame.url(), input.serverUrl, logtoOrigin));
    });
    page.on("response", (response) => {
      const observation = redactRequestObservation(response.url(), response.request().method(), input.serverUrl, logtoOrigin);
      if (observation.method === "POST" && observation.origin === "server" && observation.pathname === "/api/bind-logto-user") {
        bindResponseClassifications.push(classifyD508BindResponseStatus(response.status()));
      }
    });
    await page.exposeFunction("__nautiloD508RecordCallbackClaimTransition", () => {
      callbackClaimTransitionCount += 1;
      observeCallbackClaimTransition?.();
    });
    await page.exposeFunction("__nautiloD508RecordOwnerClaimEvent", (event: unknown) => {
      traceEvents.push(event);
      if (postReload && isD508ResumedBindSuccess(event)) observeResumedBindSuccess?.();
      if (profileRefreshActive && isD508ResumedBindSuccess(event)) observeProfileRefreshBindSuccess?.();
      if (
        event && typeof event === "object" &&
        (event as Record<string, unknown>)["commandKind"] === (input.finish === "guide" ? "navigate-guide" : "navigate-product") &&
        (event as Record<string, unknown>)["result"] === "succeeded"
      ) observeTerminalTrace?.();
    });
    await page.addInitScript(() => {
      const target = globalThis as unknown as {
        __NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__?: (event: unknown) => void;
        __nautiloD508RecordOwnerClaimEvent?: (event: unknown) => Promise<void>;
      };
      // D508's Workbench seam calls this only when it exists. The production
      // coordinator has no ambient browser/test dependency when it is absent.
      // This function forwards each navigation's five-field event into Node;
      // it never stores a document-local array that a redirect/reload erases.
      target.__NAUTILO_D508_OWNER_CLAIM_EVENT_SINK__ = (event) => {
        void target.__nautiloD508RecordOwnerClaimEvent?.(event);
      };
    });
    await page.addInitScript(({ serverOrigin }) => {
      type BrowserHistoryMutation = (data: unknown, unused: string, url?: unknown) => unknown;
      const browser = globalThis as unknown as {
        location: { origin: string; pathname: string };
        history: { replaceState: BrowserHistoryMutation; pushState: BrowserHistoryMutation };
        __nautiloD508RecordCallbackClaimTransition?: () => Promise<void>;
      };
      // Qualification-only browser behavior. It observes neither the claim
      // fragment nor any handoff/session value. It only observes the exact
      // same-origin callback history transition; main-frame commit owns the
      // later reload epoch boundary.
      if (browser.location.origin !== serverOrigin || browser.location.pathname !== "/auth/callback") return;
      let fired = false;
      const intercept = (native: BrowserHistoryMutation) => (data: unknown, unused: string, url?: unknown) => {
        const targetUrl = typeof url === "string" ? url : url instanceof URL ? url.toString() : null;
        let exactClaimTarget = false;
        if (targetUrl !== null) {
          try {
            const parsed = new URL(targetUrl, serverOrigin);
            exactClaimTarget = parsed.origin === serverOrigin && parsed.pathname === "/claim" && parsed.search === "" && parsed.hash === "";
          } catch { /* ordinary history mutation */ }
        }
        if (!fired && exactClaimTarget) {
          fired = true;
          void browser.__nautiloD508RecordCallbackClaimTransition?.();
        }
        return native.call(browser.history, data, unused, url);
      };
      browser.history.replaceState = intercept(browser.history.replaceState);
      browser.history.pushState = intercept(browser.history.pushState);
    }, { serverOrigin: new URL(input.serverUrl).origin });
    if (input.finish === "product") {
      // Before the main-frame-committed reload, no bind/reobserve request may
      // reach Fastify. The callback document's first bind is held so the
      // parent can prove that boundary before explicitly reloading.
      await page.route("**/api/bind-logto-user", async (route) => {
        if (!postReload && heldBindCount === 0) {
          heldBindCount = 1;
          observeHeldBind?.();
          await heldBindRelease;
          preReloadBlockedBindCount += 1;
          try { await route.abort("blockedbyclient"); } catch { /* reload may have already cancelled it */ }
          finally { observePreReloadBindBlocked?.(); }
          return;
        }
        if (!postReload) {
          preReloadBlockedBindCount += 1;
          try { await route.abort("blockedbyclient"); } catch { /* stale pre-reload request */ }
          finally { observePreReloadBindBlocked?.(); }
          return;
        }
        await route.continue();
      });
    }
    // The capability is fragment-only. Browser request observations deliberately never retain it.
    stage = "claim-entry";
    await awaitD508QualificationWork(page.goto(`${input.serverUrl}/claim#claim=${encodeURIComponent(input.claim)}&finish=${input.finish}`, { waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
    stage = "owner-handle";
    await awaitD508QualificationWork(page.locator("#owner-claim-handle").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Continue" }).click({ timeout: timing.browserStepMs }), signal);
    // Pinned Logto 1.38.0 contract, grounded in the shipped image sources:
    // IdentifierRegisterForm uses input[name=identifier] + Create account.
    // Because Nautilo enables forgot-password, SetPassword selects its Lite
    // branch: input[name=newPassword] + Save password, with no confirmation
    // field. Do not add selector fallbacks; a Logto pin change must update and
    // requalify this exact contract.
    stage = "hosted-identifier";
    await awaitD508QualificationWork(page.locator('input[name="identifier"]').fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Create account", exact: true }).click({ timeout: timing.browserStepMs }), signal);
    stage = "hosted-password";
    await awaitD508QualificationWork(page.locator('input[name="newPassword"]').fill(input.password, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Save password", exact: true }).click({ timeout: timing.browserStepMs }), signal);

    let refreshBeforeBindEvidence: D508RefreshBeforeBindEvidence | undefined;
    let expectedBindRequestCount = 1;
    if (input.finish === "product") {
      stage = "refresh-before-bind";
      stage = "callback-claim-transition";
      await awaitD508BrowserLatch(callbackClaimTransition, "callback-claim-transition", timing.browserStepMs, signal);
      if (callbackClaimTransitionCount !== 1) throw new D508QualificationError("browser-capture", "browser_contract", "callback-claim-transition");
      stage = "held-bind-before-release";
      await awaitD508BrowserLatch(heldBind, "held-bind-before-release", timing.browserStepMs, signal);
      await assertD508ClaimUnboundBeforeRefresh();
      stage = "pre-reload-bind-blocked";
      // Start the real reload before releasing the old document's held
      // request. Until the next frame commit, every bind/reobserve stays in
      // the pre-reload abort policy and cannot reach Fastify.
      expectingPostReload = true;
      const reload = page.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs });
      releaseHeldBind?.();
      await awaitD508BrowserLatch(preReloadBindBlocked, "pre-reload-bind-blocked", timing.browserStepMs, signal);
      stage = "post-reload-bootstrap";
      await awaitD508QualificationWork(reload, signal);
      await awaitD508BrowserLatch(postReloadCommit, "post-reload-bootstrap", timing.browserStepMs, signal);
      assertD508PostReloadCommitCount(postReloadCommitCount);
      if (postReloadTraceEpochIndex === undefined) throw new D508QualificationError("browser-capture", "browser_contract", "post-reload-bootstrap");
      const postReloadEpoch = postReloadTraceEpochIndex;
      stage = "resumed-bind-evidence";
      await awaitD508BrowserLatch(resumedBindSuccess, "resumed-bind-evidence", timing.browserStepMs, signal);
      expectedBindRequestCount = assertD508BindResponseClassifications(bindResponseClassifications);
      const profileReservation = await readD508ProfileReservation();
      stage = "post-reload-profile-visible";
      await awaitD508QualificationWork(page.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
      const beforeProfileRefresh = d508RequestCounter(requests);
      const beforeProfileRefreshTraceLength = traceEvents.length;
      const beforeProfileRefreshBindResponseLength = bindResponseClassifications.length;
      const beforeProfileRefreshOidc = requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length;
      profileRefreshActive = true;
      stage = "refresh-after-bind-validation";
      await awaitD508QualificationWork(page.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(page.waitForURL((url) => url.pathname === "/claim", { timeout: timing.browserStepMs }), signal);
      await awaitD508BrowserLatch(profileRefreshBindSuccess, "refresh-after-bind-validation", timing.browserStepMs, signal);
      await awaitD508QualificationWork(page.locator("#owner-claim-display-name").waitFor({ timeout: timing.browserStepMs }), signal);
      profileRefreshActive = false;
      const profileRefreshBindResponses = bindResponseClassifications.slice(beforeProfileRefreshBindResponseLength);
      assertD508ProfileBindValidation({
        requestDelta: {
          preview: d508RequestCounter(requests).preview - beforeProfileRefresh.preview,
          prepareAuth: d508RequestCounter(requests).prepareAuth - beforeProfileRefresh.prepareAuth,
          bind: d508RequestCounter(requests).bind - beforeProfileRefresh.bind,
          completeProfile: d508RequestCounter(requests).completeProfile - beforeProfileRefresh.completeProfile,
        },
        trace: assertRedactedCoordinatorTrace(traceEvents.slice(beforeProfileRefreshTraceLength)),
        oidcDelta: requests.filter((request) => request.origin === "logto" && request.pathname === "/oidc/auth").length - beforeProfileRefreshOidc,
        bindResponses: profileRefreshBindResponses,
      });
      expectedBindRequestCount += profileRefreshBindResponses.length;
      await assertD508ProfileReservationUnchanged(profileReservation);
      refreshBeforeBindEvidence = {
        refreshBeforeBind: {
          callbackTransitionObserved: true,
          postReloadBootObserved: true,
          claimUnboundBeforeHeldBindBlock: true,
          heldBindBlockedBeforeReload: true,
          preReloadBlockedBindCount,
          postReloadTraceEpochIndex: postReloadEpoch,
          responseClassifications: bindResponseClassifications,
        },
        refreshAfterBindValidation: {
          claimReservationUnchanged: true,
          signedInProfileBindValidated: true,
          responseClassifications: profileRefreshBindResponses,
        },
      };
    }

    stage = "owner-profile";
    await awaitD508QualificationWork(page.locator("#owner-claim-display-name").fill(input.handle, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.locator("#owner-claim-pin-confirm").fill(input.pin, { timeout: timing.browserStepMs }), signal);
    await awaitD508QualificationWork(page.getByRole("button", { name: "Complete setup" }).click({ timeout: timing.browserStepMs }), signal);
    stage = "recovery-codes";
    await awaitD508QualificationWork(page.getByText("Save these recovery codes somewhere safe. They’re shown only once.", { exact: true }).waitFor({ timeout: timing.browserStepMs }), signal);

    if (input.finish === "guide") {
      stage = "recovery-acknowledgement";
      await awaitD508QualificationWork(page.getByRole("button", { name: "Open server guide", exact: true }).click({ timeout: timing.browserStepMs }), signal);
      stage = "guide-navigation";
      await awaitD508QualificationWork(page.waitForURL(/\/help\/server/, { timeout: timing.browserStepMs }), signal);
      stage = "guide-refresh";
      await awaitD508QualificationWork(page.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(page.waitForURL(/\/help\/server/, { timeout: timing.browserStepMs }), signal);
    } else {
      // The terminal marker is intentionally session-scoped and redacted. A
      // hard reload must truthfully report that codes cannot be recovered,
      // rather than recreating the old claim flow or exposing them again.
      stage = "recovery-refresh";
      await awaitD508QualificationWork(page.reload({ waitUntil: "domcontentloaded", timeout: timing.browserStepMs }), signal);
      await awaitD508QualificationWork(page.waitForURL(/\/claim$/, { timeout: timing.browserStepMs }), signal);
      stage = "recovery-terminal";
      await awaitD508QualificationWork(page.getByText("Your server setup is confirmed, but this browser lost the recovery-code response.", { exact: false }).waitFor({ timeout: timing.browserStepMs }), signal);
      if (await page.locator("pre").count() !== 0) throw new D508QualificationError("browser-capture", "browser_contract");
      const security = page.getByRole("link", { name: "Security settings", exact: true });
      if (await security.count() !== 1 || await security.getAttribute("href") !== "/settings#security") {
        throw new D508QualificationError("browser-capture", "browser_contract");
      }
      stage = "recovery-acknowledgement";
      await awaitD508QualificationWork(page.getByRole("button", { name: "Open Nautilo", exact: true }).click({ timeout: timing.browserStepMs }), signal);
      stage = "product-navigation";
      await awaitD508QualificationWork(page.waitForURL((url) => url.pathname === "/", { timeout: timing.browserStepMs }), signal);
    }
    stage = "coordinator-trace";
    await awaitD508QualificationWork(new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new D508QualificationError("browser-capture", "browser_trace")), timing.traceDeliveryMs);
      void terminalTrace.then(() => { clearTimeout(timeout); resolve(); });
    }), signal);
    const trace = assertRedactedCoordinatorTrace(traceEvents);
    stage = "contract-validation";
    if (requests.some((entry) => entry.pathname.includes(input.claim)) || navigations.some((entry) => entry.pathname.includes(input.claim))) throw new D508QualificationError("browser-capture", "browser_contract");
    if (input.finish === "guide") assertFreshGuideContract({ requests, navigations, trace });
    else {
      if (postReloadTraceEpochIndex === undefined || postReloadRequestEpochIndex === undefined) throw new D508QualificationError("browser-capture", "browser_contract");
      assertD508PreReloadBindInterruption({
        trace: trace.slice(0, postReloadTraceEpochIndex),
        blockedRoutes: preReloadBlockedBindCount,
      });
      assertD508PostReloadOwnerContract({
        trace: trace.slice(postReloadTraceEpochIndex),
        requests: requests.slice(postReloadRequestEpochIndex),
        navigations,
      }, expectedBindRequestCount);
    }
    return {
      requests,
      navigations,
      trace,
      ...(refreshBeforeBindEvidence === undefined ? {} : { refreshBeforeBindEvidence }),
    };
  } catch (error) {
    throw withBrowserStage(error, stage);
  } finally {
    try { await browser.close(); } catch { /* browser already terminated */ }
  }
}

async function assertDbTerminalInvariants(): Promise<void> {
  try {
    const db = getSharedDirectDb();
    // This is intentionally stronger than setup-status. A blank server has a
    // seed user; only this complete join identifies a real finished owner.
    const ownerRows = await db
      .select({ id: users.id, externalId: users.externalId })
      .from(users)
      .innerJoin(credentials, and(eq(credentials.userId, users.id), eq(credentials.type, "pin")))
      .innerJoin(profiles, eq(profiles.userId, users.id))
      .innerJoin(groupMembers, eq(groupMembers.userId, users.id))
      .innerJoin(groups, and(eq(groups.id, groupMembers.groupId), eq(groups.type, "owners")))
      .where(isNull(users.server));
    if (ownerRows.length !== 1) throw new Error("owner cardinality");
    const owner = ownerRows[0];
    // `users.externalId` is the canonical Logto OIDC `sub` link (see
    // packages/db/src/schema/users.ts and the bind-logto-user contract in
    // invites.ts). channel_identities models transports, not this identity.
    if (!owner || typeof owner.externalId !== "string" || owner.externalId.length === 0) throw new Error("owner identity");
    const externalId = owner.externalId;
    const identityRows = await db.select({ id: users.id }).from(users).where(eq(users.externalId, externalId));
    if (identityRows.length !== 1 || identityRows[0]?.id !== owner.id) throw new Error("identity cardinality");
    const claimRows = await db
      .select({ maxUses: invites.maxUses, usedCount: invites.usedCount, revokedAt: invites.revokedAt, expiresAt: invites.expiresAt, redemptionUserId: inviteRedemptions.userId, completedAt: inviteRedemptions.completedAt })
      .from(invites)
      .leftJoin(inviteRedemptions, eq(inviteRedemptions.inviteId, invites.id))
      .where(eq(invites.kind, "claim"));
    const consumedForOwner = claimRows.filter((row) => row.maxUses === 1 && row.usedCount === 1 && row.revokedAt === null && row.completedAt !== null && row.redemptionUserId === owner.id);
    const liveUnredeemed = claimRows.filter((row) => row.usedCount === 0 && row.revokedAt === null && (row.expiresAt === null || row.expiresAt > new Date()));
    if (consumedForOwner.length !== 1 || liveUnredeemed.length !== 0) throw new Error("claim terminal state");
  } catch { throw new D508QualificationError("db-invariants", "db_invariant"); }
}

export type D508WorkbenchBuildChild = Readonly<{ exited: Promise<number> }>;

/**
 * This qualification exercises source-dependent browser behavior. Always ask
 * Turbo for the exact current Workbench build before infra creation; Turbo's
 * own content-addressed cache may satisfy it, but qualifier code never trusts
 * a wall-clock dist freshness heuristic.
 */
export async function buildD508CurrentWorkbench(
  spawn: (argv: readonly string[], options: Readonly<{ cwd: string; stdout: "ignore"; stderr: "ignore" }>) => D508WorkbenchBuildChild = (argv, options) => Bun.spawn([...argv], options),
): Promise<void> {
  try {
    const child = spawn(["bunx", "turbo", "run", "build", "--filter=@nautilo/workbench"], {
      cwd: NAUTILO_REPO_ROOT, stdout: "ignore", stderr: "ignore",
    });
    if (await child.exited !== 0) throw new Error("workbench build failed");
  } catch {
    throw new D508QualificationError("workbench-build", "workbench_build");
  }
}

async function worker(
  runId: string,
  scenario: D508QualificationScenario,
  timing: D508QualificationTimingPolicy = DEFAULT_D508_QUALIFICATION_TIMING,
  signal?: AbortSignal,
): Promise<number> {
  try {
    // Each scenario is a separate fresh stack, so a completed owner from one
    // proof can never mask an ambiguity in another.
    const finish: D508QualificationFinish = scenario === "fresh-browser-admin" ? "guide" : "product";
    const credentials = generatedCredentials(runId);
    await buildD508CurrentWorkbench();
    const stackCode = await devStackCmd(["--instance", runId, "--json"], {
      suppressBootstrapClaimInvite: true,
      returnWhenReady: true,
      healthTimeoutMs: timing.stackReadyMs,
    });
    if (stackCode !== 0) throw new D508QualificationError("stack-start", "stack_start");
    assertNoBootstrapClaimArtifacts(runId);
    let state: ReturnType<typeof instanceState>;
    try { state = instanceState(runId); } catch { throw new D508QualificationError("stack-start", "stack_start"); }
    await installLoopbackClaim(state.serverUrl, credentials.claim, timing);
    if (scenario === "lost-responses") {
      const browser = await runD508LostResponsesQualification({ serverUrl: state.serverUrl, ...credentials }, timing, signal);
      await assertDbTerminalInvariants();
      process.stdout.write(`${JSON.stringify({
        runId, finish, passedCases: ["lost-bind", "lost-complete"],
        notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => value !== "lost-bind" && value !== "lost-complete"),
        completedPhases: ["stack-start", "controller-install", "browser-capture", "lost-bind-response", "lost-completion-response", "lost-response-terminal", "product-navigation", "db-invariants"],
        requests: browser.requests, navigations: browser.navigations, lostResponsesTrace: browser.trace, lostResponsesEvidence: browser.evidence,
      })}\n`);
      return 0;
    }
    if (scenario === "expiry-replay") {
      await expireD508InstalledClaim(credentials.claim);
      const expired = await runD508RejectedClaimQualification({
        serverUrl: state.serverUrl,
        claim: credentials.claim,
        reason: "expired",
      }, timing, signal);
      const replacementClaim = createCanonicalOwnerClaimCapability();
      await installLoopbackClaim(state.serverUrl, replacementClaim, timing);
      const completed = await runBrowserQualification({
        serverUrl: state.serverUrl,
        handle: credentials.handle,
        password: credentials.password,
        pin: credentials.pin,
        claim: replacementClaim,
        finish,
      }, timing, signal);
      await assertDbTerminalInvariants();
      const replay = await runD508RejectedClaimQualification({
        serverUrl: state.serverUrl,
        claim: replacementClaim,
        reason: "used_up",
      }, timing, signal);
      await assertDbTerminalInvariants();
      const passedCases = ["expired-claim", "replay"] as const;
      process.stdout.write(`${JSON.stringify({
        runId, finish, passedCases,
        notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => !passedCases.includes(value as typeof passedCases[number])),
        completedPhases: ["stack-start", "controller-install", "expired-claim-response", "expired-claim-recovery", "controller-reissue", "browser-capture", "product-navigation", "replay-response", "replay-recovery", "db-invariants"],
        expiredClaim: { requests: expired.requests, navigations: expired.navigations, trace: expired.trace, evidence: expired.evidence },
        completedOwner: { requests: completed.requests, navigations: completed.navigations, trace: completed.trace },
        replayedClaim: { requests: replay.requests, navigations: replay.navigations, trace: replay.trace, evidence: replay.evidence },
      })}\n`);
      return 0;
    }
    if (scenario === "signed-out-wrong-account") {
      const wrongSuffix = randomBytes(8).toString("hex");
      const browser = await runD508SignedOutWrongAccountQualification({
        serverUrl: state.serverUrl,
        ...credentials,
        wrongHandle: `d508_wrong_${wrongSuffix}`,
        wrongPassword: `D508-${randomBytes(18).toString("base64url")}`,
      }, timing, signal);
      await assertDbTerminalInvariants();
      process.stdout.write(`${JSON.stringify({
        runId, finish, passedCases: ["signed-out-profile", "wrong-subject"],
        notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => value !== "signed-out-profile" && value !== "wrong-subject"),
        completedPhases: ["stack-start", "controller-install", "browser-capture", "wrong-account-provision", "signed-out-profile", "wrong-account-hosted-login-entry", "wrong-account-hosted-login-submit", "wrong-account-bind-response", "wrong-account-recovery-ui", "original-owner-retry-action", "account-switch-signout-started", "account-switch-navigation-away", "account-switch-return", "original-owner-hosted-login-entry", "original-owner-hosted-login-submit", "original-owner-bind-response", "original-owner-profile-visible", "original-owner-handle-absence", "original-owner-profile-submit", "original-owner-recovery-codes", "original-owner-product-navigation", "db-invariants"],
        requests: browser.requests, navigations: browser.navigations,
        ownerTrace: browser.ownerTrace, wrongProvisionTrace: browser.wrongProvisionTrace,
        signedOutWrongAccountEvidence: browser.evidence,
      })}\n`);
      return 0;
    }
    if (scenario === "browser-back") {
      const browser = await runD508BrowserBackQualification({ serverUrl: state.serverUrl, ...credentials }, timing, signal);
      await assertDbTerminalInvariants();
      process.stdout.write(`${JSON.stringify({
        runId, finish, passedCases: ["callback-error-back"],
        notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => value !== "callback-error-back"),
        completedPhases: ["stack-start", "controller-install", "browser-capture", "hosted-browser-back", "browser-back-return", "browser-back-resume", "owner-profile", "product-navigation", "db-invariants"],
        requests: browser.requests, navigations: browser.navigations, ownerTrace: browser.trace,
        browserBackEvidence: browser.evidence,
      })}\n`);
      return 0;
    }
    if (scenario === "fresh-browser-admin") {
      const completedOwner = await runBrowserQualification({
        serverUrl: state.serverUrl,
        handle: credentials.handle,
        password: credentials.password,
        pin: credentials.pin,
        claim: credentials.claim,
        finish,
      }, timing, signal);
      await assertDbTerminalInvariants();
      const freshBrowser = await runD508FreshBrowserAdminQualification({
        serverUrl: state.serverUrl,
        handle: credentials.handle,
        password: credentials.password,
        pin: credentials.pin,
      }, timing, signal);
      await assertDbTerminalInvariants();
      const passedCases = ["fresh-browser-return", "pin-gated-action"] as const;
      process.stdout.write(`${JSON.stringify({
        runId, finish, passedCases,
        notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => !passedCases.includes(value as typeof passedCases[number])),
        completedPhases: ["stack-start", "controller-install", "browser-capture", "owner-profile", "guide-navigation", "fresh-browser-signed-out", "fresh-browser-hosted-login", "fresh-browser-exact-return", "fresh-browser-guide-action", "fresh-browser-admin-route", "fresh-browser-security-section", "fresh-browser-posture-button", "fresh-browser-posture-view", "fresh-browser-posture-edit", "fresh-browser-posture-controls", "fresh-browser-posture-selection", "pin-gated-posture", "pin-gated-posture-response", "pin-gated-posture-refresh", "db-invariants"],
        ownerCompletion: { requests: completedOwner.requests, navigations: completedOwner.navigations, trace: completedOwner.trace },
        freshBrowser: { requests: freshBrowser.requests, navigations: freshBrowser.navigations, evidence: freshBrowser.evidence },
      })}\n`);
      return 0;
    }
    const browser = await runD508TwoTabReissueQualification({ runId, serverUrl: state.serverUrl, ...credentials, replacementClaim: createCanonicalOwnerClaimCapability() }, timing, signal);
    await assertDbTerminalInvariants();
    // The receipt is deliberately redacted: route paths and typed trace only.
    const passedCases = ["two-tabs", "restart-after-bind", "tab-loss-reissue"] as const;
    process.stdout.write(`${JSON.stringify({
      runId,
      finish,
      passedCases,
      // A successful future receipt must not claim its own passed vertical is
      // still unrun. The static matrix above remains conservative until that
      // receipt exists and is recorded by the operator.
      notRunCases: D508_NOT_RUN_MATRIX_CASES.filter((value) => !passedCases.includes(value as typeof passedCases[number])),
      completedPhases: ["stack-start", "controller-install", "browser-capture", "two-tab-entry", "two-tab-reservation", "server-restart-after-bind", "post-restart-profile-visible", "tab-loss-recovery", "controller-reissue", "stale-custody-fence", "resume-owner-profile", "owner-profile", "recovery-refresh", "product-navigation", "db-invariants"],
      requests: browser.requests,
      navigations: browser.navigations,
      pageATrace: browser.pageATrace,
      pageBTrace: browser.pageBTrace,
      pageCTrace: browser.pageCTrace,
      twoTabReissueEvidence: browser.twoTabReissueEvidence,
      restartAfterBindEvidence: browser.restartAfterBindEvidence,
    })}\n`);
    return 0;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({
      runId,
      attemptedCases: scenario === "lost-responses"
        ? ["lost-bind", "lost-complete"]
        : scenario === "expiry-replay"
          ? ["expired-claim", "replay"]
        : scenario === "signed-out-wrong-account"
          ? ["signed-out-profile", "wrong-subject"]
          : scenario === "browser-back"
            ? ["callback-error-back"]
            : scenario === "fresh-browser-admin"
              ? ["fresh-browser-return", "pin-gated-action"]
          : ["two-tabs", "restart-after-bind", "tab-loss-reissue"],
      ...redactedD508FailureReceipt(error),
    })}\n`);
    throw error;
  }
}

export async function qualifyOwnerClaimCmd(argv: readonly string[]): Promise<number> {
  let parsed: D508QualificationArgs;
  try { parsed = parseD508QualificationArgs(argv); } catch (error) { console.error(error instanceof Error ? error.message : "Invalid D508 qualification arguments"); return 2; }
  if (process.env[OPT_IN_ENV] !== "1") { console.error(`Set ${OPT_IN_ENV}=1 to authorize one disposable local D508 qualification stack.`); return 2; }
  if (parsed.worker && !allowsD508QualificationWorker(process.env)) { console.error("D508 qualification worker is parent-only."); return 2; }
  if (parsed.worker) {
    const workerAbort = new AbortController();
    const abortWorker = () => workerAbort.abort();
    process.once("SIGINT", abortWorker);
    process.once("SIGTERM", abortWorker);
    try {
      return await worker(parsed.runId, parsed.scenario, DEFAULT_D508_QUALIFICATION_TIMING, workerAbort.signal);
    } finally {
      process.off("SIGINT", abortWorker);
      process.off("SIGTERM", abortWorker);
    }
  }
  await preflightD508BrowserRuntime();
  const timing = DEFAULT_D508_QUALIFICATION_TIMING;
  const selectedScenarios: readonly D508QualificationScenario[] = parsed.scenario === undefined
    ? D508_QUALIFICATION_SCENARIOS
    : [parsed.scenario];
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let receivedSignal: NodeJS.Signals | undefined;
  const onSignal = (signal: NodeJS.Signals) => {
    if (receivedSignal !== undefined) return;
    receivedSignal = signal;
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), timing.childTerminationGraceMs).unref();
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const scenario of selectedScenarios) {
      const runId = createD508QualificationRunId();
      let state: { readonly ports: number[]; readonly composeProject: string } = defaultD508CleanupState(runId);
      let timeout = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      let code = 1;
      let cleanupFailed = false;
      try {
        child = Bun.spawn(["bun", "src/index.ts", "qualify-owner-claim", "--worker", "--run-id", runId, "--scenario", scenario], { cwd: import.meta.dir.replace(/\/src\/commands$/, ""), stdin: "inherit", stdout: "inherit", stderr: "inherit", env: { ...process.env, [WORKER_ENV]: "1", NAUTILO_INSTANCE_ID: runId } });
        timer = setTimeout(() => { timeout = true; onSignal("SIGTERM"); }, timing.parentRunMs);
        code = await child.exited;
        if (timeout) code = 124;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Each scenario receives its own authoritative cleanup before the
        // next fresh worker starts; no completed owner can contaminate it.
        try { state = instanceState(runId); } catch { /* deterministic fallback below */ }
        const root = resolveNautiloStorageRoot(homedir(), runId);
        const cleanupCode = existsSync(root)
          ? await deleteInstance({ id: runId, yes: true })
          : teardownGeneratedProjectFallback(state.composeProject) ? 0 : 1;
        if (cleanupCode !== 0) cleanupFailed = true;
        try { assertNoOwnedResources(runId, state); } catch { cleanupFailed = true; }
      }
      if (cleanupFailed) throw new D508QualificationError("teardown", "teardown");
      process.stdout.write(`${JSON.stringify({ runId, scenario, workerExitCode: code, teardown: "verified", teardownPhase: "teardown" })}\n`);
      if (timeout) throw new D508QualificationError("preflight", "parent_timeout");
      if (receivedSignal !== undefined) process.kill(process.pid, receivedSignal);
      if (code !== 0) return code;
      child = undefined;
    }
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
  return 0;
}
