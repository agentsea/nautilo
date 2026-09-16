/**
 * M206 Phase 3 — Electron local Office runner (structured allowlisted operations only).
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildHelpArgv,
  docxMediaMapToDataUrls,
  extractDocxMediaByRelId,
  formatOfficeHelpFailure,
  generateOffice,
  makeOfficeCreateRun,
  OFFICECLI_CREATE_DATA_ERROR,
  OFFICE_HELP_FORMAT_ERROR,
  resolveOfficeHelpFormat,
  stageOfficeRunImageInputs,
  type OfficeBatchCommand,
  type OfficeCliRunResult,
  type OfficeCreateRunFn,
  type OfficeDocType,
} from "@nautilo/config/officecli";
import type { RelayLocalFileZone } from "@nautilo/relay";
import type { OfficeRunReadSpec } from "./office-read-spec.ts";
import type { GuardedFileAdapter } from "../local-file-history/file-adapter.ts";
import { getCachedDesktopOfficeCliPath } from "../office-runtime.ts";
import { executeLocalConvert, type LocalConvertRunner } from "./convert.ts";
import type { DesktopOfficeCliCommitResult } from "../document-mutations/desktop-document-mutation-runtime.ts";
import { findForbiddenExecutionField } from "./forbidden-payload.ts";
import { buildOfficeCliDirectArgv, buildOfficeRunReadArgv } from "./office-cli-argv.ts";
import { extractRouting, resolveLocalMutationTransactionId, resolveZonePath, type LocalRoutingContext } from "./paths.ts";

const OFFICE_EXEC_TIMEOUT_MS = 120_000;
const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_STDERR_BYTES = 1024 * 1024;
const MAX_OFFICE_OUTPUT_BYTES = 200 * 1024 * 1024;
const OOXML_MAGIC = [0x50, 0x4b, 0x03, 0x04] as const;

const ALLOWED_OFFICECLI_COMMANDS = new Set([
  "create",
  "view",
  "get",
  "query",
  "set",
  "add",
  "remove",
  "move",
  "swap",
  "validate",
  "dump",
  "merge",
  "batch",
  "raw",
  "raw_set",
  "add_part",
  "open",
  "save",
  "close",
  "refresh",
  "help",
]);

const READ_ONLY_COMMANDS = new Set([
  "view",
  "get",
  "query",
  "validate",
  "dump",
  "raw",
  "help",
]);

export type LocalOfficeWireOperation =
  | {
      subkind: "officecli";
      zone: RelayLocalFileZone;
      command: string;
      payload: Record<string, unknown>;
      _routing: LocalRoutingContext;
    }
  | {
      subkind: "officeRun";
      mode: "read";
      inputPath: string;
      readSpec: OfficeRunReadSpec;
      _routing: LocalRoutingContext;
    }
  | {
      subkind: "officeRun";
      mode: "write";
      outputPath: string;
      ops: unknown[];
      imageInputs?: Array<{ dataUrl: string }>;
      overwrite: boolean;
      officeType: OfficeDocType;
      _routing: LocalRoutingContext;
    }
  | {
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
    };

export interface LocalOfficeCommandContext {
  adapter: GuardedFileAdapter;
  allowedRoots: readonly string[];
  routing: LocalRoutingContext;
  /** Test hook — inject fake OfficeCLI runner (never uses arbitrary argv from wire). */
  officeRun?: OfficeCreateRunFn | undefined;
  binaryPath?: string | undefined;
  /** Test hook — inject local markdown convert runner. */
  convertRunner?: LocalConvertRunner | undefined;
  /**
   * D448 final seam for privately staged binary producers. It owns the V2
   * journal, shared coordinator locks, exact events and durable outbox;
   * OfficeCLI, office.run output and local convert remain private generators.
   */
  officeCliCommit?: ((input: {
    readonly targetPath: string;
    readonly targetBefore: Uint8Array | null;
    readonly after: Uint8Array;
    readonly source?: {
      readonly path: string;
      readonly before: Uint8Array;
    } | undefined;
    readonly agentId: string;
    readonly turnId: string;
  }) => Promise<DesktopOfficeCliCommitResult>) | undefined;
}

function isOoxmlBuffer(bytes: Uint8Array): boolean {
  if (bytes.byteLength < OOXML_MAGIC.length) return false;
  for (let i = 0; i < OOXML_MAGIC.length; i++) {
    if (bytes[i] !== OOXML_MAGIC[i]) return false;
  }
  return true;
}

function rejectMalformed(message: string): { ok: false; message: string; code?: string } {
  return { ok: false, message };
}

async function assertContained(
  adapter: GuardedFileAdapter,
  resolved: string,
  allowedRoots: readonly string[],
): Promise<string | null> {
  try {
    const canonical = await adapter.canonicalize(resolved);
    for (const root of allowedRoots) {
      const rootCanon = await adapter.canonicalize(root);
      const rel = path.relative(rootCanon, canonical);
      if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) {
        return canonical;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function readFileBytes(adapter: GuardedFileAdapter, canonical: string): Promise<Uint8Array> {
  return adapter.readFile(canonical);
}

async function stagedTargetBefore(
  adapter: GuardedFileAdapter,
  canonicalPath: string,
): Promise<Uint8Array | null> {
  const stat = await adapter.stat(canonicalPath);
  if (stat === null) return null;
  if (!stat.isFile || stat.isSymbolicLink) {
    throw new Error("OfficeCLI output target is not a regular file");
  }
  return new Uint8Array(await adapter.readFile(canonicalPath));
}

async function commitOfficeCliOutput(
  ctx: LocalOfficeCommandContext,
  args: {
    readonly displayPath: string;
    readonly zone: RelayLocalFileZone;
    readonly canonicalPath: string;
    readonly bytes: Uint8Array;
    readonly source?: {
      readonly canonicalPath: string;
      readonly bytes: Uint8Array;
    } | undefined;
    readonly targetBefore: Uint8Array | null;
    readonly summary: string;
    readonly skipOoxmlCheck?: boolean | undefined;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  if (!args.skipOoxmlCheck && !isOoxmlBuffer(args.bytes)) {
    return rejectMalformed(
      `office output failed OOXML validation (${args.bytes.byteLength} bytes; expected PK\\x03\\x04 magic)`,
    );
  }
  if (args.bytes.byteLength > MAX_OFFICE_OUTPUT_BYTES) {
    return rejectMalformed(`office output exceeds ${MAX_OFFICE_OUTPUT_BYTES} byte cap`);
  }
  if (!ctx.officeCliCommit) {
    return rejectMalformed("Desktop OfficeCLI mutation coordinator is unavailable");
  }
  const turnId = resolveLocalMutationTransactionId(ctx.routing);
  if (!turnId) {
    return rejectMalformed("turnId or appOperationId required for local office mutations");
  }
  const committed = await ctx.officeCliCommit({
    targetPath: args.canonicalPath,
    targetBefore: args.targetBefore,
    after: new Uint8Array(args.bytes),
    ...(args.source === undefined
      ? {}
      : {
          source: {
            path: args.source.canonicalPath,
            before: new Uint8Array(args.source.bytes),
          },
        }),
    agentId: ctx.routing.agentId,
    turnId,
  });
  if (!committed.ok) {
    return committed.code === "conflict"
      ? { ok: false, code: "CONFLICT", message: committed.message }
      : { ok: false, message: committed.message };
  }
  return {
    ok: true,
    result: {
      applied: true,
      revisionId: committed.revisionId,
      revisionGroupId: committed.revisionGroupId,
      operationId: committed.operationId,
      path: args.displayPath,
      zone: args.zone,
      byteLength: committed.byteLength,
      sha256: committed.sha256,
      summary: args.summary,
      binary: true,
    },
  };
}

function resolveRunner(ctx: LocalOfficeCommandContext): OfficeCreateRunFn | null {
  if (ctx.officeRun) return ctx.officeRun;
  const binaryPath = ctx.binaryPath ?? getCachedDesktopOfficeCliPath();
  if (!binaryPath) return null;
  return makeOfficeCreateRun({ binaryPath, timeoutMs: OFFICE_EXEC_TIMEOUT_MS });
}

async function runArgv(
  run: OfficeCreateRunFn,
  argv: readonly string[],
): Promise<OfficeCliRunResult | { error: string }> {
  if (argv.some((a) => typeof a !== "string")) {
    return { error: "office argv must be strings" };
  }
  const result = await run(argv);
  if (result.stdout.length > MAX_STDOUT_BYTES) {
    return { error: `office stdout exceeds ${MAX_STDOUT_BYTES} bytes` };
  }
  if (result.stderr.length > MAX_STDERR_BYTES) {
    return { error: `office stderr exceeds ${MAX_STDERR_BYTES} bytes` };
  }
  return result;
}

async function commitGeneratedBinaryOutput(
  ctx: LocalOfficeCommandContext,
  args: {
    zone: RelayLocalFileZone;
    displayPath: string;
    canonicalPath: string;
    resolvedPath: string;
    bytes: Uint8Array;
    summary: string;
    skipOoxmlCheck?: boolean | undefined;
    requireMissing?: boolean | undefined;
    targetBefore: Uint8Array | null;
    source?: {
      canonicalPath: string;
      bytes: Uint8Array;
    } | undefined;
  },
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  if (!args.skipOoxmlCheck && !isOoxmlBuffer(args.bytes)) {
    return rejectMalformed(
      `office output failed OOXML validation (${args.bytes.byteLength} bytes; expected PK\\x03\\x04 magic)`,
    );
  }
  if (args.bytes.byteLength > MAX_OFFICE_OUTPUT_BYTES) {
    return rejectMalformed(`office output exceeds ${MAX_OFFICE_OUTPUT_BYTES} byte cap`);
  }

  if (args.resolvedPath) {
    const currentCanonical = await assertContained(ctx.adapter, args.resolvedPath, ctx.allowedRoots);
    if (!currentCanonical || currentCanonical !== args.canonicalPath) {
      return { ok: false, message: "canonical path changed during office mutation" };
    }
  }
  if (args.requireMissing && args.targetBefore !== null) {
      return { ok: false, message: `A file already exists at "${args.displayPath}".`, code: "EXISTS" };
  }

  return commitOfficeCliOutput(ctx, {
    displayPath: args.displayPath,
    zone: args.zone,
    canonicalPath: args.canonicalPath,
    bytes: args.bytes,
    targetBefore: args.targetBefore,
    skipOoxmlCheck: args.skipOoxmlCheck,
    ...(args.source === undefined
      ? {}
      : {
          source: {
            canonicalPath: args.source.canonicalPath,
            bytes: args.source.bytes,
          },
        }),
    summary: args.summary,
  });
}

async function executeOfficeCliCreate(
  op: Extract<LocalOfficeWireOperation, { subkind: "officecli" }>,
  ctx: LocalOfficeCommandContext,
  run: OfficeCreateRunFn,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  const out = op.payload["out"];
  if (typeof out !== "string" || out.trim().length === 0) {
    return rejectMalformed("create requires out");
  }
  const resolved = resolveZonePath(op.zone, out, ctx.routing);
  if (!resolved.ok) return rejectMalformed(resolved.reason);
  const canonical = await assertContained(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!canonical) return rejectMalformed("output path escapes allowed roots");
  let targetBefore: Uint8Array | null;
  try {
    targetBefore = await stagedTargetBefore(ctx.adapter, canonical);
  } catch (error) {
    return rejectMalformed(error instanceof Error ? error.message : "OfficeCLI output target could not be staged");
  }
  if (targetBefore !== null) {
    return { ok: false, code: "EXISTS", message: `A file already exists at "${resolved.displayPath}".` };
  }

  const commands = op.payload["commands"];
  const batch = Array.isArray(commands) ? (commands as OfficeBatchCommand[]) : [];
  const generated = await generateOffice({
    fileName: path.basename(resolved.resolved),
    commands: batch,
    run,
    tempDirRoot: os.tmpdir(),
    ...(typeof op.payload["locale"] === "string" ? { locale: op.payload["locale"] } : {}),
    ...(op.payload["force"] === true ? { force: true } : {}),
    ...(op.payload["minimal"] === true ? { minimal: true } : {}),
  });

  return commitOfficeCliOutput(ctx, {
    displayPath: resolved.displayPath,
    zone: op.zone,
    canonicalPath: canonical,
    bytes: generated.bytes,
    targetBefore,
    summary: `Applied officecli create ${resolved.displayPath} (${generated.bytes.byteLength} bytes).`,
  });
}

async function executeOfficeCliDirect(
  op: Extract<LocalOfficeWireOperation, { subkind: "officecli" }>,
  ctx: LocalOfficeCommandContext,
  run: OfficeCreateRunFn,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  const inputPath = op.payload["path"];
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    return rejectMalformed("path is required");
  }
  const resolved = resolveZonePath(op.zone, inputPath, ctx.routing);
  if (!resolved.ok) return rejectMalformed(resolved.reason);
  const canonical = await assertContained(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!canonical) return rejectMalformed("input path escapes allowed roots");

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "officecli-local-"));
  const workPath = path.join(scratch, path.basename(resolved.resolved));
  try {
    const inputBytes = await readFileBytes(ctx.adapter, canonical);
    const output = READ_ONLY_COMMANDS.has(op.command)
      ? undefined
      : (() => {
          const out = op.payload["out"];
          if (typeof out !== "string" || out.trim().length === 0) {
            return { error: `'${op.command}' requires out for local-zone mutations` } as const;
          }
          const outResolved = resolveZonePath(op.zone, out, ctx.routing);
          if (!outResolved.ok) return { error: outResolved.reason } as const;
          return { outResolved } as const;
        })();
    if (output && "error" in output) return rejectMalformed(output.error);
    let outputResolved: { readonly resolved: string; readonly displayPath: string } | undefined;
    let outCanonical: string | undefined;
    if (output !== undefined) {
      outputResolved = output.outResolved;
      const contained = await assertContained(ctx.adapter, outputResolved.resolved, ctx.allowedRoots);
      if (!contained) return rejectMalformed("output path escapes allowed roots");
      outCanonical = contained;
    }
    let targetBefore: Uint8Array | null | undefined;
    if (outCanonical !== undefined) {
      try {
        targetBefore = outCanonical === canonical
          ? new Uint8Array(inputBytes)
          : await stagedTargetBefore(ctx.adapter, outCanonical);
      } catch (error) {
        return rejectMalformed(error instanceof Error ? error.message : "OfficeCLI output target could not be staged");
      }
    }
    if (outCanonical !== undefined && outCanonical !== canonical && targetBefore !== null) {
      return { ok: false, code: "EXISTS", message: `A file already exists at "${outputResolved?.displayPath ?? "output"}".` };
    }
    await fs.writeFile(workPath, inputBytes);

    const built = buildOfficeCliDirectArgv(op.command, op.payload, workPath);
    if ("error" in built) return rejectMalformed(built.error);
    const result = await runArgv(run, built);
    if ("error" in result) return rejectMalformed(result.error);
    if (result.exitCode !== 0) {
      return rejectMalformed(`officecli ${op.command} failed: exit ${result.exitCode}`);
    }

    if (READ_ONLY_COMMANDS.has(op.command)) {
      return {
        ok: true,
        result: result.stdout.length > 0 ? result.stdout : JSON.stringify({ ok: true, command: op.command }),
      };
    }

    if (
      output === undefined ||
      outputResolved === undefined ||
      outCanonical === undefined ||
      targetBefore === undefined
    ) {
      return rejectMalformed("OfficeCLI output staging is unavailable");
    }

    const produced = await fs.readFile(workPath);
    return commitOfficeCliOutput(ctx, {
      displayPath: outputResolved.displayPath,
      zone: op.zone,
      canonicalPath: outCanonical,
      bytes: produced,
      targetBefore,
      ...(outCanonical === canonical
        ? {}
        : { source: { canonicalPath: canonical, bytes: inputBytes } }),
      summary: `Applied officecli ${op.command} ${outputResolved.displayPath} (${produced.byteLength} bytes).`,
    });
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeOfficeRunRead(
  op: Extract<LocalOfficeWireOperation, { subkind: "officeRun"; mode: "read" }>,
  ctx: LocalOfficeCommandContext,
  run: OfficeCreateRunFn,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string }> {
  const readSpec = op.readSpec;
  if (!readSpec || typeof readSpec !== "object" || typeof readSpec.verb !== "string") {
    return rejectMalformed("officeRun read requires structured readSpec");
  }
  const resolved = resolveZonePath("current", op.inputPath, ctx.routing);
  if (!resolved.ok) return rejectMalformed(resolved.reason);
  const canonical = await assertContained(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!canonical) return rejectMalformed("input path escapes allowed roots");

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "office-run-read-"));
  const staged = path.join(scratch, path.basename(resolved.resolved));
  try {
    const inputBytes = await readFileBytes(ctx.adapter, canonical);
    await fs.writeFile(staged, inputBytes);
    const built = buildOfficeRunReadArgv(staged, readSpec);
    if ("error" in built) return rejectMalformed(built.error);
    const result = await runArgv(run, built);
    if ("error" in result) return rejectMalformed(result.error);
    if (result.exitCode !== 0) {
      return rejectMalformed(`officecli read exited ${result.exitCode}`);
    }
    const trimmed = result.stdout.trim();
    if (trimmed.length === 0) return rejectMalformed("officecli returned empty stdout");
    let json: unknown;
    try {
      json = JSON.parse(trimmed);
    } catch {
      return rejectMalformed("officecli stdout was not valid JSON");
    }
    const mediaByRelId =
      op.inputPath.toLowerCase().endsWith(".docx")
        ? docxMediaMapToDataUrls(extractDocxMediaByRelId(Buffer.from(inputBytes)))
        : undefined;
    return {
      ok: true,
      result: {
        json,
        ...(mediaByRelId && Object.keys(mediaByRelId).length > 0 ? { mediaByRelId } : {}),
      },
    };
  } finally {
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

async function executeOfficeRunWrite(
  op: Extract<LocalOfficeWireOperation, { subkind: "officeRun"; mode: "write" }>,
  ctx: LocalOfficeCommandContext,
  run: OfficeCreateRunFn,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  const resolved = resolveZonePath("current", op.outputPath, ctx.routing);
  if (!resolved.ok) return rejectMalformed(resolved.reason);
  const canonical = await assertContained(ctx.adapter, resolved.resolved, ctx.allowedRoots);
  if (!canonical) return rejectMalformed("output path escapes allowed roots");

  let targetBefore: Uint8Array | null;
  try {
    targetBefore = await stagedTargetBefore(ctx.adapter, canonical);
  } catch (error) {
    return rejectMalformed(
      error instanceof Error ? error.message : "office.run output target could not be staged",
    );
  }
  if (!op.overwrite && targetBefore !== null) {
    return { ok: false, message: `A file already exists at "${op.outputPath}".`, code: "EXISTS" };
  }

  const scratch = await fs.mkdtemp(path.join(os.tmpdir(), "office-run-write-"));
  const outPath = path.join(scratch, `output.${op.officeType}`);
  const imageScratch = path.join(scratch, "images");
  await fs.mkdir(imageScratch, { recursive: true });
  const stagedImages = await stageOfficeRunImageInputs(op.ops, op.imageInputs, imageScratch);
  if ("error" in stagedImages) return rejectMalformed(stagedImages.error);
  try {
    const create = await runArgv(run, [
      "create",
      outPath,
      "--type",
      op.officeType,
      "--locale",
      "en-US",
      "--force",
      "--json",
    ]);
    if ("error" in create) return rejectMalformed(create.error);
    if (create.exitCode !== 0) return rejectMalformed(`officecli create failed (${create.exitCode})`);

    if (Array.isArray(stagedImages.resolvedOps) && stagedImages.resolvedOps.length > 0) {
      const batch = await runArgv(run, [
        "batch",
        outPath,
        "--commands",
        JSON.stringify(stagedImages.resolvedOps),
        "--stop-on-error",
        "--json",
      ]);
      if ("error" in batch) return rejectMalformed(batch.error);
      if (batch.exitCode !== 0) return rejectMalformed(`officecli batch failed (${batch.exitCode})`);
    }

    const close = await runArgv(run, ["close", outPath, "--json"]);
    if ("error" in close) return rejectMalformed(close.error);
    if (close.exitCode !== 0) return rejectMalformed(`officecli close failed (${close.exitCode})`);

    const bytes = await fs.readFile(outPath);
    const written = await commitGeneratedBinaryOutput(ctx, {
      zone: "current",
      displayPath: resolved.displayPath,
      canonicalPath: canonical,
      resolvedPath: resolved.resolved,
      bytes,
      summary: `Applied office.run write ${resolved.displayPath} (${bytes.byteLength} bytes).`,
      requireMissing: !op.overwrite,
      targetBefore,
    });
    if (!written.ok) return written;
    const payload = written.result as { sha256: string; byteLength: number; path: string };
    return {
      ok: true,
      result: {
        sha256: payload.sha256,
        byteLength: payload.byteLength,
        displayPath: payload.path,
      },
    };
  } finally {
    await stagedImages.cleanup().catch(() => {});
    await fs.rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

export async function executeLocalOfficeOperation(
  raw: Record<string, unknown>,
  ctx: LocalOfficeCommandContext,
): Promise<{ ok: true; result: unknown } | { ok: false; message: string; code?: string }> {
  const routing = extractRouting(raw);
  if (!routing) return rejectMalformed("local office dispatch missing routing metadata");

  const forbidden = findForbiddenExecutionField(raw);
  if (forbidden) return rejectMalformed(forbidden);

  const subkind = raw["subkind"];
  if (subkind !== "officecli" && subkind !== "officeRun" && subkind !== "convert") {
    return rejectMalformed(`unsupported local office subkind: ${String(subkind)}`);
  }

  const runner = resolveRunner(ctx);
  if (!runner && subkind !== "convert") {
    return rejectMalformed("desktop OfficeCLI is not available on this relay");
  }

  const op = { ...raw, _routing: routing } as LocalOfficeWireOperation;

  if (subkind === "convert") {
    return executeLocalConvert(
      op as Extract<LocalOfficeWireOperation, { subkind: "convert" }>,
      ctx,
      {
        ...(ctx.convertRunner ? { convertRunner: ctx.convertRunner } : {}),
        writeOutput: (args) => commitGeneratedBinaryOutput(ctx, args),
      },
    );
  }

  if (subkind === "officeRun") {
    if (op.subkind !== "officeRun") {
      return rejectMalformed("expected officeRun operation");
    }
    if (op.mode === "read") {
      return executeOfficeRunRead(op, ctx, runner!);
    }
    return executeOfficeRunWrite(op, ctx, runner!);
  }

  const command = raw["command"];
  if (typeof command !== "string" || !ALLOWED_OFFICECLI_COMMANDS.has(command)) {
    return rejectMalformed(`unsupported or missing officecli command: ${String(command)}`);
  }
  const zone = raw["zone"];
  if (zone !== "current" && zone !== "absolute") {
    return rejectMalformed("officecli local operation requires zone current|absolute");
  }

  const officeOp = op as Extract<LocalOfficeWireOperation, { subkind: "officecli" }>;
  if (command === "help") {
    const format = resolveOfficeHelpFormat(officeOp.payload);
    if (!format) return rejectMalformed(OFFICE_HELP_FORMAT_ERROR);
    const helpArgv = buildHelpArgv({
      format,
      ...(typeof officeOp.payload["verb"] === "string" ? { verb: officeOp.payload["verb"] } : {}),
      ...(typeof officeOp.payload["element"] === "string" ? { element: officeOp.payload["element"] } : {}),
      json: officeOp.payload["json"] !== false,
    });
    const result = await runArgv(runner!, helpArgv);
    if ("error" in result) return rejectMalformed(result.error);
    if (result.exitCode !== 0) return rejectMalformed(formatOfficeHelpFailure(result));
    return { ok: true, result: result.stdout };
  }

  if (command === "create") {
    if (officeOp.payload["data"] !== undefined) {
      return rejectMalformed(OFFICECLI_CREATE_DATA_ERROR);
    }
    return executeOfficeCliCreate(officeOp, ctx, runner!);
  }

  return executeOfficeCliDirect(officeOp, ctx, runner!);
}
