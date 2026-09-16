import { parseDeepLink } from "@/lib/deep-link";

export const REMOTE_PAIRING_ROUTE =
  "/(onboarding)/scan-computer-qr" as const;

export interface RemotePairingInput {
  readonly challengeId: string;
  readonly secret: string;
  readonly ceremonyContext: string;
}

let pendingPairing: RemotePairingInput | null = null;
const receivers = new Set<() => void>();

/**
 * Stage one deep-link pairing payload in process memory and navigate without
 * putting one-time verifier material into route params or navigation history.
 */
export function acceptRemotePairingDeepLink(
  raw: string,
  navigate: (route: typeof REMOTE_PAIRING_ROUTE) => void,
): string | null {
  const parsed = parseDeepLink(raw);
  if (parsed.kind !== "remote-pair") return null;
  return acceptRemotePairingInput(parsed, navigate);
}

/**
 * Same memory-only handoff for the root inbound coordinator after its URL
 * parser has already validated a remote-pair link. Keeping the secret out of
 * route params is the invariant; accepting an already-typed input avoids
 * serialising that secret into a second URL merely to parse it again.
 */
export function acceptRemotePairingInput(
  input: RemotePairingInput,
  navigate: (route: typeof REMOTE_PAIRING_ROUTE) => void,
): string {
  pendingPairing = {
    challengeId: input.challengeId,
    secret: input.secret,
    ceremonyContext: input.ceremonyContext,
  };
  if (receivers.size > 0) {
    for (const receive of receivers) receive();
    return input.challengeId;
  }
  try {
    navigate(REMOTE_PAIRING_ROUTE);
  } catch (error) {
    pendingPairing = null;
    throw error;
  }
  return input.challengeId;
}

/** Returns the staged payload at most once, clearing it synchronously. */
export function takeRemotePairingHandoff(): RemotePairingInput | null {
  const pairing = pendingPairing;
  pendingPairing = null;
  return pairing;
}

export function clearRemotePairingHandoff(): void {
  pendingPairing = null;
}

/** Receives warm links in place when the scanner screen is already mounted. */
export function subscribeRemotePairingHandoff(
  receive: () => void,
): () => void {
  receivers.add(receive);
  return () => receivers.delete(receive);
}
