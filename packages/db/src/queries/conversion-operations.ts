import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { getSharedDirectDb } from "../config/direct-database";
import {
  conversionOperations,
  type ConversionOperation,
  type NewConversionOperation,
} from "../schema/conversion-operations";

export type ConversionOperationStatus = ConversionOperation["status"];

export type CreateConversionOperationInput = Omit<
  NewConversionOperation,
  | "id"
  | "status"
  | "providerJobId"
  | "submissionLeaseId"
  | "submissionLeaseExpiresAt"
  | "cancellationRequestedAt"
  | "providerCredits"
  | "outputSha256"
  | "outputBytes"
  | "publicationRevisionId"
  | "publicationArtifactId"
  | "failureCode"
  | "version"
  | "createdAt"
  | "updatedAt"
  | "submittedAt"
  | "terminalAt"
  | "publishedAt"
>;

type ConversionDb = Pick<DirectDatabase, "insert" | "select" | "update">;

function assertDigest(value: string, label: string): void {
  if (!/^[0-9a-f]{64}$/.test(value)) throw new TypeError(`Invalid ${label}`);
}

function assertCreateInput(input: CreateConversionOperationInput): void {
  for (const [value, label] of [
    [input.operationKey, "conversion operation key"],
    [input.credentialFingerprint, "conversion credential fingerprint"],
    [input.sourceSha256, "conversion source digest"],
    [input.sourceAuthorityDigest, "conversion source authority digest"],
    [input.destinationPathDigest, "conversion destination path digest"],
    [input.destinationAuthorityDigest, "conversion destination authority digest"],
  ] as const) assertDigest(value, label);
  if (!/^ntlo_cv_[0-9a-f]{32}$/.test(input.providerTag)) {
    throw new TypeError("Invalid CloudConvert recovery tag");
  }
}

export async function createConversionOperationWith(
  db: ConversionDb,
  input: CreateConversionOperationInput,
): Promise<ConversionOperation> {
  assertCreateInput(input);
  const rows = await db.insert(conversionOperations).values({
    ...input,
    status: "prepared",
  }).onConflictDoNothing({ target: conversionOperations.operationKey }).returning();
  const created = rows[0];
  if (created) return created;
  const existing = await getConversionOperationByKeyWith(db, input.operationKey);
  if (!existing) throw new Error("Conversion operation could not be created or recovered");
  const stable = [
    "causalHumanUserId", "roomId", "agentId", "taskId", "runId",
    "fundingKind", "providerRoute", "providerSandbox", "providerRegion", "credentialId", "credentialRevision",
    "credentialFingerprint", "sourceKind", "sourceArtifactId",
    "sourceArtifactRevision", "sourceSha256", "sourceAuthorityDigest",
    "destinationArtifactId", "destinationArtifactRevision",
    "destinationNamespaceId", "destinationPathDigest",
    "destinationAuthorityDigest", "inputFormat", "outputFormat", "maxOutputBytes", "providerTag",
    "recoveryHandle",
  ] as const;
  if (stable.some((key) => (existing[key] ?? null) !== (input[key] ?? null))) {
    throw new Error("Conversion operation identity conflicts with durable state");
  }
  return existing;
}

export async function createConversionOperation(input: CreateConversionOperationInput): Promise<ConversionOperation> {
  return createConversionOperationWith(getSharedDirectDb(), input);
}

export async function getConversionOperationByKeyWith(
  db: Pick<DirectDatabase, "select">,
  operationKey: string,
): Promise<ConversionOperation | null> {
  assertDigest(operationKey, "conversion operation key");
  const rows = await db.select().from(conversionOperations)
    .where(eq(conversionOperations.operationKey, operationKey)).limit(1);
  return rows[0] ?? null;
}

export async function getConversionOperationByKey(operationKey: string): Promise<ConversionOperation | null> {
  return getConversionOperationByKeyWith(getSharedDirectDb(), operationKey);
}

export async function getConversionOperationByRecoveryHandleWith(
  db: Pick<DirectDatabase, "select">,
  recoveryHandle: string,
): Promise<ConversionOperation | null> {
  if (!/^cvr_[0-9a-f]{32}$/.test(recoveryHandle)) return null;
  const rows = await db.select().from(conversionOperations)
    .where(eq(conversionOperations.recoveryHandle, recoveryHandle)).limit(1);
  return rows[0] ?? null;
}

export async function getConversionOperationByRecoveryHandle(recoveryHandle: string): Promise<ConversionOperation | null> {
  return getConversionOperationByRecoveryHandleWith(getSharedDirectDb(), recoveryHandle);
}

export async function listRecoverableConversionOperationsWith(
  db: Pick<DirectDatabase, "select">,
  limit: number,
): Promise<ConversionOperation[]> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new TypeError("Recovery limit must be positive");
  return db.select().from(conversionOperations).where(inArray(conversionOperations.status, [
    "submitting",
    "submission_unknown",
    "submitted",
    "processing",
    "cancel_requested",
  ])).orderBy(asc(conversionOperations.updatedAt), asc(conversionOperations.id)).limit(limit);
}

export async function listRecoverableConversionOperations(limit: number): Promise<ConversionOperation[]> {
  return listRecoverableConversionOperationsWith(getSharedDirectDb(), limit);
}

export async function touchConversionRecoveryAttemptWith(
  db: Pick<DirectDatabase, "update">,
  input: Pick<ConversionOperation, "operationKey" | "status" | "version">,
): Promise<ConversionOperation | null> {
  const rows = await db.update(conversionOperations).set({
    updatedAt: new Date(),
  }).where(and(
    eq(conversionOperations.operationKey, input.operationKey),
    eq(conversionOperations.status, input.status),
    eq(conversionOperations.version, input.version),
  )).returning();
  return rows[0] ?? null;
}

export async function touchConversionRecoveryAttempt(
  input: Parameters<typeof touchConversionRecoveryAttemptWith>[1],
): Promise<ConversionOperation | null> {
  return touchConversionRecoveryAttemptWith(getSharedDirectDb(), input);
}

async function transitionWith(
  db: Pick<DirectDatabase, "update">,
  input: {
    operationKey: string;
    from: readonly ConversionOperationStatus[];
    to: ConversionOperationStatus;
    values?: Partial<NewConversionOperation>;
  },
): Promise<ConversionOperation | null> {
  const rows = await db.update(conversionOperations).set({
    ...input.values,
    status: input.to,
    version: sql`${conversionOperations.version} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(conversionOperations.operationKey, input.operationKey),
    inArray(conversionOperations.status, [...input.from]),
  )).returning();
  return rows[0] ?? null;
}

export async function claimConversionSubmissionWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; leaseId: string; leaseExpiresAt: Date },
): Promise<ConversionOperation | null> {
  assertDigest(input.leaseId, "conversion submission lease");
  if (input.leaseExpiresAt.getTime() <= Date.now()) throw new TypeError("Conversion submission lease must expire in the future");
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: ["prepared"],
    to: "submitting",
    values: { submissionLeaseId: input.leaseId, submissionLeaseExpiresAt: input.leaseExpiresAt },
  });
}

export async function claimConversionSubmission(
  input: Parameters<typeof claimConversionSubmissionWith>[1],
): Promise<ConversionOperation | null> {
  return claimConversionSubmissionWith(getSharedDirectDb(), input);
}

export async function expireConversionSubmissionLeaseWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; now: Date },
): Promise<ConversionOperation | null> {
  const rows = await db.update(conversionOperations).set({
    status: "submission_unknown",
    submissionLeaseId: null,
    submissionLeaseExpiresAt: null,
    failureCode: "provider_submit_lease_expired",
    version: sql`${conversionOperations.version} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(conversionOperations.operationKey, input.operationKey),
    eq(conversionOperations.status, "submitting"),
    lte(conversionOperations.submissionLeaseExpiresAt, input.now),
  )).returning();
  return rows[0] ?? null;
}

export async function expireConversionSubmissionLease(
  input: Parameters<typeof expireConversionSubmissionLeaseWith>[1],
): Promise<ConversionOperation | null> {
  return expireConversionSubmissionLeaseWith(getSharedDirectDb(), input);
}

export async function markConversionSubmissionUnknown(
  operationKey: string,
  failureCode: string,
): Promise<ConversionOperation | null> {
  return markConversionSubmissionUnknownWith(getSharedDirectDb(), operationKey, failureCode);
}

export async function markConversionSubmissionUnknownWith(
  db: Pick<DirectDatabase, "update">,
  operationKey: string,
  failureCode: string,
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey,
    from: ["submitting"],
    to: "submission_unknown",
    values: { failureCode, submissionLeaseId: null, submissionLeaseExpiresAt: null },
  });
}

export async function attachConversionProviderJobWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; providerJobId: string; submissionLeaseId?: string },
): Promise<ConversionOperation | null> {
  if (!input.providerJobId.trim()) throw new TypeError("Provider job id is required");
  if (input.submissionLeaseId !== undefined) {
    assertDigest(input.submissionLeaseId, "conversion submission lease");
    const rows = await db.update(conversionOperations).set({
      status: sql`CASE WHEN ${conversionOperations.cancellationRequestedAt} IS NULL THEN 'submitted' ELSE 'cancel_requested' END`,
      providerJobId: input.providerJobId,
      submittedAt: new Date(),
      failureCode: null,
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
      version: sql`${conversionOperations.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(conversionOperations.operationKey, input.operationKey),
      eq(conversionOperations.status, "submitting"),
      eq(conversionOperations.submissionLeaseId, input.submissionLeaseId),
    )).returning();
    return rows[0] ?? null;
  }
  const rows = await db.update(conversionOperations).set({
    status: sql`CASE WHEN ${conversionOperations.cancellationRequestedAt} IS NULL THEN 'submitted' ELSE 'cancel_requested' END`,
      providerJobId: input.providerJobId,
      submittedAt: new Date(),
      failureCode: null,
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
      version: sql`${conversionOperations.version} + 1`,
      updatedAt: new Date(),
    }).where(and(
      eq(conversionOperations.operationKey, input.operationKey),
      eq(conversionOperations.status, "submission_unknown"),
    )).returning();
  return rows[0] ?? null;
}

export async function attachConversionProviderJob(
  input: Parameters<typeof attachConversionProviderJobWith>[1],
): Promise<ConversionOperation | null> {
  return attachConversionProviderJobWith(getSharedDirectDb(), input);
}

export async function markConversionRecoveryAmbiguousWith(
  db: Pick<DirectDatabase, "update">,
  operationKey: string,
  failureCode: "provider_job_missing" | "provider_job_ambiguous",
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey,
    from: ["submission_unknown"],
    to: "recovery_ambiguous",
    values: {
      failureCode,
      terminalAt: new Date(),
      submissionLeaseId: null,
      submissionLeaseExpiresAt: null,
    },
  });
}

export async function markConversionRecoveryAmbiguous(
  operationKey: string,
  failureCode: "provider_job_missing" | "provider_job_ambiguous",
): Promise<ConversionOperation | null> {
  return markConversionRecoveryAmbiguousWith(getSharedDirectDb(), operationKey, failureCode);
}

export async function markConversionProcessingWith(
  db: Pick<DirectDatabase, "update">,
  operationKey: string,
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey,
    from: ["submitted", "processing"],
    to: "processing",
  });
}

export async function markConversionProcessing(operationKey: string): Promise<ConversionOperation | null> {
  return markConversionProcessingWith(getSharedDirectDb(), operationKey);
}

export async function markConversionReadyToPublishWith(
  db: Pick<DirectDatabase, "update">,
  input: {
    operationKey: string;
    providerCredits: string | null;
    outputSha256: string;
    outputBytes: number;
  },
): Promise<ConversionOperation | null> {
  assertDigest(input.outputSha256, "conversion output digest");
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: ["provider_finished"],
    to: "ready_to_publish",
    values: {
      providerCredits: input.providerCredits,
      outputSha256: input.outputSha256,
      outputBytes: input.outputBytes,
      terminalAt: new Date(),
      failureCode: null,
    },
  });
}

export async function markConversionProviderFinishedWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; providerCredits: string | null },
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: ["submitted", "processing", "cancel_requested"],
    to: "provider_finished",
    values: { providerCredits: input.providerCredits, terminalAt: new Date(), failureCode: null },
  });
}

export async function markConversionProviderFinished(
  input: Parameters<typeof markConversionProviderFinishedWith>[1],
): Promise<ConversionOperation | null> {
  return markConversionProviderFinishedWith(getSharedDirectDb(), input);
}

export async function markConversionReadyToPublish(
  input: Parameters<typeof markConversionReadyToPublishWith>[1],
): Promise<ConversionOperation | null> {
  return markConversionReadyToPublishWith(getSharedDirectDb(), input);
}

export async function claimConversionPublicationWith(
  db: Pick<DirectDatabase, "update">,
  operationKey: string,
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey,
    from: ["ready_to_publish"],
    to: "publication_committing",
  });
}

export async function claimConversionPublication(operationKey: string): Promise<ConversionOperation | null> {
  return claimConversionPublicationWith(getSharedDirectDb(), operationKey);
}

export async function confirmConversionPublishedWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; publicationRevisionId: string; publicationArtifactId: string },
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: ["publication_committing"],
    to: "published",
    values: {
      publicationRevisionId: input.publicationRevisionId,
      publicationArtifactId: input.publicationArtifactId,
      publishedAt: new Date(),
    },
  });
}

export async function confirmConversionPublished(
  input: Parameters<typeof confirmConversionPublishedWith>[1],
): Promise<ConversionOperation | null> {
  return confirmConversionPublishedWith(getSharedDirectDb(), input);
}

export async function requestConversionCancellationWith(
  db: Pick<DirectDatabase, "update">,
  operationKey: string,
): Promise<ConversionOperation | null> {
  const rows = await db.update(conversionOperations).set({
    status: sql`CASE
      WHEN ${conversionOperations.status} IN ('submitted', 'processing') THEN 'cancel_requested'
      ELSE ${conversionOperations.status}
    END`,
    cancellationRequestedAt: sql`COALESCE(${conversionOperations.cancellationRequestedAt}, NOW())`,
    version: sql`${conversionOperations.version} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(conversionOperations.operationKey, operationKey),
    inArray(conversionOperations.status, ["submitting", "submission_unknown", "submitted", "processing", "cancel_requested"]),
  )).returning();
  return rows[0] ?? null;
}

export async function requestConversionCancellation(operationKey: string): Promise<ConversionOperation | null> {
  return requestConversionCancellationWith(getSharedDirectDb(), operationKey);
}

export async function cancelConversionBeforeProviderDispatchWith(
  db: Pick<DirectDatabase, "update">,
  input:
    | { operationKey: string; phase: "prepared" }
    | { operationKey: string; phase: "submitting"; submissionLeaseId: string },
): Promise<ConversionOperation | null> {
  if (input.phase === "submitting") {
    assertDigest(input.submissionLeaseId, "conversion submission lease");
  }
  const phaseCondition = input.phase === "prepared"
    ? eq(conversionOperations.status, "prepared")
    : and(
        eq(conversionOperations.status, "submitting"),
        eq(conversionOperations.submissionLeaseId, input.submissionLeaseId),
      );
  const rows = await db.update(conversionOperations).set({
    status: "cancelled",
    providerCredits: "0",
    cancellationRequestedAt: sql`COALESCE(${conversionOperations.cancellationRequestedAt}, NOW())`,
    failureCode: "cancelled_before_provider_dispatch",
    submissionLeaseId: null,
    submissionLeaseExpiresAt: null,
    terminalAt: new Date(),
    version: sql`${conversionOperations.version} + 1`,
    updatedAt: new Date(),
  }).where(and(
    eq(conversionOperations.operationKey, input.operationKey),
    phaseCondition,
    sql`${conversionOperations.providerJobId} IS NULL`,
  )).returning();
  return rows[0] ?? null;
}

export async function cancelConversionBeforeProviderDispatch(
  input: Parameters<typeof cancelConversionBeforeProviderDispatchWith>[1],
): Promise<ConversionOperation | null> {
  return cancelConversionBeforeProviderDispatchWith(getSharedDirectDb(), input);
}

export async function markConversionTerminalWith(
  db: Pick<DirectDatabase, "update">,
  input: {
    operationKey: string;
    status: "cancelled" | "failed" | "expired";
    failureCode: string;
    providerCredits?: string | null;
  },
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: [
      "submitted",
      "processing",
      "cancel_requested",
      "provider_finished",
      "ready_to_publish",
      "publication_committing",
    ],
    to: input.status,
    values: {
      failureCode: input.failureCode,
      providerCredits: input.providerCredits ?? null,
      terminalAt: new Date(),
    },
  });
}

export async function markConversionTerminal(
  input: Parameters<typeof markConversionTerminalWith>[1],
): Promise<ConversionOperation | null> {
  return markConversionTerminalWith(getSharedDirectDb(), input);
}

export async function failConversionPublicationWith(
  db: Pick<DirectDatabase, "update">,
  input: { operationKey: string; failureCode: string },
): Promise<ConversionOperation | null> {
  return transitionWith(db, {
    operationKey: input.operationKey,
    from: ["publication_committing"],
    to: "publication_failed",
    values: { failureCode: input.failureCode, terminalAt: new Date() },
  });
}

export async function failConversionPublication(
  input: Parameters<typeof failConversionPublicationWith>[1],
): Promise<ConversionOperation | null> {
  return failConversionPublicationWith(getSharedDirectDb(), input);
}

export const conversionOperationTransitions = {
  attachProviderJob: attachConversionProviderJobWith,
  claimPublication: claimConversionPublicationWith,
  claimSubmission: claimConversionSubmissionWith,
  confirmPublished: confirmConversionPublishedWith,
  failPublication: failConversionPublicationWith,
  markProcessing: markConversionProcessingWith,
  markProviderFinished: markConversionProviderFinishedWith,
  markReadyToPublish: markConversionReadyToPublishWith,
  markRecoveryAmbiguous: markConversionRecoveryAmbiguousWith,
  markSubmissionUnknown: markConversionSubmissionUnknownWith,
  expireSubmissionLease: expireConversionSubmissionLeaseWith,
  markTerminal: markConversionTerminalWith,
  requestCancellation: requestConversionCancellationWith,
} as const;
