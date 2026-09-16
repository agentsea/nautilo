import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { transaction } from "@nautilo/config-guard";

const execFileAsync = promisify(execFile);

// Minimal local typing for the `postgres` package surface we touch — avoids
// adding `postgres` as a direct devDep just for type resolution. The runtime
// module is loaded via `createRequire` from `@nautilo/local`'s node_modules
// (it already depends on `postgres`). Only `tagged-template SELECT` and
// `end()` are used.
type SqlClient = {
  <T = Record<string, unknown>>(
    strings: TemplateStringsArray,
    ...values: unknown[]
  ): Promise<T[]>;
  end: (opts?: { timeout?: number }) => Promise<void>;
};

type PostgresFn = (config: {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  connect_timeout: number;
  max: number;
}) => SqlClient;

function loadPostgres(): PostgresFn {
  const requireFn = createRequire(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../../bin/nautilo-local/package.json",
    ),
  );
  // postgres-js's CJS export is the function itself.
  return requireFn("postgres") as unknown as PostgresFn;
}

const SENTINEL_KEY = "NAUTILO_M116_DB_PASSWORDS_GENERATED_AT";
export const CRYPTO_DB_PASSWORD_RELATIVE_PATH =
  ".bootstrap/nautilo-crypto-db-password";

const WELL_KNOWN_PASSWORDS: DbPasswords = {
  appDbPassword: "postgres",
  postgresPassword: "postgres",
  nautilo: "nautilo",
  logto: "logto",
  nautiloAgent: "nautilo_agent",
  nautiloCrypto: "nautilo_crypto",
};

export interface DbPasswords {
  appDbPassword: string;
  postgresPassword: string;
  nautilo: string;
  logto: string;
  nautiloAgent: string;
  nautiloCrypto: string;
}

export interface EnsureDbPasswordsDeps {
  /** Reads `~/.nautilo${suffix}/instance.env` (returns "" if missing). */
  readInstanceEnv: (instanceRootDir: string) => Promise<string>;
  /** Probes whether the compose project's app_pgdata volume already exists. */
  inspectAppPgdataVolume: (projectName: string) => Promise<boolean>;
  /** Probes a live cluster for the nautilo_agent role. Returns "absent" / "present" / null when unreachable. */
  probeAgentRole: (args: {
    host: string;
    port: number;
    user: string;
    password: string;
  }) => Promise<"absent" | "present" | null>;
  /** Persists 5 passwords + sentinel via config-guard.transaction(). */
  writePasswordsToInstanceEnv: (
    passwords: DbPasswords,
    generatedAt: string,
  ) => Promise<void>;
  /** Reads the role-only secret authority, which is never mounted into server. */
  readCryptoDbPassword?: (
    instanceRootDir: string,
  ) => Promise<string | undefined>;
  /** Persists the role-only secret authority mode 600. */
  writeCryptoDbPassword?: (
    instanceRootDir: string,
    password: string,
  ) => Promise<void>;
  /** Removes the legacy copy from server-mounted instance.env after migration. */
  removeCryptoDbPasswordFromInstanceEnv?: (
    instanceRootDir: string,
  ) => Promise<void>;
  /** Random 48-char hex generator. Default uses crypto.randomBytes(24). */
  randomHexPassword: () => string;
  /** Wall clock for the sentinel. */
  now: () => Date;
}

function stripCryptoPasswordFromDotenv(raw: string): string {
  return raw
    .split(/\r?\n/)
    .filter(
      (line) =>
        line.trim().split("=", 1)[0] !== "NAUTILO_CRYPTO_DB_PASSWORD",
    )
    .join("\n")
    .replace(/\n+$/, "");
}

function validateCryptoPassword(secret: string): string {
  if (secret.trim() === "" || /[\r\n]/.test(secret)) {
    throw new Error("crypto database credential is empty or multiline");
  }
  return secret;
}

async function reconcileCryptoPasswordAuthority(
  args: EnsureDbPasswordsArgs,
  deps: EnsureDbPasswordsDeps,
  legacyPassword: string | undefined,
): Promise<string> {
  const persisted = await deps.readCryptoDbPassword?.(args.instanceRootDir);
  const secret = validateCryptoPassword(
    persisted ?? legacyPassword ?? deps.randomHexPassword(),
  );
  if (persisted === undefined) {
    if (!deps.writeCryptoDbPassword) {
      throw new Error(
        "ensureDbPasswords: role-only crypto credential writer is unavailable",
      );
    }
    await deps.writeCryptoDbPassword(args.instanceRootDir, secret);
  }
  if (legacyPassword !== undefined) {
    if (!deps.removeCryptoDbPasswordFromInstanceEnv) {
      throw new Error(
        "ensureDbPasswords: cannot remove legacy crypto credential from server-mounted instance.env",
      );
    }
    await deps.removeCryptoDbPasswordFromInstanceEnv(args.instanceRootDir);
  }
  return secret;
}

export interface EnsureDbPasswordsArgs {
  /** Operator-laptop `~/.nautilo${suffix}` — not the remote droplet root. */
  instanceRootDir: string;
  composeProjectName: string;
  appPostgresHostPort: number;
  appPostgresHost?: string;
  /** When set, `docker volume inspect` runs against this daemon (remote deploy). */
  dockerHost?: string;
}

function parseDotenv(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (t === "" || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const key = t.slice(0, eq).trim();
    let value = t.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key) out[key] = value;
  }
  return out;
}

function envValue(
  parsed: Record<string, string>,
  key: string,
): string | undefined {
  const v = parsed[key];
  if (v === undefined || v.trim() === "") return undefined;
  return v;
}

export function ensureCryptoPasswordInDotenv(
  raw: string,
  generateSecret: () => string,
): { raw: string; secret: string } {
  const parsed = parseDotenv(raw);
  const existing = envValue(parsed, "NAUTILO_CRYPTO_DB_PASSWORD");
  if (existing !== undefined) {
    return { raw: stripCryptoPasswordFromDotenv(raw), secret: existing };
  }
  const secret = generateSecret();
  if (secret.trim() === "" || /[\r\n]/.test(secret)) {
    throw new Error(
      "ensureCryptoPasswordInDotenv: generated credential is empty or multiline",
    );
  }
  return {
    raw: stripCryptoPasswordFromDotenv(raw),
    secret,
  };
}

export function setCryptoPasswordInDotenv(raw: string, secret: string): string {
  if (secret.trim() === "" || /[\r\n]/.test(secret)) {
    throw new Error(
      "setCryptoPasswordInDotenv: credential is empty or multiline",
    );
  }
  const kept = raw
    .split(/\r?\n/)
    .filter((line) => line.trim().split("=", 1)[0] !== "NAUTILO_CRYPTO_DB_PASSWORD")
    .join("\n")
    .replace(/\n+$/, "");
  return `${kept === "" ? "" : `${kept}\n`}NAUTILO_CRYPTO_DB_PASSWORD=${secret}\n`;
}

function passwordsFromParsed(parsed: Record<string, string>): DbPasswords {
  const missing: string[] = [];
  const appDbPassword = envValue(parsed, "APP_DB_PASSWORD");
  const postgresPassword = envValue(parsed, "POSTGRES_PASSWORD");
  const nautilo = envValue(parsed, "NAUTILO_DB_PASSWORD");
  const logto = envValue(parsed, "LOGTO_DB_PASSWORD");
  const nautiloAgent = envValue(parsed, "NAUTILO_AGENT_DB_PASSWORD");
  const nautiloCrypto = envValue(parsed, "NAUTILO_CRYPTO_DB_PASSWORD");

  if (!appDbPassword) missing.push("APP_DB_PASSWORD");
  if (!postgresPassword) missing.push("POSTGRES_PASSWORD");
  if (!nautilo) missing.push("NAUTILO_DB_PASSWORD");
  if (!logto) missing.push("LOGTO_DB_PASSWORD");
  if (!nautiloAgent) missing.push("NAUTILO_AGENT_DB_PASSWORD");

  if (missing.length > 0) {
    throw new Error(
      `ensureDbPasswords: ${SENTINEL_KEY} is set but password key(s) missing from instance.env: ${missing.join(", ")}`,
    );
  }

  return {
    appDbPassword: appDbPassword!,
    postgresPassword: postgresPassword!,
    nautilo: nautilo!,
    logto: logto!,
    nautiloAgent: nautiloAgent!,
    nautiloCrypto: nautiloCrypto ?? "",
  };
}

async function generateAndPersist(
  args: EnsureDbPasswordsArgs,
  deps: EnsureDbPasswordsDeps,
): Promise<DbPasswords> {
  const passwords: DbPasswords = {
    appDbPassword: deps.randomHexPassword(),
    postgresPassword: deps.randomHexPassword(),
    nautilo: deps.randomHexPassword(),
    logto: deps.randomHexPassword(),
    nautiloAgent: deps.randomHexPassword(),
    nautiloCrypto: deps.randomHexPassword(),
  };
  const generatedAt = deps.now().toISOString();
  if (!deps.writeCryptoDbPassword) {
    throw new Error(
      "ensureDbPasswords: role-only crypto credential writer is unavailable",
    );
  }
  await deps.writeCryptoDbPassword(args.instanceRootDir, passwords.nautiloCrypto);
  await deps.writePasswordsToInstanceEnv(passwords, generatedAt);
  return passwords;
}

export async function ensureDbPasswords(
  args: EnsureDbPasswordsArgs,
  deps: EnsureDbPasswordsDeps,
): Promise<DbPasswords> {
  const raw = await deps.readInstanceEnv(args.instanceRootDir);
  const parsed = parseDotenv(raw);
  const sentinel = envValue(parsed, SENTINEL_KEY);

  // Branch 1 — sentinel present: return persisted passwords, no mutation.
  if (sentinel !== undefined) {
    const persisted = passwordsFromParsed(parsed);
    const cryptoPassword = await reconcileCryptoPasswordAuthority(
      args,
      deps,
      persisted.nautiloCrypto || undefined,
    );
    return {
      ...persisted,
      nautiloCrypto: cryptoPassword,
    };
  }

  const volumeExists = await deps.inspectAppPgdataVolume(args.composeProjectName);

  // Branch 2 / 5 — no volume: greenfield or partial-write edge case.
  // Partial keys in instance.env are ignored; fresh passwords overwrite via transaction.
  if (!volumeExists) {
    return generateAndPersist(args, deps);
  }

  // Branch 3 / 4 — volume exists: probe cluster for nautilo_agent role.
  const host = args.appPostgresHost ?? "127.0.0.1";
  const port = args.appPostgresHostPort;
  const probePassword = envValue(parsed, "APP_DB_PASSWORD") ?? "postgres";
  const probeResult = await deps.probeAgentRole({
    host,
    port,
    user: "postgres",
    password: probePassword,
  });

  if (probeResult === "present") {
    const upgraded = {
      ...WELL_KNOWN_PASSWORDS,
      nautiloCrypto: deps.randomHexPassword(),
    };
    if (!deps.writeCryptoDbPassword) {
      throw new Error(
        "ensureDbPasswords: role-only crypto credential writer is unavailable",
      );
    }
    await deps.writeCryptoDbPassword(args.instanceRootDir, upgraded.nautiloCrypto);
    await deps.writePasswordsToInstanceEnv(upgraded, deps.now().toISOString());
    return upgraded;
  }

  if (probeResult === "absent") {
    return generateAndPersist(args, deps);
  }

  // Branch 4 — volume exists but cluster unreachable.
  throw new Error(
    `ensureDbPasswords: app_pgdata volume exists for project "${args.composeProjectName}" but the postgres cluster is unreachable on ${host}:${port}; bring postgres up or fix connectivity before deploying`,
  );
}

export function defaultEnsureDbPasswordsDeps(opts?: {
  dockerHost?: string;
}): EnsureDbPasswordsDeps {
  const dockerEnv =
    opts?.dockerHost !== undefined
      ? { ...process.env, DOCKER_HOST: opts.dockerHost }
      : process.env;
  return {
    readInstanceEnv: async (instanceRootDir) => {
      try {
        return await readFile(join(instanceRootDir, "instance.env"), "utf8");
      } catch {
        return "";
      }
    },
    readCryptoDbPassword: async (instanceRootDir) => {
      try {
        const value = await readFile(
          join(instanceRootDir, CRYPTO_DB_PASSWORD_RELATIVE_PATH),
          "utf8",
        );
        return value.trim() || undefined;
      } catch {
        return undefined;
      }
    },
    writeCryptoDbPassword: async (instanceRootDir, password) => {
      validateCryptoPassword(password);
      const target = join(
        instanceRootDir,
        CRYPTO_DB_PASSWORD_RELATIVE_PATH,
      );
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.tmp-${process.pid}`;
      await writeFile(temporary, `${password}\n`, { mode: 0o600 });
      await rename(temporary, target);
      await chmod(target, 0o600);
    },
    removeCryptoDbPasswordFromInstanceEnv: async (instanceRootDir) => {
      const previousTarget = process.env["NAUTILO_DOTENV_PATH"];
      process.env["NAUTILO_DOTENV_PATH"] = join(
        instanceRootDir,
        "instance.env",
      );
      try {
        const result = await transaction({
          actor: "cli",
          reason:
            "M231: migrate dormant crypto role credential to role-only authority",
          healthCheck: "none",
          overwrite: true,
          operations: [
            { type: "remove", key: "NAUTILO_CRYPTO_DB_PASSWORD" },
          ],
        });
        if (!result.success) {
          throw new Error(result.error ?? "unknown error");
        }
      } finally {
        if (previousTarget === undefined) {
          delete process.env["NAUTILO_DOTENV_PATH"];
        } else {
          process.env["NAUTILO_DOTENV_PATH"] = previousTarget;
        }
      }
    },
    inspectAppPgdataVolume: async (projectName) => {
      try {
        await execFileAsync(
          "docker",
          ["volume", "inspect", `${projectName}_app_pgdata`],
          { env: dockerEnv },
        );
        return true;
      } catch {
        return false;
      }
    },
    probeAgentRole: async ({ host, port, user, password }) => {
      const postgres = loadPostgres();
      const sql = postgres({
        host,
        port,
        user,
        password,
        database: "postgres",
        connect_timeout: 3,
        max: 1,
      });
      try {
        const rows = await sql`SELECT 1 FROM pg_roles WHERE rolname='nautilo_agent'`;
        await sql.end({ timeout: 1 });
        return rows.length > 0 ? "present" : "absent";
      } catch {
        try {
          await sql.end({ timeout: 1 });
        } catch {
          /* ignore */
        }
        return null;
      }
    },
    writePasswordsToInstanceEnv: async (passwords, generatedAt) => {
      const result = await transaction({
        actor: "cli",
        reason: "M116: random per-instance DB passwords",
        healthCheck: "none",
        overwrite: true,
        operations: [
          { type: "set", key: "APP_DB_PASSWORD", value: passwords.appDbPassword },
          {
            type: "set",
            key: "POSTGRES_PASSWORD",
            value: passwords.postgresPassword,
          },
          { type: "set", key: "NAUTILO_DB_PASSWORD", value: passwords.nautilo },
          { type: "set", key: "LOGTO_DB_PASSWORD", value: passwords.logto },
          {
            type: "set",
            key: "NAUTILO_AGENT_DB_PASSWORD",
            value: passwords.nautiloAgent,
          },
          {
            type: "set",
            key: SENTINEL_KEY,
            value: generatedAt,
          },
        ],
      });
      if (!result.success) {
        throw new Error(
          `ensureDbPasswords: failed to persist passwords: ${result.error ?? "unknown error"}`,
        );
      }
    },
    randomHexPassword: () => randomBytes(24).toString("hex"),
    now: () => new Date(),
  };
}
