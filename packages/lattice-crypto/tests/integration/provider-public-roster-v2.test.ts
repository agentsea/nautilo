import { describe, expect, test } from "bun:test";
import { cryptoDomainId } from "../../src/index.ts";
import { v2ProviderMatrix } from "../../src/testing/index.ts";
import {
  decodeProviderRosterV2,
  validateProviderPublicTransitionV2,
} from "../../src/wire.ts";

describe("real provider public roster decoding", () => {
  for (const [index, row] of v2ProviderMatrix
    .filter((candidate) => candidate.id !== "dummy")
    .entries()) {
    test(`${row.id} exposes the exact authenticated device-add roster`, async () => {
      const fixture = await row.create({
        seed: 0x7a10 + index,
        domainId: cryptoDomainId(`domain_public_roster_${row.id}`),
      });
      const result = await row.prepareSemanticTransition({
        fixture,
        semantic: "device-add",
        seed: 0x7a20 + index,
      });
      const transition = validateProviderPublicTransitionV2(
        result.prepared.publicResult,
      );
      const roster = decodeProviderRosterV2(
        transition.providerId,
        transition.rosterBytes,
      );

      expect(roster).toHaveLength(2);
      const target = roster.find(
        (entry) => entry.deviceId === transition.targetDeviceId,
      );
      expect(target?.humanId).toBe(transition.targetHumanId);
      expect(Number.isSafeInteger(target?.leafIndex)).toBe(true);
      expect(
        roster.map((entry) => entry.leafIndex),
      ).toEqual(
        [...roster]
          .map((entry) => entry.leafIndex)
          .sort((left, right) => left - right),
      );
    });
  }
});
