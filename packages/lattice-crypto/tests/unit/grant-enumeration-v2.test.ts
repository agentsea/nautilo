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
import { V2_LIMITS } from "../../src/v2-types/limits.ts";

function candidate(
  namespace: string,
  domain: string,
  participants: string[],
  epoch = 0,
  authorization = 0,
): GrantNamespaceCandidateV2 {
  return {
    namespaceId: namespaceId(namespace),
    participants: participants.map(humanId),
    domainId: cryptoDomainId(domain),
    domainEpoch: domainEpoch(epoch),
    agentAuthorizationRevision: authorizationRevision(authorization),
    namespaceAccessRevision: accessRevision(0),
  };
}

describe("v2 Domain-size grant enumeration", () => {
  test("one and fifty same-Domain Namespaces produce one covered Domain", () => {
    const namespaces = Array.from(
      { length: 50 },
      (_, index) => candidate(`namespace-${index}`, "domain-ab", ["alice", "bob"]),
    );

    const result = enumerateGrantDomains([humanId("alice")], namespaces);

    expect(result.domains).toEqual([{
      domainId: cryptoDomainId("domain-ab"),
      domainEpoch: domainEpoch(0),
      agentAuthorizationRevision: authorizationRevision(0),
    }]);
    expect(result.coveredNamespaceCount).toBe(50);
    expect(result.distinctDomainCount).toBe(1);
  });

  test("the subset rule filters Namespaces and sorts distinct Domains by unsigned bytes", () => {
    const result = enumerateGrantDomains(
      [humanId("alice")],
      [
        candidate("namespace-z", "domain-z", ["alice", "bob"]),
        candidate("namespace-out", "domain-a", ["bob"]),
        candidate("namespace-a", "domain-a", ["alice"]),
      ],
    );

    expect(result.domains.map((domain) => domain.domainId)).toEqual([
      cryptoDomainId("domain-a"),
      cryptoDomainId("domain-z"),
    ]);
    expect(result.coveredNamespaceCount).toBe(2);

    expect(
      enumerateGrantDomains(
        [humanId("alice"), humanId("bob")],
        [
          candidate("namespace-partial", "domain-partial", ["alice", "carol"]),
          candidate(
            "namespace-complete",
            "domain-complete",
            ["alice", "bob", "carol"],
          ),
        ],
      ).domains.map((domain) => domain.domainId),
    ).toEqual([cryptoDomainId("domain-complete")]);
  });

  test("same-Domain candidates must agree on current epoch and authorization revision", () => {
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [
          candidate("namespace-1", "domain-ab", ["alice", "bob"], 1, 2),
          candidate("namespace-2", "domain-ab", ["alice", "bob"], 2, 2),
        ],
      )
    ).toThrow("inconsistent");
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [
          candidate("namespace-1", "domain-ab", ["alice"], 1, 2),
          candidate("namespace-2", "domain-ab", ["alice", "bob"], 1, 2),
        ],
      )
    ).toThrow("inconsistent");
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [
          candidate("namespace-1", "domain-ab", ["alice", "bob"], 1, 2),
          candidate("namespace-2", "domain-ab", ["alice", "bob"], 1, 3),
        ],
      )
    ).toThrow("inconsistent");
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [
          candidate("namespace-1", "domain-ab", ["alice", "bob"], 1, 2),
          candidate("namespace-2", "domain-ab", ["alice"], 1, 2),
        ],
      )
    ).toThrow("inconsistent");
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [
          candidate("namespace-1", "domain-ab", ["alice", "bob"], 1, 2),
          candidate("namespace-2", "domain-ab", ["alice", "carol"], 1, 2),
        ],
      )
    ).toThrow("inconsistent");
  });

  test("scope and distinct-Domain ceilings fail closed", () => {
    expect(() =>
      enumerateGrantDomains(
        Array.from({ length: 33 }, (_, index) => humanId(`human-${index}`)),
        [],
      )
    ).toThrow("Grant Human scope exceeds the 32 limit");

    const candidates = Array.from(
      { length: V2_LIMITS.agentGrantDomains + 1 },
      (_, index) =>
        candidate(
          `namespace-${index}`,
          `domain-${index.toString().padStart(5, "0")}`,
          ["alice"],
        ),
    );
    expect(() =>
      enumerateGrantDomains([humanId("alice")], candidates)
    ).toThrow(
      `Distinct covered Crypto Domains exceeds the ${V2_LIMITS.agentGrantDomains} limit`,
    );
  });

  test("noncanonical or duplicate participant inputs fail before enumeration", () => {
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice"), humanId("alice")],
        [],
      )
    ).toThrow("duplicate");
    expect(() =>
      enumerateGrantDomains(
        [humanId("alice")],
        [candidate("namespace-1", "domain-ab", ["bob", "alice"])],
      )
    ).toThrow("canonical");
  });
});
