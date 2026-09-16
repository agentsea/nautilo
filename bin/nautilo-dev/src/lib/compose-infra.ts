import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import {
  resolveNautiloRootDir,
  resolvedInstanceChildEnv,
  type ResolvedInstance,
} from "@nautilo/config";
import { readConfigEnv } from "./config-env";

/** Monorepo root (directory that contains `infra/compose/`). */
export const NAUTILO_REPO_ROOT = resolve(import.meta.dirname, "../../../..");

export const NAUTILO_COMPOSE_FILE = resolve(
  NAUTILO_REPO_ROOT,
  "infra/compose/nautilo.yml",
);

const NAUTILO_DB_COMPOSE_FILE = resolve(
  NAUTILO_REPO_ROOT,
  "packages/db/docker/docker-compose.yml",
);

/**
 * Resolve the selected instance's canonical internal credential plan and
 * ensure child processes (`bun run db:dev`, compose, etc.) see the same
 * project, ports, credentials, and derived URLs.
 */
export const REQUIRED_SERVICE_SECRET_KEYS = [
  "NAUTILO_DB_PASSWORD",
  "NAUTILO_AGENT_DB_PASSWORD",
  "LOGTO_DB_PASSWORD",
] as const;

export type InfraServiceSecretKey = (typeof REQUIRED_SERVICE_SECRET_KEYS)[number];

export interface InfraCredentialPlan {
  instanceEnvPath: string;
  source: "selected-instance" | "fresh-instance-fallback";
  serviceSecrets: Record<InfraServiceSecretKey, string> & {
    NAUTILO_CRYPTO_DB_PASSWORD: string;
  };
  childEnv: Record<string, string>;
}

export interface InstanceServiceSecretPlan {
  instanceEnvPath: string;
  source: "selected-instance" | "fresh-instance-fallback";
  serviceSecrets: Record<InfraServiceSecretKey, string>;
}

export interface EnsureInfraCryptoDbPasswordDeps {
  randomHexPassword: () => string;
  persistCryptoPassword: (secretPath: string, secret: string) => Promise<void>;
}

export const DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH =
  ".bootstrap/nautilo-crypto-db-password";

const OPENCONNECTOR_ENCRYPTION_KEY_RELATIVE_PATH =
  "runtime-secrets/openconnector-encryption.key";

const OPENCONNECTOR_DATA_RELATIVE_PATH = "openconnector-data";

/**
 * This sentinel is deliberately a separate protected file. It is written
 * last, after the role-only crypto secret and server-mounted instance.env, so
 * it is the durable commit marker for a coherent local credential authority.
 */
export const INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH =
  ".bootstrap/d508-credential-authority-committed";

const INFRA_CREDENTIAL_AUTHORITY_SENTINEL =
  "nautilo-d508-credential-authority-v1";

export type InfraCredentialAuthorityState =
  | "absent"
  | "partial-before-volume"
  | "committed"
  | "inconsistent-after-volume";

export interface InfraCredentialAuthorityInspection {
  state: InfraCredentialAuthorityState;
  instanceEnvPath: string;
  cryptoSecretPath: string;
  sentinelPath: string;
  missing: readonly string[];
  /** A complete pre-D508 durable authority may safely gain its marker only. */
  needsSentinelAdoption: boolean;
}

export interface EnsureInfraCredentialAuthorityDeps {
  randomHexPassword?: () => string;
  volumeExists?: InfraVolumeExists;
  writeProtectedFile?: (path: string, contents: string) => void;
}

function parseEnvValue(raw: string, key: string): string | undefined {
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0 || trimmed.slice(0, eq).trim() !== key) continue;
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value.trim() === "" ? undefined : value;
  }
  return undefined;
}

function readFileIfPresent(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

function isSingleLineSecret(value: string | undefined): value is string {
  return value !== undefined && value.trim() !== "" && !/[\r\n]/.test(value);
}

function removeCredentialAuthorityLines(raw: string): string {
  const authorityKeys = new Set<string>([
    ...REQUIRED_SERVICE_SECRET_KEYS,
    "NAUTILO_CRYPTO_DB_PASSWORD",
  ]);
  const retained = raw
    .split(/\r?\n/)
    .filter((line) => !authorityKeys.has(line.trim().split("=", 1)[0] ?? ""));
  return retained.join("\n").replace(/\n+$/, "");
}

function buildInstanceEnvWithServiceSecrets(
  existing: string | undefined,
  serviceSecrets: Record<InfraServiceSecretKey, string>,
): string {
  const retained = removeCredentialAuthorityLines(existing ?? "");
  const serviceLines = REQUIRED_SERVICE_SECRET_KEYS.map((key) => {
    const value = serviceSecrets[key];
    if (!isSingleLineSecret(value)) {
      throw new Error(`[instance-secrets] generated ${key} is empty or multiline`);
    }
    return `${key}=${value}`;
  });
  return `${retained === "" ? "" : `${retained}\n`}${serviceLines.join("\n")}\n`;
}

/** Same-filesystem publication used for every local credential authority file. */
export function writeProtectedInstanceSecretFile(path: string, contents: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  writeFileSync(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

/**
 * Ensure the local OpenConnector credential store has one durable AES-256 key.
 * Existing keys are validated and reused; malformed keys fail closed rather
 * than silently orphaning already-encrypted OAuth credentials.
 */
export function ensureOpenConnectorEncryptionKeyForInstance(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    randomKey?: () => string;
    writeProtectedFile?: (path: string, contents: string) => void;
  } = {},
): { keyPath: string; dataDir: string } {
  const selectedEnv = { ...env, NAUTILO_INSTANCE_ID: inst.instanceId };
  const rootDir = resolveNautiloRootDir({ env: selectedEnv });
  const keyPath = join(rootDir, OPENCONNECTOR_ENCRYPTION_KEY_RELATIVE_PATH);
  const dataDir = env["NAUTILO_OPENCONNECTOR_DATA_DIR"]?.trim()
    || join(rootDir, OPENCONNECTOR_DATA_RELATIVE_PATH);
  const existing = readFileIfPresent(keyPath)?.trim();
  if (existing !== undefined) {
    if (!/^[a-f0-9]{64}$/iu.test(existing)) {
      throw new Error(
        "[openconnector] existing encryption key is invalid; restore the original 32-byte hexadecimal key before starting so connected accounts remain decryptable",
      );
    }
    return { keyPath, dataDir };
  }

  const candidate = (deps.randomKey ?? (() => randomBytes(32).toString("hex")))();
  if (!/^[a-f0-9]{64}$/iu.test(candidate)) {
    throw new Error("[openconnector] encryption-key generator returned an invalid value");
  }
  (deps.writeProtectedFile ?? writeProtectedInstanceSecretFile)(keyPath, `${candidate}\n`);
  return { keyPath, dataDir };
}

export function openConnectorContainerName(inst: ResolvedInstance): string {
  return `${inst.compose.projectName}-openconnector-1`;
}

/**
 * Inspect only local protected authority files. A valid completion sentinel
 * makes the two independently published secret files one committed set.
 */
export function inspectInfraCredentialAuthority(input: {
  instanceEnvPath: string;
  cryptoSecretPath: string;
  sentinelPath: string;
  hasPersistentVolume: boolean;
}): InfraCredentialAuthorityInspection {
  const instanceEnvRaw = readFileIfPresent(input.instanceEnvPath);
  const instanceEnv = instanceEnvRaw === undefined
    ? undefined
    : readConfigEnv({ path: input.instanceEnvPath }).values;
  const missing: string[] = [];
  if (instanceEnvRaw === undefined) {
    missing.push("instance.env");
  } else {
    for (const key of REQUIRED_SERVICE_SECRET_KEYS) {
      if (!isSingleLineSecret(instanceEnv?.[key])) missing.push(`instance.env:${key}`);
    }
  }

  const cryptoRaw = readFileIfPresent(input.cryptoSecretPath);
  const crypto = cryptoRaw?.replace(/\r?\n$/, "");
  const legacyCrypto = instanceEnv?.["NAUTILO_CRYPTO_DB_PASSWORD"];
  // This is the existing authority precedence: a present role-only file wins;
  // older instances may still hold their crypto role credential in instance.env.
  if (cryptoRaw !== undefined) {
    if (!isSingleLineSecret(crypto)) missing.push("crypto-role-secret");
  } else if (!isSingleLineSecret(legacyCrypto)) {
    missing.push("crypto-role-secret-or-legacy-instance.env");
  }

  const sentinelRaw = readFileIfPresent(input.sentinelPath);
  const sentinel = sentinelRaw?.trim();
  const credentialsComplete = missing.length === 0;
  const needsSentinelAdoption =
    input.hasPersistentVolume &&
    credentialsComplete &&
    sentinelRaw === undefined;
  if (sentinel !== INFRA_CREDENTIAL_AUTHORITY_SENTINEL && !needsSentinelAdoption) {
    missing.push("completion-sentinel");
  }

  const noAuthorityFiles =
    instanceEnvRaw === undefined && cryptoRaw === undefined && sentinel === undefined;
  const committed = missing.length === 0;
  return {
    state: committed
      ? "committed"
      : input.hasPersistentVolume
        ? "inconsistent-after-volume"
        : noAuthorityFiles
          ? "absent"
          : "partial-before-volume",
    instanceEnvPath: input.instanceEnvPath,
    cryptoSecretPath: input.cryptoSecretPath,
    sentinelPath: input.sentinelPath,
    missing,
    needsSentinelAdoption,
  };
}

/**
 * Reconcile the complete local credential authority before `infra:start`
 * creates a Docker volume. This is intentionally not a cross-file
 * transaction: a sentinel published last identifies the coherent set, and a
 * later pre-volume run discards any interrupted publication and regenerates it.
 */
export function ensureInfraCredentialAuthorityForInfraStart(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsureInfraCredentialAuthorityDeps = {},
): InfraCredentialPlan {
  const selectedEnv = { ...env, NAUTILO_INSTANCE_ID: inst.instanceId };
  const rootDir = resolveNautiloRootDir({ env: selectedEnv });
  const instanceEnvPath = join(rootDir, "instance.env");
  const cryptoSecretPath = join(rootDir, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
  const sentinelPath = join(
    rootDir,
    INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH,
  );
  const volumeExists = deps.volumeExists ?? dockerVolumeExists;
  const persistentVolumes = infraPersistentVolumeNames(inst).filter(volumeExists);
  const inspection = inspectInfraCredentialAuthority({
    instanceEnvPath,
    cryptoSecretPath,
    sentinelPath,
    hasPersistentVolume: persistentVolumes.length > 0,
  });

  if (inspection.state === "inconsistent-after-volume") {
    throw new Error(
      `[instance-secrets] credential authority for existing instance ${inst.instanceId || "(default)"} is inconsistent-after-volume; missing or invalid: ${inspection.missing.join(", ")}. Restore ${instanceEnvPath}, ${cryptoSecretPath}, and ${sentinelPath} from the same backup, or destroy this disposable instance's persistent volumes before retrying. No credentials were changed.`,
    );
  }

  const writeProtectedFile = deps.writeProtectedFile ?? writeProtectedInstanceSecretFile;
  if (inspection.needsSentinelAdoption) {
    // The pre-D508 authority is already complete and selected by the current
    // resolver. Adoption writes only the non-secret commit marker; it cannot
    // mint, rotate, combine, or otherwise alter a credential set.
    writeProtectedFile(sentinelPath, `${INFRA_CREDENTIAL_AUTHORITY_SENTINEL}\n`);
  } else if (inspection.state !== "committed") {
    const randomHexPassword = deps.randomHexPassword ?? (() => randomBytes(24).toString("hex"));
    const serviceSecrets: Record<InfraServiceSecretKey, string> = {
      NAUTILO_DB_PASSWORD: randomHexPassword(),
      NAUTILO_AGENT_DB_PASSWORD: randomHexPassword(),
      LOGTO_DB_PASSWORD: randomHexPassword(),
    };
    const cryptoSecret = randomHexPassword();
    if (!isSingleLineSecret(cryptoSecret)) {
      throw new Error("[instance-secrets] generated crypto role credential is empty or multiline");
    }
    const existingInstanceEnv = readFileIfPresent(instanceEnvPath);

    // Publication order is intentional and covered by crash-point tests.
    writeProtectedFile(cryptoSecretPath, `${cryptoSecret}\n`);
    writeProtectedFile(
      instanceEnvPath,
      buildInstanceEnvWithServiceSecrets(existingInstanceEnv, serviceSecrets),
    );
    writeProtectedFile(sentinelPath, `${INFRA_CREDENTIAL_AUTHORITY_SENTINEL}\n`);
  }

  return resolveInfraCredentialPlan(inst, env, { instanceEnvPath });
}

/**
 * Commit the credential authority copied from a verified clone backup before
 * the target creates persistent volumes. Restored database roles still use the
 * copied service secrets, so this path may add only the dormant crypto secret
 * and the completion marker; it must never rotate the copied credentials.
 */
export function ensureClonedInfraCredentialAuthorityBeforeVolume(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
  deps: EnsureInfraCredentialAuthorityDeps = {},
): InfraCredentialPlan {
  const selectedEnv = { ...env, NAUTILO_INSTANCE_ID: inst.instanceId };
  const rootDir = resolveNautiloRootDir({ env: selectedEnv });
  const instanceEnvPath = join(rootDir, "instance.env");
  const cryptoSecretPath = join(rootDir, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
  const sentinelPath = join(
    rootDir,
    INFRA_CREDENTIAL_AUTHORITY_SENTINEL_RELATIVE_PATH,
  );
  const volumeExists = deps.volumeExists ?? dockerVolumeExists;
  const persistentVolumes = infraPersistentVolumeNames(inst).filter(volumeExists);
  if (persistentVolumes.length > 0) {
    throw new Error(
      `[instance-secrets] cloned credential authority for ${inst.instanceId || "(default)"} must be committed before persistent volumes exist: ${persistentVolumes.join(", ")}. No credentials were changed.`,
    );
  }

  const instanceEnvRaw = readFileIfPresent(instanceEnvPath);
  if (instanceEnvRaw === undefined) {
    throw new Error(
      `[instance-secrets] verified clone backup did not materialize ${instanceEnvPath}. No credentials were changed.`,
    );
  }
  // Fail before publishing anything if the copied service authority is not
  // complete. These values must continue to match the database roles restored
  // from the same verified backup.
  resolveInstanceServiceSecrets(
    { instanceId: inst.instanceId, instanceEnvPath },
    selectedEnv,
  );

  const sentinelRaw = readFileIfPresent(sentinelPath);
  if (
    sentinelRaw !== undefined &&
    sentinelRaw.trim() !== INFRA_CREDENTIAL_AUTHORITY_SENTINEL
  ) {
    throw new Error(
      `[instance-secrets] verified clone backup contains an invalid credential authority sentinel at ${sentinelPath}. No credentials were changed.`,
    );
  }

  const cryptoRaw = readFileIfPresent(cryptoSecretPath);
  const roleOnlyCrypto = cryptoRaw?.replace(/\r?\n$/, "");
  const legacyCrypto = parseEnvValue(
    instanceEnvRaw,
    "NAUTILO_CRYPTO_DB_PASSWORD",
  );
  if (cryptoRaw !== undefined && !isSingleLineSecret(roleOnlyCrypto)) {
    throw new Error(
      `[instance-secrets] verified clone backup contains an invalid crypto role credential at ${cryptoSecretPath}. No credentials were changed.`,
    );
  }
  if (
    sentinelRaw !== undefined &&
    cryptoRaw === undefined &&
    !isSingleLineSecret(legacyCrypto)
  ) {
    throw new Error(
      `[instance-secrets] verified clone backup contains a committed credential authority without a crypto role credential. No credentials were changed.`,
    );
  }

  const writeProtectedFile = deps.writeProtectedFile ?? writeProtectedInstanceSecretFile;
  if (cryptoRaw === undefined && !isSingleLineSecret(legacyCrypto)) {
    const randomHexPassword = deps.randomHexPassword ?? (() => randomBytes(24).toString("hex"));
    const cryptoSecret = randomHexPassword();
    if (!isSingleLineSecret(cryptoSecret)) {
      throw new Error(
        "[instance-secrets] generated crypto role credential is empty or multiline",
      );
    }
    writeProtectedFile(cryptoSecretPath, `${cryptoSecret}\n`);
  }
  if (sentinelRaw === undefined) {
    // Commit last so an interrupted pre-volume clone never appears coherent.
    writeProtectedFile(sentinelPath, `${INFRA_CREDENTIAL_AUTHORITY_SENTINEL}\n`);
  }

  return resolveInfraCredentialPlan(inst, selectedEnv, { instanceEnvPath });
}

function stripCryptoPasswordLine(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim().split("=", 1)[0] !== "NAUTILO_CRYPTO_DB_PASSWORD",
    )
    .join("\n")
    .replace(/\n+$/, "") + "\n";
}

/**
 * Atomically extend an existing dev credential authority with the dormant
 * crypto-role password. Existing keys are untouched; repeat calls are no-ops.
 */
export async function ensureInfraCryptoDbPassword(
  input: { instanceEnvPath: string; instanceEnvRaw: string },
  deps: EnsureInfraCryptoDbPasswordDeps,
): Promise<string> {
  const secretPath = join(
    resolve(input.instanceEnvPath, ".."),
    DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  );
  if (existsSync(secretPath)) {
    const persisted = readFileSync(secretPath, "utf8").trim();
    if (persisted !== "") return persisted;
    throw new Error("[instance-secrets] crypto role credential file is empty");
  }
  const existing = parseEnvValue(
    input.instanceEnvRaw,
    "NAUTILO_CRYPTO_DB_PASSWORD",
  );
  const secret = existing ?? deps.randomHexPassword();
  await deps.persistCryptoPassword(secretPath, secret);
  return secret;
}

function persistInfraCryptoDbPassword(
  secretPath: string,
  secret: string,
): Promise<void> {
  if (secret.trim() === "" || /[\r\n]/.test(secret)) {
    throw new Error("[instance-secrets] crypto role credential is empty or multiline");
  }
  mkdirSync(resolve(secretPath, ".."), { recursive: true, mode: 0o700 });
  const temporary = `${secretPath}.tmp-${process.pid}`;
  writeFileSync(temporary, `${secret}\n`, { mode: 0o600 });
  renameSync(temporary, secretPath);
  chmodSync(secretPath, 0o600);
  return Promise.resolve();
}

/**
 * Dev `infra:start` upgrade entry point. A proven-fresh instance may keep the
 * existing well-known fallback; any persisted instance receives a generated,
 * mode-600 config-guard transaction before Compose interpolation.
 */
export async function ensureInfraCryptoDbPasswordForInstance(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const selectedEnv = { ...env, NAUTILO_INSTANCE_ID: inst.instanceId };
  const rootDir = resolveNautiloRootDir({ env: selectedEnv });
  const instanceEnvPath = join(rootDir, "instance.env");
  const secretPath = join(rootDir, DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH);
  if (!existsSync(instanceEnvPath) && !existsSync(secretPath)) {
    return env["NAUTILO_CRYPTO_DB_PASSWORD"] ?? "nautilo_crypto";
  }
  const instanceEnvRaw = readFileSync(instanceEnvPath, "utf8");
  const secret = await ensureInfraCryptoDbPassword(
    {
      instanceEnvPath,
      instanceEnvRaw,
    },
    {
      randomHexPassword: () => randomBytes(24).toString("hex"),
      persistCryptoPassword: persistInfraCryptoDbPassword,
    },
  );
  if (
    parseEnvValue(instanceEnvRaw, "NAUTILO_CRYPTO_DB_PASSWORD") !== undefined
  ) {
    const temporary = `${instanceEnvPath}.m231-${process.pid}`;
    writeFileSync(temporary, stripCryptoPasswordLine(instanceEnvRaw), {
      mode: 0o600,
    });
    renameSync(temporary, instanceEnvPath);
    chmodSync(instanceEnvPath, 0o600);
  }
  return secret;
}

/** Shared selected-instance authority used by infra-start and server-start. */
export function resolveInstanceServiceSecrets(
  params: { instanceId: string; instanceEnvPath: string },
  env: NodeJS.ProcessEnv = process.env,
): InstanceServiceSecretPlan {
  const loaded = readConfigEnv({ path: params.instanceEnvPath });
  const values = loaded.loaded ? loaded.values : env;
  const missing = REQUIRED_SERVICE_SECRET_KEYS.filter(
    (key) => !values[key]?.trim(),
  );
  if (loaded.loaded && missing.length > 0) {
    throw new Error(
      `[instance-secrets] selected instance ${params.instanceId || "(default)"} has an incomplete instance.env; missing internal service credential(s): ${missing.join(", ")}`,
    );
  }

  return {
    instanceEnvPath: params.instanceEnvPath,
    source: loaded.loaded ? "selected-instance" : "fresh-instance-fallback",
    serviceSecrets: {
      NAUTILO_DB_PASSWORD: values["NAUTILO_DB_PASSWORD"] ?? "nautilo",
      NAUTILO_AGENT_DB_PASSWORD:
        values["NAUTILO_AGENT_DB_PASSWORD"] ?? "nautilo_agent",
      LOGTO_DB_PASSWORD: values["LOGTO_DB_PASSWORD"] ?? "logto",
    },
  };
}

/**
 * Resolve one immutable startup credential plan before Compose or a child
 * process sees any database URL. An existing selected instance.env is
 * canonical and deliberately overrides ambient values from another stack.
 */
function resolveInfraCredentialPlan(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
  options: { instanceEnvPath?: string } = {},
): InfraCredentialPlan {
  const selectedEnv = { ...env, NAUTILO_INSTANCE_ID: inst.instanceId };
  const rootDir = resolveNautiloRootDir({ env: selectedEnv });
  const instanceEnvPath = options.instanceEnvPath ?? join(rootDir, "instance.env");
  const servicePlan = resolveInstanceServiceSecrets(
    { instanceId: inst.instanceId, instanceEnvPath },
    env,
  );
  const loaded = readConfigEnv({ path: instanceEnvPath });
  const secretPath = join(
    resolve(instanceEnvPath, ".."),
    DEV_CRYPTO_DB_PASSWORD_RELATIVE_PATH,
  );
  const cryptoPassword = existsSync(secretPath)
    ? readFileSync(secretPath, "utf8").trim()
    : loaded.loaded
      ? loaded.values["NAUTILO_CRYPTO_DB_PASSWORD"]?.trim()
      : env["NAUTILO_CRYPTO_DB_PASSWORD"]?.trim();
  if (loaded.loaded && !cryptoPassword) {
    throw new Error(
      `[instance-secrets] selected instance ${inst.instanceId || "(default)"} has an incomplete instance.env; missing internal service credential(s): NAUTILO_CRYPTO_DB_PASSWORD`,
    );
  }
  const canonicalEnv: NodeJS.ProcessEnv = {
    ...env,
    ...servicePlan.serviceSecrets,
    NAUTILO_CRYPTO_DB_PASSWORD: cryptoPassword ?? "nautilo_crypto",
  };

  return {
    ...servicePlan,
    serviceSecrets: {
      ...servicePlan.serviceSecrets,
      NAUTILO_CRYPTO_DB_PASSWORD: cryptoPassword ?? "nautilo_crypto",
    },
    childEnv: {
      ...servicePlan.serviceSecrets,
      ...resolvedInstanceChildEnv(inst, canonicalEnv),
    },
  };
}

export function applyInfraComposeEnv(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
): InfraCredentialPlan {
  const plan = resolveInfraCredentialPlan(inst, env);
  for (const [key, value] of Object.entries(plan.childEnv)) {
    env[key] = value;
  }
  return plan;
}

/**
 * Compose routing for stop/status/office commands. These operations need the
 * selected project and ports but must remain usable when credentials are
 * incomplete; they neither start database dependents nor mutate roles.
 */
export function applyInfraComposeRoutingEnv(
  inst: ResolvedInstance,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const routing = resolvedInstanceChildEnv(inst, env);
  for (const [key, value] of Object.entries(routing)) {
    if (key.startsWith("DB_")) continue;
    env[key] = value;
  }
}

/** Exact Compose-managed persistent volumes whose presence proves prior state. */
export function infraPersistentVolumeNames(inst: ResolvedInstance): string[] {
  return [
    `${inst.compose.projectName}_nautilo_pgdata`,
    `${inst.compose.projectName}_pgdata`,
  ];
}

export type InfraVolumeExists = (volume: string) => boolean;

export function classifyDockerVolumeInspect(result: {
  status: number | null;
  stderr: string;
}): boolean {
  if (result.status === 0) return true;
  if (/\bno such volume\b/i.test(result.stderr)) return false;
  throw new Error(
    "[instance-secrets] cannot prove this instance is fresh because Docker volume inspection failed; credential fallbacks were refused",
  );
}

function dockerVolumeExists(volume: string): boolean {
  const result = spawnSync("docker", ["volume", "inspect", volume], {
    encoding: "utf8",
  });
  return classifyDockerVolumeInspect({
    status: result.status,
    stderr: result.stderr,
  });
}

/**
 * Development defaults are safe only before an instance has persisted state.
 * Keep this guard shared by infra-start and direct/warm server-start so
 * `dev-stack --no-infra` cannot silently authenticate with invented defaults.
 */
export function assertServiceSecretFallbackIsFresh(
  inst: ResolvedInstance,
  plan: InstanceServiceSecretPlan,
  volumeExists: InfraVolumeExists = dockerVolumeExists,
): void {
  if (plan.source !== "fresh-instance-fallback") return;
  const persisted = infraPersistentVolumeNames(inst).filter(volumeExists);
  if (persisted.length === 0) return;
  throw new Error(
    `[instance-secrets] refusing development credential fallbacks for existing instance ${inst.instanceId || "(default)"}; instance.env is missing while persistent volume(s) exist: ${persisted.join(", ")}`,
  );
}

function describeInfraInstanceMode(inst: ResolvedInstance): string {
  return inst.instanceId.trim() === ""
    ? "shared default"
    : `isolated named (${inst.instanceId})`;
}

export function formatInfraInstanceBanner(inst: ResolvedInstance): string {
  const c = inst.compose.containers;
  return [
    `[infra] instance: ${describeInfraInstanceMode(inst)}`,
    `[infra] data dir: ${inst.instanceId.trim() === "" ? "~/.nautilo" : `~/.nautilo-${inst.instanceId}`}`,
    `[infra] compose project: ${inst.compose.projectName}`,
    `[infra] server: ${inst.server.url}  workbench: ${inst.workbench.url}`,
    `[infra] db: localhost:${inst.db.postgresHostPort}`,
    `[infra] logto: core localhost:${inst.logto.corePort}  admin localhost:${inst.logto.adminPort}  db localhost:${inst.logto.dbPort}`,
    `[infra] openconnector: ${resolvedInstanceChildEnv(inst)["NAUTILO_OPENCONNECTOR_BASE_URL"]}`,
    `[infra] containers: ${c.legacyPostgres}, ${c.logtoPostgres}, ${c.logtoCore}`,
  ].join("\n");
}

/**
 * `docker compose` argv prefix for the Logto stack file, including `-p`.
 * Tail (`--profile auth up -d`, `down`, …) is appended by callers.
 */
export function dockerComposeNautiloPrefixRaw(projectName: string): string[] {
  return ["compose", "-p", projectName, "-f", NAUTILO_COMPOSE_FILE];
}

export function dockerComposeNautiloPrefixArgs(inst: ResolvedInstance): string[] {
  return dockerComposeNautiloPrefixRaw(inst.compose.projectName);
}

/** Legacy `packages/db` dev stack (`legacy-postgres`). */
export function dockerComposeDbDevPrefixRaw(projectName: string): string[] {
  return ["compose", "-p", projectName, "-f", NAUTILO_DB_COMPOSE_FILE];
}
