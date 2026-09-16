import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseToml } from "smol-toml";
import type { SecretField } from "@nautilo/api-client";

import {
  DeployConfigV1,
  type DeployConfig,
} from "./deploy-schema.ts";

const INSTANCE_ENV_REMEDIATION =
  "this belongs in ~/.nautilo${suffix}/instance.env, not deploy.toml";

/** Forbidden TOML table names at the document root (instance runtime surface). */
const FORBIDDEN_TOP_LEVEL_SECTIONS = new Set([
  "network",
  "topology",
  "ports",
  "logto",
  "db",
  "database",
  "server",
  "hosting",
]);

/** Keys that must never appear in deploy.toml (object keys, any nesting depth). */
const FORBIDDEN_FLAT_KEY_EXACT = new Set([
  "NAUTILO_PORT",
  "NAUTILO_HOST",
  "NAUTILO_INSTANCE_ID",
  "NAUTILO_HOSTING_MODE",
  "NAUTILO_BOOTSTRAP_TOKEN",
  "DB_CONNECTION_STRING",
  "DB_DIRECT_CONNECTION",
  "NAUTILO_DB_PORT",
  "NAUTILO_NEON_PROXY_PORT",
  "NAUTILO_LOGTO_DB_PORT",
  "NAUTILO_LOGTO_PORT",
  "NAUTILO_LOGTO_ADMIN_PORT",
  "COMPOSE_PROJECT_NAME",
]);

function isForbiddenFlatKeyName(key: string): boolean {
  if (key.startsWith("LOGTO_")) return true;
  return FORBIDDEN_FLAT_KEY_EXACT.has(key);
}

function formatFieldPath(path: string): string {
  return path === "" ? "(root)" : path;
}

function assertNoForbiddenDeployContent(
  value: unknown,
  path: string,
  depth: number,
): void {
  if (value === null || typeof value !== "object") return;

  if (Array.isArray(value)) {
    value.forEach((item, i) =>
      assertNoForbiddenDeployContent(item, `${path}[${i}]`, depth + 1),
    );
    return;
  }

  const o = value as Record<string, unknown>;

  if (depth === 0) {
    for (const key of Object.keys(o)) {
      if (FORBIDDEN_TOP_LEVEL_SECTIONS.has(key.toLowerCase())) {
        throw new Error(
          `${formatFieldPath(key)}: ${INSTANCE_ENV_REMEDIATION}`,
        );
      }
    }
  }

  for (const [key, child] of Object.entries(o)) {
    if (isForbiddenFlatKeyName(key)) {
      throw new Error(
        `${formatFieldPath(path ? `${path}.${key}` : key)}: ${INSTANCE_ENV_REMEDIATION}`,
      );
    }
    assertNoForbiddenDeployContent(child, path ? `${path}.${key}` : key, depth + 1);
  }

  if (depth === 0 && Array.isArray(o["providers"])) {
    o["providers"].forEach((entry, i) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return;
      const pk = (entry as Record<string, unknown>)["key"];
      if (typeof pk !== "string") return;
      if (pk.startsWith("LOGTO_")) {
        throw new Error(
          `providers[${i}].key: "${pk}" is a Logto runtime key, not a provider — ${INSTANCE_ENV_REMEDIATION}`,
        );
      }
      if (isForbiddenFlatKeyName(pk)) {
        throw new Error(
          `providers[${i}].key: "${pk}" ${INSTANCE_ENV_REMEDIATION}`,
        );
      }
    });
  }
}

export class EnvVarMissingError extends Error {
  constructor(
    public readonly field: string,
    public readonly varName: string,
  ) {
    super(`EnvVarMissingError(field=${field}, var=${varName})`);
    this.name = "EnvVarMissingError";
  }
}

export type EnvLookup = (varName: string) => string | undefined;

function resolveSecret(
  fieldPath: string,
  field: SecretField,
  lookup: EnvLookup,
): { value: string } {
  if ("value" in field) {
    return { value: field.value };
  }
  const v = lookup(field.fromEnv)?.trim();
  if (!v) {
    throw new EnvVarMissingError(fieldPath, field.fromEnv);
  }
  return { value: v };
}

function assertDeployFileMode600(filePath: string): void {
  if (process.platform === "win32") return;
  const st = statSync(filePath);
  const mode = st.mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(
      "setup file must be chmod 600 (contains a password).",
    );
  }
}

function assertPathNotInsideGitWorkTree(filePath: string): void {
  let dir = dirname(resolve(filePath));
  for (;;) {
    if (existsSync(join(dir, ".git"))) {
      throw new Error(
        "refusing to load deploy config from inside a git work tree (operator secrets); move the file outside the repository.",
      );
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

export function parseDeployConfigFromPath(filePath: string): DeployConfig {
  assertDeployFileMode600(filePath);
  assertPathNotInsideGitWorkTree(filePath);

  const raw = readFileSync(filePath, "utf8");
  const lower = filePath.toLowerCase();
  const parsed: unknown =
    lower.endsWith(".json") ? JSON.parse(raw) : parseToml(raw);

  if (typeof parsed === "object" && parsed !== null) {
    const sv = (parsed as Record<string, unknown>)["schemaVersion"];
    if (sv !== undefined && sv !== 1) {
      throw new Error(
        `unsupported template schema version (expected 1, got ${JSON.stringify(sv)})`,
      );
    }
  }

  assertNoForbiddenDeployContent(parsed, "", 0);

  const validated = DeployConfigV1.safeParse(parsed);
  if (!validated.success) {
    throw new Error(validated.error.message);
  }
  return validated.data;
}

export type ResolvedDeployConfig = Omit<DeployConfig, "admin" | "providers"> & {
  admin: Omit<DeployConfig["admin"], "password" | "pin"> & {
    password: { value: string };
    pin?: { value: string };
  };
  providers: Array<{ key: string; value: { value: string } }>;
};

export function resolveDeployConfig(
  d: DeployConfig,
  lookup: EnvLookup,
): ResolvedDeployConfig {
  const password = resolveSecret("admin.password", d.admin.password, lookup);
  if (password.value.length < 8) {
    throw new Error(
      "admin.password: value must be ≥ 8 characters when inlined",
    );
  }

  let pin: { value: string } | undefined;
  if (d.admin.pin !== undefined) {
    pin = resolveSecret("admin.pin", d.admin.pin, lookup);
    if (!/^\d{6,8}$/.test(pin.value)) {
      throw new Error("admin.pin must be 6–8 digits after resolution.");
    }
  }

  const providers = d.providers.map((p, i) => ({
    key: p.key,
    value: resolveSecret(`providers[${i}].value`, p.value, lookup),
  }));

  return {
    ...d,
    admin: {
      handle: d.admin.handle,
      displayName: d.admin.displayName,
      password,
      ...(pin !== undefined ? { pin } : {}),
    },
    providers,
  };
}
