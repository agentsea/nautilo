import { describe, expect, test } from "bun:test";
import {
  enumerateGrantDomains,
  type GrantNamespaceCandidateV2,
} from "../../src/grant/enumeration.ts";
import {
  accessRevision,
  authorizationRevision,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
} from "../../src/v2-types/ids.ts";

function shuffled<T>(input: readonly T[], seed: number): T[] {
  const values = [...input];
  let state = seed >>> 0;
  const next = () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
  for (let index = values.length - 1; index > 0; index -= 1) {
    const target = next() % (index + 1);
    [values[index], values[target]] = [values[target]!, values[index]!];
  }
  return values;
}

function candidate(
  namespaceIndex: number,
  domainIndex: number,
): GrantNamespaceCandidateV2 {
  return {
    namespaceId: namespaceId(`namespace-${namespaceIndex}`),
    participants: [humanId("alice"), humanId("bob")],
    domainId: cryptoDomainId(
      `domain-${domainIndex.toString().padStart(3, "0")}`,
    ),
    domainEpoch: domainEpoch(domainIndex),
    agentAuthorizationRevision: authorizationRevision(domainIndex),
    namespaceAccessRevision: accessRevision(namespaceIndex),
  };
}

describe("v2 recorded-seed grant enumeration properties", () => {
  test("result size and order depend on distinct Domains, never Namespace order", () => {
    for (let seed = 1; seed <= 256; seed += 1) {
      const domainCount = 1 + (seed % 64);
      const namespaceCount = domainCount + (seed % 193);
      const candidates = Array.from(
        { length: namespaceCount },
        (_, index) => candidate(index, index % domainCount),
      );
      const left = enumerateGrantDomains(
        [humanId("alice")],
        shuffled(candidates, seed),
      );
      const right = enumerateGrantDomains(
        [humanId("alice")],
        shuffled(candidates, seed ^ 0xa5a5_a5a5),
      );

      try {
        expect(left).toEqual(right);
        expect(left.distinctDomainCount).toBe(domainCount);
        expect(left.coveredNamespaceCount).toBe(namespaceCount);
      } catch (error) {
        throw new Error(
          `grant enumeration property failed; replay seed ${seed}`,
          { cause: error },
        );
      }
    }
  });
});
