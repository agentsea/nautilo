import { existsSync, readFileSync } from "node:fs";
import { getValueFromEntries, parseEnvFile } from "@nautilo/config-guard";

function nonemptySecret(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

/** Never borrow a configured credential from another application or instance. */
export function readConfiguredM2mSecret(envPath: string, applicationId: string): string | undefined {
  if (!existsSync(envPath)) return undefined;
  const entries = parseEnvFile(readFileSync(envPath, "utf8"));
  if (getValueFromEntries(entries, "LOGTO_M2M_APP_ID") !== applicationId) return undefined;
  const secret = getValueFromEntries(entries, "LOGTO_M2M_APP_SECRET");
  return nonemptySecret(secret) ? secret : undefined;
}

/** Read existing credentials only; secret creation and rotation are not recovery. */
export async function readLogtoApplicationSecret(input: {
  applicationId: string;
  legacySecret?: string | undefined;
  preferredSecret?: string | undefined;
  readSecrets: () => Promise<unknown>;
  /** Prove an existing, unlisted configured credential without replacing it. */
  verifyPreferredSecret?: (secret: string) => Promise<boolean>;
  now?: number;
}): Promise<string> {
  const failure = () => new Error("An existing active managed application secret could not be selected safely");
  if (nonemptySecret(input.legacySecret)
    && (input.preferredSecret === undefined || input.preferredSecret === input.legacySecret)) {
    return input.legacySecret;
  }
  let response: unknown;
  try { response = await input.readSecrets(); } catch { throw failure(); }
  if (!Array.isArray(response)) throw failure();
  const active = new Set<string>();
  const expired = new Set<string>();
  const now = input.now ?? Date.now();
  for (const candidate of response as unknown[]) {
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) throw failure();
    const row = candidate as Record<string, unknown>;
    if (row["applicationId"] !== input.applicationId
      || typeof row["name"] !== "string" || !row["name"] || !nonemptySecret(row["value"])
      || !(row["expiresAt"] === null || (typeof row["expiresAt"] === "number" && Number.isFinite(row["expiresAt"])))) {
      throw failure();
    }
    if (row["expiresAt"] === null || row["expiresAt"] > now) active.add(row["value"]);
    else expired.add(row["value"]);
  }
  if (input.preferredSecret !== undefined) {
    if (!nonemptySecret(input.preferredSecret)) throw failure();
    if (active.has(input.preferredSecret)) return input.preferredSecret;
    // Some supported Logto releases omit a still-valid legacy credential from
    // both read APIs. A token grant proves it is active without choosing the
    // different modern credential, rotating keys or trusting configuration alone.
    if (expired.has(input.preferredSecret) || input.verifyPreferredSecret === undefined) throw failure();
    try {
      if (await input.verifyPreferredSecret(input.preferredSecret)) return input.preferredSecret;
    } catch { /* Refuse without exposing credentials or provider response bodies. */ }
    throw failure();
  }
  if (active.size !== 1) throw failure();
  return active.values().next().value!;
}
