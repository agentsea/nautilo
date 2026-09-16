import { describe, expect, test } from "bun:test";

import {
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  humanId,
} from "@nautilo/lattice-crypto";

import {
  planAgentRuntimeAuthorizationGraphTransition,
  type AgentRuntimeAuthorizationGraphSnapshot,
} from "../../src/index";

function selected(seed: number, coordinate: number): boolean {
  let value = (seed ^ Math.imul(coordinate + 1, 0x9e3779b1)) >>> 0;
  value ^= value << 13;
  value ^= value >>> 17;
  value ^= value << 5;
  return (value >>> 0) % 3 !== 0;
}

function snapshot(
  seed: number,
): AgentRuntimeAuthorizationGraphSnapshot {
  const candidates = Array.from({ length: 12 }, (_, index) => {
    const authorizedHumanIds =
      Array.from({ length: 6 }, (_unused, humanIndex) =>
        `human-${humanIndex}`
      ).filter((_humanId, humanIndex) =>
        selected(seed + index, humanIndex)
      );
    return Object.freeze({
      namespaceId: `namespace-${String(index).padStart(2, "0")}`,
      domainId: `domain-${index % 4}`,
      authorizedHumanIds: Object.freeze(authorizedHumanIds),
    });
  });
  const selectedEdges = candidates.filter((_edge, index) =>
    selected(seed, 200 + index)
  );
  const edges = selectedEdges.length === 0
    ? [candidates[0]!]
    : selectedEdges;
  const domainIds =
    [...new Set(edges.map((edge) => edge.domainId))].sort();
  return Object.freeze({
    managementHumanIds: Object.freeze(
      ["human-0", "human-5"].filter((_humanId, index) =>
        selected(seed, 100 + index)
      ),
    ),
    namespaceEdges: Object.freeze(edges),
    domainAuthorities: Object.freeze(
      domainIds.map((domainId, index) =>
        Object.freeze({
          domainId,
          domainEpoch: 2 + index,
          agentAuthorizationRevision: 30 + index,
          committerDeviceId: `device-${domainId}`,
          committerAvailable: true,
        })
      ),
    ),
  });
}

function authorizedHumans(
  value: AgentRuntimeAuthorizationGraphSnapshot,
): readonly string[] {
  return [...new Set([
    ...value.managementHumanIds,
    ...value.namespaceEdges.flatMap((edge) =>
      edge.authorizedHumanIds
    ),
  ])].sort();
}

describe("Agent Runtime authorization graph properties", () => {
  test("bounded graph transitions preserve exact Domain and Human set algebra", () => {
    for (let seed = 1; seed <= 256; seed += 1) {
      const current = snapshot(seed);
      const next = snapshot(seed + 1);
      const result = planAgentRuntimeAuthorizationGraphTransition({
        operationId: `operation-${seed}`,
        agentId: agentId("genie"),
        oldAuthorizationRevision: authorizationRevision(seed),
        newAuthorizationRevision: authorizationRevision(seed + 1),
        currentRuntimeGeneration: agentRuntimeGeneration(seed % 8),
        currentManager: {
          managerHumanId: humanId("human-0"),
          managerAuthorizationRevision: authorizationRevision(9),
          managerDeviceId: cryptoDeviceId("manager-device"),
        },
        currentManagerAvailable: true,
        activeConfigInventory: {
          objectCount: 0,
          digest: new Uint8Array(32),
        },
        current,
        next,
      });
      expect(result.status).toBe("ready");
      if (result.status !== "ready") continue;

      const currentDomains =
        [...new Set(
          current.namespaceEdges.map((edge) => edge.domainId),
        )].sort();
      const nextDomains =
        [...new Set(
          next.namespaceEdges.map((edge) => edge.domainId),
        )].sort();
      const nextDomainSet = new Set(nextDomains);
      const currentDomainSet = new Set(currentDomains);
      const nextHumanSet = new Set(authorizedHumans(next));
      const losingHumans = authorizedHumans(current)
        .filter((humanId) => !nextHumanSet.has(humanId));

      expect(result.transition.addedDomainIds).toEqual(
        nextDomains.filter((domainId) =>
          !currentDomainSet.has(domainId)
        ),
      );
      expect(result.transition.removedDomainIds).toEqual(
        currentDomains.filter((domainId) =>
          !nextDomainSet.has(domainId)
        ),
      );
      expect(result.transition.humansLosingFinalAccess)
        .toEqual(losingHumans);
      expect(result.authorizationPlan.runtimeRotationRequired)
        .toBe(losingHumans.length > 0);
      expect(
        result.authorizationPlan.remainingDomains.map(
          (domain) => String(domain.domainId),
        ),
      ).toEqual(nextDomains);
      expect(
        new Set(
          result.authorizationPlan.remainingDomains.map(
            (domain) => domain.domainId,
          ),
        ).size,
      ).toBe(nextDomains.length);
    }
  });
});
