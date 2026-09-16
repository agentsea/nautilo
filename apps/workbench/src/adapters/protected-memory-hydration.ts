import {
  protectedMemoryDtoV1Schema,
  type ProtectedMemoryDtoV1,
} from "@nautilo/api-client/browser";

export const PROTECTED_MEMORY_MAX_HYDRATION_ROWS_V1 = 256;
export const PROTECTED_MEMORY_BRIEF_MAX_BYTES_V1 = 16 * 1024;
const MAX_OPENED_CONTENT_BYTES = 64 * 1024;
const MAX_OPENED_TYPE_BYTES = 4 * 1024;
const encoder = new TextEncoder();

type EncryptedMemoryDto = ProtectedMemoryDtoV1 & Readonly<{
  protectedPayload: Extract<
    ProtectedMemoryDtoV1["protectedPayload"],
    { status: "encrypted" }
  >;
}>;

type ClientMemoryUnavailableReason =
  | "unsupported_version"
  | "corrupt"
  | "lost_key_material"
  | "incomplete_access_set";

type ServerMemoryUnavailableReason = Extract<
  ProtectedMemoryDtoV1["protectedPayload"], { status: "unavailable" }
>["reason"];

export interface AuthorizedClientMemoryCryptoPortV1 {
  open(memory: EncryptedMemoryDto): unknown;
}

export type ProtectedWorkbenchMemoryContentV1 =
  | Readonly<{ kind: "opened"; content: string; type: string }>
  | Readonly<{
    kind: "placeholder";
    placeholder: "pending" | "locked" | "unsupported" | "corrupt" | "lost-key";
    reason:
      | ClientMemoryUnavailableReason
      | ServerMemoryUnavailableReason
      | "shadow_pending"
      | "backfill_pending";
  }>;

export type ProtectedWorkbenchMemoryV1 = Readonly<{
  memoryId: string;
  contentRevision: number;
  importance: number;
  tier: number;
  createdAt: string;
  updatedAt: string;
  namespaceIds: readonly string[];
  requiredNamespaceIds: readonly string[];
  content: ProtectedWorkbenchMemoryContentV1;
  source: ProtectedMemoryDtoV1;
}>;

export type ProtectedMemoryHydrationResultV1 =
  | Readonly<{
    status: "ready";
    memories: readonly ProtectedWorkbenchMemoryV1[];
  }>
  | Readonly<{ status: "rejected"; reason: "corrupt" }>;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const canonical = [...expected].sort();
  return actual.length === canonical.length
    && actual.every((field, index) => field === canonical[index]);
}

function openedResult(value: unknown): value is Readonly<{
  status: "opened";
  payloadVersion: 1;
  content: string;
  type: string;
}> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return exactKeys(record, ["status", "payloadVersion", "content", "type"])
    && record.status === "opened"
    && record.payloadVersion === 1
    && typeof record.content === "string"
    && encoder.encode(record.content).length <= MAX_OPENED_CONTENT_BYTES
    && typeof record.type === "string"
    && encoder.encode(record.type).length <= MAX_OPENED_TYPE_BYTES;
}

function unavailableResult(value: unknown): value is Readonly<{
  status: "unavailable";
  reason: ClientMemoryUnavailableReason;
}> {
  if (
    typeof value !== "object"
    || value === null
    || Array.isArray(value)
  ) return false;
  const record = value as Readonly<Record<string, unknown>>;
  return exactKeys(record, ["status", "reason"])
    && record.status === "unavailable"
    && (
      record.reason === "unsupported_version"
      || record.reason === "corrupt"
      || record.reason === "lost_key_material"
      || record.reason === "incomplete_access_set"
    );
}

function unavailableContent(
  reason: ClientMemoryUnavailableReason | ServerMemoryUnavailableReason,
): ProtectedWorkbenchMemoryContentV1 {
  switch (reason) {
    case "unsupported_version":
    case "text_search_unsupported":
      return { kind: "placeholder", placeholder: "unsupported", reason };
    case "corrupt":
    case "integrity_failure":
      return { kind: "placeholder", placeholder: "corrupt", reason };
    case "lost_key_material":
      return { kind: "placeholder", placeholder: "lost-key", reason };
    case "target_encryption_not_ready":
      return { kind: "placeholder", placeholder: "pending", reason };
    default:
      return { kind: "placeholder", placeholder: "locked", reason };
  }
}

async function hydrateContent(
  memory: ProtectedMemoryDtoV1,
  crypto: AuthorizedClientMemoryCryptoPortV1,
): Promise<ProtectedWorkbenchMemoryContentV1> {
  if (memory.protectedPayload.status === "pending") {
    return {
      kind: "placeholder",
      placeholder: "pending",
      reason: memory.protectedPayload.reason,
    };
  }
  if (memory.protectedPayload.status === "unavailable") {
    return unavailableContent(memory.protectedPayload.reason);
  }
  try {
    const result: unknown = await crypto.open(memory as EncryptedMemoryDto);
    if (openedResult(result)) {
      return {
        kind: "opened",
        content: result.content,
        type: result.type,
      };
    }
    if (unavailableResult(result)) return unavailableContent(result.reason);
    return unavailableContent("corrupt");
  } catch {
    return unavailableContent("corrupt");
  }
}

export async function hydrateProtectedMemoriesV1(input: Readonly<{
  items: readonly unknown[];
  crypto: AuthorizedClientMemoryCryptoPortV1;
}>): Promise<ProtectedMemoryHydrationResultV1> {
  if (
    !Array.isArray(input.items)
    || input.items.length > PROTECTED_MEMORY_MAX_HYDRATION_ROWS_V1
  ) return { status: "rejected", reason: "corrupt" };
  const parsed: ProtectedMemoryDtoV1[] = [];
  const identities = new Set<string>();
  try {
    for (const item of input.items) {
      const memory = protectedMemoryDtoV1Schema.parse(item);
      if (identities.has(memory.projection.memoryId)) {
        return { status: "rejected", reason: "corrupt" };
      }
      identities.add(memory.projection.memoryId);
      parsed.push(memory);
    }
  } catch {
    return { status: "rejected", reason: "corrupt" };
  }
  const memories = await Promise.all(parsed.map(async (memory) => {
    const projection = memory.projection;
    return Object.freeze({
      memoryId: projection.memoryId,
      contentRevision: projection.contentRevision,
      importance: projection.importance,
      tier: projection.tier,
      createdAt: projection.createdAt,
      updatedAt: projection.updatedAt,
      namespaceIds: projection.namespaceIds,
      requiredNamespaceIds: projection.requiredNamespaceIds,
      content: await hydrateContent(memory, input.crypto),
      source: memory,
    });
  }));
  return Object.freeze({ status: "ready", memories: Object.freeze(memories) });
}

/** Render bounded tier-1 content only after local authorized opening. */
export function renderProtectedMemoryBriefV1(
  memories: readonly ProtectedWorkbenchMemoryV1[],
): string {
  const lines: string[] = [];
  let bytes = 0;
  const candidates = memories
    .filter((memory) => memory.tier === 1 && memory.content.kind === "opened")
    .sort((left, right) =>
      right.importance - left.importance
      || left.createdAt.localeCompare(right.createdAt)
      || left.memoryId.localeCompare(right.memoryId)
    );
  for (const memory of candidates) {
    if (memory.content.kind !== "opened") continue;
    const line = `- [${memory.content.type}] ${memory.content.content}`;
    const nextBytes = encoder.encode(
      lines.length === 0 ? line : `\n${line}`,
    ).length;
    if (bytes + nextBytes > PROTECTED_MEMORY_BRIEF_MAX_BYTES_V1) break;
    lines.push(line);
    bytes += nextBytes;
  }
  return lines.join("\n");
}
