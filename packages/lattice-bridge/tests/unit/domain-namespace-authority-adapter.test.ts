import { describe, expect, test } from "bun:test";
import {
  accessRevision,
  authorizationRevision,
  namespaceGeneration,
  namespaceId,
} from "@nautilo/lattice-crypto";

import { createDomainNamespaceAuthorityAdapterV2 } from
  "../../src/client/message/domain-namespace-authority-adapter.ts";
import type { DomainKeyAuthorityClientV2 } from
  "../../src/client/message/domain-key-authority-client.ts";
import type {
  DomainNamespaceAccessResultV2,
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceAuthorityV2,
  OpenedDomainNamespaceGenerationV2,
} from "../../src/client/message/domain-namespace-authority-client.ts";

describe("M301 V2 Namespace authority adapter", () => {
  test("requests both Domain key classes during one target access", async () => {
    const calls: string[] = [];
    const client = createDomainNamespaceAuthorityAdapterV2({
      domainAuthority: Object.freeze({
        async ensure() {
          throw new Error("not used");
        },
        async withDomainKey() {
          throw new Error("not used");
        },
        async servicePending() {
          throw new Error("not used");
        },
      }) satisfies DomainKeyAuthorityClientV2,
      namespaceAuthority: Object.freeze({
        async ensure(
          request: Parameters<DomainNamespaceAuthorityClientV2["ensure"]>[0],
        ) {
          calls.push(request.keyClass);
          return request.keyClass === "human"
            ? Object.freeze({
                status: "pending" as const,
                reason: "source_required" as const,
              })
            : Object.freeze({ status: "ready" as const });
        },
        async withOpenedGenerations() {
          throw new Error("not used");
        },
        async servicePending() {
          return 0;
        },
      }) satisfies DomainNamespaceAuthorityClientV2,
    });

    expect(await client.ensure({
      sourceRoomId: "room-m301",
      namespaceId: "namespace-m301",
      operationId: "operation-m301",
      idempotencyKey: "request-m301",
    })).toEqual({ status: "unavailable", reason: "source_required" });
    expect(calls).toEqual(["human", "ai"]);
  });

  test("opens and delivers each Domain key before repairing its Namespace bundle", async () => {
    const calls: string[] = [];
    const domainAuthority = Object.freeze({
      async ensure(
        request: Parameters<DomainKeyAuthorityClientV2["ensure"]>[0],
      ) {
        calls.push(`open:${request.keyClass}`);
        return Object.freeze({ status: "ready" as const });
      },
      async withDomainKey() {
        throw new Error("not used");
      },
      async servicePending(
        request: Parameters<DomainKeyAuthorityClientV2["servicePending"]>[0],
      ) {
        calls.push(`deliver:${request.keyClass}`);
        return Object.freeze({ status: "ready" as const, fulfilled: 1 });
      },
    }) satisfies DomainKeyAuthorityClientV2;
    const namespaceAuthority = Object.freeze({
      async ensure(
        request: Parameters<DomainNamespaceAuthorityClientV2["ensure"]>[0],
      ) {
        calls.push(`bundle:${request.keyClass}`);
        return Object.freeze({ status: "ready" as const });
      },
      async withOpenedGenerations() {
        throw new Error("not used");
      },
      async servicePending() {
        return 0;
      },
    }) satisfies DomainNamespaceAuthorityClientV2;
    const client = createDomainNamespaceAuthorityAdapterV2({
      domainAuthority,
      namespaceAuthority,
    });

    expect(await client.synchronizeRecipients({
      sourceRoomId: "room-m301",
      namespaceId: "namespace-m301",
    })).toEqual({ status: "ready" });
    expect(calls).toEqual([
      "open:human",
      "deliver:human",
      "bundle:human",
      "open:ai",
      "deliver:ai",
      "bundle:ai",
    ]);
    calls.length = 0;
    expect(await client.ensure({
      sourceRoomId: "room-human-only", namespaceId: "namespace-human-only",
      operationId: "human-operation", idempotencyKey: "human-request",
      keyClass: "human",
    })).toEqual({ status: "ready" });
    expect(calls).toEqual(["bundle:human"]);
    calls.length = 0;
    expect(await client.synchronizeRecipients({
      sourceRoomId: "room-human-only", namespaceId: "namespace-human-only",
      keyClass: "human",
    })).toEqual({ status: "ready" });
    expect(calls).toEqual(["open:human", "deliver:human", "bundle:human"]);
  });

  test("pairs native Domain metadata with its Namespace without widening AI grant secrets", async () => {
    const namespaces = ["namespace:one", "namespace:two"] as const;
    const domains = ["domain:one", "domain:two"] as const;
    const heads = [new Uint8Array(32).fill(1), new Uint8Array(32).fill(2)];
    const generationKeys = [
      new Uint8Array(32).fill(3),
      new Uint8Array(32).fill(4),
    ];
    let substitutedAuthorityNamespace = false;
    const client = createDomainNamespaceAuthorityAdapterV2({
      domainAuthority: Object.freeze({
        async ensure() {
          throw new Error("not used");
        },
        async withDomainKey() {
          throw new Error("not used");
        },
        async servicePending() {
          throw new Error("not used");
        },
      }) satisfies DomainKeyAuthorityClientV2,
      namespaceAuthority: Object.freeze({
        async ensure() {
          throw new Error("not used");
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
          const index = namespaces.indexOf(
            request.namespaceId as typeof namespaces[number],
          );
          if (index < 0) throw new Error("unexpected Namespace");
          const entry = Object.freeze({
            namespaceId: namespaces[index]!,
            keyClass: request.keyClass,
            accessRevision: 7,
            generation: 5,
            headDigest: heads[index]!,
            generationKey: generationKeys[index]!,
          });
          return Object.freeze({
            status: "opened" as const,
            value: await use([entry], Object.freeze({
              sourceRoomId: request.sourceRoomId,
              serverId: "server:adapter",
              namespaceId: substitutedAuthorityNamespace
                ? "namespace:substituted"
                : namespaces[index]!,
              keyClass: request.keyClass,
              namespaceAccessRevision: 7,
              namespaceKeyGeneration: 5,
              namespaceHeadDigest: heads[index]!,
              domainId: domains[index]!,
              domainKeyGeneration: 3,
              domainAuthorizationRevision: 11,
              domainHeadDigest: heads[index]!,
              bundleRevision: 13,
              bundleDigest: heads[index]!,
            })),
          });
        },
        async servicePending() {
          return 0;
        },
      }) satisfies DomainNamespaceAuthorityClientV2,
    });
    const authority = Object.freeze(namespaces.map((namespace, index) =>
      Object.freeze({
        namespaceId: namespace,
        retainedGenerations: Object.freeze([Object.freeze({
          generation: 5,
          accessRevision: 7,
          headDigest: heads[index]!,
          publicationDigest: heads[index]!,
          publicationSetDigest: heads[index]!,
          audienceFingerprint: heads[index]!,
        })]),
      })
    ));

    const opened = await client.withOpenedGenerations!({
      sourceRoomId: "room:adapter",
      subjectHumanId: "human:adapter",
      deviceSigningKeyGeneration: 1,
      keyClass: "human",
      authority,
    }, entries => entries.map(entry => ({
      namespaceId: entry.namespaceId,
      domainId: entry.domainId,
    })));
    expect(opened).toEqual({
      status: "opened",
      value: [
        { namespaceId: namespaceId(namespaces[0]), domainId: domains[0] },
        { namespaceId: namespaceId(namespaces[1]), domainId: domains[1] },
      ],
    });

    substitutedAuthorityNamespace = true;
    expect(await client.withOpenedGenerations!({
      sourceRoomId: "room:adapter",
      subjectHumanId: "human:adapter",
      deviceSigningKeyGeneration: 1,
      keyClass: "human",
      authority: [authority[0]!],
    }, () => "must not open")).toEqual({
      status: "unavailable",
      reason: "authority_stale",
    });
    substitutedAuthorityNamespace = false;

    const aiAuthority = authority.map(entry => Object.freeze({
      namespaceId: namespaceId(entry.namespaceId),
      keyClass: "ai" as const,
      firstRetainedGeneration: namespaceGeneration(5),
      currentGeneration: namespaceGeneration(5),
      retainedGenerations: entry.retainedGenerations.map(generation =>
        Object.freeze({
          ...generation,
          generation: namespaceGeneration(generation.generation),
          accessRevision: accessRevision(generation.accessRevision),
        })
      ),
      agentAuthorizationRevision: authorizationRevision(9),
    }));
    const ai = await client.withOpenedAiGenerations({
      sourceRoomId: "room:adapter",
      subjectHumanId: "human:adapter",
      deviceSigningKeyGeneration: 1,
      authority: aiAuthority,
    }, entries => entries.map(entry => ({
      keys: Object.keys(entry).sort(),
      hasDomainId: "domainId" in entry,
    })));
    expect(ai).toEqual({
      status: "opened",
      value: [
        {
          keys: [
            "accessRevision",
            "audienceFingerprint",
            "generation",
            "generationKey",
            "headDigest",
            "keyClass",
            "namespaceId",
          ],
          hasDomainId: false,
        },
        {
          keys: [
            "accessRevision",
            "audienceFingerprint",
            "generation",
            "generationKey",
            "headDigest",
            "keyClass",
            "namespaceId",
          ],
          hasDomainId: false,
        },
      ],
    });
  });
});
