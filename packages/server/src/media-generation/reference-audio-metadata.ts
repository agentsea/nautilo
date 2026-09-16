/**
 * Read MP3/WAV duration from the authorized bytes. The parser accepts complete
 * audio containers only, so an Artifact MIME label or client duration can
 * never authorize provider delivery by itself.
 */
export function inspectReferenceAudio(
  bytes: Uint8Array,
  expectedMimeType: "audio/mpeg" | "audio/wav" | "audio/x-wav",
): { durationSeconds: number; providerMimeType: "audio/mpeg" | "audio/wav" } {
  return expectedMimeType === "audio/mpeg" ? inspectMp3(bytes) : inspectWav(bytes);
}

function inspectWav(bytes: Uint8Array): { durationSeconds: number; providerMimeType: "audio/wav" } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) => String.fromCharCode(...bytes.subarray(offset, offset + length));
  const fail = (): never => { throw new Error("Reference audio must be a complete MP3 or WAV with readable duration."); };
  if (bytes.byteLength < 44 || ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WAVE" || view.getUint32(4, true) + 8 !== bytes.byteLength) fail();
  let offset = 12;
  let byteRate: number | undefined;
  let blockAlign: number | undefined;
  let dataBytes = 0;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 8) fail();
    const kind = ascii(offset, 4);
    const size = view.getUint32(offset + 4, true);
    const start = offset + 8;
    const end = start + size;
    if (end > bytes.byteLength) fail();
    if (kind === "fmt ") {
      if (byteRate !== undefined || size < 16) fail();
      const containerFormat = view.getUint16(start, true);
      let format = containerFormat;
      if (containerFormat === 0xfffe) {
        const extensibleTail = [0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
        if (size < 40 || view.getUint16(start + 16, true) < 22 ||
            !extensibleTail.every((byte, index) => bytes[start + 28 + index] === byte)) fail();
        format = view.getUint32(start + 24, true);
      }
      const channels = view.getUint16(start + 2, true);
      const sampleRate = view.getUint32(start + 4, true);
      const parsedByteRate = view.getUint32(start + 8, true);
      const parsedBlockAlign = view.getUint16(start + 12, true);
      const bitsPerSample = view.getUint16(start + 14, true);
      if (![1, 3].includes(format) || !channels || !sampleRate || !parsedByteRate || !parsedBlockAlign || !bitsPerSample ||
          parsedBlockAlign !== channels * Math.ceil(bitsPerSample / 8) || parsedByteRate !== sampleRate * parsedBlockAlign) fail();
      byteRate = parsedByteRate;
      blockAlign = parsedBlockAlign;
    } else if (kind === "data") {
      if (!size) fail();
      dataBytes += size;
    }
    offset = end + (size % 2);
    if (offset > bytes.byteLength) fail();
  }
  if (offset !== bytes.byteLength || !dataBytes) fail();
  const finalByteRate = byteRate;
  const finalBlockAlign = blockAlign;
  if (finalByteRate === undefined || finalBlockAlign === undefined || dataBytes % finalBlockAlign !== 0) {
    throw new Error("Reference audio must be a complete MP3 or WAV with readable duration.");
  }
  const durationSeconds = dataBytes / finalByteRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) fail();
  return { durationSeconds, providerMimeType: "audio/wav" };
}

const MPEG1_LAYER3_KBPS = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320] as const;
const MPEG2_LAYER3_KBPS = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160] as const;

function inspectMp3(bytes: Uint8Array): { durationSeconds: number; providerMimeType: "audio/mpeg" } {
  const fail = (): never => { throw new Error("Reference audio must be a complete MP3 or WAV with readable duration."); };
  let offset = 0;
  if (bytes.byteLength >= 10 && String.fromCharCode(...bytes.subarray(0, 3)) === "ID3") {
    if (bytes[3] === 0xff || bytes[4] === 0xff || bytes.subarray(6, 10).some(byte => byte > 0x7f)) fail();
    const tagSize = ((bytes[6]! & 0x7f) << 21) | ((bytes[7]! & 0x7f) << 14) | ((bytes[8]! & 0x7f) << 7) | (bytes[9]! & 0x7f);
    offset = 10 + tagSize + ((bytes[5]! & 0x10) ? 10 : 0);
    if (offset >= bytes.byteLength) fail();
  }
  const audioEnd = bytes.byteLength >= 128 && String.fromCharCode(...bytes.subarray(bytes.byteLength - 128, bytes.byteLength - 125)) === "TAG"
    ? bytes.byteLength - 128 : bytes.byteLength;
  let totalSamples = 0;
  let sampleRate: number | undefined;
  let frames = 0;
  while (offset < audioEnd) {
    if (audioEnd - offset < 4) fail();
    const header = ((bytes[offset]! * 0x1000000) + (bytes[offset + 1]! << 16) + (bytes[offset + 2]! << 8) + bytes[offset + 3]!) >>> 0;
    if ((header >>> 21) !== 0x7ff) fail();
    const versionBits = (header >>> 19) & 0x3;
    const layerBits = (header >>> 17) & 0x3;
    const bitrateIndex = (header >>> 12) & 0xf;
    const sampleRateIndex = (header >>> 10) & 0x3;
    const padding = (header >>> 9) & 0x1;
    if (versionBits === 1 || layerBits !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) fail();
    const baseRate = [44_100, 48_000, 32_000][sampleRateIndex]!;
    const currentRate = versionBits === 3 ? baseRate : versionBits === 2 ? baseRate / 2 : baseRate / 4;
    const bitrate = (versionBits === 3 ? MPEG1_LAYER3_KBPS : MPEG2_LAYER3_KBPS)[bitrateIndex]!;
    const frameLength = Math.floor((versionBits === 3 ? 144_000 : 72_000) * bitrate / currentRate) + padding;
    if (frameLength < 24 || offset + frameLength > audioEnd) fail();
    if (sampleRate !== undefined && sampleRate !== currentRate) fail();
    sampleRate = currentRate;
    totalSamples += versionBits === 3 ? 1_152 : 576;
    frames++;
    offset += frameLength;
  }
  const finalSampleRate = sampleRate;
  if (!frames || finalSampleRate === undefined || offset !== audioEnd) {
    throw new Error("Reference audio must be a complete MP3 or WAV with readable duration.");
  }
  const durationSeconds = totalSamples / finalSampleRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) fail();
  return { durationSeconds, providerMimeType: "audio/mpeg" };
}
