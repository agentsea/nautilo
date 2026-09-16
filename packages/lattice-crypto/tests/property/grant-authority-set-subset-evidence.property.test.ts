import { describe, expect, test } from "bun:test";

import { LatticeCrypto, seededRng } from "../../src/crypto/index.ts";
import { serializeGrantV2 } from "../../src/format/grant-v2.ts";
import { mintGrantV2 } from "../../src/grant/authorization.ts";
import type {
  GrantAuthoritySetAuthorizationV2,
} from "../../src/grant/set-authorization.ts";
import {
  assertAuthenticGrantAuthoritySetExecutionEvidenceV2,
  coordinateGrantAuthoritySetUseV2,
  preflightGrantAuthoritySetUseV2,
  withGrantAuthoritySetExecutionEvidenceSubsetV2,
} from "../../src/grant/set-storage-coordinator.ts";
import { InMemoryV2Store } from "../../src/storage/v2-store.ts";
import {
  accessRevision,
  agentId,
  authorizationRevision,
  cryptoDeviceId,
  cryptoDomainId,
  domainEpoch,
  grantId,
  humanId,
  namespaceId,
} from "../../src/v2-types/ids.ts";
import { opaqueBytes } from "../../src/v2-types/opaque.ts";

const NOW = 12_000_000;

describe("Grant authority-set subset evidence recorded properties", () => {
  test("projects every nonempty Namespace subset to only its covering Domains", async () => {
    for (let seed = 1; seed <= 14; seed += 1) {
      const crypto = new LatticeCrypto(seededRng(24_300 + seed));
      const issuer = crypto.generateSigningKeyPair();
      const recipient = await crypto.generateEncryptionKeyPair();
      const domains = [
        {
          domainId: cryptoDomainId(`domain-a-${seed}`),
          domainEpoch: domainEpoch(1 + seed),
          agentAuthorizationRevision: authorizationRevision(10 + seed),
          aiRoot: new Uint8Array(32).fill(0x40 + seed),
        },
        {
          domainId: cryptoDomainId(`domain-b-${seed}`),
          domainEpoch: domainEpoch(2 + seed),
          agentAuthorizationRevision: authorizationRevision(20 + seed),
          aiRoot: new Uint8Array(32).fill(0x60 + seed),
        },
      ] as const;
      const namespaces = [
        {
          namespaceId: namespaceId(`namespace-a-${seed}`),
          domainId: domains[0].domainId,
        },
        {
          namespaceId: namespaceId(`namespace-b-${seed}`),
          domainId: domains[0].domainId,
        },
        {
          namespaceId: namespaceId(`namespace-c-${seed}`),
          domainId: domains[1].domainId,
        },
      ] as const;
      const grant = await mintGrantV2(crypto, {
        id: grantId(`grant-subset-property-${seed}`),
        issuingDeviceId: cryptoDeviceId(`device-${seed}`),
        issuingHumanId: humanId(`human-${seed}`),
        issuingDeviceSigningPrivateKey: issuer.privateKey,
        recipientAgentId: agentId(`agent-${seed}`),
        recipientKeyId: `recipient-${seed}`,
        recipientEncryptionPublicKey: recipient.publicKey,
        scope: [humanId(`human-${seed}`)],
        operations: ["encrypt"],
        issuedAt: NOW + seed,
        expiresAt: NOW + seed + 10_000,
        coveredDomains: domains,
        singleUse: true,
      });
      const authorization: GrantAuthoritySetAuthorizationV2 = {
        now: NOW + seed + 1,
        expectedIssuingDeviceId: grant.issuingDeviceId,
        issuingDeviceHumanId: grant.scope[0]!,
        issuingDeviceSigningPublicKey: issuer.publicKey,
        issuingDeviceActive: true,
        recipientAgentId: grant.recipientAgentId,
        recipientKeyId: grant.recipientKeyId,
        recipientEncryptionPrivateKey: recipient.privateKey,
        singleUseAvailable: true,
        grantScope: grant.scope,
        namespaceRequirements: namespaces.map((entry, index) => ({
          ...entry,
          operations: ["encrypt"] as const,
          namespaceParticipants: grant.scope,
          expectedAccessRevision: accessRevision(seed + index + 1),
          expectedPolicyRevision: authorizationRevision(seed + index + 30),
        })),
        domainRequirements: domains.map((entry) => ({
          domainId: entry.domainId,
          expectedEpoch: entry.domainEpoch,
          expectedAgentAuthorizationRevision:
            entry.agentAuthorizationRevision,
        })),
        hostAllowsOperation: true,
      };
      const store = new InMemoryV2Store();
      await store.putGrant({
        grantId: grant.id,
        grantBytes: opaqueBytes("grant", serializeGrantV2(grant)),
        consumed: false,
      });
      const preflight = await preflightGrantAuthoritySetUseV2(
        crypto,
        grant,
        authorization,
      );
      if (preflight === null) throw new Error("expected property preflight");
      const mask = ((seed - 1) % 7) + 1;
      const selected = namespaces.filter((_, index) =>
        (mask & (1 << index)) !== 0
      ).map((entry) => entry.namespaceId);
      const expectedDomains = [...new Set(namespaces.filter((_, index) =>
        (mask & (1 << index)) !== 0
      ).map((entry) => entry.domainId))].sort();
      const result = await coordinateGrantAuthoritySetUseV2({
        preflight,
        storage: store,
        resolveCurrentAuthorization: (context) => ({
          context,
          currentTime: context.preflightTime,
          issuingDeviceActive: true,
          recipientAgentAuthorized: true,
          requestedNamespacesAuthorized: true,
          requestedDomainsAuthorized: true,
          hostAllowsOperation: true,
          currentSingleUseStatus: context.singleUseStatus,
        }),
        execute: (_opened, evidence) =>
          withGrantAuthoritySetExecutionEvidenceSubsetV2({
            evidence,
            namespaceIds: selected,
            requiredOperations: ["encrypt"],
            execute: (subset) => {
              expect(() =>
                assertAuthenticGrantAuthoritySetExecutionEvidenceV2(subset)
              ).not.toThrow();
              expect(subset.namespaceRequirements.map((entry) =>
                entry.namespaceId
              )).toEqual(selected);
              expect(subset.domainRequirements.map((entry) => entry.domainId))
                .toEqual(expectedDomains);
              const selectedSet = new Set<string>(selected);
              expect(subset.namespaceRequirements.every((entry) =>
                selectedSet.has(entry.namespaceId)
              )).toBe(true);
              return mask;
            },
          }),
      });
      expect(result).toEqual({ status: "executed", value: mask });
    }
  });
});
