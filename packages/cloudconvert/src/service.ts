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

export interface ConversionSubmission {
  readonly job: CloudConvertJob;
  readonly tag: string;
}

export interface ConversionResult {
  readonly job: CloudConvertJob;
  readonly bytes: Buffer;
  /** Provider-measured credits. CloudConvert does not expose authoritative USD here. */
  readonly credits: number | null;
}

const IMPORT_TASK = "import-input";
const CONVERT_TASK = "convert-file";
const EXPORT_TASK = "export-result";
const EXPORT_FETCH_TIMEOUT_MS = 30_000;
const JOB_POLL_WINDOW_MS = 30_000;
const JOB_POLL_INTERVAL_MS = 1_000;

function inputFilename(inputFormat: string): string {
  const ext = inputFormat.toLowerCase().replace(/^\./, "");
  return `input.${ext}`;
}

export function buildConvertTasks(
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

export function assertJobSucceeded(job: CloudConvertJob): void {
  if (job.status !== "error") {
    return;
  }

  const errorTask = job.tasks.find((task) => task.status === "error");
  const message = errorTask?.message ?? "Conversion failed";
  throw new Error(`CloudConvert error: ${message}`);
}

export function verifyCompletedJobTag(
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

function assertSafeExportUrl(rawUrl: string): URL {
  const url = new URL(rawUrl);
  const hostname = url.hostname.toLowerCase();
  if (
    url.protocol !== "https:" ||
    !(hostname === "cloudconvert.com" || hostname.endsWith(".cloudconvert.com")) ||
    url.username.length > 0 ||
    url.password.length > 0
  ) {
    throw new Error("CloudConvert export URL is outside the trusted download boundary");
  }
  return url;
}

async function readBoundedBody(response: Response, maxBytes: number): Promise<Buffer> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && /^\d+$/.test(advertised) && Number(advertised) > maxBytes) {
    throw new Error("CloudConvert export exceeds the permitted result size");
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error("CloudConvert export exceeds the permitted result size");
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total);
}

export async function fetchExportBuffer(
  client: CloudConvertClient,
  job: CloudConvertJob,
  maxBytes = 10 * 1024 * 1024,
  signal?: AbortSignal,
): Promise<Buffer> {
  const exportUrls = client.jobs.getExportUrls(job);
  if (exportUrls.length > 1) {
    throw new Error("CloudConvert returned multiple output files; this conversion route requires exactly one result");
  }
  const downloadUrl = exportUrls[0]?.url;

  if (!downloadUrl) {
    throw new Error("No export URLs returned from conversion");
  }

  let next = assertSafeExportUrl(downloadUrl);
  const timeoutSignal = AbortSignal.timeout(EXPORT_FETCH_TIMEOUT_MS);
  const fetchSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await fetch(next, { redirect: "manual", signal: fetchSignal });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      if (!location || redirects === 3) {
        throw new Error("CloudConvert export redirect could not be followed safely");
      }
      next = assertSafeExportUrl(new URL(location, next).toString());
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Failed to download converted file: ${response.status}`);
    }
    return readBoundedBody(response, maxBytes);
  }
  throw new Error("CloudConvert export redirect limit exceeded");
}

export function cloudConvertCredits(job: CloudConvertJob): number | null {
  let total = 0;
  let observed = false;
  for (const task of job.tasks) {
    if (task.credits === null || task.credits === undefined) continue;
    if (!Number.isFinite(task.credits) || task.credits < 0) return null;
    observed = true;
    total += task.credits;
  }
  return observed && Number.isFinite(total) ? total : null;
}

/** Submit exactly one provider job. The tag is correlation, never idempotency. */
export async function submitConversionWithClient(
  client: CloudConvertClient,
  bytes: Buffer,
  inputFormat: string,
  outputFormat: string,
  tag: string,
  signal?: AbortSignal,
): Promise<ConversionSubmission> {
  if (!tag.trim()) throw new Error("CloudConvert recovery tag is required");
  const job = await client.jobs.create({
    tasks: buildConvertTasks(bytes.toString("base64"), inputFormat, outputFormat),
    tag,
  }, signal ? { signal } : undefined);
  if (job.tag !== tag) throw new Error("CloudConvert submission tag was not preserved");
  return { job, tag };
}

/** Account-bound lookup used only to reconcile a lost submission response. */
export async function findConversionsByTag(
  client: CloudConvertClient,
  tag: string,
): Promise<CloudConvertJob[]> {
  const jobs = await client.jobs.all({ "filter[tag]": tag, per_page: 2, page: 1 });
  return jobs.filter((job) => job.tag === tag);
}

export async function getConversionWithClient(
  client: CloudConvertClient,
  jobId: string,
  tag: string,
): Promise<CloudConvertJob> {
  const job = await client.jobs.get(jobId);
  verifyCompletedJobTag(job, { tag });
  return job;
}

export async function waitForConversionWithClient(
  client: CloudConvertClient,
  jobId: string,
  tag: string,
  signal?: AbortSignal,
): Promise<CloudConvertJob> {
  const deadline = Date.now() + JOB_POLL_WINDOW_MS;
  let job = await getConversionWithClient(client, jobId, tag);
  while (job.status !== "finished" && job.status !== "error" && Date.now() < deadline) {
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const timer = setTimeout(finish, JOB_POLL_INTERVAL_MS);
      timer.unref?.();
      function abort() {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        reject(signal?.reason instanceof Error
          ? signal.reason
          : new Error("CloudConvert polling cancelled"));
      }
      if (!signal) return;
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    });
    job = await getConversionWithClient(client, jobId, tag);
  }
  return job;
}

export async function cancelConversionWithClient(
  client: CloudConvertClient,
  job: CloudConvertJob,
  tag: string,
): Promise<CloudConvertJob> {
  verifyCompletedJobTag(job, { tag });
  await Promise.all(job.tasks
    .filter((task) => task.status === "waiting" || task.status === "processing")
    .map((task) => client.tasks.cancel(task.id)));
  return getConversionWithClient(client, job.id, tag);
}

export async function downloadConversionWithClient(
  client: CloudConvertClient,
  job: CloudConvertJob,
  tag: string,
  maxBytes?: number,
  signal?: AbortSignal,
): Promise<ConversionResult> {
  verifyCompletedJobTag(job, { tag });
  assertJobSucceeded(job);
  if (job.status !== "finished") throw new Error("CloudConvert job is not ready for download");
  return {
    job,
    bytes: await fetchExportBuffer(client, job, maxBytes, signal),
    credits: cloudConvertCredits(job),
  };
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
