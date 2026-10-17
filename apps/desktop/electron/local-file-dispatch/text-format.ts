/**
 * Local text edits keep a file's existing format. A UTF-8 byte order mark
 * stays at the start, and a file whose every line break is CRLF stays CRLF.
 * Edits run on the file's body without the mark and with LF line breaks,
 * which is also the form models send. Mixed or LF files keep their bytes.
 */

const BYTE_ORDER_MARK = "\uFEFF";

export interface TextFormat {
  readonly bom: boolean;
  readonly crlf: boolean;
}

function isCrlfText(text: string): boolean {
  return text.includes("\r\n") && !/(^|[^\r])\n/.test(text);
}

function toLf(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Splits decoded file text into its format and the body that edits apply to. */
export function parseTextFormat(decoded: string): { format: TextFormat; body: string } {
  const bom = decoded.startsWith(BYTE_ORDER_MARK);
  const withoutBom = bom ? decoded.slice(1) : decoded;
  const crlf = isCrlfText(withoutBom);
  return { format: { bom, crlf }, body: crlf ? toLf(withoutBom) : withoutBom };
}

/** Brings model-supplied text into the body form of a file with this format. */
export function toEditText(text: string, format: TextFormat): string {
  const withoutBom = format.bom && text.startsWith(BYTE_ORDER_MARK) ? text.slice(1) : text;
  return format.crlf ? toLf(withoutBom) : withoutBom;
}

/** Restores the format's line breaks and, unless omitted, its byte order mark. */
export function formatText(body: string, format: TextFormat, includeBom = true): string {
  const text = format.crlf ? toLf(body).replace(/\n/g, "\r\n") : body;
  return format.bom && includeBom ? BYTE_ORDER_MARK + text : text;
}
