import * as nodeFs from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  PERSONAL_PROVIDER_CUSTODY_ENV,
  createPersonalProviderCustody,
  parsePersonalProviderCustody,
  personalProviderCustodyFromEnvFile,
  serializePersonalProviderCustody,
  type PersonalProviderCredentialDbEvidence,
  type PersonalProviderCustody,
} from "@nautilo/operator-secrets";
export {
  assertPersonalProviderCustodyHealth,
  assertPersonalProviderRestoreCustody,
  buildPersonalProviderCustodyBackupEvidence,
  readPersonalProviderCredentialEvidenceFromDump,
  type PersonalProviderCredentialDbEvidence,
  type PersonalProviderCustodyBackupEvidence,
  type PersonalProviderCustodyHealthEvidence,
} from "@nautilo/operator-secrets";
import { shellQuote } from "./remote-exec.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface EnsurePersonalProviderCustodyArgs {
  instanceRootDir: string;
  inspectDatabase: () => Promise<PersonalProviderCredentialDbEvidence>;
}

export interface EnsurePersonalProviderCustodyDeps {
  withProvisioningLock: <T>(
    instanceRootDir: string,
    operation: () => Promise<T>,
  ) => Promise<T>;
  readInstanceEnv: (instanceRootDir: string) => Promise<string>;
  writeInstanceEnv: (instanceRootDir: string, raw: string) => Promise<void>;
  createCustody: () => PersonalProviderCustody;
}

const TABLE_ABSENT_SENTINEL = "__NAUTILO_PERSONAL_PROVIDER_TABLE_ABSENT__";

const shellEnvAssignmentHelpers = [
  'custody_count() { awk -v key="$custody_key" \'{ line=$0; sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); if (index(line,key)==1) { rest=substr(line,length(key)+1); if (rest ~ /^[[:space:]]*=/) n++ } } END { print n+0 }\' "$1"; }',
  'read_custody() { awk -v key="$custody_key" \'{ line=$0; sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); if (index(line,key)==1) { rest=substr(line,length(key)+1); if (rest ~ /^[[:space:]]*=/) { sub(/^[[:space:]]*=[[:space:]]*/, "", rest); print rest } } }\' "$1"; }',
  'strip_custody() { awk -v key="$custody_key" \'{ line=$0; sub(/^[[:space:]]*/, "", line); sub(/^export[[:space:]]+/, "", line); if (index(line,key)==1) { rest=substr(line,length(key)+1); if (rest ~ /^[[:space:]]*=/) next } print }\' "$1"; }',
  "normalize_custody() { printf %s \"$1\" | sed \"s/^'\\(.*\\)'$/\\1/\"; }",
].join("; ");

const custodyJsonPattern =
  '^\\{"formatVersion":1,"keyId":"[[:xdigit:]]{8}-[[:xdigit:]]{4}-[1-8][[:xdigit:]]{3}-[89abAB][[:xdigit:]]{3}-[[:xdigit:]]{12}","keyHex":"[[:xdigit:]]{64}"\\}$';

export function buildReadConnectedPersonalProviderCredentialEvidenceScript(
  psqlCommand: string,
): string {
  const relationQuery = shellQuote(
    "SELECT coalesce(to_regclass('public.personal_provider_credentials')::text, '');",
  );
  const evidenceQuery = shellQuote(
    "SELECT json_build_object('rowCount', count(*), 'keyIds', coalesce(json_agg(DISTINCT key_id::text), '[]'::json))::text FROM public.personal_provider_credentials;",
  );
  return [
    "set -eu",
    `relation="$(${psqlCommand} -X -A -t -q -v ON_ERROR_STOP=1 -c ${relationQuery})"`,
    `if [ -z "$relation" ]; then printf '%s\\n' ${shellQuote(TABLE_ABSENT_SENTINEL)}; exit 0; fi`,
    `${psqlCommand} -X -A -t -q -v ON_ERROR_STOP=1 -c ${evidenceQuery}`,
  ].join("; ");
}

export function parseConnectedPersonalProviderCredentialEvidence(
  stdout: string,
): PersonalProviderCredentialDbEvidence {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate !== "");
  if (line === TABLE_ABSENT_SENTINEL) return { state: "table-absent" };
  if (line === undefined) {
    throw new Error("personal provider credential database probe returned no evidence");
  }
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("personal provider credential database probe returned malformed evidence");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("personal provider credential database probe returned malformed evidence");
  }
  const record = raw as { rowCount?: unknown; keyIds?: unknown };
  const rowCount =
    typeof record.rowCount === "number"
      ? record.rowCount
      : typeof record.rowCount === "string"
        ? Number(record.rowCount)
        : Number.NaN;
  if (!Number.isSafeInteger(rowCount) || rowCount < 0 || !Array.isArray(record.keyIds)) {
    throw new Error("personal provider credential database probe returned malformed evidence");
  }
  const keyIds = record.keyIds.map((value) => {
    if (typeof value !== "string" || !UUID_RE.test(value)) {
      throw new Error("personal provider credential database probe returned invalid custody identity");
    }
    return value.toLowerCase();
  });
  if (rowCount === 0) {
    if (keyIds.length !== 0) {
      throw new Error("personal provider credential database probe returned inconsistent evidence");
    }
    return { state: "empty" };
  }
  if (keyIds.length === 0) {
    throw new Error("personal provider credential database probe returned incomplete evidence");
  }
  return { state: "rows", keyIds: [...new Set(keyIds)].sort() };
}

/**
 * Host-side remote provisioning. The secret never enters stdout, argv, the
 * operator process, or logs. Canonical host config wins and is projected into
 * the final server env under the same lock.
 */
export function buildEnsureRemotePersonalProviderCustodyScript(args: {
  canonicalInstanceEnvPath: string;
  serverEnvPath: string;
  psqlCommand: string;
}): string {
  const relationQuery = shellQuote(
    "SELECT coalesce(to_regclass('public.personal_provider_credentials')::text, '');",
  );
  const rowCountQuery = shellQuote(
    "SELECT count(*)::text FROM public.personal_provider_credentials;",
  );
  const key = PERSONAL_PROVIDER_CUSTODY_ENV;
  const canonical = shellQuote(args.canonicalInstanceEnvPath);
  const serverEnv = shellQuote(args.serverEnvPath);
  const lock = shellQuote(`${args.canonicalInstanceEnvPath}.custody.lock`);
  return [
    "set -eu",
    "umask 077",
    `canonical=${canonical}`,
    `server_env=${serverEnv}`,
    `lock=${lock}`,
    `custody_key=${shellQuote(key)}`,
    shellEnvAssignmentHelpers,
    'block_projection() { blocked_tmp="${server_env}.blocked.$$"; if [ -f "$server_env" ]; then [ -r "$server_env" ] || return 72; strip_custody "$server_env" > "$blocked_tmp" || return 72; elif [ -e "$server_env" ]; then return 72; else : > "$blocked_tmp" || return 72; fi; printf "%s=\\n" "$custody_key" >> "$blocked_tmp" || return 72; chmod 600 "$blocked_tmp" || return 72; sync "$blocked_tmp" || return 72; mv -f -- "$blocked_tmp" "$server_env" || return 72; }',
    'fail_custody() { code="$1"; block_projection || exit 72; exit "$code"; }',
    'attempt=0; until mkdir -- "$lock" 2>/dev/null; do attempt=$((attempt + 1)); if [ "$attempt" -ge 100 ]; then exit 74; fi; sleep 0.05; done',
    `trap 'rmdir -- "$lock" 2>/dev/null || true' EXIT HUP INT TERM`,
    'if [ ! -f "$canonical" ] || [ ! -r "$canonical" ]; then fail_custody 72; fi',
    'if [ -e "$server_env" ] && { [ ! -f "$server_env" ] || [ ! -r "$server_env" ]; }; then exit 72; fi',
    'count="$(custody_count "$canonical")" || fail_custody 72; if [ "$count" -gt 1 ]; then fail_custody 65; fi',
    'custody_raw="$(read_custody "$canonical")" || fail_custody 72; custody="$(normalize_custody "$custody_raw")"',
    'if [ "$count" -eq 1 ] && [ -z "$custody" ]; then fail_custody 65; fi',
    "if [ -n \"$custody\" ]; then if ! printf %s \"$custody\" | grep -Eq " +
      shellQuote(custodyJsonPattern) +
      '; then fail_custody 65; fi; fi',
    'if [ -z "$custody" ]; then block_projection || exit 72; fi',
    'if [ -z "$custody" ]; then relation="$(' +
      `${args.psqlCommand} -X -A -t -q -v ON_ERROR_STOP=1 -c ${relationQuery}` +
      ')"; if [ -n "$relation" ]; then row_count="$(' +
      `${args.psqlCommand} -X -A -t -q -v ON_ERROR_STOP=1 -c ${rowCountQuery}` +
      ')"; if [ "$row_count" != "0" ]; then exit 67; fi; fi; uuid="$(cat /proc/sys/kernel/random/uuid)"; key_hex="$(od -An -N32 -tx1 /dev/urandom | tr -d " \\n")"; custody="{\\"formatVersion\\":1,\\"keyId\\":\\"${uuid}\\",\\"keyHex\\":\\"${key_hex}\\"}"; config_tmp="${canonical}.tmp.$$"; strip_custody "$canonical" > "$config_tmp"; printf "%s=%s\\n" "$custody_key" "$custody" >> "$config_tmp"; chmod 600 "$config_tmp"; sync "$config_tmp"; mv -f -- "$config_tmp" "$canonical"; sync "$(dirname -- "$canonical")"; fi',
    'server_tmp="${server_env}.tmp.$$"; if [ -f "$server_env" ]; then [ -r "$server_env" ] || exit 72; strip_custody "$server_env" > "$server_tmp"; else : > "$server_tmp"; fi; printf "%s=%s\\n" "$custody_key" "$custody" >> "$server_tmp"; chmod 600 "$server_tmp"; sync "$server_tmp"; mv -f -- "$server_tmp" "$server_env"',
  ].join("; ");
}

export function buildAssertRemoteRestoreCustodyScript(args: {
  canonicalInstanceEnvPath: string;
  database: PersonalProviderCredentialDbEvidence;
}): string {
  if (args.database.state !== "rows") return "set -eu; :";
  if (args.database.keyIds.length !== 1) return "set -eu; exit 68";
  const expected = args.database.keyIds[0]!;
  return [
    "set -eu",
    `canonical=${shellQuote(args.canonicalInstanceEnvPath)}`,
    `custody_key=${shellQuote(PERSONAL_PROVIDER_CUSTODY_ENV)}`,
    shellEnvAssignmentHelpers,
    'if [ ! -f "$canonical" ] || [ ! -r "$canonical" ]; then exit 72; fi',
    'count="$(custody_count "$canonical")"; if [ "$count" -ne 1 ]; then exit 67; fi',
    'custody_raw="$(read_custody "$canonical")"; custody="$(normalize_custody "$custody_raw")"',
    'if ! printf %s "$custody" | grep -Eq ' + shellQuote(custodyJsonPattern) + '; then exit 65; fi',
    'actual="$(printf %s "$custody" | sed -n ' +
      shellQuote('s/^.*"keyId":"\\([0-9a-fA-F-]*\\)".*$/\\1/p') +
      ')"',
    `if [ "$(printf %s "$actual" | tr '[:upper:]' '[:lower:]')" != ${shellQuote(expected)} ]; then exit 68; fi`,
  ].join("; ");
}

export function buildMergeRemoteCanonicalCustodyScript(args: {
  canonicalInstanceEnvPath: string;
  incomingInstanceEnvPath: string;
  serverEnvPath: string;
  incomingServerEnvPath: string;
}): string {
  return [
    "set -eu",
    "umask 077",
    `canonical=${shellQuote(args.canonicalInstanceEnvPath)}`,
    `incoming=${shellQuote(args.incomingInstanceEnvPath)}`,
    `server_env=${shellQuote(args.serverEnvPath)}`,
    `incoming_server=${shellQuote(args.incomingServerEnvPath)}`,
    `custody_key=${shellQuote(PERSONAL_PROVIDER_CUSTODY_ENV)}`,
    shellEnvAssignmentHelpers,
    'for required in "$canonical" "$incoming" "$incoming_server"; do if [ ! -f "$required" ] || [ ! -r "$required" ]; then exit 72; fi; done',
    'count="$(custody_count "$canonical")"; if [ "$count" -gt 1 ]; then exit 65; fi; incoming_count="$(custody_count "$incoming")"; if [ "$incoming_count" -gt 1 ]; then exit 65; fi; incoming_server_count="$(custody_count "$incoming_server")"; if [ "$incoming_server_count" -gt 1 ]; then exit 65; fi',
    'custody_raw="$(read_custody "$canonical")"; custody="$(normalize_custody "$custody_raw")"; if [ "$count" -eq 1 ] && ! printf %s "$custody" | grep -Eq ' + shellQuote(custodyJsonPattern) + '; then exit 65; fi',
    'config_tmp="${canonical}.tmp.$$"; strip_custody "$incoming" > "$config_tmp"; if [ -n "$custody" ]; then printf "%s=%s\\n" "$custody_key" "$custody" >> "$config_tmp"; fi; chmod 600 "$config_tmp"; sync "$config_tmp"; mv -f -- "$config_tmp" "$canonical"',
    'server_tmp="${server_env}.tmp.$$"; strip_custody "$incoming_server" > "$server_tmp"; printf "%s=%s\\n" "$custody_key" "$custody" >> "$server_tmp"; chmod 600 "$server_tmp"; sync "$server_tmp"; mv -f -- "$server_tmp" "$server_env"',
    'rm -f -- "$incoming" "$incoming_server"',
    'sync "$(dirname -- "$canonical")"',
  ].join("; ");
}

export function readPersonalProviderCustodyFromEnv(
  raw: string,
): PersonalProviderCustody | undefined {
  const value = personalProviderCustodyFromEnvFile(raw);
  if (value === undefined) return undefined;
  if (value === "") {
    throw new Error("personal provider custody is configured but invalid");
  }
  return parsePersonalProviderCustody(value);
}

export function setPersonalProviderCustodyInEnv(
  raw: string,
  custody: PersonalProviderCustody,
): string {
  const retained = raw
    .split(/\r?\n/)
    .filter((line) => {
      const trimmed = line.trimStart();
      const separator = trimmed.indexOf("=");
      return !(
        separator >= 0 &&
        trimmed.slice(0, separator).trim() === PERSONAL_PROVIDER_CUSTODY_ENV
      );
    });
  while (retained.at(-1) === "") retained.pop();
  retained.push(
    `${PERSONAL_PROVIDER_CUSTODY_ENV}=${serializePersonalProviderCustody(custody)}`,
    "",
  );
  return retained.join("\n");
}

/**
 * Resolve the canonical host custody. Existing valid custody is sufficient
 * authority and is reused without a database probe. First provisioning is
 * allowed only after the database proves that the credential table is absent
 * or empty. Every read, parse, database, and durable-write failure propagates.
 */
export async function ensurePersonalProviderCustody(
  args: EnsurePersonalProviderCustodyArgs,
  deps: EnsurePersonalProviderCustodyDeps =
    defaultEnsurePersonalProviderCustodyDeps(),
): Promise<PersonalProviderCustody> {
  return deps.withProvisioningLock(args.instanceRootDir, async () => {
    const before = await deps.readInstanceEnv(args.instanceRootDir);
    const existing = readPersonalProviderCustodyFromEnv(before);
    if (existing !== undefined) return existing;

    const database = await args.inspectDatabase();
    if (database.state === "rows") {
      throw new Error(
        "personal provider custody is missing while encrypted credentials exist",
      );
    }

    const created = deps.createCustody();
    await deps.writeInstanceEnv(
      args.instanceRootDir,
      setPersonalProviderCustodyInEnv(before, created),
    );
    const persisted = readPersonalProviderCustodyFromEnv(
      await deps.readInstanceEnv(args.instanceRootDir),
    );
    if (
      persisted === undefined ||
      serializePersonalProviderCustody(persisted) !==
        serializePersonalProviderCustody(created)
    ) {
      throw new Error("personal provider custody persistence verification failed");
    }
    return persisted;
  });
}

async function withFileLock<T>(
  instanceRootDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lockPath = join(instanceRootDir, "runtime-config", ".personal-provider-custody.lock");
  await nodeFs.mkdir(dirname(lockPath), { recursive: true, mode: 0o700 });
  let handle: nodeFs.FileHandle | undefined;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      handle = await nodeFs.open(lockPath, "wx", 0o600);
      break;
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        (error as NodeJS.ErrnoException).code !== "EEXIST"
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (handle === undefined) {
    throw new Error("personal provider custody provisioning lock timed out");
  }
  try {
    return await operation();
  } finally {
    await handle.close();
    await nodeFs.unlink(lockPath).catch(() => undefined);
  }
}

export function defaultEnsurePersonalProviderCustodyDeps(): EnsurePersonalProviderCustodyDeps {
  return {
    withProvisioningLock: withFileLock,
    readInstanceEnv: (instanceRootDir) =>
      nodeFs.readFile(join(instanceRootDir, "runtime-config", "instance.env"), "utf8"),
    writeInstanceEnv: async (instanceRootDir, raw) => {
      const path = join(instanceRootDir, "runtime-config", "instance.env");
      const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
      let handle: nodeFs.FileHandle | undefined;
      try {
        handle = await nodeFs.open(temporary, "wx", 0o600);
        await handle.writeFile(raw, "utf8");
        await handle.sync();
        await handle.close();
        handle = undefined;
        await nodeFs.rename(temporary, path);
        const directory = await nodeFs.open(dirname(path), "r");
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await handle?.close().catch(() => undefined);
        await nodeFs.unlink(temporary).catch(() => undefined);
      }
    },
    createCustody: createPersonalProviderCustody,
  };
}
