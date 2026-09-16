/**
 * Writer preview image hydration — trusted-host utilities for ReaderSurface /
 * HTML viewer. Image bytes live only in the non-executable Wafflebase payload;
 * static preview markup uses indexed slots (`data-writer-image-index`).
 */

import { parseDataUrlImage } from "./docx-image";
import {
  WAFFLEBASE_DOCUMENT_TYPE,
  WRITER_EDITOR,
  WRITER_DOCUMENT_TYPE,
  WRITER_PREVIEW_IMAGE_INDEX_ATTR,
  WRITER_PREVIEW_ROOT_CLASS,
  collectWriterPreviewImageSources,
  type WafflebaseDocumentPayload,
} from "./office-document";

export { WRITER_PREVIEW_IMAGE_INDEX_ATTR, WRITER_PREVIEW_ROOT_CLASS };

export type WriterPreviewHydrationResult = {
  attached: number;
  revoke: () => void;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Attach blob: URLs to indexed preview slots; leaves placeholders on failure. */
export function hydrateWriterPreviewImages(
  root: ParentNode,
  imageSources: readonly string[],
): WriterPreviewHydrationResult {
  const blobUrls: string[] = [];
  let attached = 0;
  const slots = root.querySelectorAll<HTMLImageElement>(
    `img[${WRITER_PREVIEW_IMAGE_INDEX_ATTR}]`,
  );
  for (const slot of slots) {
    const rawIndex = slot.getAttribute(WRITER_PREVIEW_IMAGE_INDEX_ATTR);
    const index = rawIndex === null ? Number.NaN : Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index) || index < 0 || index >= imageSources.length) continue;
    const parsed = parseDataUrlImage(imageSources[index]!);
    if (parsed === null) continue;
    const blob = new Blob([parsed.bytes.slice()], { type: parsed.mimeType });
    const url = URL.createObjectURL(blob);
    blobUrls.push(url);
    slot.src = url;
    slot.removeAttribute("aria-hidden");
    const figure = slot.closest("figure");
    const fallback = figure?.querySelector(".nautilo-writer-preview-image-fallback");
    if (fallback instanceof HTMLElement) fallback.hidden = true;
    attached += 1;
  }
  return {
    attached,
    revoke: () => {
      for (const url of blobUrls) URL.revokeObjectURL(url);
    },
  };
}

function readWriterPayloadFromDocument(doc: Document): WafflebaseDocumentPayload | null {
  const manifest = doc.getElementById("manifest");
  if (manifest === null) return null;
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifest.textContent ?? "");
  } catch {
    return null;
  }
  if (!isRecord(manifestJson)) return null;
  if (manifestJson["documentType"] !== WRITER_DOCUMENT_TYPE) return null;
  if (manifestJson["editor"] !== WRITER_EDITOR) return null;
  const payloadId = manifestJson["payloadId"];
  if (typeof payloadId !== "string" || payloadId.trim().length === 0) return null;
  if (manifestJson["payloadFormat"] !== WAFFLEBASE_DOCUMENT_TYPE) return null;
  const payloadEl = doc.getElementById(payloadId.trim());
  if (payloadEl === null) return null;
  let payloadJson: unknown;
  try {
    payloadJson = JSON.parse(payloadEl.textContent ?? "");
  } catch {
    return null;
  }
  if (!isRecord(payloadJson) || !Array.isArray(payloadJson["blocks"])) return null;
  return payloadJson as WafflebaseDocumentPayload;
}

/** Extract image data URLs from a Writer HTML document's non-executable payload. */
export function extractWriterPreviewImageSourcesFromHtml(html: string): string[] | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const payload = readWriterPayloadFromDocument(doc);
  if (payload === null) return null;
  return collectWriterPreviewImageSources(payload);
}

/** Hydrate preview image slots from an HTML string (trusted host entry point). */
export function hydrateWriterPreviewFromHtml(html: string): WriterPreviewHydrationResult | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");
  const payload = readWriterPayloadFromDocument(doc);
  if (payload === null) return null;
  const sources = collectWriterPreviewImageSources(payload);
  const previewRoot = doc.querySelector(`main.${WRITER_PREVIEW_ROOT_CLASS}`);
  if (previewRoot === null) return { attached: 0, revoke: () => {} };
  return hydrateWriterPreviewImages(previewRoot, sources);
}

/**
 * Self-contained trusted script injected by the HTML viewer host (not document
 * content). Reads the existing typed payload, hydrates indexed slots, and
 * revokes blob URLs on teardown.
 */
export function writerPreviewHydrationScriptSource(): string {
  return `(function(){
var ATTR="data-writer-image-index";
var ROOT="main.nautilo-writer-preview";
var DOC_TYPE="document";
var EDITOR="wafflebase";
var PAYLOAD_FORMAT="application/vnd.wafflebase.document+json";
var IMAGE_CHAR="\\uFFFC";
var DATA_URL_RE=/^data:(image\\/(?:png|jpeg|gif|svg\\+xml));base64,([A-Za-z0-9+/=\\s]+)$/i;
var blobUrls=[];
function parseDataUrl(dataUrl){
  if(typeof dataUrl!=="string"||dataUrl.length===0)return null;
  var match=DATA_URL_RE.exec(dataUrl.trim());
  if(match===null)return null;
  var mime=match[1].toLowerCase();
  if(mime==="image/jpg")mime="image/jpeg";
  var payload=match[2].replace(/\\s+/g,"");
  if(payload.length===0)return null;
  try{
    var binary=atob(payload);
    var bytes=new Uint8Array(binary.length);
    for(var i=0;i<binary.length;i++)bytes[i]=binary.charCodeAt(i);
    return{mime:match[1],bytes:bytes};
  }catch(e){return null;}
}
function isImageInline(inline){
  if(!inline||typeof inline!=="object")return false;
  if(inline.text!==IMAGE_CHAR)return false;
  var style=inline.style;
  if(!style||typeof style!=="object"||Array.isArray(style))return false;
  var image=style.image;
  if(!image||typeof image!=="object"||Array.isArray(image))return false;
  return typeof image.src==="string"&&image.src.indexOf("data:")===0;
}
function readImageSrc(inline){
  var image=inline.style&&inline.style.image;
  return image&&typeof image.src==="string"?image.src:null;
}
function collectFromInlines(inlines,out){
  if(!Array.isArray(inlines))return;
  for(var i=0;i<inlines.length;i++){
    var inline=inlines[i];
    if(isImageInline(inline)){
      var src=readImageSrc(inline);
      if(src)out.push(src);
    }
  }
}
function walkBlocks(blocks,out){
  if(!Array.isArray(blocks))return;
  for(var i=0;i<blocks.length;i++){
    var block=blocks[i];
    if(!block||typeof block!=="object")continue;
    collectFromInlines(block.inlines,out);
    if(block.type==="table"&&block.tableData&&typeof block.tableData==="object"){
      var rows=block.tableData.rows;
      if(Array.isArray(rows)){
        for(var r=0;r<rows.length;r++){
          var cells=rows[r]&&rows[r].cells;
          if(!Array.isArray(cells))continue;
          for(var c=0;c<cells.length;c++){
            var cell=cells[c];
            if(!cell||typeof cell!=="object")continue;
            if(cell.colSpan===0)continue;
            walkBlocks(cell.blocks,out);
          }
        }
      }
    }
  }
}
function readPayload(doc){
  var manifest=doc.getElementById("manifest");
  if(!manifest)return null;
  var manifestJson;
  try{manifestJson=JSON.parse(manifest.textContent||"");}catch(e){return null;}
  if(!manifestJson||typeof manifestJson!=="object")return null;
  if(manifestJson.documentType!==DOC_TYPE||manifestJson.editor!==EDITOR)return null;
  if(manifestJson.payloadFormat!==PAYLOAD_FORMAT)return null;
  var payloadId=manifestJson.payloadId;
  if(typeof payloadId!=="string"||payloadId.trim().length===0)return null;
  var payloadEl=doc.getElementById(payloadId.trim());
  if(!payloadEl)return null;
  var payloadJson;
  try{payloadJson=JSON.parse(payloadEl.textContent||"");}catch(e){return null;}
  if(!payloadJson||typeof payloadJson!=="object"||!Array.isArray(payloadJson.blocks))return null;
  return payloadJson;
}
function revokeAll(){
  for(var i=0;i<blobUrls.length;i++)URL.revokeObjectURL(blobUrls[i]);
  blobUrls.length=0;
}
function hydrate(){
  revokeAll();
  var payload=readPayload(document);
  if(!payload)return;
  var sources=[];
  walkBlocks(payload.blocks,sources);
  var root=document.querySelector(ROOT);
  if(!root)return;
  var slots=root.querySelectorAll("img["+ATTR+"]");
  for(var i=0;i<slots.length;i++){
    var slot=slots[i];
    var raw=slot.getAttribute(ATTR);
    var index=raw===null?NaN:parseInt(raw,10);
    if(!Number.isFinite(index)||index<0||index>=sources.length)continue;
    var parsed=parseDataUrl(sources[index]);
    if(parsed===null)continue;
    var blob=new Blob([parsed.bytes],{type:parsed.mime});
    var url=URL.createObjectURL(blob);
    blobUrls.push(url);
    slot.src=url;
    slot.removeAttribute("aria-hidden");
    var figure=slot.closest("figure");
    if(figure){
      var fallback=figure.querySelector(".nautilo-writer-preview-image-fallback");
      if(fallback)fallback.hidden=true;
    }
  }
}
if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",hydrate,{once:true});
}else{
  hydrate();
}
window.addEventListener("pagehide",revokeAll);
})();`;
}
