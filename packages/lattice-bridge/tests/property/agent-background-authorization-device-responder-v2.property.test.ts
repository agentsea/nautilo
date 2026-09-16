import { describe, expect, test } from "bun:test";

import {
  accessRevision,
  agentId,
  agentRuntimeGeneration,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  humanId,
  namespaceId,
} from "@nautilo/lattice-crypto";
import type {
  BackgroundDomainRequirementV2,
  BackgroundNamespaceRequirementV2,
} from "@nautilo/lattice-crypto/wire";
import {
  assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2,
  type AgentBackgroundAuthorizationDevicePublicAuthorityV2,
} from "../../src/device/agent-background-authorization-responder-v2.ts";

function rotate<T>(values: readonly T[], amount: number): readonly T[] {
  const offset = amount % values.length;
  return [...values.slice(offset), ...values.slice(0, offset)];
}

function fixture(seed: number): Readonly<{
  expected: Parameters<
    typeof assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2
  >[0];
  authority: AgentBackgroundAuthorizationDevicePublicAuthorityV2;
}> {
  const namespaceRequirements: BackgroundNamespaceRequirementV2[] = [];
  const domainRequirements: BackgroundDomainRequirementV2[] = [];
  for (let index = 0; index < 4; index += 1) {
    const suffix = String(index).padStart(2, "0");
    namespaceRequirements.push({
      namespaceId: namespaceId(`namespace-${suffix}`),
      domainId: cryptoDomainId(`domain-${suffix}`),
      operations: index % 2 === 0
        ? ["decrypt"]
        : ["decrypt", "encrypt"],
      expectedAccessRevision: accessRevision(seed + index + 1),
      expectedPolicyRevision: authorizationRevision(
        seed * 10 + index + 1,
      ),
    });
    domainRequirements.push({
      domainId: cryptoDomainId(`domain-${suffix}`),
      expectedEpoch: domainEpoch(seed + index + 2),
      expectedAgentAuthorizationRevision: authorizationRevision(
        seed * 100 + index + 1,
      ),
    });
  }
  const expected = Object.freeze({
    grantScope: [humanId("human-alice"), humanId("human-bob")],
    agentId: agentId("agent-genie"),
    runtimeGeneration: agentRuntimeGeneration(seed),
    agentAuthorizationRevision: authorizationRevision(seed * 1_000),
    namespaceRequirements,
    domainRequirements,
    issuingHumanId: humanId("human-alice"),
    issuingDeviceId: cryptoDeviceId("device-alice"),
    issuingDeviceAuthorizationRevision: authorizationRevision(seed + 7),
  });
  const authority: AgentBackgroundAuthorizationDevicePublicAuthorityV2 = {
    humanId: humanId("human-alice"),
    humanState: "active",
    deviceId: cryptoDeviceId("device-alice"),
    deviceHumanId: humanId("human-alice"),
    deviceState: "active",
    deviceAuthorizationRevision: authorizationRevision(seed + 7),
    deviceSigningPublicKey: new Uint8Array(32).fill(seed & 0xff),
    agentId: expected.agentId,
    agentState: "active",
    runtimeGeneration: expected.runtimeGeneration,
    agentAuthorizationRevision: expected.agentAuthorizationRevision,
    namespaces: namespaceRequirements.map((requirement) => ({
      namespaceId: requirement.namespaceId,
      domainId: requirement.domainId,
      namespaceState: "active" as const,
      issuingHumanAccess: "authorized" as const,
      grantScopeAccess: "authorized" as const,
      authorizedOperations: requirement.operations,
      namespaceAccessRevision: requirement.expectedAccessRevision,
      policyRevision: requirement.expectedPolicyRevision,
    })),
    domains: domainRequirements.map((requirement) => ({
      domainId: requirement.domainId,
      domainState: "active" as const,
      domainEpoch: requirement.expectedEpoch,
      agentAuthorizationRevision:
        requirement.expectedAgentAuthorizationRevision,
    })),
  };
  return Object.freeze({ expected, authority });
}

describe("Agent v2 complete authority-set properties", () => {
  test("accepts only exact order, cardinality, coordinates, and independent revisions", () => {
    for (let seed = 1; seed <= 64; seed += 1) {
      const { expected, authority } = fixture(seed);
      expect(() =>
        assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
          expected,
          authority,
        )
      ).not.toThrow();

      expect(() =>
        assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
          expected,
          { ...authority, namespaces: rotate(authority.namespaces, 1) },
        )
      ).toThrow();
      expect(() =>
        assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
          expected,
          { ...authority, domains: rotate(authority.domains, 1) },
        )
      ).toThrow();
      expect(() =>
        assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
          expected,
          { ...authority, namespaces: authority.namespaces.slice(0, -1) },
        )
      ).toThrow();
      expect(() =>
        assertCurrentAgentBackgroundAuthorizationPublicAuthorityV2(
          expected,
          {
            ...authority,
            domains: authority.domains.map((domain, index) =>
              index === seed % authority.domains.length
                ? {
                  ...domain,
                  agentAuthorizationRevision: authorizationRevision(
                    domain.agentAuthorizationRevision + 1,
                  ),
                }
                : domain
            ),
          },
        )
      ).toThrow();
    }
  });
});
