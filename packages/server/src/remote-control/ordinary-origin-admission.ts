import { createHash } from "node:crypto";
import { getRelayRegistry } from "@nautilo/agent";
import { eq, getSharedDirectDb, nautiloInstanceIdentity } from "@nautilo/db";
import {
  canonicalRemoteOrdinaryRequestBody,
  REMOTE_PAIRING_PROOF_ALGORITHM,
  type RemoteOrdinaryRequestProof,
  type VerifiedOrdinaryOrigin,
} from "@nautilo/types";
import { z } from "zod";
import {
  getOrdinaryAdmissionStore,
  type OrdinaryAdmissionStore,
} from "./ordinary-admission-store";
import {
  verifyMobileOrdinaryOrigin,
} from "./ordinary-origin-proof";
import {
  getElectronOriginCredentialStore,
  type ElectronOriginCredentialStore,
} from "./electron-origin-credential-store";
import {
  getRemotePairingStore,
  type RemotePairingStore,
} from "./pairing-store";

export const MOBILE_ORDINARY_ORIGIN_HEADER = "x-nautilo-mobile-origin";
export const ELECTRON_ORDINARY_ORIGIN_HEADER = "x-nautilo-electron-origin";
const MAX_HEADER_LENGTH = 4096;
const MAX_AGE_MS = 2 * 60 * 1000;
const MAX_FUTURE_SKEW_MS = 15 * 1000;
const lowercaseHex = (bytes: number) => z.string().regex(new RegExp(`^[0-9a-f]{${bytes * 2}}$`));
const positiveInteger = z.number().int().positive();
const proofSchema = z.object({
  algorithm: z.literal(REMOTE_PAIRING_PROOF_ALGORITHM),
  serverInstanceId: z.string().uuid(),
  serverBindingGeneration: positiveInteger,
  controllerInstallationId: z.string().uuid(),
  installationId: z.string().uuid(),
  installationGeneration: positiveInteger,
  requestId: z.string().uuid(),
  issuedAtMs: positiveInteger,
  method: z.string().min(3).max(12),
  path: z.string().min(1).max(1024),
  bodySha256: lowercaseHex(32),
  signature: lowercaseHex(64),
}).strict();

export type OrdinaryOriginAdmissionResult =
  | { readonly status: "absent" }
  | { readonly status: "denied" }
  | { readonly status: "verified"; readonly origin: VerifiedOrdinaryOrigin };

export interface ElectronOriginAdmissionRegistry {
  getUserId(relayId: string): string | null | undefined;
  getDesktopSessionId(relayId: string): string | null | undefined;
  getPairingGeneration(relayId: string): string | null | undefined;
}

export interface OrdinaryOriginAdmissionDeps {
  readonly pairingStore: Pick<RemotePairingStore, "findControllerOriginForOrdinaryRequest">;
  readonly admissionStore: OrdinaryAdmissionStore;
  readonly electronCredentialStore: ElectronOriginCredentialStore;
  readonly getRelayRegistry: () => ElectronOriginAdmissionRegistry | null;
  readonly getServerIdentity: () => Promise<{
    serverInstanceId: string;
    serverBindingGeneration: number;
  } | null>;
  readonly now: () => Date;
}

async function defaultServerIdentity(): Promise<{
  serverInstanceId: string;
  serverBindingGeneration: number;
} | null> {
  const rows = await getSharedDirectDb()
    .select({
      serverInstanceId: nautiloInstanceIdentity.serverInstanceId,
      serverBindingGeneration: nautiloInstanceIdentity.serverBindingGeneration,
    })
    .from(nautiloInstanceIdentity)
    .where(eq(nautiloInstanceIdentity.id, "self"))
    .limit(1);
  return rows[0] ?? null;
}

const defaultDeps: OrdinaryOriginAdmissionDeps = {
  pairingStore: getRemotePairingStore(),
  admissionStore: getOrdinaryAdmissionStore(),
  electronCredentialStore: getElectronOriginCredentialStore(),
  getRelayRegistry: () => getRelayRegistry() as ElectronOriginAdmissionRegistry | null,
  getServerIdentity: defaultServerIdentity,
  now: () => new Date(),
};

/** Verifies and consumes a paired-mobile or local-Electron origin proof. */
export async function admitOrdinaryOrigin(
  input: {
    readonly mobileHeader: string | string[] | undefined;
    readonly electronHeader: string | string[] | undefined;
    readonly sessionUserId: string;
    readonly sessionActorId: string;
    readonly method: string;
    readonly path: string;
    readonly body: unknown;
  },
  deps: OrdinaryOriginAdmissionDeps = defaultDeps,
): Promise<OrdinaryOriginAdmissionResult> {
  if (input.mobileHeader === undefined && input.electronHeader === undefined) {
    return { status: "absent" };
  }
  // An origin is singular. Supplying both proof families is ambiguous and
  // must never become a caller-controlled precedence rule.
  if (input.mobileHeader !== undefined && input.electronHeader !== undefined) {
    return { status: "denied" };
  }
  const canonicalBody = canonicalRemoteOrdinaryRequestBody(input.body);
  const bodySha256 = createHash("sha256").update(canonicalBody, "utf8").digest("hex");
  if (input.electronHeader !== undefined) {
    if (typeof input.electronHeader !== "string" || input.electronHeader.length > 128) {
      return { status: "denied" };
    }
    const registry = deps.getRelayRegistry();
    if (!registry) return { status: "denied" };
    const origin = deps.electronCredentialStore.consume({
      token: input.electronHeader,
      userId: input.sessionUserId,
      actorId: input.sessionActorId,
      method: input.method,
      path: input.path,
      bodySha256,
      now: deps.now(),
      isCurrentRelaySession: (binding) =>
        registry.getUserId(binding.relayId) === binding.userId &&
        registry.getDesktopSessionId(binding.relayId) === binding.desktopSessionId &&
        registry.getPairingGeneration(binding.relayId) === binding.pairingGeneration,
    });
    return origin ? { status: "verified", origin } : { status: "denied" };
  }
  const header = input.mobileHeader;
  if (typeof header !== "string" || header.length > MAX_HEADER_LENGTH) {
    return { status: "denied" };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(header);
  } catch {
    return { status: "denied" };
  }
  const parsed = proofSchema.safeParse(raw);
  if (!parsed.success) return { status: "denied" };
  const proof: RemoteOrdinaryRequestProof = parsed.data;
  const identity = await deps.getServerIdentity();
  if (!identity) return { status: "denied" };
  const stored = await deps.pairingStore.findControllerOriginForOrdinaryRequest({
    installationId: proof.installationId,
    userId: input.sessionUserId,
    actorId: input.sessionActorId,
    serverInstanceId: identity.serverInstanceId,
    serverBindingGeneration: identity.serverBindingGeneration,
  });
  const now = deps.now();
  const origin = verifyMobileOrdinaryOrigin({
    stored,
    sessionUserId: input.sessionUserId,
    sessionActorId: input.sessionActorId,
    serverInstanceId: identity.serverInstanceId,
    serverBindingGeneration: identity.serverBindingGeneration,
    method: input.method,
    path: input.path,
    bodySha256,
    nowMs: now.getTime(),
    maxAgeMs: MAX_AGE_MS,
    maxFutureSkewMs: MAX_FUTURE_SKEW_MS,
    proof,
  });
  if (!origin) return { status: "denied" };
  const admitted = await deps.admissionStore.admitOnce({
    requestId: origin.requestId,
    userId: origin.userId,
    actorId: origin.actorId,
    controllerInstallationId: origin.controllerInstallationId,
    installationGeneration: origin.installationGeneration,
    bodySha256,
    admittedAt: now,
    expiresAt: new Date(proof.issuedAtMs + MAX_AGE_MS + MAX_FUTURE_SKEW_MS),
  });
  if (!admitted) return { status: "denied" };
  void deps.admissionStore.cleanupExpired({ now, limit: 100 }).catch(() => {});
  return { status: "verified", origin };
}
