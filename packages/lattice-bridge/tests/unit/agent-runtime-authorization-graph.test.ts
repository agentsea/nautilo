import { describe, expect, test } from "bun:test";

import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
} from "@nautilo/lattice-crypto";

import {
  planAgentRuntimeAuthorizationGraphTransition,
  type AgentRuntimeAuthorizationGraphSnapshot,
} from "../../src/invocation/agent-runtime-authorization-graph";

const encoder = new TextEncoder();

function comparePortableText(left: string, right: string): number {
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  const width = Math.min(leftBytes.length, rightBytes.length);
  for (let index = 0; index < width; index += 1) {
    const difference = leftBytes[index]! - rightBytes[index]!;
    if (difference !== 0) return difference;
  }
  return leftBytes.length - rightBytes.length;
}

function snapshot(input: Readonly<{
  readonly namespaces: readonly Readonly<{
    readonly namespaceId: string;
    readonly domainId: string;
    readonly humanIds: readonly string[];
  }>[];
  readonly managementHumanIds?: readonly string[];
  readonly unavailableDomains?: readonly string[];
}>): AgentRuntimeAuthorizationGraphSnapshot {
  const domainIds = [...new Set(
    input.namespaces.map((edge) => edge.domainId),
  )].sort(comparePortableText);
  const unavailable = new Set(input.unavailableDomains ?? []);
  return Object.freeze({
    managementHumanIds: Object.freeze([
      ...(input.managementHumanIds ?? []),
    ].sort(comparePortableText)),
    namespaceEdges: Object.freeze(
      [...input.namespaces]
        .sort((left, right) =>
          left.namespaceId.localeCompare(right.namespaceId)
        )
        .map((edge) =>
          Object.freeze({
            namespaceId: edge.namespaceId,
            domainId: edge.domainId,
            authorizedHumanIds: Object.freeze(
              [...edge.humanIds].sort(comparePortableText),
            ),
          })
        ),
    ),
    domainAuthorities: Object.freeze(
      domainIds.map((domainId) => {
        const coordinate = [...domainId]
          .reduce((sum, value) => sum + value.charCodeAt(0), 0);
        return Object.freeze({
          domainId,
          domainEpoch: 4 + (coordinate % 5),
          agentAuthorizationRevision: 10 + (coordinate % 7),
          committerDeviceId: `device-${domainId}`,
          committerAvailable: !unavailable.has(domainId),
        });
      }),
    ),
  });
}

const inventory = Object.freeze({
  objectCount: 2,
  digest: new Uint8Array(32).fill(0x44),
});

function plan(
  current: AgentRuntimeAuthorizationGraphSnapshot,
  next: AgentRuntimeAuthorizationGraphSnapshot,
) {
  return planAgentRuntimeAuthorizationGraphTransition({
    operationId: "operation-graph-transition",
    agentId: agentId("genie"),
    oldAuthorizationRevision: authorizationRevision(20),
    newAuthorizationRevision: authorizationRevision(21),
    currentRuntimeGeneration: agentRuntimeGeneration(3),
    currentManager: {
      managerHumanId: humanId("alice"),
      managerAuthorizationRevision: authorizationRevision(7),
      managerDeviceId: cryptoDeviceId("alice-phone"),
    },
    currentManagerAvailable: true,
    activeConfigInventory: inventory,
    current,
    next,
  });
}

describe("Wave 8 Agent authorization graph transition planning", () => {
  test("deduplicates twenty Namespace edges into three Domain envelopes", () => {
    const namespaces = Array.from({ length: 20 }, (_, index) => ({
      namespaceId: `room-${String(index).padStart(2, "0")}`,
      domainId: `domain-${index % 3}`,
      humanIds: ["alice", "bob"],
    }));
    const current = snapshot({ namespaces });
    const result = plan(current, current);

    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transition).toEqual({
      addedDomainIds: [],
      removedDomainIds: [],
      retainedDomainIds: ["domain-0", "domain-1", "domain-2"],
      refreshDomainIds: [],
      humansLosingFinalAccess: [],
    });
    expect(result.authorizationPlan.remainingDomains).toHaveLength(3);
    expect(result.authorizationTransitionPlan?.currentDomains).toHaveLength(3);
    expect(result.authorizationTransitionPlan?.remainingDomains)
      .toHaveLength(3);
    expect(result.authorizationTransitionPlan?.refreshedDomainIds)
      .toEqual([]);
  });

  test("creates only the first Domain edge and removes only the final edge", () => {
    const current = snapshot({
      namespaces: [
        { namespaceId: "room-a", domainId: "domain-ab", humanIds: ["alice"] },
        { namespaceId: "room-b", domainId: "domain-ab", humanIds: ["alice"] },
        { namespaceId: "room-c", domainId: "domain-c", humanIds: ["alice"] },
      ],
    });
    const oneOfSeveralRemoved = snapshot({
      namespaces: [
        { namespaceId: "room-b", domainId: "domain-ab", humanIds: ["alice"] },
        { namespaceId: "room-c", domainId: "domain-c", humanIds: ["alice"] },
      ],
    });
    const retained = plan(current, oneOfSeveralRemoved);
    expect(retained.status).toBe("ready");
    if (retained.status !== "ready") return;
    expect(retained.transition.removedDomainIds).toEqual([]);
    expect(retained.transition.refreshDomainIds).toEqual([]);

    const finalRemovedAndFirstAdded = snapshot({
      namespaces: [
        { namespaceId: "room-c", domainId: "domain-c", humanIds: ["alice"] },
        { namespaceId: "room-d", domainId: "domain-d", humanIds: ["alice"] },
      ],
    });
    const changed = plan(oneOfSeveralRemoved, finalRemovedAndFirstAdded);
    expect(changed.status).toBe("ready");
    if (changed.status !== "ready") return;
    expect(changed.transition).toMatchObject({
      addedDomainIds: ["domain-d"],
      removedDomainIds: ["domain-ab"],
      retainedDomainIds: ["domain-c"],
      refreshDomainIds: ["domain-d"],
    });
    expect(
      changed.authorizationTransitionPlan?.currentDomains.map(
        (domain) => String(domain.domainId),
      ),
    ).toEqual(["domain-ab", "domain-c"]);
    expect(
      changed.authorizationTransitionPlan?.remainingDomains.map(
        (domain) => String(domain.domainId),
      ),
    ).toEqual(["domain-c", "domain-d"]);
    expect(changed.authorizationTransitionPlan?.refreshedDomainIds)
      .toEqual(["domain-d"]);
  });

  test("rotates only when a Human loses the final global Runtime-authorizing edge", () => {
    const current = snapshot({
      namespaces: [
        {
          namespaceId: "room-a",
          domainId: "domain-a",
          humanIds: ["alice", "bob"],
        },
        {
          namespaceId: "room-b",
          domainId: "domain-b",
          humanIds: ["alice", "bob"],
        },
      ],
    });
    const bobStillHasOne = snapshot({
      namespaces: [
        {
          namespaceId: "room-a",
          domainId: "domain-a",
          humanIds: ["alice"],
        },
        {
          namespaceId: "room-b",
          domainId: "domain-b",
          humanIds: ["alice", "bob"],
        },
      ],
    });
    const preserved = plan(current, bobStillHasOne);
    expect(preserved.status).toBe("ready");
    if (preserved.status !== "ready") return;
    expect(preserved.authorizationPlan.runtimeRotationRequired).toBe(false);
    expect(preserved.transition.humansLosingFinalAccess).toEqual([]);

    const bobLosesFinal = snapshot({
      namespaces: [
        {
          namespaceId: "room-a",
          domainId: "domain-a",
          humanIds: ["alice"],
        },
        {
          namespaceId: "room-b",
          domainId: "domain-b",
          humanIds: ["alice"],
        },
      ],
    });
    const rotated = plan(bobStillHasOne, bobLosesFinal);
    expect(rotated.status).toBe("ready");
    if (rotated.status !== "ready") return;
    expect(rotated.authorizationPlan.runtimeRotationRequired).toBe(true);
    expect(rotated.authorizationTransitionPlan).toBeNull();
    expect(rotated.transition.humansLosingFinalAccess).toEqual(["bob"]);
    expect(rotated.transition.refreshDomainIds).toEqual([
      "domain-a",
      "domain-b",
    ]);
  });

  test("management access prevents premature rotation", () => {
    const current = snapshot({
      namespaces: [{
        namespaceId: "room-a",
        domainId: "domain-a",
        humanIds: ["alice", "bob"],
      }],
    });
    const next = snapshot({
      namespaces: [{
        namespaceId: "room-a",
        domainId: "domain-a",
        humanIds: ["alice"],
      }],
      managementHumanIds: ["bob"],
    });
    const result = plan(current, next);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.authorizationPlan.runtimeRotationRequired).toBe(false);
    expect(result.transition.humansLosingFinalAccess).toEqual([]);
  });

  test("stays pending when a required target committer or rotation manager is offline", () => {
    const current = snapshot({
      namespaces: [{
        namespaceId: "room-a",
        domainId: "domain-a",
        humanIds: ["alice", "bob"],
      }],
    });
    const next = snapshot({
      namespaces: [{
        namespaceId: "room-a",
        domainId: "domain-a",
        humanIds: ["alice"],
      }],
      unavailableDomains: ["domain-a"],
    });
    expect(plan(current, next)).toMatchObject({
      status: "pending",
      reason: "domain_committer_unavailable",
      unavailableDomainIds: ["domain-a"],
    });

    expect(planAgentRuntimeAuthorizationGraphTransition({
      operationId: "operation-manager-offline",
      agentId: agentId("genie"),
      oldAuthorizationRevision: authorizationRevision(20),
      newAuthorizationRevision: authorizationRevision(21),
      currentRuntimeGeneration: agentRuntimeGeneration(3),
      currentManager: {
        managerHumanId: humanId("alice"),
        managerAuthorizationRevision: authorizationRevision(7),
        managerDeviceId: cryptoDeviceId("alice-phone"),
      },
      currentManagerAvailable: false,
      activeConfigInventory: inventory,
      current,
      next: snapshot({
        namespaces: [{
          namespaceId: "room-a",
          domainId: "domain-a",
          humanIds: ["alice"],
        }],
      }),
    })).toMatchObject({
      status: "pending",
      reason: "manager_unavailable",
    });

    const removalOnly = snapshot({
      namespaces: [{
        namespaceId: "room-b",
        domainId: "domain-b",
        humanIds: ["alice", "bob"],
      }],
    });
    expect(planAgentRuntimeAuthorizationGraphTransition({
      operationId: "operation-removal-manager-offline",
      agentId: agentId("genie"),
      oldAuthorizationRevision: authorizationRevision(20),
      newAuthorizationRevision: authorizationRevision(21),
      currentRuntimeGeneration: agentRuntimeGeneration(3),
      currentManager: {
        managerHumanId: humanId("alice"),
        managerAuthorizationRevision: authorizationRevision(7),
        managerDeviceId: cryptoDeviceId("alice-phone"),
      },
      currentManagerAvailable: false,
      activeConfigInventory: inventory,
      current: snapshot({
        namespaces: [
          {
            namespaceId: "room-a",
            domainId: "domain-a",
            humanIds: ["alice", "bob"],
          },
          {
            namespaceId: "room-b",
            domainId: "domain-b",
            humanIds: ["alice", "bob"],
          },
        ],
      }),
      next: removalOnly,
    })).toMatchObject({
      status: "pending",
      reason: "manager_unavailable",
      transition: {
        removedDomainIds: ["domain-a"],
        refreshDomainIds: [],
      },
    });
  });

  test("refreshes a retained Domain when its authenticated head changes", () => {
    const current = snapshot({
      namespaces: [{
        namespaceId: "room-a",
        domainId: "domain-a",
        humanIds: ["alice"],
      }],
    });
    const next: AgentRuntimeAuthorizationGraphSnapshot = {
      ...structuredClone(current),
      domainAuthorities: [{
        ...current.domainAuthorities[0]!,
        domainEpoch: domainEpoch(9),
        agentAuthorizationRevision: authorizationRevision(15),
      }],
    };
    const result = plan(current, next);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;
    expect(result.transition.refreshDomainIds).toEqual(["domain-a"]);
    expect(result.authorizationPlan.remainingDomains).toEqual([{
      domainId: cryptoDomainId("domain-a"),
      domainEpoch: domainEpoch(9),
      agentAuthorizationRevision: authorizationRevision(15),
      committerDeviceId: cryptoDeviceId("device-domain-a"),
    }]);
  });

  test("rejects non-portable Human, Namespace, and Domain identifiers", () => {
    const current = snapshot({
      namespaces: [
        {
          namespaceId: "room-a",
          domainId: "\u{10000}",
          humanIds: ["\u{10000}"],
        },
        {
          namespaceId: "room-b",
          domainId: "\u{e000}",
          humanIds: ["\u{e000}"],
        },
      ],
      managementHumanIds: ["\u{e000}", "\u{10000}"],
    });
    expect(() => plan(current, current)).toThrow(
      "is invalid",
    );
  });
});
