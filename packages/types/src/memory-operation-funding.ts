import { parseTaskFundingBinding, type TaskFundingBinding } from "./task-funding";
import { type MemoryCapabilityRole } from "./personal-capability-preferences";

/** Existing Memory work owns this content-free accepted model/account binding. */
export type MemoryOperationBinding = Readonly<{
  version: 1;
  role: MemoryCapabilityRole;
  modelId: string;
  /** Opaque server-keyed commitment; no source coordinates or content hashes. */
  inputCommitment: string;
}> & (Readonly<{ kind: "service" }> | Readonly<{
  kind: "human";
  humanUserId: string;
  preferenceRevision: number;
  funding: TaskFundingBinding;
}>);

export function parseMemoryOperationBinding(value: unknown): MemoryOperationBinding {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Memory operation binding is malformed");
  const row = value as Record<string, unknown>;
  const base = ["version", "role", "modelId", "inputCommitment", "kind"];
  const expected = row["kind"] === "human" ? [...base, "humanUserId", "preferenceRevision", "funding"] : base;
  if (row["version"] !== 1 || !(row["role"] === "memoryReview" || row["role"] === "memoryReflection" || row["role"] === "memorySummarization")
    || typeof row["modelId"] !== "string" || row["modelId"].trim() !== row["modelId"] || !row["modelId"]
    || typeof row["inputCommitment"] !== "string" || !/^hmac-sha256:[A-Za-z0-9_-]{43}$/.test(row["inputCommitment"])
    || Object.keys(row).length !== expected.length || expected.some((key) => !(key in row))) throw new TypeError("Memory operation binding is malformed");
  const common = { version: 1 as const, role: row["role"] as MemoryCapabilityRole, modelId: row["modelId"], inputCommitment: row["inputCommitment"] };
  if (row["kind"] === "service") return Object.freeze({ ...common, kind: "service" });
  if (row["kind"] !== "human" || typeof row["humanUserId"] !== "string" || !row["humanUserId"]
    || !Number.isSafeInteger(row["preferenceRevision"]) || Number(row["preferenceRevision"]) < 0) throw new TypeError("Memory operation binding is malformed");
  return Object.freeze({ ...common, kind: "human", humanUserId: row["humanUserId"],
    preferenceRevision: Number(row["preferenceRevision"]), funding: parseTaskFundingBinding(row["funding"]) });
}
