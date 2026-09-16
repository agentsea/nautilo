/**
 * CloudConvert conversion service.
 *
 * Generalized file conversion via import/base64 → convert → export/url.
 * API keys should use task.read + task.write scopes only.
 */

import type { CloudConvertClient, CloudConvertJob } from "./client.ts";
import { createCloudConvertClient } from "./client.ts";
import { resolveConvertConfig } from "./config.ts";
import { logger } from "./logger.ts";

export interface ConvertOptions {
  sandbox?: boolean;
  region?: string;
  /** Correlation tag set on the job; verified before trusting the result. */
  tag?: string;
  /** Successful provider job receipt; raw job ids stay inside the caller's hashing boundary. */
  onCompleted?: (receipt: { jobId: string }) => void | Promise<void>;
}

const IMPORT_TASK = "import-input";
const CONVERT_TASK = "convert-file";
const EXPORT_TASK = "export-result";

function inputFilename(inputFormat: string): string {
  const ext = inputFormat.toLowerCase().replace(/^\./, "");
  return `input.${ext}`;
}

function buildConvertTasks(
  base64Content: string,
  inputFormat: string,
  outputFormat: string,
): Record<string, unknown> {
  const normalizedInput = inputFormat.toLowerCase();
  const normalizedOutput = outputFormat.toLowerCase();

  const convertTask: Record<string, unknown> = {
    operation: "convert",
    input: IMPORT_TASK,
    input_format: normalizedInput,
    output_format: normalizedOutput,
  };

  if (normalizedInput === "html" && normalizedOutput === "pdf") {
    Object.assign(convertTask, {
      engine: "chrome",
      margin_top: 25,
      margin_bottom: 25,
      margin_left: 25,
      margin_right: 25,
      print_background: true,
    });
  }

  return {
    [IMPORT_TASK]: {
      operation: "import/base64",
      file: base64Content,
      filename: inputFilename(normalizedInput),
    },
    [CONVERT_TASK]: convertTask,
    [EXPORT_TASK]: {
      operation: "export/url",
      input: CONVERT_TASK,
    },
  };
}

function assertJobSucceeded(job: CloudConvertJob): void {
  if (job.status !== "error") {
    return;
  }

  const errorTask = job.tasks.find((task) => task.status === "error");
  const message = errorTask?.message ?? "Conversion failed";
  throw new Error(`CloudConvert error: ${message}`);
}

function verifyCompletedJobTag(
  job: CloudConvertJob,
  opts?: ConvertOptions,
): void {
  if (!opts?.tag) {
    return;
  }

  if (job.tag !== opts.tag) {
    throw new Error("Job ownership verification failed");
  }
}

async function fetchExportBuffer(
  client: CloudConvertClient,
  job: CloudConvertJob,
): Promise<Buffer> {
  const exportUrls = client.jobs.getExportUrls(job);
  const downloadUrl = exportUrls[0]?.url;

  if (!downloadUrl) {
    throw new Error("No export URLs returned from conversion");
  }

  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(`Failed to download converted file: ${response.status}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Convert bytes using an existing CloudConvert client (test seam).
 */
export async function convertWithClient(
  client: CloudConvertClient,
  bytes: Buffer,
  inputFormat: string,
  outputFormat: string,
  opts?: ConvertOptions,
): Promise<Buffer> {
  const base64Content = bytes.toString("base64");
  const tasks = buildConvertTasks(base64Content, inputFormat, outputFormat);

  logger.info(`Starting conversion ${inputFormat} → ${outputFormat}`);

  const job = await client.jobs.create({
    tasks,
    ...(opts?.tag ? { tag: opts.tag } : {}),
  });

  const completedJob = await client.jobs.wait(job.id);

  verifyCompletedJobTag(completedJob, opts);
  assertJobSucceeded(completedJob);
  await opts?.onCompleted?.({ jobId: completedJob.id });

  const result = await fetchExportBuffer(client, completedJob);
  logger.info("Conversion completed successfully");
  return result;
}

/**
 * Convert arbitrary file bytes between formats via CloudConvert.
 *
 * Uses env CLOUDCONVERT_API_KEY (and optional sandbox/region overrides).
 * Fails closed when no API key is configured.
 */
export async function convert(
  bytes: Buffer,
  inputFormat: string,
  outputFormat: string,
  opts?: ConvertOptions,
): Promise<Buffer> {
  const config = resolveConvertConfig(opts);

  if (!config.apiKey) {
    throw new Error(
      "CLOUDCONVERT_API_KEY environment variable is required for cloud conversion",
    );
  }

  const client = createCloudConvertClient(
    config.apiKey,
    config.sandbox,
    config.region,
  );

  return convertWithClient(client, bytes, inputFormat, outputFormat, opts);
}
