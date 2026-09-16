/**
 * Minimal, dependency-free XML-RPC codec for the unoserver/nwuno engine.
 *
 * Scope is deliberately the XML-RPC subset unoserver speaks (Python
 * SimpleXMLRPCServer, allow_none=True): string / int / boolean / double /
 * base64 / nil / array / struct. No dateTime coercion (kept as string).
 */

export type XmlRpcValue =
  | string
  | number
  | boolean
  | null
  | Uint8Array
  | XmlRpcValue[]
  | { [key: string]: XmlRpcValue };

export class XmlRpcFault extends Error {
  constructor(
    readonly faultCode: number,
    readonly faultString: string,
  ) {
    super(`XML-RPC fault ${faultCode}: ${faultString}`);
    this.name = "XmlRpcFault";
  }
}

// ---- encode -------------------------------------------------------------

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function toBase64(bytes: Uint8Array): string {
  // Buffer is available under Bun/Node; avoids btoa unicode pitfalls.
  return Buffer.from(bytes).toString("base64");
}

export function encodeValue(v: XmlRpcValue): string {
  if (v === null || v === undefined) return "<value><nil/></value>";
  if (v instanceof Uint8Array) return `<value><base64>${toBase64(v)}</base64></value>`;
  if (typeof v === "boolean") return `<value><boolean>${v ? 1 : 0}</boolean></value>`;
  if (typeof v === "number") {
    return Number.isInteger(v)
      ? `<value><int>${v}</int></value>`
      : `<value><double>${v}</double></value>`;
  }
  if (typeof v === "string") return `<value><string>${escapeXml(v)}</string></value>`;
  if (Array.isArray(v)) {
    return `<value><array><data>${v.map(encodeValue).join("")}</data></array></value>`;
  }
  const members = Object.entries(v)
    .map(([k, val]) => `<member><name>${escapeXml(k)}</name>${encodeValue(val)}</member>`)
    .join("");
  return `<value><struct>${members}</struct></value>`;
}

export function buildMethodCall(method: string, params: XmlRpcValue[]): string {
  const p = params.map((v) => `<param>${encodeValue(v)}</param>`).join("");
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${p}</params></methodCall>`;
}

// ---- decode -------------------------------------------------------------

function unescapeXml(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

interface Cursor {
  s: string;
  i: number;
}

function skipWs(c: Cursor): void {
  while (c.i < c.s.length && /\s/.test(c.s[c.i]!)) c.i++;
}

function expect(c: Cursor, tag: string): void {
  skipWs(c);
  if (!c.s.startsWith(tag, c.i)) {
    throw new Error(`XML-RPC parse: expected ${tag} at ${c.i}: ${c.s.slice(c.i, c.i + 40)}`);
  }
  c.i += tag.length;
}

function readUntil(c: Cursor, close: string): string {
  const end = c.s.indexOf(close, c.i);
  if (end === -1) throw new Error(`XML-RPC parse: missing ${close}`);
  const out = c.s.slice(c.i, end);
  c.i = end + close.length;
  return out;
}

/** Parse one <value>…</value> starting at (or before, skipping ws) the cursor. */
function parseValue(c: Cursor): XmlRpcValue {
  expect(c, "<value>");
  skipWs(c);
  let result: XmlRpcValue;

  if (c.s.startsWith("<nil/>", c.i)) {
    c.i += "<nil/>".length;
    result = null;
  } else if (c.s.startsWith("<string>", c.i)) {
    c.i += "<string>".length;
    result = unescapeXml(readUntil(c, "</string>"));
  } else if (c.s.startsWith("<int>", c.i)) {
    c.i += "<int>".length;
    result = parseInt(readUntil(c, "</int>").trim(), 10);
  } else if (c.s.startsWith("<i4>", c.i)) {
    c.i += "<i4>".length;
    result = parseInt(readUntil(c, "</i4>").trim(), 10);
  } else if (c.s.startsWith("<boolean>", c.i)) {
    c.i += "<boolean>".length;
    result = readUntil(c, "</boolean>").trim() === "1";
  } else if (c.s.startsWith("<double>", c.i)) {
    c.i += "<double>".length;
    result = parseFloat(readUntil(c, "</double>").trim());
  } else if (c.s.startsWith("<base64>", c.i)) {
    c.i += "<base64>".length;
    const b64 = readUntil(c, "</base64>").replace(/\s/g, "");
    result = new Uint8Array(Buffer.from(b64, "base64"));
  } else if (c.s.startsWith("<dateTime.iso8601>", c.i)) {
    c.i += "<dateTime.iso8601>".length;
    result = readUntil(c, "</dateTime.iso8601>").trim();
  } else if (c.s.startsWith("<array>", c.i)) {
    c.i += "<array>".length;
    expect(c, "<data>");
    const arr: XmlRpcValue[] = [];
    for (;;) {
      skipWs(c);
      if (c.s.startsWith("</data>", c.i)) {
        c.i += "</data>".length;
        break;
      }
      arr.push(parseValue(c));
    }
    expect(c, "</array>");
    result = arr;
  } else if (c.s.startsWith("<struct>", c.i)) {
    c.i += "<struct>".length;
    const obj: Record<string, XmlRpcValue> = {};
    for (;;) {
      skipWs(c);
      if (c.s.startsWith("</struct>", c.i)) {
        c.i += "</struct>".length;
        break;
      }
      expect(c, "<member>");
      expect(c, "<name>");
      const name = unescapeXml(readUntil(c, "</name>"));
      obj[name] = parseValue(c);
      expect(c, "</member>");
    }
    result = obj;
  } else {
    // No type tag → raw string content until </value>.
    result = unescapeXml(readUntil(c, "</value>"));
    return result;
  }

  expect(c, "</value>");
  return result;
}

/** Decode a methodResponse; throws XmlRpcFault on <fault>. */
export function decodeMethodResponse(xml: string): XmlRpcValue {
  const faultIdx = xml.indexOf("<fault>");
  if (faultIdx !== -1) {
    const c: Cursor = { s: xml, i: faultIdx + "<fault>".length };
    const fault = parseValue(c) as Record<string, XmlRpcValue>;
    const code = fault["faultCode"];
    const str = fault["faultString"];
    throw new XmlRpcFault(
      typeof code === "number" ? code : Number(code ?? -1),
      typeof str === "string" ? str : JSON.stringify(str ?? "unknown"),
    );
  }
  const paramIdx = xml.indexOf("<param>");
  if (paramIdx === -1) return null; // void response
  const c: Cursor = { s: xml, i: paramIdx + "<param>".length };
  return parseValue(c);
}
