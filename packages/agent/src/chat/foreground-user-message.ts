import { HumanMessage } from "@langchain/core/messages";
import type { ChatMultimodalImagePart } from "@nautilo/types";
import { normalizeAcceptedChatImageMime } from "@nautilo/attachments";
import { modelSupportsInput } from "@nautilo/model-capabilities";

type VisionContentPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string } };

/**
 * Build the user HumanMessage for a foreground chat job.
 *
 * - Keeps the user's typed text separate from attachment-derived text blocks
 *   until here — we merge them for the model without embedding raw base64 into
 *   the visible client message field.
 * - Drops image bytes when the active model does not declare image input (catalog).
 */
function replyKwargs(replyToMessageId: number | null | undefined): Record<string, unknown> | undefined {
  if (typeof replyToMessageId !== "number" || !Number.isInteger(replyToMessageId)) return undefined;
  return { nautilo_reply_to_message_id: replyToMessageId };
}

export function buildForegroundUserHumanMessage(args: {
  userText: string;
  attachmentTextBlocks: string[];
  multimodalImages: ChatMultimodalImagePart[];
  modelId: string;
  /**
   * Set when the executor ran vision fallback (or emitted a fallback warning).
   * Suppresses the generic "images not sent" line — must not be derived from
   * user-controlled attachment text (spoof risk).
   */
  suppressImageDropNote?: boolean | undefined;
  /** D124 — quote-reply row linkage (same-room validated upstream). */
  replyToMessageId?: number | null | undefined;
  /**
   * M135 P6 — DM (1 human + 1 agent) server-time prefix. ISO-8601 UTC string
   * (e.g. `2026-06-01T13:02:11Z`). When set, the human turn is prefixed with
   * `[<iso>] ` for time grounding. No speaker labels / composite block — DMs
   * are structurally unchanged otherwise. Group rooms leave this undefined
   * (they get the composite context block as a transient leading message
   * injected in `langgraph-executor.ts`).
   */
  serverTimePrefixIso?: string | undefined;
}): HumanMessage {
  const replyKw = replyKwargs(args.replyToMessageId);
  const timePrefix =
    typeof args.serverTimePrefixIso === "string" && args.serverTimePrefixIso.length > 0
      ? `[${args.serverTimePrefixIso}] `
      : "";
  const trimmedUser = args.userText.trim();
  const attachmentPrefix = args.attachmentTextBlocks.filter((s) => s.trim().length > 0).join("\n\n");

  const innerBody = [attachmentPrefix, trimmedUser].filter(Boolean).join("\n\n");
  let bodyText = innerBody ? timePrefix + innerBody : innerBody;
  if (!bodyText && args.multimodalImages.length > 0) {
    bodyText = `${timePrefix}(User attached images.)`;
  }

  if (args.multimodalImages.length === 0) {
    return replyKw
      ? new HumanMessage({ content: bodyText, additional_kwargs: replyKw })
      : new HumanMessage(bodyText);
  }

  const visionOk = modelSupportsInput(args.modelId, "image");
  if (!visionOk && args.multimodalImages.length > 0) {
    if (args.suppressImageDropNote === true) {
      const inner = [attachmentPrefix, trimmedUser].filter(Boolean).join("\n\n");
      const combined = inner ? timePrefix + inner : inner;
      return replyKw
        ? new HumanMessage({ content: combined || attachmentPrefix || "(User attached images.)", additional_kwargs: replyKw })
        : new HumanMessage(combined || attachmentPrefix || "(User attached images.)");
    }
    const names = args.multimodalImages.map((i) => i.filename).join(", ");
    const dropNote =
      `[Attachments] ${args.multimodalImages.length} image(s) were not sent to this model ` +
      `(no native image input): ${names}.`;
    const combined = timePrefix + [dropNote, attachmentPrefix, trimmedUser].filter(Boolean).join("\n\n");
    return replyKw
      ? new HumanMessage({ content: combined || dropNote, additional_kwargs: replyKw })
      : new HumanMessage(combined || dropNote);
  }

  const parts: VisionContentPart[] = [{ type: "text", text: bodyText || "(attached)" }];
  let addedImages = 0;
  for (const img of args.multimodalImages) {
    const mime = normalizeAcceptedChatImageMime(img.mimeType);
    if (!mime) continue;
    addedImages += 1;
    parts.push({
      type: "image_url",
      image_url: {
        url: `data:${mime};base64,${img.base64}`,
      },
    });
  }
  if (addedImages === 0 && args.multimodalImages.length > 0) {
    const note =
      `[Attachments] ${args.multimodalImages.length} image(s) could not be attached (invalid or unsupported MIME).`;
    const first = parts[0];
    if (first && first.type === "text") {
      parts[0] = { type: "text", text: `${first.text}\n\n${note}`.trim() };
    }
  }
  return replyKw ? new HumanMessage({ content: parts, additional_kwargs: replyKw }) : new HumanMessage({ content: parts });
}
