import { describe, expect, test } from "bun:test";

import { createDomainNamespaceAuthorityAdapterV2 } from
  "../../src/client/message/domain-namespace-authority-adapter.ts";
import type { DomainKeyAuthorityClientV2 } from
  "../../src/client/message/domain-key-authority-client.ts";
import type { DomainNamespaceAuthorityClientV2 } from
  "../../src/client/message/domain-namespace-authority-client.ts";

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
});
