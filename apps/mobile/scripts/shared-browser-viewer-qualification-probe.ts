import {
  SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION,
  sharedBrowserViewerQualificationEligibility,
} from "../src/lib/shared-browser-viewer-policy.web";

const PROBE_RESULT_SCHEMA_VERSION = "nautilo.shared-browser-viewer-qualification-result.v2";

export interface ProbeResult {
  readonly schemaVersion: typeof PROBE_RESULT_SCHEMA_VERSION;
  readonly valid: boolean;
  readonly eligibleForSeparateApproval: boolean;
  readonly reason: string;
  readonly receipt?: unknown;
  readonly errors: readonly string[];
}

export interface ProbeExecution {
  readonly exitCode: 0 | 1;
  readonly result: ProbeResult;
}

function usageError(message: string): never { throw new Error(message); }

function receiptInputPath(args: readonly string[]): string | null {
  if (args.length === 0) return null;
  if (args.length === 2 && args[0] === "--receipt" && args[1] && !args[1].startsWith("-")) return args[1];
  usageError("usage: bun scripts/shared-browser-viewer-qualification-probe.ts [--receipt <file>] < receipt.json");
}

async function readReceiptInput(args: readonly string[]): Promise<string> {
  const path = receiptInputPath(args);
  try { return path ? await Bun.file(path).text() : await new Response(Bun.stdin.stream()).text(); }
  catch { throw new Error("unable to read qualification receipt input"); }
}

function toResult(value: unknown): ProbeResult {
  const eligibility = sharedBrowserViewerQualificationEligibility(value);
  return {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    valid: eligibility.validation.valid,
    eligibleForSeparateApproval: eligibility.eligible,
    reason: eligibility.reason,
    ...(eligibility.validation.receipt ? { receipt: eligibility.validation.receipt } : {}),
    errors: eligibility.validation.errors,
  };
}

function invalidInputResult(message: string): ProbeResult {
  return {
    schemaVersion: PROBE_RESULT_SCHEMA_VERSION,
    valid: false,
    eligibleForSeparateApproval: false,
    reason: "invalid-receipt",
    errors: [message],
  };
}

export function evaluateQualificationProbeInput(input: string): ProbeExecution {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input) as unknown;
  } catch {
    return { exitCode: 1, result: invalidInputResult("receipt input must be valid JSON") };
  }
  const result = toResult(parsed);
  return { exitCode: result.eligibleForSeparateApproval ? 0 : 1, result };
}

async function main(): Promise<void> {
  let input: string;
  try { input = await readReceiptInput(process.argv.slice(2)); }
  catch (error) {
    const message = error instanceof Error && error.message.startsWith("usage:") ? error.message : "receipt input must be valid JSON";
    process.stdout.write(`${JSON.stringify(invalidInputResult(message))}\n`);
    process.exitCode = 1;
    return;
  }
  const { exitCode, result } = evaluateQualificationProbeInput(input);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}

if (import.meta.main) void main();

export { SHARED_BROWSER_VIEWER_RECEIPT_SCHEMA_VERSION };
