/**
 * D372 Writer DOCX corpus harness.
 *
 * This is a measurement tool, deliberately not a product-limit policy.  It
 * writes the OfficeCLI streams to scratch files, then records anonymous byte
 * counts and hashes.  Corpus reports contain no user content, paths, or file
 * names.  Generated inputs are fixed-data OOXML mutations so repeat runs are
 * comparable; an operator supplied document is always identified only as
 * `external-real`.
 */

import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { once } from "node:events";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { docxMediaMapToDataUrls, extractDocxMediaByRelId } from "../../../packages/config/src/officecli/office-run-images";
import { mapOfficeCliGetEnvelope } from "../../../packages/first-party-apps/writer/src/docx-mapper";
import {
  serializeWriterHtml,
  wafflebaseDocumentToPayload,
  type WriterHtmlManifest,
} from "../../../packages/first-party-apps/writer/src/office-document";

export const CORPUS_FIXTURE = "packages/server/tests/integration/fixtures/d391-roundtrip.docx";
/** Valid DOS ZIP timestamp (2000-01-01 UTC) for reproducible generated cases. */
export const FIXED_ZIP_MTIME = new Date("2000-01-01T00:00:00.000Z");
/** Harness safety only. This is not a product transformation deadline. */
export const DEFAULT_CORPUS_CASE_DEADLINE_MS = 120_000;
const FIXED_MANIFEST: WriterHtmlManifest = {
  documentType: "document",
  editor: "wafflebase",
  payloadId: "wafflebase-document",
  payloadFormat: "application/vnd.wafflebase.document+json",
  version: "1.0",
  metadata: { createdBy: "nautilo-corpus", updatedAt: "2000-01-01T00:00:00.000Z" },
};

export type CorpusCategory =
  | "committed-ordinary"
  | "external-real"
  | "generated-high-expansion"
  | "malformed-truncated-zip"
  | "malformed-document-xml"
  | "generated-near-canonical"
  | "generated-image-heavy"
  | "export-workspace"
  | "import-current-folder"
  | "export-current-folder"
  | "cancellation-qualification";

export type CorpusOperation = "import" | "export";
export type CorpusSurface = "workspace" | "current-folder";

export type UnsupportedCase = {
  readonly category: Exclude<CorpusCategory, "committed-ordinary" | "external-real" | "generated-high-expansion" | "malformed-truncated-zip" | "malformed-document-xml">;
  readonly status: "unsupported";
  readonly format: "docx";
  readonly operation: CorpusOperation;
  readonly surface: CorpusSurface;
  readonly reason: string;
};

export type CorpusDescriptor = {
  readonly category: Exclude<CorpusCategory, "generated-near-canonical" | "generated-image-heavy">;
  readonly bytes: Uint8Array;
};

export type CapturedChild = {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
};

export class CorpusCaptureCancelledError extends Error {
  constructor() {
    super("corpus child capture cancelled before or during process execution");
    this.name = "CorpusCaptureCancelledError";
  }
}

export class CorpusCaptureDeadlineError extends Error {
  constructor() {
    super("corpus case deadline elapsed before OfficeCLI completed");
    this.name = "CorpusCaptureDeadlineError";
  }
}

export type CorpusMetric = {
  readonly category: CorpusCategory;
  readonly status: "measured" | "converter-failed" | "mapper-failed" | "deadline" | "cancelled" | "unsupported";
  readonly format: "docx";
  readonly operation: CorpusOperation;
  readonly surface: CorpusSurface;
  readonly source?: { readonly sha256: string; readonly bytes: number };
  readonly officecli?: { readonly exitCode: number | null; readonly stdoutBytes: number; readonly stderrBytes: number };
  readonly wire?: {
    /** Exact worker-protocol `rpc-res` frame for the measured `office.run` value. */
    readonly officeRunRpcResponseJsonLineBytes: number;
    /** Fixed-redaction lower bound, not an exact invocation-specific frame. */
    readonly writerDocumentCreateRepresentativeLowerBoundJsonLineBytes: number;
    readonly writerDocumentCreateRepresentativeScope: "workspace import; fixed redacted logical paths; no artifact-specific path bytes";
    readonly writerDocumentCreateRepresentativeShape: "rpc document.createDocument args[0]";
  };
  readonly writerHtmlBytes?: number;
  readonly durationMs?: number;
  readonly rss: { readonly available: false; readonly reason: string };
  readonly reason?: string;
};

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Exact UTF-8 accounting for the JSON-line worker/relay envelope, newline included. */
export function jsonLineBytes(value: unknown): number {
  return Buffer.byteLength(`${JSON.stringify(value)}\n`, "utf8");
}

export function classifyDocxBytes(bytes: Uint8Array): "valid-zip" | "malformed-truncated-zip" | "malformed-document-xml" {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes) as Record<string, Uint8Array>;
  } catch {
    return "malformed-truncated-zip";
  }
  const documentXml = entries["word/document.xml"];
  if (documentXml === undefined || !strFromU8(documentXml).includes("</w:document>")) {
    return "malformed-document-xml";
  }
  return "valid-zip";
}

/**
 * fflate's synchronous archive writer emits deterministic bytes when the
 * archive timestamp is explicit. This avoids host-clock noise without
 * claiming a product-sized near-limit corpus.
 */
function rewriteDocx(bytes: Uint8Array, mutateDocumentXml: (xml: string) => string): Uint8Array {
  const entries = unzipSync(bytes) as Record<string, Uint8Array>;
  const original = entries["word/document.xml"];
  if (original === undefined) throw new Error("template lacks word/document.xml");
  entries["word/document.xml"] = strToU8(mutateDocumentXml(strFromU8(original)));
  return zipSync(entries, { level: 6, mtime: FIXED_ZIP_MTIME });
}

export function makeHighExpansionDocx(template: Uint8Array): Uint8Array {
  // 512 KiB of repeated paragraph text gives a strongly compressed source and
  // a meaningfully expanded OOJSON/HTML result, while keeping local runs sane.
  const repeated = "A".repeat(512 * 1024);
  return rewriteDocx(template, (xml) => xml.replace(
    /<w:body>[\s\S]*<\/w:body>/,
    `<w:body><w:p><w:r><w:t>${repeated}</w:t></w:r></w:p><w:sectPr/></w:body>`,
  ));
}

export function makeMalformedDocumentXmlDocx(template: Uint8Array): Uint8Array {
  return rewriteDocx(template, () => "<w:document><w:body><w:p>");
}

export function makeTruncatedZip(bytes: Uint8Array): Uint8Array {
  return bytes.slice(0, Math.max(1, Math.floor(bytes.byteLength / 2)));
}

export function unsupportedDescriptors(): readonly UnsupportedCase[] {
  return [
    {
      category: "generated-near-canonical",
      status: "unsupported",
      format: "docx",
      operation: "import",
      surface: "workspace",
      reason: "requires measured canonical-byte target; this harness never selects policy numbers",
    },
    {
      category: "generated-image-heavy",
      status: "unsupported",
      format: "docx",
      operation: "import",
      surface: "workspace",
      reason: "requires a representative licensed image corpus; synthetic image padding would mismeasure OOXML media behavior",
    },
    {
      category: "export-workspace",
      status: "unsupported",
      format: "docx",
      operation: "export",
      surface: "workspace",
      reason: "Writer DOCX export is not exercised by this import corpus harness",
    },
    {
      category: "import-current-folder",
      status: "unsupported",
      format: "docx",
      operation: "import",
      surface: "current-folder",
      reason: "current-folder relay framing and local authority are not exercised by this workspace harness",
    },
    {
      category: "export-current-folder",
      status: "unsupported",
      format: "docx",
      operation: "export",
      surface: "current-folder",
      reason: "current-folder export relay is not exercised by this workspace import harness",
    },
    {
      category: "cancellation-qualification",
      status: "unsupported",
      format: "docx",
      operation: "import",
      surface: "workspace",
      reason: "cancellation has a child cleanup sentinel test; end-to-end app-worker qualification is not exercised here",
    },
  ];
}

export async function buildCorpus(realDocxPath?: string): Promise<readonly CorpusDescriptor[]> {
  const template = new Uint8Array(await readFile(resolveRepoFile(CORPUS_FIXTURE)));
  const corpus: CorpusDescriptor[] = [
    { category: "committed-ordinary", bytes: template },
    { category: "generated-high-expansion", bytes: makeHighExpansionDocx(template) },
    { category: "malformed-truncated-zip", bytes: makeTruncatedZip(template) },
    { category: "malformed-document-xml", bytes: makeMalformedDocumentXmlDocx(template) },
  ];
  if (realDocxPath !== undefined) {
    corpus.splice(1, 0, { category: "external-real", bytes: new Uint8Array(await readFile(realDocxPath)) });
  }
  return corpus;
}

function resolveRepoFile(relative: string): string {
  return resolve(import.meta.dir, "../../..", relative);
}

/** Runs a child with on-disk stream capture; no output cap is selected here. */
export async function captureChild(
  command: string,
  args: readonly string[],
  options: { readonly signal?: AbortSignal; readonly deadlineAt?: number; readonly cwd?: string } = {},
): Promise<CapturedChild> {
  // This check is intentionally before mkdtemp/spawn: a pre-aborted caller
  // must not create a child or scratch files that need later recovery.
  if (options.signal?.aborted) throw new CorpusCaptureCancelledError();
  if (options.deadlineAt !== undefined && options.deadlineAt <= Date.now()) {
    throw new CorpusCaptureDeadlineError();
  }
  const scratch = await mkdtemp(join(tmpdir(), "nautilo-writer-corpus-"));
  const stdoutPath = join(scratch, "stdout");
  const stderrPath = join(scratch, "stderr");
  try {
    const child: ChildProcess = spawn(command, [...args], {
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (child.stdout === null || child.stderr === null) throw new Error("child did not expose stdout/stderr");
    const stdoutSink = createWriteStream(stdoutPath);
    const stderrSink = createWriteStream(stderrPath);
    const stdoutFinished = once(stdoutSink, "finish");
    const stderrFinished = once(stderrSink, "finish");
    child.stdout.pipe(stdoutSink);
    child.stderr.pipe(stderrSink);
    let terminalError: CorpusCaptureCancelledError | CorpusCaptureDeadlineError | undefined;
    const terminate = (error: CorpusCaptureCancelledError | CorpusCaptureDeadlineError): void => {
      if (terminalError !== undefined) return;
      terminalError = error;
      child.kill("SIGKILL");
    };
    const abort = (): void => terminate(new CorpusCaptureCancelledError());
    const remainingMs = options.deadlineAt === undefined ? undefined : options.deadlineAt - Date.now();
    const deadlineTimer = remainingMs === undefined ? undefined : setTimeout(
      () => terminate(new CorpusCaptureDeadlineError()),
      Math.max(0, remainingMs),
    );
    options.signal?.addEventListener("abort", abort, { once: true });
    try {
      // Close the listener-installation race: an abort between the precheck and
      // addEventListener still kills the now-observable child.
      if (options.signal?.aborted) abort();
      const [exitCode, signal] = await once(child, "close") as [number | null, NodeJS.Signals | null];
      await Promise.all([stdoutFinished, stderrFinished]);
      if (terminalError !== undefined) throw terminalError;
      return {
        exitCode,
        signal,
        stdout: new Uint8Array(await readFile(stdoutPath)),
        stderr: new Uint8Array(await readFile(stderrPath)),
      };
    } finally {
      // `once(child, "close")` rejects when spawn reports ENOENT. Do this in
      // finally so that failed spawns do not retain a 120-second deadline timer
      // or a caller AbortSignal listener.
      options.signal?.removeEventListener("abort", abort);
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer);
      if (!stdoutSink.writableFinished) stdoutSink.destroy();
      if (!stderrSink.writableFinished) stderrSink.destroy();
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    // The return above is observed only after this finally block completes.
    // A failed remove throws rather than silently reporting successful cleanup.
  }
}

async function measureOne(
  descriptor: CorpusDescriptor,
  officeCli: string,
  workDir: string,
  signal: AbortSignal | undefined,
  caseDeadlineMs: number,
): Promise<CorpusMetric> {
  const started = performance.now();
  const deadlineAt = Date.now() + caseDeadlineMs;
  const inputPath = join(workDir, `${descriptor.category}.docx`);
  const base = {
    category: descriptor.category,
    format: "docx" as const,
    operation: "import" as const,
    surface: "workspace" as const,
    source: { sha256: sha256(descriptor.bytes), bytes: descriptor.bytes.byteLength },
    rss: { available: false as const, reason: "not captured: cross-platform child RSS probe intentionally omitted" },
  };
  try {
    if (signal?.aborted) throw new CorpusCaptureCancelledError();
    if (deadlineAt <= Date.now()) throw new CorpusCaptureDeadlineError();
    await writeFile(inputPath, descriptor.bytes);
    const child = await captureChild(officeCli, ["get", inputPath, "/body", "--depth", "6", "--json"], { ...(signal ? { signal } : {}), deadlineAt });
    const completed = {
      ...base,
      officecli: { exitCode: child.exitCode, stdoutBytes: child.stdout.byteLength, stderrBytes: child.stderr.byteLength },
      durationMs: Math.round((performance.now() - started) * 100) / 100,
    };
    if (child.exitCode !== 0) {
      return { ...completed, status: "converter-failed", reason: "officecli exited non-zero" };
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse(Buffer.from(child.stdout).toString("utf8"));
    } catch {
      return { ...completed, status: "converter-failed", reason: "officecli emitted invalid JSON" };
    }
    try {
      const mapped = mapOfficeCliGetEnvelope(envelope as never);
      const html = serializeWriterHtml(FIXED_MANIFEST, wafflebaseDocumentToPayload(mapped.document));
      // Exact app-tool-worker protocol envelopes. The application response
      // carries media data URLs where a DOCX has embedded images, so their JSON
      // escaping is included. Redacted logical paths preserve byte accounting
      // for the fixed harness frame without leaking an operator filename.
      const mediaByRelId = docxMediaMapToDataUrls(extractDocxMediaByRelId(Buffer.from(descriptor.bytes)));
      const officeValue = {
        ok: true as const,
        json: envelope,
        ...(Object.keys(mediaByRelId).length > 0 ? { mediaByRelId } : {}),
      };
      const officeRunRpcResponseJsonLineBytes = jsonLineBytes({
        type: "rpc-res",
        id: 1,
        ok: true,
        value: officeValue,
      });
      const writerDocumentCreateRepresentativeLowerBoundJsonLineBytes = jsonLineBytes({
        type: "rpc",
        id: 2,
        method: "document.createDocument",
        args: [{
          surface: "workspace",
          path: "[redacted].html",
          content: html,
          mimeType: "text/html",
          overwrite: false,
          colocateWith: { surface: "workspace", path: "[redacted].docx" },
        }],
      });
      return {
        ...completed,
        status: "measured",
        wire: {
          officeRunRpcResponseJsonLineBytes,
          writerDocumentCreateRepresentativeLowerBoundJsonLineBytes,
          writerDocumentCreateRepresentativeScope: "workspace import; fixed redacted logical paths; no artifact-specific path bytes",
          writerDocumentCreateRepresentativeShape: "rpc document.createDocument args[0]",
        },
        writerHtmlBytes: Buffer.byteLength(html, "utf8"),
      };
    } catch (error) {
      return { ...completed, status: "mapper-failed", reason: error instanceof Error ? error.name : "unknown mapper failure" };
    }
  } catch (error) {
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    if (error instanceof CorpusCaptureDeadlineError) {
      return { ...base, status: "deadline", durationMs, reason: "harness per-case deadline elapsed" };
    }
    if (error instanceof CorpusCaptureCancelledError) {
      return { ...base, status: "cancelled", durationMs, reason: "harness cancellation signal received" };
    }
    throw error;
  } finally {
    await rm(inputPath, { force: true });
  }
}

export async function runWriterDocxCorpus(options: {
  readonly officeCli: string;
  readonly realDocx: string;
  readonly runs: number;
  readonly signal?: AbortSignal;
  readonly caseDeadlineMs?: number;
}): Promise<readonly CorpusMetric[]> {
  if (!Number.isInteger(options.runs) || options.runs < 1) throw new Error("runs must be a positive integer");
  const caseDeadlineMs = options.caseDeadlineMs ?? DEFAULT_CORPUS_CASE_DEADLINE_MS;
  if (!Number.isFinite(caseDeadlineMs) || caseDeadlineMs <= 0) {
    throw new Error("caseDeadlineMs must be a positive finite number");
  }
  const corpus = await buildCorpus(options.realDocx);
  const workDir = await mkdtemp(join(tmpdir(), "nautilo-writer-corpus-inputs-"));
  try {
    const metrics: CorpusMetric[] = [];
    for (let run = 0; run < options.runs; run += 1) {
      for (const descriptor of corpus) {
        metrics.push(await measureOne(descriptor, options.officeCli, workDir, options.signal, caseDeadlineMs));
        if (options.signal?.aborted) break;
      }
      if (options.signal?.aborted) break;
    }
    for (const unsupported of unsupportedDescriptors()) {
      metrics.push({ ...unsupported, rss: { available: false, reason: "not applicable" } });
    }
    return metrics;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function assertAnonymousJsonLine(line: string): void {
  const forbidden = ["The_Infinite_Stack", "/Users/", "\\\\", basename(CORPUS_FIXTURE)];
  if (forbidden.some((fragment) => line.includes(fragment))) {
    throw new Error("corpus output included a forbidden path or filename fragment");
  }
}
