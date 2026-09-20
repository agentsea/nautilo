/** Split at the provider's catalog limit without dropping text or splitting Unicode code points. */
export function splitSpeechText(text: string, maximum: number): string[] {
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("Invalid speech input limit");
  const characters = Array.from(text);
  const chunks: string[] = [];
  let offset = 0;
  while (offset < characters.length) {
    let end = Math.min(offset + maximum, characters.length);
    if (end < characters.length) {
      for (let boundary = end; boundary > offset; boundary--) {
        if (/\s/.test(characters[boundary - 1]!)) { end = boundary; break; }
      }
    }
    chunks.push(characters.slice(offset, end).join(""));
    offset = end;
  }
  return chunks;
}
