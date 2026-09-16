#!/usr/bin/env bun
/**
 * `loffice` — gogcli-style CLI over LofficeClient (D362 spec P2).
 *
 * Contract (mirrors gog): stdout is parseable (`--json` envelope / `--plain`),
 * human hints go to stderr, `--no-input` never prompts, stable exit codes:
 *   0 ok · 2 usage error · 3 engine error · 1 other.
 *
 * P2 verbs (transform): info · convert · render · compare.
 * P4 will add mutation/extract/meta verbs on the same router.
 */
import { readFile, writeFile } from "node:fs/promises";
import { extname } from "node:path";
import { LofficeClient } from "./client";
import { XmlRpcFault } from "./xmlrpc";

export const EXIT = { ok: 0, other: 1, usage: 2, engine: 3 } as const;

const VALUE_FLAGS = new Set([
  "url", "to", "filter", "filetype",
  "find", "replace", "text", "at", "cell", "value", "sheet", "map", "range", "rows",
  "title", "author", "subject",
]);

/** "42"/"3.5" → number; "=A1" and everything else → string. */
function coerceValue(raw: string): string | number {
  return /^-?\d+(\.\d+)?$/.test(raw) ? Number(raw) : raw;
}

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok.startsWith("--")) {
      const body = tok.slice(2);
      const eq = body.indexOf("=");
      if (eq !== -1) {
        flags[body.slice(0, eq)] = body.slice(eq + 1);
      } else if (VALUE_FLAGS.has(body) && i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) {
        flags[body] = argv[++i]!;
      } else {
        flags[body] = true;
      }
    } else {
      positionals.push(tok);
    }
  }
  return { command: positionals[0] ?? "", positionals: positionals.slice(1), flags };
}

function extToFormat(p: string): string {
  return extname(p).replace(/^\./, "").toLowerCase();
}

/** stdout emit: JSON envelope under --json, else a plain line. */
function emit(json: boolean, payload: Record<string, unknown>, plainLine: string): void {
  if (json) process.stdout.write(JSON.stringify({ ok: true, ...payload }) + "\n");
  else if (plainLine) process.stdout.write(plainLine + "\n");
}

function fail(json: boolean, code: number, message: string): number {
  if (json) process.stdout.write(JSON.stringify({ ok: false, error: message }) + "\n");
  else process.stderr.write(`loffice: ${message}\n`);
  return code;
}

const USAGE = `loffice — LibreOffice headless CLI (D362)

Usage:
  loffice info [--json]
  loffice convert <in> <out> [--to <fmt>] [--filter <name>] [--json]
  loffice render  <in> <out.pdf|out.png> [--json]
  loffice compare <old> <new> <out> [--json]
  loffice find-replace <in> <out> --find <s> --replace <r> [--regex]
  loffice template-fill <in> <out> --map <data.json>
  loffice insert-text <in> <out> --text <s> [--at start|end]
  loffice set-cell <in> <out> --cell <A1> --value <v> [--sheet <n>]
  loffice set-range <in> <out> --range <A1:B2> --rows <rows.json> [--sheet <n>]
  loffice extract <in> [--json]
  loffice meta <in>                       # print metadata
  loffice meta <in> <out> [--title <t>] [--author <a>] [--subject <s>]

Global flags: --url <engineUrl>  --json  --plain  --no-input
Note: mutation verbs need the nwuno engine (set --url to the nwuno service).`;

export async function runCli(argv: string[]): Promise<number> {
  const { command, positionals, flags } = parseArgs(argv);
  const json = flags["json"] === true;
  if (!command || command === "help" || flags["help"]) {
    process.stderr.write(USAGE + "\n");
    return command ? EXIT.ok : EXIT.usage;
  }

  const client = new LofficeClient(
    typeof flags["url"] === "string" ? { baseUrl: flags["url"] } : {},
  );

  try {
    switch (command) {
      case "info": {
        const info = await client.info();
        emit(
          json,
          { unoserver: info.unoserver, api: info.api, export_filters: Object.keys(info.export_filters).length, import_filters: Object.keys(info.import_filters).length },
          `unoserver ${info.unoserver} (api ${info.api}) — ${Object.keys(info.export_filters).length} export / ${Object.keys(info.import_filters).length} import filters`,
        );
        return EXIT.ok;
      }
      case "convert":
      case "render": {
        const [inPath, outPath] = positionals;
        if (!inPath || !outPath) return fail(json, EXIT.usage, `${command}: need <in> <out>`);
        const to = typeof flags["to"] === "string" ? flags["to"] : extToFormat(outPath);
        if (!to) return fail(json, EXIT.usage, `${command}: cannot infer target format from '${outPath}'; pass --to`);
        const bytes = new Uint8Array(await readFile(inPath));
        const out = await client.convert(bytes, to, typeof flags["filter"] === "string" ? { filter: flags["filter"] } : {});
        await writeFile(outPath, out);
        emit(json, { command, in: inPath, out: outPath, to, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "compare": {
        const [oldPath, newPath, outPath] = positionals;
        if (!oldPath || !newPath || !outPath) return fail(json, EXIT.usage, "compare: need <old> <new> <out>");
        const filetype = typeof flags["filetype"] === "string" ? flags["filetype"] : extToFormat(outPath);
        const out = await client.compare(new Uint8Array(await readFile(oldPath)), new Uint8Array(await readFile(newPath)), filetype);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "find-replace": {
        const [inPath, outPath] = positionals;
        const find = flags["find"];
        const replace = flags["replace"];
        if (!inPath || !outPath || typeof find !== "string" || typeof replace !== "string")
          return fail(json, EXIT.usage, "find-replace: need <in> <out> --find <s> --replace <r>");
        const ext = extToFormat(inPath);
        const out = await client.findReplace(new Uint8Array(await readFile(inPath)), ext, find, replace, flags["regex"] === true);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "template-fill": {
        const [inPath, outPath] = positionals;
        const mapPath = flags["map"];
        if (!inPath || !outPath || typeof mapPath !== "string")
          return fail(json, EXIT.usage, "template-fill: need <in> <out> --map <data.json>");
        const mapping = JSON.parse(await readFile(mapPath, "utf8")) as Record<string, string>;
        const out = await client.templateFill(new Uint8Array(await readFile(inPath)), extToFormat(inPath), mapping);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, keys: Object.keys(mapping).length, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "insert-text": {
        const [inPath, outPath] = positionals;
        const text = flags["text"];
        if (!inPath || !outPath || typeof text !== "string")
          return fail(json, EXIT.usage, "insert-text: need <in> <out> --text <s>");
        const out = await client.insertText(new Uint8Array(await readFile(inPath)), extToFormat(inPath), text, flags["at"] !== "start");
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "set-cell": {
        const [inPath, outPath] = positionals;
        const cell = flags["cell"];
        if (!inPath || !outPath || typeof cell !== "string" || flags["value"] === undefined)
          return fail(json, EXIT.usage, "set-cell: need <in> <out> --cell <A1> --value <v>");
        const sheet = typeof flags["sheet"] === "string" ? Number(flags["sheet"]) : 0;
        const value = typeof flags["value"] === "string" ? coerceValue(flags["value"]) : flags["value"];
        const out = await client.setCells(new Uint8Array(await readFile(inPath)), extToFormat(inPath), [{ sheet, cell, value: value as string | number }]);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, cell, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "set-range": {
        const [inPath, outPath] = positionals;
        const range = flags["range"];
        const rowsPath = flags["rows"];
        if (!inPath || !outPath || typeof range !== "string" || typeof rowsPath !== "string")
          return fail(json, EXIT.usage, "set-range: need <in> <out> --range <A1:B2> --rows <rows.json>");
        const rows = JSON.parse(await readFile(rowsPath, "utf8")) as Array<Array<string | number>>;
        const sheet = typeof flags["sheet"] === "string" ? Number(flags["sheet"]) : 0;
        const out = await client.setRange(new Uint8Array(await readFile(inPath)), extToFormat(inPath), sheet, range, rows);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, bytes: out.byteLength }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      case "extract": {
        const [inPath] = positionals;
        if (!inPath) return fail(json, EXIT.usage, "extract: need <in>");
        const struct = await client.getStructured(new Uint8Array(await readFile(inPath)), extToFormat(inPath));
        process.stdout.write(JSON.stringify(json ? { ok: true, ...struct } : struct) + "\n");
        return EXIT.ok;
      }
      case "meta": {
        const [inPath, outPath] = positionals;
        if (!inPath) return fail(json, EXIT.usage, "meta: need <in>");
        const ext = extToFormat(inPath);
        const bytes = new Uint8Array(await readFile(inPath));
        if (!outPath) {
          const meta = await client.getMeta(bytes, ext);
          process.stdout.write(JSON.stringify(json ? { ok: true, meta } : meta) + "\n");
          return EXIT.ok;
        }
        const set: Record<string, string> = {};
        for (const k of ["title", "author", "subject"]) if (typeof flags[k] === "string") set[k] = flags[k];
        const out = await client.setMeta(bytes, ext, set);
        await writeFile(outPath, out);
        emit(json, { command, out: outPath, set: Object.keys(set) }, `${outPath} (${out.byteLength} bytes)`);
        return EXIT.ok;
      }
      default:
        return fail(json, EXIT.usage, `unknown command '${command}'\n${USAGE}`);
    }
  } catch (err) {
    if (err instanceof XmlRpcFault) return fail(json, EXIT.engine, err.message);
    return fail(json, EXIT.other, err instanceof Error ? err.message : String(err));
  }
}

if (import.meta.main) {
  void runCli(process.argv.slice(2)).then((code) => process.exit(code));
}
