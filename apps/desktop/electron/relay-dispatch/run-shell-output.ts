import { Buffer } from "node:buffer";

import type { RelayDispatchRequest } from "@nautilo/relay";

import { RunShellOutputArtifactStore } from "../run-shell-output-continuity.ts";
import type { DesktopDispatchDecision } from "./router.ts";

/** Retained output is a pure read lane before any shell authority is prepared. */
export async function dispatchRunShellOutput(input: {
  readonly request: RelayDispatchRequest;
  readonly outputArtifactStore?: RunShellOutputArtifactStore | undefined;
}): Promise<DesktopDispatchDecision> {
  await Promise.resolve();
  const { request: req, outputArtifactStore } = input;
  if (req.toolName !== "run_shell" || req.args["output_artifact"] === undefined)
    return { handled: false };
  const request = req.args["output_artifact"];
  const record =
    typeof request === "object" && request !== null && !Array.isArray(request)
      ? (request as Record<string, unknown>)
      : null;
  const unavailable = (): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_UNAVAILABLE",
      error:
        "run_shell output continuation is unavailable on this relay session",
    },
  });
  const notFound = (): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_NOT_FOUND",
      error:
        "run_shell output continuation is unavailable, expired, or belongs to another session",
    },
  });
  const invalid = (
    error = "run_shell output continuation request is invalid",
  ): DesktopDispatchDecision => ({
    handled: true,
    result: {
      status: "error",
      errorCode: "RUN_SHELL_OUTPUT_ARTIFACT_REQUEST_INVALID",
      error,
    },
  });
  if (record?.["operation"] === "search") {
    const allowedKeys = new Set([
      "reference",
      "operation",
      "query",
      "max_matches",
      "context_bytes",
    ]);
    const query = record["query"];
    const maxMatches =
      record["max_matches"] === undefined ? 20 : record["max_matches"];
    const contextBytes =
      record["context_bytes"] === undefined ? 256 : record["context_bytes"];
    if (
      Object.keys(req.args).length !== 1 ||
      typeof record["reference"] !== "string" ||
      !/^[A-Za-z0-9_-]{43}$/.test(record["reference"]) ||
      Object.keys(record).some((key) => !allowedKeys.has(key)) ||
      typeof query !== "string" ||
      query.length === 0 ||
      query.length > 1024 ||
      Buffer.byteLength(query, "utf8") > 1024 ||
      typeof maxMatches !== "number" ||
      !Number.isSafeInteger(maxMatches) ||
      maxMatches < 1 ||
      maxMatches > 20 ||
      typeof contextBytes !== "number" ||
      !Number.isSafeInteger(contextBytes) ||
      contextBytes < 0 ||
      contextBytes > 1024
    )
      return invalid("run_shell output continuation search request is invalid");
    if (
      req.runShellOwnerBinding === undefined ||
      outputArtifactStore === undefined
    )
      return unavailable();
    const result = outputArtifactStore.search({
      reference: record["reference"],
      owner: req.runShellOwnerBinding,
      query: Buffer.from(query, "utf8"),
      maxMatches,
      contextBytes,
    });
    return result === null
      ? notFound()
      : { handled: true, result: { status: "ok", result } };
  }
  const allowedKeys = new Set([
    "reference",
    "offset_bytes",
    "max_bytes",
    "delete_after_read",
  ]);
  if (
    Object.keys(req.args).length !== 1 ||
    record === null ||
    typeof record["reference"] !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/.test(record["reference"]) ||
    Object.keys(record).some((key) => !allowedKeys.has(key)) ||
    (record["delete_after_read"] !== undefined &&
      typeof record["delete_after_read"] !== "boolean") ||
    req.args["command"] !== undefined ||
    req.args["git"] !== undefined ||
    req.args["execution"] !== undefined
  )
    return invalid();
  if (
    req.runShellOwnerBinding === undefined ||
    outputArtifactStore === undefined
  )
    return unavailable();
  const offsetBytes =
    record["offset_bytes"] === undefined ? 0 : record["offset_bytes"];
  const maxBytes =
    record["max_bytes"] === undefined ? 16 * 1024 : record["max_bytes"];
  if (
    typeof offsetBytes !== "number" ||
    !Number.isSafeInteger(offsetBytes) ||
    offsetBytes < 0 ||
    typeof maxBytes !== "number" ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1
  )
    return invalid("run_shell output continuation paging values are invalid");
  const result = outputArtifactStore.read({
    reference: record["reference"],
    owner: req.runShellOwnerBinding,
    deleteAfterRead: record["delete_after_read"] === true,
    offsetBytes,
    maxBytes,
  });
  return result === null
    ? notFound()
    : { handled: true, result: { status: "ok", result } };
}
