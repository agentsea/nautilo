import { describe, expect, test } from "bun:test";
import { authorizationRevision } from "@nautilo/lattice-crypto";

import { createDomainForegroundAuthorityClientV2 } from
  "../../src/client/message/domain-foreground-authority-client.ts";
import type {
  DomainKeyAuthorityClientV2,
  OpenedDomainKeyAuthorityV2,
} from
  "../../src/client/message/domain-key-authority-client.ts";
import type {
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceAuthorityV2,
  OpenedDomainNamespaceGenerationV2,
} from
  "../../src/client/message/domain-namespace-authority-client.ts";

const digest = (value: number) => new Uint8Array(32).fill(value);

describe("M301 V2 foreground Domain authority client", () => {
  test("opens multiple Domains without nesting non-reentrant cache leases", async () => {
    let leaseHeld = false;
    const openedNamespaces: string[] = [];
    const client = createDomainForegroundAuthorityClientV2({
      domainAuthority: Object.freeze({
        async ensure() {
          return Object.freeze({ status: "ready" as const });
        },
        async withDomainKey<Value>(
          request: Parameters<DomainKeyAuthorityClientV2["withDomainKey"]>[0],
          use: (
            domainKey: Uint8Array,
            authority: OpenedDomainKeyAuthorityV2,
          ) => Value | Promise<Value>,
        ) {
          if (leaseHeld) throw new Error("secure cache lease is not reentrant");
          leaseHeld = true;
          openedNamespaces.push(request.namespaceId);
          try {
            const index = request.namespaceId === "namespace-a" ? 1 : 2;
            return Object.freeze({
              status: "opened" as const,
              value: await use(new Uint8Array(32).fill(index), Object.freeze({
                serverId: "https://server.test",
                domainId: `domain-${index === 1 ? "a" : "b"}`,
                participantDigest: digest(index),
                participantCount: index,
                keyClass: "ai" as const,
                domainKeyGeneration: 1,
                authorizationRevision: 1,
                headDigest: digest(index + 2),
                recipientDeviceSigningGeneration: 1,
              })),
            });
          } finally {
            leaseHeld = false;
          }
        },
        async servicePending() {
          return Object.freeze({ status: "ready" as const, fulfilled: 0 });
        },
      }),
      namespaceAuthority: Object.freeze({
        async ensure() {
          return Object.freeze({ status: "ready" as const });
        },
        async withOpenedGenerations() {
          throw new Error("Room key should not be needed");
        },
        async servicePending() {
          return 0;
        },
      }),
    });
    const result = await client.withOpenedAuthorizationDomains({
      sourceRoomId: "room-1",
      domains: Object.freeze([
        Object.freeze({
          domainId: "domain-a",
          sourceNamespaceId: "namespace-a",
          participantDigest: digest(1),
          participantCount: 1,
          keyClass: "ai" as const,
          domainKeyGeneration: 1,
          authorizationRevision: authorizationRevision(1),
          headDigest: digest(3),
          activeNamespaceBindingSetDigest: digest(5),
          activeNamespaceBindingCount: 1,
        }),
        Object.freeze({
          domainId: "domain-b",
          sourceNamespaceId: "namespace-b",
          participantDigest: digest(2),
          participantCount: 2,
          keyClass: "ai" as const,
          domainKeyGeneration: 1,
          authorizationRevision: authorizationRevision(1),
          headDigest: digest(4),
          activeNamespaceBindingSetDigest: digest(6),
          activeNamespaceBindingCount: 1,
        }),
      ]),
    }, (domains) => domains.map((domain) => domain.domainKey[0]));

    expect(result).toEqual({ status: "opened", value: [1, 2] });
    expect(openedNamespaces).toEqual(["namespace-a", "namespace-b"]);
  });

  test("opens exact Domain keys and the current Room Namespace on demand", async () => {
    const openedNamespaces: string[] = [];
    const domainAuthority: DomainKeyAuthorityClientV2 = Object.freeze({
      async ensure() {
        return Object.freeze({ status: "ready" as const });
      },
      async withDomainKey<Value>(
        request: Parameters<DomainKeyAuthorityClientV2["withDomainKey"]>[0],
        use: (
          domainKey: Uint8Array,
          authority: OpenedDomainKeyAuthorityV2,
        ) => Value | Promise<Value>,
      ) {
        openedNamespaces.push(request.namespaceId);
        return Object.freeze({
          status: "opened" as const,
          value: await use(new Uint8Array(32).fill(
            request.namespaceId === "namespace-a" ? 11 : 12,
          ), Object.freeze({
            serverId: "https://server.test",
            domainId: request.namespaceId === "namespace-a"
              ? "domain-a"
              : "domain-b",
            participantDigest: digest(
              request.namespaceId === "namespace-a" ? 1 : 2,
            ),
            participantCount: request.namespaceId === "namespace-a" ? 1 : 2,
            keyClass: "ai" as const,
            domainKeyGeneration: 1,
            authorizationRevision: 1,
            headDigest: digest(
              request.namespaceId === "namespace-a" ? 3 : 4,
            ),
            recipientDeviceSigningGeneration: 1,
          })),
        });
      },
      async servicePending() {
        return Object.freeze({ status: "ready" as const, fulfilled: 0 });
      },
    });
    const namespaceAuthority: DomainNamespaceAuthorityClientV2 = Object.freeze({
      async ensure() {
        return Object.freeze({ status: "ready" as const });
      },
      async withOpenedGenerations<Value>(
        request: Parameters<
          DomainNamespaceAuthorityClientV2["withOpenedGenerations"]
        >[0],
        use: (
          entries: readonly OpenedDomainNamespaceGenerationV2[],
          _authority: OpenedDomainNamespaceAuthorityV2,
        ) =>
          Value | Promise<Value>,
      ) {
        const namespaceHeadDigest = digest(8);
        return Object.freeze({
          status: "opened" as const,
          value: await use(Object.freeze([Object.freeze({
            namespaceId: request.namespaceId,
            keyClass: request.keyClass,
            accessRevision: 7,
            generation: 2,
            headDigest: namespaceHeadDigest,
            generationKey: new Uint8Array(32).fill(9),
          })]), Object.freeze({
            sourceRoomId: request.sourceRoomId,
            serverId: "https://server.test",
            namespaceId: request.namespaceId,
            keyClass: request.keyClass,
            namespaceAccessRevision: 7,
            namespaceKeyGeneration: 2,
            namespaceHeadDigest,
            domainId: "domain-a",
            domainKeyGeneration: 1,
            domainAuthorizationRevision: 1,
            domainHeadDigest: digest(3),
            bundleRevision: 1,
            bundleDigest: digest(5),
          })),
        });
      },
      async servicePending() {
        return 0;
      },
    });
    const client = createDomainForegroundAuthorityClientV2({
      domainAuthority,
      namespaceAuthority,
    });
    const result = await client.withOpenedTurnAuthority({
      sourceRoomId: "room-1",
      namespaceId: "room-namespace",
      namespaceAccessRevision: 7,
      namespaceKeyGeneration: 2,
      namespaceHeadDigest: digest(8),
      domains: Object.freeze([
        Object.freeze({
          domainId: "domain-a",
          sourceNamespaceId: "namespace-a",
          participantDigest: digest(1),
          participantCount: 1,
          keyClass: "ai" as const,
          domainKeyGeneration: 1,
          authorizationRevision: authorizationRevision(1),
          headDigest: digest(3),
          activeNamespaceBindingSetDigest: digest(5),
          activeNamespaceBindingCount: 1,
        }),
        Object.freeze({
          domainId: "domain-b",
          sourceNamespaceId: "namespace-b",
          participantDigest: digest(2),
          participantCount: 2,
          keyClass: "ai" as const,
          domainKeyGeneration: 1,
          authorizationRevision: authorizationRevision(1),
          headDigest: digest(4),
          activeNamespaceBindingSetDigest: digest(6),
          activeNamespaceBindingCount: 3,
        }),
      ]),
    }, ({ roomNamespaceKey, domains }) => Object.freeze({
      room: roomNamespaceKey[0],
      domainKeys: domains.map((entry) => entry.domainKey[0]),
    }));
    expect(result).toEqual({
      status: "opened",
      value: { room: 9, domainKeys: [11, 12] },
    });
    expect(openedNamespaces).toEqual(["namespace-a", "namespace-b"]);
  });

  test("rejects a Domain key whose current head disagrees with the plan", async () => {
    const client = createDomainForegroundAuthorityClientV2({
      domainAuthority: Object.freeze({
        async ensure() {
          return Object.freeze({ status: "ready" as const });
        },
        async withDomainKey<Value>(
          _request: Parameters<
            DomainKeyAuthorityClientV2["withDomainKey"]
          >[0],
          use: (
            domainKey: Uint8Array,
            authority: OpenedDomainKeyAuthorityV2,
          ) => Value | Promise<Value>,
        ) {
          return Object.freeze({
            status: "opened" as const,
            value: await use(new Uint8Array(32).fill(4), Object.freeze({
              serverId: "https://server.test",
              domainId: "domain-a",
              participantDigest: digest(1),
              participantCount: 1,
              keyClass: "ai" as const,
              domainKeyGeneration: 2,
              authorizationRevision: 1,
              headDigest: digest(3),
              recipientDeviceSigningGeneration: 1,
            })),
          });
        },
        async servicePending() {
          return Object.freeze({ status: "ready" as const, fulfilled: 0 });
        },
      }),
      namespaceAuthority: Object.freeze({
        async ensure() {
          return Object.freeze({ status: "ready" as const });
        },
        async withOpenedGenerations() {
          throw new Error("Room key should not be needed");
        },
        async servicePending() {
          return 0;
        },
      }),
    });
    const result = await client.withOpenedAuthorizationDomains({
      sourceRoomId: "room-1",
      domains: Object.freeze([Object.freeze({
        domainId: "domain-a",
        sourceNamespaceId: "namespace-a",
        participantDigest: digest(1),
        participantCount: 1,
        keyClass: "ai" as const,
        domainKeyGeneration: 1,
        authorizationRevision: authorizationRevision(1),
        headDigest: digest(3),
        activeNamespaceBindingSetDigest: digest(5),
        activeNamespaceBindingCount: 1,
      })]),
    }, () => true);
    expect(result).toEqual({
      status: "unavailable",
      reason: "authority_stale",
    });
  });
});
