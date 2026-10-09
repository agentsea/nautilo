import { createHash, randomBytes } from "node:crypto";
import type {
  CloudConversionExecutionRequest,
  CloudConversionExecutionResult,
  CloudConversionRecoveryRequest,
  ConversionRuntime,
  UsageFundingProvenance,
} from "@nautilo/agent";
import {
  cancelConversionWithClient,
  cloudConvertCredits,
  createCloudConvertClient,
  downloadConversionWithClient,
  findConversionsByTag,
  getCloudConvertConfig,
  getConversionWithClient,
  submitConversionWithClient,
  waitForConversionWithClient,
  type CloudConvertClient,
  type CloudConvertJob,
} from "@nautilo/cloudconvert";
import {
  attachConversionProviderJob,
  cancelConversionBeforeProviderDispatch,
  claimConversionPublication,
  claimConversionSubmission,
  confirmConversionPublished,
  createConversionOperation,
  expireConversionSubmissionLease,
  failConversionPublication,
  getConversionOperationByKey,
  getConversionOperationByRecoveryHandle,
  listRecoverableConversionOperations,
  markConversionProcessing,
  markConversionProviderFinished,
  markConversionReadyToPublish,
  markConversionRecoveryAmbiguous,
  markConversionSubmissionUnknown,
  markConversionTerminal,
  requestConversionCancellation,
  touchConversionRecoveryAttempt,
  type ConversionOperation,
  type CreateConversionOperationInput,
} from "@nautilo/db";
import type { DurableServiceFundingBinding } from "@nautilo/types";
import {
  beginServerProviderCostAttempt,
  settleServerProviderCostAttempt,
  type ServerProviderCostAttemptAdmission,
  type ServerProviderCostReceipt,
} from "../costs/provider-cost-recorder";
import {
  admitDurableServiceFunding,
  runWithDurableServiceFunding,
} from "../lib/service-funding";
import { ModelFundingError } from "../lib/model-funding";

type ConversionStore = Readonly<{
  create(input: CreateConversionOperationInput): Promise<ConversionOperation>;
  getByKey(operationKey: string): Promise<ConversionOperation | null>;
  getByHandle(recoveryHandle: string): Promise<ConversionOperation | null>;
  listRecoverable(limit: number): Promise<ConversionOperation[]>;
  touchRecovery(input: Pick<ConversionOperation, "operationKey" | "status" | "version">): Promise<ConversionOperation | null>;
  claimSubmission(input: { operationKey: string; leaseId: string; leaseExpiresAt: Date }): Promise<ConversionOperation | null>;
  expireSubmissionLease(input: { operationKey: string; now: Date }): Promise<ConversionOperation | null>;
  submissionUnknown(operationKey: string, failureCode: string): Promise<ConversionOperation | null>;
  attachJob(input: { operationKey: string; providerJobId: string; submissionLeaseId?: string }): Promise<ConversionOperation | null>;
  recoveryAmbiguous(operationKey: string, failureCode: "provider_job_missing" | "provider_job_ambiguous"): Promise<ConversionOperation | null>;
  processing(operationKey: string): Promise<ConversionOperation | null>;
  providerFinished(input: { operationKey: string; providerCredits: string | null }): Promise<ConversionOperation | null>;
  ready(input: { operationKey: string; providerCredits: string | null; outputSha256: string; outputBytes: number }): Promise<ConversionOperation | null>;
  claimPublication(operationKey: string): Promise<ConversionOperation | null>;
  published(input: { operationKey: string; publicationRevisionId: string; publicationArtifactId: string }): Promise<ConversionOperation | null>;
  failPublication(input: { operationKey: string; failureCode: string }): Promise<ConversionOperation | null>;
  requestCancel(operationKey: string): Promise<ConversionOperation | null>;
  cancelBeforeDispatch(input:
    | { operationKey: string; phase: "prepared" }
    | { operationKey: string; phase: "submitting"; submissionLeaseId: string }
  ): Promise<ConversionOperation | null>;
  terminal(input: { operationKey: string; status: "cancelled" | "failed" | "expired"; failureCode: string; providerCredits?: string | null }): Promise<ConversionOperation | null>;
}>;

const DEFAULT_STORE: ConversionStore = {
  create: createConversionOperation,
  getByKey: getConversionOperationByKey,
  getByHandle: getConversionOperationByRecoveryHandle,
  listRecoverable: listRecoverableConversionOperations,
  touchRecovery: touchConversionRecoveryAttempt,
  claimSubmission: claimConversionSubmission,
  expireSubmissionLease: expireConversionSubmissionLease,
  submissionUnknown: markConversionSubmissionUnknown,
  attachJob: attachConversionProviderJob,
  recoveryAmbiguous: markConversionRecoveryAmbiguous,
  processing: markConversionProcessing,
  providerFinished: markConversionProviderFinished,
  ready: markConversionReadyToPublish,
  claimPublication: claimConversionPublication,
  published: confirmConversionPublished,
  failPublication: failConversionPublication,
  requestCancel: requestConversionCancellation,
  cancelBeforeDispatch: cancelConversionBeforeProviderDispatch,
  terminal: markConversionTerminal,
};

const SUBMISSION_TRANSPORT_TIMEOUT_MS = 30_000;
const SUBMISSION_LEASE_MS = 60_000;
const PROVIDER_READ_TIMEOUT_MS = 35_000;

class SubmissionTransportTimeoutError extends Error {
  constructor() {
    super("CloudConvert submission transport timed out");
    this.name = "SubmissionTransportTimeoutError";
  }
}

async function withSubmissionTimeout<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SubmissionTransportTimeoutError()), SUBMISSION_TRANSPORT_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function withProviderReadBound<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const bound = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("CloudConvert recovery read timed out")),
      PROVIDER_READ_TIMEOUT_MS,
    );
    timer.unref?.();
    if (signal) {
      abort = () => reject(signal.reason instanceof Error
        ? signal.reason
        : new Error("CloudConvert recovery cancelled"));
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, bound]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abort) signal.removeEventListener("abort", abort);
  }
}

export interface CloudConversionRuntimeDependencies {
  readonly store?: ConversionStore;
  readonly admitFunding?: typeof admitDurableServiceFunding;
  readonly runFunding?: typeof runWithDurableServiceFunding;
  readonly createClient?: (
    apiKey: string,
    endpoint: Readonly<{ sandbox: boolean; region: string | null }>,
  ) => CloudConvertClient;
  readonly beginCost?: (receipt: ServerProviderCostAttemptAdmission) => Promise<void>;
  readonly settleCost?: (receipt: ServerProviderCostReceipt) => Promise<void>;
}

export interface ProductionCloudConversionRuntime extends ConversionRuntime {
  /** Content-free boot recovery. It never submits, downloads, or publishes. */
  reconcilePending(limit: number): Promise<Readonly<{ inspected: number; changed: number }>>;
  start(policy: Readonly<{ intervalMs: number; batchSize: number }>): void;
  stop(): Promise<void>;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, child]) => child !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, canonical(child)]),
  );
  return value;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function operationKey(request: CloudConversionExecutionRequest): string {
  return digest({
    domain: "nautilo/cloud-conversion/v1",
    human: request.execution.causalHumanUserId,
    room: request.execution.roomId,
    agent: request.execution.agentId,
    turn: request.execution.turnId,
    toolCall: request.execution.toolCallId,
    task: request.execution.taskId ?? null,
    run: request.execution.runId ?? null,
  });
}

function recoveryHandle(key: string): string {
  return `cvr_${digest({ domain: "nautilo/cloud-conversion-recovery/v1", key }).slice(0, 32)}`;
}

function providerTag(key: string): string {
  return `ntlo_cv_${digest({ domain: "nautilo/cloudconvert-tag/v1", key }).slice(0, 32)}`;
}

function fundingFromRow(row: ConversionOperation): DurableServiceFundingBinding {
  const binding = row.fundingKind === "personal"
    ? {
        kind: "personal" as const,
        providerRoute: "cloudconvert",
        credentialId: row.credentialId!,
        credentialRevision: row.credentialRevision!,
      }
    : { kind: "server" as const, providerRoute: "cloudconvert" };
  return {
    humanUserId: row.causalHumanUserId,
    provider: "cloudconvert",
    binding,
    credentialFingerprint: row.credentialFingerprint,
  };
}

function usageFunding(binding: DurableServiceFundingBinding): UsageFundingProvenance {
  return binding.binding.kind === "personal"
    ? {
        kind: "personal",
        humanUserId: binding.humanUserId,
        payerHumanId: binding.humanUserId,
        providerRoute: "cloudconvert",
        credentialId: binding.binding.credentialId,
        credentialRevision: binding.binding.credentialRevision,
      }
    : {
        kind: "server",
        humanUserId: binding.humanUserId,
        providerRoute: "cloudconvert",
      };
}

function costBase(row: ConversionOperation): ServerProviderCostAttemptAdmission {
  return {
    identity: `cloud-conversion:${row.operationKey}:provider-job`,
    usageFunding: usageFunding(fundingFromRow(row)),
    userId: row.causalHumanUserId,
    roomId: row.roomId,
    agentId: row.agentId,
    taskId: row.taskId,
    runId: row.runId,
    jobId: row.jobId,
    workload: "conversion",
    provider: "cloudconvert",
    operation: "conversion",
  };
}

function creditsValue(job: CloudConvertJob): { db: string | null; measured: number | null } {
  const measured = cloudConvertCredits(job);
  return {
    db: measured === null ? null : measured.toFixed(8),
    measured,
  };
}

function publicError(
  code: string,
  message: string,
  row?: ConversionOperation,
  options: { retryable?: boolean; uncertainEffect?: boolean } = {},
): CloudConversionExecutionResult {
  return {
    status: "error",
    code,
    message,
    retryable: options.retryable ?? false,
    uncertainEffect: options.uncertainEffect ?? false,
    ...(row ? { operationKey: row.operationKey } : {}),
    ...(row ? { recoveryHandle: row.recoveryHandle } : {}),
  };
}

function providerHttpStatus(error: unknown): number | null {
  if (!(error instanceof Error)) return null;
  return error.cause instanceof Response ? error.cause.status : null;
}

function creatingAccountError(row: ConversionOperation, error: unknown): CloudConversionExecutionResult {
  if (error instanceof ModelFundingError && error.code === "personal_credential_stale") {
    return publicError(
      "creating_credential_changed",
      `The personal key record that created this CloudConvert job was replaced or deleted. A new key revision cannot take over the job. Preserve ${row.recoveryHandle}; an operator can restore the original credential record and custody, or the Human can inspect the job in the original provider account.`,
      row,
      { uncertainEffect: true },
    );
  }
  if (error instanceof ModelFundingError && error.code === "personal_credential_unavailable") {
    return publicError(
      "creating_credential_custody_unavailable",
      `The exact personal key record still owns this CloudConvert job, but its encrypted custody is unavailable. Repair instance custody, then resume ${row.recoveryHandle}.`,
      row,
      { retryable: true, uncertainEffect: true },
    );
  }
  if (error instanceof ModelFundingError) {
    return publicError(
      "creating_account_unavailable",
      `The exact CloudConvert account binding is unavailable. A different key or payer cannot take over this job. Preserve ${row.recoveryHandle} and repair the original server credential configuration or account access.`,
      row,
      { retryable: true, uncertainEffect: true },
    );
  }
  const status = providerHttpStatus(error);
  if (status === 401 || status === 403) {
    return publicError(
      "creating_account_rejected",
      `CloudConvert rejected access from the exact creating credential. Preserve ${row.recoveryHandle}; replacing it does not transfer this job.`,
      row,
      { uncertainEffect: true },
    );
  }
  return publicError(
    "provider_temporarily_unavailable",
    `CloudConvert could not be reached for this existing job. Resume ${row.recoveryHandle}; the job will not be submitted again.`,
    row,
    { retryable: true, uncertainEffect: true },
  );
}

function rowResult(row: ConversionOperation): CloudConversionExecutionResult | null {
  if (row.status === "published") {
    return {
      status: "published",
      operationKey: row.operationKey,
      recoveryHandle: row.recoveryHandle,
      outputFormat: row.outputFormat,
      artifactId: row.publicationArtifactId!,
      revisionId: row.publicationRevisionId!,
    };
  }
  if (row.status === "publication_committing") {
    return {
      status: "recover_publication",
      operationKey: row.operationKey,
      recoveryHandle: row.recoveryHandle,
      outputFormat: row.outputFormat,
    };
  }
  if (row.status === "recovery_ambiguous") {
    return publicError(
      row.failureCode ?? "provider_submission_unresolved",
      "The original CloudConvert submission could not be identified safely. It was not submitted again. Use the recovery handle for support; starting another conversion may create another charge.",
      row,
      { uncertainEffect: true },
    );
  }
  if (row.status === "cancelled") {
    return publicError(
      "conversion_cancelled",
      "The CloudConvert job is cancelled. Cancellation does not prove that provider credits were refunded.",
      row,
    );
  }
  if (row.status === "failed") {
    return publicError(
      row.failureCode ?? "conversion_failed",
      "The CloudConvert job failed. Its cost evidence remains available in Costs.",
      row,
    );
  }
  if (row.status === "publication_failed") {
    return publicError(
      row.failureCode ?? "conversion_publication_failed",
      "The converted bytes could not be published to the original destination. The provider job was not submitted again.",
      row,
    );
  }
  if (row.status === "expired") {
    return publicError(
      "conversion_result_expired",
      "CloudConvert no longer has the converted bytes. The original job was not submitted again; start a new conversion only if another charge is acceptable.",
      row,
    );
  }
  return null;
}

function validateDigest(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value);
}

function destinationAuthorityMatches(row: ConversionOperation, request: CloudConversionRecoveryRequest): boolean {
  return row.causalHumanUserId === request.causalHumanUserId
    && row.destinationAuthorityDigest === request.destination.authorityDigest
    && row.destinationPathDigest === request.destination.pathDigest
    && row.destinationNamespaceId === request.destination.namespaceId;
}

function destinationMatches(row: ConversionOperation, request: CloudConversionRecoveryRequest): boolean {
  return destinationAuthorityMatches(row, request)
    && (row.destinationArtifactId ?? null) === (request.destination.artifactInternalId ?? null)
    && (row.destinationArtifactRevision ?? null) === (request.destination.revision ?? null);
}

function executionRequestMatches(row: ConversionOperation, request: CloudConversionExecutionRequest): boolean {
  return row.causalHumanUserId === request.execution.causalHumanUserId
    && row.roomId === request.execution.roomId
    && row.agentId === request.execution.agentId
    && row.taskId === (request.execution.taskId ?? null)
    && row.runId === (request.execution.runId ?? null)
    && row.sourceKind === request.source.kind
    && row.sourceArtifactId === (request.source.artifactInternalId ?? null)
    && row.sourceArtifactRevision === (request.source.revision ?? null)
    && row.sourceSha256 === request.source.sha256
    && row.sourceAuthorityDigest === request.source.authorityDigest
    && row.destinationNamespaceId === request.destination.namespaceId
    && row.destinationPathDigest === request.destination.pathDigest
    && row.destinationAuthorityDigest === request.destination.authorityDigest
    && row.inputFormat === request.inputFormat
    && row.outputFormat === request.outputFormat;
}

function executionConflict(row: ConversionOperation): CloudConversionExecutionResult {
  return publicError(
    "conversion_operation_conflict",
    "This trusted conversion invocation is already bound to different source bytes, source authority, destination, or formats. No new CloudConvert job was submitted.",
    row,
  );
}

export function createCloudConversionRuntime(
  dependencies: CloudConversionRuntimeDependencies = {},
): ProductionCloudConversionRuntime {
  const store = dependencies.store ?? DEFAULT_STORE;
  const admitFunding = dependencies.admitFunding ?? admitDurableServiceFunding;
  const runFunding = dependencies.runFunding ?? runWithDurableServiceFunding;
  const beginCost = dependencies.beginCost ?? beginServerProviderCostAttempt;
  const settleCost = dependencies.settleCost ?? settleServerProviderCostAttempt;
  const makeClient = dependencies.createClient ?? ((apiKey: string, endpoint: Readonly<{ sandbox: boolean; region: string | null }>) =>
    createCloudConvertClient(apiKey, endpoint.sandbox, endpoint.region ?? undefined));

  const withProvider = <T>(
    row: ConversionOperation,
    intent: "spend" | "recover",
    run: (client: CloudConvertClient) => Promise<T>,
  ): Promise<T> => runFunding(
    fundingFromRow(row),
    intent,
    ({ apiKey }) => run(makeClient(apiKey, {
      sandbox: row.providerSandbox,
      region: row.providerRegion,
    })),
  );

  const settle = async (
    row: ConversionOperation,
    job: CloudConvertJob,
    outcome: "succeeded" | "failed" | "cancelled" | "unknown",
    failureCode: string | null,
  ): Promise<void> => {
    const credits = creditsValue(job);
    await settleCost({
      ...costBase(row),
      receiptId: job.id,
      evidenceState: "unknown",
      attemptOutcome: outcome,
      failureCode,
      measuredUnits: credits.measured,
      unitType: credits.measured === null ? null : "cloudconvert_credit",
    });
  };

  const settleCancelledBeforeDispatch = (row: ConversionOperation): Promise<void> => settleCost({
    ...costBase(row),
    actualCostUsd: "0",
    evidenceState: "actual",
    attemptOutcome: "cancelled",
    failureCode: "cancelled_before_provider_dispatch",
    measuredUnits: 0,
    unitType: "cloudconvert_credit",
  });

  const cancelledBeforeDispatchResult = (row?: ConversionOperation): CloudConversionExecutionResult => publicError(
    "conversion_cancelled",
    "The conversion was cancelled before CloudConvert dispatch. No provider job was created and measured provider usage is zero.",
    row,
  );

  const cancellationPendingResult = (row: ConversionOperation): CloudConversionExecutionResult => publicError(
    "conversion_cancel_pending",
    `Cancellation is durably recorded for ${row.recoveryHandle} and will be reconciled with the exact creating account; no refund is assumed.`,
    row,
    { retryable: true, uncertainEffect: true },
  );

  const attachRecoveredSubmission = async (
    row: ConversionOperation,
    signal?: AbortSignal,
  ): Promise<ConversionOperation | CloudConversionExecutionResult> => {
    let matches: CloudConvertJob[];
    try {
      matches = await withProviderReadBound(
        withProvider(row, "recover", (client) => findConversionsByTag(client, row.providerTag)),
        signal,
      );
    } catch (error) {
      return creatingAccountError(row, error);
    }
    if (matches.length !== 1) {
      const failureCode = matches.length === 0 ? "provider_job_missing" : "provider_job_ambiguous";
      await store.recoveryAmbiguous(row.operationKey, failureCode);
      await settleCost({
        ...costBase(row),
        evidenceState: "unknown",
        attemptOutcome: "unknown",
        failureCode,
      });
      return publicError(
        failureCode,
        `The original CloudConvert submission has ${matches.length === 0 ? "no" : "multiple"} account matches. It was not submitted again. Recovery handle: ${row.recoveryHandle}.`,
        row,
        { uncertainEffect: true },
      );
    }
    const attached = await store.attachJob({ operationKey: row.operationKey, providerJobId: matches[0]!.id });
    return attached ?? (await store.getByKey(row.operationKey))!;
  };

  const resolveProviderJob = async (
    row: ConversionOperation,
    wait: boolean,
    signal?: AbortSignal,
  ): Promise<CloudConvertJob | CloudConversionExecutionResult> => {
    if (!row.providerJobId) {
      return publicError("provider_job_unavailable", "The CloudConvert job receipt is unavailable.", row, { uncertainEffect: true });
    }
    try {
      return await withProviderReadBound(withProvider(row, "recover", async (client) => {
        const current = await getConversionWithClient(client, row.providerJobId!, row.providerTag);
        if (!wait || current.status === "finished" || current.status === "error") return current;
        await store.processing(row.operationKey);
        return waitForConversionWithClient(client, row.providerJobId!, row.providerTag, signal);
      }), signal);
    } catch (error) {
      if (providerHttpStatus(error) === 404) {
        await settleCost({
          ...costBase(row),
          receiptId: row.providerJobId,
          evidenceState: "unknown",
          attemptOutcome: "unknown",
          failureCode: "provider_job_expired",
        });
        await store.terminal({
          operationKey: row.operationKey,
          status: "expired",
          failureCode: "provider_job_expired",
          providerCredits: row.providerCredits,
        });
        return publicError(
          "conversion_result_expired",
          "CloudConvert no longer retains this job or its result. It was not submitted again.",
          row,
        );
      }
      return creatingAccountError(row, error);
    }
  };

  const downloadAndClaim = async (
    row: ConversionOperation,
    maxOutputBytes: number,
    signal?: AbortSignal,
  ): Promise<CloudConversionExecutionResult> => {
    const publicationAlreadyClaimed = row.status === "publication_committing";
    const job = await resolveProviderJob(row, true, signal);
    if ("code" in job) return job;
    const providerJob = job as CloudConvertJob;
    if (providerJob.status === "error") {
      const cancelled = row.status === "cancel_requested";
      await settle(row, providerJob, cancelled ? "cancelled" : "failed", cancelled ? "provider_cancelled" : "provider_failed");
      const credits = creditsValue(providerJob);
      await store.terminal({
        operationKey: row.operationKey,
        status: cancelled ? "cancelled" : "failed",
        failureCode: cancelled ? "provider_cancelled" : "provider_failed",
        providerCredits: credits.db,
      });
      return publicError(
        cancelled ? "conversion_cancelled" : "conversion_failed",
        cancelled
          ? "The provider reports the conversion stopped. Cancellation does not prove a refund."
          : "CloudConvert reports that the conversion failed.",
        row,
      );
    }
    if (providerJob.status !== "finished") {
      return publicError("conversion_in_progress", `CloudConvert is still processing this job. Resume ${row.recoveryHandle}.`, row, { retryable: true });
    }
    const providerAlreadySettled = [
      "provider_finished",
      "ready_to_publish",
      "publication_committing",
      "published",
      "publication_failed",
    ].includes(row.status);
    if (!providerAlreadySettled) {
      await settle(row, providerJob, "succeeded", null);
      row = await store.providerFinished({
        operationKey: row.operationKey,
        providerCredits: creditsValue(providerJob).db,
      }) ?? row;
    }
    let result;
    try {
      result = await withProvider(row, "recover", (client) =>
        downloadConversionWithClient(client, providerJob, row.providerTag, maxOutputBytes, signal));
    } catch (error) {
      const expired = error instanceof Error && error.message === "No export URLs returned from conversion";
      if (expired) {
        if (!providerAlreadySettled) {
          await settle(row, providerJob, "succeeded", "result_expired");
        }
        await store.terminal({
          operationKey: row.operationKey,
          status: "expired",
          failureCode: "result_expired",
          providerCredits: creditsValue(providerJob).db,
        });
        return publicError(
          "conversion_result_expired",
          "CloudConvert no longer has the converted bytes. The job was not submitted again.",
          row,
        );
      }
      return publicError(
        "conversion_download_failed",
        `The existing CloudConvert result could not be downloaded safely. Resume ${row.recoveryHandle}; the conversion was not submitted again.`,
        row,
        { retryable: true },
      );
    }
    const outputSha256 = createHash("sha256").update(result.bytes).digest("hex");
    if (publicationAlreadyClaimed) {
      if (row.outputSha256 !== outputSha256 || row.outputBytes !== result.bytes.byteLength) {
        return publicError(
          "conversion_output_changed",
          "CloudConvert returned bytes that do not match the result already claimed for publication. The Artifact was not changed.",
          row,
          { uncertainEffect: true },
        );
      }
      return {
        status: "ready_to_publish",
        operationKey: row.operationKey,
        recoveryHandle: row.recoveryHandle,
        outputFormat: row.outputFormat,
        bytes: result.bytes,
        outputSha256,
      };
    }
    const ready = await store.ready({
      operationKey: row.operationKey,
      providerCredits: result.credits === null ? null : result.credits.toFixed(8),
      outputSha256,
      outputBytes: result.bytes.byteLength,
    }) ?? await store.getByKey(row.operationKey);
    if (!ready) throw new Error("Conversion operation disappeared before publication");
    const claimed = ready.status === "ready_to_publish"
      ? await store.claimPublication(row.operationKey)
      : ready;
    const current = claimed ?? await store.getByKey(row.operationKey);
    if (!current) throw new Error("Conversion publication claim disappeared");
    if (current.status === "publication_committing") {
      if (current.outputSha256 !== outputSha256 || current.outputBytes !== result.bytes.byteLength) {
        return publicError(
          "conversion_output_changed",
          "CloudConvert returned bytes that do not match the durable publication claim. The Artifact was not changed.",
          current,
          { uncertainEffect: true },
        );
      }
      return {
        status: "ready_to_publish",
        operationKey: current.operationKey,
        recoveryHandle: current.recoveryHandle,
        outputFormat: current.outputFormat,
        bytes: result.bytes,
        outputSha256,
      };
    }
    const projected = rowResult(current);
    if (projected) return projected;
    return publicError("conversion_publication_conflict", "The conversion result publication state changed. Resume with the recovery handle.", current, { retryable: true });
  };

  const resumeRow = async (
    row: ConversionOperation,
    request: CloudConversionRecoveryRequest,
    afterPublicationRecovery: boolean,
  ): Promise<CloudConversionExecutionResult> => {
    // The immutable source receipt binds the already-admitted provider result.
    // Recovery never re-reads or re-uploads source bytes. It still requires the
    // same Human, original Room-derived authority, and current destination;
    // canonical publication recovery is the only way to reuse a committed result.
    const terminal = rowResult(row);
    if (terminal?.status === "published" || terminal?.status === "recover_publication") {
      if (!destinationAuthorityMatches(row, request)) {
        return publicError(
          "conversion_destination_authority_changed",
          "The current Room or destination authority does not match this conversion receipt.",
          row,
        );
      }
    }
    if (terminal && !(afterPublicationRecovery && terminal.status === "recover_publication")) return terminal;
    if (!destinationMatches(row, request)) {
      return publicError(
        "conversion_destination_changed",
        "The current destination authority or revision does not match this conversion. Re-open the original Room and destination, then resume it.",
        row,
      );
    }
    if (row.status === "submitting") {
      const expired = await store.expireSubmissionLease({ operationKey: row.operationKey, now: new Date() });
      if (!expired) {
        return publicError(
          "conversion_submission_in_progress",
          `The original CloudConvert submission is still within its transport lease. Resume ${row.recoveryHandle} after the current attempt finishes; it will not be submitted again.`,
          row,
          { retryable: true, uncertainEffect: true },
        );
      }
      row = expired;
    }
    if (row.status === "submission_unknown") {
      const recovered = await attachRecoveredSubmission(row, request.signal);
      if ("status" in recovered && recovered.status === "error") return recovered;
      row = recovered as ConversionOperation;
    }
    if (row.status === "prepared") {
      return publicError(
        "conversion_not_submitted",
        "This conversion was recorded before provider dispatch and has no paid job to recover. Start a fresh conversion from the original source.",
        row,
      );
    }
    if (row.status === "publication_committing" && !afterPublicationRecovery) {
      return rowResult(row)!;
    }
    return downloadAndClaim(row, request.maxOutputBytes, request.signal);
  };

  const execute = async (request: CloudConversionExecutionRequest): Promise<CloudConversionExecutionResult> => {
    if (request.signal?.aborted) return cancelledBeforeDispatchResult();
    if (
      !request.execution.causalHumanUserId || !request.execution.roomId ||
      !request.execution.agentId || !request.execution.toolCallId ||
      !validateDigest(request.source.sha256) ||
      !validateDigest(request.source.authorityDigest) ||
      !validateDigest(request.destination.pathDigest) ||
      !validateDigest(request.destination.authorityDigest) ||
      !Number.isSafeInteger(request.maxOutputBytes) || request.maxOutputBytes <= 0 ||
      createHash("sha256").update(request.bytes).digest("hex") !== request.source.sha256
    ) {
      return publicError("conversion_invalid_request", "Cloud conversion could not establish a trusted source and destination.");
    }
    const key = operationKey(request);
    let row = await store.getByKey(key);
    if (!row) {
      if (request.signal?.aborted) return cancelledBeforeDispatchResult();
      const funding = await admitFunding(request.execution.causalHumanUserId, "cloudconvert");
      if (request.signal?.aborted) return cancelledBeforeDispatchResult();
      const endpoint = getCloudConvertConfig();
      try {
        row = await store.create({
          operationKey: key,
          recoveryHandle: recoveryHandle(key),
          causalHumanUserId: request.execution.causalHumanUserId,
          roomId: request.execution.roomId,
          agentId: request.execution.agentId,
          taskId: request.execution.taskId ?? null,
          runId: request.execution.runId ?? null,
          jobId: request.execution.jobId ?? null,
          fundingKind: funding.binding.kind,
          providerRoute: "cloudconvert",
          providerSandbox: endpoint.sandbox,
          providerRegion: endpoint.region,
          credentialId: funding.binding.kind === "personal" ? funding.binding.credentialId : null,
          credentialRevision: funding.binding.kind === "personal" ? funding.binding.credentialRevision : null,
          credentialFingerprint: funding.credentialFingerprint,
          sourceKind: request.source.kind,
          sourceArtifactId: request.source.artifactInternalId ?? null,
          sourceArtifactRevision: request.source.revision ?? null,
          sourceSha256: request.source.sha256,
          sourceAuthorityDigest: request.source.authorityDigest,
          destinationArtifactId: request.destination.artifactInternalId ?? null,
          destinationArtifactRevision: request.destination.revision ?? null,
          destinationNamespaceId: request.destination.namespaceId,
          destinationPathDigest: request.destination.pathDigest,
          destinationAuthorityDigest: request.destination.authorityDigest,
          inputFormat: request.inputFormat,
          outputFormat: request.outputFormat,
          maxOutputBytes: request.maxOutputBytes,
          providerTag: providerTag(key),
        });
      } catch (error) {
        const concurrent = await store.getByKey(key);
        if (!concurrent) throw error;
        row = concurrent;
      }
    }
    if (!executionRequestMatches(row, request)) return executionConflict(row);
    if (request.signal?.aborted) {
      if (row.status === "prepared") {
        const cancelled = await store.cancelBeforeDispatch({
          operationKey: row.operationKey,
          phase: "prepared",
        });
        return cancelledBeforeDispatchResult(cancelled ?? row);
      }
      const requested = await store.requestCancel(row.operationKey);
      if (requested) return cancellationPendingResult(requested);
      const current = await store.getByKey(row.operationKey) ?? row;
      if (["provider_finished", "ready_to_publish", "publication_committing", "published", "publication_failed"].includes(current.status)) {
        return publicError(
          "conversion_already_completed",
          `The provider conversion completed before cancellation took effect. Resume ${current.recoveryHandle} from the original Room to recover its publication; no output was returned after cancellation.`,
          current,
        );
      }
      const projected = rowResult(current);
      if (projected) return projected;
      return publicError(
        "conversion_cancel_unknown",
        `Cancellation could not be durably attached to ${current.recoveryHandle}. No new provider request was sent.`,
        current,
        { retryable: true, uncertainEffect: true },
      );
    }
    const terminal = rowResult(row);
    if (terminal) return terminal;
    if (row.status !== "prepared") {
      return resumeRow(row, {
        recoveryHandle: row.recoveryHandle,
        causalHumanUserId: request.execution.causalHumanUserId,
        destination: request.destination,
        maxOutputBytes: request.maxOutputBytes,
        ...(request.signal ? { signal: request.signal } : {}),
      }, false);
    }
    try {
      await admitFunding(row.causalHumanUserId, "cloudconvert", fundingFromRow(row));
      if (request.signal?.aborted) {
        const cancelled = await store.cancelBeforeDispatch({
          operationKey: row.operationKey,
          phase: "prepared",
        });
        return cancelledBeforeDispatchResult(cancelled ?? row);
      }
    } catch (error) {
      if (error instanceof ModelFundingError && error.code === "personal_credential_stale") {
        return publicError(
          "conversion_funding_changed_before_submission",
          "The admitted personal CloudConvert key changed before provider dispatch. This receipt cannot rebind to a new key, but no provider job was submitted; start a fresh conversion after reconnecting.",
          row,
        );
      }
      if (error instanceof ModelFundingError && error.code === "personal_credential_unavailable") {
        return publicError(
          "conversion_funding_custody_unavailable",
          "The admitted personal CloudConvert key could not be decrypted before provider dispatch. Repair instance custody, then retry this receipt; no provider job was submitted.",
          row,
          { retryable: true },
        );
      }
      return publicError(
        "conversion_funding_unavailable",
        "CloudConvert funding is no longer admitted. Repair the creating account before starting this conversion.",
        row,
        { retryable: true },
      );
    }
    const preparedRow = row;
    const submissionLeaseId = randomBytes(32).toString("hex");
    try {
      return await runFunding(fundingFromRow(preparedRow), "spend", async ({ apiKey }) => {
        if (request.signal?.aborted) {
          const cancelled = await store.cancelBeforeDispatch({
            operationKey: preparedRow.operationKey,
            phase: "prepared",
          });
          return cancelledBeforeDispatchResult(cancelled ?? preparedRow);
        }
        try {
          await beginCost(costBase(preparedRow));
        } catch {
          return publicError(
            "conversion_cost_admission_failed",
            "CloudConvert could not start because its durable cost receipt was unavailable.",
            preparedRow,
            { retryable: true },
          );
        }
        if (request.signal?.aborted) {
          const cancelled = await store.cancelBeforeDispatch({
            operationKey: preparedRow.operationKey,
            phase: "prepared",
          });
          if (cancelled) await settleCancelledBeforeDispatch(cancelled);
          return cancelledBeforeDispatchResult(cancelled ?? preparedRow);
        }
        const claimed = await store.claimSubmission({
          operationKey: preparedRow.operationKey,
          leaseId: submissionLeaseId,
          leaseExpiresAt: new Date(Date.now() + SUBMISSION_LEASE_MS),
        });
        if (!claimed) {
          const current = await store.getByKey(preparedRow.operationKey);
          if (!current) throw new Error("Conversion operation disappeared before submission");
          return resumeRow(current, {
            recoveryHandle: current.recoveryHandle,
            causalHumanUserId: request.execution.causalHumanUserId,
            destination: request.destination,
            maxOutputBytes: request.maxOutputBytes,
          }, false);
        }
        const submittingRow = claimed;
        let abortPersistence: Promise<ConversionOperation | null> | undefined;
        const persistAbort = () => {
          abortPersistence ??= store.requestCancel(submittingRow.operationKey);
          return abortPersistence;
        };
        const onAbort = () => { void persistAbort().catch(() => undefined); };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        try {
          if (request.signal?.aborted) {
            const cancelled = await store.cancelBeforeDispatch({
              operationKey: submittingRow.operationKey,
              phase: "submitting",
              submissionLeaseId,
            });
            if (cancelled) {
              await settleCancelledBeforeDispatch(cancelled);
              return cancelledBeforeDispatchResult(cancelled);
            }
            const current = await store.getByKey(submittingRow.operationKey) ?? submittingRow;
            return cancellationPendingResult(current);
          }
          const timeoutSignal = AbortSignal.timeout(SUBMISSION_TRANSPORT_TIMEOUT_MS);
          const submissionSignal = request.signal
            ? AbortSignal.any([request.signal, timeoutSignal])
            : timeoutSignal;
          const submission = submitConversionWithClient(
            makeClient(apiKey, {
              sandbox: submittingRow.providerSandbox,
              region: submittingRow.providerRegion,
            }),
            Buffer.from(request.bytes),
            submittingRow.inputFormat,
            submittingRow.outputFormat,
            submittingRow.providerTag,
            submissionSignal,
          );
          const durableSubmission = submission.then(async (submitted) => {
            const attached = await store.attachJob({
              operationKey: submittingRow.operationKey,
              providerJobId: submitted.job.id,
              submissionLeaseId,
            });
            if (!attached) throw new Error("CloudConvert job receipt could not be attached");
            return { ok: true as const, row: attached };
          }).catch((error: unknown) => ({ ok: false as const, error }));
          let outcome: Awaited<typeof durableSubmission>;
          try {
            outcome = await withSubmissionTimeout(durableSubmission);
          } catch (error) {
            if (error instanceof SubmissionTransportTimeoutError) {
              return publicError(
                "provider_submit_transport_timeout",
                `The CloudConvert submission transport timed out while its durable lease remains active. It was not submitted again. Resume ${submittingRow.recoveryHandle} after the current attempt is reconciled.`,
                submittingRow,
                { retryable: true, uncertainEffect: true },
              );
            }
            throw error;
          }
          if (!outcome.ok) {
            if (request.signal?.aborted) {
              await persistAbort();
              const current = await store.getByKey(submittingRow.operationKey) ?? submittingRow;
              return cancellationPendingResult(current);
            }
            return publicError(
              "provider_submit_response_unknown",
              `CloudConvert may have accepted the job, but its response was lost. It was not submitted again. Resume ${submittingRow.recoveryHandle} after the submission lease expires to reconcile the creating account.`,
              submittingRow,
              { retryable: true, uncertainEffect: true },
            );
          }
          if (outcome.row.status === "cancel_requested" || request.signal?.aborted) {
            if (request.signal?.aborted) await persistAbort();
            const current = await store.getByKey(submittingRow.operationKey) ?? outcome.row;
            return cancellationPendingResult(current);
          }
          const result = await downloadAndClaim(outcome.row, request.maxOutputBytes, request.signal);
          if (request.signal?.aborted) {
            await persistAbort();
            const current = await store.getByKey(submittingRow.operationKey) ?? outcome.row;
            if (["provider_finished", "ready_to_publish", "publication_committing", "published"].includes(current.status)) {
              return publicError(
                "conversion_already_completed",
                `The provider conversion finished before cancellation took effect. Resume ${current.recoveryHandle} from the original Room to recover its publication; no output was returned after cancellation.`,
                current,
              );
            }
            return cancellationPendingResult(current);
          }
          return result;
        } finally {
          request.signal?.removeEventListener("abort", onAbort);
          if (abortPersistence) await abortPersistence;
        }
      });
    } catch (error) {
      const current = await store.getByKey(preparedRow.operationKey) ?? preparedRow;
      if (error instanceof ModelFundingError) return creatingAccountError(current, error);
      return publicError(
        "conversion_dispatch_failed",
        `CloudConvert dispatch could not be completed. Resume ${current.recoveryHandle}; do not start another conversion while this receipt is unresolved.`,
        current,
        { retryable: true, uncertainEffect: current.status === "submitting" },
      );
    }
  };

  let reconciliationTimer: ReturnType<typeof setInterval> | null = null;
  let reconciliationRun: Promise<unknown> | null = null;
  let reconciliationAbort: AbortController | null = null;
  const reconcile = async (
    limit: number,
    signal?: AbortSignal,
  ): Promise<Readonly<{ inspected: number; changed: number }>> => {
    const rows = await store.listRecoverable(limit);
    let changed = 0;
    for (let row of rows) {
      signal?.throwIfAborted();
      const touched = await store.touchRecovery({
        operationKey: row.operationKey,
        status: row.status,
        version: row.version,
      });
      if (!touched) continue;
      row = touched;
      if (row.status === "submitting") {
        const expired = await store.expireSubmissionLease({ operationKey: row.operationKey, now: new Date() });
        if (!expired) continue;
        row = expired;
      }
      if (row.status === "submission_unknown") {
        const recovered = await attachRecoveredSubmission(row, signal);
        if (!("status" in recovered && recovered.status === "error")) {
          row = recovered as ConversionOperation;
          changed += 1;
        }
      }
      if (!row.providerJobId || !["submitted", "processing", "cancel_requested"].includes(row.status)) continue;
      let observed: CloudConvertJob | CloudConversionExecutionResult;
      if (row.status === "cancel_requested") {
        try {
          observed = await withProviderReadBound(withProvider(row, "recover", async (client) => {
            const current = await getConversionWithClient(client, row.providerJobId!, row.providerTag);
            return cancelConversionWithClient(client, current, row.providerTag);
          }), signal);
        } catch (error) {
          observed = creatingAccountError(row, error);
        }
      } else {
        observed = await resolveProviderJob(row, false, signal);
      }
      if ("code" in observed) continue;
      const job = observed as CloudConvertJob;
      if (job.status === "error") {
        const cancelled = row.status === "cancel_requested";
        await settle(row, job, cancelled ? "cancelled" : "failed", cancelled ? "provider_cancelled" : "provider_failed");
        await store.terminal({
          operationKey: row.operationKey,
          status: cancelled ? "cancelled" : "failed",
          failureCode: cancelled ? "provider_cancelled" : "provider_failed",
          providerCredits: creditsValue(job).db,
        });
        changed += 1;
      } else if (job.status === "finished") {
        await settle(row, job, "succeeded", null);
        await store.providerFinished({
          operationKey: row.operationKey,
          providerCredits: creditsValue(job).db,
        });
        // Publication requires current content authority. Leave the existing
        // provider receipt resumable; do not auto-download or auto-publish.
        changed += 1;
      }
    }
    return { inspected: rows.length, changed };
  };
  const runtime: ProductionCloudConversionRuntime = {
    execute,
    async resume(request) {
      const row = await store.getByHandle(request.recoveryHandle);
      if (!row || row.causalHumanUserId !== request.causalHumanUserId) {
        return publicError("conversion_not_found", "No conversion owned by this Human matches that recovery handle.");
      }
      return resumeRow(row, request, false);
    },
    async resumePublication(request) {
      const row = await store.getByHandle(request.recoveryHandle);
      if (!row || row.causalHumanUserId !== request.causalHumanUserId) {
        return publicError("conversion_not_found", "No conversion owned by this Human matches that recovery handle.");
      }
      if (row.status !== "publication_committing") {
        return resumeRow(row, request, false);
      }
      return resumeRow(row, request, true);
    },
    async confirmPublication(input) {
      const published = await store.published({
        operationKey: input.operationKey,
        publicationArtifactId: input.artifactId,
        publicationRevisionId: input.revisionId,
      });
      if (!published) {
        const current = await store.getByKey(input.operationKey);
        if (!current || current.status !== "published"
          || current.publicationArtifactId !== input.artifactId
          || current.publicationRevisionId !== input.revisionId) {
          throw new Error("Conversion publication receipt conflicts with durable state");
        }
      }
    },
    async failPublication(input) {
      await store.failPublication(input);
    },
    async cancel(input) {
      input.signal?.throwIfAborted();
      let row = await store.getByHandle(input.operationKey) ?? await store.getByKey(input.operationKey);
      if (!row || row.causalHumanUserId !== input.causalHumanUserId) {
        return publicError("conversion_not_found", "No conversion owned by this Human matches that recovery handle.");
      }
      if ([
        "provider_finished",
        "ready_to_publish",
        "publication_committing",
        "published",
        "publication_failed",
      ].includes(row.status)) {
        return publicError(
          "conversion_already_completed",
          `The provider conversion has already completed and cannot be cancelled. Resume ${row.recoveryHandle} from the original Room to recover its publication.`,
          row,
        );
      }
      const terminal = rowResult(row);
      if (terminal) return terminal;
      row = await store.requestCancel(row.operationKey) ?? row;
      if (row.status === "submitting") {
        const expired = await store.expireSubmissionLease({ operationKey: row.operationKey, now: new Date() });
        if (!expired) {
          return publicError(
            "conversion_cancel_waiting_for_submission",
            `Cancellation is durably recorded, but the original provider submission is still within its transport lease. It will be sent once the provider job is attached; no refund is assumed.`,
            row,
            { retryable: true, uncertainEffect: true },
          );
        }
        row = expired;
      }
      if (row.status === "submission_unknown") {
        const recovered = await attachRecoveredSubmission(row, input.signal);
        if ("status" in recovered && recovered.status === "error") return recovered;
        row = recovered as ConversionOperation;
      }
      if (!row.providerJobId) {
        return publicError("conversion_not_submitted", "This conversion has no provider job to cancel.", row);
      }
      let observed: CloudConvertJob;
      try {
        observed = await withProviderReadBound(withProvider(row, "recover", async (client) => {
          input.signal?.throwIfAborted();
          const current = await getConversionWithClient(client, row.providerJobId!, row.providerTag);
          input.signal?.throwIfAborted();
          return cancelConversionWithClient(client, current, row.providerTag);
        }), input.signal);
      } catch (error) {
        if (error instanceof ModelFundingError
          || providerHttpStatus(error) === 401
          || providerHttpStatus(error) === 403) {
          return creatingAccountError(row, error);
        }
        return publicError(
          "conversion_cancel_unknown",
          `The cancellation result is unknown. Resume or cancel ${row.recoveryHandle} again with the creating account; no refund is assumed.`,
          row,
          { retryable: true, uncertainEffect: true },
        );
      }
      if (observed.status === "error") {
        await settle(row, observed, "cancelled", "provider_cancelled");
        await store.terminal({
          operationKey: row.operationKey,
          status: "cancelled",
          failureCode: "provider_cancelled",
          providerCredits: creditsValue(observed).db,
        });
        return publicError(
          "conversion_cancelled",
          "CloudConvert reports that the job stopped. Cancellation does not prove a refund.",
          row,
        );
      }
      if (observed.status === "finished") {
        await settle(row, observed, "succeeded", null);
        await store.providerFinished({
          operationKey: row.operationKey,
          providerCredits: creditsValue(observed).db,
        });
        return publicError(
          "conversion_already_completed",
          `The provider conversion finished before cancellation took effect. Resume ${row.recoveryHandle} from the original Room to recover its publication; no output was returned by cancellation.`,
          row,
        );
      }
      return publicError(
        "conversion_cancel_pending",
        `CloudConvert has not reported a terminal result. Resume ${row.recoveryHandle}; no refund is assumed.`,
        row,
        { retryable: true, uncertainEffect: true },
      );
    },
    reconcilePending: (limit) => reconcile(limit),
    start(policy) {
      if (reconciliationTimer !== null) return;
      if (!Number.isSafeInteger(policy.intervalMs) || policy.intervalMs <= 0
        || !Number.isSafeInteger(policy.batchSize) || policy.batchSize <= 0) {
        throw new TypeError("Invalid CloudConvert reconciliation policy");
      }
      const wake = () => {
        if (reconciliationRun !== null) return;
        reconciliationAbort = new AbortController();
        reconciliationRun = reconcile(policy.batchSize, reconciliationAbort.signal)
          .catch(() => undefined)
          .finally(() => {
            reconciliationRun = null;
            reconciliationAbort = null;
          });
      };
      wake();
      reconciliationTimer = setInterval(wake, policy.intervalMs);
      reconciliationTimer.unref?.();
    },
    async stop() {
      if (reconciliationTimer !== null) clearInterval(reconciliationTimer);
      reconciliationTimer = null;
      reconciliationAbort?.abort(new Error("CloudConvert reconciliation stopped"));
      await reconciliationRun;
    },
  };
  return runtime;
}
