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
  let sawCopy = false;
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
    if (
      /^CREATE TABLE (?:(?:"public"|public)\.)?(?:"personal_provider_credentials"|personal_provider_credentials)\s*\($/.test(
        line,
      )
    ) {
      tableDeclared = true;
    }
    if (columns === undefined) {
      const match = line.match(
        /^COPY (?:(?:"public"|public)\.)?(?:"personal_provider_credentials"|personal_provider_credentials) \(([^)]+)\) FROM stdin;$/,
      );
      if (!match) continue;
      tableDeclared = true;
      sawCopy = true;
      columns = match[1]!
        .split(",")
        .map((column) => column.trim().replace(/^"|"$/g, ""));
      if (!columns.includes("key_id")) {
        throw new Error(
          "restore refused: personal credential dump is missing custody identity",
        );
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
    const keyId = decodePgCopyText(values[columns.indexOf("key_id")]!);
    if (keyId === undefined || !UUID_RE.test(keyId)) {
      throw new Error("restore refused: personal credential row has invalid custody identity");
    }
    keyIds.add(keyId.toLowerCase());
    rowCount += 1;
  }

  if (columns !== undefined) {
    throw new Error("restore refused: truncated personal credential COPY data");
  }
  if (!tableDeclared) return { state: "table-absent" };
  if (!sawCopy) {
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
