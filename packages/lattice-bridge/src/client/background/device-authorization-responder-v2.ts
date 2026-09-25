import {
  backgroundProcessorDomainRequirementsV2,
  backgroundProcessorNamespaceRequirementsV2,
  createBackgroundAuthorizationResponseV2,
  decodeAnyBackgroundProcessorWorkDescriptorV2,
  type AnyBackgroundProcessorWorkDescriptorV2,
  type BackgroundAuthorizationIssuerV2,
  type BackgroundNamespaceAuthorityV2,
  type BackgroundProcessorWorkDescriptorV2,
  type BackgroundReflectionWorkDescriptorV2,
  type LatticeCrypto,
} from "@nautilo/lattice-crypto/background";

import type {
  DomainKeyAuthorityClientV2,
  OpenedDomainKeyAuthorityV2,
} from "../message/domain-key-authority-client.ts";
import type {
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceAuthorityV2,
  OpenedDomainNamespaceGenerationV2,
} from "../message/domain-namespace-authority-client.ts";

export type CurrentBackgroundAuthorizationSigningAuthorityV2 = Readonly<{
  issuer: BackgroundAuthorizationIssuerV2;
  /** Borrowed for the callback lifetime. */
  signingPrivateKey: Uint8Array;
  policyRevision: number;
  hostAuthorizationRevision: number;
}>;

export type WithCurrentBackgroundAuthorizationSigningAuthorityV2 = <Value>(
  use: (
    authority: CurrentBackgroundAuthorizationSigningAuthorityV2,
  ) => Value | Promise<Value>,
) => Promise<Value | null>;

export type DeviceAuthorizationResponderResultV2 =
  | Readonly<{
      status: "ready";
      requestId: string;
      recipientGeneration: number;
      expiresAt: number;
      /** Owned by the caller, which must wipe it after transport submission. */
      responseBytes: Uint8Array;
    }>
  | Readonly<{
      status: "pending";
      reason: "namespace_authority_pending" | "domain_authority_pending";
    }>
  | Readonly<{
      status: "unavailable";
      reason:
        | "invalid_descriptor"
        | "invalid_clock"
        | "namespace_authority_unavailable"
        | "domain_authority_unavailable"
        | "signing_authority_unavailable"
        | "response_creation_failed";
    }>
  | Readonly<{
      status: "stale";
      reason:
        | "server_changed"
        | "not_yet_valid"
        | "expired"
        | "namespace_authority_changed"
        | "domain_authority_changed"
        | "device_authority_changed"
        | "policy_changed";
    }>;

export interface DeviceAuthorizationResponderV2Input {
  readonly descriptorBytes: Uint8Array;
  readonly signal?: AbortSignal;
  readonly domainAuthority: DomainKeyAuthorityClientV2;
  readonly namespaceAuthority: DomainNamespaceAuthorityClientV2;
  readonly crypto: LatticeCrypto;
  /** Current M301 server scope, distinct from the M303 server-instance UUID. */
  readonly serverId: string;
  readonly now: () => number;
  readonly createId: () => string;
  readonly withCurrentSigningAuthority:
    WithCurrentBackgroundAuthorizationSigningAuthorityV2;
}

type NonReadyResult = Exclude<
  DeviceAuthorizationResponderResultV2,
  { status: "ready" }
>;

function same(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error(typeof signal.reason === "string"
    ? signal.reason
    : "Background authorization cancelled");
  error.name = "AbortError";
  throw error;
}

function destroyAuthority(authority: BackgroundNamespaceAuthorityV2): void {
  authority.namespaceHeadDigest.fill(0);
  authority.domainHeadDigest.fill(0);
  authority.bundleDigest.fill(0);
}

function isReflectionDescriptor(
  descriptor: AnyBackgroundProcessorWorkDescriptorV2,
): descriptor is BackgroundReflectionWorkDescriptorV2 {
  return descriptor.subject.processorKind === "reflection";
}

function destroyDescriptor(
  descriptor: AnyBackgroundProcessorWorkDescriptorV2,
): void {
  if (isReflectionDescriptor(descriptor)) {
    descriptor.namespaceRequirements.forEach((requirement) => {
      destroyAuthority(requirement.authority);
    });
  } else {
    destroyAuthority(descriptor.authority);
  }
  descriptor.source.fingerprint.fill(0);
  descriptor.recipientPublicKey.fill(0);
}

function currentWindow(
  input: Pick<DeviceAuthorizationResponderV2Input, "now" | "signal">,
  descriptor: AnyBackgroundProcessorWorkDescriptorV2,
): NonReadyResult | null {
  throwIfAborted(input.signal);
  let now: number;
  try {
    now = input.now();
  } catch {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "invalid_clock" as const,
    });
  }
  if (!Number.isSafeInteger(now) || now < 0) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "invalid_clock" as const,
    });
  }
  if (now < descriptor.notBefore) {
    return Object.freeze({
      status: "stale" as const,
      reason: "not_yet_valid" as const,
    });
  }
  if (now >= descriptor.expiresAt) {
    return Object.freeze({
      status: "stale" as const,
      reason: "expired" as const,
    });
  }
  return null;
}

function namespaceAuthorityMatches(
  expected: BackgroundNamespaceAuthorityV2,
  entries: readonly OpenedDomainNamespaceGenerationV2[],
  authority: OpenedDomainNamespaceAuthorityV2,
): boolean {
  const current = entries.find((entry) =>
    entry.namespaceId === expected.namespaceId
    && entry.keyClass === "ai"
    && entry.accessRevision === expected.namespaceAccessRevision
    && entry.generation === expected.namespaceKeyGeneration
    && same(entry.headDigest, expected.namespaceHeadDigest)
  );
  return current !== undefined
    && authority.sourceRoomId === expected.roomId
    && authority.serverId === expected.serverId
    && authority.namespaceId === expected.namespaceId
    && authority.keyClass === "ai"
    && authority.namespaceAccessRevision === expected.namespaceAccessRevision
    && authority.namespaceKeyGeneration === expected.namespaceKeyGeneration
    && same(authority.namespaceHeadDigest, expected.namespaceHeadDigest)
    && authority.domainId === expected.domainId
    && authority.domainKeyGeneration === expected.domainKeyGeneration
    && authority.domainAuthorizationRevision
      === expected.domainAuthorizationRevision
    && same(authority.domainHeadDigest, expected.domainHeadDigest)
    && authority.bundleRevision === expected.bundleRevision
    && same(authority.bundleDigest, expected.bundleDigest);
}

function namespaceMatches(
  descriptor: BackgroundProcessorWorkDescriptorV2,
  entries: readonly OpenedDomainNamespaceGenerationV2[],
  authority: OpenedDomainNamespaceAuthorityV2,
): boolean {
  const expected = descriptor.authority;
  if (descriptor.anchorNamespaceId !== expected.namespaceId
    || descriptor.anchorDomainId !== expected.domainId
    || descriptor.inputBindings.some((binding) =>
      binding.namespaceId !== descriptor.anchorNamespaceId)
    || descriptor.outputSlots.some((slot) =>
      slot.namespaceIds.length !== 1
      || slot.namespaceIds[0] !== descriptor.anchorNamespaceId)) return false;
  return namespaceAuthorityMatches(expected, entries, authority);
}

function domainMatches(
  descriptor: BackgroundProcessorWorkDescriptorV2,
  authority: OpenedDomainKeyAuthorityV2,
): boolean {
  const expected = descriptor.authority;
  return authority.serverId === expected.serverId
    && authority.domainId === expected.domainId
    && authority.keyClass === "ai"
    && authority.domainKeyGeneration === expected.domainKeyGeneration
    && authority.authorizationRevision === expected.domainAuthorizationRevision
    && same(authority.headDigest, expected.domainHeadDigest);
}

async function verifyReflectionNamespace(
  input: DeviceAuthorizationResponderV2Input,
  descriptor: BackgroundReflectionWorkDescriptorV2,
  expected: BackgroundNamespaceAuthorityV2,
): Promise<NonReadyResult | null> {
  let opened;
  try {
    throwIfAborted(input.signal);
    opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: expected.roomId,
      namespaceId: expected.namespaceId,
      keyClass: "ai",
      expectedAccessRevision: expected.namespaceAccessRevision,
      expectedCurrentGeneration: expected.namespaceKeyGeneration,
      expectedCurrentHeadDigest: expected.namespaceHeadDigest,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    }, (entries, authority): NonReadyResult | null => {
      const window = currentWindow(input, descriptor);
      if (window !== null) return window;
      return namespaceAuthorityMatches(expected, entries, authority)
        ? null
        : Object.freeze({
            status: "stale" as const,
            reason: "namespace_authority_changed" as const,
          });
    });
  } catch {
    throwIfAborted(input.signal);
    return Object.freeze({
      status: "unavailable" as const,
      reason: "namespace_authority_unavailable" as const,
    });
  }
  const window = currentWindow(input, descriptor);
  if (window !== null) return window;
  if (opened.status !== "opened") {
    return opened.status === "pending"
      ? Object.freeze({
          status: "pending" as const,
          reason: "namespace_authority_pending" as const,
        })
      : Object.freeze({
          status: "unavailable" as const,
          reason: "namespace_authority_unavailable" as const,
        });
  }
  return opened.value;
}

async function respondToReflectionAuthorizationV2(
  input: DeviceAuthorizationResponderV2Input,
  descriptorBytes: Uint8Array,
  descriptor: BackgroundReflectionWorkDescriptorV2,
): Promise<DeviceAuthorizationResponderResultV2> {
  const namespaceRequirements = backgroundProcessorNamespaceRequirementsV2(
    descriptor,
  );
  const domainRequirements = backgroundProcessorDomainRequirementsV2(descriptor);
  const namespaceByDomain = new Map<string, BackgroundNamespaceAuthorityV2>();
  for (const { authority } of namespaceRequirements) {
    if (!namespaceByDomain.has(authority.domainId)) {
      namespaceByDomain.set(authority.domainId, authority);
    }
  }
  const domainKeys: { domainId: string; key: Uint8Array }[] = [];
  let candidateResponse: Uint8Array | undefined;
  try {
    for (const requirement of namespaceRequirements) {
      const result = await verifyReflectionNamespace(
        input,
        descriptor,
        requirement.authority,
      );
      if (result !== null) return result;
    }

    for (const expected of domainRequirements) {
      const namespace = namespaceByDomain.get(expected.domainId);
      if (namespace === undefined) {
        return Object.freeze({
          status: "unavailable" as const,
          reason: "invalid_descriptor" as const,
        });
      }
      let opened;
      try {
        throwIfAborted(input.signal);
        opened = await input.domainAuthority.withDomainKey({
          sourceRoomId: namespace.roomId,
          namespaceId: namespace.namespaceId,
          keyClass: "ai",
          ...(input.signal === undefined ? {} : { signal: input.signal }),
        }, (domainKey, authority): NonReadyResult | Uint8Array => {
          const window = currentWindow(input, descriptor);
          if (window !== null) return window;
          if (authority.serverId !== namespace.serverId
            || authority.domainId !== expected.domainId
            || authority.keyClass !== "ai"
            || authority.domainKeyGeneration !== expected.domainKeyGeneration
            || authority.authorizationRevision
              !== expected.domainAuthorizationRevision
            || !same(authority.headDigest, expected.domainHeadDigest)) {
            return Object.freeze({
              status: "stale" as const,
              reason: "domain_authority_changed" as const,
            });
          }
          return Uint8Array.from(domainKey);
        });
      } catch {
        throwIfAborted(input.signal);
        return Object.freeze({
          status: "unavailable" as const,
          reason: "domain_authority_unavailable" as const,
        });
      }
      const window = currentWindow(input, descriptor);
      if (window !== null) return window;
      if (opened.status !== "opened") {
        return opened.status === "pending"
          ? Object.freeze({
              status: "pending" as const,
              reason: "domain_authority_pending" as const,
            })
          : Object.freeze({
              status: "unavailable" as const,
              reason: "domain_authority_unavailable" as const,
            });
      }
      if (!(opened.value instanceof Uint8Array)) return opened.value;
      domainKeys.push({ domainId: expected.domainId, key: opened.value });
    }

    // Domain keys are copied outside their cache leases. Revalidate every
    // Namespace immediately before signing so a changed access coordinate
    // cannot authorize a response with an earlier snapshot.
    for (const requirement of namespaceRequirements) {
      const result = await verifyReflectionNamespace(
        input,
        descriptor,
        requirement.authority,
      );
      if (result !== null) return result;
    }

    let signingCallbackInvoked = false;
    let signed: DeviceAuthorizationResponderResultV2 | null;
    try {
      throwIfAborted(input.signal);
      signed = await input.withCurrentSigningAuthority(
        async (authority): Promise<DeviceAuthorizationResponderResultV2> => {
          if (signingCallbackInvoked) {
            return Object.freeze({
              status: "unavailable" as const,
              reason: "signing_authority_unavailable" as const,
            });
          }
          signingCallbackInvoked = true;
          let window = currentWindow(input, descriptor);
          if (window !== null) return window;
          if (authority.policyRevision !== descriptor.policyRevision) {
            return Object.freeze({
              status: "stale" as const,
              reason: "policy_changed" as const,
            });
          }
          try {
            candidateResponse = await createBackgroundAuthorizationResponseV2(
              input.crypto,
              {
                credentialId: input.createId(),
                descriptorBytes,
                issuer: authority.issuer,
                issuerSigningPrivateKey: authority.signingPrivateKey,
                domainKeys,
              },
            );
          } catch {
            throwIfAborted(input.signal);
            return Object.freeze({
              status: "unavailable" as const,
              reason: "response_creation_failed" as const,
            });
          }
          window = currentWindow(input, descriptor);
          if (window !== null) {
            candidateResponse.fill(0);
            candidateResponse = undefined;
            return window;
          }
          return Object.freeze({
            status: "ready" as const,
            requestId: descriptor.requestId,
            recipientGeneration: descriptor.recipientGeneration,
            expiresAt: descriptor.expiresAt,
            responseBytes: candidateResponse,
          });
        },
      );
    } catch {
      throwIfAborted(input.signal);
      return Object.freeze({
        status: "unavailable" as const,
        reason: "signing_authority_unavailable" as const,
      });
    }
    const window = currentWindow(input, descriptor);
    if (window !== null) return window;
    if (signed?.status === "ready") candidateResponse = undefined;
    return signed ?? Object.freeze({
      status: "unavailable" as const,
      reason: "signing_authority_unavailable" as const,
    });
  } finally {
    candidateResponse?.fill(0);
    domainKeys.forEach(({ key }) => key.fill(0));
    domainRequirements.forEach(({ domainHeadDigest }) => {
      domainHeadDigest.fill(0);
    });
  }
}

/**
 * Creates one current V2 device response without owning transport or custody.
 * Namespace access is proved and released before the Domain cache is opened,
 * avoiding a nested non-reentrant cache lease. Reflection copies its complete
 * Domain set between sequential leases and wipes those copies before return.
 */
export async function respondToCurrentDeviceAuthorizationV2(
  input: DeviceAuthorizationResponderV2Input,
): Promise<DeviceAuthorizationResponderResultV2> {
  throwIfAborted(input.signal);
  if (!(input.descriptorBytes instanceof Uint8Array)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "invalid_descriptor" as const,
    });
  }
  // Copy explicitly because some Uint8Array-compatible slice methods alias.
  const descriptorBytes = Uint8Array.from(input.descriptorBytes);
  let descriptor: AnyBackgroundProcessorWorkDescriptorV2 | undefined;
  let candidateResponse: Uint8Array | undefined;
  try {
    try {
      descriptor = decodeAnyBackgroundProcessorWorkDescriptorV2(descriptorBytes);
    } catch {
      return Object.freeze({
        status: "unavailable" as const,
        reason: "invalid_descriptor" as const,
      });
    }
    const descriptorServerId = isReflectionDescriptor(descriptor)
      ? descriptor.namespaceRequirements[0]!.authority.serverId
      : descriptor.authority.serverId;
    if (descriptorServerId !== input.serverId) {
      return Object.freeze({
        status: "stale" as const,
        reason: "server_changed" as const,
      });
    }
    let window = currentWindow(input, descriptor);
    if (window !== null) return window;

    if (isReflectionDescriptor(descriptor)) {
      return await respondToReflectionAuthorizationV2(
        input,
        descriptorBytes,
        descriptor,
      );
    }
    const stenographerDescriptor = descriptor;

    let namespaceOpened;
    try {
      namespaceOpened = await input.namespaceAuthority.withOpenedGenerations({
        sourceRoomId: stenographerDescriptor.authority.roomId,
        namespaceId: stenographerDescriptor.authority.namespaceId,
        keyClass: "ai",
        expectedAccessRevision:
          stenographerDescriptor.authority.namespaceAccessRevision,
        expectedCurrentGeneration:
          stenographerDescriptor.authority.namespaceKeyGeneration,
        expectedCurrentHeadDigest:
          stenographerDescriptor.authority.namespaceHeadDigest,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, (entries, authority): NonReadyResult | null => {
        const callbackWindow = currentWindow(input, stenographerDescriptor);
        if (callbackWindow !== null) return callbackWindow;
        return namespaceMatches(stenographerDescriptor, entries, authority)
          ? null
          : Object.freeze({
              status: "stale" as const,
              reason: "namespace_authority_changed" as const,
            });
      });
    } catch {
      throwIfAborted(input.signal);
      return Object.freeze({
        status: "unavailable" as const,
        reason: "namespace_authority_unavailable" as const,
      });
    }
    window = currentWindow(input, stenographerDescriptor);
    if (window !== null) return window;
    if (namespaceOpened.status !== "opened") {
      return namespaceOpened.status === "pending"
        ? Object.freeze({
            status: "pending" as const,
            reason: "namespace_authority_pending" as const,
          })
        : Object.freeze({
            status: "unavailable" as const,
            reason: "namespace_authority_unavailable" as const,
          });
    }
    if (namespaceOpened.value !== null) return namespaceOpened.value;

    let domainOpened;
    try {
      domainOpened = await input.domainAuthority.withDomainKey({
        sourceRoomId: stenographerDescriptor.authority.roomId,
        namespaceId: stenographerDescriptor.authority.namespaceId,
        keyClass: "ai",
        ...(input.signal === undefined ? {} : { signal: input.signal }),
      }, async (domainKey, domainAuthority): Promise<
        DeviceAuthorizationResponderResultV2
      > => {
        let callbackWindow = currentWindow(input, stenographerDescriptor);
        if (callbackWindow !== null) return callbackWindow;
        if (!domainMatches(stenographerDescriptor, domainAuthority)) {
          return Object.freeze({
            status: "stale" as const,
            reason: "domain_authority_changed" as const,
          });
        }
        let signingCallbackInvoked = false;
        let signed: DeviceAuthorizationResponderResultV2 | null;
        try {
          signed = await input.withCurrentSigningAuthority(
            async (authority): Promise<DeviceAuthorizationResponderResultV2> => {
              if (signingCallbackInvoked) {
                return Object.freeze({
                  status: "unavailable" as const,
                  reason: "signing_authority_unavailable" as const,
                });
              }
              signingCallbackInvoked = true;
              const signingWindow = currentWindow(
                input,
                stenographerDescriptor,
              );
              if (signingWindow !== null) return signingWindow;
              if (authority.policyRevision
                !== stenographerDescriptor.policyRevision) {
                return Object.freeze({
                  status: "stale" as const,
                  reason: "policy_changed" as const,
                });
              }
              try {
                candidateResponse = await createBackgroundAuthorizationResponseV2(
                  input.crypto,
                  {
                    credentialId: input.createId(),
                    descriptorBytes,
                    issuer: authority.issuer,
                    issuerSigningPrivateKey: authority.signingPrivateKey,
                    domainKey,
                  },
                );
              } catch {
                throwIfAborted(input.signal);
                return Object.freeze({
                  status: "unavailable" as const,
                  reason: "response_creation_failed" as const,
                });
              }
              const createdWindow = currentWindow(
                input,
                stenographerDescriptor,
              );
              if (createdWindow !== null) {
                candidateResponse.fill(0);
                candidateResponse = undefined;
                return createdWindow;
              }
              return Object.freeze({
                status: "ready" as const,
                requestId: stenographerDescriptor.requestId,
                recipientGeneration: stenographerDescriptor.recipientGeneration,
                expiresAt: stenographerDescriptor.expiresAt,
                responseBytes: candidateResponse,
              });
            },
          );
        } catch {
          throwIfAborted(input.signal);
          return Object.freeze({
            status: "unavailable" as const,
            reason: "signing_authority_unavailable" as const,
          });
        }
        callbackWindow = currentWindow(input, stenographerDescriptor);
        if (callbackWindow !== null) return callbackWindow;
        return signed ?? Object.freeze({
          status: "unavailable" as const,
          reason: "signing_authority_unavailable" as const,
        });
      });
    } catch {
      throwIfAborted(input.signal);
      return Object.freeze({
        status: "unavailable" as const,
        reason: "domain_authority_unavailable" as const,
      });
    }
    window = currentWindow(input, stenographerDescriptor);
    if (window !== null) return window;
    if (domainOpened.status !== "opened") {
      return domainOpened.status === "pending"
        ? Object.freeze({
            status: "pending" as const,
            reason: "domain_authority_pending" as const,
          })
        : Object.freeze({
            status: "unavailable" as const,
            reason: "domain_authority_unavailable" as const,
          });
    }
    if (domainOpened.value.status === "ready") {
      candidateResponse = undefined;
    }
    return domainOpened.value;
  } finally {
    candidateResponse?.fill(0);
    if (descriptor !== undefined) destroyDescriptor(descriptor);
    descriptorBytes.fill(0);
  }
}
