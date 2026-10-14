/**
 * Local text edits keep a file's existing line-ending convention. Models send
 * LF text, so a file whose every line break is CRLF is edited in LF form and
 * written back with CRLF. Mixed or LF files are left byte-for-byte as edited.
 */

export function isCrlfText(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

export function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

export function toCrlf(text: string): string {
  return toLf(text).replace(/\n/g, "\r\n");
}
