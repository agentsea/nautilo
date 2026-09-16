import type { NautiloApiClient } from "@nautilo/api-client/browser";
import {
  DOMAIN_NAMESPACE_GENERATION_KEY_BYTES,
  accessRevision,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainNamespaceGenerationHeadDigest,
  domainNamespaceRetainedAuthoritySetDigest,
  humanId,
  namespaceGeneration,
  namespaceId,
  openDomainKeyRecipientEnvelope,
  prepareDomainNamespaceBundle,
  withOpenedDomainNamespaceBundle,
  type DomainKeyClass,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto";
import {
  destroyDomainKeyRecipientEnvelopeV2,
  destroyDomainNamespaceBundleBindingV2,
  verifyDomainNamespaceBundleBindingV2,
} from "@nautilo/lattice-crypto/wire";

import {
  authenticateClientDeviceProfileV4,
  destroyOpenedClientDeviceProfileV4,
} from "../../client-vault/profile-v4.ts";
import type {
  ClientProfileCoordinates,
  ClientProfileVault,
} from "../../client-vault/types.ts";
import type {
  DomainKeyAuthorityClientV2,
  OpenedDomainKeyAuthorityV2,
} from "./domain-key-authority-client.ts";

type Api = Pick<
  NautiloApiClient,
  "planDomainNamespaceBundleV2" | "publishDomainNamespaceBundleV2"
>;

export type OpenedDomainNamespaceGenerationV2 = Readonly<{
  namespaceId: string;
  keyClass: DomainKeyClass;
  accessRevision: number;
  generation: number;
  headDigest: Uint8Array;
  generationKey: Uint8Array;
}>;

/**
 * Current signed Domain/Namespace coordinates for one opened bundle.
 *
 * `sourceRoomId` is the authenticated route context used to fetch the bundle;
 * it is not a field in the signed Domain Namespace binding. Every byte array
 * is borrowed for the callback lifetime and is wiped when the callback exits.
 */
export type OpenedDomainNamespaceAuthorityV2 = Readonly<{
  sourceRoomId: string;
  serverId: string;
  namespaceId: string;
  keyClass: DomainKeyClass;
  namespaceAccessRevision: number;
  namespaceKeyGeneration: number;
  namespaceHeadDigest: Uint8Array;
  domainId: string;
  domainKeyGeneration: number;
  domainAuthorizationRevision: number;
  domainHeadDigest: Uint8Array;
  bundleRevision: number;
  bundleDigest: Uint8Array;
}>;

export type DomainNamespaceAccessResultV2<Value> =
  | Readonly<{ status: "opened"; value: Value }>
  | Readonly<{
      status: "pending" | "unavailable";
      reason: string;
    }>;

/** Content-free Room coverage observation safe to expose to renderer UI. */
export type ProtectedRoomAccessStateV2 = Readonly<{
  roomId: string;
  namespaceId: string;
  keyClass: DomainKeyClass;
  status: "ready" | "waiting";
  reason?: string;
}>;

export interface DomainNamespaceAuthorityClientV2 {
  ensure(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    signal?: AbortSignal;
  }>): Promise<
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "pending" | "unavailable"; reason: string }>
  >;
  withOpenedGenerations<Value>(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    expectedAccessRevision?: number;
    expectedCurrentGeneration?: number;
    expectedCurrentHeadDigest?: Uint8Array;
    signal?: AbortSignal;
  }>, use: (
    entries: readonly OpenedDomainNamespaceGenerationV2[],
    authority: OpenedDomainNamespaceAuthorityV2,
  ) => Value | Promise<Value>): Promise<DomainNamespaceAccessResultV2<Value>>;
  servicePending(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    signal?: AbortSignal;
  }>): Promise<number>;
}

function toBase64url(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.length; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function fromBase64url(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/")
    + "=".repeat((4 - value.length % 4) % 4);
  const decoded = Uint8Array.from(
    atob(padded),
    (character) => character.charCodeAt(0),
  );
  if (decoded.length === 0 || toBase64url(decoded) !== value) {
    decoded.fill(0);
    throw new TypeError("Domain Namespace authority bytes are noncanonical");
  }
  return decoded;
}

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function wipe(values: readonly (Uint8Array | null | undefined)[]): void {
  values.forEach((value) => value?.fill(0));
}

function destroyOpened(
  values: readonly OpenedDomainNamespaceGenerationV2[],
): void {
  values.forEach((entry) => wipe([entry.headDigest, entry.generationKey]));
}

function authorityMatches(
  authority: OpenedDomainKeyAuthorityV2,
  expected: Readonly<{
    serverId: string;
    domainId: string;
    participantDigest: Uint8Array;
    participantCount: number;
    keyClass: DomainKeyClass;
    domainKeyGeneration: number;
    authorizationRevision: number;
    headDigest: Uint8Array;
  }>,
): boolean {
  return authority.serverId === expected.serverId
    && authority.domainId === expected.domainId
    && same(authority.participantDigest, expected.participantDigest)
    && authority.participantCount === expected.participantCount
    && authority.keyClass === expected.keyClass
    && authority.domainKeyGeneration === expected.domainKeyGeneration
    && authority.authorizationRevision === expected.authorizationRevision
    && same(authority.headDigest, expected.headDigest);
}

function nativeGenerationChainMatches(
  crypto: LatticeCrypto,
  input: Readonly<{
    serverId: string;
    namespaceId: string;
    keyClass: DomainKeyClass;
    retained: readonly Readonly<{
      accessRevision: number;
      generation: number;
      headDigest: Uint8Array;
      generationKey: Uint8Array;
    }>[];
  }>,
): boolean {
  let previous: Uint8Array | null = null;
  try {
    for (const entry of input.retained) {
      const expected = domainNamespaceGenerationHeadDigest(crypto, {
        serverId: input.serverId,
        namespaceId: namespaceId(input.namespaceId),
        keyClass: input.keyClass,
        accessRevision: accessRevision(entry.accessRevision),
        generation: namespaceGeneration(entry.generation),
        previousHeadDigest: previous,
        generationKey: entry.generationKey,
      });
      if (!same(expected, entry.headDigest)) {
        expected.fill(0);
        return false;
      }
      previous?.fill(0);
      previous = expected;
    }
    return true;
  } finally {
    previous?.fill(0);
  }
}

export function createDomainNamespaceAuthorityClientV2(input: Readonly<{
  api: Api;
  crypto: LatticeCrypto;
  vault: ClientProfileVault;
  coordinates: ClientProfileCoordinates;
  domainAuthority: DomainKeyAuthorityClientV2;
  serverId: string;
  now: () => number;
  createId: () => string;
  onAccessState?: (state: ProtectedRoomAccessStateV2) => void;
}>): DomainNamespaceAuthorityClientV2 {
  const observe = (
    request: Parameters<DomainNamespaceAuthorityClientV2["ensure"]>[0],
    result:
      | Readonly<{ status: "ready" }>
      | Readonly<{ status: "pending" | "unavailable"; reason: string }>,
  ) => {
    input.onAccessState?.(Object.freeze({
      roomId: request.sourceRoomId,
      namespaceId: request.namespaceId,
      keyClass: request.keyClass,
      status: result.status === "ready" ? "ready" as const : "waiting" as const,
      ...(result.status === "ready" ? {} : { reason: result.reason }),
    }));
    return result;
  };
  const withProfile = async <Value>(use: (
    profile: Awaited<ReturnType<typeof authenticateClientDeviceProfileV4>>,
  ) => Value | Promise<Value>): Promise<Value | null> => {
    const available = await input.vault.availability();
    if (
      available.status !== "available"
      && (await input.vault.unlock()).status !== "available"
    ) return null;
    return input.vault.withOpenProfile(input.coordinates, async (profileBytes) => {
      let profile;
      try {
        profile = await authenticateClientDeviceProfileV4({
          crypto: input.crypto,
          profileBytes,
          expectedDeviceId: input.coordinates.deviceId,
        });
      } catch {
        return null;
      }
      try {
        return await use(profile);
      } finally {
        destroyOpenedClientDeviceProfileV4(profile);
      }
    });
  };

  const publishInitial = async (
    request: Readonly<{
      sourceRoomId: string;
      namespaceId: string;
      keyClass: DomainKeyClass;
      signal?: AbortSignal;
    }>,
    plan: Extract<
      Awaited<ReturnType<Api["planDomainNamespaceBundleV2"]>>,
      { status: "create_required" }
    >,
  ): Promise<boolean> => {
    const generationKey = input.crypto.randomBytes(
      DOMAIN_NAMESPACE_GENERATION_KEY_BYTES,
    );
    const generationHeadDigest = domainNamespaceGenerationHeadDigest(
      input.crypto,
      {
        serverId: input.serverId,
        namespaceId: namespaceId(request.namespaceId),
        keyClass: request.keyClass,
        accessRevision: accessRevision(plan.namespaceAccessRevision),
        generation: namespaceGeneration(0),
        previousHeadDigest: null,
        generationKey,
      },
    );
    const generations = Object.freeze([Object.freeze({
      namespaceId: request.namespaceId,
      keyClass: request.keyClass,
      accessRevision: plan.namespaceAccessRevision,
      generation: 0,
      headDigest: generationHeadDigest,
      generationKey,
    })]);
    const participantDigest = fromBase64url(
      plan.participantDigestBase64url,
    );
    const domainHeadDigest = fromBase64url(plan.domainHeadDigestBase64url);
    const expectedRetainedDigest = domainNamespaceRetainedAuthoritySetDigest(
      input.crypto,
      generations.map((entry) => Object.freeze({
        generation: namespaceGeneration(entry.generation),
        accessRevision: accessRevision(entry.accessRevision),
        headDigest: entry.headDigest,
      })),
    );
    try {
      const opened = await input.domainAuthority.withDomainKey(
        request,
        async (domainKey, domainAuthority) => {
          if (!authorityMatches(domainAuthority, {
            serverId: input.serverId,
            domainId: plan.domainId,
            participantDigest,
            participantCount: plan.participantCount,
            keyClass: plan.keyClass,
            domainKeyGeneration: plan.domainKeyGeneration,
            authorizationRevision: plan.domainAuthorizationRevision,
            headDigest: domainHeadDigest,
          })) return false;
          return await withProfile(async (profile) => {
            const base = profile.baseProfile.baseProfile;
            if (
              base.deviceId !== plan.issuerDeviceId
              || plan.issuerHumanId !== input.coordinates.humanActorId
              || plan.namespaceId !== request.namespaceId
            ) return false;
            const prepared = prepareDomainNamespaceBundle(input.crypto, {
              operationId: input.createId(),
              bundle: {
                formatVersion: 2,
                purpose: "domain_key.namespace_bundle",
                serverId: input.serverId,
                cryptoDomainId: cryptoDomainId(plan.domainId),
                participantDigest,
                participantCount: plan.participantCount,
                keyClass: plan.keyClass,
                domainKeyGeneration: plan.domainKeyGeneration,
                domainAuthorizationRevision: authorizationRevision(
                  plan.domainAuthorizationRevision,
                ),
                domainHeadDigest,
                namespaceId: namespaceId(request.namespaceId),
                namespaceAccessRevision: accessRevision(
                  plan.namespaceAccessRevision,
                ),
                namespaceCurrentGeneration: namespaceGeneration(
                  plan.namespaceCurrentGeneration,
                ),
                bundleRevision: plan.bundleRevision,
                retainedGenerationCount: generations.length,
                retainedAuthoritySetDigest: expectedRetainedDigest,
                retainedGenerations: generations.map((entry) => ({
                  generation: namespaceGeneration(entry.generation),
                  accessRevision: accessRevision(entry.accessRevision),
                  headDigest: entry.headDigest,
                  generationKey: entry.generationKey,
                })),
              },
              previousBindingDigest: null,
              issuerHumanId: humanId(plan.issuerHumanId),
              issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
              issuerDeviceSigningGeneration:
                plan.issuerDeviceSigningGeneration,
              issuerSigningPrivateKey: base.signingPrivateKey,
              issuerSigningPublicKey: base.signingPublicKey,
              domainKey,
              issuedAt: input.now(),
            });
            try {
              const response = await input.api.publishDomainNamespaceBundleV2(
                request.sourceRoomId,
                request.namespaceId,
                {
                  requestVersion: 2,
                  serverId: input.serverId,
                  clientDeviceId: input.coordinates.deviceId,
                  keyClass: request.keyClass,
                  operationId: prepared.binding.operationId,
                  idempotencyKey: input.createId(),
                  bindingBytesBase64url: toBase64url(prepared.bytes),
                },
                request.signal === undefined
                  ? undefined
                  : {signal: request.signal},
              );
              const responseDigest = fromBase64url(
                response.bindingDigestBase64url,
              );
              try {
                return response.namespaceId === request.namespaceId
                  && response.domainId === plan.domainId
                  && response.keyClass === request.keyClass
                  && same(responseDigest, prepared.bindingDigest);
              } finally {
                responseDigest.fill(0);
              }
            } finally {
              destroyDomainNamespaceBundleBindingV2(prepared.binding);
              wipe([
                prepared.bytes,
                prepared.bindingDigest,
                prepared.plaintextDigest,
              ]);
            }
          }) === true;
        },
      );
      return opened.status === "opened" && opened.value === true;
    } finally {
      destroyOpened(generations);
      wipe([participantDigest, domainHeadDigest, expectedRetainedDigest]);
    }
  };

  const publishReplacement = async (
    request: Readonly<{
      sourceRoomId: string;
      namespaceId: string;
      keyClass: DomainKeyClass;
      signal?: AbortSignal;
    }>,
    plan: Extract<
      Awaited<ReturnType<Api["planDomainNamespaceBundleV2"]>>,
      { status: "replace_required" }
    >,
  ): Promise<boolean> => {
    const sourceBindingBytes = fromBase64url(
      plan.sourceBindingBytesBase64url,
    );
    const sourceBindingDigest = fromBase64url(
      plan.sourceBindingDigestBase64url,
    );
    const sourceIssuerSigningPublicKey = fromBase64url(
      plan.sourceIssuerSigningPublicKeyBase64url,
    );
    const sourceEnvelopeBytes = fromBase64url(
      plan.sourceEnvelopeBytesBase64url,
    );
    const sourceEnvelopeDigest = fromBase64url(
      plan.sourceEnvelopeDigestBase64url,
    );
    const sourceEnvelopeIssuerSigningPublicKey = fromBase64url(
      plan.sourceEnvelopeIssuerSigningPublicKeyBase64url,
    );
    const previousBindingDigest = fromBase64url(
      plan.previousBindingDigestBase64url,
    );
    const sourceBinding = verifyDomainNamespaceBundleBindingV2(input.crypto, {
      bindingBytes: sourceBindingBytes,
      expectedBindingDigest: sourceBindingDigest,
      issuerSigningPublicKey: sourceIssuerSigningPublicKey,
    });
    if (sourceBinding === null) {
      wipe([
        sourceBindingBytes,
        sourceBindingDigest,
        sourceIssuerSigningPublicKey,
        sourceEnvelopeBytes,
        sourceEnvelopeDigest,
        sourceEnvelopeIssuerSigningPublicKey,
        previousBindingDigest,
      ]);
      return false;
    }
    let oldGenerations: readonly OpenedDomainNamespaceGenerationV2[] = [];
    try {
      if (
        sourceBinding.serverId !== input.serverId
        || sourceBinding.namespaceId !== request.namespaceId
        || sourceBinding.keyClass !== request.keyClass
        || sourceBinding.bundleRevision + 1 !== plan.bundleRevision
        || !same(sourceBindingDigest, previousBindingDigest)
      ) return false;
      const openedSource = await withProfile(async (profile) => {
        const base = profile.baseProfile.baseProfile;
        const openedEnvelope = await openDomainKeyRecipientEnvelope(
          input.crypto,
          {
            envelopeBytes: sourceEnvelopeBytes,
            expectedEnvelopeDigest: sourceEnvelopeDigest,
            issuerSigningPublicKey:
              sourceEnvelopeIssuerSigningPublicKey,
            recipientHumanId: humanId(input.coordinates.humanActorId),
            recipientKind: "device",
            recipientKeyId: input.coordinates.deviceId,
            recipientKeyGeneration:
              plan.sourceRecipientDeviceSigningGeneration,
            recipientPrivateKey: base.encryptionPrivateKey,
          },
        );
        if (openedEnvelope === null) return null;
        try {
          const envelope = openedEnvelope.envelope;
          if (
            envelope.serverId !== sourceBinding.serverId
            || envelope.cryptoDomainId !== sourceBinding.cryptoDomainId
            || envelope.keyClass !== sourceBinding.keyClass
            || envelope.domainKeyGeneration
              !== sourceBinding.domainKeyGeneration
            || envelope.authorizationRevision
              !== sourceBinding.domainAuthorizationRevision
            || !same(envelope.participantDigest, sourceBinding.participantDigest)
            || !same(envelope.headDigest, sourceBinding.domainHeadDigest)
          ) return null;
          const openedBundle = await withOpenedDomainNamespaceBundle(
            input.crypto,
            {
              bindingBytes: sourceBindingBytes,
              expectedBindingDigest: sourceBindingDigest,
              issuerSigningPublicKey: sourceIssuerSigningPublicKey,
              domainKey: openedEnvelope.domainKey,
              current: {
                serverId: sourceBinding.serverId,
                cryptoDomainId: sourceBinding.cryptoDomainId,
                participantDigest: sourceBinding.participantDigest,
                participantCount: sourceBinding.participantCount,
                keyClass: sourceBinding.keyClass,
                domainKeyGeneration: sourceBinding.domainKeyGeneration,
                domainAuthorizationRevision:
                  sourceBinding.domainAuthorizationRevision,
                domainHeadDigest: sourceBinding.domainHeadDigest,
                namespaceId: sourceBinding.namespaceId,
                namespaceAccessRevision:
                  sourceBinding.namespaceAccessRevision,
                namespaceCurrentGeneration:
                  sourceBinding.namespaceCurrentGeneration,
                bundleRevision: sourceBinding.bundleRevision,
                retainedAuthoritySetDigest:
                  sourceBinding.retainedAuthoritySetDigest,
              },
              operation: (retained) => Object.freeze(retained.map((entry) =>
                Object.freeze({
                  namespaceId: sourceBinding.namespaceId,
                  keyClass: sourceBinding.keyClass,
                  accessRevision: entry.accessRevision,
                  generation: entry.generation,
                  headDigest: entry.headDigest.slice(),
                  generationKey: entry.generationKey.slice(),
                })
              )),
            },
          );
          if (
            openedBundle.status !== "opened"
            || !nativeGenerationChainMatches(input.crypto, {
              serverId: sourceBinding.serverId,
              namespaceId: sourceBinding.namespaceId,
              keyClass: sourceBinding.keyClass,
              retained: openedBundle.value,
            })
          ) {
            if (openedBundle.status === "opened") {
              destroyOpened(openedBundle.value);
            }
            return null;
          }
          return openedBundle.value;
        } finally {
          destroyDomainKeyRecipientEnvelopeV2(openedEnvelope.envelope);
          wipe([openedEnvelope.envelopeDigest, openedEnvelope.domainKey]);
        }
      });
      if (openedSource === null) return false;
      oldGenerations = openedSource;
      if (
        oldGenerations.length !== sourceBinding.retainedGenerationCount
        || oldGenerations.at(-1)?.generation
          !== sourceBinding.namespaceCurrentGeneration
      ) return false;
      let latest: readonly OpenedDomainNamespaceGenerationV2[] = [];
      try {
        if (plan.advanceGeneration) {
          const generationKey = input.crypto.randomBytes(
            DOMAIN_NAMESPACE_GENERATION_KEY_BYTES,
          );
          const generationHeadDigest = domainNamespaceGenerationHeadDigest(
            input.crypto,
            {
              serverId: input.serverId,
              namespaceId: namespaceId(request.namespaceId),
              keyClass: request.keyClass,
              accessRevision: accessRevision(plan.namespaceAccessRevision),
              generation: namespaceGeneration(plan.namespaceCurrentGeneration),
              previousHeadDigest: oldGenerations.at(-1)!.headDigest,
              generationKey,
            },
          );
          latest = Object.freeze([Object.freeze({
            namespaceId: request.namespaceId,
            keyClass: request.keyClass,
            accessRevision: plan.namespaceAccessRevision,
            generation: plan.namespaceCurrentGeneration,
            headDigest: generationHeadDigest,
            generationKey,
          })]);
        }
        const generations = Object.freeze([...oldGenerations, ...latest]);
        if (
          generations.length !== plan.retainedGenerationCount
          || generations.at(-1)?.generation
            !== plan.namespaceCurrentGeneration
        ) return false;
        const participantDigest = fromBase64url(
          plan.participantDigestBase64url,
        );
        const domainHeadDigest = fromBase64url(
          plan.domainHeadDigestBase64url,
        );
        const expectedRetainedDigest = domainNamespaceRetainedAuthoritySetDigest(
          input.crypto,
          generations.map((entry) => ({
            generation: namespaceGeneration(entry.generation),
            accessRevision: accessRevision(entry.accessRevision),
            headDigest: entry.headDigest,
          })),
        );
        try {
          const target = await input.domainAuthority.withDomainKey(
            request,
            async (domainKey, domainAuthority) => {
              if (!authorityMatches(domainAuthority, {
                serverId: input.serverId,
                domainId: plan.domainId,
                participantDigest,
                participantCount: plan.participantCount,
                keyClass: plan.keyClass,
                domainKeyGeneration: plan.domainKeyGeneration,
                authorizationRevision: plan.domainAuthorizationRevision,
                headDigest: domainHeadDigest,
              })) return false;
              return await withProfile(async (profile) => {
                const base = profile.baseProfile.baseProfile;
                if (
                  base.deviceId !== plan.issuerDeviceId
                  || plan.issuerHumanId !== input.coordinates.humanActorId
                ) return false;
                const prepared = prepareDomainNamespaceBundle(input.crypto, {
                  operationId: input.createId(),
                  bundle: {
                    formatVersion: 2,
                    purpose: "domain_key.namespace_bundle",
                    serverId: input.serverId,
                    cryptoDomainId: cryptoDomainId(plan.domainId),
                    participantDigest,
                    participantCount: plan.participantCount,
                    keyClass: plan.keyClass,
                    domainKeyGeneration: plan.domainKeyGeneration,
                    domainAuthorizationRevision: authorizationRevision(
                      plan.domainAuthorizationRevision,
                    ),
                    domainHeadDigest,
                    namespaceId: namespaceId(request.namespaceId),
                    namespaceAccessRevision: accessRevision(
                      plan.namespaceAccessRevision,
                    ),
                    namespaceCurrentGeneration: namespaceGeneration(
                      plan.namespaceCurrentGeneration,
                    ),
                    bundleRevision: plan.bundleRevision,
                    retainedGenerationCount: generations.length,
                    retainedAuthoritySetDigest: expectedRetainedDigest,
                    retainedGenerations: generations.map((entry) => ({
                      generation: namespaceGeneration(entry.generation),
                      accessRevision: accessRevision(entry.accessRevision),
                      headDigest: entry.headDigest,
                      generationKey: entry.generationKey,
                    })),
                  },
                  previousBindingDigest,
                  issuerHumanId: humanId(plan.issuerHumanId),
                  issuerDeviceId: cryptoDeviceId(plan.issuerDeviceId),
                  issuerDeviceSigningGeneration:
                    plan.issuerDeviceSigningGeneration,
                  issuerSigningPrivateKey: base.signingPrivateKey,
                  issuerSigningPublicKey: base.signingPublicKey,
                  domainKey,
                  issuedAt: input.now(),
                });
                try {
                  const response = await input.api
                    .publishDomainNamespaceBundleV2(
                      request.sourceRoomId,
                      request.namespaceId,
                      {
                        requestVersion: 2,
                        serverId: input.serverId,
                        clientDeviceId: input.coordinates.deviceId,
                        keyClass: request.keyClass,
                        operationId: prepared.binding.operationId,
                        idempotencyKey: input.createId(),
                        bindingBytesBase64url: toBase64url(prepared.bytes),
                      },
                      request.signal === undefined
                        ? undefined
                        : {signal: request.signal},
                    );
                  const responseDigest = fromBase64url(
                    response.bindingDigestBase64url,
                  );
                  try {
                    return response.namespaceId === request.namespaceId
                      && response.domainId === plan.domainId
                      && response.keyClass === request.keyClass
                      && same(responseDigest, prepared.bindingDigest);
                  } finally {
                    responseDigest.fill(0);
                  }
                } finally {
                  destroyDomainNamespaceBundleBindingV2(prepared.binding);
                  wipe([
                    prepared.bytes,
                    prepared.bindingDigest,
                    prepared.plaintextDigest,
                  ]);
                }
              }) === true;
            },
          );
          return target.status === "opened" && target.value === true;
        } finally {
          wipe([participantDigest, domainHeadDigest, expectedRetainedDigest]);
        }
      } finally {
        destroyOpened(latest);
      }
    } finally {
      destroyOpened(oldGenerations);
      destroyDomainNamespaceBundleBindingV2(sourceBinding);
      wipe([
        sourceBindingBytes,
        sourceBindingDigest,
        sourceIssuerSigningPublicKey,
        sourceEnvelopeBytes,
        sourceEnvelopeDigest,
        sourceEnvelopeIssuerSigningPublicKey,
        previousBindingDigest,
      ]);
    }
  };

  const planBundle = (
    request: Parameters<DomainNamespaceAuthorityClientV2["ensure"]>[0],
  ) => input.api.planDomainNamespaceBundleV2(
    request.sourceRoomId,
    request.namespaceId,
    {
      requestVersion: 2,
      serverId: input.serverId,
      clientDeviceId: input.coordinates.deviceId,
      keyClass: request.keyClass,
    },
    request.signal === undefined ? undefined : {signal: request.signal},
  );

  const client: DomainNamespaceAuthorityClientV2 = Object.freeze({
    async ensure(
      request: Parameters<DomainNamespaceAuthorityClientV2["ensure"]>[0],
    ) {
      const domain = await input.domainAuthority.ensure(request);
      if (domain.status !== "ready") return observe(request, domain);
      await client.servicePending(request);
      const planned = await planBundle(request);
      if (planned.status === "unavailable") {
        if (planned.reason === "recipient_sync_required") {
          return observe(request, Object.freeze({
            status: "pending" as const,
            reason: "qualified_source_required",
          }));
        }
        return observe(request, Object.freeze({
          status: "unavailable" as const,
          reason: planned.reason,
        }));
      }
      if (planned.status === "ready") {
        return observe(request, Object.freeze({ status: "ready" as const }));
      }
      const published = planned.status === "create_required"
        ? await publishInitial(request, planned)
        : await publishReplacement(request, planned);
      if (!published) {
        const raced = await planBundle(request);
        if (raced.status === "ready") {
          return observe(request, Object.freeze({ status: "ready" as const }));
        }
        return observe(request, Object.freeze({
          status: "unavailable" as const,
          reason: "bundle_source_unavailable",
        }));
      }
      return observe(request, Object.freeze({ status: "ready" as const }));
    },

    async withOpenedGenerations<Value>(
      request: Parameters<
        DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
      >[0],
      use: (
        entries: readonly OpenedDomainNamespaceGenerationV2[],
        authority: OpenedDomainNamespaceAuthorityV2,
      ) => Value | Promise<Value>,
    ): Promise<DomainNamespaceAccessResultV2<Value>> {
      const ensured = await client.ensure(request);
      if (ensured.status !== "ready") return ensured;
      const planned = await planBundle(request);
      if (planned.status === "unavailable") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: planned.reason,
        });
      }
      if (
        planned.status === "create_required"
        || planned.status === "replace_required"
      ) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "bundle_not_ready",
        });
      }
      const bindingBytes = fromBase64url(planned.bindingBytesBase64url);
      const bindingDigest = fromBase64url(planned.bindingDigestBase64url);
      const issuerSigningPublicKey = fromBase64url(
        planned.issuerSigningPublicKeyBase64url,
      );
      const binding = verifyDomainNamespaceBundleBindingV2(input.crypto, {
        bindingBytes,
        issuerSigningPublicKey,
        expectedBindingDigest: bindingDigest,
      });
      if (binding === null) {
        wipe([bindingBytes, bindingDigest, issuerSigningPublicKey]);
        return Object.freeze({
          status: "unavailable" as const,
          reason: "binding_invalid",
        });
      }
      try {
        if (
          binding.serverId !== input.serverId
          || binding.namespaceId !== request.namespaceId
          || binding.keyClass !== request.keyClass
          || (request.expectedAccessRevision !== undefined
            && binding.namespaceAccessRevision
              !== request.expectedAccessRevision)
          || (request.expectedCurrentGeneration !== undefined
            && binding.namespaceCurrentGeneration
              !== request.expectedCurrentGeneration)
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "binding_stale",
          });
        }
        const opened = await input.domainAuthority.withDomainKey(
          request,
          async (domainKey, domainAuthority) => {
            if (!authorityMatches(domainAuthority, {
              serverId: input.serverId,
              domainId: binding.cryptoDomainId,
              participantDigest: binding.participantDigest,
              participantCount: binding.participantCount,
              keyClass: binding.keyClass,
              domainKeyGeneration: binding.domainKeyGeneration,
              authorizationRevision: binding.domainAuthorizationRevision,
              headDigest: binding.domainHeadDigest,
            })) {
              return Object.freeze({
                status: "unavailable" as const,
                reason: "domain_stale",
              });
            }
            return withOpenedDomainNamespaceBundle(input.crypto, {
              bindingBytes,
              expectedBindingDigest: bindingDigest,
              issuerSigningPublicKey,
              domainKey,
              current: {
                serverId: binding.serverId,
                cryptoDomainId: binding.cryptoDomainId,
                participantDigest: binding.participantDigest,
                participantCount: binding.participantCount,
                keyClass: binding.keyClass,
                domainKeyGeneration: binding.domainKeyGeneration,
                domainAuthorizationRevision:
                  binding.domainAuthorizationRevision,
                domainHeadDigest: binding.domainHeadDigest,
                namespaceId: binding.namespaceId,
                namespaceAccessRevision: binding.namespaceAccessRevision,
                namespaceCurrentGeneration:
                  binding.namespaceCurrentGeneration,
                bundleRevision: binding.bundleRevision,
                retainedAuthoritySetDigest:
                  binding.retainedAuthoritySetDigest,
              },
              operation: async (retained) => {
                if (!nativeGenerationChainMatches(input.crypto, {
                  serverId: binding.serverId,
                  namespaceId: binding.namespaceId,
                  keyClass: binding.keyClass,
                  retained,
                })) {
                  throw new TypeError("Namespace generation chain is invalid");
                }
                const prefixDigests = retained.map((_, index) =>
                  domainNamespaceRetainedAuthoritySetDigest(
                    input.crypto,
                    retained.slice(0, index + 1),
                  )
                );
                try {
                  if (
                    request.expectedCurrentHeadDigest !== undefined
                    && !same(
                      prefixDigests.at(-1)!,
                      request.expectedCurrentHeadDigest,
                    )
                  ) throw new TypeError("Namespace current head is stale");
                  const entries = Object.freeze(retained.map((entry, index) =>
                    Object.freeze({
                      namespaceId: binding.namespaceId,
                      keyClass: binding.keyClass,
                      accessRevision: entry.accessRevision,
                      generation: entry.generation,
                      headDigest: prefixDigests[index]!,
                      generationKey: entry.generationKey,
                    })
                  ));
                  return await use(entries, Object.freeze({
                    sourceRoomId: request.sourceRoomId,
                    serverId: binding.serverId,
                    namespaceId: binding.namespaceId,
                    keyClass: binding.keyClass,
                    namespaceAccessRevision:
                      binding.namespaceAccessRevision,
                    namespaceKeyGeneration:
                      binding.namespaceCurrentGeneration,
                    namespaceHeadDigest: prefixDigests.at(-1)!,
                    domainId: binding.cryptoDomainId,
                    domainKeyGeneration: binding.domainKeyGeneration,
                    domainAuthorizationRevision:
                      binding.domainAuthorizationRevision,
                    domainHeadDigest: binding.domainHeadDigest,
                    bundleRevision: binding.bundleRevision,
                    bundleDigest: bindingDigest,
                  }));
                } finally {
                  prefixDigests.forEach((digest) => digest.fill(0));
                }
              },
            });
          },
        );
        if (opened.status !== "opened") return opened;
        return opened.value.status === "opened"
          ? Object.freeze({
              status: "opened" as const,
              value: opened.value.value,
            })
          : Object.freeze({
              status: "unavailable" as const,
              reason: opened.value.reason,
            });
      } catch {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "bundle_open_failed",
        });
      } finally {
        destroyDomainNamespaceBundleBindingV2(binding);
        wipe([bindingBytes, bindingDigest, issuerSigningPublicKey]);
      }
    },

    async servicePending(
      request: Parameters<DomainNamespaceAuthorityClientV2["servicePending"]>[0],
    ): Promise<number> {
      const serviced = await input.domainAuthority.servicePending(request);
      return serviced.status === "ready" ? serviced.fulfilled : 0;
    },
  });
  return client;
}
