import { describe, expect, test } from "bun:test";

import {
  resolveTaskContentAuthorityV1,
  type ResolveTaskContentAuthorityInputV1,
  type TaskConversationShapeV1,
  type TaskDeliveryDestinationsV1,
} from "../../src/task/task-content-authority-v1.ts";

const conversations: readonly TaskConversationShapeV1[] = [
  "private",
  "group",
  "public",
  "open",
  "dm",
  "orphan",
];

function input(
  overrides: Partial<ResolveTaskContentAuthorityInputV1> = {},
): ResolveTaskContentAuthorityInputV1 {
  return {
    resolverVersion: 1,
    requesterHumanId: "human.requester",
    requesterPrivateNamespace: {
      status: "authorized",
      subjectHumanId: "human.requester",
      namespaceId: "namespace.requester.private",
      domainId: "domain.requester.private",
      accessRevision: 4,
      policyRevision: 9,
    },
    shape: {
      conversation: "private",
      memory: "namespace",
      executor: "native",
    },
    ...overrides,
  };
}

describe("Task content authority v1", () => {
  test("selects only the requester-private authority across every routing shape", () => {
    const inputs = conversations.flatMap((conversation) => [
      input({
        shape: {
          ...input().shape,
          conversation,
        },
      }),
      input({
        shape: {
          ...input().shape,
          conversation,
          memory: "private_wide",
        },
      }),
      input({
        shape: {
          ...input().shape,
          conversation,
          memory: "scope",
        },
      }),
      input({
        shape: {
          ...input().shape,
          conversation,
          executor: "external_harness",
        },
      }),
    ]);

    for (const candidate of inputs) {
      expect(resolveTaskContentAuthorityV1(candidate)).toEqual({
        resolverVersion: 1,
        status: "resolved",
        authority: {
          authorityVersion: 1,
          kind: "requester_private_namespace",
          keyClass: "ai",
          requesterHumanId: "human.requester",
          namespaceId: "namespace.requester.private",
          domainId: "domain.requester.private",
          expectedAccessRevision: 4,
          expectedPolicyRevision: 9,
        },
      });
    }
  });

  test("does not substitute transcript or report-back destinations", () => {
    const destinations = {
      transcriptDestination: {
        status: "resolved",
        roomId: "room.transcript",
        namespaceId: "namespace.transcript",
      },
      reportBackDestination: {
        status: "resolved",
        roomId: "room.report",
        namespaceId: "namespace.report",
      },
    } as const satisfies TaskDeliveryDestinationsV1;
    const lateBound = {
      transcriptDestination: { status: "deferred" },
      reportBackDestination: { status: "none" },
    } as const satisfies TaskDeliveryDestinationsV1;
    const resolution = resolveTaskContentAuthorityV1(input());

    expect(lateBound.transcriptDestination.status).toBe("deferred");
    expect(resolution.status).toBe("resolved");
    if (resolution.status === "resolved") {
      expect(resolution.authority.namespaceId).not.toBe(
        destinations.transcriptDestination.namespaceId,
      );
      expect(resolution.authority.namespaceId).not.toBe(
        destinations.reportBackDestination.namespaceId,
      );
    }
  });

  test("returns closed unavailable results and never accepts an arbitrary fallback", () => {
    for (const reason of [
      "requester_identity_unavailable",
      "requester_private_namespace_unavailable",
      "requester_private_namespace_unauthorized",
      "authority_stale",
    ] as const) {
      expect(resolveTaskContentAuthorityV1(input({
        requesterPrivateNamespace: { status: "unavailable", reason },
      }))).toEqual({ resolverVersion: 1, status: "unavailable", reason });
    }

    expect(resolveTaskContentAuthorityV1(input({
      requesterPrivateNamespace: {
        status: "authorized",
        subjectHumanId: "human.someone-else",
        namespaceId: "namespace.someone-else.private",
        domainId: "domain.someone-else.private",
        accessRevision: 1,
        policyRevision: 1,
      },
    }))).toEqual({
      resolverVersion: 1,
      status: "unavailable",
      reason: "requester_authority_mismatch",
    });

    const withFallback = {
      ...input(),
      fallbackNamespaceId: "namespace.arbitrary",
    } as unknown as ResolveTaskContentAuthorityInputV1;
    expect(resolveTaskContentAuthorityV1(withFallback)).toEqual({
      resolverVersion: 1,
      status: "unavailable",
      reason: "invalid_authority_facts",
    });
  });

  test("fails closed for unsupported versions and malformed trusted facts", () => {
    expect(resolveTaskContentAuthorityV1({
      ...input(),
      resolverVersion: 2,
    } as unknown as ResolveTaskContentAuthorityInputV1)).toEqual({
      resolverVersion: 1,
      status: "unavailable",
      reason: "unsupported_resolver_version",
    });
    expect(resolveTaskContentAuthorityV1({
      ...input(),
      requesterPrivateNamespace: {
        ...input().requesterPrivateNamespace,
        accessRevision: -1,
      },
    } as ResolveTaskContentAuthorityInputV1)).toEqual({
      resolverVersion: 1,
      status: "unavailable",
      reason: "invalid_authority_facts",
    });
    expect(resolveTaskContentAuthorityV1({
      ...input(),
      requesterPrivateNamespace: {
        ...input().requesterPrivateNamespace,
        accessRevision: 0,
        policyRevision: 1,
      },
    } as ResolveTaskContentAuthorityInputV1).status).toBe("resolved");
    expect(resolveTaskContentAuthorityV1({
      ...input(),
      requesterPrivateNamespace: {
        ...input().requesterPrivateNamespace,
        policyRevision: 0,
      },
    } as ResolveTaskContentAuthorityInputV1)).toEqual({
      resolverVersion: 1,
      status: "unavailable",
      reason: "invalid_authority_facts",
    });
  });
});
