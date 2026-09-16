/**
 * M100 Phase 1 — `setup-instance` (bun run dev:setup): consume M091 deploy.toml,
 * claim when needed, write provider keys via config-guard, optional reload-env,
 * stamp deployConfigConsumedAt on instance.json.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { RedeemInput, RedeemResult, SetupStatusResponse } from "@nautilo/api-client";
import { NautiloApiClient } from "@nautilo/api-client";
import {
  markDeployConfigConsumed,
  readDeployConfigConsumedAt,
  resolveInstance,
  resolveNautiloRootDir,
} from "@nautilo/config";
import { isLoopbackHostname } from "@nautilo/config/loopback-origin";
import {
  getValueFromEntries,
  parseEnvFile,
  resolveDotenvPath,
} from "@nautilo/config-guard";
import { defaultOperatorSecretsPath, loadOperatorSecrets } from "@nautilo/operator-secrets";
import { loadConfigEnvIntoProcess } from "../lib/config-env";
import {
  type DeployConfig,
  type ResolvedDeployConfig,
  EnvVarMissingError,
  parseDeployConfigFromPath,
  planAdminRedemption,
  resolveDeployConfig,
  consumeDeployConfigProviders,
  type ProviderWriteOutcome,
} from "@nautilo/deploy-config";
import { parseClaimInviteFileContent } from "../lib/bootstrap-claim-invite.ts";
import { resolveAndEvaluateDefaultInstanceMutationGuard } from "../lib/default-instance-guard";

export type SetupInstanceStatus = SetupStatusResponse & {
  deployConfigConsumedAt: string | null;
};

function extractRedeemBearer(redeem: RedeemResult): string | null {
  const a = redeem.logtoSession?.accessToken?.trim();
  if (a && a.length > 0) return a;
  const s = redeem.sessionToken?.trim();
  if (s && s.length > 0) return s;
  return null;
}

function isLoopbackServerUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isLoopbackHostname(parsed.hostname);
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function formatBootstrapDirDisplay(rootDir: string): string {
  const home = homedir();
  if (rootDir === home || !rootDir.startsWith(home)) {
    return `${rootDir}/.bootstrap/`;
  }
  return `~${rootDir.slice(home.length)}/.bootstrap/`;
}

function summarizeProviderOutcomes(outcomes: ProviderWriteOutcome[]): string {
  const keys = outcomes.map((o) => o.key);
  const written = outcomes.filter((o) => o.status === "written").length;
  const unchanged = outcomes.filter((o) => o.status === "unchanged").length;
  if (keys.length === 0) return "(none)";
  return `${keys.join(", ")}  (${written} written, ${unchanged} unchanged)`;
}

/**
 * D173 — mirror `consumeDeployConfigProviders`'s write/no-op decision without
 * mutating disk: true when at least one resolved provider has a non-empty value
 * that differs from the current `instance.env` row (same path as config-guard).
 */
function hasPendingProviderKeyWritesForConsume(resolved: ResolvedDeployConfig): boolean {
  const rows = Array.isArray(resolved.providers) ? resolved.providers : [];
  const envPath = resolveDotenvPath();
  for (const row of rows) {
    const value = row.value.value.trim();
    if (value === "") continue;
    const raw = existsSync(envPath) ? readFileSync(envPath, "utf8") : "";
    const onDisk = getValueFromEntries(parseEnvFile(raw), row.key)?.trim();
    const onDiskNorm =
      onDisk === "" || onDisk === undefined ? undefined : onDisk;
    if (onDiskNorm !== value) return true;
  }
  return false;
}

/** Claim redeem failed because the invite is exhausted (server `410` + `used_up`, etc.). */
function isInviteRedeemUsedUpFailure(detail: string | undefined): boolean {
  if (!detail) return false;
  const d = detail.toLowerCase();
  return d.includes("used_up");
}

/** Read `.bootstrap/claim-invite` first; fall back to legacy `claim-invite.txt`. */
function readBootstrapClaimInviteToken(warnLegacy: (msg: string) => void): string | null {
  const root = resolveNautiloRootDir();
  const modernPath = join(root, ".bootstrap", "claim-invite");
  const legacyPath = join(root, "claim-invite.txt");

  if (existsSync(modernPath)) {
    const raw = readFileSync(modernPath, "utf8").trim();
    const first = raw.split(/\r?\n/u)[0]?.trim();
    if (first && first.length > 0) return first;
  }

  if (existsSync(legacyPath)) {
    warnLegacy(
      `[dev:setup] using deprecated ${legacyPath}; prefer ${modernPath} (single-line token).`,
    );
    const parsed = parseClaimInviteFileContent(readFileSync(legacyPath, "utf8"));
    if (!parsed) return null;
    const t = parsed.token?.trim();
    if (t && t.length > 0) return t;
    return parsed.redeemInput.trim().length > 0 ? parsed.redeemInput.trim() : null;
  }

  return null;
}

export interface SetupInstanceDeps {
  resolveStatus: () => Promise<SetupInstanceStatus>;
  redeemInvite: (token: string, body: RedeemInput) => Promise<RedeemResult>;
  /** Apply session tokens from redeem onto the API client used by resolveStatus. */
  setAuthFromRedeem: (redeem: RedeemResult) => boolean;
  consumeProviders: (resolved: ResolvedDeployConfig) => Promise<ProviderWriteOutcome[]>;
  postReloadEnv: (bearer: string) => Promise<{ ok: boolean; status: number }>;
  stampDeployConsumed: () => void;
  /** Value shown as deployConfigConsumedAt in the success banner (defaults to disk read in CLI). */
  readConsumedStamp: () => string | null;
  readClaimInvite: () => string | null;
  loadDeployConfig: () => DeployConfig;
  resolveSecrets: (cfg: DeployConfig) => ResolvedDeployConfig;
  envLookup: (name: string) => string | undefined;
  log: (s: string) => void;
  warn: (s: string) => void;
}

export interface RunSetupInstanceOpts {
  instanceId: string;
  serverUrl: string;
  logPrefix?: string;
}

export async function runSetupInstance(
  deps: SetupInstanceDeps,
  opts: RunSetupInstanceOpts,
): Promise<number> {
  const p = opts.logPrefix ?? "[dev:setup]";
  const { instanceId, serverUrl } = opts;
  const rootDir = resolveNautiloRootDir();

  let status = await deps.resolveStatus();
  const deployStamped =
    status.deployConfigConsumedAt !== null &&
    status.deployConfigConsumedAt !== undefined &&
    String(status.deployConfigConsumedAt).trim() !== "";

  if (status.setupState === "ready" && deployStamped) {
    deps.log(`${p} already ready and stamped — no-op`);
    return 0;
  }

  const deploy = deps.loadDeployConfig();
  let resolved: ResolvedDeployConfig;
  try {
    resolved = deps.resolveSecrets(deploy);
  } catch (e) {
    if (e instanceof EnvVarMissingError) {
      deps.warn(
        `${p} missing environment variable for deploy.toml: ${e.varName} (required by field ${e.field})`,
      );
      return 2;
    }
    throw e;
  }

  const plan = planAdminRedemption(resolved);
  let redeemBearer: string | null = null;
  let recoveryCodes: string[] | undefined;
  let wasFreshUnclaimed = false;
  const initialReadyUnstamped = status.setupState === "ready" && !deployStamped;

  if (status.setupState === "fresh-unclaimed") {
    wasFreshUnclaimed = true;
    const r = await tryRedeemClaimAndExtractBearer(deps, resolved);
    if (!r.ok) {
      if (r.recoveryCodes && r.recoveryCodes.length > 0) {
        logRecoveryCodes(deps, p, r.recoveryCodes);
      }
      deps.warn(
        formatRedeemFailureMessage(r, p, rootDir, "fresh-unclaimed"),
      );
      return 2;
    }
    redeemBearer = r.bearer;
    recoveryCodes = r.recoveryCodes;
    status = await deps.resolveStatus();
  }

  // D157 Phase 2 — `claimed-needs-auth` recovery branch. Pre-D157 this
  // branch unconditionally returned 2 with a vague "complete owner sign-in"
  // message, which trapped the operator: their
  // dev:setup had partially completed (instance was claimed) but provider
  // keys were not yet written, and the only escape was to manually sign
  // in via a separate surface. Now we attempt to re-redeem the claim
  // invite (idempotent per M073/M100 contract) and continue automation
  // from there. If the claim invite is missing or re-redeem fails (e.g.
  // claim file was manually cleaned, server-side invariant broke), we
  // print an improved error message that points at concrete recovery
  // commands rather than handing the operator an unlinked sign-in instruction.
  if (status.setupState === "claimed-needs-auth") {
    const r = await tryRedeemClaimAndExtractBearer(deps, resolved);
    if (!r.ok) {
      if (r.recoveryCodes && r.recoveryCodes.length > 0) {
        logRecoveryCodes(deps, p, r.recoveryCodes);
      }
      if (
        r.reason === "redeem-failed" &&
        isInviteRedeemUsedUpFailure(r.detail) &&
        hasPendingProviderKeyWritesForConsume(resolved)
      ) {
        deps.log(
          `${p} skipping D157 recovery branch — resuming keys-write phase (claim already consumed, providers pending)`,
        );
      } else {
        deps.warn(
          formatRedeemFailureMessage(r, p, rootDir, "claimed-needs-auth"),
        );
        return 2;
      }
    } else {
      redeemBearer = r.bearer;
      recoveryCodes = r.recoveryCodes;
      status = await deps.resolveStatus();
    }
  }

  let outcomes: ProviderWriteOutcome[];
  try {
    outcomes = await deps.consumeProviders(resolved);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    deps.warn(`${p} provider key write failed: ${msg}`);
    return 1;
  }

  for (const o of outcomes) {
    deps.log(`${p} provider ${o.key}: ${o.status}`);
  }

  const anyWritten = outcomes.some((o) => o.status === "written");
  if (anyWritten && redeemBearer && isLoopbackServerUrl(serverUrl)) {
    const res = await deps.postReloadEnv(redeemBearer);
    if (!res.ok) {
      deps.warn(`${p} POST /api/setup/reload-env returned HTTP ${res.status}; restart server if keys changed`);
    }
  } else if (anyWritten && initialReadyUnstamped) {
    deps.log(
      `${p} reload-env skipped (no admin bearer in already-ready branch); restart server if you rotated keys`,
    );
  }

  deps.stampDeployConsumed();

  if (wasFreshUnclaimed) {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      status = await deps.resolveStatus();
      if (status.setupState === "ready") break;
      await sleep(500);
    }
  }

  const consumedAt = deps.readConsumedStamp();
  const displayId = instanceId.trim() === "" ? "(default)" : instanceId;
  const lines: string[] = [];
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  Nautilo dev:setup complete — ${instanceId.trim() === "" ? "default" : instanceId}`);
  lines.push("═══════════════════════════════════════════════════════════");
  lines.push(`  instanceId            : ${displayId}`);
  lines.push(`  serverUrl             : ${serverUrl}`);
  lines.push(`  setupState            : ${status.setupState}`);
  lines.push(`  deployConfigConsumedAt: ${consumedAt ?? "(unset)"}`);
  lines.push(`  adminHandle           : ${plan.handle}`);
  lines.push(`  providers applied     : ${summarizeProviderOutcomes(outcomes)}`);
  lines.push(`  bootstrap dir         : ${formatBootstrapDirDisplay(rootDir)}`);
  if (recoveryCodes && recoveryCodes.length > 0) {
    lines.push("");
    lines.push("  Recovery codes (one-time, store now — won't be shown again):");
    lines.push(`    ${recoveryCodes.join("  ")}`);
  }
  lines.push("═══════════════════════════════════════════════════════════");
  deps.log(lines.join("\n"));

  return 0;
}

/**
 * D157 Phase 2 post-smoke (2026-05-16) — env lookup for `{ fromEnv = "X" }`
 * deploy.toml resolution. Precedence (first match wins):
 *
 *   1. `--env-file <path>` contents (caller-supplied; explicit > implicit).
 *   2. Operator secrets file (default `~/.config/nautilo/secrets.env`,
 *      override via `--secrets-file`). Auto-loaded if present at the
 *      default path; missing file is silently skipped. Same file the
 *      legacy `nautilo setup --secrets-file` flow has always consumed —
 *      `dev:setup` had a feature-parity gap that surfaced as a fresh-
 *      shell smoke failure with `[dev:setup] missing environment
 *      variable for deploy.toml: OPENAI_API_KEY` even though the file
 *      was sitting at the canonical 0600 path. Stack 19 caught it in
 *      Phase 6.4.2 live smoke; pinned with the regression test below.
 *   3. `process.env` (caller exported it before invocation).
 *
 * Returns undefined when no source has a non-empty value.
 */
function buildEnvLookupFromEnvFile(
  envFilePath: string | undefined,
  operatorSecrets: Record<string, string>,
): (name: string) => string | undefined {
  let entries: ReturnType<typeof parseEnvFile> = [];
  if (envFilePath && existsSync(envFilePath)) {
    entries = parseEnvFile(readFileSync(envFilePath, "utf8"));
  }
  return (name: string): string | undefined => {
    const fromFile = getValueFromEntries(entries, name)?.trim();
    if (fromFile && fromFile.length > 0) return fromFile;
    const fromOpSecrets = operatorSecrets[name]?.trim();
    if (fromOpSecrets && fromOpSecrets.length > 0) return fromOpSecrets;
    const fromProc = process.env[name]?.trim();
    return fromProc && fromProc.length > 0 ? fromProc : undefined;
  };
}

/**
 * D157 Phase 2 — pull the redeem + setAuth + extract-bearer sequence
 * out of the `fresh-unclaimed` branch so the `claimed-needs-auth`
 * recovery branch can reuse it.
 *
 * Returns:
 *   { ok: true, bearer } — redeem succeeded; caller may continue to
 *     consumeProviders.
 *   { ok: false, reason } — redeem failed for one of several reasons;
 *     caller prints the appropriate operator-facing message + returns 2.
 *
 * Idempotency note: M073/M100's `redeemInvite` endpoint is documented
 * as idempotent for already-redeemed claim invites (returns the same
 * admin's session). If a future server change breaks that invariant,
 * the `redeem-failed` branch fires and the operator sees the
 * fallback message.
 */
type ClaimRedeemResult =
  | { ok: true; bearer: string; recoveryCodes?: string[] | undefined }
  | {
      ok: false;
      reason: "no-token" | "redeem-failed" | "no-session-token" | "no-bearer";
      detail?: string;
      recoveryCodes?: string[] | undefined;
    };

function logRecoveryCodes(
  deps: Pick<SetupInstanceDeps, "log">,
  prefix: string,
  recoveryCodes: readonly string[],
): void {
  deps.log(
    [
      `${prefix} claim succeeded and returned recovery codes, but setup automation cannot continue.`,
      `${prefix} Recovery codes (one-time, store now — won't be shown again):`,
      `${prefix}   ${recoveryCodes.join("  ")}`,
    ].join("\n"),
  );
}

async function tryRedeemClaimAndExtractBearer(
  deps: SetupInstanceDeps,
  resolved: ResolvedDeployConfig,
): Promise<ClaimRedeemResult> {
  const token = deps.readClaimInvite();
  if (!token || token.trim().length === 0) {
    return { ok: false, reason: "no-token" };
  }
  const plan = planAdminRedemption(resolved);
  const redeemBody = {
    handle: plan.handle,
    displayName: plan.displayName,
    password: plan.password,
    forcePasswordChange: false,
    ...(plan.pin !== undefined ? { pin: plan.pin } : {}),
  } as RedeemInput;
  let redeem: RedeemResult;
  try {
    redeem = await deps.redeemInvite(token.trim(), redeemBody);
  } catch (e) {
    return {
      ok: false,
      reason: "redeem-failed",
      detail: e instanceof Error ? e.message : String(e),
    };
  }
  if (!deps.setAuthFromRedeem(redeem)) {
    return {
      ok: false,
      reason: "no-session-token",
      recoveryCodes: redeem.recoveryCodes,
    };
  }
  const bearer = extractRedeemBearer(redeem);
  if (!bearer) {
    return { ok: false, reason: "no-bearer", recoveryCodes: redeem.recoveryCodes };
  }
  return { ok: true, bearer, recoveryCodes: redeem.recoveryCodes };
}

/**
 * D157 Phase 2 — format the operator-facing error message for a
 * failed claim redeem, branching on the failure reason and the
 * setupState that triggered the redeem. Spells out concrete
 * recovery commands instead of an unlinked sign-in instruction.
 */
function formatRedeemFailureMessage(
  result: Extract<ClaimRedeemResult, { ok: false }>,
  prefix: string,
  rootDir: string,
  state: "fresh-unclaimed" | "claimed-needs-auth",
): string {
  if (result.reason === "no-token") {
    return state === "fresh-unclaimed"
      ? `${prefix} fresh-unclaimed but no claim invite token found under ${rootDir}`
      : [
          `${prefix} setupState=claimed-needs-auth — claim invite not available for re-redeem`,
          `(file missing or already-consumed at ${rootDir}/bootstrap-claim-invite.txt).`,
          ``,
          `Manual recovery options:`,
          `  - Sign in via the workbench (browser or Electron desktop app), then re-run \`bun run dev:setup\`.`,
          ``,
          `See ISSUE-D157 for the partial-claim-recovery context.`,
        ].join("\n");
  }
  if (result.reason === "redeem-failed") {
    return state === "fresh-unclaimed"
      ? `${prefix} redeem failed: ${result.detail ?? "(unknown)"}`
      : [
          `${prefix} setupState=claimed-needs-auth re-redeem attempt FAILED: ${result.detail ?? "(unknown)"}.`,
          ``,
          `The claim invite may have been consumed by a prior partial dev:setup AND the server-side`,
          `idempotency invariant doesn't apply for this case (M073/M100 contract change?).`,
          `Check the error detail above, ensure your deploy.toml has the intended \`[[providers]]\` block,`,
          `then re-run \`bun run dev:setup\`. See ISSUE-D173 (keys-write fall-through) and ISSUE-D157.`,
        ].join("\n");
  }
  if (result.reason === "no-session-token") {
    return `${prefix} redeem did not return a session token — recovery codes were printed above, but setup cannot continue automation. Complete owner sign-in manually, then rerun setup if provider keys still need applying.`;
  }
  return `${prefix} redeem bearer missing after session handoff.`;
}

export async function setupInstanceCmd(args: string[]): Promise<number> {
  const flagValue = (flag: string): string | undefined => {
    const idx = args.indexOf(flag);
    if (idx === -1 || idx === args.length - 1) return undefined;
    return args[idx + 1];
  };

  const serverUrlFlag = flagValue("--server")?.trim();
  const configPath =
    flagValue("--config")?.trim() ?? join(homedir(), ".config", "nautilo", "deploy.toml");
  const envFilePath = flagValue("--env-file")?.trim();
  // D157 Phase 2 post-smoke (2026-05-16): `--secrets-file` overrides the
  // default operator-secrets path; matches the legacy `nautilo setup`
  // flag of the same name + semantics. Default path is the canonical
  // M091 location enforced by `loadOperatorSecrets` (mode 0600, outside
  // any git work tree). Missing file is silently skipped (no error).
  const secretsFilePath =
    flagValue("--secrets-file")?.trim() ?? defaultOperatorSecretsPath();

  const instance = resolveInstance();

  // D157 Phase 1 — auto-source `~/.nautilo${suffix}/instance.env` into
  // process.env BEFORE config-guard transactional validation. Without
  // this, a fresh shell invocation fails the LOGTO_* config-guard check
  // even though the keys are present on disk (infra:start writes them
  // but doesn't export into the calling shell).
  //
  // Composes with M107's fix in `bin/nautilo-dev/src/lib/paths.ts` —
  // `loadConfigEnvIntoProcess` resolves the dotenv path via
  // `resolveDotenvPath()` which post-M091+M107 correctly points at
  // `~/.nautilo${suffix}/instance.env`. Same loader used by
  // `migrate-to-username-identity` and `verify-user-link` for the
  // same purpose (single canonical loader; user-explicit env wins
  // over file values per the loader's contract).
  loadConfigEnvIntoProcess();

  const serverUrl = (serverUrlFlag && serverUrlFlag.length > 0
    ? serverUrlFlag
    : instance.server.url
  ).replace(/\/$/, "");

  const api = new NautiloApiClient(serverUrl);
  const peekStatus = async (): Promise<SetupInstanceStatus> => {
    const s = await api.getSetupStatus();
    return {
      ...s,
      deployConfigConsumedAt: readDeployConfigConsumedAt(resolveNautiloRootDir()),
    };
  };

  const initialStatus = await peekStatus();
  const deployStamped =
    initialStatus.deployConfigConsumedAt !== null &&
    initialStatus.deployConfigConsumedAt !== undefined &&
    String(initialStatus.deployConfigConsumedAt).trim() !== "";
  const isReadOnlyNoOp =
    initialStatus.setupState === "ready" && deployStamped;

  if (!isReadOnlyNoOp) {
    const iKnowWhatIAmDoing = args.includes("--i-know-what-i-am-doing");
    const guard = resolveAndEvaluateDefaultInstanceMutationGuard({
      commandName: "dev:setup-instance",
      cwd: process.cwd(),
      isDryRunOrReadOnly: false,
      iKnowWhatIAmDoing,
    });
    if (!guard.allowed) {
      console.error(guard.message);
      return 2;
    }
  }

  const resolveStatus = async (): Promise<SetupInstanceStatus> => {
    const s = await api.getSetupStatus();
    return {
      ...s,
      deployConfigConsumedAt: readDeployConfigConsumedAt(resolveNautiloRootDir()),
    };
  };

  // Load operator-secrets (mode 0600 enforced by the loader); missing
  // file → empty map, callers may still supply env vars or --env-file.
  let operatorSecrets: Record<string, string> = {};
  try {
    operatorSecrets = await loadOperatorSecrets(secretsFilePath);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[dev:setup] operator-secrets load failed (${secretsFilePath}): ${msg}`);
    console.warn(
      `[dev:setup] continuing without secrets file — \`{ fromEnv = "X" }\` fields will fall back to process.env only`,
    );
  }

  const envLookup = buildEnvLookupFromEnvFile(
    envFilePath && envFilePath.length > 0 ? envFilePath : undefined,
    operatorSecrets,
  );

  const deps: SetupInstanceDeps = {
    resolveStatus,
    redeemInvite: (token, body) => api.redeemInvite(token, body),
    setAuthFromRedeem: (redeem) => {
      if (redeem.logtoSession?.accessToken) {
        api.setToken(redeem.logtoSession.accessToken);
        return true;
      }
      if (redeem.sessionToken) {
        api.setToken(redeem.sessionToken);
        return true;
      }
      return false;
    },
    consumeProviders: (r) => consumeDeployConfigProviders(r),
    postReloadEnv: async (bearer) => {
      try {
        const res = await fetch(`${serverUrl}/api/setup/reload-env`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${bearer}`,
            "Content-Type": "application/json",
          },
          body: "{}",
        });
        return { ok: res.ok, status: res.status };
      } catch {
        return { ok: false, status: 0 };
      }
    },
    stampDeployConsumed: () => markDeployConfigConsumed(resolveNautiloRootDir()),
    readConsumedStamp: () => readDeployConfigConsumedAt(resolveNautiloRootDir()),
    readClaimInvite: () => readBootstrapClaimInviteToken((m) => console.warn(m)),
    loadDeployConfig: () => parseDeployConfigFromPath(configPath),
    resolveSecrets: (cfg) => resolveDeployConfig(cfg, envLookup),
    envLookup,
    log: (s) => console.log(s),
    warn: (s) => console.warn(s),
  };

  try {
    return await runSetupInstance(deps, {
      instanceId: instance.instanceId,
      serverUrl,
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[dev:setup] ${msg}`);
    return 2;
  }
}
