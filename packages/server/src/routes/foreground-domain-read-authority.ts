import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { authorizationRevision, createDomainForegroundAuthorizationPlan, cryptoDeviceId,
  humanId, withOpenedDomainForegroundAuthorization, type DomainForegroundAuthorityEntry,
  type DomainForegroundSecretEntry, type LatticeCrypto } from "@nautilo/lattice-crypto";
import { DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
  destroyDomainForegroundAuthorizationPlanV2, destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationV2, serializeDomainForegroundAuthorizationPlanV2 } from "@nautilo/lattice-crypto/wire";
import { authenticateForegroundRuntimeRecipientKeyPair, destroyProtectedInvocationRecipient } from "@nautilo/lattice-bridge";
import { withProtectedInvocationRecipientPrivateKey,
  type DomainForegroundNamespaceAuthorityInspectionV2, type LiveShadowRecipientRegistry } from "@nautilo/lattice-bridge/server";

export type DomainForegroundReadBinding = Readonly<{
  userId: string; humanActorId: string; clientDeviceId: string; clientActionSessionId: string;
}>;
export type DomainForegroundReadLocator = Readonly<{ topLevelRoomId: string; namespaceId: string }>;
/** Owned public metadata; every returned snapshot is wiped by its consumer. */
export type DomainForegroundReadSnapshot = Readonly<{
  policyRevision: number; committerDeviceId: string; committerDeviceSigningKeyGeneration: number;
  committerDeviceSigningPublicKey: Uint8Array; hostAuthorizationRevision: number;
  namespaceAuthority: Omit<DomainForegroundNamespaceAuthorityInspectionV2, "status">;
  domains: readonly DomainForegroundAuthorityEntry[];
}>;

type Unavailable = Readonly<{ status: "unavailable" }>;
const unavailable: Unavailable = Object.freeze({ status: "unavailable" });

export class DomainForegroundReadUnavailable extends Error {
  override readonly name = "DomainForegroundReadUnavailable";
}

type Challenge<
  Locator extends DomainForegroundReadLocator,
  Snapshot extends DomainForegroundReadSnapshot,
> = Readonly<{
  binding: DomainForegroundReadBinding;
  locator: Locator;
  snapshot: Snapshot;
  planBytes: Uint8Array;
  issuedAt: number;
  deadlineAt: number;
  recipientKeyId: string;
}>;

export function wipeDomainForegroundReadSnapshot(snapshot: DomainForegroundReadSnapshot): void {
  snapshot.committerDeviceSigningPublicKey.fill(0);
  for (const value of Object.values(snapshot.namespaceAuthority)) {
    if (value instanceof Uint8Array) value.fill(0);
  }
  for (const domain of snapshot.domains) {
    domain.participantDigest.fill(0);
    domain.headDigest.fill(0);
    domain.activeNamespaceBindingSetDigest.fill(0);
  }
}

function wipeOnAbort(signal: AbortSignal, wipe: () => void): () => void {
  signal.addEventListener("abort", wipe, { once: true });
  if (signal.aborted) wipe();
  return () => signal.removeEventListener("abort", wipe);
}

/**
 * One-use, decrypt-only custody for the canonical Namespace locator. The
 * resolver must revalidate its still-awaiting row and current product policy.
 * No execution reservation, message publication or reusable grant is created.
 */
export function createDomainForegroundReadAuthority<
  Locator extends DomainForegroundReadLocator,
  Authority,
  Snapshot extends DomainForegroundReadSnapshot = DomainForegroundReadSnapshot,
>(input: Readonly<{
  crypto: LatticeCrypto;
  recipients: LiveShadowRecipientRegistry;
  resolveCurrent(
    binding: DomainForegroundReadBinding,
    locator: Locator,
  ): Promise<Snapshot | null>;
  withAuthority<Value>(
    context: Readonly<{
      binding: DomainForegroundReadBinding;
      locator: Locator;
      snapshot: Snapshot;
      domains: readonly DomainForegroundSecretEntry[];
      signal: AbortSignal;
      deadlineAt: number;
      authorizationId: string;
      recipientKeyId: string;
      issuedAt: number;
      authorizationDigest: Uint8Array;
      assertCurrentAuthority(): Promise<void>;
    }>,
    use: (authority: Authority) => Promise<Value>,
  ): Promise<Value>;
  now?: () => number;
}>) {
  const now = input.now ?? Date.now;
  const challenges = new Map<string, Challenge<Locator, Snapshot>>();
  const active = new Map<AbortController, Readonly<{
    binding: DomainForegroundReadBinding; deadlineAt: number; operationId: string;
  }>>();
  let closed = false;
  const discard = (id: string, challenge: Challenge<Locator, Snapshot>): void => {
    challenges.delete(id);
    input.recipients.delete(id);
    challenge.planBytes.fill(0);
    wipeDomainForegroundReadSnapshot(challenge.snapshot);
  };
  const prune = (): void => {
    for (const [controller, entry] of active) {
      if (entry.deadlineAt <= now()) {
        active.delete(controller);
        controller.abort();
      }
    }
    for (const [id, challenge] of challenges) {
      if (challenge.deadlineAt <= now() || !input.recipients.hasOperation({
        operationId: id,
        clientActionSessionId: challenge.binding.clientActionSessionId,
        actorId: challenge.binding.humanActorId,
      })) discard(id, challenge);
    }
  };
  const cancel = (matches: (binding: DomainForegroundReadBinding) => boolean): void => {
    for (const [id, challenge] of challenges) {
      if (matches(challenge.binding)) discard(id, challenge);
    }
    for (const [controller, entry] of active) {
      if (matches(entry.binding)) {
        active.delete(controller);
        controller.abort();
      }
    }
  };
  return Object.freeze({
    async plan(request: Readonly<{
      binding: DomainForegroundReadBinding;
      locator: Locator;
      /** Supplied by the existing foreground challenge lifetime contract. */
      deadlineAt: number;
    }>): Promise<Unavailable | Readonly<{
      status: "authorization_required";
      challengeId: string;
      authorizationPlanBytes: Uint8Array;
      recipientPublicKey: Uint8Array;
      deadlineAt: number;
    }>> {
      prune();
      const issuedAt = now();
      if (closed || request.deadlineAt <= issuedAt) return unavailable;
      const binding = Object.freeze({ ...request.binding });
      const locator = Object.freeze(structuredClone(request.locator));
      const id = randomUUID();
      const reservation = {operationId: id, clientActionSessionId: binding.clientActionSessionId,
        actorId: binding.humanActorId, deadlineAt: request.deadlineAt};
      if (!input.recipients.reserveRuntime(reservation)) return unavailable;
      const controller = new AbortController();
      active.set(controller, {binding, deadlineAt: request.deadlineAt, operationId: id});
      const cancelRecipient = (): void => {input.recipients.delete(id);};
      controller.signal.addEventListener("abort", cancelRecipient, {once: true});
      let snapshot: Snapshot | null = null;
      let retained = false;
      // Retain the existing opaque recipient label; it grants no checkpoint authority.
      const recipientKeyId = `checkpoint-read-key:${id}`;
      let publicKey: Uint8Array | null = null;
      try {
        const keyPair = await input.crypto.generateEncryptionKeyPair();
        const detachKey = wipeOnAbort(controller.signal, () => keyPair.privateKey.fill(0));
        try {
          if (closed || controller.signal.aborted || now() >= request.deadlineAt) return unavailable;
          const recipient = await authenticateForegroundRuntimeRecipientKeyPair({
            crypto: input.crypto, recipientKind: "nautilo_foreground_runtime", recipientKeyId, ...keyPair,
          });
          if (closed || controller.signal.aborted
            || !input.recipients.completeReservedRuntime({...reservation, publicKey: keyPair.publicKey, recipient})) {
            destroyProtectedInvocationRecipient(recipient);
            return unavailable;
          }
          publicKey = keyPair.publicKey.slice();
        } finally {
          detachKey();
          keyPair.publicKey.fill(0);
          keyPair.privateKey.fill(0);
        }
        snapshot = await input.resolveCurrent(binding, locator);
        if (snapshot === null || controller.signal.aborted || closed
          || snapshot.namespaceAuthority.namespaceId !== locator.namespaceId
          || snapshot.committerDeviceId !== binding.clientDeviceId
          || snapshot.domains.length !== 1
          || snapshot.domains[0]!.domainId !== snapshot.namespaceAuthority.domainId
          || now() >= request.deadlineAt
          || !input.recipients.hasOperation(reservation)) return unavailable;
        const plan = createDomainForegroundAuthorizationPlan(input.crypto, {
          authorizationId: id,
          policyRevision: snapshot.policyRevision,
          sessionId: binding.clientActionSessionId,
          roomId: locator.topLevelRoomId,
          subjectHumanId: humanId(binding.humanActorId),
          committerDeviceId: cryptoDeviceId(binding.clientDeviceId),
          committerDeviceSigningGeneration: snapshot.committerDeviceSigningKeyGeneration,
          hostAuthorizationRevision: authorizationRevision(snapshot.hostAuthorizationRevision),
          recipientKind: "runtime",
          recipientPrincipalId: "nautilo_foreground_runtime",
          recipientAuthorizationRevision: authorizationRevision(0),
          recipientRuntimeGeneration: 0,
          recipientKeyId,
          operations: ["decrypt"],
          issuedAt,
          deadlineAt: request.deadlineAt,
          maximumSecretBytes: DOMAIN_FOREGROUND_AUTHORIZATION_MAX_SECRET_BYTES_V2,
          domains: snapshot.domains,
        });
        let planBytes: Uint8Array;
        try { planBytes = serializeDomainForegroundAuthorizationPlanV2(plan); }
        finally { destroyDomainForegroundAuthorizationPlanV2(plan); }
          challenges.set(id, Object.freeze({
            binding, locator, snapshot, planBytes, issuedAt,
            deadlineAt: request.deadlineAt, recipientKeyId,
          }));
          retained = true;
          return Object.freeze({
            status: "authorization_required",
            challengeId: id,
            authorizationPlanBytes: planBytes.slice(),
            recipientPublicKey: publicKey.slice(),
            deadlineAt: request.deadlineAt,
          });
      } finally {
        active.delete(controller);
        if (retained) controller.signal.removeEventListener("abort", cancelRecipient);
        controller.abort();
        publicKey?.fill(0);
        if (snapshot !== null && !retained) wipeDomainForegroundReadSnapshot(snapshot);
      }
    },

    async read<Value>(request: Readonly<{
      binding: DomainForegroundReadBinding;
      challengeId: string;
      authorizationBytes: Uint8Array;
      execute(authority: Authority, locator: Locator): Promise<Value>;
    }>): Promise<Unavailable | Readonly<{ status: "read"; value: Value }>> {
      prune();
      const challenge = challenges.get(request.challengeId);
      if (closed || challenge === undefined
        || !isDeepStrictEqual(challenge.binding, request.binding)) return unavailable;
      const challengeId = request.challengeId;
      const authorizationBytes = request.authorizationBytes.slice();
      // Consume before any await: concurrent replays cannot obtain custody.
      challenges.delete(challengeId);
      const recipient = input.recipients.takeRuntime({
        operationId: challengeId,
        clientActionSessionId: challenge.binding.clientActionSessionId,
        actorId: challenge.binding.humanActorId,
      });
      const controller = new AbortController();
      active.set(controller, {binding: challenge.binding, deadlineAt: challenge.deadlineAt, operationId: challengeId});
      const disposeRecipient = (): void => {
        if (recipient !== null) {
          recipient.publicKey.fill(0);
          destroyProtectedInvocationRecipient(recipient.recipient);
        }
      };
      controller.signal.addEventListener("abort", disposeRecipient, {once: true});
      const isActive = (): boolean => !closed && !controller.signal.aborted
        && now() < challenge.deadlineAt;
      const currentMatches = async (): Promise<boolean> => {
        if (!isActive()) return false;
        const current = await input.resolveCurrent(challenge.binding, challenge.locator);
        try {
          return isActive() && current !== null
            && isDeepStrictEqual(current, challenge.snapshot);
        } finally { if (current !== null) wipeDomainForegroundReadSnapshot(current); }
      };
      try {
        if (recipient === null || !isActive()) return unavailable;
        const envelope = parseDomainForegroundAuthorizationV2(authorizationBytes);
        if (envelope === null) return unavailable;
        try {
          if (!isDeepStrictEqual(envelope.planBytes, challenge.planBytes)) return unavailable;
        } finally { destroyDomainForegroundAuthorizationV2(envelope); }
        if (!await currentMatches()) return unavailable;
        const snapshot = challenge.snapshot;
        const opened = await withProtectedInvocationRecipientPrivateKey(recipient.recipient,
            async (privateKey) => {
              const detachPrivateKey = wipeOnAbort(controller.signal, () => {
                privateKey.fill(0);
                destroyProtectedInvocationRecipient(recipient.recipient);
              });
              try { return await withOpenedDomainForegroundAuthorization(input.crypto, {
              authorizationBytes,
              expectedOperations: ["decrypt"],
              now: now(),
              current: {
                authorizationId: challengeId,
                policyRevision: snapshot.policyRevision,
                sessionId: challenge.binding.clientActionSessionId,
                roomId: challenge.locator.topLevelRoomId,
                subjectHumanId: humanId(challenge.binding.humanActorId),
                committerDeviceId: cryptoDeviceId(snapshot.committerDeviceId),
                committerDeviceSigningGeneration: snapshot.committerDeviceSigningKeyGeneration,
                committerDeviceSigningPublicKey: snapshot.committerDeviceSigningPublicKey,
                committerDeviceActive: true,
                hostAuthorizationRevision: authorizationRevision(snapshot.hostAuthorizationRevision),
                recipientKind: "runtime",
                recipientPrincipalId: "nautilo_foreground_runtime",
                recipientAuthorizationRevision: authorizationRevision(0),
                recipientRuntimeGeneration: 0,
                recipientKeyId: challenge.recipientKeyId,
                recipientEncryptionPrivateKey: privateKey,
                recipientAuthorized: true,
                domains: snapshot.domains,
              },
              operation: async (entries) => {
                // Recipient decryption is complete; no private scalar is needed
                // while storage is awaited. Only this callback owns Domain keys.
                privateKey.fill(0);
                destroyProtectedInvocationRecipient(recipient.recipient);
                if (!isActive()) return unavailable;
                const wipeDomains = () => entries.forEach(
                  (entry) => entry.domainKey.fill(0),
                );
                const detachDomains = wipeOnAbort(controller.signal, wipeDomains);
                const assertCurrentAuthority = async (): Promise<void> => {
                  if (!await currentMatches()) {
                    throw new DomainForegroundReadUnavailable(
                      "foreground read authority changed",
                    );
                  }
                };
                const authorizationDigest = input.crypto.hash(authorizationBytes);
                try {
                  const value = await input.withAuthority({
                    binding: challenge.binding,
                    locator: challenge.locator,
                    snapshot,
                    domains: entries,
                    signal: controller.signal,
                    deadlineAt: challenge.deadlineAt,
                    authorizationId: challengeId,
                    recipientKeyId: challenge.recipientKeyId,
                    issuedAt: challenge.issuedAt,
                    authorizationDigest,
                    assertCurrentAuthority,
                  }, authority => request.execute(authority, challenge.locator));
                  return await currentMatches()
                    ? Object.freeze({ status: "read" as const, value })
                    : unavailable;
                } finally {
                  authorizationDigest.fill(0);
                  detachDomains();
                  wipeDomains();
                }
              },
            }); } finally { detachPrivateKey(); }
          });
        return opened !== null && opened.status === "opened" && isActive()
          ? opened.value : unavailable;
      } catch (error) {
        if (!isActive() || error instanceof DomainForegroundReadUnavailable) {
          return unavailable;
        }
        throw error;
      } finally {
        input.recipients.delete(challengeId);
        authorizationBytes.fill(0);
        controller.abort();
        active.delete(controller);
        challenge.planBytes.fill(0);
        wipeDomainForegroundReadSnapshot(challenge.snapshot);
      }
    },
    cancelChallenge(challengeId: string): void {
      const challenge = challenges.get(challengeId);
      if (challenge !== undefined) discard(challengeId, challenge);
      for (const [controller, value] of active) if (value.operationId === challengeId) {
        active.delete(controller); controller.abort();
      }
    },
    cancelForDevice(binding: Readonly<{ subjectHumanId: string; issuingDeviceId: string }>): void {
      cancel((value) => value.humanActorId === binding.subjectHumanId
        && value.clientDeviceId === binding.issuingDeviceId);
    },
    cancelForClientSession(clientActionSessionId: string): void {
      cancel((value) => value.clientActionSessionId === clientActionSessionId);
    },
    cancelForHuman(subjectHumanId: string): void {
      cancel((value) => value.humanActorId === subjectHumanId);
    },
    close(): void { closed = true; cancel(() => true); },
  });
}
