import { existsSync, readFileSync } from "node:fs";

import {
  classifyForbiddenInInstanceEnv,
  getValueFromEntries,
  parseEnvFile,
  resolveDotenvPath,
  transaction,
} from "@nautilo/config-guard";

import type { ResolvedDeployConfig } from "./deploy-loader.ts";

/**
 * Pure plan describing the admin-redemption work the future
 * `nautilo deploy` verb (M092) will perform. Phase 3 produces this
 * plan but does NOT execute it; the verb will route it through
 * `redeem-claim` + `change-password` + PIN enroll.
 */
export interface AdminRedemptionPlan {
  handle: string;
  displayName: string;
  password: string;
  pin?: string;
}

export function planAdminRedemption(resolved: ResolvedDeployConfig): AdminRedemptionPlan {
  const plan: AdminRedemptionPlan = {
    handle: resolved.admin.handle,
    displayName: resolved.admin.displayName,
    password: resolved.admin.password.value,
  };
  if (resolved.admin.pin !== undefined) {
    plan.pin = resolved.admin.pin.value;
  }
  return plan;
}

/**
 * Result row per provider key write attempt — caller sees what
 * actually changed vs what was already in instance.env.
 */
export interface ProviderWriteOutcome {
  key: string;
  status: "written" | "unchanged" | "skipped-empty";
}

export interface ConsumeProvidersOptions {
  /** Override for tests; defaults to `resolveDotenvPath()` from config-guard. */
  dotenvPath?: string;
  /** Override for tests; defaults to a no-op note. */
  audit?: (entry: { key: string; status: ProviderWriteOutcome["status"] }) => void;
}

function assertProvidersNotForbidden(keys: readonly string[]): void {
  for (const key of keys) {
    const forbidden = classifyForbiddenInInstanceEnv(key);
    if (forbidden) {
      throw new Error(
        `provider key '${key}' is forbidden in instance.env (${forbidden.category}); ${forbidden.remediation}`,
      );
    }
  }
}

function readEnvKeyFromDisk(envPath: string, key: string): string | undefined {
  const raw = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
  const v = getValueFromEntries(parseEnvFile(raw), key);
  const t = v?.trim();
  return t === "" || t === undefined ? undefined : t;
}

async function withDotenvPathOverride<T>(
  dotenvPath: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (dotenvPath === undefined) {
    return fn();
  }
  const prev = process.env["NAUTILO_DOTENV_PATH"];
  process.env["NAUTILO_DOTENV_PATH"] = dotenvPath;
  try {
    return await fn();
  } finally {
    if (prev === undefined) {
      delete process.env["NAUTILO_DOTENV_PATH"];
    } else {
      process.env["NAUTILO_DOTENV_PATH"] = prev;
    }
  }
}

/**
 * Writes every `[providers]` row from a resolved deploy.toml into
 * the instance dotenv via `config-guard.transaction()`. Idempotent —
 * running twice with the same input is a no-op except for the audit
 * trail. Returns one outcome per provider key in input order.
 *
 * Refuses keys classified by `classifyForbiddenInInstanceEnv` (M091)
 * before any write; unknown keys are still rejected by config-guard.
 */
export async function consumeDeployConfigProviders(
  resolved: ResolvedDeployConfig,
  options?: ConsumeProvidersOptions,
): Promise<ProviderWriteOutcome[]> {
  const audit = options?.audit ?? (() => {});

  return withDotenvPathOverride(options?.dotenvPath, async () => {
    const envPath = resolveDotenvPath();
    const keys = resolved.providers.map((p) => p.key);
    assertProvidersNotForbidden(keys);

    type Slot =
      | { kind: "done"; outcome: ProviderWriteOutcome }
      | { kind: "write"; key: string; value: string };

    const slots: Slot[] = [];

    for (const row of resolved.providers) {
      const value = row.value.value.trim();
      if (value === "") {
        slots.push({
          kind: "done",
          outcome: { key: row.key, status: "skipped-empty" },
        });
        continue;
      }

      const onDisk = readEnvKeyFromDisk(envPath, row.key);
      if (onDisk === value) {
        slots.push({
          kind: "done",
          outcome: { key: row.key, status: "unchanged" },
        });
        continue;
      }

      slots.push({ kind: "write", key: row.key, value });
    }

    const writeBatch = slots
      .filter((s): s is Extract<Slot, { kind: "write" }> => s.kind === "write")
      .map((s) => ({ key: s.key, value: s.value }));

    if (writeBatch.length > 0) {
      const result = await transaction({
        operations: writeBatch.map((q) => ({
          type: "set" as const,
          key: q.key,
          value: q.value,
        })),
        healthCheck: "none",
        overwrite: true,
        reason: "consume deploy.toml providers",
        actor: "cli",
      });
      if (!result.success) {
        throw new Error(
          result.error ?? "config-guard transaction rejected while writing provider keys",
        );
      }
    }

    const outcomes: ProviderWriteOutcome[] = [];
    for (const slot of slots) {
      if (slot.kind === "done") {
        outcomes.push(slot.outcome);
        audit({ key: slot.outcome.key, status: slot.outcome.status });
      } else {
        const o: ProviderWriteOutcome = { key: slot.key, status: "written" };
        outcomes.push(o);
        audit({ key: slot.key, status: o.status });
      }
    }

    return outcomes;
  });
}
