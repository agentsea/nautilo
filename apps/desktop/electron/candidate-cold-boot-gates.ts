/**
 * D514 — candidate-only gates for a committed, known-identity resume.
 *
 * This is deliberately Electron-free. It has no active-server fallback: its
 * caller supplies the exact already-committed B descriptor and every token,
 * auth-window, onboarding, and HTTP operation is scoped to that descriptor.
 */
import { shouldForceGenieOnboardingFromSetup, shouldSkipGenieOnboardingWizard } from "./boot-setup-status";
import { isAccessTokenExpiring, refreshTokens as refreshCandidateCore } from "./auth/refresh";
import { runSignIn } from "./auth/sign-in";
import type { LoopbackHandle } from "./auth/loopback-server";
import type { TokenBundle } from "./auth/token-store";
import type { SetupStatusResponse } from "@nautilo/api-client";

export const CANDIDATE_COLD_BOOT_GATE_CONTEXT = "known-identity-committed-resume" as const;
export const ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT = "accepted-identity-replacement" as const;

export type CandidateColdBootGateDescriptor = Readonly<{
  routingServerUrl: string;
  canonicalOrigin: string;
  registryScope: string;
  partition: string;
}>;

export type CandidateHealthLogto = Readonly<{
  endpoint: string;
  appId: string;
  resource: string;
}>;

export type CandidateProfileFact =
  | Readonly<{ kind: "observed"; exists: boolean; onboardingCompleted: boolean }>
  | Readonly<{ kind: "unavailable" }>;

type CandidateColdBootGateInputFacts = Readonly<{
  candidate: CandidateColdBootGateDescriptor;
  logto: CandidateHealthLogto;
  setupStatus: SetupStatusResponse | null;
  profile: CandidateProfileFact;
  forceOnboarding?: boolean;
  signal: AbortSignal;
}>;

export type CandidateColdBootGateInput =
  | (CandidateColdBootGateInputFacts & Readonly<{
      context: typeof CANDIDATE_COLD_BOOT_GATE_CONTEXT;
    }>)
  | (CandidateColdBootGateInputFacts & Readonly<{
      /** Fresh Human acceptance; no persisted A credential may enter B. */
      context: typeof ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT;
    }>);

export type CandidateColdBootGatePorts = Readonly<{
  fetch: typeof globalThis.fetch;
  loadTokensFor: (routingServerUrl: string) => TokenBundle | null;
  saveTokensFor: (routingServerUrl: string, bundle: TokenBundle) => void;
  clearTokensFor: (routingServerUrl: string) => void;
  startLoopback: () => Promise<LoopbackHandle>;
  openAuthSurface: (args: Readonly<{
    url: string;
    partition: string;
    signal: AbortSignal;
    /** Human close only; programmatic completion remains the core's job. */
    onClosedByUser: () => void;
  }>) => Promise<{ closeAuthSurface: () => void }>;
  showOnboarding: (args: Readonly<{
    routingServerUrl: string;
    canonicalOrigin: string;
    partition: string;
    getBearer: () => Promise<string | null>;
    signal: AbortSignal;
  }>) => Promise<void>;
}>;

export type CandidateColdBootGateResult = Readonly<{
  ok: boolean;
  signedIn: boolean;
  onboarding: boolean;
}>;

function aborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function validOrigin(value: string): boolean {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") &&
      parsed.origin === value && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

/** Reject malformed/cross-origin/persistent candidates before any port runs. */
export function isValidCandidateColdBootGateInput(input: CandidateColdBootGateInput): boolean {
  if (input.context !== CANDIDATE_COLD_BOOT_GATE_CONTEXT &&
      input.context !== ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT) return false;
  const { candidate, logto } = input;
  if (!candidate.registryScope.trim() || !candidate.partition.trim() || candidate.partition.startsWith("persist:")) return false;
  if (!validOrigin(candidate.canonicalOrigin)) return false;
  try {
    const route = new URL(candidate.routingServerUrl);
    const endpoint = new URL(logto.endpoint);
    if ((route.protocol !== "http:" && route.protocol !== "https:") || route.username || route.password || route.search || route.hash) return false;
    if (route.origin !== candidate.canonicalOrigin) return false;
    if ((endpoint.protocol !== "http:" && endpoint.protocol !== "https:") || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) return false;
  } catch {
    return false;
  }
  return Boolean(logto.appId.trim() && logto.resource.trim());
}

function shouldOpenOnboarding(input: CandidateColdBootGateInput): boolean {
  if (input.forceOnboarding === true) return true;
  if (shouldSkipGenieOnboardingWizard(input.setupStatus)) return false;
  if (shouldForceGenieOnboardingFromSetup(input.setupStatus)) return true;
  return input.profile.kind === "observed" &&
    (!input.profile.exists || !input.profile.onboardingCompleted);
}

/**
 * Runs only the existing refresh/sign-in cores through exact-B closures, then
 * optionally opens onboarding in B's ephemeral partition. False is a safe
 * non-release result (including cancellation); it never changes server choice.
 */
export async function runCandidateColdBootGates(
  input: CandidateColdBootGateInput,
  ports: CandidateColdBootGatePorts,
): Promise<CandidateColdBootGateResult> {
  const failed = (): CandidateColdBootGateResult => ({ ok: false, signedIn: false, onboarding: false });
  if (!isValidCandidateColdBootGateInput(input) || aborted(input.signal)) return failed();
  const { candidate, logto, signal } = input;
  const acceptedReplacement = input.context === ACCEPTED_IDENTITY_REPLACEMENT_GATE_CONTEXT;
  let freshReplacementBundle: TokenBundle | null = null;
  const resolveCandidateBearer = async (): Promise<string | null> => {
    let bundle = acceptedReplacement
      ? freshReplacementBundle
      : ports.loadTokensFor(candidate.routingServerUrl);
    if (aborted(signal)) return null;
    if (bundle && isAccessTokenExpiring(bundle)) {
      bundle = await refreshCandidateCore(logto, {
        fetchImpl: ports.fetch,
        loadTokens: () => acceptedReplacement
          ? freshReplacementBundle
          : ports.loadTokensFor(candidate.routingServerUrl),
        saveTokens: (next) => {
          if (acceptedReplacement) freshReplacementBundle = next;
          ports.saveTokensFor(candidate.routingServerUrl, next);
        },
        clearTokens: () => {
          // Replacement can only clear a bundle this invocation first saved.
          if (!acceptedReplacement || freshReplacementBundle !== null) {
            freshReplacementBundle = null;
            ports.clearTokensFor(candidate.routingServerUrl);
          }
        },
      });
    }
    return aborted(signal) ? null : bundle?.access_token ?? null;
  };

  const onboarding = shouldOpenOnboarding(input);
  let bearer = await resolveCandidateBearer();
  if (aborted(signal)) return failed();
  let signedIn = bearer !== null;

  // A signed-out server without an onboarding requirement releases to the
  // ordinary Workbench sign-in surface. Candidate auth is only needed to let
  // an onboarding gate make authenticated B-only calls before release.
  if (!bearer && onboarding) {
    let authSurface: { closeAuthSurface: () => void } | null = null;
    let loopback: LoopbackHandle | null = null;
    let loopbackShutdownRequested = false;
    let underlyingLoopbackShutdownPerformed = false;
    const shutdownLoopback = () => {
      loopbackShutdownRequested = true;
      if (!loopback || underlyingLoopbackShutdownPerformed) return;
      underlyingLoopbackShutdownPerformed = true;
      loopback.shutdown();
    };
    const stop = () => {
      authSurface?.closeAuthSurface();
      shutdownLoopback();
    };
    signal.addEventListener("abort", stop, { once: true });
    try {
      const signInResult = await runSignIn(logto, {
        fetchImpl: ports.fetch,
        saveTokens: (next) => {
          if (!aborted(signal)) {
            if (acceptedReplacement) freshReplacementBundle = next;
            ports.saveTokensFor(candidate.routingServerUrl, next);
          }
        },
        startLoopback: async () => {
          if (aborted(signal)) throw new Error("candidate sign-in cancelled");
          const createdLoopback = await ports.startLoopback();
          loopback = createdLoopback;
          if (loopbackShutdownRequested || aborted(signal)) shutdownLoopback();
          return { ...createdLoopback, shutdown: shutdownLoopback };
        },
        openAuthUrl: async (url) => {
          if (aborted(signal)) throw new Error("candidate sign-in cancelled");
          authSurface = await ports.openAuthSurface({
            url,
            partition: candidate.partition,
            signal,
            onClosedByUser: shutdownLoopback,
          });
          if (aborted(signal)) authSurface.closeAuthSurface();
          return authSurface;
        },
      });
      bearer = signInResult.bundle.access_token;
      signedIn = true;
    } catch {
      return failed();
    } finally {
      signal.removeEventListener("abort", stop);
    }
    if (aborted(signal)) return failed();
  }

  if (!onboarding) return { ok: !aborted(signal), signedIn, onboarding: false };
  try {
    await ports.showOnboarding({
      routingServerUrl: candidate.routingServerUrl,
      canonicalOrigin: candidate.canonicalOrigin,
      partition: candidate.partition,
      getBearer: async () => {
        bearer = await resolveCandidateBearer();
        signedIn = bearer !== null;
        return bearer;
      },
      signal,
    });
    return { ok: !aborted(signal), signedIn, onboarding: true };
  } catch {
    return failed();
  }
}
