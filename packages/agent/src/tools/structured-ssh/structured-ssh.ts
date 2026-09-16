import { DynamicStructuredTool } from "@langchain/core/tools";
import {
  RELAY_SSH_APPROVED_REQUEST_MAX_ARG_BYTES,
  RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES,
  RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES,
  RELAY_SSH_APPROVED_REQUEST_MAX_PROGRAM_BYTES,
  RELAY_SSH_DEFAULT_TIMEOUT_SECONDS,
  RELAY_SSH_HARD_TIMEOUT_SECONDS,
  RELAY_SSH_SOFT_TIMEOUT_SECONDS,
  RELAY_SSH_TIMEOUT_REASON_MAX_BYTES,
  RELAY_SSH_TIMEOUT_REASON_MIN_BYTES,
} from "@nautilo/relay";
import { isIP } from "node:net";
import { z } from "zod";

// eslint-disable-next-line no-control-regex -- the relay protocol rejects C0/C1 controls in programs.
const PROGRAM_CONTROLS = /[\u0000-\u001f\u007f-\u009f]/u;
// eslint-disable-next-line no-control-regex -- POSIX argv may contain line breaks; only NUL is impossible.
const ARG_FORBIDDEN = /\u0000/u;
// eslint-disable-next-line no-control-regex -- destinations and local paths remain single-line identifiers.
const TEXT_FORBIDDEN = /[\u0000\r\n]/u;
const REMOTE_COPY_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const DESTINATION_HOST_MAX_BYTES = 253;
const DESTINATION_USER_MAX_BYTES = 64;

export type StructuredSshTimeoutResolution =
  | { readonly ok: true; readonly timeoutSeconds: number; readonly timeoutReason?: string | undefined }
  | { readonly ok: false; readonly error: string };

export function resolveStructuredSshTimeout(
  args: Record<string, unknown>,
): StructuredSshTimeoutResolution {
  const raw = args["timeout_seconds"];
  const timeoutSeconds = raw === undefined ? RELAY_SSH_DEFAULT_TIMEOUT_SECONDS : raw;
  if (!Number.isSafeInteger(timeoutSeconds) || (timeoutSeconds as number) < 1 ||
    (timeoutSeconds as number) > RELAY_SSH_HARD_TIMEOUT_SECONDS) {
    return {
      ok: false,
      error: `Structured SSH timeout_seconds must be an integer from 1 to ${RELAY_SSH_HARD_TIMEOUT_SECONDS}.`,
    };
  }
  const reasonRaw = args["timeout_reason"];
  if ((timeoutSeconds as number) <= RELAY_SSH_SOFT_TIMEOUT_SECONDS) {
    if (reasonRaw !== undefined) {
      return { ok: false, error: "Structured SSH timeout_reason is accepted only above the 30-minute soft budget." };
    }
    return { ok: true, timeoutSeconds: timeoutSeconds as number };
  }
  const timeoutReason = typeof reasonRaw === "string" ? reasonRaw.trim() : "";
  const reasonBytes = Buffer.byteLength(timeoutReason, "utf8");
  if (reasonBytes < RELAY_SSH_TIMEOUT_REASON_MIN_BYTES || reasonBytes > RELAY_SSH_TIMEOUT_REASON_MAX_BYTES || TEXT_FORBIDDEN.test(timeoutReason)) {
    return {
      ok: false,
      error: `Structured SSH operations above ${RELAY_SSH_SOFT_TIMEOUT_SECONDS} seconds require a single-line timeout_reason between ${RELAY_SSH_TIMEOUT_REASON_MIN_BYTES} and ${RELAY_SSH_TIMEOUT_REASON_MAX_BYTES} UTF-8 bytes.`,
    };
  }
  return { ok: true, timeoutSeconds: timeoutSeconds as number, timeoutReason };
}

const timeoutFields = {
  timeout_seconds: z.number().int().min(1).max(RELAY_SSH_HARD_TIMEOUT_SECONDS).optional()
    .describe(`Execution budget in seconds. Defaults to ${RELAY_SSH_DEFAULT_TIMEOUT_SECONDS}; above ${RELAY_SSH_SOFT_TIMEOUT_SECONDS} requires timeout_reason; maximum ${RELAY_SSH_HARD_TIMEOUT_SECONDS}.`),
  timeout_reason: z.string().optional()
    .describe(`Required only above ${RELAY_SSH_SOFT_TIMEOUT_SECONDS} seconds and included in the exact review.`),
};

function validateTimeoutFields(value: Record<string, unknown>, ctx: z.RefinementCtx): void {
  const resolved = resolveStructuredSshTimeout(value);
  if (!resolved.ok) ctx.addIssue({ code: "custom", message: resolved.error });
}

function hasUnpairedUtf16Surrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return true;
    }
  }
  return false;
}

const boundedProgramSchema = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      value.charAt(0) !== "-" &&
      Buffer.byteLength(value, "utf8") <= RELAY_SSH_APPROVED_REQUEST_MAX_PROGRAM_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      !PROGRAM_CONTROLS.test(value),
    `program must be a non-option command without controls, at most ${RELAY_SSH_APPROVED_REQUEST_MAX_PROGRAM_BYTES} UTF-8 bytes.`,
  )
  .describe("Bounded program name for the grant-authorized remote command; this is not a shell command string.");

const boundedArgSchema = z
  .string()
  .refine(
    (value) =>
      Buffer.byteLength(value, "utf8") <= RELAY_SSH_APPROVED_REQUEST_MAX_ARG_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      !ARG_FORBIDDEN.test(value),
    `Each argv entry must be at most ${RELAY_SSH_APPROVED_REQUEST_MAX_ARG_BYTES} UTF-8 bytes and contain no NUL. Line breaks are preserved as argument data.`,
  );

const namedDestinationSchema = z.object({
  connection: z.string().refine(
    (value) =>
      value.length > 0 &&
      !value.startsWith("-") &&
      Buffer.byteLength(value, "utf8") <= DESTINATION_HOST_MAX_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      !TEXT_FORBIDDEN.test(value) &&
      (isIP(value) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value)),
    `connection must be a bounded configured connection name, at most ${DESTINATION_HOST_MAX_BYTES} UTF-8 bytes.`,
  ),
}).strict();

const adHocDestinationSchema = z.object({
  host: z.string().refine(
    (value) =>
      value.length > 0 &&
      !value.startsWith("-") &&
      Buffer.byteLength(value, "utf8") <= DESTINATION_HOST_MAX_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      !TEXT_FORBIDDEN.test(value) &&
      (isIP(value) !== 0 || /^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/u.test(value)),
    `host must be a bounded DNS name or IP literal, at most ${DESTINATION_HOST_MAX_BYTES} UTF-8 bytes.`,
  ),
  user: z.string().refine(
    (value) =>
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= DESTINATION_USER_MAX_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      /^[A-Za-z_][A-Za-z0-9_-]*$/u.test(value),
    `user must be a bounded remote username, at most ${DESTINATION_USER_MAX_BYTES} UTF-8 bytes.`,
  ),
  port: z.number().int().min(1).max(65_535).optional(),
}).strict();

const destinationSchema = z.union([namedDestinationSchema, adHocDestinationSchema])
  .describe("Strict SSH destination intent: either { connection } or exact { host, user, port? }. Variants never mix and ad hoc endpoints bypass the catalog.");

const localCopyPathSchema = z
  .string()
  .refine(
    (value) =>
      value.length > 0 &&
      !value.startsWith("/") &&
      !value.includes("\\") &&
      Buffer.byteLength(value, "utf8") <= RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES &&
      !hasUnpairedUtf16Surrogate(value) &&
      !TEXT_FORBIDDEN.test(value) &&
      value.split("/").every((segment) =>
        segment.length > 0 && segment !== "." && segment !== ".." && !segment.startsWith("-"),
      ),
    `localPath must be a workspace-relative path without traversal or controls, at most ${RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES} UTF-8 bytes. Electron resolves it under the Workspace.`,
  );

const remoteCopyPathSchema = z
  .string()
  .refine(
    (value) => {
      if (value.length === 0 || Buffer.byteLength(value, "utf8") > RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES || !/^[A-Za-z0-9/._-]+$/u.test(value)) return false;
      return value.split("/").every((segment, index) =>
        (index === 0 && segment === "") || (segment !== "." && segment !== ".." && REMOTE_COPY_SEGMENT.test(segment)),
      );
    },
    `remotePath must be a bounded literal POSIX path, at most ${RELAY_SSH_APPROVED_REQUEST_MAX_COPY_PATH_BYTES} UTF-8 bytes.`,
  );

/** Model-facing request only; Electron owns grant, identity, executable, and trust authority. */
export const structuredSshAuthSchema = z
  .object({ destination: destinationSchema })
  .strict();

/** Model-facing request only; program and argv are data, never shell text. */
export const structuredSshExecSchema = z
  .object({
    destination: destinationSchema,
    program: boundedProgramSchema,
    argv: z
      .array(boundedArgSchema)
      .max(RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES)
      .describe(`Bounded argument vector with at most ${RELAY_SSH_APPROVED_REQUEST_MAX_ARGV_ENTRIES} entries.`),
    ...timeoutFields,
  })
  .strict()
  .superRefine(validateTimeoutFields);

/** Local paths are intent only; Electron resolves each one against live local authority. */
export const structuredSshCopyUploadSchema = z.object({
  destination: destinationSchema,
  localPath: localCopyPathSchema,
  remotePath: remoteCopyPathSchema,
  ...timeoutFields,
}).strict().superRefine(validateTimeoutFields);

/** Local paths are intent only; Electron resolves each one against live local authority. */
export const structuredSshCopyDownloadSchema = z.object({
  destination: destinationSchema,
  remotePath: remoteCopyPathSchema,
  localPath: localCopyPathSchema,
  ...timeoutFields,
}).strict().superRefine(validateTimeoutFields);

const structuredSshOutputPageSchema = z.object({
  reference: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  offset_bytes: z.number().int().nonnegative().optional(),
  max_bytes: z.number().int().positive().max(16 * 1024).optional(),
  delete_after_read: z.boolean().optional(),
}).strict();

const structuredSshOutputSearchSchema = z.object({
  reference: z.string().regex(/^[A-Za-z0-9_-]{43}$/u),
  operation: z.literal("search"),
  query: z.string().min(1).max(1024)
    .refine((value) => Buffer.byteLength(value, "utf8") <= 1024),
  max_matches: z.number().int().positive().max(20).optional(),
  context_bytes: z.number().int().nonnegative().max(1024).optional(),
}).strict();

export const structuredSshOutputSchema = z.object({
  output_artifact: z.union([structuredSshOutputPageSchema, structuredSshOutputSearchSchema]),
}).strict();

function rejectDirectInvocation(toolName: string): Promise<never> {
  return Promise.reject(
    new Error(
      `${toolName} is a relay tool — execution goes through the approved structured SSH relay protocol, not direct invocation. ` +
        "If you see this error, the tool routing in toolsNode is broken.",
    ),
  );
}

export function createStructuredSshAuthTool() {
  return new DynamicStructuredTool({
    name: "structured_ssh_auth",
    description:
      "Authenticate to one exact destination using this Mac's enabled structured SSH capability and locally resolved OpenSSH setup. " +
      "Use destination.connection for one configured connection, or destination.host plus destination.user for an exact endpoint. Variants cannot mix; an exact endpoint bypasses the catalog. " +
      "The model supplies no identity, SSH executable, option, path, socket, trust state, or grant reference. " +
      "Normal session approval policy applies; do not ask the Human to create a separate host grant. This is a relay-only structured operation, never a raw shell fallback.",
    schema: structuredSshAuthSchema,
    func: () => rejectDirectInvocation("structured_ssh_auth"),
  });
}

export function createStructuredSshExecTool() {
  return new DynamicStructuredTool({
    name: "structured_ssh_exec",
    description:
      "Run one bounded program and argv at the exact destination using this Mac's enabled structured SSH capability and locally resolved OpenSSH setup. Live output is shown while it runs; larger results return a short-lived continuation instead of failing at 64 KiB. " +
      "Use destination.connection for one configured connection, or destination.host plus destination.user for an exact endpoint. Variants cannot mix; an exact endpoint bypasses the catalog. " +
      "The model supplies program and argv, but no identity, SSH executable, option, path, socket, trust state, or grant reference. " +
      `The default execution budget is ${RELAY_SSH_DEFAULT_TIMEOUT_SECONDS} seconds; request up to ${RELAY_SSH_HARD_TIMEOUT_SECONDS} seconds, with a reason above ${RELAY_SSH_SOFT_TIMEOUT_SECONDS}. ` +
      "Normal session approval policy applies; do not ask the Human to create a separate host grant. This is a relay-only structured operation, never a raw shell fallback.",
    schema: structuredSshExecSchema,
    func: () => rejectDirectInvocation("structured_ssh_exec"),
  });
}

export function createStructuredSshCopyUploadTool() {
  return new DynamicStructuredTool({
    name: "structured_ssh_copy_upload",
    description:
      "Copy one workspace-relative local file to one literal remote path using this Mac's enabled structured SSH capability and locally resolved OpenSSH setup. " +
      "Use destination.connection for one configured connection, or destination.host plus destination.user for an exact endpoint. Variants cannot mix; an exact endpoint bypasses the catalog. " +
      "The desktop independently resolves localPath under Nautilo Workspace. The model supplies no identity, SSH executable, option, key, socket, trust state, or grant reference. Normal session approval policy applies; do not ask the Human to create a separate host grant. Never use raw shell.",
    schema: structuredSshCopyUploadSchema,
    func: () => rejectDirectInvocation("structured_ssh_copy_upload"),
  });
}

export function createStructuredSshCopyDownloadTool() {
  return new DynamicStructuredTool({
    name: "structured_ssh_copy_download",
    description:
      "Copy one literal remote file at the exact destination to one workspace-relative local path using this Mac's enabled structured SSH capability and locally resolved OpenSSH setup. " +
      "Use destination.connection for one configured connection, or destination.host plus destination.user for an exact endpoint. Variants cannot mix; an exact endpoint bypasses the catalog. " +
      "The desktop independently resolves localPath under Nautilo Workspace. The model supplies no identity, SSH executable, option, key, socket, trust state, or grant reference. Normal session approval policy applies; do not ask the Human to create a separate host grant. Never use raw shell.",
    schema: structuredSshCopyDownloadSchema,
    func: () => rejectDirectInvocation("structured_ssh_copy_download"),
  });
}

export function createStructuredSshOutputTool() {
  return new DynamicStructuredTool({
    name: "structured_ssh_output",
    description:
      "Read or search a bounded page from a short-lived, Desktop-local Structured SSH output continuation. " +
      "Use the opaque outputArtifact.reference returned by structured_ssh_exec. This never reconnects, reruns the remote command, reads a private key, or starts an SSH process. " +
      "Search first for a known diagnostic; otherwise page only the ranges needed and request deletion on the final page. Missing or expired output must not cause an automatic command retry.",
    schema: structuredSshOutputSchema,
    func: () => rejectDirectInvocation("structured_ssh_output"),
  });
}
