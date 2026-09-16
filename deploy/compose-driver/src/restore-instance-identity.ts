import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";

import { shellQuote } from "./remote-exec.ts";

const ABSENT_IDENTITY_SENTINEL = "__NAUTILO_INSTANCE_IDENTITY_ABSENT__";
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface RestoreInstanceIdentity {
  instanceId: string;
  serverInstanceId?: string;
  serverBindingGeneration?: number;
}

function decodePgCopyText(value: string): string | undefined {
  if (value === String.raw`\N`) return undefined;
  return value.replace(/\\([btnr\\])/g, (_match, escaped: string) => {
    switch (escaped) {
      case "b":
        return "\b";
      case "t":
        return "\t";
      case "n":
        return "\n";
      case "r":
        return "\r";
      default:
        return "\\";
    }
  });
}

function parseIdentityRecord(
  record: Record<string, string | undefined>,
  context: string,
): RestoreInstanceIdentity {
  const instanceId = record["instance_id"];
  if (instanceId === undefined) {
    throw new Error(`${context}: identity row is missing instance_id`);
  }

  const serverInstanceId = record["server_instance_id"];
  if (serverInstanceId !== undefined && !UUID_RE.test(serverInstanceId)) {
    throw new Error(`${context}: identity row has an invalid server_instance_id`);
  }

  const generationRaw = record["server_binding_generation"];
  const serverBindingGeneration =
    generationRaw === undefined ? undefined : Number(generationRaw);
  if (
    serverBindingGeneration !== undefined &&
    (!Number.isSafeInteger(serverBindingGeneration) || serverBindingGeneration < 1)
  ) {
    throw new Error(
      `${context}: identity row has an invalid server_binding_generation`,
    );
  }

  if ((serverInstanceId === undefined) !== (serverBindingGeneration === undefined)) {
    throw new Error(`${context}: identity row has an incomplete server authority tuple`);
  }

  return {
    instanceId,
    ...(serverInstanceId !== undefined ? { serverInstanceId } : {}),
    ...(serverBindingGeneration !== undefined
      ? { serverBindingGeneration }
      : {}),
  };
}

/**
 * Reads the singleton identity directly from a plain-format pg_dump gzip.
 * Column order is taken from the COPY header so bundles from before D458
 * (which had no server UUID/generation columns) remain distinguishable.
 */
export async function readRestoreInstanceIdentityFromDump(
  dumpPath: string,
): Promise<RestoreInstanceIdentity | undefined> {
  const input = createReadStream(dumpPath).pipe(createGunzip());
  const lines = createInterface({ input, crlfDelay: Infinity });
  let columns: string[] | undefined;

  try {
    for await (const line of lines) {
      if (columns === undefined) {
        const match = line.match(
          /^COPY (?:(?:"public"|public)\.)?(?:"nautilo_instance_identity"|nautilo_instance_identity) \(([^)]+)\) FROM stdin;$/,
        );
        if (!match) continue;
        columns = match[1]!
          .split(",")
          .map((column) => column.trim().replace(/^"|"$/g, ""));
        continue;
      }

      if (line === String.raw`\.`) return undefined;
      const values = line.split("\t");
      if (values.length !== columns.length) {
        throw new Error("restore refused: malformed nautilo_instance_identity COPY row");
      }
      const record = Object.fromEntries(
        columns.map((column, index) => [column, decodePgCopyText(values[index]!)]),
      );
      if (record["id"] !== "self") continue;
      return parseIdentityRecord(record, "restore refused: backup");
    }
  } catch (error) {
    // Dump validity remains owned by validateRestoreDumpScript, which runs
    // before any schema reset. Defer gzip framing errors to that authoritative
    // gate so identity inspection does not become a second, divergent dump
    // validator. Valid gzip content is still parsed strictly above.
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? (error as { code?: unknown }).code
        : undefined;
    if (code === "Z_BUF_ERROR" || code === "Z_DATA_ERROR") return undefined;
    throw error;
  }

  return undefined;
}

/** Read-only psql probe that also works when the marker table is absent. */
export function buildReadConnectedInstanceIdentityScript(
  psqlCommand: string,
): string {
  const relationQuery = shellQuote(
    "SELECT coalesce(to_regclass('public.nautilo_instance_identity')::text, '');",
  );
  const identityQuery = shellQuote(
    "SELECT to_jsonb(identity_row)::text FROM public.nautilo_instance_identity AS identity_row WHERE id = 'self' LIMIT 1;",
  );
  return [
    "set -eu",
    `relation="$(${psqlCommand} -X -A -t -q -c ${relationQuery})"`,
    `if [ -z "$relation" ]; then printf '%s\\n' ${shellQuote(ABSENT_IDENTITY_SENTINEL)}; exit 0; fi`,
    `${psqlCommand} -X -A -t -q -c ${identityQuery}`,
  ].join("; ");
}

export function parseConnectedInstanceIdentity(
  stdout: string,
): RestoreInstanceIdentity | undefined {
  const line = stdout.split(/\r?\n/).find((candidate) => candidate !== "");
  if (line === undefined || line === ABSENT_IDENTITY_SENTINEL) return undefined;

  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    throw new Error("restore refused: target identity probe returned malformed JSON");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("restore refused: target identity probe returned a malformed row");
  }
  const record = raw as Record<string, unknown>;
  const normalized: Record<string, string | undefined> = {};
  for (const key of [
    "instance_id",
    "server_instance_id",
    "server_binding_generation",
  ] as const) {
    const value = record[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== "string" && typeof value !== "number") {
      throw new Error("restore refused: target identity probe returned a malformed row");
    }
    normalized[key] = String(value);
  }
  return parseIdentityRecord(normalized, "restore refused: target");
}

export function assertRestoreIdentityCompatible(args: {
  bundle: RestoreInstanceIdentity | undefined;
  target: RestoreInstanceIdentity | undefined;
  manifestInstanceId: string;
  targetInstanceId: string;
}): void {
  if (args.manifestInstanceId !== args.targetInstanceId) {
    throw new Error(
      "restore refused: bundle and target deployment labels differ; restore preserves logical server identity and cannot relabel it",
    );
  }
  if (args.bundle !== undefined && args.bundle.instanceId !== args.manifestInstanceId) {
    throw new Error(
      "restore refused: backup database identity does not match its bundle manifest",
    );
  }
  if (args.target === undefined) return;
  if (args.bundle === undefined) {
    throw new Error(
      "restore refused: identity-less legacy backup cannot overwrite an identity-bearing target",
    );
  }
  if (
    args.bundle.instanceId !== args.target.instanceId ||
    args.bundle.serverInstanceId !== args.target.serverInstanceId ||
    args.bundle.serverBindingGeneration !== args.target.serverBindingGeneration
  ) {
    throw new Error(
      "restore refused: target belongs to a different logical server identity",
    );
  }
}

export function assertRestoredIdentity(
  expected: RestoreInstanceIdentity | undefined,
  actual: RestoreInstanceIdentity | undefined,
): void {
  if (expected === undefined) return;
  if (
    actual === undefined ||
    expected.instanceId !== actual.instanceId ||
    expected.serverInstanceId !== actual.serverInstanceId ||
    expected.serverBindingGeneration !== actual.serverBindingGeneration
  ) {
    throw new Error(
      "restore failed closed: restored database did not retain the backup's logical server identity",
    );
  }
}
