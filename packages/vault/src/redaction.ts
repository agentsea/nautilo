import { redactSecretLikeValues, type SecretLeakFinding } from "./leak-scanner.ts";
import { scrubSecrets } from "./scrubber.ts";

const globalExactSecrets = new Set<string>();

export interface SecretRedactionResult {
  readonly text: string;
  readonly exactRedactions: number;
  readonly leakFindings: readonly SecretLeakFinding[];
}

export function registerSecretForRedaction(value: Uint8Array | string): void {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  if (text.length > 0) {
    globalExactSecrets.add(text);
  }
}

export function unregisterSecretForRedaction(value: Uint8Array | string): void {
  const text = typeof value === "string" ? value : Buffer.from(value).toString("utf8");
  globalExactSecrets.delete(text);
}

export function clearRegisteredSecretsForRedaction(): void {
  globalExactSecrets.clear();
}

export function redactSecrets(
  text: string,
  exactEntries: readonly Uint8Array[] | readonly string[] = [],
): SecretRedactionResult {
  const exact = [...globalExactSecrets, ...exactEntries.map((entry) =>
    typeof entry === "string" ? entry : Buffer.from(entry).toString("utf8"),
  )];
  const scrubbed = scrubSecrets(text, exact);
  const scanned = redactSecretLikeValues(scrubbed.text);

  return {
    text: scanned.text,
    exactRedactions: scrubbed.redactions,
    leakFindings: scanned.findings,
  };
}

