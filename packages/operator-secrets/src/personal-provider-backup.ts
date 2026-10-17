import { createReadStream } from "node:fs";
import * as nodeFs from "node:fs/promises";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import {
  personalProviderCustodyFromEnvFile,
  parsePersonalProviderCustody,
  type PersonalProviderCustody,
} from "./personal-provider-custody.ts";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type PersonalProviderCredentialDbEvidence =
  | { state: "table-absent" }
  | { state: "empty" }
  | { state: "rows"; keyIds: readonly string[] };

export interface PersonalProviderCustodyBackupEvidence {
  database: "table-absent" | "empty" | "rows";
  custody: "missing" | "valid" | "invalid";
  custodyKeyId?: string | undefined;
  custodyResetFromKeyId?: string | undefined;
  rowKeyIds?: string[] | undefined;
}

export interface PersonalProviderCustodyHealthEvidence {
  status: "ready" | "degraded";
  recordsExist: true;
  keyId: string;
}

export function assertPersonalProviderCustodyHealth(
  raw: string,
  expectedKeyId: string,
): PersonalProviderCustodyHealthEvidence {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("restore failed: personal provider custody verification failed");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("restore failed: personal provider custody verification failed");
  }
  const result = value as Record<string, unknown>;
  if (
    (result["status"] !== "ready" && result["status"] !== "degraded") ||
    result["recordsExist"] !== true ||
    typeof result["keyId"] !== "string" ||
    !UUID_RE.test(result["keyId"]) ||
    result["keyId"].toLowerCase() !== expectedKeyId.toLowerCase()
  ) {
    throw new Error("restore failed: personal provider custody verification failed");
  }
  return {
    status: result["status"],
    recordsExist: true,
    keyId: result["keyId"].toLowerCase(),
  };
}

function readCustody(raw: string): PersonalProviderCustody | undefined {
  const value = personalProviderCustodyFromEnvFile(raw);
  if (value === undefined) return undefined;
  if (value === "") {
    throw new Error("personal provider custody is configured but invalid");
  }
  return parsePersonalProviderCustody(value);
}

function decodePgCopyText(value: string): string | undefined {
  if (value === String.raw`\N`) return undefined;
  return value.replace(/\\([btnr\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "b": return "\b";
      case "t": return "\t";
      case "n": return "\n";
      case "r": return "\r";
      default: return "\\";
    }
  });
}

/** Inspect a gzip-compressed, plain-format pg_dump without loading a database. */
export async function readPersonalProviderCredentialEvidenceFromDump(
  dumpPath: string,
): Promise<PersonalProviderCredentialDbEvidence> {
  await nodeFs.access(dumpPath);
  const input = createReadStream(dumpPath).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let firstLine = true;
  let tableDeclared = false;
  let columns: string[] | undefined;
  const declaredTables = new Set<string>();
  const copiedTables = new Set<string>();
  let subscription = false;
  let rowCount = 0;
  const keyIds = new Set<string>();

  for await (const line of lines) {
    if (firstLine) {
      firstLine = false;
      if (line.startsWith("PGDMP")) {
        throw new Error(
          "restore refused: personal credential evidence requires a plain-format database dump",
        );
      }
    }
    const declared = line.match(/^CREATE TABLE (?:(?:"public"|public)\.)?"?(personal_provider_credentials|chatgpt_registrations)"?\s*\($/);
    if (declared) { tableDeclared = true; declaredTables.add(declared[1]!); }
    if (columns === undefined) {
      const match = line.match(/^COPY (?:(?:"public"|public)\.)?"?(personal_provider_credentials|chatgpt_registrations)"? \(([^)]+)\) FROM stdin;$/);
      if (!match) continue;
      tableDeclared = true;
      copiedTables.add(match[1]!);
      subscription = match[1] === "chatgpt_registrations";
      columns = match[2]!.split(",").map(column => column.trim().replace(/^"|"$/g, ""));
      if (subscription ? !columns.includes("identity_envelope") || !columns.includes("envelope") : !columns.includes("key_id")) {
        throw new Error("restore refused: personal credential dump is missing custody identity");
      }
      continue;
    }
    if (line === String.raw`\.`) {
      columns = undefined;
      continue;
    }
    const values = line.split("\t");
    if (values.length !== columns.length) {
      throw new Error("restore refused: malformed personal credential COPY row");
    }
    const rememberKey = (keyId: unknown) => {
      if (typeof keyId !== "string" || !UUID_RE.test(keyId)) {
        throw new Error("restore refused: personal credential row has invalid custody identity");
      }
      keyIds.add(keyId.toLowerCase());
    };
    if (subscription) {
      for (const column of ["identity_envelope", "envelope"]) {
        const raw = decodePgCopyText(values[columns.indexOf(column)]!);
        if (raw === undefined && column === "envelope") continue;
        let envelope: unknown;
        try { envelope = JSON.parse(raw ?? ""); } catch { throw new Error("restore refused: malformed subscription custody envelope"); }
        rememberKey(typeof envelope === "object" && envelope !== null && "keyId" in envelope ? envelope.keyId : undefined);
      }
    } else rememberKey(decodePgCopyText(values[columns.indexOf("key_id")]!));
    rowCount += 1;
  }

  if (columns !== undefined) {
    throw new Error("restore refused: truncated personal credential COPY data");
  }
  if (!tableDeclared) return { state: "table-absent" };
  if (copiedTables.size === 0 || [...declaredTables].some(table => !copiedTables.has(table))) {
    throw new Error(
      "restore refused: personal credential contents cannot be established from the backup",
    );
  }
  if (rowCount === 0) return { state: "empty" };
  return { state: "rows", keyIds: [...keyIds].sort() };
}

export function buildPersonalProviderCustodyBackupEvidence(
  database: PersonalProviderCredentialDbEvidence,
  instanceEnvRaw: string | undefined,
): PersonalProviderCustodyBackupEvidence {
  let custody: PersonalProviderCustody | undefined;
  let custodyState: PersonalProviderCustodyBackupEvidence["custody"] = "missing";
  if (instanceEnvRaw !== undefined) {
    try {
      custody = readCustody(instanceEnvRaw);
      custodyState = custody === undefined ? "missing" : "valid";
    } catch {
      custodyState = "invalid";
    }
  }
  return {
    database: database.state,
    custody: custodyState,
    ...(custody === undefined ? {} : { custodyKeyId: custody.keyId }),
    ...(custody?.resetFromKeyId === undefined ? {} : { custodyResetFromKeyId: custody.resetFromKeyId }),
    ...(database.state === "rows" ? { rowKeyIds: [...database.keyIds] } : {}),
  };
}

export function assertPersonalProviderRestoreCustody(args: {
  database: PersonalProviderCredentialDbEvidence;
  instanceEnvRaw: string | undefined;
  recorded?: PersonalProviderCustodyBackupEvidence | undefined;
}): void {
  const observed = buildPersonalProviderCustodyBackupEvidence(
    args.database,
    args.instanceEnvRaw,
  );
  if (
    args.recorded !== undefined &&
    JSON.stringify(args.recorded) !== JSON.stringify(observed)
  ) {
    throw new Error(
      "restore refused: personal credential custody metadata does not match the recovery bundle",
    );
  }
  if (args.database.state !== "rows") return;
  if (observed.custody !== "valid" || observed.custodyKeyId === undefined) {
    throw new Error(
      "restore refused: encrypted personal credentials require matching custody",
    );
  }
  const allowed = new Set([observed.custodyKeyId, ...(observed.custodyResetFromKeyId === undefined ? [] : [observed.custodyResetFromKeyId])]);
  if (args.database.keyIds.some((keyId) => !allowed.has(keyId.toLowerCase()))) {
    throw new Error(
      "restore refused: personal credential custody identity does not match the restored records",
    );
  }
}

/** Run inside the restore transaction before any runtime restarts. A backup's
 * renewable token may have rotated, or its original custodian may still live.
 * Keep identity and explicit selection, but require fresh consent before use.
 * Identity AAD uses authority_revision, so leave it intact until reconnect. */
export const CHATGPT_RESTORE_FENCE_SQL = `DO $chatgpt_restore$
BEGIN
  IF to_regclass('public.chatgpt_registrations') IS NOT NULL THEN
    UPDATE public.chatgpt_registrations
      SET envelope = NULL, state = 'reconnect_required',
          token_generation = token_generation + 1, updated_at = now()
      WHERE state = 'connected';
  END IF;
END
$chatgpt_restore$;`;
