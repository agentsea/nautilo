import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useLocation } from "react-router-dom";
import { ApiError } from "@nautilo/api-client/browser";

import { useAuth } from "../hooks/use-auth";
import { useCan } from "../hooks/use-can";
import { apiClient } from "../lib/api";
import { desktopAPI } from "../lib/desktop";
import {
  getCryptoAdmissionSnapshot,
  registerCryptoAdmissionAccessOwner,
  requestCryptoAdmissionRefresh,
  setCryptoAdmissionAccessState,
  type CryptoAdmissionPolicy,
} from "../lib/crypto-admission-access";
import { useEncryptionReadinessClient } from
  "../contexts/encryption-readiness-context";
import { EncryptedRecoverySection } from
  "../pages/settings/sections/encrypted-recovery-section";
import { EncryptionTransitionCard } from
  "../pages/admin/sections/encryption-transition-card";
import { WorkbenchPortalProvider } from "./workbench-portals";
import { Button } from "../pages/settings/ui";
import { ConnectionRecoveryPortalContext } from "./footer/connection-recovery-portal";

type AdmissionViewState =
  | "checking"
  | "reconnecting"
  | "open"
  | "connect_device"
  | "unsupported"
  | "policy_unavailable"
  | "unavailable";

const RETRY_BASE_MS = 1_000;
const RETRY_CAP_MS = 30_000;

function isRetryable(cause: unknown): boolean {
  return cause instanceof TypeError
    || (cause instanceof ApiError
      && ([408, 425, 429].includes(cause.status) || cause.status >= 500));
}

function retryDelayMs(cause: unknown, attempt: number): number {
  const explicitMs = (cause as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  if (typeof explicitMs === "number" && Number.isFinite(explicitMs) && explicitMs >= 0) {
    return explicitMs;
  }
  const explicitSeconds = (cause as { retryAfterSeconds?: unknown } | null)
    ?.retryAfterSeconds;
  if (
    typeof explicitSeconds === "number"
    && Number.isFinite(explicitSeconds)
    && explicitSeconds >= 0
  ) return explicitSeconds * 1_000;
  return Math.min(RETRY_CAP_MS, RETRY_BASE_MS * (2 ** attempt));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error
    ? cause.message
    : "This device could not be verified.";
}

function isRemovedDevice(cause: unknown): boolean {
  return cause instanceof Error
    && /device_removed_or_stale|device_enrollment_required/u.test(cause.message);
}

function serverOrigin(): string {
  return typeof window === "undefined" ? "this server" : window.location.origin;
}

export function CryptoDeviceAdmissionGate({
  children,
}: Readonly<{ children: ReactNode }>) {
  const auth = useAuth();
  const can = useCan();
  const location = useLocation();
  const readiness = useEncryptionReadinessClient();
  const [state, setState] = useState<AdmissionViewState>("checking");
  const [connectionRecoveryHost, setConnectionRecoveryHost] = useState<HTMLDivElement | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [admittedIdentity, setAdmittedIdentity] = useState<string | null>(null);
  const [resolvedIdentity, setResolvedIdentity] = useState<string | null>(null);
  const [changingServer, setChangingServer] = useState(false);
  const [switchingAccount, setSwitchingAccount] = useState(false);
  const running = useRef<{
    identity: string;
    request: number;
    controller: AbortController;
  } | null>(null);
  const requestGeneration = useRef(0);
  const pendingRefresh = useRef<string | null>(null);
  const retryAttempt = useRef(0);
  const credentialGeneration = useRef(auth.credentialGeneration);
  const retryTimer = useRef<number | null>(null);
  const expiryTimer = useRef<number | null>(null);
  const transportDisconnected = useRef(false);
  const mounted = useRef(false);
  const minimalAdmin = location.pathname === "/admin/encryption";
  const accountIdentity = [
    serverOrigin(),
    auth.viewerGeneration,
    auth.viewer.sessionUserId ?? "signed-out",
    auth.viewer.sessionActorId ?? "no-human",
  ].join(":");
  const retainedForAccount = admittedIdentity !== null
    && admittedIdentity.startsWith(`${accountIdentity}:device:`);
  const effectiveState = resolvedIdentity?.startsWith(`${accountIdentity}:`) === true
    ? state
    : "checking";
  const effectiveMessage = resolvedIdentity?.startsWith(`${accountIdentity}:`) === true
    ? message
    : null;

  const clearRetry = useCallback((): void => {
    if (retryTimer.current !== null) window.clearTimeout(retryTimer.current);
    retryTimer.current = null;
  }, []);
  const clearExpiry = useCallback((): void => {
    if (expiryTimer.current !== null) window.clearTimeout(expiryTimer.current);
    expiryTimer.current = null;
  }, []);

  const settle = useCallback((input: Readonly<{
    nextState: AdmissionViewState;
    identity: string;
    policy: CryptoAdmissionPolicy | null;
    nextMessage?: string | null;
  }>): void => {
    // Once explicitly gated, a network event or an in-flight Retry must not
    // reveal retained content. Only a successful new admission can reopen it.
    if (retainedForAccount && getCryptoAdmissionSnapshot().status === "blocked"
      && (input.nextState === "checking" || input.nextState === "reconnecting")) {
      if (input.nextMessage != null) setMessage(input.nextMessage);
      return;
    }
    const accessStatus = input.nextState === "open"
      ? "open"
      : input.nextState === "checking" || input.nextState === "reconnecting"
      ? (retainedForAccount ? "paused" : "checking")
      : "blocked";
    setCryptoAdmissionAccessState({
      status: accessStatus,
      identity: input.identity,
      policy: input.policy,
    });
    setState(input.nextState);
    setMessage(input.nextMessage ?? null);
    setResolvedIdentity(input.identity);
    if (input.nextState === "open") setAdmittedIdentity(input.identity);
  }, [retainedForAccount]);

  const checkRef = useRef<(reason: string) => void>(() => undefined);
  const refreshRef = useRef<(reason: string) => void>(() => undefined);
  const check = useCallback((reason: string): void => {
    if (!mounted.current || reason === "transport_disconnected") return;
    const identityAtStart = accountIdentity;
    if (running.current !== null) {
      pendingRefresh.current = reason;
      return;
    }
    clearRetry();
    const request = ++requestGeneration.current;
    const controller = new AbortController();
    running.current = { identity: identityAtStart, request, controller };
    pendingRefresh.current = null;
    const stillCurrent = (): boolean => mounted.current
      && requestGeneration.current === request
      && running.current?.request === request
      && running.current.identity === identityAtStart;
    const currentSnapshot = getCryptoAdmissionSnapshot();
    const policyAtStart = currentSnapshot.identity?.startsWith(`${identityAtStart}:`) === true
      ? currentSnapshot.policy
      : null;
    // Refreshing a still-admitted account must not invalidate its requests or
    // make its editor inert. Explicit invalidations already closed the gate.
    if (currentSnapshot.status !== "open"
      || !currentSnapshot.identity?.startsWith(`${identityAtStart}:`)) {
      settle({
        nextState: retainedForAccount ? "reconnecting" : "checking",
        identity: retainedForAccount && admittedIdentity !== null
          ? admittedIdentity
          : `${identityAtStart}:device:checking`,
        policy: policyAtStart,
      });
    }

    void (async () => {
      let policy: CryptoAdmissionPolicy | null = null;
      let apiStep = true;
      try {
        const status = await apiClient.admin.encryptionTransition.getPolicy({
          signal: controller.signal,
        });
        if (!stillCurrent()) return;
        policy = {
          mode: status.policy.mode,
          shadowBehavior: status.policy.shadowBehavior,
        };
        if (getCryptoAdmissionSnapshot().status === "open"
          && (policyAtStart?.mode !== policy.mode
            || policyAtStart.shadowBehavior !== policy.shadowBehavior)) {
          settle({
            nextState: "reconnecting",
            identity: currentSnapshot.identity!,
            policy,
          });
        }
        if (!status.requiresCryptoDevice) {
          clearExpiry();
          retryAttempt.current = 0;
          settle({
            nextState: "open",
            identity: `${identityAtStart}:device:not-required`,
            policy,
          });
          return;
        }
        if (minimalAdmin) {
          settle({
            nextState: "connect_device",
            identity: `${identityAtStart}:device:recovery-route`,
            policy,
          });
          return;
        }
        if (readiness?.signDeviceAdmissionChallenge === undefined) {
          settle({
            nextState: "unsupported",
            identity: `${identityAtStart}:device:unsupported`,
            policy,
            nextMessage: "This client build cannot verify its encryption device.",
          });
          return;
        }
        apiStep = false;
        const deviceId = await readiness.deviceAdmissionDeviceId?.();
        if (!stillCurrent()) return;
        if (deviceId === undefined || deviceId === null) {
          settle({
            nextState: "connect_device",
            identity: `${identityAtStart}:device:missing`,
            policy,
          });
          return;
        }
        const deviceIdentity = `${identityAtStart}:device:${deviceId}`;
        if (admittedIdentity !== null && admittedIdentity !== deviceIdentity) {
          // A local crypto installation switch is an identity boundary, not a
          // refresh of the old device. Destroy the retained subtree before any
          // server result can admit the replacement device.
          setAdmittedIdentity(null);
          setState("checking");
          setMessage(null);
          setResolvedIdentity(deviceIdentity);
          setCryptoAdmissionAccessState({
            status: "checking",
            identity: deviceIdentity,
            policy,
          });
          retryTimer.current = window.setTimeout(
            () => checkRef.current("device_identity_changed"),
            0,
          );
          return;
        }
        if (
          getCryptoAdmissionSnapshot().identity !== deviceIdentity
          && getCryptoAdmissionSnapshot().status !== "open"
        ) {
          setCryptoAdmissionAccessState({
            status: retainedForAccount ? "paused" : "checking",
            identity: deviceIdentity,
            policy,
          });
          setResolvedIdentity(deviceIdentity);
        }
        apiStep = true;
        const admission = await apiClient.deviceAdmission.status({
          signal: controller.signal,
        });
        if (!stillCurrent()) return;
        if (
          admission.status === "admitted"
          && admission.deviceId === deviceId
          && admission.expiresAt > Date.now()
        ) {
          clearExpiry();
          retryAttempt.current = 0;
          settle({ nextState: "open", identity: deviceIdentity, policy });
          const admittedSnapshot = getCryptoAdmissionSnapshot();
          const expiryDelayMs = Math.max(0, admission.expiresAt - Date.now());
          expiryTimer.current = window.setTimeout(() => {
            const current = getCryptoAdmissionSnapshot();
            if (
              current.status === "open"
              && current.identity === deviceIdentity
              && current.generation === admittedSnapshot.generation
            ) requestCryptoAdmissionRefresh("device_admission_expired");
          }, expiryDelayMs);
          return;
        }
        if (
          admission.status === "required"
          && admission.reason === "device_removed_or_stale"
        ) {
          clearExpiry();
          settle({
            nextState: "connect_device",
            identity: deviceIdentity,
            policy,
            nextMessage: "This device is no longer admitted to this server.",
          });
          return;
        }
        // A renewed credential needs a new proof; that does not revoke the
        // same device's existing admission. Its original expiry timer remains
        // active throughout. Other missing/expired admissions close access.
        const renewingCredential = reason === "credential_changed"
          && admission.status === "required"
          && admission.reason === "device_admission_required"
          && getCryptoAdmissionSnapshot().status === "open"
          && getCryptoAdmissionSnapshot().identity === deviceIdentity;
        if (!renewingCredential) {
          settle({ nextState: "reconnecting", identity: deviceIdentity, policy });
        }
        const challenge = await apiClient.deviceAdmission.challenge({
          requestVersion: 1,
          deviceId,
        }, { signal: controller.signal });
        if (!stillCurrent()) return;
        apiStep = false;
        const proof = await readiness.signDeviceAdmissionChallenge(
          challenge.challenge,
        );
        if (!stillCurrent()) return;
        apiStep = true;
        const proved = await apiClient.deviceAdmission.prove({
          requestVersion: 1,
          proof,
        }, { signal: controller.signal });
        if (!stillCurrent()) return;
        if (proved.deviceId !== deviceId) {
          settle({
            nextState: "connect_device",
            identity: deviceIdentity,
            policy,
            nextMessage: "The server admitted a different device. Try connecting this device again.",
          });
          return;
        }
        clearExpiry();
        retryAttempt.current = 0;
        settle({ nextState: "open", identity: deviceIdentity, policy });
        const admittedSnapshot = getCryptoAdmissionSnapshot();
        const expiryDelayMs = Math.max(0, proved.expiresAt - Date.now());
        expiryTimer.current = window.setTimeout(() => {
          const current = getCryptoAdmissionSnapshot();
          if (
            current.status === "open"
            && current.identity === deviceIdentity
            && current.generation === admittedSnapshot.generation
          ) requestCryptoAdmissionRefresh("device_admission_expired");
        }, expiryDelayMs);
      } catch (cause) {
        if (!stillCurrent()) return;
        clearExpiry();
        if (isRemovedDevice(cause)) {
          settle({
            nextState: "connect_device",
            identity: getCryptoAdmissionSnapshot().identity
              ?? `${identityAtStart}:device:unknown`,
            policy,
            nextMessage: errorMessage(cause),
          });
          return;
        }
        if (apiStep && isRetryable(cause)) {
          settle({
            nextState: "reconnecting",
            identity: getCryptoAdmissionSnapshot().identity
              ?? `${identityAtStart}:device:checking`,
            policy: policy ?? policyAtStart,
            nextMessage: errorMessage(cause),
          });
          const backoffDelayMs = retryDelayMs(cause, retryAttempt.current++);
          retryTimer.current = window.setTimeout(
            () => checkRef.current("backoff"),
            backoffDelayMs,
          );
          return;
        }
        if (
          apiStep
          && retainedForAccount
          && cause instanceof ApiError
          && cause.status === 401
        ) {
          // Authentication recovery remains owned by the API/auth layer. A
          // same-account refresh failure pauses protected work without
          // destroying or exposing the retained workspace.
          settle({
            nextState: "reconnecting",
            identity: getCryptoAdmissionSnapshot().identity
              ?? `${identityAtStart}:device:checking`,
            policy: policy ?? policyAtStart,
            nextMessage: errorMessage(cause),
          });
          return;
        }
        settle({
          nextState: policy === null ? "policy_unavailable" : "unavailable",
          identity: getCryptoAdmissionSnapshot().identity
            ?? `${identityAtStart}:device:unknown`,
          policy: policy ?? policyAtStart,
          nextMessage: errorMessage(cause),
        });
      } finally {
        if (running.current?.request === request) {
          running.current = null;
          if (pendingRefresh.current !== null) {
            const pendingReason = pendingRefresh.current;
            pendingRefresh.current = null;
            checkRef.current(pendingReason);
          }
        }
      }
    })();
  }, [
    accountIdentity,
    admittedIdentity,
    clearExpiry,
    clearRetry,
    minimalAdmin,
    readiness,
    retainedForAccount,
    settle,
  ]);
  checkRef.current = check;
  refreshRef.current = (reason: string): void => {
    const current = getCryptoAdmissionSnapshot();
    if (reason === "transport_disconnected") {
      transportDisconnected.current = true;
      if (running.current !== null) {
        requestGeneration.current += 1;
        running.current.controller.abort();
      }
      pendingRefresh.current = null;
      clearRetry();
      clearExpiry();
      if (retainedForAccount && admittedIdentity !== null) {
        settle({
          nextState: "reconnecting",
          identity: admittedIdentity,
          policy: current.policy,
        });
      }
      return;
    }
    if (reason === "device_removed_or_stale") {
      requestGeneration.current += 1;
      running.current?.controller.abort();
      pendingRefresh.current = null;
      clearRetry();
      clearExpiry();
      settle({
        nextState: "connect_device",
        identity: current.identity ?? `${accountIdentity}:device:unknown`,
        policy: current.policy,
        nextMessage: "This device is no longer admitted to this server.",
      });
      return;
    }
    if (reason === "transport_reconnected" || reason === "online") {
      transportDisconnected.current = false;
    } else if (
      transportDisconnected.current
      && reason !== "manual_retry"
      && reason !== "visibility_resume"
      && reason !== "credential_changed"
      && reason !== "device_ready"
      && reason !== "device_admission_required"
      && reason !== "device_admission_expired"
      && reason !== "device_admission_unavailable"
    ) {
      return;
    }
    // A visibility/online observation can share an active or queued check.
    // Do not abort credential renewal or replace its pending reason with one.
    if ((reason === "visibility_resume" || reason === "online")
      && running.current !== null
      && (running.current.request === requestGeneration.current
        || pendingRefresh.current !== null)) return;
    if (running.current !== null) {
      requestGeneration.current += 1;
      running.current.controller.abort();
    }
    checkRef.current(reason);
  };

  useLayoutEffect(() => {
    mounted.current = true;
    requestGeneration.current += 1;
    running.current?.controller.abort();
    pendingRefresh.current = null;
    clearRetry();
    clearExpiry();
    const initialIdentity = `${accountIdentity}:device:checking`;
    setCryptoAdmissionAccessState({
      status: "checking",
      identity: initialIdentity,
      policy: null,
    });
    setState("checking");
    setMessage(null);
    setResolvedIdentity(initialIdentity);
    setAdmittedIdentity((current) => current?.startsWith(`${accountIdentity}:`)
      ? current
      : null);
    checkRef.current("identity_changed");
    return () => {
      mounted.current = false;
      requestGeneration.current += 1;
      running.current?.controller.abort();
      pendingRefresh.current = null;
      clearRetry();
      clearExpiry();
    };
  }, [accountIdentity, clearExpiry, clearRetry]);

  useEffect(() => registerCryptoAdmissionAccessOwner((reason) => {
    refreshRef.current(reason);
  }), []);

  useEffect(() => {
    const wsRejected = (event: Event): void => {
      const reason = (event as CustomEvent<{ reason?: unknown }>).detail?.reason;
      if (typeof reason === "string" && reason.startsWith("device_")) {
        requestCryptoAdmissionRefresh(reason);
      }
    };
    const online = (): void => requestCryptoAdmissionRefresh("online");
    const visible = (): void => {
      if (document.visibilityState === "visible") {
        requestCryptoAdmissionRefresh("visibility_resume");
      }
    };
    window.addEventListener("online", online);
    window.addEventListener("pageshow", online);
    window.addEventListener("nautilo:auth-rejected", wsRejected);
    document.addEventListener("visibilitychange", visible);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("pageshow", online);
      window.removeEventListener("nautilo:auth-rejected", wsRejected);
      document.removeEventListener("visibilitychange", visible);
    };
  }, []);

  useLayoutEffect(() => {
    if (credentialGeneration.current === auth.credentialGeneration) return;
    credentialGeneration.current = auth.credentialGeneration;
    // The cold check can precede the AuthProvider's first token latch. A
    // newly available credential must also restart that still-closed gate.
    requestCryptoAdmissionRefresh("credential_changed");
  }, [auth.credentialGeneration]);

  const retryNow = (): void => {
    retryAttempt.current = 0;
    clearRetry();
    requestCryptoAdmissionRefresh("manual_retry");
  };

  const changeServer = (): void => {
    if (desktopAPI?.servers?.openPicker === undefined) return;
    setChangingServer(true);
    void desktopAPI.servers.openPicker().finally(() => setChangingServer(false));
  };

  const switchAccount = (): void => {
    setSwitchingAccount(true);
    void auth.session.signOut().catch(() => {
      setSwitchingAccount(false);
      setMessage("Account switch could not start. Please try again.");
    });
  };

  if (minimalAdmin && effectiveState !== "open") {
    return (
      <main className="min-h-screen bg-background p-6 text-foreground">
        <div className="mx-auto max-w-4xl space-y-4">
          <div>
            <h1 className="text-xl font-semibold">Encryption policy</h1>
            <p className="mt-1 text-sm text-foreground-muted">
              This narrow recovery page does not open rooms or other product data.
            </p>
          </div>
          {can("read_server_settings") || can("manage_server_settings") ? (
            <EncryptionTransitionCard />
          ) : (
            <p role="alert" className="text-sm text-error">
              You do not have permission to manage encryption policy.
            </p>
          )}
        </div>
      </main>
    );
  }

  if (retainedForAccount) {
    const hidden = effectiveState !== "open"
      && effectiveState !== "checking"
      && effectiveState !== "reconnecting";
    return (
      <>
        <div
          inert={effectiveState === "open" ? undefined : true}
          aria-busy={effectiveState === "open" ? undefined : true}
          hidden={hidden}
        >
          <ConnectionRecoveryPortalContext.Provider value={connectionRecoveryHost}>
            <WorkbenchPortalProvider>{children}</WorkbenchPortalProvider>
          </ConnectionRecoveryPortalContext.Provider>
        </div>
        {/* Only connection status/retry may escape the inert product boundary. */}
        <div ref={setConnectionRecoveryHost} hidden={hidden} data-connection-recovery-host="" />
        {effectiveState === "open" ? null : hidden ? (
          <AdmissionRecovery
            canManage={can("manage_server_settings")}
            changingServer={changingServer}
            message={effectiveMessage}
            onChangeServer={changeServer}
            onRetry={retryNow}
            onSwitchAccount={switchAccount}
            readiness={readiness}
            state={effectiveState}
            switchingAccount={switchingAccount}
          />
        ) : null}
      </>
    );
  }

  if (effectiveState === "open") return <WorkbenchPortalProvider>{children}</WorkbenchPortalProvider>;
  return (
    <AdmissionRecovery
      canManage={can("manage_server_settings")}
      changingServer={changingServer}
      message={effectiveMessage}
      onChangeServer={changeServer}
      onRetry={retryNow}
      onSwitchAccount={switchAccount}
      readiness={readiness}
      state={effectiveState}
      switchingAccount={switchingAccount}
    />
  );
}

function AdmissionRecovery({
  canManage,
  changingServer,
  message,
  onChangeServer,
  onRetry,
  onSwitchAccount,
  readiness,
  state,
  switchingAccount,
}: Readonly<{
  canManage: boolean;
  changingServer: boolean;
  message: string | null;
  onChangeServer: () => void;
  onRetry: () => void;
  onSwitchAccount: () => void;
  readiness: ReturnType<typeof useEncryptionReadinessClient>;
  state: AdmissionViewState;
  switchingAccount: boolean;
}>) {
  const pending = state === "checking" || state === "reconnecting"
    || state === "policy_unavailable";
  if (pending) {
    return (
      <main className="fixed inset-0 z-40 flex items-center justify-center overflow-y-auto bg-background px-6 py-10 text-foreground">
        <div className="w-full max-w-md text-center">
          <p className="mb-8 text-sm font-semibold tracking-wide text-foreground-muted">Nautilo</p>
          <div aria-hidden="true" className="mx-auto mb-6 h-10 w-10 rounded-full border-2 border-border border-t-foreground motion-safe:animate-spin" />
          <div role="status" aria-live="polite">
            <h1 className="text-2xl font-semibold tracking-tight">
              {state === "checking" ? "Connecting to your workspace" : "Reconnecting to your workspace"}
            </h1>
            <p className="mt-3 text-sm leading-relaxed text-foreground-muted">
              {state === "checking"
                ? "Verifying this server and device before protected content opens."
                : "The security check could not finish. Your workspace will resume when the connection returns."}
            </p>
          </div>
          <div className="mt-6">
            <Button onClick={onRetry}>Retry</Button>
          </div>
          <ServerRecoveryDetails
            changingServer={changingServer}
            message={message}
            onChangeServer={onChangeServer}
            onSwitchAccount={onSwitchAccount}
            switchingAccount={switchingAccount}
          />
        </div>
      </main>
    );
  }

  return (
    <main className="fixed inset-0 z-40 overflow-y-auto bg-background px-6 py-10 text-foreground">
      <div className="mx-auto max-w-2xl space-y-5">
        <div>
          <h1 className="text-xl font-semibold">
            {state === "unsupported" ? "Update this client" : "Connect this device"}
          </h1>
          <p className="mt-1 text-sm text-foreground-muted">
            {state === "unsupported"
              ? "This client cannot verify the encryption required by this server."
              : "Encryption is enabled on this server. Connect this Browser or Desktop before opening your workspace."}
          </p>
        </div>
        {state !== "unsupported" && readiness !== undefined ? (
          <EncryptedRecoverySection readinessPort={readiness} showPersonalCoverage={false} />
        ) : null}
        {message ? <p role="alert" className="text-sm text-error">{message}</p> : null}
        <div className="flex flex-wrap gap-3">
          <Button onClick={onRetry}>Retry</Button>
          {canManage ? (
            <a href="/admin/encryption" className="inline-flex rounded-md border border-border px-3 py-2 text-sm">
              Manage encryption policy
            </a>
          ) : null}
        </div>
        <ServerRecoveryDetails
          changingServer={changingServer}
          message={null}
          onChangeServer={onChangeServer}
          onSwitchAccount={onSwitchAccount}
          switchingAccount={switchingAccount}
        />
      </div>
    </main>
  );
}

function ServerRecoveryDetails({
  changingServer,
  message,
  onChangeServer,
  onSwitchAccount,
  switchingAccount,
}: Readonly<{
  changingServer: boolean;
  message: string | null;
  onChangeServer: () => void;
  onSwitchAccount: () => void;
  switchingAccount: boolean;
}>) {
  const canChangeServer = desktopAPI?.servers?.openPicker !== undefined;
  return (
    <details className="mt-6 text-sm text-foreground-muted">
      <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary">Server details</summary>
      <div className="mt-3 space-y-3 border-t border-border pt-3 text-left">
        <p className="break-all">Current server: {serverOrigin()}</p>
        {message ? <p className="break-words">{message}</p> : null}
        <div className="flex flex-wrap gap-2">
          <Button variant="ghost" loading={switchingAccount} onClick={onSwitchAccount}>
            {switchingAccount ? "Switching account…" : "Switch account"}
          </Button>
          {canChangeServer ? (
            <Button variant="ghost" loading={changingServer} onClick={onChangeServer}>
              {changingServer ? "Opening server selector…" : "Change server"}
            </Button>
          ) : (
            <p>To use another trusted server, open its address in a new browser tab.</p>
          )}
        </div>
      </div>
    </details>
  );
}
