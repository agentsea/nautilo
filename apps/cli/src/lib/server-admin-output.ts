/**
 * The deliberately small output contract for the signed server CLI.
 *
 * Commands use this rather than printing Error messages or cached session
 * objects directly.  In particular, an Error can contain a token, a URL with
 * credentials, a response body, or a stack; none is a safe CLI payload.
 */
export type ServerAdminFormat = "human" | "json" | "jsonl";

const SERVER_ADMIN_OUTPUT_SCHEMA = "nautilo.server-admin.v1";

type JsonRecord = Record<string, unknown>;

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

export function renderServerAdminError(
  format: ServerAdminFormat,
  code: string,
  message: string,
): string {
  if (format === "json" || format === "jsonl") {
    return `${JSON.stringify({
      schema: SERVER_ADMIN_OUTPUT_SCHEMA,
      ok: false,
      error: { code, message },
    })}\n`;
  }
  return `${message}\n`;
}

export function writeServerAdminSuccess(
  format: ServerAdminFormat,
  data: JsonRecord,
  human: readonly string[],
): void {
  if (format === "json" || format === "jsonl") {
    json({ schema: SERVER_ADMIN_OUTPUT_SCHEMA, ok: true, data });
    return;
  }
  process.stdout.write(`${human.join("\n")}\n`);
}

/** Error messages are fixed, reviewed strings: never forward an Error. */
export function writeServerAdminError(
  format: ServerAdminFormat,
  code: string,
  message: string,
): void {
  if (format === "json" || format === "jsonl") {
    process.stdout.write(renderServerAdminError(format, code, message));
    return;
  }
  process.stderr.write(renderServerAdminError(format, code, message));
}

/**
 * Redact by field name at every depth.  This is intentionally conservative:
 * error fixtures exercise access/refresh tokens, headers, URLs and stacks.
 */
const SECRET_FIELD = /(?:token|authorization|cookie|password|secret|api[-_]?key|stack|headers?|url|cause|error|message)/i;

export function redactServerAdminValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactServerAdminValue);
  // Error fields such as `message`, `cause`, and `stack` are frequently
  // non-enumerable. Treat the entire object as unsafe rather than relying on
  // Object.entries() to discover every implementation-specific field.
  if (value instanceof Error) return undefined;
  if (value && typeof value === "object") {
    const out: JsonRecord = {};
    for (const [key, nested] of Object.entries(value as JsonRecord)) {
      if (SECRET_FIELD.test(key)) continue;
      out[key] = redactServerAdminValue(nested);
    }
    return out;
  }
  return value;
}
