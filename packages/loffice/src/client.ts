/**
 * LofficeClient — typed TS client for the unoserver/nwuno XML-RPC engine.
 *
 * Native unoserver methods (verified via system.listMethods, 2026-07-02):
 *   info() · convert(...) · compare(...)
 * Extended nwuno methods (Tier-A: find_replace/template_fill/insert_text/
 * set_cells/set_range/get_structured/get_meta/set_meta) land in a later phase
 * and reuse `call()`.
 */
import {
  buildMethodCall,
  decodeMethodResponse,
  type XmlRpcValue,
} from "./xmlrpc";

export interface LofficeClientOptions {
  /** Engine XML-RPC endpoint. Default env NAUTILO_LOFFICE_URL or http://localhost:2003/ */
  baseUrl?: string;
  /** Per-call timeout (ms). Default 60000. */
  timeoutMs?: number;
}

export interface LofficeInfo {
  unoserver: string;
  api: string;
  /** Present on some unoserver builds only; absent on 3.4. Keyed data is in the filter maps. */
  libreoffice_version?: string;
  /** Keyed by LibreOffice **internal** filter name (e.g. `writer_pdf_Export`), value = description. */
  import_filters: Record<string, string>;
  export_filters: Record<string, string>;
}

export interface ConvertOptions {
  /** Explicit LibreOffice export filter name (else auto by target). */
  filter?: string;
  /** Filter options like "OptionName=Value" (e.g. PDF settings). */
  filterOptions?: string[];
  /** Update TOC/indexes before export. Default true. */
  updateIndex?: boolean;
  /** Explicit import filter name. */
  inFilter?: string;
}

export class LofficeClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(opts: LofficeClientOptions = {}) {
    this.baseUrl =
      opts.baseUrl ?? process.env["NAUTILO_LOFFICE_URL"] ?? "http://localhost:2003/";
    this.timeoutMs = opts.timeoutMs ?? 60000;
  }

  /** Low-level XML-RPC call. Throws XmlRpcFault on engine fault. */
  async call(method: string, params: XmlRpcValue[]): Promise<XmlRpcValue> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const res = await fetch(this.baseUrl, {
        method: "POST",
        headers: { "content-type": "text/xml" },
        body: buildMethodCall(method, params),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`engine HTTP ${res.status} ${res.statusText}`);
      return decodeMethodResponse(await res.text());
    } finally {
      clearTimeout(timer);
    }
  }

  async info(): Promise<LofficeInfo> {
    return (await this.call("info", [])) as unknown as LofficeInfo;
  }

  /** Convert document bytes to `convertTo` (e.g. "pdf","xlsx"). Returns bytes. */
  async convert(
    data: Uint8Array,
    convertTo: string,
    opts: ConvertOptions = {},
  ): Promise<Uint8Array> {
    const result = await this.call("convert", [
      null, // inpath
      data, // indata (base64)
      null, // outpath
      convertTo, // convert_to
      opts.filter ?? null, // filtername
      opts.filterOptions ?? [], // filter_options
      opts.updateIndex ?? true, // update_index
      opts.inFilter ?? null, // infiltername
    ]);
    if (!(result instanceof Uint8Array)) {
      throw new Error("convert: expected binary result from engine");
    }
    return result;
  }

  /** Compare two documents; returns the comparison doc bytes. */
  async compare(
    oldData: Uint8Array,
    newData: Uint8Array,
    filetype: string,
  ): Promise<Uint8Array> {
    const result = await this.call("compare", [
      null, // oldpath
      oldData, // olddata
      null, // newpath
      newData, // newdata
      null, // outpath
      filetype, // filetype
    ]);
    if (!(result instanceof Uint8Array)) {
      throw new Error("compare: expected binary result from engine");
    }
    return result;
  }

  // ---- extended (nwuno) Tier-A mutation/read ----------------------------
  // `ext` is the document extension (e.g. "docx"/"xlsx"), used to load + store.

  private async mutate(method: string, params: XmlRpcValue[]): Promise<Uint8Array> {
    const r = await this.call(method, params);
    if (!(r instanceof Uint8Array)) throw new Error(`${method}: expected binary result`);
    return r;
  }

  findReplace(data: Uint8Array, ext: string, search: string, replace: string, regex = false): Promise<Uint8Array> {
    return this.mutate("find_replace", [data, ext, search, replace, regex]);
  }

  templateFill(data: Uint8Array, ext: string, mapping: Record<string, string>): Promise<Uint8Array> {
    return this.mutate("template_fill", [data, ext, mapping]);
  }

  insertText(data: Uint8Array, ext: string, text: string, atEnd = true): Promise<Uint8Array> {
    return this.mutate("insert_text", [data, ext, text, atEnd]);
  }

  setCells(data: Uint8Array, ext: string, cells: Array<{ sheet?: number; cell: string; value: string | number | boolean }>): Promise<Uint8Array> {
    return this.mutate("set_cells", [data, ext, cells as unknown as XmlRpcValue]);
  }

  setRange(data: Uint8Array, ext: string, sheet: number, cellrange: string, rows: Array<Array<string | number>>): Promise<Uint8Array> {
    return this.mutate("set_range", [data, ext, sheet, cellrange, rows as unknown as XmlRpcValue]);
  }

  setMeta(data: Uint8Array, ext: string, meta: Record<string, string | string[]>): Promise<Uint8Array> {
    return this.mutate("set_meta", [data, ext, meta as unknown as XmlRpcValue]);
  }

  async getMeta(data: Uint8Array, ext: string): Promise<Record<string, unknown>> {
    return (await this.call("get_meta", [data, ext])) as Record<string, unknown>;
  }

  async getStructured(data: Uint8Array, ext: string): Promise<Record<string, unknown>> {
    return (await this.call("get_structured", [data, ext])) as Record<string, unknown>;
  }
}
