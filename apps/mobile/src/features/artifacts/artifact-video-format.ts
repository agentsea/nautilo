/** Containers offered to the native decoder, not a promise of every codec. */
export function isVideoCandidate(path: string, mimeType: string): boolean {
  const mime = mimeType.split(";", 1)[0].trim().toLowerCase();
  return mime.startsWith("video/") || /\.(mp4|m4v|mov|webm)$/i.test(path);
}

/**
 * Inspect only the container signature, never decode a whole video in JS.
 * Playlists are intentionally excluded: a local manifest must not turn the
 * player into an authenticated or arbitrary remote-resource fetcher.
 * Actual codec/container validity is still decided by the native decoder.
 */
export function hasLocalVideoContainer(header: Uint8Array): boolean {
  if (header.length >= 12 && header[4] === 0x66 && header[5] === 0x74 && header[6] === 0x79 && header[7] === 0x70) {
    const boxSize = header[0] * 0x1000000 + header[1] * 0x10000 + header[2] * 0x100 + header[3];
    return boxSize === 1 || boxSize >= 16;
  }
  return header.length >= 4 && header[0] === 0x1a && header[1] === 0x45 && header[2] === 0xdf && header[3] === 0xa3;
}
