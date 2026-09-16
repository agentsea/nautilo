/**
 * Single-line metadata safe for `[Attachment …]` lines and similar model-visible envelopes.
 * Strips C0/C1 controls, square brackets (framing), and newlines.
 */
export function sanitizeAttachmentMetadataLine(input: string, maxLen = 240): string {
  // eslint-disable-next-line no-control-regex -- intentional stripping of C0/C1 for prompt-adjacent labels
  const noCtrl = input.replace(/[\u0000-\u001F\u007F\u0080-\u009F]/g, "");
  const noBracket = noCtrl.replace(/\[/g, "").replace(/\]/g, "");
  const collapsed = noBracket.replace(/\r?\n/g, " ").trim().slice(0, maxLen);
  return collapsed.length > 0 ? collapsed : "unnamed";
}
