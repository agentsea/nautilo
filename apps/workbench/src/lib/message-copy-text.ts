/**
 * Full-message text extraction for "Copy message" (ISSUE-D367).
 *
 * `conversation.tsx`'s `extractMessageText` deliberately returns only
 * the FIRST text part — it feeds the one-line quote-reply snippet.
 * Copying a message must not truncate: an assistant turn can carry
 * several text parts (interleaved with tool parts), so copy joins ALL
 * text parts. Non-text parts (tool calls, attachments) are omitted in
 * v1 — copy yields the readable prose the user sees.
 *
 * Pure function: no React, no DOM. Unit-tested in
 * `message-copy-text.test.ts`.
 */
export function extractFullMessageText(content: unknown): string {
  if (!Array.isArray(content)) return "";
  const texts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const po = part as { type?: string; text?: string };
    if (po.type === "text" && typeof po.text === "string") {
      texts.push(po.text);
    }
  }
  return texts.join("\n\n");
}
