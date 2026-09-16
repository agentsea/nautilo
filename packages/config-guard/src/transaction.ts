import { accessSync, constants, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isCloudMode } from "@nautilo/config";
import { isCloudManagedDeployment, isCloudManagedProviderKey } from "./managed-provider-keys";
import { error as logError, warn as logWarn } from "@nautilo/logger";
import { appendAuditEntry } from "./audit-log";
import { getAllKeyDefinitions, getKeyByEnvVar } from "./key-registry";
import {
  parseEnvFile,
  serializeEnvFile,
  setValueInEntries,
  removeKeyFromEntries,
} from "./env-parser";
import {
  reloadEnvAndStripRemovedRegistryKeys,
  reloadEnvOverlay,
  writeFileAtomic,
} from "./env-writer";
import { checkKeysHealth, checkServerHealth } from "./health-checker";
import {
  resolveAuditLogPath,
  resolveDotenvPath,
  resolveHealthCheckUrl,
  resolveSnapshotDir,
} from "./paths";
import {
  createSnapshot,
  readSnapshotEnv,
  snapshotOperationsSummary,
  updateSnapshotMeta,
} from "./snapshot-store";
import { parseTransactionInput } from "./schemas";
import { validateOperations } from "./validator";
import type { TransactionDetail, TransactionInput, TransactionResult } from "./types";
import { ConfigGuardError } from "./types";

const rateLimitTimes: number[] = [];

function takeRateSlot(): void {
  const now = Date.now();
  const windowMs = 60_000;
  while (rateLimitTimes.length > 0 && rateLimitTimes[0]! < now - windowMs) {
    rateLimitTimes.shift();
  }
  if (rateLimitTimes.length >= 10) {
    logWarn(
      "[config-guard] rate limit: rejecting transaction (max 10 per 60s rolling window)",
    );
    throw new ConfigGuardError(
      "RATE_LIMIT",
      "Too many config transactions; wait up to 1 minute.",
    );
  }
  rateLimitTimes.push(now);
}

let lockChain: Promise<void> = Promise.resolve();

function enqueueLocked<T>(fn: () => Promise<T>): Promise<T> {
  const run = lockChain.then(() => fn());
  lockChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function readEnvFileOrEmpty(envPath: string): Promise<string> {
  try {
    return await readFile(envPath, "utf-8");
  } catch {
    return "";
  }
}

function rejectCloudProviderOperation(input: TransactionInput): string | null {
  const providerKeys = new Set(getAllKeyDefinitions().map((definition) => definition.envVar));
  for (const operation of input.operations) {
    if (operation.type !== "set" || !providerKeys.has(operation.key)) {
      return (
        "Cloud Admin may only add or change registered provider credentials. " +
        `Rejected ${operation.type} ${operation.key}; platform, identity, and mode ` +
        "configuration remains owned by the deployment controller."
      );
    }
  }
  return null;
}

/** Create the empty override authority without copying platform credentials. */
async function ensureCloudProviderAuthority(envPath: string): Promise<void> {
  if (!existsSync(envPath)) await writeFileAtomic(envPath, "");
}

/**
 * D445 Phase 0 — fail closed before mutation when an explicit canonical
 * config target is unavailable.
 *
 * The split-brain: compose injects the host `instance.env` into `process.env`
 * via Docker `env_file` (read once at container creation), but inside the
 * container `resolveDotenvPath()` resolves a SEPARATE container-local file
 * when `NAUTILO_DOTENV_PATH` is unset. A mutation (e.g. Google OAuth set)
 * then reads that missing/empty file, writes only the one new key, and
 * `reloadEnvAndStripRemovedRegistryKeys()` strips every other registered
 * key from `process.env` — losing every compose-injected provider key
 * without touching disk authority.
 *
 * The deployed/container contract is: an explicit `NAUTILO_DOTENV_PATH`
 * pointing at a writable mounted file shared with compose. When that env
 * is set, the target MUST exist and be writable; a missing/unwritable
 * target is a mount/authority problem, NOT an empty authority. Refuse to
 * mutate so `process.env` is left unchanged.
 *
 * Local intentional initialization (no `NAUTILO_DOTENV_PATH`) is preserved:
 * `resolveDotenvPath()` creates `~/.nautilo/instance.env` as before.
 */
function canonicalTargetAvailable(envPath: string): { ok: true } | { ok: false; reason: string } {
  const explicit = process.env["NAUTILO_DOTENV_PATH"]?.trim();
  if (!explicit) {
    return { ok: true };
  }
  if (!existsSync(envPath)) {
    return {
      ok: false,
      reason:
        `Canonical config target is missing at NAUTILO_DOTENV_PATH=${envPath}. ` +
        `Refusing to mutate process.env from an empty fallback (would strip every ` +
        `compose-injected provider key). Mount the dedicated runtime-config ` +
        `directory and ensure instance.env exists before writing.`,
    };
  }
  try {
    accessSync(envPath, constants.W_OK);
  } catch {
    return {
      ok: false,
      reason:
        `Canonical config file is not writable: ${envPath} (NAUTILO_DOTENV_PATH). ` +
        `Atomic temp-write + rename requires a writable target. No process.env ` +
        `mutation was performed.`,
    };
  }
  try {
    accessSync(dirname(envPath), constants.W_OK);
  } catch {
    return {
      ok: false,
      reason:
        `Canonical config directory is not writable: ${dirname(envPath)} ` +
        `(NAUTILO_DOTENV_PATH=${envPath}). Atomic temp-write + rename requires a ` +
        `writable directory mount. No process.env mutation was performed.`,
    };
  }
  return { ok: true };
}

async function runHealthAfterApply(
  input: TransactionInput,
  appliedKeys: string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ ok: boolean; detail?: string }> {
  if (input.healthCheck === "none") {
    return { ok: true };
  }
  if (input.healthCheck === "server") {
    const r = await checkServerHealth(resolveHealthCheckUrl());
    return r.ok ? { ok: true } : { ok: false, detail: r.detail ?? "server health check failed" };
  }
  const ids = new Set<string>();
  for (const k of appliedKeys) {
    const def = getKeyByEnvVar(k);
    if (def) {
      ids.add(def.id);
    }
  }
  const results = await checkKeysHealth(env, [...ids]);
  for (const id of ids) {
    const r = results[id];
    if (!r) {
      continue;
    }
    if (r.status !== "verified") {
      return { ok: false, detail: `${id}: ${r.status}${r.detail ? ` (${r.detail})` : ""}` };
    }
  }
  return { ok: true };
}

async function runTransaction(input: TransactionInput): Promise<TransactionResult> {
  const cloudProviderOverlay = isCloudMode();
  const envPath = resolveDotenvPath();
  const snapshotDir = resolveSnapshotDir();
  const auditPath = resolveAuditLogPath();
  const details: TransactionDetail[] = [];
  const overwrite = input.overwrite ?? false;
  const before = await readEnvFileOrEmpty(envPath);
  // Keep this parsed dotenv overlay independent of ambient ProcessEnv
  // augmentations (for example Expo requiring NODE_ENV in mobile builds).
  const canonicalEnv: Record<string, string> = {};
  for (const entry of parseEnvFile(before)) {
    if (entry.type === "pair") canonicalEnv[entry.key] = entry.value;
  }

  const { apply, errors } = validateOperations(input.operations, {
    overwrite,
    // instance.env is the transaction's canonical authority. Ambient values
    // still fill keys absent on disk, but a partially prepared orchestrator
    // environment must not make a complete canonical Logto block look
    // incomplete and reject an unrelated safe write.
    existingEnv: { ...process.env, ...canonicalEnv },
  });

  for (const row of apply) {
    if (row.skip) {
      details.push({
        key: row.operation.key,
        action: "skipped",
        reason: row.skipReason,
      });
    }
  }

  if (errors.length > 0) {
    await appendAuditEntry(auditPath, {
      ts: new Date().toISOString(),
      actor: input.actor,
      reason: input.reason,
      ops: input.operations.map((o) => ({ type: o.type, key: o.key })),
      result: "rejected",
      error: errors.join("; "),
    });
    return {
      success: false,
      snapshot: null,
      applied: 0,
      skipped: apply.filter((a) => a.skip).length,
      rolledBack: false,
      error: errors.join("; "),
      details,
    };
  }

  const toApply = apply.filter((a) => !a.skip);
  const skipped = apply.filter((a) => a.skip).length;

  if (toApply.length === 0) {
    return {
      success: true,
      snapshot: null,
      applied: 0,
      skipped,
      rolledBack: false,
      error: null,
      details,
    };
  }

  takeRateSlot();

  let entries = parseEnvFile(before);
  const appliedKeys: string[] = [];

  for (const row of toApply) {
    const op = row.operation;
    if (op.type === "set" && op.value !== undefined) {
      entries = setValueInEntries(entries, op.key, op.value);
      appliedKeys.push(op.key);
    } else if (op.type === "remove") {
      entries = removeKeyFromEntries(entries, op.key);
      appliedKeys.push(op.key);
    }
  }
  const nextContent = serializeEnvFile(entries);

  // Cloud provider overrides are validated before the atomic publication, so
  // rollback never needs to retain the previous plaintext credential.
  if (cloudProviderOverlay) {
    const nextEnv: NodeJS.ProcessEnv = { ...process.env };
    for (const entry of entries) {
      if (entry.type === "pair") nextEnv[entry.key] = entry.value;
    }
    const health = await runHealthAfterApply(input, appliedKeys, nextEnv);
    if (!health.ok) {
      await appendAuditEntry(auditPath, {
        ts: new Date().toISOString(),
        actor: input.actor,
        reason: input.reason,
        ops: input.operations.map((operation) => ({
          type: operation.type,
          key: operation.key,
        })),
        result: "rejected",
        error: health.detail ?? "Provider validation failed",
      });
      return {
        success: false,
        snapshot: null,
        applied: 0,
        skipped,
        rolledBack: false,
        error: health.detail ?? "Provider validation failed",
        details: appliedKeys.map((key) => ({
          key,
          action: "failed" as const,
          reason: health.detail ?? "Provider validation failed",
        })),
      };
    }
  }

  let snapshotId: string;
  try {
    snapshotId = await createSnapshot(
      snapshotDir,
      // The cloud snapshot is a redacted operation journal. Local config keeps
      // its existing plaintext rollback snapshot contract.
      cloudProviderOverlay ? "" : before,
      snapshotOperationsSummary(
        input.actor,
        input.reason,
        toApply.map((t) => ({ type: t.operation.type, key: t.operation.key })),
      ),
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logError("[config-guard] snapshot failed:", msg);
    throw new ConfigGuardError("IO", `Snapshot failed: ${msg}`);
  }

  try {
    for (const key of appliedKeys) {
      details.push({ key, action: "applied" });
    }

    await writeFileAtomic(envPath, nextContent);
    if (cloudProviderOverlay) reloadEnvOverlay(envPath);
    else await reloadEnvAndStripRemovedRegistryKeys(envPath);

    const health = cloudProviderOverlay
      ? { ok: true as const }
      : await runHealthAfterApply(input, appliedKeys);
    if (!health.ok) {
      const prev = await readSnapshotEnv(snapshotDir, snapshotId);
      await writeFileAtomic(envPath, prev);
      await reloadEnvAndStripRemovedRegistryKeys(envPath);
      await updateSnapshotMeta(snapshotDir, snapshotId, {
        result: "rolled_back",
        error: health.detail,
      });
      await appendAuditEntry(auditPath, {
        ts: new Date().toISOString(),
        actor: input.actor,
        reason: input.reason,
        ops: input.operations.map((o) => ({ type: o.type, key: o.key })),
        result: "rolled_back",
        error: health.detail,
        snapshot: snapshotId,
      });
      return {
        success: false,
        snapshot: snapshotId,
        applied: appliedKeys.length,
        skipped,
        rolledBack: true,
        error: health.detail ?? "Health check failed",
        details,
      };
    }

    await updateSnapshotMeta(snapshotDir, snapshotId, { result: "applied" });
    await appendAuditEntry(auditPath, {
      ts: new Date().toISOString(),
      actor: input.actor,
      reason: input.reason,
      ops: input.operations.map((o) => ({ type: o.type, key: o.key })),
      result: "applied",
      snapshot: snapshotId,
    });

    return {
      success: true,
      snapshot: snapshotId,
      applied: appliedKeys.length,
      skipped,
      rolledBack: false,
      error: null,
      details,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (cloudProviderOverlay) {
      // Cloud snapshots deliberately contain no prior secrets. Atomic write
      // failures leave the old file intact; failures after rename are
      // reobservable through the masked key summary and safe to retry.
      logError("[config-guard] cloud provider transaction failed:", msg);
      if (e instanceof ConfigGuardError) throw e;
      throw new ConfigGuardError("IO", msg);
    }
    let rolledBackOk = false;
    try {
      const prev = await readSnapshotEnv(snapshotDir, snapshotId);
      await writeFileAtomic(envPath, prev);
      await reloadEnvAndStripRemovedRegistryKeys(envPath);
      await updateSnapshotMeta(snapshotDir, snapshotId, {
        result: "rolled_back",
        error: msg,
      });
      rolledBackOk = true;
    } catch {
      /* best effort */
    }
    if (rolledBackOk) {
      try {
        await appendAuditEntry(auditPath, {
          ts: new Date().toISOString(),
          actor: input.actor,
          reason: input.reason,
          ops: input.operations.map((o) => ({ type: o.type, key: o.key })),
          result: "rolled_back",
          error: msg,
          snapshot: snapshotId,
        });
      } catch (auditErr) {
        logError(
          "[config-guard] audit log append failed after IO rollback:",
          auditErr instanceof Error ? auditErr.message : String(auditErr),
        );
      }
      logError("[config-guard] transaction error after apply (env restored from snapshot):", msg);
    } else {
      logError("[config-guard] transaction error; env rollback did not complete:", msg);
    }
    if (e instanceof ConfigGuardError) {
      throw e;
    }
    throw new ConfigGuardError("IO", msg);
  }
}

export async function transaction(input: unknown): Promise<TransactionResult> {
  const parsed = parseTransactionInput(input);
  if (isCloudManagedDeployment() && parsed.operations.some((operation) => isCloudManagedProviderKey(operation.key))) {
    return {
      success: false,
      rolledBack: false,
      error: "Included provider credentials are managed by Mini-Cloud and cannot be changed on this instance.",
      snapshot: null,
      applied: 0,
      skipped: 0,
      details: [],
      rejectedReason: "managed_provider_key",
    };
  }
  if (isCloudMode() && parsed.operations.length > 0) {
    const rejection = rejectCloudProviderOperation(parsed);
    if (rejection !== null) {
      return {
        success: false,
        rolledBack: false,
        error: rejection,
        snapshot: null,
        applied: 0,
        skipped: 0,
        details: [],
        rejectedReason: "provider_keys_only_in_cloud",
      };
    }
    if (!process.env["NAUTILO_DOTENV_PATH"]?.trim()) {
      return {
        success: false,
        rolledBack: false,
        error:
          "Cloud provider-key custody is unavailable because NAUTILO_DOTENV_PATH is not configured.",
        snapshot: null,
        applied: 0,
        skipped: 0,
        details: [],
        rejectedReason: "read_only_in_cloud",
      };
    }
  }
  return enqueueLocked(async () => {
    if (parsed.operations.length > 0) {
      const envPath = resolveDotenvPath();
      if (isCloudMode()) {
        await ensureCloudProviderAuthority(envPath);
      }
      const guard = canonicalTargetAvailable(envPath);
      if (!guard.ok) {
        return {
          success: false,
          rolledBack: false,
          error: guard.reason,
          snapshot: null,
          applied: 0,
          skipped: 0,
          details: [],
        };
      }
    }
    return runTransaction(parsed);
  });
}

/** Clears the 10/min rate-limit window. For tests (config-guard + server packages). */
export function resetConfigGuardRateLimitForTests(): void {
  rateLimitTimes.length = 0;
}
