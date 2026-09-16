import { transaction } from "@nautilo/config-guard";
import type { TransactionActor } from "@nautilo/config-guard";

export type ApplyProviderEnvWritesResult = {
  applied: string[];
  rejected: Array<{ key: string; error: string }>;
};

/**
 * Append/replace provider registry keys in the resolved instance `config.env`
 * via config-guard (atomic temp + rename).
 *
 * Strategy: one transaction per key so a single bad key (stale token, format
 * mismatch, dead provider endpoint) only invalidates that one entry. Setup
 * keeps going with the keys that did apply, returning a structured result so
 * the caller can decide whether to warn or hard-fail. Pre-D112 this was a
 * single multi-op transaction that rolled back everything on first failure
 * and aborted setup before Genie defaults could land — see commit log.
 */
export async function applyProviderEnvWrites(args: {
  operations: Array<{ key: string; value: string }>;
  actor?: TransactionActor | undefined;
  reason?: string | undefined;
  overwrite?: boolean | undefined;
}): Promise<ApplyProviderEnvWritesResult> {
  const applied: string[] = [];
  const rejected: Array<{ key: string; error: string }> = [];
  for (const op of args.operations) {
    const result = await transaction({
      operations: [{ type: "set" as const, key: op.key, value: op.value }],
      healthCheck: "keys",
      overwrite: args.overwrite ?? true,
      reason: args.reason ?? "nautilo setup — provider keys from setup template",
      actor: args.actor ?? "cli",
    });
    if (result.success) {
      applied.push(op.key);
    } else {
      rejected.push({ key: op.key, error: result.error ?? "config-guard transaction failed" });
    }
  }
  return { applied, rejected };
}
