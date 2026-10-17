import {
  parseImageAssistanceAdmission,
  type ImageAssistanceAdmission,
  type ImageAssistanceEntrypoint,
  type TaskFundingBinding,
} from "@nautilo/types";
import { and, eq } from "drizzle-orm";
import type { DirectDatabase } from "../config/direct-database";
import { jobs } from "../schema/jobs";

export type ImageAssistanceAdmissionIdentity = Readonly<{
  jobId: string;
  humanUserId: string;
  roomId: string;
  agentId: string;
  turnId: string;
  entrypoint: ImageAssistanceEntrypoint;
  mainModelId: string;
  inputCommitment: string;
  parentFundingKind: TaskFundingBinding["kind"];
}>;

type AdmissionJobRow = Pick<
  typeof jobs.$inferSelect,
  "id" | "requestorId" | "roomId" | "type" | "status" | "metadata"
>;

const IDENTITY_KEYS = [
  "jobId",
  "humanUserId",
  "roomId",
  "agentId",
  "turnId",
  "entrypoint",
  "mainModelId",
  "inputCommitment",
  "parentFundingKind",
] as const;
const HMAC_COMMITMENT_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;
const METADATA_KEY = "imageAssistanceAdmission";
const SANITIZED_ERROR = "Image assistance admission is unavailable";

export class ImageAssistanceAdmissionError extends Error {
  constructor() {
    super(SANITIZED_ERROR);
    this.name = "ImageAssistanceAdmissionError";
  }
}

function reject(): never {
  throw new ImageAssistanceAdmissionError();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length
    && actual.every((key, index) => key === expected[index]);
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function parseIdentity(value: unknown): ImageAssistanceAdmissionIdentity {
  if (!isRecord(value) || !hasExactKeys(value, IDENTITY_KEYS)) reject();
  if (
    !nonempty(value["jobId"])
    || !nonempty(value["humanUserId"])
    || !nonempty(value["roomId"])
    || !nonempty(value["agentId"])
    || !nonempty(value["turnId"])
    || !(value["entrypoint"] === "foreground.main" || value["entrypoint"] === "foreground.fork")
    || !nonempty(value["mainModelId"])
    || typeof value["inputCommitment"] !== "string"
    || !HMAC_COMMITMENT_PATTERN.test(value["inputCommitment"])
    || !(value["parentFundingKind"] === "server" || value["parentFundingKind"] === "personal")
  ) reject();
  return value as unknown as ImageAssistanceAdmissionIdentity;
}

function parseAdmission(value: unknown): ImageAssistanceAdmission {
  try {
    return parseImageAssistanceAdmission(value);
  } catch {
    return reject();
  }
}

function storedAdmission(metadata: unknown): ImageAssistanceAdmission | null {
  if (!isRecord(metadata)) reject();
  if (!Object.prototype.hasOwnProperty.call(metadata, METADATA_KEY)) return null;
  return parseAdmission(metadata[METADATA_KEY]);
}

function assertRow(
  row: AdmissionJobRow | undefined,
  identity: ImageAssistanceAdmissionIdentity,
): AdmissionJobRow {
  if (
    !row
    || row.id !== identity.jobId
    || row.requestorId !== identity.humanUserId
    || row.roomId !== identity.roomId
    || row.type !== "foreground"
    || row.status !== "running"
  ) reject();
  if (!isRecord(row.metadata)) reject();
  return row;
}

function assertAdmissionIdentity(
  admission: ImageAssistanceAdmission,
  identity: ImageAssistanceAdmissionIdentity,
): void {
  if (
    admission.jobId !== identity.jobId
    || admission.humanUserId !== identity.humanUserId
    || admission.roomId !== identity.roomId
    || admission.agentId !== identity.agentId
    || admission.turnId !== identity.turnId
    || admission.entrypoint !== identity.entrypoint
    || admission.mainModelId !== identity.mainModelId
    || admission.inputCommitment !== identity.inputCommitment
    || admission.operationId !== `image-assistance:${identity.jobId}`
    || admission.funding.kind !== identity.parentFundingKind
  ) reject();
}

function sameRetainedBinding(
  left: ImageAssistanceAdmission,
  right: ImageAssistanceAdmission,
): boolean {
  return left.formatVersion === right.formatVersion
    && left.jobId === right.jobId
    && left.humanUserId === right.humanUserId
    && left.roomId === right.roomId
    && left.agentId === right.agentId
    && left.turnId === right.turnId
    && left.entrypoint === right.entrypoint
    && left.mainModelId === right.mainModelId
    && left.inputCommitment === right.inputCommitment
    && left.operationId === right.operationId
    && left.modelId === right.modelId
    && left.preferenceRevision === right.preferenceRevision
    && left.serverSelection === right.serverSelection
    && JSON.stringify(left.funding) === JSON.stringify(right.funding);
}

const selection = {
  id: jobs.id,
  requestorId: jobs.requestorId,
  roomId: jobs.roomId,
  type: jobs.type,
  status: jobs.status,
  metadata: jobs.metadata,
};

function authorityPredicate(identity: ImageAssistanceAdmissionIdentity) {
  return and(
    eq(jobs.id, identity.jobId),
    eq(jobs.requestorId, identity.humanUserId),
    eq(jobs.roomId, identity.roomId),
    eq(jobs.type, "foreground"),
    eq(jobs.status, "running"),
  );
}

async function lockedJob(
  tx: Parameters<Parameters<DirectDatabase["transaction"]>[0]>[0],
  identity: ImageAssistanceAdmissionIdentity,
): Promise<AdmissionJobRow> {
  const [row] = await tx.select(selection)
    .from(jobs)
    .where(authorityPredicate(identity))
    .limit(1)
    .for("update");
  return assertRow(row, identity);
}

export async function readImageAssistanceAdmissionWith(
  db: DirectDatabase,
  unsafeIdentity: ImageAssistanceAdmissionIdentity,
): Promise<ImageAssistanceAdmission | null> {
  const identity = parseIdentity(unsafeIdentity);
  const [row] = await db.select(selection)
    .from(jobs)
    .where(authorityPredicate(identity))
    .limit(1);
  const admission = storedAdmission(assertRow(row, identity).metadata);
  if (admission) assertAdmissionIdentity(admission, identity);
  return admission;
}

export async function pinImageAssistanceAdmissionWith(
  db: DirectDatabase,
  unsafeIdentity: ImageAssistanceAdmissionIdentity,
  unsafeCandidate: ImageAssistanceAdmission,
): Promise<ImageAssistanceAdmission> {
  const identity = parseIdentity(unsafeIdentity);
  const candidate = parseAdmission(unsafeCandidate);
  assertAdmissionIdentity(candidate, identity);
  if (candidate.state !== "admitted") reject();
  return db.transaction(async (tx) => {
    const row = await lockedJob(tx, identity);
    const retained = storedAdmission(row.metadata);
    if (retained) {
      assertAdmissionIdentity(retained, identity);
      return retained;
    }
    const [updated] = await tx.update(jobs)
      .set({ metadata: { ...row.metadata, [METADATA_KEY]: candidate } })
      .where(authorityPredicate(identity))
      .returning({ id: jobs.id });
    if (!updated) reject();
    return candidate;
  });
}

export async function claimImageAssistanceDispatchWith(
  db: DirectDatabase,
  unsafeIdentity: ImageAssistanceAdmissionIdentity,
  unsafeAdmission: ImageAssistanceAdmission,
): Promise<boolean> {
  const identity = parseIdentity(unsafeIdentity);
  const admission = parseAdmission(unsafeAdmission);
  assertAdmissionIdentity(admission, identity);
  if (admission.state !== "admitted") reject();
  return db.transaction(async (tx) => {
    const row = await lockedJob(tx, identity);
    const retained = storedAdmission(row.metadata);
    if (!retained) reject();
    assertAdmissionIdentity(retained, identity);
    if (!sameRetainedBinding(retained, admission)) reject();
    if (retained.state === "dispatched") return false;
    const dispatched = parseAdmission({ ...retained, state: "dispatched" });
    const [updated] = await tx.update(jobs)
      .set({ metadata: { ...row.metadata, [METADATA_KEY]: dispatched } })
      .where(authorityPredicate(identity))
      .returning({ id: jobs.id });
    if (!updated) reject();
    return true;
  });
}
