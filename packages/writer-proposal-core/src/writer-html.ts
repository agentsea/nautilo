/** Server-safe parser for the canonical Writer HTML container. */

export const NAUTILO_DOCUMENT_MANIFEST_TYPE = "application/vnd.nautilo.document+json";
export const NAUTILO_DOCUMENT_MANIFEST_ID = "manifest";
export const WAFFLEBASE_DOCUMENT_TYPE = "application/vnd.wafflebase.document+json";
export const WRITER_DOCUMENT_TYPE = "document";
export const WRITER_EDITOR = "wafflebase";
export const WRITER_HTML_VERSION = "1.0";
export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_SCAN_NODES = 200_000;

export type WriterHtmlManifest = {
  documentType: typeof WRITER_DOCUMENT_TYPE;
  editor: typeof WRITER_EDITOR;
  payloadId: string;
  payloadFormat: typeof WAFFLEBASE_DOCUMENT_TYPE;
  version: typeof WRITER_HTML_VERSION;
  metadata?: { createdBy?: string; updatedAt?: string };
};

export type WafflebaseDocumentPayload = {
  blocks: unknown[];
  [key: string]: unknown;
};

export type WriterHtmlDocument = {
  manifest: WriterHtmlManifest;
  document: WafflebaseDocumentPayload;
};

export type WriterHtmlParseResult =
  | { ok: true; document: WriterHtmlDocument }
  | { ok: false; error: string };

type ScriptBlock = { attrs: Record<string, string>; content: string };
const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertSafeObjectKeys(value: unknown, label: string): string | null {
  let budget = MAX_SCAN_NODES;
  const walk = (node: unknown, path: string): string | null => {
    if (--budget <= 0) return `${label} is too large to validate safely.`;
    if (!node || typeof node !== "object") return null;
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        const err = walk(node[i], `${path}[${i}]`);
        if (err) return err;
      }
      return null;
    }
    for (const key of Object.keys(node as Record<string, unknown>)) {
      if (FORBIDDEN_KEYS.has(key)) return `${path}.${key} is a forbidden key.`;
      const err = walk((node as Record<string, unknown>)[key], `${path}.${key}`);
      if (err) return err;
    }
    return null;
  };
  return walk(value, label);
}

function attrMap(attrText: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRe = /([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(attrText)) !== null) {
    attrs[match[1]!.toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

function extractScriptBlocks(html: string): ScriptBlock[] {
  const blocks: ScriptBlock[] = [];
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
  let match: RegExpExecArray | null;
  while ((match = scriptRe.exec(html)) !== null) {
    blocks.push({ attrs: attrMap(match[1] ?? ""), content: (match[2] ?? "").replace(/<\\\/script/gi, "</script").trim() });
  }
  return blocks;
}

function parseJsonBlock(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${label} is not valid JSON.`);
  }
}

function findRequiredScript(blocks: ScriptBlock[], id: string, type: string): ScriptBlock {
  const matches = blocks.filter(
    (block) => block.attrs["id"] === id && block.attrs["type"]?.toLowerCase() === type,
  );
  if (matches.length !== 1) throw new Error(`Expected exactly one script#${id} with type ${type}.`);
  return matches[0]!;
}

function validateManifest(value: unknown): WriterHtmlManifest {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Manifest must be an object.");
  const unsafe = assertSafeObjectKeys(value, "manifest");
  if (unsafe) throw new Error(unsafe);
  const record = value as Record<string, unknown>;
  if (record["documentType"] !== WRITER_DOCUMENT_TYPE) throw new Error('Manifest documentType must be "document".');
  if (record["editor"] !== WRITER_EDITOR) throw new Error('Manifest editor must be "wafflebase".');
  if (typeof record["payloadId"] !== "string" || record["payloadId"].trim().length === 0) {
    throw new Error("Manifest payloadId must be a non-empty string.");
  }
  if (record["payloadFormat"] !== WAFFLEBASE_DOCUMENT_TYPE) {
    throw new Error(`Manifest payloadFormat must be "${WAFFLEBASE_DOCUMENT_TYPE}".`);
  }
  if (record["version"] !== WRITER_HTML_VERSION) throw new Error(`Manifest version must be "${WRITER_HTML_VERSION}".`);
  const metadata =
    record["metadata"] && typeof record["metadata"] === "object" && !Array.isArray(record["metadata"])
      ? record["metadata"] as NonNullable<WriterHtmlManifest["metadata"]>
      : undefined;
  return {
    ...record,
    documentType: WRITER_DOCUMENT_TYPE,
    editor: WRITER_EDITOR,
    payloadId: record["payloadId"].trim(),
    payloadFormat: WAFFLEBASE_DOCUMENT_TYPE,
    version: WRITER_HTML_VERSION,
    ...(metadata !== undefined ? { metadata } : {}),
  };
}

export function validateWafflebaseDocument(value: unknown): WafflebaseDocumentPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Document payload must be an object.");
  const unsafe = assertSafeObjectKeys(value, "document");
  if (unsafe) throw new Error(unsafe);
  const blocks = (value as Record<string, unknown>)["blocks"];
  if (!Array.isArray(blocks)) throw new Error("Document payload must include a blocks array.");
  return value as WafflebaseDocumentPayload;
}

function escapeScriptJson(json: string): string {
  return json.replace(/<\/script/gi, "<\\/script");
}

/**
 * Emits the server-authoritative Writer container. Wrapper markup is fixed and
 * deterministic; only validated manifest and document JSON cross the boundary.
 */
export function serializeCanonicalWriterHtml(
  manifest: WriterHtmlManifest,
  document: unknown,
): string {
  const normalizedManifest = validateManifest(manifest);
  const normalizedDocument = validateWafflebaseDocument(document);
  const manifestJson = escapeScriptJson(JSON.stringify(normalizedManifest));
  const documentJson = escapeScriptJson(JSON.stringify(normalizedDocument));
  const html = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Document</title>
    <script type="${NAUTILO_DOCUMENT_MANIFEST_TYPE}" id="${NAUTILO_DOCUMENT_MANIFEST_ID}">${manifestJson}</script>
    <script type="${normalizedManifest.payloadFormat}" id="${normalizedManifest.payloadId}">${documentJson}</script>
  </head>
  <body></body>
</html>
`;
  if (new TextEncoder().encode(html).byteLength > MAX_DOCUMENT_BYTES) {
    throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES} bytes (app bridge limit).`);
  }
  return html;
}

export function parseWriterHtml(raw: string): WriterHtmlParseResult {
  try {
    if (new TextEncoder().encode(raw).byteLength > MAX_DOCUMENT_BYTES) {
      throw new Error(`Document exceeds ${MAX_DOCUMENT_BYTES} bytes (app bridge limit).`);
    }
    const blocks = extractScriptBlocks(raw);
    const executable = blocks.find((block) => {
      const type = block.attrs["type"]?.toLowerCase();
      return !type || type === "text/javascript" || type === "module" || block.attrs["src"];
    });
    if (executable) throw new Error("Writer documents must not contain executable script tags.");
    const manifestBlock = findRequiredScript(blocks, NAUTILO_DOCUMENT_MANIFEST_ID, NAUTILO_DOCUMENT_MANIFEST_TYPE);
    const manifest = validateManifest(parseJsonBlock(manifestBlock.content, "Manifest"));
    const payloadBlock = findRequiredScript(blocks, manifest.payloadId, manifest.payloadFormat);
    const document = validateWafflebaseDocument(parseJsonBlock(payloadBlock.content, "Document payload"));
    return { ok: true, document: { manifest, document } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
