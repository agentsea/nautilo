import type { RuntimeImageEvidenceManifestV1 } from "./runtime-image-evidence.ts";

export interface UnavailableFix {
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly distribution: "debian:13";
  readonly availableVersion: string;
  readonly fixedVersion: string;
}
export interface PackageAvailabilityRequirement {
  readonly packageName: string;
  readonly installedVersion: string;
  readonly unavailableFix: UnavailableFix;
}
export interface SupportedPackageAvailability {
  readonly image: RuntimeImageEvidenceManifestV1["image"];
  readonly architecture: RuntimeImageEvidenceManifestV1["architecture"];
  readonly distribution: "debian:13";
  readonly checkedAt: string;
  readonly verifiedBy: "apt-secure";
  readonly signedIndexes: Readonly<Record<string, string>>;
  readonly packages: readonly {
    packageName: string; installedVersion: string; availableVersion: string;
    fixedVersion: string; fixAvailable: boolean;
  }[];
}
type Run = (command: string, args: readonly string[]) => Promise<{exitCode: number; stdout: string; stderr: string}>;

// Probe only supported, authenticated Debian archives. Never start the server,
// inherit its environment, mount production data, or install a package.
export const SUPPORTED_PACKAGE_PROBE = `
set -eu
. /etc/os-release
test "$ID:$VERSION_ID" = debian:13
test "$(dpkg --print-architecture)" = "$1"
shift
printf 'Types: deb\\nURIs: https://deb.debian.org/debian\\nSuites: trixie trixie-updates\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\n\\nTypes: deb\\nURIs: https://security.debian.org/debian-security\\nSuites: trixie-security\\nComponents: main\\nSigned-By: /usr/share/keyrings/debian-archive-keyring.gpg\\n' > /tmp/supported.sources
apt-get -o Dir::Etc::sourcelist=/tmp/supported.sources -o Dir::Etc::sourceparts=- -o Dir::Etc::preferences=/dev/null -o Dir::Etc::preferencesparts=- -o APT::Update::Error-Mode=any -o Acquire::AllowInsecureRepositories=false update >&2
for suite in trixie trixie-updates trixie-security; do
  if [ "$suite" = trixie-security ]; then origin=security.debian.org_debian-security; else origin=deb.debian.org_debian; fi
  hash="$(sha256sum "/var/lib/apt/lists/\${origin}_dists_\${suite}_InRelease" | cut -d' ' -f1)"
  printf 'index %s %s\\n' "$suite" "$hash"
done
while [ "$#" -gt 0 ]; do
  package="$1"; fixed="$2"; shift 2
  installed="$(dpkg-query -W -f='\${Version}' "$package")"
  available="$(apt-cache -o Dir::Etc::sourcelist=/tmp/supported.sources -o Dir::Etc::sourceparts=- -o Dir::Etc::preferences=/dev/null -o Dir::Etc::preferencesparts=- policy "$package" | awk '/Candidate:/ {print $2}')"
  test -n "$available"; test "$available" != '(none)'
  if dpkg --compare-versions "$available" lt "$fixed"; then fix_available=false; else fix_available=true; fi
  printf 'package %s %s %s %s %s\\n' "$package" "$installed" "$available" "$fixed" "$fix_available"
done
`;

export async function collectSupportedPackageAvailability(
  manifest: RuntimeImageEvidenceManifestV1,
  requirements: readonly PackageAvailabilityRequirement[],
  run: Run,
): Promise<SupportedPackageAvailability> {
  const selected = [...new Map(requirements.map(r => [r.packageName + "\0" + r.unavailableFix.fixedVersion, r])).values()];
  if (selected.length === 0) throw new Error("supported package probe needs exact requirements");
  const result = await run("docker", [
    "run", "--rm", "--read-only", "--user", "0:0", "--platform", manifest.architecture,
    "--tmpfs", "/tmp", "--tmpfs", "/var/lib/apt/lists", "--tmpfs", "/var/cache/apt",
    "--entrypoint", "/bin/sh", manifest.image.reference, "-ceu", SUPPORTED_PACKAGE_PROBE,
    "availability-probe", manifest.architecture.split("/")[1]!,
    ...selected.flatMap(r => [r.packageName, r.unavailableFix.fixedVersion]),
  ]);
  if (result.exitCode !== 0) throw new Error("authenticated supported package probe failed: " + result.stderr);
  const signedIndexes: Record<string, string> = {};
  const packages: SupportedPackageAvailability["packages"][number][] = [];
  for (const line of result.stdout.trim().split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields[0] === "index" && fields.length === 3 && ["trixie", "trixie-updates", "trixie-security"].includes(fields[1]!)) {
      if (!/^[a-f0-9]{64}$/.test(fields[2]!) || signedIndexes[fields[1]!] !== undefined) throw new Error("invalid signed index evidence");
      signedIndexes[fields[1]!] = fields[2]!;
    } else if (fields[0] === "package" && fields.length === 6 && ["true", "false"].includes(fields[5]!)) {
      packages.push({packageName: fields[1]!, installedVersion: fields[2]!, availableVersion: fields[3]!, fixedVersion: fields[4]!, fixAvailable: fields[5] === "true"});
    } else throw new Error("invalid supported package evidence");
  }
  if (Object.keys(signedIndexes).length !== 3 || packages.length !== selected.length ||
      selected.some(r => packages.filter(p => p.packageName === r.packageName && p.fixedVersion === r.unavailableFix.fixedVersion).length !== 1)) {
    throw new Error("incomplete supported package evidence");
  }
  return {image: manifest.image, architecture: manifest.architecture, distribution: "debian:13",
    checkedAt: new Date().toISOString(), verifiedBy: "apt-secure", signedIndexes, packages};
}

export function unavailableFixIsProven(
  requirement: PackageAvailabilityRequirement,
  manifest: RuntimeImageEvidenceManifestV1,
  evidence: SupportedPackageAvailability | undefined,
  evaluatedAt: string,
): boolean {
  const gap = requirement.unavailableFix;
  if (!evidence || evidence.verifiedBy !== "apt-secure" || evidence.checkedAt !== evaluatedAt ||
      gap.architecture !== manifest.architecture || evidence.architecture !== manifest.architecture ||
      gap.distribution !== evidence.distribution || evidence.image.reference !== manifest.image.reference ||
      evidence.image.digest !== manifest.image.digest ||
      Object.keys(evidence.signedIndexes).sort().join(",") !== "trixie,trixie-security,trixie-updates" ||
      Object.values(evidence.signedIndexes).some(h => !/^[a-f0-9]{64}$/.test(h))) return false;
  const matches = evidence.packages.filter(p => p.packageName === requirement.packageName && p.fixedVersion === gap.fixedVersion);
  return matches.length === 1 && matches[0]!.installedVersion === requirement.installedVersion &&
    matches[0]!.availableVersion === gap.availableVersion && matches[0]!.fixAvailable === false;
}
