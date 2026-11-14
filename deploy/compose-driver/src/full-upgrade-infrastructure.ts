import type { AuthContract } from "../../contracts/auth.ts";
import { DEPENDENCY_PINS } from "../../dependency-pins.ts";
import { mergeManagedRemoteEnv } from "./remote-auth-runtime.ts";

/** Full upgrades use this CLI's packaged topology, not a newer unrelated image. */
export function assertFullUpgradeInfrastructureContract(contract: AuthContract): void {
  if (contract.logtoEngine.image !== DEPENDENCY_PINS.logto ||
    contract.logtoEngine.minimumVersion !== DEPENDENCY_PINS.packagedLogtoImageTag) {
    throw new Error(
      "Full upgrade refused: the incoming server requires a different authentication baseline. " +
        "Use a signed CLI matching that server release; use restore for a retained rollback bundle.",
    );
  }
}

/** Update public image inputs only; preserve credentials, ports and other operator settings. */
export function refreshFullUpgradeInfrastructureEnv(current: string): string {
  const selected = {
    LOGTO_IMAGE: DEPENDENCY_PINS.logto,
    LOGTO_IMAGE_TAG: DEPENDENCY_PINS.packagedLogtoImageTag,
    POSTGRES_IMAGE: DEPENDENCY_PINS.postgres,
    PGVECTOR_IMAGE: DEPENDENCY_PINS.pgvectorPg17,
  };
  const reconciled = Object.entries(selected).map(([key, value]) => `${key}=${value}`).join("\n") + "\n";
  return mergeManagedRemoteEnv(current, reconciled, Object.keys(selected));
}

function repository(reference: string): string {
  return reference.split("@", 1)[0]!.replace(/:[^/:]+$/, "");
}

/** A configured incoming pin is not evidence of the image currently holding the data. */
export function resolveRecoveryImageReference(
  actualReference: string,
  configuredReference: string,
  repoDigests: unknown,
): string {
  if (!Array.isArray(repoDigests) || repoDigests.some((value) => typeof value !== "string")) {
    throw new Error("backup: missing actual infrastructure image digests");
  }
  const digests = [...new Set(repoDigests as string[])];
  if (digests.some((value) => !/^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/.test(value))) {
    throw new Error("backup: malformed actual infrastructure image digest");
  }
  if (digests.includes(actualReference)) return actualReference;
  for (const ref of [actualReference, configuredReference]) {
    const matches = digests.filter((value) => value.startsWith(`${repository(ref)}@sha256:`));
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) throw new Error("backup: ambiguous actual infrastructure repository digest");
  }
  throw new Error("backup: missing exact actual infrastructure repository digest");
}

export function recoveryLogtoVersion(actualImageVersion: string): string {
  const version = actualImageVersion.trim();
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error("backup: actual authentication image version is missing or invalid");
  }
  return version;
}
