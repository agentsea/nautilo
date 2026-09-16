#!/usr/bin/env bun
/** Run the anonymous D372 Writer DOCX corpus measurement harness. */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  assertAnonymousJsonLine,
  DEFAULT_CORPUS_CASE_DEADLINE_MS,
  runWriterDocxCorpus,
} from "./writer-docx-corpus";

type Args = { officeCli?: string; realDocx?: string; runs: number; output?: string; caseDeadlineMs: number };

function usage(): never {
  throw new Error("usage: bun dev/scripts/office-transformation/qualify-writer-docx.ts --officecli <path> --real-docx <path> --runs <n> --output <jsonl> [--case-deadline-ms <n>]");
}

function parseArgs(argv: readonly string[]): Args {
  const parsed: Args = { runs: 1, caseDeadlineMs: DEFAULT_CORPUS_CASE_DEADLINE_MS };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    const value = argv[index + 1];
    if (key === "--officecli") parsed.officeCli = value;
    else if (key === "--real-docx") parsed.realDocx = value;
    else if (key === "--runs") parsed.runs = Number(value);
    else if (key === "--output") parsed.output = value;
    else if (key === "--case-deadline-ms") parsed.caseDeadlineMs = Number(value);
    else usage();
    index += 1;
  }
  if (!parsed.officeCli || !parsed.realDocx || !parsed.output || !Number.isInteger(parsed.runs) || parsed.runs < 1 || !Number.isFinite(parsed.caseDeadlineMs) || parsed.caseDeadlineMs <= 0) usage();
  return parsed;
}

try {
  const args = parseArgs(process.argv.slice(2));
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  try {
    const output = resolve(args.output!);
    await mkdir(dirname(output), { recursive: true });
    // A qualification run is one coherent sample. Never append to a prior run.
    await writeFile(output, "", "utf8");
    const metrics = await runWriterDocxCorpus({
      officeCli: args.officeCli!,
      realDocx: args.realDocx!,
      runs: args.runs,
      signal: controller.signal,
      caseDeadlineMs: args.caseDeadlineMs,
    });
    for (const metric of metrics) {
      const line = JSON.stringify(metric);
      assertAnonymousJsonLine(line);
      await appendFile(output, `${line}\n`, "utf8");
    }
    if (controller.signal.aborted) process.exitCode = 130;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
} catch (error) {
  process.stderr.write(`[writer-docx-corpus] ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
