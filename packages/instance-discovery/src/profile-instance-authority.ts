import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { isCanonicalNautiloInstanceId } from "@nautilo/config";
import { parse } from "smol-toml";

export type ProfileTransport = "local" | "remote";

export type ProfileInstanceClaim = {
  profileName: string;
  instanceId: string;
  transport: ProfileTransport | "unknown";
  retention: "durable" | "disposable" | "unknown";
  reason?: string;
};

export type ProfileInstanceAuthority = {
  claimsByInstanceId: ReadonlyMap<string, readonly ProfileInstanceClaim[]>;
  /** A profile that could not be tied safely to one instance makes every unclaimed ID ambiguous. */
  unattributedErrors: readonly string[];
};

/**
 * Read the authority-relevant subset of every persisted CLI profile once.
 *
 * This deliberately does not import the CLI schema: cleanup only needs the
 * persisted instance ID and transport, and must never resolve or probe a
 * profile endpoint. Invalid relevant fields are retained as unknown claims.
 */
export function readProfileInstanceAuthority(userHomeDir: string): ProfileInstanceAuthority {
  const profilesDir = join(userHomeDir, ".nautilo", "profiles");
  const claims = new Map<string, ProfileInstanceClaim[]>();
  const unattributedErrors: string[] = [];
  if (!existsSync(profilesDir)) {
    return { claimsByInstanceId: claims, unattributedErrors };
  }
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch (error) {
    unattributedErrors.push(
      `profiles directory could not be read: ${error instanceof Error ? error.message : String(error)}`,
    );
    return { claimsByInstanceId: claims, unattributedErrors };
  }

  const add = (claim: ProfileInstanceClaim) => {
    const existing = claims.get(claim.instanceId) ?? [];
    existing.push(claim);
    claims.set(claim.instanceId, existing);
  };

  for (const entry of entries) {
    if (!entry.name.endsWith(".toml")) continue;
    const filenameName = entry.name.slice(0, -".toml".length);
    let raw: Record<string, unknown>;
    try {
      const parsed = parse(readFileSync(join(profilesDir, entry.name), "utf8"));
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("profile root is not a table");
      }
      raw = parsed as Record<string, unknown>;
    } catch (error) {
      unattributedErrors.push(
        `profile ${filenameName} is malformed: ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }

    const rawInstanceId = raw["instance_id"];
    const instanceId = rawInstanceId === undefined ? "" : rawInstanceId;
    if (!isCanonicalNautiloInstanceId(instanceId)) {
      unattributedErrors.push(`profile ${filenameName} has an invalid instance_id`);
      continue;
    }

    const transport = raw["transport"];
    const lifecycle = raw["lifecycle"];
    if (
      (transport !== "local" && transport !== "remote") ||
      (lifecycle !== "compose" && lifecycle !== "external") ||
      (transport === "local" && lifecycle === "external" && rawInstanceId !== undefined)
    ) {
      add({
        profileName: filenameName,
        instanceId,
        transport: "unknown",
        retention: "unknown",
        reason: `profile ${filenameName} has invalid or insufficient transport/lifecycle metadata`,
      });
      continue;
    }

    const retention = raw["retention"];
    if (transport === "local" && lifecycle === "compose") {
      if (retention !== undefined && retention !== "durable" && retention !== "disposable") {
        add({ profileName: filenameName, instanceId, transport: "unknown", retention: "unknown", reason: `profile ${filenameName} has invalid retention metadata` });
        continue;
      }
      add({
        profileName: filenameName,
        instanceId,
        transport,
        // Local profiles created before retention existed are durable by
        // default. Cleanup must lose authority before it can lose user data.
        retention: retention ?? "durable",
      });
      continue;
    }
    if (retention !== undefined) {
      add({ profileName: filenameName, instanceId, transport: "unknown", retention: "unknown", reason: `profile ${filenameName} sets retention outside a local Compose lifecycle` });
      continue;
    }
    add({ profileName: filenameName, instanceId, transport, retention: "unknown" });
  }

  return { claimsByInstanceId: claims, unattributedErrors };
}

export type InstanceAuthorityClassification = "local" | "remote" | "unknown";

export type InstanceAuthorityDecision = {
  classification: InstanceAuthorityClassification;
  reason: string;
  retention: "durable" | "disposable" | "unknown";
};

/** Resolve profile authority only. Local filesystem evidence is applied by the caller. */
export function classifyProfileAuthority(
  instanceId: string,
  authority: ProfileInstanceAuthority,
): InstanceAuthorityDecision | null {
  const claims = authority.claimsByInstanceId.get(instanceId) ?? [];
  const unknown = claims.find((claim) => claim.transport === "unknown");
  if (unknown) {
    return { classification: "unknown", retention: "unknown", reason: unknown.reason ?? "profile metadata is invalid" };
  }

  const transports = new Set(claims.map((claim) => claim.transport));
  if (transports.size > 1) {
    const names = claims.map((claim) => claim.profileName).sort().join(", ");
    return {
      classification: "unknown",
      retention: "unknown",
      reason: `conflicting local and remote profiles claim this instance ID (${names})`,
    };
  }

  const claim = claims[0];
  if (claim?.transport === "remote") {
    const names = claims.map((item) => item.profileName).sort().join(", ");
    return {
      classification: "remote",
      retention: "unknown",
      reason: `remote profile${claims.length === 1 ? "" : "s"} ${names} own${claims.length === 1 ? "s" : ""} this local projection`,
    };
  }
  if (claim?.transport === "local") {
    const retentions = new Set(claims.map((item) => item.retention));
    if (retentions.size !== 1 || claim.retention === "unknown") {
      const names = claims.map((item) => item.profileName).sort().join(", ");
      return { classification: "unknown", retention: "unknown", reason: `local profiles disagree about durable retention (${names})` };
    }
    const names = claims.map((item) => item.profileName).sort().join(", ");
    return {
      classification: "local",
      retention: claim.retention,
      reason: `local profile${claims.length === 1 ? "" : "s"} ${names} own${claims.length === 1 ? "s" : ""} this instance`,
    };
  }

  if (authority.unattributedErrors.length > 0) {
    return {
      classification: "unknown",
      retention: "unknown",
      reason: `profile metadata is incomplete: ${authority.unattributedErrors.join("; ")}`,
    };
  }
  return null;
}
