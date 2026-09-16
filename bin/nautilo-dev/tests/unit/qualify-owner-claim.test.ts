import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  DEFAULT_D508_QUALIFICATION_TIMING,
  D508QualificationError,
  D508_DISPOSABLE_INSTANCE_ID_RE,
  D508_QUALIFIED_LOGTO_IMAGE,
  D508_BROWSER_STAGES,
  D508_NOT_RUN_MATRIX_CASES,
  awaitD508QualificationWork,
  awaitD508BrowserLatch,
  awaitD508ExactBind409Response,
  awaitD508ExactBindSuccessResponse,
  awaitD508PostLogoutReturn,
  awaitD508SignOutTraceStarted,
  buildD508CurrentWorkbench,
  assertRedactedCoordinatorTrace,
  assertD508BindResponseClassifications,
  assertD508PreReloadBindInterruption,
  assertD508PostReloadCommitCount,
  classifyD508BindResponseStatus,
  isD508ResumedBindSuccess,
  assertFreshGuideContract,
  assertD508PostReloadOwnerContract,
  assertD508ProfileBindValidation,
  assertD508PassiveProfileCheckpointRequestDelta,
  assertD508RestartAfterBindContract,
  assertD508SelectedServerIdentity,
  assertD508TwoTabReissueContract as assertD508TwoTabReissueContractBase,
  assertD508ControllerInstallResponse,
  assertD508CommittedResponseAbortOrder,
  assertD508LostResponsesContract,
  assertD508SignedOutWrongAccountContract,
  assertD508RejectedClaimContract,
  assertD508BrowserBackContract,
  assertD508FreshBrowserAdminContract,
  assertD508SeedBindFailureResponse,
  D508_SEED_BIND_FAILURE_RESPONSE,
  assertD508OneLiveUnboundClaim,
  selectD508LiveProfileReservation,
  assertHeldBindProductRecoveryRefreshContract,
  assertProductRecoveryRefreshContract,
  allowsD508QualificationWorker,
  createCanonicalOwnerClaimCapability,
  createD508QualificationRunId,
  defaultD508CleanupState,
  parseD508QualificationArgs,
  preflightD508BrowserRuntime,
  observeD508Request,
  redactedD508FailureReceipt,
  redactNavigationObservation,
  redactRequestObservation,
  isD508CallbackClaimTarget,
  sameD508ContainerRuntime,
  terminateD508RestartChild,
  validateD508QualificationTiming,
} from "../../src/commands/qualify-owner-claim";
import { shouldMintBootstrapClaimInvite } from "../../src/commands/infra-start";

describe("D508 disposable owner-claim qualification command", () => {
  test("generates only bounded disposable named-instance ids", () => {
    const runId = createD508QualificationRunId(Buffer.from("123456", "utf8"));
    expect(runId).toBe("d508313233343536");
    expect(D508_DISPOSABLE_INSTANCE_ID_RE.test(runId)).toBeTrue();
    // The public CLI's INSTANCE_ID_RE accepts this exact 16-character form.
    expect(runId).toMatch(/^[a-z0-9-]{0,16}$/);
    expect(() => createD508QualificationRunId(Buffer.alloc(5))).toThrow("exactly 6 random bytes");
    expect(() => createD508QualificationRunId(Buffer.alloc(7))).toThrow("exactly 6 random bytes");
  });

  test("uses the exact server owner-claim capability shape", () => {
    const claim = createCanonicalOwnerClaimCapability(Buffer.alloc(24, 0));
    expect(claim).toBe(`inv_${"A".repeat(32)}`);
    expect(claim).toMatch(/^inv_[A-Za-z0-9_-]{32}$/);
    expect(() => createCanonicalOwnerClaimCapability(Buffer.alloc(32))).toThrow();
  });

  test("accepts only the parent form or exact internal worker form", () => {
    expect(parseD508QualificationArgs([])).toEqual({ worker: false });
    expect(parseD508QualificationArgs(["--scenario", "lost-responses"])).toEqual({ worker: false, scenario: "lost-responses" });
    expect(parseD508QualificationArgs(["--scenario", "signed-out-wrong-account"])).toEqual({ worker: false, scenario: "signed-out-wrong-account" });
    expect(parseD508QualificationArgs(["--scenario", "expiry-replay"])).toEqual({ worker: false, scenario: "expiry-replay" });
    expect(parseD508QualificationArgs(["--scenario", "browser-back"])).toEqual({ worker: false, scenario: "browser-back" });
    expect(parseD508QualificationArgs(["--scenario", "fresh-browser-admin"])).toEqual({ worker: false, scenario: "fresh-browser-admin" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "two-tab-reissue"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "two-tab-reissue" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "lost-responses"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "lost-responses" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "signed-out-wrong-account"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "signed-out-wrong-account" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "expiry-replay"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "expiry-replay" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "browser-back"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "browser-back" });
    expect(parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "fresh-browser-admin"])).toEqual({ worker: true, runId: "d508012345abcdef", scenario: "fresh-browser-admin" });
    expect(() => parseD508QualificationArgs(["--instance", "default"])).toThrow(D508QualificationError);
    expect(() => parseD508QualificationArgs(["--worker", "--run-id", "default", "--scenario", "lost-responses"])).toThrow(D508QualificationError);
    expect(() => parseD508QualificationArgs(["--worker", "--run-id", "d508012345abcdef", "--scenario", "anything-else"])).toThrow(D508QualificationError);
    expect(() => parseD508QualificationArgs(["--worker", "--run-id", "d508-claim-012345abcdef", "--scenario", "lost-responses"])).toThrow(D508QualificationError);
    expect(() => parseD508QualificationArgs(["--scenario", "lost-responses", "--worker"])).toThrow(D508QualificationError);
    expect(allowsD508QualificationWorker({ NAUTILO_D508_DISPOSABLE_QUALIFICATION: "1" })).toBeFalse();
    expect(allowsD508QualificationWorker({ NAUTILO_D508_DISPOSABLE_QUALIFICATION: "1", NAUTILO_D508_QUALIFICATION_WORKER: "1" })).toBeTrue();
  });

  test("requires an exact fresh-browser guide return and one real PIN-gated posture change", () => {
    const valid = {
      startedSignedOut: true,
      returnedToExactGuide: true,
      authReturnConsumed: true,
      ownerIo: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      oidcAuthorizations: 1,
      reachedConfigureServer: true,
      initialPosture: { deploymentMode: "server", securityLevel: "paranoid" },
      posturePutCount: 1,
      postureResponse: { status: 200, changed: true, deploymentMode: "server", securityLevel: "cautious" },
      refreshedPostureVisible: true,
    } as const;
    expect(assertD508FreshBrowserAdminContract(valid)).toEqual({
      freshBrowserStartedSignedOut: true,
      exactServerGuideReturn: true,
      authReturnConsumed: true,
      noOwnerClaimIo: true,
      oneOidcAuthorization: true,
      configureServerLinkReachedAdmin: true,
      pinGatedPostureChangedOnce: true,
      refreshedPostureVisible: true,
    });
    expect(() => assertD508FreshBrowserAdminContract({ ...valid, returnedToExactGuide: false })).toThrow(D508QualificationError);
    expect(() => assertD508FreshBrowserAdminContract({ ...valid, ownerIo: { ...valid.ownerIo, preview: 1 } })).toThrow(D508QualificationError);
    expect(() => assertD508FreshBrowserAdminContract({ ...valid, posturePutCount: 2 })).toThrow(D508QualificationError);
    expect(() => assertD508FreshBrowserAdminContract({ ...valid, postureResponse: { ...valid.postureResponse, changed: false } })).toThrow(D508QualificationError);
  });

  test("requires server-authoritative expiry/replay rejection and no refresh replay", () => {
    const zero = { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 } as const;
    const onePreview = { ...zero, preview: 1 } as const;
    const trace = [
      { operationId: 1, phase: "previewing", commandKind: "preview-claim", result: "started", navigationIntent: null },
      { operationId: 1, phase: "previewing", commandKind: "preview-claim", result: "failed", navigationIntent: null },
    ] as const;
    for (const reason of ["expired", "used_up"] as const) {
      expect(assertD508RejectedClaimContract({
        reason,
        responseStatus: 410,
        responseReason: reason,
        requestsBeforeRefresh: onePreview,
        requestsAfterRefresh: onePreview,
        oidcRequests: 0,
        trace,
        custody: { session: false, local: false },
        recoveryVisible: true,
      }, reason === "expired" ? "expired-claim-recovery" : "replay-recovery")).toEqual({
        serverReason: reason,
        exactPreview410: true,
        recoveryVisible: true,
        custodyCleared: true,
        refreshIssuedNoOwnerIo: true,
      });
    }
    expect(() => assertD508RejectedClaimContract({
      reason: "expired",
      responseStatus: 410,
      responseReason: "expired",
      requestsBeforeRefresh: onePreview,
      requestsAfterRefresh: { ...onePreview, preview: 2 },
      oidcRequests: 0,
      trace,
      custody: { session: false, local: false },
      recoveryVisible: true,
    }, "expired-claim-recovery")).toThrow(D508QualificationError);
    expect(() => assertD508RejectedClaimContract({
      reason: "used_up",
      responseStatus: 410,
      responseReason: "used_up",
      requestsBeforeRefresh: onePreview,
      requestsAfterRefresh: onePreview,
      oidcRequests: 0,
      trace,
      custody: { session: true, local: false },
      recoveryVisible: true,
    }, "replay-recovery")).toThrow(D508QualificationError);
  });

  test("requires Browser Back to restore the saved handle without owner I/O before explicit resume", () => {
    const trace = assertRedactedCoordinatorTrace([
      { operationId: 1, phase: "previewing", commandKind: "preview-claim", result: "started", navigationIntent: null },
      { operationId: 1, phase: "previewing", commandKind: "preview-claim", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "starting-auth", commandKind: "prepare-signup", result: "started", navigationIntent: null },
      { operationId: 2, phase: "starting-auth", commandKind: "prepare-signup", result: "succeeded", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "succeeded", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "started", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "succeeded", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "completing", commandKind: "complete-profile", result: "started", navigationIntent: null },
      { operationId: 2, phase: "completing", commandKind: "complete-profile", result: "succeeded", navigationIntent: null },
      { operationId: 3, phase: "finalizing", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 3, phase: "finalizing", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const requests = [
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/preview" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/prepare-auth" },
      { method: "GET", origin: "logto" as const, pathname: "/oidc/auth" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/prepare-auth" },
      { method: "GET", origin: "logto" as const, pathname: "/oidc/auth" },
      { method: "POST", origin: "server" as const, pathname: "/api/bind-logto-user" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/complete-profile" },
    ];
    const evidence = {
      returnedToCleanClaim: true,
      restoredHandleWithoutReentry: true,
      returnIssuedNoOwnerIo: true,
      custodyRemainedSessionOnly: true,
      resumedWithOneExplicitContinue: true,
    } as const;
    expect(() => assertD508BrowserBackContract({
      requests,
      navigations: [{ origin: "server", pathname: "/" }],
      trace,
      bindResponses: ["2xx"],
      evidence,
    })).not.toThrow();
    expect(() => assertD508BrowserBackContract({
      requests: [...requests, requests[0]!],
      navigations: [{ origin: "server", pathname: "/" }],
      trace,
      bindResponses: ["2xx"],
      evidence,
    })).toThrow(D508QualificationError);
  });

  test("selects one live unbound claim while retaining expired or revoked history", () => {
    const now = new Date("2026-08-09T12:00:00.000Z");
    const base = { usedCount: 0, boundAt: null, redemptionUserId: null, completedAt: null } as const;
    expect(() => assertD508OneLiveUnboundClaim([
      { ...base, revokedAt: null, expiresAt: new Date("2026-08-09T11:59:00.000Z") },
      { ...base, revokedAt: new Date("2026-08-09T11:58:00.000Z"), expiresAt: new Date("2026-08-09T12:10:00.000Z") },
      { ...base, revokedAt: null, expiresAt: new Date("2026-08-09T12:10:00.000Z") },
    ], now)).not.toThrow();
    expect(() => assertD508OneLiveUnboundClaim([
      { ...base, revokedAt: null, expiresAt: new Date("2026-08-09T12:10:00.000Z") },
      { ...base, revokedAt: null, expiresAt: new Date("2026-08-09T12:11:00.000Z") },
    ], now)).toThrow();
    expect(() => assertD508OneLiveUnboundClaim([
      { ...base, revokedAt: null, expiresAt: new Date("2026-08-09T12:10:00.000Z"), boundAt: now, redemptionUserId: "user" },
    ], now)).toThrow();
  });

  test("uses deterministic exact cleanup scope even if stack startup never wrote instance.json", () => {
    expect(defaultD508CleanupState("d508012345abcdef")).toEqual({ ports: [], composeProject: "nautilo-d508012345abcdef" });
  });

  test("proves the separately-installed browser runtime before stack creation", async () => {
    let closed = false;
    await preflightD508BrowserRuntime(async () => ({ close: async () => { closed = true; } }));
    expect(closed).toBeTrue();
    let failure: unknown;
    try {
      await preflightD508BrowserRuntime(async () => { throw new Error("browser missing"); });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ phase: "preflight", code: "browser_runtime" });
  });

  test("keeps all disposable-run timing in one bounded policy grounded in existing contracts", () => {
    expect(DEFAULT_D508_QUALIFICATION_TIMING).toEqual({
      stackReadyMs: 60_000,
      browserStepMs: 120_000,
      traceDeliveryMs: 120_000,
      parentRunMs: 360_000,
      claimTtlMs: 15 * 60 * 1000,
      claimInstallSkewMs: 1_000,
      childTerminationGraceMs: 5_000,
    });
    expect(validateD508QualificationTiming(DEFAULT_D508_QUALIFICATION_TIMING)).toBe(DEFAULT_D508_QUALIFICATION_TIMING);
    expect(() => validateD508QualificationTiming({ ...DEFAULT_D508_QUALIFICATION_TIMING, browserStepMs: 0 })).toThrow("browserStepMs");
    expect(() => validateD508QualificationTiming({ ...DEFAULT_D508_QUALIFICATION_TIMING, claimInstallSkewMs: 15 * 60 * 1000 })).toThrow("claimInstallSkewMs");
  });

  test("makes in-flight browser or trace work abortable without exposing underlying errors", async () => {
    const controller = new AbortController();
    const pending = new Promise<void>(() => {});
    const result = awaitD508QualificationWork(pending, controller.signal);
    controller.abort();
    let aborted = false;
    try { await result; } catch { aborted = true; }
    expect(aborted).toBeTrue();
    expect(await awaitD508QualificationWork(Promise.resolve("complete"), new AbortController().signal)).toBe("complete");
  });

  test("bounds a redacted browser latch with the existing browser-step timeout", async () => {
    const pending = new Promise<void>(() => {});
    let failure: unknown;
    try {
      await awaitD508BrowserLatch(pending, "refresh-before-bind", 1);
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ phase: "browser-capture", code: "browser_trace", browserStage: "refresh-before-bind" });
    expect(await awaitD508BrowserLatch(Promise.resolve(), "refresh-before-bind", 1)).toBeUndefined();
  });

  test("pre-arms an exact redacted wrong-account bind-409 response latch", async () => {
    const responseListeners = new Set<(response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void>();
    const page = {
      on: (_event: "response", listener: never) => { responseListeners.add(listener as (response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void); return page; },
      off: (_event: "response", listener: never) => { responseListeners.delete(listener as (response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void); return page; },
    };
    const emit = (url: string, method: string, status: number) => {
      const response = { url: () => url, status: () => status, request: () => ({ method: () => method }) };
      for (const listener of responseListeners) listener(response);
    };

    const exact = awaitD508ExactBind409Response(page as never, "http://server.test", 100, "wrong-account-bind-response");
    emit("http://server.test/api/bind-logto-user", "GET", 409);
    emit("http://server.test/api/other", "POST", 409);
    expect(responseListeners.size).toBe(1);
    emit("http://server.test/api/bind-logto-user", "POST", 409);
    await exact;
    expect(responseListeners.size).toBe(0);

    const non409 = awaitD508ExactBind409Response(page as never, "http://server.test", 100, "wrong-account-bind-response");
    emit("http://server.test/api/bind-logto-user", "POST", 500);
    let non409Failure: unknown;
    try { await non409; } catch (error) { non409Failure = error; }
    expect(non409Failure).toMatchObject({
      browserStage: "wrong-account-bind-response",
      contractDeltas: [{ kind: "wrong-account-bind-response", expected: "exact-409", actual: "non-409" }],
    });
    expect(responseListeners.size).toBe(0);

    const missing = awaitD508ExactBind409Response(page as never, "http://server.test", 1, "wrong-account-bind-response");
    let missingFailure: unknown;
    try { await missing; } catch (error) { missingFailure = error; }
    expect(missingFailure).toMatchObject({
      browserStage: "wrong-account-bind-response",
      contractDeltas: [{ kind: "wrong-account-bind-response", expected: "exact-409", actual: "no-matching-response" }],
    });
    expect(responseListeners.size).toBe(0);
  });

  test("pre-arms only the direct or one-retry original-owner bind-success response shape", async () => {
    const responseListeners = new Set<(response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void>();
    const page = {
      on: (_event: "response", listener: never) => { responseListeners.add(listener as (response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void); return page; },
      off: (_event: "response", listener: never) => { responseListeners.delete(listener as (response: { url: () => string; status: () => number; request: () => { method: () => string } }) => void); return page; },
    };
    const emit = (status: number) => {
      const response = { url: () => "http://server.test/api/bind-logto-user", status: () => status, request: () => ({ method: () => "POST" }) };
      for (const listener of responseListeners) listener(response);
    };

    const direct = awaitD508ExactBindSuccessResponse(page as never, "http://server.test", 100, "original-owner-bind-response");
    emit(200);
    await direct;
    expect(responseListeners.size).toBe(0);

    const replay = awaitD508ExactBindSuccessResponse(page as never, "http://server.test", 100, "original-owner-bind-response");
    emit(401);
    expect(responseListeners.size).toBe(1);
    emit(200);
    await replay;
    expect(responseListeners.size).toBe(0);

    const invalid = awaitD508ExactBindSuccessResponse(page as never, "http://server.test", 100, "original-owner-bind-response");
    emit(409);
    let invalidFailure: unknown;
    try { await invalid; } catch (error) { invalidFailure = error; }
    expect(invalidFailure).toMatchObject({
      browserStage: "original-owner-bind-response",
      contractDeltas: [{ kind: "original-owner-bind-response", expected: "2xx-or-401-2xx", actual: "unexpected-response-sequence" }],
    });
    expect(responseListeners.size).toBe(0);

    const incomplete = awaitD508ExactBindSuccessResponse(page as never, "http://server.test", 1, "original-owner-bind-response");
    emit(401);
    let incompleteFailure: unknown;
    try { await incomplete; } catch (error) { incompleteFailure = error; }
    expect(incompleteFailure).toMatchObject({
      browserStage: "original-owner-bind-response",
      contractDeltas: [{ kind: "original-owner-bind-response", expected: "2xx-or-401-2xx", actual: "no-final-2xx" }],
    });
    expect(responseListeners.size).toBe(0);
  });

  test("arms post-logout request/return evidence before click and cleans every listener path", async () => {
    let currentUrl = "http://server.test/claim";
    const frame = { url: () => currentUrl };
    const frameListeners = new Set<(value: typeof frame) => void>();
    const requestListeners = new Set<(value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void>();
    const failedListeners = new Set<(value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void>();
    const page = {
      mainFrame: () => frame,
      on: (event: "request" | "requestfailed" | "framenavigated", listener: never) => {
        if (event === "framenavigated") frameListeners.add(listener as (value: typeof frame) => void);
        else if (event === "request") requestListeners.add(listener as (value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void);
        else failedListeners.add(listener as (value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void);
        return page;
      },
      off: (event: "request" | "requestfailed" | "framenavigated", listener: never) => {
        if (event === "framenavigated") frameListeners.delete(listener as (value: typeof frame) => void);
        else if (event === "request") requestListeners.delete(listener as (value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void);
        else failedListeners.delete(listener as (value: { isNavigationRequest: () => boolean; frame: () => typeof frame; url: () => string }) => void);
        return page;
      },
    };
    const arm = (timeout = 100) => awaitD508PostLogoutReturn(page as never, "http://server.test", timeout, {
      flow: "profile", leaveStage: "signed-out-profile-navigation-away", returnStage: "signed-out-profile-return",
    });
    const emitFrame = (url: string) => { currentUrl = url; for (const listener of frameListeners) listener(frame); };
    const emitRequest = (url: string, failed = false) => {
      const request = { isNavigationRequest: () => true, frame: () => frame, url: () => url };
      for (const listener of requestListeners) listener(request);
      if (failed) for (const listener of failedListeners) listener(request);
    };

    const currentDocument = arm();
    let settled = false;
    void currentDocument.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBeFalse();
    currentDocument.dispose();
    expect(frameListeners.size + requestListeners.size + failedListeners.size).toBe(0);

    const ordered = arm();
    emitRequest("http://logto.test/oidc/session/end");
    emitFrame("http://server.test/claim");
    expect(await ordered).toEqual({ outcome: "clean-return", foreignCommitObserved: false, foreignRequestFailed: false });
    expect(frameListeners.size + requestListeners.size + failedListeners.size).toBe(0);

    const outOfOrder = arm();
    emitFrame("http://logto.test/oidc/session/end");
    let outOfOrderFailure: unknown;
    try { await outOfOrder; } catch (error) { outOfOrderFailure = error; }
    expect(outOfOrderFailure).toMatchObject({ browserStage: "signed-out-profile-navigation-away" });
    const foreignCommit = arm();
    emitRequest("http://logto.test/oidc/session/end", true);
    emitFrame("http://logto.test/oidc/session/end");
    emitFrame("http://server.test/claim");
    expect(await foreignCommit).toEqual({ outcome: "clean-return", foreignCommitObserved: true, foreignRequestFailed: true });
    const wrongPath = arm();
    emitRequest("http://logto.test/oidc/session/end");
    emitFrame("http://server.test/");
    let wrongPathFailure: unknown;
    try { await wrongPath; } catch (error) { wrongPathFailure = error; }
    expect(wrongPathFailure).toMatchObject({ browserStage: "signed-out-profile-return" });
    const requestWithoutReturn = arm(1);
    emitRequest("http://logto.test/oidc/session/end");
    let requestFailure: unknown;
    try { await requestWithoutReturn; } catch (error) { requestFailure = error; }
    expect(requestFailure).toMatchObject({ contractDeltas: [{ actual: "foreign-request-no-return-commit" }] });
    expect(frameListeners.size + requestListeners.size + failedListeners.size).toBe(0);
  });

  test("waits for delayed Node-side sign-out started trace after a clean logout return", async () => {
    const subscribers = new Set<(event: unknown) => void>();
    const latch = awaitD508SignOutTraceStarted((listener) => { subscribers.add(listener); return () => subscribers.delete(listener); }, 100, "signed-out-profile-signout-started");
    let resolved = false;
    void latch.then(() => { resolved = true; });
    await Promise.resolve();
    expect(resolved).toBeFalse();
    for (const subscriber of subscribers) subscriber({ commandKind: "sign-out", result: "started" });
    await latch;
    expect(resolved).toBeTrue();
    expect(subscribers.size).toBe(0);

    const missing = awaitD508SignOutTraceStarted(() => () => {}, 1, "signed-out-profile-signout-started");
    let missingFailure: unknown;
    try { await missing; } catch (error) { missingFailure = error; }
    expect(missingFailure).toMatchObject({ code: "browser_trace", browserStage: "signed-out-profile-signout-started" });
  });

  test("forces the exact current Workbench turbo build before a source-dependent qualification stack", async () => {
    const repoRoot = join(import.meta.dir, "../../../..");
    const calls: Array<{ argv: readonly string[]; cwd: string }> = [];
    await buildD508CurrentWorkbench((argv, options) => {
      calls.push({ argv, cwd: options.cwd });
      return { exited: Promise.resolve(0) };
    });
    expect(calls).toEqual([{ argv: ["bunx", "turbo", "run", "build", "--filter=@nautilo/workbench"], cwd: repoRoot }]);
    let buildFailure: unknown;
    try { await buildD508CurrentWorkbench(() => ({ exited: Promise.resolve(1) })); } catch (error) { buildFailure = error; }
    expect(buildFailure).toMatchObject({ phase: "workbench-build", code: "workbench_build" });
    let spawnFailure: unknown;
    try { await buildD508CurrentWorkbench(() => { throw new Error("spawn unavailable"); }); } catch (error) { spawnFailure = error; }
    expect(spawnFailure).toMatchObject({ phase: "workbench-build", code: "workbench_build" });
  });

  test("fails visibly when the local Logto image pin changes beneath its exact hosted-form contract", () => {
    const compose = readFileSync(join(import.meta.dir, "../../../../infra/compose/nautilo.yml"), "utf8");
    expect(compose).toContain(`image: ${D508_QUALIFIED_LOGTO_IMAGE}`);
  });

  test("reports only a semantic browser stage for a browser failure", () => {
    const failure = new D508QualificationError("browser-capture", "browser_contract", "hosted-password");
    expect(redactedD508FailureReceipt(failure)).toEqual({
      outcome: "failed",
      phase: "browser-capture",
      code: "browser_contract",
      browserStage: "hosted-password",
    });
    expect(JSON.stringify(redactedD508FailureReceipt(failure))).not.toContain("password-value");
    expect(D508_BROWSER_STAGES).toContain("hosted-identifier");
    expect(D508_BROWSER_STAGES).toContain("guide-refresh");
    expect(D508_BROWSER_STAGES).toContain("recovery-refresh");
    expect(D508_BROWSER_STAGES).toContain("product-navigation");
    expect(D508_BROWSER_STAGES).toContain("refresh-before-bind");
    expect(D508_BROWSER_STAGES).toContain("callback-claim-transition");
    expect(D508_BROWSER_STAGES).toContain("pre-reload-bind-blocked");
    expect(D508_BROWSER_STAGES).toContain("post-reload-bootstrap");
    expect(D508_BROWSER_STAGES).toContain("resumed-bind-evidence");
    expect(D508_BROWSER_STAGES).toContain("post-reload-profile-visible");
    expect(D508_BROWSER_STAGES).toContain("refresh-after-bind-validation");
    expect(D508_BROWSER_STAGES).toContain("server-restart-after-bind");
    expect(D508_BROWSER_STAGES).toContain("post-restart-profile-visible");
    expect(D508_BROWSER_STAGES).toContain("wrong-account-hosted-login-entry");
    expect(D508_BROWSER_STAGES).toContain("wrong-account-hosted-login-submit");
    expect(D508_BROWSER_STAGES).toContain("wrong-account-bind-response");
    expect(D508_BROWSER_STAGES).toContain("wrong-account-recovery-ui");
    expect(D508_BROWSER_STAGES).toContain("original-owner-retry-action");
    expect(D508_BROWSER_STAGES).toContain("original-owner-hosted-login-entry");
    expect(D508_BROWSER_STAGES).toContain("original-owner-bind-response");
    expect(D508_BROWSER_STAGES).toContain("original-owner-recovery-codes");
    expect(D508_BROWSER_STAGES).toContain("original-owner-product-navigation");
    expect(D508_BROWSER_STAGES).toContain("expired-claim-response");
    expect(D508_BROWSER_STAGES).toContain("expired-claim-recovery");
    expect(D508_BROWSER_STAGES).toContain("replay-response");
    expect(D508_BROWSER_STAGES).toContain("replay-recovery");
    expect(D508_BROWSER_STAGES).not.toContain("hosted-register");
  });

  test("keeps plaintext bootstrap-claim minting disabled only for the internal qualification option", () => {
    expect(shouldMintBootstrapClaimInvite({})).toBeTrue();
    expect(shouldMintBootstrapClaimInvite({ suppressBootstrapClaimInvite: true })).toBeFalse();
  });

  test("observations retain only origin class, method and pathname", () => {
    const request = redactRequestObservation(
      "http://127.0.0.1:4321/api/owner-claim/preview?claim=never-record-this#still-never-recorded",
      "POST", "http://127.0.0.1:4321", "http://127.0.0.1:3002",
    );
    expect(request).toEqual({ method: "POST", origin: "server", pathname: "/api/owner-claim/preview" });
    const nav = redactNavigationObservation("http://127.0.0.1:3002/oidc/auth?state=secret", "http://127.0.0.1:4321", "http://127.0.0.1:3002");
    expect(nav).toEqual({ origin: "logto", pathname: "/oidc/auth" });
    expect(JSON.stringify({ request, nav })).not.toContain("secret");
  });

  test("classifies the initial OIDC authorization request before navigation arrives", () => {
    const observed = observeD508Request(
      "http://127.0.0.1:3901/oidc/auth?client_id=nonsecret-example&state=redacted",
      "GET",
      "http://127.0.0.1:3601",
      null,
    );
    expect(observed).toEqual({
      logtoOrigin: "http://127.0.0.1:3901",
      observation: { method: "GET", origin: "logto", pathname: "/oidc/auth" },
    });
    expect(JSON.stringify(observed)).not.toContain("state=");
  });

  test("rejects absent or over-broad coordinator trace evidence", () => {
    expect(() => assertRedactedCoordinatorTrace([])).toThrow(D508QualificationError);
    expect(() => assertRedactedCoordinatorTrace([{ operationId: 1, phase: "claim", commandKind: "preview-claim", result: "succeeded", navigationIntent: null }])).not.toThrow();
    expect(() => assertRedactedCoordinatorTrace([{ operationId: 1, phase: "claim", commandKind: "preview", result: "ok", navigationIntent: null, claim: "forbidden" }])).toThrow(D508QualificationError);
    expect(() => assertRedactedCoordinatorTrace([{ operationId: "1", phase: "claim", commandKind: "preview", result: "ok", navigationIntent: null }])).toThrow(D508QualificationError);
  });

  test("limits the callback transition and post-reload epoch to exact same-origin boundaries", () => {
    const serverOrigin = "http://127.0.0.1:3601";
    expect(isD508CallbackClaimTarget({ serverOrigin, currentOrigin: serverOrigin, currentPathname: "/auth/callback", historyTarget: "/claim" })).toBeTrue();
    expect(isD508CallbackClaimTarget({ serverOrigin, currentOrigin: serverOrigin, currentPathname: "/auth/callback", historyTarget: "/claim?next=forbidden" })).toBeFalse();
    expect(isD508CallbackClaimTarget({ serverOrigin, currentOrigin: serverOrigin, currentPathname: "/claim", historyTarget: "/claim" })).toBeFalse();
    expect(isD508CallbackClaimTarget({ serverOrigin, currentOrigin: "http://127.0.0.1:3901", currentPathname: "/auth/callback", historyTarget: "/claim" })).toBeFalse();
    const source = readFileSync(join(import.meta.dir, "../../src/commands/qualify-owner-claim.ts"), "utf8");
    expect(source).toContain('browser.location.pathname !== "/auth/callback"');
    expect(source).toContain('parsed.pathname === "/claim"');
    const callbackTransition = source.indexOf('void browser.__nautiloD508RecordCallbackClaimTransition?.();');
    const nativeFallback = source.indexOf("return native.call(browser.history, data, unused, url);");
    expect(source).toContain('page.on("framenavigated"');
    expect(source).toContain("expectingPostReload && !postReload");
    expect(callbackTransition).toBeGreaterThan(-1);
    expect(nativeFallback).toBeGreaterThan(callbackTransition);
    expect(source).not.toContain("__nautiloD508RecordPreReactReload");
    expect(source).not.toContain("owner-claim-handoff");
  });

  test("requires the semantic pre-reload bind interruption, not an arbitrary route count", () => {
    expect(isD508ResumedBindSuccess({ operationId: 1, commandKind: "bind-subject", result: "succeeded" })).toBeTrue();
    expect(isD508ResumedBindSuccess({ operationId: 1, commandKind: "bind-subject", result: "failed" })).toBeFalse();
    expect(isD508ResumedBindSuccess({ operationId: 1, commandKind: "complete-profile", result: "succeeded" })).toBeFalse();
    const preReloadTrace = assertRedactedCoordinatorTrace([
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "failed", navigationIntent: null },
      { operationId: 2, phase: "recoverable", commandKind: "reobserve-bind", result: "started", navigationIntent: null },
      { operationId: 2, phase: "recoverable", commandKind: "reobserve-bind", result: "failed", navigationIntent: null },
    ]);
    expect(() => assertD508PreReloadBindInterruption({ trace: preReloadTrace, blockedRoutes: 2 })).not.toThrow();
    expect(assertD508BindResponseClassifications(["2xx"])).toBe(1);
    expect(assertD508BindResponseClassifications(["401", "2xx"])).toBe(2);
    expect(classifyD508BindResponseStatus(204)).toBe("2xx");
    expect(classifyD508BindResponseStatus(401)).toBe("401");
    expect(classifyD508BindResponseStatus(500)).toBe("other");
    expect(() => assertD508PostReloadCommitCount(1)).not.toThrow();
    let failure: unknown;
    try { assertD508PreReloadBindInterruption({ trace: preReloadTrace, blockedRoutes: 1 }); } catch (error) { failure = error; }
    expect(redactedD508FailureReceipt(failure)).toMatchObject({
      code: "browser_contract",
      browserStage: "resumed-bind-evidence",
      contractDeltas: [{
        kind: "pre-reload-bind-interruption",
        expected: { bindStarts: 1, reobserveStarts: 1, completeProfileStarts: 0, successful: 0, blockedRoutesEqualMutationStarts: true },
        actual: { bindStarts: 1, reobserveStarts: 1, completeProfileStarts: 0, successful: 0, blockedRoutes: 1, mutationStarts: 2 },
      }],
    });
    expect(() => assertD508BindResponseClassifications(["2xx", "2xx"])).toThrow(D508QualificationError);
    expect(() => assertD508PostReloadCommitCount(0)).toThrow(D508QualificationError);
  });

  test("requires the exact fresh-guide browser mutation and coordinator trace spine", () => {
    const trace = assertRedactedCoordinatorTrace([
      ...["preview-claim", "prepare-signup", "launch-logto-signup", "bind-subject", "complete-profile", "navigate-guide"].flatMap((commandKind, operationId) => [
        { operationId, phase: "claim", commandKind, result: "started", navigationIntent: null },
        { operationId, phase: "claim", commandKind, result: "succeeded", navigationIntent: commandKind === "navigate-guide" ? "guide" : null },
      ]),
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    expect(() => assertFreshGuideContract({ requests, navigations: [{ origin: "server", pathname: "/help/server" }], trace })).not.toThrow();
    expect(() => assertFreshGuideContract({ requests: [...requests, requests[0]!], navigations: [{ origin: "server", pathname: "/help/server" }], trace })).toThrow(D508QualificationError);
  });

  test("requires product finish to reload its truthful no-codes terminal without duplicate mutations", () => {
    const trace = assertRedactedCoordinatorTrace([
      ...["preview-claim", "prepare-signup", "launch-logto-signup", "bind-subject", "complete-profile", "navigate-product"].flatMap((commandKind, operationId) => [
        { operationId, phase: "claim", commandKind, result: "started", navigationIntent: commandKind === "navigate-product" ? "product" : null },
        { operationId, phase: "claim", commandKind, result: "succeeded", navigationIntent: commandKind === "navigate-product" ? "product" : null },
      ]),
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    expect(() => assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/claim" }, { origin: "server", pathname: "/" }], trace })).not.toThrow();
    expect(() => assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/help/server" }], trace })).toThrow(D508QualificationError);
    expect(() => assertProductRecoveryRefreshContract({ requests: [...requests, requests[3]!], navigations: [{ origin: "server", pathname: "/" }], trace })).toThrow(D508QualificationError);
    expect(() => assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace: [...trace, trace[0]!] })).toThrow(D508QualificationError);
  });

  test("requires committed-before-reset lost bind and completion responses to resolve exactly once", () => {
    const trace = assertRedactedCoordinatorTrace([
      { operationId: 1, phase: "capturing", commandKind: "preview-claim", result: "started", navigationIntent: null },
      { operationId: 1, phase: "capturing", commandKind: "preview-claim", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "new-owner", commandKind: "prepare-signup", result: "started", navigationIntent: null },
      { operationId: 2, phase: "new-owner", commandKind: "prepare-signup", result: "succeeded", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "aborted", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "stale", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "failed", navigationIntent: null },
      { operationId: 2, phase: "recoverable", commandKind: "reobserve-bind", result: "started", navigationIntent: null },
      { operationId: 2, phase: "recoverable", commandKind: "reobserve-bind", result: "succeeded", navigationIntent: null },
      { operationId: 3, phase: "completing", commandKind: "complete-profile", result: "started", navigationIntent: null },
      { operationId: 3, phase: "completing", commandKind: "complete-profile", result: "failed", navigationIntent: null },
      { operationId: 4, phase: "recoverable", commandKind: "reobserve-completion", result: "started", navigationIntent: null },
      { operationId: 4, phase: "recoverable", commandKind: "reobserve-completion", result: "succeeded", navigationIntent: null },
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const requests = [
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/preview" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/prepare-auth" },
      { method: "POST", origin: "server" as const, pathname: "/api/bind-logto-user" },
      { method: "POST", origin: "server" as const, pathname: "/api/bind-logto-user" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/complete-profile" },
      { method: "GET", origin: "server" as const, pathname: "/api/setup/status" },
    ];
    const valid = {
      trace, requests, navigations: [{ origin: "server" as const, pathname: "/" }], oidcRequests: 1,
      bindCommitted200: true, bindAbortedAfterCommit: true, bindReservationUnchanged: true,
      completionCommitted200: true, completionAbortedAfterCommit: true, completionRecoveryFingerprintUnchanged: true,
      setupStatusDelta: 1,
      terminalCustody: true, noCodesTerminal: true,
    } as const;
    expect(assertD508LostResponsesContract(valid)).toMatchObject({ completionReobservedSetupStatusOnce: true });
    const directTrace = [...trace];
    directTrace.splice(4, 3,
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 3, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "succeeded", navigationIntent: null },
    );
    expect(() => assertD508LostResponsesContract({ ...valid, trace: directTrace })).not.toThrow();
    expect(() => assertD508LostResponsesContract({ ...valid, setupStatusDelta: 0 })).toThrow(D508QualificationError);
    expect(() => assertD508LostResponsesContract({ ...valid, requests: [...valid.requests, valid.requests[4]!] })).toThrow(D508QualificationError);
    expect(() => assertD508LostResponsesContract({ ...valid, setupStatusDelta: 2 })).toThrow(D508QualificationError);
    expect(() => assertD508LostResponsesContract({ ...valid, trace: [...trace, trace.at(-1)!] })).toThrow(D508QualificationError);
    expect(() => assertD508LostResponsesContract({ ...valid, trace: trace.map((event, index) => index === 9 ? { ...event, operationId: 3 } : event) })).toThrow(D508QualificationError);
    expect(() => assertD508LostResponsesContract({ ...valid, completionRecoveryFingerprintUnchanged: false })).toThrow(D508QualificationError);
    expect(() => assertD508CommittedResponseAbortOrder(["response-200", "db-committed", "connectionreset"])).not.toThrow();
    expect(() => assertD508CommittedResponseAbortOrder(["response-200", "connectionreset", "db-committed"])).toThrow(D508QualificationError);
  });

  test("requires the signed-out wrong-account proof to retain server and custody fences", () => {
    const trace = (groups: readonly (readonly [string, readonly string[]])[], epochs: readonly number[]) => {
      let groupIndex = 0;
      return assertRedactedCoordinatorTrace(epochs.flatMap((count) => Array.from({ length: count }, (_, operationIndex) => {
        const [commandKind, results] = groups[groupIndex++]!;
        return results.map((result) => ({ operationId: operationIndex + 1, phase: "qualification", commandKind, result, navigationIntent: commandKind === "navigate-product" ? "product" : null }));
      })).flat());
    };
    const wrongProvisionTrace = trace([
      ["preview-claim", ["started", "succeeded"]], ["prepare-signup", ["started", "succeeded"]], ["launch-logto-signup", ["started", "succeeded"]], ["bind-subject", ["started", "failed"]],
    ], [3, 1]);
    const ownerTrace = trace([
      ["preview-claim", ["started", "succeeded"]], ["prepare-signup", ["started", "succeeded"]], ["launch-logto-signup", ["started", "succeeded"]],
      ["bind-subject", ["started", "succeeded"]], ["sign-out", ["started", "succeeded"]],
      ["prepare-resume", ["started", "succeeded"]], ["launch-logto-signin", ["started", "succeeded"]],
      ["bind-subject", ["started", "failed"]], ["sign-out", ["started", "succeeded"]],
      ["prepare-resume", ["started", "succeeded"]], ["launch-logto-signin", ["started", "succeeded"]],
      ["bind-subject", ["started", "succeeded"]], ["complete-profile", ["started", "succeeded"]], ["navigate-product", ["started", "succeeded"]],
    ], [3, 2, 2, 2, 2, 3]);
    const valid = {
      wrongProvisionTrace, ownerTrace,
      wrongProvisionRequests: { preview: 1, prepareAuth: 1, bind: 1, completeProfile: 0 },
      ownerRequests: { preview: 1, prepareAuth: 3, bind: 3, completeProfile: 1 },
      ownerOidcRequests: 3,
      wrongBind409s: 1,
      wrongBindResponses: ["other"],
      correctRecoveryBindResponses: ["2xx"],
      signedOutProfileOwnerIo: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      evidence: {
        wrongAccountCreatedWithoutServerBind: true,
        signedOutProfilePreservedSessionOnlyCustody: true,
        wrongSubjectBind409Observed: true,
        wrongSubjectReceivedOnlyClaimReserved: true,
        wrongSubjectDidNotChangeReservationOrCompleteOwner: true,
        originalSubjectRecoveredWithoutHandleEntry: true,
        originalSubjectCompletedExactlyOnce: true,
      },
    } as const;
    expect(assertD508SignedOutWrongAccountContract(valid)).toMatchObject({ originalSubjectCompletedExactlyOnce: true });
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, wrongBind409s: 0 })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, evidence: { ...valid.evidence, wrongSubjectBind409Observed: false as never } })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, wrongBindResponses: ["2xx"] })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, correctRecoveryBindResponses: ["other"] })).toThrow(D508QualificationError);
    expect(assertD508SignedOutWrongAccountContract({
      ...valid,
      ownerRequests: { ...valid.ownerRequests, bind: 4 },
      correctRecoveryBindResponses: ["401", "2xx"],
    })).toMatchObject({ originalSubjectCompletedExactlyOnce: true });
    expect(() => assertD508SignedOutWrongAccountContract({
      ...valid,
      correctRecoveryBindResponses: ["401", "2xx"],
    })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, signedOutProfileOwnerIo: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 } })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, ownerRequests: { ...valid.ownerRequests, bind: 4 } })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({ ...valid, ownerTrace: ownerTrace.map((event, index) => index === 10 ? { ...event, operationId: 3 } : event) })).toThrow(D508QualificationError);
    expect(() => assertD508SignedOutWrongAccountContract({
      ...valid,
      wrongProvisionTrace: [...wrongProvisionTrace, { operationId: 2, phase: "recoverable", commandKind: "reobserve-bind", result: "started", navigationIntent: null }],
    })).toThrow(D508QualificationError);
  });

  test("uses only the frozen ordinary bind-500 seed response, never an ambiguous transport outcome", () => {
    expect(assertD508SeedBindFailureResponse(D508_SEED_BIND_FAILURE_RESPONSE)).toEqual({
      status: 500,
      contentType: "application/json",
      json: { error: "claim_reservation_invariant", code: "claim_reservation_invariant" },
    });
    expect(() => assertD508SeedBindFailureResponse({ status: 500, contentType: "application/json", json: { error: "claim_reservation_invariant" } })).toThrow();
    expect(() => assertD508SeedBindFailureResponse({ status: 409, contentType: "application/json", json: { error: "claim_reservation_invariant", code: "claim_reservation_invariant" } })).toThrow();
  });

  test("accepts the real redirect launch disposal shape when OIDC continuation reaches bind and completion", () => {
    const trace = assertRedactedCoordinatorTrace([
      { operationId: 0, phase: "previewing", commandKind: "preview-claim", result: "started", navigationIntent: null },
      { operationId: 0, phase: "previewing", commandKind: "preview-claim", result: "succeeded", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "started", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "aborted", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "stale", navigationIntent: null },
      { operationId: 3, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 3, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
      { operationId: 4, phase: "completing", commandKind: "complete-profile", result: "started", navigationIntent: null },
      { operationId: 4, phase: "completing", commandKind: "complete-profile", result: "succeeded", navigationIntent: null },
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    expect(() => assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace })).not.toThrow();
  });

  test("requires one held logical bind and rejects reobserve-binds", () => {
    const trace = assertRedactedCoordinatorTrace([
      { operationId: 0, phase: "previewing", commandKind: "preview-claim", result: "started", navigationIntent: null },
      { operationId: 0, phase: "previewing", commandKind: "preview-claim", result: "succeeded", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "started", navigationIntent: null },
      { operationId: 1, phase: "starting-auth", commandKind: "prepare-signup", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "aborted", navigationIntent: null },
      { operationId: 2, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "stale", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
      { operationId: 5, phase: "completing", commandKind: "complete-profile", result: "started", navigationIntent: null },
      { operationId: 5, phase: "completing", commandKind: "complete-profile", result: "succeeded", navigationIntent: null },
      { operationId: 6, phase: "showing-recovery", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 6, phase: "showing-recovery", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    expect(() => assertHeldBindProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace }, 1)).not.toThrow();
    expect(() => assertHeldBindProductRecoveryRefreshContract({
      requests: [...requests, { method: "POST", origin: "server", pathname: "/api/bind-logto-user" }],
      navigations: [{ origin: "server", pathname: "/" }],
      trace,
    }, 2)).not.toThrow();
    const postReloadTrace = assertRedactedCoordinatorTrace([
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
      { operationId: 2, phase: "completing", commandKind: "complete-profile", result: "started", navigationIntent: null },
      { operationId: 2, phase: "completing", commandKind: "complete-profile", result: "succeeded", navigationIntent: null },
      { operationId: 3, phase: "finalizing", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 3, phase: "finalizing", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const postReloadRequests = [
      { method: "POST", origin: "server" as const, pathname: "/api/bind-logto-user" },
      { method: "POST", origin: "server" as const, pathname: "/api/bind-logto-user" },
      { method: "POST", origin: "server" as const, pathname: "/api/owner-claim/complete-profile" },
    ];
    expect(() => assertD508PostReloadOwnerContract({ requests: postReloadRequests, navigations: [{ origin: "server", pathname: "/" }], trace: postReloadTrace }, 2)).not.toThrow();

    const mismatchedOperationPair = postReloadTrace.map((event, index) => index === 3 ? { ...event, operationId: 7 } : event);
    expect(() => assertD508PostReloadOwnerContract({ requests: postReloadRequests, navigations: [{ origin: "server", pathname: "/" }], trace: mismatchedOperationPair }, 2)).toThrow(D508QualificationError);

    const reobserve = [...trace, { operationId: 2, phase: "binding", commandKind: "reobserve-bind", result: "succeeded", navigationIntent: null }];
    expect(() => assertHeldBindProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace: reobserve }, 1)).toThrow(D508QualificationError);
    expect(() => assertD508PostReloadOwnerContract({ requests: postReloadRequests, navigations: [{ origin: "server", pathname: "/" }], trace: [...postReloadTrace, reobserve.at(-1)!] }, 2)).toThrow(D508QualificationError);
  });

  test("requires passive and signed-out profile checkpoints to issue no owner I/O", () => {
    const before = { preview: 1, prepareAuth: 1, bind: 2, completeProfile: 0 } as const;
    expect(assertD508PassiveProfileCheckpointRequestDelta(before, { ...before })).toEqual({ preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 });
    expect(() => assertD508PassiveProfileCheckpointRequestDelta(before, { ...before, preview: 2 })).toThrow(D508QualificationError);
  });

  test("requires a host-only restart to preserve the profile reservation and revalidate it exactly once", () => {
    const zero = { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 } as const;
    const bindValidationTrace = assertRedactedCoordinatorTrace([
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "started", navigationIntent: null },
      { operationId: 1, phase: "binding", commandKind: "bind-subject", result: "succeeded", navigationIntent: null },
    ]);
    const valid = {
      serverPidBefore: 101,
      serverPidAfter: 102,
      appPostgresUnchanged: true,
      logtoCoreUnchanged: true,
      logtoPostgresUnchanged: true,
      reservationUnchanged: true,
      noCompletedOwner: true,
      beforeReload: { requestDelta: zero, traceDelta: 0, oidcDelta: 0, sessionOnlyCustody: true },
      afterReload: {
        requestDelta: { preview: 0, prepareAuth: 0, bind: 1, completeProfile: 0 },
        trace: bindValidationTrace,
        oidcDelta: 0,
        bindResponses: ["2xx"],
        sessionOnlyCustody: true,
      },
    } as const;
    expect(assertD508RestartAfterBindContract(valid)).toEqual({
      hostServerRestartedWithDifferentPid: true,
      appPostgresLogtoCoreAndLogtoPostgresUnchanged: true,
      reservationUnchanged: true,
      noCompletedOwnerBeforeProfileSubmit: true,
      noOwnerIoOrOidcBeforeReload: true,
      profileBindValidationAfterReload: true,
      rawClaimRemainedSessionOnly: true,
    });
    expect(() => assertD508RestartAfterBindContract({ ...valid, serverPidAfter: 101 })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, appPostgresUnchanged: false })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, logtoCoreUnchanged: false })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, logtoPostgresUnchanged: false })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, reservationUnchanged: false })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, noCompletedOwner: false })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, beforeReload: { ...valid.beforeReload, requestDelta: { ...zero, bind: 1 } } })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, beforeReload: { ...valid.beforeReload, traceDelta: 1 } })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, afterReload: { ...valid.afterReload, oidcDelta: 1 } })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, afterReload: { ...valid.afterReload, requestDelta: zero } })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, afterReload: { ...valid.afterReload, bindResponses: ["other"] } })).toThrow(D508QualificationError);
    expect(() => assertD508RestartAfterBindContract({ ...valid, afterReload: { ...valid.afterReload, trace: [...bindValidationTrace, bindValidationTrace[1]!] } })).toThrow(D508QualificationError);
    expect(assertD508RestartAfterBindContract({
      ...valid,
      afterReload: { ...valid.afterReload, requestDelta: { preview: 0, prepareAuth: 0, bind: 2, completeProfile: 0 }, bindResponses: ["401", "2xx"] },
    })).toMatchObject({ profileBindValidationAfterReload: true });
    expect(() => assertD508RestartAfterBindContract({ ...valid, afterReload: { ...valid.afterReload, sessionOnlyCustody: false } })).toThrow(D508QualificationError);
    expect(assertD508ProfileBindValidation({
      requestDelta: { preview: 0, prepareAuth: 0, bind: 1, completeProfile: 0 }, trace: bindValidationTrace, oidcDelta: 0, bindResponses: ["2xx"],
    })).toBeTrue();
    expect(() => assertD508ProfileBindValidation({
      requestDelta: { preview: 1, prepareAuth: 0, bind: 1, completeProfile: 0 }, trace: bindValidationTrace, oidcDelta: 0, bindResponses: ["2xx"],
    })).toThrow(D508QualificationError);
  });

  test("requires the selected server PID file to name the live Nautilo listener", () => {
    expect(assertD508SelectedServerIdentity({ pidFile: 101, listenerPid: 101, isNautiloServer: true })).toBe(101);
    expect(() => assertD508SelectedServerIdentity({ pidFile: 101, listenerPid: 102, isNautiloServer: true })).toThrow(D508QualificationError);
    expect(() => assertD508SelectedServerIdentity({ pidFile: 101, listenerPid: 101, isNautiloServer: false })).toThrow(D508QualificationError);
    expect(() => assertD508SelectedServerIdentity({ pidFile: 0, listenerPid: 0, isNautiloServer: true })).toThrow(D508QualificationError);
  });

  test("compares all private container runtime identity fields, including StartedAt", () => {
    const before = { id: "private-a", status: "running" as const, running: true as const, restartCount: 0, startedAt: "2026-08-08T12:00:00.000000000Z" };
    expect(sameD508ContainerRuntime(before, { ...before })).toBeTrue();
    expect(sameD508ContainerRuntime(before, { ...before, id: "private-b" })).toBeFalse();
    expect(sameD508ContainerRuntime(before, { ...before, restartCount: 1 })).toBeFalse();
    expect(sameD508ContainerRuntime(before, { ...before, startedAt: "2026-08-08T12:00:01.000000000Z" })).toBeFalse();
  });

  test("terminates and awaits an interrupted nested restart before teardown may proceed", async () => {
    let resolveGracefulExit: ((code: number) => void) | undefined;
    const gracefulSignals: NodeJS.Signals[] = [];
    const graceful = {
      exited: new Promise<number>((resolve) => { resolveGracefulExit = resolve; }),
      kill: (signal: NodeJS.Signals) => {
        gracefulSignals.push(signal);
        if (signal === "SIGTERM") resolveGracefulExit?.(0);
      },
    };
    await terminateD508RestartChild(graceful, 5, async () => new Promise<void>(() => {}));
    expect(gracefulSignals).toEqual(["SIGTERM"]);

    let resolveForcedExit: ((code: number) => void) | undefined;
    const forcedSignals: NodeJS.Signals[] = [];
    const forced = {
      exited: new Promise<number>((resolve) => { resolveForcedExit = resolve; }),
      kill: (signal: NodeJS.Signals) => {
        forcedSignals.push(signal);
        if (signal === "SIGKILL") resolveForcedExit?.(137);
      },
    };
    await terminateD508RestartChild(forced, 5, async () => {});
    expect(forcedSignals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("requires per-tab two-tab loss/reissue evidence without merging coordinator operation ids", () => {
    const event = (operationId: number, commandKind: string, result: string) => ({ operationId, phase: "claim", commandKind, result, navigationIntent: null });
    const pageA = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(2, "prepare-signup", "started"), event(2, "prepare-signup", "succeeded"),
      event(3, "launch-logto-signup", "started"), event(3, "launch-logto-signup", "aborted"), event(3, "launch-logto-signup", "stale"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
    ]);
    const pageB = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(1, "preview-claim", "started"), event(1, "preview-claim", "failed"),
    ]);
    const pageC = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(2, "prepare-resume", "started"), event(2, "prepare-resume", "succeeded"),
      event(3, "bind-subject", "started"), event(3, "bind-subject", "succeeded"),
      event(4, "complete-profile", "started"), event(4, "complete-profile", "succeeded"),
      { operationId: 1, phase: "claim", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 1, phase: "claim", commandKind: "navigate-product", result: "succeeded", navigationIntent: "product" },
    ]);
    const assertD508TwoTabReissueContract = (
      input: Omit<Parameters<typeof assertD508TwoTabReissueContractBase>[0], "pageARequests" | "pageBRequests" | "pageCRequests" | "pageAOidcRequests" | "pageBOidcRequests" | "pageCOidcRequests" | "pageAReloadBindResponses">
        & Partial<Pick<Parameters<typeof assertD508TwoTabReissueContractBase>[0], "pageARequests" | "pageBRequests" | "pageCRequests" | "pageAOidcRequests" | "pageBOidcRequests" | "pageCOidcRequests" | "pageAReloadBindResponses">>,
    ) => assertD508TwoTabReissueContractBase({
      pageARequests: { preview: 1, prepareAuth: 1, bind: 2, completeProfile: 0 },
      pageBRequests: { preview: 2, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageCRequests: { preview: 1, prepareAuth: 1, bind: 1, completeProfile: 1 },
      pageAOidcRequests: 1,
      pageBOidcRequests: 0,
      pageCOidcRequests: 0,
      pageAReloadBindResponses: ["2xx"],
      ...input,
    });
    expect(assertD508TwoTabReissueContract({
      pageATrace: pageA,
      pageBTrace: pageB,
      pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1,
      pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toEqual({
      pageAAndBHaveSessionOnlyCustody: true,
      pageBDidNotMutateDuringAReservation: true,
      pageAClosedAndPageBReportedControllerReissueGuidance: true,
      staleCustodyClearedBeforeSecondRefresh: true,
      controllerReplacementRevokedAAndRetainedReservation: true,
      sameSubjectResumedWithoutHandleOrOidc: true,
      successfulCompletions: 1,
    });
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA, pageBTrace: pageB, pageCTrace: pageC,
      pageARequests: { preview: 1, prepareAuth: 1, bind: 3, completeProfile: 0 },
      pageAReloadBindResponses: ["401", "2xx"],
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).not.toThrow();
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA, pageBTrace: pageB, pageCTrace: pageC,
      pageAReloadBindResponses: ["other"],
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA,
      pageBTrace: pageB,
      pageCTrace: pageC,
      pageARequests: { preview: 2, prepareAuth: 1, bind: 2, completeProfile: 0 },
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1,
      pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA,
      pageBTrace: pageB,
      pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1,
      pageAOidcRequests: 1,
      pageCOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    const pageADirectSuccess = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(2, "prepare-signup", "started"), event(2, "prepare-signup", "succeeded"),
      event(3, "launch-logto-signup", "started"), event(3, "launch-logto-signup", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
    ]);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageADirectSuccess, pageBTrace: pageB, pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).not.toThrow();
    const pageADirectMonotonicImpossible = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(2, "prepare-signup", "started"), event(2, "prepare-signup", "succeeded"),
      event(3, "launch-logto-signup", "started"), event(3, "launch-logto-signup", "succeeded"),
      event(4, "bind-subject", "started"), event(4, "bind-subject", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
    ]);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageADirectMonotonicImpossible, pageBTrace: pageB, pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    const pageADirectNonContiguousEpoch = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(3, "prepare-signup", "started"), event(3, "prepare-signup", "succeeded"),
      event(4, "launch-logto-signup", "started"), event(4, "launch-logto-signup", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
    ]);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageADirectNonContiguousEpoch, pageBTrace: pageB, pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA,
      pageBTrace: pageB,
      pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 1, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1,
      pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA,
      pageBTrace: pageB,
      pageCTrace: [...pageC, event(6, "reobserve-bind", "started")],
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1,
      pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    const pageARepeatedOperationWithinEpoch = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(1, "prepare-signup", "started"), event(1, "prepare-signup", "succeeded"),
      event(3, "launch-logto-signup", "started"), event(3, "launch-logto-signup", "aborted"), event(3, "launch-logto-signup", "stale"),
      event(1, "bind-subject", "started"), event(1, "bind-subject", "succeeded"),
    ]);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageARepeatedOperationWithinEpoch, pageBTrace: pageB, pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
    const pageBMismatchedPreviewPair = assertRedactedCoordinatorTrace([
      event(1, "preview-claim", "started"), event(1, "preview-claim", "succeeded"),
      event(1, "preview-claim", "started"), event(2, "preview-claim", "failed"),
    ]);
    expect(() => assertD508TwoTabReissueContract({
      pageATrace: pageA, pageBTrace: pageBMismatchedPreviewPair, pageCTrace: pageC,
      pageBReservationDelta: { preview: 0, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedRefreshDelta: { preview: 1, prepareAuth: 0, bind: 0, completeProfile: 0 },
      pageBRevokedPreview404s: 1, pageAOidcRequests: 1,
      evidence: {
        pageAAndBHaveSessionOnlyCustody: true,
        pageAClosedAndPageBReportedControllerReissueGuidance: true,
        staleCustodyClearedBeforeSecondRefresh: true,
        controllerReplacementRevokedAAndRetainedReservation: true,
        sameSubjectResumedWithoutHandleOrOidc: true,
      },
    })).toThrow(D508QualificationError);
  });

  test("accepts only the frozen redacted controller-install acknowledgement", () => {
    expect(() => assertD508ControllerInstallResponse({ schemaVersion: 1, state: "claim-active" })).not.toThrow();
    expect(() => assertD508ControllerInstallResponse({ schemaVersion: 1, state: "claim-active", extra: true })).toThrow();
    expect(() => assertD508ControllerInstallResponse({ schemaVersion: 1, state: "owner-bound" })).toThrow();
  });

  test("selects the live reservation while retaining a revoked controller-claim history row", () => {
    const now = new Date("2026-08-08T12:00:00.000Z");
    expect(selectD508LiveProfileReservation([
      {
        usedCount: 0,
        revokedAt: new Date("2026-08-08T11:59:00.000Z"),
        expiresAt: new Date("2026-08-08T12:10:00.000Z"),
        boundAt: new Date("2026-08-08T11:50:00.000Z"),
        redemptionUserId: "reserved-owner",
        completedAt: null,
      },
      {
        usedCount: 0,
        revokedAt: null,
        expiresAt: new Date("2026-08-08T12:10:00.000Z"),
        boundAt: new Date("2026-08-08T11:59:30.000Z"),
        redemptionUserId: "reserved-owner",
        completedAt: null,
      },
    ], now)).toEqual({ userId: "reserved-owner", reservedAt: Date.parse("2026-08-08T11:59:30.000Z") });
  });

  test("rejects failed or repeated Logto launch attempts with bounded trace evidence", () => {
    const trace = assertRedactedCoordinatorTrace([
      ...["preview-claim", "prepare-signup", "bind-subject", "complete-profile", "navigate-product"].flatMap((commandKind, operationId) => [
        { operationId, phase: "claim", commandKind, result: "started", navigationIntent: commandKind === "navigate-product" ? "product" : null },
        { operationId, phase: "claim", commandKind, result: "succeeded", navigationIntent: commandKind === "navigate-product" ? "product" : null },
      ]),
      { operationId: 5, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 6, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "started", navigationIntent: null },
      { operationId: 6, phase: "awaiting-callback", commandKind: "launch-logto-signup", result: "failed", navigationIntent: null },
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    let failure: unknown;
    try { assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace }); } catch (error) { failure = error; }
    expect(redactedD508FailureReceipt(failure)).toMatchObject({
      code: "browser_trace",
      contractDeltas: [
        { kind: "trace-result", commandKind: "launch-logto-signup", result: "started", expected: 1, actual: 2 },
        { kind: "trace-result", commandKind: "launch-logto-signup", result: "succeeded", expected: 1, actual: 0 },
        { kind: "trace-result", commandKind: "launch-logto-signup", result: "failed", expected: 0, actual: 1 },
        { kind: "trace-operation-cardinality", commandKind: "launch-logto-signup", expected: 1, actual: 2 },
      ],
    });
  });

  test("reports the bounded product trace delta when a final navigation is aborted", () => {
    const trace = assertRedactedCoordinatorTrace([
      ...["preview-claim", "prepare-signup", "launch-logto-signup", "bind-subject", "complete-profile"].flatMap((commandKind, operationId) => [
        { operationId, phase: "claim", commandKind, result: "started", navigationIntent: null },
        { operationId, phase: "claim", commandKind, result: "succeeded", navigationIntent: null },
      ]),
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "started", navigationIntent: "product" },
      { operationId: 5, phase: "showing-recovery", commandKind: "navigate-product", result: "aborted", navigationIntent: "product" },
    ]);
    const requests: Array<{ method: string; origin: "server" | "logto" | "other"; pathname: string }> = [
      "/api/owner-claim/preview", "/api/owner-claim/prepare-auth", "/api/bind-logto-user", "/api/owner-claim/complete-profile",
    ].map((pathname) => ({ method: "POST", origin: "server" as const, pathname }));
    requests.push({ method: "GET", origin: "logto", pathname: "/oidc/auth" });
    let failure: unknown;
    try { assertProductRecoveryRefreshContract({ requests, navigations: [{ origin: "server", pathname: "/" }], trace }); } catch (error) { failure = error; }
    const receipt = redactedD508FailureReceipt(failure);
    expect(receipt).toMatchObject({
      outcome: "failed",
      phase: "browser-capture",
      code: "browser_trace",
      contractDeltas: [
        { kind: "trace-result", commandKind: "navigate-product", result: "succeeded", expected: 1, actual: 0 },
        { kind: "trace-result", commandKind: "navigate-product", result: "aborted", expected: 0, actual: 1 },
      ],
    });
    expect(JSON.stringify(receipt)).not.toContain("claim=");
    expect(JSON.stringify(receipt)).not.toContain("password");
  });

  test("declares recovery and adversarial cases as not run, rather than passing them", () => {
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("tab-loss-reissue");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("wrong-subject");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("expired-claim");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("product-finish");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("recovery-refresh");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("refresh-before-bind");
    expect(D508_NOT_RUN_MATRIX_CASES).toContain("refresh-after-bind-validation");
  });
});
