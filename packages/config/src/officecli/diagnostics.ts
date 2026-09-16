import { truncateCliOutput, type OfficeHelpFormat } from "./generate";

/**
 * Small, pure OfficeCLI input and diagnostic helpers shared by the Agent
 * workspace path and the Desktop relay path. They never invoke OfficeCLI.
 */

const OFFICE_HELP_FORMATS = new Set<OfficeHelpFormat>(["docx", "xlsx", "pptx"]);

export const OFFICE_HELP_FORMAT_ERROR =
  "help requires format via format, type, or a .docx/.xlsx/.pptx path";

export const OFFICECLI_CREATE_DATA_ERROR =
  "`data` is merge-only; use `commands` when creating a document. For Markdown, add { command: \"add\", parent: \"/body\", type: \"markdown\", props: { markdown: \"...\" } } to commands.";

function isOfficeHelpFormat(value: unknown): value is OfficeHelpFormat {
  return typeof value === "string" && OFFICE_HELP_FORMATS.has(value as OfficeHelpFormat);
}

/** Explicit format wins, followed by the legacy format-shaped type and path extension. */
export function resolveOfficeHelpFormat(input: {
  readonly format?: unknown;
  readonly type?: unknown;
  readonly path?: unknown;
}): OfficeHelpFormat | undefined {
  if (isOfficeHelpFormat(input.format)) return input.format;
  if (isOfficeHelpFormat(input.type)) return input.type;
  if (typeof input.path !== "string") return undefined;
  const extension = /\.([^.\\/]+)$/u.exec(input.path.trim())?.[1]?.toLowerCase();
  return isOfficeHelpFormat(extension) ? extension : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function boundedText(value: string): string {
  return truncateCliOutput(value);
}

/**
 * Return only an intentional message/error field from a JSON error envelope.
 * Schema bodies and arbitrary nested data are never echoed into the model.
 */
export function extractOfficeCliStructuredMessage(stdout: string): string | undefined {
  try {
    const root = record(JSON.parse(stdout));
    if (!root) return undefined;
    const rootMessage = root["message"];
    if (typeof rootMessage === "string" && boundedText(rootMessage)) return boundedText(rootMessage);
    const error = root["error"];
    if (typeof error === "string" && boundedText(error)) return boundedText(error);
    const errorRecord = record(error);
    const errorMessage = errorRecord?.["message"];
    if (typeof errorMessage === "string" && boundedText(errorMessage)) return boundedText(errorMessage);
    const errorText = errorRecord?.["error"];
    return typeof errorText === "string" && boundedText(errorText)
      ? boundedText(errorText)
      : undefined;
  } catch {
    return undefined;
  }
}

/** Prefer structured stdout, then concise stderr, and finally the exit code. */
export function formatOfficeHelpFailure(input: {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}): string {
  const structured = extractOfficeCliStructuredMessage(input.stdout);
  if (structured) return `officecli help failed: ${structured}`;
  const stderr = boundedText(input.stderr);
  if (stderr) return `officecli help failed: ${stderr}`;
  return `officecli help failed: exit ${input.exitCode}`;
}
