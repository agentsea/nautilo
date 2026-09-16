import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { HUMAN_DEVICE_MEMBERSHIP_MAX_BASE64URL_BYTES_V1 } from
  "@nautilo/api-client";
import { HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES } from
  "@nautilo/lattice-crypto";

const membershipClient = await readFile(
  new URL(
    "../../src/device/human-device-membership-client.ts",
    import.meta.url,
  ),
  "utf8",
);
const domainAuthority = await readFile(
  new URL(
    "../../src/server/delivery/postgres-domain-key-authority.ts",
    import.meta.url,
  ),
  "utf8",
);

describe("M304 Human-device membership boundary", () => {
  test("stores one dedicated MLS snapshot without consulting Domain inventory", () => {
    expect(membershipClient).toContain("humanDeviceGroupSnapshot");
    expect(membershipClient).not.toContain("activeProviderSnapshots");
    expect(membershipClient).not.toContain("exportDomainRoots");
  });

  test("requires the exact current group head before M301 device eligibility", () => {
    expect(domainAuthority).toContain("currentHumanDeviceMembershipHead()");
    for (const coordinate of [
      "membershipServerInstanceId",
      "membershipLineageGeneration",
      "membershipEpoch",
      "membershipSecurityRevision",
      "membershipHeadDigest",
    ]) expect(domainAuthority).toContain(coordinate);
  });

  test("keeps the wire-byte ceiling equal to canonical transition expansion", () => {
    expect(HUMAN_DEVICE_MEMBERSHIP_MAX_BASE64URL_BYTES_V1).toBe(
      Math.ceil(HUMAN_DEVICE_GROUP_MAX_TRANSITION_BYTES / 3) * 4,
    );
  });
});
