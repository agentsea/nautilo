/**
 * Running-kernel admission for CVE-2026-98432, not kernel attestation or a
 * replacement for host updates. Evidence: https://ubuntu.com/security/CVE-2026-98432
 * (reviewed 2026-11-11). Ubuntu backports require vendor build versions; the
 * upstream version at the end of /proc/version_signature is not a fix floor.
 *
 * Coverage is deliberately limited to generic, AWS, Azure, GCP, Oracle, KVM,
 * and lowlatency streams below. Other vendors, flavours, branches, FIPS,
 * custom builds and livepatch state are unverified. A newer branch is not
 * automatically fixed. The signature is kernel-reported identity, not proof
 * of package provenance. No host userspace release is inferred from a container.
 */
export const UBUNTU_HOST_KERNEL_CVE = "CVE-2026-98432";

export interface UbuntuHostKernelAssessment {
  readonly cve: typeof UBUNTU_HOST_KERNEL_CVE;
  readonly status: "fixed" | "affected" | "unknown";
  readonly signature: string | null;
  readonly message: string;
  readonly flavour?: string;
  readonly version?: string;
  readonly fixedVersion?: string;
}

interface KernelVersion {
  readonly branch: string;
  readonly abi: string;
  readonly revision: readonly string[];
  readonly backport: string;
  readonly flavour: string;
  readonly version: string;
}

// Each entry retains its Ubuntu source-package stream. Unsuffixed entries
// correspond to linux / linux-<flavour> in their native Ubuntu release;
// ~20.04.1, ~22.04.1 and ~24.04.1 identify the separately published backports.
// Generic HWE streams still listed as vulnerable/work in progress have no
// accepted fixed floor, even if an installed build matches the proposed fix.
const FIXED_VERSIONS: Readonly<Record<string, readonly string[]>> = {
  generic: [
    "5.15.0-203.213", "5.15.0-203.213~20.04.1",
    "6.8.0-149.149", "7.0.0-43.43", "7.3.0-10.10",
  ],
  aws: [
    "5.15.0-1120.127", "5.15.0-1120.127~20.04.1",
    "6.8.0-1069.74", "6.8.0-1069.74~22.04.1",
    "7.0.0-1017.18", "7.0.0-1017.18~24.04.1", "7.3.0-1004.4",
  ],
  azure: [
    "5.15.0-1126.135", "5.15.0-1126.135~20.04.1",
    "6.8.0-1073.82", "6.8.0-1073.82~22.04.1",
    "7.0.0-1020.21", "7.3.0-1004.4",
  ],
  gcp: [
    "5.15.0-1121.131", "5.15.0-1121.131~20.04.1",
    "6.8.0-1073.81", "6.8.0-1073.81~22.04.1",
    "7.0.0-1017.19", "7.0.0-1017.19~24.04.1", "7.3.0-1004.4",
  ],
  oracle: [
    "5.15.0-1117.123", "5.15.0-1117.123~20.04.1",
    "6.8.0-1067.71", "6.8.0-1067.71~22.04.1",
    "7.0.0-1016.18", "7.0.0-1016.18~24.04.1", "7.3.0-1004.4",
  ],
  kvm: ["5.15.0-1112.117"],
  lowlatency: [
    "5.15.0-198.208", "5.15.0-198.208~20.04.1",
    "6.8.0-149.149.1", "6.8.0-149.149.1~22.04.1",
  ],
};

// The same advisory lists native linux on Xenial, Bionic and Focal, and
// linux-hwe-6.17 on Noble, as vulnerable without a published fixed build.
// The Jammy 6.8 and Noble 7.0 generic HWE builds remain work in progress.
// Proposed fix versions are deliberately not accepted as release evidence.
const GENERIC_AFFECTED_WITHOUT_FIXED_FLOOR: readonly string[] = [
  "4.4.0", "4.15.0", "5.4.0", "6.17.0~24.04.1",
  "6.8.0~22.04.1", "7.0.0~24.04.1",
];

function parseVersion(versionWithFlavour: string): KernelVersion | undefined {
  const match = /^(\d+\.\d+\.\d+)-(\d+)\.(\d+(?:\.\d+)*)(~\d+\.\d+\.\d+)?-([a-z][a-z0-9-]*)$/.exec(versionWithFlavour);
  if (!match) return undefined;
  const [, branch, abi, revision, suffix, flavour] = match;
  if (!branch || !abi || !revision || !flavour) return undefined;
  const backport = suffix ?? "";
  return { branch, abi, revision: revision.split("."), backport, flavour,
    version: `${branch}-${abi}.${revision}${backport}` };
}

function sameStream(a: KernelVersion, b: KernelVersion): boolean {
  return a.branch === b.branch && a.flavour === b.flavour && a.backport === b.backport;
}

// Compare decimal components without lexical ordering or floating-point loss.
function compareDecimal(a: string, b: string): number {
  const left = a.replace(/^0+(?=\d)/, "");
  const right = b.replace(/^0+(?=\d)/, "");
  if (left.length !== right.length) return left.length < right.length ? -1 : 1;
  return left === right ? 0 : left < right ? -1 : 1;
}

function atLeastFloor(kernel: KernelVersion, floor: KernelVersion): boolean {
  const abiOrder = compareDecimal(kernel.abi, floor.abi);
  if (abiOrder !== 0) return abiOrder > 0;
  for (let i = 0; i < Math.max(kernel.revision.length, floor.revision.length); i++) {
    const order = compareDecimal(kernel.revision[i] ?? "0", floor.revision[i] ?? "0");
    if (order !== 0) return order > 0;
  }
  return true;
}

export function assessUbuntuHostKernel(signature: string | null): UbuntuHostKernelAssessment {
  const normalized = signature?.trim() || null;
  const base: Pick<UbuntuHostKernelAssessment, "cve" | "signature"> = {
    cve: UBUNTU_HOST_KERNEL_CVE, signature: normalized,
  };
  const unknown = (): UbuntuHostKernelAssessment => ({ ...base, status: "unknown",
    message: `${UBUNTU_HOST_KERNEL_CVE}: running kernel protection is unverified; this kernel identity is outside the supported Ubuntu build streams. Ask the host or platform administrator to verify the running kernel against its vendor advisory.` });
  if (normalized === null) return unknown();
  const tokens = normalized.split(/\s+/);
  if (tokens.length !== 3 || tokens[0] !== "Ubuntu" ||
    !/^\d+\.\d+\.\d+(?:[-.+~][A-Za-z0-9.-]+)?$/.test(tokens[2] ?? "")) return unknown();
  const kernel = parseVersion(tokens[1] ?? "");
  if (!kernel) return unknown();
  const identity = { ...base, flavour: kernel.flavour, version: kernel.version };
  const affectedWithoutFixedFloor = kernel.flavour === "generic" &&
    GENERIC_AFFECTED_WITHOUT_FIXED_FLOOR.includes(`${kernel.branch}${kernel.backport}`);
  const versions = Object.hasOwn(FIXED_VERSIONS, kernel.flavour)
    ? FIXED_VERSIONS[kernel.flavour] ?? [] : [];
  const floor = versions
    .map((version) => parseVersion(`${version}-${kernel.flavour}`))
    .find((candidate): candidate is KernelVersion => candidate !== undefined && sameStream(kernel, candidate));
  if (!floor && !affectedWithoutFixedFloor) return { ...unknown(), flavour: kernel.flavour, version: kernel.version };
  if (floor && atLeastFloor(kernel, floor)) {
    return { ...identity, status: "fixed", fixedVersion: floor.version,
      message: `${UBUNTU_HOST_KERNEL_CVE}: running Ubuntu ${kernel.version}-${kernel.flavour} meets the supported stream's fixed build ${floor.version}.` };
  }
  return { ...identity, status: "affected", ...(floor ? { fixedVersion: floor.version } : {}),
    message: `${UBUNTU_HOST_KERNEL_CVE}: refusing to start on affected Ubuntu ${kernel.version}-${kernel.flavour}. ${floor ? `Install the vendor kernel update for this stream (${floor.version} or newer)` : "This Ubuntu stream has no accepted fixed build in this policy; obtain a vendor-confirmed fixed kernel"}, reboot the Docker host or platform VM, and verify its running kernel before retrying. Updating the container image alone does not update the host kernel.` };
}
