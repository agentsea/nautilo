/**
 * Read ISO BMFF/QuickTime movie timing from the actual authorized bytes.
 * No native executable, network URL, or client-supplied duration is trusted.
 * Box traversal is bounded by container byte ranges; malformed sizes fail closed.
 * This measures container duration/codec, not a promise that every frame decodes.
 */
export function inspectReferenceVideo(bytes: Uint8Array): { durationSeconds: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  type Box = { type: string; start: number; end: number };
  function fail(): never { throw new Error("Reference video must be a complete MP4/MOV with H.264 or H.265 video and readable duration."); }
  function boxes(start: number, end: number): Box[] {
    const result: Box[] = [];
    while (start < end) {
      if (end - start < 8) fail();
      let size = view.getUint32(start);
      let header = 8;
      if (size === 1) {
        if (end - start < 16) fail();
        const wide = view.getBigUint64(start + 8);
        if (wide > BigInt(Number.MAX_SAFE_INTEGER)) fail();
        size = Number(wide); header = 16;
      } else if (size === 0) size = end - start;
      if (size < header || size > end - start) fail();
      const type = String.fromCharCode(...bytes.subarray(start + 4, start + 8));
      result.push({ type, start: start + header, end: start + size });
      start += size;
    }
    return result;
  }
  const top = boxes(0, bytes.byteLength);
  const movies = top.filter(box => box.type === "moov");
  if (movies.length !== 1 || !top.some(box => box.type === "mdat" && box.end > box.start)) fail();
  const movie = boxes(movies[0]!.start, movies[0]!.end);
  const headers = movie.filter(box => box.type === "mvhd");
  if (headers.length !== 1) fail();
  const header = headers[0]!;
  const version = view.getUint8(header.start);
  if (version !== 0 && version !== 1) fail();
  const scaleOffset = header.start + (version === 1 ? 20 : 12);
  if (header.end < scaleOffset + (version === 1 ? 12 : 8)) fail();
  const scale = view.getUint32(scaleOffset);
  const ticks = version === 1 ? Number(view.getBigUint64(scaleOffset + 4)) : view.getUint32(scaleOffset + 4);
  if (!scale || !Number.isSafeInteger(ticks) || !ticks) fail();
  let hasVideo = false;
  for (const track of movie.filter(box => box.type === "trak")) {
    const media = boxes(track.start, track.end).find(box => box.type === "mdia");
    if (!media) fail();
    const mediaBoxes = boxes(media.start, media.end);
    const handler = mediaBoxes.find(box => box.type === "hdlr");
    if (!handler || handler.end - handler.start < 12) fail();
    const kind = String.fromCharCode(...bytes.subarray(handler.start + 8, handler.start + 12));
    const minf = mediaBoxes.find(box => box.type === "minf");
    const stbl = minf && boxes(minf.start, minf.end).find(box => box.type === "stbl");
    const stsd = stbl && boxes(stbl.start, stbl.end).find(box => box.type === "stsd");
    if (!stsd || stsd.end - stsd.start < 8) fail();
    const entries = boxes(stsd.start + 8, stsd.end);
    if (entries.length !== view.getUint32(stsd.start + 4) || !entries.length) fail();
    if (kind === "vide") {
      if (entries.some(box => !["avc1", "avc3", "hvc1", "hev1"].includes(box.type))) fail();
      hasVideo = true;
    } else if (kind === "soun" && entries.some(box => !["mp4a", ".mp3"].includes(box.type))) fail();
  }
  if (!hasVideo) fail();
  return { durationSeconds: ticks / scale };
}
