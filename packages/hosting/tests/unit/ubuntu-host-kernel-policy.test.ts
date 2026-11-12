import { describe, expect, test } from "bun:test";
import { assessUbuntuHostKernel } from "../../src/ubuntu-host-kernel-policy.ts";

function signature(version: string, flavour = "generic", upstream = "6.8.12"): string {
  return `Ubuntu ${version}-${flavour} ${upstream}`;
}

describe("Ubuntu CVE-2026-98432 vendor build floors", () => {
  // Independently transcribed advisory boundaries, including separate backports.
  const fixedBuilds: readonly [string, string][] = [
    ["generic", "5.15.0-203.213"], ["generic", "5.15.0-203.213~20.04.1"],
    ["generic", "6.8.0-149.149"], ["generic", "7.0.0-43.43"], ["generic", "7.3.0-10.10"],
    ["aws", "5.15.0-1120.127"], ["aws", "5.15.0-1120.127~20.04.1"],
    ["aws", "6.8.0-1069.74"], ["aws", "6.8.0-1069.74~22.04.1"],
    ["aws", "7.0.0-1017.18"], ["aws", "7.0.0-1017.18~24.04.1"], ["aws", "7.3.0-1004.4"],
    ["azure", "5.15.0-1126.135"], ["azure", "5.15.0-1126.135~20.04.1"],
    ["azure", "6.8.0-1073.82"], ["azure", "6.8.0-1073.82~22.04.1"],
    ["azure", "7.0.0-1020.21"], ["azure", "7.3.0-1004.4"],
    ["gcp", "5.15.0-1121.131"], ["gcp", "5.15.0-1121.131~20.04.1"],
    ["gcp", "6.8.0-1073.81"], ["gcp", "6.8.0-1073.81~22.04.1"],
    ["gcp", "7.0.0-1017.19"], ["gcp", "7.0.0-1017.19~24.04.1"], ["gcp", "7.3.0-1004.4"],
    ["oracle", "5.15.0-1117.123"], ["oracle", "5.15.0-1117.123~20.04.1"],
    ["oracle", "6.8.0-1067.71"], ["oracle", "6.8.0-1067.71~22.04.1"],
    ["oracle", "7.0.0-1016.18"], ["oracle", "7.0.0-1016.18~24.04.1"], ["oracle", "7.3.0-1004.4"],
    ["kvm", "5.15.0-1112.117"],
    ["lowlatency", "5.15.0-198.208"], ["lowlatency", "5.15.0-198.208~20.04.1"],
    ["lowlatency", "6.8.0-149.149.1"], ["lowlatency", "6.8.0-149.149.1~22.04.1"],
  ];
  for (const [flavour, fixedVersion] of fixedBuilds) {
    test(`${flavour} ${fixedVersion}: below, exact and later ABI`, () => {
      const [branch, build = ""] = fixedVersion.split("-");
      const [abi = ""] = build.split(".");
      const suffix = fixedVersion.includes("~") ? `~${fixedVersion.split("~")[1]}` : "";
      expect(assessUbuntuHostKernel(signature(`${branch}-${Number(abi) - 1}.9999${suffix}`, flavour)).status).toBe("affected");
      const exact = assessUbuntuHostKernel(signature(fixedVersion, flavour));
      expect(exact.status).toBe("fixed");
      expect(exact.fixedVersion).toBe(fixedVersion);
      expect(assessUbuntuHostKernel(signature(`${branch}-${Number(abi) + 1}.1${suffix}`, flavour)).status).toBe("fixed");
    });
  }

  test("compares vendor upload revisions and lowlatency's extra component numerically", () => {
    expect(assessUbuntuHostKernel(signature("6.8.0-149.148")).status).toBe("affected");
    expect(assessUbuntuHostKernel(signature("6.8.0-149.150")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(signature("6.8.0-149.99")).status).toBe("affected");
    expect(assessUbuntuHostKernel(signature("6.8.0-149.149", "lowlatency")).status).toBe("affected");
    expect(assessUbuntuHostKernel(signature("6.8.0-149.149.2", "lowlatency")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(signature("5.15.0-198.208", "lowlatency")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(signature("5.15.0-198.208", "generic")).status).toBe("affected");
  });

  test("keeps cloud vendor floors separate", () => {
    expect(assessUbuntuHostKernel(signature("6.8.0-1073.81", "gcp")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(signature("6.8.0-1073.81", "azure")).status).toBe("affected");
    expect(assessUbuntuHostKernel(signature("7.0.0-1017.18~24.04.1", "aws")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(signature("7.0.0-1017.18~24.04.1", "gcp")).status).toBe("affected");
  });

  test("does not certify work-in-progress generic HWE streams at proposed or later builds", () => {
    for (const version of ["6.8.0-149.149~22.04.1", "6.8.0-999.999~22.04.1",
      "7.0.0-43.43~24.04.1", "7.0.0-999.999~24.04.1"]) {
      const result = assessUbuntuHostKernel(signature(version));
      expect(result.status).toBe("affected");
      expect(result.fixedVersion).toBeUndefined();
      expect(result.message).toContain("reboot");
    }
  });

  test("refuses known vulnerable native and Noble HWE streams without inventing fix floors", () => {
    for (const version of ["4.4.0-292.326", "4.4.0-293.327", "4.4.0-999.999",
      "4.15.0-262.274", "4.15.0-263.275", "4.15.0-999.999",
      "5.4.0-246.266", "5.4.0-247.267", "5.4.0-999.999",
      "6.17.0-1.1~24.04.1", "6.17.0-999.999~24.04.1"]) {
      const result = assessUbuntuHostKernel(signature(version));
      expect(result.status).toBe("affected");
      expect(result.fixedVersion).toBeUndefined();
      expect(result.message).toContain("no accepted fixed build");
      expect(result.message).toContain("reboot");
    }
  });

  test("uses the running vendor build, not the displayed upstream version", () => {
    expect(assessUbuntuHostKernel(signature("6.8.0-148.148", "generic", "7.99.99")).status).toBe("affected");
    expect(assessUbuntuHostKernel(signature("6.8.0-149.149", "generic", "6.8.12")).status).toBe("fixed");
    expect(assessUbuntuHostKernel(" \tUbuntu  6.8.0-149.149-generic\t6.8.12\n").status).toBe("fixed");
  });

  test("unsupported identities remain explicitly unverified", () => {
    for (const input of [null, "", "Linux 6.8.0-149.149-generic 6.8.12",
      "Ubuntu 6.8.0-149.149-generic", "Ubuntu 6.8.0-149.149-generic invalid",
      "Ubuntu 6.8.0-149.149-generic 6.8.12 extra", signature("6.8.0-999.999+custom1"),
      signature("6.8.0-999.999", "aws-fips"), signature("6.8.0-999.999", "azure-fde"),
      signature("6.8.0-999.999", "generic-64k"), signature("6.8.0-999.999", "constructor"), signature("7.4.0-999.999"),
      signature("5.4.0-247.267~18.04.1"), signature("6.17.0-999.999"),
      signature("6.8.0-999.999~22.04.2"),
      signature("7.0.0-999.999~24.04.1", "azure")]) {
      const result = assessUbuntuHostKernel(input);
      expect(result.status).toBe("unknown");
      expect(result.message).toContain("unverified");
    }
  });

  test("affected diagnostic gives host recovery guidance", () => {
    const result = assessUbuntuHostKernel(signature("6.8.0-148.148"));
    expect(result.message).toContain("6.8.0-149.149");
    expect(result.message).toContain("reboot the Docker host");
    expect(result.message).toContain("container image alone does not update");
  });
});
