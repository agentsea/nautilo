const FOREGROUND_SHADOW_IPC_MAX_BYTES = 8 * 1024 * 1024;
export const FOREGROUND_SHADOW_HISTORY_IPC_MAX_BYTES = 64 * 1024 * 1024;
const FOREGROUND_SHADOW_HISTORY_MAX_RECORDS = 64;

/** Clone one renderer value only after proving a finite serialized bound. */
export function boundedForegroundShadowValue(
  value: unknown,
  label: string,
  maxBytes = FOREGROUND_SHADOW_IPC_MAX_BYTES,
): unknown {
  let json: string | undefined;
  try {
    json = JSON.stringify(value);
  } catch {
    throw new Error(`${label} is not serializable.`);
  }
  if (json === undefined) throw new Error(`${label} is not serializable.`);
  if (Buffer.byteLength(json, "utf8") > maxBytes) {
    throw new Error(`${label} exceeds its byte limit.`);
  }
  return structuredClone(value);
}

export function foregroundShadowString(
  value: unknown,
  label: string,
  maxLength = 256,
): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new Error(`${label} is invalid.`);
  }
  return value;
}

/** Exact data-only input for decrypt-only pending-attention recovery. */
export function parseForegroundShadowPendingAttention(raw: unknown): Readonly<{
  roomId: string;
  clientActionSessionId: string;
}> {
  const value = boundedForegroundShadowValue(
    raw,
    "Foreground pending attention",
  ) as Record<string, unknown>;
  if (Object.keys(value).some((key) =>
    key !== "roomId" && key !== "clientActionSessionId"
  )) throw new TypeError("Foreground pending attention input is invalid.");
  return Object.freeze({
    roomId: foregroundShadowString(value["roomId"], "Room id", 200),
    clientActionSessionId: foregroundShadowString(
      value["clientActionSessionId"],
      "Client action Session id",
      200,
    ),
  });
}

export function assertForegroundShadowHistoryShape(value: unknown): asserts value is {
  readerInput: { records: readonly unknown[] };
  acknowledgement: object;
} {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Foreground Shadow history input is invalid.");
  }
  const input = value as {
    readerInput?: { records?: readonly unknown[] };
    acknowledgement?: unknown;
  };
  if (!Array.isArray(input.readerInput?.records)
    || input.readerInput.records.length > FOREGROUND_SHADOW_HISTORY_MAX_RECORDS
    || typeof input.acknowledgement !== "object"
    || input.acknowledgement === null
    || Array.isArray(input.acknowledgement)) {
    throw new Error("Foreground Shadow history input is invalid.");
  }
  for (const candidate of input.readerInput.records) {
    if (typeof candidate !== "object" || candidate === null
      || Array.isArray(candidate)) {
      throw new Error("Foreground Shadow history record is invalid.");
    }
    const record = candidate as Record<string, unknown>;
    if (record["representationMode"] === "protected-only") {
      if ("ordinarySibling" in record
        || "ordinaryPayloadBytesBase64url" in record
        || typeof record["selectedSource"] !== "object"
        || record["selectedSource"] === null
        || Array.isArray(record["selectedSource"])) {
        throw new Error("Protected Room history contains an ordinary sibling.");
      }
    }
  }
}
/** Data-only edit request; custody is opened only after this validation. */
export function parseForegroundShadowEdit(raw: unknown): Readonly<{
  roomId: string;
  messageId: string;
  body: Readonly<{ content: string; expectedRevision: number }>;
}> {
  const value = boundedForegroundShadowValue(raw, "Foreground encrypted edit") as {
    roomId?: unknown;
    messageId?: unknown;
    body?: unknown;
  };
  const roomId = foregroundShadowString(value?.roomId, "Room id", 200);
  const messageId = foregroundShadowString(value?.messageId, "Message id", 200);
  if (typeof value?.body !== "object" || value.body === null || Array.isArray(value.body)) {
    throw new TypeError("Encrypted edit body is invalid.");
  }
  const body = value.body as Record<string, unknown>;
  const content = body["content"];
  const expectedRevision = body["expectedRevision"];
  if (Object.keys(body).some((key) => key !== "content" && key !== "expectedRevision")
    || typeof content !== "string" || content.trim().length === 0
    || typeof expectedRevision !== "number"
    || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new TypeError("Encrypted edit body is invalid.");
  }
  return { roomId, messageId, body: { content, expectedRevision } };
}
