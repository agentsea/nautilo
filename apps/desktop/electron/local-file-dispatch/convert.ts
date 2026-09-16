/**
 * M206 — local-zone convert: read source, transform, validate, write on the relay.
 */

import type { RelayLocalFileZone } from "@nautilo/relay";
import type { GuardedFileAdapter } from "../local-file-history/file-adapter.ts";
import { resolveZonePath, type LocalRoutingContext } from "./paths.ts";

export type LocalConvertRunner = (
  inputFormat: string,
  outputFormat: string,
  markdown: string,
) => Promise<Uint8Array>;

export interface LocalConvertContext {
  adapter: GuardedFileAdapter;
  allowedRoots: readonly string[];
  routing: LocalRoutingContext;
}

export interface LocalConvertWireOperation {
  subkind: "convert";
  sourceZone: RelayLocalFileZone;
  sourcePath: string;
  destinationZone: RelayLocalFileZone;
  destinationPath: string;
  inputFormat: string;
  outputFormat: string;
  backend: "local";
  summary: string;
  _routing: LocalRoutingContext;
}

export type LocalConvertWriteFn = (
  args: {
    zone: RelayLocalFileZone;
    displayPath: string;
    canonicalPath: string;
    resolvedPath: string;
    bytes: Uint8Array;
    summary: string;
    skipOoxmlCheck?: boolean | undefined;
    targetBefore: Uint8Array | null;
    source: {
      canonicalPath: string;
      bytes: Uint8Array;
    };
  },
) => Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }>;

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46] as const; // %PDF
const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

function defaultLocalConvertRunner(): LocalConvertRunner {
  return async (inputFormat, outputFormat, markdown) => {
    const { markdownToDocxBuffer, markdownToPdfBuffer } = await import(
      "../../../../packages/agent/src/tools/convert/local-markdown-convert.ts"
    );
    const input = inputFormat.toLowerCase();
    const output = outputFormat.toLowerCase();
    if (input !== "md") {
      throw new Error(`local convert only supports markdown sources (got ${inputFormat})`);
    }
    if (output === "pdf") {
      return new Uint8Array(await markdownToPdfBuffer(markdown));
    }
    if (output === "docx") {
      return new Uint8Array(await markdownToDocxBuffer(markdown));
    }
    throw new Error(`local convert cannot produce ${outputFormat}`);
  };
}

function isPdfBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i++) {
    if (bytes[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

function isOoxmlBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < OOXML_MAGIC.length) return false;
  for (let i = 0; i < OOXML_MAGIC.length; i++) {
    if (bytes[i] !== OOXML_MAGIC[i]) return false;
  }
  return true;
}

function validateConvertOutput(bytes: Uint8Array, outputFormat: string): string | null {
  const output = outputFormat.toLowerCase();
  if (bytes.byteLength === 0) return "convert output is empty";
  if (output === "pdf") {
    return isPdfBuffer(bytes) ? null : "convert output failed PDF magic validation";
  }
  if (output === "docx") {
    return isOoxmlBuffer(bytes) ? null : "convert output failed OOXML magic validation";
  }
  if (bytes.byteLength > 200 * 1024 * 1024) {
    return "convert output exceeds 200MB cap";
  }
  return null;
}

async function assertContained(
  adapter: GuardedFileAdapter,
  resolved: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  const pathMod = await import("node:path");
  try {
    const canonical = await adapter.canonicalize(resolved);
    for (const root of allowedRoots) {
      const rootCanon = await adapter.canonicalize(root);
      const rel = pathMod.relative(rootCanon, canonical);
      if (rel === "" || (!rel.startsWith("..") && !pathMod.isAbsolute(rel))) {
        return canonical;
      }
    }
    return null;
  } catch {
    return null;
  }
}

export async function executeLocalConvert(
  op: LocalConvertWireOperation,
  ctx: LocalConvertContext,
  opts: {
    convertRunner?: LocalConvertRunner | undefined;
    writeOutput: LocalConvertWriteFn;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  const sourceResolved = resolveZonePath(op.sourceZone, op.sourcePath, ctx.routing);
  if (!sourceResolved.ok) {
    return { ok: false, message: sourceResolved.reason };
  }
  const destResolved = resolveZonePath(op.destinationZone, op.destinationPath, ctx.routing);
  if (!destResolved.ok) {
    return { ok: false, message: destResolved.reason };
  }

  const sourceCanonical = await assertContained(ctx.adapter, sourceResolved.resolved, ctx.allowedRoots);
  if (!sourceCanonical) return { ok: false, message: "source path escapes allowed roots" };
  const destCanonical = await assertContained(ctx.adapter, destResolved.resolved, ctx.allowedRoots);
  if (!destCanonical) return { ok: false, message: "destination path escapes allowed roots" };

  let sourceBytes: Uint8Array;
  try {
    sourceBytes = await ctx.adapter.readFile(sourceCanonical);
  } catch {
    return { ok: false, message: `source file not found: ${op.sourcePath}` };
  }

  let targetBefore: Uint8Array | null;
  try {
    const destinationStat = await ctx.adapter.stat(destCanonical);
    if (destinationStat === null) {
      targetBefore = null;
    } else if (!destinationStat.isFile || destinationStat.isSymbolicLink) {
      return { ok: false, message: "convert output target is not a regular file" };
    } else {
      targetBefore = new Uint8Array(await ctx.adapter.readFile(destCanonical));
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error
        ? err.message
        : "convert output target could not be staged",
    };
  }

  const runner = opts.convertRunner ?? defaultLocalConvertRunner();
  let generated: Uint8Array;
  try {
    const markdown = Buffer.from(sourceBytes).toString("utf-8");
    generated = await runner(op.inputFormat, op.outputFormat, markdown);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `local convert failed: ${msg}` };
  }

  const validationError = validateConvertOutput(generated, op.outputFormat);
  if (validationError) {
    return { ok: false, message: validationError };
  }

  return opts.writeOutput({
    zone: op.destinationZone,
    displayPath: destResolved.displayPath,
    canonicalPath: destCanonical,
    resolvedPath: destResolved.resolved,
    bytes: generated,
    summary: op.summary,
    skipOoxmlCheck: op.outputFormat.toLowerCase() !== "docx",
    targetBefore,
    source: {
      canonicalPath: sourceCanonical,
      bytes: sourceBytes,
    },
  });
}
