import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { transaction } from "@nautilo/config-guard";

/**
 * M120 — the shared secret between Logto's `http-email` connector
 * (`Authorization: Bearer <secret>`) and Nautilo's webhook receiver
 * (`NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET`). Generated once per instance and
 * persisted to `instance.env`, mirroring `ensureDbPasswords`: read-or-generate
 * so re-deploys reuse the same secret (the connector config and the server
 * env must agree).
 */
export const WEBHOOK_SECRET_KEY = "NAUTILO_LOGTO_HTTP_EMAIL_WEBHOOK_SECRET";

export interface EnsureWebhookSecretDeps {
  /** Reads `~/.nautilo${suffix}/instance.env` (returns "" if missing). */
  readInstanceEnv: (instanceRootDir: string) => Promise<string>;
  /** Persists the secret via config-guard.transaction(). */
  writeSecretToInstanceEnv: (secret: string) => Promise<void>;
  /** Random secret generator. Default uses crypto.randomBytes(24) → 48 hex chars. */
  randomSecret: () => string;
}

export interface EnsureWebhookSecretArgs {
  /** Operator-laptop `~/.nautilo${suffix}` — not the remote droplet root. */
  instanceRootDir: string;
}

function parseDotenvValue(raw: string, key: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    if (t.slice(0, eq).trim() !== key) continue;
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim().length > 0 ? value : undefined;
  }
  return undefined;
}

export async function ensureForgotPasswordWebhookSecret(
  args: EnsureWebhookSecretArgs,
  deps: EnsureWebhookSecretDeps,
): Promise<string> {
  const raw = await deps.readInstanceEnv(args.instanceRootDir);
  const existing = parseDotenvValue(raw, WEBHOOK_SECRET_KEY);
  if (existing !== undefined) {
    return existing;
  }
  const secret = deps.randomSecret();
  await deps.writeSecretToInstanceEnv(secret);
  return secret;
}

export function defaultEnsureWebhookSecretDeps(): EnsureWebhookSecretDeps {
  return {
    readInstanceEnv: async (instanceRootDir) => {
      try {
        return await readFile(join(instanceRootDir, "instance.env"), "utf8");
      } catch {
        return "";
      }
    },
    writeSecretToInstanceEnv: async (secret) => {
      const result = await transaction({
        actor: "cli",
        reason: "M120: Logto http-email webhook relay secret",
        healthCheck: "none",
        overwrite: true,
        operations: [{ type: "set", key: WEBHOOK_SECRET_KEY, value: secret }],
      });
      if (!result.success) {
        throw new Error(
          `ensureForgotPasswordWebhookSecret: failed to persist secret: ${result.error ?? "unknown error"}`,
        );
      }
    },
    randomSecret: () => randomBytes(24).toString("hex"),
  };
}
