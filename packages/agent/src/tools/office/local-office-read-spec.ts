/**
 * M206 — structured office.run read spec (never put readArgv on the relay wire).
 */

export type OfficeRunReadVerb = "get" | "dump" | "view" | "query" | "validate" | "raw";

export interface OfficeRunReadSpec {
  verb: OfficeRunReadVerb;
  /** Object path for get/dump/raw, selector for query, mode token for view. */
  target?: string | undefined;
  depth?: number | undefined;
  find?: string | undefined;
  mode?: string | undefined;
  json?: boolean | undefined;
}

const ALLOWED_READ_VERBS = new Set<OfficeRunReadVerb>([
  "get",
  "dump",
  "view",
  "query",
  "validate",
  "raw",
]);

export function parseOfficeRunReadArgv(
  argv: readonly string[],
): { ok: true; spec: OfficeRunReadSpec } | { ok: false; error: string } {
  if (argv.length === 0) {
    return { ok: false, error: "office.run readArgv is empty" };
  }
  const verb = argv[0];
  if (typeof verb !== "string" || !ALLOWED_READ_VERBS.has(verb as OfficeRunReadVerb)) {
    return { ok: false, error: `unsupported office.run read verb: ${String(verb)}` };
  }

  const spec: OfficeRunReadSpec = { verb: verb as OfficeRunReadVerb, json: true };
  let i = 1;
  if (i < argv.length && !argv[i]!.startsWith("--")) {
    spec.target = argv[i];
    i++;
  }

  while (i < argv.length) {
    const token = argv[i]!;
    if (token === "--json") {
      spec.json = true;
      i++;
      continue;
    }
    if (token === "--no-json") {
      spec.json = false;
      i++;
      continue;
    }
    if (token === "--depth" && i + 1 < argv.length) {
      const depth = Number(argv[i + 1]);
      if (!Number.isFinite(depth)) {
        return { ok: false, error: "office.run read --depth requires a number" };
      }
      spec.depth = depth;
      i += 2;
      continue;
    }
    if (token === "--find" && i + 1 < argv.length) {
      spec.find = argv[i + 1];
      i += 2;
      continue;
    }
    if (token === "--mode" && i + 1 < argv.length) {
      spec.mode = argv[i + 1];
      i += 2;
      continue;
    }
    return { ok: false, error: `unsupported office.run read flag: ${token}` };
  }

  return { ok: true, spec };
}
