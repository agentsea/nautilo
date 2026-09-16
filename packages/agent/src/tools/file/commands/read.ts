/** Text reads return lossless byte-bounded pages; image/PDF projection remains modality-aware. */
import { readTextWindow } from "@nautilo/relay";
import { ToolMessage } from "@langchain/core/messages";
import {
  isImageMimeForModelInput,
  isPdfMimeForModelInput,
  sniffMimeFromPathAndBytes,
} from "@nautilo/attachments";
import { modelSupportsInput } from "@nautilo/model-capabilities";
import type { CommandHandler } from "./_shared";
import { getFileBackend } from "../dispatch";
import { fileToolError } from "../file-result-status";
import { modelIdForCapabilityProjection } from "../../../config/model-role-resolution";

const DEFAULT_MAX_LINES = 2000;
const BINARY_SNIFF_BYTES = 8 * 1024;
/** Cap for image/PDF bytes loaded into the model context (D069). */
const MAX_MULTIMODAL_READ_BYTES = 10 * 1024 * 1024;
const OFFICE_DOCUMENT_PATH = /\.(?:docx|xlsx|pptx)$/i;

export const handleRead: CommandHandler<"read"> = async (
  args,
  resolution,
  _ctx,
) => {
  if (args.lineRange && args.lineRange.to < args.lineRange.from) {
    return fileToolError(
      `Error: lineRange.to (${args.lineRange.to}) must be >= lineRange.from (${args.lineRange.from})`,
    );
  }
  const offset = Math.max(1, args.lineRange?.from ?? args.offset ?? 1);
  const limit = args.lineRange
    ? args.lineRange.to - args.lineRange.from + 1
    : args.limit ?? DEFAULT_MAX_LINES;
  // The active model has already crossed the selection/invocation boundary.
  // File projection only inspects its capabilities; resolve a default solely
  // when the caller did not supply an active model at all.
  const activeModelId = modelIdForCapabilityProjection("chat", _ctx.activeModelId);
  const backend = getFileBackend(_ctx);

  try {
    const stat = await backend.stat(resolution.resolved);
    if (stat.isDirectory()) return fileToolError(`Error: ${resolution.resolved} is a directory. Use 'list' for directories.`);
    if (!backend.readRange || !stat.sourceVersion) {
      return fileToolError("Error: this file backend does not support recoverable text reads. Use the current Desktop local-file transport.");
    }
    const head = await backend.readRange(resolution.resolved, 0, Math.min(stat.size, BINARY_SNIFF_BYTES));

    const sniffedMime = sniffMimeFromPathAndBytes(resolution.resolved, head);

    if (sniffedMime && (isImageMimeForModelInput(sniffedMime) || isPdfMimeForModelInput(sniffedMime))) {
      const isImage = isImageMimeForModelInput(sniffedMime);
      const requiredModality = isImage ? "image" : "file";
      if (!modelSupportsInput(activeModelId, requiredModality)) {
        const capLabel = isImage ? "vision" : "PDF document understanding";
        return (
          `${sniffedMime} file ${resolution.resolved} — current model (${activeModelId}) does not support ${capLabel}. ` +
          "Switch to a model that supports this modality to read the file."
        );
      }

      if (stat.size > MAX_MULTIMODAL_READ_BYTES) {
        return fileToolError(`Error: ${sniffedMime} file ${resolution.resolved} is ${stat.size} bytes, exceeds the ${MAX_MULTIMODAL_READ_BYTES}-byte multimodal-read cap.`);
      }

      const bytes = await backend.readRange(resolution.resolved, 0, stat.size);
      if ((await backend.stat(resolution.resolved)).sourceVersion !== stat.sourceVersion) {
        return fileToolError("Error: source changed during read; retry the file.");
      }
      const b64 = bytes.toString("base64");
      const kind = isImage ? "Image" : "PDF";
      const headerText = `${kind}: ${resolution.resolved} (${bytes.byteLength} bytes, ${sniffedMime})`;

      // LangChain content-block shapes are NOT symmetric across modalities:
      //   - images use the legacy `{type:"image_url", image_url:{url}}` form
      //     and `@langchain/anthropic` converts the data URL to Anthropic's
      //     base64 source natively.
      //   - PDFs / arbitrary files use the standard file block with
      //     `source_type:"base64"` + `mime_type` + raw base64 `data`.
      //     OpenAI requires a later provider projection because function
      //     outputs cannot carry this document semantically; pre-model owns
      //     that role-safe projection rather than coupling the file tool to a
      //     particular transport.
      const content: Array<Record<string, unknown>> = [
        { type: "text", text: headerText },
        isImage
          ? {
              type: "image_url",
              image_url: { url: `data:${sniffedMime};base64,${b64}` },
            }
          : {
              type: "file",
              source_type: "base64",
              mime_type: sniffedMime,
              data: b64,
              filename: resolution.resolved.split(/[\\/]/).pop() || "document.pdf",
            },
      ];

      // D113A — stash a structured summary on additional_kwargs so the
      // workbench tool card can render a thumbnail (image) / metadata
      // block (PDF) instead of the generic "[multimodal tool result]"
      // placeholder. Field name is namespaced; LangChain ignores
      // unknown additional_kwargs keys.
      const eventSummary = JSON.stringify({
        multimodal: true,
        kind: isImage ? "image" : "pdf",
        absolutePath: resolution.resolved,
        mime: sniffedMime,
        bytes: bytes.byteLength,
        header: headerText,
      });

      return new ToolMessage({
        content: content as never,
        tool_call_id: "",
        name: "file",
        additional_kwargs: { nautilo_event_summary: eventSummary },
      });
    }

    if (head.length > 0 && head.includes(0)) {
      const recovery = OFFICE_DOCUMENT_PATH.test(args.path)
        ? "Use officecli with command='view' and mode='text' to read this closed Office document."
        : "Use 'stat' for metadata.";
      return fileToolError(`Error: ${resolution.resolved} appears to be a binary file (contains null bytes in first ${BINARY_SNIFF_BYTES} bytes). ${recovery}`);
    }

    return JSON.stringify(await readTextWindow({
      size: stat.size, version: stat.sourceVersion,
      readRange: (start, length) => backend.readRange!(resolution.resolved, start, length),
      currentVersion: async () => (await backend.stat(resolution.resolved)).sourceVersion ?? "",
    }, { from: offset, to: offset + limit - 1, ...(args.readCursor ? { cursor: args.readCursor } : {}), ...(_ctx.signal ? { signal: _ctx.signal } : {}) }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("ENOENT")) {
      return fileToolError(`Error: file not found: ${resolution.resolved}`);
    }
    if (msg.includes("EISDIR")) {
      return fileToolError(`Error: ${resolution.resolved} is a directory. Use 'list' for directories.`);
    }
    if (msg.includes("EACCES")) {
      return fileToolError(`Error: permission denied: ${resolution.resolved}`);
    }
    return fileToolError(`Error reading file: ${msg}`);
  }
};
