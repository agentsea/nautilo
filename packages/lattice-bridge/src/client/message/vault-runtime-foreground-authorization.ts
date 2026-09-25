import {
  mintDomainForegroundAuthorization,
  type DomainForegroundSecretEntry,
  type LatticeCrypto,
  decodeHumanAiReadableLiveShadowMessagePlan,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainForegroundAuthorizationPlanV2,
  destroyDomainForegroundAuthorizationV2,
  parseDomainForegroundAuthorizationPlanV2,
  serializeDomainForegroundAuthorizationV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import type { DomainForegroundAuthorityClientV2 } from
  "./domain-foreground-authority-client.ts";

export type PrepareVaultRuntimeForegroundAuthorizationResult =
  | Readonly<{
    status: "prepared";
    authorizationBytes: Uint8Array;
    authorizationDigest: Uint8Array;
  }>
  | Readonly<{
    status: "unavailable";
    reason:
      | "plan_stale"
      | "profile_unavailable"
      | "profile_invalid"
      | "domain_unavailable";
  }>;

function unavailable(
  reason: Extract<PrepareVaultRuntimeForegroundAuthorizationResult, {
    status: "unavailable";
  }>["reason"],
): PrepareVaultRuntimeForegroundAuthorizationResult {
  return Object.freeze({ status: "unavailable", reason });
}

function destroyHumanPlan(plan: ReturnType<
  typeof decodeHumanAiReadableLiveShadowMessagePlan
>): void {
  plan.namespaceHeadDigest.fill(0);
  plan.namespacePublicationDigest.fill(0);
  plan.namespacePublicationSetDigest.fill(0);
  plan.namespaceAudienceFingerprint.fill(0);
}

type VaultRuntimeAuthorizationInput = Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  domainForegroundAuthority: DomainForegroundAuthorityClientV2;
  authorizationPlanBytes: Uint8Array;
  sourceHumanPlanBytes?: Uint8Array;
  recipientPublicKey: Uint8Array;
  expectedSessionId: string;
  expectedSourceRoomId?: string;
  expectedRecipientPrincipalId?: string;
  now: number;
}>;

async function prepareVaultRuntimeAuthorization(
  input: VaultRuntimeAuthorizationInput,
): Promise<PrepareVaultRuntimeForegroundAuthorizationResult> {
  const plan = parseDomainForegroundAuthorizationPlanV2(
    input.authorizationPlanBytes,
  );
  if (plan === null) return unavailable("plan_stale");
  let humanPlan: ReturnType<
    typeof decodeHumanAiReadableLiveShadowMessagePlan
  > | null = null;
  try {
    if (input.sourceHumanPlanBytes !== undefined) {
      try {
        humanPlan = decodeHumanAiReadableLiveShadowMessagePlan(
          input.sourceHumanPlanBytes,
        );
      } catch {
        return unavailable("plan_stale");
      }
    }
    if (
      !Number.isSafeInteger(input.now)
      || input.now < plan.issuedAt
      || input.now >= plan.deadlineAt
      || plan.recipientKind !== "runtime"
      || plan.sessionId !== input.expectedSessionId
      || (
        input.expectedSourceRoomId !== undefined
        && plan.roomId !== input.expectedSourceRoomId
      )
      || (
        input.expectedRecipientPrincipalId !== undefined
        && plan.recipientPrincipalId !== input.expectedRecipientPrincipalId
      )
      || (humanPlan !== null && (
        plan.roomId !== humanPlan.roomId
        || plan.subjectHumanId !== humanPlan.subjectHumanId
        || plan.committerDeviceId !== humanPlan.committerDeviceId
        || plan.committerDeviceSigningGeneration
          !== humanPlan.committerDeviceSigningKeyGeneration
        || plan.hostAuthorizationRevision
          !== humanPlan.hostAuthorizationRevision
        || plan.policyRevision !== humanPlan.policyRevision
      ))
      || plan.subjectHumanId !== input.coordinates.humanActorId
      || plan.committerDeviceId !== input.coordinates.deviceId
    ) return unavailable("plan_stale");
    const available = await input.vault.availability();
    if (
      available.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) return unavailable("profile_unavailable");

    const opened = await input.domainForegroundAuthority
      .withOpenedAuthorizationDomains({
        sourceRoomId: plan.roomId,
        domains: plan.domains,
      }, (domains: readonly DomainForegroundSecretEntry[]) =>
        input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
          let profile;
          try {
            profile = await authenticateClientDeviceProfileV4({
              crypto: input.crypto,
              profileBytes,
              expectedDeviceId: plan.committerDeviceId,
            });
          } catch {
            return unavailable("profile_invalid");
          }
          try {
            const base = profile.baseProfile.baseProfile;
            if (
              base.deviceId !== plan.committerDeviceId
              || base.trustedHostAuthorizationRevision
                !== plan.hostAuthorizationRevision
            ) return unavailable("plan_stale");
            const minted = await mintDomainForegroundAuthorization(
              input.crypto,
              {
                plan,
                domains,
                committerDeviceSigningPrivateKey: base.signingPrivateKey,
                recipientEncryptionPublicKey: input.recipientPublicKey,
              },
            );
            try {
              const authorizationBytes =
                serializeDomainForegroundAuthorizationV2(minted);
              return Object.freeze({
                status: "prepared" as const,
                authorizationBytes,
                authorizationDigest: input.crypto.hash(authorizationBytes),
              });
            } finally {
              destroyDomainForegroundAuthorizationV2(minted);
            }
          } finally {
            destroyOpenedClientDeviceProfileV4(profile);
          }
        })
      );
    return opened.status === "opened"
      ? opened.value
      : unavailable("domain_unavailable");
  } catch {
    return unavailable("domain_unavailable");
  } finally {
    destroyDomainForegroundAuthorizationPlanV2(plan);
    if (humanPlan !== null) destroyHumanPlan(humanPlan);
  }
}

/** Mint exactly one device-approved, Agent-free foreground Runtime authorization. */
export function prepareVaultRuntimeForegroundAuthorization(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  domainForegroundAuthority: DomainForegroundAuthorityClientV2;
  authorizationPlanBytes: Uint8Array;
  sourceHumanPlanBytes?: Uint8Array;
  recipientPublicKey: Uint8Array;
  browserSessionId: string;
  now: number;
}>): Promise<PrepareVaultRuntimeForegroundAuthorizationResult> {
  return prepareVaultRuntimeAuthorization({
    ...input,
    expectedSessionId: input.browserSessionId,
  });
}

/** Mint one device-approved authorization for an exact Task Runtime episode. */
export function prepareVaultTaskRuntimeAuthorization(input: Readonly<{
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  domainForegroundAuthority: DomainForegroundAuthorityClientV2;
  authorizationPlanBytes: Uint8Array;
  recipientPublicKey: Uint8Array;
  authorizationEpisodeId: string;
  sourceRoomId: string;
  now: number;
}>): Promise<PrepareVaultRuntimeForegroundAuthorizationResult> {
  return prepareVaultRuntimeAuthorization({
    ...input,
    expectedSessionId: input.authorizationEpisodeId,
    expectedSourceRoomId: input.sourceRoomId,
    expectedRecipientPrincipalId: "nautilo_task_runtime",
  });
}
