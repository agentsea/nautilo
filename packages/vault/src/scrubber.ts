const REDACTION = "[REDACTED CONNECTION]";

function normalizeEntries(entries: readonly Uint8Array[] | readonly string[]): string[] {
  return [...entries]
    .map((entry) =>
      typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8"),
    )
    .filter((entry) => entry.length > 0)
    .sort((a, b) => b.length - a.length);
}

export interface ScrubResult {
  readonly text: string;
  readonly redactions: number;
}

export function scrubSecrets(
  text: string,
  entries: readonly Uint8Array[] | readonly string[],
): ScrubResult {
  let output = text;
  let redactions = 0;

  for (const secret of normalizeEntries(entries)) {
    const before = output;
    output = output.split(secret).join(REDACTION);
    if (before !== output) {
      redactions += before.split(secret).length - 1;
    }
  }

  return { text: output, redactions };
}

export class StreamScrubber {
  private tail = "";
  private readonly secrets: string[];
  private readonly maxSecretLength: number;

  constructor(entries: readonly Uint8Array[] | readonly string[]) {
    this.secrets = normalizeEntries(entries);
    this.maxSecretLength = this.secrets.reduce(
      (max, entry) => Math.max(max, entry.length),
      0,
    );
  }

  push(chunk: string): string {
    if (this.maxSecretLength === 0) return chunk;

    const joined = this.tail + chunk;
    const keep = Math.max(0, this.maxSecretLength - 1);
    if (joined.length <= keep) {
      this.tail = joined;
      return "";
    }

    let emitEnd = joined.length - keep;
    const pendingTail = joined.slice(emitEnd);
    const pendingEmit = joined.slice(0, emitEnd);
    const prefixLength = longestSecretPrefixSuffix(pendingEmit, this.secrets);
    emitEnd -= prefixLength;

    const emit = joined.slice(0, emitEnd);
    this.tail = joined.slice(emitEnd, emitEnd + prefixLength) + pendingTail;

    return scrubSecrets(emit, this.secrets).text;
  }

  flush(): string {
    const out = scrubSecrets(this.tail, this.secrets).text;
    this.tail = "";
    return out;
  }
}

function longestSecretPrefixSuffix(text: string, secrets: readonly string[]): number {
  let best = 0;
  for (const secret of secrets) {
    const max = Math.min(secret.length - 1, text.length);
    for (let length = max; length > best; length -= 1) {
      if (text.endsWith(secret.slice(0, length))) {
        best = length;
        break;
      }
    }
  }
  return best;
}
