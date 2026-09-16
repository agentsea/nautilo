import { Stack, router, useLocalSearchParams } from "expo-router";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { ActivityIndicator, Pressable, StyleSheet, Text, TextInput, View } from "react-native";

import {
  initialInviteCeremonyState,
  reduceInviteCeremony,
  failureFromHttpStatus,
  type CeremonyRef,
  type InviteCeremonyState,
} from "@/features/invite-redemption/invite-ceremony";
import {
  handoffSettlementForFailure,
  inviteCustodyFailureView,
  inviteScreenView,
  presentInvitePreview,
  previewExpiryEpoch,
  previewFailureDecision,
  previewForCeremony,
  type InvitePreviewPresentation,
} from "@/features/invite-redemption/invite-preview";
import {
  getInviteIntake,
  inviteRouteFromParams,
} from "@/features/invite-redemption/invite-intake";
import {
  clearInviteCallbackLocator,
  loadInviteHandoff,
  saveInviteHandoff,
  settleInviteHandoff,
} from "@/features/invite-redemption/invite-handoff";
import {
  runInviteEnrollment,
  retainInviteEnrollmentFailure,
  rewindInviteAuthentication,
  validateInviteHandle,
} from "@/features/invite-redemption/invite-enrollment";
import {
  runInviteProfileCompletion,
  validateInviteProfile,
} from "@/features/invite-redemption/invite-profile";
import {
  INVITE_COMPLETION_NOTICE_PARAM,
  resolveInviteLanding,
} from "@/features/invite-redemption/invite-landing";
import { inviteCancelDestination } from "@/features/invite-redemption/invite-cancel";
import { Screen } from "@/components/screen";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { useServers } from "@/providers/server-registry";
import { useAppTheme } from "@/providers/theme";
import type { AppTheme } from "@/theme/tokens";

type IntakeNotice = "invalid" | "persistence-failed" | null;

function noticeFromRouteError(error: string | string[] | undefined): IntakeNotice {
  return error === "invalid-link" ? "invalid" : error === "persistence-failed" ? "persistence-failed" : null;
}

function sameRef(left: CeremonyRef, right: CeremonyRef): boolean {
  return left.generation === right.generation && left.serverId === right.serverId && left.ceremonyId === right.ceremonyId;
}

function stateRef(state: InviteCeremonyState): CeremonyRef | null {
  return "ref" in state ? state.ref : null;
}

/**
 * Native Phase 1 preview. The invite bearer exists only in the narrow async
 * closure between the exact handoff read and one exact-server API call; all
 * rendered output is derived from `inviteScreenView`'s safe model.
 */
export default function InviteScreen() {
  const t = useAppTheme();
  const styles = useMemo(() => createStyles(t), [t]);
  const { activeServer, resolveInviteServer, activateInviteServer } = useServers();
  const { status, viewer, refreshViewer, registerInvite, clearInviteRegistration, signIn, signOut } = useAuth();
  const params = useLocalSearchParams<{
    serverUrl?: string;
    serverId?: string;
    generation?: string;
    ceremonyId?: string;
    error?: string;
  }>();
  const route = inviteRouteFromParams(params);
  const [ceremony, dispatch] = useReducer(reduceInviteCeremony, initialInviteCeremonyState);
  const ceremonyRef = useRef(ceremony);
  ceremonyRef.current = ceremony;
  const authStatusRef = useRef(status);
  authStatusRef.current = status;
  const activeServerRef = useRef(activeServer);
  activeServerRef.current = activeServer;
  const [manualUrl, setManualUrl] = useState("");
  const [handleInput, setHandleInput] = useState("");
  const [handleError, setHandleError] = useState<string | null>(null);
  const [displayNameInput, setDisplayNameInput] = useState("");
  const [pinInput, setPinInput] = useState("");
  const [pinConfirmationInput, setPinConfirmationInput] = useState("");
  const [displayNameError, setDisplayNameError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [profileHandle, setProfileHandle] = useState<string | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<readonly string[] | null>(null);
  const [recoveryCopied, setRecoveryCopied] = useState(false);
  const [recoveryAcknowledged, setRecoveryAcknowledged] = useState(false);
  const [bootstrapAttempt, setBootstrapAttempt] = useState(0);
  const [notice, setNotice] = useState<IntakeNotice>(noticeFromRouteError(params.error));
  const [busy, setBusy] = useState(false);
  const [custodyFailure, setCustodyFailure] = useState(false);
  const [previewPresentation, setPreviewPresentation] = useState<InvitePreviewPresentation | null>(null);
  const confirmationRef = useRef<Parameters<typeof activateInviteServer>[0]["confirmation"] | null>(null);
  const inFlightRef = useRef<string | null>(null);
  const submittedHandleRef = useRef<string | null>(null);
  const profileSubmissionRef = useRef<Readonly<{ displayName: string; pin: string }> | null>(null);
  const profileInFlightRef = useRef<string | null>(null);
  const landingInFlightRef = useRef<string | null>(null);
  const pendingProfileSuccessRef = useRef<Readonly<{
    ref: CeremonyRef;
    recoveryCodes: readonly string[];
    landingRoomId: string | null;
  }> | null>(null);
  const routeBootstrapRef = useRef<string | null>(null);

  const isCurrent = useCallback((ref: CeremonyRef): boolean => {
    const current = stateRef(ceremonyRef.current);
    // `null` is the intentional process-restoration policy: no in-process
    // intake is known, but a persisted exact handoff may still be resumed.
    // `false` is a synchronous replacement fence and must block all work.
    const ownership = getInviteIntake().ceremonyOwnership(ref);
    return current !== null && sameRef(current, ref) && ownership !== false;
  }, []);

  const settleSafely = useCallback(async (ref: CeremonyRef, reason: Parameters<typeof settleInviteHandoff>[1]): Promise<boolean> => {
    if (!isCurrent(ref)) return false;
    try {
      const intake = getInviteIntake();
      const ownership = intake.ceremonyOwnership(ref);
      if (ownership === true) {
        const result = await intake.settle(ref, reason);
        if (result === "replaced") return false;
        if (result === "cleared" || (reason === "retryable-network" && result === "retained")) return isCurrent(ref);
      }
      if (!isCurrent(ref)) return false;
      // This process has no active intake record (for example, restored
      // navigation after process death), so there is no queued writer to
      // coordinate with. The bounded handoff remains safe to settle directly.
      const result = await settleInviteHandoff(ref.serverId, reason);
      if (result === "cleared" && route) {
        await clearInviteCallbackLocator({
          serverId: ref.serverId,
          serverUrl: route.serverUrl,
          generation: String(ref.generation),
          ceremonyId: ref.ceremonyId,
        });
      }
      return (result === "cleared" || (reason === "retryable-network" && result === "retained")) && isCurrent(ref);
    } catch {
      if (isCurrent(ref)) setCustodyFailure(true);
      return false;
    }
  }, [isCurrent, route?.serverUrl]);

  const settleFailure = useCallback(async (ref: CeremonyRef, code: Parameters<typeof handoffSettlementForFailure>[0]) => {
    return settleSafely(ref, handoffSettlementForFailure(code));
  }, [settleSafely]);

  const publishPendingProfileSuccess = useCallback(async (ref: CeremonyRef): Promise<boolean> => {
    const pending = pendingProfileSuccessRef.current;
    if (!pending || !sameRef(pending.ref, ref) || !isCurrent(ref)) {
      if (!isCurrent(ref)) pendingProfileSuccessRef.current = null;
      return false;
    }
    if (!await settleSafely(ref, "success")) {
      if (!isCurrent(ref)) pendingProfileSuccessRef.current = null;
      else setCustodyFailure(true);
      return false;
    }
    if (!isCurrent(ref) || pendingProfileSuccessRef.current !== pending) {
      pendingProfileSuccessRef.current = null;
      return false;
    }
    pendingProfileSuccessRef.current = null;
    profileSubmissionRef.current = null;
    setPinInput("");
    setPinConfirmationInput("");
    if (pending.recoveryCodes.length > 0) {
      setRecoveryCodes(pending.recoveryCodes);
      setRecoveryCopied(false);
      setRecoveryAcknowledged(false);
    } else {
      setRecoveryCodes(null);
      setRecoveryAcknowledged(false);
    }
    dispatch({
      type: "profile.complete.succeeded",
      ref,
      hasRecoveryMaterial: pending.recoveryCodes.length > 0,
      landingRoomId: pending.landingRoomId,
    });
    return true;
  }, [isCurrent, settleSafely]);

  useEffect(() => {
    const routeNotice = noticeFromRouteError(params.error);
    if (routeNotice) setNotice(routeNotice);
  }, [params.error]);

  useEffect(() => {
    if (route || noticeFromRouteError(params.error)) return;
    // Expo Router also observes custom-scheme URLs. On a warm Android launch
    // it may navigate `nautilo://invite?...` to this screen without params
    // after the root coordinator has already put the bearer in SecureStore.
    // Recover only that coordinator-owned, token-free correlation route; this
    // screen never parses the URL, reads the bearer, or installs a listener.
    const activeRoute = getInviteIntake().activeRoute();
    if (activeRoute) router.replace(activeRoute);
  }, [params.error, route?.ceremonyId, route?.generation, route?.serverId, route?.serverUrl]);

  useEffect(() => {
    if (!route) return;
    const ref: CeremonyRef = {
      serverId: route.serverId,
      generation: Number(route.generation),
      ceremonyId: route.ceremonyId,
    };
    const key = `${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (routeBootstrapRef.current === key) return;
    routeBootstrapRef.current = key;
    setPreviewPresentation(null);
    setCustodyFailure(false);
    confirmationRef.current = null;
    setNotice(null);
    let cancelled = false;
    void (async () => {
      // Process restoration must inspect the verified exact-server handoff
      // *before* the normal locator transition. Accepting first would enter
      // previewing, whose strict stage check would correctly—but wrongly for
      // a PKCE return—erase an external-auth/binding record.
      let handoff;
      try {
        handoff = await loadInviteHandoff({ serverId: ref.serverId, serverUrl: route.serverUrl });
      } catch {
        if (!cancelled) {
          // Leave no cached success latch behind a transient SecureStore read
          // failure. The safe custody card can explicitly retry this same
          // exact route; it never falls through to preview and guesses.
          routeBootstrapRef.current = null;
          setCustodyFailure(true);
        }
        return;
      }
      if (cancelled) return;
      if (handoff && handoff.stage !== "preview") {
        dispatch({ type: "handoff.hydrated", ref, serverUrl: route.serverUrl, stage: handoff.stage });
        return;
      }
      dispatch({ type: "locator.accepted", ref, serverUrl: route.serverUrl });
    })();
    return () => {
      cancelled = true;
    };
  }, [route?.serverUrl, route?.serverId, route?.generation, route?.ceremonyId, bootstrapAttempt]);

  useEffect(() => {
    if (ceremony.kind !== "probing-server") {
      if (inFlightRef.current?.startsWith("probe:")) inFlightRef.current = null;
      return;
    }
    const { ref, serverUrl } = ceremony;
    const key = `probe:${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;
    void (async () => {
      const result = await resolveInviteServer({ ref, serverUrl }, isCurrent);
      if (!isCurrent(ref)) return;
      switch (result.kind) {
        case "known-active":
          dispatch({ type: "server.probe.succeeded", ref, serverUrl, knownServer: true, alreadyActive: true });
          return;
        case "known-inactive":
          dispatch({ type: "server.probe.succeeded", ref, serverUrl, knownServer: true, alreadyActive: false });
          return;
        case "requires-confirmation":
          confirmationRef.current = result;
          dispatch({ type: "server.probe.succeeded", ref, serverUrl, knownServer: false, alreadyActive: false });
          return;
        case "unreachable":
          dispatch({ type: "server.probe.failed", ref, failure: "server-unreachable" });
          return;
        case "invalid-locator":
          dispatch({ type: "server.probe.failed", ref, failure: "invalid-locator" });
          return;
        case "server-mismatch":
          if (!await settleFailure(ref, "server-mismatch")) return;
          dispatch({ type: "server.mismatch", ref });
          return;
        case "stale":
          return;
      }
    })();
  }, [ceremony, isCurrent, resolveInviteServer]);

  useEffect(() => {
    if (ceremony.kind !== "activating-server") {
      if (inFlightRef.current?.startsWith("activate:")) inFlightRef.current = null;
      return;
    }
    const { ref, serverUrl, operation } = ceremony;
    const key = `activate:${ref.generation}:${ref.serverId}:${ref.ceremonyId}:${operation}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;
    void (async () => {
      const confirmation = operation === "add" ? confirmationRef.current : undefined;
      const result = await activateInviteServer({ ref, serverUrl, operation, ...(confirmation ? { confirmation } : {}) }, isCurrent);
      if (!isCurrent(ref)) return;
      switch (result.kind) {
        case "activated":
          confirmationRef.current = null;
          dispatch({ type: "server.activation.succeeded", ref });
          return;
        case "server-mismatch":
          if (await settleFailure(ref, "server-mismatch")) dispatch({ type: "server.mismatch", ref });
          return;
        case "stale":
          return;
        case "server-removed":
        case "requires-resolution":
        case "unreachable":
          // The existing reducer maps these exact-server registry outcomes to
          // its truthful verify/retry card; it never turns a removed record
          // into an implicit add.
          dispatch({ type: "server.activation.failed", ref, failure: "server-unreachable" });
          return;
      }
    })();
  }, [activateInviteServer, ceremony, isCurrent, settleFailure]);

  useEffect(() => {
    if (ceremony.kind !== "previewing") {
      if (inFlightRef.current?.startsWith("preview:")) inFlightRef.current = null;
      return;
    }
    const { ref, serverUrl } = ceremony;
    const key = `preview:${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;
    void (async () => {
      const handoff = await loadInviteHandoff({ serverId: ref.serverId, serverUrl });
      if (!isCurrent(ref)) return;
      if (!handoff || handoff.stage !== "preview") {
        if (await settleSafely(ref, "terminal-failure")) dispatch({ type: "preview.failed", ref, failure: { status: 422 } });
        return;
      }
      try {
        // This is the only preview request in the mobile flow. Its base URL is
        // the active, exact registry record proven by the prior activation.
        const apiPreview = await getApiClient(serverUrl).previewInvite(handoff.inviteToken);
        if (!isCurrent(ref)) return;
        if (!apiPreview) {
          if (await settleSafely(ref, "terminal-failure")) dispatch({ type: "preview.failed", ref, failure: { status: 404 } });
          return;
        }
        const expiry = previewExpiryEpoch(apiPreview.expiresAt);
        // A preview from a correctly behaving server cannot carry a past or
        // malformed expiry. Treat one as terminal rather than extending a
        // bearer handoff beyond the server's stated lifetime.
        if (apiPreview.expiresAt !== null && expiry === null) {
          if (await settleSafely(ref, "expiry")) dispatch({ type: "preview.failed", ref, failure: { status: 410 } });
          return;
        }
        try {
          if (!isCurrent(ref)) return;
          await saveInviteHandoff({
            serverId: handoff.serverId,
            serverUrl: handoff.serverUrl,
            inviteToken: handoff.inviteToken,
            prepareState: null,
            handle: null,
            stage: "preview",
            startedAt: handoff.startedAt,
            inviteExpiresAt: expiry,
          });
        } catch {
          if (isCurrent(ref)) {
            if (await settleSafely(ref, "terminal-failure")) dispatch({ type: "preview.failed", ref, failure: { status: 422 } });
          }
          return;
        }
        if (!isCurrent(ref)) return;
        setPreviewPresentation(presentInvitePreview(apiPreview));
        dispatch({ type: "preview.succeeded", ref, preview: previewForCeremony(apiPreview), signedIn: authStatusRef.current === "signed-in" });
      } catch (error) {
        const decision = previewFailureDecision(error);
        if (!isCurrent(ref)) return;
        if (await settleFailure(ref, decision.code)) dispatch({ type: "preview.failed", ref, failure: decision.failure });
      }
    })();
  }, [ceremony, isCurrent, settleFailure]);

  useEffect(() => {
    if (ceremony.kind !== "preparing" && ceremony.kind !== "external-auth" && ceremony.kind !== "binding") {
      if (inFlightRef.current?.startsWith("enrollment:")) inFlightRef.current = null;
      return;
    }
    const { ref, serverUrl } = ceremony;
    const start = ceremony.kind === "preparing"
      ? "prepare"
      : ceremony.kind === "external-auth"
        ? "authenticate"
        : "bind";
    // One in-flight spine owns every reducer phase for this ref. The reducer
    // may re-render from preparing → external-auth → binding while the same
    // async run is still alive; phase-specific keys would double-call Logto.
    const key = `enrollment:${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (inFlightRef.current === key) return;
    inFlightRef.current = key;

    void (async () => {
      const result = await runInviteEnrollment({
        ref,
        serverUrl,
        start,
        handle: start === "prepare" ? submittedHandleRef.current : null,
      }, {
        isCurrent,
        loadHandoff: (server) => loadInviteHandoff(server),
        saveHandoff: (handoff) => saveInviteHandoff(handoff),
        prepare: (inviteToken, input) => getApiClient(serverUrl).prepareLogtoSignup(inviteToken, input),
        authenticate: ({ serverId, serverUrl: exactServerUrl, handle }) => registerInvite({
          serverId,
          serverUrl: exactServerUrl,
          handle,
          isCurrent: () => isCurrent(ref),
        }),
        bind: (input) => getApiClient(serverUrl).bindLogtoUser(input),
        onPrepared: () => dispatch({ type: "prepare.succeeded", ref }),
        onAuthenticated: () => dispatch({ type: "auth.succeeded", ref }),
      });
      if (!isCurrent(ref)) return;
      switch (result.kind) {
        case "bound":
          dispatch({ type: "bind.succeeded", ref });
          // Binding creates the local Human. Only now may the provider ask
          // whoami and converge its cached identity/status.
          void refreshViewer();
          return;
        case "prepare-failed":
          if (!retainInviteEnrollmentFailure(result.failure, "prepare") && !await settleFailure(ref, typeof result.failure === "string" ? result.failure : failureFromHttpStatus(result.failure.status, "prepare", result.failure.errorCode).code)) return;
          dispatch({ type: "prepare.failed", ref, failure: result.failure });
          return;
        case "auth-failed":
          if (result.failure === "server-mismatch") {
            if (await settleFailure(ref, "server-mismatch")) dispatch({ type: "server.mismatch", ref });
          } else if (result.failure === "auth-cancelled") {
            dispatch({ type: "auth.cancelled", ref });
          } else {
            if (!retainInviteEnrollmentFailure(result.failure, "authenticate") && !await settleFailure(ref, typeof result.failure === "string" ? result.failure : failureFromHttpStatus(result.failure.status, "authenticate", result.failure.errorCode).code)) return;
            dispatch({ type: "auth.failed", ref, failure: result.failure });
          }
          return;
        case "bind-failed":
          if (!retainInviteEnrollmentFailure(result.failure, "bind") && !await settleFailure(ref, typeof result.failure === "string" ? result.failure : failureFromHttpStatus(result.failure.status, "bind", result.failure.errorCode).code)) return;
          dispatch({ type: "bind.failed", ref, failure: result.failure });
          return;
        case "stale":
          return;
      }
    })();
  }, [ceremony, isCurrent, refreshViewer, registerInvite, settleFailure]);

  useEffect(() => {
    if (ceremony.kind !== "profile") {
      setProfileHandle(null);
      return;
    }
    const { ref, serverUrl } = ceremony;
    let cancelled = false;
    void (async () => {
      try {
        const handoff = await loadInviteHandoff({ serverId: ref.serverId, serverUrl });
        if (cancelled || !isCurrent(ref)) return;
        if (!handoff || handoff.stage !== "profile" || !handoff.handle) {
          setCustodyFailure(true);
          return;
        }
        const validated = validateInviteHandle(handoff.handle);
        if (!validated.valid) {
          setCustodyFailure(true);
          return;
        }
        setProfileHandle(validated.handle);
      } catch {
        if (!cancelled && isCurrent(ref)) setCustodyFailure(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ceremony, isCurrent]);

  useEffect(() => {
    if (ceremony.kind !== "completing-profile") {
      profileInFlightRef.current = null;
      return;
    }
    const { ref, serverUrl } = ceremony;
    const submission = profileSubmissionRef.current;
    const key = `profile:${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (!submission || profileInFlightRef.current === key) return;
    profileInFlightRef.current = key;

    void (async () => {
      const result = await runInviteProfileCompletion({
        ref,
        serverUrl,
        displayName: submission.displayName,
        pin: submission.pin,
      }, {
        isCurrent,
        loadHandoff: (server) => loadInviteHandoff(server),
        complete: (inviteToken, input) => getApiClient(serverUrl).completeInviteProfile(inviteToken, input),
      });
      if (!isCurrent(ref)) return;
      if (result.kind === "completed") {
        // A failed deletion retry never calls complete-profile again. The
        // one-time response remains only in this non-rendered memory seam.
        pendingProfileSuccessRef.current = {
          ref,
          recoveryCodes: result.recoveryCodes,
          landingRoomId: result.landingRoomId,
        };
        await publishPendingProfileSuccess(ref);
        return;
      }
      if (result.kind === "stale") return;
      const mapped = typeof result.failure === "string"
        ? { code: result.failure, recovery: result.failure, retryStage: null }
        : failureFromHttpStatus(result.failure.status, "complete-profile", result.failure.errorCode);
      const retain = mapped.recovery === "edit-profile" || mapped.recovery === "sign-in-again"
        || handoffSettlementForFailure(mapped.code) === "retryable-network";
      if (!retain) {
        profileSubmissionRef.current = null;
        setDisplayNameInput("");
        setPinInput("");
        setPinConfirmationInput("");
        if (!await settleFailure(ref, mapped.code)) return;
      }
      dispatch({ type: "profile.complete.failed", ref, failure: result.failure });
    })();
  }, [ceremony, isCurrent, publishPendingProfileSuccess, settleFailure]);

  useEffect(() => {
    if (ceremony.kind !== "success") {
      landingInFlightRef.current = null;
      return;
    }
    const { ref, landingRoomId } = ceremony;
    const key = `landing:${ref.generation}:${ref.serverId}:${ref.ceremonyId}`;
    if (landingInFlightRef.current === key) return;
    landingInFlightRef.current = key;
    void (async () => {
      const destination = await resolveInviteLanding({
        ceremonyServerId: ref.serverId,
        landingRoomId,
      }, {
        getActiveServer: () => activeServerRef.current,
        refreshViewer: async () => (await refreshViewer()) === "verified",
        listRooms: (serverUrl) => getApiClient(serverUrl).listRooms(),
      });
      if (!isCurrent(ref)) return;
      if (destination.kind === "room" && activeServerRef.current?.id === ref.serverId) {
        router.replace(`/chat/${destination.roomId}`);
        return;
      }
      // This route-only correlation is the whole notice contract. It contains
      // no invite/profile/recovery material and the Chats screen consumes it
      // once without storing it in either device persistence backend.
      router.replace({
        pathname: "/(drawer)/(tabs)",
        params: { inviteNotice: INVITE_COMPLETION_NOTICE_PARAM },
      });
    })();
  }, [ceremony, isCurrent, refreshViewer]);

  useEffect(() => {
    if (ceremony.kind !== "cancelled") return;
    const { ref, destination } = ceremony;
    void (async () => {
      if (await settleSafely(ref, "cancelled")) {
        router.replace(destination === "app" ? "/(drawer)/(tabs)" : "/(onboarding)/add-server");
      }
    })();
  }, [ceremony, settleSafely]);

  async function submitManualUrl() {
    setBusy(true);
    setNotice(null);
    const result = await getInviteIntake().acceptRaw(manualUrl, "manual", (next) => router.replace(next));
    setBusy(false);
    if (result.kind === "accepted" || result.kind === "duplicate") {
      setManualUrl("");
      return;
    }
    setNotice(result.kind === "persistence-failed" ? "persistence-failed" : "invalid");
  }

  async function cancel() {
    if (busy) return;
    setBusy(true);
    setCustodyFailure(false);
    pendingProfileSuccessRef.current = null;
    setRecoveryCodes(null);
    setRecoveryCopied(false);
    setRecoveryAcknowledged(false);
    try {
      const ref = stateRef(ceremony);
      if (ref && !await settleSafely(ref, "cancelled")) return;
      const destination = inviteCancelDestination(ceremony, {
        authStatus: status,
        activeServerId: activeServer?.id ?? null,
      });
      router.replace(destination === "app" ? "/(drawer)/(tabs)" : "/(onboarding)/add-server");
    } catch {
      // `settleSafely` owns known custody errors. This catches only a
      // future unexpected local interruption without leaking it or navigating.
      setCustodyFailure(true);
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    if (custodyFailure) {
      const pending = pendingProfileSuccessRef.current;
      if (pending && isCurrent(pending.ref)) {
        setCustodyFailure(false);
        await publishPendingProfileSuccess(pending.ref);
        return;
      }
      pendingProfileSuccessRef.current = null;
      routeBootstrapRef.current = null;
      setCustodyFailure(false);
      setBootstrapAttempt((attempt) => attempt + 1);
      return;
    }
    if (ceremony.kind !== "failure") return;
    const { ref, recovery, retryStage } = ceremony;
    if (recovery === "enter-full-invite-url" || recovery === "start-over" || recovery === "request-new-invite") {
      if (await settleSafely(ref, "terminal-failure")) router.replace("/(onboarding)/invite");
      return;
    }
    if (recovery === "sign-in-again") {
      if (retryStage === "complete-profile") {
        const error = await signIn();
        if (!error && isCurrent(ref)) dispatch({ type: "retry", ref });
        return;
      }
      const result = await rewindInviteAuthentication({ ref, serverUrl: ceremony.serverUrl ?? "" }, {
        isCurrent,
        loadHandoff: (server) => loadInviteHandoff(server),
        saveHandoff: (handoff) => saveInviteHandoff(handoff),
        clearAuthentication: clearInviteRegistration,
      });
      if (result === "rewound" && isCurrent(ref)) {
        dispatch({ type: "retry", ref });
      } else if (result === "server-mismatch") {
        if (await settleFailure(ref, "server-mismatch")) dispatch({ type: "server.mismatch", ref });
      } else if (result === "custody-failed" && isCurrent(ref)) {
        setCustodyFailure(true);
      }
      return;
    }
    if (recovery === "edit-handle") {
      try {
        const handoff = await loadInviteHandoff({ serverId: ref.serverId, serverUrl: ceremony.serverUrl ?? "" });
        if (!isCurrent(ref) || !handoff) return;
        // Drop an invalid opaque state while retaining the one invite bearer
        // in SecureStore. The next handle submit prepares a new state without
        // replaying preview or moving either secret through UI state.
        await saveInviteHandoff({
          serverId: handoff.serverId,
          serverUrl: handoff.serverUrl,
          inviteToken: handoff.inviteToken,
          prepareState: null,
          handle: null,
          stage: "preview",
          startedAt: handoff.startedAt,
          inviteExpiresAt: handoff.expiresAt,
        });
        if (isCurrent(ref)) dispatch({ type: "retry", ref });
      } catch {
        if (isCurrent(ref)) setCustodyFailure(true);
      }
      return;
    }
    if (isCurrent(ref)) dispatch({ type: "retry", ref });
  }

  function confirmServer() {
    if (ceremony.kind === "confirm-server" && isCurrent(ceremony.ref)) {
      dispatch({ type: "server.add.requested", ref: ceremony.ref });
    }
  }

  function keepCurrentAccount() {
    if (ceremony.kind === "signed-in-boundary" && isCurrent(ceremony.ref)) {
      dispatch({ type: "account.keep-current", ref: ceremony.ref });
    }
  }

  async function switchAccount() {
    if (busy || ceremony.kind !== "signed-in-boundary" || !isCurrent(ceremony.ref)) return;
    setBusy(true);
    try {
      await signOut();
      if (isCurrent(ceremony.ref)) dispatch({ type: "account.switched", ref: ceremony.ref });
    } finally {
      setBusy(false);
    }
  }

  function submitHandle() {
    if (ceremony.kind !== "preview" || !isCurrent(ceremony.ref)) return;
    const validated = validateInviteHandle(handleInput);
    if (!validated.valid) {
      setHandleError(validated.message);
      return;
    }
    submittedHandleRef.current = validated.handle;
    setHandleInput(validated.handle);
    setHandleError(null);
    dispatch({ type: "prepare.requested", ref: ceremony.ref });
  }

  function submitProfile() {
    if (ceremony.kind !== "profile" || !isCurrent(ceremony.ref)) return;
    const validated = validateInviteProfile(displayNameInput, pinInput, pinConfirmationInput);
    setDisplayNameInput(validated.displayName);
    setDisplayNameError(validated.displayNameError);
    setPinError(validated.pinError);
    if (!validated.valid) return;
    profileSubmissionRef.current = { displayName: validated.displayName, pin: pinInput };
    dispatch({ type: "profile.submit.requested", ref: ceremony.ref });
  }

  async function copyRecoveryCodes() {
    if (!recoveryCodes || recoveryCodes.length === 0) return;
    try {
      await Clipboard.setStringAsync(recoveryCodes.join("\n"));
      setRecoveryCopied(true);
    } catch {
      setRecoveryCopied(false);
    }
  }

  function acknowledgeRecoveryCodes() {
    if (ceremony.kind !== "recovery-acknowledgement" || !recoveryCodes || !recoveryAcknowledged || !isCurrent(ceremony.ref)) return;
    setRecoveryCodes(null);
    setRecoveryCopied(false);
    setRecoveryAcknowledged(false);
    dispatch({ type: "recovery.acknowledged", ref: ceremony.ref });
  }

  const ceremonyServerUrl = "serverUrl" in ceremony ? ceremony.serverUrl : null;
  const view = custodyFailure
    ? inviteCustodyFailureView(ceremonyServerUrl)
    : inviteScreenView(ceremony, previewPresentation, viewer?.handle ?? viewer?.displayName ?? null);
  const manual = view.kind === "manual";
  const serverDomain = "serverDomain" in view ? view.serverDomain : null;
  const showCancel = ceremony.kind !== "recovery-acknowledgement" && ceremony.kind !== "completing-profile";

  return (
    <Screen contentStyle={styles.content}>
      <Stack.Screen options={{ title: "Join Nautilo" }} />
      {view.kind !== "failure" ? (
        <>
          {serverDomain ? <Text style={styles.domain}>{serverDomain}</Text> : null}
          <Text style={styles.title}>{view.title}</Text>
          <Text style={styles.sub}>{view.body}</Text>
        </>
      ) : null}

      {view.kind === "loading" ? <ActivityIndicator color={t.color.action.primaryBg} /> : null}

      {view.kind === "confirm-server" ? (
        <Pressable style={styles.button} onPress={confirmServer}>
          <Text style={styles.buttonText}>Connect and continue</Text>
        </Pressable>
      ) : null}

      {view.kind === "preview" || view.kind === "signed-in-boundary" ? (
        <View style={styles.card}>
          {view.inviterLine ? <Text style={styles.inviter}>{view.inviterLine}</Text> : null}
          {view.advisories.map((advisory) => <Text key={advisory.label} style={styles.advisory}>{advisory.label}: {advisory.value}</Text>)}
          {view.kind === "signed-in-boundary" && view.viewerLine ? <Text style={styles.boundary}>{view.viewerLine}</Text> : null}
        </View>
      ) : null}

      {view.kind === "signed-in-boundary" ? (
        <>
          <Pressable style={[styles.button, busy && styles.buttonDisabled]} disabled={busy} onPress={() => void switchAccount()}>
            {busy ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.buttonText}>Switch account</Text>}
          </Pressable>
          <Pressable style={styles.secondaryButton} disabled={busy} onPress={keepCurrentAccount}>
            <Text style={styles.secondaryButtonText}>Keep current account</Text>
          </Pressable>
        </>
      ) : null}

      {view.kind === "preview" ? (
        <>
          <TextInput
            style={styles.input}
            value={handleInput}
            onChangeText={(value) => {
              setHandleInput(value);
              if (handleError) setHandleError(null);
            }}
            placeholder="Choose a handle"
            placeholderTextColor={t.color.text.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            autoComplete="username-new"
            textContentType="username"
            editable={!busy}
            onSubmitEditing={submitHandle}
            returnKeyType="go"
          />
          {handleError ? <Text style={styles.error}>{handleError}</Text> : null}
          <Pressable style={[styles.button, (!handleInput.trim() || busy) && styles.buttonDisabled]} disabled={!handleInput.trim() || busy} onPress={submitHandle}>
            <Text style={styles.buttonText}>Continue to secure sign-up</Text>
          </Pressable>
        </>
      ) : null}

      {view.kind === "profile" ? (
        <>
          <View style={styles.profileHandle}>
            <Text style={styles.profileHandleLabel}>Joining as</Text>
            <Text style={styles.profileHandleValue}>{profileHandle ? `@${profileHandle}` : "Loading handle…"}</Text>
          </View>
          <TextInput
            style={styles.input}
            value={displayNameInput}
            onChangeText={(value) => {
              setDisplayNameInput(value);
              if (displayNameError) setDisplayNameError(null);
            }}
            placeholder="Display name"
            placeholderTextColor={t.color.text.disabled}
            autoCapitalize="words"
            autoCorrect={false}
            textContentType="name"
            accessibilityLabel="Display name"
            editable={!busy}
            returnKeyType="next"
          />
          {displayNameError ? <Text accessibilityRole="alert" style={styles.error}>{displayNameError}</Text> : null}
          <TextInput
            style={styles.input}
            value={pinInput}
            onChangeText={(value) => {
              setPinInput(value);
              if (pinError) setPinError(null);
            }}
            placeholder="Choose a 6–8 digit PIN"
            placeholderTextColor={t.color.text.disabled}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={8}
            secureTextEntry
            textContentType="newPassword"
            accessibilityLabel="Choose a 6 to 8 digit PIN"
            editable={!busy}
            returnKeyType="next"
          />
          <TextInput
            style={styles.input}
            value={pinConfirmationInput}
            onChangeText={(value) => {
              setPinConfirmationInput(value);
              if (pinError) setPinError(null);
            }}
            placeholder="Confirm your PIN"
            placeholderTextColor={t.color.text.disabled}
            keyboardType="number-pad"
            inputMode="numeric"
            maxLength={8}
            secureTextEntry
            textContentType="newPassword"
            accessibilityLabel="Confirm your PIN"
            editable={!busy}
            onSubmitEditing={submitProfile}
            returnKeyType="go"
          />
          {pinError ? <Text accessibilityRole="alert" style={styles.error}>{pinError}</Text> : null}
          <Pressable style={[styles.button, (busy || !profileHandle) && styles.buttonDisabled]} disabled={busy || !profileHandle} onPress={submitProfile}>
            <Text style={styles.buttonText}>Finish joining</Text>
          </Pressable>
        </>
      ) : null}

      {view.kind === "recovery" && recoveryCodes ? (
        <View style={styles.card}>
          <Text style={styles.recoveryCodes}>{recoveryCodes.join("\n")}</Text>
          <Pressable style={styles.secondaryButton} onPress={() => void copyRecoveryCodes()}>
            <Text style={styles.secondaryButtonText}>{recoveryCopied ? "Copied" : "Copy codes"}</Text>
          </Pressable>
          <Pressable
            accessibilityLabel="I saved these somewhere safe"
            accessibilityRole="checkbox"
            accessibilityState={{ checked: recoveryAcknowledged }}
            style={styles.recoveryAcknowledgement}
            onPress={() => setRecoveryAcknowledged((acknowledged) => !acknowledged)}
          >
            <Text style={styles.secondaryButtonText}>{recoveryAcknowledged ? "☑" : "☐"} I saved these somewhere safe</Text>
          </Pressable>
          <Pressable style={[styles.button, !recoveryAcknowledged && styles.buttonDisabled]} disabled={!recoveryAcknowledged} onPress={acknowledgeRecoveryCodes}>
            <Text style={styles.buttonText}>Continue to Nautilo</Text>
          </Pressable>
        </View>
      ) : null}

      {view.kind === "failure" ? (
        <View style={styles.errorCard}>
          {view.serverDomain ? <Text style={styles.domain}>{view.serverDomain}</Text> : null}
          <Text style={styles.errorTitle}>{view.title}</Text>
          <Text style={styles.sub}>{view.body}</Text>
          <Pressable
            style={[styles.button, view.primaryDisabled && styles.buttonDisabled]}
            disabled={view.primaryDisabled}
            onPress={() => void recover()}
          >
            <Text style={styles.buttonText}>{view.primaryLabel}</Text>
          </Pressable>
        </View>
      ) : null}

      {manual ? (
        <>
          <TextInput
            style={styles.input}
            value={manualUrl}
            onChangeText={setManualUrl}
            placeholder="https://your-server.example/redeem/..."
            placeholderTextColor={t.color.text.disabled}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            inputMode="url"
            editable={!busy}
            onSubmitEditing={() => void submitManualUrl()}
            returnKeyType="go"
          />
          {notice === "invalid" ? <Text style={styles.error}>Enter the complete invite link from your invitation.</Text> : null}
          {notice === "persistence-failed" ? <Text style={styles.error}>We couldn't safely save this invite. Try again.</Text> : null}
          <Pressable style={[styles.button, (busy || !manualUrl.trim()) && styles.buttonDisabled]} disabled={busy || !manualUrl.trim()} onPress={() => void submitManualUrl()}>
            {busy ? <ActivityIndicator color={t.color.text.onPrimary} /> : <Text style={styles.buttonText}>Continue</Text>}
          </Pressable>
        </>
      ) : null}

      {showCancel ? (
        <Pressable onPress={() => void cancel()} disabled={busy} style={styles.cancel}>
          <Text style={styles.cancelText}>Cancel</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}

function createStyles(t: AppTheme) {
  return StyleSheet.create({
    // Center short invitation states but retain `Screen`'s keyboard-aware
    // scroll container for the profile and recovery forms on small devices.
    content: { justifyContent: "center" },
    domain: { ...t.typography.caption, color: t.color.text.muted },
    title: { ...t.typography.title, color: t.color.text.foreground },
    sub: { ...t.typography.body, color: t.color.text.muted },
    input: { ...t.typography.body, color: t.color.text.foreground, borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.lg },
    card: { borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.md, padding: t.spacing.lg, gap: t.spacing.sm },
    inviter: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    advisory: { ...t.typography.body, color: t.color.text.muted },
    boundary: { ...t.typography.body, color: t.color.text.foreground, marginTop: t.spacing.sm },
    profileHandle: { borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.md, gap: t.spacing.xs },
    profileHandleLabel: { ...t.typography.label, color: t.color.text.muted },
    profileHandleValue: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    recoveryCodes: { ...t.typography.bodyStrong, color: t.color.text.foreground, letterSpacing: 1.2 },
    recoveryAcknowledgement: { paddingVertical: t.spacing.sm },
    errorCard: { borderWidth: 1, borderColor: t.color.status.error, borderRadius: t.radii.md, padding: t.spacing.lg, gap: t.spacing.md },
    errorTitle: { ...t.typography.subheading, color: t.color.text.foreground },
    error: { ...t.typography.label, color: t.color.status.error },
    button: { backgroundColor: t.color.action.primaryBg, borderRadius: t.radii.sm, padding: t.spacing.lg, alignItems: "center" },
    buttonDisabled: { opacity: 0.5 },
    buttonText: { ...t.typography.bodyStrong, color: t.color.text.onPrimary },
    secondaryButton: { borderWidth: 1, borderColor: t.color.border.default, borderRadius: t.radii.sm, padding: t.spacing.lg, alignItems: "center" },
    secondaryButtonText: { ...t.typography.bodyStrong, color: t.color.text.foreground },
    cancel: { padding: t.spacing.md, alignItems: "center" },
    cancelText: { ...t.typography.label, color: t.color.brand.accent },
  });
}
