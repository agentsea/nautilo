import { ApiError } from "@nautilo/api-client/browser";
import {
  MOBILE_USER_AGREEMENT_VERSION,
  hasCurrentMobileUserAgreementContract,
  isCurrentMobileUserAgreementState,
  type MobileUserAgreementAcceptanceDto,
  type MobileUserAgreementStateResponse,
} from "@nautilo/types";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import {
  canQueryMobileUserAgreement,
  mobileAgreementStatusDuringRefresh,
  type MobileUserAgreementStatus,
} from "@/features/user-agreement/admission";
import { getApiClient } from "@/lib/api";
import { useAuth } from "@/providers/auth";
import { usePlatformCapabilities } from "@/providers/platform-capabilities";
import { useRealtime } from "@/providers/realtime";
import { useServers } from "@/providers/server-registry";

interface UserAgreementValue {
  readonly status: MobileUserAgreementStatus;
  readonly acceptance: MobileUserAgreementAcceptanceDto | null;
  readonly busy: boolean;
  readonly refresh: () => Promise<void>;
  readonly accept: () => Promise<boolean>;
  readonly withdraw: () => Promise<boolean>;
}

const UserAgreementContext = createContext<UserAgreementValue | null>(null);

export function UserAgreementProvider({ children }: { children: React.ReactNode }) {
  const { activeServer } = useServers();
  const { status: authStatus, viewer, viewerState } = useAuth();
  const { recoveryRevision } = useRealtime();
  const platform = usePlatformCapabilities().platform;
  const [status, setStatus] = useState<MobileUserAgreementStatus>("loading");
  const [acceptance, setAcceptance] = useState<MobileUserAgreementAcceptanceDto | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const generationRef = useRef(0);
  const mutationGenerationRef = useRef(0);
  const statusRef = useRef<MobileUserAgreementStatus>(status);
  statusRef.current = status;
  const settledScopeKeyRef = useRef<string | null>(null);
  const refreshInFlightRef = useRef<Readonly<{
    key: string;
    generation: number;
    promise: Promise<void>;
  }> | null>(null);

  const scope = useMemo(() =>
    platform !== "unknown" && activeServer && viewer && canQueryMobileUserAgreement({
      platform,
      authStatus,
      viewerState,
      viewerUserId: viewer.userId,
    })
      ? { serverId: activeServer.id, serverUrl: activeServer.serverUrl, userId: viewer.userId }
      : null,
  [activeServer?.id, activeServer?.serverUrl, authStatus, platform, viewer?.userId, viewerState]);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const scopeKey = scope ? `${scope.serverId}\0${scope.userId}` : null;

  const applyResponse = useCallback((response: MobileUserAgreementStateResponse, responseScopeKey: string) => {
    settledScopeKeyRef.current = responseScopeKey;
    if (!hasCurrentMobileUserAgreementContract(response)) {
      setAcceptance(null);
      statusRef.current = "unsupported";
      setStatus("unsupported");
      return;
    }
    setAcceptance(response.acceptance);
    const nextStatus = isCurrentMobileUserAgreementState(response) ? "accepted" : "required";
    statusRef.current = nextStatus;
    setStatus(nextStatus);
  }, []);

  const refresh = useCallback(async (): Promise<void> => {
    const operationScope = scopeRef.current;
    if (!operationScope) {
      setAcceptance(null);
      statusRef.current = "loading";
      setStatus("loading");
      return;
    }
    const operationScopeKey = `${operationScope.serverId}\0${operationScope.userId}`;
    const existing = refreshInFlightRef.current;
    if (existing?.key === operationScopeKey && existing.generation === generationRef.current) {
      return existing.promise;
    }
    const generation = ++generationRef.current;
    const pendingStatus = mobileAgreementStatusDuringRefresh(
      statusRef.current,
      settledScopeKeyRef.current === operationScopeKey,
    );
    statusRef.current = pendingStatus;
    setStatus(pendingStatus);
    const promise = (async () => {
      try {
        const response = await getApiClient(operationScope.serverUrl).getMobileUserAgreementState();
        if (generationRef.current !== generation || scopeRef.current?.serverId !== operationScope.serverId || scopeRef.current?.userId !== operationScope.userId) return;
        applyResponse(response, operationScopeKey);
      } catch (error) {
        if (generationRef.current !== generation || scopeRef.current?.serverId !== operationScope.serverId || scopeRef.current?.userId !== operationScope.userId) return;
        settledScopeKeyRef.current = operationScopeKey;
        setAcceptance(null);
        const nextStatus = error instanceof ApiError && (error.status === 404 || error.status === 405) ? "unsupported" : "unavailable";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
      }
    })();
    refreshInFlightRef.current = { key: operationScopeKey, generation, promise };
    try {
      await promise;
    } finally {
      if (refreshInFlightRef.current?.promise === promise) refreshInFlightRef.current = null;
    }
  }, [applyResponse]);

  useEffect(() => {
    generationRef.current += 1;
    mutationGenerationRef.current += 1;
    busyRef.current = false;
    setBusy(false);
    setAcceptance(null);
    settledScopeKeyRef.current = null;
    if (platform !== "native") {
      statusRef.current = "accepted";
      setStatus("accepted");
      return;
    }
    statusRef.current = "loading";
    setStatus("loading");
    if (scope) void refresh();
  }, [platform, scopeKey, refresh]);

  useEffect(() => {
    if (scope && recoveryRevision > 0) void refresh();
  }, [recoveryRevision, refresh, scope]);

  const accept = useCallback(async (): Promise<boolean> => {
    const operationScope = scopeRef.current;
    if (!operationScope || busyRef.current) return false;
    const generation = ++generationRef.current;
    const mutationGeneration = ++mutationGenerationRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await getApiClient(operationScope.serverUrl)
        .acceptMobileUserAgreement(MOBILE_USER_AGREEMENT_VERSION);
      if (generationRef.current !== generation || scopeRef.current?.serverId !== operationScope.serverId || scopeRef.current?.userId !== operationScope.userId) return false;
      applyResponse(response, `${operationScope.serverId}\0${operationScope.userId}`);
      return isCurrentMobileUserAgreementState(response);
    } catch (error) {
      if (generationRef.current === generation) {
        settledScopeKeyRef.current = `${operationScope.serverId}\0${operationScope.userId}`;
        setAcceptance(null);
        const nextStatus = error instanceof ApiError && (error.status === 404 || error.status === 405 || error.status === 409) ? "unsupported" : "unavailable";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
      }
      return false;
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [applyResponse]);

  const withdraw = useCallback(async (): Promise<boolean> => {
    const operationScope = scopeRef.current;
    if (!operationScope || busyRef.current) return false;
    const generation = ++generationRef.current;
    const mutationGeneration = ++mutationGenerationRef.current;
    busyRef.current = true;
    setBusy(true);
    try {
      const response = await getApiClient(operationScope.serverUrl).withdrawMobileUserAgreement();
      if (generationRef.current !== generation || scopeRef.current?.serverId !== operationScope.serverId || scopeRef.current?.userId !== operationScope.userId) return false;
      applyResponse(response, `${operationScope.serverId}\0${operationScope.userId}`);
      return !response.accepted;
    } catch (error) {
      if (generationRef.current === generation) {
        settledScopeKeyRef.current = `${operationScope.serverId}\0${operationScope.userId}`;
        const nextStatus = error instanceof ApiError && (error.status === 404 || error.status === 405) ? "unsupported" : "unavailable";
        statusRef.current = nextStatus;
        setStatus(nextStatus);
      }
      return false;
    } finally {
      if (mutationGenerationRef.current === mutationGeneration) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  }, [applyResponse]);

  const value = useMemo<UserAgreementValue>(
    () => ({ status, acceptance, busy, refresh, accept, withdraw }),
    [accept, acceptance, busy, refresh, status, withdraw],
  );
  return <UserAgreementContext.Provider value={value}>{children}</UserAgreementContext.Provider>;
}

export function useUserAgreement(): UserAgreementValue {
  const context = useContext(UserAgreementContext);
  if (!context) throw new Error("useUserAgreement must be used within UserAgreementProvider");
  return context;
}
