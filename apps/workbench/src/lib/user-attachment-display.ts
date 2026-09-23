/** Presentation only: persisted attachment bodies remain available to the agent.
 * Recognize the legacy leading attachment envelope shape, not its provenance.
 * Examples in prose/code and incomplete or ambiguous envelopes stay verbatim.
 * An intentionally authored exact envelope is indistinguishable in this legacy
 * text-only representation; this must never establish attachment authority.
 */
export function formatUserAttachmentDisplay(text: string): string {
  const names: string[] = [];
  let remaining = text;
  const envelope = /^<(attachment|attachment-transcript) id="[^"\n]+" filename="([^"\n]+)"(?: provider="[^"\n]*" model="[^"\n]*")? untrusted="true">\n[\s\S]*?\n<\/\1>(?:\n\n|$)/;
  for (let match = envelope.exec(remaining); match; match = envelope.exec(remaining)) {
    const name = match[2].replace(/&(amp|quot|lt|gt);/g, entity => ({
      "&amp;": "&", "&quot;": '"', "&lt;": "<", "&gt;": ">",
    })[entity]!);
    // Filenames are labels, never Markdown links, images or HTML.
    names.push(name.replace(/[\\`*_{}[\]()<>#+.!|~&-]/g, "\\$&"));
    remaining = remaining.slice(match[0].length);
  }
  if (!names.length) return text;
  // Adapter bodies are unescaped text. A delimiter inside a file can look like
  // the end of an envelope. Never summarize a partial parse and expose its tail
  // as authored prose; preserve the whole message if any extra delimiter exists.
  const delimiters = text.match(/<\/?attachment(?:-transcript)?(?=[\s>])/g) ?? [];
  if (delimiters.length !== names.length * 2) return text;
  const summary = `📎 Attached: ${names.join(", ")}`;
  return remaining ? `${summary}\n\n${remaining}` : summary;
}
