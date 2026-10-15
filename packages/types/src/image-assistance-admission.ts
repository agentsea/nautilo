import {
  parseTaskFundingBinding,
  type TaskFundingBinding,
} from "./task-funding";

export const IMAGE_ASSISTANCE_ENTRYPOINTS = [
  "foreground.main",
  "foreground.fork",
] as const;

export type ImageAssistanceEntrypoint =
  (typeof IMAGE_ASSISTANCE_ENTRYPOINTS)[number];

export type ImageAssistanceAdmission = Readonly<{
  formatVersion: 1;
  jobId: string;
  humanUserId: string;
  roomId: string;
  agentId: string;
  turnId: string;
  entrypoint: ImageAssistanceEntrypoint;
  mainModelId: string;
  inputCommitment: string;
  operationId: string;
  modelId: string;
  preferenceRevision: number;
  serverSelection: string | null;
  funding: TaskFundingBinding;
  state: "admitted" | "dispatched";
}>;

const ADMISSION_KEYS = [
  "formatVersion",
  "jobId",
  "humanUserId",
  "roomId",
  "agentId",
  "turnId",
  "entrypoint",
  "mainModelId",
  "inputCommitment",
  "operationId",
  "modelId",
  "preferenceRevision",
  "serverSelection",
  "funding",
  "state",
] as const;
const HMAC_COMMITMENT_PATTERN = /^hmac-sha256:[0-9a-f]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((key, index) => key === sortedExpected[index]);
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Parse only the durable, non-content admission protocol. The exact-key check
 * prevents callers from persisting prompts, images, questions, or credentials
 * alongside the binding.
 */
export function parseImageAssistanceAdmission(
  value: unknown,
): ImageAssistanceAdmission {
  if (!isRecord(value) || !hasExactKeys(value, ADMISSION_KEYS)) {
    throw new TypeError("Image assistance admission is malformed");
  }
  const strings = [
    value["jobId"],
    value["humanUserId"],
    value["roomId"],
    value["agentId"],
    value["turnId"],
    value["mainModelId"],
    value["modelId"],
  ];
  if (
    value["formatVersion"] !== 1
    || strings.some((item) => !isNonemptyString(item))
    || !(IMAGE_ASSISTANCE_ENTRYPOINTS as readonly unknown[]).includes(value["entrypoint"])
    || typeof value["inputCommitment"] !== "string"
    || !HMAC_COMMITMENT_PATTERN.test(value["inputCommitment"])
    || value["operationId"] !== `image-assistance:${value["jobId"] as string}`
    || !Number.isSafeInteger(value["preferenceRevision"])
    || (value["preferenceRevision"] as number) < 0
    || !(value["serverSelection"] === null || isNonemptyString(value["serverSelection"]))
    || !(value["state"] === "admitted" || value["state"] === "dispatched")
  ) {
    throw new TypeError("Image assistance admission is malformed");
  }
  const funding = parseTaskFundingBinding(value["funding"]);
  return Object.freeze({
    formatVersion: 1,
    jobId: value["jobId"] as string,
    humanUserId: value["humanUserId"] as string,
    roomId: value["roomId"] as string,
    agentId: value["agentId"] as string,
    turnId: value["turnId"] as string,
    entrypoint: value["entrypoint"] as ImageAssistanceEntrypoint,
    mainModelId: value["mainModelId"] as string,
    inputCommitment: value["inputCommitment"],
    operationId: value["operationId"],
    modelId: value["modelId"] as string,
    preferenceRevision: value["preferenceRevision"] as number,
    serverSelection: value["serverSelection"],
    funding,
    state: value["state"],
  });
}
