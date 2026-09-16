import {
  accessRevision,
  namespaceGeneration,
  namespaceId,
  type NamespaceAgentGrantAuthorityEntry,
  type NamespaceAgentGrantSecretEntry,
} from "@nautilo/lattice-crypto";

import type {
  NamespaceAuthorityClient,
  NamespaceGenerationAuthority,
  OpenedNamespaceGeneration,
  OpenedRetainedRoomAuthority,
  RetainedRoomAuthorityClient,
} from "./namespace-authority-client.ts";
import type {
  DomainNamespaceAuthorityClientV2,
  OpenedDomainNamespaceGenerationV2,
} from "./domain-namespace-authority-client.ts";
import type { DomainKeyAuthorityClientV2 } from
  "./domain-key-authority-client.ts";
type Authority = NamespaceGenerationAuthority |
  NamespaceAgentGrantAuthorityEntry;

function same(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function unavailable(reason: string) {
  return Object.freeze({ status: "unavailable" as const, reason });
}

function retained(authority: Authority) {
  return authority.retainedGenerations;
}

function current(authority: Authority) {
  return retained(authority).at(-1);
}

function selectOpened(
  authority: Authority,
  keyClass: "human" | "ai",
  opened: readonly OpenedDomainNamespaceGenerationV2[],
): readonly OpenedNamespaceGeneration[] | null {
  const result: OpenedNamespaceGeneration[] = [];
  for (const expected of retained(authority)) {
    const entry = opened.find((candidate) =>
      candidate.namespaceId === authority.namespaceId
      && candidate.keyClass === keyClass
      && candidate.generation === expected.generation
      && candidate.accessRevision === expected.accessRevision
      && same(candidate.headDigest, expected.headDigest)
    );
    if (entry === undefined) return null;
    result.push(Object.freeze({
      namespaceId: namespaceId(entry.namespaceId),
      keyClass,
      accessRevision: accessRevision(entry.accessRevision),
      generation: namespaceGeneration(entry.generation),
      generationKey: entry.generationKey,
      audienceFingerprint: expected.audienceFingerprint,
      headDigest: entry.headDigest,
    }));
  }
  return Object.freeze(result);
}

/**
 * Present native V2 Domain and Namespace authority through the shared
 * foreground Message authority port. The port describes product operations;
 * all durable key authority remains in the V2 repositories supplied here.
 */
export function createDomainNamespaceAuthorityAdapterV2(input: Readonly<{
  domainAuthority: DomainKeyAuthorityClientV2;
  namespaceAuthority: DomainNamespaceAuthorityClientV2;
}>): NamespaceAuthorityClient {
  const openMany = async <Value>(request: Readonly<{
    sourceRoomId: string;
    keyClass: "human" | "ai";
    authority: readonly Authority[];
    signal?: AbortSignal;
  }>, use: (
    entries: readonly OpenedNamespaceGeneration[],
  ) => Value | Promise<Value>): Promise<
    | Readonly<{ status: "opened"; value: Value }>
    | Readonly<{ status: "unavailable"; reason: string }>
  > => {
    const visit = async (
      index: number,
      accumulated: readonly OpenedNamespaceGeneration[],
    ): Promise<
      | Readonly<{ status: "opened"; value: Value }>
      | Readonly<{ status: "unavailable"; reason: string }>
    > => {
      const authority = request.authority[index];
      if (authority === undefined) {
        return Object.freeze({
          status: "opened" as const,
          value: await use(Object.freeze([...accumulated])),
        });
      }
      const expectedCurrent = current(authority);
      if (expectedCurrent === undefined) return unavailable("authority_empty");
      const opened = await input.namespaceAuthority.withOpenedGenerations({
        sourceRoomId: request.sourceRoomId,
        namespaceId: authority.namespaceId,
        keyClass: request.keyClass,
        expectedAccessRevision: expectedCurrent.accessRevision,
        expectedCurrentGeneration: expectedCurrent.generation,
        expectedCurrentHeadDigest: expectedCurrent.headDigest,
        ...(request.signal === undefined ? {} : {signal: request.signal}),
      }, async (entries) => {
        const selected = selectOpened(authority, request.keyClass, entries);
        return selected === null
          ? unavailable("authority_stale")
          : visit(index + 1, [...accumulated, ...selected]);
      });
      if (opened.status !== "opened") {
        return unavailable(opened.reason);
      }
      return opened.value;
    };
    return visit(0, []);
  };

  const client: NamespaceAuthorityClient = Object.freeze({
    async ensure(
      request: Parameters<NamespaceAuthorityClient["ensure"]>[0],
    ) {
      let firstFailure: string | null = null;
      for (const keyClass of request.keyClass === undefined
        ? ["human", "ai"] as const : [request.keyClass]) {
        const result = await input.namespaceAuthority.ensure({
          sourceRoomId: request.sourceRoomId,
          namespaceId: request.namespaceId,
          keyClass,
          ...(request.signal === undefined ? {} : {signal: request.signal}),
        });
        if (result.status !== "ready" && firstFailure === null) {
          firstFailure = result.reason;
        }
      }
      return firstFailure === null
        ? Object.freeze({ status: "ready" as const })
        : unavailable(firstFailure);
    },

    async synchronizeRecipients(
      request: Parameters<
        NamespaceAuthorityClient["synchronizeRecipients"]
      >[0],
    ) {
      for (const keyClass of request.keyClass === undefined
        ? ["human", "ai"] as const : [request.keyClass]) {
        const opened = await input.domainAuthority.ensure({
          sourceRoomId: request.sourceRoomId,
          namespaceId: request.namespaceId,
          keyClass,
        });
        if (opened.status !== "ready") return unavailable(opened.reason);
        // Deliver the current Domain key before requiring bundle readiness.
        // A newcomer may be the only holder of that current key while an old,
        // still-qualified source is the only holder of the retained bundle.
        const result = await input.domainAuthority.servicePending({
          sourceRoomId: request.sourceRoomId,
          namespaceId: request.namespaceId,
          keyClass,
        });
        if (result.status !== "ready") return unavailable(result.reason);
        const namespace = await input.namespaceAuthority.ensure({
          sourceRoomId: request.sourceRoomId,
          namespaceId: request.namespaceId,
          keyClass,
        });
        if (namespace.status !== "ready") return unavailable(namespace.reason);
      }
      return Object.freeze({ status: "ready" as const });
    },

    async withOpenedAiGenerations<Value>(
      request: Parameters<
        NamespaceAuthorityClient["withOpenedAiGenerations"]
      >[0],
      use: (entries: readonly NamespaceAgentGrantSecretEntry[]) =>
        Value | Promise<Value>,
    ) {
      return openMany<Value>({
        sourceRoomId: request.sourceRoomId,
        keyClass: "ai",
        authority: request.authority,
      }, (entries) => use(Object.freeze(entries.map((entry) =>
        Object.freeze({
          ...entry,
          keyClass: "ai" as const,
        }) satisfies NamespaceAgentGrantSecretEntry
      ))));
    },

    async withOpenedGenerations<Value>(
      request: Parameters<NonNullable<
        NamespaceAuthorityClient["withOpenedGenerations"]
      >>[0],
      use: (entries: readonly OpenedNamespaceGeneration[]) =>
        Value | Promise<Value>,
    ) {
      return openMany<Value>({
        sourceRoomId: request.sourceRoomId,
        keyClass: request.keyClass,
        authority: request.authority,
        ...(request.signal === undefined ? {} : {signal: request.signal}),
      }, use);
    },
  });
  return client;
}

/**
 * Message-history adapter over the native V2 Domain Namespace bundle.
 */
export function createDomainNamespaceHistoryAuthorityAdapterV2(input: Readonly<{
  namespaceAuthority: DomainNamespaceAuthorityClientV2;
}>): RetainedRoomAuthorityClient {
  return Object.freeze({
    async withOpenedRetainedRoomAuthority<Value>(
      request: Parameters<
        RetainedRoomAuthorityClient[
          "withOpenedRetainedRoomAuthority"
        ]
      >[0],
      use: (authority: OpenedRetainedRoomAuthority) =>
        Promise<Value> | Value,
    ) {
      const opened = await input.namespaceAuthority.withOpenedGenerations({
        sourceRoomId: request.sourceRoomId,
        namespaceId: request.plan.namespaceId,
        keyClass: "ai",
        expectedAccessRevision: request.plan.namespaceAccessRevision,
        expectedCurrentHeadDigest: request.plan.namespaceAudienceFingerprint,
      }, async (entries) => use(Object.freeze({
        retainedGenerations: Object.freeze(entries.map((entry) =>
          Object.freeze({
            generation: namespaceGeneration(entry.generation),
            accessRevision: accessRevision(entry.accessRevision),
            headDigest: entry.headDigest,
            publicationDigest: entry.headDigest,
            publicationSetDigest: entry.headDigest,
            audienceFingerprint: entry.headDigest,
            generationKey: entry.generationKey,
          })
        )),
      })));
      return opened.status === "opened"
        ? Object.freeze({ status: "opened" as const, value: opened.value })
        : unavailable(opened.reason);
    },
  });
}
