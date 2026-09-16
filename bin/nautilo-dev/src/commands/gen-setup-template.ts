/**
 * Dev-only fixture generator for `nautilo setup` smoke tests (not shipped in @nautilo/cli).
 */
import { createHash, randomBytes, randomInt } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { stringify } from "smol-toml";
import { getKeyDefinition, KEY_REGISTRY } from "@nautilo/config-guard";
import { SetupTemplateV1 } from "@nautilo/api-client";
import {
  bootstrapAdminPasswordKey,
  bootstrapPinKey,
  bootstrapDirForInstance,
  writeBootstrapAdminPassword,
  writeBootstrapAdminPin,
  defaultOperatorSecretsPath,
  loadOperatorSecrets,
} from "@nautilo/operator-secrets";

function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 8);
}

function parseProviderSpec(spec: string): { key: string; value: { fromEnv: string } } {
  const eq = spec.indexOf("=");
  if (eq === -1) throw new Error(`invalid --provider (expected key=env:VAR): ${spec}`);
  const id = spec.slice(0, eq).trim();
  const rhs = spec.slice(eq + 1).trim();
  const envPrefix = "env:";
  if (!rhs.startsWith(envPrefix)) {
    throw new Error(`invalid --provider value (expected env:VAR): ${spec}`);
  }
  const envVar = rhs.slice(envPrefix.length).trim();
  const def = getKeyDefinition(id);
  if (!def) {
    throw new Error(`unknown provider id '${id}' (not in KEY_REGISTRY)`);
  }
  if (def.envVar !== envVar) {
    throw new Error(
      `--provider ${id}: env var must be ${def.envVar} for this registry entry (got ${envVar})`,
    );
  }
  return { key: def.envVar, value: { fromEnv: envVar } };
}

function randomSixDigitPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

export async function genSetupTemplateCmd(args: {
  instance: string;
  randomizeGenie?: boolean | undefined;
  seed?: number | undefined;
  providers: string[];
  out: string;
  passwordEnv?: string | undefined;
  pinEnv?: string | undefined;
  claimCode?: string | undefined;
  claimEnv?: string | undefined;
  handle?: string | undefined;
  displayName?: string | undefined;
  secretsFile?: string | undefined;
  noSecretsFile?: boolean | undefined;
  /**
   * When true, scan the operator secrets file (resolved from
   * `--secrets-file` or `defaultOperatorSecretsPath()`) and emit a
   * `[[providers]]` entry per recognized `KEY_REGISTRY.envVar`
   * present. Additive with explicit `--provider` flags; explicit
   * flags win on duplicates by provider id.
   */
  allProvidersFromSecrets?: boolean | undefined;
}): Promise<number> {
  const inst = args.instance.trim();
  const instanceDir = join(homedir(), `.nautilo-${inst}`);
  try {
    statSync(instanceDir);
  } catch {
    throw new Error(`instance directory does not exist: ${instanceDir}`);
  }

  const h = shortHash(inst);
  const handle = args.handle ?? `smoke_admin_${h}`;
  const displayName = args.displayName ?? handle.replace(/_/g, " ");

  const adminPwKey = bootstrapAdminPasswordKey(inst);
  const pinKey = bootstrapPinKey(inst);

  const useSecretsFile = !args.noSecretsFile;
  const secretsPath = args.secretsFile ?? defaultOperatorSecretsPath();

  let passwordField: { value: string } | { fromEnv: string };
  let generatedPassword: string | undefined;
  if (args.passwordEnv) {
    passwordField = { fromEnv: args.passwordEnv };
  } else if (useSecretsFile) {
    const pw = randomBytes(12).toString("base64url").slice(0, 22);
    generatedPassword = `${pw}Aa1`;
    passwordField = { fromEnv: adminPwKey };
  } else {
    const pw = randomBytes(12).toString("base64url").slice(0, 22);
    passwordField = { value: `${pw}Aa1` };
    generatedPassword = passwordField.value;
  }

  let pinField: { value: string } | { fromEnv: string };
  let generatedPin: string | undefined;
  if (args.pinEnv) {
    pinField = { fromEnv: args.pinEnv };
  } else if (useSecretsFile) {
    generatedPin = randomSixDigitPin();
    pinField = { fromEnv: pinKey };
  } else {
    generatedPin = randomSixDigitPin();
    pinField = { value: generatedPin };
  }

  let inviteField: { value: string } | { fromEnv: string };
  if (args.claimCode) {
    inviteField = { value: args.claimCode.trim() };
  } else if (args.claimEnv) {
    inviteField = { fromEnv: args.claimEnv };
  } else {
    const claimPath = join(homedir(), `.nautilo-${inst}`, "claim-invite.txt");
    let raw: string;
    try {
      raw = readFileSync(claimPath, "utf8");
    } catch {
      throw new Error(`missing claim invite at ${claimPath} (pass --claim-code or --claim-env)`);
    }
    const tokenLine = raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => /^(redeem_input|token)\s*:/i.test(l));
    const token = tokenLine
      ? tokenLine.split(":").slice(1).join(":").trim()
      : raw.trim();
    if (!/^inv_/.test(token)) {
      throw new Error(
        `could not extract invite token from ${claimPath} (looked for 'redeem_input:' line; got ${JSON.stringify(token.slice(0, 40))}…)`,
      );
    }
    inviteField = { value: token };
  }

  // Track explicit ids first so --all-providers-from-secrets can
  // skip duplicates (explicit flags win).
  const explicitProviderIds = new Set<string>();
  for (const spec of args.providers) {
    const eq = spec.indexOf("=");
    if (eq !== -1) explicitProviderIds.add(spec.slice(0, eq).trim());
  }

  const augmentedProviderSpecs: string[] = [...args.providers];
  if (args.allProvidersFromSecrets) {
    let loaded: Record<string, string> = {};
    try {
      loaded = await loadOperatorSecrets(secretsPath);
    } catch (e) {
      throw new Error(
        `--all-providers-from-secrets: failed to load ${secretsPath}: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    const autoIds: string[] = [];
    for (const def of KEY_REGISTRY) {
      if (explicitProviderIds.has(def.id)) continue;
      if (loaded[def.envVar] === undefined) continue;
      augmentedProviderSpecs.push(`${def.id}=env:${def.envVar}`);
      autoIds.push(def.id);
    }
    if (autoIds.length > 0) {
      process.stderr.write(
        `[gen-setup-template] auto-included ${autoIds.length} provider${autoIds.length === 1 ? "" : "s"} from ${secretsPath}: ${autoIds.join(", ")}\n`,
      );
    } else {
      process.stderr.write(
        `[gen-setup-template] --all-providers-from-secrets: no recognized provider keys present in ${secretsPath}\n`,
      );
    }
  }

  const providers = augmentedProviderSpecs.map(parseProviderSpec);

  const genie = args.randomizeGenie
    ? {
        mode: "randomize" as const,
        ...(args.seed !== undefined ? { seed: args.seed } : {}),
      }
    : undefined;

  const raw = {
    schemaVersion: 1 as const,
    admin: {
      handle,
      displayName,
      password: passwordField,
      pin: pinField,
    },
    claim: {
      inviteCode: inviteField,
    },
    providers,
    ...(genie ? { genie } : {}),
  };

  const parsed = SetupTemplateV1.safeParse(raw);
  if (!parsed.success) {
    throw new Error(parsed.error.message);
  }

  const toml = stringify(parsed.data as Record<string, unknown>);

  const bootstrapDir = bootstrapDirForInstance(inst);
  if (useSecretsFile) {
    if (generatedPassword !== undefined) {
      writeBootstrapAdminPassword(bootstrapDir, generatedPassword);
    }
    if (generatedPin !== undefined) {
      writeBootstrapAdminPin(bootstrapDir, generatedPin);
    }
  }

  if (args.out === "-") {
    process.stdout.write(`${toml}\n`);
    if (useSecretsFile && (generatedPassword !== undefined || generatedPin !== undefined)) {
      const n = (generatedPassword !== undefined ? 1 : 0) + (generatedPin !== undefined ? 1 : 0);
      process.stderr.write(
        `[gen-setup-template] wrote (stdout) + ${n} file${n === 1 ? "" : "s"} to ${bootstrapDir}\n`,
      );
    } else if (!args.passwordEnv && !useSecretsFile) {
      process.stderr.write(
        `[gen-setup-template] generated password (dev): ${(passwordField as { value: string }).value}\n`,
      );
    }
    if (!useSecretsFile && generatedPin !== undefined && "value" in pinField) {
      process.stderr.write(`[gen-setup-template] generated PIN (dev): ${generatedPin}\n`);
    }
    return 0;
  }

  const parent = dirname(args.out);
  try {
    statSync(parent);
  } catch {
    throw new Error(`parent directory does not exist: ${parent}`);
  }

  writeFileSync(args.out, `${toml}\n`, { mode: 0o600 });
  process.stderr.write(`[gen-setup-template] wrote ${args.out} (mode 0600)\n`);
  if (useSecretsFile && (generatedPassword !== undefined || generatedPin !== undefined)) {
    const n = (generatedPassword !== undefined ? 1 : 0) + (generatedPin !== undefined ? 1 : 0);
    process.stderr.write(
      `[gen-setup-template] wrote ${args.out} + ${n} file${n === 1 ? "" : "s"} to ${bootstrapDir}\n`,
    );
  } else if (!args.passwordEnv && !useSecretsFile) {
    process.stderr.write(
      `[gen-setup-template] generated password (dev): ${(passwordField as { value: string }).value}\n`,
    );
  }
  if (!useSecretsFile && generatedPin !== undefined && "value" in pinField) {
    process.stderr.write(`[gen-setup-template] generated PIN (dev): ${generatedPin}\n`);
  }
  return 0;
}
