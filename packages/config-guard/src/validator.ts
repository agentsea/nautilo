import { getKeyByEnvVar } from "./key-registry";
import {
  classifyForbiddenInInstanceEnv,
  getModeByEnvVar,
  LOGTO_REQUIRED_KEYS,
  type ModeDefinition,
} from "./mode-registry";
import type { ConfigOperation } from "./types";

export interface ValidatedOperation {
  operation: ConfigOperation;
  skip: boolean;
  skipReason?: string | undefined;
}

/**
 * Per-op validation: each operation is checked against `KEY_REGISTRY` first
 * (existing path) and falls through to `MODE_REGISTRY` (M051). Unknown env
 * vars in either registry are rejected. Cross-key invariants (every
 * `LOGTO_*` must be set in the merged env) run separately via
 * `crossKeyInvariants` so they can reason about the post-merge env, not
 * just the operations being submitted.
 */
export function validateOperations(
  operations: ConfigOperation[],
  options: { overwrite: boolean; existingEnv: NodeJS.ProcessEnv },
): { apply: ValidatedOperation[]; errors: string[] } {
  const errors: string[] = [];
  const apply: ValidatedOperation[] = [];

  for (const op of operations) {
    // Cleanup/migration must always be able to remove a forbidden legacy key.
    // Only writes are rejected by the persisted-config boundary.
    if (op.type === "remove") {
      apply.push({ operation: op, skip: false });
      continue;
    }
    const forbidden = classifyForbiddenInInstanceEnv(op.key);
    if (forbidden) {
      errors.push(
        `${op.key}: forbidden in instance.env (${forbidden.category}); ${forbidden.remediation}`,
      );
      continue;
    }

    const keyDef = getKeyByEnvVar(op.key);
    const modeDef = keyDef ? undefined : getModeByEnvVar(op.key);

    if (!keyDef && !modeDef) {
      errors.push(`Unknown or disallowed environment variable: ${op.key}`);
      continue;
    }

    const value = op.value?.trim() ?? "";
    if (value === "") {
      errors.push(`${op.key}: value is required for set`);
      continue;
    }

    if (!options.overwrite && options.existingEnv[op.key]) {
      apply.push({
        operation: op,
        skip: true,
        skipReason: "Key already present and overwrite is false",
      });
      continue;
    }

    if (keyDef) {
      if (!keyDef.formatCheck(value)) {
        errors.push(`${op.key}: invalid format (expected ${keyDef.formatHint})`);
        continue;
      }
    } else if (modeDef) {
      const err = modeDef.validator(value);
      if (err !== null) {
        errors.push(`${op.key}: ${err}`);
        continue;
      }
    }

    apply.push({ operation: { type: "set", key: op.key, value }, skip: false });
  }

  // Cross-key invariants run against the post-merge env (existing ∪ ops).
  // Skipped operations still contribute (they're already in existingEnv);
  // failed operations must NOT contribute or we'd assert against a state
  // we never wrote.
  if (errors.length === 0) {
    const merged = mergedEnvAfterApply(apply, options.existingEnv);
    errors.push(...crossKeyInvariants(merged));
  }

  return { apply, errors };
}

/**
 * Strict version: every LOGTO_* OIDC key must be set in the merged env, period.
 * Used by operator-facing readiness checks (`verify-config-env`) where the
 * question is "is the post-bootstrap server ready to talk to Logto?". Always
 * fires the invariant regardless of how many keys are currently set.
 */
export function assertLogtoConfigComplete(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const errors: string[] = [];
  const missing = LOGTO_REQUIRED_KEYS.filter(
    (k) => !env[k] || env[k]?.trim() === "",
  );
  if (missing.length > 0) {
    errors.push(
      `Logto configuration requires every LOGTO_* key to be set; missing: ${missing.join(", ")}`,
    );
  }
  return errors;
}

/**
 * M072 + M116: cross-key transaction guard. Every LOGTO_* OIDC key in the
 * merged env must be set — once Logto configuration has begun.
 *
 * **M116 carve-out**: if ZERO LOGTO_* OIDC keys are *defined* in the merged env
 * (key absent, not just empty), the invariant does not fire. This handles the
 * pre-Logto-bootstrap window on a fresh deploy, where M116 needs to persist
 * DB passwords to `instance.env` before Postgres/Logto containers come up.
 * `bootstrap-logto.ts` writes all OIDC keys atomically in a single transaction
 * (`buildLogtoEnvOperations`), so any partial-Logto state is contained within
 * that transaction's atomic window.
 *
 * Membership-not-value gating keeps the whitespace-as-missing guard intact
 * for post-bootstrap states where a key might be accidentally set to "   ".
 *
 * For the operator-facing "is my config complete" check, use
 * `assertLogtoConfigComplete` instead — it always fires.
 *
 * Pure function over an env snapshot — easy to unit-test in isolation.
 */
export function crossKeyInvariants(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const anyDefined = LOGTO_REQUIRED_KEYS.some((k) => k in env);
  if (!anyDefined) {
    return [];
  }
  return assertLogtoConfigComplete(env);
}

/**
 * Project the operations onto the existing env to produce the post-apply
 * snapshot used by `crossKeyInvariants`. Skipped ops carry through from
 * `existingEnv` already; only the non-skip applies need merging.
 *
 * Pure; tested transitively via `validateOperations`'s cross-key tests.
 */
function mergedEnvAfterApply(
  apply: readonly ValidatedOperation[],
  existingEnv: Readonly<NodeJS.ProcessEnv>,
): Record<string, string | undefined> {
  const merged: Record<string, string | undefined> = { ...existingEnv };
  for (const row of apply) {
    if (row.skip) continue;
    const op = row.operation;
    if (op.type === "set") {
      merged[op.key] = op.value;
    } else if (op.type === "remove") {
      delete merged[op.key];
    }
  }
  return merged;
}

// Re-export for internal callers needing to introspect a single mode entry.
export type { ModeDefinition };
