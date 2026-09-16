import type {
  MaintenancePortableExportCheckpoint,
  MaintenanceProviderWorkflowCheckpoint,
} from "./maintenance-receipt";

const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export type PortableTransferDirection = "export" | "restore";
export type PortableTransferJobState = "running" | "complete" | "error" | "not-found";

/**
 * Request-only storage and encryption authority. Implementations must pass it
 * directly to the target job and must never serialize it into a maintenance
 * receipt, progress event, error, or command argument.
 */
export interface PortableTransferAuthority {
  readonly endpoint: string;
  readonly region: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly encryptionKey: Uint8Array;
}

export interface PortableTransferIdentity {
  /** Deterministic idempotency identity, safe to persist. */
  readonly operationId: string;
  /** Opaque object key identity only; never a URL or local path. */
  readonly objectId: string;
}

export interface PortableExportJobInput extends PortableTransferIdentity {
  readonly authority: PortableTransferAuthority;
}

export interface PortableRestoreJobInput extends PortableTransferIdentity {
  readonly expectedSha256: string;
  readonly authority: PortableTransferAuthority;
}

export interface PortableTransferJobReference {
  readonly jobId: string;
}

export type PortableTransferJobObservation =
  | { readonly state: "running" }
  | { readonly state: "error" | "not-found" }
  | {
      readonly state: "complete";
      readonly objectId: string;
      readonly sha256: string;
      readonly completedAt: string;
    };

type CompletedPortableTransferJob = Extract<
  PortableTransferJobObservation,
  { readonly state: "complete" }
>;

/**
 * Target-side execution boundary. There is deliberately no byte-returning API:
 * encrypted backup bytes flow between the target job and object storage only.
 */
export interface PortableTransferTarget {
  find(operationId: string): Promise<PortableTransferJobReference | undefined>;
  startExport(input: PortableExportJobInput): Promise<PortableTransferJobReference>;
  startRestore(input: PortableRestoreJobInput): Promise<PortableTransferJobReference>;
  observe(jobId: string): Promise<PortableTransferJobObservation>;
}

export interface PortableTransferScheduler {
  wait(milliseconds: number): Promise<void>;
}

export interface PortableTransferCoordinatorOptions {
  readonly target: PortableTransferTarget;
  readonly persistWorkflow: (
    checkpoint: MaintenanceProviderWorkflowCheckpoint,
  ) => Promise<void>;
  readonly scheduler?: PortableTransferScheduler | undefined;
  readonly intervalMs?: number | undefined;
  readonly maxAttempts?: number | undefined;
}

export type PortableTransferFailureCode =
  | "invalid-input"
  | "target-failed"
  | "start-unknown"
  | "checkpoint-failed"
  | "job-error"
  | "job-not-found"
  | "job-timeout"
  | "result-mismatch";

export type PortableExportResult =
  | { readonly outcome: "complete"; readonly checkpoint: MaintenancePortableExportCheckpoint }
  | { readonly outcome: "failure"; readonly code: PortableTransferFailureCode };

export type PortableRestoreResult =
  | { readonly outcome: "complete"; readonly completedAt: string }
  | { readonly outcome: "failure"; readonly code: PortableTransferFailureCode };

const defaultScheduler: PortableTransferScheduler = {
  // Intentionally referenced: after a one-shot target job exits this timer may
  // be the CLI's only live handle, and the coordinator must keep polling.
  wait: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function validTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString() === value;
}

function validIdentity(input: PortableTransferIdentity): boolean {
  return SAFE_ID.test(input.operationId) && SAFE_ID.test(input.objectId);
}

function validAuthority(authority: PortableTransferAuthority): boolean {
  let endpoint: URL;
  try {
    endpoint = new URL(authority.endpoint);
  } catch {
    return false;
  }
  return endpoint.protocol === "https:"
    && endpoint.username === ""
    && endpoint.password === ""
    && endpoint.search === ""
    && endpoint.hash === ""
    && authority.region.length > 0
    && authority.region.length <= 128
    && authority.bucket.length > 0
    && authority.bucket.length <= 255
    && authority.accessKeyId.length > 0
    && authority.accessKeyId.length <= 512
    && authority.secretAccessKey.length > 0
    && authority.secretAccessKey.length <= 2048
    && authority.encryptionKey.byteLength === 32;
}

export class PortableTransferCoordinator {
  readonly #target: PortableTransferTarget;
  readonly #persistWorkflow: PortableTransferCoordinatorOptions["persistWorkflow"];
  readonly #scheduler: PortableTransferScheduler;
  readonly #intervalMs: number;
  readonly #maxAttempts: number;

  constructor(options: PortableTransferCoordinatorOptions) {
    this.#target = options.target;
    this.#persistWorkflow = options.persistWorkflow;
    this.#scheduler = options.scheduler ?? defaultScheduler;
    this.#intervalMs = options.intervalMs ?? 1_000;
    this.#maxAttempts = options.maxAttempts ?? 900;
  }

  async #persist(checkpoint: MaintenanceProviderWorkflowCheckpoint): Promise<boolean> {
    try {
      await this.#persistWorkflow(checkpoint);
      return true;
    } catch {
      return false;
    }
  }

  async #resolveJob(
    direction: PortableTransferDirection,
    input: PortableExportJobInput | PortableRestoreJobInput,
    resumeJobId?: string,
  ): Promise<PortableTransferJobReference | PortableTransferFailureCode> {
    if (resumeJobId !== undefined) {
      return SAFE_ID.test(resumeJobId) ? { jobId: resumeJobId } : "invalid-input";
    }
    try {
      const existing = await this.#target.find(input.operationId);
      if (existing !== undefined) return SAFE_ID.test(existing.jobId) ? existing : "target-failed";
      const created = direction === "export"
        ? await this.#target.startExport(input as PortableExportJobInput)
        : await this.#target.startRestore(input as PortableRestoreJobInput);
      return SAFE_ID.test(created.jobId) ? created : "target-failed";
    } catch {
      // The mutation may have committed. Reobserve the deterministic operation
      // identity once, but never replay the mutation blindly.
      try {
        const observed = await this.#target.find(input.operationId);
        return observed !== undefined && SAFE_ID.test(observed.jobId)
          ? observed
          : "start-unknown";
      } catch {
        return "start-unknown";
      }
    }
  }

  async #poll(
    direction: PortableTransferDirection,
    jobId: string,
    expectedObjectId: string,
    expectedSha256?: string,
  ): Promise<CompletedPortableTransferJob | PortableTransferFailureCode> {
    for (let attempt = 0; attempt < this.#maxAttempts; attempt += 1) {
      let observed: PortableTransferJobObservation;
      try {
        observed = await this.#target.observe(jobId);
      } catch {
        return "target-failed";
      }
      if (observed.state === "error") return "job-error";
      if (observed.state === "not-found") return "job-not-found";
      if (observed.state === "complete") {
        if (observed.objectId !== expectedObjectId || !SHA256.test(observed.sha256)
            || !validTimestamp(observed.completedAt)
            || (direction === "restore" && observed.sha256 !== expectedSha256)) {
          return "result-mismatch";
        }
        return observed;
      }
      if (attempt + 1 < this.#maxAttempts) await this.#scheduler.wait(this.#intervalMs);
    }
    return "job-timeout";
  }

  async export(
    input: PortableExportJobInput,
    resumeJobId?: string,
  ): Promise<PortableExportResult> {
    if (!validIdentity(input) || !validAuthority(input.authority)
        || !Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1
        || !Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0) {
      return { outcome: "failure", code: "invalid-input" };
    }
    const job = await this.#resolveJob("export", input, resumeJobId);
    if (typeof job === "string") return { outcome: "failure", code: job };
    if (!await this.#persist({ operation: "export-portable", workflowId: job.jobId, state: "pending" })) {
      return { outcome: "failure", code: "checkpoint-failed" };
    }
    const observed = await this.#poll("export", job.jobId, input.objectId);
    if (typeof observed === "string") return { outcome: "failure", code: observed };
    if (!await this.#persist({
      operation: "export-portable",
      workflowId: job.jobId,
      state: "complete",
      completedAt: observed.completedAt,
    })) return { outcome: "failure", code: "checkpoint-failed" };
    return {
      outcome: "complete",
      checkpoint: {
        objectId: observed.objectId,
        sha256: observed.sha256,
        completedAt: observed.completedAt,
      },
    };
  }

  async restore(
    input: PortableRestoreJobInput,
    resumeJobId?: string,
  ): Promise<PortableRestoreResult> {
    if (!validIdentity(input) || !validAuthority(input.authority)
        || !SHA256.test(input.expectedSha256)
        || !Number.isSafeInteger(this.#maxAttempts) || this.#maxAttempts < 1
        || !Number.isSafeInteger(this.#intervalMs) || this.#intervalMs < 0) {
      return { outcome: "failure", code: "invalid-input" };
    }
    const job = await this.#resolveJob("restore", input, resumeJobId);
    if (typeof job === "string") return { outcome: "failure", code: job };
    if (!await this.#persist({ operation: "restore-portable", workflowId: job.jobId, state: "pending" })) {
      return { outcome: "failure", code: "checkpoint-failed" };
    }
    const observed = await this.#poll(
      "restore",
      job.jobId,
      input.objectId,
      input.expectedSha256,
    );
    if (typeof observed === "string") return { outcome: "failure", code: observed };
    if (!await this.#persist({
      operation: "restore-portable",
      workflowId: job.jobId,
      state: "complete",
      completedAt: observed.completedAt,
    })) return { outcome: "failure", code: "checkpoint-failed" };
    return { outcome: "complete", completedAt: observed.completedAt };
  }
}
