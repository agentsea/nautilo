import type {
  DomainForegroundAuthorityEntry,
  DomainForegroundSecretEntry,
} from "@nautilo/lattice-crypto";

import type { DomainKeyAuthorityClientV2 } from
  "./domain-key-authority-client.ts";
import type { DomainNamespaceAuthorityClientV2 } from
  "./domain-namespace-authority-client.ts";

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function destroySecrets(values: readonly DomainForegroundSecretEntry[]): void {
  values.forEach((entry) => {
    entry.participantDigest.fill(0);
    entry.headDigest.fill(0);
    entry.domainKey.fill(0);
  });
}

export interface DomainForegroundAuthorityClientV2 {
  withOpenedAuthorizationDomains<Value>(input: Readonly<{
    sourceRoomId: string;
    domains: readonly DomainForegroundAuthorityEntry[];
  }>, use: (
    domains: readonly DomainForegroundSecretEntry[],
  ) => Value | Promise<Value>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
  withOpenedTurnAuthority<Value>(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    namespaceAccessRevision: number;
    namespaceKeyGeneration: number;
    namespaceHeadDigest: Uint8Array;
    domains: readonly DomainForegroundAuthorityEntry[];
  }>, use: (authority: Readonly<{
    roomNamespaceKey: Uint8Array;
    domains: readonly DomainForegroundSecretEntry[];
  }>) => Value | Promise<Value>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
  withOpenedReusableTurnRoomKey<Value>(input: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    namespaceAccessRevision: number;
    namespaceKeyGeneration: number;
    namespaceHeadDigest: Uint8Array;
  }>, use: (roomNamespaceKey: Uint8Array) => Value | Promise<Value>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  >;
}

export function createDomainForegroundAuthorityClientV2(input: Readonly<{
  domainAuthority: DomainKeyAuthorityClientV2;
  namespaceAuthority: DomainNamespaceAuthorityClientV2;
}>): DomainForegroundAuthorityClientV2 {
  const openDomains = async <Value>(
    sourceRoomId: string,
    authorities: readonly DomainForegroundAuthorityEntry[],
    use: (domains: readonly DomainForegroundSecretEntry[]) =>
      Value | Promise<Value>,
  ) => {
    const collected: DomainForegroundSecretEntry[] = [];
    const visit = async (index: number): Promise<
      | Readonly<{ status: "opened"; value: Value }>
      | Readonly<{ status: "unavailable"; reason: string }>
    > => {
      const expected = authorities[index];
      if (expected === undefined) {
        return Object.freeze({
          status: "opened" as const,
          value: await use(Object.freeze(collected)),
        });
      }
      const opened = await input.domainAuthority.withDomainKey({
        sourceRoomId,
        namespaceId: expected.sourceNamespaceId,
        keyClass: "ai",
      }, (domainKey, actual) => {
        if (
          actual.domainId !== expected.domainId
          || !same(actual.participantDigest, expected.participantDigest)
          || actual.participantCount !== expected.participantCount
          || actual.keyClass !== expected.keyClass
          || actual.domainKeyGeneration !== expected.domainKeyGeneration
          || actual.authorizationRevision !== expected.authorizationRevision
          || !same(actual.headDigest, expected.headDigest)
        ) {
          return Object.freeze({
            status: "unavailable" as const,
            reason: "authority_stale",
          });
        }
        return Object.freeze({
          status: "ready" as const,
          secret: Object.freeze({
            domainId: expected.domainId,
            sourceNamespaceId: expected.sourceNamespaceId,
            participantDigest: expected.participantDigest.slice(),
            participantCount: expected.participantCount,
            keyClass: "ai" as const,
            domainKeyGeneration: expected.domainKeyGeneration,
            authorizationRevision: expected.authorizationRevision,
            headDigest: expected.headDigest.slice(),
            domainKey: domainKey.slice(),
          }),
        });
      });
      if (opened.status !== "opened") {
        return Object.freeze({
          status: "unavailable" as const,
          reason: opened.reason,
        });
      }
      if (opened.value.status !== "ready") return opened.value;
      // `withDomainKey` may hold a non-reentrant secure-cache lease while its
      // callback runs. Leave that callback before opening the next Domain;
      // recursively nesting these calls deadlocks real Browser custody even
      // though permissive test doubles appear to work.
      collected.push(opened.value.secret);
      return visit(index + 1);
    };
    try {
      return await visit(0);
    } finally {
      destroySecrets(collected);
    }
  };

  const openRoom = async <Value>(request: Readonly<{
    sourceRoomId: string;
    namespaceId: string;
    namespaceAccessRevision: number;
    namespaceKeyGeneration: number;
    namespaceHeadDigest: Uint8Array;
  }>, use: (roomNamespaceKey: Uint8Array) => Value | Promise<Value>) => {
    const opened = await input.namespaceAuthority.withOpenedGenerations({
      sourceRoomId: request.sourceRoomId,
      namespaceId: request.namespaceId,
      keyClass: "ai",
      expectedAccessRevision: request.namespaceAccessRevision,
      expectedCurrentGeneration: request.namespaceKeyGeneration,
      expectedCurrentHeadDigest: request.namespaceHeadDigest,
    }, async (entries) => {
      const current = entries.find((entry) =>
        entry.namespaceId === request.namespaceId
        && entry.accessRevision === request.namespaceAccessRevision
        && entry.generation === request.namespaceKeyGeneration
        && same(entry.headDigest, request.namespaceHeadDigest)
      );
      return current === undefined
        ? Object.freeze({
            status: "unavailable" as const,
            reason: "namespace_stale",
          })
        : Object.freeze({
            status: "opened" as const,
            value: await use(current.generationKey),
          });
    });
    if (opened.status !== "opened") {
      return Object.freeze({
        status: "unavailable" as const,
        reason: opened.reason,
      });
    }
    return opened.value;
  };

  const client: DomainForegroundAuthorityClientV2 = Object.freeze({
    async withOpenedAuthorizationDomains<Value>(
      request: Parameters<
        DomainForegroundAuthorityClientV2["withOpenedAuthorizationDomains"]
      >[0],
      use: (domains: readonly DomainForegroundSecretEntry[]) =>
        Value | Promise<Value>,
    ) {
      return openDomains(request.sourceRoomId, request.domains, use);
    },
    async withOpenedTurnAuthority<Value>(
      request: Parameters<
        DomainForegroundAuthorityClientV2["withOpenedTurnAuthority"]
      >[0],
      use: (authority: Readonly<{
        roomNamespaceKey: Uint8Array;
        domains: readonly DomainForegroundSecretEntry[];
      }>) => Value | Promise<Value>,
    ) {
      return openRoom(request, async (roomNamespaceKey) =>
        openDomains(request.sourceRoomId, request.domains, async (domains) =>
          use(Object.freeze({ roomNamespaceKey, domains }))))
        .then((opened) => opened.status !== "opened"
          ? opened
          : opened.value);
    },
    async withOpenedReusableTurnRoomKey<Value>(
      request: Parameters<
        DomainForegroundAuthorityClientV2[
          "withOpenedReusableTurnRoomKey"
        ]
      >[0],
      use: (roomNamespaceKey: Uint8Array) => Value | Promise<Value>,
    ) {
      return openRoom(request, use);
    },
  });
  return client;
}
